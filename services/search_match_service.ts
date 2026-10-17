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

// Plain-text excerpts; the browser escapes and highlights these without trusting page HTML.
export function buildSearchSnippet(article: { body?: unknown; summary?: unknown }, keywords: string[]): string {
  const texts = [String(article.body ?? ''), String(article.summary ?? '')];
  for (const text of texts) {
    const normalized = text.normalize('NFKC').toLowerCase();
    const positions = keywords.map(term => normalized.indexOf(term.normalize('NFKC').toLowerCase())).filter(index => index >= 0);
    if (!positions.length) continue;
    // Use normalized text as the displayed text too, so width normalization cannot shift offsets.
    const display = text.normalize('NFKC');
    const start = Math.max(0, Math.min(...positions) - 70);
    return `${start ? '…' : ''}${display.slice(start, start + 240)}${start + 240 < display.length ? '…' : ''}`;
  }
  return (texts[1] || texts[0]).slice(0, 240);
}
