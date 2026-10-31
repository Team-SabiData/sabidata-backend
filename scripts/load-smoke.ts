// Smoke test de charge minimal, sans dépendance externe.
//
// Exemples :
//   npm run load-smoke
//   LOAD_TOKEN="$ADMIN_TOKEN" LOAD_PATHS="/api/me,/api/leaderboard?lang=moore&dialect=nord" npm run load-smoke
//   LOAD_TOKEN="$ADMIN_TOKEN" LOAD_PATHS="/admin/quality?limit=50,/admin/dataset/catalog?limit=50" \
//     LOAD_ROUNDS=100 LOAD_CONCURRENCY=20 npm run load-smoke

const BASE_URL = (process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = process.env.LOAD_TOKEN?.trim();
const APP_VERSION = process.env.LOAD_APP_VERSION?.trim();
const ROUNDS = positiveInt(process.env.LOAD_ROUNDS, 30);
const CONCURRENCY = positiveInt(process.env.LOAD_CONCURRENCY, 10);
const TIMEOUT_MS = positiveInt(process.env.LOAD_TIMEOUT_MS, 10_000);

const PATHS = (process.env.LOAD_PATHS ?? '/health,/api/regions,/api/languages,/api/config')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

async function sample(path: string): Promise<{ ms: number; status: number; ok: boolean }> {
  const headers: Record<string, string> = {};
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  if (APP_VERSION) headers['x-app-version'] = APP_VERSION;
  const started = performance.now();
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.arrayBuffer();
    return { ms: performance.now() - started, status: res.status, ok: res.ok };
  } catch {
    return { ms: performance.now() - started, status: 0, ok: false };
  }
}

async function main(): Promise<void> {
  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  const failures: string[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= ROUNDS) return;
      const path = PATHS[index % PATHS.length]!;
      const result = await sample(path);
      latencies.push(result.ms);
      statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
      if (!result.ok && failures.length < 10) failures.push(`${result.status || 'ERR'} ${path}`);
    }
  }

  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ROUNDS) }, () => worker()));
  const elapsed = performance.now() - started;

  const total = latencies.length;
  const failed = [...statuses.entries()].filter(([status]) => status < 200 || status >= 300)
    .reduce((sum, [, n]) => sum + n, 0);

  console.log(JSON.stringify({
    baseUrl: BASE_URL,
    paths: PATHS,
    requests: total,
    concurrency: Math.min(CONCURRENCY, ROUNDS),
    durationMs: Math.round(elapsed),
    rps: Number((total / (elapsed / 1000)).toFixed(1)),
    failed,
    statuses: Object.fromEntries([...statuses.entries()].sort(([a], [b]) => a - b)),
    latencyMs: {
      p50: Number(percentile(latencies, 50).toFixed(1)),
      p95: Number(percentile(latencies, 95).toFixed(1)),
      p99: Number(percentile(latencies, 99).toFixed(1)),
      max: Number(Math.max(0, ...latencies).toFixed(1)),
    },
    sampleFailures: failures,
  }, null, 2));

  if (failed > 0) process.exitCode = 1;
}

await main();

export {};
