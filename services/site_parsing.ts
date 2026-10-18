/**
 * Pure helpers for registered sites: scope, URL normalisation, robots.txt, sitemaps,
 * page metadata and article links. No network here (easy to test, nothing is executed:
 * HTML and XML are only read with patterns, never run).
 */
import crypto from 'node:crypto';
import { decodeEntities } from './discover_service.js';
import { articleIdentityKey, canonicalArticleUrl } from './article_identity.js';

// ─── scope ───────────────────────────────────────────────────

/** Which URLs belong to a registered site: exact hosts and a path prefix ending in "/". */
/**
 * linked: the site's own list page / feed is the scope (e.g. a Zenn publication, whose articles
 * live under each author's path): an article outside the path is accepted only when that list or
 * feed links to it, and only on the same host. The whole host is never crawled.
 */
export type SiteScope = { hosts: string[]; pathPrefix: string; extraPrefixes?: string[]; linked?: boolean };

export function scopePrefixes(scope: SiteScope): string[] {
  return [scope.pathPrefix, ...(scope.extraPrefixes ?? [])].map(prefix => (prefix.endsWith('/') ? prefix : `${prefix}/`));
}

/**
 * Hosts shared by many writers/companies: a registration there is always limited to one
 * user or organisation (never the whole host).
 */
export const SHARED_HOSTS = ['note.com', 'zenn.dev', 'qiita.com', 'medium.com', 'dev.to', 'hatena.ne.jp', 'speakerdeck.com', 'scrapbox.io', 'hackmd.io', 'github.com', 'gist.github.com', 'tumblr.com', 'ameblo.jp', 'livedoor.jp', 'fc2.com'];
export function isSharedHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^www\./, '');
  return SHARED_HOSTS.includes(name);
}

/** Path segments that mark "an article follows" (/entry/<slug>, /articles/<slug>, /n/<id>, /items/<id>) */
const ARTICLE_MARKERS = /^(entry|entries|articles?|posts?|archives?|n|items|stories|story|p|blog-entry)$/i;
const DATE_SEGMENT = /^(19|20)\d{2}$|^(0?[1-9]|1[0-2])$|^(0?[1-9]|[12]\d|3[01])$|^\d{8}$/;

/**
 * Possible scopes for an article URL, most likely first: the shallowest ancestor below the host
 * root that is not a date (/blog/2026/10/x → /blog/), the "marker" folder (/entry/x → /entry/),
 * and the host root last (never on shared hosts).
 */
export function candidatePrefixes(articleUrl: string): string[] {
  const url = new URL(articleUrl);
  const segments = url.pathname.split('/').filter(Boolean);
  const ancestors: string[] = [];
  for (let depth = 1; depth < segments.length; depth += 1) {
    const last = segments[depth - 1];
    if (DATE_SEGMENT.test(last)) break; // /blog/2026/... : stop at the year
    ancestors.push(`/${segments.slice(0, depth).join('/')}/`);
  }
  const shared = isSharedHost(url.hostname);
  const out: string[] = [];
  // /user/articles/<slug> on a shared host: the user (or org) folder; elsewhere the first folder
  const nonMarker = ancestors.filter(prefix => !ARTICLE_MARKERS.test(prefix.split('/').filter(Boolean).pop() ?? ''));
  const marker = ancestors.filter(prefix => ARTICLE_MARKERS.test(prefix.split('/').filter(Boolean).pop() ?? ''));
  if (shared) {
    // zenn.dev/p/<org>/..., note.com/<user>/n/..., qiita.com/<user>/items/..., qiita.com/organizations/<org>
    const first = segments[0] && (segments[0] === 'p' || segments[0] === 'organizations') && segments[1] ? `/${segments[0]}/${segments[1]}/` : segments[0] ? `/${segments[0]}/` : null;
    if (first && segments.length > 1) out.push(first);
  } else {
    if (nonMarker.length) out.push(nonMarker[0]);
    for (const prefix of marker) if (!out.includes(prefix)) out.push(prefix);
    for (const prefix of nonMarker.slice(1)) if (!out.includes(prefix)) out.push(prefix);
    out.push('/');
  }
  return out;
}

/** Validate prefixes typed by the user: absolute paths on the same host, no wildcards, at most 5. */
export function cleanPrefixes(prefixes: string[]): string[] {
  const out: string[] = [];
  for (const raw of prefixes) {
    let value = raw.trim();
    if (!value) continue;
    try { if (/^https?:/i.test(value)) value = new URL(value).pathname; } catch { continue; }
    if (!value.startsWith('/') || /[*?#\s]|\.\./.test(value)) continue;
    if (!value.endsWith('/')) value = `${value}/`;
    if (!out.includes(value)) out.push(value);
  }
  return out.slice(0, 5);
}


/** The URL a user typed → the site URL (no query/hash, lower-case host, default port dropped). */
export function normalizeSiteUrl(raw: string): URL {
  const trimmed = raw.trim();
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  url.hash = '';
  url.search = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  return url;
}

/** /blog/ → /blog/ ; /blog → /blog/ ; /blog/index.html → /blog/ ; / → / */
export function scopeFromUrl(url: URL): SiteScope {
  let path = url.pathname || '/';
  if (!path.endsWith('/')) {
    const last = path.slice(path.lastIndexOf('/') + 1);
    path = /\.[a-z0-9]{2,5}$/i.test(last) ? path.slice(0, path.lastIndexOf('/') + 1) : `${path}/`;
  }
  return { hosts: [url.hostname.toLowerCase()], pathPrefix: path };
}

/** Same page, one spelling: no hash, no tracking parameters, lower-case host, default port dropped. */
export function normalizeArticleUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return canonicalArticleUrl(url.toString());
}

/** Key for "is this the same article": http/https, trailing slash and "www." do not matter. */
export function articleKey(url: string): string {
  return articleIdentityKey(url);
}

export function articleIdFor(siteId: string, url: string): string {
  return `site_${siteId}_${crypto.createHash('sha1').update(articleKey(url)).digest('hex').slice(0, 16)}`;
}

/** Inside the site: same host (exactly) and the path at or under the prefix (segment boundary). */
export function inScope(raw: string, scope: SiteScope): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (!scope.hosts.includes(url.hostname.toLowerCase())) return false;
  return scopePrefixes(scope).some(prefix => url.pathname === prefix.slice(0, -1) || url.pathname.startsWith(prefix));
}

/** A URL this site's articles may have: in the scope, or (linked scope) an article URL on the same host. */
export function acceptsUrl(raw: string, scope: SiteScope): boolean {
  if (inScope(raw, scope)) return true;
  return !!scope.linked && looksLikeArticle(raw, { hosts: scope.hosts, pathPrefix: '/' });
}

const NOT_ARTICLE_SEGMENT = /\/(tags?|categor(y|ies)|labels?|authors?|users?|page|pages|feed|rss|search|archives?|wp-content|wp-json|wp-admin|wp-includes|login|signup|about|contact|privacy|terms|policy|cdn-cgi|static|assets|images?|img|css|js|amp)(\/|$)/i;
const NOT_ARTICLE_FILE = /\.(jpe?g|png|gif|webp|svg|ico|css|js|json|xml|gz|zip|mp[34]|mov|woff2?|ttf|txt)$/i;

/** A URL in the scope that looks like one article (not the top, a list, a tag page or a file). */
export function looksLikeArticle(raw: string, scope: SiteScope): boolean {
  if (!inScope(raw, scope)) return false;
  const url = new URL(raw);
  const prefix = scopePrefixes(scope).filter(item => url.pathname.startsWith(item)).sort((a, b) => b.length - a.length)[0] ?? '';
  const rest = prefix ? url.pathname.slice(prefix.length) : '';
  if (!rest.replace(/\/+$/, '') && !url.searchParams.has('p')) return false;
  if (NOT_ARTICLE_SEGMENT.test(`/${rest}`) || NOT_ARTICLE_FILE.test(url.pathname)) return false;
  if (/^(\d+)\/?$/.test(rest) && /page/i.test(url.search)) return false;
  if ([...url.searchParams.keys()].some(key => /^(page|paged|tag|cat|category|s|q|sort|order)$/i.test(key))) return false;
  return true;
}

// ─── robots.txt ──────────────────────────────────────────────

export type Robots = { allows: (path: string) => boolean; sitemaps: string[]; found: boolean };

function robotsPatternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Groups for "my-search" if any, else "*". Longest matching rule wins; Allow wins a tie. */
export function parseRobots(text: string | null, agent = 'my-search'): Robots {
  if (text === null) return { allows: () => true, sitemaps: [], found: false };
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; pattern: string }> }> = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'sitemap') { if (value) sitemaps.push(value); continue; }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && !value) continue; // "Disallow:" = everything allowed
      current.rules.push({ allow: key === 'allow', pattern: value });
    }
  }
  const mine = groups.filter(group => group.agents.some(name => name !== '*' && agent.toLowerCase().includes(name)));
  const chosen = mine.length ? mine : groups.filter(group => group.agents.includes('*'));
  const rules = chosen.flatMap(group => group.rules).map(rule => ({ ...rule, regex: robotsPatternToRegex(rule.pattern) }));
  return {
    found: true,
    sitemaps,
    allows: (path: string) => {
      let best: { allow: boolean; length: number } | null = null;
      for (const rule of rules) {
        if (!rule.regex.test(path)) continue;
        const length = rule.pattern.length;
        if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
      }
      return best ? best.allow : true;
    },
  };
}

// ─── sitemaps ────────────────────────────────────────────────

export type SitemapEntry = { loc: string; lastmod?: string; title?: string; published?: string };
export type ParsedSitemap = { kind: 'index' | 'urlset' | 'unknown'; entries: SitemapEntry[] };

function xmlTag(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i'));
  return match ? decodeEntities(match[1]).trim() : undefined;
}

export function parseSitemap(xml: string, maxEntries = 50_000): ParsedSitemap {
  if (/<(?:[\w-]+:)?sitemapindex[\s>]/i.test(xml)) {
    const entries = (xml.match(/<(?:[\w-]+:)?sitemap[\s>][\s\S]*?<\/(?:[\w-]+:)?sitemap>/gi) ?? []).slice(0, maxEntries)
      .map(block => ({ loc: xmlTag(block, 'loc') ?? '', lastmod: xmlTag(block, 'lastmod') }))
      .filter(entry => entry.loc);
    return { kind: 'index', entries };
  }
  if (/<(?:[\w-]+:)?urlset[\s>]/i.test(xml)) {
    const entries = (xml.match(/<(?:[\w-]+:)?url[\s>][\s\S]*?<\/(?:[\w-]+:)?url>/gi) ?? []).slice(0, maxEntries)
      .map(block => ({ loc: xmlTag(block, 'loc') ?? '', lastmod: xmlTag(block, 'lastmod'), title: xmlTag(block, 'title'), published: xmlTag(block, 'publication_date') }))
      .filter(entry => entry.loc);
    return { kind: 'urlset', entries };
  }
  return { kind: 'unknown', entries: [] };
}

/** Child sitemaps worth reading first: the ones about posts/blog, then the newest. */
export function rankChildSitemaps(entries: SitemapEntry[], scope: SiteScope): SitemapEntry[] {
  const score = (entry: SitemapEntry) => {
    let value = 0;
    if (/post|blog|article|entry|entries|news|story/i.test(entry.loc)) value += 2;
    if (/tag|categor|author|page-sitemap|image|video|attachment|product/i.test(entry.loc)) value -= 2;
    if (inScope(entry.loc, scope)) value += 1;
    return value;
  };
  return [...entries].sort((a, b) => score(b) - score(a) || String(b.lastmod ?? '').localeCompare(String(a.lastmod ?? '')));
}

export function dateOrUndefined(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// ─── HTML (read as text only) ────────────────────────────────

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim() : undefined;
}

function stripHtmlText(html: string): string {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function metaContent(html: string, keys: string[]): string | undefined {
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? attr(tag, 'itemprop') ?? '').toLowerCase();
    if (keys.includes(key)) {
      const value = attr(tag, 'content');
      if (value) return value;
    }
  }
  return undefined;
}

/** <link rel="..." href="..."> values (resolved), optionally only of one type. */
export function linkHrefs(html: string, rel: string, base: string, type?: RegExp): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<link\s[^>]*>/gi) ?? []) {
    const rels = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    if (!rels.includes(rel.toLowerCase())) continue;
    if (type && !type.test(attr(tag, 'type') ?? '')) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    try { out.push(new URL(href, base).toString()); } catch { /* ignore */ }
  }
  return out;
}

function jsonLdObjects(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const match of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(match[1].trim());
      const queue: unknown[] = Array.isArray(value) ? [...value] : [value];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        out.push(record);
        if (Array.isArray(record['@graph'])) queue.push(...record['@graph']);
        if (Array.isArray(record.itemListElement)) queue.push(...record.itemListElement);
        if (record.item && typeof record.item === 'object') queue.push(record.item);
      }
    } catch { /* broken JSON-LD: ignore */ }
  }
  return out;
}

export type PageMeta = { title?: string; siteName?: string; description?: string; publishedAt?: string; updatedAt?: string; canonical?: string; lang?: string };

/** Title, description, dates and canonical URL of one page, from its HTML text. */
export function extractPageMeta(html: string, pageUrl: string): PageMeta {
  const ld = jsonLdObjects(html).find(item => /Article|BlogPosting|NewsArticle|TechArticle|WebPage/i.test(String(item['@type'] ?? '')));
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const timeTag = html.match(/<time[^>]+datetime\s*=\s*["']([^"']+)["']/i)?.[1];
  const canonical = linkHrefs(html, 'canonical', pageUrl)[0];
  return {
    title: metaContent(html, ['og:title', 'twitter:title']) ?? (typeof ld?.headline === 'string' ? ld.headline : undefined) ?? (titleTag ? stripHtmlText(titleTag) : undefined),
    siteName: metaContent(html, ['og:site_name', 'application-name']),
    description: metaContent(html, ['og:description', 'description', 'twitter:description']) ?? (typeof ld?.description === 'string' ? ld.description : undefined),
    publishedAt: dateOrUndefined(metaContent(html, ['article:published_time', 'datepublished', 'date', 'pubdate']) ?? (typeof ld?.datePublished === 'string' ? ld.datePublished : undefined) ?? timeTag),
    updatedAt: dateOrUndefined(metaContent(html, ['article:modified_time', 'og:updated_time', 'datemodified']) ?? (typeof ld?.dateModified === 'string' ? ld.dateModified : undefined)),
    canonical: canonical ? normalizeArticleUrl(canonical) ?? undefined : undefined,
    lang: html.match(/<html[^>]+lang\s*=\s*["']([^"']+)["']/i)?.[1],
  };
}

export type LinkCandidate = { url: string; text: string };

/**
 * Article links on a list page: links inside the scope that look like articles, with their text.
 * Only the most common URL shape is kept (e.g. /blog/entry/<slug>), so navigation and footer
 * links drop out. Fewer than 3 → not an article list.
 */
export function extractArticleLinks(html: string, pageUrl: string, scope: SiteScope): LinkCandidate[] {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ');
  const found = new Map<string, string>();
  for (const match of body.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(` ${match[1]}`, 'href');
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    const url = normalizeArticleUrl(href, pageUrl);
    if (!url || !looksLikeArticle(url, scope)) continue;
    const text = stripHtmlText(match[2]);
    const previous = found.get(url);
    if (previous === undefined || text.length > previous.length) found.set(url, text);
  }
  for (const item of jsonLdObjects(html)) {
    const raw = typeof item.url === 'string' ? item.url : typeof item['@id'] === 'string' ? item['@id'] as string : null;
    const url = raw ? normalizeArticleUrl(raw, pageUrl) : null;
    if (!url || !looksLikeArticle(url, scope)) continue;
    const title = typeof item.headline === 'string' ? item.headline : typeof item.name === 'string' ? item.name : '';
    if (!found.has(url) || (found.get(url) ?? '').length < title.length) found.set(url, title);
  }
  const shape = (url: string) => new URL(url).pathname.replace(/\/+$/, '').split('/').slice(0, -1).map(part => (/^\d+$/.test(part) ? '#' : part)).join('/');
  const groups = new Map<string, LinkCandidate[]>();
  for (const [url, text] of found) {
    if (text.length < 4) continue;
    const key = shape(url);
    groups.set(key, [...(groups.get(key) ?? []), { url, text: text.slice(0, 300) }]);
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  return best.length >= 3 ? best : [];
}

/** Links to terms of use / policies on a page, so the user can check them before allowing full text. */
export function extractPolicyLinks(html: string, pageUrl: string): Array<{ url: string; text: string }> {
  const out = new Map<string, string>();
  for (const match of html.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const text = stripHtmlText(match[2]);
    const href = attr(` ${match[1]}`, 'href');
    if (!href || !/(利用規約|規約|ご利用|terms|copyright|著作権|ガイドライン|guideline|ポリシー|policy)/i.test(`${text} ${href}`)) continue;
    if (/privacy|プライバシー|個人情報/i.test(`${text} ${href}`) && !/利用規約|terms/i.test(text)) continue;
    try { out.set(new URL(href, pageUrl).toString(), text.slice(0, 60)); } catch { /* ignore */ }
    if (out.size >= 5) break;
  }
  return [...out].map(([url, text]) => ({ url, text }));
}

/** "Article - Site name" → "Article" (only when the suffix is the site's name). */
export function stripSiteSuffix(title: string, siteName: string | undefined): string {
  if (!siteName) return title;
  const escaped = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = title.replace(new RegExp(`\\s*[-|｜–—:：]\\s*${escaped}\\s*$`), '').trim();
  return stripped || title;
}

export function siteNameFromHtml(html: string, fallback: string): string {
  const name = metaContent(html, ['og:site_name', 'application-name']);
  if (name) return name.slice(0, 100);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? stripHtmlText(title).split(/\s[|｜\-–—]\s/)[0].slice(0, 100) || fallback : fallback;
}
