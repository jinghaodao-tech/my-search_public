export type SearchQualityMetricName = 'precisionAt1' | 'rPrecision' | 'mrr' | 'recallAt5' | 'ndcgAt5';

// Reference definitions: https://amitness.com/posts/information-retrieval-evaluation
export const searchQualityMetricReferences: Record<SearchQualityMetricName, string> = {
  precisionAt1: 'Precision@k = relevant documents in the first k results divided by k',
  rPrecision: 'R-Precision = relevant documents in the first R results divided by R, where R is the number of known relevant documents',
  mrr: 'MRR = mean reciprocal rank of the first relevant result',
  recallAt5: 'Recall@5 = relevant documents in the first five results divided by all known relevant documents',
  ndcgAt5: 'nDCG@5 = discounted cumulative gain at five divided by ideal discounted cumulative gain at five',
};

export function precisionAt(results: string[], expected: string[], k: number): number {
  if (!Number.isInteger(k) || k <= 0) throw new Error(`invalid_k:${k}`);
  const relevant = new Set(expected);
  return results.slice(0, k).filter(id => relevant.has(id)).length / k;
}

export function rPrecision(results: string[], expected: string[]): number {
  const relevant = new Set(expected);
  const r = Math.max(expected.length, 1);
  return results.slice(0, r).filter(id => relevant.has(id)).length / r;
}

export function reciprocalRank(results: string[], expected: string[]): number {
  const relevant = new Set(expected);
  const index = results.findIndex(id => relevant.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

export function recallAt5(results: string[], expected: string[]): number {
  const relevant = new Set(expected);
  return results.slice(0, 5).filter(id => relevant.has(id)).length / relevant.size;
}

export function ndcgAt5(results: string[], expected: string[]): number {
  const relevant = new Set(expected);
  const dcg = results.slice(0, 5).reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(5, relevant.size) }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0);
  return ideal ? dcg / ideal : 0;
}
