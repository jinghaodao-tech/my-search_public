export type RankedItem = { docIndex: number; score: number };

export function reciprocalRankFusion(rankings: readonly (readonly RankedItem[])[], k = 60): RankedItem[] {
  if (!(k >= 0) || !Number.isFinite(k)) throw new Error('RRF k must be a finite non-negative number.');
  const fused = new Map<number, number>();
  for (const ranking of rankings) {
    const seen = new Set<number>();
    for (const [index, item] of ranking.entries()) {
      if (seen.has(item.docIndex)) continue;
      seen.add(item.docIndex);
      fused.set(item.docIndex, (fused.get(item.docIndex) ?? 0) + 1 / (k + index + 1));
    }
  }
  return [...fused].map(([docIndex, score]) => ({ docIndex, score }))
    .sort((left, right) => right.score - left.score || left.docIndex - right.docIndex);
}
