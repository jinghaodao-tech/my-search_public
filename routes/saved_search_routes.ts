import express from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db } from '../db/database.js';
import { savedSearchSchema } from '../schemas/api_schemas.js';
import { parseBody, sendError } from '../services/http_service.js';

export function createSavedSearchRouter() {
  const router = express.Router();
  router.post('/saved-searches/:id/checkpoint', (req, res) => {
    const body = parseBody(z.object({ checkedAt: z.string().datetime() }).strict(), req, res);
    if (!body) return;
    if (body.checkedAt > new Date().toISOString()) { sendError(req, res, 400, 'Future checkpoint'); return; }
    if (!db.prepare('SELECT id FROM saved_searches WHERE id = ?').get(req.params.id)) { sendError(req, res, 404, 'Search not found'); return; }
    db.prepare(`INSERT INTO search_checkpoints VALUES (?, ?) ON CONFLICT(search_id) DO UPDATE SET checked_at = MAX(checked_at, excluded.checked_at)`).run(req.params.id, body.checkedAt);
    res.json({ checkedAt: body.checkedAt });
  });
  router.get('/saved-searches', (_req, res) => {
    const rows = db.prepare('SELECT * FROM saved_searches ORDER BY updated_at DESC').all() as Array<{ id: string; payload: string; updated_at: string }>;
    res.json(rows.map(row => ({ ...JSON.parse(row.payload), id: row.id, checkedAt: (db.prepare('SELECT checked_at FROM search_checkpoints WHERE search_id = ?').get(row.id) as { checked_at: string } | undefined)?.checked_at, updatedAt: row.updated_at })));
  });
  router.post('/saved-searches', (req, res) => {
    const body = parseBody(savedSearchSchema, req, res);
    if (!body) return;
    const id = randomUUID();
    db.prepare('INSERT INTO saved_searches VALUES (?, ?, ?)').run(id, JSON.stringify(body), new Date().toISOString());
    res.status(201).json({ ...body, id });
  });
  router.put('/saved-searches/:id', (req, res) => {
    const body = parseBody(savedSearchSchema, req, res);
    if (!body) return;
    const result = db.prepare('UPDATE saved_searches SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(body), new Date().toISOString(), req.params.id);
    if (!result.changes) { sendError(req, res, 404, 'Search not found'); return; }
    res.json({ ...body, id: req.params.id });
  });
  router.delete('/saved-searches/:id', (req, res) => {
    db.prepare('DELETE FROM saved_searches WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });
  return router;
}
