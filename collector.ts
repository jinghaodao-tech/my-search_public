/**
 * collector.ts — データ収集エンジン
 * RSS / arXiv / GitHub を収集して Article[] に正規化する
 *
 * 依存追加: npm install rss-parser node-cron
 */

import RSSParser from 'rss-parser';
import cron      from 'node-cron';
import { safeFetch } from './services/safe_fetch.js';
import { articleIdentityKey, stableArticleId } from './services/article_identity.js';
import { buildStoredTokenSet, type Article } from './bm25_engine.js';
import {
  loadArticlesFromDb,
  getArticleById,
  loadArticleStats,
  reuseArticleTokenCache,
  saveArticlesToDb,
} from './repositories/articles_repository.js';

export function saveArticles(result: CollectResult): void {
    const saved = saveArticlesToDb(result.articles, result.stats.fetchedAt);
    console.log(`  saved articles to SQLite (${result.articles.length} items, inserted=${saved.inserted}, updated=${saved.updated}, skippedDuplicateUrls=${saved.skippedDuplicateUrls})`);
}

export function loadArticles(): CollectResult | null {
  try {
    const articles = loadArticlesFromDb();
    if (!articles.length) return null;
    const stats = loadArticleStats() ?? {
      rss: 0,
      arxiv: 0,
      github: 0,
      total: articles.length,
      fetchedAt: new Date(0).toISOString(),
    };
    console.log(`  loaded articles from SQLite: ${articles.length} items (${stats.fetchedAt})`);
    return { articles, errors: [], stats };
  } catch (e) {
    console.warn('  loadArticles failed:', (e as Error).message);
    return null;
  }
}

export async function ensureArticleTokens(result: CollectResult, forceRebuild = false): Promise<CollectResult> {
  const cachedArticles = forceRebuild ? result.articles.map(article => ({ ...article, tokens: undefined, morphologicalTokens: undefined, ngramTokens: undefined })) : reuseArticleTokenCache(result.articles);
  const articles = await Promise.all(cachedArticles.map(async (article) => {
    if (Array.isArray(article.morphologicalTokens) && article.morphologicalTokens.length > 0 && Array.isArray(article.ngramTokens) && article.ngramTokens.length > 0) {
      return {
        ...article,
        tokens: article.ngramTokens,
        docLength: article.docLength && article.docLength > 0
          ? article.docLength
          : article.ngramTokens.length,
      };
    }

    const stored = await buildStoredTokenSet(`${article.title} ${article.body}`);
    return { ...article, tokens: stored.ngramTokens, docLength: stored.ngramDocLength, ...stored };
  }));

  return { ...result, articles };
}

// ════════════════════════════════════════════════════
//  § 1. 型定義
// ════════════════════════════════════════════════════

export interface CollectorConfig {
  rss:    RSSSource[];
  arxiv:  ArxivSource[];
  github: GitHubSource[];
}

interface RSSSource {
  url:       string;
  label:     string;
  authority: number; // 0–1
}
interface ArxivSource {
  query:     string; // 例: "machine learning"
  maxResults: number;
  authority: number;
}
interface GitHubSource {
  language:  string; // 例: "typescript"
  since:     'daily' | 'weekly' | 'monthly';
  authority: number;
}

export interface CollectResult {
  articles:  Article[];
  errors:    string[];
  stats: {
    rss:    number;
    arxiv:  number;
    github: number;
    total:  number;
    fetchedAt: string;
  };
}

// ════════════════════════════════════════════════════
//  § 2. デフォルト設定
// ════════════════════════════════════════════════════

export const DEFAULT_CONFIG: CollectorConfig = {
  rss: [
    { url: 'https://www.oreilly.com/radar/feed.xml',               label: "O'Reilly Radar",     authority: 0.90 },
    { url: 'https://www.publickey1.jp/atom.xml',                   label: 'Publickey',          authority: 0.85 },
    { url: 'https://zenn.dev/feed',                                label: 'Zenn',               authority: 0.75 },
    { url: 'https://qiita.com/popular-items/feed',                 label: 'Qiita Popular',      authority: 0.70 },
    { url: 'https://techcrunch.com/feed/',                         label: 'TechCrunch',         authority: 0.80 },
    { url: 'https://www.theverge.com/rss/index.xml',               label: 'The Verge',          authority: 0.78 },
    { url: 'https://arxiv.org/rss/cs.AI',                          label: 'arXiv cs.AI RSS',    authority: 0.95 },
    { url: 'https://arxiv.org/rss/cs.LG',                          label: 'arXiv cs.LG RSS',    authority: 0.95 },
    { url: 'https://arxiv.org/rss/cs.CL',                          label: 'arXiv cs.CL RSS',    authority: 0.95 },
  ],
  arxiv: [
    { query: 'large language model',      maxResults: 10, authority: 0.95 },
    { query: 'transformer architecture',  maxResults: 8,  authority: 0.95 },
    { query: 'reinforcement learning',    maxResults: 8,  authority: 0.95 },
  ],
  github: [
    { language: 'typescript', since: 'daily',  authority: 0.80 },
    { language: 'python',     since: 'daily',  authority: 0.80 },
    { language: 'rust',       since: 'weekly', authority: 0.75 },
  ],
};

// ════════════════════════════════════════════════════
//  § 3. ユーティリティ
// ════════════════════════════════════════════════════

function httpsGet(url: string): Promise<string> {
  return safeFetch(url, { maxBytes: 3 * 1024 * 1024, timeoutMs: 10_000,
    allowedContentTypes: /(?:xml|rss|atom|json|text\/plain)/i,
  }).then(response => response.text());
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

// ════════════════════════════════════════════════════
//  § 4. RSS コレクター
// ════════════════════════════════════════════════════

export async function collectRSS(
  sources: RSSSource[],
  errors: string[]
): Promise<Article[]> {
  const parser = new RSSParser();
  const articles: Article[] = [];

  for (const src of sources) {
    try {
      const feed = await parser.parseString(await httpsGet(src.url));
      for (const item of (feed.items ?? []).slice(0, 20)) {
        if (!item.title) continue;
        articles.push({
          id:              stableArticleId('rss', item.guid ? `${src.url}\0${item.guid}` : item.link ? articleIdentityKey(item.link) : `${src.url}\0${item.title}\0${item.content ?? item.summary ?? ''}`),
          title:           item.title,
          body:            stripHtml(item.contentSnippet ?? item.content ?? item.summary ?? ''),
          publishedAt:     new Date(item.isoDate ?? item.pubDate ?? NaN),
          sourceAuthority: src.authority,
          url:             item.link ?? '',
          source:          `rss:${src.label}`,
          bodyKind:        'excerpt',
        });
      }
      console.log(`  [RSS] ${src.label}: ${feed.items?.length ?? 0} 件`);
    } catch (e) {
      const msg = `RSS(${src.label}): ${(e as Error).message}`;
      errors.push(msg);
      console.warn('  ⚠', msg);
    }
  }
  return articles;
}

// ════════════════════════════════════════════════════
//  § 5. arXiv コレクター（Atom API）
// ════════════════════════════════════════════════════

export async function collectArxiv(
  sources: ArxivSource[],
  errors: string[]
): Promise<Article[]> {
  const articles: Article[] = [];

  for (const src of sources) {
    try {
      const q   = encodeURIComponent(src.query);
      const url = `https://export.arxiv.org/api/query?search_query=all:${q}&start=0&max_results=${src.maxResults}&sortBy=submittedDate&sortOrder=descending`;
      const xml = await httpsGet(url);

      // Atom XML を簡易パース（外部パーサー不使用）
      const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/g) ?? [];
      for (const entry of entries) {
        const title   = (entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/\s+/g, ' ').trim();
        const summary = (entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '').replace(/\s+/g, ' ').trim();
        const link    = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? '';
        const pubRaw  = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() ?? '';
        const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)]
          .map(m => m[1].trim()).join(', ');

        if (!title) continue;
        articles.push({
          id:              stableArticleId('arxiv', link.replace(/^http:/, 'https:') || `${title}\0${summary}`),
          title,
          body:            `${summary} [Authors: ${authors}]`,
          publishedAt:     new Date(pubRaw || NaN),
          sourceAuthority: src.authority,
          url:             link,
          source:          `arxiv:${src.query}`,
          bodyKind:        'excerpt',
        });
      }
      console.log(`  [arXiv] "${src.query}": ${entries.length} 件`);
    } catch (e) {
      const msg = `arXiv(${src.query}): ${(e as Error).message}`;
      errors.push(msg);
      console.warn('  ⚠', msg);
    }
  }
  return articles;
}

// ════════════════════════════════════════════════════
//  § 6. GitHub トレンド コレクター
//       公式APIはトレンドエンドポイントなし → ghtrending非公式APIを使用
//       または GitHub Search API (認証なしで60req/h)
// ════════════════════════════════════════════════════

export async function collectGitHub(
  sources: GitHubSource[],
  errors: string[]
): Promise<Article[]> {
  const articles: Article[] = [];

  for (const src of sources) {
    try {
      // GitHub Search API: 直近N日でスターが多いリポジトリを取得
      const days = src.since === 'daily' ? 1 : src.since === 'weekly' ? 7 : 30;
      const from = new Date(Date.now() - days * 86_400_000).toISOString().split('T')[0];
      const q    = encodeURIComponent(`language:${src.language} created:>=${from}`);
      const url  = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=15`;

      const json = await httpsGet(url);
      const data = JSON.parse(json) as {
        items?: Array<{
          id: number;
          full_name: string;
          description: string | null;
          html_url: string;
          stargazers_count: number;
          created_at: string;
          topics?: string[];
          language: string | null;
        }>
      };

      for (const repo of data.items ?? []) {
        const desc = repo.description ?? '';
        const topics = (repo.topics ?? []).join(', ');
        articles.push({
          id:              `github_${repo.id}`,
          title:           `[GitHub] ${repo.full_name}`,
          body:            `${desc} Topics: ${topics} Stars: ${repo.stargazers_count} Language: ${repo.language ?? 'unknown'}`,
          publishedAt:     new Date(repo.created_at),
          sourceAuthority: src.authority,
          url:             repo.html_url,
          source:          `github:${src.language}`,
          bodyKind:        'excerpt',
        });
      }
      console.log(`  [GitHub] ${src.language}/${src.since}: ${data.items?.length ?? 0} 件`);
    } catch (e) {
      const msg = `GitHub(${src.language}): ${(e as Error).message}`;
      errors.push(msg);
      console.warn('  ⚠', msg);
    }
  }
  return articles;
}

// ════════════════════════════════════════════════════
//  § 7. メイン収集関数（全ソースを並列実行）
// ════════════════════════════════════════════════════

export async function collectAll(
  config: CollectorConfig = DEFAULT_CONFIG
): Promise<CollectResult> {
  console.log('\n🔄 収集開始...');
  const errors: string[] = [];

  const [rssArticles, arxivArticles, githubArticles] = await Promise.all([
    collectRSS(config.rss, errors),
    collectArxiv(config.arxiv, errors),
    collectGitHub(config.github, errors),
  ]);

  const articles = [...rssArticles, ...arxivArticles, ...githubArticles];
  const result: CollectResult = {
    articles,
    errors,
    stats: {
      rss:    rssArticles.length,
      arxiv:  arxivArticles.length,
      github: githubArticles.length,
      total:  articles.length,
      fetchedAt: new Date().toISOString(),
    },
  };

  console.log(`✓ 収集完了: RSS=${result.stats.rss} arXiv=${result.stats.arxiv} GitHub=${result.stats.github} 合計=${result.stats.total}`);
  const indexedResult = await ensureArticleTokens(result);
  saveArticles(indexedResult);
  if (errors.length) console.warn(`⚠ エラー ${errors.length} 件:`, errors);
  // Return canonical persisted IDs, including aliases matched to legacy articles.
  return { ...indexedResult, articles: indexedResult.articles.map(article => getArticleById(article.id) ?? article) };
}

// ════════════════════════════════════════════════════
//  § 8. Cron スケジューラー
// ════════════════════════════════════════════════════

export interface SchedulerOptions {
  /** cron式 デフォルト: 30分ごと */
  cronExpr?:  string;
  config?:    CollectorConfig;
  getConfig?: () => CollectorConfig;
  collect?: (config: CollectorConfig) => Promise<CollectResult>;
  onError?: (error: unknown) => void;
  onCollect?: (result: CollectResult) => void;
}

export function startScheduler(opts: SchedulerOptions = {}): () => void {
  const expr     = opts.cronExpr  ?? '*/30 * * * *'; // 30分ごと
  const config   = opts.config    ?? DEFAULT_CONFIG;
  const callback = opts.onCollect ?? (() => {});

  console.log(`\n⏰ スケジューラー起動: "${expr}"`);

  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try { callback(await (opts.collect ?? collectAll)(opts.getConfig?.() ?? config)); }
    catch (error) { (opts.onError ?? console.error)(error); }
    finally { running = false; }
  };
  const task = cron.schedule(expr, run);

  // 起動直後に1回実行
  void run();

  return () => { stopped = true; task.stop(); };
}
