import { type FastifyInstance, type FastifyReply } from 'fastify';
import { ContributionService } from '../services/contributionService';
import { ClipMultipartReq, VoteReq, TranscriptionReq } from '../contribution/schemas';
import { extFromMime, mimeFromExt, type AudioStore } from '../storage/audioStore';
import { ForbiddenError } from '../authz/can';
import { HttpError } from '../errors';

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof ForbiddenError) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: e.perm } });
  if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: { code: e.code, message: e.code } });
  throw e;
}

// Surface MOBILE — /api/* (préfixe + authenticate('mobile') appliqués au register).
export async function contributionRoutes(
  app: FastifyInstance,
  svc: ContributionService,
  audioStore: AudioStore,
): Promise<void> {
  app.post('/clips', async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'token requis' } });

    const fields: Record<string, string> = {};
    let audioBuffer: Buffer | null = null;
    let audioExt = '';
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'audio') {
            part.file.resume(); // draine les fichiers inattendus
            continue;
          }
          const ext = extFromMime(part.mimetype);
          if (!ext) {
            return reply.code(415).send({ error: { code: 'BAD_FORMAT', message: part.mimetype } });
          }
          audioExt = ext;
          audioBuffer = await part.toBuffer(); // lève si > limite (10 Mo)
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
    } catch (e) {
      if (e instanceof Error && (e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: { code: 'TOO_LARGE', message: 'audio > 10 Mo' } });
      }
      throw e;
    }

    if (!audioBuffer) {
      return reply.code(400).send({ error: { code: 'NO_AUDIO', message: 'fichier audio requis' } });
    }

    const body = ClipMultipartReq.parse(fields);
    const r = await svc.submitClip(
      p.userId,
      {
        promptId: body.promptId,
        rarity: body.rarity as 0 | 1 | 2,
        durationS: body.durationS,
        commercialUse: body.commercialUse,
        consentVersion: body.consentVersion,
        language: body.language,
        dialect: body.dialect,
        region: body.region,
      },
      { buffer: audioBuffer, ext: audioExt },
    );
    return reply.code(201).send(r);
  });

  app.get('/clips/:id/audio', async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'token requis' } });
    const { id } = req.params as { id: string };
    const clip = await svc.getClip(id);
    if (!clip || !clip.audioPath) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'audio' } });
    const stream = await audioStore.openRead(clip.audioPath);
    if (!stream) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'audio' } });
    const ext = clip.audioPath.split('.').pop() ?? '';
    return reply.type(mimeFromExt(ext)).send(stream);
  });

  app.get('/validation/next', async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'token requis' } });
    try {
      const clip = await svc.nextForValidation(p);
      if (!clip) return reply.code(204).send();
      return reply.send({
        clipId: clip.id,
        durationS: clip.durationS,
        requiredCompetence: clip.requiredCompetence,
        audioUrl: `/api/clips/${clip.id}/audio`,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/clips/:id/validations', async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'token requis' } });
    const { id } = req.params as { id: string };
    const body = VoteReq.parse(req.body);
    try {
      const r = await svc.submitVote(p, id, body.verdict);
      return reply.code(201).send(r);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/transcriptions/next', async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'token requis' } });
    try {
      const clip = await svc.nextForTranscription(p);
      if (!clip) return reply.code(204).send();
      return reply.send({
        clipId: clip.id,
        durationS: clip.durationS,
        audioUrl: `/api/clips/${clip.id}/audio`,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/transcriptions', async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'token requis' } });
    const body = TranscriptionReq.parse(req.body);
    try {
      const r = await svc.submitTranscription(p, body);
      return reply.code(201).send(r);
    } catch (e) {
      return fail(reply, e);
    }
  });
}
