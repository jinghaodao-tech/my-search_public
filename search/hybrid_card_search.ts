import { db } from '../db/database.js';
import { runPipeline, type Article, type ModeConfig, type PipelineResult } from '../bm25_engine.js';
import type { Card } from '../domain/card.js';

export type HybridSearchOptions = {
  bm25Weight?: number;
  ftsWeight?: number;
  resultLimit?: number;
};

type FtsRow = { id: string; rank: number };

function normalize(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || max <= min) return 0;
  return (value - min) / (max - min);
}

function ftsQuery(keywords: ModeConfig['keywords']): string {
  return keywords.map(keyword => String(keyword.term ?? '').trim())
    .filter(Boolean)
    .flatMap(term => term.split(/\s+/))
    .map(term => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ');
}

/** Combine independent BM25 and SQLite FTS5 evidence with min-max normalization. */
export async function runHybridCardSearch(
  cards: Card[],
  mode: ModeConfig,
  modeId: string,
  options: HybridSearchOptions = {},
): Promise<PipelineResult> {
  const bm25Weight = options.bm25Weight ?? 0.7;
  const ftsWeight = options.ftsWeight ?? 0.3;
  const resultLimit = options.resultLimit ?? 50;
  const bm25 = await runPipeline(cards.map(card => ({
    id: card.id,
    title: card.title,
    body: card.body,
    url: card.url ?? '',
    source: 'cards',
    sourceAuthority: 1,
    publishedAt: new Date(card.createdAt),
    tags: card.tags ?? [],
    summary: card.summary,
  } satisfies Article)), mode, modeId, { ...options, resultLimit: Math.max(resultLimit, cards.length) });
  const query = ftsQuery(mode.keywords);
  const ftsRows = query ? db.prepare('SELECT id, bm25(cards_fts) AS rank FROM cards_fts WHERE cards_fts MATCH ? ORDER BY rank ASC').all(query) as FtsRow[] : [];
  const ftsById = new Map(ftsRows.map((row, index) => [row.id, { rank: row.rank, position: index }]));
  const bm25Scores = bm25.active.map(item => item.score);
  const min = Math.min(...bm25Scores, 0);
  const max = Math.max(...bm25Scores, 0);
  const active = bm25.active.map(item => {
    const fts = ftsById.get(item.article.id);
    const ftsScore = fts ? 1 - fts.position / Math.max(ftsRows.length, 1) : 0;
    return {
      ...item,
      score: bm25Weight * normalize(item.score, min, max) + ftsWeight * ftsScore,
      hybrid: { bm25: item.score, fts5: ftsScore, weights: { bm25: bm25Weight, fts5: ftsWeight } },
    };
  }).sort((a, b) => b.score - a.score).slice(0, resultLimit);
  return { ...bm25, active, stats: { ...bm25.stats, activeCount: active.length, avgScore: active.length ? active.reduce((sum, item) => sum + item.score, 0) / active.length : 0 } };
}
