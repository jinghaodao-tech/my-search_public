/**
 * Demo mode (DEMO_MODE=true): a public instance for trying the app (e.g. hackathon judges).
 *
 * - On a fresh database it puts in sample data: three short articles written for the demo,
 *   a sample PDF with printed page numbers, and two cards with memos and quotes.
 *   (Free hosting has no persistent disk, so every restart starts again from this sample.)
 * - The sample documents live under the reserved host "demo.my-search.invalid" and are
 *   served from files in demo/, so the demo works without fetching anything from outside.
 * - No personal data, and no third-party text: all sample text was written for the demo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Article } from '../bm25_engine.js';
import type { CollectResult } from '../collector.js';
import { saveArticlesToDb } from '../repositories/articles_repository.js';
import { saveReaderText } from '../repositories/reader_texts_repository.js';
import { composeReaderCardBody, extractReadable, readPdf, type ReadableArticle } from './reader_service.js';
import { logger } from '../utils/logger.js';

export const DEMO_HOST = 'demo.my-search.invalid';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO_DIR = path.join(ROOT, 'demo');

export function isDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.DEMO_MODE ?? '').trim().toLowerCase() === 'true';
}

type DemoDocument = { file: string; kind: 'html' | 'pdf'; title: string; summary: string; daysAgo: number };

export const DEMO_DOCUMENTS: Record<string, DemoDocument> = {
  '/reading-notes': { file: 'articles/reading-notes.html', kind: 'html', title: '読みながらメモを取るための三つの習慣', summary: '引用と自分の考えを分ける、出典はその場で記録する、表にして比べる。', daysAgo: 1 },
  '/search-reproducibility': { file: 'articles/search-reproducibility.html', kind: 'html', title: '検索結果が毎回変わることの問題', summary: '同じ条件なら同じ順位が返る検索は、確かめられる調べ物の土台になる。', daysAgo: 2 },
  '/citation-pages': { file: 'articles/citation-pages.html', kind: 'html', title: '引用にページ番号を付ける理由', summary: 'ページ番号、一字一句、孫引きの回避。引用の三つの作法。', daysAgo: 3 },
  '/sample-paper.pdf': { file: 'sample-paper.pdf', kind: 'pdf', title: '調べ物の記録を確かめられる形で残す（見本論文PDF）', summary: '引用・出典・ページの三つをそろえる記録の方法。表紙つき、印刷ページ41〜44。', daysAgo: 4 },
};

/** Search preset shown first in demo mode: words that the sample documents contain. */
export const DEMO_SEARCH_MODE = {
  label: '見本を探す',
  description: 'デモ用：見本の記事とPDFに合う検索語です。自由に書き換えて試せます。',
  k1: 1.2,
  b: 0.75,
  lambda: 0,
  contextBonus: 0,
  morphologicalWeight: 0.5,
  ngramWeight: 0.5,
  keywords: [
    { term: '引用', weight: 1.5, synonyms: ['出典'] },
    { term: 'ページ', weight: 1.2, synonyms: ['ページ番号'] },
    { term: 'メモ', weight: 1.2, synonyms: ['記録'] },
  ],
};

export function demoUrl(pathname: string): string {
  return `https://${DEMO_HOST}${pathname}`;
}

/** A sample document by URL (only in demo mode), or null for any other URL. */
export async function readDemoDocument(rawUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<ReadableArticle | null> {
  if (!isDemoMode(env)) return null;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.hostname !== DEMO_HOST) return null;
  const doc = DEMO_DOCUMENTS[url.pathname];
  if (!doc) return null;
  const file = path.join(DEMO_DIR, doc.file);
  if (doc.kind === 'pdf') {
    return readPdf(new Uint8Array(fs.readFileSync(file)), { url: url.toString(), fileName: path.basename(doc.file) });
  }
  return extractReadable(fs.readFileSync(file, 'utf8'), url.toString());
}

type SeedContext = {
  getCards: () => unknown[];
  loadArticles: () => CollectResult | null;
  createCard: (fields: { title: string; body: string; url?: string; tags: string[]; type: 'article' }) => Promise<{ id: string }>;
  setCachedArticles: (value: CollectResult | null) => void;
};

function findIndex(paragraphs: string[], startsWith: string): number {
  const index = paragraphs.findIndex(paragraph => paragraph.startsWith(startsWith));
  if (index < 0) throw new Error(`demo seed: paragraph not found: ${startsWith}`);
  return index;
}

/** Put the sample data into an empty database. Does nothing when there is any card or article already. */
export async function seedDemoData(ctx: SeedContext): Promise<boolean> {
  if (ctx.getCards().length > 0 || (ctx.loadArticles()?.articles.length ?? 0) > 0) return false;
  const now = Date.now();

  // Collected articles (search results / candidates)
  const articles: Article[] = [];
  for (const [pathname, doc] of Object.entries(DEMO_DOCUMENTS)) {
    const article = await readDemoDocument(demoUrl(pathname), { ...process.env, DEMO_MODE: 'true' });
    if (!article) continue;
    const text = article.paragraphs.filter(paragraph => !paragraph.startsWith('[[page:')).join('\n');
    articles.push({
      id: `demo-${pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`,
      title: doc.title,
      body: text.slice(0, 2000),
      summary: doc.summary,
      url: demoUrl(pathname),
      source: '見本ブログ（デモ）',
      sourceAuthority: 0.7,
      publishedAt: new Date(now - doc.daysAgo * 86_400_000),
      tags: ['デモ'],
    });
  }
  saveArticlesToDb(articles);
  ctx.setCachedArticles(ctx.loadArticles());

  // Card 1: an article read with quotes and a comparison table
  const notes = (await readDemoDocument(demoUrl('/reading-notes'), { ...process.env, DEMO_MODE: 'true' }))!;
  const q1 = findIndex(notes.paragraphs, 'メモの中で、原文の言葉と');
  const q2 = findIndex(notes.paragraphs, 'タイトル、著者、URL');
  const memo1 = [
    '> 原文から写した部分は必ず引用符でくくり、自分の考えは別の行に書く。 [¶' + (q1 + 1) + ']',
    '',
    'このアプリでは「選択を引用」で引用と出典が自動でそろう。',
    '',
    '| 主張 | 根拠（本文の引用） | 自分の考え |',
    '| --- | --- | --- |',
    `| 出典はその場で残す | 「タイトル、著者、URL、ページ番号は、読んでいるその場で記録しておく。」[¶${q2 + 1}] | PDFは印刷ページで記録する |`,
  ].join('\n');
  const card1 = await ctx.createCard({
    title: notes.title,
    body: composeReaderCardBody({ memo: memo1, source: { title: notes.title, url: notes.url, byline: '見本 一郎（架空）', siteName: notes.siteName, fetchedAt: notes.fetchedAt, year: '2025' }, paragraphs: notes.paragraphs }),
    url: notes.url ?? undefined,
    tags: ['デモ', 'メモの取り方'],
    type: 'article',
  });
  saveReaderText(card1.id, notes.paragraphs);

  // Card 2: the sample PDF, quotes with printed pages (one of them crosses nothing, one is a quote of another work)
  const paper = (await readDemoDocument(demoUrl('/sample-paper.pdf'), { ...process.env, DEMO_MODE: 'true' }))!;
  const p1 = findIndex(paper.paragraphs, '特にページは見落とされやすい');
  const memo2 = [
    `> 引用で示すべきなのは印刷されたページである。 [¶${p1 + 1}|p. 42]`,
    '',
    'PDFの1枚目は表紙なので、印刷ページは2枚目が p. 41。アプリが紙面の番号から推定している。',
  ].join('\n');
  const card2 = await ctx.createCard({
    title: paper.title,
    body: composeReaderCardBody({ memo: memo2, source: { title: paper.title, url: paper.url, byline: '見本 太郎（架空）', siteName: '見本紀要', fetchedAt: paper.fetchedAt, year: '2025', fileName: 'sample-paper.pdf' }, paragraphs: paper.paragraphs }),
    url: paper.url ?? undefined,
    tags: ['デモ', 'PDF', '引用'],
    type: 'article',
  });
  saveReaderText(card2.id, paper.paragraphs);

  logger.info({ event: 'demo_seeded', articles: articles.length, cards: 2 }, 'demo data seeded');
  return true;
}
