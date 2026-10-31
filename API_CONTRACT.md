# Contrat d'API — SabiData

Deux surfaces :

- `/api/**` : application mobile (contributeurs, validateurs).
- `/admin/**` : console d'administration (2FA).

## Compatibilité

| Élément | Valeur |
|---|---|
| Version d'API | `v1` |
| Version RBAC | `2` |
| En-tête mobile | `X-App-Version: <semver>` |
| Endpoint public | `GET /api/config` |

`GET /api/config` est toujours accessible (même depuis une version obsolète) :

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

Si `MIN_APP_VERSION` est défini côté serveur, tout appel `/api/*` (sauf
`/api/config`) sans `X-App-Version` valide, ou avec une version inférieure,
reçoit :

```http
HTTP/1.1 426 Upgrade Required
```

```json
{
  "error": { "code": "UPGRADE_REQUIRED", "message": "Mise à jour requise (version minimale 1.2.0)" },
  "minAppVersion": "1.2.0"
}
```

La comparaison porte sur `major.minor.patch` ; les suffixes `-préversion` et
`+build` sont ignorés. `rbacVersion` est aussi exposé dans `GET /api/me` et
`GET /admin/me` pour permettre aux clients d'invalider leurs caches de
permissions.

## Authentification

- Mobile : `Authorization: Bearer <access>` ; access court renouvelé via
  `POST /api/auth/refresh`, refresh long (30 j).
- Admin : `POST /admin/auth/login` puis `POST /admin/auth/totp` ; access admin
  court (30 min).
- Une révocation (`logout`, changement de mot de passe, suspension) incrémente
  `token_version` : tous les access/refresh précédents sont refusés.

## Enveloppe d'erreur

```json
{ "error": { "code": "CODE_STABLE", "message": "Message lisible" } }
```

Codes notables : `BAD_INPUT` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403),
`NOT_FOUND` (404), `CONFLICT` / `REFERENCE_IN_USE` (409), `UPGRADE_REQUIRED`
(426), `RATE_LIMITED` (429). Les ressources supprimées logiquement sont
invisibles des listes publiques et renvoient `404`.

## Mobile — `/api`

### Auth

| Méthode | Chemin | Notes |
|---|---|---|
| POST | `/api/auth/register` | Crée un contributeur. |
| POST | `/api/auth/login` | Email **ou** téléphone + mot de passe. |
| POST | `/api/auth/otp` | Envoie un OTP de connexion par téléphone. |
| POST | `/api/auth/verify` | Vérifie l'OTP et ouvre une session. |
| POST | `/api/auth/refresh` | Renouvelle l'access token. |
| POST | `/api/auth/logout` | Révoque toutes les sessions du compte. |

### Profil et wallet

| Méthode | Chemin | Notes |
|---|---|---|
| GET | `/api/me` | Profil, permissions, `rbacVersion`, points, niveau. |
| PATCH | `/api/me` | Nom, consentement commercial. |
| POST | `/api/me/profile` | Verrouille langue + dialecte + région. |
| POST | `/api/me/contact` | Demande de changement email/téléphone (OTP). |
| POST | `/api/me/contact/confirm` | Confirme le changement par OTP. |
| GET | `/api/me/wallet` | Solde FCFA, points gagnés/convertibles, niveau. |
| GET | `/api/me/ledger` | Historique du ledger. |

### Contribution et validation

| Méthode | Chemin | Notes |
|---|---|---|
| GET | `/api/prompts/next` | Prompt suivant selon langue/dialecte. |
| POST | `/api/clips` | Upload multipart `audio` (≤ 10 Mo) + métadonnées. |
| GET | `/api/clips/:id/audio` | Flux audio (propriétaire ou ayant droit). |
| GET | `/api/validation/next` | Clip à valider. |
| POST | `/api/clips/:id/validations` | Vote `correct` / `problem`. |
| GET | `/api/transcriptions/next` | Clip validé à transcrire. |
| POST | `/api/transcriptions` | Soumet une transcription. |
| POST | `/api/transcriptions/:id/validations` | Vote sur une transcription. |

### Référentiel public et classement

| Méthode | Chemin | Notes |
|---|---|---|
| GET | `/api/regions` | Couverture régionale. |
| GET | `/api/languages` | Langues actives. |
| GET | `/api/dialects?lang=` | Dialectes actifs d'une langue. |
| GET | `/api/leaderboard?lang=&dialect=` | Classement filtré (paramètres requis). |

### Support

| Méthode | Chemin | Notes |
|---|---|---|
| POST | `/api/support/conversations` | Ouvre (ou réutilise) la conversation ouverte ; idempotent. |
| GET | `/api/support/conversation` | État courant (ou `null`). |
| GET | `/api/support/conversations/:id/messages` | Pagination `after` / `before` / `limit`. |
| POST | `/api/support/conversations/:id/messages` | Envoie un message (1–4000 chars). |
| POST | `/api/support/conversations/:id/read` | Accusé de lecture. |
| POST | `/api/support/conversations/:id/close` | Clôture. |

## Admin — `/admin`

Toutes les routes exigent un access admin et la permission indiquée.

| Méthode | Chemin | Permission |
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
| GET | `/admin/dataset/catalog` | `export.run` |
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
| GET | `/admin/users/:id/wallet`, `/ledger` | `wallet.read` |
| GET | `/admin/users/:id/activity` | `audit.read` |
| GET | `/admin/withdrawals` | `withdrawal.settle` |
| POST | `/admin/withdrawals/:id/decide` | `withdrawal.settle` |
| GET | `/admin/support/conversations` | `support.manage` |
| GET | `/admin/support/conversations/:id` | `support.manage` |
| POST | `/admin/support/conversations/:id/messages` | `support.manage` |
| POST | `/admin/support/conversations/:id/read` | `support.manage` |
| POST | `/admin/support/conversations/:id/close` | `support.manage` |

### Règles d'écriture admin

- `PATCH` et `DELETE` sensibles exigent un `reason` non vide.
- Référentiel : suppression logique uniquement. `409 REFERENCE_IN_USE` si
  l'entité est encore référencée ; `DELETE` est idempotent si déjà inactif.
- Mot de passe : `{ password, reason }`, minimum 6 caractères. Révoque toutes
  les sessions et journalise `user.password_reset`.
- Suppression utilisateur : anonymisation, ledger conservé, sessions révoquées.
- Toute écriture admin produit une entrée d'audit append-only.

## Tests de charge

Voir `npm run load-smoke` et `scripts/load-smoke.ts` (variables `LOAD_BASE_URL`,
`LOAD_TOKEN`, `LOAD_PATHS`, `LOAD_ROUNDS`, `LOAD_CONCURRENCY`).
