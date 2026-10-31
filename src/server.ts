import Fastify, { type FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { InMemoryRepo, type Repo } from './ports/repo';
import { type AudioStore, FsAudioStore, mimeFromExt } from './storage/audioStore';
import { CONFIG } from './config';
import { authRoutes } from './routes/authRoutes';
import { adminAuthRoutes } from './routes/adminAuthRoutes';
import { contributionRoutes } from './routes/contributionRoutes';
import { supportRoutes, adminSupportRoutes } from './routes/supportRoutes';
import { ContributionService } from './services/contributionService';
import { WalletService } from './services/walletService';
import { GovernanceService } from './services/governanceService';
import { AdminService } from './services/adminService';
import { DatasetExportService } from './services/datasetExportService';
import { SupportService } from './services/supportService';
import { QualityService } from './services/qualityService';
import { ReferentialService } from './services/referentialService';
import { authenticate, requirePerm } from './http/guards';
import { enforceAppVersion, minAppVersion } from './http/appVersion';
import { ForbiddenError, can } from './authz/can';
import { permissionsFor } from './domain/roles';
import { HttpError } from './errors';
import { hashPassword } from './auth/crypto';
import { currentTotp } from './auth/totp';
import { hashOtp, otpMatches } from './auth/otp';
import {
  ProfileReq,
  ProfilePatchReq,
  ContactChangeReq,
  ContactConfirmReq,
  isProfileComplete,
} from './mobile/profileSchema';
import { generateOtp, sendOtpSms } from './services/sms';
import { checkRateLimit } from './http/rateLimit';
import { langMatches } from './mobile/langMatch';
import { assertProdSecurity, isProduction } from './config/prodGuard';
import { buildRegionCoverage } from './mobile/regionCoverage';
import { type MediaProcessor, StubMediaProcessor, FfmpegMediaProcessor, ffmpegAvailable } from './media/processor';
import { SEED_PROMPTS } from './db/referentialSeed';

function maskPhone(phone: string): string {
  const digits = phone.replace(/\s+/g, '');
  return digits.length <= 4 ? '****' : `${digits.slice(0, 3)}****${digits.slice(-2)}`;
}

function corsOrigins(): boolean | string[] {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (!raw || raw === '*') return true; // reflechir l'origine (dev / staging)
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Câblage minimal : séparation /api (mobile) vs /admin (web), garde central.
// Injecte le Repo (InMemoryRepo par défaut, PgRepo en prod).
export function buildServer(
  repo: Repo = new InMemoryRepo(),
  audioStore: AudioStore = new FsAudioStore(CONFIG.audioDir),
  media: MediaProcessor = new StubMediaProcessor(),
) {
  const app = Fastify({ logger: false });
  app.register(cors, {
    origin: corsOrigins(),
    credentials: true,
  });
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  app.get('/health', async () => ({ ok: true, service: 'sabidata-backend' }));

  app.addHook('onRequest', async (req, reply) => {
    const path = (req.raw.url ?? '').split('?')[0] ?? '';
    if (path.startsWith('/api/') && path !== '/api/config') {
      await enforceAppVersion(req, reply);
    }
  });

  // Contrat de compatibilité public : consultable même par une version obsolète.
  app.get('/api/config', async () => ({
    apiVersion: CONFIG.apiVersion,
    rbacVersion: CONFIG.rbacVersion,
    minAppVersion: minAppVersion() || null,
    features: {
      supportChat: true,
      qualityAdmin: true,
      datasetCatalog: true,
    },
  }));

  // Auth mobile
  app.register((i) => authRoutes(i, repo), { prefix: '/api/auth' });
  // Auth admin (2FA)
  app.register((i) => adminAuthRoutes(i, repo), { prefix: '/admin/auth' });

  // Surface MOBILE protégée : /me + portefeuille + flux de contribution.
  const contributions = new ContributionService(repo, audioStore, media);
  const wallet = new WalletService(repo);
  const support = new SupportService(repo);
  const quality = new QualityService(repo);

  const fallbackPrompts = SEED_PROMPTS.map((p) => ({
    id: p.id,
    text: p.text,
    lang: p.languageCode,
    dialect: p.dialectCode,
  }));

  app.register(
    async (i) => {
      i.addHook('preHandler', authenticate('mobile', repo));

      // Profil enrichi — renvoie nom, rôle, compétence et points
      i.get('/me', async (req) => {
        const uid = req.principal!.userId;
        const [user, w] = await Promise.all([repo.findUserById(uid), wallet.getWallet(uid)]);
        return {
          id:          uid,
          name:        user?.name        ?? 'Contributeur',
          role:        req.principal?.role,
          permissions: permissionsFor(req.principal!.role),
          rbacVersion: CONFIG.rbacVersion,
          competence:  req.principal?.competence ?? 0,
          points:      w.pointsTotal,
          pointsEarned: w.pointsEarned,
          pointsConvertible: w.pointsConvertible,
          balanceFcfa: w.balanceFcfa,
          contributionsValidated: w.contributionsValidated,
          level:       w.level,
          email:       user?.email ?? null,
          phone:       user?.phone ?? null,
          phoneVerified: user?.phoneVerified ?? false,
          language:     user?.language,
          dialect:      user?.dialect,
          region:       user?.region,
          commercialConsent: user?.commercialConsent ?? false,
          profileComplete: isProfileComplete(user ?? {}),
          profileLocked: isProfileComplete(user ?? {}),
        };
      });

      i.post('/me/profile', async (req, reply) => {
        let body: ReturnType<typeof ProfileReq.parse>;
        try {
          body = ProfileReq.parse(req.body);
        } catch (e) {
          if (e instanceof ZodError) {
            const msg = e.issues[0]?.message ?? 'données invalides';
            return reply.code(400).send({ error: { code: 'BAD_INPUT', message: msg } });
          }
          throw e;
        }
        const uid = req.principal!.userId;
        const user = await repo.findUserById(uid);
        if (!user) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'utilisateur' } });

        // Langue/dialecte/région verrouillés après l'onboarding : seul un
        // administrateur peut les modifier (via /admin). On autorise un envoi
        // identique (le mobile renvoie tout le profil), mais aucun changement.
        if (isProfileComplete(user)) {
          const locked =
            body.language !== user.language ||
            body.dialect !== user.dialect ||
            body.region !== user.region;
          if (locked) {
            return reply.code(409).send({
              error: { code: 'PROFILE_LOCKED', message: 'langue, dialecte et région sont verrouillés' },
            });
          }
        }

        const updated = await repo.updateUser(uid, body);
        await repo.addAudit({
          actorId: uid, action: 'profile.update', entityType: 'user', entityId: uid,
          reason: '', metadata: {},
        });
        return reply.code(200).send({
          language: updated?.language,
          dialect: updated?.dialect,
          region: updated?.region,
          commercialConsent: updated?.commercialConsent ?? false,
          profileComplete: isProfileComplete(updated ?? {}),
        });
      });

      // Modification du nom (email/téléphone passent par le flow OTP ci-dessous).
      i.patch('/me', async (req, reply) => {
        let body: ReturnType<typeof ProfilePatchReq.parse>;
        try {
          body = ProfilePatchReq.parse(req.body);
        } catch (e) {
          if (e instanceof ZodError) {
            const msg = e.issues[0]?.message ?? 'données invalides';
            return reply.code(400).send({ error: { code: 'BAD_INPUT', message: msg } });
          }
          throw e;
        }
        const uid = req.principal!.userId;
        const updated = await repo.updateUser(uid, { name: body.name });
        if (!updated) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'utilisateur' } });
        await repo.addAudit({
          actorId: uid, action: 'profile.update', entityType: 'user', entityId: uid,
          reason: '', metadata: { fields: ['name'] },
        });
        return { id: updated.id, name: updated.name };
      });

      // Demande de changement de contact : un OTP est envoyé au numéro de
      // vérification (numéro actuel pour un email, nouveau numéro pour un phone).
      i.post('/me/contact', async (req, reply) => {
        const p = req.principal!;
        const limit = checkRateLimit(`contact:${p.userId}`, { windowMs: 60_000, max: 3 });
        if (!limit.ok) {
          return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'trop de demandes' } });
        }
        let body: ReturnType<typeof ContactChangeReq.parse>;
        try {
          body = ContactChangeReq.parse(req.body);
        } catch (e) {
          if (e instanceof ZodError) {
            const msg = e.issues[0]?.message ?? 'données invalides';
            return reply.code(400).send({ error: { code: 'BAD_INPUT', message: msg } });
          }
          throw e;
        }
        const user = await repo.findUserById(p.userId);
        if (!user) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'utilisateur' } });

        let verifyPhone: string;
        if (body.email) {
          const email = body.email.toLowerCase();
          const existing = await repo.findUserByEmail(email);
          if (existing && existing.id !== user.id) {
            return reply.code(409).send({ error: { code: 'CONTACT_TAKEN', message: 'email déjà utilisé' } });
          }
          if (!user.phone) {
            return reply.code(409).send({
              error: { code: 'PHONE_REQUIRED', message: 'ajoutez un téléphone avant de modifier l’email' },
            });
          }
          verifyPhone = user.phone;
        } else {
          const phone = body.phone!.trim();
          const existing = await repo.findUserByPhone(phone);
          if (existing && existing.id !== user.id) {
            return reply.code(409).send({ error: { code: 'CONTACT_TAKEN', message: 'téléphone déjà utilisé' } });
          }
          verifyPhone = phone;
        }

        const code = generateOtp();
        const change = await repo.createContactChange({
          userId: user.id,
          newEmail: body.email?.toLowerCase(),
          newPhone: body.phone?.trim(),
          verifyPhone,
          codeHash: hashOtp(code),
          expiresAt: new Date(Date.now() + 5 * 60_000),
        });
        await sendOtpSms(verifyPhone, code);
        return reply.code(202).send({
          challengeId: change.id,
          sentTo: maskPhone(verifyPhone),
          expiresAt: change.expiresAt,
        });
      });

      i.post('/me/contact/confirm', async (req, reply) => {
        let body: ReturnType<typeof ContactConfirmReq.parse>;
        try {
          body = ContactConfirmReq.parse(req.body);
        } catch (e) {
          if (e instanceof ZodError) {
            const msg = e.issues[0]?.message ?? 'données invalides';
            return reply.code(400).send({ error: { code: 'BAD_INPUT', message: msg } });
          }
          throw e;
        }
        const uid = req.principal!.userId;
        const change = await repo.getContactChange(body.challengeId);
        if (!change || change.userId !== uid) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'demande inconnue' } });
        }
        if (change.expiresAt < new Date()) {
          await repo.deleteContactChange(change.id);
          return reply.code(401).send({ error: { code: 'CODE_EXPIRED', message: 'code expiré' } });
        }
        if (!otpMatches(body.code, change.codeHash)) {
          return reply.code(401).send({ error: { code: 'BAD_CODE', message: 'code invalide' } });
        }
        const updated = await repo.updateUser(
          uid,
          change.newPhone
            ? { phone: change.newPhone, phoneVerified: true }
            : { email: change.newEmail },
        );
        await repo.deleteContactChange(change.id);
        await repo.addAudit({
          actorId: uid, action: 'contact.update', entityType: 'user', entityId: uid,
          reason: '', metadata: { field: change.newPhone ? 'phone' : 'email' },
        });
        return {
          email: updated?.email ?? null,
          phone: updated?.phone ?? null,
          phoneVerified: updated?.phoneVerified ?? false,
        };
      });

      i.get('/me/wallet', async (req) => wallet.getWallet(req.principal!.userId));

      // Historique perso des gains — antéchronologique.
      i.get('/me/ledger', async (req) => ({ entries: await repo.ledgerHistoryFor(req.principal!.userId) }));

      // Phrase suivante — DB référentiel, fallback seed
      i.get('/prompts/next', async (req) => {
        const query = (req.query as Record<string, string>);
        const langParam = (query.lang ?? '').trim();
        let dbPrompts = await repo.listActivePrompts();
        if (langParam) {
          dbPrompts = dbPrompts.filter((p) => langMatches(p.languageCode, langParam));
        }
        if (dbPrompts.length > 0) {
          const p = dbPrompts[Math.floor(Math.random() * dbPrompts.length)]!;
          return {
            prompt: {
              id: p.stableId,
              text: p.text,
              lang: p.languageCode,
              dialect: p.dialectCode,
            },
          };
        }
        const pool = langParam
          ? fallbackPrompts.filter((p) => langMatches(p.lang, langParam))
          : fallbackPrompts;
        const source = pool.length > 0 ? pool : fallbackPrompts;
        const prompt = source[Math.floor(Math.random() * source.length)];
        return { prompt };
      });

      // Classement par langue + dialecte (les deux obligatoires) — top 10 des
      // points cumulés gagnés dans ce couple linguistique.
      i.get('/leaderboard', async (req, reply) => {
        const uid = req.principal!.userId;
        const q = req.query as Record<string, string>;
        const language = (q.lang ?? '').trim();
        const dialect = (q.dialect ?? '').trim();
        if (!language || !dialect) {
          return reply.code(400).send({
            error: { code: 'BAD_INPUT', message: 'lang et dialect sont requis' },
          });
        }
        const users = (await repo.listUsers()).filter(
          (u) =>
            u.language != null &&
            u.dialect != null &&
            langMatches(u.language, language) &&
            u.dialect.toLowerCase() === dialect.toLowerCase(),
        );

        const entries = await Promise.all(
          users.map(async (u) => {
            const w = await wallet.getWallet(u.id);
            return {
              id: u.id,
              name: u.name,
              points: w.pointsEarned,
              language: u.language,
              dialect: u.dialect,
            };
          }),
        );

        entries.sort((a, b) => b.points - a.points);
        const top10 = entries.slice(0, 10).map((e, idx) => ({ rank: idx + 1, ...e }));
        const myIdx = entries.findIndex((e) => e.id === uid);
        const me = myIdx >= 0 ? { rank: myIdx + 1, ...entries[myIdx] } : null;
        return { language, dialect, top10, me };
      });

      await contributionRoutes(i, contributions, audioStore);
      await supportRoutes(i, support);
    },
    { prefix: '/api' },
  );

  // Référentiel + couverture — public (aucune PII).
  app.register(
    async (i) => {
      i.get('/regions', async () => buildRegionCoverage(await repo.countClipsByRegion()));
      i.get('/languages', async () => {
        const all = await repo.listLanguages({ includeInactive: true });
        if (all.length > 0) return { languages: all.filter((l) => l.status === 'active') };
        return {
          languages: [
            { code: 'moore', nameFr: 'Mooré', isoBcp47: 'mos' },
            { code: 'dioula', nameFr: 'Dioula', isoBcp47: 'dyu' },
            { code: 'fulfulde', nameFr: 'Fulfuldé', isoBcp47: 'fuv' },
          ],
        };
      });
      i.get('/dialects', async (req) => {
        const lang = ((req.query as Record<string, string>).lang ?? '').trim() || undefined;
        return { dialects: await repo.listDialects(lang) };
      });
    },
    { prefix: '/api' },
  );

  const governance = new GovernanceService(repo);
  const adminSvc = new AdminService(repo);
  const referential = new ReferentialService(repo);
  const datasetExport = new DatasetExportService(repo, audioStore);
  app.register(
    async (i) => {
      i.addHook('preHandler', authenticate('admin', repo));
      // Toutes les mutations admin sont gardées par le garde central can().
      const sendErr = (reply: FastifyReply, e: unknown) => {
        if (e instanceof ForbiddenError) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: e.perm } });
        if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: { code: e.code, message: e.code } });
        throw e;
      };

      i.get('/me', async (req) => {
        const p = req.principal!;
        const user = await repo.findUserById(p.userId);
        return {
          id: p.userId,
          name: user?.name ?? 'Admin',
          role: p.role,
          competence: p.competence,
          permissions: permissionsFor(p.role),
          rbacVersion: CONFIG.rbacVersion,
        };
      });

      i.get('/disputes', { preHandler: requirePerm('dispute.arbitrate') }, async () => {
        const clips = await repo.listClipsByStatus('disputed');
        const disputes = [];
        for (const c of clips) {
          const meta = await contributions.promptMetaForClip(c);
          const votes = await repo.votesForClip(c.id);
          const contributor = await repo.findUserById(c.contributorId);
          const conversation = await support.summaryForClip(c.id);
          disputes.push({
            id: c.id,
            durationS: c.durationS,
            rarity: c.rarity,
            language: c.language,
            dialect: c.dialect,
            region: c.region,
            audioQuality: c.audioQuality,
            promptId: meta.promptId,
            promptText: meta.promptText,
            contributor: contributor
              ? { id: contributor.id, name: contributor.name }
              : { id: c.contributorId, name: 'Inconnu' },
            votes: votes.map((v) => ({
              verdict: v.verdict,
              validatorId: v.validatorId,
              competence: v.reviewerCompetence,
            })),
            conversation,
          });
        }
        return { disputes };
      });

      i.get('/quality', { preHandler: requirePerm('content.moderate') }, async (req, reply) => {
        const q = req.query as {
          type?: 'clips' | 'transcriptions' | 'all';
          status?: string;
          language?: string;
          page?: string;
          limit?: string;
        };
        try {
          return await quality.list(req.principal!, {
            type: q.type,
            status: q.status,
            language: q.language,
            page: q.page ? Number(q.page) : undefined,
            limit: q.limit ? Number(q.limit) : undefined,
          });
        } catch (e) {
          return sendErr(reply, e);
        }
      });

      i.get('/quality-queue', { preHandler: requirePerm('content.moderate') }, async () => {
        const clips = await repo.listQualityQueue();
        const items = [];
        for (const c of clips) {
          const meta = await contributions.promptMetaForClip(c);
          items.push({
            id: c.id,
            status: c.status,
            durationS: c.durationS,
            audioQuality: c.audioQuality ?? null,
            silenceRatio: c.silenceRatio ?? null,
            snrDb: c.snrDb ?? null,
            language: c.language,
            dialect: c.dialect,
            promptText: meta.promptText,
            contributorId: c.contributorId,
            createdAt: c.createdAt,
            autocheck: c.autocheck ?? null,
          });
        }
        return { items };
      });

      // — Référentiel (admin) —
      i.get('/languages', { preHandler: requirePerm('reference.manage') }, async () => ({
        languages: await repo.listLanguages({ includeInactive: true }),
      }));
      i.post('/languages', { preHandler: requirePerm('reference.manage') }, async (req, reply) => {
        const body = (req.body ?? {}) as { code?: string; nameFr?: string; isoBcp47?: string };
        if (!body.code || !body.nameFr || !body.isoBcp47) {
          return reply.code(400).send({ error: { code: 'BAD_INPUT', message: 'code, nameFr, isoBcp47 requis' } });
        }
        try {
          const language = await repo.createLanguage({
            code: body.code, nameFr: body.nameFr, isoBcp47: body.isoBcp47,
          });
          await repo.addAudit({
            actorId: req.principal!.userId, action: 'reference.language.create',
            entityType: 'language', entityId: language.id, reason: 'create',
            metadata: { code: language.code },
          });
          return reply.code(201).send({ language });
        } catch (e) {
          return sendErr(reply, e);
        }
      });
      i.patch('/languages/:code', { preHandler: requirePerm('reference.manage') }, async (req, reply) => {
        const { code } = req.params as { code: string };
        try {
          return await referential.updateLanguage(req.principal!, code, (req.body ?? {}) as never);
        } catch (e) { return sendErr(reply, e); }
      });
      i.delete('/languages/:code', { preHandler: requirePerm('reference.manage') }, async (req, reply) => {
        const { code } = req.params as { code: string };
        try { return await referential.deleteLanguage(req.principal!, code); }
        catch (e) { return sendErr(reply, e); }
      });
      i.get('/dialects', { preHandler: requirePerm('reference.manage') }, async (req) => {
        const lang = ((req.query as Record<string, string>).lang ?? '').trim() || undefined;
        return { dialects: await repo.listDialects(lang, { includeInactive: true }) };
      });
      i.post('/dialects', { preHandler: requirePerm('reference.manage') }, async (req, reply) => {
        const body = (req.body ?? {}) as {
          languageCode?: string; code?: string; nameFr?: string; zone?: string; targetHours?: number;
        };
        if (!body.languageCode || !body.code || !body.nameFr) {
          return reply.code(400).send({ error: { code: 'BAD_INPUT', message: 'languageCode, code, nameFr requis' } });
        }
        try {
          const dialect = await repo.createDialect({
            languageCode: body.languageCode, code: body.code, nameFr: body.nameFr,
            zone: body.zone, targetHours: body.targetHours,
          });
          await repo.addAudit({
            actorId: req.principal!.userId, action: 'reference.dialect.create',
            entityType: 'dialect', entityId: dialect.id, reason: 'create',
          });
          return reply.code(201).send({ dialect });
        } catch (e) {
          return reply.code(400).send({ error: { code: 'BAD_INPUT', message: String(e) } });
        }
      });
      i.patch('/dialects/:id', { preHandler: requirePerm('reference.manage') }, async (req, reply) => {
        const { id } = req.params as { id: string };
        try {
          return await referential.updateDialect(req.principal!, id, (req.body ?? {}) as never);
        } catch (e) { return sendErr(reply, e); }
      });
      i.delete('/dialects/:id', { preHandler: requirePerm('reference.manage') }, async (req, reply) => {
        const { id } = req.params as { id: string };
        try { return await referential.deleteDialect(req.principal!, id); }
        catch (e) { return sendErr(reply, e); }
      });
      i.get('/prompts', { preHandler: requirePerm('reference.manage') }, async (req) => {
        const lang = ((req.query as Record<string, string>).lang ?? '').trim() || undefined;
        return { prompts: await repo.listPrompts(lang, { includeInactive: true }) };
      });
      i.post('/prompts', { preHandler: requirePerm('reference.manage') }, async (req, reply) => {
        const body = (req.body ?? {}) as {
          stableId?: string; languageCode?: string; dialectCode?: string; text?: string;
        };
        if (!body.stableId || !body.languageCode || !body.text) {
          return reply.code(400).send({ error: { code: 'BAD_INPUT', message: 'stableId, languageCode, text requis' } });
        }
        try {
          const prompt = await repo.createPrompt({
            stableId: body.stableId, languageCode: body.languageCode,
            dialectCode: body.dialectCode, text: body.text,
          });
          await repo.addAudit({
            actorId: req.principal!.userId, action: 'reference.prompt.create',
            entityType: 'prompt', entityId: prompt.stableId, reason: 'create',
          });
          return reply.code(201).send({ prompt });
        } catch (e) {
          return reply.code(400).send({ error: { code: 'BAD_INPUT', message: String(e) } });
        }
      });
      i.patch('/prompts/:stableId', { preHandler: requirePerm('reference.manage') }, async (req, reply) => {
        const { stableId } = req.params as { stableId: string };
        try {
          const { prompt } = await referential.updatePrompt(
            req.principal!, stableId, (req.body ?? {}) as never,
          );
          return { ok: true, stableId, active: prompt.active !== false, prompt };
        } catch (e) { return sendErr(reply, e); }
      });
      i.delete('/prompts/:stableId', { preHandler: requirePerm('reference.manage') }, async (req, reply) => {
        const { stableId } = req.params as { stableId: string };
        try { return await referential.deletePrompt(req.principal!, stableId); }
        catch (e) { return sendErr(reply, e); }
      });

      // Arbitrage d'un litige — résout disputed→validated|rejected, journalisé.
      i.post('/clips/:id/arbitrate', { preHandler: requirePerm('dispute.arbitrate') }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as { result?: string; reason?: string };
        if (body.result !== 'validated' && body.result !== 'rejected') {
          return reply.code(400).send({ error: { code: 'BAD_RESULT', message: 'result ∈ {validated,rejected}' } });
        }
        try {
          const r = await governance.arbitrate(req.principal!, id, body.result, body.reason ?? '');
          return reply.send(r);
        } catch (e) {
          return sendErr(reply, e);
        }
      });

      // Écoute d'un clip en litige — /api/clips/:id/audio exige l'audience
      // 'mobile' ; un token admin est refusé. On rejoue le même flux ici,
      // gardé par content.read_any (lecture, pas de mutation).
      i.get('/clips/:id/audio', { preHandler: requirePerm('content.read_any') }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const clip = await contributions.getClip(id);
        if (!clip || !clip.audioPath) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'audio' } });
        const path = clip.audioMasterPath ?? clip.audioPath;
        const stream = await audioStore.openRead(path);
        if (!stream) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'audio' } });
        const ext = path.split('.').pop() ?? '';
        return reply.type(mimeFromExt(ext)).send(stream);
      });

      // Journal d'audit immuable — lecture seule (admin uniquement).

      // — Dataset catalogue (tout le validé, tous tiers) —
      i.get('/dataset/catalog', { preHandler: requirePerm('export.run') }, async (req, reply) => {
        const q = req.query as {
          groupBy?: string;
          language?: string;
          dialect?: string;
          quality?: 'A' | 'B' | 'C';
          tier?: 'gold' | 'silver' | 'bronze';
        };
        if (!q.groupBy || !['language', 'dialect', 'quality', 'tier'].includes(q.groupBy)) {
          return reply.code(400).send({ error: { code: 'BAD_INPUT', message: 'groupBy requis' } });
        }
        try {
          return await datasetExport.catalog(
            req.principal!,
            q.groupBy as 'language' | 'dialect' | 'quality' | 'tier',
            { language: q.language, dialect: q.dialect, quality: q.quality, tier: q.tier },
          );
        } catch (e) {
          return sendErr(reply, e);
        }
      });
      i.get('/dataset/catalog/download', { preHandler: requirePerm('export.run') }, async (req, reply) => {
        const q = req.query as {
          format?: string;
          language?: string;
          dialect?: string;
          quality?: 'A' | 'B' | 'C';
          tier?: 'gold' | 'silver' | 'bronze';
        };
        const filter = { language: q.language, dialect: q.dialect, quality: q.quality, tier: q.tier };
        try {
          if (q.format === 'jsonl') {
            const body = await datasetExport.catalogJsonl(req.principal!, filter);
            return reply
              .header('content-type', 'application/x-ndjson; charset=utf-8')
              .header('content-disposition', 'attachment; filename="sabidata-catalog.jsonl"')
              .send(body);
          }
          if (q.format === 'zip') {
            const { archive, itemCount } = await datasetExport.catalogArchive(req.principal!, filter);
            return reply
              .header('content-type', 'application/zip')
              .header('content-disposition', 'attachment; filename="sabidata-catalog.zip"')
              .header('x-item-count', String(itemCount))
              .send(archive);
          }
          return reply.code(400).send({ error: { code: 'BAD_INPUT', message: 'format zip|jsonl' } });
        } catch (e) {
          return sendErr(reply, e);
        }
      });

      // — Dataset releases —
      i.get('/dataset/releases', { preHandler: requirePerm('export.run') }, async (req, reply) => {
        try {
          return { releases: await datasetExport.listReleases(req.principal!) };
        } catch (e) {
          return sendErr(reply, e);
        }
      });
      i.get('/dataset/releases/:id', { preHandler: requirePerm('export.run') }, async (req, reply) => {
        try {
          const { id } = req.params as { id: string };
          return await datasetExport.getRelease(req.principal!, id);
        } catch (e) {
          return sendErr(reply, e);
        }
      });
      i.get('/dataset/releases/:id/manifest', { preHandler: requirePerm('export.run') }, async (req, reply) => {
        try {
          const { id } = req.params as { id: string };
          const release = await datasetExport.getRelease(req.principal!, id);
          if (!release.manifestJsonl) {
            return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'manifest' } });
          }
          return reply
            .header('content-type', 'application/x-ndjson; charset=utf-8')
            .header('content-disposition', `attachment; filename="${release.version}-manifest.jsonl"`)
            .send(release.manifestJsonl);
        } catch (e) {
          return sendErr(reply, e);
        }
      });
      i.post('/dataset/releases', { preHandler: requirePerm('export.run') }, async (req, reply) => {
        const body = (req.body ?? {}) as {
          version?: string;
          licenseTag?: string;
          filter?: {
            languages?: string[];
            audioQualities?: Array<'A' | 'B' | 'C'>;
            minTiers?: Array<'gold' | 'silver' | 'bronze'>;
            commercialOnly?: boolean;
            aOnly?: boolean;
          };
        };
        if (!body.version?.trim()) {
          return reply.code(400).send({ error: { code: 'BAD_INPUT', message: 'version requise' } });
        }
        try {
          const r = await datasetExport.createRelease(req.principal!, {
            version: body.version.trim(),
            licenseTag: body.licenseTag,
            filter: body.filter,
          });
          return reply.code(201).send(r);
        } catch (e) {
          return sendErr(reply, e);
        }
      });

      await adminSupportRoutes(i, support);

      i.get('/audit-log', { preHandler: requirePerm('audit.read') }, async (req) => {
        const q = req.query as { actor?: string; entity?: string; action?: string };
        const entries = await governance.listAudit({ actorId: q.actor, entityId: q.entity, action: q.action });
        return { entries };
      });

      i.get('/users', { preHandler: requirePerm('content.read_any') }, async (req) => {
        const users = await repo.listUsers();
        // content.read_any (modérateur inclus) ne donne pas droit au solde ni
        // au PII — seul wallet.read (admin) voit balance/email/phone/dernière connexion.
        const seesWallet = can(req.principal!, 'wallet.read');
        const logins = seesWallet ? await repo.listAudit({ action: 'login' }) : [];
        const out = [];
        for (const u of users) {
          let balanceFcfa: number | null = null;
          let lastLoginAt: Date | null = null;
          if (seesWallet) {
            const w = await wallet.getWallet(u.id);
            balanceFcfa = w.balanceFcfa;
            const last = logins.filter((l) => l.actorId === u.id).at(-1);
            lastLoginAt = last ? last.createdAt : null;
          }
          out.push({
            id: u.id, name: u.name, role: u.role, competence: u.competence,
            status: u.status ?? 'active',
            email: seesWallet ? (u.email ?? null) : null,
            phone: seesWallet ? (u.phone ?? null) : null,
            balanceFcfa,
            lastLoginAt,
          });
        }
        return { users: out };
      });

      i.patch('/users/:id', { preHandler: requirePerm('user.manage') }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as { role?: string; competence?: number; status?: string; reason?: string };
        try {
          if (body.status) {
            if (body.status !== 'active' && body.status !== 'suspended' && body.status !== 'banned') {
              return reply.code(400).send({ error: { code: 'BAD_STATUS', message: 'status ∈ {active,suspended,banned}' } });
            }
            const r = await adminSvc.setUserStatus(req.principal!, id, body.status, body.reason ?? '');
            return reply.send(r);
          }
          const r = await adminSvc.changeRole(
            req.principal!, id,
            { role: body.role as never, competence: body.competence as never },
            body.reason ?? '',
          );
          return reply.send(r);
        } catch (e) { return sendErr(reply, e); }
      });

      i.post('/users', { preHandler: requirePerm('user.manage') }, async (req, reply) => {
        const body = (req.body ?? {}) as { name?: string; email?: string; phone?: string; role?: string; password?: string };
        try {
          const r = await adminSvc.createUser(req.principal!, {
            name: body.name ?? '', email: body.email, phone: body.phone,
            role: (body.role ?? 'contributor') as never, password: body.password,
          });
          return reply.code(201).send(r);
        } catch (e) { return sendErr(reply, e); }
      });

      i.post('/users/:id/password', { preHandler: requirePerm('user.manage') }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as { password?: string; reason?: string };
        try {
          return await adminSvc.resetPassword(
            req.principal!, id, body.password ?? '', body.reason ?? '',
          );
        } catch (e) { return sendErr(reply, e); }
      });

      i.delete('/users/:id', { preHandler: requirePerm('user.manage') }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as { reason?: string };
        try { return await adminSvc.deleteUser(req.principal!, id, body.reason ?? ''); }
        catch (e) { return sendErr(reply, e); }
      });

      i.get('/users/:id/wallet', { preHandler: requirePerm('wallet.read') }, async (req, reply) => {
        const { id } = req.params as { id: string };
        if (!(await repo.findUserById(id))) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'user' } });
        return wallet.getWallet(id);
      });

      i.get('/users/:id/ledger', { preHandler: requirePerm('wallet.read') }, async (req) => {
        const { id } = req.params as { id: string };
        return { entries: await repo.ledgerFor(id) };
      });

      i.get('/users/:id/activity', { preHandler: requirePerm('audit.read') }, async (req) => {
        const { id } = req.params as { id: string };
        const asActor = await repo.listAudit({ actorId: id });
        const asEntity = await repo.listAudit({ entityId: id });
        const seen = new Set<string>();
        const entries = [...asActor, ...asEntity]
          .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return { entries };
      });

      i.post('/users/:id/adjustments', { preHandler: requirePerm('wallet.adjust') }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as { delta?: number; reason?: string };
        try { return await adminSvc.adjustBalance(req.principal!, id, body.delta ?? 0, body.reason ?? ''); }
        catch (e) { return sendErr(reply, e); }
      });

      i.get('/withdrawals', { preHandler: requirePerm('withdrawal.settle') }, async (req) => {
        const q = req.query as { status?: 'processing' | 'paid' | 'failed' };
        const withdrawals = await repo.listWithdrawals(q.status);
        return { withdrawals };
      });

      i.post('/withdrawals/:id/decide', { preHandler: requirePerm('withdrawal.settle') }, async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as { decision?: string; reason?: string };
        if (body.decision !== 'approved' && body.decision !== 'rejected') {
          return reply.code(400).send({ error: { code: 'BAD_DECISION', message: 'decision ∈ {approved,rejected}' } });
        }
        try { return await adminSvc.decideWithdrawal(req.principal!, id, body.decision, body.reason ?? ''); }
        catch (e) { return sendErr(reply, e); }
      });
    },
    { prefix: '/admin' },
  );

  return app;
}

// Secret TOTP de DEV fixe → l'opérateur calcule le code courant (cf. README).
// En prod : provisioning réel + secret par admin généré via generateTotpSecret().
export const DEV_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

// Compte admin de DEV (à supprimer en prod ; remplacer par un provisioning réel).
export async function seedDevAdmin(repo: Repo): Promise<void> {
  const existing = await repo.findUserByEmail('admin@sabidata.bf');
  if (!existing) {
    await repo.createUser({
      name: 'Admin SabiData',
      role: 'admin',
      competence: 3,
      email: 'admin@sabidata.bf',
      passwordHash: hashPassword('admin123'),
      phoneVerified: true,
      totpSecret: DEV_TOTP_SECRET,
    });
  }
}

// Démarrage direct : `RUN_SERVER=1 tsx src/server.ts`.
// Base : DATABASE_URL (Postgres managé, ex. Neon) > DATABASE=pg (PGlite) > mémoire.
// Audio : S3_BUCKET (+ S3_ENDPOINT/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY,
// compatible R2) > filesystem (AUDIO_DIR).
if (process.env.RUN_SERVER === '1') {
  const boot = async () => {
    // Fail-fast : refuse de démarrer sur des valeurs par défaut « dev » en prod.
    assertProdSecurity();

    let repo: Repo = new InMemoryRepo();
    let repoLabel = 'memory';
    if (process.env.DATABASE_URL) {
      const { createPgDb } = await import('./db/pg');
      const { ensureSchema } = await import('./db/sql');
      const { PgRepo } = await import('./ports/pgRepo');
      const db = createPgDb(process.env.DATABASE_URL);
      await ensureSchema(db);
      repo = new PgRepo(db);
      repoLabel = 'postgres (DATABASE_URL)';
    } else if (process.env.DATABASE === 'pg') {
      const { createDb } = await import('./db/pglite');
      const { PgRepo } = await import('./ports/pgRepo');
      repo = new PgRepo(await createDb());
      repoLabel = 'postgres (pglite)';
    }

    let audioStore: AudioStore | undefined;
    let audioLabel = 'fs';
    if (process.env.S3_BUCKET) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      const { S3AudioStore } = await import('./storage/s3AudioStore');
      const client = new S3Client({
        region: process.env.S3_REGION ?? 'auto', // R2 : 'auto'
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: Boolean(process.env.S3_ENDPOINT),
        credentials: process.env.S3_ACCESS_KEY_ID
          ? {
              accessKeyId: process.env.S3_ACCESS_KEY_ID,
              secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
            }
          : undefined,
      });
      audioStore = new S3AudioStore(client, {
        bucket: process.env.S3_BUCKET,
        prefix: process.env.S3_PREFIX,
      });
      audioLabel = `s3 (${process.env.S3_BUCKET})`;
    }

    // Seed admin de dev (identifiants + secret TOTP publics) : jamais en prod.
    if (!isProduction()) {
      await seedDevAdmin(repo);
    }
    let media: MediaProcessor = new StubMediaProcessor();
    if (await ffmpegAvailable()) {
      media = new FfmpegMediaProcessor();
      console.log('media: ffmpeg');
    } else {
      console.warn('media: stub (ffmpeg absent — qualité dataset dégradée)');
    }
    const app = buildServer(repo, audioStore, media);
    // Railway injecte PORT ; défaut 3000 en local. host 0.0.0.0 → LAN + containers.
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`SabiData API on 0.0.0.0:${port} (repo: ${repoLabel}, audio: ${audioLabel})`);
    if (!isProduction()) {
      console.log(`[dev] admin TOTP courant : ${currentTotp(DEV_TOTP_SECRET)} (valide ~30 s)`);
    }
  };
  void boot();
}
