# Runbook — mise en production SabiData backend

Repo : https://github.com/Team-SabiData/sabidata-backend

> Le backend exécute automatiquement `ensureSchema()` + les migrations au
> démarrage. Un simple redéploiement applique donc les migrations, dont
> `006_drop_classrooms.sql` qui est **destructive et non réversible**.
> Sauvegarder la base avant chaque déploiement.

## Étape 0 — Préflight local

```bash
cd sabidata-backend
npm ci
npm run typecheck
npm test
npm audit --omit=dev
git status
git diff --stat
```

Attendu : typecheck OK, `155/155` tests, pas de vulnérabilité high/critical
côté production (revérifier avec `npm audit --omit=dev`).

Ne pas continuer si `git status` contient des fichiers inattendus ou des
secrets.

## Étape 1 — Sauvegarder la base de production

### Option recommandée : branche/snapshot Neon

Dans la console Neon : créer une branche `pre-deploy-YYYYMMDD-HHmm` à partir de
la branche de production. Ne pas la supprimer avant la fin de la validation.

Avec `neonctl` :

```bash
neonctl branches create \
  --project-id <PROJECT_ID> \
  --name pre-deploy-$(date +%Y%m%d-%H%M)
```

### Option complémentaire : dump local

```bash
pg_dump "$DATABASE_URL" \
  --no-owner \
  --format=custom \
  --file="/tmp/sabidata-$(date +%Y%m%d-%H%M).dump"
```

Vérifier que le dump existe et a une taille non nulle. Le stocker hors du repo.

## Étape 2 — Tester les migrations sur une copie

Créer une branche Neon de test ou utiliser la branche `pre-deploy`.

```bash
export STAGING_DATABASE_URL='postgresql://…?sslmode=require'

DATABASE_URL="$STAGING_DATABASE_URL" npm run db:migrate
```

Relancer une seconde fois pour vérifier l'idempotence :

```bash
DATABASE_URL="$STAGING_DATABASE_URL" npm run db:migrate
```

Vérifier les migrations :

```bash
psql "$STAGING_DATABASE_URL" \
  -c "SELECT version, applied_at FROM schema_migrations ORDER BY version;"
```

Attendu : `001_auth_profile` → `006_drop_classrooms` présentes.

Vérifier les changements structurants :

```bash
psql "$STAGING_DATABASE_URL" -c '\d users' | grep classroom_id
psql "$STAGING_DATABASE_URL" -c '\d clips' | grep classroom_id
psql "$STAGING_DATABASE_URL" -c '\d transcriptions' | grep -E 'status|rejection_count|deleted_at'
psql "$STAGING_DATABASE_URL" -c '\d dialects' | grep active
```

`classroom_id` doit être absent. Les colonnes qualité/statuts doivent exister.

Si échec : ne pas toucher à la prod. Corriger sur la branche de test, puis
recommencer.

## Étape 3 — Commit et push

```bash
git status
git diff --stat
git add -A
git commit -m "feat: phases 1-7 backend (auth, support, qualité, dataset, référentiel, compatibilité)"
git push origin main
```

Optionnel, pour identifier le déploiement :

```bash
git tag deploy-$(date +%Y%m%d-%H%M)
git push origin --tags
```

Railway déploie depuis GitHub : sans push, le nouveau code ne partira pas.

## Étape 4 — Déployer en staging

Créer un service Railway staging séparé (recommandé) relié à la branche Neon de
test. Ne pas réutiliser la base de production.

Variables staging :

```env
NODE_ENV=production
STAGING=true
JWT_SECRET=<openssl rand -hex 32>
DATABASE_URL=<branche Neon staging>
S3_BUCKET=<bucket R2 staging>
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<clé>
S3_SECRET_ACCESS_KEY=<secret>
S3_REGION=auto
S3_PREFIX=clips/
SMS_ENABLED=false
CORS_ORIGINS=https://<admin-staging>.vercel.app
MIN_APP_VERSION=
```

`STAGING=true` autorise le SMS désactivé pour le premier go-live contrôlé.
`NODE_ENV=production` active le fail-fast de sécurité.

Avec Railway CLI :

```bash
railway login
railway link
railway status
railway variables --service <service-staging> --set 'NODE_ENV=production'
railway variables --service <service-staging> --set 'STAGING=true'
# répéter pour chaque variable, ou utiliser le dashboard Railway
railway up --service <service-staging>
```

Suivre les logs :

```bash
railway logs --service <service-staging>
```

Attendu : pas d'erreur de migration, message `media: ffmpeg`, pas de warn
`media: stub`.

## Étape 5 — Bootstrap admin staging

```bash
DATABASE_URL='<branche Neon staging>' \
ADMIN_EMAIL='ops-staging@sabidata.bf' \
ADMIN_PASSWORD='<mot de passe ≥ 8 caractères>' \
ADMIN_NAME='Ops Staging' \
npm run bootstrap-admin
```

Conserver le secret TOTP affiché. Ne jamais le committer ni le transmettre par
un canal non sécurisé.

## Étape 6 — Smoke tests staging

### Santé et compatibilité

```bash
curl -sS https://<staging>/health
curl -sS https://<staging>/api/config
```

Attendu : `{ "ok": true, ... }` et `apiVersion: "v1"`, `rbacVersion: 2`.

### Mobile

```bash
BASE=https://<staging>
curl -sS -X POST "$BASE/api/auth/register" \
  -H 'content-type: application/json' \
  -H 'x-app-version: 1.0.0' \
  -d '{"name":"Test Staging","email":"test-staging@example.com","password":"secret123"}'
```

Tester ensuite : login, `/api/me`, `/api/me/profile`, upload d'un clip,
validation/transcription, support.

Avec `SMS_ENABLED=false`, l'OTP est loggé (`[SMS-DEV]`) et le code fixe `0000`
est accepté en mode dev/staging. Vérifier dans `railway logs`.

### Admin

```bash
BASE=https://<staging>
CHALLENGE=$(curl -sS -X POST "$BASE/admin/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"ops-staging@sabidata.bf","password":"<mot de passe>"}' | jq -r .challenge)

curl -sS -X POST "$BASE/admin/auth/totp" \
  -H 'content-type: application/json' \
  -d "{\"challenge\":\"$CHALLENGE\",\"code\":\"<code TOTP>\"}"
```

Tester : `/admin/me`, liste utilisateurs, qualité, dataset, référentiel,
support, CORS depuis l'UI admin staging.

### Charge légère

```bash
LOAD_BASE_URL=https://<staging> \
LOAD_TOKEN='<access admin>' \
LOAD_PATHS='/admin/quality?limit=50,/admin/dataset/catalog?groupBy=language' \
LOAD_ROUNDS=100 \
LOAD_CONCURRENCY=10 \
npm run load-smoke
```

Attendu : `failed: 0`, latences correctes, pas de `5xx`.

## Étape 7 — Préparer la production

Avant de déployer :

- [ ] Staging validé pendant au moins une session complète.
- [ ] Sauvegarde production refaite juste avant le déploiement.
- [ ] Build mobile avec `X-App-Version` disponible / plan de diffusion connu.
- [ ] Décision sur `MIN_APP_VERSION` prise.
- [ ] UI admin compatible avec les nouveaux endpoints.
- [ ] Fenêtre de déploiement annoncée.

Variables production :

```env
NODE_ENV=production
# STAGING absent ou false
JWT_SECRET=<secret production existant ou rotation volontaire>
DATABASE_URL=<Neon production>
S3_BUCKET=<bucket R2 production>
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<clé>
S3_SECRET_ACCESS_KEY=<secret>
S3_REGION=auto
S3_PREFIX=clips/
SMS_ENABLED=true
VONAGE_API_KEY=<clé réelle>
VONAGE_API_SECRET=<secret réel>
VONAGE_FROM=SabiData
CORS_ORIGINS=https://<admin-production>.vercel.app
MIN_APP_VERSION=
```

`MIN_APP_VERSION` :

- Vide : toutes les apps continuent de fonctionner, y compris celles sans
  en-tête.
- `1.0.0` : les apps sans `X-App-Version` ou plus anciennes reçoivent `426`.
  À définir seulement après diffusion du build compatible.

## Étape 8 — Déployer en production

1. Pousser le commit validé sur `main`.
2. Laisser Railway déployer, ou forcer :

```bash
railway up --service <service-production>
```

3. Surveiller immédiatement :

```bash
railway logs --service <service-production>
```

4. Vérifier le healthcheck Railway (`/health`) et attendre le statut vert.

Si le démarrage échoue à cause des migrations : **ne pas relancer en boucle**.
Lire l'erreur, restaurer la branche Neon de sauvegarde si nécessaire, puis
corriger.

## Étape 9 — Vérifications post-déploiement

```bash
BASE=https://sabidata-api-production.up.railway.app
curl -sS "$BASE/health"
curl -sS "$BASE/api/config"
```

Puis tester manuellement :

- [ ] Inscription + login mobile.
- [ ] OTP téléphone avec un vrai SMS.
- [ ] Upload audio et écoute.
- [ ] Validation et transcription.
- [ ] Support mobile + réponse admin.
- [ ] Login admin + TOTP.
- [ ] `/admin/me` et permissions.
- [ ] Qualité, référentiel, dataset ZIP/JSONL.
- [ ] `MIN_APP_VERSION` et réponse `426` si activé.
- [ ] CORS depuis le domaine admin.
- [ ] Logs sans `[SMS-DEV]`, sans `media: stub`, sans erreur S3/DB.
- [ ] `schema_migrations` contient `006_drop_classrooms`.

Surveiller pendant 30–60 minutes : taux de `5xx`, `429`, erreurs DB, erreurs R2,
connexions Postgres.

## Étape 10 — Rollback

### Rollback applicatif seul

Railway → Deployments → redéployer le déploiement précédent.

### Rollback après migration 006

`006_drop_classrooms.sql` supprime des colonnes et une table. Un ancien backend
qui insère encore `classroom_id` ne peut pas fonctionner sur la base migrée.

Procédure :

1. Mettre le trafic en pause / maintenance.
2. Restaurer la branche Neon de sauvegarde ou le dump `pg_dump`.
3. Redéployer l’ancienne version applicative.
4. Vérifier `/health`, login mobile et admin.
5. Communiquer sur la perte éventuelle des écritures postérieures à la sauvegarde.

Ne jamais supprimer la branche de sauvegarde avant la fin de la période de
stabilité (48 h recommandé).

## Étape 11 — Après la mise en prod

- Déployer l’UI admin alignée sur les nouveaux endpoints.
- Diffuser le build mobile contenant `X-App-Version`.
- Activer `MIN_APP_VERSION` seulement quand la diffusion est confirmée.
- Programmer une revue `npm audit --omit=dev`.
- Vérifier les secrets (JWT, R2, Vonage, Neon) et limiter les accès.
