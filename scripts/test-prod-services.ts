// =============================================================================
// Test des services de prod (Neon Postgres + Cloudflare R2) déclarés dans .env.
//
//   npx tsx --env-file=.env scripts/test-prod-services.ts
//
// Phase 1 — connexion directe : SELECT sur Neon, Put/Get/Delete d'un objet
//           sonde sur R2. Échoue vite avec un message clair si une clé est
//           mauvaise.
// Phase 2 — flux API complet sur le vrai câblage (PgRepo + S3AudioStore) :
//           register → POST /api/clips (multipart) → relecture de l'audio
//           depuis R2, comparaison octet à octet.
//
// Le compte et le clip créés en phase 2 restent en base : c'est voulu, vous
// pouvez les voir dans la console Neon (table users/clips) et le dashboard R2.
// =============================================================================
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createPgDb } from '../src/db/pg';
import { ensureSchema } from '../src/db/sql';
import { PgRepo } from '../src/ports/pgRepo';
import { S3AudioStore } from '../src/storage/s3AudioStore';
import { buildServer } from '../src/server';

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ Variable ${name} absente du .env — décommente/remplis la section correspondante.`);
    process.exit(1);
  }
  return v;
}

const DATABASE_URL = need('DATABASE_URL');
const S3_BUCKET = need('S3_BUCKET');
const S3_ENDPOINT = need('S3_ENDPOINT');
need('S3_ACCESS_KEY_ID');
need('S3_SECRET_ACCESS_KEY');

const ok = (msg: string) => console.log(`✓ ${msg}`);

async function main() {
  // ── Phase 1a : Neon ────────────────────────────────────────────────────────
  const db = createPgDb(DATABASE_URL);
  const v = await db.query<{ version: string }>('SELECT version()');
  ok(`Neon répond : ${v.rows[0]?.version.split(' on ')[0]}`);

  await ensureSchema(db);
  const t = await db.query<{ count: string }>(
    "SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'public'",
  );
  ok(`Schéma en place (${t.rows[0]?.count} tables)`);

  // ── Phase 1b : R2 ──────────────────────────────────────────────────────────
  const s3 = new S3Client({
    region: process.env.S3_REGION ?? 'auto',
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  });
  const probeKey = '_probe/sabidata-check.txt';
  const probeBody = `sabidata probe ${new Date().toISOString()}`;
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: probeKey, Body: probeBody }));
  const got = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: probeKey }));
  const gotBody = await got.Body!.transformToString();
  if (gotBody !== probeBody) throw new Error('R2 : contenu relu différent du contenu écrit');
  await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: probeKey }));
  ok(`R2 répond : put/get/delete OK sur ${S3_BUCKET}`);

  // ── Phase 2 : flux API réel (même câblage que le boot serveur) ────────────
  const repo = new PgRepo(db);
  const store = new S3AudioStore(s3, { bucket: S3_BUCKET, prefix: process.env.S3_PREFIX });
  const app = buildServer(repo, store);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // Inscription d'un compte de test identifiable.
    const stamp = Date.now();
    const regRes = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `Test E2E ${stamp}`,
        email: `test-e2e-${stamp}@sabidata.dev`,
        password: 'motdepasse-test-1',
      }),
    });
    if (regRes.status !== 201) throw new Error(`register → ${regRes.status} : ${await regRes.text()}`);
    const { access } = (await regRes.json()) as { access: string };
    ok(`Compte créé dans Neon (test-e2e-${stamp}@sabidata.dev)`);

    // Soumission d'un clip multipart — l'audio part dans R2.
    const audio = Buffer.from(`FAKE-M4A-${stamp}-`.repeat(64)); // contenu arbitraire, identifiable
    const form = new FormData();
    form.append('audio', new Blob([audio], { type: 'audio/mp4' }), 'clip.m4a');
    form.append('promptId', 'p01');
    form.append('rarity', '0');
    form.append('durationS', '5');
    form.append('commercialUse', 'true');
    form.append('consentVersion', 'v1');
    const clipRes = await fetch(`${base}/api/clips`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}` },
      body: form,
    });
    if (clipRes.status !== 201) throw new Error(`POST /clips → ${clipRes.status} : ${await clipRes.text()}`);
    const clip = (await clipRes.json()) as { clipId: string; status: string; reward: number };
    ok(`Clip ${clip.clipId} soumis (status: ${clip.status}, reward: ${clip.reward} pts) — audio poussé dans R2`);

    // Relecture : l'API restitue l'audio depuis R2, octets identiques.
    const audioRes = await fetch(`${base}/api/clips/${clip.clipId}/audio`, {
      headers: { authorization: `Bearer ${access}` },
    });
    if (audioRes.status !== 200) throw new Error(`GET audio → ${audioRes.status}`);
    const roundTrip = Buffer.from(await audioRes.arrayBuffer());
    if (!roundTrip.equals(audio)) throw new Error('audio relu ≠ audio envoyé');
    ok(`Audio relu depuis R2 : ${roundTrip.length} octets, identiques à l'envoi (content-type: ${audioRes.headers.get('content-type')})`);

    // Preuve de persistance côté Neon.
    const rows = await db.query<{ audio_path: string }>(
      'SELECT audio_path FROM clips WHERE id = $1', [clip.clipId],
    );
    ok(`Ligne clips en base Neon (audio_path: ${rows.rows[0]?.audio_path}) — clé R2 : ${process.env.S3_PREFIX ?? ''}${rows.rows[0]?.audio_path}`);

    console.log('\nTout est vert : Neon et R2 sont opérationnels de bout en bout.');
    console.log('Vérifiable à l\'œil : console.neon.tech (tables users/clips) et dashboard R2 (objet ci-dessus).');
  } finally {
    await app.close();
    await db.end();
  }
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
