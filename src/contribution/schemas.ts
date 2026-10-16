import { z } from 'zod';

export const ClipReq = z.object({
  promptId: z.string().optional(),
  rarity: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  durationS: z.number().int().nonnegative(),
  consent: z.object({
    commercialUse: z.boolean(),
    consentVersion: z.string().min(1),
  }),
});
// Variante multipart : les champs form-data arrivent en strings → coercition.
export const ClipMultipartReq = z.object({
  promptId: z.string().optional(),
  rarity: z.coerce.number().int().refine((v) => v === 0 || v === 1 || v === 2, 'rarity ∈ {0,1,2}'),
  durationS: z.coerce.number().int().nonnegative(),
  commercialUse: z.enum(['true', 'false']).transform((v) => v === 'true'),
  consentVersion: z.string().min(1),
  // classification linguistique (profil contributeur) — regroupement des audios en BD
  language: z.string().min(1).optional(),
  dialect: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
});

export const VoteReq = z.object({ verdict: z.enum(['correct', 'problem', 'unsure']) });
export const TranscriptionReq = z.object({
  clipId: z.string().optional(),
  archiveId: z.string().optional(),
  text: z.string().min(1),
  writingSystem: z.enum(['std', 'phon']),
  consistency: z.number().min(0).max(1).default(0.6),
});

export type ClipReq = z.infer<typeof ClipReq>;
export type ClipMultipartReq = z.infer<typeof ClipMultipartReq>;
export type VoteReq = z.infer<typeof VoteReq>;
export type TranscriptionReq = z.infer<typeof TranscriptionReq>;
