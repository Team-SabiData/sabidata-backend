/** Seed langues / dialectes / prompts (codes stables pour mobile + dataset). */
export const SEED_LANGUAGES = [
  { code: 'moore', nameFr: 'Mooré', isoBcp47: 'mos', status: 'active' },
  { code: 'dioula', nameFr: 'Dioula', isoBcp47: 'dyu', status: 'active' },
  { code: 'fulfulde', nameFr: 'Fulfuldé', isoBcp47: 'fuv', status: 'active' },
] as const;

export const SEED_DIALECTS: Array<{
  languageCode: string;
  code: string;
  nameFr: string;
  zone: string;
  targetHours: number;
}> = [
  { languageCode: 'moore', code: 'nord', nameFr: 'Nord', zone: 'Nord', targetHours: 50 },
  { languageCode: 'moore', code: 'centre', nameFr: 'Centre', zone: 'Centre', targetHours: 80 },
  { languageCode: 'moore', code: 'plateau-central', nameFr: 'Plateau-Central', zone: 'Plateau Central', targetHours: 40 },
  { languageCode: 'moore', code: 'centre-nord', nameFr: 'Centre-Nord', zone: 'Centre-Nord', targetHours: 30 },
  { languageCode: 'moore', code: 'centre-ouest', nameFr: 'Centre-Ouest', zone: 'Centre-Ouest', targetHours: 30 },
  { languageCode: 'moore', code: 'centre-sud', nameFr: 'Centre-Sud', zone: 'Centre-Sud', targetHours: 30 },
  { languageCode: 'moore', code: 'boucle-du-mouhoun', nameFr: 'Boucle-du-Mouhoun', zone: 'Boucle du Mouhoun', targetHours: 30 },
  { languageCode: 'dioula', code: 'ouest', nameFr: 'Ouest', zone: 'Hauts-Bassins', targetHours: 50 },
  { languageCode: 'dioula', code: 'hauts-bassins', nameFr: 'Hauts-Bassins', zone: 'Hauts-Bassins', targetHours: 50 },
  { languageCode: 'dioula', code: 'cascade', nameFr: 'Cascade', zone: 'Cascades', targetHours: 30 },
  { languageCode: 'dioula', code: 'centre', nameFr: 'Centre', zone: 'Centre', targetHours: 20 },
  { languageCode: 'fulfulde', code: 'sahel', nameFr: 'Sahel', zone: 'Sahel', targetHours: 40 },
  { languageCode: 'fulfulde', code: 'est', nameFr: 'Est', zone: 'Est', targetHours: 30 },
  { languageCode: 'fulfulde', code: 'nord', nameFr: 'Nord', zone: 'Nord', targetHours: 20 },
];

export const SEED_PROMPTS: Array<{
  id: string;
  languageCode: string;
  dialectCode: string;
  text: string;
}> = [
  { id: 'p01', languageCode: 'moore', dialectCode: 'nord', text: 'Le marché se tient chaque dimanche matin.' },
  { id: 'p02', languageCode: 'moore', dialectCode: 'centre', text: 'La pluie est arrivée tôt cette année.' },
  { id: 'p03', languageCode: 'dioula', dialectCode: 'ouest', text: 'Mon père cultive le mil et le sorgho.' },
  { id: 'p04', languageCode: 'moore', dialectCode: 'plateau-central', text: 'Les enfants jouent près du baobab.' },
  { id: 'p05', languageCode: 'fulfulde', dialectCode: 'sahel', text: "L'eau du puits est fraîche en saison sèche." },
  { id: 'p06', languageCode: 'dioula', dialectCode: 'hauts-bassins', text: 'La vieille femme tisse le faso dan fani.' },
  { id: 'p07', languageCode: 'moore', dialectCode: 'nord', text: 'Le chef du village convoque une réunion ce soir.' },
  { id: 'p08', languageCode: 'moore', dialectCode: 'centre', text: "Nous partons à Ouaga demain à l'aube." },
  { id: 'p09', languageCode: 'dioula', dialectCode: 'ouest', text: 'La radio diffuse les nouvelles en trois langues.' },
  { id: 'p10', languageCode: 'fulfulde', dialectCode: 'est', text: 'Le bœuf et l\'âne travaillent dans les champs.' },
  { id: 'p11', languageCode: 'moore', dialectCode: 'centre-nord', text: 'Ma grand-mère connaît beaucoup de proverbes.' },
  { id: 'p12', languageCode: 'dioula', dialectCode: 'cascade', text: 'Le téléphone portable est utile pour appeler la famille.' },
  { id: 'p13', languageCode: 'moore', dialectCode: 'centre-ouest', text: 'Les mangues sont mûres en saison chaude.' },
  { id: 'p14', languageCode: 'fulfulde', dialectCode: 'nord', text: 'Le forgeron fabrique des outils pour les paysans.' },
  { id: 'p15', languageCode: 'moore', dialectCode: 'centre-sud', text: "La mosquée et l'église sont au centre du village." },
  { id: 'p16', languageCode: 'dioula', dialectCode: 'hauts-bassins', text: 'Sɔgɔma nin na, sigiɖa bɛ se ka kɛ jɔ.' },
  { id: 'p17', languageCode: 'moore', dialectCode: 'plateau-central', text: 'Ned yaa yãgd tõog ne pʋg-pɛlg.' },
  { id: 'p18', languageCode: 'fulfulde', dialectCode: 'sahel', text: 'Himo Alla, ko nde wii nannditii.' },
  { id: 'p19', languageCode: 'moore', dialectCode: 'boucle-du-mouhoun', text: 'Les femmes récoltent le karité à l\'aube.' },
  { id: 'p20', languageCode: 'dioula', dialectCode: 'centre', text: "Le griot raconte l'histoire du royaume." },
];
