# Sortie du staging — prérequis manquants

Le backend tourne avec `STAGING=true` tant que :

1. **Cloudflare R2** — variables `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
2. **Vonage SMS** — `VONAGE_API_KEY`, `VONAGE_API_SECRET`, `VONAGE_FROM` réels (pas `REMPLACE_*`)

Puis :

```bash
railway variables --service sabidata-api --set SMS_ENABLED=true
railway variables --service sabidata-api --delete STAGING   # ou --set STAGING=false
railway redeploy --service sabidata-api --yes --from-source
```

Sans SMS réel, l’OTP reste aléatoire 6 chiffres **loggé** dans les logs Railway (`[SMS-DEV]`), plus le code fixe `0000`.
