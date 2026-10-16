import { CONFIG } from '../config';
import { type Principal, can, canHandleContent, ForbiddenError } from '../authz/can';
import { autocheck, consensusNext, canTransition, type ClipState } from '../curation/stateMachine';
import { computeTier, type WritingSystem } from '../curation/tier';
import { type Repo } from '../ports/repo';
import { type Clip, type Consent, type Rarity, type Verdict } from '../domain/contribution';
import { type AudioStore, InMemoryAudioStore } from '../storage/audioStore';
import { conflict, notFound } from '../errors';

function requiredCompetenceFor(rarity: Rarity): number {
  // Compétence requise = rareté : clip normal (0) validable par tout contributeur,
  // rare (1) et très rare (2) réservés aux validateurs plus qualifiés.
  return rarity;
}

// Isolation linguistique : un contributeur ne manipule que le contenu de SA
// langue (et de son dialecte si les deux sont renseignés). Souple pour les
// données héritées : un clip sans langue n'impose aucune contrainte.
function sameLinguistic(
  user: { language?: string; dialect?: string },
  clip: { language?: string; dialect?: string },
): boolean {
  if (!clip.language) return true;
  if (user.language !== clip.language) return false;
  if (user.dialect && clip.dialect && user.dialect !== clip.dialect) return false;
  return true;
}

// Flux de contribution complet, branché sur la logique déjà testée.
export class ContributionService {
  constructor(
    private readonly repo: Repo,
    private readonly audioStore: AudioStore = new InMemoryAudioStore(),
  ) {}

  // GET /clips/:id/audio — lecture d'un clip (garde le repo privé).
  getClip(id: string): Promise<Clip | null> {
    return this.repo.getClip(id);
  }

  // POST /clips — enregistrement → auto-check → peer_review | rejected (+ ledger D4)
  async submitClip(
    contributorId: string,
    input: {
      promptId?: string;
      rarity: Rarity;
      durationS: number;
      commercialUse: boolean;
      consentVersion: string;
      language?: string;
      dialect?: string;
      region?: string;
    },
    audio?: { buffer: Buffer; ext: string },
  ): Promise<{ clipId: string; status: ClipState; reward: number; licenseTag: string }> {
    const { passed, report } = autocheck(input.durationS);
    const status: ClipState = passed ? 'peer_review' : 'rejected';
    const licenseTag = input.commercialUse ? `commercial-${input.consentVersion}` : `noncommercial-${input.consentVersion}`;
    const consent: Consent = {
      commercialUse: input.commercialUse,
      consentVersion: input.consentVersion,
      licenseTag,
      provenance: { capturedAt: new Date().toISOString(), device: 'mobile', source: 'sabidata-app' },
    };

    // Rattache le clip au classroom courant du contributeur (collecte de groupe).
    const contributor = await this.repo.findUserById(contributorId);
    const clip = await this.repo.createClip({
      contributorId,
      promptId: input.promptId,
      rarity: input.rarity,
      durationS: input.durationS,
      requiredCompetence: requiredCompetenceFor(input.rarity),
      language: input.language,
      dialect: input.dialect,
      region: input.region,
      classroomId: contributor?.classroomId,
      status,
      consent,
      autocheck: report,
    });

    // Stocke le blob audio uniquement si l'auto-check passe (un clip rejeté ne laisse aucun fichier).
    if (passed && audio) {
      const path = await this.audioStore.save(clip.id, audio.buffer, audio.ext);
      await this.repo.setClipAudio(clip.id, path);
    }

    let reward = 0;
    if (passed) {
      // D4 : crédit PROVISOIRE à la soumission (× rareté sur l'enregistrement).
      reward = CONFIG.rewards.record * (CONFIG.rarityMult[input.rarity] ?? 1);
      await this.repo.addLedger({
        userId: contributorId,
        delta: reward,
        reason: 'record',
        state: 'provisional',
        refClipId: clip.id,
      });
    }
    return { clipId: clip.id, status, reward, licenseTag };
  }

  // GET /validation/next — routé par competence_level (décision 1/2)
  async nextForValidation(p: Principal): Promise<Clip | null> {
    if (!can(p, 'validate')) throw new ForbiddenError('validate');
    const me = (await this.repo.findUserById(p.userId)) ?? {};
    const candidates = await this.repo.listPeerReview();
    for (const c of candidates) {
      if (c.contributorId === p.userId) continue; // pas son propre clip
      if (c.requiredCompetence > p.competence) continue; // niveau insuffisant
      if (!sameLinguistic(me, c)) continue; // même langue/dialecte uniquement
      if (await this.repo.hasVotedClip(c.id, p.userId)) continue; // déjà voté
      return c;
    }
    return null;
  }

  // POST /clips/:id/validations — vote → consensus → transition + ledger
  async submitVote(
    p: Principal,
    clipId: string,
    verdict: Verdict,
  ): Promise<{ status: ClipState; reward: number }> {
    const clip = await this.repo.getClip(clipId);
    if (!clip) throw notFound('clip');
    if (clip.status !== 'peer_review') throw conflict('not_in_review');
    if (!canHandleContent(p, clip.requiredCompetence)) throw new ForbiddenError('validate');
    if (clip.contributorId === p.userId) throw conflict('own_clip');
    const me = (await this.repo.findUserById(p.userId)) ?? {};
    if (!sameLinguistic(me, clip)) throw conflict('wrong_language'); // isolation linguistique
    if (await this.repo.hasVotedClip(clipId, p.userId)) throw conflict('already_voted');

    await this.repo.createVote({ clipId, validatorId: p.userId, verdict, reviewerCompetence: p.competence });
    // D4 : valider EST une contribution → crédit confirmé immédiat.
    await this.repo.addLedger({
      userId: p.userId,
      delta: CONFIG.rewards.validate,
      reason: 'validate',
      state: 'confirmed',
      refClipId: clipId,
    });

    const votes = await this.repo.votesForClip(clipId);
    const tally = {
      correct: votes.filter((v) => v.verdict === 'correct').length,
      problem: votes.filter((v) => v.verdict === 'problem').length,
      total: votes.length,
    };
    const next = consensusNext('peer_review', tally);
    if (next !== clip.status && canTransition(clip.status, next)) {
      await this.repo.setClipStatus(clipId, next);
      if (next === 'validated') await this.repo.setRecordLedgerState(clipId, 'confirmed');
      else if (next === 'rejected') await this.repo.setRecordLedgerState(clipId, 'reversed');
    }
    return { status: next, reward: CONFIG.rewards.validate };
  }

  // POST /transcriptions — produit une transcription (RTB ou conversion)
  // GET /transcriptions/next — clip validé à transcrire, filtré par langue/dialecte
  // du contributeur (même isolation que la validation).
  async nextForTranscription(p: Principal): Promise<Clip | null> {
    const me = (await this.repo.findUserById(p.userId)) ?? {};
    const candidates = await this.repo.listClipsByStatus('validated');
    for (const c of candidates) {
      if (c.contributorId === p.userId) continue; // pas son propre clip
      if (!sameLinguistic(me, c)) continue; // même langue/dialecte uniquement
      if (await this.repo.hasTranscribedClip(c.id, p.userId)) continue; // déjà transcrit
      return c;
    }
    return null;
  }

  async submitTranscription(
    p: Principal,
    input: { clipId?: string; archiveId?: string; text: string; writingSystem: WritingSystem; consistency: number },
  ): Promise<{ id: string; reward: number }> {
    const tr = await this.repo.createTranscription({
      authorId: p.userId,
      clipId: input.clipId,
      archiveId: input.archiveId,
      text: input.text,
      writingSystem: input.writingSystem,
      consistency: input.consistency,
    });
    const reward = CONFIG.rewards.transcribe;
    await this.repo.addLedger({ userId: p.userId, delta: reward, reason: 'transcribe', state: 'confirmed', refTranscriptionId: tr.id });
    return { id: tr.id, reward };
  }

  // POST /transcriptions/:id/validations — vote → calcul du tier (D1)
  async voteTranscription(
    p: Principal,
    transcriptionId: string,
    verdict: Verdict,
    input: { writingSystem: WritingSystem; consistency: number },
  ): Promise<{ tier: string; matchesAudio: boolean | null }> {
    if (!can(p, 'validate')) throw new ForbiddenError('validate');
    await this.repo.createVote({ transcriptionId, validatorId: p.userId, verdict, reviewerCompetence: p.competence });
    const votes = await this.repo.votesForTranscription(transcriptionId);
    const result = computeTier({
      writingSystem: input.writingSystem,
      consistency: input.consistency,
      correct: votes.filter((v) => v.verdict === 'correct').length,
      problem: votes.filter((v) => v.verdict === 'problem').length,
      qualifiedCorrect: votes.filter(
        (v) => v.verdict === 'correct' && v.reviewerCompetence >= CONFIG.competenceForGold,
      ).length,
    });
    await this.repo.setTranscriptionTier(transcriptionId, result.tier, result.matchesAudio);
    return { tier: result.tier, matchesAudio: result.matchesAudio };
  }
}
