// Constantes gelées D1–D4 (miroir de la table app_config du schéma).
// Modifiables sans toucher la logique.
import { RBAC_VERSION } from './domain/roles';

export const CONFIG = {
  // Compatibilité clients / contrat d'API.
  apiVersion: 'v1',
  rbacVersion: RBAC_VERSION,

  // Conversion : uniquement les points gagnés APRÈS le niveau OR.
  pointToFcfa: 0.15,
  rewards: {
    recordByQuality: { A: 10, B: 5, C: 1, F: 0 } as Record<string, number>,
    validationBonus: 15,
    validate: 0,
    transcribe: 0,
  },
  withdrawMinFcfa: 500,
  // Niveaux dérivés des points cumulés GAGNÉS (pas du solde).
  levels: { bronzeAt: 500, argentAt: 1500, orAt: 4500 },
  withdrawMinLevel: 'or' as const, // conversion FCFA verrouillée sous OR

  // D3 — consensus
  votesMin: 2,
  votesCap: 5,
  netValidate: 2,
  netReject: 2,

  // D1 — tier
  quorumAudio: 2,
  reviewsForGold: 2,
  competenceForGold: 2,
  consistencyHigh: 0.85,
  consistencyOk: 0.6,

  // D2 — curation auto-check
  autocheck: { minSeconds: 1, maxSeconds: 30 },

  // Stockage audio (D6 partiel) — filesystem par défaut.
  audioDir: process.env.AUDIO_DIR ?? 'var/audio',

  // D2/D3 — sessions
  // Mobile : access court (renouvelé via refresh token) + refresh long (30 j)
  // pour rester connecté entre les lancements. adminSessionTtl reste court.
  jwt: { accessTtl: '1h', refreshTtl: '30d', adminSessionTtl: '30m' },

  // Mobile — couverture régionale (GET /regions)
  // Toponymes officiels BF (décret juil. 2025) — 17 régions, chef-lieux.
  regionTargetClips: 1000,
  regions: [
    { name: 'Ouagadougou', zone: 'Kadiogo' },
    { name: 'Koudougou', zone: 'Nando' },
    { name: 'Ouahigouya', zone: 'Yaadga' },
    { name: 'Bobo-Dioulasso', zone: 'Guiriko' },
    { name: 'Dédougou', zone: 'Bankui' },
    { name: 'Tougan', zone: 'Sourou' },
    { name: 'Dori', zone: 'Liptako' },
    { name: 'Djibo', zone: 'Soum' },
    { name: "Fada N'Gourma", zone: 'Goulmou' },
    { name: 'Bogandé', zone: 'Sirba' },
    { name: 'Diapaga', zone: 'Tapoa' },
    { name: 'Gaoua', zone: 'Djôrô' },
    { name: 'Banfora', zone: 'Tannounyan' },
    { name: 'Kaya', zone: 'Kuilsé' },
    { name: 'Tenkodogo', zone: 'Nakambé' },
    { name: 'Manga', zone: 'Nazinon' },
    { name: 'Ziniaré', zone: 'Oubri' },
  ],
} as const;
