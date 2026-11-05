export type MiraclHitMetrics = {
  hit1: boolean;
  hit10: boolean;
  hit50: boolean;
  rr10: number;
  ndcg10: number;
};

export const hitMetrics = (top50: string[], goldIds: string[]): MiraclHitMetrics => {
  const gold = new Set(goldIds);
  const top10 = top50.slice(0, 10);
  const firstTop50 = top50.findIndex(id => gold.has(id));
  const firstTop10 = top10.findIndex(id => gold.has(id));
  const dcg = top10.reduce((sum, id, rank) => sum + (gold.has(id) ? 1 / Math.log2(rank + 2) : 0), 0);
  const ideal = Array.from({length: Math.min(gold.size, 10)}, (_, rank) => 1 / Math.log2(rank + 2))
    .reduce((sum, value) => sum + value, 0);

  return {
    hit1: firstTop50 === 0,
    hit10: firstTop10 >= 0,
    hit50: firstTop50 >= 0,
    rr10: firstTop10 >= 0 ? 1 / (firstTop10 + 1) : 0,
    ndcg10: ideal ? dcg / ideal : 0,
  };
};
