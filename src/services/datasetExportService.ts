import { createHash } from 'node:crypto';
import { ZipArchive, type Archiver } from 'archiver';
import { type Principal, can, ForbiddenError } from '../authz/can';
import { type Repo } from '../ports/repo';
import {
  type Clip,
  type DatasetItem,
  type DatasetRelease,
  type DatasetSplit,
  type Transcription,
} from '../domain/contribution';
import { type Tier } from '../curation/tier';
import { type AudioStore, InMemoryAudioStore } from '../storage/audioStore';
import { conflict, notFound } from '../errors';

export interface ExportFilter {
  languages?: string[];
  /** Défaut ['A','B','C'] */
  audioQualities?: Array<'A' | 'B' | 'C'>;
  /** Défaut ['gold','silver','bronze'] */
  minTiers?: Array<'gold' | 'silver' | 'bronze'>;
  commercialOnly?: boolean;
  aOnly?: boolean;
}

export type CatalogGroupBy = 'language' | 'dialect' | 'quality' | 'tier';

export interface CatalogFilter {
  language?: string;
  dialect?: string;
  quality?: 'A' | 'B' | 'C';
  tier?: 'gold' | 'silver' | 'bronze';
}

const TIER_RANK: Record<string, number> = { gold: 3, silver: 2, bronze: 1, raw: 0 };

function speakerHash(contributorId: string): string {
  const salt = process.env.DATASET_SPEAKER_SALT ?? 'sabidata-speaker';
  return createHash('sha256').update(`${salt}:${contributorId}`).digest('hex').slice(0, 16);
}

function pickCanonical(trs: Transcription[]): Transcription | null {
  const ranked = trs
    .filter((t) => t.status !== 'rejected' && t.status !== 'deleted')
    .filter((t) => t.tier && TIER_RANK[t.tier] != null)
    .sort((a, b) => (TIER_RANK[b.tier!] ?? 0) - (TIER_RANK[a.tier!] ?? 0));
  return ranked[0] ?? null;
}

/** Split stable 80/10/10 par dialecte, un contributeur = un seul split. */
export function assignSplitsBySpeaker(
  rows: Array<{ contributorId: string; dialectKey: string }>,
  seed: string,
): Map<string, DatasetSplit> {
  const byDialect = new Map<string, string[]>();
  for (const r of rows) {
    const list = byDialect.get(r.dialectKey) ?? [];
    if (!list.includes(r.contributorId)) list.push(r.contributorId);
    byDialect.set(r.dialectKey, list);
  }
  const out = new Map<string, DatasetSplit>();
  for (const [, speakers] of byDialect) {
    const sorted = [...speakers].sort((a, b) => {
      const ha = createHash('sha256').update(`${seed}:${a}`).digest('hex');
      const hb = createHash('sha256').update(`${seed}:${b}`).digest('hex');
      return ha.localeCompare(hb);
    });
    const n = sorted.length;
    const nTrain = Math.max(1, Math.floor(n * 0.8));
    const nDev = Math.max(n > 2 ? 1 : 0, Math.floor(n * 0.1));
    sorted.forEach((id, i) => {
      let split: DatasetSplit = 'train';
      if (i >= nTrain + nDev) split = 'test';
      else if (i >= nTrain) split = 'dev';
      out.set(id, split);
    });
  }
  return out;
}

type Eligible = {
  clip: Clip;
  transcription: Transcription;
  language: string;
  dialect: string;
  tier: Tier;
};

export class DatasetExportService {
  constructor(
    private readonly repo: Repo,
    private readonly audioStore: AudioStore = new InMemoryAudioStore(),
  ) {}

  async createRelease(
    p: Principal,
    input: { version: string; filter?: ExportFilter; licenseTag?: string },
  ): Promise<{ release: DatasetRelease; itemCount: number; preview: string[] }> {
    if (!can(p, 'export.run')) throw new ForbiddenError('export.run');
    const version = input.version.trim();
    if (!/^sabidata-[a-z0-9.-]+-v\d+\.\d+\.\d+$/i.test(version) && !/^v?\d+\.\d+\.\d+/.test(version)) {
      // Accepte sabidata-mos-v1.0.0 ou v1.0.0
      if (!version) throw conflict('version_required');
    }
    const existing = await this.repo.getDatasetReleaseByVersion(version);
    if (existing) throw conflict('version_exists');

    const filter: ExportFilter = {
      commercialOnly: true,
      audioQualities: input.filter?.aOnly ? ['A'] : (input.filter?.audioQualities ?? ['A', 'B', 'C']),
      minTiers: input.filter?.minTiers ?? ['gold', 'silver', 'bronze'],
      languages: input.filter?.languages,
      aOnly: input.filter?.aOnly,
    };

    const eligible = await this.collectEligible(filter);
    if (eligible.length === 0) throw conflict('no_eligible_clips');

    const splitMap = assignSplitsBySpeaker(
      eligible.map((e) => ({
        contributorId: e.clip.contributorId,
        dialectKey: `${e.language}|${e.dialect}`,
      })),
      version,
    );

    const ordered = [...eligible].sort((a, b) => {
      const ka = `${a.language}\0${a.dialect}\0${splitMap.get(a.clip.contributorId) ?? 'train'}\0${a.tier}\0${a.clip.id}`;
      const kb = `${b.language}\0${b.dialect}\0${splitMap.get(b.clip.contributorId) ?? 'train'}\0${b.tier}\0${b.clip.id}`;
      return ka.localeCompare(kb);
    });

    const release = await this.repo.createDatasetRelease({
      version,
      status: 'drafting',
      filterSpec: filter as unknown as Record<string, unknown>,
      licenseTag: input.licenseTag ?? 'commercial',
      createdBy: p.userId,
    });

    const items: Array<Omit<DatasetItem, 'id'>> = [];
    const manifestLines: string[] = [];
    let ordinal = 0;
    for (const e of ordered) {
      ordinal += 1;
      const split = splitMap.get(e.clip.contributorId) ?? 'train';
      const relativePath = `audio/${e.language}/${e.dialect}/${split}/${String(ordinal).padStart(6, '0')}.wav`;
      items.push({
        releaseId: release.id,
        clipId: e.clip.id,
        transcriptionId: e.transcription.id,
        split,
        ordinal,
        relativePath,
      });
      manifestLines.push(this.manifestLine(e, split, relativePath, ordinal));
    }

    await this.repo.insertDatasetItems(items);
    const stats = {
      clips: items.length,
      train: items.filter((i) => i.split === 'train').length,
      dev: items.filter((i) => i.split === 'dev').length,
      test: items.filter((i) => i.split === 'test').length,
      byLanguage: Object.fromEntries(
        [...new Set(ordered.map((e) => e.language))].map((lang) => [
          lang,
          ordered.filter((e) => e.language === lang).length,
        ]),
      ),
    };
    const manifestJsonl = `${manifestLines.join('\n')}\n`;
    const published = await this.repo.publishDatasetRelease(release.id, {
      manifestJsonl,
      stats,
    });

    await this.repo.addAudit({
      actorId: p.userId,
      action: 'export.run',
      entityType: 'dataset_release',
      entityId: release.id,
      reason: `publish ${version}`,
      metadata: stats,
    });

    return {
      release: published ?? release,
      itemCount: items.length,
      preview: manifestLines.slice(0, 3),
    };
  }

  async listReleases(p: Principal): Promise<DatasetRelease[]> {
    if (!can(p, 'export.run')) throw new ForbiddenError('export.run');
    return this.repo.listDatasetReleases();
  }

  async getRelease(p: Principal, id: string): Promise<DatasetRelease & { items: DatasetItem[] }> {
    if (!can(p, 'export.run')) throw new ForbiddenError('export.run');
    const release = await this.repo.getDatasetRelease(id);
    if (!release) throw notFound('dataset_release');
    const items = await this.repo.listDatasetItems(id);
    return { ...release, items };
  }

  /** Catalogue qualité : tout le validé A/B/C, tous les tiers, filtrable. */
  async catalog(p: Principal, groupBy: CatalogGroupBy, filter: CatalogFilter = {}) {
    if (!can(p, 'export.run')) throw new ForbiddenError('export.run');
    if (!['language', 'dialect', 'quality', 'tier'].includes(groupBy)) {
      throw conflict('invalid_group_by');
    }
    const entries = await this.collectCatalog(filter);
    const groups = new Map<string, number>();
    for (const e of entries) {
      const key = this.catalogKey(e, groupBy);
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    return {
      groupBy,
      total: entries.length,
      groups: [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => ({ key, count })),
    };
  }

  async catalogJsonl(p: Principal, filter: CatalogFilter = {}): Promise<string> {
    if (!can(p, 'export.run')) throw new ForbiddenError('export.run');
    const entries = await this.collectCatalog(filter);
    if (entries.length === 0) throw conflict('no_eligible_clips');
    return this.buildCatalogManifest(entries).manifestJsonl;
  }

  async catalogArchive(
    p: Principal,
    filter: CatalogFilter = {},
  ): Promise<{ archive: Archiver; itemCount: number }> {
    if (!can(p, 'export.run')) throw new ForbiddenError('export.run');
    const entries = await this.collectCatalog(filter);
    if (entries.length === 0) throw conflict('no_eligible_clips');

    const splitMap = assignSplitsBySpeaker(
      entries.map((e) => ({
        contributorId: e.clip.contributorId,
        dialectKey: `${e.language}|${e.dialect}`,
      })),
      'catalog-v1',
    );
    const ordered = this.orderCatalog(entries, splitMap);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const lines: string[] = [];
    let ordinal = 0;
    for (const e of ordered) {
      const source = e.clip.audioMasterPath ?? e.clip.audioPath;
      if (!source) continue;
      const stream = await this.audioStore.openRead(source);
      if (!stream) continue;
      ordinal += 1;
      const split = splitMap.get(e.clip.contributorId) ?? 'train';
      const ext = source.split('.').pop()?.toLowerCase() || 'wav';
      const relativePath = `audio/${e.language}/${e.dialect}/${split}/${String(ordinal).padStart(6, '0')}.${ext}`;
      archive.append(stream, { name: relativePath });
      lines.push(this.manifestLine(e, split, relativePath, ordinal));
    }
    archive.append(`${lines.join('\n')}\n`, { name: 'metadata.jsonl' });
    void archive.finalize();
    return { archive, itemCount: lines.length };
  }

  private catalogKey(e: Eligible, groupBy: CatalogGroupBy): string {
    if (groupBy === 'language') return e.language;
    if (groupBy === 'dialect') return `${e.language}/${e.dialect}`;
    if (groupBy === 'quality') return e.clip.audioQuality ?? 'unknown';
    return e.tier;
  }

  private orderCatalog(entries: Eligible[], splitMap: Map<string, DatasetSplit>): Eligible[] {
    return [...entries].sort((a, b) => {
      const ka = `${a.language}\0${a.dialect}\0${splitMap.get(a.clip.contributorId) ?? 'train'}\0${a.tier}\0${a.clip.id}`;
      const kb = `${b.language}\0${b.dialect}\0${splitMap.get(b.clip.contributorId) ?? 'train'}\0${b.tier}\0${b.clip.id}`;
      return ka.localeCompare(kb);
    });
  }

  private buildCatalogManifest(entries: Eligible[]): {
    manifestJsonl: string;
    splits: Map<string, DatasetSplit>;
  } {
    const splitMap = assignSplitsBySpeaker(
      entries.map((e) => ({
        contributorId: e.clip.contributorId,
        dialectKey: `${e.language}|${e.dialect}`,
      })),
      'catalog-v1',
    );
    const ordered = this.orderCatalog(entries, splitMap);
    const lines = ordered.map((e, index) => {
      const split = splitMap.get(e.clip.contributorId) ?? 'train';
      const source = e.clip.audioMasterPath ?? e.clip.audioPath ?? '';
      const ext = source.split('.').pop()?.toLowerCase() || 'wav';
      const relativePath = `audio/${e.language}/${e.dialect}/${split}/${String(index + 1).padStart(6, '0')}.${ext}`;
      return this.manifestLine(e, split, relativePath, index + 1);
    });
    return { manifestJsonl: `${lines.join('\n')}\n`, splits: splitMap };
  }

  private manifestLine(e: Eligible, split: DatasetSplit, relativePath: string, ordinal: number): string {
    return JSON.stringify({
      id: e.clip.id,
      path: relativePath,
      sentence: e.transcription.text,
      language: e.language,
      dialect: e.dialect,
      split,
      ordinal,
      duration_ms: e.clip.durationMs ?? e.clip.durationS * 1000,
      sample_rate: 16000,
      channels: 1,
      bit_depth: 16,
      audio_quality: e.clip.audioQuality ?? null,
      annotation_tier: e.tier,
      writing_system: e.transcription.writingSystem,
      consent_version: e.clip.consent.consentVersion,
      license: e.clip.consent.licenseTag,
      speaker_hash: speakerHash(e.clip.contributorId),
      master_sha256: e.clip.masterSha256 ?? null,
    });
  }

  private async collectCatalog(filter: CatalogFilter): Promise<Eligible[]> {
    const entries = await this.collectEligible({
      commercialOnly: false,
      audioQualities: ['A', 'B', 'C'],
      minTiers: ['gold', 'silver', 'bronze'],
      languages: filter.language ? [filter.language] : undefined,
    });
    return entries.filter((e) => {
      if (filter.dialect && e.dialect !== filter.dialect) return false;
      if (filter.quality && e.clip.audioQuality !== filter.quality) return false;
      if (filter.tier && e.tier !== filter.tier) return false;
      return true;
    });
  }

  private async collectEligible(filter: ExportFilter): Promise<Eligible[]> {
    const clips = await this.repo.listClipsByStatus('validated');
    const qualities = new Set(filter.audioQualities ?? ['A', 'B', 'C']);
    const tiers = new Set(filter.minTiers ?? ['gold', 'silver', 'bronze']);
    const langs = filter.languages?.length ? new Set(filter.languages.map((l) => l.toLowerCase())) : null;
    const out: Eligible[] = [];

    for (const clip of clips) {
      if (clip.deletedAt) continue;
      if (filter.commercialOnly !== false && !clip.consent.commercialUse) continue;
      if (!clip.audioPath && !clip.audioMasterPath) continue;
      const q = clip.audioQuality;
      if (q) {
        if (!qualities.has(q as 'A' | 'B' | 'C')) continue;
      } else {
        // Clips legacy sans grade : exclus du release clean (qualité inconnue).
        continue;
      }
      const lang = (clip.language ?? 'unknown').toLowerCase();
      const dialect = (clip.dialect ?? 'unknown').toLowerCase().replace(/\s+/g, '-');
      if (langs && ![...langs].some((l) => lang.includes(l) || l.includes(lang))) continue;

      const trs = await this.repo.listTranscriptionsForClip(clip.id);
      const canon = pickCanonical(trs);
      if (!canon?.tier || !tiers.has(canon.tier as 'gold' | 'silver' | 'bronze')) continue;

      out.push({
        clip,
        transcription: canon,
        language: lang,
        dialect,
        tier: canon.tier,
      });
    }
    return out;
  }
}
