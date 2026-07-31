import {
  collectAll,
  DEFAULT_CONFIG,
  ensureArticleTokens,
  loadArticles,
  saveArticles,
  type CollectResult,
  type CollectorConfig,
} from '../collector.js';

function portfolioFixture(): CollectResult {
  const fetchedAt = new Date().toISOString();
  const articles = [
    { id: 'fixture-portfolio-search', title: 'Portfolio search architecture', body: 'BM25 ranking and local SQLite search for a practical portfolio workflow.', url: 'https://fixture.local/portfolio-search', source: 'fixture', sourceAuthority: 1, publishedAt: new Date(fetchedAt), tokens: ['portfolio', 'search', 'bm25', 'sqlite'], docLength: 4 },
    { id: 'fixture-portfolio-ops', title: 'Portfolio operations and verification', body: 'Local-first operations with tests, benchmarks, and deterministic CI evidence.', url: 'https://fixture.local/portfolio-ops', source: 'fixture', sourceAuthority: 1, publishedAt: new Date(fetchedAt), tokens: ['portfolio', 'operations', 'tests', 'benchmark'], docLength: 4 },
    { id: 'fixture-portfolio-design', title: 'Portfolio design notes', body: 'A compact product surface for cards, tags, links, and review states.', url: 'https://fixture.local/portfolio-design', source: 'fixture', sourceAuthority: 0.9, publishedAt: new Date(fetchedAt), tokens: ['portfolio', 'design', 'cards', 'tags'], docLength: 4 },
  ];
  return { articles, errors: [], stats: { rss: 0, arxiv: 0, github: 0, total: articles.length, fetchedAt } };
}

export function createCollectorService() {
  let cachedArticles: CollectResult | null = loadArticles();
  let collectorConfig: CollectorConfig = DEFAULT_CONFIG;

  return {
    collectAll,
    collectFixture: async () => portfolioFixture(),
    loadArticles,
    saveArticles,
    ensureArticleTokens,
    getCachedArticles: () => cachedArticles,
    setCachedArticles: (value: CollectResult | null) => { cachedArticles = value; },
    getCollectorConfig: () => collectorConfig,
    setCollectorConfig: (value: CollectorConfig) => { collectorConfig = value; },
    getDefaultConfig: () => DEFAULT_CONFIG,
  };
}