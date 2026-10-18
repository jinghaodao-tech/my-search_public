/**
 * Collecting the articles of registered sites into the articles table.
 *
 * - First run: up to the site's limit (50 by default) of its newest articles.
 * - Later runs (about once a day): only articles not seen before (a URL list per site),
 *   plus articles whose update date moved, a few at a time. No full re-crawl.
 * - Same article = same normalised URL (canonical URL when the page names one inside the site).
 * - Page fetches respect robots.txt. Full text is fetched only when the user said the site's
 *   terms allow it (body policy "body"); otherwise title, date and summary only.
 * - One site failing never stops the others.
 */
import { buildStoredTokenSet, type Article } from '../bm25_engine.js';
import { getArticleByUrl, saveArticlesToDb } from '../repositories/articles_repository.js';
import crypto from 'node:crypto';
import {
  knownSiteArticles,
  listSites,
  markListed,
  markSiteChecking,
  moveSiteArticle,
  recordArticleCheck,
  recordSiteArticles,
  recordSiteCheck,
  siteArticleCounts,
  siteSourceTag,
  type ArticleState,
  type KnownArticle,
  type SiteSource,
  type SiteStatus,
} from '../repositories/site_sources_repository.js';
import { extractReadable, IMAGE_LINE } from './reader_service.js';
import { fetchRobots, listArticles, type DetectResult, type FoundArticle } from './site_adapters.js';
import type { SafeFetchError, SafeFetcher } from './safe_fetch.js';
import { acceptsUrl, articleIdFor, articleKey, extractPageMeta, normalizeArticleUrl, stripSiteSuffix, type PageMeta, type Robots } from './site_parsing.js';
import { logger } from '../utils/logger.js';
import { db } from '../db/database.js';
import { getSite } from '../repositories/site_sources_repository.js';
import { SafeFetchError as FetchError } from './safe_fetch.js';

export const SITE_UPDATE_MAX_NEW = 30;
export const SITE_UPDATE_MAX_CHANGED = 10;
export const SITE_CHECK_INTERVAL_HOURS = 24;

function pathOf(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

/** One article page: its metadata, and its readable text when asked for. A 304 answer means "not changed". */
export async function fetchPageMeta(
  fetch: SafeFetcher,
  url: string,
  withBody: boolean,
  conditional: { etag?: string | null; lastModified?: string | null } = {},
  validateUrl?: (url: URL) => void,
): Promise<{ meta: PageMeta; body: string | null; finalUrl: string; notModified: boolean; etag: string | null; lastModified: string | null }> {
  validateUrl?.(new URL(url));
  const htmlTypes = /^(text\/html|application\/xhtml\+xml)(\s*;|$)/i;
  const response = await fetch(url, { validateUrl, allowedContentTypes: htmlTypes, accept: 'text/html,application/xhtml+xml', maxBytes: withBody ? 3 * 1024 * 1024 : 1024 * 1024, ifNoneMatch: conditional.etag, ifModifiedSince: conditional.lastModified });
  validateUrl?.(new URL(response.url));
  const etag = typeof response.headers.etag === 'string' ? response.headers.etag : null;
  const lastModified = typeof response.headers['last-modified'] === 'string' ? response.headers['last-modified'] : null;
  if (response.status === 304) return { meta: {}, body: null, finalUrl: response.url, notModified: true, etag: etag ?? conditional.etag ?? null, lastModified: lastModified ?? conditional.lastModified ?? null };
  if (!htmlTypes.test(response.contentType)) throw new FetchError('対応していない種類のファイルです（Content-Type）', 'http', 415);
  const html = response.text();
  const meta = extractPageMeta(html, response.url);
  if (meta.canonical) validateUrl?.(new URL(meta.canonical));
  let body: string | null = null;
  if (withBody) {
    const readable = extractReadable(html, response.url);
    body = readable.paragraphs.filter(paragraph => !IMAGE_LINE.test(paragraph)).join('\n').slice(0, 100_000) || null;
  }
  return { meta, body, finalUrl: response.url, notModified: false, etag, lastModified };
}

/** Titles for the preview when the method gives URLs only (sitemaps): a few pages, if robots.txt allows. */
export async function enrichSamples(detect: DetectResult, fetch: SafeFetcher, robots: Robots): Promise<DetectResult> {
  const samples: FoundArticle[] = [];
  for (const sample of detect.samples.slice(0, 5)) {
    if (sample.title || samples.length >= 3 || !robots.allows(pathOf(sample.url))) { samples.push(sample); continue; }
    try {
      const { meta } = await fetchPageMeta(fetch, sample.url, false);
      samples.push({ ...sample, title: meta.title ? stripSiteSuffix(meta.title, meta.siteName ?? detect.name) : undefined, summary: sample.summary ?? meta.description, publishedAt: sample.publishedAt ?? meta.publishedAt });
    } catch {
      samples.push(sample);
    }
  }
  return { ...detect, samples };
}

export type SiteRunResult = {
  siteId: string;
  mode: 'initial' | 'update';
  listed: number;
  added: number;
  updated: number;
  moved: number;
  unchanged: number;
  failed: number;
  skippedByRobots: number;
  /** articles not in the site's list any more / confirmed 404 twice / 401-403 / temporary failures (kept, not deleted) */
  missing: number;
  gone: number;
  restricted: number;
  temporaryErrors: number;
  status: SiteStatus;
  error: string | null;
  warnings: string[];
};

export function assessSiteRun(result: SiteRunResult): {status: 'succeeded' | 'failed'; error?: string} {
  return result.status === 'error' ? {status: 'failed', error: result.error ?? 'Site collection failed'} : {status: 'succeeded'};
}

async function toArticle(site: SiteSource, id: string, url: string, found: FoundArticle, meta: PageMeta | null, body: string | null): Promise<Article> {
  const title = stripSiteSuffix(meta?.title || found.title || url, meta?.siteName ?? site.name).slice(0, 300);
  const summary = (found.summary || meta?.description || '').slice(0, 1000) || undefined;
  const text = body || summary || '';
  const published = found.publishedAt || meta?.publishedAt;
  const tokens = await buildStoredTokenSet(`${title} ${text}`);
  return {
    id,
    title,
    body: text,
    summary,
    url,
    source: siteSourceTag(site.id),
    sourceAuthority: 0.7,
    publishedAt: published ? new Date(published) : new Date(NaN),
    bodyKind: body ? 'fulltext' : 'excerpt',
    sourceUpdatedAt: found.updatedAt ?? meta?.updatedAt,
    tags: [site.name],
    ...tokens,
    tokens: tokens.ngramTokens,
    docLength: tokens.ngramDocLength,
  };
}

/** 404/410 twice → gone (once → missing), 401/403 → restricted, anything else → temporary error. */
function failureState(item: KnownArticle, status: number): { state: ArticleState; httpStatus: number | null; failCount: number } {
  const failCount = item.failCount + 1;
  const state: ArticleState = status === 404 || status === 410 ? (failCount >= 2 ? 'gone' : 'missing')
    : status === 401 || status === 403 ? 'restricted'
    : 'error';
  return { state, httpStatus: status || null, failCount };
}

function hashText(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** How many "missing / failing" articles are looked at again per run (to tell removed from temporary). */
export const SITE_RECHECK_PER_RUN = 5;
/** Older sitemap files read per update check, beyond the newest ones. */
export const SITEMAP_OLDER_FILES_PER_RUN = 6;

/**
 * Check one site now. Never throws: problems end up in the result and the site's status.
 *
 * new       — not seen before (by URL key, and by the site's own article id when it has one)
 * updated   — the listing's update date moved; the page is fetched with If-None-Match /
 *             If-Modified-Since, so an unchanged page costs no download
 * moved     — same article id at the source under a new URL: the record follows the URL
 * missing   — no longer in a complete listing (sitemap / WordPress): only marked, never deleted
 * gone / restricted / error — from looking at a few missing or failing pages again:
 *             404/410 twice → gone, 401/403 → restricted, anything else → temporary error
 */
class SiteChangedError extends Error {}

/** What the user sees for an unexpected failure (the original message goes to the log only). */
function userFacingSyncError(error: unknown): string {
  if (error instanceof SiteChangedError || error instanceof FetchError) return (error as Error).message;
  if ((error as { code?: string })?.code?.startsWith?.('SQLITE')) return 'データベースに書き込めませんでした（空き容量などを確認してください）。今回の結果は保存していません';
  const message = String((error as Error)?.message ?? '');
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(message) ? message : '確認中に予期しないエラーが起きました。今回の結果は保存していません';
}

const activeSyncs = new Map<string, Promise<SiteRunResult>>();

export function syncSite(site: SiteSource, fetch: SafeFetcher, mode?: 'initial' | 'update'): Promise<SiteRunResult> {
  const active = activeSyncs.get(site.id);
  if (active) return active;
  const run = syncSiteUnlocked(getSite(site.id) ?? site, fetch, mode).finally(() => {
    if (activeSyncs.get(site.id) === run) activeSyncs.delete(site.id);
  });
  activeSyncs.set(site.id, run);
  return run;
}

async function syncSiteUnlocked(site: SiteSource, fetch: SafeFetcher, mode?: 'initial' | 'update'): Promise<SiteRunResult> {
  const known = knownSiteArticles(site.id);
  const runMode = mode ?? (known.size === 0 ? 'initial' : 'update');
  const result: SiteRunResult = { siteId: site.id, mode: runMode, listed: 0, added: 0, updated: 0, moved: 0, unchanged: 0, failed: 0, skippedByRobots: 0, missing: 0, gone: 0, restricted: 0, temporaryErrors: 0, status: 'ok', error: null, warnings: [] };
  const wantBody = site.bodyPolicy === 'body';
  markSiteChecking(site.id);
  const validatePageUrl = (url: URL) => {
    if (!acceptsUrl(url.toString(), site.scope)) throw new FetchError('記事のURLが登録した範囲の外です', 'blocked');
  };
  const checks: Array<() => void> = [];
  const moves: Array<() => void> = [];
  try {
    const origin = new URL(site.siteUrl).origin;
    const resourceFetch: SafeFetcher = async (url, options = {}) => {
      const resourcePath = new URL(url).pathname.replace(/\/+$/, '') || '/';
      const validateUrl = (target: URL) => {
        if (!site.scope.hosts.includes(target.hostname.toLowerCase())) throw new FetchError('登録したサイトのホストの外を指していたため読みませんでした', 'blocked');
        if ((target.pathname.replace(/\/+$/, '') || '/') !== resourcePath) throw new FetchError('リダイレクト先が確認済みの場所と違うため読みませんでした', 'blocked');
        options.validateUrl?.(target);
      };
      validateUrl(new URL(url));
      const response = await fetch(url, { ...options, validateUrl });
      validateUrl(new URL(response.url));
      return response;
    };
    const { robots, note } = await fetchRobots(resourceFetch, origin);
    if (note) result.warnings.push(note);
    const env = { fetch: resourceFetch, scope: site.scope, robots };
    const cursorKey = `sitemap_older_offset:${site.id}`;
    const olderOffset = Number((db.prepare('SELECT value FROM collector_settings WHERE key = ?').get(cursorKey) as { value: string } | undefined)?.value ?? 0) || 0;
    const listed = await listArticles(env, site.adapter, {
      includeBody: wantBody,
      maxItems: runMode === 'initial' ? site.maxInitial : 50,
      // update checks also read a few older sitemap files each time (past articles are found over days)
      olderFiles: runMode === 'update' && site.adapter.type === 'sitemap' ? { offset: olderOffset, count: SITEMAP_OLDER_FILES_PER_RUN } : undefined,
      // After a pause the catch-up is still bounded: WordPress lists only what changed since the last check.
      modifiedAfter: runMode === 'update' && site.adapter.type === 'wordpress' && site.lastSuccessAt ? site.lastSuccessAt : undefined,
    });
    result.warnings.push(...listed.warnings);
    result.listed = listed.articles.length;
    // Nothing listed and the listing reported problems (sitemap 500, timeout, DNS…): the check failed.
    // Do not report it as "no new articles", and do not move the last success time.
    const listingFailed = listed.articles.length === 0 && listed.warnings.length > 0;

    const byExternal = new Map([...known.values()].filter(item => item.externalId).map(item => [item.externalId!, item]));
    const listedKeys = new Set<string>();
    const work: Array<{ found: FoundArticle; existing: KnownArticle | null; movedFrom: string | null }> = [];
    let fresh = 0;
    let changed = 0;
    const freshLimit = runMode === 'initial' ? site.maxInitial : SITE_UPDATE_MAX_NEW;
    for (const found of listed.articles) {
      const url = normalizeArticleUrl(found.url);
      if (!url || !acceptsUrl(url, site.scope)) continue;
      const key = articleKey(url);
      if (listedKeys.has(key)) continue;
      listedKeys.add(key);
      let existing = known.get(key) ?? null;
      let movedFrom: string | null = null;
      if (!existing && found.externalId && byExternal.has(found.externalId)) {
        existing = byExternal.get(found.externalId)!;
        movedFrom = existing.key;
      }
      if (movedFrom) { work.push({ found: { ...found, url }, existing, movedFrom }); continue; }
      if (!existing) {
        if (fresh < freshLimit) { work.push({ found: { ...found, url }, existing: null, movedFrom: null }); fresh += 1; }
      } else if (runMode === 'update' && changed < SITE_UPDATE_MAX_CHANGED && (
        existing.failCount > 0 || (wantBody && !existing.hasBody) ||
        (found.updatedAt && (!existing.lastmod || found.updatedAt > existing.lastmod)))) {
        work.push({ found: { ...found, url }, existing, movedFrom: null });
        changed += 1;
      }
    }
    // An article the listing no longer shows is only "missing" (it may be paginated away, edited, moved…).

    const articles: Article[] = [];
    const records: Parameters<typeof recordSiteArticles>[1] = [];
    for (const { found, existing, movedFrom } of work) {
      let url = found.url;
      let meta: PageMeta | null = null;
      let body: string | null = wantBody ? found.body ?? null : null;
      let etag: string | null = null;
      let lastModified: string | null = null;
      // The page is read when the listing has no title or date (sitemaps, list pages), or for full text.
      // Updates found by a listing that carries titles (WordPress, feeds) need no page download.
      const needsPage = !found.title || (!found.publishedAt && site.adapter.type !== 'feed') || (wantBody && !body);
      if (needsPage) {
        if (!robots.allows(pathOf(url))) {
          result.skippedByRobots += 1;
          if (!found.title) continue; // nothing to show without the page (no guessed titles)
        } else {
          try {
            const page = await fetchPageMeta(fetch, url, wantBody && !body, existing && !movedFrom ? { etag: existing.etag, lastModified: existing.lastModified } : {}, validatePageUrl);
            etag = page.etag;
            lastModified = page.lastModified;
            if (page.notModified && existing) {
              result.unchanged += 1;
              records.push({ key: existing.key, articleId: existing.articleId, url: existing.url, lastmod: found.updatedAt ?? existing.lastmod, hasBody: existing.hasBody, etag, lastModified });
              continue;
            }
            meta = page.meta;
            url = normalizeArticleUrl(page.finalUrl) ?? url;
            if (wantBody && !body) body = page.body;
            const canonical = page.meta.canonical;
            if (canonical && acceptsUrl(canonical, site.scope) && articleKey(canonical) !== articleKey(url)) {
              if (known.has(articleKey(canonical)) && !existing) continue; // same article under another URL
              url = canonical;
            }
          } catch (error) {
            result.failed += 1;
            logger.warn({ event: 'site_page_failed', siteId: site.id, url, error: (error as Error).message }, 'site page fetch failed');
            if (existing) {
              // keep what was collected before; only note how the page answered
              const check = failureState(existing, (error as SafeFetchError).status ?? 0);
              checks.push(() => recordArticleCheck(site.id, existing.key, check));
              continue;
            }
            if (!found.title || (error as SafeFetchError).code === 'blocked' || (error as SafeFetchError).status === 415) continue;
            // Metadata is still usable; do not report that the full-text fetch succeeded.
            const failedKey = articleKey(found.url);
            checks.push(() => recordArticleCheck(site.id, failedKey, { state: 'error', httpStatus: (error as SafeFetchError).status || null, failCount: 1 }));
          }
        }
      }
      const otherSource = getArticleByUrl(url);
      validatePageUrl(new URL(url));
      const id = existing?.articleId ?? (otherSource ? otherSource.id : articleIdFor(site.id, url));
      const article = await toArticle(site, id, url, found, meta, body);
      articles.push(article);
      const key = articleKey(url);
      if (movedFrom && movedFrom !== key) moves.push(() => moveSiteArticle(site.id, movedFrom, key, url));
      records.push({ key, articleId: id, url, lastmod: found.updatedAt ?? meta?.updatedAt ?? found.publishedAt ?? null, hasBody: !!body || !!existing?.hasBody, externalId: found.externalId ?? null, etag, lastModified, contentHash: hashText(`${article.title}\n${article.body}`) });
      if (articleKey(found.url) !== key) records.push({ key: articleKey(found.url), articleId: id, url, lastmod: found.updatedAt ?? null, hasBody: !!body, externalId: null });
      if (movedFrom) result.moved += 1;
      else if (existing) result.updated += 1;
      else result.added += 1;
    }

    // Look again at a few articles that went missing or failed before (never deleted, only labelled).
    if (runMode === 'update') {
      const toRecheck = [...known.values()].filter(item => !work.some(task => task.existing?.key === item.key) && (item.state !== 'active' || item.failCount > 0 || (listed.complete && !listedKeys.has(item.key))))
        .sort((a, b) => String(a.missingSince ?? '').localeCompare(String(b.missingSince ?? ''))).slice(0, SITE_RECHECK_PER_RUN);
      for (const item of toRecheck) {
        if (!robots.allows(pathOf(item.url))) continue;
        try {
          const page = await fetchPageMeta(fetch, item.url, false, { etag: item.etag, lastModified: item.lastModified }, validatePageUrl);
          checks.push(() => recordArticleCheck(site.id, item.key, { state: listedKeys.has(item.key) || !listed.complete ? 'active' : 'missing', httpStatus: page.notModified ? 304 : 200, etag: page.etag, lastModified: page.lastModified, failCount: 0 }));
        } catch (error) {
          const check = failureState(item, (error as SafeFetchError).status ?? 0);
          checks.push(() => recordArticleCheck(site.id, item.key, check));
          result.failed += 1;
        }
      }
    }
    result.status = result.failed > 0 ? (records.length ? 'partial' : 'error') : 'ok';
    if (result.status === 'error') result.error = '記事の取得に失敗しました';
    if (listingFailed) {
      result.status = 'error';
      result.error = `記事の一覧を読めませんでした（${listed.warnings[0]}）。前回までの記事はそのまま残っています`;
    }
    if (result.listed === 0 && known.size === 0) {
      result.status = 'error';
      result.error = '記事が見つかりませんでした';
    }
    db.transaction(() => {
      const current = getSite(site.id);
      if (!current || (wantBody && current.bodyPolicy !== 'body')) throw new SiteChangedError('確認中にサイトの登録が解除されたか、本文の取得設定が変わったため中止しました');
      const saved = saveArticlesToDb(articles);
      for (const record of records) record.articleId = saved.canonicalIds[record.articleId] ?? record.articleId;
      for (const move of moves) move();
      if (runMode === 'update') markListed(site.id, listedKeys, !!listed.complete);
      // move on to the next older files only when everything new from these files was taken
      if (listed.olderCursor && fresh < freshLimit) {
        db.prepare('INSERT INTO collector_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(cursorKey, String(listed.olderCursor.next));
      }
      if (records.length) recordSiteArticles(site.id, records);
      for (const check of checks) check();
      const counts = siteArticleCounts().get(site.id);
      result.missing = counts?.missing ?? 0;
      result.gone = counts?.gone ?? 0;
      result.restricted = counts?.restricted ?? 0;
      result.temporaryErrors = counts?.error ?? 0;
      persistResult();
    })();
  } catch (error) {
    result.added = 0; result.updated = 0; result.moved = 0;
    result.status = 'error';
    result.error = userFacingSyncError(error);
    logger.error({ event: 'site_sync_failed', siteId: site.id, error: (error as Error).message }, 'site sync failed');
    persistResult();
  }
  function persistResult() { recordSiteCheck(site.id, {
    status: result.status,
    error: result.error,
    success: result.status === 'ok',
    summary: {
      mode: result.mode, listed: result.listed, added: result.added, updated: result.updated, moved: result.moved, unchanged: result.unchanged,
      failed: result.failed, skippedByRobots: result.skippedByRobots, missing: result.missing, gone: result.gone, restricted: result.restricted,
      temporaryErrors: result.temporaryErrors, warnings: result.warnings.slice(0, 5),
    },
  }); }
  logger.info({ event: 'site_sync', ...result, warnings: result.warnings.length }, 'site checked');
  return result;
}

/** Check every enabled site whose last check is older than the interval, one after another. */
export async function syncDueSites(fetch: SafeFetcher, now = Date.now(), intervalHours = SITE_CHECK_INTERVAL_HOURS, run: typeof syncSite = syncSite): Promise<SiteRunResult[]> {
  const results: SiteRunResult[] = [];
  for (const site of listSites()) {
    if (!site.enabled || site.status === 'unsupported') continue;
    if (site.lastCheckedAt && now - Date.parse(site.lastCheckedAt) < intervalHours * 3_600_000) continue;
    try {
      results.push(await run(site, fetch));
    } catch (error) {
      logger.error({ event: 'site_sync_crash', siteId: site.id, error: (error as Error).message }, 'site sync crashed');
    }
  }
  return results;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Hourly look at which sites are due (each site is checked about once a day). */
export function startSiteScheduler(fetch: SafeFetcher, onDone?: (results: SiteRunResult[]) => void, run: typeof syncSite = syncSite): () => void {
  if (timer) return () => {};
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await syncDueSites(fetch, Date.now(), SITE_CHECK_INTERVAL_HOURS, run);
      if (results.length && onDone) onDone(results);
    } catch (error) {
      logger.error({ event: 'site_scheduler_failed', error: (error as Error).message }, 'site scheduler failed');
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => { void tick(); }, 60 * 60 * 1000);
  timer.unref();
  const initialTimer = setTimeout(() => { void tick(); }, 30_000);
  initialTimer.unref();
  return () => { clearTimeout(initialTimer); if (timer) clearInterval(timer); timer = null; };
}
