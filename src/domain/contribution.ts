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
  classroomId?: string; // classroom du contributeur au moment de l'envoi
  status: ClipState;
  consent: Consent;
  autocheck?: Record<string, unknown>;
  audioPath?: string; // chemin relatif du blob audio (null tant que non stocké)
  createdAt: Date;
}

// Groupe de collecte (école, association) rejoint par code d'invitation.
export interface Classroom {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  inviteCode: string;
  createdAt: Date;
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
