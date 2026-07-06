import express from 'express';
import type { RouteContext } from '../services/route_context.js';
import { errorMeta, logger } from '../utils/logger.js';
import { getRequestId, invalidRequest, parseBody } from '../services/http_service.js';
import type { Article } from '../bm25_engine.js';
import type { Card } from '../domain/card.js';

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

  router.post('/cards/import-articles', async (req, res) => {
    const body = parseBody(ctx.importArticlesSchema, req, res);
    if (!body) return;
    const { articleIds } = body;
    const articles = ctx.getCachedArticles()?.articles ?? [];
    const targets = articleIds
      ? articles.filter((article: Article) => articleIds.includes(article.id))
      : articles;

    const existing = new Set(ctx.loadCards().map((card: Card) => card.id));
    const imported: Card[] = [];

    for (const article of targets) {
      if (existing.has(`card_from_${article.id}`)) continue;
      const card = await ctx.createCard({
        title: article.title,
        body: article.body,
        url: article.url,
        tags: [],
        type: 'article',
      });
      imported.push(card);
    }
    res.json({ ok: true, count: imported.length });
  });

  return router;
}