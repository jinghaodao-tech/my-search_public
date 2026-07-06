import express from 'express';
import type { RouteContext } from '../services/route_context.js';
import { errorMeta, logger } from '../utils/logger.js';
import { getRequestId, parseBody, sendError } from '../services/http_service.js';
import type { CollectResult } from '../collector.js';

export function createCollectRouter(ctx: RouteContext) {
  const router = express.Router();

  router.get('/articles', (_req, res) => {
    const cachedArticles = ctx.getCachedArticles();
    if (!cachedArticles) {
      res.json({ articles: [], stats: null, message: '譛ｪ蜿朱寔縲・api/collect 繧貞他繧薙〒縺上□縺輔＞' });
      return;
    }
    res.json(cachedArticles);
  });

  router.post(['/collect', '/articles/refresh'], ctx.apiLimiter, async (req, res) => {
    const body = parseBody(ctx.collectBodySchema, req, res);
    if (!body) return;
    try {
      const config = ctx.resolveCollectorConfig(body.config);
      ctx.setCollectorConfig(config);
      if (body.background) {
        if (ctx.getCollectRunning()) {
          res.json({ ok: false, running: true, message: 'collect already running' });
          return;
        }
        ctx.setCollectRunning(true);
        res.status(202).json({ ok: true, running: true, message: 'collect started' });
        ctx.collectAll(config)
          .then((result: CollectResult) => { ctx.setCachedArticles(result); })
          .catch((err: unknown) => logger.error({ event: 'collect_error', requestId: getRequestId(req), error: errorMeta(err) }, 'collect failed'))
          .finally(() => { ctx.setCollectRunning(false); });
        return;
      }
      const result = await ctx.collectAll(config);
      ctx.setCachedArticles(result);
      res.json(result);
    } catch (err) {
      logger.error({ event: 'collect_error', requestId: getRequestId(req), error: errorMeta(err) }, 'collect failed');
      sendError(req, res, 500, 'Internal server error');
    }
  });

  router.get('/collect/config', (_req, res) => res.json(ctx.getCollectorConfig()));

  router.post('/collect/config', (req, res) => {
    const body = parseBody(ctx.collectorConfigSchema, req, res);
    if (!body) return;
    ctx.setCollectorConfig(body);
    res.json({ ok: true });
  });

  router.post('/scheduler/start', (req, res) => {
    const body = parseBody(ctx.schedulerStartSchema, req, res);
    if (!body) return;
    if (ctx.getSchedulerStop()) {
      res.json({ ok: false, message: '譌｢縺ｫ襍ｷ蜍穂ｸｭ' });
      return;
    }
    const expr = body.cronExpr ?? '*/30 * * * *';
    ctx.setSchedulerCronExpr(expr);
    const stop = ctx.startScheduler({
      cronExpr: expr,
      config: ctx.getCollectorConfig(),
      onCollect: (result: CollectResult) => {
        ctx.setCachedArticles(result);
        ctx.saveArticles(result);
      },
    });
    ctx.setSchedulerStop(stop);
    res.json({ ok: true, cronExpr: expr });
  });

  router.post('/scheduler/stop', (_req, res) => {
    const stop = ctx.getSchedulerStop();
    if (stop) {
      stop();
      ctx.setSchedulerStop(null);
    }
    ctx.setSchedulerCronExpr(null);
    res.json({ ok: true });
  });

  router.get('/scheduler/status', (_req, res) => {
    const cachedArticles = ctx.getCachedArticles();
    res.json({
      running: !!ctx.getSchedulerStop(),
      collecting: ctx.getCollectRunning(),
      cronExpr: ctx.getSchedulerCronExpr(),
      lastFetchedAt: cachedArticles?.stats?.fetchedAt ?? null,
      articleCount: cachedArticles?.articles?.length ?? 0,
    });
  });

  return router;
}

