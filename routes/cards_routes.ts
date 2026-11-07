import express from 'express';
import { z } from 'zod';
import { mergeTagList, tagVariantGroups } from '../services/tag_tidy.js';
import type { RouteContext } from '../services/route_context.js';
import { markdownContentDisposition } from '../utils/markdown_export.js';
import { errorMeta, logger } from '../utils/logger.js';
import { buildBulkMarkdownZip, buildCardMarkdown } from '../services/export_service.js';
import { getRequestId, invalidRequest, parseBody, sendError } from '../services/http_service.js';
import { cardListQuerySchema, cardSearchBodySchema } from '../schemas/api_schemas.js';
import type { Card } from '../domain/card.js';
import { buildStoredTokenSet, numericUnitSearchTerms, type Article } from '../bm25_engine.js';
import { buildSearchSnippet } from '../services/search_match_service.js';
import { rerankWithE5Rrf } from '../services/e5_rrf_ranker.js';
import { loadCardsByIds, savedCardCount, savedCardTokenFtsAvailable, searchSavedCardIdsByNumericPhrase, searchSavedCardIdsFts5Morphological, searchSavedCardIdsFts5Raw, searchSavedCardIdsFts5Rrf, searchSavedReaderText } from '../repositories/cards_repository.js';

function parseCardSort(value: unknown): 'created_at_asc' | 'created_at_desc' | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === 'created_at_asc' || raw === 'created_at_desc') return raw;
  if (raw === 'createdAtAsc') return 'created_at_asc';
  if (raw === 'createdAtDesc') return 'created_at_desc';
  return undefined;
}


function normalizeQueryNumber(value: unknown, min: number, max: number): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return undefined;
  return Math.min(parsed, max);
}
export function createCardsRouter(ctx: RouteContext) {
  const router = express.Router();

  router.get('/cards', (req, res) => {
    const rawQuery = req.query as Record<string, unknown>;
    const parsedQuery = cardListQuerySchema.safeParse({ ...rawQuery, limit: normalizeQueryNumber(rawQuery.limit, 1, 100), offset: normalizeQueryNumber(rawQuery.offset, 0, Number.MAX_SAFE_INTEGER) });
    if (!parsedQuery.success) { invalidRequest(req, res, parsedQuery.error.issues); return; }
    const { tag, kjGroupId, type, q, archived, limit, offset, sort } = parsedQuery.data;
    const filters = {
      tag,
      kjGroupId,
      type,
      q,
      archived: archived === 'true' ? true : archived === 'false' ? false : undefined,
      limit,
      offset,
      sort: parseCardSort(sort),
    };

    if (typeof limit !== 'undefined' || typeof offset !== 'undefined') {
      res.json(ctx.getCardsPage(filters));
      return;
    }

    res.json(ctx.getCards(filters));
  });

  router.post('/cards/search', async (req, res) => {
    const body = parseBody(cardSearchBodySchema, req, res);
    if (!body) return;
    try {
      const cardSearchEngine = process.env.CARD_SEARCH_ENGINE ?? 'fts5-morph';
      const useE5Rrf = cardSearchEngine === 'e5-rrf';
      const useRawOnlyFts = cardSearchEngine === 'fts5-raw';
      const useMorphologyOnlyFts = cardSearchEngine === 'fts5-morph';
      const queryTerms = body.config.keywords.flatMap(keyword => [keyword.term, ...(keyword.synonyms ?? [])]);
      const cardFilters = body.cardFilters;
      const matchesCardFilters = (card: Card) => (!cardFilters?.tag || card.tags.includes(cardFilters.tag))
        && (!cardFilters?.kjGroupId || card.kjGroupId === cardFilters.kjGroupId)
        && (!cardFilters?.type || card.type === cardFilters.type)
        && (cardFilters?.archived === undefined || card.archived === cardFilters.archived);
      const numericPhraseTerms = numericUnitSearchTerms(queryTerms);
      const useFts = (cardSearchEngine === 'fts5' || useRawOnlyFts || useMorphologyOnlyFts) && savedCardTokenFtsAvailable()
        && (body.options?.dedupThreshold ?? 1) >= 1;
      if (useFts) {
        const startedAt = performance.now();
        const tokenSet = await buildStoredTokenSet(queryTerms.join(' '));
        const tokenPreparationMs = performance.now() - startedAt;
        const limit = Math.max(1, Math.min(500, body.options?.resultLimit ?? 50));
        const excluded = (body.filters?.excludedTerms ?? []).map(term => term.normalize('NFKC').toLowerCase());
        const selected: Array<{ card: Card; rank: ReturnType<typeof searchSavedCardIdsFts5Rrf>[number] }> = [];
        const pageSize = excluded.length ? 500 : limit;
        const indexCandidateLimit = Math.min(500, Math.max(limit, limit * 4));
        let offset = 0;
        let candidateCount = 0;
        let rawOnlyFallbackUsed = false;
        let numericPhraseFallbackUsed = false;
        const rankingStartedAt = performance.now();
        while (selected.length < indexCandidateLimit) {
          let ranks = numericPhraseFallbackUsed
            ? searchSavedCardIdsByNumericPhrase(numericPhraseTerms, pageSize, offset)
            : useRawOnlyFts && !rawOnlyFallbackUsed
            ? searchSavedCardIdsFts5Raw(queryTerms, pageSize, offset)
            : useMorphologyOnlyFts && !rawOnlyFallbackUsed
              ? searchSavedCardIdsFts5Morphological(tokenSet.morphologicalTokens, pageSize, offset)
              : searchSavedCardIdsFts5Rrf(tokenSet.morphologicalTokens, tokenSet.ngramTokens, queryTerms, pageSize, offset);
          if ((useRawOnlyFts || useMorphologyOnlyFts) && !rawOnlyFallbackUsed && offset === 0 && ranks.length === 0) {
            rawOnlyFallbackUsed = true;
            ranks = searchSavedCardIdsFts5Rrf(tokenSet.morphologicalTokens, tokenSet.ngramTokens, queryTerms, pageSize, offset);
          }
          if (ranks.length === 0 && offset === 0 && numericPhraseTerms.length > 0) {
            numericPhraseFallbackUsed = true;
            ranks = searchSavedCardIdsByNumericPhrase(numericPhraseTerms, pageSize, offset);
          }
          if (!ranks.length) break;
          candidateCount = ranks[0]!.matchedCount;
          const cardsById = new Map(loadCardsByIds(ranks.map(rank => rank.id)).map(card => [card.id, card]));
          for (const rank of ranks) {
            const card = cardsById.get(rank.id);
            if (!card || !matchesCardFilters(card)) continue;
            const content = `${card.title} ${card.body} ${card.summary ?? ''}`.normalize('NFKC').toLowerCase();
            if (excluded.some(term => content.includes(term))) continue;
            selected.push({ card, rank });
            if (selected.length >= indexCandidateLimit) break;
          }
          offset += ranks.length;
          if (ranks.length < pageSize) break;
        }
        const readerTextMatches = searchSavedReaderText(queryTerms, indexCandidateLimit, excluded);
        const readerCardsById = new Map(loadCardsByIds(readerTextMatches.map(match => match.id)).map(card => [card.id, card]));
        const selectedById = new Map(selected.map(entry => [entry.card.id, entry]));
        for (const match of readerTextMatches) {
          const existing = selectedById.get(match.id);
          const card = existing?.card ?? readerCardsById.get(match.id);
          if (!card || !matchesCardFilters(card)) continue;
          if (match.excludedTermMatched) continue;
          if (existing) {
            existing.rank.readerTextRank = match.readerTextRank;
            existing.rank.readerSnippet = match.readerSnippet;
            continue;
          }
          const readerScore = 61 / (60 + match.readerTextRank);
          const entry = {
            card,
            rank: {
              id: card.id,
              morphologicalRank: null,
              ngramRank: null,
              rawTextRank: null,
              readerTextRank: match.readerTextRank,
              readerSnippet: match.readerSnippet,
              rrfScore: 1 / (60 + match.readerTextRank),
              normalizedScore: readerScore,
              matchedCount: match.matchedCount,
            },
          };
          selected.push(entry);
          selectedById.set(card.id, entry);
        }
        selected.sort((a, b) => b.rank.normalizedScore - a.rank.normalizedScore);
        selected.splice(limit);
        const scoringMs = performance.now() - rankingStartedAt;
        const keywords = ctx.buildSearchKeywordCandidates(body.config);
        const archiveThreshold = body.options?.archiveScoreThreshold ?? 0.5;
        const active: Array<Record<string, unknown>> = [];
        const archived: Array<Record<string, unknown>> = [];
        for (const { card, rank } of selected) {
          const article: Article = {
            id: card.id,
            title: card.title,
            body: card.body,
            summary: card.summary,
            publishedAt: new Date(card.createdAt),
            createdAt: card.createdAt,
            updatedAt: card.updatedAt,
            url: card.url ?? '',
            tags: card.tags,
            type: card.type,
            archived: card.archived,
            archivedAt: card.archivedAt,
            source: 'saved-card',
            sourceAuthority: 0.8,
          };
          const meta = ctx.buildSearchMatchMeta(article, keywords);
          const score = rank.normalizedScore;
          const item = {
            article,
            score,
            breakdown: {
              bm25Raw: rank.rrfScore,
              bm25Morphological: rank.morphologicalRank ? 1 / (60 + rank.morphologicalRank) : 0,
              bm25Ngram: rank.ngramRank ? 1 / (60 + rank.ngramRank) : 0,
              bm25RawText: rank.rawTextRank ? 1 / (60 + rank.rawTextRank) : 0,
              normalizedMorphological: rank.morphologicalRank ? (1 / (60 + rank.morphologicalRank)) / rank.rrfScore : 0,
              normalizedNgram: rank.ngramRank ? (1 / (60 + rank.ngramRank)) / rank.rrfScore : 0,
              tokenWeights: numericPhraseFallbackUsed
                ? { morphological: 0, ngram: 0, rawText: 1 }
                : useRawOnlyFts && !rawOnlyFallbackUsed
                ? { morphological: 0, ngram: 0, rawText: 1 }
                : useMorphologyOnlyFts && !rawOnlyFallbackUsed
                  ? { morphological: 1, ngram: 0, rawText: 0 }
                  : { morphological: 1 / 3, ngram: 1 / 3, rawText: 1 / 3 },
              contextBonus: 1,
              timeDecay: 1,
              finalScore: score,
              matchedTerms: [],
            },
            scoreSources: {
              method: rank.readerTextRank && !rank.morphologicalRank && !rank.ngramRank && !rank.rawTextRank ? 'sqlite-reader-text-fts5'
                : numericPhraseFallbackUsed ? 'sqlite-exact-numeric-phrase'
                : useRawOnlyFts && !rawOnlyFallbackUsed ? 'sqlite-fts5-raw-bm25'
                : useMorphologyOnlyFts && !rawOnlyFallbackUsed ? 'sqlite-fts5-morphological-bm25' : 'sqlite-fts5-rrf',
              rrfScore: rank.rrfScore,
              morphologicalRank: rank.morphologicalRank,
              ngramRank: rank.ngramRank,
              rawTextRank: rank.rawTextRank,
              readerTextRank: rank.readerTextRank ?? null,
              reciprocalRankConstant: 60,
            },
            ...meta,
            snippet: rank.readerSnippet || buildSearchSnippet(article, [...meta.matchedKeywords, ...keywords]),
          };
          if (score < archiveThreshold) archived.push({ ...item, reason: `スコア閾値割れ (${score.toFixed(3)} < ${archiveThreshold})` });
          else active.push(item);
        }
        const elapsedMs = performance.now() - startedAt;
        const count = savedCardCount();
        const allResults = [...active, ...archived];
        res.json({
          active,
          belowThreshold: archived,
          archived,
          stats: {
            inputCount: candidateCount,
            afterDedup: candidateCount,
            activeCount: active.length,
            archivedCount: archived.length,
            modeUsed: numericPhraseFallbackUsed ? 'saved-card-numeric-phrase-fallback'
              : useRawOnlyFts && !rawOnlyFallbackUsed ? 'saved-card-fts5-raw-bm25'
              : useMorphologyOnlyFts && !rawOnlyFallbackUsed ? 'saved-card-fts5-morphological-bm25' : 'saved-card-fts5-rrf',
            avgScore: active.length ? active.reduce((sum, item) => sum + Number(item.score), 0) / active.length : 0,
            timings: {
              tokenPreparationMs: Number(tokenPreparationMs.toFixed(3)),
              scoringMs: Number(scoringMs.toFixed(3)),
              sortingLimitMs: 0,
              totalSearchMs: Number(elapsedMs.toFixed(3)),
            },
          },
          scope: {
            corpus: 'cards',
            searchMethod: numericPhraseFallbackUsed ? 'numeric-phrase-scan-saved-cards'
              : useRawOnlyFts
              ? rawOnlyFallbackUsed ? 'fts5-raw-fallback-rrf-saved-cards' : 'fts5-raw-saved-cards'
              : useMorphologyOnlyFts
                ? rawOnlyFallbackUsed ? 'fts5-morph-fallback-rrf-saved-cards' : 'fts5-morph-saved-cards'
                : 'fts5-rrf-saved-cards',
            candidateCount,
            totalCount: count,
            searchedCount: count,
            sources: allResults.length ? ['saved-card'] : [],
            availableSources: count ? ['saved-card'] : [],
            bySource: { 'saved-card': { total: count, searched: candidateCount } },
            filtersApplied: { excludedTerms: body.filters?.excludedTerms ?? [], status: 'all', since: null, sources: [] },
            ...(process.env.NODE_ENV === 'test' && process.env.PERSONAL_REFIND_EVAL_CAPTURE === '1'
              ? { candidateIdsBeforeRerank: selected.map(({ card }) => card.id) } : {}),
            index: {
              morphology: !useRawOnlyFts || rawOnlyFallbackUsed,
              ngram: !useRawOnlyFts && !useMorphologyOnlyFts || rawOnlyFallbackUsed,
              raw: !useMorphologyOnlyFts || rawOnlyFallbackUsed,
              readerText: true,
              candidateCountExact: true,
            },
            readerTextCandidateCount: readerTextMatches[0]?.matchedCount ?? 0,
            fallbackUsed: rawOnlyFallbackUsed || numericPhraseFallbackUsed,
            directNumericPhraseFallback: numericPhraseFallbackUsed,
          },
        });
        return;
      }
      const cards = ctx.loadCards().filter(card => (!cardFilters?.tag || card.tags.includes(cardFilters.tag))
        && (!cardFilters?.kjGroupId || card.kjGroupId === cardFilters.kjGroupId)
        && (!cardFilters?.type || card.type === cardFilters.type)
        && (cardFilters?.archived === undefined || card.archived === cardFilters.archived));
      const excluded = (body.filters?.excludedTerms ?? []).map(term => term.normalize('NFKC').toLowerCase());
      const articles = cards.map((card): Article => ({
        id: card.id,
        title: card.title,
        body: card.body,
        summary: card.summary,
        publishedAt: new Date(card.createdAt),
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
        url: card.url ?? '',
        tags: card.tags,
        type: card.type,
        archived: card.archived,
        archivedAt: card.archivedAt,
        source: 'saved-card',
        sourceAuthority: 0.8,
        tokens: card.tokens,
        docLength: card.docLength,
        morphologicalTokens: card.morphologicalTokens,
        ngramTokens: card.ngramTokens,
        morphologicalDocLength: card.morphologicalDocLength,
        ngramDocLength: card.ngramDocLength,
      })).filter(card => !excluded.some(term => `${card.title} ${card.body} ${card.summary ?? ''}`.normalize('NFKC').toLowerCase().includes(term)));
      const resultLimit = Math.max(1, Math.min(500, body.options?.resultLimit ?? 50));
      const candidateLimit = useE5Rrf
        ? Math.max(resultLimit, Number(process.env.CARD_SEARCH_E5_CANDIDATES ?? 100))
        : resultLimit;
      const baselineOptions = {
        ...body.options,
        dedupThreshold: body.options?.dedupThreshold ?? 1,
        corpus: 'cards' as const,
      };
      let result = await ctx.runPipeline(articles, body.config, 'custom', {
        ...baselineOptions,
        ...(useE5Rrf ? { resultLimit: candidateLimit, archiveScoreThreshold: Number.NEGATIVE_INFINITY } : {}),
      });
      const articleById = new Map(articles.map(article => [article.id, article]));
      const readerTextMatches = searchSavedReaderText(queryTerms, Math.min(500, Math.max(candidateLimit, resultLimit * 4)), excluded);
      const readerSnippetById = new Map<string, string>();
      const mergeReaderCandidates = () => {
        const present = new Set([...result.active, ...result.archived].map(item => item.article.id));
        const archiveThreshold = body.options?.archiveScoreThreshold ?? 0.5;
        for (const match of readerTextMatches) {
          const article = articleById.get(match.id);
          if (!article || match.excludedTermMatched) continue;
          readerSnippetById.set(match.id, match.readerSnippet);
          if (present.has(match.id) || !match.readerSnippet) continue;
          const score = 61 / (60 + match.readerTextRank);
          const item = {
            article: { ...article, summary: [article.summary, match.readerSnippet].filter(Boolean).join('\n') },
            score,
            breakdown: {
              bm25Raw: 1 / (60 + match.readerTextRank),
              bm25Morphological: 0,
              bm25Ngram: 0,
              bm25RawText: 0,
              normalizedMorphological: 0,
              normalizedNgram: 0,
              tokenWeights: { morphological: 0, ngram: 0, rawText: 0 },
              contextBonus: 1,
              timeDecay: 1,
              finalScore: score,
              matchedTerms: [],
            },
            scoreSources: { method: 'sqlite-reader-text-fts5', readerTextRank: match.readerTextRank },
          } as typeof result.active[number];
          if (useE5Rrf || score >= archiveThreshold) result.active.push(item);
          else result.archived.push({ ...item, reason: `Reader本文検索スコア閾値割れ (${score.toFixed(3)} < ${archiveThreshold})` });
          present.add(match.id);
        }
        result.active.sort((a, b) => b.score - a.score);
        result.active = result.active.slice(0, useE5Rrf ? candidateLimit : resultLimit);
        result.belowThreshold = result.archived;
        result.stats.activeCount = result.active.length;
        result.stats.archivedCount = result.archived.length;
        result.stats.avgScore = result.active.length ? result.active.reduce((sum, item) => sum + item.score, 0) / result.active.length : 0;
      };
      mergeReaderCandidates();
      let candidateIdsBeforeRerank = [...result.active, ...result.archived].map(item => item.article.id);
      let e5FallbackUsed = false;
      let e5CandidateCount = 0;
      if (useE5Rrf && result.active.length) {
        e5CandidateCount = result.active.length;
        candidateIdsBeforeRerank = result.active.map(item => item.article.id);
        const e5Started = performance.now();
        const query = body.config.keywords.flatMap(keyword => [keyword.term, ...(keyword.synonyms ?? [])]).join(' ');
        try {
          const ranked = await rerankWithE5Rrf(result.active, query);
          const archiveThreshold = body.options?.archiveScoreThreshold ?? 0.5;
          const reranked = ranked.map(entry => ({
            ...entry.item,
            score: entry.normalizedScore,
            breakdown: { ...entry.item.breakdown, finalScore: entry.normalizedScore },
            scoreSources: {
              method: 'bm25-e5-rrf',
              model: 'multilingual-e5-small',
              bm25Score: entry.item.score,
              bm25Rank: entry.bm25Rank,
              e5Rank: entry.e5Rank,
              cosineSimilarity: entry.similarity,
              rrfScore: entry.rrfScore,
              rrfK: 60,
            },
          }));
          const eligible = reranked;
          const baselineScoreById = new Map(ranked.map(entry => [entry.item.article.id, entry.item.score]));
          const active = eligible.filter(item => baselineScoreById.get(item.article.id)! >= archiveThreshold);
          const belowThreshold = eligible.filter(item => baselineScoreById.get(item.article.id)! < archiveThreshold)
            .map(item => ({ article: item.article, reason: `BM25スコア閾値割れ (${baselineScoreById.get(item.article.id)!.toFixed(3)} < ${archiveThreshold})` }));
          result.active = active.slice(0, resultLimit);
          result.belowThreshold = belowThreshold.slice(0, Math.max(0, resultLimit - result.active.length));
          result.archived = result.belowThreshold;
          result.stats.activeCount = active.length;
          result.stats.archivedCount = belowThreshold.length;
          result.stats.avgScore = result.active.length ? result.active.reduce((sum, item) => sum + item.score, 0) / result.active.length : 0;
          result.stats.modeUsed = 'bm25-e5-rrf';
          if (result.stats.timings) result.stats.timings.e5RerankMs = Number((performance.now() - e5Started).toFixed(3));
        } catch (error) {
          e5FallbackUsed = true;
          logger.warn({ event: 'saved_card_e5_fallback', reason: error instanceof Error ? error.name : 'unknown' }, 'E5 reranking unavailable; using BM25 results');
          result = await ctx.runPipeline(articles, body.config, 'custom', baselineOptions);
          mergeReaderCandidates();
          candidateIdsBeforeRerank = [...result.active, ...result.archived].map(item => item.article.id);
        }
      }
      const keywords = ctx.buildSearchKeywordCandidates(body.config);
      const cleanArticle = (source: Article) => {
        const { tokens: _tokens, docLength: _docLength, morphologicalTokens: _morphologicalTokens,
          ngramTokens: _ngramTokens, morphologicalDocLength: _morphologicalDocLength,
          ngramDocLength: _ngramDocLength, ...article } = source;
        return article;
      };
      const serialize = (item: typeof result.active[number]) => {
        const article = cleanArticle(articleById.get(item.article.id) ?? item.article);
        const meta = ctx.buildSearchMatchMeta(article, keywords, item.breakdown?.matchedTerms);
        return { ...item, article, ...meta, snippet: readerSnippetById.get(article.id) || buildSearchSnippet(article, [...meta.matchedKeywords, ...keywords]) };
      };
      const searched = articles.length;
      res.json({
        ...result,
        scope: {
          corpus: 'cards',
          searchMethod: e5FallbackUsed ? 'bm25-e5-fallback-saved-cards' : useE5Rrf && result.stats.modeUsed === 'bm25-e5-rrf' ? 'bm25-e5-rrf-saved-cards' : cardSearchEngine === 'fts5' ? 'bm25-saved-cards-fallback' : 'bm25-saved-cards',
          fallbackUsed: e5FallbackUsed,
          e5CandidateCount,
          readerTextCandidateCount: readerTextMatches[0]?.matchedCount ?? 0,
          candidateCount: cards.length,
          totalCount: cards.length,
          searchedCount: searched,
          sources: searched ? ['saved-card'] : [],
          availableSources: cards.length ? ['saved-card'] : [],
          bySource: { 'saved-card': { total: cards.length, searched } },
          filtersApplied: { excludedTerms: body.filters?.excludedTerms ?? [], status: 'all', since: null, sources: [] },
          ...(process.env.NODE_ENV === 'test' && process.env.PERSONAL_REFIND_EVAL_CAPTURE === '1' ? { candidateIdsBeforeRerank } : {}),
        },
        active: result.active.map(serialize),
        archived: result.archived.map(item => ({ ...item, article: cleanArticle(item.article) })),
      });
    } catch (err) {
      logger.error({ event: 'saved_card_search_error', requestId: getRequestId(req), error: errorMeta(err) }, 'saved card search failed');
      sendError(req, res, 500, 'Internal server error');
    }
  });

  router.post('/cards', async (req, res) => {
    const body = parseBody(ctx.createCardSchema, req, res);
    if (!body) return;
    try {
      const card = await ctx.createCard({ type: 'memo', ...ctx.normalizeCardInput(body) });
      res.status(201).json(card);
    } catch (err) {
      logger.warn({ event: 'card_create_error', requestId: getRequestId(req), error: errorMeta(err) }, 'card create failed');
      sendError(req, res, 500, 'Internal server error', undefined, 'card_create_failed');
    }
  });

  router.get('/cards/:id', (req, res) => {
    const card = ctx.getCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    const backlinks = ctx.getBacklinks(req.params.id);
    res.json({ ...card, backlinks });
  });

  router.get('/cards/:id/export-md', (req, res) => {
    try {
    const card = ctx.getCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    const { markdown, filename } = buildCardMarkdown(card);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', markdownContentDisposition(filename));
    res.send(markdown);
    } catch { sendError(req, res, 500, 'Export failed', undefined, 'export_failed'); }
  });

  router.post('/cards/export-md-bulk', (req, res) => {
    try {
    const body = parseBody(ctx.idsBodySchema, req, res);
    if (!body) return;
    const result = buildBulkMarkdownZip(body.ids);
    if (!result) {
      sendError(req, res, 404, 'Not found', undefined, 'card_not_found');
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', markdownContentDisposition(result.filename));
    res.send(result.zip);
    } catch { sendError(req, res, 500, 'Export failed', undefined, 'export_failed'); }
  });

  router.put('/cards/:id', async (req, res) => {
    const body = parseBody(ctx.updateCardSchema, req, res);
    if (!body) return;
    const card = await ctx.updateCard(req.params.id, ctx.normalizeCardInput(body));
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    res.json(card);
  });

  router.delete('/cards/:id', (req, res) => {
    const ok = ctx.deleteCard(req.params.id);
    if (!ok) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    res.json({ ok });
  });

  router.put('/cards/:id/archive', async (req, res) => {
    const card = await ctx.updateCard(req.params.id, { archived: true, archivedAt: new Date().toISOString() });
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    res.json(card);
  });

  router.put('/cards/:id/unarchive', async (req, res) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', 'use POST /cards/:id/restore');
    const card = await ctx.restoreCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    res.json(card);
  });

  router.post('/cards/:id/restore', async (req, res) => {
    const card = await ctx.restoreCard(req.params.id);
    if (!card) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    res.json(card);
  });

  router.post('/cards/archive-bulk', (req, res) => {
    res.setHeader('Deprecation', 'true');
    const body = parseBody(ctx.idsBodySchema, req, res);
    if (!body) return;
    const updated = ctx.bulkArchiveCards(body.ids);
    res.json({ ok: true, updated });
  });

  router.post('/cards/bulk-archive', (req, res) => {
    const body = parseBody(ctx.idsBodySchema, req, res);
    if (!body) return;
    const updated = ctx.bulkArchiveCards(body.ids);
    res.json({ ok: true, updated });
  });

  router.post('/cards/bulk-restore', (req, res) => {
    const body = parseBody(ctx.idsBodySchema, req, res);
    if (!body) return;
    const updated = ctx.bulkRestoreCards(body.ids);
    res.json({ ok: true, updated });
  });

  router.post('/cards/bulk-delete', (req, res) => {
    const body = parseBody(ctx.idsBodySchema, req, res);
    if (!body) return;
    const deleted = ctx.bulkDeleteCards(body.ids);
    res.json({ ok: true, deleted });
  });

  router.post('/cards/:id/links', (req, res) => {
    const body = parseBody(ctx.linkBodySchema, req, res);
    if (!body) return;
    if (req.params.id === body.targetId) {
      invalidRequest(req, res, [{ path: 'targetId', message: 'Cannot link a card to itself' }]);
      return;
    }
    if (!ctx.getCard(req.params.id) || !ctx.getCard(body.targetId)) {
      sendError(req, res, 404, 'Not found', undefined, 'card_not_found');
      return;
    }
    ctx.linkCards(req.params.id, body.targetId);
    res.json({ ok: true });
  });

  router.delete('/cards/:id/links/:targetId', (req, res) => {
    if (!ctx.getCard(req.params.id) || !ctx.getCard(req.params.targetId)) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    if (!ctx.unlinkCards(req.params.id, req.params.targetId)) { sendError(req, res, 404, 'Link not found', undefined, 'link_not_found'); return; }
    res.json({ ok: true });
  });

  router.get('/cards/:id/backlinks', (req, res) => {
    if (!ctx.getCard(req.params.id)) { sendError(req, res, 404, 'Not found', undefined, 'card_not_found'); return; }
    res.json(ctx.getBacklinks(req.params.id));
  });

  router.get('/zettelkasten/graph', (req, res) => {
    const rawQuery = req.query as Record<string, unknown>;
    const limit = normalizeQueryNumber(rawQuery.limit, 1, 5000) ?? 1000;
    const offset = normalizeQueryNumber(rawQuery.offset, 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const cards = ctx.loadCards();
    const linkedIds = new Set<string>();
    for (const card of cards) {
      if (card.links?.length) {
        linkedIds.add(card.id);
        for (const linkId of card.links) linkedIds.add(linkId);
      }
    }
    const allVisibleCards = cards.filter((card: Card) => linkedIds.has(card.id));
    const visibleCards = allVisibleCards.slice(offset, offset + limit);
    const nodes = visibleCards.map((card: Card) => ({
      id: card.id,
      label: card.title.slice(0, 40),
      title: card.summary ?? card.body.slice(0, 100),
      group: card.type,
      color: card.color,
    }));
    const edges: { from: string; to: string }[] = [];
    for (const card of visibleCards) {
      for (const linkId of card.links) {
        if (!linkedIds.has(linkId)) continue;
        edges.push({ from: card.id, to: linkId });
      }
    }
    res.json({ nodes, edges, total: allVisibleCards.length, limit, offset });
  });

  // Tidying tags: spellings of the same tag, tags used once, and merging (with a dry run first).
  router.get('/tags/tidy', (_req, res) => {
    const tags = ctx.getAllTags() as Array<{ tag: string; count: number }>;
    res.json({ variants: tagVariantGroups(tags), usedOnce: tags.filter(item => item.count === 1).map(item => item.tag).sort((a, b) => a.localeCompare(b, 'ja')), total: tags.length });
  });

  router.post('/tags/merge', async (req, res) => {
    const body = parseBody(z.object({ from: z.array(z.string().trim().min(1).max(100)).min(1).max(50), to: z.string().trim().min(1).max(100), dryRun: z.boolean().default(false) }).strict(), req, res);
    if (!body) return;
    const from = body.from.filter(tag => tag !== body.to);
    const cards = (ctx.loadCards() as Card[]).filter(card => (card.tags ?? []).some(tag => from.includes(tag)));
    if (body.dryRun) { res.json({ cards: cards.length, titles: cards.slice(0, 10).map(card => card.title) }); return; }
    let changed = 0;
    for (const card of cards) {
      if (await ctx.updateCard(card.id, { tags: mergeTagList(card.tags ?? [], from, body.to) })) changed += 1;
    }
    res.json({ changed, to: body.to });
  });

  router.get('/tags', (req, res) => {
    const rawQuery = req.query as Record<string, unknown>;
    const limit = normalizeQueryNumber(rawQuery.limit, 1, 5000) ?? 1000;
    const offset = normalizeQueryNumber(rawQuery.offset, 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const tags = ctx.getAllTags();
    if (typeof rawQuery.limit === 'undefined' && typeof rawQuery.offset === 'undefined') { res.json(tags); return; }
    res.json({ items: tags.slice(offset, offset + limit), total: tags.length, limit, offset });
  });

  return router;
}

