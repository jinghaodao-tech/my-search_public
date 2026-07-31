import express from 'express';
import type { RouteContext } from '../services/route_context.js';
import { errorMeta, logger } from '../utils/logger.js';
import { getRequestId, parseBody, sendError } from '../services/http_service.js';
import type { Card } from '../domain/card.js';
import type { Article } from '../bm25_engine.js';
import { db } from '../db/database.js';

type SearchInputArticle = Partial<Article> & Pick<Article, 'id' | 'title' | 'body'> & {
  publishedAt: string | Date;
  sourceAuthority?: number;
  url?: string;
};

export function createSearchRouter(ctx: RouteContext) {
  const router = express.Router();

  router.get('/modes', (_req, res) => res.json(ctx.MODES));

  router.post('/run', async (req, res) => {
    const body = parseBody(ctx.runBodySchema, req, res);
    if (!body) return;
    try {
      const { modeId, config, articles: reqArticles, options } = body;
      const rawArticles = (reqArticles ?? ctx.getCachedArticles()?.articles ?? []) as SearchInputArticle[];
      if (!rawArticles.length) {
        res.status(400).json({ error: '記事がありません。先に /api/collect を呼んでください', requestId: getRequestId(req) });
        return;
      }
      const cardsById = new Map(ctx.loadCards().map((card: Card) => [card.id, card]));
      const parsed: Article[] = rawArticles.map(art => {
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
      const result = await ctx.runPipeline(parsed, config, modeId ?? 'custom', options);
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
        active: result.active.map(item => {
          const article = stripSearchFields(item.article);
          const meta = ctx.buildSearchMatchMeta(article, ctx.buildSearchKeywordCandidates(config), item.breakdown?.matchedTerms);
          updateRankingMetadata.run(item.score, rankingReason(item, meta), item.article.id);
          return { ...item, article, ...meta };
        }),
        archived: result.archived.map(item => {
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