import { randomInt } from 'node:crypto';
import { type FastifyInstance } from 'fastify';
import { authenticate } from '../http/guards';
import { type Repo } from '../ports/repo';
import { type WalletService } from '../services/walletService';
import { type Classroom } from '../domain/contribution';

/**
 * Routes Classroom — groupe de collecte rejoint par CODE D'INVITATION.
 * Les contributions d'un membre sont rattachées à son classroom (clip.classroom_id),
 * ce qui alimente les stats de groupe (clips, points cumulés, membres).
 *
 * POST /api/classrooms         — créer (le créateur rejoint, reçoit un code)
 * POST /api/classrooms/join    — rejoindre via { code }
 * GET  /api/classrooms/mine    — mon classroom + stats (ou null)
 * POST /api/classrooms/leave   — quitter
 */

// Alphabet sans caractères ambigus (I, O, 0, 1, L).
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Code d'invitation aléatoire cryptographiquement sûr (randomInt), non
// prédictible. À compléter par un rate-limit sur /classrooms/join avant la prod.
function randomCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return code;
}

async function genUniqueCode(repo: Repo): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = randomCode();
    if (!(await repo.findClassroomByCode(code))) return code;
  }
  return randomCode(); // collision improbable après 12 essais
}

// Rate-limit anti-énumération des codes : au plus JOIN_MAX tentatives de join
// par fenêtre glissante et par utilisateur.
const JOIN_MAX = 8;
const JOIN_WINDOW_MS = 60_000;

export async function classroomRoutes(app: FastifyInstance, repo: Repo, wallet: WalletService): Promise<void> {
  app.addHook('preHandler', authenticate('mobile'));

  // État du rate-limit, scopé à l'instance serveur (in-memory).
  const joinHits = new Map<string, number[]>();
  function joinRateExceeded(userId: string): boolean {
    const now = Date.now();
    const recent = (joinHits.get(userId) ?? []).filter((t) => now - t < JOIN_WINDOW_MS);
    recent.push(now);
    joinHits.set(userId, recent);
    return recent.length > JOIN_MAX;
  }

  // Vue détaillée + stats de groupe.
  async function detail(cls: Classroom) {
    const [owner, members, clipCount] = await Promise.all([
      repo.findUserById(cls.ownerId),
      repo.listClassroomMembers(cls.id),
      repo.countClipsByClassroom(cls.id),
    ]);
    const memberStats = await Promise.all(
      members.map(async (m) => ({ id: m.id, name: m.name, points: (await wallet.getWallet(m.id)).pointsTotal })),
    );
    memberStats.sort((a, b) => b.points - a.points);
    return {
      id: cls.id,
      name: cls.name,
      description: cls.description,
      inviteCode: cls.inviteCode,
      ownerName: owner?.name ?? 'Anonyme',
      memberCount: members.length,
      clipCount,
      groupPoints: memberStats.reduce((s, m) => s + m.points, 0),
      members: memberStats,
      createdAt: cls.createdAt.toISOString(),
    };
  }

  // Créer un classroom — le créateur le rejoint automatiquement.
  app.post('/classrooms', async (req, reply) => {
    const body = req.body as { name?: string; description?: string };
    const name = body?.name?.toString().trim();
    if (!name || name.length < 3) {
      return reply.code(400).send({ error: { code: 'INVALID_NAME', message: 'Le nom doit faire au moins 3 caractères.' } });
    }
    const uid = req.principal!.userId;
    const cls = await repo.createClassroom({
      name,
      description: (body?.description?.toString() ?? '').slice(0, 280),
      ownerId: uid,
      inviteCode: await genUniqueCode(repo),
    });
    await repo.updateUser(uid, { classroomId: cls.id });
    return reply.code(201).send({ classroom: { ...(await detail(cls)), isOwner: true } });
  });

  // Rejoindre par code d'invitation.
  app.post('/classrooms/join', async (req, reply) => {
    const uid = req.principal!.userId;
    if (joinRateExceeded(uid)) {
      return reply.code(429).send({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Trop de tentatives. Réessayez dans une minute.' } });
    }
    const body = req.body as { code?: string };
    const code = body?.code?.toString().trim().toUpperCase();
    if (!code) return reply.code(400).send({ error: { code: 'MISSING_CODE', message: 'Code requis.' } });
    const cls = await repo.findClassroomByCode(code);
    if (!cls) return reply.code(404).send({ error: { code: 'INVALID_CODE', message: 'Code invalide.' } });
    await repo.updateUser(uid, { classroomId: cls.id });
    return reply.send({ classroom: { ...(await detail(cls)), isOwner: cls.ownerId === uid } });
  });

  // Mon classroom courant (+ stats) ou null.
  app.get('/classrooms/mine', async (req) => {
    const uid = req.principal!.userId;
    const me = await repo.findUserById(uid);
    if (!me?.classroomId) return { classroom: null };
    const cls = await repo.findClassroomById(me.classroomId);
    if (!cls) return { classroom: null };
    return { classroom: { ...(await detail(cls)), isOwner: cls.ownerId === uid } };
  });

  // Quitter mon classroom.
  app.post('/classrooms/leave', async (req) => {
    await repo.updateUser(req.principal!.userId, { classroomId: null });
    return { ok: true };
  });
}
