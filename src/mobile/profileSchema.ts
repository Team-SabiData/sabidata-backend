import { z } from 'zod';

export const ProfileReq = z.object({
  language: z.string().min(1),
  dialect: z.string().min(1),
  region: z.string().min(1),
  commercialConsent: z.boolean(),
});
export type ProfileReq = z.infer<typeof ProfileReq>;

/** Modification des informations personnelles : nom uniquement (contact via OTP). */
export const ProfilePatchReq = z
  .object({
    name: z.string().min(2).optional(),
  })
  .refine((d) => d.name !== undefined, { message: 'name requis' });
export type ProfilePatchReq = z.infer<typeof ProfilePatchReq>;

/** Demande de changement d'email OU de téléphone (vérifiée par OTP). */
export const ContactChangeReq = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().min(8).optional(),
  })
  .refine((d) => (d.email !== undefined) !== (d.phone !== undefined), {
    message: 'un seul champ (email ou phone) à la fois',
  });
export type ContactChangeReq = z.infer<typeof ContactChangeReq>;

export const ContactConfirmReq = z.object({
  challengeId: z.string().min(1),
  code: z.string().length(6),
});
export type ContactConfirmReq = z.infer<typeof ContactConfirmReq>;

/** profileComplete = langue+dialecte+région renseignés (consentement séparé). */
export function isProfileComplete(u: { language?: string; dialect?: string; region?: string }): boolean {
  return !!(u.language && u.dialect && u.region);
}
