import { db } from '../db/database.js';
import { runPipeline, type Article, type BenchmarkTimings, type ModeConfig } from './bm25.js';

export type SearchOptions = { archiveScoreThreshold?: number; dedupThreshold?: number; resultLimit?: number; bm25Weight?: number; ftsWeight?: number };
export type SearchResult = Awaited<ReturnType<typeof runPipeline>>;

export interface SearchEngine {
  readonly name: string;
  run(articles: Article[], mode: Parameters<typeof runPipeline>[1], modeId: string, options?: SearchOptions): Promise<SearchResult>;
}

export class Bm25SearchEngine implements SearchEngine {
  readonly name = 'bm25';

  run(articles: Article[], mode: Parameters<typeof runPipeline>[1], modeId: string, options?: SearchOptions) {
    return runPipeline(articles, mode, modeId, options);
  }
}

export class HybridSearchEngine implements SearchEngine {
  readonly name = 'hybrid';
  async run(articles: Article[], mode: ModeConfig, modeId: string, options: SearchOptions = {}) {
    const base = await runPipeline(articles, mode, modeId, options);
    const terms = mode.keywords.flatMap(keyword => keyword.term.split(/\s+/)).filter(Boolean);
    const query = terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
    const rows = query ? db.prepare('SELECT id FROM cards_fts WHERE cards_fts MATCH ? ORDER BY bm25(cards_fts)').all(query) as Array<{ id: string }> : [];
    const ftsRank = new Map(rows.map((row, index) => [row.id, 1 - index / Math.max(rows.length, 1)]));
    const scores = base.active.map(item => item.score);
    const min = Math.min(...scores, 0); const max = Math.max(...scores, 0);
    const bm25Weight = options.bm25Weight ?? 0.7; const ftsWeight = options.ftsWeight ?? 0.3;
    const normalize = (score: number) => max > min ? (score - min) / (max - min) : 0;
    const active = base.active.map(item => ({ ...item, score: bm25Weight * normalize(item.score) + ftsWeight * (ftsRank.get(item.article.id) ?? 0), scoreSources: { bm25: item.score, fts5: ftsRank.get(item.article.id) ?? 0, bm25Weight, ftsWeight } })).sort((a, b) => b.score - a.score).slice(0, options.resultLimit ?? 50);
    return { ...base, active, stats: { ...base.stats, activeCount: active.length, avgScore: active.length ? active.reduce((sum, item) => sum + item.score, 0) / active.length : 0 } };
  }
}

export function createSearchEngine(): SearchEngine {
  const engine = process.env.SEARCH_ENGINE ?? 'bm25';
  if (engine === 'bm25') return new Bm25SearchEngine();
  if (engine === 'hybrid') return new HybridSearchEngine();
  throw new Error(`Unsupported SEARCH_ENGINE: ${engine}`);
}

export type { Article, BenchmarkTimings };
