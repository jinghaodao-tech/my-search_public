import express from 'express';
import { markdownContentDisposition } from '../utils/markdown_export.js';
import { errorMeta, logger } from '../utils/logger.js';
import { buildBulkMarkdownZip, buildCardMarkdown } from '../services/export_service.js';
import { getRequestId, invalidRequest, parseBody, sendError } from '../services/http_service.js';

export function createCardsRouter(ctx: any) {
  const router = express.Router();

  router.get('/cards', (req, res) => {
    const { tag, kjGroupId, type, q, archived } = req.query as Record<string, string>;
    res.json(ctx.getCards({
      tag,
      kjGroupId,
      type,
      q,
      archived: archived === 'true' ? true : archived === 'false' ? false : undefined,
    }));
  });

  router.post('/cards', async (req, res) => {
    const body = parseBody(ctx.createCardSchema, req, res) as any;
    if (!body) return;
    try {
      const card = await ctx.createCard({ type: 'memo', ...ctx.normalizeCardInput(body) });
      res.status(201).json(card);
    } catch (err) {
      logger.warn({ event: 'card_create_error', requestId: getRequestId(req), error: errorMeta(err) }, 'card create failed');
      sendError(req, res, 400, 'Invalid request');
    }
  });

  router.get('/cards/:id', (req, res) => {
    const card = ctx.getCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found'); return; }
    const backlinks = ctx.getBacklinks(req.params.id);
    res.json({ ...card, backlinks });
  });

  router.get('/cards/:id/export-md', (req, res) => {
    const card = ctx.getCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found'); return; }
    const { markdown, filename } = buildCardMarkdown(card);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', markdownContentDisposition(filename));
    res.send(markdown);
  });

  router.post('/cards/export-md-bulk', (req, res) => {
    const body = parseBody(ctx.idsBodySchema, req, res) as any;
    if (!body) return;
    const result = buildBulkMarkdownZip(body.ids);
    if (!result) {
      sendError(req, res, 404, 'Not found');
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', markdownContentDisposition(result.filename));
    res.send(result.zip);
  });

  router.put('/cards/:id', async (req, res) => {
    const body = parseBody(ctx.updateCardSchema, req, res) as any;
    if (!body) return;
    const card = await ctx.updateCard(req.params.id, ctx.normalizeCardInput(body));
    if (!card) { sendError(req, res, 404, 'Not found'); return; }
    res.json(card);
  });

  router.delete('/cards/:id', (req, res) => {
    const ok = ctx.deleteCard(req.params.id);
    res.json({ ok });
  });

  router.put('/cards/:id/archive', async (req, res) => {
    const card = await ctx.updateCard(req.params.id, { archived: true, archivedAt: new Date().toISOString() });
    if (!card) { sendError(req, res, 404, 'Not found'); return; }
    res.json(card);
  });

  router.put('/cards/:id/unarchive', async (req, res) => {
    const card = await ctx.restoreCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found'); return; }
    res.json(card);
  });

  router.post('/cards/:id/restore', async (req, res) => {
    const card = await ctx.restoreCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found'); return; }
    res.json(card);
  });

  router.post('/cards/archive-bulk', async (req, res) => {
    const body = parseBody(ctx.idsBodySchema, req, res) as any;
    if (!body) return;
    const now = new Date().toISOString();
    const updated: string[] = [];
    for (const id of body.ids) {
      const card = await ctx.updateCard(id, { archived: true, archivedAt: now });
      if (card) updated.push(id);
    }
    res.json({ ok: true, updated });
  });

  router.post('/cards/bulk-archive', (req, res) => {
    const body = parseBody(ctx.idsBodySchema, req, res) as any;
    if (!body) return;
    const updated = ctx.bulkArchiveCards(body.ids);
    res.json({ ok: true, updated });
  });

  router.post('/cards/bulk-restore', (req, res) => {
    const body = parseBody(ctx.idsBodySchema, req, res) as any;
    if (!body) return;
    const updated = ctx.bulkRestoreCards(body.ids);
    res.json({ ok: true, updated });
  });

  router.post('/cards/bulk-delete', (req, res) => {
    const body = parseBody(ctx.idsBodySchema, req, res) as any;
    if (!body) return;
    const deleted = ctx.bulkDeleteCards(body.ids);
    res.json({ ok: true, deleted });
  });

  router.post('/cards/:id/links', (req, res) => {
    const body = parseBody(ctx.linkBodySchema, req, res) as any;
    if (!body) return;
    if (req.params.id === body.targetId) {
      invalidRequest(req, res, [{ path: 'targetId', message: 'Cannot link a card to itself' }]);
      return;
    }
    if (!ctx.getCard(req.params.id) || !ctx.getCard(body.targetId)) {
      sendError(req, res, 404, 'Not found');
      return;
    }
    ctx.linkCards(req.params.id, body.targetId);
    res.json({ ok: true });
  });

  router.delete('/cards/:id/links/:targetId', (req, res) => {
    ctx.unlinkCards(req.params.id, req.params.targetId);
    res.json({ ok: true });
  });

  router.get('/cards/:id/backlinks', (req, res) => {
    res.json(ctx.getBacklinks(req.params.id));
  });

  router.get('/zettelkasten/graph', (_req, res) => {
    const cards = ctx.loadCards();
    const linkedIds = new Set<string>();
    for (const card of cards) {
      if (card.links?.length) {
        linkedIds.add(card.id);
        for (const linkId of card.links) linkedIds.add(linkId);
      }
    }
    const visibleCards = cards.filter((card: any) => linkedIds.has(card.id));
    const nodes = visibleCards.map((card: any) => ({
      id: card.id,
      label: card.title.slice(0, 40),
      title: card.summary ?? card.body.slice(0, 100),
      group: card.type,
      color: card.color,
    }));
    const edgesSet = new Set<string>();
    const edges: { from: string; to: string }[] = [];
    for (const card of visibleCards) {
      for (const linkId of card.links) {
        if (!linkedIds.has(linkId)) continue;
        const key = [card.id, linkId].sort().join('--');
        if (!edgesSet.has(key)) {
          edgesSet.add(key);
          edges.push({ from: card.id, to: linkId });
        }
      }
    }
    res.json({ nodes, edges });
  });

  router.get('/tags', (_req, res) => res.json(ctx.getAllTags()));

  return router;
}
