import express from 'express';
import type { RouteContext } from '../services/route_context.js';
import { errorMeta, logger } from '../utils/logger.js';
import { getRequestId, parseBody, sendError } from '../services/http_service.js';
import type { CollectResult } from '../collector.js';
import { isDemoMode } from '../services/demo_service.js';
import { CollectionBusyError } from '../services/collector_service.js';
import cron from 'node-cron';

export function createCollectRouter(ctx: RouteContext) {
  const router = express.Router();

  // Demo instance: no collecting from outside feeds (the sample articles are already there).
  router.post(['/collect', '/articles/refresh', '/collect/config', '/scheduler/start'], (req, res, next) => {
    if (isDemoMode()) { sendError(req, res, 403, 'デモ版では記事の収集は止めています', undefined, 'request_failed'); return; }
    next();
  });

  router.post('/scheduler/start', (req, res, next) => {
    if (ctx.getSchedulerStop()) {
      sendError(req, res, 409, 'Scheduler already running', undefined, 'scheduler_already_running');
      return;
    }
    next();
  });

  router.get('/articles', (_req, res) => {
    const cachedArticles = ctx.getCachedArticles();
    if (!cachedArticles) {
      res.json({ articles: [], stats: null, message: '未収集。/api/collect を呼んでください' });
      return;
    }
    res.json(cachedArticles);
  });

  router.post(['/collect', '/articles/refresh'], ctx.apiLimiter, async (req, res) => {
    const body = parseBody(ctx.collectBodySchema, req, res);
    if (!body) return;
    if (ctx.getCollectRunning()) { sendError(req, res, 409, 'Collection already running', undefined, 'collection_already_running'); return; }
    try {
      if (body.fixture === 'portfolio-demo') {
        if (body.background) {
          const job = ctx.submitJob('collect-fixture', async () => {
            const fixture = await ctx.collectFixture();
            ctx.setCachedArticles(fixture);
            return fixture;
          });
          res.status(202).json({ ok: true, running: true, jobId: job.id, status: job.status, fixture: 'portfolio-demo' });
          return;
        }
        const fixture = await ctx.collectFixture();
        ctx.setCachedArticles(fixture);
        res.json({ ...fixture, fixture: 'portfolio-demo' });
        return;
      }
      const config = ctx.resolveCollectorConfig(body.config);
      ctx.setCollectorConfig(config);
      if (body.background) {
        const job = ctx.submitJob('collect', async () => {
          const result = await ctx.collectAll(config);
          ctx.setCachedArticles(result);
          return result;
        });
        res.status(202).json({ ok: true, running: true, jobId: job.id, status: job.status, message: 'collect started' });
        return;
      }
      const result = await ctx.collectAll(config);
      ctx.setCachedArticles(result);
      res.json(result);
    } catch (err) {
      if (err instanceof CollectionBusyError) { sendError(req, res, 409, err.message, undefined, 'collection_already_running'); return; }
      logger.error({ event: 'collect_error', requestId: getRequestId(req), error: errorMeta(err) }, 'collect failed');
      sendError(req, res, 500, 'Internal server error', undefined, 'collector_failed');
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
      res.json({ ok: false, message: '既に起動中' });
      return;
    }
    const expr = body.cronExpr ?? '*/30 * * * *';
    if (!cron.validate(expr)) { sendError(req, res, 400, 'Invalid cron expression', undefined, 'validation_failed'); return; }
    ctx.setSchedulerCronExpr(expr);
    const stop = ctx.startScheduler({
      cronExpr: expr,
      config: ctx.getCollectorConfig(),
      getConfig: ctx.getCollectorConfig,
      collect: async config => {
        if (ctx.getCollectRunning()) throw new CollectionBusyError();
        return await new Promise<CollectResult>((resolve, reject) => {
          ctx.submitJob('scheduled-collect', async () => {
            try { const result = await ctx.collectAll(config); resolve(result); return result; }
            catch (error) { reject(error); throw error; }
          });
        });
      },
      onError: error => logger.error({ event: 'scheduled_collect_error', error: errorMeta(error) }, 'Scheduled collection failed'),
      onCollect: (result: CollectResult) => {
        ctx.setCachedArticles(result);
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
      articleCount: ctx.getCollectionStatus().accumulatedArticleCount,
      ...ctx.getCollectionStatus(),
    });
  });

  return router;
}
