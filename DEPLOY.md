# Déploiement Railway

Repos déjà sur GitHub : https://github.com/Team-SabiData/sabidata-backend

## Via Dashboard (recommandé)

1. https://railway.app/new → **Deploy from GitHub repo** → `Team-SabiData/sabidata-backend`
2. Ajouter une base **Neon** (externe) ou plugin Postgres Railway → copier `DATABASE_URL`
3. Variables :

```
NODE_ENV=production
STAGING=true
JWT_SECRET=<openssl rand -hex 32>
DATABASE_URL=<neon>
S3_BUCKET=<r2>
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_REGION=auto
S3_PREFIX=clips/
SMS_ENABLED=false
CORS_ORIGINS=https://<admin>.vercel.app
```

4. Start command : `npm start` (déjà dans `railway.toml`)
5. Healthcheck : `/health`
6. Noter l’URL publique `https://….up.railway.app`
7. Bootstrap admin :

```bash
DATABASE_URL='…' ADMIN_EMAIL='ops@…' ADMIN_PASSWORD='…' npm run bootstrap-admin
```

## Via CLI

```bash
railway login
cd sabidata-backend
railway link
railway variables set NODE_ENV=production STAGING=true …
railway up
```
