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
    await this.db.query(
      `INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1,$2,$3)
       ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = $3`,
      [phone, code, expiresAt],
    );
  }
  async consumeOtp(phone: string, code: string): Promise<boolean> {
    const row = await this.one<{ code: string; expires_at: string }>(
      'SELECT code, expires_at FROM otp_codes WHERE phone = $1',
      [phone],
    );
    if (!row || row.code !== code || new Date(row.expires_at) < new Date()) return false;
    await this.db.query('DELETE FROM otp_codes WHERE phone = $1', [phone]);
    return true;
  }

  // — clips —
  async createClip(c: Omit<Clip, 'id' | 'createdAt'>): Promise<Clip> {
    const row = await this.one<ClipRow>(
      `INSERT INTO clips
         (contributor_id, prompt_id, rarity, duration_s, required_competence, language, dialect, region, classroom_id, status,
          commercial_use, consent_version, license_tag, provenance, autocheck)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        c.contributorId, c.promptId ?? null, c.rarity, c.durationS, c.requiredCompetence,
        c.language ?? null, c.dialect ?? null, c.region ?? null, c.classroomId ?? null, c.status,
        c.consent.commercialUse, c.consent.consentVersion, c.consent.licenseTag,
        JSON.stringify(c.consent.provenance), c.autocheck ? JSON.stringify(c.autocheck) : null,
      ],
    );
    return this.mapClip(row)!;
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
      status: r.status as ClipState, consent, autocheck: r.autocheck ?? undefined,
      audioPath: r.audio_path ?? undefined,
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
  classroom_id: string | null;
  status: string; commercial_use: boolean; consent_version: string;
  license_tag: string; provenance: Record<string, unknown> | null; autocheck: Record<string, unknown> | null;
  audio_path: string | null;
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
