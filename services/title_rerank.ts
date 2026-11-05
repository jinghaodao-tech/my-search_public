export interface TitleRerankDetails {
  method: 'title-coverage';
  baseScore: number;
  normalizedBaseScore: number;
  titleCoverage: number;
  weight: number;
}

type ScoredTitleItem = { score: number; article: { title: string } };

export function rerankByTitleCoverage<T extends ScoredTitleItem>(
  items: T[],
  queryTerms: string[],
  weight = 0.2,
): Array<T & { scoreSources: TitleRerankDetails }> {
  if (!Number.isFinite(weight) || weight < 0) throw new Error('Title rerank weight must be a non-negative finite number');

  const terms = [...new Set(queryTerms.map(term => term.normalize('NFKC').toLocaleLowerCase('ja-JP').trim()).filter(Boolean))];
  if (!items.length) return [];
  const scores = items.map(item => item.score);
  const minimum = Math.min(...scores);
  const maximum = Math.max(...scores);
  const range = maximum - minimum;

  return items.map((item, index) => {
    const title = item.article.title.normalize('NFKC').toLocaleLowerCase('ja-JP');
    const titleCoverage = terms.length ? terms.filter(term => title.includes(term)).length / terms.length : 0;
    const normalizedBaseScore = range > 0 ? (item.score - minimum) / range : 1;
    const score = normalizedBaseScore + weight * titleCoverage;
    return {
      order: index,
      item: {
        ...item,
        score,
        scoreSources: {
          method: 'title-coverage' as const,
          baseScore: item.score,
          normalizedBaseScore,
          titleCoverage,
          weight,
        },
      },
    };
  }).sort((a, b) => b.item.score - a.item.score || a.order - b.order).map(entry => entry.item);
}
