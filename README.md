# sabidata-backend

API SabiData (Fastify / TypeScript / Postgres) — surfaces `/api` (mobile) et `/admin` (console).

## Local

```bash
npm install
cp .env.example .env   # JWT_SECRET, DATABASE=pg
npm run dev            # http://0.0.0.0:3000
npm test
```

Health : `GET /health` → `{ ok: true }`.

## Production (Railway + Neon + R2)

Variables requises :

| Variable | Rôle |
|---|---|
| `NODE_ENV` | `production` |
| `STAGING` | `true` pour le premier go-live sans SMS réel |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `DATABASE_URL` | Neon Postgres |
| `S3_BUCKET` + `S3_ENDPOINT` + clés | Cloudflare R2 |
| `SMS_ENABLED` | `false` si staging ; `true` avant ouverture publique |
| `CORS_ORIGINS` | URL(s) Vercel admin, séparées par des virgules |

Start : `npm start` (utilise `PORT` injecté par Railway).

### Premier admin

Le seed `admin@sabidata.bf` / `admin123` **n’existe pas** en production.

```bash
DATABASE_URL=… ADMIN_EMAIL=ops@you.bf ADMIN_PASSWORD='…' npm run bootstrap-admin
```

Enregistrer le secret TOTP affiché dans une app 2FA.

### Déploiement Railway

1. Lier le repo `sabidata-backend`
2. Configurer les variables ci-dessus
3. Healthcheck : `/health`
4. Bootstrap admin une fois la DB joignable
