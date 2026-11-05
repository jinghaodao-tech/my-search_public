import type { Posting } from './bm25_adaptive_tf.js';

export type Rm3Document = { length: number; termFrequencies: ReadonlyMap<string, number> };

export function buildRm3QueryWeights(
  originalTerms: readonly string[],
  rankedDocuments: readonly { docIndex: number }[],
  documents: readonly Rm3Document[],
  documentCount: number,
  collectionLength: number,
  collectionFrequencies: ReadonlyMap<string, number>,
  feedbackDocumentCount = 10,
  expansionTermLimit = 10,
  originalQueryWeight = 0.5,
  dirichletMu = 1000,
): Map<string, number> {
  if (!Number.isInteger(feedbackDocumentCount) || feedbackDocumentCount < 1) throw new Error('feedbackDocumentCount must be a positive integer.');
  if (!Number.isInteger(expansionTermLimit) || expansionTermLimit < 0) throw new Error('expansionTermLimit must be a non-negative integer.');
  if (!(originalQueryWeight >= 0 && originalQueryWeight <= 1)) throw new Error('originalQueryWeight must be between 0 and 1.');
  if (!(dirichletMu > 0) || !(collectionLength > 0)) throw new Error('Dirichlet mu and collection length must be positive.');

  const terms = [...new Set(originalTerms.filter(Boolean))];
  if (!terms.length) return new Map();
  const feedbackDocs = rankedDocuments.slice(0, feedbackDocumentCount)
    .map(({ docIndex }) => documents[docIndex])
    .filter((document): document is Rm3Document => document !== undefined);
  if (!feedbackDocs.length || expansionTermLimit === 0) {
    return new Map(terms.map(term => [term, 1 / terms.length]));
  }
  const inCollectionQueryTerms = terms.filter(term => (collectionFrequencies.get(term) ?? 0) > 0);
  if (!inCollectionQueryTerms.length) return new Map(terms.map(term => [term, 1 / terms.length]));

  const logQueryLikelihoods = feedbackDocs.map(document => inCollectionQueryTerms.reduce((sum, term) => {
    const collectionProbability = (collectionFrequencies.get(term) ?? 0) / collectionLength;
    const probability = (document.termFrequencies.get(term) ?? 0) + dirichletMu * collectionProbability;
    return sum + Math.log(probability / (document.length + dirichletMu));
  }, 0));
  const maxLogLikelihood = Math.max(...logQueryLikelihoods);
  const documentMasses = logQueryLikelihoods.map(value => Math.exp(value - maxLogLikelihood));
  const totalDocumentMass = documentMasses.reduce((sum, value) => sum + value, 0);
  const feedbackModel = new Map<string, number>();

  feedbackDocs.forEach((document, index) => {
    const documentWeight = documentMasses[index]! / totalDocumentMass;
    for (const [term, frequency] of document.termFrequencies) {
      const collectionProbability = (collectionFrequencies.get(term) ?? 0) / collectionLength;
      const termProbability = (frequency + dirichletMu * collectionProbability) / (document.length + dirichletMu);
      feedbackModel.set(term, (feedbackModel.get(term) ?? 0) + documentWeight * termProbability);
    }
  });

  const originalSet = new Set(terms);
  const expansionTerms = [...feedbackModel]
    .filter(([term, probability]) => !originalSet.has(term) && probability > 0 && Number.isFinite(probability))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, expansionTermLimit);
  const expansionMass = expansionTerms.reduce((sum, [, probability]) => sum + probability, 0);
  if (!expansionTerms.length || !(expansionMass > 0)) return new Map(terms.map(term => [term, 1 / terms.length]));

  const weights = new Map(terms.map(term => [term, originalQueryWeight / terms.length]));
  for (const [term, probability] of expansionTerms) {
    weights.set(term, (1 - originalQueryWeight) * probability / expansionMass);
  }
  return weights;
}

export function scoreWeightedBm25(
  queryWeights: ReadonlyMap<string, number>,
  documentCount: number,
  averageLength: number,
  lengths: readonly number[],
  postings: ReadonlyMap<string, readonly Posting[]>,
  k1 = 1.2,
  b = 0.75,
  limit = Number.POSITIVE_INFINITY,
): Array<{ docIndex: number; score: number }> {
  if (!(limit === Number.POSITIVE_INFINITY || (Number.isInteger(limit) && limit > 0))) {
    throw new Error('limit must be a positive integer or Infinity.');
  }
  const scores = new Map<number, number>();
  for (const [term, queryWeight] of queryWeights) {
    const rows = postings.get(term);
    if (!rows?.length || !(queryWeight > 0)) continue;
    const idf = Math.log(1 + (documentCount - rows.length + 0.5) / (rows.length + 0.5));
    for (const row of rows) {
      const normalization = 1 - b + b * lengths[row.docIndex]! / Math.max(averageLength, 1);
      const normalizedTf = row.tf / normalization;
      const tfScore = normalizedTf * (k1 + 1) / (normalizedTf + k1);
      scores.set(row.docIndex, (scores.get(row.docIndex) ?? 0) + queryWeight * idf * tfScore);
    }
  }
  const isWorse = (left: { docIndex: number; score: number }, right: { docIndex: number; score: number }) =>
    left.score < right.score || (left.score === right.score && left.docIndex > right.docIndex);
  const heap: Array<{ docIndex: number; score: number }> = [];
  for (const [docIndex, score] of scores) {
    const item = { docIndex, score };
    if (heap.length < limit) {
      heap.push(item);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (!isWorse(heap[index]!, heap[parent]!)) break;
        [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
        index = parent;
      }
      continue;
    }
    if (isWorse(heap[0]!, item) || (heap[0]!.score === item.score && heap[0]!.docIndex === item.docIndex)) {
      heap[0] = item;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let worst = index;
        if (left < heap.length && isWorse(heap[left]!, heap[worst]!)) worst = left;
        if (right < heap.length && isWorse(heap[right]!, heap[worst]!)) worst = right;
        if (worst === index) break;
        [heap[index], heap[worst]] = [heap[worst]!, heap[index]!];
        index = worst;
      }
    }
  }
  return heap.sort((left, right) => right.score - left.score || left.docIndex - right.docIndex);
}
