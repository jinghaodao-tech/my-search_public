export type ParsedKeyword = { term: string; weight: number; synonyms: string[] };
export type ParsedSearchQuery = { rawQuery: string; phrases: string[]; terms: string[]; excludedTerms: string[]; parsedKeywords: ParsedKeyword[] };

const tokenPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|(-?[^\s]+)/gu;
function normalize(value: string): string { return value.trim().toLocaleLowerCase(); }
function splitTerms(value: string): string[] { return value.split(/[\s,、。]+/u).map(normalize).filter(Boolean); }

export function parseSearchQuery(rawQuery: string, synonyms: Record<string, string[]> = {}): ParsedSearchQuery {
  const raw = String(rawQuery ?? '').trim();
  const phrases: string[] = [];
  const terms: string[] = [];
  const excludedTerms: string[] = [];
  const seen = new Set<string>();
  const add = (target: string[], value: string) => { const key = normalize(value); if (key && !seen.has(`${target === excludedTerms ? '!' : ''}${key}`)) { seen.add(`${target === excludedTerms ? '!' : ''}${key}`); target.push(key); } };
  for (const match of raw.matchAll(tokenPattern)) {
    const phrase = match[1];
    const token = match[2];
    if (phrase !== undefined) { const normalized = normalize(phrase); if (normalized) { phrases.push(normalized); for (const term of splitTerms(normalized)) add(terms, term); } continue; }
    if (!token) continue;
    if (token.startsWith('-') && token.length > 1) { for (const term of splitTerms(token.slice(1))) add(excludedTerms, term); }
    else for (const term of splitTerms(token)) add(terms, term);
  }
  const parsedKeywords = terms.map((term) => ({ term, weight: phrases.some((phrase) => phrase.split(/\s+/u).includes(term)) ? 1.5 : 1, synonyms: (synonyms[term] ?? []).map(normalize).filter(Boolean) }));
  return { rawQuery: raw, phrases, terms, excludedTerms, parsedKeywords };
}

export function excludesArticle(article: { title: string; body: string; tokens?: string[] }, excludedTerms: string[]): boolean {
  const haystack = `${article.title} ${article.body} ${(article.tokens ?? []).join(' ')}`.toLocaleLowerCase();
  return excludedTerms.some((term) => haystack.includes(term));
}