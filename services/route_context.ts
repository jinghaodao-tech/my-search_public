import type express from 'express';
import { MODES, runPipeline } from './search_service.js';
import {
  collectAll,
  DEFAULT_CONFIG,
  ensureArticleTokens,
  loadArticles,
  saveArticles,
  startScheduler,
  type CollectResult,
  type CollectorConfig,
} from '../collector.js';
import {
  backfillCardTokens,
  bulkArchiveCards,
  bulkDeleteCards,
  bulkRestoreCards,
  createCard,
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
} from '../repositories/kj_groups_repository.js';
import {
  parseAndImportCSV,
  parseAndImportJSON,
} from './import_service.js';
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
import {
  buildSearchKeywordCandidates,
  buildSearchMatchMeta,
} from './search_match_service.js';

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
}) {
  let cachedArticles: CollectResult | null = loadArticles();
  let collectorConfig: CollectorConfig = DEFAULT_CONFIG;
  let schedulerStop: (() => void) | null = null;
  let schedulerCronExpr: string | null = null;
  let collectRunning = false;

  function isCollectorConfig(value: unknown): value is CollectorConfig {
    return collectorConfigSchema.safeParse(value).success;
  }

  function resolveCollectorConfig(value: unknown): CollectorConfig {
    if (isCollectorConfig(value)) return value;
    if (isCollectorConfig(collectorConfig)) return collectorConfig;
    return DEFAULT_CONFIG;
  }

  return {
    AI_PROVIDER,
    MODES,
    ...limiters,
    collectAll,
    startScheduler,
    saveArticles,
    loadArticles,
    ensureArticleTokens,
    runPipeline,
    loadCards,
    getCards,
    getCardsPage,
    createCard,
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
    keywordExpandSchema,
    kjGroupCreateSchema,
    kjGroupUpdateSchema,
    kjAssignSchema,
    getCachedArticles: () => cachedArticles,
    setCachedArticles: (value: CollectResult | null) => { cachedArticles = value; },
    getCollectorConfig: () => collectorConfig,
    setCollectorConfig: (value: CollectorConfig) => { collectorConfig = value; },
    resolveCollectorConfig,
    getSchedulerStop: () => schedulerStop,
    setSchedulerStop: (value: (() => void) | null) => { schedulerStop = value; },
    getSchedulerCronExpr: () => schedulerCronExpr,
    setSchedulerCronExpr: (value: string | null) => { schedulerCronExpr = value; },
    getCollectRunning: () => collectRunning,
    setCollectRunning: (value: boolean) => { collectRunning = value; },
    bootstrap: async () => {
      await backfillCardTokens();
      if (cachedArticles) {
        cachedArticles = await ensureArticleTokens(cachedArticles);
        saveArticles(cachedArticles);
      }
    },
  };
}


export type RouteContext = ReturnType<typeof createRouteContext>;