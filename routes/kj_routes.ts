import express from 'express';
import type { RouteContext } from '../services/route_context.js';
import { parseBody, sendError } from '../services/http_service.js';
import type { Card } from '../domain/card.js';

export function createKjRouter(ctx: RouteContext) {
  const router = express.Router();

  router.get('/kj/groups', (_req, res) => {
    const groups = ctx.loadKJGroups();
    const cards = ctx.loadCards();
    const result = groups.map(group => ({
      ...group,
      cards: cards.filter((card: Card) => card.kjGroupId === group.id),
    }));
    const ungrouped = cards.filter((card: Card) => !card.kjGroupId);
    res.json({ groups: result, ungrouped });
  });

  router.post('/kj/groups', (req, res) => {
    const body = parseBody(ctx.kjGroupCreateSchema, req, res);
    if (!body) return;
    const { name, description, color } = body;
    const group = ctx.createKJGroup(name, description, color);
    res.status(201).json(group);
  });

  router.put('/kj/groups/:id', (req, res) => {
    const body = parseBody(ctx.kjGroupUpdateSchema, req, res);
    if (!body) return;
    const group = ctx.updateKJGroup(req.params.id, body);
    if (!group) { sendError(req, res, 404, 'Not found'); return; }
    res.json(group);
  });

  router.delete('/kj/groups/:id', (req, res) => {
    ctx.deleteKJGroup(req.params.id);
    res.json({ ok: true });
  });

  router.post('/kj/groups/:id/cards', async (req, res) => {
    const body = parseBody(ctx.kjAssignSchema, req, res);
    if (!body) return;
    await ctx.assignKJGroup(body.cardId, req.params.id);
    res.json({ ok: true });
  });

  router.delete('/kj/groups/:id/cards/:cardId', async (req, res) => {
    await ctx.assignKJGroup(req.params.cardId, null);
    res.json({ ok: true });
  });

  return router;
}

