import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/js/memo_render.js is a classic browser script; load its pure functions into a sandbox.
const sandbox: Record<string, unknown> = {};
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'public/js/memo_render.js'), 'utf8'), sandbox);
const formatTextQuote = sandbox.formatTextQuote as (text: string, index?: number, location?: string) => string;
const formatCellQuote = sandbox.formatCellQuote as (text: string, index?: number, location?: string) => string;
const findQuoteMarkerAt = sandbox.findQuoteMarkerAt as (text: string, caret: number) => number | null;
const findMarkerIn = sandbox.findMarkerIn as (text: string) => number | null;
const renderMemoHtml = sandbox.renderMemoHtml as (memo: string) => string;
const memoPreviewText = sandbox.memoPreviewText as (body: string) => string | null;
const splitReaderBody = sandbox.splitReaderBody as (body: string) => { memo: string; sourceLines: string[] } | null;

describe('quote markers', () => {
  it('formats text and cell quotes with a 1-based paragraph marker', () => {
    expect(formatTextQuote('一行目\n\n二行目', 4)).toBe('> 一行目\n> 二行目 [¶5]');
    expect(formatCellQuote('同じ設定なら\n同じ結果', 0)).toBe('「同じ設定なら 同じ結果」[¶1]');
    expect(formatTextQuote('印なし')).toBe('> 印なし');
  });

  it('finds the marker of the quote under the caret, even on an earlier line of the quote', () => {
    const memo = 'メモ\n> 一行目\n> 二行目 [¶5]\n\n> 別の引用 [¶9]';
    expect(findQuoteMarkerAt(memo, memo.indexOf('一行目'))).toBe(4);
    expect(findQuoteMarkerAt(memo, memo.indexOf('二行目'))).toBe(4);
    expect(findQuoteMarkerAt(memo, memo.indexOf('別の'))).toBe(8);
    expect(findQuoteMarkerAt(memo, 1)).toBeNull(); // plain memo line: nothing happens
  });

  it('reads a marker from a table cell', () => {
    expect(findMarkerIn('メモ 「引用」[¶12]')).toBe(11);
    expect(findMarkerIn('ただの文')).toBeNull();
  });
});

describe('memo rendering for the card detail panel', () => {
  it('renders paragraphs, quotes and tables, escaping all text', () => {
    const html = renderMemoHtml('考え<b>た</b>こと\n\n> 引用 [¶3]\n\n| 方法 | 利点 |\n| --- | --- |\n| BM25 | 再現性\\|安い |');
    expect(html).toContain('<p>考え&lt;b&gt;た&lt;/b&gt;こと</p>');
    expect(html).toContain('<blockquote class="memo-view-quote">引用 <span class="quote-marker">¶3</span></blockquote>');
    expect(html).toContain('<th>方法</th><th>利点</th>');
    expect(html).toContain('<td>BM25</td><td>再現性|安い</td>');
    expect(html).not.toContain('<b>');
  });

  it('splits a reader card body into memo and source lines', () => {
    const body = '## メモ\n\nメモ本文\n\n## 出典\n\n- タイトル: T\n- URL: https://e.com\n\n## 本文（取得時点のコピー・私的利用）\n\n本文';
    expect(splitReaderBody(body)).toEqual({ memo: 'メモ本文', sourceLines: ['- タイトル: T', '- URL: https://e.com'] });
    expect(splitReaderBody('普通のメモ')).toBeNull();
  });
});

describe('card list preview', () => {
  it('shows only the memo text, without quote marks, markers or table syntax', () => {
    const body = '## メモ\n\n> 引用文 [¶3]\n考え\n\n| 方法 | 利点 |\n| --- | --- |\n| BM25 | 安い |\n\n## 出典\n\n- URL: https://e.com\n\n## 本文（取得時点のコピー・私的利用）\n\n本文';
    expect(memoPreviewText(body)).toBe('引用文 考え 方法 / 利点 BM25 / 安い');
    expect(memoPreviewText('普通のメモ')).toBeNull();
  });
});

describe('PDF pages and citations (browser helpers)', () => {
  const pageAt = sandbox.pageAt as (p: string[], i: number) => { sheet: number; label: string | null } | null;
  const locationBetween = sandbox.locationBetween as (p: string[], a: number, b?: number) => string | null;
  const relabelParagraphs = sandbox.relabelParagraphs as (p: string[], sheet: number, printed: number) => string[];
  const formatCitedQuote = sandbox.formatCitedQuote as (x: { quote: string; author?: string | null; year?: string | null; location?: string | null }) => string;
  const paragraphs = ['[[page:1|]]', '表紙', '[[page:2|27]]', '本文A', '本文B', '[[page:3|28]]', '本文C'];

  it('finds the page of a paragraph and formats p. / pp. / PDF sheet', () => {
    expect(pageAt(paragraphs, 4)).toEqual({ sheet: 2, label: '27' });
    expect(locationBetween(paragraphs, 3)).toBe('p. 27');
    expect(locationBetween(paragraphs, 4, 6)).toBe('pp. 27–28');
    expect(locationBetween(paragraphs, 1)).toBe('PDF 1枚目');
    expect(locationBetween(['ただの記事'], 0)).toBeNull();
  });

  it('relabels pages from a user correction', () => {
    expect(relabelParagraphs(paragraphs, 2, 101).filter(p => p.startsWith('[['))).toEqual(['[[page:1|]]', '[[page:2|101]]', '[[page:3|102]]']);
  });

  it('puts the page into the quote marker, finds and renders it', () => {
    expect(formatTextQuote('引用文', 3, 'p. 27')).toBe('> 引用文 [¶4|p. 27]');
    expect(formatCellQuote('引用文', 3, 'pp. 27–28')).toBe('「引用文」[¶4|pp. 27–28]');
    expect(findQuoteMarkerAt('> 引用文 [¶4|p. 27]', 3)).toBe(3);
    expect(findMarkerIn('「引用文」[¶4|PDF 3枚目]')).toBe(3);
    expect(renderMemoHtml('> 引用文 [¶4|p. 27]')).toContain('<span class="quote-marker">¶4 · p. 27</span>');
    expect(memoPreviewText('## メモ\n\n> 引用文 [¶4|p. 27]\n\n## 出典\n\n- URL: x\n\n## 本文（取得時点のコピー・私的利用）\n\n本文')).toBe('引用文');
  });

  it('formats a quote with its citation, by language', () => {
    expect(formatCitedQuote({ quote: '「まで」は否定文では普通使われない', author: '寺村', year: '1991', location: 'p. 122' }))
      .toBe('「『まで』は否定文では普通使われない」（寺村，1991，p. 122）');
    expect(formatCitedQuote({ quote: 'it is almost always "necessary" to include some index', author: 'Mizumoto & Takeuchi', year: '2008', location: 'p. 57' }))
      .toBe('“it is almost always ‘necessary’ to include some index” (Mizumoto & Takeuchi, 2008, p. 57)');
    expect(formatCitedQuote({ quote: '記事の一文', author: null, year: null, location: null })).toBe('「記事の一文」（著者未入力，年未入力）');
  });
});
