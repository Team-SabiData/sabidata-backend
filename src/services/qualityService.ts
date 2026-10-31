import { type Principal, can, ForbiddenError } from '../authz/can';
import { type Repo } from '../ports/repo';
import { badRequest } from '../errors';

export type QualityType = 'clips' | 'transcriptions' | 'all';

export interface QualityQuery {
  type?: QualityType;
  status?: string;
  language?: string;
  page?: number;
  limit?: number;
}

function voteSummary(votes: Array<{ verdict: string }>) {
  return {
    correct: votes.filter((v) => v.verdict === 'correct').length,
    problem: votes.filter((v) => v.verdict === 'problem').length,
    unsure: votes.filter((v) => v.verdict === 'unsure').length,
    total: votes.length,
  };
}

/** Vue admin unifiée clips + transcriptions pour la modération qualité. */
export class QualityService {
  constructor(private readonly repo: Repo) {}

  async list(p: Principal, query: QualityQuery = {}) {
    if (!can(p, 'content.moderate')) throw new ForbiddenError('content.moderate');
    const type = query.type ?? 'all';
    if (!['clips', 'transcriptions', 'all'].includes(type)) {
      throw badRequest('BAD_QUALITY_TYPE');
    }
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 50)));
    const filter = {
      status: query.status?.trim() || undefined,
      language: query.language?.trim() || undefined,
    };

    const clips = type === 'transcriptions'
      ? []
      : await this.repo.listQualityClips(filter);
    const transcriptions = type === 'clips'
      ? []
      : await this.repo.listQualityTranscriptions(filter);

    const clipItems = [];
    for (const c of clips) {
      clipItems.push({
        id: c.id,
        status: c.status,
        language: c.language ?? null,
        dialect: c.dialect ?? null,
        audioQuality: c.audioQuality ?? null,
        rejectionCount: c.rejectionCount ?? 0,
        deletedAt: c.deletedAt ?? null,
        audioPurged: !c.audioPath && !c.audioIngestPath && !c.audioMasterPath,
        contributorId: c.contributorId,
        promptId: c.promptId ?? null,
        createdAt: c.createdAt,
        votes: voteSummary(await this.repo.votesForClip(c.id)),
      });
    }

    const transcriptionItems = [];
    for (const t of transcriptions) {
      transcriptionItems.push({
        id: t.id,
        clipId: t.clipId ?? null,
        archiveId: t.archiveId ?? null,
        status: t.status ?? 'pending',
        language: t.language ?? null,
        dialect: t.dialect ?? null,
        tier: t.tier,
        matchesAudio: t.matchesAudio,
        rejectionCount: t.rejectionCount ?? 0,
        deletedAt: t.deletedAt ?? null,
        authorId: t.authorId,
        text: t.text,
        votes: voteSummary(await this.repo.votesForTranscription(t.id)),
      });
    }

    const start = (page - 1) * limit;
    return {
      page,
      limit,
      total: {
        clips: clipItems.length,
        transcriptions: transcriptionItems.length,
      },
      clips: clipItems.slice(start, start + limit),
      transcriptions: transcriptionItems.slice(start, start + limit),
    };
  }
}
