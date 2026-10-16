import { type FastifyInstance, type FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { RegisterReq, LoginReq, OtpReq, VerifyReq } from '../auth/schemas';
import { signAccess, signRefresh, verifyRefresh } from '../auth/jwt';
import { hashPassword, verifyPassword } from '../auth/crypto';
import { type Repo, type UserRecord } from '../ports/repo';
import { CONFIG } from '../config';
import { generateOtp, sendOtpSms } from '../services/sms';

function publicUser(u: UserRecord) {
  return { id: u.id, name: u.name, role: u.role, competence: u.competence };
}

// Paire de jetons mobile : access court + refresh long (cf. CONFIG.jwt).
function issueTokens(u: UserRecord): { access: string; refresh: string } {
  const access = signAccess(
    { sub: u.id, role: u.role, competence: u.competence, aud: 'mobile' },
    CONFIG.jwt.accessTtl,
  );
  const refresh = signRefresh(u.id, CONFIG.jwt.refreshTtl);
  return { access, refresh };
}

// Compte suspendu/banni/supprimé → refus explicite (les deux points d'entrée
// mobile : envoi d'OTP par téléphone, et vérification d'OTP).
function accountDisabled(reply: FastifyReply) {
  return reply.code(403).send({
    error: { code: 'ACCOUNT_DISABLED', message: 'Compte suspendu ou désactivé. Contactez SabiData.' },
  });
}

async function logMobileLogin(repo: Repo, user: UserRecord): Promise<void> {
  await repo.addAudit({
    actorId: user.id, action: 'login', entityType: 'user', entityId: user.id,
    reason: '', metadata: { channel: 'mobile' },
  });
}

// Surface MOBILE — /api/auth/* (décision 2 : friction minimale).
export async function authRoutes(app: FastifyInstance, repo: Repo): Promise<void> {
  app.post('/register', async (req, reply) => {
    let body: ReturnType<typeof RegisterReq.parse>;
    try {
      body = RegisterReq.parse(req.body);
    } catch (e) {
      if (e instanceof ZodError) {
        const msg = e.issues[0]?.message ?? 'données invalides';
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: msg } });
      }
      throw e;
    }
    // Vérification unicité email (seulement si fourni)
    if (body.email && await repo.findUserByEmail(body.email)) {
      return reply.code(409).send({ error: { code: 'EMAIL_TAKEN', message: 'email déjà utilisé' } });
    }
    const user = await repo.createUser({
      name: body.name,
      email: body.email,
      phone: body.phone,
      passwordHash: hashPassword(body.password),
      role: 'contributor',
      competence: 0,
      phoneVerified: false,
    });
    const { access, refresh } = issueTokens(user);
    await logMobileLogin(repo, user);
    return reply.code(201).send({ access, refresh, user: publicUser(user) });
  });

  // /login accepte soit email+password (compte inscrit), soit phone seul
  // (entrée du flux OTP — cf. décision 2, téléphone = ancre principale).
  app.post('/login', async (req, reply) => {
    const raw = (req.body ?? {}) as { phone?: unknown };
    if (typeof raw.phone === 'string') {
      const { phone } = OtpReq.parse(raw);
      const user = await repo.findUserByPhone(phone);
      if (user && (user.status ?? 'active') !== 'active') {
        return accountDisabled(reply);
      }
      const code = generateOtp();
      await repo.saveOtp(phone, code, new Date(Date.now() + 5 * 60_000));
      await sendOtpSms(phone, code);
      return reply.code(202).send(); // anti-énumération : toujours 202
    }
    const body = LoginReq.parse(req.body);
    const user = await repo.findUserByEmail(body.email);
    if (!user || !user.passwordHash || !verifyPassword(body.password, user.passwordHash)) {
      return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'identifiants invalides' } });
    }
    if ((user.status ?? 'active') !== 'active') {
      return accountDisabled(reply);
    }
    const { access, refresh } = issueTokens(user);
    await logMobileLogin(repo, user);
    return reply.send({ access, refresh, user: publicUser(user) });
  });

  app.post('/otp', async (req, reply) => {
    const body = OtpReq.parse(req.body);
    const user = await repo.findUserByPhone(body.phone);
    if (user && (user.status ?? 'active') !== 'active') {
      return accountDisabled(reply);
    }
    const code = generateOtp();
    await repo.saveOtp(body.phone, code, new Date(Date.now() + 5 * 60_000));
    await sendOtpSms(body.phone, code);
    return reply.code(202).send(); // anti-énumération : toujours 202
  });

  app.post('/verify', async (req, reply) => {
    const body = VerifyReq.parse(req.body);
    if (!(await repo.consumeOtp(body.phone, body.code))) {
      return reply.code(401).send({ error: { code: 'BAD_CODE', message: 'code invalide ou expiré' } });
    }
    // D2 : crée le compte si nouveau, sinon connecte (téléphone = ancre).
    let user = await repo.findUserByPhone(body.phone);
    if (user && (user.status ?? 'active') !== 'active') {
      return accountDisabled(reply);
    }
    user ??= await repo.createUser({
      name: 'Nouveau contributeur',
      phone: body.phone,
      role: 'contributor',
      competence: 0,
      phoneVerified: true,
    });
    const { access, refresh } = issueTokens(user);
    await logMobileLogin(repo, user);
    return reply.send({ access, refresh, user: publicUser(user) });
  });

  // Renouvelle l'access token à partir d'un refresh token valide (session
  // mobile longue durée). Rôle/compétence/statut relus en base.
  app.post('/refresh', async (req, reply) => {
    const raw = (req.body ?? {}) as { refresh?: unknown };
    if (typeof raw.refresh !== 'string') {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'refresh requis' } });
    }
    let sub: string;
    try {
      ({ sub } = verifyRefresh(raw.refresh));
    } catch {
      return reply.code(401).send({ error: { code: 'INVALID_REFRESH', message: 'session expirée' } });
    }
    const user = await repo.findUserById(sub);
    if (!user) {
      return reply.code(401).send({ error: { code: 'INVALID_REFRESH', message: 'session expirée' } });
    }
    if ((user.status ?? 'active') !== 'active') {
      return accountDisabled(reply);
    }
    const { access, refresh } = issueTokens(user);
    return reply.send({ access, refresh });
  });
}
