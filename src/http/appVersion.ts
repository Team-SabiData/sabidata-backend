import { type FastifyReply, type FastifyRequest } from 'fastify';

export function minAppVersion(): string {
  return process.env.MIN_APP_VERSION?.trim() ?? '';
}

export function parseAppVersion(value: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/i.exec(value.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** < 0 si a < b, 0 si égal, > 0 si a > b ; null si une version est invalide. */
export function compareAppVersions(a: string, b: string): number | null {
  const pa = parseAppVersion(a);
  const pb = parseAppVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  return 0;
}

export function isAppVersionSupported(header: string | string[] | undefined): boolean {
  const min = minAppVersion();
  if (!min) return true;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return false;
  const cmp = compareAppVersions(raw, min);
  return cmp !== null && cmp >= 0;
}

export async function enforceAppVersion(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isAppVersionSupported(req.headers['x-app-version'])) return;
  const min = minAppVersion();
  await reply.code(426).send({
    error: {
      code: 'UPGRADE_REQUIRED',
      message: `Mise à jour requise (version minimale ${min})`,
    },
    minAppVersion: min,
  });
}
