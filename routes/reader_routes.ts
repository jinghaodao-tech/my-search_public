import express from 'express';
import { db } from '../db/database.js';
import { z } from 'zod';
import type { RouteContext } from '../services/route_context.js';
import { CandidateSaveConflict } from '../services/candidate_service.js';
import { parseBody, sendError } from '../services/http_service.js';
import { ReaderError, composeReaderCardBody, fetchReadable, parseReaderCardBody, readPdf } from '../services/reader_service.js';
import { PAGE_MARKER, PDF_MAX_BYTES } from '../services/pdf_service.js';
import { getReaderText, saveReaderText } from '../repositories/reader_texts_repository.js';
import { IS_MOCK_AI, completeWithProvider } from '../services/ai_service.js';
import { buildEvidenceTable, type EvidenceSource } from '../services/evidence_service.js';

const extractSchema = z.object({ url: z.string().trim().url().max(2000) }).strict();

// Paragraph lists can be long (a whole book as a PDF): up to 50,000 paragraphs.
const paragraphsSchema = z.array(z.string().max(20000)).max(50000);
const sourceFields = {
  title: z.string().trim().min(1).max(200),
  byline: z.string().max(300).nullable().optional(),
  siteName: z.string().max(300).nullable().optional(),
  year: z.string().trim().max(20).nullable().optional(),
  fileName: z.string().trim().max(300).nullable().optional(),
};

const updateSchema = z.object({
  ...sourceFields,
  url: z.string().trim().url().max(2000).nullable().optional(),
  fetchedAt: z.string().datetime().nullable().optional(),
  paragraphs: paragraphsSchema,
  memo: z.string().max(10000).default(''),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
}).strict();

const saveSchema = z.object({
  ...sourceFields,
  url: z.string().trim().url().max(2000).nullable().optional(),
  fetchedAt: z.string().datetime(),
  paragraphs: paragraphsSchema,
  memo: z.string().max(10000).default(''),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
  candidateId: z.string().trim().min(1).max(200).optional(),
}).strict().refine(body => !!body.url || !!body.fileName, { message: 'url か fileName が必要です' });

const evidenceSchema = z.object({
  purpose: z.string().trim().min(2).max(300),
  article: z.object({
    title: z.string().trim().min(1).max(200),
    url: z.string().trim().max(2000).nullable().optional(),
    paragraphs: z.array(z.string().max(20000)).min(1).max(50000),
  }).strict().optional(),
  cardIds: z.array(z.string().trim().min(1).max(200)).min(1).max(10).optional(),
}).strict().refine(body => !!body.article !== !!body.cardIds, { message: 'article か cardIds のどちらか一方を指定してください' });

// Text read in the reader is also used when searching collected articles (only for pages that
// were collected: matched by URL). PDF page markers are not part of the text.
function cacheReaderText(url: string | null, paragraphs: string[], fetchedAt: string) {
  const text = paragraphs.filter(paragraph => !PAGE_MARKER.test(paragraph));
  if (!url || !text.length) return;
  db.prepare(`INSERT INTO article_reader_content(article_id, body, fetched_at)
    SELECT id, ?, ? FROM articles WHERE url = ?
    ON CONFLICT(article_id) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`)
    .run(text.join('\n\n'), fetchedAt, url);
}

export function createReaderRouter(ctx: RouteContext) {
  const router = express.Router();

  // Fetch a page and return its readable text (no AI, deterministic).
  router.post('/reader/extract', async (req, res) => {
    const body = parseBody(extractSchema, req, res);
    if (!body) return;
    try {
      const article = await fetchReadable(body.url);
      cacheReaderText(body.url, article.paragraphs, article.fetchedAt);
      res.json(article);
    } catch (error) {
      if (error instanceof ReaderError) {
        sendError(req, res, error.status, error.message, undefined, error.status === 400 ? 'validation_failed' : 'reader_fetch_failed');
        return;
      }
      throw error;
    }
  });

  // Read an uploaded PDF (sent as the raw request body). No AI; pages come from the PDF itself.
  router.post('/reader/pdf', express.raw({ type: 'application/pdf', limit: PDF_MAX_BYTES }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      sendError(req, res, 400, 'Content-Type: application/pdf の本文としてPDFを送ってください', undefined, 'validation_failed');
      return;
    }
    let fileName: string | null = null;
    try { fileName = decodeURIComponent(String(req.get('x-file-name') ?? '')).slice(0, 300) || null; } catch { fileName = null; }
    try {
      res.json(await readPdf(new Uint8Array(req.body), { url: null, fileName }));
    } catch (error) {
      if (error instanceof ReaderError) { sendError(req, res, error.status, error.message, undefined, 'reader_fetch_failed'); return; }
      throw error;
    }
  });

  // Save memo + source + copy of the text as one article card.
  router.post('/reader/save', async (req, res) => {
    const body = parseBody(saveSchema, req, res);
    if (!body) return;
    const cardBody = composeReaderCardBody({
      memo: body.memo,
      source: { title: body.title, url: body.url ?? null, byline: body.byline ?? null, siteName: body.siteName ?? null, fetchedAt: body.fetchedAt, year: body.year ?? null, fileName: body.fileName ?? null },
      paragraphs: body.paragraphs,
    });
    cacheReaderText(body.url ?? null, body.paragraphs, body.fetchedAt);
    const fields = { title: body.title, body: cardBody, ...(body.url ? { url: body.url } : {}), tags: body.tags, type: 'article' as const };

    if (!body.candidateId) {
      const card = await ctx.createCard(fields);
      saveReaderText(card.id, body.paragraphs);
      res.status(201).json({ card, candidate: null });
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
      saveReaderText(card.id, body.paragraphs);
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
      year: parsed.source.year,
      fileName: parsed.source.fileName,
      fetchedAt: parsed.source.fetchedAt,
      memo: parsed.memo,
      paragraphs: getReaderText(card.id) ?? parsed.paragraphs,
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
    const url = body.url ?? existing.url ?? null;
    const cardBody = composeReaderCardBody({
      memo: body.memo,
      source: { title: body.title, url, byline: body.byline ?? null, siteName: body.siteName ?? null, fetchedAt: body.fetchedAt ?? new Date().toISOString(), year: body.year ?? null, fileName: body.fileName ?? null },
      paragraphs: body.paragraphs,
    });
    const card = await ctx.updateCard(req.params.id, { body: cardBody, ...(body.tags ? { tags: body.tags } : {}) });
    saveReaderText(req.params.id, body.paragraphs);
    cacheReaderText(url, body.paragraphs, body.fetchedAt ?? new Date().toISOString());
    res.json(card);
  });

  // AI proposes claim ↔ quote rows for a purpose; every quote is checked against
  // the saved text without AI, and only found quotes come back as rows.
  router.post('/reader/evidence', ctx.aiLimiter, async (req, res) => {
    const body = parseBody(evidenceSchema, req, res);
    if (!body) return;
    let sources: EvidenceSource[];
    if (body.article) {
      sources = [{ id: 'article', title: body.article.title, url: body.article.url ?? null, paragraphs: body.article.paragraphs }];
    } else {
      sources = [];
      for (const id of body.cardIds ?? []) {
        const card = ctx.getCard(id);
        if (!card) { sendError(req, res, 404, `カードが見つかりません: ${id}`, undefined, 'card_not_found'); return; }
        const parsed = parseReaderCardBody(card.body ?? '');
        const paragraphs = getReaderText(card.id) ?? (parsed.isReaderFormat && parsed.paragraphs.length
          ? parsed.paragraphs
          : String(card.body ?? '').split(/\n{2,}/).map(text => text.trim()).filter(Boolean));
        sources.push({ id: card.id, title: parsed.source.title ?? card.title, url: parsed.source.url ?? card.url ?? null, paragraphs });
      }
    }
    if (!IS_MOCK_AI && !ctx.hasConfiguredProviderKey()) {
      const keyName = ctx.AI_PROVIDER === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
      sendError(req, res, 503, `${keyName} が設定されていません`, undefined, 'ai_provider_unavailable');
      return;
    }
    try {
      const result = await buildEvidenceTable(body.purpose, sources, completeWithProvider, IS_MOCK_AI);
      res.json({ ...result, sources: sources.map(source => ({ id: source.id, title: source.title, url: source.url ?? null })) });
    } catch (error) {
      if (ctx.isAiSummaryError(error)) {
        sendError(req, res, error.status >= 500 ? 502 : error.status, `AIの呼び出しに失敗しました: ${error.message}`, undefined, 'ai_provider_unavailable');
        return;
      }
      throw error;
    }
  });

  return router;
}
