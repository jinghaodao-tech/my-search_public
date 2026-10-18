import express from 'express';
import { z } from 'zod';
import type { RouteContext } from '../services/route_context.js';
import { CandidateSaveConflict } from '../services/candidate_service.js';
import { parseBody, sendError } from '../services/http_service.js';
import { ReaderError, composeReaderCardBody, fetchReadable, parseReaderCardBody, readPdf } from '../services/reader_service.js';
import { PAGE_MARKER, pdfMaxBytes } from '../services/pdf_service.js';
import { DEMO_DOCUMENTS, demoUrl, isDemoMode, readDemoDocument } from '../services/demo_service.js';
import { getReaderText, getReaderTranslation, saveReaderText, type ReaderTranslation } from '../repositories/reader_texts_repository.js';
import { IS_MOCK_AI, completeWithProvider } from '../services/ai_service.js';
import { buildEvidenceTable, pickPassagesByWords, verifyRows, type EvidenceSource } from '../services/evidence_service.js';
import { tokenizeMorphological } from '../bm25_engine.js';
import { prepareReaderContent, storeReaderContent } from '../repositories/articles_repository.js';

const extractSchema = z.object({ url: z.string().trim().url().max(2000) }).strict();
const sourceUrlSchema = z.string().trim().url().max(2000).refine(value => /^https?:\/\//i.test(value), 'Only HTTP(S) source URLs are allowed');

// Paragraph lists can be long (a whole book as a PDF): up to 50,000 paragraphs.
const paragraphsSchema = z.array(z.string().max(20000)).max(50000);
// Japanese machine translation made in the browser (Chrome's on-device Translator), aligned to paragraphs.
const translationSchema = z.object({
  from: z.string().trim().min(2).max(10),
  to: z.literal('ja'),
  engine: z.string().trim().min(1).max(50),
  translatedAt: z.string().datetime(),
  paragraphs: z.array(z.string().max(40000).nullable()).max(50000),
}).strict();

const sourceFields = {
  title: z.string().trim().min(1).max(200),
  byline: z.string().max(300).nullable().optional(),
  siteName: z.string().max(300).nullable().optional(),
  year: z.string().trim().max(20).nullable().optional(),
  fileName: z.string().trim().max(300).nullable().optional(),
};

const updateSchema = z.object({
  ...sourceFields,
  url: sourceUrlSchema.nullable().optional(),
  fetchedAt: z.string().datetime().nullable().optional(),
  paragraphs: paragraphsSchema,
  translation: translationSchema.nullable().optional(),
  memo: z.string().max(10000).default(''),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
}).strict().refine(body => !body.translation || body.translation.paragraphs.length === body.paragraphs.length, { message: 'translation.paragraphs must match paragraphs' });

const saveSchema = z.object({
  ...sourceFields,
  url: sourceUrlSchema.nullable().optional(),
  fetchedAt: z.string().datetime(),
  paragraphs: paragraphsSchema,
  translation: translationSchema.nullable().optional(),
  memo: z.string().max(10000).default(''),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
  candidateId: z.string().trim().min(1).max(200).optional(),
}).strict()
  .refine(body => !!body.url || !!body.fileName, { message: 'url か fileName が必要です' })
  .refine(body => !body.translation || body.translation.paragraphs.length === body.paragraphs.length, { message: 'translation.paragraphs must match paragraphs' });

const evidenceSchema = z.object({
  purpose: z.string().trim().min(2).max(300),
  article: z.object({
    title: z.string().trim().min(1).max(200),
    url: z.string().trim().max(2000).nullable().optional(),
    paragraphs: z.array(z.string().max(20000)).min(1).max(50000),
  }).strict().optional(),
  cardIds: z.array(z.string().trim().min(1).max(200)).min(1).max(10).optional(),
}).strict().refine(body => !!body.article !== !!body.cardIds, { message: 'article か cardIds のどちらか一方を指定してください' });

// Passages for a purpose, without server AI. Either the browser's on-device AI proposed the rows
// (they are checked here, word for word, like any AI proposal), or — with no AI at all — the
// sentences that share the most words with the purpose are picked.
const proposedRowSchema = z.object({
  claim: z.string().max(500),
  quote: z.string().max(3000),
  source: z.string().max(20).default('S1'),
  secondary: z.boolean().optional(),
}).strict();
const passagesSchema = z.object({
  purpose: z.string().trim().min(2).max(300),
  article: evidenceSchema.shape.article,
  cardIds: evidenceSchema.shape.cardIds,
  proposed: z.array(proposedRowSchema).max(60).optional(),
}).strict().refine(body => !!body.article !== !!body.cardIds, { message: 'article か cardIds のどちらか一方を指定してください' });

// Text read in the reader is also used when searching collected articles (only for pages that
// were collected: matched by URL). PDF page markers are not part of the text.
async function cacheReaderText(url: string | null, paragraphs: string[], fetchedAt: string) {
  const text = paragraphs.filter(paragraph => !PAGE_MARKER.test(paragraph));
  if (!url || !text.length) return;
  storeReaderContent(await prepareReaderContent(url, text.join('\n\n')), fetchedAt);
}

export function createReaderRouter(ctx: RouteContext) {
  const router = express.Router();

  // Fetch a page and return its readable text (no AI, deterministic).
  // What this instance offers (the UI hides what is not available).
  router.get('/features', (_req, res) => {
    const demo = isDemoMode();
    res.json({
      demo,
      ai: IS_MOCK_AI || ctx.hasConfiguredProviderKey(),
      pdfMaxMb: Math.round(pdfMaxBytes() / 1024 / 1024),
      samples: demo ? Object.entries(DEMO_DOCUMENTS).map(([pathname, doc]) => ({ title: doc.title, url: demoUrl(pathname), download: pathname.endsWith('.pdf') ? `/demo/${doc.file}` : null })) : [],
    });
  });

  router.post('/reader/extract', ctx.readerLimiter, async (req, res) => {
    const body = parseBody(extractSchema, req, res);
    if (!body) return;
    try {
      const article = (await readDemoDocument(body.url)) ?? await fetchReadable(body.url);
      await cacheReaderText(body.url, article.paragraphs, article.fetchedAt);
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
  router.post('/reader/pdf', ctx.readerLimiter, (req, res, next) => express.raw({ type: 'application/pdf', limit: pdfMaxBytes() })(req, res, next), async (req, res) => {
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
      translation: body.translation ?? null,
    });
    const fields = { title: body.title, body: cardBody, ...(body.url ? { url: body.url } : {}), tags: body.tags, type: 'article' as const };

    if (!body.candidateId) {
      const content = await prepareReaderContent(body.url ?? null, body.paragraphs.filter(p => !PAGE_MARKER.test(p)).join('\n\n'));
      const card = await ctx.createCardWithTransaction(fields, card => {
        saveReaderText(card.id, body.paragraphs, (body.translation ?? null) as ReaderTranslation | null);
        storeReaderContent(content, body.fetchedAt);
      });
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
      const content = await prepareReaderContent(body.url ?? null, body.paragraphs.filter(p => !PAGE_MARKER.test(p)).join('\n\n'));
      const card = await ctx.createCardWithTransaction(fields, createdCard => {
        savedCandidate = ctx.saveCandidate(body.candidateId as string, createdCard.id);
        if (!savedCandidate) throw new CandidateSaveConflict();
        saveReaderText(createdCard.id, body.paragraphs, (body.translation ?? null) as ReaderTranslation | null);
        storeReaderContent(content, body.fetchedAt);
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
      year: parsed.source.year,
      fileName: parsed.source.fileName,
      fetchedAt: parsed.source.fetchedAt,
      memo: parsed.memo,
      paragraphs: getReaderText(card.id) ?? parsed.paragraphs,
      translation: getReaderTranslation(card.id),
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
    const url = body.url !== undefined ? body.url : existing.url ?? null;
    // No translation in the request: keep the stored one if it still fits the text.
    const kept = getReaderTranslation(req.params.id);
    const translation = body.translation !== undefined
      ? (body.translation as ReaderTranslation | null)
      : (kept && JSON.stringify(getReaderText(req.params.id)) === JSON.stringify(body.paragraphs) ? kept : null);
    const cardBody = composeReaderCardBody({
      memo: body.memo,
      source: { title: body.title, url, byline: body.byline ?? null, siteName: body.siteName ?? null, fetchedAt: body.fetchedAt ?? new Date().toISOString(), year: body.year ?? null, fileName: body.fileName ?? null },
      paragraphs: body.paragraphs,
      translation,
    });
    const content = await prepareReaderContent(url, body.paragraphs.filter(p => !PAGE_MARKER.test(p)).join('\n\n'));
    const card = await ctx.updateCard(req.params.id, { title: body.title, url: url ?? undefined, body: cardBody, ...(body.tags ? { tags: body.tags } : {}) }, () => {
      saveReaderText(req.params.id, body.paragraphs, translation);
      storeReaderContent(content, body.fetchedAt ?? new Date().toISOString());
    });
    res.json(card);
  });

  function loadEvidenceSources(body: { article?: { title: string; url?: string | null; paragraphs: string[] }; cardIds?: string[] }, req: express.Request, res: express.Response): EvidenceSource[] | null {
    if (body.article) return [{ id: 'article', title: body.article.title, url: body.article.url ?? null, paragraphs: body.article.paragraphs }];
    const sources: EvidenceSource[] = [];
    for (const id of body.cardIds ?? []) {
      const card = ctx.getCard(id);
      if (!card) { sendError(req, res, 404, `カードが見つかりません: ${id}`, undefined, 'card_not_found'); return null; }
      const parsed = parseReaderCardBody(card.body ?? '');
      const paragraphs = getReaderText(card.id) ?? (parsed.isReaderFormat && parsed.paragraphs.length
        ? parsed.paragraphs
        : String(card.body ?? '').split(/\n{2,}/).map(text => text.trim()).filter(Boolean));
      sources.push({ id: card.id, title: parsed.source.title ?? card.title, url: parsed.source.url ?? card.url ?? null, paragraphs });
    }
    return sources;
  }

  router.post('/reader/passages', ctx.readerLimiter, async (req, res) => {
    const body = parseBody(passagesSchema, req, res);
    if (!body) return;
    const sources = loadEvidenceSources(body, req, res);
    if (!sources) return;
    const method = body.proposed ? 'local-ai' : 'words';
    const proposed = body.proposed ?? await pickPassagesByWords(body.purpose, sources, tokenizeMorphological);
    const result = verifyRows(proposed, sources);
    res.json({ ...result, method, chunks: 1, sources: sources.map(source => ({ id: source.id, title: source.title, url: source.url ?? null })) });
  });

  // AI proposes claim ↔ quote rows for a purpose; every quote is checked against
  // the saved text without AI, and only found quotes come back as rows.
  router.post('/reader/evidence', ctx.aiLimiter, async (req, res) => {
    const body = parseBody(evidenceSchema, req, res);
    if (!body) return;
    const sources = loadEvidenceSources(body, req, res);
    if (!sources) return;
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
