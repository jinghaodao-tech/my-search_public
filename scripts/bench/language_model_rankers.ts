export type LanguageModelPosting = { docIndex: number; tf: number };

export type LanguageModelOptions =
  | { method: 'dirichlet'; mu: number }
  | { method: 'jelinek-mercer'; lambda: number };

export function reciprocalRankFusion(rankings: readonly (readonly string[])[], constant = 60, limit = 100): string[] {
  if (!(Number.isFinite(constant) && constant > 0)) throw new Error('constant must be positive.');
  if (!(Number.isInteger(limit) && limit > 0)) throw new Error('limit must be a positive integer.');
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    ranking.forEach((id, index) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (constant + index + 1));
    });
  }
  return [...scores].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit).map(([id]) => id);
}

export function scoreQueryLikelihood(
  terms: readonly string[],
  lengths: readonly number[],
  collectionLength: number,
  collectionFrequencies: ReadonlyMap<string, number>,
  postings: ReadonlyMap<string, readonly LanguageModelPosting[]>,
  options: LanguageModelOptions,
  limit = 100,
): Array<{ docIndex: number; score: number }> {
  if (!(Number.isInteger(limit) && limit > 0)) throw new Error('limit must be a positive integer.');
  if (!(collectionLength > 0)) throw new Error('collectionLength must be positive.');
  if (options.method === 'dirichlet' && !(options.mu > 0)) throw new Error('mu must be positive.');
  if (options.method === 'jelinek-mercer' && !(options.lambda > 0 && options.lambda <= 1)) {
    throw new Error('lambda must be in (0, 1].');
  }

  const queryTerms = [...new Set(terms.filter(Boolean))].flatMap(term => {
    const frequency = collectionFrequencies.get(term) ?? 0;
    return frequency > 0 ? [{ term, probability: frequency / collectionLength }] : [];
  });
  if (!queryTerms.length) return [];

  const scores = new Float64Array(lengths.length);
  for (let docIndex = 0; docIndex < lengths.length; docIndex++) {
    const documentLength = lengths[docIndex]!;
    scores[docIndex] = queryTerms.reduce((sum, queryTerm) => {
      if (options.method === 'dirichlet') {
        return sum + Math.log(options.mu * queryTerm.probability / (documentLength + options.mu));
      }
      return sum + Math.log(options.lambda * queryTerm.probability);
    }, 0);
  }

  for (const { term, probability } of queryTerms) {
    const baselineProbability = options.method === 'dirichlet'
      ? options.mu * probability
      : options.lambda * probability;
    for (const posting of postings.get(term) ?? []) {
      const documentLength = lengths[posting.docIndex];
      if (documentLength === undefined || !(posting.tf > 0)) throw new Error('Invalid posting row.');
      const probabilityWithTerm = options.method === 'dirichlet'
        ? posting.tf + baselineProbability
        : (posting.tf * (1 - options.lambda) / Math.max(documentLength, 1)) + baselineProbability;
      scores[posting.docIndex] += Math.log(probabilityWithTerm / baselineProbability);
    }
  }

  const compareRank = (left: { docIndex: number; score: number }, right: { docIndex: number; score: number }) =>
    right.score - left.score || left.docIndex - right.docIndex;
  const isWorse = (left: { docIndex: number; score: number }, right: { docIndex: number; score: number }) =>
    compareRank(left, right) > 0;
  const heap: Array<{ docIndex: number; score: number }> = [];
  const siftDown = (start: number) => {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < heap.length && isWorse(heap[left]!, heap[worst]!)) worst = left;
      if (right < heap.length && isWorse(heap[right]!, heap[worst]!)) worst = right;
      if (worst === index) return;
      [heap[index], heap[worst]] = [heap[worst]!, heap[index]!];
      index = worst;
    }
  };
  for (let docIndex = 0; docIndex < scores.length; docIndex++) {
    const item = { docIndex, score: scores[docIndex]! };
    if (heap.length < limit) {
      heap.push(item);
      for (let index = heap.length - 1; index > 0;) {
        const parent = Math.floor((index - 1) / 2);
        if (!isWorse(heap[index]!, heap[parent]!)) break;
        [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
        index = parent;
      }
    } else if (compareRank(item, heap[0]!) < 0) {
      heap[0] = item;
      siftDown(0);
    }
  }
  return heap.sort(compareRank);
}
