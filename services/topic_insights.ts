/**
 * Answers for broad questions that keyword search cannot answer by itself (no AI, just counting):
 * - trend: words that appear in many more collected articles lately than before ("今の傾向")
 * - overview: the results split by the words they share ("全体像")
 * Representative articles are listed with every topic, so each claim can be checked by reading them.
 */
import { GENERIC_TERMS } from './query_analysis.js';
import { tokenizeNouns } from '../bm25_engine.js';

export type InsightArticle = { id: string; title: string; url?: string | null; publishedAt: string | null; tokens: string[] };
export type Topic = { term: string; count: number; before?: number; articles: Array<{ id: string; title: string; url: string | null; publishedAt: string | null }> };

const HIRAGANA_ONLY = /^[぀-ゟ]+$/u;
const NUMBER_LIKE = /^[\d.,:%\-/]+$/;
const STOP = new Set([
  'する', 'ある', 'いる', 'なる', 'できる', 'れる', 'られる', 'こと', 'もの', 'ため', 'よう', 'さん', 'これ', 'それ',
  // words in almost every technical title: they do not name a topic
  '発表', '公開', '開発', '利用', '活用', '機能', '対応', '紹介', '解説', '使用', '実装', '検証', '取り組み', 'リリース', '正式', '登場', '提供', '発売',
  '追加', '改善', '向け', '版', '新', '最新', '社内', '自動', '基盤', '生成', '設計', '評価', '分析', '参加', '開催', 'イベント', 'レポート', '習慣', '理由', '方法', '話', 'ユーザー', 'サービス', 'システム', 'エンジニア', '企業', '会社', '日本', '年', '月', '日',
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'using', 'your', 'how', 'what', 'why', 'are', 'was', 'you', 'our', 'can', 'new', 'not', 'all', 'more',
  'its', 'has', 'have', 'will', 'just', 'now', 'out', 'get', 'got', 'one', 'two', 'about', 'after', 'before', 'over', 'than', 'when', 'while', 'where', 'which',
  'based', 'via', 'towards', 'toward', 'through', 'without', 'within', 'across', 'make', 'makes', 'made', 'use', 'uses', 'used', 'first', 'best', 'like', 'here',
  'they', 'their', 'there', 'these', 'those', 'some', 'most', 'much', 'many', 'only', 'also', 'even', 'still', 'way', 'ways', 'want', 'wants', 'says', 'say',
  'github', 'type', 'language', 'model', 'models', 'paper', 'study', 'approach', 'system', 'systems', 'data', 'learning', 'large',
]);

/** A word that can name a topic: not generic, not a function word, not a number, at least 2 characters (3 for Latin). */
export function topicWord(term: string): boolean {
  if (!/\p{L}/u.test(term) || /[()[\]{}<>"'`,:;!?]/.test(term)) return false;
  if (!term || STOP.has(term) || GENERIC_TERMS.has(term) || HIRAGANA_ONLY.test(term) || NUMBER_LIKE.test(term)) return false;
  return /^[a-z0-9.+#-]+$/i.test(term) ? term.length >= 3 : Array.from(term).length >= 2;
}

function brief(article: InsightArticle) { return { id: article.id, title: article.title, url: article.url ?? null, publishedAt: article.publishedAt }; }
const newestFirst = (a: InsightArticle, b: InsightArticle) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? ''));

/** Words in many more articles of the last `days` days than before (per article, so busy weeks do not dominate). */
export function trendTopics(articles: InsightArticle[], options: { now?: number; days?: number; limit?: number } = {}): { topics: Topic[]; recentCount: number; olderCount: number; compared: boolean; days: number } {
  const days = options.days ?? 30;
  const since = (options.now ?? Date.now()) - days * 86_400_000;
  const recent = articles.filter(article => article.publishedAt && Date.parse(article.publishedAt) >= since);
  const older = articles.filter(article => !recent.includes(article));
  const df = (list: InsightArticle[]) => {
    const counts = new Map<string, InsightArticle[]>();
    for (const article of list) for (const term of new Set(article.tokens.filter(topicWord))) counts.set(term, [...(counts.get(term) ?? []), article]);
    return counts;
  };
  const recentDf = df(recent);
  const olderDf = df(older);
  // With few older articles there is nothing to compare with: then it is "frequent lately", not "rising".
  const compared = older.length >= 20;
  const scored = [...recentDf.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([term, list]) => {
      const before = olderDf.get(term)?.length ?? 0;
      const lift = (list.length / Math.max(1, recent.length)) / ((before + 1) / (older.length + 1));
      return { term, list, before, score: compared ? list.length * Math.log(1 + lift) : list.length };
    })
    .sort((a, b) => b.score - a.score || b.list.length - a.list.length);
  return {
    topics: dedupe(scored).slice(0, options.limit ?? 8).map(({ term, list, before }) => ({ term, count: list.length, before, articles: [...list].sort(newestFirst).slice(0, 3).map(brief) })),
    recentCount: recent.length,
    olderCount: older.length,
    compared,
    days,
  };
}

/** Words that mostly name the same articles as a better one already chosen are dropped (Claude / Claude Code). */
function dedupe<T extends { term: string; list: InsightArticle[] }>(items: T[]): T[] {
  const chosen: T[] = [];
  for (const item of items) {
    const ids = new Set(item.list.map(article => article.id));
    const overlaps = chosen.some(other => {
      const shared = other.list.filter(article => ids.has(article.id)).length;
      return shared / Math.min(ids.size, other.list.length) >= 0.8;
    });
    if (!overlaps) chosen.push(item);
  }
  return chosen;
}

/** The results grouped by the words they share (beyond the words searched for). Each article in one group. */
export function overviewTopics(articles: InsightArticle[], searched: string[], limit = 6): { topics: Topic[]; rest: Array<{ id: string; title: string; url: string | null; publishedAt: string | null }> } {
  const skip = new Set(searched.map(term => term.toLowerCase()));
  const counts = new Map<string, InsightArticle[]>();
  for (const article of articles) for (const term of new Set(article.tokens.filter(term => topicWord(term) && !skip.has(term)))) counts.set(term, [...(counts.get(term) ?? []), article]);
  const left = new Set(articles.map(article => article.id));
  const topics: Topic[] = [];
  while (topics.length < limit) {
    let best: [string, InsightArticle[]] | null = null;
    for (const [term, list] of counts) {
      const open = list.filter(article => left.has(article.id));
      if (open.length >= 2 && open.length < articles.length && (!best || open.length > best[1].length)) best = [term, open];
    }
    if (!best) break;
    for (const article of best[1]) left.delete(article.id);
    topics.push({ term: best[0], count: best[1].length, articles: best[1].sort(newestFirst).slice(0, 5).map(brief) });
  }
  return { topics, rest: articles.filter(article => left.has(article.id)).map(brief) };
}

const titleCache = new Map<string, string[]>();
/** Topic words of a title: Latin words (names such as Rust, MCP) and nouns. Titles name their topic; bodies wander. */
export async function titleTerms(title: string): Promise<string[]> {
  const cached = titleCache.get(title);
  if (cached) return cached;
  const latin = (title.match(/[A-Za-z][A-Za-z0-9.+#-]{1,}/g) ?? []).map(word => word.toLowerCase().replace(/[.-]+$/, ''));
  const nouns = await tokenizeNouns(title.replace(/[A-Za-z][A-Za-z0-9.+#-]{1,}/g, ' '));
  const terms = [...new Set([...latin, ...nouns])].filter(topicWord);
  if (titleCache.size > 20_000) titleCache.clear();
  titleCache.set(title, terms);
  return terms;
}
