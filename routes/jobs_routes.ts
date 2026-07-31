import express from 'express';
import type { RouteContext } from '../services/route_context.js';
import { sendError } from '../services/http_service.js';

export function createJobsRouter(ctx: RouteContext) {
  const router = express.Router();
  router.get('/jobs', (_req, res) => res.json(ctx.listJobs()));
  router.get('/jobs/:id', (req, res) => {
    const job = ctx.getJob(req.params.id);
    if (!job) {
      sendError(req, res, 404, 'Job not found', undefined, 'job_not_found');
      return;
    }
    res.json(job);
  });
  return router;
}
