import { loadArticlesFromDb } from '../repositories/articles_repository.js';
import { buildSearchSnippet } from '../services/search_match_service.js';
import express from 'express';
import type { RouteContext } from '../services/route_context.js';
import { errorMeta, logger } from '../utils/logger.js';
import { getRequestId, parseBody, sendError } from '../services/http_service.js';
import type { Card } from '../domain/card.js';
import type { Article } from '../bm25_engine.js';
import { buildStoredTokenSet } from '../bm25_engine.js';
import { db } from '../db/database.js';
import { DEMO_SEARCH_MODE, isDemoMode } from '../services/demo_service.js';

type SearchInputArticle = Partial<Article> & Pick<Article, 'id' | 'title' | 'body'> & {
  publishedAt: string | Date;
  sourceAuthority?: number;
  url?: string;
};

export function createSearchRouter(ctx: RouteContext) {
  const router = express.Router();

  // Demo: a first preset whose words match the sample documents, so the first search finds them.
  router.get('/modes', (_req, res) => res.json(isDemoMode() ? { demo: DEMO_SEARCH_MODE, ...ctx.MODES } : ctx.MODES));

  router.post('/run', async (req, res) => {
    const body = parseBody(ctx.runBodySchema, req, res);
    if (!body) return;
    try {
      const { modeId, config, articles: reqArticles, options, filters } = body;
      const rawArticles = (reqArticles ?? loadArticlesFromDb()) as SearchInputArticle[];
      const candidates = new Map(ctx.getCandidates().map(candidate => [candidate.candidateId, candidate]));
      const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
      const filteredArticles = rawArticles.filter(article => {
        const candidate = reqArticles ? undefined : candidates.get(article.id);
        if (filters?.since && (!candidate || candidate.firstSeenAt <= filters.since)) return false;
        if (candidate?.status === 'expired') return false;
        if (filters?.status && filters.status !== 'all' && candidate?.status !== filters.status) return false;
        if (filters?.sources.length && !filters.sources.includes(article.source ?? 'unknown')) return false;
        const content = normalize(`${article.title} ${article.body} ${article.summary ?? ''}`);
        return !filters?.excludedTerms.some(term => content.includes(normalize(term)));
      });
      const scope = {
        corpus: reqArticles ? 'cards' : 'articles',
        totalCount: rawArticles.length,
        searchedCount: filteredArticles.length,
        sources: [...new Set(filteredArticles.map(article => article.source ?? (reqArticles ? '保存済みカード' : 'unknown')))],
        availableSources: [...new Set(rawArticles.map(article => article.source ?? 'unknown'))],
      };
      const cardsById = new Map(ctx.loadCards().map((card: Card) => [card.id, card]));
      const parsed: Article[] = filteredArticles.map(art => {
        const stored = cardsById.get(art.id);
        return {
          id: art.id,
          title: stored?.title ?? art.title,
          body: stored?.body ?? art.body,
          publishedAt: new Date(art.publishedAt),
          sourceAuthority: art.sourceAuthority ?? 0,
          url: stored?.url ?? art.url ?? '',
          source: art.source ?? undefined,
          tokens: stored?.tokens ?? art.tokens,
          docLength: stored?.docLength ?? art.docLength,
          summary: stored?.summary ?? art.summary ?? undefined,
          tags: stored?.tags ?? art.tags ?? [],
          type: stored?.type ?? art.type ?? undefined,
          createdAt: stored?.createdAt ?? art.createdAt ?? undefined,
          updatedAt: stored?.updatedAt ?? art.updatedAt ?? undefined,
          archived: stored?.archived ?? art.archived ?? undefined,
          archivedAt: stored?.archivedAt ?? art.archivedAt ?? undefined,
        };
      });
      for (const article of parsed) {
        if (!article.tokens?.length) {
          const stored = await buildStoredTokenSet(`${article.title} ${article.body}`);
          Object.assign(article, stored, { tokens: stored.ngramTokens, docLength: stored.ngramDocLength });
        }
      }
      const result = await ctx.runPipeline(parsed, config, modeId ?? 'custom', reqArticles ? options : { ...options, dedupThreshold: 1 });
      const stripSearchFields = (article: Article) => {
        const { tokens: _tokens, docLength: _docLength, ...publicArticle } = article;
        return {
          ...publicArticle,
          summary: publicArticle.summary ?? null,
          tags: publicArticle.tags ?? [],
          type: publicArticle.type ?? 'article',
          createdAt: publicArticle.createdAt ?? publicArticle.publishedAt,
          archived: publicArticle.archived ?? false,
        };
      };
      const updateRankingMetadata = db.prepare("UPDATE articles SET candidate_score = ?, candidate_match_reason = ?, updated_at = updated_at WHERE id = ?");
      const rankingReason = (item: { breakdown?: { matchedTerms?: Array<{ term?: string }> } }, meta: { matchedFields: string[]; matchedKeywords: string[] }) => {
        const fields = meta.matchedFields.length ? meta.matchedFields.join(", ") : "本文一致";
        const keywords = meta.matchedKeywords.length ? `キーワード: ${meta.matchedKeywords.join(", ")}` : "キーワード一致";
        return `${fields} / ${keywords}`;
      };
      const response = {
        ...result,
        scope,
        active: result.active.map(item => {
          const article = stripSearchFields(item.article);
          const meta = ctx.buildSearchMatchMeta(article, ctx.buildSearchKeywordCandidates(config), item.breakdown?.matchedTerms);
          updateRankingMetadata.run(item.score, rankingReason(item, meta), item.article.id);
          return { ...item, article, ...meta,
            snippet: buildSearchSnippet(article, [...meta.matchedKeywords, ...ctx.buildSearchKeywordCandidates(config)]),
            candidate: reqArticles ? null : candidates.get(article.id) ? { status: candidates.get(article.id)!.status, savedCardId: candidates.get(article.id)!.savedCardId } : null,
          };
        }),
        archived: result.archived.map(item => {
          const article = stripSearchFields(item.article);
          const meta = ctx.buildSearchMatchMeta(article, ctx.buildSearchKeywordCandidates(config));
          return { ...item, article, ...meta,
            snippet: buildSearchSnippet(article, [...meta.matchedKeywords, ...ctx.buildSearchKeywordCandidates(config)]),
            candidate: reqArticles ? null : candidates.get(article.id) ? { status: candidates.get(article.id)!.status, savedCardId: candidates.get(article.id)!.savedCardId } : null,
          };
        }),
      };
      logger.debug({
        event: 'search_results',
        requestId: getRequestId(req),
        resultCount: response.active.length + response.archived.length,
      }, 'BM25 search results prepared');
      res.json(response);
    } catch (err) {
      logger.error({ event: 'search_error', requestId: getRequestId(req), error: errorMeta(err) }, 'BM25 search failed');
      sendError(req, res, 500, 'Internal server error', undefined, 'search_failed');
    }
  });

  router.post('/search/expand-keywords', ctx.aiLimiter, async (req, res) => {
    const body = parseBody(ctx.keywordExpandSchema, req, res);
    if (!body) return;
    try {
      const original = new Set(body.keywords.map((keyword: string) => keyword.toLowerCase()));
      const seen = new Set(original);
      const expandedKeywords = (await ctx.expandSearchKeywords(body.keywords))
        .map((keyword: string) => keyword.trim())
        .filter((keyword: string) => {
          const key = keyword.toLowerCase();
          if (!keyword || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 10);
      res.json({ expandedKeywords });
    } catch (err) {
      if (ctx.isAiSummaryError(err)) {
        logger.warn({
          event: 'ai_keyword_expand_error',
          requestId: getRequestId(req),
          code: err.code,
          statusCode: err.status,
          provider: ctx.AI_PROVIDER,
          error: errorMeta(err),
        }, 'keyword expansion provider error');
        res.status(err.status).json({ error: err.message, code: err.code, requestId: getRequestId(req) });
        return;
      }
      logger.error({ event: 'ai_keyword_expand_error', requestId: getRequestId(req), error: errorMeta(err) }, 'keyword expansion failed');
      sendError(req, res, 500, 'Internal server error', [{ code: 'api_error' }]);
    }
  });

  return router;
}