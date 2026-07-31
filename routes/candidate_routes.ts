import { candidateStatusSchema } from "../schemas/api_schemas.js";
import express from 'express';
import type { RouteContext } from '../services/route_context.js';
import { sendError } from '../services/http_service.js';

export function createCandidateRouter(ctx: RouteContext) {
  const router = express.Router();
  router.get('/candidates', (req, res) => {
    const raw = typeof req.query.status === 'string' ? req.query.status : undefined;
    const parsed = raw ? candidateStatusSchema.safeParse(raw) : { success: true as const, data: undefined };
    if (!parsed.success) { sendError(req, res, 400, 'Invalid candidate status', undefined, 'validation_failed'); return; }
    const status = parsed.data as Parameters<typeof ctx.getCandidates>[0];
    res.json(ctx.getCandidates(status));
  });
  router.get('/candidates/:id', (req, res) => {
    const candidate = ctx.getCandidate(req.params.id);
    if (!candidate) { sendError(req, res, 404, 'Not found', undefined, 'candidate_not_found'); return; }
    res.json(candidate);
  });
  router.put('/candidates/:id/review', (req, res) => {
    const candidate = ctx.reviewCandidate(req.params.id);
    if (!candidate) { sendError(req, res, 404, 'Not found', undefined, 'candidate_not_found'); return; }
    res.json(candidate);
  });
  router.put('/candidates/:id/expire', (req, res) => {
    const candidate = ctx.expireCandidate(req.params.id);
    if (!candidate) { sendError(req, res, 404, 'Not found', undefined, 'candidate_not_found'); return; }
    res.json(candidate);
  });
  router.post('/candidates/expire-reviewed', (req, res) => {
    const retentionDays = Number(req.body?.candidateRetentionDays ?? 14);
    if (!Number.isInteger(retentionDays) || retentionDays < 0) { sendError(req, res, 400, 'candidateRetentionDays must be a non-negative integer', undefined, 'validation_failed'); return; }
    res.json({ ok: true, expired: ctx.expireReviewedCandidates(retentionDays) });
  });
  router.post('/candidates/:id/save', async (req, res) => {
    const candidate = ctx.getCandidate(req.params.id);
    if (!candidate) { sendError(req, res, 404, 'Not found', undefined, 'candidate_not_found'); return; }
    if (candidate.status === 'expired') { sendError(req, res, 409, 'Candidate expired', undefined, 'candidate_expired'); return; }
    if (candidate.status === 'saved_as_card') { sendError(req, res, 409, 'Candidate already saved', undefined, 'candidate_already_saved'); return; }
    const article = ctx.getArticleById(req.params.id);
    if (!article) { sendError(req, res, 404, 'Not found', undefined, 'candidate_not_found'); return; }
    const card = await ctx.createCard({ title: article.title, body: article.body, summary: article.summary, url: article.url, tags: article.tags ?? [], type: 'article' });
    res.status(201).json({ card, candidate: ctx.saveCandidate(req.params.id) });
  });
  return router;
}
