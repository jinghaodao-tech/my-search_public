import type { Posting } from './bm25_adaptive_tf.js';

const log2 = (value: number) => Math.log(value) / Math.LN2;

export function buildBo1ExpansionWeights(
  feedbackTermFrequencies: ReadonlyMap<string, number>,
  collectionFrequencies: ReadonlyMap<string, number>,
  documentCount: number,
  originalTerms: ReadonlySet<string>,
  expansionTermLimit = 10,
): Map<string, number> {
  if (!Number.isInteger(expansionTermLimit) || expansionTermLimit < 0) throw new Error('Expansion term limit must be a non-negative integer.');
  const candidates: Array<{ term: string; weight: number }> = [];
  for (const [term, feedbackTf] of feedbackTermFrequencies) {
    const collectionFrequency = collectionFrequencies.get(term) ?? 0;
    if (originalTerms.has(term) || !(feedbackTf > 0) || !(collectionFrequency > 0)) continue;
    const pn = collectionFrequency / documentCount;
    const weight = feedbackTf * log2((1 + pn) / pn) + log2(1 + pn);
    if (Number.isFinite(weight) && weight > 0) candidates.push({ term, weight });
  }
  candidates.sort((left, right) => right.weight - left.weight || left.term.localeCompare(right.term));
  const selected = candidates.slice(0, expansionTermLimit);
  const maximum = selected[0]?.weight ?? 0;
  return new Map(selected.map(candidate => [candidate.term, candidate.weight / maximum]));
}

export function scoreWeightedStandardBm25(
  queryTermWeights: ReadonlyMap<string, number>,
  documentCount: number,
  averageLength: number,
  lengths: readonly number[],
  postings: ReadonlyMap<string, readonly Posting[]>,
  k1 = 1.2,
  b = 0.75,
): Array<{ docIndex: number; score: number }> {
  const scores = new Map<number, number>();
  for (const [term, queryWeight] of queryTermWeights) {
    const rows = postings.get(term);
    if (!rows?.length || !(queryWeight > 0)) continue;
    const documentFrequency = rows.length;
    const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
    for (const row of rows) {
      const normalization = 1 - b + b * (lengths[row.docIndex] ?? 0) / Math.max(averageLength, 1);
      const normalizedTf = row.tf / normalization;
      const tfScore = (normalizedTf * (k1 + 1)) / (normalizedTf + k1);
      scores.set(row.docIndex, (scores.get(row.docIndex) ?? 0) + queryWeight * idf * tfScore);
    }
  }
  return [...scores].map(([docIndex, score]) => ({ docIndex, score }))
    .sort((left, right) => right.score - left.score || left.docIndex - right.docIndex);
}
