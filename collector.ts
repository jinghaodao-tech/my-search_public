/**
 * collector.ts — データ収集エンジン
 * RSS / arXiv / GitHub を収集して Article[] に正規化する
 *
 * 依存追加: npm install rss-parser node-cron
 */

import RSSParser from 'rss-parser';
import cron      from 'node-cron';
import https     from 'https';
import fs        from 'fs';
import path      from 'path';
import { fileURLToPath } from 'url';
import type { Article } from './bm25_engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 永続化パス ───────────────────────────────────────────────────
// data/ ディレクトリにJSONとして保存
const DATA_DIR      = path.join(__dirname, 'data');
const ARTICLES_FILE = path.join(DATA_DIR, 'articles.json');
const STATS_FILE    = path.join(DATA_DIR, 'stats.json');

export function saveArticles(result: CollectResult): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ARTICLES_FILE, JSON.stringify(result.articles, null, 2), 'utf-8');
  fs.writeFileSync(STATS_FILE,    JSON.stringify(result.stats,    null, 2), 'utf-8');
  console.log(`  💾 保存: ${ARTICLES_FILE} (${result.articles.length}件)`);
}

export function loadArticles(): CollectResult | null {
  try {
    if (!fs.existsSync(ARTICLES_FILE)) return null;
    const articles: Article[] = JSON.parse(fs.readFileSync(ARTICLES_FILE, 'utf-8'))
      .map((a: any) => ({ ...a, publishedAt: new Date(a.publishedAt) }));
    const stats = fs.existsSync(STATS_FILE)
      ? JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'))
      : null;
    console.log(`  📂 読み込み: ${articles.length}件 (${stats?.fetchedAt ?? '不明'})`);
    return { articles, errors: [], stats };
  } catch (e) {
    console.warn('  ⚠ 読み込み失敗:', (e as Error).message);
    return null;
  }
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
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'DigitalCommons/1.0' } }, (res) => {
      // リダイレクト追従
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', (c: string) => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 48);
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
      const feed = await parser.parseURL(src.url);
      for (const item of (feed.items ?? []).slice(0, 20)) {
        if (!item.title) continue;
        articles.push({
          id:              `rss_${slug(src.label)}_${slug(item.title)}`,
          title:           item.title,
          body:            stripHtml(item.contentSnippet ?? item.content ?? item.summary ?? ''),
          publishedAt:     item.pubDate ? new Date(item.pubDate) : new Date(),
          sourceAuthority: src.authority,
          url:             item.link ?? src.url,
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
          id:              `arxiv_${slug(title)}`,
          title,
          body:            `${summary} [Authors: ${authors}]`,
          publishedAt:     pubRaw ? new Date(pubRaw) : new Date(),
          sourceAuthority: src.authority,
          url:             link,
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
  saveArticles(result); // ← data/articles.json に自動保存
  if (errors.length) console.warn(`⚠ エラー ${errors.length} 件:`, errors);
  return result;
}

// ════════════════════════════════════════════════════
//  § 8. Cron スケジューラー
// ════════════════════════════════════════════════════

export interface SchedulerOptions {
  /** cron式 デフォルト: 30分ごと */
  cronExpr?:  string;
  config?:    CollectorConfig;
  onCollect?: (result: CollectResult) => void;
}

export function startScheduler(opts: SchedulerOptions = {}): () => void {
  const expr     = opts.cronExpr  ?? '*/30 * * * *'; // 30分ごと
  const config   = opts.config    ?? DEFAULT_CONFIG;
  const callback = opts.onCollect ?? (() => {});

  console.log(`\n⏰ スケジューラー起動: "${expr}"`);

  const task = cron.schedule(expr, async () => {
    const result = await collectAll(config);
    callback(result);
  });

  // 起動直後に1回実行
  collectAll(config).then(callback);

  return () => task.stop();
}
