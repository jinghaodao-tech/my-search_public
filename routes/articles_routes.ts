import express from 'express';
import type { RouteContext } from '../services/route_context.js';
import { errorMeta, logger } from '../utils/logger.js';
import { getRequestId, invalidRequest, parseBody } from '../services/http_service.js';
import type { Article } from '../bm25_engine.js';
import type { Card } from '../domain/card.js';
import { getArticleById, loadArticlesFromDb } from '../repositories/articles_repository.js';

export function createArticlesRouter(ctx: RouteContext) {
  const router = express.Router();

  router.post('/cards/import-csv', ctx.importLimiter, async (req, res) => {
    const body = parseBody(ctx.csvImportSchema, req, res);
    if (!body) return;
    try {
      const imported = await ctx.parseAndImportCSV(body.csv);
      if (!imported.length) {
        invalidRequest(req, res, [{ path: 'csv', message: 'CSV must include a header and at least one valid row' }]);
        return;
      }
      res.json({ ok: true, count: imported.length, cards: imported });
    } catch (err) {
      logger.warn({ event: 'import_error', requestId: getRequestId(req), importer: 'csv', error: errorMeta(err) }, 'CSV import failed');
      invalidRequest(req, res, 'Import failed');
    }
  });

  router.post('/cards/import-json', ctx.importLimiter, async (req, res) => {
    const body = parseBody(ctx.jsonImportSchema, req, res);
    if (!body) return;
    try {
      const result = await ctx.parseAndImportJSON(body.json);
      if (!result.cards.length) {
        invalidRequest(req, res, [{ path: 'json', message: 'JSON must contain at least one importable card' }]);
        return;
      }
      res.json({ ok: true, count: result.cards.length, warnings: result.warnings, cards: result.cards });
    } catch (err) {
      logger.warn({ event: 'import_error', requestId: getRequestId(req), importer: 'json', error: errorMeta(err) }, 'JSON import failed');
      invalidRequest(req, res, 'Import failed');
    }
  });

  router.post('/cards/import-articles', ctx.importLimiter, async (req, res) => {
    const body = parseBody(ctx.importArticlesSchema, req, res);
    if (!body) return;
    try {
      const { articleIds } = body;
      const targets = articleIds ? articleIds.map(getArticleById).filter((a): a is Article => !!a) : loadArticlesFromDb();
      const existing = new Set(ctx.loadCards().filter(card => card.type === 'article').map(card => card.id));
      const imported: Card[] = [];
      for (const article of targets) {
        const candidate = ctx.getCandidate(article.id);
        if (candidate?.savedCardId || candidate?.status === 'expired') continue;
        if (existing.has(`card_from_${article.id}`)) {
          ctx.saveCandidate(article.id, `card_from_${article.id}`);
          continue;
        }
        try {
          imported.push(await ctx.createCardWithTransaction({ title: article.title, body: article.body, url: article.url, tags: article.tags ?? [], type: 'article' }, card => {
            if (!ctx.saveCandidate(article.id, card.id)) throw new Error('article_import_conflict');
          }));
        } catch (error) {
          if ((error as Error).message !== 'article_import_conflict') throw error;
        }
      }
      res.json({ ok: true, count: imported.length });
    } catch (err) {
      logger.error({ event: 'article_import_error', requestId: getRequestId(req), error: errorMeta(err) }, 'article import failed');
      res.status(500).json({ error: 'Internal server error', code: 'article_import_failed', requestId: getRequestId(req) });
    }
  });

  return router;
}
