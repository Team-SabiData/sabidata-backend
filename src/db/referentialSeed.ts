/** Seed langues / dialectes / prompts (codes stables pour mobile + dataset).
 *  Zones = toponymes officiels BF (décret juil. 2025) : 17 régions. */
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
  // Mooré — codes stables ; nameFr/zone = nouveaux toponymes
  { languageCode: 'moore', code: 'nord', nameFr: 'Yaadga', zone: 'Yaadga', targetHours: 50 },
  { languageCode: 'moore', code: 'centre', nameFr: 'Kadiogo', zone: 'Kadiogo', targetHours: 80 },
  { languageCode: 'moore', code: 'plateau-central', nameFr: 'Oubri', zone: 'Oubri', targetHours: 40 },
  { languageCode: 'moore', code: 'centre-nord', nameFr: 'Kuilsé', zone: 'Kuilsé', targetHours: 30 },
  { languageCode: 'moore', code: 'centre-ouest', nameFr: 'Nando', zone: 'Nando', targetHours: 30 },
  { languageCode: 'moore', code: 'centre-sud', nameFr: 'Nazinon', zone: 'Nazinon', targetHours: 30 },
  { languageCode: 'moore', code: 'boucle-du-mouhoun', nameFr: 'Bankui', zone: 'Bankui', targetHours: 30 },
  { languageCode: 'moore', code: 'sourou', nameFr: 'Sourou', zone: 'Sourou', targetHours: 25 },
  { languageCode: 'moore', code: 'centre-est', nameFr: 'Nakambé', zone: 'Nakambé', targetHours: 25 },
  // Dioula
  { languageCode: 'dioula', code: 'ouest', nameFr: 'Guiriko', zone: 'Guiriko', targetHours: 50 },
  { languageCode: 'dioula', code: 'hauts-bassins', nameFr: 'Guiriko', zone: 'Guiriko', targetHours: 50 },
  { languageCode: 'dioula', code: 'cascade', nameFr: 'Tannounyan', zone: 'Tannounyan', targetHours: 30 },
  { languageCode: 'dioula', code: 'sud-ouest', nameFr: 'Djôrô', zone: 'Djôrô', targetHours: 25 },
  { languageCode: 'dioula', code: 'centre', nameFr: 'Kadiogo', zone: 'Kadiogo', targetHours: 20 },
  // Fulfuldé
  { languageCode: 'fulfulde', code: 'sahel', nameFr: 'Liptako', zone: 'Liptako', targetHours: 40 },
  { languageCode: 'fulfulde', code: 'soum', nameFr: 'Soum', zone: 'Soum', targetHours: 25 },
  { languageCode: 'fulfulde', code: 'est', nameFr: 'Goulmou', zone: 'Goulmou', targetHours: 30 },
  { languageCode: 'fulfulde', code: 'sirba', nameFr: 'Sirba', zone: 'Sirba', targetHours: 25 },
  { languageCode: 'fulfulde', code: 'tapoa', nameFr: 'Tapoa', zone: 'Tapoa', targetHours: 25 },
  { languageCode: 'fulfulde', code: 'nord', nameFr: 'Yaadga', zone: 'Yaadga', targetHours: 20 },
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
