import { type ClipState } from '../curation/stateMachine';
import { type Tier, type WritingSystem } from '../curation/tier';

export type Rarity = 0 | 1 | 2;
export type Verdict = 'correct' | 'problem' | 'unsure';
export type LedgerState = 'provisional' | 'confirmed' | 'reversed';
export type LedgerReason =
  | 'record'
  | 'validate'
  | 'transcribe'
  | 'convert'
  | 'admin_adjustment'
  | 'withdrawal'
  | 'withdrawal_refund';

// Décision 4 — chaîne de consentement immuable attachée au clip.
export interface Consent {
  commercialUse: boolean;
  consentVersion: string;
  licenseTag: string;
  provenance: Record<string, unknown>;
}

export interface Clip {
  id: string;
  contributorId: string;
  promptId?: string;
  rarity: Rarity;
  durationS: number;
  requiredCompetence: number; // routage pair-review (décision 1)
  language?: string; // langue déclarée par le contributeur (classification BD)
  dialect?: string; // dialecte / localité
  region?: string; // zone du Burkina Faso
  clientUuid?: string; // idempotence client (outbox)
  status: ClipState;
  consent: Consent;
  autocheck?: Record<string, unknown>;
  audioPath?: string; // chemin lecture (master préféré, sinon ingest)
  audioIngestPath?: string;
  audioMasterPath?: string;
  ingestSha256?: string;
  masterSha256?: string;
  durationMs?: number;
  silenceRatio?: number;
  snrDb?: number;
  peakDbfs?: number;
  audioQuality?: 'A' | 'B' | 'C' | 'F';
  rejectionCount?: number;
  deletedAt?: Date;
  createdAt: Date;
}

export interface LanguageRow {
  id: string;
  code: string;
  nameFr: string;
  isoBcp47: string;
  status: string;
}

export interface DialectRow {
  id: string;
  languageId: string;
  languageCode: string;
  code: string;
  nameFr: string;
  zone?: string;
  targetHours: number;
  active?: boolean; // absent = actif
}

export interface PromptRow {
  id: string;
  stableId: string;
  languageCode: string;
  dialectCode?: string;
  text: string;
  writingSystem: string;
  active?: boolean; // absent = actif
}

export interface Vote {
  id: string;
  clipId?: string;
  transcriptionId?: string;
  validatorId: string;
  verdict: Verdict;
  reviewerCompetence: number; // snapshot (décision 1)
  createdAt: Date;
}

export interface LedgerEntry {
  id: string;
  userId: string;
  delta: number;
  reason: LedgerReason;
  state: LedgerState;
  refClipId?: string;
  refTranscriptionId?: string;
}

export type TranscriptionStatus = 'pending' | 'validated' | 'rejected' | 'deleted';

export interface Transcription {
  id: string;
  authorId: string;
  clipId?: string;
  archiveId?: string;
  text: string;
  writingSystem: WritingSystem;
  consistency: number;
  matchesAudio: boolean | null;
  tier: Tier | null;
  status?: TranscriptionStatus;
  rejectionCount?: number;
  deletedAt?: Date;
}

// Ligne de contrôle qualité : transcription enrichie de la langue du clip.
export interface QualityTranscription extends Transcription {
  language?: string;
  dialect?: string;
}

// Journal d'audit immuable (delta-v2 §3/§6) : chaque action de gouvernance
// admin y est consignée. Append-only — le port n'expose ni update ni delete.
export interface AuditEntry {
  id: string;
  actorId: string;
  action: string;          // ex. 'clip.arbitrate', 'user.update'
  entityType: string;      // ex. 'clip', 'user'
  entityId: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

// Retrait de gains (D4). status suit l'enum SQL : processing → paid | failed.
export interface Withdrawal {
  id: string;
  userId: string;
  amountFcfa: number;
  provider: string;
  status: 'processing' | 'paid' | 'failed';
  createdAt: Date;
}

// Changement d'email/téléphone en attente de vérification OTP.
export interface ContactChange {
  id: string;
  userId: string;
  newEmail?: string;
  newPhone?: string;
  verifyPhone: string;
  codeHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export type DatasetSplit = 'train' | 'dev' | 'test';
export type DatasetReleaseStatus = 'drafting' | 'published' | 'superseded';

export interface DatasetRelease {
  id: string;
  version: string;
  status: DatasetReleaseStatus;
  filterSpec: Record<string, unknown>;
  licenseTag: string;
  manifestJsonl?: string;
  stats?: Record<string, unknown>;
  createdBy?: string;
  createdAt: Date;
  publishedAt?: Date;
}

export interface DatasetItem {
  id: string;
  releaseId: string;
  clipId: string;
  transcriptionId?: string;
  split: DatasetSplit;
  ordinal: number;
  relativePath: string;
}
