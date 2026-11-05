import type { Article } from '../bm25_engine.js';
import { embedE5Texts } from './e5_embedding_service.js';

export const E5_RRF_K = 60;

export type E5RerankCandidate = { article: Article; score: number };
export type E5RerankResult<T extends E5RerankCandidate> = {
  item: T;
  bm25Rank: number;
  e5Rank: number;
  similarity: number;
  rrfScore: number;
  normalizedScore: number;
};
export type EmbedBatch = (texts: readonly string[]) => Promise<Float32Array[]>;

function dot(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new Error('Embedding dimensions do not match.');
  let sum = 0;
  for (let index = 0; index < left.length; index++) sum += left[index]! * right[index]!;
  return sum;
}

export async function rerankWithE5Rrf<T extends E5RerankCandidate>(
  candidates: readonly T[],
  query: string,
  embed: EmbedBatch = embedE5Texts,
): Promise<Array<E5RerankResult<T>>> {
  if (!candidates.length) return [];
  const queryText = query.trim();
  if (!queryText) throw new Error('E5 reranking requires at least one query term.');
  const passageText = (article: Article) => [article.title, article.summary, article.tags?.join(' '), article.body]
    .filter(Boolean).join('\n');
  const vectors = await embed([`query: ${queryText}`, ...candidates.map(item => `passage: ${passageText(item.article)}`)]);
  if (vectors.length !== candidates.length + 1) throw new Error('E5 returned an unexpected number of embeddings.');
  const similarities = candidates.map((_, index) => dot(vectors[0]!, vectors[index + 1]!));
  const semanticOrder = candidates.map((item, index) => ({ item, index, similarity: similarities[index]! }))
    .sort((left, right) => right.similarity - left.similarity || left.index - right.index);
  const semanticRank = new Map(semanticOrder.map((entry, index) => [entry.index, index + 1]));
  const scores = candidates.map((_, index) => 1 / (E5_RRF_K + index + 1) + 1 / (E5_RRF_K + semanticRank.get(index)!));
  const maximum = Math.max(...scores);
  return candidates.map((item, index) => ({
    item,
    bm25Rank: index + 1,
    e5Rank: semanticRank.get(index)!,
    similarity: similarities[index]!,
    rrfScore: scores[index]!,
    normalizedScore: maximum > 0 ? scores[index]! / maximum : 0,
  })).sort((left, right) => right.rrfScore - left.rrfScore || left.bm25Rank - right.bm25Rank);
}
