import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';
import { composeReaderCardBody, parseReaderCardBody } from '../services/reader_service.js';
import { pickPassagesByWords, verifyRows } from '../services/evidence_service.js';
import { tokenizeMorphological } from '../bm25_engine.js';

type LocalAi = Record<string, (...args: any[]) => any>;

function loadLocalAi(globals: Record<string, unknown> = {}): LocalAi {
  const sandbox: Record<string, unknown> = { ...globals };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'public/js/local_ai.js'), 'utf8'), sandbox);
  return sandbox.localAi as LocalAi;
}

const PARAGRAPHS = [
  '[[page:1|]]',
  'BM25 は検索語の出現回数と文書の長さから点数を付ける。',
  '![図](a.png)',
  '同じ設定なら同じ順位が返るので、検索の再現性が高い。',
  'カレーはスパイスから作ると香りが良い。',
];

describe('local AI (browser script): prompts and parsing', () => {
  const ai = loadLocalAi();

  it('parses queries from JSON or from lines, without duplicates', () => {
    expect(ai.parseQueries('{"queries":["BM25 再現性","bm25 再現性","BM25 reproducibility"]}')).toEqual(['BM25 再現性', 'BM25 reproducibility']);
    expect(ai.parseQueries('1. 検索 再現性\n- 「BM25」 評価')).toEqual(['検索 再現性', 'BM25 評価']);
    expect(ai.buildQueryPrompt('検索の再現性')).toContain('調べたいこと: 検索の再現性');
  });

  it('numbers paragraphs by their real index and leaves page markers and images out', () => {
    const chunks = ai.chunkParagraphs(PARAGRAPHS, 40);
    expect(chunks.map((chunk: Array<{ index: number }>) => chunk.map(item => item.index))).toEqual([[1], [3], [4]]);
    expect(ai.buildPassagePrompt('再現性', chunks[1])).toContain('[4] 同じ設定なら');
    expect(ai.parsePassages('[{"paragraph":4,"quote":"同じ順位が返る","claim":"再現できる"}, {"quote":""}]')).toEqual([{ claim: '再現できる', quote: '同じ順位が返る', source: 'S1' }]);
    expect(ai.parsePassages('ごめんなさい')).toEqual([]);
  });

  it('reports "unavailable" when the browser has no on-device AI', async () => {
    expect(await ai.status()).toEqual({ prompt: 'unavailable', translator: 'unavailable', detector: 'unavailable' });
  });

  it('uses the Prompt API with a JSON schema on a fresh clone', async () => {
    const calls: unknown[] = [];
    const session = {
      clone: async () => ({ prompt: async (text: string, options: unknown) => { calls.push([text, options]); return '{"queries":["BM25 再現性"]}'; }, destroy() { calls.push('destroyed'); } }),
    };
    const fake = loadLocalAi({ LanguageModel: { availability: async () => 'available', create: async () => session } });
    expect(await fake.status()).toMatchObject({ prompt: 'available' });
    expect(await fake.makeQueries('検索の再現性')).toEqual(['BM25 再現性']);
    expect((calls[0] as [string, { responseConstraint: unknown }])[1].responseConstraint).toBeTruthy();
    expect(calls[1]).toBe('destroyed');
  });

  it('translates paragraph by paragraph, aligned, skipping markers, images and Japanese', async () => {
    const fake = loadLocalAi({ Translator: { availability: async () => 'available', create: async () => ({ translate: async (text: string) => `訳:${text}` }) } });
    const progress: number[] = [];
    const out = await fake.translateParagraphs(['[[page:1|]]', 'Hello world.', '![x](a.png)', '日本語の段落', 'Second one.'], { onProgress: (done: number) => progress.push(done) });
    expect(out).toEqual([null, '訳:Hello world.', null, null, '訳:Second one.']);
    expect(progress).toEqual([1, 2]);
    expect(fake.looksEnglish(['This is an English article. '.repeat(20)])).toBe(true);
    expect(fake.looksEnglish(['これは日本語の記事です。BM25 を使う。'.repeat(20)])).toBe(false);
  });
});

describe('local AI: summaries and synonyms (instead of an external AI)', () => {
  it('splits long bodies into chunks without code blocks, images and page markers', () => {
    const ai = loadLocalAi();
    const chunks = ai.summaryChunks('[[page:1|]]\n本文。\n```js\nconst x = 1;\n```\n![図](a.png)\n' + 'あ'.repeat(7000));
    expect(chunks.length).toBe(3);
    expect(chunks[0]).not.toContain('const x');
    expect(chunks[0]).not.toContain('[[page:');
    expect(ai.summaryChunks('').length).toBe(0);
    expect(ai.summaryChunks('い'.repeat(100000)).length).toBe(6);
  });

  it('summarizes a short text in one call and a long one part by part', async () => {
    const prompts: string[] = [];
    const session = { prompt: async (text: string) => { prompts.push(text); return '要約：・一行目\n・二行目'; }, destroy() {} };
    const ai = loadLocalAi({ LanguageModel: { availability: async () => 'available', create: async () => ({ clone: async () => session }) } });
    expect(await ai.summarize('題', '短い本文。')).toBe('一行目\n二行目');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('3行以内');
    prompts.length = 0;
    const progress: number[] = [];
    await ai.summarize('題', 'う'.repeat(6500), { onProgress: (done: number) => progress.push(done) });
    expect(prompts).toHaveLength(4); // 3 parts + 1 summary of the parts
    expect(prompts[0]).toContain('長い記事の一部');
    expect(progress).toEqual([1, 2, 3, 4]);
  });

  it('parses synonyms, dropping the input words and duplicates', () => {
    const ai = loadLocalAi();
    expect(ai.parseExpanded('{"terms":["全文検索","BM25","Okapi","okapi",""]}', ['bm25'])).toEqual(['全文検索', 'Okapi']);
    expect(ai.parseExpanded('ごめんなさい', ['x'])).toEqual([]);
    expect(ai.buildExpandPrompt(['BM25'])).toContain('検索語: ["BM25"]');
  });

  it('splits a broad question into topics (suggestions), dropping the question itself and duplicates', () => {
    const ai = loadLocalAi();
    expect(ai.parseTopics('{"topics":["AI生成コード 品質","ai生成コード 品質","IT業界の問題","「レガシー」 刷新",""]}', 'IT業界の問題')).toEqual(['AI生成コード 品質', 'レガシー 刷新']);
    expect(ai.parseTopics('すみません', 'x')).toEqual([]);
    expect(ai.buildTopicPrompt('今問題になっていること')).toContain('質問: 今問題になっていること');
  });
});

describe('passages without server AI', () => {
  it('picks the sentences sharing the rarest words with the purpose, and they verify', async () => {
    const sources = [{ id: 'a', title: '記事', paragraphs: PARAGRAPHS }];
    const rows = await pickPassagesByWords('検索の再現性', sources, tokenizeMorphological);
    expect(rows[0].quote).toBe('同じ設定なら同じ順位が返るので、検索の再現性が高い。');
    expect(rows.map(row => row.quote)).not.toContain('カレーはスパイスから作ると香りが良い。');
    expect(verifyRows(rows, sources).rows[0]).toMatchObject({ paragraphIndex: 3 });
  });

  it('API: words fallback, and checks rows proposed by the browser AI word for word', async () => {
    const article = { title: '記事', url: 'https://example.com/a', paragraphs: PARAGRAPHS };
    const words = await request(app).post('/api/reader/passages').send({ purpose: '検索の再現性', article });
    expect(words.status).toBe(200);
    expect(words.body.method).toBe('words');
    expect(words.body.rows[0].paragraphIndex).toBe(3);
    const local = await request(app).post('/api/reader/passages').send({
      purpose: '検索の再現性',
      article,
      proposed: [
        { claim: '再現できる', quote: '同じ設定なら同じ順位が返る', source: 'S1' },
        { claim: '作り話', quote: 'BM25 は常に最良である。', source: 'S1' },
      ],
    });
    expect(local.body.method).toBe('local-ai');
    expect(local.body.rows).toHaveLength(1);
    expect(local.body.rejected[0].reason).toBe('not_found');
  });
});

describe('saving a Japanese translation with an English article', () => {
  const paragraphs = ['Search should be reproducible.', 'Same settings, same ranking.'];
  const translation = { from: 'en', to: 'ja', engine: 'chrome-translator', translatedAt: '2026-10-18T00:00:00.000Z', paragraphs: ['検索は再現できるべきだ。', '同じ設定なら同じ順位。'] };

  it('card body: original first, then the translation, and parsing still returns only the original', () => {
    const body = composeReaderCardBody({ memo: 'm', source: { title: 'T', url: 'https://e.com', byline: null, siteName: null, fetchedAt: '2026-10-18T00:00:00.000Z' }, paragraphs, translation });
    expect(body).toContain('- 日本語訳: 機械翻訳（Chrome内蔵の翻訳、en→ja）');
    expect(body).toContain('## 日本語訳（機械翻訳・私的利用）\n\n検索は再現できるべきだ。');
    expect(parseReaderCardBody(body).paragraphs).toEqual(paragraphs);
    const long = composeReaderCardBody({ memo: '', source: { title: 'T', url: null, byline: null, siteName: null, fetchedAt: 'x' }, paragraphs: ['a'.repeat(30000)], translation: { ...translation, paragraphs: ['あ'.repeat(30000)] } });
    expect(long.length).toBeLessThanOrEqual(20000);
    expect(long).toContain('（以下省略：日本語訳は全30000文字');
  });

  it('API: saved, returned when the card is opened, kept on an edit, dropped when the text changes', async () => {
    const saved = await request(app).post('/api/reader/save').send({ title: 'English article', url: 'https://example.com/en', fetchedAt: '2026-10-18T00:00:00.000Z', paragraphs, translation, memo: '' });
    expect(saved.status).toBe(201);
    const id = saved.body.card.id;
    expect(saved.body.card.body).toContain('同じ設定なら同じ順位。');
    const opened = await request(app).get(`/api/reader/cards/${id}`);
    expect(opened.body.translation).toMatchObject({ from: 'en', paragraphs: translation.paragraphs });
    await request(app).put(`/api/reader/cards/${id}`).send({ title: 'English article', paragraphs, memo: 'edited' }).expect(200);
    expect((await request(app).get(`/api/reader/cards/${id}`)).body.translation.paragraphs).toEqual(translation.paragraphs);
    await request(app).put(`/api/reader/cards/${id}`).send({ title: 'English article', paragraphs: [...paragraphs, 'New.'], memo: '' }).expect(200);
    expect((await request(app).get(`/api/reader/cards/${id}`)).body.translation).toBeNull();
    const bad = await request(app).post('/api/reader/save').send({ title: 'x', url: 'https://example.com/x', fetchedAt: '2026-10-18T00:00:00.000Z', paragraphs, translation: { ...translation, paragraphs: ['一つだけ'] } });
    expect(bad.status).toBe(400);
  });
});
