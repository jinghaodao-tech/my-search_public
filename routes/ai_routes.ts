import express from 'express';
import type { RouteContext } from '../services/route_context.js';
import { errorMeta, logger } from '../utils/logger.js';
import { getRequestId, parseBody, sendError } from '../services/http_service.js';

export function createAiRouter(ctx: RouteContext) {
  const router = express.Router();

  router.delete('/cards/:id/summary', async (req, res) => {
    const card = ctx.getCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    const updated = await ctx.updateCard(req.params.id, { summary: undefined });
    res.json({ ok: true, card: updated });
  });

  router.post('/cards/:id/summarize', ctx.aiLimiter, async (req, res) => {
    const cardId = String(req.params.id);
    const card = ctx.getCard(cardId);
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }

    try {
      const summary = await ctx.summarizeCard(card);
      const updated = await ctx.updateCard(card.id, { summary });
      res.json({ summary, card: updated });
    } catch (err) {
      if (ctx.isAiSummaryError(err)) {
        logger.warn({
          event: 'ai_provider_error',
          requestId: getRequestId(req),
          code: err.code,
          statusCode: err.status,
          provider: ctx.AI_PROVIDER,
          error: errorMeta(err),
        }, 'AI summary provider error');
        res.status(err.status).json({
          error: err.message,
          code: err.code,
          requestId: getRequestId(req),
        });
        return;
      }
      logger.error({ event: 'ai_summary_error', requestId: getRequestId(req), error: errorMeta(err) }, 'AI summary failed');
      sendError(req, res, 500, 'AI APIでエラーが発生しました', [{ code: 'api_error' }], 'ai_provider_unavailable');
    }
  });

  router.post('/cards/summarize-bulk', ctx.aiLimiter, async (req, res) => {
    const body = parseBody(ctx.idsBodySchema, req, res);
    if (!body) return;
    if (!ctx.hasConfiguredProviderKey()) {
      const keyName = ctx.AI_PROVIDER === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
      logger.error({ event: 'ai_missing_api_key', requestId: getRequestId(req), provider: ctx.AI_PROVIDER }, `[AI SUMMARY] ${keyName} is not configured`);
      res.status(500).json({
        error: `${keyName} is not configured`,
        code: 'missing_api_key',
        requestId: getRequestId(req),
      });
      return;
    }
    res.json({ ok: true, message: `${body.ids.length}件の要約を開始しました` });

    (async () => {
      for (const id of body.ids) {
        const card = ctx.getCard(id);
        if (!card || card.summary) continue;
        try {
          const summary = await ctx.summarizeCard(card);
          await ctx.updateCard(id, { summary });
          await new Promise(r => setTimeout(r, 300));
        } catch (error) {
          logger.error({ event: 'ai_bulk_summary_error', id, error: errorMeta(error) }, '[AI SUMMARY] bulk summarize failed');
        }
      }
    })();
  });

  return router;
}