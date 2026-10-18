/**
 * Discover: search the web for a purpose, without any AI on the server.
 *
 *   queries (from Chrome's on-device AI, or from the purpose's own words)
 *     → free public sources (Qiita API, Hatena Bookmark search RSS, GitHub repo search, arXiv API)
 *     → one list, deduplicated by URL
 *     → ranked by my-search's BM25 pipeline × a trust rule (source + popularity)
 *
 * Each result carries its score breakdown so the user can see why it ranks where it does.
 * Responses are cached in memory for a while to stay well inside the sources' rate limits
 * (Qiita: 60 requests/hour without a token, GitHub: 10/minute without a token).
 */
import { buildStoredTokenSet, runPipeline, tokenizeNouns, type Article, type ModeConfig } from '../bm25_engine.js';

export type DiscoverSourceId = 'qiita' | 'hatena' | 'github' | 'arxiv';
export const DISCOVER_SOURCES: DiscoverSourceId[] = ['qiita', 'hatena', 'github', 'arxiv'];

export type FetchText = (url: string, headers: Record<string, string>) => Promise<string>;

export type DiscoverHit = {
  title: string;
  url: string;
  body: string;
  summary: string;
  publishedAt: Date;
  updatedAt?: Date;
  author: string | null;
  /** likes / bookmarks / stars */
  popularity: number;
  popularityLabel: string;
  site: string;
  via: DiscoverSourceId | 'feed';
  tags: string[];
};

type Provider = {
  id: DiscoverSourceId;
  label: string;
  url: (query: string, limit: number) => string;
  headers: (env: NodeJS.ProcessEnv) => Record<string, string>;
  parse: (text: string) => DiscoverHit[];
  /** Wait this long between two requests (arXiv asks for one request every 3 seconds). */
  minIntervalMs?: number;
  /** Only queries without Japanese (English-only sources such as arXiv). */
  latinOnly?: boolean;
};

const UA = 'my-search (personal research tool)';

export function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeEntities(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Markdown → plain text that is good enough for ranking and a snippet (code blocks are dropped). */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(xml: string, name: string): string {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return match ? decodeEntities(match[1]).trim() : '';
}

function siteOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function validDate(raw: unknown): Date {
  const date = new Date(String(raw ?? ''));
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

const qiita: Provider = {
  id: 'qiita',
  label: 'Qiita',
  url: (query, limit) => `https://qiita.com/api/v2/items?page=1&per_page=${limit}&query=${encodeURIComponent(query)}`,
  headers: (env): Record<string, string> => (env.QIITA_TOKEN ? { Authorization: `Bearer ${env.QIITA_TOKEN}` } : {}),
  parse: text => {
    const items = JSON.parse(text);
    if (!Array.isArray(items)) return [];
    return items.filter(item => item && item.title && item.url).map(item => {
      const body = markdownToText(String(item.body ?? '')).slice(0, 6000);
      return {
        title: String(item.title),
        url: String(item.url),
        body,
        summary: body.slice(0, 200),
        publishedAt: validDate(item.created_at),
        author: item.user?.name || item.user?.id || null,
        popularity: Number(item.likes_count ?? 0) + Number(item.stocks_count ?? 0),
        popularityLabel: `いいね ${Number(item.likes_count ?? 0)}・ストック ${Number(item.stocks_count ?? 0)}`,
        site: 'qiita.com',
        via: 'qiita' as const,
        tags: Array.isArray(item.tags) ? item.tags.map((t: { name?: unknown }) => String(t?.name ?? '')).filter(Boolean) : [],
      };
    });
  },
};

/** Hatena Bookmark full-text search (RSS 1.0). Covers Zenn, note, personal blogs and Qiita too. */
const hatena: Provider = {
  id: 'hatena',
  label: 'はてなブックマーク',
  url: query => `https://b.hatena.ne.jp/q/${encodeURIComponent(query)}?target=text&mode=rss&sort=popular`,
  headers: () => ({}),
  parse: text => {
    const items = text.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
    return items.map(item => {
      const url = tag(item, 'link') || (item.match(/rdf:about="([^"]+)"/)?.[1] ?? '');
      const description = stripTags(tag(item, 'description'));
      const bookmarks = Number(tag(item, 'hatena:bookmarkcount') || 0);
      return {
        title: stripTags(tag(item, 'title')),
        url: decodeEntities(url),
        body: description,
        summary: description.slice(0, 200),
        publishedAt: validDate(tag(item, 'dc:date')),
        author: null,
        popularity: bookmarks,
        popularityLabel: `はてブ ${bookmarks}`,
        site: siteOf(decodeEntities(url)),
        via: 'hatena' as const,
        tags: (item.match(/<dc:subject>([\s\S]*?)<\/dc:subject>/g) ?? []).map(s => stripTags(s)).filter(Boolean),
      };
    }).filter(hit => hit.title && /^https?:\/\//.test(hit.url));
  },
};

const github: Provider = {
  id: 'github',
  label: 'GitHub',
  url: (query, limit) => `https://api.github.com/search/repositories?per_page=${limit}&q=${encodeURIComponent(query)}`,
  headers: env => ({ Accept: 'application/vnd.github+json', ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) }),
  parse: text => {
    const json = JSON.parse(text);
    const items = Array.isArray(json?.items) ? json.items : [];
    return items.filter((item: Record<string, unknown>) => item?.full_name && item?.html_url).map((item: Record<string, any>) => {
      const topics: string[] = Array.isArray(item.topics) ? item.topics.map(String) : [];
      const description = String(item.description ?? '');
      const stars = Number(item.stargazers_count ?? 0);
      return {
        title: String(item.full_name),
        url: String(item.html_url),
        body: [description, topics.join(' '), item.language ?? ''].filter(Boolean).join(' '),
        summary: description.slice(0, 200),
        publishedAt: validDate(item.pushed_at ?? item.updated_at),
        author: item.owner?.login ?? null,
        popularity: stars,
        popularityLabel: `★ ${stars}`,
        site: 'github.com',
        via: 'github' as const,
        tags: topics,
      };
    });
  },
};

const arxiv: Provider = {
  id: 'arxiv',
  label: 'arXiv',
  minIntervalMs: 3100,
  latinOnly: true,
  url: (query, limit) => {
    const terms = query.split(/\s+/).filter(Boolean).map(term => `all:${encodeURIComponent(term)}`).join('+AND+');
    return `https://export.arxiv.org/api/query?search_query=${terms}&start=0&max_results=${limit}&sortBy=relevance`;
  },
  headers: () => ({}),
  parse: text => {
    const entries = text.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
    return entries.map(entry => {
      const summary = tag(entry, 'summary').replace(/\s+/g, ' ');
      const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => decodeEntities(m[1]).trim());
      const id = tag(entry, 'id');
      return {
        title: tag(entry, 'title').replace(/\s+/g, ' '),
        url: id.replace(/^http:/, 'https:'),
        body: summary,
        summary: summary.slice(0, 200),
        publishedAt: validDate(tag(entry, 'published')),
        author: authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' ほか' : ''),
        popularity: 0,
        popularityLabel: '論文（プレプリント）',
        site: 'arxiv.org',
        via: 'arxiv' as const,
        tags: [],
      };
    }).filter(hit => hit.title && hit.url);
  },
};

export const PROVIDERS: Record<DiscoverSourceId, Provider> = { qiita, hatena, github, arxiv };

// ─── RSS / Atom feeds (sources with no search API) ───────────

/** Parse RSS 2.0, RSS 1.0 (RDF) or Atom into hits. */
export function parseFeed(text: string, feedUrl: string): DiscoverHit[] {
  const blocks = text.match(/<item[\s>][\s\S]*?<\/item>/g) ?? text.match(/<entry[\s>][\s\S]*?<\/entry>/g) ?? [];
  return blocks.map(block => {
    const atomLink = block.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1] ?? block.match(/<link[^>]*href="([^"]+)"/)?.[1];
    const url = decodeEntities(tag(block, 'link') || atomLink || block.match(/rdf:about="([^"]+)"/)?.[1] || tag(block, 'guid'));
    let absolute = url;
    try { absolute = new URL(url, feedUrl).toString(); } catch { /* keep */ }
    const description = stripTags(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content:encoded') || tag(block, 'content'));
    return {
      title: stripTags(tag(block, 'title')),
      url: absolute,
      body: description.slice(0, 6000),
      summary: description.slice(0, 200),
      publishedAt: validDate(tag(block, 'pubDate') || tag(block, 'dc:date') || tag(block, 'published')),
      updatedAt: tag(block, 'updated') ? validDate(tag(block, 'updated')) : undefined,
      author: stripTags(tag(block, 'dc:creator') || tag(block, 'name')) || null,
      popularity: 0,
      popularityLabel: 'フィード',
      site: siteOf(absolute) || siteOf(feedUrl),
      via: 'feed' as const,
      tags: (block.match(/<(?:category|dc:subject)[^>]*>([\s\S]*?)<\/(?:category|dc:subject)>/g) ?? []).map(s => stripTags(s)).filter(Boolean),
    };
  }).filter(hit => hit.title && /^https?:\/\//.test(hit.url));
}

// ─── trust rule ──────────────────────────────────────────────

const SITE_BASE: Array<[RegExp, number, string]> = [
  [/(^|\.)arxiv\.org$/, 0.75, '論文プレプリント'],
  [/(^|\.)github\.com$/, 0.45, 'GitHubリポジトリ（スター数で加点）'],
  [/(^|\.)qiita\.com$/, 0.5, '技術記事（Qiita）'],
  [/(^|\.)zenn\.dev$/, 0.5, '技術記事（Zenn）'],
  [/\.(go\.jp|ac\.jp|edu)$/, 0.75, '公的機関・大学'],
];

/**
 * How much to trust a hit, 0–1: a base by site, plus up to 0.3 for popularity
 * (log scale: 10 → +0.1, 100 → +0.2, 1000+ → +0.3). Shown to the user as is.
 */
export function trustOf(hit: Pick<DiscoverHit, 'site' | 'popularity'>): { authority: number; base: number; popularityBonus: number; reason: string } {
  const rule = SITE_BASE.find(([pattern]) => pattern.test(hit.site));
  const base = rule ? rule[1] : 0.45;
  const popularityBonus = Math.min(0.3, Math.log10(1 + Math.max(0, hit.popularity)) * 0.1);
  return {
    authority: Math.min(1, Number((base + popularityBonus).toFixed(3))),
    base,
    popularityBonus: Number(popularityBonus.toFixed(3)),
    reason: rule ? rule[2] : 'ブログ・その他',
  };
}

// ─── queries without AI ──────────────────────────────────────

/** Words of the purpose itself (nouns etc. by the morphological analyzer), when no AI made queries. */
const PURPOSE_STOP_WORDS = new Set(['する', 'いる', 'ある', 'なる', 'できる', 'こと', 'もの', 'ため', 'よう', 'たい', '知る', '調べる', '方法', 'について', '結果', '理由', '場合', '必要', 'やり方', '思う', '使う', '動かす', 'したい']);

/** The content words of the purpose, in order (English words first), at most 6. */
export async function purposeWords(purpose: string): Promise<string[]> {
  const ascii = purpose.match(/[A-Za-z][A-Za-z0-9.+#-]{1,}/g) ?? [];
  // nouns carry the topic (書き込み, 再現); verbs and adjectives (知りたい, 動かす) do not
  const tokens = await tokenizeNouns(purpose.replace(/[A-Za-z][A-Za-z0-9.+#-]{1,}/g, ' '));
  return [...new Set([...ascii.map(word => word.toLowerCase()), ...tokens])]
    .filter(word => word.length > 1 && !PURPOSE_STOP_WORDS.has(word))
    .slice(0, 6);
}

export async function fallbackQueries(purpose: string): Promise<string[]> {
  const words = (await purposeWords(purpose)).slice(0, 4);
  if (words.length === 0) return [];
  const queries = [words.slice(0, 3).join(' ')];
  if (words.length > 1) queries.push(words.slice(0, 2).join(' '));
  return [...new Set(queries)];
}

// ─── fetching ────────────────────────────────────────────────

export const defaultFetchText: FetchText = async (url, headers) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(10_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

const CACHE_MS = 15 * 60_000;
const cache = new Map<string, { at: number; hits: DiscoverHit[] }>();

export function clearDiscoverCache(): void {
  cache.clear();
}

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Returns the hits and whether the network was used (for pacing). A 429 is retried once after the interval. */
async function fetchProvider(provider: Provider, query: string, limit: number, fetchText: FetchText, env: NodeJS.ProcessEnv, sleep: Sleep): Promise<{ hits: DiscoverHit[]; fetched: boolean }> {
  const url = provider.url(query, limit);
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_MS) return { hits: cached.hits, fetched: false };
  let text: string;
  try {
    text = await fetchText(url, provider.headers(env));
  } catch (err) {
    if (!/429/.test((err as Error).message) || !provider.minIntervalMs) throw err;
    await sleep(provider.minIntervalMs);
    text = await fetchText(url, provider.headers(env));
  }
  const hits = provider.parse(text).slice(0, limit);
  cache.set(url, { at: Date.now(), hits });
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return { hits, fetched: true };
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) if (/^utm_/.test(key)) parsed.searchParams.delete(key);
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`.toLowerCase();
  } catch {
    return url;
  }
}

/** One entry per URL; when two sources return the same page, keep the longer text and the larger popularity. */
export function mergeHits(hits: DiscoverHit[]): Array<DiscoverHit & { foundBy: Array<DiscoverSourceId | 'feed'> }> {
  const byUrl = new Map<string, DiscoverHit & { foundBy: Array<DiscoverSourceId | 'feed'> }>();
  for (const hit of hits) {
    const key = normalizeUrl(hit.url);
    const existing = byUrl.get(key);
    if (!existing) { byUrl.set(key, { ...hit, foundBy: [hit.via] }); continue; }
    if (!existing.foundBy.includes(hit.via)) existing.foundBy.push(hit.via);
    if (hit.body.length > existing.body.length) {
      Object.assign(existing, { body: hit.body, summary: hit.summary, via: hit.via, author: hit.author ?? existing.author, tags: hit.tags.length ? hit.tags : existing.tags });
    }
    if (hit.popularity > existing.popularity) Object.assign(existing, { popularity: hit.popularity, popularityLabel: hit.popularityLabel });
  }
  return [...byUrl.values()];
}

// ─── ranking ─────────────────────────────────────────────────

// The morphological analyzer splits "BM25" into "bm" + "25", and then any "25" in a text counts
// as a match. Words mixing letters and digits are kept whole by spelling the digits as letters
// (bm25 → bmzqczqf) in both the texts and the query, and spelled back for display.
const MIXED_ALNUM = /[a-z]+\d[a-z\d]*|\d+[a-z][a-z\d]*/gi;
const DIGIT_LETTERS = 'abcdefghij';
export function protectAlnum(text: string): string {
  return text.normalize('NFKC').replace(MIXED_ALNUM, word => word.toLowerCase().replace(/\d/g, digit => `zq${DIGIT_LETTERS[Number(digit)]}`));
}
export function restoreAlnum(term: string): string {
  return term.replace(/zq([a-j])/g, (_, letter: string) => String(DIGIT_LETTERS.indexOf(letter)));
}

/**
 * An English / alphanumeric word in a Japanese purpose is usually the specific topic (BM25, React,
 * LLM), while Japanese nouns are often general (検索, 方法). Inside a set of search results the usual
 * IDF cannot tell this (every result contains the searched words), so it is given here.
 */
export function purposeTermWeight(term: string): number {
  return /^[a-z0-9.+#-]+$/i.test(term.trim()) ? 3 : 2;
}

/**
 * Ranking keywords: the words of the purpose itself weigh 2 (English / alphanumeric ones 3), the other words of the queries 1
 * (queries may come from the on-device AI, which sometimes drifts from the purpose).
 */
export function discoverMode(queries: string[], purposeTerms: string[] = []): ModeConfig {
  const weights = new Map<string, number>();
  for (const term of queries.flatMap(query => query.split(/\s+/))) {
    const key = protectAlnum(term.trim()).toLowerCase();
    if (key && !weights.has(key)) weights.set(key, 1);
  }
  for (const term of purposeTerms) {
    const key = protectAlnum(term.trim()).toLowerCase();
    if (key) weights.set(key, purposeTermWeight(term));
  }
  const terms = [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  return {
    label: '目的から探す',
    description: '検索語から作る一時的な設定',
    k1: 1.2,
    b: 0.3, // weak length normalization: descriptions (GitHub, はてブ) and article openings differ a lot in length
    lambda: Math.LN2 / 730, // half-life of two years: technical articles age, but slowly
    contextBonus: 1.2, // upper bound of the co-occurrence multiplier (0 would zero out every full match)
    morphologicalWeight: 0.5,
    ngramWeight: 0.5,
    keywords: terms.map(([term, weight]) => ({ term, weight, synonyms: [] })),
  } as ModeConfig;
}

export const RANK_TEXT_CHARS = 1500;

export type DiscoverResult = {
  title: string;
  url: string;
  site: string;
  via: DiscoverSourceId | 'feed';
  foundBy: Array<DiscoverSourceId | 'feed'>;
  author: string | null;
  summary: string;
  publishedAt: string | null;
  tags: string[];
  popularity: number;
  popularityLabel: string;
  score: number;
  breakdown: { relevance: number; purposeCoverage: number; missingKeyTerms: string[]; timeDecay: number; trust: number; trustBase: number; popularityBonus: number; trustReason: string; matchedTerms: string[] };
};

export type DiscoverOutput = {
  queries: string[];
  querySource: 'given' | 'purpose';
  results: DiscoverResult[];
  sources: Array<{ id: DiscoverSourceId | 'feed'; label: string; count: number; error: string | null }>;
  stats: { fetched: number; unique: number; ranked: number };
};

/**
 * Final score = relevance (BM25, recency included) × (0.5 + 0.5 × trust).
 * Relevance comes first; trust only reorders results that are about equally relevant.
 */
export async function discover(
  input: { purpose?: string; queries?: string[]; sources?: DiscoverSourceId[]; feeds?: string[]; perSource?: number; limit?: number },
  options: { fetchText?: FetchText; env?: NodeJS.ProcessEnv; sleep?: Sleep } = {},
): Promise<DiscoverOutput> {
  const fetchText = options.fetchText ?? defaultFetchText;
  const sleep = options.sleep ?? realSleep;
  const env = options.env ?? process.env;
  const given = (input.queries ?? []).map(query => query.trim()).filter(Boolean).slice(0, 4);
  const queries = given.length > 0 ? given : await fallbackQueries(input.purpose ?? '');
  const purposeTerms = input.purpose ? await purposeWords(input.purpose) : [];
  const sources = (input.sources?.length ? input.sources : DISCOVER_SOURCES).filter(id => id in PROVIDERS);
  const perSource = Math.min(Math.max(input.perSource ?? 10, 1), 20);
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const output: DiscoverOutput = {
    queries,
    querySource: given.length > 0 ? 'given' : 'purpose',
    results: [],
    sources: [],
    stats: { fetched: 0, unique: 0, ranked: 0 },
  };
  if (queries.length === 0) return output;

  const all: DiscoverHit[] = [];
  await Promise.all(sources.map(async id => {
    const provider = PROVIDERS[id];
    let count = 0;
    let error: string | null = null;
    let fetchedBefore = false;
    for (const query of queries) {
      if (provider.latinOnly && /[\u3040-\u30ff\u3400-\u9fff]/.test(query)) continue;
      try {
        if (fetchedBefore && provider.minIntervalMs) await sleep(provider.minIntervalMs);
        const { hits, fetched } = await fetchProvider(provider, query, perSource, fetchText, env, sleep);
        fetchedBefore = fetched;
        count += hits.length;
        all.push(...hits);
      } catch (err) {
        error = (err as Error).message || 'error';
      }
    }
    output.sources.push({ id, label: provider.label, count, error });
  }));
  // Feeds have no search: fetch each once, and let the ranking below decide what fits the purpose.
  for (const feedUrl of (input.feeds ?? []).slice(0, 20)) {
    try {
      const cached = cache.get(feedUrl);
      const hits = cached && Date.now() - cached.at < CACHE_MS ? cached.hits : parseFeed(await fetchText(feedUrl, {}), feedUrl).slice(0, 100);
      cache.set(feedUrl, { at: Date.now(), hits });
      all.push(...hits);
      output.sources.push({ id: 'feed', label: siteOf(feedUrl), count: hits.length, error: null });
    } catch (err) {
      output.sources.push({ id: 'feed', label: siteOf(feedUrl), count: 0, error: (err as Error).message || 'error' });
    }
  }
  output.sources.sort((a, b) => (a.id === 'feed' ? 99 : sources.indexOf(a.id)) - (b.id === 'feed' ? 99 : sources.indexOf(b.id)));
  output.stats.fetched = all.length;

  const merged = mergeHits(all);
  output.stats.unique = merged.length;
  const byId = new Map<string, (typeof merged)[number] & { trust: ReturnType<typeof trustOf> }>();
  const articles: Article[] = await Promise.all(merged.map(async (hit, index) => {
    const trust = trustOf(hit);
    const id = `discover-${index}`;
    byId.set(id, { ...hit, trust });
    // Rank on the same amount of text for every source: Qiita returns whole articles, the others
    // a description. Whole bodies would lose to one-line descriptions on BM25's length normalization.
    const text = protectAlnum(`${hit.title}\n${hit.tags.join(' ')}\n${hit.body.slice(0, RANK_TEXT_CHARS)}`);
    return {
      ...(await buildStoredTokenSet(text)),
      id,
      title: hit.title,
      body: text,
      summary: hit.summary,
      url: hit.url,
      source: hit.site,
      sourceAuthority: trust.authority,
      publishedAt: hit.publishedAt.getTime() > 0 ? hit.publishedAt : new Date(Date.now() - 365 * 86_400_000),
      tags: hit.tags,
    };
  }));

  // Near-duplicate removal keeps the copy with more text × higher trust (pipeline layer 1).
  const mode = discoverMode(queries, purposeTerms);
  const protectedPurpose = purposeTerms.map(term => protectAlnum(term).toLowerCase());
  const pipeline = await runPipeline(articles, mode, 'discover', { archiveScoreThreshold: 0, resultLimit: 500, timeDecayFloor: 0.5 });
  output.results = pipeline.active.map(scored => {
    const hit = byId.get(scored.article.id)!;
    const text = scored.article.body.toLowerCase();
    // How much of the purpose the text covers. A page that matches only the AI's extra words
    // (e.g. a generic 仕組み) and not what was asked for sinks.
    const totalWeight = purposeTerms.reduce((sum, term) => sum + purposeTermWeight(term), 0);
    const coverage = totalWeight ? purposeTerms.reduce((sum, term, i) => sum + (text.includes(protectedPurpose[i]) ? purposeTermWeight(term) : 0), 0) / totalWeight : 1;
    // The specific words (English / alphanumeric) name the topic: a page with none of them is
    // about something else even when it shares the general words, so it goes down a lot.
    const keyTerms = purposeTerms.map((term, i) => (purposeTermWeight(term) === 3 ? protectedPurpose[i] : null)).filter((term): term is string => !!term);
    const missingKeyTerms = keyTerms.length > 0 && !keyTerms.some(term => text.includes(term));
    const relevance = scored.score * (0.4 + 0.6 * coverage) * (missingKeyTerms ? 0.3 : 1);
    return {
      title: hit.title,
      url: hit.url,
      site: hit.site,
      via: hit.via,
      foundBy: hit.foundBy,
      author: hit.author,
      summary: hit.summary,
      publishedAt: hit.publishedAt.getTime() > 0 ? hit.publishedAt.toISOString() : null,
      tags: hit.tags.slice(0, 8),
      popularity: hit.popularity,
      popularityLabel: hit.popularityLabel,
      score: Number((relevance * (0.5 + 0.5 * hit.trust.authority)).toFixed(4)),
      breakdown: {
        relevance: Number(relevance.toFixed(4)),
        purposeCoverage: Number(coverage.toFixed(2)),
        missingKeyTerms: missingKeyTerms ? keyTerms.map(restoreAlnum) : [],
        timeDecay: Number(scored.breakdown.timeDecay.toFixed(3)),
        trust: hit.trust.authority,
        trustBase: hit.trust.base,
        popularityBonus: hit.trust.popularityBonus,
        trustReason: hit.trust.reason,
        matchedTerms: mode.keywords.map(keyword => keyword.term).filter(term => text.includes(term)).map(restoreAlnum).slice(0, 10),
      },
    };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
  output.stats.ranked = output.results.length;
  return output;
}

// ─── field presets (feeds checked by hand before they are listed here) ───

export type FieldPreset = { id: string; label: string; kind: string; feeds: string[] };

/** Only these feed URLs are fetched; the API never fetches a feed URL sent by a client. */
export const FIELD_PRESETS: FieldPreset[] = [];

export function feedsForFields(ids: string[]): string[] {
  return [...new Set(FIELD_PRESETS.filter(preset => ids.includes(preset.id)).flatMap(preset => preset.feeds))];
}
