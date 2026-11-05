export type Pl2Posting = { docIndex: number; tf: number };

const log2 = (value: number) => Math.log(value) / Math.LN2;

export function scorePl2(
  terms: readonly string[],
  documentCount: number,
  averageLength: number,
  lengths: readonly number[],
  collectionFrequencies: ReadonlyMap<string, number>,
  postings: ReadonlyMap<string, readonly Pl2Posting[]>,
  c = 1,
): Array<{ docIndex: number; score: number }> {
  if (!(c > 0)) throw new Error('PL2 normalization parameter c must be positive.');
  const scores = new Map<number, number>();
  for (const term of new Set(terms)) {
    const rows = postings.get(term);
    const collectionFrequency = collectionFrequencies.get(term) ?? 0;
    if (!rows?.length || !(collectionFrequency > 0)) continue;

    const mean = collectionFrequency / documentCount;
    const p1 = mean / Math.LN2 + 0.5 * log2(2 * Math.PI);
    const p2 = log2(mean) + 1 / Math.LN2;
    for (const row of rows) {
      const docLength = lengths[row.docIndex];
      if (!(docLength! > 0) || !(row.tf > 0)) continue;
      const normalizedTf = row.tf * log2(1 + (c * averageLength) / docLength!);
      if (!(normalizedTf > 0)) continue;
      const divergence = p1 + (normalizedTf + 0.5) * log2(normalizedTf) - p2 * normalizedTf;
      if (!(divergence > 0)) continue;
      scores.set(row.docIndex, (scores.get(row.docIndex) ?? 0) + divergence / (normalizedTf + 1));
    }
  }
  return [...scores].map(([docIndex, score]) => ({ docIndex, score }))
    .sort((left, right) => right.score - left.score || left.docIndex - right.docIndex);
}
