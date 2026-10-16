import { z } from 'zod';

export const ProfileReq = z.object({
  language: z.string().min(1),
  dialect: z.string().min(1),
  region: z.string().min(1),
  commercialConsent: z.boolean(),
});
export type ProfileReq = z.infer<typeof ProfileReq>;

/** profileComplete = langue+dialecte+région renseignés (consentement séparé). */
export function isProfileComplete(u: { language?: string; dialect?: string; region?: string }): boolean {
  return !!(u.language && u.dialect && u.region);
}
