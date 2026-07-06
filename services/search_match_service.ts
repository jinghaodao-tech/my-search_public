type SearchMatchField = 'title' | 'body' | 'summary' | 'tags';

function normalizeSearchText(value: unknown): string {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase();
}

export function buildSearchKeywordCandidates(config: unknown): string[] {
  const keywords = (config as { keywords?: Array<{ term?: unknown; synonyms?: unknown[] }> })?.keywords ?? [];
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const keyword of keywords) {
    const text = String(keyword.term ?? '').trim();
    const key = normalizeSearchText(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    candidates.push(text);
  }

  return candidates;
}

export function buildSearchMatchMeta(
  article: { title?: unknown; body?: unknown; summary?: unknown; tags?: unknown },
  keywords: string[],
  matchedTerms: Array<{ term?: unknown }> = [],
): { matchedFields: SearchMatchField[]; matchedKeywords: string[] } {
  const fieldTexts: Record<SearchMatchField, string> = {
    title: normalizeSearchText(article.title),
    body: normalizeSearchText(article.body),
    summary: normalizeSearchText(article.summary),
    tags: Array.isArray(article.tags)
      ? normalizeSearchText(article.tags.join(' '))
      : normalizeSearchText(article.tags),
  };

  const matchedFields = (Object.entries(fieldTexts) as Array<[SearchMatchField, string]>)
    .filter(([, value]) => keywords.some((keyword) => value.includes(normalizeSearchText(keyword))))
    .map(([field]) => field);

  const matchedKeywords = keywords.filter((keyword) => {
    const normalized = normalizeSearchText(keyword);
    return Object.values(fieldTexts).some((value) => value.includes(normalized));
  });

  if (matchedKeywords.length) {
    return { matchedFields, matchedKeywords };
  }

  const fallbackKeywords = [...new Set(matchedTerms.map((term) => String(term.term ?? '').trim()).filter(Boolean))];
  return { matchedFields, matchedKeywords: fallbackKeywords };
}
