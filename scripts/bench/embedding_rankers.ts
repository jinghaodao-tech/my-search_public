export type ScoredDocument = { docIndex: number; score: number };

export function exactTopK(scores: Float32Array, limit: number): ScoredDocument[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer.');
  const heap: ScoredDocument[] = [];
  const worse = (left: ScoredDocument, right: ScoredDocument) =>
    left.score < right.score || (left.score === right.score && left.docIndex > right.docIndex);
  const swap = (left: number, right: number) => [heap[left], heap[right]] = [heap[right]!, heap[left]!];
  for (let docIndex = 0; docIndex < scores.length; docIndex++) {
    const candidate = { docIndex, score: scores[docIndex]! };
    if (!Number.isFinite(candidate.score)) throw new Error(`Non-finite score at document ${docIndex}.`);
    if (heap.length < limit) {
      heap.push(candidate);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (!worse(heap[index]!, heap[parent]!)) break;
        swap(index, parent);
        index = parent;
      }
      continue;
    }
    if (!worse(heap[0]!, candidate)) continue;
    heap[0] = candidate;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < heap.length && worse(heap[left]!, heap[worst]!)) worst = left;
      if (right < heap.length && worse(heap[right]!, heap[worst]!)) worst = right;
      if (worst === index) break;
      swap(index, worst);
      index = worst;
    }
  }
  return heap.sort((left, right) => right.score - left.score || left.docIndex - right.docIndex);
}

export function reciprocalRankFusion(rankings: readonly (readonly string[])[], k = 60, limit = 100): string[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) ranking.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  return [...scores].sort(([leftId, leftScore], [rightId, rightScore]) => rightScore - leftScore || leftId.localeCompare(rightId))
    .slice(0, limit).map(([id]) => id);
}
