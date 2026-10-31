# SabiData — handoff intégration mobile & web

Document à transmettre aux équipes mobile et web.

## 1. URLs

| Cible | URL |
|---|---|
| Backend production | `https://sabidata-api-production.up.railway.app` |
| Backend local | `http://localhost:3000` |
| Healthcheck | `GET /health` |
| Config publique | `GET /api/config` |
| Surface mobile | `/api/**` |
| Surface web admin | `/admin/**` |

Pas de slash final dans les URLs de base.

### Mobile Flutter

```bash
flutter run \
  --dart-define=API_BASE_URL=https://sabidata-api-production.up.railway.app \
  --dart-define=APP_VERSION=1.0.0
```

Le client doit envoyer `X-App-Version` sur **tous** les appels `/api/*`.
Le client actuel le fait déjà.

### Web admin

`VITE_API_BASE_URL` vide en production Vercel : `vercel.json` proxifie déjà
`/admin/*` et `/api/*` vers Railway (same-origin, pas de CORS).

```env
VITE_API_BASE_URL=
```

En local sans proxy :

```env
VITE_API_BASE_URL=http://localhost:3000
```

En cross-origin, configurer côté backend :

```env
CORS_ORIGINS=https://mon-admin.vercel.app,https://autre-origine.example
```

`CORS_ORIGINS=*` uniquement en dev/staging. Les requêtes utilisent
`Authorization`, pas de cookie : le token doit être stocké côté client
(`sessionStorage` pour l'admin, stockage sécurisé pour le mobile).

## 2. En-têtes

```http
Content-Type: application/json
Authorization: Bearer <access_token>
X-App-Version: 1.0.0
```

- `Authorization` : obligatoire hors routes publiques.
- `X-App-Version` : mobile uniquement ; ne pas l'ajouter aux routes `/admin`.
- Upload audio : **ne pas** fixer `Content-Type` manuellement ; le client
  multipart doit générer le boundary.

## 3. Format d'erreur

```json
{
  "error": {
    "code": "CODE_STABLE",
    "message": "Message lisible"
  }
}
```

Codes principaux : `BAD_INPUT`, `VALIDATION_ERROR`, `INVALID_CREDENTIALS`,
`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `PROFILE_LOCKED`,
`REFERENCE_IN_USE`, `ACCOUNT_DISABLED`, `RATE_LIMITED`, `UPGRADE_REQUIRED`.

## 4. Authentification mobile

### 4.1 Inscription email/mot de passe

```http
POST /api/auth/register
Content-Type: application/json

{
  "name": "Awa Ouédraogo",
  "email": "awa@example.com",
  "phone": "70000000",
  "password": "motdepasse"
}
```

- `name` ≥ 2 caractères.
- `password` ≥ 6 caractères.
- `email` et `phone` optionnels, mais au moins l'un des deux.
- `201` → `{ access, refresh, user }`.
- `409 EMAIL_TAKEN` si l'email existe déjà.

### 4.2 Connexion email

```http
POST /api/auth/login
Content-Type: application/json

{ "email": "awa@example.com", "password": "motdepasse" }
```

`200` → `{ access, refresh, user }`.

### 4.3 Connexion téléphone par OTP

```http
POST /api/auth/otp
Content-Type: application/json

{ "phone": "70000000" }
```

`202` sans corps (anti-énumération). Puis :

```http
POST /api/auth/verify
Content-Type: application/json

{ "phone": "70000000", "code": "123456" }
```

`200` → `{ access, refresh, user }`. Le compte est créé automatiquement si le
téléphone est inconnu. `POST /api/auth/login` avec seulement `{ "phone": "..." }`
déclenche le même envoi d'OTP.

### 4.4 Refresh et logout

```http
POST /api/auth/refresh
Content-Type: application/json

{ "refresh": "<refresh_token>" }
```

`200` → `{ access, refresh }` (rotation des deux jetons).

```http
POST /api/auth/logout
Authorization: Bearer <access_token>
```

`200` → `{ ok: true }`. Révoque **toutes** les sessions du compte. Sur `401`
mobile : tenter un refresh une seule fois puis rejouer la requête ; si le
refresh échoue, vider la session locale.

Durées : access 1 h, refresh 30 j.

## 5. Authentification web admin

### 5.1 Login + 2FA

```http
POST /admin/auth/login
Content-Type: application/json

{ "email": "ops@sabidata.bf", "password": "..." }
```

`200` → `{ challenge }` (valide 5 min).

```http
POST /admin/auth/totp
Content-Type: application/json

{ "challenge": "...", "code": "123456" }
```

`200` → `{ access }` (valide 30 min). Pas de refresh admin : sur `401`, vider
le token et rediriger vers le login. Seuls les rôles `admin` et `moderator`
peuvent se connecter.

### 5.2 Contexte admin

```http
GET /admin/me
Authorization: Bearer <admin_access>
```

Renvoie `{ id, name, role, competence, permissions, rbacVersion }`.
Utiliser `permissions` pour masquer les écrans/actions non autorisés.

## 6. Endpoints mobile `/api`

Toutes les routes ci-dessous exigent un Bearer mobile, sauf `/api/config`,
`/api/regions`, `/api/languages`, `/api/dialects`.

| Méthode | Endpoint | Usage |
|---|---|---|
| GET | `/api/config` | Compatibilité, version minimale, features |
| POST | `/api/auth/register` | Inscription |
| POST | `/api/auth/login` | Login email ou demande OTP téléphone |
| POST | `/api/auth/otp` | Envoi OTP |
| POST | `/api/auth/verify` | Vérification OTP / création compte |
| POST | `/api/auth/refresh` | Renouvellement des jetons |
| POST | `/api/auth/logout` | Révocation de toutes les sessions |
| GET | `/api/me` | Profil, permissions, points, niveau, wallet résumé |
| PATCH | `/api/me` | Modifier le nom |
| POST | `/api/me/profile` | Onboarding : langue + dialecte + région |
| POST | `/api/me/contact` | Demander un changement email/téléphone |
| POST | `/api/me/contact/confirm` | Confirmer avec l'OTP |
| GET | `/api/me/wallet` | Solde et points |
| GET | `/api/me/ledger` | Historique des mouvements |
| GET | `/api/prompts/next` | Prompt suivant |
| POST | `/api/clips` | Upload audio multipart |
| GET | `/api/clips/:id/audio` | Écoute d'un clip |
| GET | `/api/validation/next` | Clip à valider |
| POST | `/api/clips/:id/validations` | Vote sur un clip |
| GET | `/api/transcriptions/next` | Clip à transcrire |
| POST | `/api/transcriptions` | Soumettre une transcription |
| POST | `/api/transcriptions/:id/validations` | Vote sur une transcription |
| GET | `/api/regions` | Couverture régionale (public) |
| GET | `/api/languages` | Langues actives (public) |
| GET | `/api/dialects?lang=moore` | Dialectes actifs (public) |
| GET | `/api/leaderboard?lang=moore&dialect=nord` | Classement (2 paramètres requis) |
| POST | `/api/support/conversations` | Ouvrir/récupérer la conversation support |
| GET | `/api/support/conversation` | Conversation ouverte courante |
| GET | `/api/support/conversations/:id/messages` | Messages (`after`, `before`, `limit`) |
| POST | `/api/support/conversations/:id/messages` | Envoyer un message |
| POST | `/api/support/conversations/:id/read` | Marquer comme lu |
| POST | `/api/support/conversations/:id/close` | Clôturer |

### Payloads mobile importants

Profil (verrouillé après le premier envoi complet) :

```json
{ "language": "moore", "dialect": "nord", "region": "Ouagadougou", "commercialConsent": true }
```

Upload clip — `multipart/form-data`, fichier dans le champ `audio` :

```text
audio=<fichier audio>          obligatoire, ≤ 10 Mo
promptId=<stableId>            optionnel
durationS=<secondes>           entier ≥ 0
commercialUse=true|false       string
consentVersion=<version>       string
clientUuid=<uuid>              optionnel, idempotence offline
language=<code>                optionnel
dialect=<code>                 optionnel
region=<nom>                   optionnel
```

La rareté est calculée côté serveur. Réponse `201` avec le clip créé.

Vote clip :

```json
{ "verdict": "correct" }
```

`verdict` ∈ `correct`, `problem`, `unsure`.

Transcription :

```json
{
  "clipId": "uuid",
  "text": "transcription",
  "writingSystem": "std",
  "consistency": 0.8
}
```

`writingSystem` ∈ `std`, `phon` ; `consistency` entre 0 et 1.

Vote transcription :

```json
{ "verdict": "correct", "writingSystem": "std", "consistency": 0.8 }
```

Support :

```json
{ "clipId": "uuid-optionnel", "subject": "Sujet optionnel" }
```

```json
{ "body": "Message 1 à 4000 caractères" }
```

## 7. Endpoints web admin `/admin`

Toutes les routes exigent un Bearer admin et la permission indiquée.

| Méthode | Endpoint | Permission |
|---|---|---|
| GET | `/admin/me` | authentifié |
| GET | `/admin/disputes` | `dispute.arbitrate` |
| POST | `/admin/clips/:id/arbitrate` | `dispute.arbitrate` |
| GET | `/admin/clips/:id/audio` | `content.read_any` |
| GET | `/admin/quality` | `content.moderate` |
| GET | `/admin/quality-queue` | `content.moderate` |
| GET/POST | `/admin/languages` | `reference.manage` |
| PATCH/DELETE | `/admin/languages/:code` | `reference.manage` |
| GET/POST | `/admin/dialects` | `reference.manage` |
| PATCH/DELETE | `/admin/dialects/:id` | `reference.manage` |
| GET/POST | `/admin/prompts` | `reference.manage` |
| PATCH/DELETE | `/admin/prompts/:stableId` | `reference.manage` |
| GET | `/admin/dataset/catalog?groupBy=...` | `export.run` |
| GET | `/admin/dataset/catalog/download?format=zip\|jsonl` | `export.run` |
| GET/POST | `/admin/dataset/releases` | `export.run` |
| GET | `/admin/dataset/releases/:id` | `export.run` |
| GET | `/admin/dataset/releases/:id/manifest` | `export.run` |
| GET | `/admin/audit-log` | `audit.read` |
| GET | `/admin/users` | `content.read_any` |
| POST | `/admin/users` | `user.manage` |
| PATCH/DELETE | `/admin/users/:id` | `user.manage` |
| POST | `/admin/users/:id/password` | `user.manage` |
| POST | `/admin/users/:id/adjustments` | `wallet.adjust` |
| GET | `/admin/users/:id/wallet` | `wallet.read` |
| GET | `/admin/users/:id/ledger` | `wallet.read` |
| GET | `/admin/users/:id/activity` | `audit.read` |
| GET | `/admin/withdrawals` | `withdrawal.settle` |
| POST | `/admin/withdrawals/:id/decide` | `withdrawal.settle` |
| GET | `/admin/support/conversations` | `support.manage` |
| GET | `/admin/support/conversations/:id` | `support.manage` |
| POST | `/admin/support/conversations/:id/messages` | `support.manage` |
| POST | `/admin/support/conversations/:id/read` | `support.manage` |
| POST | `/admin/support/conversations/:id/close` | `support.manage` |

### Payloads admin importants

Arbitrage :

```json
{ "result": "validated", "reason": "..." }
```

`result` ∈ `validated`, `rejected`.

Création utilisateur :

```json
{
  "name": "Awa",
  "email": "awa@example.com",
  "phone": "70000000",
  "role": "contributor",
  "password": "motdepasse"
}
```

Modification utilisateur — soit statut, soit rôle :

```json
{ "status": "suspended", "reason": "..." }
```

```json
{ "role": "validator", "competence": 2, "reason": "..." }
```

Réinitialisation de mot de passe :

```json
{ "password": "nouveau123", "reason": "demande utilisateur" }
```

Suppression : `DELETE /admin/users/:id` avec `{ "reason": "..." }`.
Anonymise le compte, conserve le ledger, révoque les sessions.

Qualité :

```http
GET /admin/quality?type=all&status=pending&language=moore&page=1&limit=50
```

`type` ∈ `clips`, `transcriptions`, `all` ; `limit` max 200.

Référentiel :

```json
{ "nameFr": "Mooré", "isoBcp47": "mos", "active": true }
```

```json
{ "nameFr": "Nord", "zone": "...", "targetHours": 100, "active": true }
```

```json
{ "text": "Nouveau prompt", "active": true }
```

`DELETE` sur le référentiel = désactivation logique. Réponse `409
REFERENCE_IN_USE` si l'entité est encore utilisée. `DELETE` est idempotent sur
une entité déjà inactive.

Dataset :

```http
GET /admin/dataset/catalog?groupBy=language&language=moore
GET /admin/dataset/catalog/download?format=zip&tier=gold
```

`groupBy` obligatoire ∈ `language`, `dialect`, `quality`, `tier`.

## 8. Compatibilité

```http
GET /api/config
```

```json
{
  "apiVersion": "v1",
  "rbacVersion": 2,
  "minAppVersion": "1.2.0",
  "features": {
    "supportChat": true,
    "qualityAdmin": true,
    "datasetCatalog": true
  }
}
```

Si `MIN_APP_VERSION` est configuré côté backend, un appel `/api/*` sans
`X-App-Version` valide reçoit `426` :

```json
{
  "error": { "code": "UPGRADE_REQUIRED", "message": "Mise à jour requise (version minimale 1.2.0)" },
  "minAppVersion": "1.2.0"
}
```

Le mobile doit alors bloquer l'usage et proposer une mise à jour. `/admin/*`
n'est pas concerné. `rbacVersion` est aussi présent dans `/api/me` et
`/admin/me` pour invalider un cache de permissions.

## 9. Rôles et permissions

| Rôle | Permissions |
|---|---|
| `contributor` | `contribute`, `transcribe` |
| `validator` | `validate` |
| `moderator` | `validate`, `content.read_any`, `content.moderate`, `dispute.arbitrate`, `support.manage` |
| `admin` | toutes |

`competence` (0–3) est un niveau de routage de contenu, pas un droit.

## 10. Checklist d'intégration

- [ ] Renseigner l'URL backend prod/local.
- [ ] Mobile : envoyer `X-App-Version` sur `/api/*`.
- [ ] Mobile : gérer `401` par refresh unique, puis purge session.
- [ ] Mobile : gérer `426` par écran de mise à jour obligatoire.
- [ ] Web : token admin en `sessionStorage`, purge sur tout `401`.
- [ ] Web : masquer les actions selon `permissions` de `/admin/me`.
- [ ] Web cross-origin : configurer `CORS_ORIGINS` avec l'origine exacte.
- [ ] Upload audio : multipart `audio`, pas de `Content-Type` manuel, ≤ 10 Mo.
- [ ] Ne jamais mettre le token dans l'URL ou les logs.
- [ ] Créer le premier admin avec `npm run bootstrap-admin` + TOTP.

Référence exhaustive : [`API_CONTRACT.md`](./API_CONTRACT.md).
