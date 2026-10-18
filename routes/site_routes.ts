import express from 'express';
import { z } from 'zod';
import type { RouteContext } from '../services/route_context.js';
import { parseBody, sendError } from '../services/http_service.js';
import { safeFetch, type SafeFetcher } from '../services/safe_fetch.js';
import { ADAPTER_LABELS, detectSite, fetchRobots, inspectUrl, type DetectResult } from '../services/site_adapters.js';
import { assessSiteRun, enrichSamples, syncSite } from '../services/site_collector.js';
import { acceptsUrl, isSharedHost, normalizeSiteUrl, scopePrefixes } from '../services/site_parsing.js';
import {
  createSite,
  deleteSite,
  findSiteByUrl,
  findSiteForUrl,
  unsavedSiteArticleIds,
  getSite,
  listSites,
  siteArticleCounts,
  siteSourceTag,
  updateSite,
  type SiteSource,
} from '../repositories/site_sources_repository.js';
import { isDemoMode } from '../services/demo_service.js';

const prefixesSchema = z.array(z.string().trim().min(1).max(300)).max(5);
const urlSchema = z.object({ url: z.string().trim().min(4).max(2000), prefixes: prefixesSchema.optional() }).strict();
const bodyPolicySchema = z.enum(['pending', 'metadata', 'body']);
const createSchema = z.object({
  url: z.string().trim().min(4).max(2000),
  name: z.string().trim().min(1).max(100).optional(),
  bodyPolicy: bodyPolicySchema.default('pending'),
  maxInitial: z.number().int().min(1).max(500).default(50),
  /** the scope as shown (and possibly edited) in the preview */
  prefixes: prefixesSchema.optional(),
  /** the whole host was shown and the user accepted it */
  confirmWholeSite: z.boolean().default(false),
}).strict();
const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  bodyPolicy: bodyPolicySchema.optional(),
  maxInitial: z.number().int().min(1).max(500).optional(),
  enabled: z.boolean().optional(),
}).strict();

const DEMO_MAX_SITES = 5;

export const STATUS_LABELS: Record<string, string> = {
  ok: '正常',
  checking: '更新確認中',
  partial: '一部取得失敗',
  error: '取得失敗',
  unsupported: '自動取得不可',
};
export const BODY_POLICY_LABELS: Record<string, string> = {
  pending: '利用条件の確認待ち（タイトル・概要のみ）',
  metadata: 'タイトル・概要のみ',
  body: '本文も取得（利用条件を確認済み）',
};

function present(site: SiteSource, counts: ReturnType<typeof siteArticleCounts>) {
  const count = counts.get(site.id) ?? { articles: 0, withBody: 0, missing: 0, gone: 0, restricted: 0, error: 0 };
  return {
    ...site,
    source: siteSourceTag(site.id),
    prefixes: scopePrefixes(site.scope),
    adapterLabel: ADAPTER_LABELS[site.adapter.type],
    statusLabel: !site.enabled ? '自動収集を停止中' : site.status === 'ok' ? '収集中' : (STATUS_LABELS[site.status] ?? site.status),
    missingCount: count.missing,
    goneCount: count.gone,
    restrictedCount: count.restricted,
    errorCount: count.error,
    unsavedCount: unsavedSiteArticleIds(site.id).length,
    bodyPolicyLabel: BODY_POLICY_LABELS[site.bodyPolicy],
    articleCount: count.articles,
    bodyCount: count.withBody,
    pastArticles: site.adapter.type !== 'feed',
  };
}

export function createSiteRouter(ctx: RouteContext, fetch: SafeFetcher = safeFetch) {
  const router = express.Router();

  const refreshArticles = () => ctx.setCachedArticles(ctx.loadArticles());

  router.get('/sites', (_req, res) => {
    const counts = siteArticleCounts();
    res.json({ sites: listSites().map(site => present(site, counts)) });
  });

  const describe = async (detected: DetectResult) => {
    if (!detected.ok) return { ...detected, adapterLabel: null, availableLabels: [], existing: null, plan: null };
    const { robots } = await fetchRobots(fetch, new URL(detected.siteUrl).origin);
    const preview = await enrichSamples(detected, fetch, robots);
    const existing = findSiteByUrl(preview.siteUrl);
    return {
      ...preview,
      adapterLabel: preview.adapter ? ADAPTER_LABELS[preview.adapter.type] : null,
      availableLabels: preview.available.map(type => ADAPTER_LABELS[type]),
      existing: existing ? { id: existing.id, name: existing.name } : null,
      plan: {
        initialCount: preview.estimatedCount != null ? Math.min(50, preview.estimatedCount) : null,
        pastArticles: preview.adapter?.type !== 'feed',
        pagesAllowed: preview.robots.pagesAllowed,
        sharedHost: isSharedHost(preview.scope.hosts[0] ?? ''),
      },
    };
  };

  // Look at a URL before registering it. A blog's top page → how its articles can be found; an article
  // → the blog it belongs to (up to two possible scopes), or the registered source it is already in.
  // prefixes: the scope edited by the user (only the host of the URL, never another one).
  router.post('/sites/preview', ctx.readerLimiter, async (req, res) => {
    const body = parseBody(urlSchema, req, res);
    if (!body) return;
    if (body.prefixes?.length) {
      res.json({ kind: 'source', article: null, alreadyIn: null, error: null, candidates: [await describe(await detectSite(body.url, fetch, { prefixes: body.prefixes }))] });
      return;
    }
    const inspected = await inspectUrl(body.url, fetch);
    const alreadyIn = inspected.article ? findSiteForUrl(inspected.article.url, (url, site) => acceptsUrl(url, site.scope)) : null;
    const candidates = [];
    for (const candidate of inspected.candidates) candidates.push(await describe(candidate));
    res.json({ ...inspected, alreadyIn: alreadyIn ? { id: alreadyIn.id, name: alreadyIn.name } : null, candidates });
  });

  // Register: the server looks at the site again (the client's preview is not trusted), saves it,
  // and starts the first collection in the background.
  router.post('/sites', ctx.readerLimiter, async (req, res) => {
    const body = parseBody(createSchema, req, res);
    if (!body) return;
    if (isDemoMode() && listSites().length >= DEMO_MAX_SITES) { sendError(req, res, 403, `デモ版で登録できるサイトは${DEMO_MAX_SITES}件までです`, undefined, 'request_failed'); return; }
    let normalized: string;
    try { normalized = normalizeSiteUrl(body.url).toString(); } catch { sendError(req, res, 400, 'URLの形式が正しくありません', undefined, 'request_failed'); return; }
    const already = findSiteByUrl(normalized);
    if (already) { sendError(req, res, 409, `このサイトは登録済みです（${already.name}）`, { id: already.id }, 'request_failed'); return; }
    const detected = await detectSite(body.url, fetch, body.prefixes?.length ? { prefixes: body.prefixes } : {});
    if (!detected.ok || !detected.adapter) { sendError(req, res, 422, detected.error ?? 'このサイトは自動では登録できません', { notes: detected.notes }, 'request_failed'); return; }
    if (detected.needsScopeConfirm && !body.confirmWholeSite) { sendError(req, res, 422, 'サイト全体が対象になります。対象の範囲を確認してください', { prefixes: detected.prefixes }, 'request_failed'); return; }
    const duplicate = findSiteByUrl(detected.siteUrl);
    if (duplicate) { sendError(req, res, 409, `このサイトは登録済みです（${duplicate.name}）`, { id: duplicate.id }, 'request_failed'); return; }
    const site = createSite({ siteUrl: detected.siteUrl, name: body.name ?? detected.name, scope: detected.scope, adapter: detected.adapter, bodyPolicy: body.bodyPolicy, maxInitial: body.maxInitial });
    const job = ctx.submitJob('site-initial-collect', async () => {
      const result = await syncSite(site, fetch, 'initial');
      refreshArticles();
      return result;
    }, assessSiteRun);
    res.status(201).json({ site: present(getSite(site.id)!, siteArticleCounts()), jobId: job.id });
  });

  router.put('/sites/:id', (req, res) => {
    const body = parseBody(updateSchema, req, res);
    if (!body) return;
    const site = updateSite(String(req.params.id), body);
    if (!site) { sendError(req, res, 404, 'Not found', undefined, 'request_failed'); return; }
    res.json({ site: present(site, siteArticleCounts()) });
  });

  // Check now (instead of waiting for the daily check).
  router.post('/sites/:id/sync', ctx.readerLimiter, (req, res) => {
    const site = getSite(String(req.params.id));
    if (!site) { sendError(req, res, 404, 'Not found', undefined, 'request_failed'); return; }
    if (site.status === 'checking' && site.updatedAt && Date.now() - Date.parse(site.updatedAt) < 10 * 60_000) { sendError(req, res, 409, '更新を確認中です', undefined, 'request_failed'); return; }
    const job = ctx.submitJob('site-sync', async () => {
      const result = await syncSite(site, fetch);
      refreshArticles();
      return result;
    }, assessSiteRun);
    res.status(202).json({ jobId: job.id });
  });

  // Unregister. Cards, memos, quotes and tags are never deleted. The site's collected articles that
  // were not saved are kept unless ?articles=delete is given (the screen asks the user which).
  router.delete('/sites/:id', (req, res) => {
    const choice = String(req.query.articles ?? '');
    if (choice !== 'keep' && choice !== 'delete') { sendError(req, res, 400, '未保存の記事を残すか削除するか（articles=keep|delete）を指定してください', undefined, 'request_failed'); return; }
    const result = deleteSite(String(req.params.id), { removeUnsavedArticles: choice === 'delete' });
    if (!result.deleted) { sendError(req, res, 404, 'Not found', undefined, 'request_failed'); return; }
    refreshArticles();
    res.json({ ok: true, removedArticles: result.removedArticles });
  });

  return router;
}
