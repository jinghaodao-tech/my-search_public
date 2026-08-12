import express from 'express';
import type { RouteContext } from '../services/route_context.js';
import { errorMeta, logger } from '../utils/logger.js';
import { getRequestId, parseBody, sendError } from '../services/http_service.js';
import type { CollectResult } from '../collector.js';

export function createCollectRouter(ctx: RouteContext) {
  const router = express.Router();

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
    try {
      if (body.fixture === 'portfolio-demo') {
        if (body.background) {
          const job = ctx.submitJob('collect-fixture', async () => {
            const fixture = await ctx.collectFixture();
            ctx.setCachedArticles(fixture);
            ctx.saveArticles(fixture);
            return fixture;
          });
          res.status(202).json({ ok: true, running: true, jobId: job.id, status: job.status, fixture: 'portfolio-demo' });
          return;
        }
        const fixture = await ctx.collectFixture();
        ctx.setCachedArticles(fixture);
        ctx.saveArticles(fixture);
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
