/**
 * Service d'envoi de SMS via Vonage (Nexmo).
 *
 * Comportement :
 *   - SMS_ENABLED=true  → envoie un vrai SMS via l'API Vonage
 *   - SMS_ENABLED=false → log dans la console uniquement (mode DEV/test)
 *
 * Variables d'environnement requises (voir .env) :
 *   VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_FROM, SMS_ENABLED
 */

import { randomInt } from 'node:crypto';
import { Vonage } from '@vonage/server-sdk';

const smsEnabled = process.env.SMS_ENABLED === 'true';

// Initialisation paresseuse — Vonage n'est instancié que si les clés sont présentes.
function getVonage(): Vonage | null {
  const key    = process.env.VONAGE_API_KEY;
  const secret = process.env.VONAGE_API_SECRET;
  if (!key || !secret || key === 'REMPLACE_PAR_TA_CLE') return null;
  return new Vonage({ apiKey: key, apiSecret: secret });
}

/**
 * Génère un code OTP numérique à 4 chiffres.
 * randomInt (CSPRNG) — Math.random() est prévisible, inacceptable pour un OTP.
 * En mode DEV (SMS_ENABLED=false), retourne toujours "0000".
 */
export function generateOtp(): string {
  if (!smsEnabled) return '0000';
  return String(randomInt(0, 10000)).padStart(4, '0');
}

/**
 * Envoie le code OTP par SMS.
 * Retourne `true` si l'envoi a réussi, `false` sinon.
 */
export async function sendOtpSms(phone: string, code: string): Promise<boolean> {
  if (!smsEnabled) {
    // Mode DEV : affiche le code dans le terminal pour les tests manuels.
    console.info(`[SMS-DEV] OTP pour ${phone} → ${code}`);
    return true;
  }

  const vonage = getVonage();
  if (!vonage) {
    console.error('[SMS] Clés Vonage manquantes — vérifiez .env (VONAGE_API_KEY, VONAGE_API_SECRET)');
    return false;
  }

  const from = process.env.VONAGE_FROM ?? 'SabiData';
  const text = `Votre code SabiData : ${code}. Valable 5 minutes. Ne le partagez jamais.`;

  try {
    const resp = await vonage.sms.send({ to: phone, from, text });
    const status = resp.messages[0]?.status;
    if (status !== '0') {
      console.error(`[SMS] Échec Vonage pour ${phone} — status: ${status}, err: ${resp.messages[0]?.errorText}`);
      return false;
    }
    console.info(`[SMS] OTP envoyé à ${phone} (message-id: ${resp.messages[0]?.['message-id']})`);
    return true;
  } catch (err) {
    console.error('[SMS] Erreur réseau Vonage :', err);
    return false;
  }
}
