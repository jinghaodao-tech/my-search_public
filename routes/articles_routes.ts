import express from 'express';
import { errorMeta, logger } from '../utils/logger.js';
import { getRequestId, invalidRequest, parseBody } from '../services/http_service.js';

export function createArticlesRouter(ctx: any) {
  const router = express.Router();

  router.post('/cards/import-csv', ctx.importLimiter, (req, res) => {
    const body = parseBody(ctx.csvImportSchema, req, res) as any;
    if (!body) return;
    try {
      const imported = ctx.parseAndImportCSV(body.csv);
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

  router.post('/cards/import-json', ctx.importLimiter, (req, res) => {
    const body = parseBody(ctx.jsonImportSchema, req, res) as any;
    if (!body) return;
    try {
      const result = ctx.parseAndImportJSON(body.json);
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
    const { articleIds }: { articleIds?: string[] } = req.body;
    const articles = ctx.getCachedArticles()?.articles ?? [];
    const targets = articleIds
      ? articles.filter((article: any) => articleIds.includes(article.id))
      : articles;

    const existing = new Set(ctx.loadCards().map((card: any) => card.id));
    const imported: any[] = [];

    for (const article of targets) {
      if (existing.has(`card_from_${article.id}`)) continue;
      const card = await ctx.createCard({
        id: `card_from_${article.id}`,
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
