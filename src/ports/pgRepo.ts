import { type SqlDb } from '../db/sql';
import { type Role, type CompetenceLevel } from '../domain/roles';
import { type ClipState } from '../curation/stateMachine';
import { type Tier } from '../curation/tier';
import {
  type Clip,
  type Vote,
  type LedgerEntry,
  type Transcription,
  type TranscriptionStatus,
  type QualityTranscription,
  type LedgerState,
  type Rarity,
  type Verdict,
  type Consent,
  type AuditEntry,
  type Withdrawal,
  type LanguageRow,
  type DialectRow,
  type PromptRow,
  type DatasetRelease,
  type DatasetItem,
  type ContactChange,
} from '../domain/contribution';
import { type ChatMessage, type Conversation, type ConversationStatus } from '../domain/support';
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
  async bumpTokenVersion(id: string): Promise<number | null> {
    const row = await this.one<{ token_version: number }>(
      'UPDATE users SET token_version = token_version + 1, updated_at = now() WHERE id = $1 RETURNING token_version',
      [id],
    );
    return row?.token_version ?? null;
  }
  async createContactChange(c: Omit<ContactChange, 'id' | 'createdAt'>): Promise<ContactChange> {
    await this.db.query('DELETE FROM contact_changes WHERE user_id = $1', [c.userId]);
    const row = await this.one<ContactChangeRow>(
      `INSERT INTO contact_changes (user_id, new_email, new_phone, verify_phone, code_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [c.userId, c.newEmail ?? null, c.newPhone ?? null, c.verifyPhone, c.codeHash, c.expiresAt],
    );
    return this.mapContactChange(row)!;
  }
  async getContactChange(id: string): Promise<ContactChange | null> {
    return this.mapContactChange(
      await this.one<ContactChangeRow>('SELECT * FROM contact_changes WHERE id = $1', [id]),
    );
  }
  async deleteContactChange(id: string): Promise<void> {
    await this.db.query('DELETE FROM contact_changes WHERE id = $1', [id]);
  }
  async deleteContactChangesForUser(userId: string): Promise<void> {
    await this.db.query('DELETE FROM contact_changes WHERE user_id = $1', [userId]);
  }

  // — chat support —
  async createConversation(c: { userId: string; clipId?: string; subject?: string }): Promise<Conversation> {
    const row = await this.one<ConversationRow>(
      `INSERT INTO conversations (user_id, clip_id, subject)
       VALUES ($1,$2,$3) RETURNING *`,
      [c.userId, c.clipId ?? null, c.subject ?? null],
    );
    return this.mapConversation(row)!;
  }
  async findOpenConversation(userId: string): Promise<Conversation | null> {
    return this.mapConversation(
      await this.one<ConversationRow>(
        "SELECT * FROM conversations WHERE user_id = $1 AND status = 'open'",
        [userId],
      ),
    );
  }
  async findConversationByClipId(clipId: string): Promise<Conversation | null> {
    return this.mapConversation(
      await this.one<ConversationRow>(
        `SELECT * FROM conversations WHERE clip_id = $1
         ORDER BY (status = 'open') DESC, COALESCE(last_message_at, updated_at) DESC
         LIMIT 1`,
        [clipId],
      ),
    );
  }
  async getConversation(id: string): Promise<Conversation | null> {
    return this.mapConversation(
      await this.one<ConversationRow>('SELECT * FROM conversations WHERE id = $1', [id]),
    );
  }
  async listConversations(filter?: {
    status?: ConversationStatus;
    limit?: number;
    offset?: number;
  }): Promise<Conversation[]> {
    const params: unknown[] = [];
    let where = '';
    if (filter?.status) {
      params.push(filter.status);
      where = `WHERE status = $${params.length}`;
    }
    params.push(filter?.limit ?? 50, filter?.offset ?? 0);
    const rows = await this.many<ConversationRow>(
      `SELECT * FROM conversations ${where}
       ORDER BY COALESCE(last_message_at, updated_at) DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map((r) => this.mapConversation(r)!);
  }
  async updateConversation(
    id: string,
    patch: {
      status?: ConversationStatus;
      clipId?: string | null;
      closedAt?: Date | null;
      lastMessageAt?: Date | null;
      userLastReadAt?: Date | null;
      staffLastReadAt?: Date | null;
    },
  ): Promise<Conversation | null> {
    const params: unknown[] = [id];
    const sets: string[] = [];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.status !== undefined) {
      set('status', patch.status);
      if (patch.closedAt === undefined) {
        sets.push(patch.status === 'closed' ? 'closed_at = now()' : 'closed_at = NULL');
      }
    }
    if (patch.clipId !== undefined) set('clip_id', patch.clipId);
    if (patch.closedAt !== undefined) set('closed_at', patch.closedAt);
    if (patch.lastMessageAt !== undefined) set('last_message_at', patch.lastMessageAt);
    if (patch.userLastReadAt !== undefined) set('user_last_read_at', patch.userLastReadAt);
    if (patch.staffLastReadAt !== undefined) set('staff_last_read_at', patch.staffLastReadAt);
    sets.push('updated_at = now()');
    const row = await this.one<ConversationRow>(
      `UPDATE conversations SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    return this.mapConversation(row);
  }
  async addChatMessage(m: Omit<ChatMessage, 'id' | 'createdAt'>): Promise<ChatMessage> {
    const row = await this.one<ChatMessageRow>(
      `INSERT INTO chat_messages (conversation_id, sender_id, sender_role, body)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [m.conversationId, m.senderId, m.senderRole, m.body],
    );
    await this.db.query(
      'UPDATE conversations SET last_message_at = $2, updated_at = now() WHERE id = $1',
      [m.conversationId, row!.created_at],
    );
    return this.mapChatMessage(row)!;
  }
  async listChatMessages(
    conversationId: string,
    opts?: { after?: Date; before?: Date; limit?: number },
  ): Promise<ChatMessage[]> {
    const params: unknown[] = [conversationId];
    const clauses = ['conversation_id = $1'];
    if (opts?.after) {
      params.push(opts.after);
      clauses.push(`created_at > $${params.length}`);
    }
    if (opts?.before) {
      params.push(opts.before);
      clauses.push(`created_at < $${params.length}`);
    }
    params.push(opts?.limit ?? 50);
    const order = opts?.after ? 'ASC' : 'DESC';
    const rows = await this.many<ChatMessageRow>(
      `SELECT * FROM chat_messages WHERE ${clauses.join(' AND ')}
       ORDER BY created_at ${order} LIMIT $${params.length}`,
      params,
    );
    if (order === 'DESC') rows.reverse();
    return rows.map((r) => this.mapChatMessage(r)!);
  }
  async countChatMessagesAfter(
    conversationId: string,
    after: Date | undefined,
    senderRole: ChatMessage['senderRole'],
  ): Promise<number> {
    const params: unknown[] = [conversationId, senderRole];
    let clause = '';
    if (after) {
      params.push(after);
      clause = ` AND created_at > $${params.length}`;
    }
    const row = await this.one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM chat_messages
       WHERE conversation_id = $1 AND sender_role = $2${clause}`,
      params,
    );
    return Number(row?.n ?? 0);
  }

  // — clips —
  async createClip(c: Omit<Clip, 'id' | 'createdAt'>): Promise<Clip> {
    const row = await this.one<ClipRow>(
      `INSERT INTO clips
         (contributor_id, prompt_id, rarity, duration_s, required_competence, language, dialect, region, client_uuid, status,
          commercial_use, consent_version, license_tag, provenance, autocheck)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        c.contributorId, c.promptId ?? null, c.rarity, c.durationS, c.requiredCompetence,
        c.language ?? null, c.dialect ?? null, c.region ?? null, c.clientUuid ?? null, c.status,
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
  async setClipModeration(
    id: string,
    patch: { rejectionCount?: number; deletedAt?: Date | null },
  ) {
    if (patch.rejectionCount !== undefined) {
      await this.db.query('UPDATE clips SET rejection_count = $2 WHERE id = $1', [
        id,
        patch.rejectionCount,
      ]);
    }
    if (patch.deletedAt !== undefined) {
      await this.db.query('UPDATE clips SET deleted_at = $2 WHERE id = $1', [
        id,
        patch.deletedAt,
      ]);
    }
  }
  async clearClipAudio(id: string) {
    await this.db.query(
      `UPDATE clips
       SET audio_path = NULL, audio_ingest_path = NULL, audio_master_path = NULL
       WHERE id = $1`,
      [id],
    );
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
  async listLanguages(opts: { includeInactive?: boolean } = {}): Promise<LanguageRow[]> {
    const rows = await this.many<{ id: string; code: string; name_fr: string; iso_bcp47: string; status: string }>(
      `SELECT id, code, name_fr, iso_bcp47, status FROM languages
       WHERE ($1::boolean OR status = 'active')
       ORDER BY name_fr`,
      [Boolean(opts.includeInactive)],
    );
    return rows.map((r) => ({
      id: r.id, code: r.code, nameFr: r.name_fr, isoBcp47: r.iso_bcp47, status: r.status,
    }));
  }
  async findLanguageByCode(code: string): Promise<LanguageRow | null> {
    const r = await this.one<{ id: string; code: string; name_fr: string; iso_bcp47: string; status: string }>(
      `SELECT id, code, name_fr, iso_bcp47, status FROM languages WHERE code = $1`,
      [code],
    );
    if (!r) return null;
    return { id: r.id, code: r.code, nameFr: r.name_fr, isoBcp47: r.iso_bcp47, status: r.status };
  }
  async updateLanguage(
    code: string,
    patch: { nameFr?: string; isoBcp47?: string; status?: 'active' | 'inactive' },
  ): Promise<LanguageRow | null> {
    const r = await this.one<{ id: string; code: string; name_fr: string; iso_bcp47: string; status: string }>(
      `UPDATE languages SET
         name_fr = COALESCE($2, name_fr),
         iso_bcp47 = COALESCE($3, iso_bcp47),
         status = COALESCE($4, status)
       WHERE code = $1
       RETURNING id, code, name_fr, iso_bcp47, status`,
      [code, patch.nameFr ?? null, patch.isoBcp47 ?? null, patch.status ?? null],
    );
    if (!r) return null;
    return { id: r.id, code: r.code, nameFr: r.name_fr, isoBcp47: r.iso_bcp47, status: r.status };
  }
  async countLanguageRefs(
    code: string,
  ): Promise<{ dialects: number; prompts: number; users: number; clips: number }> {
    const r = await this.one<{ dialects: string; prompts: string; users: string; clips: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM dialects d WHERE d.language_id = l.id AND d.active) AS dialects,
         (SELECT COUNT(*)::text FROM prompts p WHERE p.language_id = l.id AND p.active) AS prompts,
         (SELECT COUNT(*)::text FROM users u WHERE u.language = $1) AS users,
         (SELECT COUNT(*)::text FROM clips c WHERE c.language = $1) AS clips
       FROM languages l WHERE l.code = $1`,
      [code],
    );
    if (!r) return { dialects: 0, prompts: 0, users: 0, clips: 0 };
    return {
      dialects: Number(r.dialects), prompts: Number(r.prompts),
      users: Number(r.users), clips: Number(r.clips),
    };
  }
  async listDialects(
    languageCode?: string,
    opts: { includeInactive?: boolean } = {},
  ): Promise<DialectRow[]> {
    const rows = await this.many<{
      id: string; language_id: string; language_code: string; code: string;
      name_fr: string; zone: string | null; target_hours: string; active: boolean;
    }>(
      `SELECT d.id, d.language_id, l.code AS language_code, d.code, d.name_fr, d.zone,
              d.target_hours::text, d.active
       FROM dialects d JOIN languages l ON l.id = d.language_id
       WHERE ($1::text IS NULL OR l.code = $1)
         AND ($2::boolean OR d.active)
       ORDER BY d.name_fr`,
      [languageCode ?? null, Boolean(opts.includeInactive)],
    );
    return rows.map((r) => ({
      id: r.id,
      languageId: r.language_id,
      languageCode: r.language_code,
      code: r.code,
      nameFr: r.name_fr,
      zone: r.zone ?? undefined,
      targetHours: Number(r.target_hours),
      active: r.active,
    }));
  }
  async findDialectById(id: string): Promise<DialectRow | null> {
    const r = await this.one<{
      id: string; language_id: string; language_code: string; code: string;
      name_fr: string; zone: string | null; target_hours: string; active: boolean;
    }>(
      `SELECT d.id, d.language_id, l.code AS language_code, d.code, d.name_fr, d.zone,
              d.target_hours::text, d.active
       FROM dialects d JOIN languages l ON l.id = d.language_id
       WHERE d.id = $1`,
      [id],
    );
    if (!r) return null;
    return {
      id: r.id,
      languageId: r.language_id,
      languageCode: r.language_code,
      code: r.code,
      nameFr: r.name_fr,
      zone: r.zone ?? undefined,
      targetHours: Number(r.target_hours),
      active: r.active,
    };
  }
  async updateDialect(
    id: string,
    patch: { nameFr?: string; zone?: string | null; targetHours?: number; active?: boolean },
  ): Promise<DialectRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.nameFr !== undefined) push('name_fr', patch.nameFr);
    if (patch.zone !== undefined) push('zone', patch.zone);
    if (patch.targetHours !== undefined) push('target_hours', patch.targetHours);
    if (patch.active !== undefined) push('active', patch.active);
    if (sets.length === 0) return this.findDialectById(id);
    const r = await this.one<{ id: string }>(
      `UPDATE dialects SET ${sets.join(', ')} WHERE id = $1 RETURNING id`,
      params,
    );
    if (!r) return null;
    return this.findDialectById(r.id);
  }
  async countDialectRefs(id: string): Promise<{ prompts: number; users: number; clips: number }> {
    const dialect = await this.findDialectById(id);
    if (!dialect) return { prompts: 0, users: 0, clips: 0 };
    const r = await this.one<{ prompts: string; users: string; clips: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM prompts p
            JOIN languages l ON l.id = p.language_id
            JOIN dialects d ON d.id = p.dialect_id
          WHERE l.code = $1 AND d.code = $2 AND p.active) AS prompts,
         (SELECT COUNT(*)::text FROM users u
          WHERE u.language = $1 AND u.dialect = $2) AS users,
         (SELECT COUNT(*)::text FROM clips c
          WHERE c.language = $1 AND c.dialect = $2) AS clips`,
      [dialect.languageCode, dialect.code],
    );
    return {
      prompts: Number(r?.prompts ?? 0),
      users: Number(r?.users ?? 0),
      clips: Number(r?.clips ?? 0),
    };
  }
  async listActivePrompts(languageCode?: string): Promise<PromptRow[]> {
    return this.listPrompts(languageCode);
  }
  async listPrompts(
    languageCode?: string,
    opts: { includeInactive?: boolean } = {},
  ): Promise<PromptRow[]> {
    const rows = await this.many<{
      id: string; stable_id: string; language_code: string; dialect_code: string | null;
      text: string; writing_system: string; active: boolean;
    }>(
      `SELECT p.id, p.stable_id, l.code AS language_code, d.code AS dialect_code,
              p.text, p.writing_system, p.active
       FROM prompts p
       JOIN languages l ON l.id = p.language_id
       LEFT JOIN dialects d ON d.id = p.dialect_id
       WHERE ($1::text IS NULL OR l.code = $1)
         AND ($2::boolean OR p.active)`,
      [languageCode ?? null, Boolean(opts.includeInactive)],
    );
    return rows.map((r) => ({
      id: r.id,
      stableId: r.stable_id,
      languageCode: r.language_code,
      dialectCode: r.dialect_code ?? undefined,
      text: r.text,
      writingSystem: r.writing_system,
      active: r.active,
    }));
  }
  async getPromptByStableId(stableId: string): Promise<PromptRow | null> {
    const r = await this.one<{
      id: string; stable_id: string; language_code: string; dialect_code: string | null;
      text: string; writing_system: string; active: boolean;
    }>(
      `SELECT p.id, p.stable_id, l.code AS language_code, d.code AS dialect_code,
              p.text, p.writing_system, p.active
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
      active: r.active,
    };
  }
  async updatePrompt(
    stableId: string,
    patch: { text?: string; active?: boolean },
  ): Promise<PromptRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [stableId];
    if (patch.text !== undefined) {
      params.push(patch.text);
      sets.push(`text = $${params.length}`);
    }
    if (patch.active !== undefined) {
      params.push(patch.active);
      sets.push(`active = $${params.length}`);
    }
    if (sets.length > 0) {
      await this.db.query(`UPDATE prompts SET ${sets.join(', ')} WHERE stable_id = $1`, params);
    }
    return this.getPromptByStableId(stableId);
  }
  async countPromptRefs(stableId: string): Promise<{ clips: number }> {
    const r = await this.one<{ clips: string }>(
      `SELECT COUNT(*)::text AS clips FROM clips WHERE prompt_id = $1`,
      [stableId],
    );
    return { clips: Number(r?.clips ?? 0) };
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
  async listQualityClips(filter: { status?: string; language?: string } = {}): Promise<Clip[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter.language) {
      params.push(filter.language);
      where.push(`language = $${params.length}`);
    }
    const sql = `SELECT * FROM clips${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC LIMIT 1000`;
    return (await this.many<ClipRow>(sql, params)).map((r) => this.mapClip(r)!);
  }
  async listQualityTranscriptions(
    filter: { status?: string; language?: string } = {},
  ): Promise<QualityTranscription[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      params.push(filter.status);
      where.push(`t.status = $${params.length}`);
    }
    if (filter.language) {
      params.push(filter.language);
      where.push(`c.language = $${params.length}`);
    }
    const rows = await this.many<TrRow & { language: string | null; dialect: string | null }>(
      `SELECT t.*, c.language, c.dialect
       FROM transcriptions t
       LEFT JOIN clips c ON c.id = t.clip_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.created_at DESC LIMIT 1000`,
      params,
    );
    return rows.map((r) => ({
      ...this.mapTr(r)!,
      language: r.language ?? undefined,
      dialect: r.dialect ?? undefined,
    }));
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
      active: true,
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
      active: true,
    };
  }
  async setPromptActive(stableId: string, active: boolean): Promise<PromptRow | null> {
    return this.updatePrompt(stableId, { active });
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
  async getTranscription(id: string): Promise<Transcription | null> {
    return this.mapTr(await this.one<TrRow>('SELECT * FROM transcriptions WHERE id = $1', [id]));
  }
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
  async setTranscriptionModeration(
    id: string,
    patch: {
      tier?: Tier | null;
      matchesAudio?: boolean | null;
      status?: TranscriptionStatus;
      rejectionCount?: number;
      deletedAt?: Date | null;
    },
  ) {
    if (patch.tier !== undefined) {
      await this.db.query('UPDATE transcriptions SET tier = $2 WHERE id = $1', [id, patch.tier]);
    }
    if (patch.matchesAudio !== undefined) {
      await this.db.query('UPDATE transcriptions SET matches_audio = $2 WHERE id = $1', [
        id,
        patch.matchesAudio,
      ]);
    }
    if (patch.status !== undefined) {
      await this.db.query('UPDATE transcriptions SET status = $2 WHERE id = $1', [
        id,
        patch.status,
      ]);
    }
    if (patch.rejectionCount !== undefined) {
      await this.db.query('UPDATE transcriptions SET rejection_count = $2 WHERE id = $1', [
        id,
        patch.rejectionCount,
      ]);
    }
    if (patch.deletedAt !== undefined) {
      await this.db.query('UPDATE transcriptions SET deleted_at = $2 WHERE id = $1', [
        id,
        patch.deletedAt,
      ]);
    }
  }
  async hasTranscribedClip(clipId: string, authorId: string) {
    return (await this.one('SELECT 1 FROM transcriptions WHERE clip_id = $1 AND author_id = $2', [clipId, authorId])) !== null;
  }

  // — admin —
  async listUsers() {
    return (await this.many<UserRow>('SELECT * FROM users ORDER BY created_at')).map((r) => this.mapUser(r)!);
  }
  async listClipsByStatus(status: ClipState) {
    return (await this.many<ClipRow>('SELECT * FROM clips WHERE status = $1 ORDER BY created_at DESC', [status])).map(
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
      phoneVerified?: boolean;
      language?: string;
      dialect?: string;
      region?: string;
      commercialConsent?: boolean;
    },
  ) {
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
    if (patch.phoneVerified !== undefined) set('phone_verified', patch.phoneVerified);
    if (patch.language !== undefined) set('language', patch.language);
    if (patch.dialect !== undefined) set('dialect', patch.dialect);
    if (patch.region !== undefined) set('region', patch.region);
    if (patch.commercialConsent !== undefined) set('commercial_consent', patch.commercialConsent);
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
      tokenVersion: r.token_version ?? 0,
      status: (r.status as UserStatus) ?? undefined,
      language: r.language ?? undefined, dialect: r.dialect ?? undefined,
      region: r.region ?? undefined, commercialConsent: r.commercial_consent,
    };
  }
  private mapConversation(r: ConversationRow | null): Conversation | null {
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,
      clipId: r.clip_id ?? undefined,
      subject: r.subject ?? undefined,
      status: r.status as ConversationStatus,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
      closedAt: r.closed_at ? new Date(r.closed_at) : undefined,
      lastMessageAt: r.last_message_at ? new Date(r.last_message_at) : undefined,
      userLastReadAt: r.user_last_read_at ? new Date(r.user_last_read_at) : undefined,
      staffLastReadAt: r.staff_last_read_at ? new Date(r.staff_last_read_at) : undefined,
    };
  }
  private mapChatMessage(r: ChatMessageRow | null): ChatMessage | null {
    if (!r) return null;
    return {
      id: r.id,
      conversationId: r.conversation_id,
      senderId: r.sender_id,
      senderRole: r.sender_role as ChatMessage['senderRole'],
      body: r.body,
      createdAt: new Date(r.created_at),
    };
  }
  private mapContactChange(r: ContactChangeRow | null): ContactChange | null {
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,
      newEmail: r.new_email ?? undefined,
      newPhone: r.new_phone ?? undefined,
      verifyPhone: r.verify_phone,
      codeHash: r.code_hash,
      expiresAt: new Date(r.expires_at),
      createdAt: new Date(r.created_at),
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
      rejectionCount: r.rejection_count,
      deletedAt: r.deleted_at ? new Date(r.deleted_at) : undefined,
      createdAt: new Date(r.created_at),
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
      status: r.status as TranscriptionStatus,
      rejectionCount: r.rejection_count,
      deletedAt: r.deleted_at ? new Date(r.deleted_at) : undefined,
    };
  }
}

// — formes de lignes SQL —
interface UserRow {
  id: string; name: string; role: string; competence: number;
  email: string | null; phone: string | null; password_hash: string | null;
  totp_secret: string | null; phone_verified: boolean; status: string | null;
  token_version: number | null;
  language: string | null; dialect: string | null; region: string | null; commercial_consent: boolean;
}
interface ContactChangeRow {
  id: string; user_id: string; new_email: string | null; new_phone: string | null;
  verify_phone: string; code_hash: string; expires_at: string; created_at: string;
}
interface ConversationRow {
  id: string; user_id: string; clip_id: string | null; subject: string | null;
  status: string; created_at: string; updated_at: string;
  closed_at: string | null; last_message_at: string | null;
  user_last_read_at: string | null; staff_last_read_at: string | null;
}
interface ChatMessageRow {
  id: string; conversation_id: string; sender_id: string; sender_role: string;
  body: string; created_at: string;
}
interface WithdrawalRow {
  id: string; user_id: string; amount_fcfa: number; provider: string;
  status: string; created_at: string;
}
interface ClipRow {
  id: string; contributor_id: string; prompt_id: string | null; rarity: number; duration_s: number;
  required_competence: number; language: string | null; dialect: string | null; region: string | null;
  client_uuid: string | null;
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
  rejection_count: number;
  deleted_at: string | null;
  created_at: string;
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
  status: string; rejection_count: number; deleted_at: string | null;
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
