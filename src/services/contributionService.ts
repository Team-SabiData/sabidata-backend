import { CONFIG } from '../config';
import { type Principal, can, canHandleContent, ForbiddenError } from '../authz/can';
import { autocheck, consensusNext, canTransition, type ClipState } from '../curation/stateMachine';
import { computeTier, type WritingSystem } from '../curation/tier';
import { type Repo } from '../ports/repo';
import { type Clip, type Consent, type Rarity, type Verdict } from '../domain/contribution';
import { type AudioStore, InMemoryAudioStore } from '../storage/audioStore';
import { type MediaProcessor, StubMediaProcessor } from '../media/processor';
import { conflict, notFound } from '../errors';

function requiredCompetenceFor(rarity: Rarity): number {
  return rarity;
}

function sameLinguistic(
  user: { language?: string; dialect?: string },
  clip: { language?: string; dialect?: string },
): boolean {
  if (!clip.language) return true;
  if (user.language !== clip.language) return false;
  if (user.dialect && clip.dialect && user.dialect !== clip.dialect) return false;
  return true;
}

export class ContributionService {
  constructor(
    private readonly repo: Repo,
    private readonly audioStore: AudioStore = new InMemoryAudioStore(),
    private readonly media: MediaProcessor = new StubMediaProcessor(),
  ) {}

  getClip(id: string): Promise<Clip | null> {
    return this.repo.getClip(id);
  }

  /** ACL lecture audio — anti-scraping corpus. */
  async canReadAudio(p: Principal, clip: Clip): Promise<boolean> {
    if (can(p, 'content.read_any')) return true;
    if (clip.contributorId === p.userId) return true;
    const me = (await this.repo.findUserById(p.userId)) ?? {};
    if (!sameLinguistic(me, clip)) return false;
    if (clip.status === 'peer_review' && can(p, 'validate') && canHandleContent(p, clip.requiredCompetence)) {
      return true;
    }
    if (clip.status === 'validated') return true;
    return false;
  }

  async submitClip(
    contributorId: string,
    input: {
      promptId?: string;
      /** @deprecated ignoré — rareté dérivée serveur */
      rarity?: Rarity;
      durationS: number;
      commercialUse: boolean;
      consentVersion: string;
      language?: string;
      dialect?: string;
      region?: string;
      clientUuid?: string;
    },
    audio?: { buffer: Buffer; ext: string },
  ): Promise<{ clipId: string; status: ClipState; reward: number; licenseTag: string; audioQuality?: string }> {
    const contributor = await this.repo.findUserById(contributorId);
    if (input.clientUuid) {
      const existing = await this.repo.findClipByClientUuid(contributorId, input.clientUuid);
      if (existing) {
        return {
          clipId: existing.id,
          status: existing.status,
          reward: 0,
          licenseTag: existing.consent.licenseTag,
          audioQuality: existing.audioQuality,
        };
      }
    }

    const minBytes = 800;
    const audioOk = !audio || audio.buffer.length >= minBytes;

    let status: ClipState;
    let durationS = input.durationS;
    let autocheckReport: Record<string, unknown>;
    let mediaResult: Awaited<ReturnType<MediaProcessor['process']>> | null = null;

    if (audio && audioOk) {
      mediaResult = await this.media.process(audio.buffer, audio.ext);
      durationS = Math.max(1, Math.round(mediaResult.metrics.durationMs / 1000));
      status = mediaResult.passed ? 'peer_review' : 'rejected';
      autocheckReport = {
        source: 'media_job',
        durationMs: mediaResult.metrics.durationMs,
        silenceRatio: mediaResult.metrics.silenceRatio,
        snrDb: mediaResult.metrics.snrDb,
        peakDbfs: mediaResult.metrics.peakDbfs,
        sampleRateHz: mediaResult.metrics.sampleRateHz,
        channels: mediaResult.metrics.channels,
        quality: mediaResult.quality,
        reasons: mediaResult.reasons,
        audioBytes: audio.buffer.length,
        audioOk: true,
      };
    } else {
      const { passed: durationOk, report } = autocheck(input.durationS);
      const passed = durationOk && audioOk;
      status = passed ? 'peer_review' : 'rejected';
      autocheckReport = { ...report, audioBytes: audio?.buffer.length ?? 0, audioOk, source: 'client_duration' };
    }

    const licenseTag = input.commercialUse
      ? `commercial-${input.consentVersion}`
      : `noncommercial-${input.consentVersion}`;
    const consent: Consent = {
      commercialUse: input.commercialUse,
      consentVersion: input.consentVersion,
      licenseTag,
      provenance: { capturedAt: new Date().toISOString(), device: 'mobile', source: 'sabidata-app' },
    };

    const language = contributor?.language ?? input.language;
    const dialect = contributor?.dialect ?? input.dialect;
    const region = contributor?.region ?? input.region;

    const rarity = await this.serverRarity(region);
    const clip = await this.repo.createClip({
      contributorId,
      promptId: input.promptId,
      rarity,
      durationS,
      requiredCompetence: requiredCompetenceFor(rarity),
      language,
      dialect,
      region,
      classroomId: contributor?.classroomId,
      clientUuid: input.clientUuid,
      status,
      consent,
      autocheck: autocheckReport,
      audioQuality: mediaResult?.quality,
      durationMs: mediaResult?.metrics.durationMs,
    });

    if (audio && audioOk && mediaResult) {
      const ingestPath = await this.audioStore.save(clip.id, audio.buffer, audio.ext);
      const masterPath = await this.audioStore.save(`${clip.id}_master`, mediaResult.masterWav, 'wav');
      await this.repo.setClipMedia(clip.id, {
        audioPath: masterPath,
        audioIngestPath: ingestPath,
        audioMasterPath: masterPath,
        ingestSha256: mediaResult.ingestSha256,
        masterSha256: mediaResult.masterSha256,
        durationS,
        durationMs: mediaResult.metrics.durationMs,
        silenceRatio: mediaResult.metrics.silenceRatio,
        snrDb: mediaResult.metrics.snrDb,
        peakDbfs: mediaResult.metrics.peakDbfs,
        audioQuality: mediaResult.quality,
        autocheck: autocheckReport,
        status,
      });
    } else if (audio && audioOk) {
      const path = await this.audioStore.save(clip.id, audio.buffer, audio.ext);
      await this.repo.setClipAudio(clip.id, path);
    }

    let reward = 0;
    if (status === 'peer_review') {
      reward = CONFIG.rewards.record * (CONFIG.rarityMult[rarity] ?? 1);
      await this.repo.addLedger({
        userId: contributorId,
        delta: reward,
        reason: 'record',
        state: 'provisional',
        refClipId: clip.id,
      });
    }
    return {
      clipId: clip.id,
      status,
      reward,
      licenseTag,
      audioQuality: mediaResult?.quality,
    };
  }

  private async serverRarity(region?: string): Promise<Rarity> {
    if (!region) return 0;
    const counts = await this.repo.countClipsByRegion();
    const clips = counts.find((c) => c.region === region)?.clips ?? 0;
    const pct = clips / CONFIG.regionTargetClips;
    if (pct < 0.1) return 2;
    if (pct < 0.4) return 1;
    return 0;
  }

  async nextForValidation(p: Principal): Promise<Clip | null> {
    if (!can(p, 'validate')) throw new ForbiddenError('validate');
    const me = (await this.repo.findUserById(p.userId)) ?? {};
    const candidates = await this.repo.listPeerReview();
    for (const c of candidates) {
      if (c.contributorId === p.userId) continue;
      if (c.requiredCompetence > p.competence) continue;
      if (!sameLinguistic(me, c)) continue;
      if (await this.repo.hasVotedClip(c.id, p.userId)) continue;
      return c;
    }
    return null;
  }

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
    if (!sameLinguistic(me, clip)) throw conflict('wrong_language');
    if (await this.repo.hasVotedClip(clipId, p.userId)) throw conflict('already_voted');

    await this.repo.createVote({ clipId, validatorId: p.userId, verdict, reviewerCompetence: p.competence });
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

  async nextForTranscription(p: Principal): Promise<Clip | null> {
    const me = (await this.repo.findUserById(p.userId)) ?? {};
    const candidates = await this.repo.listClipsByStatus('validated');
    for (const c of candidates) {
      if (c.contributorId === p.userId) continue;
      if (!sameLinguistic(me, c)) continue;
      if (await this.repo.hasTranscribedClip(c.id, p.userId)) continue;
      return c;
    }
    return null;
  }

  async submitTranscription(
    p: Principal,
    input: { clipId?: string; archiveId?: string; text: string; writingSystem: WritingSystem; consistency: number },
  ): Promise<{ id: string; reward: number }> {
    if (!input.clipId && !input.archiveId) throw conflict('target_required');
    if (input.clipId) {
      const clip = await this.repo.getClip(input.clipId);
      if (!clip) throw notFound('clip');
      if (clip.status !== 'validated') throw conflict('clip_not_validated');
      if (clip.contributorId === p.userId) throw conflict('own_clip');
      const me = (await this.repo.findUserById(p.userId)) ?? {};
      if (!sameLinguistic(me, clip)) throw conflict('wrong_language');
      if (await this.repo.hasTranscribedClip(input.clipId, p.userId)) throw conflict('already_transcribed');
    }
    const consistency = 0.6;
    const tr = await this.repo.createTranscription({
      authorId: p.userId,
      clipId: input.clipId,
      archiveId: input.archiveId,
      text: input.text,
      writingSystem: input.writingSystem,
      consistency,
    });
    const reward = CONFIG.rewards.transcribe;
    await this.repo.addLedger({
      userId: p.userId,
      delta: reward,
      reason: 'transcribe',
      state: 'confirmed',
      refTranscriptionId: tr.id,
    });
    return { id: tr.id, reward };
  }

  async voteTranscription(
    p: Principal,
    transcriptionId: string,
    verdict: Verdict,
    input: { writingSystem: WritingSystem; consistency: number },
  ): Promise<{ tier: string; matchesAudio: boolean | null }> {
    if (!can(p, 'validate')) throw new ForbiddenError('validate');
    await this.repo.createVote({
      transcriptionId,
      validatorId: p.userId,
      verdict,
      reviewerCompetence: p.competence,
    });
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
