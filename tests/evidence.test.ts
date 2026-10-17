import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';
import {
  EVIDENCE_MAX_ROWS,
  buildEvidencePrompt,
  buildEvidenceTable,
  chunkSources,
  cleanQuote,
  formatLocation,
  isLongQuote,
  parseProposedRows,
  verifyRows,
  type EvidenceSource,
} from '../services/evidence_service.js';
import { composeReaderCardBody } from '../services/reader_service.js';

const SOURCES: EvidenceSource[] = [
  {
    id: 'a',
    title: '検索の記事',
    paragraphs: [
      '検索の質はパラメーターの調整で大きく変わる。',
      '![図](https://example.com/fig.png)',
      '再現性：同じ設定なら同じ結果になる。AI を呼ばないのでトークンを使わない。',
    ],
  },
  {
    id: 'b',
    title: 'AI検索の記事',
    paragraphs: ['生成AIの検索は質問の意味を理解できるが、毎回答えが変わることがある。'],
  },
];

describe('evidence: deterministic check of AI-proposed quotes', () => {
  it('keeps only quotes that exist in the text, and finds the paragraph itself', () => {
    const result = verifyRows([
      { claim: '設定が同じなら結果も同じ', quote: '同じ設定なら同じ結果になる。', source: 'S1' },
      { claim: '捏造', quote: 'BM25は常にAIより正確である。', source: 'S1' },
      { claim: '短い', quote: '検索', source: 'S1' },
      { claim: '', quote: '検索の質は', source: 'S1' },
    ], SOURCES);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ claim: '設定が同じなら結果も同じ', quote: '同じ設定なら同じ結果になる。', sourceId: 'a', sourceTitle: '検索の記事', paragraphIndex: 2, location: null, secondary: false, long: false });
    expect(result.rejected.map(row => row.reason)).toEqual(['not_found', 'too_short', 'invalid']);
  });

  it('ignores whitespace / full-width differences and wrapping quote marks, and the source the AI named if it is wrong', () => {
    const result = verifyRows([
      { claim: '意味', quote: '「生成ＡＩの検索は 質問の意味を\n理解できる」', source: 'S1' },
    ], SOURCES);
    expect(result.rows[0]).toMatchObject({ sourceId: 'b', paragraphIndex: 0 });
    // the wording put into the memo is the source's, not the model's
    expect(result.rows[0].quote).toBe('生成AIの検索は質問の意味を理解できる');
  });

  it('drops duplicates and caps the number of rows', () => {
    const many = Array.from({ length: 20 }, () => ({ claim: 'x', quote: '検索の質はパラメーターの調整', source: 'S1' }));
    expect(verifyRows(many, SOURCES).rows).toHaveLength(1);
    const distinct = Array.from({ length: 20 }, (_, i) => ({ claim: `c${i}`, quote: '検索の質はパラメーターの調整で大きく変わる。'.slice(0, 9 + (i % 12)), source: 'S1' }));
    expect(verifyRows(distinct, SOURCES).rows.length).toBeLessThanOrEqual(EVIDENCE_MAX_ROWS);
  });

  it('parses the model answer defensively', () => {
    expect(parseProposedRows('```json\n[{"claim":"a","quote":"b","source":"S1","secondary":true}]\n```')).toEqual([{ claim: 'a', quote: 'b', source: 'S1', secondary: true }]);
    expect(parseProposedRows('すみません、見つかりません')).toEqual([]);
    expect(parseProposedRows('[{"claim": 1}, null, "x"]')).toEqual([{ claim: '1', quote: '', source: '', secondary: false }]);
    expect(cleanQuote('「引用です…」')).toBe('引用です');
  });

  it('numbers paragraphs in the prompt and leaves images out', () => {
    const chunks = chunkSources(SOURCES);
    expect(chunks).toHaveLength(1);
    const prompt = buildEvidencePrompt('再現性を知りたい', chunks[0]);
    expect(prompt).toContain('目的: 再現性を知りたい');
    expect(prompt).toContain('[S1-3] 再現性：同じ設定なら同じ結果になる。');
    expect(prompt).toContain('[S2-1] 生成AIの検索は');
    expect(prompt).not.toContain('fig.png');
  });

  it('runs the model through an injected function, then verifies', async () => {
    const answer = JSON.stringify([
      { claim: 'トークンを使わない', quote: 'AI を呼ばないのでトークンを使わない。', source: 'S1' },
      { claim: '作り話', quote: '存在しない一節がここにある。', source: 'S2' },
    ]);
    let seenPrompt = '';
    const result = await buildEvidenceTable('費用', SOURCES, async prompt => { seenPrompt = prompt; return answer; });
    expect(seenPrompt).toContain('目的: 費用');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].paragraphIndex).toBe(2);
    expect(result.rejected).toHaveLength(1);
  });
});

describe('evidence: PDF pages and quotation rules', () => {
  const PDF: EvidenceSource = {
    id: 'pdf',
    title: '効果量の論文',
    paragraphs: [
      '[[page:1|]]',
      '表紙',
      '[[page:2|57]]',
      '小野寺・菱村 (2005) は，「いずれ数年のうちに効果サイズを無視した研究報告はできなくなると考えられる。」(p.135) としている。',
      'もし，外国語教育学が人文系の一分野として他の研究領域と同じような水準の',
      '[[page:3|58]]',
      '研究が求められるのならば，現状は変えていかなければならない。',
      '(1) とりたて詞とは、文中の種々の要素－これを自者と呼ぶことにする－をとりた',
      'て、これに対する他の要素との論理的関係を示す語である。（沼田 (1986), p.108）',
    ],
  };

  it('gives the printed page, and pp. for a quote that crosses a page', () => {
    const { rows } = verifyRows([
      { claim: '一頁', quote: 'もし，外国語教育学が人文系の一分野', source: 'S1' },
      { claim: 'またぎ', quote: '同じような水準の研究が求められるのならば', source: 'S1' },
    ], [PDF]);
    expect(rows[0]).toMatchObject({ location: 'p. 57', sheetStart: 2, pageStart: '57' });
    expect(rows[1]).toMatchObject({ location: 'pp. 57–58', sheetStart: 2, sheetEnd: 3, paragraphIndex: 4, endParagraphIndex: 6 });
    expect(rows[1].quote).toBe('同じような水準の研究が求められるのならば');
  });

  it('flags a passage that is itself a quotation of another work (secondary citation)', () => {
    const { rows } = verifyRows([
      { claim: '孫引き', quote: 'いずれ数年のうちに効果サイズを無視した研究報告はできなくなる', source: 'S1' },
      { claim: '例文の引用', quote: 'とりたて詞とは、文中の種々の要素－これを自者と呼ぶことにする－をとりたて、これに対する他の要素', source: 'S1' },
      { claim: '著者の文', quote: '現状は変えていかなければならない', source: 'S1' },
      { claim: 'AIの指摘', quote: '研究が求められるのならば', source: 'S1', secondary: true },
    ], [PDF]);
    expect(rows.map(row => row.secondary)).toEqual([true, true, false, true]);
  });

  it('formats locations and long quotes', () => {
    expect(formatLocation({ sheetStart: null, sheetEnd: null, pageStart: null, pageEnd: null })).toBeNull();
    expect(formatLocation({ sheetStart: 3, sheetEnd: 3, pageStart: null, pageEnd: null })).toBe('PDF 3枚目');
    expect(formatLocation({ sheetStart: 3, sheetEnd: 4, pageStart: null, pageEnd: null })).toBe('PDF 3–4枚目');
    expect(isLongQuote('あ'.repeat(201))).toBe(true);
    expect(isLongQuote('あ'.repeat(200))).toBe(false);
    expect(isLongQuote(Array(40).fill('word').join(' '))).toBe(true);
  });

  it('sends a long document in several calls and checks every row against the whole text', async () => {
    const book: EvidenceSource = { id: 'book', title: '本', paragraphs: Array.from({ length: 30 }, (_, i) => `第${i}段落の本文です。${'内容'.repeat(2000)}`) };
    const calls: string[] = [];
    const result = await buildEvidenceTable('内容', [book], async prompt => {
      calls.push(prompt);
      return calls.length === 2 ? JSON.stringify([{ claim: 'c', quote: '第12段落の本文です。', source: 'S1' }]) : '[]';
    });
    expect(calls.length).toBeGreaterThan(1);
    expect(result.chunks).toBe(calls.length);
    expect(result.rows[0]).toMatchObject({ paragraphIndex: 12 });
  });
});

describe('evidence API (mock AI)', () => {
  it('returns checked rows for an article', async () => {
    const res = await request(app).post('/api/reader/evidence').send({
      purpose: '再現性 について',
      article: { title: '記事', url: 'https://example.com/a', paragraphs: SOURCES[0].paragraphs },
    });
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThan(0);
    for (const row of res.body.rows) expect(SOURCES[0].paragraphs[row.paragraphIndex]).toContain(row.quote);
    expect(res.body.sources).toEqual([{ id: 'article', title: '記事', url: 'https://example.com/a' }]);
  });

  it('reads saved cards (copy of the text) as sources', async () => {
    const body = composeReaderCardBody({
      memo: '',
      source: { title: '保存した記事', url: 'https://example.com/b', byline: null, siteName: null, fetchedAt: '2026-10-15T00:00:00.000Z' },
      paragraphs: SOURCES[1].paragraphs,
    });
    const created = await request(app).post('/api/cards').send({ title: '保存した記事', body, url: 'https://example.com/b', tags: [], type: 'article' });
    expect(created.status).toBe(201);
    const id = created.body.id ?? created.body.card?.id;
    const res = await request(app).post('/api/reader/evidence').send({ purpose: '意味 理解', cardIds: [id] });
    expect(res.status).toBe(200);
    expect(res.body.rows[0]).toMatchObject({ sourceId: id, paragraphIndex: 0 });
  });

  it('validates input', async () => {
    expect((await request(app).post('/api/reader/evidence').send({ purpose: 'x', article: { title: 't', paragraphs: ['p'] } })).status).toBe(400);
    expect((await request(app).post('/api/reader/evidence').send({ purpose: '目的です' })).status).toBe(400);
    expect((await request(app).post('/api/reader/evidence').send({ purpose: '目的です', cardIds: ['missing-card'] })).status).toBe(404);
  });
});

describe('evidence rows into the memo table (browser script)', () => {
  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'public/js/memo_table.js'), 'utf8'), sandbox);
  const appendEvidenceRows = sandbox.appendEvidenceRows as (rows: string[][] | null, evidence: unknown[]) => { rows: string[][]; added: number };
  const evidence = [{ claim: '同じなら同じ', quote: '同じ設定なら同じ結果', paragraphIndex: 2 }];

  it('starts an evidence table when there is none', () => {
    const result = appendEvidenceRows(null, evidence);
    expect(result.rows).toEqual([['主張', '根拠（本文の引用）', '自分の考え'], ['同じなら同じ', '「同じ設定なら同じ結果」[¶3]', '']]);
    expect(result.added).toBe(1);
  });

  it('appends to an existing table, drops empty rows and skips a quote already there', () => {
    const first = appendEvidenceRows([['A', 'B'], ['', ''], ['x', 'y']], evidence);
    expect(first.rows).toEqual([['A', 'B'], ['x', 'y'], ['同じなら同じ', '「同じ設定なら同じ結果」[¶3]']]);
    const again = appendEvidenceRows(first.rows, evidence);
    expect(again.added).toBe(0);
    expect(again.rows).toHaveLength(3);
  });
});
