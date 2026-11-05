// Independent, direct definitions used only to cross-check production evaluators.
// Relevance gains and rank discounts match standard TREC-style nDCG and binary Hit/MRR/Recall.
export function referenceHitAtK(ranking, relevantIds, k) {
  const relevant = new Set(relevantIds);
  return Number(ranking.slice(0, k).some(id => relevant.has(id)));
}

export function referenceDcgAtK(ranking, relevance, k) {
  let total = 0;
  for (let index = 0; index < Math.min(k, ranking.length); index++) {
    const grade = relevance[ranking[index]] ?? 0;
    total += (2 ** grade - 1) / Math.log2(index + 2);
  }
  return total;
}

export function referenceNdcgAtK(ranking, relevance, k) {
  const idealRanking = Object.entries(relevance).filter(([, grade]) => grade > 0)
    .sort((left, right) => right[1] - left[1]).map(([id]) => id);
  const ideal = referenceDcgAtK(idealRanking, relevance, k);
  return ideal > 0 ? referenceDcgAtK(ranking, relevance, k) / ideal : 0;
}

export function referenceMrrAtK(ranking, relevantIds, k) {
  const relevant = new Set(relevantIds);
  const index = ranking.slice(0, k).findIndex(id => relevant.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

export function referenceRecallAtK(ranking, relevantIds, k) {
  if (!relevantIds.length) return 0;
  const relevant = new Set(relevantIds);
  return ranking.slice(0, k).filter(id => relevant.has(id)).length / relevant.size;
}
