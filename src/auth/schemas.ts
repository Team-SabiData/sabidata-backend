import { z } from 'zod';

// Mobile (décision 3 : friction minimale — téléphone = ancre principale)
// email est optionnel : le flux phone+OTP ne l'exige pas.
export const RegisterReq = z.object({
  name: z.string().min(2),
  email: z.string().email().optional(),
  phone: z.string().min(8).optional(),
  password: z.string().min(6),
}).refine((d) => d.email || d.phone, {
  message: 'email ou phone requis',
  path: ['email'],
});
export const LoginReq = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});
export const OtpReq = z.object({ phone: z.string().min(8) });
export const VerifyReq = z.object({ phone: z.string().min(8), code: z.string().length(4) });

// Admin (décision 3 : email+password puis TOTP obligatoire)
export const AdminLoginReq = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});
export const AdminTotpReq = z.object({
  challenge: z.string().min(1),
  code: z.string().length(6),
});
export const AdminRecoveryReq = z.object({
  email: z.string().email(),
  recoveryCode: z.string().min(8),
});

export type RegisterReq = z.infer<typeof RegisterReq>;
export type LoginReq = z.infer<typeof LoginReq>;
export type OtpReq = z.infer<typeof OtpReq>;
export type VerifyReq = z.infer<typeof VerifyReq>;
export type AdminLoginReq = z.infer<typeof AdminLoginReq>;
export type AdminTotpReq = z.infer<typeof AdminTotpReq>;
