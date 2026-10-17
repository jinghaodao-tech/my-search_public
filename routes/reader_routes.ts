import express from 'express';
import { z } from 'zod';
import type { RouteContext } from '../services/route_context.js';
import { CandidateSaveConflict } from '../services/candidate_service.js';
import { parseBody, sendError } from '../services/http_service.js';
import { ReaderError, composeReaderCardBody, fetchReadable, parseReaderCardBody } from '../services/reader_service.js';

const extractSchema = z.object({ url: z.string().trim().url().max(2000) }).strict();

const updateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  url: z.string().trim().url().max(2000).nullable().optional(),
  byline: z.string().max(300).nullable().optional(),
  siteName: z.string().max(300).nullable().optional(),
  fetchedAt: z.string().datetime().nullable().optional(),
  paragraphs: z.array(z.string().max(20000)).max(5000),
  memo: z.string().max(10000).default(''),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
}).strict();

const saveSchema = z.object({
  url: z.string().trim().url().max(2000),
  title: z.string().trim().min(1).max(200),
  byline: z.string().max(300).nullable().optional(),
  siteName: z.string().max(300).nullable().optional(),
  fetchedAt: z.string().datetime(),
  paragraphs: z.array(z.string().max(20000)).max(5000),
  memo: z.string().max(10000).default(''),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
  candidateId: z.string().trim().min(1).max(200).optional(),
}).strict();

export function createReaderRouter(ctx: RouteContext) {
  const router = express.Router();

  // Fetch a page and return its readable text (no AI, deterministic).
  router.post('/reader/extract', async (req, res) => {
    const body = parseBody(extractSchema, req, res);
    if (!body) return;
    try {
      res.json(await fetchReadable(body.url));
    } catch (error) {
      if (error instanceof ReaderError) {
        sendError(req, res, error.status, error.message, undefined, error.status === 400 ? 'validation_failed' : 'reader_fetch_failed');
        return;
      }
      throw error;
    }
  });

  // Save memo + source + copy of the text as one article card.
  router.post('/reader/save', async (req, res) => {
    const body = parseBody(saveSchema, req, res);
    if (!body) return;
    const cardBody = composeReaderCardBody({
      memo: body.memo,
      source: { title: body.title, url: body.url, byline: body.byline ?? null, siteName: body.siteName ?? null, fetchedAt: body.fetchedAt },
      paragraphs: body.paragraphs,
    });
    const fields = { title: body.title, body: cardBody, url: body.url, tags: body.tags, type: 'article' as const };

    if (!body.candidateId) {
      res.status(201).json({ card: await ctx.createCard(fields), candidate: null });
      return;
    }

    // Same atomic rule as POST /candidates/:id/save: the card and the
    // candidate status change succeed or fail together.
    const candidate = ctx.getCandidate(body.candidateId);
    if (!candidate) { sendError(req, res, 404, 'Not found', undefined, 'candidate_not_found'); return; }
    if (candidate.status === 'expired') { sendError(req, res, 409, 'Candidate expired', undefined, 'candidate_expired'); return; }
    if (candidate.status === 'saved_as_card') { sendError(req, res, 409, 'Candidate already saved', undefined, 'candidate_already_saved'); return; }
    let savedCandidate = null;
    try {
      const card = await ctx.createCardWithTransaction(fields, createdCard => {
        savedCandidate = ctx.saveCandidate(body.candidateId as string, createdCard.id);
        if (!savedCandidate) throw new CandidateSaveConflict();
      });
      res.status(201).json({ card, candidate: savedCandidate });
    } catch (error) {
      if (error instanceof CandidateSaveConflict) { sendError(req, res, 409, 'Candidate save conflict', undefined, 'candidate_save_conflict'); return; }
      throw error;
    }
  });

  // Open an existing card in the reader: split it back into memo / source / text.
  router.get('/reader/cards/:id', (req, res) => {
    const card = ctx.getCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    const parsed = parseReaderCardBody(card.body ?? '');
    res.json({
      id: card.id,
      title: parsed.source.title ?? card.title,
      url: parsed.source.url ?? card.url ?? null,
      siteName: parsed.source.siteName,
      byline: parsed.source.byline,
      fetchedAt: parsed.source.fetchedAt,
      memo: parsed.memo,
      paragraphs: parsed.paragraphs,
      tags: card.tags ?? [],
      isReaderFormat: parsed.isReaderFormat,
    });
  });

  // Save edits made in the reader back to the same card.
  router.put('/reader/cards/:id', async (req, res) => {
    const body = parseBody(updateSchema, req, res);
    if (!body) return;
    const existing = ctx.getCard(req.params.id);
    if (!existing) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    const url = body.url ?? existing.url ?? '';
    const cardBody = composeReaderCardBody({
      memo: body.memo,
      source: { title: body.title, url, byline: body.byline ?? null, siteName: body.siteName ?? null, fetchedAt: body.fetchedAt ?? new Date().toISOString() },
      paragraphs: body.paragraphs,
    });
    const card = await ctx.updateCard(req.params.id, { body: cardBody, ...(body.tags ? { tags: body.tags } : {}) });
    res.json(card);
  });

  return router;
}
