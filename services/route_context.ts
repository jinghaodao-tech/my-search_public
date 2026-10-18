import type express from 'express';
import { db } from '../db/database.js';
import { tokenizerName } from '../bm25_engine.js';
import { resetInterruptedSiteChecks } from '../repositories/site_sources_repository.js';
import { logger } from '../utils/logger.js';
import { getArticleById } from '../repositories/articles_repository.js';
import { expireCandidate, expireReviewedCandidates, getCandidate, getCandidates, reviewCandidate, saveCandidate } from './candidate_service.js';
import { MODES, createSearchEngine } from './search_service.js';
import { createCollectorService } from './collector_service.js';
import { createSchedulerService } from './scheduler_service.js';
import {
  backfillCardTokens,
  bulkArchiveCards,
  bulkDeleteCards,
  bulkRestoreCards,
  createCard,
  createCardWithTransaction,
  deleteCard,
  getAllTags,
  getBacklinks,
  getCard,
  getCards,
  getCardsPage,
  linkCards,
  loadCards,
  restoreCard,
  unlinkCards,
  updateCard,
} from './cards_service.js';
import {
  assignKJGroup,
  createKJGroup,
  deleteKJGroup,
  loadKJGroups,
  updateKJGroup,
} from './kj_service.js';
import { parseAndImportCSV, parseAndImportJSON } from './import_service.js';
import {
  collectBodySchema,
  collectorConfigSchema,
  createCardSchema,
  systemCreateCardSchema,
  csvImportSchema,
  idsBodySchema,
  jsonImportSchema,
  importArticlesSchema,
  keywordExpandSchema,
  kjAssignSchema,
  kjGroupCreateSchema,
  kjGroupUpdateSchema,
  linkBodySchema,
  runBodySchema,
  schedulerStartSchema,
  updateCardSchema,
} from '../schemas/api_schemas.js';
import {
  AI_PROVIDER,
  expandSearchKeywords,
  hasConfiguredProviderKey,
  isAiSummaryError,
  summarizeCard,
} from './ai_service.js';
import { buildSearchKeywordCandidates, buildSearchMatchMeta } from './search_match_service.js';
import { createJobService } from './job_service.js';

function normalizeCardInput<T extends { url?: string | null; kjGroupId?: string | null; note?: unknown }>(body: T) {
  const { note: _note, ...rest } = body;
  return {
    ...rest,
    url: body.url || undefined,
    kjGroupId: body.kjGroupId ?? undefined,
  };
}

export function createRouteContext(limiters: {
  apiLimiter: express.RequestHandler;
  aiLimiter: express.RequestHandler;
  importLimiter: express.RequestHandler;
  readerLimiter: express.RequestHandler;
}) {
  const collector = createCollectorService();
  const scheduler = createSchedulerService();
  const jobs = createJobService();
  const searchEngine = createSearchEngine();

  function isCollectorConfig(value: unknown) {
    return collectorConfigSchema.safeParse(value).success;
  }

  function resolveCollectorConfig(value: unknown) {
    if (isCollectorConfig(value)) return value as ReturnType<typeof collector.getCollectorConfig>;
    const current = collector.getCollectorConfig();
    if (isCollectorConfig(current)) return current;
    return collector.getDefaultConfig();
  }

  return {
    AI_PROVIDER,
    MODES,
    ...limiters,
    ...collector,
    ...scheduler,
    getCollectRunning: collector.getCollectRunning,
    collectAll: collector.collectAll,
    collectFixture: collector.collectFixture,
    startScheduler: scheduler.startScheduler,
    saveArticles: collector.saveArticles,
    loadArticles: collector.loadArticles,
    ensureArticleTokens: collector.ensureArticleTokens,
    runPipeline: searchEngine.run.bind(searchEngine),
    searchEngine,
    submitJob: jobs.submit,
    getJob: jobs.get,
    listJobs: jobs.list,
    loadCards,
    getCards,
    getCardsPage,
    createCard,
  createCardWithTransaction,
    updateCard,
    deleteCard,
    getCard,
    bulkArchiveCards,
    bulkRestoreCards,
    bulkDeleteCards,
    restoreCard,
    linkCards,
    unlinkCards,
    getBacklinks,
    getAllTags,
    loadKJGroups,
    createKJGroup,
    updateKJGroup,
    deleteKJGroup,
    assignKJGroup,
    parseAndImportCSV,
    parseAndImportJSON,
    buildSearchKeywordCandidates,
    buildSearchMatchMeta,
    expandSearchKeywords,
    summarizeCard,
    hasConfiguredProviderKey,
    isAiSummaryError,
    normalizeCardInput,
    collectorConfigSchema,
    collectBodySchema,
    schedulerStartSchema,
    runBodySchema,
    createCardSchema,
    systemCreateCardSchema,
    updateCardSchema,
    idsBodySchema,
    linkBodySchema,
    csvImportSchema,
    jsonImportSchema,
    importArticlesSchema,
    getArticleById,
    getCandidates,
    getCandidate,
    reviewCandidate,
    saveCandidate,
    expireCandidate,
    expireReviewedCandidates,
    keywordExpandSchema,
    kjGroupCreateSchema,
    kjGroupUpdateSchema,
    kjAssignSchema,
    resolveCollectorConfig,
    bootstrap: async () => {
      // Search tokens are stored. When the tokenizer changes (TOKENIZER=segmenter / kuromoji), rebuild them once.
      const storedTokenizer = (db.prepare("SELECT value FROM collector_settings WHERE key = 'search_tokenizer'").get() as { value: string } | undefined)?.value ?? 'kuromoji';
      const tokenizerChanged = storedTokenizer !== tokenizerName();
      if (tokenizerChanged) logger.info({ event: 'search_tokens_rebuild', from: storedTokenizer, to: tokenizerName() }, 'tokenizer changed: rebuilding search tokens');
      resetInterruptedSiteChecks();
      await backfillCardTokens(tokenizerChanged);
      const retentionDays = Number(process.env.CANDIDATE_RETENTION_DAYS ?? 14);
      if (Number.isInteger(retentionDays) && retentionDays >= 0) expireReviewedCandidates(retentionDays);
      const cachedArticles = collector.getCachedArticles();
      if (cachedArticles) {
        const indexed = await collector.ensureArticleTokens(cachedArticles, tokenizerChanged);
        collector.setCachedArticles(indexed);
        collector.saveArticles(indexed);
      }
      db.prepare("INSERT INTO collector_settings(key, value) VALUES ('search_tokenizer', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(tokenizerName());
    },
  };
}

export type RouteContext = ReturnType<typeof createRouteContext>;
