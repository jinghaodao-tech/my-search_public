import express from 'express';
import { errorMeta, logger } from '../utils/logger.js';
import { getRequestId, parseBody, sendError } from '../services/http_service.js';

export function createSearchRouter(ctx: any) {
  const router = express.Router();

  router.get('/modes', (_req, res) => res.json(ctx.MODES));

  router.post('/run', async (req, res) => {
    const body = parseBody(ctx.runBodySchema, req, res) as any;
    if (!body) return;
    try {
      const { modeId, config, articles: reqArticles, options } = body;
      const rawArticles = reqArticles ?? ctx.getCachedArticles()?.articles ?? [];
      if (!rawArticles.length) {
        res.status(400).json({ error: '記事がありません。先に /api/collect を実行してください', requestId: getRequestId(req) });
        return;
      }
      const cardsById = new Map(ctx.loadCards().map((card: any) => [card.id, card]));
      const parsed = rawArticles.map((article: any) => {
        const stored = cardsById.get(article.id) as any;
        return {
          ...article,
          title: stored?.title ?? article.title,
          body: stored?.body ?? article.body,
          summary: stored?.summary ?? article.summary,
          tags: stored?.tags ?? article.tags ?? [],
          url: stored?.url ?? article.url ?? '',
          type: stored?.type ?? article.type,
          createdAt: stored?.createdAt ?? article.createdAt,
          updatedAt: stored?.updatedAt ?? article.updatedAt,
          archived: stored?.archived ?? article.archived,
          archivedAt: stored?.archivedAt ?? article.archivedAt,
          publishedAt: new Date(article.publishedAt),
          tokens: stored?.tokens ?? article.tokens,
          docLength: stored?.docLength ?? article.docLength,
        };
      });
      const result = await ctx.runPipeline(parsed, config, modeId ?? 'custom', options);
      const stripSearchFields = (article: any) => {
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
      const response = {
        ...result,
        active: result.active.map((item: any) => {
          const article = stripSearchFields(item.article);
          const meta = ctx.buildSearchMatchMeta(article, ctx.buildSearchKeywordCandidates(config), item.breakdown?.matchedTerms);
          return { ...item, article, ...meta };
        }),
        archived: result.archived.map((item: any) => {
          const article = stripSearchFields(item.article);
          const meta = ctx.buildSearchMatchMeta(article, ctx.buildSearchKeywordCandidates(config));
          return { ...item, article, ...meta };
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
      sendError(req, res, 500, 'Internal server error');
    }
  });

  router.post('/search/expand-keywords', ctx.aiLimiter, async (req, res) => {
    const body = parseBody(ctx.keywordExpandSchema, req, res) as any;
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
        const aiError = err as any;
        logger.warn({
          event: 'ai_keyword_expand_error',
          requestId: getRequestId(req),
          code: aiError.code,
          statusCode: aiError.status,
          provider: ctx.AI_PROVIDER,
          error: errorMeta(aiError),
        }, 'keyword expansion provider error');
        res.status(aiError.status).json({ error: aiError.message, code: aiError.code, requestId: getRequestId(req) });
        return;
      }
      logger.error({ event: 'ai_keyword_expand_error', requestId: getRequestId(req), error: errorMeta(err) }, 'keyword expansion failed');
      sendError(req, res, 500, 'Internal server error', [{ code: 'api_error' }]);
    }
  });

  return router;
}
