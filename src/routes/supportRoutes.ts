import { type FastifyInstance, type FastifyReply } from 'fastify';
import { ZodError, z } from 'zod';
import { ForbiddenError } from '../authz/can';
import { HttpError } from '../errors';
import { checkRateLimit, type RateLimitOpts } from '../http/rateLimit';
import { type SupportService } from '../services/supportService';

const OpenConversationReq = z.object({
  clipId: z.string().min(1).optional(),
  subject: z.string().max(200).optional(),
});
const MessageReq = z.object({ body: z.string().min(1).max(4000) });
const MessageQuery = z.object({
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const ConversationQuery = z.object({
  status: z.enum(['open', 'closed']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const OPEN_LIMIT: RateLimitOpts = { windowMs: 60 * 60_000, max: 5 };
const USER_MESSAGE_LIMIT: RateLimitOpts = { windowMs: 60_000, max: 20 };
const STAFF_MESSAGE_LIMIT: RateLimitOpts = { windowMs: 60_000, max: 60 };

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof ZodError) {
    return reply.code(400).send({
      error: { code: 'BAD_INPUT', message: e.issues[0]?.message ?? 'données invalides' },
    });
  }
  if (e instanceof ForbiddenError) {
    return reply.code(403).send({ error: { code: 'FORBIDDEN', message: e.perm } });
  }
  if (e instanceof HttpError) {
    return reply.code(e.statusCode).send({ error: { code: e.code, message: e.code } });
  }
  throw e;
}

function rateLimited(reply: FastifyReply, key: string, opts: RateLimitOpts): FastifyReply | null {
  const rl = checkRateLimit(key, opts);
  if (rl.ok) return null;
  reply.header('Retry-After', String(rl.retryAfterSec));
  return reply.code(429).send({
    error: { code: 'RATE_LIMITED', message: 'trop de requêtes, réessayez plus tard' },
  });
}

/** Surface mobile — /api/support/* (polling REST, texte uniquement). */
export async function supportRoutes(app: FastifyInstance, svc: SupportService): Promise<void> {
  app.post('/support/conversations', async (req, reply) => {
    const body = OpenConversationReq.parse(req.body ?? {});
    const limited = rateLimited(reply, `support-open:${req.principal!.userId}`, OPEN_LIMIT);
    if (limited) return limited;
    try {
      const conversation = await svc.openConversation(req.principal!, body);
      return reply.code(201).send({ conversation });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/support/conversation', async (req, reply) => {
    try {
      return await svc.getCurrent(req.principal!);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/support/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = MessageQuery.parse(req.query ?? {});
    try {
      return { messages: await svc.listMessages(req.principal!, id, query) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/support/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = MessageReq.parse(req.body);
    const limited = rateLimited(reply, `support-msg:${req.principal!.userId}`, USER_MESSAGE_LIMIT);
    if (limited) return limited;
    try {
      const message = await svc.postMessage(req.principal!, id, body.body);
      return reply.code(201).send({ message });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/support/conversations/:id/read', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.markRead(req.principal!, id);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/support/conversations/:id/close', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { conversation: await svc.close(req.principal!, id) };
    } catch (e) {
      return fail(reply, e);
    }
  });
}

/** Surface staff — /admin/support/* (permission support.manage). */
export async function adminSupportRoutes(app: FastifyInstance, svc: SupportService): Promise<void> {
  app.get('/support/conversations', async (req, reply) => {
    const query = ConversationQuery.parse(req.query ?? {});
    try {
      return await svc.listForStaff(req.principal!, query);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/support/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = MessageQuery.parse(req.query ?? {});
    try {
      return await svc.getForStaff(req.principal!, id, query);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/support/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = MessageReq.parse(req.body);
    const limited = rateLimited(reply, `support-staff-msg:${req.principal!.userId}`, STAFF_MESSAGE_LIMIT);
    if (limited) return limited;
    try {
      const message = await svc.postStaffMessage(req.principal!, id, body.body);
      return reply.code(201).send({ message });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/support/conversations/:id/read', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await svc.markStaffRead(req.principal!, id);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/support/conversations/:id/close', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { conversation: await svc.closeForStaff(req.principal!, id) };
    } catch (e) {
      return fail(reply, e);
    }
  });
}
