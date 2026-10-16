// Matching langue app ↔ prompts : l'app envoie les noms affichés (« Mooré »,
// « Fulfuldé »), les prompts sont en ASCII ('moore', 'fulfulde') — on compare
// après suppression des diacritiques, sinon le filtre rate et l'utilisateur
// reçoit des phrases d'une autre langue.
function normalizeLang(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function langMatches(promptLang: string, param: string): boolean {
  const a = normalizeLang(promptLang);
  const b = normalizeLang(param);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}
