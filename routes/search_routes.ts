import { loadArticlesFromDb, prepareReaderContent, storeReaderContent } from '../repositories/articles_repository.js';
import { overviewTopics, titleTerms, trendTopics } from '../services/topic_insights.js';
import { analyzeQuery } from '../services/query_analysis.js';
import { buildSearchSnippet } from '../services/search_match_service.js';
import express from 'express';
import type { RouteContext } from '../services/route_context.js';
import { errorMeta, logger } from '../utils/logger.js';
import { getRequestId, parseBody, sendError } from '../services/http_service.js';
import type { Card } from '../domain/card.js';
import type { Article } from '../bm25_engine.js';
import { buildStoredTokenSet } from '../bm25_engine.js';
import { db } from '../db/database.js';
import { DEMO_SEARCH_MODE, isDemoMode } from '../services/demo_service.js';
import { z } from 'zod';
import { DISCOVER_SOURCES, PROVIDERS, purposeTermWeight, purposeWords } from '../services/discover_service.js';
import { articleAvailability, listSites, siteArticleCounts } from '../repositories/site_sources_repository.js';
import { BODY_POLICY_LABELS, STATUS_LABELS } from './site_routes.js';

type SearchInputArticle = Partial<Article> & Pick<Article, 'id' | 'title' | 'body'> & {
  publishedAt: string | Date;
  sourceAuthority?: number;
  url?: string;
};

function articleSources(article: Partial<Article>): string[] {
  return article.sources?.length ? article.sources : [article.source ?? 'unknown'];
}

export function createSearchRouter(ctx: RouteContext) {
  const router = express.Router();

  // Demo: a first preset whose words match the sample documents, so the first search finds them.
  router.get('/modes', (_req, res) => res.json(isDemoMode() ? { demo: DEMO_SEARCH_MODE, ...ctx.MODES } : ctx.MODES));

  router.post('/run', async (req, res) => {
    const body = parseBody(ctx.runBodySchema, req, res);
    if (!body) return;
    try {
      const { modeId, config, articles: reqArticles, options, filters } = body;
      const rawArticles = (reqArticles ?? loadArticlesFromDb()) as SearchInputArticle[];
      // Older DBs may have reader copies without dual token caches: repair once, persist for reuse.
      if (!reqArticles) for (const article of rawArticles) {
        if (!article.ngramTokens?.length || !article.morphologicalTokens?.length) {
          const hasReader = db.prepare('SELECT 1 FROM article_reader_content WHERE article_id = ?').get(article.id);
          const content = hasReader ? await prepareReaderContent(article.url ?? null, article.body) : null;
          storeReaderContent(content, new Date().toISOString());
          const stored = content?.tokens ?? await buildStoredTokenSet(`${article.title} ${article.body}`);
          Object.assign(article, stored, { tokens: stored.ngramTokens, docLength: stored.ngramDocLength });
          if (!content) db.prepare(`UPDATE articles SET tokens_json=?, morphological_tokens_json=?, ngram_tokens_json=?, doc_length=?, morphological_doc_length=?, ngram_doc_length=? WHERE id=?`)
            .run(JSON.stringify(stored.ngramTokens), JSON.stringify(stored.morphologicalTokens), JSON.stringify(stored.ngramTokens), stored.ngramDocLength, stored.morphologicalDocLength, stored.ngramDocLength, article.id);
        }
      }
      const candidates = new Map(ctx.getCandidates().map(candidate => [candidate.candidateId, candidate]));
      const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
      const filteredArticles = rawArticles.filter(article => {
        const candidate = reqArticles ? undefined : candidates.get(article.id);
        if (filters?.since && (!candidate || candidate.firstSeenAt <= filters.since)) return false;
        if (candidate?.status === 'expired') return false;
        if (filters?.status && filters.status !== 'all' && candidate?.status !== filters.status) return false;
        if (filters?.sources.length && !articleSources(article).some(source => filters.sources.includes(source))) return false;
        const content = normalize(`${article.title} ${article.body} ${article.summary ?? ''}`);
        return !filters?.excludedTerms.some(term => content.includes(normalize(term)));
      });
      const scope = {
        corpus: reqArticles ? 'cards' : 'articles',
        totalCount: rawArticles.length,
        searchedCount: filteredArticles.length,
        sources: [...new Set(filteredArticles.flatMap(articleSources))],
        availableSources: [...new Set(rawArticles.flatMap(articleSources))],
        // per source: how many articles exist and how many were left after the filters (for "0 results" help)
        bySource: (() => {
          const out: Record<string, { total: number; searched: number }> = {};
          for (const article of rawArticles) for (const key of articleSources(article)) { (out[key] ??= { total: 0, searched: 0 }).total += 1; }
          for (const article of filteredArticles) for (const key of articleSources(article)) { (out[key] ??= { total: 0, searched: 0 }).searched += 1; }
          return out;
        })(),
        filtersApplied: {
          excludedTerms: filters?.excludedTerms ?? [],
          status: filters?.status ?? 'all',
          since: filters?.since ?? null,
          sources: filters?.sources ?? [],
        },
      };
      const cardsById = new Map(ctx.loadCards().map((card: Card) => [card.id, card]));
      const parsed: Article[] = filteredArticles.map(art => {
        const stored = reqArticles ? cardsById.get(art.id) : undefined;
        return {
          id: art.id,
          title: stored?.title ?? art.title,
          body: stored?.body ?? art.body,
          publishedAt: new Date(art.publishedAt),
          publicationDateKnown: art.publicationDateKnown,
          sourceAuthority: art.sourceAuthority ?? 0,
          url: stored?.url ?? art.url ?? '',
          source: art.source ?? undefined,
          sources: art.sources,
          tokens: stored?.tokens ?? art.tokens,
          docLength: stored?.docLength ?? art.docLength,
          morphologicalTokens: stored?.morphologicalTokens ?? art.morphologicalTokens,
          ngramTokens: stored?.ngramTokens ?? art.ngramTokens,
          morphologicalDocLength: stored?.morphologicalDocLength ?? art.morphologicalDocLength,
          ngramDocLength: stored?.ngramDocLength ?? art.ngramDocLength,
          summary: stored?.summary ?? art.summary ?? undefined,
          tags: stored?.tags ?? art.tags ?? [],
          type: stored?.type ?? art.type ?? undefined,
          createdAt: stored?.createdAt ?? art.createdAt ?? undefined,
          updatedAt: stored?.updatedAt ?? art.updatedAt ?? undefined,
          archived: stored?.archived ?? art.archived ?? undefined,
          archivedAt: stored?.archivedAt ?? art.archivedAt ?? undefined,
        };
      });
      for (const article of parsed) {
        if (!article.tokens?.length) {
          const stored = await buildStoredTokenSet(`${article.title} ${article.body}`);
          Object.assign(article, stored, { tokens: stored.ngramTokens, docLength: stored.ngramDocLength });
        }
      }
      const result = await ctx.runPipeline(parsed, config, modeId ?? 'custom', { ...options, corpus: reqArticles ? 'cards' : 'articles', ...(!reqArticles ? { dedupThreshold: 1 } : {}) });
      const stripSearchFields = (article: Article) => {
        const { tokens: _tokens, docLength: _docLength, ...publicArticle } = article;
        return {
          ...publicArticle,
          summary: publicArticle.summary ?? null,
          tags: publicArticle.tags ?? [],
          type: publicArticle.type ?? 'article',
          createdAt: publicArticle.createdAt ?? publicArticle.publishedAt,
          archived: publicArticle.archived ?? false,
        };
      };
      const updateRankingMetadata = db.prepare("UPDATE articles SET candidate_score = ?, candidate_match_reason = ?, updated_at = updated_at WHERE id = ?");
      const rankingReason = (item: { breakdown?: { matchedTerms?: Array<{ term?: string }> } }, meta: { matchedFields: string[]; matchedKeywords: string[] }) => {
        const fields = meta.matchedFields.length ? meta.matchedFields.join(", ") : "本文一致";
        const keywords = meta.matchedKeywords.length ? `キーワード: ${meta.matchedKeywords.join(", ")}` : "キーワード一致";
        return `${fields} / ${keywords}`;
      };
      const availability = articleAvailability(result.active.map(item => item.article.id));
      const response = {
        ...result,
        scope,
        active: result.active.map(item => {
          const article = stripSearchFields(item.article);
          const meta = ctx.buildSearchMatchMeta(article, ctx.buildSearchKeywordCandidates(config), item.breakdown?.matchedTerms);
          updateRankingMetadata.run(item.score, rankingReason(item, meta), item.article.id);
          return { ...item, article, ...meta,
            snippet: buildSearchSnippet(article, [...meta.matchedKeywords, ...ctx.buildSearchKeywordCandidates(config)]),
            candidate: reqArticles ? null : candidates.get(article.id) ? { status: candidates.get(article.id)!.status, savedCardId: candidates.get(article.id)!.savedCardId } : null,
            availability: availability.get(item.article.id) ?? null,
          };
        }),
        archived: result.archived.map(item => {
          const article = stripSearchFields(item.article);
          const meta = ctx.buildSearchMatchMeta(article, ctx.buildSearchKeywordCandidates(config));
          return { ...item, article, ...meta,
            snippet: buildSearchSnippet(article, [...meta.matchedKeywords, ...ctx.buildSearchKeywordCandidates(config)]),
            candidate: reqArticles ? null : candidates.get(article.id) ? { status: candidates.get(article.id)!.status, savedCardId: candidates.get(article.id)!.savedCardId } : null,
          };
        }),
      };
      logger.debug({
        event: 'search_results',
        requestId: getRequestId(req),
        resultCount: response.active.length + response.archived.length,
      }, 'BM25 search results prepared');
      res.json(response);
    } catch (err) {
      logger.error({ event: 'search_error', requestId: getRequestId(req), error: errorMeta(err) }, 'BM25 search failed');
      sendError(req, res, 500, 'Internal server error', undefined, 'search_failed');
    }
  });

  // What the search screen can look in: collected sources (registered sites by name, feeds, ...),
  // the user's cards, and the web sources searched on the spot.
  router.get('/search/targets', (_req, res) => {
    const rows = db.prepare(`SELECT s.source, COUNT(DISTINCT a.id) AS count, COUNT(DISTINCT CASE WHEN a.body_kind='fulltext' THEN a.id END) AS with_body, MAX(COALESCE(a.last_fetched_at, a.updated_at)) AS last_fetched_at
      FROM articles a JOIN article_sources s ON s.article_id=a.id WHERE COALESCE(a.candidate_status, 'unreviewed') != 'expired' GROUP BY s.source`).all() as Array<{ source: string; count: number; with_body: number; last_fetched_at: string | null }>;
    const counts = new Map(rows.map(row => [row.source, row]));
    const siteCounts = siteArticleCounts();
    const sites = listSites().map(site => ({
      value: `site:${site.id}`,
      label: site.name,
      kind: 'site' as const,
      count: counts.get(`site:${site.id}`)?.count ?? 0,
      bodyCount: counts.get(`site:${site.id}`)?.with_body ?? 0,
      lastCheckedAt: site.lastCheckedAt,
      status: site.status,
      statusLabel: STATUS_LABELS[site.status] ?? site.status,
      bodyPolicy: site.bodyPolicy,
      bodyPolicyLabel: BODY_POLICY_LABELS[site.bodyPolicy],
      pastArticles: site.adapter.type !== 'feed',
      lastError: site.lastError,
      enabled: site.enabled,
      missingCount: (siteCounts.get(site.id)?.missing ?? 0) + (siteCounts.get(site.id)?.gone ?? 0),
      searchable: (counts.get(`site:${site.id}`)?.with_body ?? 0) > 0 ? ((counts.get(`site:${site.id}`)?.with_body ?? 0) >= (counts.get(`site:${site.id}`)?.count ?? 0) ? 'fulltext' : 'mixed') : 'title_summary',
    }));
    const config = ctx.getCollectorConfig();
    const configuredSources = [...config.rss.map(source => `rss:${source.label}`), ...config.arxiv.map(source => `arxiv:${source.query}`), ...config.github.map(source => `github:${source.language}`)];
    const feedRows = [...rows, ...configuredSources.filter(source => !counts.has(source)).map(source => ({ source, count: 0, with_body: 0, last_fetched_at: null }))];
    const feeds = [...new Map(feedRows.filter(row => !row.source.startsWith('site:')).map(row => [row.source, row])).values()].map(row => ({
      value: row.source,
      label: row.source.replace(/^rss:/, '').replace(/^arxiv:/, 'arXiv: ').replace(/^github:/, 'GitHub: '),
      kind: 'feed' as const,
      count: row.count,
      lastCheckedAt: row.last_fetched_at,
      searchable: row.with_body > 0 ? (row.with_body >= row.count ? 'fulltext' : 'mixed') : 'title_summary',
    }));
    res.json({
      collected: [...sites, ...feeds],
      collectedTotal: (db.prepare("SELECT COUNT(*) AS count FROM articles WHERE COALESCE(candidate_status,'unreviewed')!='expired'").get() as {count: number}).count,
      cards: { value: 'cards', label: '自分のカード', count: ctx.loadCards().length },
      web: DISCOVER_SOURCES.map(id => ({ value: `web:${id}`, label: id === 'hatena' ? 'はてブ（Zenn・ブログ）' : PROVIDERS[id].label, kind: 'web' as const })),
    });
  });

  // Saved searches: how many articles arrived since each was last marked "checked" (新着を待つ).
  router.get('/search/new-counts', async (_req, res) => {
    const saved = db.prepare('SELECT id, payload FROM saved_searches').all() as Array<{ id: string; payload: string }>;
    const checkpoints = new Map((db.prepare('SELECT search_id, checked_at FROM search_checkpoints').all() as Array<{ search_id: string; checked_at: string }>).map(row => [row.search_id, row.checked_at]));
    const candidates = new Map(ctx.getCandidates().map(candidate => [candidate.candidateId, candidate]));
    const articles = loadArticlesFromDb();
    const counts: Record<string, { newCount: number; checkedAt: string | null }> = {};
    for (const row of saved) {
      const search = JSON.parse(row.payload);
      const checkedAt = checkpoints.get(row.id) ?? null;
      if (search.source !== 'articles' || !checkedAt || !search.config?.keywords?.length) { counts[row.id] = { newCount: 0, checkedAt }; continue; }
      const sources: string[] = search.filters?.sources ?? [];
      const excluded: string[] = (search.filters?.excludedTerms ?? []).map((term: string) => term.normalize('NFKC').toLowerCase());
      const fresh = articles.filter(article => {
        const candidate = candidates.get(article.id);
        if (!candidate || candidate.firstSeenAt <= checkedAt || candidate.status === 'expired') return false;
        if (sources.length && !articleSources(article).some(source => sources.includes(source))) return false;
        const content = `${article.title} ${article.body}`.normalize('NFKC').toLowerCase();
        return !excluded.some(term => content.includes(term));
      });
      if (!fresh.length) { counts[row.id] = { newCount: 0, checkedAt }; continue; }
      const result = await ctx.runPipeline(fresh, search.config, 'saved', { ...(search.options ?? {}), dedupThreshold: 1, corpus: 'articles' });
      counts[row.id] = { newCount: result.active.length, checkedAt };
    }
    res.json({ counts });
  });

  // A sentence or a few words → keywords with weights (no AI): content words of the text,
  // English / alphanumeric words weighing more (they usually name the topic).
  // Broad questions: "今の傾向" (words rising in the collected articles) and "全体像" (results by shared words).
  router.post('/search/insights', async (req, res) => {
    const body = parseBody(z.object({
      kind: z.enum(['trend', 'overview']),
      sources: z.array(z.string().max(200)).max(200).default([]),
      ids: z.array(z.string().max(300)).max(500).default([]),
      terms: z.array(z.string().max(100)).max(20).default([]),
      days: z.number().int().min(7).max(365).default(30),
    }).strict(), req, res);
    if (!body) return;
    const where: string[] = ["COALESCE(a.candidate_status, 'unreviewed') != 'expired'"];
    const params: string[] = [];
    if (body.kind === 'overview') {
      if (!body.ids.length) { res.json({ topics: [], rest: [] }); return; }
      where.push(`a.id IN (${body.ids.map(() => '?').join(',')})`);
      params.push(...body.ids);
    } else if (body.sources.length) {
      where.push(`a.id IN (SELECT article_id FROM article_sources WHERE source IN (${body.sources.map(() => '?').join(',')}))`);
      params.push(...body.sources);
    }
    const rows = db.prepare(`SELECT a.id, a.title, a.url, a.published_at FROM articles a WHERE ${where.join(' AND ')}`).all(...params) as Array<{ id: string; title: string; url: string | null; published_at: string | null }>;
    const articles = await Promise.all(rows.map(async row => ({ id: row.id, title: row.title, url: row.url, publishedAt: row.published_at, tokens: await titleTerms(row.title ?? '') })));
    if (body.kind === 'trend') res.json({ ...trendTopics(articles, { days: body.days }), searched: articles.length });
    else res.json(overviewTopics(articles, body.terms));
  });

  router.post('/search/terms', async (req, res) => {
    const body = parseBody(z.object({ text: z.string().trim().min(1).max(500) }).strict(), req, res);
    if (!body) return;
    const spaced = body.text.split(/\s+/).filter(Boolean);
    const words = await purposeWords(body.text);
    const terms = words.length ? words : spaced;
    // generic words ("問題", "最近") count for little; a question with no topic word is "broad"
    const analysis = analyzeQuery(body.text, terms, term => (purposeTermWeight(term) === 3 ? 1.5 : 1));
    res.json({ keywords: analysis.keywords, analysis: { intent: analysis.intent, intentLabel: analysis.intentLabel, genericTerms: analysis.genericTerms, specificTerms: analysis.specificTerms, broad: analysis.broad, reason: analysis.reason } });
  });

  router.post('/search/expand-keywords', ctx.aiLimiter, async (req, res) => {
    const body = parseBody(ctx.keywordExpandSchema, req, res);
    if (!body) return;
    try {
      const original = new Set(body.keywords.map((keyword: string) => keyword.toLowerCase()));
      const seen = new Set(original);
      const expandedKeywords = (await ctx.expandSearchKeywords(body.keywords))
        .map((keyword: string) => keyword.trim())
        .filter((keyword: string) => {
          const key = keyword.toLowerCase();
          if (!keyword || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 10);
      res.json({ expandedKeywords });
    } catch (err) {
      if (ctx.isAiSummaryError(err)) {
        logger.warn({
          event: 'ai_keyword_expand_error',
          requestId: getRequestId(req),
          code: err.code,
          statusCode: err.status,
          provider: ctx.AI_PROVIDER,
          error: errorMeta(err),
        }, 'keyword expansion provider error');
        res.status(err.status).json({ error: err.message, code: err.code, requestId: getRequestId(req) });
        return;
      }
      logger.error({ event: 'ai_keyword_expand_error', requestId: getRequestId(req), error: errorMeta(err) }, 'keyword expansion failed');
      sendError(req, res, 500, 'Internal server error', [{ code: 'api_error' }]);
    }
  });

  return router;
}
