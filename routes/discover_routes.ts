import express from 'express';
import { z } from 'zod';
import type { RouteContext } from '../services/route_context.js';
import { parseBody, sendError } from '../services/http_service.js';
import { DISCOVER_SOURCES, FIELD_PRESETS, PROVIDERS, discover, fallbackQueries, feedsForFields } from '../services/discover_service.js';
import { logger } from '../utils/logger.js';

const discoverSchema = z.object({
  purpose: z.string().trim().max(500).default(''),
  queries: z.array(z.string().trim().min(1).max(100)).max(4).optional(),
  sources: z.array(z.enum(DISCOVER_SOURCES as [string, ...string[]])).max(4).optional(),
  fields: z.array(z.string().trim().max(50)).max(10).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict().refine(value => value.purpose.length > 0 || (value.queries?.length ?? 0) > 0, { message: 'purpose or queries is required' });

export function createDiscoverRouter(ctx: RouteContext) {
  const router = express.Router();

  router.get('/discover/sources', (_req, res) => {
    res.json({
      sources: DISCOVER_SOURCES.map(id => ({ id, label: PROVIDERS[id].label })),
      fields: FIELD_PRESETS.map(({ id, label, kind, feeds }) => ({ id, label, kind, feedCount: feeds.length })),
    });
  });

  // Queries without AI: the words of the purpose (used when the browser has no on-device AI).
  router.post('/discover/queries', async (req, res) => {
    const body = parseBody(z.object({ purpose: z.string().trim().min(2).max(500) }).strict(), req, res);
    if (!body) return;
    res.json({ queries: await fallbackQueries(body.purpose), method: 'words' });
  });

  router.post('/discover', ctx.readerLimiter, async (req, res) => {
    const body = parseBody(discoverSchema, req, res);
    if (!body) return;
    try {
      const result = await discover({
        purpose: body.purpose,
        queries: body.queries,
        sources: body.sources as never,
        feeds: feedsForFields(body.fields ?? []),
        limit: body.limit,
      });
      logger.info({ event: 'discover', queries: result.queries.length, fetched: result.stats.fetched, ranked: result.stats.ranked }, 'discover');
      res.json(result);
    } catch (err) {
      sendError(req, res, 500, 'discover_failed', (err as Error).message);
    }
  });

  return router;
}
