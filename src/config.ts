// Constantes gelées D1–D4 (miroir de la table app_config du schéma).
// Modifiables sans toucher la logique.
export const CONFIG = {
  pointToFcfa: 5, // D4 : 1 pt = 5 FCFA
  rewards: { record: 50, validate: 20, transcribe: 80, convert: 120, dailyTaskBonus: 250 },
  rarityMult: { 0: 1, 1: 2, 2: 3 } as Record<number, number>, // ×pts enregistrement
  withdrawMinFcfa: 500,
  // Niveaux gamifiés — dérivés du nombre de contributions validées.
  levels: { argentAt: 50, orAt: 200 },
  withdrawMinLevel: 'argent' as const, // retrait verrouillé sous ce niveau

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
  regionTargetClips: 1000,
  regions: [
    { name: 'Ouagadougou', zone: 'Centre' },
    { name: 'Koudougou', zone: 'Plateau Central' },
    { name: 'Ouahigouya', zone: 'Nord' },
    { name: 'Yatenga', zone: 'Nord' },
    { name: 'Bobo-Dioulasso', zone: 'Hauts-Bassins' },
    { name: 'Dédougou', zone: 'Boucle du Mouhoun' },
    { name: 'Dori', zone: 'Sahel' },
    { name: "Fada N'Gourma", zone: 'Est' },
  ],
} as const;
