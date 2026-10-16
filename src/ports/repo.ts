import { type Role, type CompetenceLevel } from '../domain/roles';
import { type ClipState } from '../curation/stateMachine';
import { type Tier } from '../curation/tier';
import {
  type Clip,
  type Vote,
  type LedgerEntry,
  type Transcription,
  type LedgerState,
  type AuditEntry,
  type Withdrawal,
  type Classroom,
} from '../domain/contribution';

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
  status?: UserStatus; // absent = 'active'
  language?: string;
  dialect?: string;
  region?: string;
  commercialConsent?: boolean;
  classroomId?: string; // classroom courant (nullable)
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

  // — contribution —
  createClip(c: Omit<Clip, 'id' | 'createdAt'>): Promise<Clip>;
  getClip(id: string): Promise<Clip | null>;
  setClipStatus(id: string, status: ClipState, autocheck?: Record<string, unknown>): Promise<void>;
  setClipAudio(id: string, audioPath: string): Promise<void>;
  listPeerReview(): Promise<Clip[]>;
  countClipsByRegion(): Promise<Array<{ region: string; clips: number }>>;

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

  createTranscription(t: Omit<Transcription, 'id' | 'tier' | 'matchesAudio'>): Promise<Transcription>;
  setTranscriptionTier(id: string, tier: Tier, matchesAudio: boolean | null): Promise<void>;
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
      language?: string;
      dialect?: string;
      region?: string;
      commercialConsent?: boolean;
      classroomId?: string | null;
    },
  ): Promise<UserRecord | null>;

  // — classrooms —
  createClassroom(c: Omit<Classroom, 'id' | 'createdAt'>): Promise<Classroom>;
  findClassroomById(id: string): Promise<Classroom | null>;
  findClassroomByCode(code: string): Promise<Classroom | null>;
  listClassroomMembers(classroomId: string): Promise<UserRecord[]>;
  countClipsByClassroom(classroomId: string): Promise<number>;

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
  private clips: Clip[] = [];
  private votes: Vote[] = [];
  private ledger: (LedgerEntry & { createdAt: Date })[] = [];
  private transcriptions: Transcription[] = [];
  private audit: AuditEntry[] = [];
  private withdrawals: Withdrawal[] = [];
  private classrooms: Classroom[] = [];
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
    const user: UserRecord = { ...u, id: this.id('u'), commercialConsent: u.commercialConsent ?? false };
    this.users.push(user);
    return user;
  }
  async saveOtp(phone: string, code: string, expiresAt: Date) {
    this.otps.set(phone, { code, expiresAt });
  }
  async consumeOtp(phone: string, code: string) {
    const rec = this.otps.get(phone);
    if (!rec || rec.expiresAt < new Date() || rec.code !== code) return false;
    this.otps.delete(phone);
    return true;
  }

  async createClip(c: Omit<Clip, 'id' | 'createdAt'>) {
    const clip: Clip = { ...c, id: this.id('c'), createdAt: new Date() };
    this.clips.push(clip);
    return clip;
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
  async setClipAudio(id: string, audioPath: string) {
    const c = this.clips.find((x) => x.id === id);
    if (c) c.audioPath = audioPath;
  }
  async listPeerReview() {
    return this.clips.filter((c) => c.status === 'peer_review');
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

  async createTranscription(t: Omit<Transcription, 'id' | 'tier' | 'matchesAudio'>) {
    const tr: Transcription = { ...t, id: this.id('t'), tier: null, matchesAudio: null };
    this.transcriptions.push(tr);
    return tr;
  }
  async setTranscriptionTier(id: string, tier: Tier, matchesAudio: boolean | null) {
    const t = this.transcriptions.find((x) => x.id === id);
    if (t) {
      t.tier = tier;
      t.matchesAudio = matchesAudio;
    }
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
      language?: string;
      dialect?: string;
      region?: string;
      commercialConsent?: boolean;
      classroomId?: string | null;
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
    if (patch.language !== undefined) u.language = patch.language;
    if (patch.dialect !== undefined) u.dialect = patch.dialect;
    if (patch.region !== undefined) u.region = patch.region;
    if (patch.commercialConsent !== undefined) u.commercialConsent = patch.commercialConsent;
    if (patch.classroomId !== undefined) u.classroomId = patch.classroomId ?? undefined;
    return u;
  }

  // — classrooms —
  async createClassroom(c: Omit<Classroom, 'id' | 'createdAt'>) {
    const cls: Classroom = { ...c, id: this.id('cls'), createdAt: new Date() };
    this.classrooms.push(cls);
    return cls;
  }
  async findClassroomById(id: string) {
    return this.classrooms.find((c) => c.id === id) ?? null;
  }
  async findClassroomByCode(code: string) {
    return this.classrooms.find((c) => c.inviteCode === code) ?? null;
  }
  async listClassroomMembers(classroomId: string) {
    return this.users.filter((u) => u.classroomId === classroomId);
  }
  async countClipsByClassroom(classroomId: string) {
    return this.clips.filter((c) => c.classroomId === classroomId).length;
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
