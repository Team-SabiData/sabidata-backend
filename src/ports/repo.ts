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

export type UserStatus = 'active' | 'suspended' | 'banned' | 'deleted';

export interface UserRecord {
  id: string;
  name: string;
  role: Role;
  competence: CompetenceLevel;
  email?: string;
  phone?: string;
  passwordHash?: string;
  phoneVerified: boolean;
  totpSecret?: string;
  tokenVersion?: number;
  status?: UserStatus; // absent = 'active'
  language?: string;
  dialect?: string;
  region?: string;
  commercialConsent?: boolean;
}

// Port de persistance unique. L'impl Postgres/Drizzle remplacera InMemoryRepo ;
// le reste du code ne dépend que de cette interface.
export interface Repo {
  // — auth —
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserByPhone(phone: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  createUser(u: Omit<UserRecord, 'id'>): Promise<UserRecord>;
  saveOtp(phone: string, code: string, expiresAt: Date): Promise<void>;
  consumeOtp(phone: string, code: string): Promise<boolean>;
  /** Incrémente la version de session (logout / reset mot de passe). */
  bumpTokenVersion(id: string): Promise<number | null>;
  createContactChange(c: Omit<ContactChange, 'id' | 'createdAt'>): Promise<ContactChange>;
  getContactChange(id: string): Promise<ContactChange | null>;
  deleteContactChange(id: string): Promise<void>;
  deleteContactChangesForUser(userId: string): Promise<void>;

  // — chat support —
  createConversation(c: {
    userId: string;
    clipId?: string;
    subject?: string;
  }): Promise<Conversation>;
  findOpenConversation(userId: string): Promise<Conversation | null>;
  findConversationByClipId(clipId: string): Promise<Conversation | null>;
  getConversation(id: string): Promise<Conversation | null>;
  listConversations(filter?: {
    status?: ConversationStatus;
    limit?: number;
    offset?: number;
  }): Promise<Conversation[]>;
  updateConversation(
    id: string,
    patch: {
      status?: ConversationStatus;
      clipId?: string | null;
      closedAt?: Date | null;
      lastMessageAt?: Date | null;
      userLastReadAt?: Date | null;
      staffLastReadAt?: Date | null;
    },
  ): Promise<Conversation | null>;
  addChatMessage(m: Omit<ChatMessage, 'id' | 'createdAt'>): Promise<ChatMessage>;
  listChatMessages(
    conversationId: string,
    opts?: { after?: Date; before?: Date; limit?: number },
  ): Promise<ChatMessage[]>;
  countChatMessagesAfter(
    conversationId: string,
    after: Date | undefined,
    senderRole: ChatMessage['senderRole'],
  ): Promise<number>;

  // — contribution —
  createClip(c: Omit<Clip, 'id' | 'createdAt'>): Promise<Clip>;
  findClipByClientUuid(contributorId: string, clientUuid: string): Promise<Clip | null>;
  getClip(id: string): Promise<Clip | null>;
  setClipStatus(id: string, status: ClipState, autocheck?: Record<string, unknown>): Promise<void>;
  setClipModeration(
    id: string,
    patch: { rejectionCount?: number; deletedAt?: Date | null },
  ): Promise<void>;
  clearClipAudio(id: string): Promise<void>;
  setClipAudio(id: string, audioPath: string): Promise<void>;
  setClipMedia(
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
  ): Promise<void>;
  listPeerReview(): Promise<Clip[]>;
  countClipsByRegion(): Promise<Array<{ region: string; clips: number }>>;

  // — référentiel —
  listLanguages(opts?: { includeInactive?: boolean }): Promise<LanguageRow[]>;
  findLanguageByCode(code: string): Promise<LanguageRow | null>;
  updateLanguage(
    code: string,
    patch: { nameFr?: string; isoBcp47?: string; status?: 'active' | 'inactive' },
  ): Promise<LanguageRow | null>;
  countLanguageRefs(code: string): Promise<{ dialects: number; prompts: number; users: number; clips: number }>;
  listDialects(languageCode?: string, opts?: { includeInactive?: boolean }): Promise<DialectRow[]>;
  findDialectById(id: string): Promise<DialectRow | null>;
  updateDialect(
    id: string,
    patch: { nameFr?: string; zone?: string | null; targetHours?: number; active?: boolean },
  ): Promise<DialectRow | null>;
  countDialectRefs(id: string): Promise<{ prompts: number; users: number; clips: number }>;
  listActivePrompts(languageCode?: string): Promise<PromptRow[]>;
  listPrompts(
    languageCode?: string,
    opts?: { includeInactive?: boolean },
  ): Promise<PromptRow[]>;
  getPromptByStableId(stableId: string): Promise<PromptRow | null>;
  updatePrompt(stableId: string, patch: { text?: string; active?: boolean }): Promise<PromptRow | null>;
  countPromptRefs(stableId: string): Promise<{ clips: number }>;
  listQualityQueue(): Promise<Clip[]>;
  listQualityClips(filter?: { status?: string; language?: string }): Promise<Clip[]>;
  listQualityTranscriptions(filter?: { status?: string; language?: string }): Promise<QualityTranscription[]>;
  createLanguage(input: { code: string; nameFr: string; isoBcp47: string }): Promise<LanguageRow>;
  createDialect(input: {
    languageCode: string; code: string; nameFr: string; zone?: string; targetHours?: number;
  }): Promise<DialectRow>;
  createPrompt(input: {
    stableId: string; languageCode: string; dialectCode?: string; text: string;
  }): Promise<PromptRow>;
  setPromptActive(stableId: string, active: boolean): Promise<PromptRow | null>;

  listTranscriptionsForClip(clipId: string): Promise<Transcription[]>;

  createDatasetRelease(r: Omit<DatasetRelease, 'id' | 'createdAt' | 'publishedAt' | 'manifestJsonl' | 'stats'> & {
    filterSpec: Record<string, unknown>;
  }): Promise<DatasetRelease>;
  getDatasetRelease(id: string): Promise<DatasetRelease | null>;
  getDatasetReleaseByVersion(version: string): Promise<DatasetRelease | null>;
  listDatasetReleases(): Promise<DatasetRelease[]>;
  insertDatasetItems(items: Array<Omit<DatasetItem, 'id'>>): Promise<void>;
  listDatasetItems(releaseId: string): Promise<DatasetItem[]>;
  publishDatasetRelease(
    id: string,
    data: { manifestJsonl: string; stats: Record<string, unknown> },
  ): Promise<DatasetRelease | null>;

  createVote(v: Omit<Vote, 'id' | 'createdAt'>): Promise<Vote>;
  hasVotedClip(clipId: string, validatorId: string): Promise<boolean>;
  votesForClip(clipId: string): Promise<Vote[]>;
  votesForTranscription(transcriptionId: string): Promise<Vote[]>;

  addLedger(e: Omit<LedgerEntry, 'id'>): Promise<void>;
  setRecordLedgerState(clipId: string, state: LedgerState): Promise<void>;
  ledgerFor(userId: string): Promise<LedgerEntry[]>;
  ledgerHistoryFor(
    userId: string,
  ): Promise<Array<{ reason: string; delta: number; state: string; createdAt: Date; refClipId?: string }>>;

  createTranscription(
    t: Omit<
      Transcription,
      'id' | 'tier' | 'matchesAudio' | 'status' | 'rejectionCount' | 'deletedAt'
    >,
  ): Promise<Transcription>;
  getTranscription(id: string): Promise<Transcription | null>;
  setTranscriptionTier(id: string, tier: Tier, matchesAudio: boolean | null): Promise<void>;
  setTranscriptionModeration(
    id: string,
    patch: {
      tier?: Tier | null;
      matchesAudio?: boolean | null;
      status?: TranscriptionStatus;
      rejectionCount?: number;
      deletedAt?: Date | null;
    },
  ): Promise<void>;
  hasTranscribedClip(clipId: string, authorId: string): Promise<boolean>;

  // — admin —
  listUsers(): Promise<UserRecord[]>;
  listClipsByStatus(status: ClipState): Promise<Clip[]>;
  updateUser(
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
  ): Promise<UserRecord | null>;

  // — retraits —
  createWithdrawal(w: Omit<Withdrawal, 'id' | 'createdAt' | 'status'>): Promise<Withdrawal>;
  listWithdrawals(status?: Withdrawal['status']): Promise<Withdrawal[]>;
  getWithdrawal(id: string): Promise<Withdrawal | null>;
  setWithdrawalStatus(id: string, status: 'paid' | 'failed'): Promise<void>;

  // — audit (append-only) —
  addAudit(e: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<AuditEntry>;
  listAudit(filter?: { actorId?: string; entityId?: string; action?: string }): Promise<AuditEntry[]>;
}

// Stub mémoire — fait tourner/typer le serveur sans Postgres.
// NB: mots de passe & OTP en clair = STUB (remplacer par argon2id + hash).
export class InMemoryRepo implements Repo {
  private users: UserRecord[] = [];
  private otps = new Map<string, { code: string; expiresAt: Date }>();
  private contactChanges: ContactChange[] = [];
  private conversations: Conversation[] = [];
  private chatMessages: ChatMessage[] = [];
  private clips: Clip[] = [];
  private votes: Vote[] = [];
  private ledger: (LedgerEntry & { createdAt: Date })[] = [];
  private transcriptions: Transcription[] = [];
  private audit: AuditEntry[] = [];
  private withdrawals: Withdrawal[] = [];
  private languages: LanguageRow[] = [];
  private dialects: DialectRow[] = [];
  private prompts: PromptRow[] = [];
  private datasetReleases: DatasetRelease[] = [];
  private datasetItems: DatasetItem[] = [];
  private seq = 0;
  private id(p: string): string {
    return `${p}_${++this.seq}`;
  }

  async findUserByEmail(email: string) {
    return this.users.find((u) => u.email === email) ?? null;
  }
  async findUserByPhone(phone: string) {
    return this.users.find((u) => u.phone === phone) ?? null;
  }
  async findUserById(id: string) {
    return this.users.find((u) => u.id === id) ?? null;
  }
  async createUser(u: Omit<UserRecord, 'id'>) {
    const user: UserRecord = {
      ...u,
      id: this.id('u'),
      commercialConsent: u.commercialConsent ?? false,
      tokenVersion: u.tokenVersion ?? 0,
    };
    this.users.push(user);
    return user;
  }
  async saveOtp(phone: string, code: string, expiresAt: Date) {
    const { hashOtp } = await import('../auth/otp');
    this.otps.set(phone, { code: hashOtp(code), expiresAt });
  }
  async consumeOtp(phone: string, code: string) {
    const { otpMatches } = await import('../auth/otp');
    const rec = this.otps.get(phone);
    if (!rec || rec.expiresAt < new Date() || !otpMatches(code, rec.code)) return false;
    this.otps.delete(phone);
    return true;
  }
  async bumpTokenVersion(id: string) {
    const u = this.users.find((x) => x.id === id);
    if (!u) return null;
    u.tokenVersion = (u.tokenVersion ?? 0) + 1;
    return u.tokenVersion;
  }
  async createContactChange(c: Omit<ContactChange, 'id' | 'createdAt'>) {
    this.contactChanges = this.contactChanges.filter((x) => x.userId !== c.userId);
    const change: ContactChange = { ...c, id: this.id('cc'), createdAt: new Date() };
    this.contactChanges.push(change);
    return change;
  }
  async getContactChange(id: string) {
    return this.contactChanges.find((x) => x.id === id) ?? null;
  }
  async deleteContactChange(id: string) {
    this.contactChanges = this.contactChanges.filter((x) => x.id !== id);
  }
  async deleteContactChangesForUser(userId: string) {
    this.contactChanges = this.contactChanges.filter((x) => x.userId !== userId);
  }

  async createConversation(c: { userId: string; clipId?: string; subject?: string }) {
    const now = new Date();
    const conv: Conversation = {
      id: this.id('conv'),
      userId: c.userId,
      clipId: c.clipId,
      subject: c.subject,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.push(conv);
    return conv;
  }
  async findOpenConversation(userId: string) {
    return this.conversations.find((c) => c.userId === userId && c.status === 'open') ?? null;
  }
  async findConversationByClipId(clipId: string) {
    return (
      this.conversations
        .filter((c) => c.clipId === clipId)
        .sort((a, b) => {
          if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1;
          return (b.lastMessageAt ?? b.updatedAt).getTime() - (a.lastMessageAt ?? a.updatedAt).getTime();
        })[0] ?? null
    );
  }
  async getConversation(id: string) {
    return this.conversations.find((c) => c.id === id) ?? null;
  }
  async listConversations(filter?: { status?: ConversationStatus; limit?: number; offset?: number }) {
    const rows = this.conversations
      .filter((c) => !filter?.status || c.status === filter.status)
      .sort((a, b) => (b.lastMessageAt ?? b.updatedAt).getTime() - (a.lastMessageAt ?? a.updatedAt).getTime());
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? rows.length;
    return rows.slice(offset, offset + limit);
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
  ) {
    const c = this.conversations.find((x) => x.id === id);
    if (!c) return null;
    if (patch.status !== undefined) c.status = patch.status;
    if (patch.clipId !== undefined) c.clipId = patch.clipId ?? undefined;
    if (patch.closedAt !== undefined) c.closedAt = patch.closedAt ?? undefined;
    if (patch.lastMessageAt !== undefined) c.lastMessageAt = patch.lastMessageAt ?? undefined;
    if (patch.userLastReadAt !== undefined) c.userLastReadAt = patch.userLastReadAt ?? undefined;
    if (patch.staffLastReadAt !== undefined) c.staffLastReadAt = patch.staffLastReadAt ?? undefined;
    c.updatedAt = new Date();
    return c;
  }
  async addChatMessage(m: Omit<ChatMessage, 'id' | 'createdAt'>) {
    const msg: ChatMessage = { ...m, id: this.id('msg'), createdAt: new Date() };
    this.chatMessages.push(msg);
    await this.updateConversation(m.conversationId, { lastMessageAt: msg.createdAt });
    return msg;
  }
  async listChatMessages(
    conversationId: string,
    opts?: { after?: Date; before?: Date; limit?: number },
  ) {
    const limit = opts?.limit ?? 50;
    let rows = this.chatMessages
      .filter((m) => m.conversationId === conversationId)
      .filter((m) => !opts?.after || m.createdAt > opts.after)
      .filter((m) => !opts?.before || m.createdAt < opts.before)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (opts?.after) rows = rows.slice(0, limit);
    else rows = rows.slice(-limit);
    return rows;
  }
  async countChatMessagesAfter(
    conversationId: string,
    after: Date | undefined,
    senderRole: ChatMessage['senderRole'],
  ) {
    return this.chatMessages.filter(
      (m) =>
        m.conversationId === conversationId &&
        m.senderRole === senderRole &&
        (!after || m.createdAt > after),
    ).length;
  }

  async createClip(c: Omit<Clip, 'id' | 'createdAt'>) {
    const clip: Clip = {
      ...c,
      rejectionCount: c.rejectionCount ?? 0,
      id: this.id('c'),
      createdAt: new Date(),
    };
    this.clips.push(clip);
    return clip;
  }
  async findClipByClientUuid(contributorId: string, clientUuid: string) {
    return this.clips.find((c) => c.contributorId === contributorId && c.clientUuid === clientUuid) ?? null;
  }
  async getClip(id: string) {
    return this.clips.find((c) => c.id === id) ?? null;
  }
  async setClipStatus(id: string, status: ClipState, autocheck?: Record<string, unknown>) {
    const c = this.clips.find((x) => x.id === id);
    if (c) {
      c.status = status;
      if (autocheck) c.autocheck = autocheck;
    }
  }
  async setClipModeration(
    id: string,
    patch: { rejectionCount?: number; deletedAt?: Date | null },
  ) {
    const c = this.clips.find((x) => x.id === id);
    if (!c) return;
    if (patch.rejectionCount !== undefined) c.rejectionCount = patch.rejectionCount;
    if (patch.deletedAt !== undefined) c.deletedAt = patch.deletedAt ?? undefined;
  }
  async clearClipAudio(id: string) {
    const c = this.clips.find((x) => x.id === id);
    if (!c) return;
    c.audioPath = undefined;
    c.audioIngestPath = undefined;
    c.audioMasterPath = undefined;
  }
  async setClipAudio(id: string, audioPath: string) {
    const c = this.clips.find((x) => x.id === id);
    if (c) c.audioPath = audioPath;
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
    const c = this.clips.find((x) => x.id === id);
    if (!c) return;
    Object.assign(c, {
      audioPath: media.audioPath,
      audioIngestPath: media.audioIngestPath,
      audioMasterPath: media.audioMasterPath,
      ingestSha256: media.ingestSha256,
      masterSha256: media.masterSha256,
      durationS: media.durationS,
      durationMs: media.durationMs,
      silenceRatio: media.silenceRatio,
      snrDb: media.snrDb ?? undefined,
      peakDbfs: media.peakDbfs ?? undefined,
      audioQuality: media.audioQuality,
      autocheck: media.autocheck,
      status: media.status,
    });
  }
  async listPeerReview() {
    return this.clips.filter((c) => c.status === 'peer_review');
  }
  async listLanguages(opts: { includeInactive?: boolean } = {}) {
    return this.languages
      .filter((l) => opts.includeInactive || l.status === 'active')
      .map((l) => ({ ...l }));
  }
  async findLanguageByCode(code: string) {
    const l = this.languages.find((x) => x.code === code);
    return l ? { ...l } : null;
  }
  async updateLanguage(
    code: string,
    patch: { nameFr?: string; isoBcp47?: string; status?: 'active' | 'inactive' },
  ) {
    const l = this.languages.find((x) => x.code === code);
    if (!l) return null;
    if (patch.nameFr !== undefined) l.nameFr = patch.nameFr;
    if (patch.isoBcp47 !== undefined) l.isoBcp47 = patch.isoBcp47;
    if (patch.status !== undefined) l.status = patch.status;
    return { ...l };
  }
  async countLanguageRefs(code: string) {
    const lang = this.languages.find((l) => l.code === code);
    if (!lang) return { dialects: 0, prompts: 0, users: 0, clips: 0 };
    return {
      dialects: this.dialects.filter(
        (d) => d.languageId === lang.id && d.active !== false,
      ).length,
      prompts: this.prompts.filter(
        (p) => p.languageCode === code && p.active !== false,
      ).length,
      users: this.users.filter((u) => u.language === code).length,
      clips: this.clips.filter((c) => c.language === code).length,
    };
  }
  async listDialects(languageCode?: string, opts: { includeInactive?: boolean } = {}) {
    return this.dialects
      .filter((d) => (languageCode ? d.languageCode === languageCode : true))
      .filter((d) => opts.includeInactive || d.active !== false)
      .map((d) => ({ ...d }));
  }
  async findDialectById(id: string) {
    const d = this.dialects.find((x) => x.id === id);
    return d ? { ...d } : null;
  }
  async updateDialect(
    id: string,
    patch: { nameFr?: string; zone?: string | null; targetHours?: number; active?: boolean },
  ) {
    const d = this.dialects.find((x) => x.id === id);
    if (!d) return null;
    if (patch.nameFr !== undefined) d.nameFr = patch.nameFr;
    if (patch.zone !== undefined) d.zone = patch.zone ?? undefined;
    if (patch.targetHours !== undefined) d.targetHours = patch.targetHours;
    if (patch.active !== undefined) d.active = patch.active;
    return { ...d };
  }
  async countDialectRefs(id: string) {
    const d = this.dialects.find((x) => x.id === id);
    if (!d) return { prompts: 0, users: 0, clips: 0 };
    return {
      prompts: this.prompts.filter(
        (p) =>
          p.active !== false &&
          p.languageCode === d.languageCode &&
          p.dialectCode === d.code,
      ).length,
      users: this.users.filter(
        (u) => u.language === d.languageCode && u.dialect === d.code,
      ).length,
      clips: this.clips.filter(
        (c) => c.language === d.languageCode && c.dialect === d.code,
      ).length,
    };
  }
  async listActivePrompts(languageCode?: string) {
    return this.prompts
      .filter((p) => p.active !== false)
      .filter((p) => (languageCode ? p.languageCode === languageCode : true))
      .map((p) => ({ ...p }));
  }
  async listPrompts(languageCode?: string, opts: { includeInactive?: boolean } = {}) {
    return this.prompts
      .filter((p) => opts.includeInactive || p.active !== false)
      .filter((p) => (languageCode ? p.languageCode === languageCode : true))
      .map((p) => ({ ...p }));
  }
  async getPromptByStableId(stableId: string) {
    const p = this.prompts.find((x) => x.stableId === stableId);
    return p ? { ...p } : null;
  }
  async updatePrompt(stableId: string, patch: { text?: string; active?: boolean }) {
    const p = this.prompts.find((x) => x.stableId === stableId);
    if (!p) return null;
    if (patch.text !== undefined) p.text = patch.text;
    if (patch.active !== undefined) p.active = patch.active;
    return { ...p };
  }
  async countPromptRefs(stableId: string) {
    return { clips: this.clips.filter((c) => c.promptId === stableId).length };
  }
  async listQualityQueue() {
    return this.clips.filter((c) => c.status === 'rejected' || c.audioQuality === 'F');
  }
  async listQualityClips(filter: { status?: string; language?: string } = {}) {
    return this.clips.filter(
      (c) =>
        (!filter.status || c.status === filter.status) &&
        (!filter.language || c.language === filter.language),
    );
  }
  async listQualityTranscriptions(
    filter: { status?: string; language?: string } = {},
  ): Promise<QualityTranscription[]> {
    const out: QualityTranscription[] = [];
    for (const t of this.transcriptions) {
      if (filter.status && t.status !== filter.status) continue;
      const clip = t.clipId ? this.clips.find((c) => c.id === t.clipId) : undefined;
      if (filter.language && clip?.language !== filter.language) continue;
      out.push({ ...t, language: clip?.language, dialect: clip?.dialect });
    }
    return out;
  }
  async createLanguage(input: { code: string; nameFr: string; isoBcp47: string }) {
    const row: LanguageRow = {
      id: this.id('lang'), code: input.code, nameFr: input.nameFr, isoBcp47: input.isoBcp47, status: 'active',
    };
    this.languages.push(row);
    return row;
  }
  async createDialect(input: {
    languageCode: string; code: string; nameFr: string; zone?: string; targetHours?: number;
  }) {
    const lang = this.languages.find((l) => l.code === input.languageCode);
    if (!lang) throw new Error('language_not_found');
    const row: DialectRow = {
      id: this.id('dia'),
      languageId: lang.id,
      languageCode: lang.code,
      code: input.code,
      nameFr: input.nameFr,
      zone: input.zone,
      targetHours: input.targetHours ?? 0,
      active: true,
    };
    this.dialects.push(row);
    return row;
  }
  async createPrompt(input: {
    stableId: string; languageCode: string; dialectCode?: string; text: string;
  }) {
    const row: PromptRow = {
      id: this.id('prm'),
      stableId: input.stableId,
      languageCode: input.languageCode,
      dialectCode: input.dialectCode,
      text: input.text,
      writingSystem: 'std',
      active: true,
    };
    this.prompts.push(row);
    return row;
  }
  async setPromptActive(stableId: string, active: boolean) {
    return this.updatePrompt(stableId, { active });
  }
  async listTranscriptionsForClip(clipId: string) {
    return this.transcriptions.filter((t) => t.clipId === clipId);
  }
  async createDatasetRelease(r: Omit<DatasetRelease, 'id' | 'createdAt' | 'publishedAt' | 'manifestJsonl' | 'stats'> & {
    filterSpec: Record<string, unknown>;
  }) {
    const release: DatasetRelease = {
      ...r,
      id: this.id('dr'),
      createdAt: new Date(),
    };
    this.datasetReleases.push(release);
    return release;
  }
  async getDatasetRelease(id: string) {
    return this.datasetReleases.find((r) => r.id === id) ?? null;
  }
  async getDatasetReleaseByVersion(version: string) {
    return this.datasetReleases.find((r) => r.version === version) ?? null;
  }
  async listDatasetReleases() {
    return [...this.datasetReleases].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async insertDatasetItems(items: Array<Omit<DatasetItem, 'id'>>) {
    for (const it of items) {
      this.datasetItems.push({ ...it, id: this.id('di') });
    }
  }
  async listDatasetItems(releaseId: string) {
    return this.datasetItems.filter((i) => i.releaseId === releaseId).sort((a, b) => a.ordinal - b.ordinal);
  }
  async publishDatasetRelease(id: string, data: { manifestJsonl: string; stats: Record<string, unknown> }) {
    const r = this.datasetReleases.find((x) => x.id === id);
    if (!r) return null;
    r.status = 'published';
    r.manifestJsonl = data.manifestJsonl;
    r.stats = data.stats;
    r.publishedAt = new Date();
    return r;
  }
  /** Seed mémoire pour tests (optionnel). */
  seedReferential(data: { languages: LanguageRow[]; dialects: DialectRow[]; prompts: PromptRow[] }) {
    this.languages = data.languages;
    this.dialects = data.dialects;
    this.prompts = data.prompts;
  }
  async countClipsByRegion() {
    const byRegion = new Map<string, number>();
    for (const c of this.clips) {
      if (!c.region) continue;
      byRegion.set(c.region, (byRegion.get(c.region) ?? 0) + 1);
    }
    return [...byRegion.entries()].map(([region, clips]) => ({ region, clips }));
  }

  async createVote(v: Omit<Vote, 'id' | 'createdAt'>) {
    const vote: Vote = { ...v, id: this.id('v'), createdAt: new Date() };
    this.votes.push(vote);
    return vote;
  }
  async hasVotedClip(clipId: string, validatorId: string) {
    return this.votes.some((v) => v.clipId === clipId && v.validatorId === validatorId);
  }
  async votesForClip(clipId: string) {
    return this.votes.filter((v) => v.clipId === clipId);
  }
  async votesForTranscription(transcriptionId: string) {
    return this.votes.filter((v) => v.transcriptionId === transcriptionId);
  }

  async addLedger(e: Omit<LedgerEntry, 'id'>) {
    this.ledger.push({ ...e, id: this.id('l'), createdAt: new Date() });
  }
  async setRecordLedgerState(clipId: string, state: LedgerState) {
    for (const e of this.ledger) {
      if (e.refClipId === clipId && e.reason === 'record' && e.state === 'provisional') e.state = state;
    }
  }
  async ledgerFor(userId: string) {
    return this.ledger.filter((e) => e.userId === userId);
  }
  async ledgerHistoryFor(userId: string) {
    return this.ledger
      .filter((e) => e.userId === userId)
      .map((e) => ({ reason: e.reason, delta: e.delta, state: e.state, createdAt: e.createdAt, refClipId: e.refClipId }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async createTranscription(
    t: Omit<
      Transcription,
      'id' | 'tier' | 'matchesAudio' | 'status' | 'rejectionCount' | 'deletedAt'
    >,
  ) {
    const tr: Transcription = {
      ...t,
      id: this.id('t'),
      tier: null,
      matchesAudio: null,
      status: 'pending',
      rejectionCount: 0,
    };
    this.transcriptions.push(tr);
    return tr;
  }
  async getTranscription(id: string) {
    return this.transcriptions.find((t) => t.id === id) ?? null;
  }
  async setTranscriptionTier(id: string, tier: Tier, matchesAudio: boolean | null) {
    const t = this.transcriptions.find((x) => x.id === id);
    if (t) {
      t.tier = tier;
      t.matchesAudio = matchesAudio;
    }
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
    const t = this.transcriptions.find((x) => x.id === id);
    if (!t) return;
    if (patch.tier !== undefined) t.tier = patch.tier;
    if (patch.matchesAudio !== undefined) t.matchesAudio = patch.matchesAudio;
    if (patch.status !== undefined) t.status = patch.status;
    if (patch.rejectionCount !== undefined) t.rejectionCount = patch.rejectionCount;
    if (patch.deletedAt !== undefined) t.deletedAt = patch.deletedAt ?? undefined;
  }
  async hasTranscribedClip(clipId: string, authorId: string) {
    return this.transcriptions.some((t) => t.clipId === clipId && t.authorId === authorId);
  }

  async listUsers() {
    return [...this.users];
  }
  async listClipsByStatus(status: ClipState) {
    return this.clips.filter((c) => c.status === status);
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
    const u = this.users.find((x) => x.id === id);
    if (!u) return null;
    if (patch.role) u.role = patch.role;
    if (patch.competence !== undefined) u.competence = patch.competence;
    if (patch.status) u.status = patch.status;
    if (patch.name !== undefined) u.name = patch.name;
    if (patch.email !== undefined) u.email = patch.email ?? undefined;
    if (patch.phone !== undefined) u.phone = patch.phone ?? undefined;
    if (patch.passwordHash !== undefined) u.passwordHash = patch.passwordHash ?? undefined;
    if (patch.totpSecret !== undefined) u.totpSecret = patch.totpSecret ?? undefined;
    if (patch.phoneVerified !== undefined) u.phoneVerified = patch.phoneVerified;
    if (patch.language !== undefined) u.language = patch.language;
    if (patch.dialect !== undefined) u.dialect = patch.dialect;
    if (patch.region !== undefined) u.region = patch.region;
    if (patch.commercialConsent !== undefined) u.commercialConsent = patch.commercialConsent;
    return u;
  }

  async createWithdrawal(w: Omit<Withdrawal, 'id' | 'createdAt' | 'status'>) {
    const wd: Withdrawal = { ...w, id: this.id('w'), status: 'processing', createdAt: new Date() };
    this.withdrawals.push(wd);
    return wd;
  }
  async listWithdrawals(status?: Withdrawal['status']) {
    return this.withdrawals.filter((w) => (status ? w.status === status : true));
  }
  async getWithdrawal(id: string) {
    return this.withdrawals.find((w) => w.id === id) ?? null;
  }
  async setWithdrawalStatus(id: string, status: 'paid' | 'failed') {
    const w = this.withdrawals.find((x) => x.id === id);
    if (w) w.status = status;
  }

  async addAudit(e: Omit<AuditEntry, 'id' | 'createdAt'>) {
    const entry: AuditEntry = { ...e, id: this.id('a'), createdAt: new Date() };
    this.audit.push(entry);
    return entry;
  }
  async listAudit(filter?: { actorId?: string; entityId?: string; action?: string }) {
    return this.audit
      .filter((e) => (filter?.actorId ? e.actorId === filter.actorId : true))
      .filter((e) => (filter?.entityId ? e.entityId === filter.entityId : true))
      .filter((e) => (filter?.action ? e.action === filter.action : true));
  }
}
