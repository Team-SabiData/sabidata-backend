import { type SqlDb } from '../db/sql';
import { type Role, type CompetenceLevel } from '../domain/roles';
import { type ClipState } from '../curation/stateMachine';
import { type Tier } from '../curation/tier';
import {
  type Clip,
  type Vote,
  type LedgerEntry,
  type Transcription,
  type LedgerState,
  type Rarity,
  type Verdict,
  type Consent,
  type AuditEntry,
  type Withdrawal,
  type Classroom,
  type LanguageRow,
  type DialectRow,
  type PromptRow,
  type DatasetRelease,
  type DatasetItem,
} from '../domain/contribution';
import { type Repo, type UserRecord, type UserStatus } from './repo';

// Impl Postgres du port Repo — sur toute SqlDb (PGlite en dev, Pool pg en prod).
export class PgRepo implements Repo {
  constructor(private readonly db: SqlDb) {}

  private async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const r = await this.db.query<T>(sql, params);
    return r.rows[0] ?? null;
  }
  private async many<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.db.query<T>(sql, params);
    return r.rows;
  }

  // — auth —
  async findUserByEmail(email: string) {
    return this.mapUser(await this.one<UserRow>('SELECT * FROM users WHERE email = $1', [email]));
  }
  async findUserByPhone(phone: string) {
    return this.mapUser(await this.one<UserRow>('SELECT * FROM users WHERE phone = $1', [phone]));
  }
  async findUserById(id: string) {
    return this.mapUser(await this.one<UserRow>('SELECT * FROM users WHERE id = $1', [id]));
  }
  async createUser(u: Omit<UserRecord, 'id'>): Promise<UserRecord> {
    const row = await this.one<UserRow>(
      `INSERT INTO users (name, role, competence, email, phone, password_hash, totp_secret, phone_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [u.name, u.role, u.competence, u.email ?? null, u.phone ?? null, u.passwordHash ?? null, u.totpSecret ?? null, u.phoneVerified],
    );
    return this.mapUser(row)!;
  }
  async saveOtp(phone: string, code: string, expiresAt: Date) {
    const { hashOtp } = await import('../auth/otp');
    const digest = hashOtp(code);
    await this.db.query(
      `INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1,$2,$3)
       ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = $3`,
      [phone, digest, expiresAt],
    );
  }
  async consumeOtp(phone: string, code: string): Promise<boolean> {
    const { otpMatches } = await import('../auth/otp');
    const row = await this.one<{ code: string; expires_at: string }>(
      'SELECT code, expires_at FROM otp_codes WHERE phone = $1',
      [phone],
    );
    if (!row || new Date(row.expires_at) < new Date() || !otpMatches(code, row.code)) return false;
    await this.db.query('DELETE FROM otp_codes WHERE phone = $1', [phone]);
    return true;
  }

  // — clips —
  async createClip(c: Omit<Clip, 'id' | 'createdAt'>): Promise<Clip> {
    const row = await this.one<ClipRow>(
      `INSERT INTO clips
         (contributor_id, prompt_id, rarity, duration_s, required_competence, language, dialect, region, classroom_id, client_uuid, status,
          commercial_use, consent_version, license_tag, provenance, autocheck)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        c.contributorId, c.promptId ?? null, c.rarity, c.durationS, c.requiredCompetence,
        c.language ?? null, c.dialect ?? null, c.region ?? null, c.classroomId ?? null, c.clientUuid ?? null, c.status,
        c.consent.commercialUse, c.consent.consentVersion, c.consent.licenseTag,
        JSON.stringify(c.consent.provenance), c.autocheck ? JSON.stringify(c.autocheck) : null,
      ],
    );
    return this.mapClip(row)!;
  }
  async findClipByClientUuid(contributorId: string, clientUuid: string) {
    const row = await this.one<ClipRow>(
      'SELECT * FROM clips WHERE contributor_id = $1 AND client_uuid = $2',
      [contributorId, clientUuid],
    );
    return this.mapClip(row);
  }
  async getClip(id: string) {
    return this.mapClip(await this.one<ClipRow>('SELECT * FROM clips WHERE id = $1', [id]));
  }
  async setClipStatus(id: string, status: ClipState, autocheck?: Record<string, unknown>) {
    await this.db.query('UPDATE clips SET status = $2, autocheck = COALESCE($3, autocheck) WHERE id = $1', [
      id, status, autocheck ? JSON.stringify(autocheck) : null,
    ]);
  }
  async setClipAudio(id: string, audioPath: string) {
    await this.db.query('UPDATE clips SET audio_path = $2 WHERE id = $1', [id, audioPath]);
  }
  async setClipMedia(
    id: string,
    media: {
      audioPath: string;
      audioIngestPath: string;
      audioMasterPath: string;
      ingestSha256: string;
      masterSha256: string;
      durationS: number;
      durationMs: number;
      silenceRatio: number;
      snrDb: number | null;
      peakDbfs: number | null;
      audioQuality: 'A' | 'B' | 'C' | 'F';
      autocheck: Record<string, unknown>;
      status: ClipState;
    },
  ) {
    await this.db.query(
      `UPDATE clips SET
         audio_path = $2, audio_ingest_path = $3, audio_master_path = $4,
         ingest_sha256 = $5, master_sha256 = $6,
         duration_s = $7, duration_ms = $8, silence_ratio = $9, snr_db = $10, peak_dbfs = $11,
         audio_quality = $12, autocheck = $13, status = $14
       WHERE id = $1`,
      [
        id,
        media.audioPath,
        media.audioIngestPath,
        media.audioMasterPath,
        media.ingestSha256,
        media.masterSha256,
        media.durationS,
        media.durationMs,
        media.silenceRatio,
        media.snrDb,
        media.peakDbfs,
        media.audioQuality,
        JSON.stringify(media.autocheck),
        media.status,
      ],
    );
  }
  async listPeerReview() {
    return (await this.many<ClipRow>(`SELECT * FROM clips WHERE status = 'peer_review' ORDER BY created_at`)).map(
      (r) => this.mapClip(r)!,
    );
  }
  async countClipsByRegion() {
    const rows = await this.many<{ region: string | null; n: string }>(
      `SELECT region, COUNT(*)::text AS n FROM clips WHERE region IS NOT NULL GROUP BY region`,
    );
    return rows.map((r) => ({ region: r.region as string, clips: Number(r.n) }));
  }
  async listLanguages(): Promise<LanguageRow[]> {
    const rows = await this.many<{ id: string; code: string; name_fr: string; iso_bcp47: string; status: string }>(
      `SELECT id, code, name_fr, iso_bcp47, status FROM languages WHERE status = 'active' ORDER BY name_fr`,
    );
    return rows.map((r) => ({
      id: r.id, code: r.code, nameFr: r.name_fr, isoBcp47: r.iso_bcp47, status: r.status,
    }));
  }
  async listDialects(languageCode?: string): Promise<DialectRow[]> {
    const rows = await this.many<{
      id: string; language_id: string; language_code: string; code: string;
      name_fr: string; zone: string | null; target_hours: string;
    }>(
      `SELECT d.id, d.language_id, l.code AS language_code, d.code, d.name_fr, d.zone, d.target_hours::text
       FROM dialects d JOIN languages l ON l.id = d.language_id
       WHERE ($1::text IS NULL OR l.code = $1)
       ORDER BY d.name_fr`,
      [languageCode ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      languageId: r.language_id,
      languageCode: r.language_code,
      code: r.code,
      nameFr: r.name_fr,
      zone: r.zone ?? undefined,
      targetHours: Number(r.target_hours),
    }));
  }
  async listActivePrompts(languageCode?: string): Promise<PromptRow[]> {
    const rows = await this.many<{
      id: string; stable_id: string; language_code: string; dialect_code: string | null;
      text: string; writing_system: string;
    }>(
      `SELECT p.id, p.stable_id, l.code AS language_code, d.code AS dialect_code, p.text, p.writing_system
       FROM prompts p
       JOIN languages l ON l.id = p.language_id
       LEFT JOIN dialects d ON d.id = p.dialect_id
       WHERE p.active = true AND ($1::text IS NULL OR l.code = $1)`,
      [languageCode ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      stableId: r.stable_id,
      languageCode: r.language_code,
      dialectCode: r.dialect_code ?? undefined,
      text: r.text,
      writingSystem: r.writing_system,
    }));
  }
  async getPromptByStableId(stableId: string): Promise<PromptRow | null> {
    const r = await this.one<{
      id: string; stable_id: string; language_code: string; dialect_code: string | null;
      text: string; writing_system: string;
    }>(
      `SELECT p.id, p.stable_id, l.code AS language_code, d.code AS dialect_code, p.text, p.writing_system
       FROM prompts p
       JOIN languages l ON l.id = p.language_id
       LEFT JOIN dialects d ON d.id = p.dialect_id
       WHERE p.stable_id = $1`,
      [stableId],
    );
    if (!r) return null;
    return {
      id: r.id,
      stableId: r.stable_id,
      languageCode: r.language_code,
      dialectCode: r.dialect_code ?? undefined,
      text: r.text,
      writingSystem: r.writing_system,
    };
  }
  async listQualityQueue(): Promise<Clip[]> {
    return (
      await this.many<ClipRow>(
        `SELECT * FROM clips
         WHERE status = 'rejected' OR audio_quality = 'F'
         ORDER BY created_at DESC
         LIMIT 200`,
      )
    ).map((r) => this.mapClip(r)!);
  }
  async createLanguage(input: { code: string; nameFr: string; isoBcp47: string }): Promise<LanguageRow> {
    const r = await this.one<{ id: string; code: string; name_fr: string; iso_bcp47: string; status: string }>(
      `INSERT INTO languages (code, name_fr, iso_bcp47, status)
       VALUES ($1,$2,$3,'active') RETURNING id, code, name_fr, iso_bcp47, status`,
      [input.code, input.nameFr, input.isoBcp47],
    );
    return { id: r!.id, code: r!.code, nameFr: r!.name_fr, isoBcp47: r!.iso_bcp47, status: r!.status };
  }
  async createDialect(input: {
    languageCode: string; code: string; nameFr: string; zone?: string; targetHours?: number;
  }): Promise<DialectRow> {
    const lang = await this.one<{ id: string }>('SELECT id FROM languages WHERE code = $1', [input.languageCode]);
    if (!lang) throw new Error('language_not_found');
    const r = await this.one<{
      id: string; language_id: string; code: string; name_fr: string; zone: string | null; target_hours: string;
    }>(
      `INSERT INTO dialects (language_id, code, name_fr, zone, target_hours)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, language_id, code, name_fr, zone, target_hours::text`,
      [lang.id, input.code, input.nameFr, input.zone ?? null, input.targetHours ?? 0],
    );
    return {
      id: r!.id,
      languageId: r!.language_id,
      languageCode: input.languageCode,
      code: r!.code,
      nameFr: r!.name_fr,
      zone: r!.zone ?? undefined,
      targetHours: Number(r!.target_hours),
    };
  }
  async createPrompt(input: {
    stableId: string; languageCode: string; dialectCode?: string; text: string;
  }): Promise<PromptRow> {
    const lang = await this.one<{ id: string }>('SELECT id FROM languages WHERE code = $1', [input.languageCode]);
    if (!lang) throw new Error('language_not_found');
    let dialectId: string | null = null;
    if (input.dialectCode) {
      const d = await this.one<{ id: string }>(
        `SELECT d.id FROM dialects d JOIN languages l ON l.id = d.language_id
         WHERE l.code = $1 AND d.code = $2`,
        [input.languageCode, input.dialectCode],
      );
      dialectId = d?.id ?? null;
    }
    const r = await this.one<{ id: string; stable_id: string; text: string; writing_system: string }>(
      `INSERT INTO prompts (stable_id, language_id, dialect_id, text, writing_system, active)
       VALUES ($1,$2,$3,$4,'std',true)
       RETURNING id, stable_id, text, writing_system`,
      [input.stableId, lang.id, dialectId, input.text],
    );
    return {
      id: r!.id,
      stableId: r!.stable_id,
      languageCode: input.languageCode,
      dialectCode: input.dialectCode,
      text: r!.text,
      writingSystem: r!.writing_system,
    };
  }
  async setPromptActive(stableId: string, active: boolean): Promise<PromptRow | null> {
    await this.db.query(`UPDATE prompts SET active = $2 WHERE stable_id = $1`, [stableId, active]);
    return this.getPromptByStableId(stableId);
  }
  async listTranscriptionsForClip(clipId: string): Promise<Transcription[]> {
    return (await this.many<TrRow>('SELECT * FROM transcriptions WHERE clip_id = $1', [clipId])).map(
      (r) => this.mapTr(r)!,
    );
  }
  async createDatasetRelease(r: Omit<DatasetRelease, 'id' | 'createdAt' | 'publishedAt' | 'manifestJsonl' | 'stats'> & {
    filterSpec: Record<string, unknown>;
  }): Promise<DatasetRelease> {
    const row = await this.one<{
      id: string; version: string; status: string; filter_spec: Record<string, unknown>;
      license_tag: string; created_by: string | null; created_at: string;
    }>(
      `INSERT INTO dataset_releases (version, status, filter_spec, license_tag, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, version, status, filter_spec, license_tag, created_by, created_at`,
      [r.version, r.status, JSON.stringify(r.filterSpec), r.licenseTag, r.createdBy ?? null],
    );
    return {
      id: row!.id, version: row!.version, status: row!.status as DatasetRelease['status'],
      filterSpec: row!.filter_spec ?? {}, licenseTag: row!.license_tag,
      createdBy: row!.created_by ?? undefined, createdAt: new Date(row!.created_at),
    };
  }
  async getDatasetRelease(id: string): Promise<DatasetRelease | null> {
    const row = await this.one<DrRow>('SELECT * FROM dataset_releases WHERE id = $1', [id]);
    return this.mapDr(row);
  }
  async getDatasetReleaseByVersion(version: string): Promise<DatasetRelease | null> {
    const row = await this.one<DrRow>('SELECT * FROM dataset_releases WHERE version = $1', [version]);
    return this.mapDr(row);
  }
  async listDatasetReleases(): Promise<DatasetRelease[]> {
    return (await this.many<DrRow>('SELECT * FROM dataset_releases ORDER BY created_at DESC')).map((r) => this.mapDr(r)!);
  }
  async insertDatasetItems(items: Array<Omit<DatasetItem, 'id'>>): Promise<void> {
    for (const it of items) {
      await this.db.query(
        `INSERT INTO dataset_items (release_id, clip_id, transcription_id, split, ordinal, relative_path)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [it.releaseId, it.clipId, it.transcriptionId ?? null, it.split, it.ordinal, it.relativePath],
      );
    }
  }
  async listDatasetItems(releaseId: string): Promise<DatasetItem[]> {
    const rows = await this.many<{
      id: string; release_id: string; clip_id: string; transcription_id: string | null;
      split: string; ordinal: number; relative_path: string;
    }>('SELECT * FROM dataset_items WHERE release_id = $1 ORDER BY ordinal', [releaseId]);
    return rows.map((r) => ({
      id: r.id, releaseId: r.release_id, clipId: r.clip_id,
      transcriptionId: r.transcription_id ?? undefined,
      split: r.split as DatasetItem['split'], ordinal: r.ordinal, relativePath: r.relative_path,
    }));
  }
  async publishDatasetRelease(
    id: string,
    data: { manifestJsonl: string; stats: Record<string, unknown> },
  ): Promise<DatasetRelease | null> {
    await this.db.query(
      `UPDATE dataset_releases
       SET status = 'published', manifest_jsonl = $2, stats = $3, published_at = now()
       WHERE id = $1`,
      [id, data.manifestJsonl, JSON.stringify(data.stats)],
    );
    return this.getDatasetRelease(id);
  }
  private mapDr(r: DrRow | null): DatasetRelease | null {
    if (!r) return null;
    return {
      id: r.id, version: r.version, status: r.status as DatasetRelease['status'],
      filterSpec: r.filter_spec ?? {}, licenseTag: r.license_tag,
      manifestJsonl: r.manifest_jsonl ?? undefined,
      stats: r.stats ?? undefined,
      createdBy: r.created_by ?? undefined,
      createdAt: new Date(r.created_at),
      publishedAt: r.published_at ? new Date(r.published_at) : undefined,
    };
  }


  // — votes —
  async createVote(v: Omit<Vote, 'id' | 'createdAt'>): Promise<Vote> {
    const row = await this.one<VoteRow>(
      `INSERT INTO votes (validator_id, clip_id, transcription_id, verdict, reviewer_competence)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [v.validatorId, v.clipId ?? null, v.transcriptionId ?? null, v.verdict, v.reviewerCompetence],
    );
    return this.mapVote(row)!;
  }
  async hasVotedClip(clipId: string, validatorId: string) {
    return (await this.one('SELECT 1 FROM votes WHERE clip_id = $1 AND validator_id = $2', [clipId, validatorId])) !== null;
  }
  async votesForClip(clipId: string) {
    return (await this.many<VoteRow>('SELECT * FROM votes WHERE clip_id = $1', [clipId])).map((r) => this.mapVote(r)!);
  }
  async votesForTranscription(transcriptionId: string) {
    return (await this.many<VoteRow>('SELECT * FROM votes WHERE transcription_id = $1', [transcriptionId])).map(
      (r) => this.mapVote(r)!,
    );
  }

  // — ledger —
  async addLedger(e: Omit<LedgerEntry, 'id'>) {
    await this.db.query(
      `INSERT INTO points_ledger (user_id, delta, reason, state, ref_clip_id, ref_transcription_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [e.userId, e.delta, e.reason, e.state, e.refClipId ?? null, e.refTranscriptionId ?? null],
    );
  }
  async setRecordLedgerState(clipId: string, state: LedgerState) {
    await this.db.query(
      `UPDATE points_ledger SET state = $2
       WHERE ref_clip_id = $1 AND reason = 'record' AND state = 'provisional'`,
      [clipId, state],
    );
  }
  async ledgerFor(userId: string) {
    return (await this.many<LedgerRow>('SELECT * FROM points_ledger WHERE user_id = $1', [userId])).map(
      (r) => this.mapLedger(r),
    );
  }
  async ledgerHistoryFor(userId: string) {
    const rows = await this.many<LedgerRow & { created_at: string }>(
      `SELECT reason, delta, state, ref_clip_id, created_at
       FROM points_ledger WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({
      reason: r.reason, delta: r.delta, state: r.state,
      createdAt: new Date(r.created_at), refClipId: r.ref_clip_id ?? undefined,
    }));
  }

  // — transcriptions —
  async createTranscription(t: Omit<Transcription, 'id' | 'tier' | 'matchesAudio'>): Promise<Transcription> {
    const row = await this.one<TrRow>(
      `INSERT INTO transcriptions (author_id, clip_id, archive_id, text, writing_system, consistency)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [t.authorId, t.clipId ?? null, t.archiveId ?? null, t.text, t.writingSystem, t.consistency],
    );
    return this.mapTr(row)!;
  }
  async setTranscriptionTier(id: string, tier: Tier, matchesAudio: boolean | null) {
    await this.db.query('UPDATE transcriptions SET tier = $2, matches_audio = $3 WHERE id = $1', [id, tier, matchesAudio]);
  }
  async hasTranscribedClip(clipId: string, authorId: string) {
    return (await this.one('SELECT 1 FROM transcriptions WHERE clip_id = $1 AND author_id = $2', [clipId, authorId])) !== null;
  }

  // — classrooms —
  async createClassroom(c: Omit<Classroom, 'id' | 'createdAt'>) {
    const row = await this.one<ClassroomRow>(
      `INSERT INTO classrooms (name, description, owner_id, invite_code)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [c.name, c.description, c.ownerId, c.inviteCode],
    );
    return this.mapClassroom(row)!;
  }
  async findClassroomById(id: string) {
    return this.mapClassroom(await this.one<ClassroomRow>('SELECT * FROM classrooms WHERE id = $1', [id]));
  }
  async findClassroomByCode(code: string) {
    return this.mapClassroom(await this.one<ClassroomRow>('SELECT * FROM classrooms WHERE invite_code = $1', [code]));
  }
  async listClassroomMembers(classroomId: string) {
    return (await this.many<UserRow>('SELECT * FROM users WHERE classroom_id = $1 ORDER BY name', [classroomId])).map(
      (r) => this.mapUser(r)!,
    );
  }
  async countClipsByClassroom(classroomId: string) {
    const row = await this.one<{ n: string }>('SELECT COUNT(*)::text AS n FROM clips WHERE classroom_id = $1', [classroomId]);
    return Number(row?.n ?? 0);
  }

  async listUsers() {
    return (await this.many<UserRow>('SELECT * FROM users ORDER BY created_at')).map((r) => this.mapUser(r)!);
  }
  async listClipsByStatus(status: ClipState) {
    return (await this.many<ClipRow>('SELECT * FROM clips WHERE status = $1 ORDER BY created_at', [status])).map(
      (r) => this.mapClip(r)!,
    );
  }
  async updateUser(
    id: string,
    patch: {
      role?: Role;
      competence?: CompetenceLevel;
      status?: UserStatus;
      name?: string;
      email?: string | null;
      phone?: string | null;
      passwordHash?: string | null;
      totpSecret?: string | null;
      language?: string;
      dialect?: string;
      region?: string;
      commercialConsent?: boolean;
      classroomId?: string | null;
    },
  ) {
    // SET dynamique : contrairement à COALESCE, ça permet de repasser
    // explicitement email/phone/... à NULL (anonymisation D4).
    const params: unknown[] = [id];
    const sets: string[] = [];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.role !== undefined) set('role', patch.role);
    if (patch.competence !== undefined) set('competence', patch.competence);
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.email !== undefined) set('email', patch.email);
    if (patch.phone !== undefined) set('phone', patch.phone);
    if (patch.passwordHash !== undefined) set('password_hash', patch.passwordHash);
    if (patch.totpSecret !== undefined) set('totp_secret', patch.totpSecret);
    if (patch.language !== undefined) set('language', patch.language);
    if (patch.dialect !== undefined) set('dialect', patch.dialect);
    if (patch.region !== undefined) set('region', patch.region);
    if (patch.commercialConsent !== undefined) set('commercial_consent', patch.commercialConsent);
    if (patch.classroomId !== undefined) set('classroom_id', patch.classroomId);
    if (sets.length === 0) return this.findUserById(id);
    sets.push('updated_at = now()');
    const row = await this.one<UserRow>(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    return this.mapUser(row);
  }

  // — retraits —
  async createWithdrawal(w: Omit<Withdrawal, 'id' | 'createdAt' | 'status'>): Promise<Withdrawal> {
    const row = await this.one<WithdrawalRow>(
      `INSERT INTO withdrawals (user_id, amount_fcfa, provider) VALUES ($1,$2,$3) RETURNING *`,
      [w.userId, w.amountFcfa, w.provider],
    );
    return this.mapWithdrawal(row)!;
  }
  async listWithdrawals(status?: Withdrawal['status']) {
    return (
      await this.many<WithdrawalRow>(
        `SELECT * FROM withdrawals WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at`,
        [status ?? null],
      )
    ).map((r) => this.mapWithdrawal(r)!);
  }
  async getWithdrawal(id: string) {
    return this.mapWithdrawal(await this.one<WithdrawalRow>('SELECT * FROM withdrawals WHERE id = $1', [id]));
  }
  async setWithdrawalStatus(id: string, status: 'paid' | 'failed') {
    await this.db.query('UPDATE withdrawals SET status = $2 WHERE id = $1', [id, status]);
  }

  // — audit (append-only) —
  async addAudit(e: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<AuditEntry> {
    const row = await this.one<AuditRow>(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, reason, metadata)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [e.actorId, e.action, e.entityType, e.entityId, e.reason ?? null, e.metadata ? JSON.stringify(e.metadata) : null],
    );
    return this.mapAudit(row)!;
  }
  async listAudit(filter?: { actorId?: string; entityId?: string; action?: string }) {
    return (
      await this.many<AuditRow>(
        `SELECT * FROM audit_log
         WHERE ($1::uuid IS NULL OR actor_id = $1) AND ($2::text IS NULL OR entity_id = $2)
           AND ($3::text IS NULL OR action = $3)
         ORDER BY created_at`,
        [filter?.actorId ?? null, filter?.entityId ?? null, filter?.action ?? null],
      )
    ).map((r) => this.mapAudit(r)!);
  }

  // — mappers row -> domaine —
  private mapUser(r: UserRow | null): UserRecord | null {
    if (!r) return null;
    return {
      id: r.id, name: r.name, role: r.role as Role, competence: r.competence as CompetenceLevel,
      email: r.email ?? undefined, phone: r.phone ?? undefined,
      passwordHash: r.password_hash ?? undefined, phoneVerified: r.phone_verified,
      totpSecret: r.totp_secret ?? undefined,
      status: (r.status as UserStatus) ?? undefined,
      language: r.language ?? undefined, dialect: r.dialect ?? undefined,
      region: r.region ?? undefined, commercialConsent: r.commercial_consent,
      classroomId: r.classroom_id ?? undefined,
    };
  }
  private mapWithdrawal(r: WithdrawalRow | null): Withdrawal | null {
    if (!r) return null;
    return {
      id: r.id, userId: r.user_id, amountFcfa: r.amount_fcfa, provider: r.provider,
      status: r.status as Withdrawal['status'], createdAt: new Date(r.created_at),
    };
  }
  private mapClip(r: ClipRow | null): Clip | null {
    if (!r) return null;
    const consent: Consent = {
      commercialUse: r.commercial_use, consentVersion: r.consent_version,
      licenseTag: r.license_tag, provenance: r.provenance ?? {},
    };
    return {
      id: r.id, contributorId: r.contributor_id, promptId: r.prompt_id ?? undefined,
      rarity: r.rarity as Rarity, durationS: r.duration_s, requiredCompetence: r.required_competence,
      language: r.language ?? undefined, dialect: r.dialect ?? undefined, region: r.region ?? undefined,
      classroomId: r.classroom_id ?? undefined,
      clientUuid: r.client_uuid ?? undefined,
      status: r.status as ClipState, consent, autocheck: r.autocheck ?? undefined,
      audioPath: r.audio_path ?? undefined,
      audioIngestPath: r.audio_ingest_path ?? undefined,
      audioMasterPath: r.audio_master_path ?? undefined,
      ingestSha256: r.ingest_sha256 ?? undefined,
      masterSha256: r.master_sha256 ?? undefined,
      durationMs: r.duration_ms ?? undefined,
      silenceRatio: r.silence_ratio != null ? Number(r.silence_ratio) : undefined,
      snrDb: r.snr_db != null ? Number(r.snr_db) : undefined,
      peakDbfs: r.peak_dbfs != null ? Number(r.peak_dbfs) : undefined,
      audioQuality: (r.audio_quality as Clip['audioQuality']) ?? undefined,
      createdAt: new Date(r.created_at),
    };
  }
  private mapClassroom(r: ClassroomRow | null): Classroom | null {
    if (!r) return null;
    return {
      id: r.id, name: r.name, description: r.description, ownerId: r.owner_id,
      inviteCode: r.invite_code, createdAt: new Date(r.created_at),
    };
  }
  private mapVote(r: VoteRow | null): Vote | null {
    if (!r) return null;
    return {
      id: r.id, clipId: r.clip_id ?? undefined, transcriptionId: r.transcription_id ?? undefined,
      validatorId: r.validator_id, verdict: r.verdict as Verdict,
      reviewerCompetence: r.reviewer_competence, createdAt: new Date(r.created_at),
    };
  }
  private mapLedger(r: LedgerRow): LedgerEntry {
    return {
      id: r.id, userId: r.user_id, delta: r.delta, reason: r.reason as LedgerEntry['reason'],
      state: r.state as LedgerState, refClipId: r.ref_clip_id ?? undefined,
      refTranscriptionId: r.ref_transcription_id ?? undefined,
    };
  }
  private mapAudit(r: AuditRow | null): AuditEntry | null {
    if (!r) return null;
    return {
      id: r.id, actorId: r.actor_id, action: r.action, entityType: r.entity_type,
      entityId: r.entity_id, reason: r.reason ?? undefined,
      metadata: r.metadata ?? undefined, createdAt: new Date(r.created_at),
    };
  }
  private mapTr(r: TrRow | null): Transcription | null {
    if (!r) return null;
    return {
      id: r.id, authorId: r.author_id, clipId: r.clip_id ?? undefined, archiveId: r.archive_id ?? undefined,
      text: r.text, writingSystem: r.writing_system as Transcription['writingSystem'],
      consistency: Number(r.consistency), matchesAudio: r.matches_audio, tier: (r.tier as Tier) ?? null,
    };
  }
}

// — formes de lignes SQL —
interface UserRow {
  id: string; name: string; role: string; competence: number;
  email: string | null; phone: string | null; password_hash: string | null;
  totp_secret: string | null; phone_verified: boolean; status: string | null;
  language: string | null; dialect: string | null; region: string | null; commercial_consent: boolean;
  classroom_id: string | null;
}
interface WithdrawalRow {
  id: string; user_id: string; amount_fcfa: number; provider: string;
  status: string; created_at: string;
}
interface ClipRow {
  id: string; contributor_id: string; prompt_id: string | null; rarity: number; duration_s: number;
  required_competence: number; language: string | null; dialect: string | null; region: string | null;
  classroom_id: string | null; client_uuid: string | null;
  status: string; commercial_use: boolean; consent_version: string;
  license_tag: string; provenance: Record<string, unknown> | null; autocheck: Record<string, unknown> | null;
  audio_path: string | null;
  audio_ingest_path: string | null;
  audio_master_path: string | null;
  ingest_sha256: string | null;
  master_sha256: string | null;
  duration_ms: number | null;
  silence_ratio: string | null;
  snr_db: string | null;
  peak_dbfs: string | null;
  audio_quality: string | null;
  created_at: string;
}
interface ClassroomRow {
  id: string; name: string; description: string; owner_id: string; invite_code: string; created_at: string;
}
interface VoteRow {
  id: string; validator_id: string; clip_id: string | null; transcription_id: string | null;
  verdict: string; reviewer_competence: number; created_at: string;
}
interface LedgerRow {
  id: string; user_id: string; delta: number; reason: string; state: string;
  ref_clip_id: string | null; ref_transcription_id: string | null;
}
interface TrRow {
  id: string; author_id: string; clip_id: string | null; archive_id: string | null; text: string;
  writing_system: string; consistency: string; matches_audio: boolean | null; tier: string | null;
}
interface AuditRow {
  id: string; actor_id: string; action: string; entity_type: string; entity_id: string;
  reason: string | null; metadata: Record<string, unknown> | null; created_at: string;
}
interface DrRow {
  id: string; version: string; status: string; filter_spec: Record<string, unknown> | null;
  license_tag: string; manifest_jsonl: string | null; stats: Record<string, unknown> | null;
  created_by: string | null; created_at: string; published_at: string | null;
}
