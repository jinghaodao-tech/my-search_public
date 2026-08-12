import express from 'express';
import type { RouteContext } from '../services/route_context.js';
import { markdownContentDisposition } from '../utils/markdown_export.js';
import { errorMeta, logger } from '../utils/logger.js';
import { buildBulkMarkdownZip, buildCardMarkdown } from '../services/export_service.js';
import { getRequestId, invalidRequest, parseBody, sendError } from '../services/http_service.js';
import { cardListQuerySchema } from '../schemas/api_schemas.js';
import type { Card } from '../domain/card.js';

function parseCardSort(value: unknown): 'created_at_asc' | 'created_at_desc' | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === 'created_at_asc' || raw === 'created_at_desc') return raw;
  if (raw === 'createdAtAsc') return 'created_at_asc';
  if (raw === 'createdAtDesc') return 'created_at_desc';
  return undefined;
}


function normalizeQueryNumber(value: unknown, min: number, max: number): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return undefined;
  return Math.min(parsed, max);
}
export function createCardsRouter(ctx: RouteContext) {
  const router = express.Router();

  router.get('/cards', (req, res) => {
    const rawQuery = req.query as Record<string, unknown>;
    const parsedQuery = cardListQuerySchema.safeParse({ ...rawQuery, limit: normalizeQueryNumber(rawQuery.limit, 1, 100), offset: normalizeQueryNumber(rawQuery.offset, 0, Number.MAX_SAFE_INTEGER) });
    if (!parsedQuery.success) { invalidRequest(req, res, parsedQuery.error.issues); return; }
    const { tag, kjGroupId, type, q, archived, limit, offset, sort } = parsedQuery.data;
    const filters = {
      tag,
      kjGroupId,
      type,
      q,
      archived: archived === 'true' ? true : archived === 'false' ? false : undefined,
      limit,
      offset,
      sort: parseCardSort(sort),
    };

    if (typeof limit !== 'undefined' || typeof offset !== 'undefined') {
      res.json(ctx.getCardsPage(filters));
      return;
    }

    res.json(ctx.getCards(filters));
  });

  router.post('/cards', async (req, res) => {
    const body = parseBody(ctx.createCardSchema, req, res);
    if (!body) return;
    try {
      const card = await ctx.createCard({ type: 'memo', ...ctx.normalizeCardInput(body) });
      res.status(201).json(card);
    } catch (err) {
      logger.warn({ event: 'card_create_error', requestId: getRequestId(req), error: errorMeta(err) }, 'card create failed');
      sendError(req, res, 500, 'Internal server error', undefined, 'card_create_failed');
    }
  });

  router.get('/cards/:id', (req, res) => {
    const card = ctx.getCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    const backlinks = ctx.getBacklinks(req.params.id);
    res.json({ ...card, backlinks });
  });

  router.get('/cards/:id/export-md', (req, res) => {
    try {
    const card = ctx.getCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    const { markdown, filename } = buildCardMarkdown(card);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', markdownContentDisposition(filename));
    res.send(markdown);
    } catch { sendError(req, res, 500, 'Export failed', undefined, 'export_failed'); }
  });

  router.post('/cards/export-md-bulk', (req, res) => {
    try {
    const body = parseBody(ctx.idsBodySchema, req, res);
    if (!body) return;
    const result = buildBulkMarkdownZip(body.ids);
    if (!result) {
      sendError(req, res, 404, 'Not found', undefined, 'card_not_found');
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', markdownContentDisposition(result.filename));
    res.send(result.zip);
    } catch { sendError(req, res, 500, 'Export failed', undefined, 'export_failed'); }
  });

  router.put('/cards/:id', async (req, res) => {
    const body = parseBody(ctx.updateCardSchema, req, res);
    if (!body) return;
    const card = await ctx.updateCard(req.params.id, ctx.normalizeCardInput(body));
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    res.json(card);
  });

  router.delete('/cards/:id', (req, res) => {
    const ok = ctx.deleteCard(req.params.id);
    if (!ok) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    res.json({ ok });
  });

  router.put('/cards/:id/archive', async (req, res) => {
    const card = await ctx.updateCard(req.params.id, { archived: true, archivedAt: new Date().toISOString() });
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    res.json(card);
  });

  router.put('/cards/:id/unarchive', async (req, res) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', 'use POST /cards/:id/restore');
    const card = await ctx.restoreCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    res.json(card);
  });

  router.post('/cards/:id/restore', async (req, res) => {
    const card = await ctx.restoreCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    res.json(card);
  });

  router.post('/cards/archive-bulk', (req, res) => {
    res.setHeader('Deprecation', 'true');
    const body = parseBody(ctx.idsBodySchema, req, res);
    if (!body) return;
    const updated = ctx.bulkArchiveCards(body.ids);
    res.json({ ok: true, updated });
  });

  router.post('/cards/bulk-archive', (req, res) => {
    const body = parseBody(ctx.idsBodySchema, req, res);
    if (!body) return;
    const updated = ctx.bulkArchiveCards(body.ids);
    res.json({ ok: true, updated });
  });

  router.post('/cards/bulk-restore', (req, res) => {
    const body = parseBody(ctx.idsBodySchema, req, res);
    if (!body) return;
    const updated = ctx.bulkRestoreCards(body.ids);
    res.json({ ok: true, updated });
  });

  router.post('/cards/bulk-delete', (req, res) => {
    const body = parseBody(ctx.idsBodySchema, req, res);
    if (!body) return;
    const deleted = ctx.bulkDeleteCards(body.ids);
    res.json({ ok: true, deleted });
  });

  router.post('/cards/:id/links', (req, res) => {
    const body = parseBody(ctx.linkBodySchema, req, res);
    if (!body) return;
    if (req.params.id === body.targetId) {
      invalidRequest(req, res, [{ path: 'targetId', message: 'Cannot link a card to itself' }]);
      return;
    }
    if (!ctx.getCard(req.params.id) || !ctx.getCard(body.targetId)) {
      sendError(req, res, 404, 'Not found', undefined, 'card_not_found');
      return;
    }
    ctx.linkCards(req.params.id, body.targetId);
    res.json({ ok: true });
  });

  router.delete('/cards/:id/links/:targetId', (req, res) => {
    if (!ctx.getCard(req.params.id) || !ctx.getCard(req.params.targetId)) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    if (!ctx.unlinkCards(req.params.id, req.params.targetId)) { sendError(req, res, 404, 'Link not found', undefined, 'link_not_found'); return; }
    res.json({ ok: true });
  });

  router.get('/cards/:id/backlinks', (req, res) => {
    if (!ctx.getCard(req.params.id)) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    res.json(ctx.getBacklinks(req.params.id));
  });

  router.get('/zettelkasten/graph', (req, res) => {
    const rawQuery = req.query as Record<string, unknown>;
    const limit = normalizeQueryNumber(rawQuery.limit, 1, 5000) ?? 1000;
    const offset = normalizeQueryNumber(rawQuery.offset, 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const cards = ctx.loadCards();
    const linkedIds = new Set<string>();
    for (const card of cards) {
      if (card.links?.length) {
        linkedIds.add(card.id);
        for (const linkId of card.links) linkedIds.add(linkId);
      }
    }
    const allVisibleCards = cards.filter((card: Card) => linkedIds.has(card.id));
    const visibleCards = allVisibleCards.slice(offset, offset + limit);
    const nodes = visibleCards.map((card: Card) => ({
      id: card.id,
      label: card.title.slice(0, 40),
      title: card.summary ?? card.body.slice(0, 100),
      group: card.type,
      color: card.color,
    }));
    const edges: { from: string; to: string }[] = [];
    for (const card of visibleCards) {
      for (const linkId of card.links) {
        if (!linkedIds.has(linkId)) continue;
        edges.push({ from: card.id, to: linkId });
      }
    }
    res.json({ nodes, edges, total: allVisibleCards.length, limit, offset });
  });

  router.get('/tags', (req, res) => {
    const rawQuery = req.query as Record<string, unknown>;
    const limit = normalizeQueryNumber(rawQuery.limit, 1, 5000) ?? 1000;
    const offset = normalizeQueryNumber(rawQuery.offset, 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const tags = ctx.getAllTags();
    if (typeof rawQuery.limit === 'undefined' && typeof rawQuery.offset === 'undefined') { res.json(tags); return; }
    res.json({ items: tags.slice(offset, offset + limit), total: tags.length, limit, offset });
  });

  return router;
}

