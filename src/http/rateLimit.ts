// Rate-limit mémoire simple (suffisant mon-instance Railway staging).
// Clé = ip|phone|email selon l'appelant.

export interface RateLimitOpts {
  windowMs: number;
  max: number;
}

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function resetRateLimits(): void {
  buckets.clear();
}

export function checkRateLimit(key: string, opts: RateLimitOpts): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + opts.windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > opts.max) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfterSec: 0 };
}
