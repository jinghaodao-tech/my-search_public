import {
  collectAll,
  DEFAULT_CONFIG,
  ensureArticleTokens,
  loadArticles,
  saveArticles,
  type CollectResult,
  type CollectorConfig,
} from '../collector.js';

export function createCollectorService() {
  let cachedArticles: CollectResult | null = loadArticles();
  let collectorConfig: CollectorConfig = DEFAULT_CONFIG;

  return {
    collectAll,
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