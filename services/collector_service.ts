import {
  collectAll,
  DEFAULT_CONFIG,
  ensureArticleTokens,
  loadArticles,
  saveArticles,
  type CollectResult,
  type CollectorConfig,
} from '../collector.js';
import { db } from '../db/database.js';
import { collectorConfigSchema } from '../schemas/api_schemas.js';
import { loadArticleStats } from '../repositories/articles_repository.js';

export class CollectionBusyError extends Error {
  constructor() { super('Collection already running'); }
}

function portfolioFixture(): CollectResult {
  const fetchedAt = new Date().toISOString();
  const articles = [
    { id: 'fixture-portfolio-search', title: 'Portfolio search architecture', body: 'BM25 ranking and local SQLite search for a practical portfolio workflow.', url: 'https://fixture.local/portfolio-search', source: 'fixture', sourceAuthority: 1, publishedAt: new Date(fetchedAt), tokens: ['portfolio', 'search', 'bm25', 'sqlite'], docLength: 4 },
    { id: 'fixture-portfolio-ops', title: 'Portfolio operations and verification', body: 'Local-first operations with tests, benchmarks, and deterministic CI evidence.', url: 'https://fixture.local/portfolio-ops', source: 'fixture', sourceAuthority: 1, publishedAt: new Date(fetchedAt), tokens: ['portfolio', 'operations', 'tests', 'benchmark'], docLength: 4 },
    { id: 'fixture-portfolio-design', title: 'Portfolio design notes', body: 'A compact product surface for cards, tags, links, and review states.', url: 'https://fixture.local/portfolio-design', source: 'fixture', sourceAuthority: 0.9, publishedAt: new Date(fetchedAt), tokens: ['portfolio', 'design', 'cards', 'tags'], docLength: 4 },
  ];
  return { articles, errors: [], stats: { rss: 0, arxiv: 0, github: 0, total: articles.length, fetchedAt } };
}

export function createCollectorService(collect = collectAll) {
  let cachedArticles: CollectResult | null = loadArticles();
  const readSetting = (key: string) => (db.prepare('SELECT value FROM collector_settings WHERE key = ?').get(key) as {value: string} | undefined)?.value;
  const writeSetting = (key: string, value: string) => db.prepare('INSERT INTO collector_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
  let collectorConfig: CollectorConfig = structuredClone(DEFAULT_CONFIG);
  try { collectorConfig = collectorConfigSchema.parse(JSON.parse(readSetting('config') ?? 'null')); } catch { /* First run uses defaults. */ }
  let running = false;
  let lastAttemptAt = readSetting('lastAttemptAt') ?? null;
  let lastSuccessAt = readSetting('lastSuccessAt') ?? null;
  let lastError = readSetting('lastError') ?? null;
  let latestFetchedCount: number | null = null;
  const savedCount = readSetting('latestFetchedCount');
  if (savedCount !== undefined && Number.isFinite(Number(savedCount))) latestFetchedCount = Number(savedCount);
  async function run(config: CollectorConfig, fixture = false): Promise<CollectResult> {
    if (running) throw new CollectionBusyError();
    running = true;
    try {
      lastAttemptAt = new Date().toISOString();
      writeSetting('lastAttemptAt', lastAttemptAt);
      const result = fixture ? portfolioFixture() : await collect(config);
      if (fixture) saveArticles(result);
      cachedArticles = result;
      latestFetchedCount = result.stats.total;
      writeSetting('latestFetchedCount', String(latestFetchedCount));
      lastError = result.errors.join('\n') || null;
      writeSetting('lastError', lastError ?? '');
      if (!result.errors.length) { lastSuccessAt = result.stats.fetchedAt; writeSetting('lastSuccessAt', lastSuccessAt); }
      return result;
    } catch (error) {
      lastError = (error as Error).message;
      writeSetting('lastError', lastError);
      throw error;
    } finally { running = false; }
  }

  return {
    collectAll: (config = collectorConfig) => run(config),
    collectFixture: () => run(collectorConfig, true),
    getCollectRunning: () => running,
    getCollectionStatus: () => ({ lastAttemptAt, lastSuccessAt, lastError, accumulatedArticleCount: loadArticleStats()?.total ?? 0, latestFetchedCount }),
    loadArticles,
    saveArticles,
    ensureArticleTokens,
    getCachedArticles: () => cachedArticles,
    setCachedArticles: (value: CollectResult | null) => { cachedArticles = value; },
    getCollectorConfig: () => structuredClone(collectorConfig),
    setCollectorConfig: (value: CollectorConfig) => {
      const validated = collectorConfigSchema.parse(value);
      writeSetting('config', JSON.stringify(validated));
      collectorConfig = structuredClone(validated);
    },
    getDefaultConfig: () => DEFAULT_CONFIG,
  };
}
