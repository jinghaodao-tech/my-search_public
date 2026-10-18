/**
 * How the articles of a registered site are found. One shared shape for every method, so a
 * new site that fits an existing method needs no new code:
 *
 *   wordpress — the site's public WordPress REST API (titles, dates, excerpts, ids)
 *   sitemap   — robots.txt / sitemap.xml / sitemap index (every past article, by URL)
 *   listpage  — article links on the registered list page (+ next pages)
 *   feed      — RSS/Atom (only the latest articles: shown as a limitation)
 *
 * Methods only list articles; reading each page (title, dates, full text) is done by the
 * collector, which checks robots.txt and the site's body policy first.
 */
import { parseFeed } from './discover_service.js';
import { SafeFetchError, type SafeFetcher, type SafeFetchOptions } from './safe_fetch.js';
import {
  acceptsUrl,
  candidatePrefixes,
  cleanPrefixes,
  dateOrUndefined,
  extractPageMeta,
  isSharedHost,
  metaContent,
  scopePrefixes,
  stripSiteSuffix,
  extractArticleLinks,
  extractPolicyLinks,
  inScope,
  linkHrefs,
  looksLikeArticle,
  normalizeArticleUrl,
  normalizeSiteUrl,
  parseRobots,
  parseSitemap,
  rankChildSitemaps,
  scopeFromUrl,
  siteNameFromHtml,
  type Robots,
  type SiteScope,
} from './site_parsing.js';
import { assertPublicUrl } from './safe_fetch.js';
import zlib from 'node:zlib';

export type AdapterType = 'wordpress' | 'sitemap' | 'listpage' | 'feed';
/** linked: articles are the ones this list page / feed links to (see SiteScope.linked) */
export type AdapterConfig = { type: AdapterType; apiBase?: string; sitemaps?: string[]; listUrl?: string; feedUrl?: string; linked?: boolean };

export type FoundArticle = {
  url: string;
  title?: string;
  publishedAt?: string;
  updatedAt?: string;
  summary?: string;
  body?: string;
  externalId?: string;
};

export type SiteEnv = { fetch: SafeFetcher; scope: SiteScope; robots: Robots };
/** olderFiles: also read `count` sitemap files beyond the first ones, starting at `offset` (older months). */
export type ListOptions = { includeBody: boolean; modifiedAfter?: string; maxItems?: number; olderFiles?: { offset: number; count: number } };
/** pathGroups: article-like URLs of the whole host seen while listing, by first folder (for the scope preview) */
/** olderCursor: where the next run continues reading older sitemap files (0 = from the start again). */
export type ListResult = { articles: FoundArticle[]; total?: number; warnings: string[]; pathGroups?: Map<string, number>; complete?: boolean; olderCursor?: { next: number; total: number; read: number } };

function firstFolder(url: string): string {
  const segment = new URL(url).pathname.split('/').filter(Boolean)[0];
  return segment ? `/${segment}/` : '/';
}

function countGroup(groups: Map<string, number>, url: string): void {
  const key = firstFolder(url);
  groups.set(key, (groups.get(key) ?? 0) + 1);
}

export const ADAPTER_LABELS: Record<AdapterType, string> = {
  wordpress: 'WordPressの公開API',
  sitemap: 'サイトマップ',
  listpage: '記事一覧ページ',
  feed: 'RSS / Atom フィード',
};

const HARD_CAP = 5000;
const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)(\s*;|$)/i;
const JSON_TYPES = /^application\/(?:json|[\w.-]+\+json)(\s*;|$)/i;
const XML_TYPES = /^(?:application\/(?:xml|rss\+xml|atom\+xml|[\w.-]+\+xml)|text\/xml)(\s*;|$)/i;
const SITEMAP_TYPES = /^(?:application\/(?:xml|[\w.-]+\+xml|gzip|x-gzip)|text\/xml)(\s*;|$)/i;

async function typedFetch(fetch: SafeFetcher, url: string | URL, options: SafeFetchOptions, types: RegExp, scope?: SiteScope) {
  const validateUrl = (target: URL) => {
    if (scope && !scope.hosts.includes(target.hostname.toLowerCase())) throw new SafeFetchError('登録したサイトのホストの外を指していたため読みませんでした', 'blocked');
    options.validateUrl?.(target);
  };
  validateUrl(new URL(url));
  const response = await fetch(url, { ...options, allowedContentTypes: types, validateUrl });
  validateUrl(new URL(response.url));
  if (response.status !== 304 && !types.test(response.contentType)) throw new SafeFetchError('対応していない種類のファイルです（Content-Type）', 'http', 415);
  return response;
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#8217;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/\s+/g, ' ').trim();
}

function pathOf(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

// ─── WordPress ───────────────────────────────────────────────

function wpPostsUrl(apiBase: string, params: Record<string, string>): string {
  const base = new URL(apiBase);
  if (base.searchParams.has('rest_route')) {
    base.searchParams.set('rest_route', '/wp/v2/posts');
    for (const [key, value] of Object.entries(params)) base.searchParams.set(key, value);
    return base.toString();
  }
  const url = new URL('wp/v2/posts', base.toString().endsWith('/') ? base.toString() : `${base}/`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function listWordPress(env: SiteEnv, config: AdapterConfig, options: ListOptions): Promise<ListResult> {
  const fields = ['id', 'link', 'title', 'excerpt', 'date_gmt', 'modified_gmt', ...(options.includeBody ? ['content'] : [])].join(',');
  const perPage = Math.min(Math.max(options.maxItems ?? 50, 1), 100);
  const articles: FoundArticle[] = [];
  const groups = new Map<string, number>();
  let total: number | undefined;
  let complete = false;
  for (let page = 1; page <= 3; page += 1) {
    const params: Record<string, string> = { per_page: String(perPage), page: String(page), orderby: options.modifiedAfter ? 'modified' : 'date', order: 'desc', _fields: fields };
    if (options.modifiedAfter) params.modified_after = options.modifiedAfter;
    const response = await typedFetch(env.fetch, wpPostsUrl(config.apiBase!, params), { accept: 'application/json', maxBytes: 8 * 1024 * 1024 }, JSON_TYPES, env.scope);
    const posts = JSON.parse(response.text());
    if (!Array.isArray(posts)) throw new SafeFetchError('WordPressの投稿一覧の形式が違います', 'http');
    total ??= Number(response.headers['x-wp-total'] ?? '') || undefined;
    for (const post of posts) {
      const url = normalizeArticleUrl(String(post?.link ?? ''));
      if (url && env.scope.hosts.includes(new URL(url).hostname)) countGroup(groups, url);
      if (!url || !inScope(url, env.scope)) continue;
      articles.push({
        url,
        externalId: post.id != null ? String(post.id) : undefined,
        title: stripTags(String(post?.title?.rendered ?? '')) || undefined,
        summary: stripTags(String(post?.excerpt?.rendered ?? '')).slice(0, 500) || undefined,
        body: options.includeBody ? stripTags(String(post?.content?.rendered ?? '')).slice(0, 100_000) || undefined : undefined,
        publishedAt: dateOrUndefined(post?.date_gmt ? `${post.date_gmt}Z` : undefined),
        updatedAt: dateOrUndefined(post?.modified_gmt ? `${post.modified_gmt}Z` : undefined),
      });
    }
    const totalPages = Number(response.headers['x-wp-totalpages'] ?? 1);
    if (posts.length < perPage || page >= totalPages) { complete = !options.modifiedAfter; break; }
    if (articles.length >= (options.maxItems ?? 50)) break;
  }
  return { articles, total, warnings: [], pathGroups: groups, complete };
}

// ─── sitemap ─────────────────────────────────────────────────

async function fetchSitemapText(env: SiteEnv, url: string): Promise<string> {
  const response = await typedFetch(env.fetch, url, { accept: 'application/xml,text/xml,application/gzip', maxBytes: 20 * 1024 * 1024 }, SITEMAP_TYPES, env.scope);
  let bytes = response.bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes, { maxOutputLength: 50 * 1024 * 1024 });
  return bytes.toString('utf8');
}

async function listSitemap(env: SiteEnv, config: AdapterConfig, options: ListOptions & { maxFiles?: number }): Promise<ListResult> {
  const warnings: string[] = [];
  const maxFiles = options.maxFiles ?? 12;
  const queue = [...(config.sitemaps ?? [])];
  const seenFiles = new Set<string>();
  const entries = new Map<string, FoundArticle & { order: number }>();
  const groups = new Map<string, number>();
  const hostScope = { hosts: env.scope.hosts, pathPrefix: '/' };
  let order = 0;
  let failedFiles = 0;
  while (queue.length && seenFiles.size < maxFiles && entries.size < HARD_CAP) {
    const file = queue.shift()!;
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    let parsed;
    try {
      parsed = parseSitemap(await fetchSitemapText(env, file));
    } catch (error) {
      failedFiles += 1;
      warnings.push(`サイトマップを読めませんでした: ${file}（${(error as Error).message}）`);
      continue;
    }
    if (parsed.kind === 'index') {
      for (const child of rankChildSitemaps(parsed.entries, env.scope)) {
        if (env.scope.hosts.includes(new URL(child.loc).hostname.toLowerCase())) queue.push(child.loc);
      }
      continue;
    }
    for (const entry of parsed.entries) {
      const url = normalizeArticleUrl(entry.loc);
      if (url && looksLikeArticle(url, hostScope)) countGroup(groups, url);
      if (!url || !looksLikeArticle(url, env.scope) || entries.has(url)) continue;
      entries.set(url, { url, title: entry.title, publishedAt: dateOrUndefined(entry.published), updatedAt: dateOrUndefined(entry.lastmod), order: order++ });
    }
  }
  const truncated = seenFiles.size >= maxFiles && queue.length > 0;
  // Sites that split their sitemap by month (e.g. Hatena Blog) have more files than one run reads.
  // Each check also reads a few older files and remembers where it stopped, so past articles are found over time.
  let olderCursor: ListResult['olderCursor'];
  if (truncated && options.olderFiles && options.olderFiles.count > 0) {
    const rest = [...new Set(queue.filter(file => !seenFiles.has(file)))];
    const start = options.olderFiles.offset < rest.length ? options.olderFiles.offset : 0;
    const slice = rest.slice(start, start + options.olderFiles.count);
    let read = 0;
    for (const file of slice) {
      seenFiles.add(file);
      try {
        const parsed = parseSitemap(await fetchSitemapText(env, file));
        if (parsed.kind === 'index') continue;
        read += 1;
        for (const entry of parsed.entries) {
          const url = normalizeArticleUrl(entry.loc);
          if (!url || !looksLikeArticle(url, env.scope) || entries.has(url)) continue;
          // older files go after everything else, whatever their dates say
          entries.set(url, { url, title: entry.title, publishedAt: dateOrUndefined(entry.published), updatedAt: dateOrUndefined(entry.lastmod), order: HARD_CAP + order++, older: true } as FoundArticle & { order: number });
        }
      } catch (error) {
        failedFiles += 1;
        warnings.push(`サイトマップを読めませんでした: ${file}（${(error as Error).message}）`);
      }
    }
    olderCursor = { next: start + slice.length >= rest.length ? 0 : start + slice.length, total: rest.length, read };
  }
  if (truncated && !olderCursor) warnings.push(`サイトマップが多いため、先頭の${maxFiles}ファイルだけ読みました`);
  // Newest first by lastmod (a hint only: entries without it keep the sitemap's order, after them).
  const articles = [...entries.values()].sort((a, b) => {
    const olderA = (a as { older?: boolean }).older ? 1 : 0;
    const olderB = (b as { older?: boolean }).older ? 1 : 0;
    if (olderA !== olderB) return olderA - olderB;
    const da = a.updatedAt ?? a.publishedAt;
    const db = b.updatedAt ?? b.publishedAt;
    if (da && db) return db.localeCompare(da);
    if (da) return -1;
    if (db) return 1;
    return a.order - b.order;
  }).map(({ order: _order, older: _older, ...rest }: FoundArticle & { order: number; older?: boolean }) => rest);
  // "complete": every sitemap file was read, so an article missing from it may really be gone from the list
  return { articles, total: articles.length, warnings, pathGroups: groups, complete: !truncated && failedFiles === 0 && entries.size < HARD_CAP, olderCursor };
}

// ─── list page ───────────────────────────────────────────────

function nextPageUrl(html: string, pageUrl: string, scope: SiteScope): string | null {
  const rel = linkHrefs(html, 'next', pageUrl)[0];
  if (rel && inScope(rel, scope)) return rel;
  const anchor = html.match(/<a\s[^>]*rel\s*=\s*["']?next["']?[^>]*href\s*=\s*["']([^"']+)["']/i)?.[1]
    ?? html.match(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']?next["']?/i)?.[1];
  if (anchor) {
    try {
      const url = new URL(anchor, pageUrl).toString();
      if (inScope(url, scope)) return url;
    } catch { /* ignore */ }
  }
  return null;
}

async function listListPage(env: SiteEnv, config: AdapterConfig, options: ListOptions & { maxPages?: number }): Promise<ListResult> {
  const articles = new Map<string, FoundArticle>();
  const warnings: string[] = [];
  let pageUrl: string | null = config.listUrl!;
  for (let page = 0; page < (options.maxPages ?? 3) && pageUrl; page += 1) {
    if (!env.robots.allows(pathOf(pageUrl))) { warnings.push('robots.txt で一覧ページの取得が禁止されています'); break; }
    const response = await typedFetch(env.fetch, pageUrl, { accept: 'text/html', validateUrl: target => {
      if (!inScope(target.toString(), env.scope)) throw new SafeFetchError('一覧ページが登録した範囲の外にあります', 'blocked');
    } }, HTML_TYPES, env.scope);
    const html = response.text();
    const links = extractArticleLinks(html, response.url, env.scope.linked ? { hosts: env.scope.hosts, pathPrefix: '/' } : env.scope)
      .filter(link => !env.scope.linked || new URL(link.url).pathname.split('/').filter(Boolean).length >= 2);
    for (const link of links) {
      if (!articles.has(link.url)) articles.set(link.url, { url: link.url, title: link.text });
    }
    if (articles.size >= (options.maxItems ?? 50)) break;
    pageUrl = nextPageUrl(html, response.url, env.scope);
  }
  return { articles: [...articles.values()], warnings };
}

// ─── feed ────────────────────────────────────────────────────

async function listFeed(env: SiteEnv, config: AdapterConfig): Promise<ListResult> {
  const response = await typedFetch(env.fetch, config.feedUrl!, { accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml' }, XML_TYPES, env.scope);
  const articles = parseFeed(response.text(), response.url)
    .map(hit => ({ ...hit, url: normalizeArticleUrl(hit.url) ?? hit.url }))
    .filter(hit => acceptsUrl(hit.url, env.scope))
    .map(hit => ({ url: hit.url, title: hit.title, summary: hit.summary || undefined, publishedAt: hit.publishedAt.getTime() > 0 ? hit.publishedAt.toISOString() : undefined, updatedAt: hit.updatedAt && hit.updatedAt.getTime() > 0 ? hit.updatedAt.toISOString() : undefined }));
  return { articles, total: articles.length, warnings: ['RSS/Atomで取れるのは最新の記事だけです（過去の記事は取得できません）'] };
}

export async function listArticles(env: SiteEnv, config: AdapterConfig, options: ListOptions): Promise<ListResult> {
  if (config.type === 'wordpress') return listWordPress(env, config, options);
  if (config.type === 'sitemap') return listSitemap(env, config, options);
  if (config.type === 'listpage') return listListPage(env, config, options);
  return listFeed(env, config);
}

// ─── detection ───────────────────────────────────────────────

export type DetectResult = {
  ok: boolean;
  inputUrl: string;
  siteUrl: string;
  name: string;
  scope: SiteScope;
  adapter: AdapterConfig | null;
  /** methods that also work (shown; the first one is used) */
  available: AdapterType[];
  robots: { found: boolean; pagesAllowed: boolean };
  samples: FoundArticle[];
  estimatedCount: number | null;
  notes: string[];
  policyLinks: Array<{ url: string; text: string }>;
  error: string | null;
  /** the scope as editable path list */
  prefixes: string[];
  /** article-like URLs of the host by first folder, in or out of the scope (only what was actually seen) */
  pathGroups: Array<{ prefix: string; count: number; inScope: boolean }>;
  /** the whole host would be collected: the user has to confirm (or narrow it) */
  needsScopeConfirm: boolean;
};

export async function fetchRobots(fetch: SafeFetcher, origin: string): Promise<{ robots: Robots; note: string | null }> {
  try {
    const response = await typedFetch(fetch, `${origin}/robots.txt`, { accept: 'text/plain', maxBytes: 512 * 1024, retries: 0 }, /^text\/plain(\s*;|$)/i, {hosts: [new URL(origin).hostname], pathPrefix: '/'});
    return { robots: parseRobots(response.text()), note: null };
  } catch (error) {
    const status = (error as SafeFetchError).status;
    if (status === 404 || status === 410) return { robots: parseRobots(null), note: null };
    // Any other failure: be careful and treat the site as not allowing page fetches.
    return { robots: { found: false, sitemaps: [], allows: () => false }, note: `robots.txt を確認できませんでした（${(error as Error).message}）。ページの取得はしません` };
  }
}

async function probeWordPress(fetch: SafeFetcher, html: string, pageUrl: string, scope: SiteScope, robots: Robots, headers: Record<string, string | string[] | undefined>): Promise<string | null> {
  const origin = new URL(pageUrl).origin;
  const fromLink = linkHrefs(html, 'https://api.w.org/', pageUrl)[0]
    ?? String(headers.link ?? '').match(/<([^>]+)>;\s*rel="https:\/\/api\.w\.org\/"/)?.[1];
  const looksWp = !!fromLink || /wp-content|wp-includes|generator"\s+content="WordPress/i.test(html);
  if (!looksWp) return null;
  const candidates = [fromLink ? new URL(fromLink, pageUrl).toString() : null, `${origin}/wp-json/`].filter((value): value is string => !!value);
  for (const apiBase of candidates) {
    try {
      const api = new URL(apiBase);
      if (!scope.hosts.includes(api.hostname.toLowerCase())) continue; // never follow the API to another host
      if (!robots.allows(api.pathname)) continue;
      const response = await typedFetch(fetch, wpPostsUrl(apiBase, { per_page: '1', _fields: 'id,link' }), { accept: 'application/json', retries: 0 }, JSON_TYPES, scope);
      if (Array.isArray(JSON.parse(response.text()))) return apiBase;
    } catch { /* API disabled or limited: try the next method */ }
  }
  return null;
}

async function findSitemaps(fetch: SafeFetcher, html: string, pageUrl: string, scope: SiteScope, robots: Robots): Promise<string[]> {
  const origin = new URL(pageUrl).origin;
  const sameHost = (url: string) => { try { return scope.hosts.includes(new URL(url).hostname.toLowerCase()); } catch { return false; } };
  const candidates = [...new Set([
    ...robots.sitemaps,
    ...linkHrefs(html, 'sitemap', pageUrl),
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/wp-sitemap.xml`,
  ])].filter(sameHost);
  const working: string[] = [];
  for (const url of candidates.slice(0, 6)) {
    try {
      const text = await fetchSitemapText({ fetch, scope, robots }, url);
      if (parseSitemap(text, 10).kind !== 'unknown') { working.push(url); break; }
    } catch { /* not there */ }
  }
  return working;
}

function feedFromHtml(html: string, pageUrl: string, scope: SiteScope): string | null {
  const feeds = linkHrefs(html, 'alternate', pageUrl, /(rss|atom)\+xml|application\/xml/i);
  return feeds.find(url => scope.hosts.includes(new URL(url).hostname.toLowerCase())) ?? null;
}

/**
 * Look at a URL and find how its articles can be listed. Reads: the page, robots.txt, and only
 * the small number of extra URLs needed to try each method.
 */
export async function detectSite(rawUrl: string, fetch: SafeFetcher, options: { prefixes?: string[] } = {}): Promise<DetectResult> {
  const result: DetectResult = {
    ok: false, inputUrl: rawUrl, siteUrl: rawUrl, name: '', scope: { hosts: [], pathPrefix: '/' }, adapter: null, available: [],
    robots: { found: false, pagesAllowed: true }, samples: [], estimatedCount: null, notes: [], policyLinks: [], error: null,
    prefixes: [], pathGroups: [], needsScopeConfirm: false,
  };
  let start: URL;
  try {
    start = assertPublicUrl(normalizeSiteUrl(rawUrl));
  } catch (error) {
    result.error = (error as Error).message;
    return result;
  }
  const sharedRoot = (host: string) => `${host} は多くの人が使う共通のサイトです。全体ではなく、ユーザー・組織のページのURL（例: https://${host}/ユーザー名）を入れてください`;
  const askedPrefixes = options.prefixes ? cleanPrefixes(options.prefixes) : [scopeFromUrl(start).pathPrefix];
  if (isSharedHost(start.hostname) && askedPrefixes.includes('/')) {
    result.error = sharedRoot(start.hostname);
    return result;
  }
  let page;
  try {
    page = await typedFetch(fetch, start, { accept: 'text/html,application/xhtml+xml', maxBytes: 3 * 1024 * 1024 }, HTML_TYPES);
  } catch (error) {
    result.error = `ページにアクセスできませんでした（${(error as Error).message}）`;
    return result;
  }
  const finalUrl = normalizeSiteUrl(page.url);
  if (finalUrl.hostname !== start.hostname) result.notes.push(`${start.hostname} から ${finalUrl.hostname} へ転送されたため、転送先を登録します`);
  const given = options.prefixes ? cleanPrefixes(options.prefixes) : [];
  const scope: SiteScope = given.length
    ? { hosts: [finalUrl.hostname.toLowerCase()], pathPrefix: given[0], ...(given.length > 1 ? { extraPrefixes: given.slice(1) } : {}) }
    : scopeFromUrl(finalUrl);
  result.prefixes = scopePrefixes(scope);
  if (isSharedHost(finalUrl.hostname) && result.prefixes.includes('/')) {
    result.error = sharedRoot(finalUrl.hostname);
    return result;
  }
  const html = /html|xml/i.test(page.contentType) || !page.contentType ? page.text() : '';
  result.siteUrl = finalUrl.toString();
  result.scope = scope;
  result.name = siteNameFromHtml(html, finalUrl.hostname);
  result.policyLinks = extractPolicyLinks(html, page.url);

  const { robots, note } = await fetchRobots(fetch, finalUrl.origin);
  if (note) result.notes.push(note);
  result.robots = { found: robots.found, pagesAllowed: robots.allows(finalUrl.pathname) };
  if (!result.robots.pagesAllowed) result.notes.push('robots.txt でこのサイトのページ取得が禁止されています。記事ページは読みに行きません');
  const env: SiteEnv = { fetch, scope, robots };

  const apiBase = await probeWordPress(fetch, html, page.url, scope, robots, page.headers);
  if (apiBase) result.available.push('wordpress');
  const sitemaps = await findSitemaps(fetch, html, page.url, scope, robots);
  const listLinks = robots.allows(finalUrl.pathname) ? extractArticleLinks(html, page.url, scope) : [];
  if (listLinks.length) result.available.push('listpage');
  const feedUrl = feedFromHtml(html, page.url, scope);

  const configs: AdapterConfig[] = [
    ...(apiBase ? [{ type: 'wordpress' as const, apiBase }] : []),
    ...(sitemaps.length ? [{ type: 'sitemap' as const, sitemaps }] : []),
    ...(listLinks.length ? [{ type: 'listpage' as const, listUrl: page.url }] : []),
    ...(feedUrl ? [{ type: 'feed' as const, feedUrl }] : []),
  ];
  let sitemapEmpty = false;
  for (const config of configs) {
    try {
      const listed = await listArticles(env, config, { includeBody: false, maxItems: 50 });
      if (!listed.articles.length) {
        if (config.type === 'sitemap') sitemapEmpty = true;
        continue;
      }
      if (!result.available.includes(config.type)) result.available.push(config.type);
      if (!result.adapter) {
        result.adapter = config;
        result.samples = listed.articles.slice(0, 5);
        result.estimatedCount = listed.total ?? listed.articles.length;
        result.notes.push(...listed.warnings);
        if (listed.pathGroups) {
          result.pathGroups = [...listed.pathGroups].map(([prefix, count]) => ({ prefix, count, inScope: result.prefixes.some(item => prefix.startsWith(item) || item.startsWith(prefix)) }))
            .sort((a, b) => b.count - a.count).slice(0, 12);
        }
      }
    } catch (error) {
      result.notes.push(`${ADAPTER_LABELS[config.type]}を使えませんでした（${(error as Error).message}）`);
    }
  }
  if (sitemapEmpty && !result.adapter) result.notes.push('サイトマップはありますが、このURLの範囲の記事は見つかりませんでした');
  // Articles listed by this page or its feed, but stored under other paths of the same host
  // (e.g. a Zenn publication): the list/feed itself becomes the scope.
  if (!result.adapter && (feedUrl || html)) {
    const linkedScope: SiteScope = { ...scope, linked: true };
    const linkedEnv: SiteEnv = { fetch, scope: linkedScope, robots };
    // The feed first (it names exactly this page's articles); common feed paths are tried when the
    // page does not link one (e.g. pages drawn by JavaScript). A list page counts only when its links
    // are at least two levels deep (/author/articles/slug), so menus and footers do not qualify.
    const guessedFeeds = feedUrl ? [] : [`${page.url.replace(/\/+$/, '')}/feed`, `${page.url.replace(/\/+$/, '')}/rss`];
    const deepLinks = extractArticleLinks(html, page.url, { hosts: scope.hosts, pathPrefix: '/' }).filter(link => new URL(link.url).pathname.split('/').filter(Boolean).length >= 2);
    const linkedConfigs: AdapterConfig[] = [
      ...(feedUrl ? [{ type: 'feed' as const, feedUrl, linked: true }] : guessedFeeds.map(url => ({ type: 'feed' as const, feedUrl: url, linked: true }))),
      ...(robots.allows(finalUrl.pathname) && deepLinks.length >= 3 ? [{ type: 'listpage' as const, listUrl: page.url, linked: true }] : []),
    ];
    for (const config of linkedConfigs) {
      try {
        const listed = await listArticles(linkedEnv, config, { includeBody: false, maxItems: 50 });
        if (!listed.articles.length) continue;
        result.available.push(config.type);
        result.adapter = config;
        result.scope = linkedScope;
        result.samples = listed.articles.slice(0, 5);
        result.estimatedCount = listed.total ?? listed.articles.length;
        result.notes.push(...listed.warnings, 'このページ（とそのRSS）に載っている記事だけを対象にします。同じサイトのほかの記事は集めません');
        break;
      } catch (error) {
        if (!guessedFeeds.includes(config.feedUrl ?? '')) result.notes.push(`${ADAPTER_LABELS[config.type]}を使えませんでした（${(error as Error).message}）`);
      }
    }
  }
  if (!result.adapter) {
    result.error = 'このサイトは自動では登録できません（公開API・サイトマップ・記事一覧・RSSのどれでも記事を見つけられませんでした）';
    return result;
  }
  // The whole host: fine for a blog-only host, but it has to be confirmed (a company site also has news, jobs, products...).
  result.needsScopeConfirm = !result.scope.linked && result.prefixes.includes('/');
  result.ok = true;
  return result;
}

// ─── from an article URL ─────────────────────────────────────

export type InspectResult = {
  kind: 'source' | 'article';
  article: { url: string; title: string | null; publishedAt: string | null } | null;
  candidates: DetectResult[];
  error: string | null;
};

function hasOwnFeed(html: string, url: string): boolean {
  const page = new URL(url);
  const own = page.pathname.replace(/\/+$/, '');
  if (!own) return false;
  for (const match of html.matchAll(/<link\s[^>]*>/gi)) {
    const tag = match[0];
    if (!/application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const feed = new URL(href, url);
      if (feed.hostname === page.hostname && feed.pathname.startsWith(`${own}/`)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/** Distinct same-host links that look like articles (any URL shape: a publication links many writers). */
function countArticleLikeLinks(html: string, url: string): number {
  const scope = { hosts: [new URL(url).hostname], pathPrefix: '/' };
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    const link = normalizeArticleUrl(match[1], url);
    if (!link || link === normalizeArticleUrl(url) || !looksLikeArticle(link, scope)) continue;
    if (new URL(link).pathname.split('/').filter(Boolean).length < 2) continue;
    seen.add(link);
  }
  return seen.size;
}

function isArticlePage(html: string, url: string): boolean {
  if (!html) return false;
  const ogType = (metaContent(html, ['og:type']) ?? '').toLowerCase();
  if (/"@type"\s*:\s*"(BlogPosting|NewsArticle|TechArticle|Article|Report)"/.test(html)) return true;
  if (metaContent(html, ['article:published_time'])) return true;
  // Some list pages also say og:type=article (a Zenn publication page links ~100 articles). Without a
  // publish date, a page that links many articles of the same site is a list, not an article.
  if (ogType === 'article') {
    // A page with its own feed under its own path (zenn.dev/p/team → zenn.dev/p/team/feed) is a list.
    if (hasOwnFeed(html, url)) return false;
    return countArticleLikeLinks(html, url) < 15;
  }
  const depth = new URL(url).pathname.split('/').filter(Boolean).length;
  return depth >= 2 && /<article[\s>]/i.test(html) && extractArticleLinks(html, url, { hosts: [new URL(url).hostname], pathPrefix: '/' }).length < 3;
}

/** Ancestor folders the page itself names as its blog (JSON-LD isPartOf / breadcrumbs), same host only. */
function namedParents(html: string, url: string): string[] {
  const out: string[] = [];
  const host = new URL(url).hostname;
  const path = new URL(url).pathname;
  for (const match of html.matchAll(/"(?:isPartOf|item|@id|url)"\s*:\s*(?:\{[^}]*?"(?:@id|url)"\s*:\s*)?"(https?:[^"]+)"/g)) {
    try {
      const candidate = new URL(match[1]);
      if (candidate.hostname !== host) continue;
      let prefix = candidate.pathname.endsWith('/') ? candidate.pathname : `${candidate.pathname}/`;
      if (prefix === '/' || !path.startsWith(prefix) || path === prefix || `${path}/` === prefix) continue;
      prefix = prefix.replace(/\/+/g, '/');
      if (!out.includes(prefix)) out.push(prefix);
    } catch { /* ignore */ }
  }
  return out.sort((a, b) => a.length - b.length);
}

/**
 * A URL typed by the user: a blog's top page, or one of its articles. For an article, the blog it
 * belongs to is estimated (folders the page names, its path, then what the site's sitemap/API/list
 * shows) and up to two possible scopes are offered. The host root is offered only when nothing
 * narrower works, and then has to be confirmed.
 */
export async function inspectUrl(rawUrl: string, fetch: SafeFetcher): Promise<InspectResult> {
  let start: URL;
  try {
    start = assertPublicUrl(normalizeArticleUrl(/^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`) ?? rawUrl);
  } catch (error) {
    return { kind: 'source', article: null, candidates: [], error: (error as Error).message };
  }
  if (isSharedHost(start.hostname) && (start.pathname.replace(/\/+$/, '') || '/') === '/') {
    // note.com / zenn.dev / qiita.com … : the top page is everyone's articles, not one blog.
    return { kind: 'source', article: null, candidates: [], error: `${start.hostname} は多くの人が書いている共通のサイトなので、サイト全体は登録できません。登録したい人や組織のページのURL（例: https://${start.hostname}/ユーザー名）を入れてください` };
  }
  let page;
  try {
    page = await typedFetch(fetch, start, { accept: 'text/html,application/xhtml+xml', maxBytes: 3 * 1024 * 1024 }, HTML_TYPES);
  } catch (error) {
    return { kind: 'source', article: null, candidates: [], error: `ページにアクセスできませんでした（${(error as Error).message}）` };
  }
  const html = /html/i.test(page.contentType) || !page.contentType ? page.text() : '';
  const meta = extractPageMeta(html, page.url);
  const articleUrl = meta.canonical && new URL(meta.canonical).hostname === new URL(page.url).hostname ? meta.canonical : normalizeArticleUrl(page.url) ?? page.url;
  if (!isArticlePage(html, page.url)) {
    return { kind: 'source', article: null, candidates: [await detectSite(page.url, fetch)], error: null };
  }
  const article = { url: articleUrl, title: meta.title ? stripSiteSuffix(meta.title, meta.siteName) : null, publishedAt: meta.publishedAt ?? null };
  const origin = new URL(articleUrl).origin;
  const prefixes = [...new Set([...namedParents(html, articleUrl), ...candidatePrefixes(articleUrl)])];
  const candidates: DetectResult[] = [];
  let lastError: string | null = null;
  for (const prefix of prefixes.slice(0, 4)) {
    if (prefix === '/' && candidates.length) break; // the whole host only when nothing narrower works
    let detected = await detectSite(`${origin}${prefix}`, fetch, { prefixes: [prefix] });
    if (!detected.ok && /アクセスできません/.test(detected.error ?? '') && prefix !== '/') {
      // the folder has no page of its own (e.g. /entry/): read the top page, keep the folder as the scope
      detected = await detectSite(`${origin}/`, fetch, { prefixes: [prefix] });
    }
    if (detected.ok && acceptsUrl(articleUrl, detected.scope)) {
      candidates.push(detected);
      if (candidates.length >= 2) break;
    } else if (detected.error) {
      lastError = detected.error;
    }
  }
  return {
    kind: 'article',
    article,
    candidates,
    error: candidates.length ? null : `この記事が属するブログを自動では判定できませんでした${lastError ? `（${lastError}）` : ''}。記事だけ保存するか、ブログのトップページのURLで試してください`,
  };
}
