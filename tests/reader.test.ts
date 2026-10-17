import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';
import { saveArticlesToDb } from '../repositories/articles_repository.js';
import {
  CARD_BODY_LIMIT,
  ReaderError,
  assertFetchableUrl,
  composeReaderCardBody,
  decodeHtml,
  extractReadable,
  fetchReadable,
  parseReaderCardBody,
} from '../services/reader_service.js';

const ARTICLE_HTML = `<!doctype html><html><head><title>BM25 を手で調整しない検索 - Example Blog</title>
<meta property="og:site_name" content="Example Blog"></head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<script>window.tracking = true;</script>
<article>
  <h1>BM25 を手で調整しない検索</h1>
  <p class="byline">by Taro Yamada</p>
  <p>検索の質はパラメーターの調整で大きく変わる。しかし毎回スライダーを動かすのは面倒で、結局使われなくなる。</p>
  <p>この記事では、その時の目的を起点に設定を作る方法を考える。履歴から学ぶ方法は、欲しいものに連続性がない場合に外れやすい。</p>
  <ul><li><p>再現性：同じ設定なら同じ結果になる。</p></li><li>費用：AI を呼ばないのでトークンを使わない。</li></ul>
  <p>まとめると、透明な設定を毎回作ることが鍵になる。読み手は、なぜその順位になったかを確かめられる。</p>
</article>
<footer>© Example Blog</footer></body></html>`;

describe('reader: extraction (no network, no AI)', () => {
  it('extracts title and article paragraphs, dropping navigation and scripts', () => {
    const article = extractReadable(ARTICLE_HTML, 'https://blog.example.com/post', '2026-10-15T12:00:00.000Z');
    expect(article.title).toContain('BM25 を手で調整しない検索');
    expect(article.siteName).toBe('Example Blog');
    const text = article.paragraphs.join('\n');
    expect(text).toContain('毎回スライダーを動かすのは面倒');
    expect(text).toContain('再現性：同じ設定なら同じ結果になる。');
    expect(text).not.toContain('window.tracking');
    expect(text).not.toContain('About');
    // nested <li><p> must not be duplicated
    expect(article.paragraphs.filter(p => p.includes('再現性')).length).toBe(1);
  });

  it('is deterministic: the same HTML gives the same paragraphs', () => {
    const a = extractReadable(ARTICLE_HTML, 'https://blog.example.com/post', '2026-10-15T12:00:00.000Z');
    const b = extractReadable(ARTICLE_HTML, 'https://blog.example.com/post', '2026-10-15T12:00:00.000Z');
    expect(b).toEqual(a);
  });

  it('rejects local and non-http URLs before fetching', () => {
    for (const bad of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://192.168.1.10/', 'http://10.0.0.1/', 'file:///etc/passwd', 'not a url']) {
      expect(() => assertFetchableUrl(bad)).toThrow(ReaderError);
    }
    expect(assertFetchableUrl('https://zenn.dev/some/article').hostname).toBe('zenn.dev');
  });

  it('fetches through an injected fetch, reads PDFs and refuses other types', async () => {
    const htmlFetch = (async () => new Response(ARTICLE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as typeof fetch;
    const article = await fetchReadable('https://blog.example.com/post', htmlFetch);
    expect(article.paragraphs.length).toBeGreaterThan(2);
    // a PDF URL is read as a PDF (a broken one is refused as unreadable, not as the wrong type)
    const pdfFetch = (async () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } })) as typeof fetch;
    await expect(fetchReadable('https://blog.example.com/file.pdf', pdfFetch)).rejects.toMatchObject({ status: 422 });
    const zipFetch = (async () => new Response('PK', { status: 200, headers: { 'content-type': 'application/zip' } })) as typeof fetch;
    await expect(fetchReadable('https://blog.example.com/file.zip', zipFetch)).rejects.toMatchObject({ status: 415 });
  });
});

describe('reader: card body', () => {
  const source = { title: 'T', url: 'https://blog.example.com/post', byline: 'Taro', siteName: 'Example Blog', fetchedAt: '2026-10-15T12:00:00.000Z' };

  it('keeps memo, source, and the copied text together', () => {
    const body = composeReaderCardBody({ memo: '透明な設定が鍵', source, paragraphs: ['段落1', '段落2'] });
    expect(body).toMatch(/^## メモ\n\n透明な設定が鍵/);
    expect(body).toContain('- URL: https://blog.example.com/post');
    expect(body).toContain('- 取得日時: 2026-10-15T12:00:00.000Z');
    expect(body).toContain('段落1\n\n段落2');
  });

  it('cuts long text to the card body limit and says so', () => {
    const body = composeReaderCardBody({ memo: 'm', source, paragraphs: ['あ'.repeat(50_000)] });
    expect(body.length).toBeLessThanOrEqual(CARD_BODY_LIMIT);
    expect(body).toContain('（以下省略：本文は全50000文字');
  });
});

describe('reader: API', () => {
  it('rejects private addresses with 400', async () => {
    const response = await request(app).post('/api/reader/extract').send({ url: 'http://127.0.0.1:3000/' });
    expect(response.status).toBe(400);
  });

  it('saves a read article as a card with memo and full text', async () => {
    const response = await request(app).post('/api/reader/save').send({
      url: 'https://blog.example.com/reader-save', title: 'Reader save test', siteName: 'Example Blog', byline: null,
      fetchedAt: '2026-10-15T12:00:00.000Z', paragraphs: ['本文の一段落目', '本文の二段落目'], memo: '読みながら書いたメモ', tags: ['reader'],
    });
    expect(response.status).toBe(201);
    expect(response.body.card.type).toBe('article');
    expect(response.body.card.body).toContain('読みながら書いたメモ');
    expect(response.body.card.body).toContain('本文の二段落目');
    expect(response.body.candidate).toBeNull();
  });

  it('saving from a candidate also marks the candidate as saved_as_card', async () => {
    const id = `reader-candidate-${Date.now()}`;
    saveArticlesToDb([{ id, title: 'Reader candidate', body: 'RSS snippet only', url: `https://blog.example.com/${id}`, publishedAt: new Date('2026-10-01T00:00:00.000Z'), sourceAuthority: 0.8, summary: '', tags: [] }]);
    const response = await request(app).post('/api/reader/save').send({
      url: `https://blog.example.com/${id}`, title: 'Reader candidate', fetchedAt: '2026-10-15T12:00:00.000Z',
      paragraphs: ['候補の全文'], memo: 'メモ', candidateId: id,
    });
    expect(response.status).toBe(201);
    expect(response.body.candidate.status).toBe('saved_as_card');
    expect(response.body.card.body).toContain('候補の全文');
    const again = await request(app).post('/api/reader/save').send({
      url: `https://blog.example.com/${id}`, title: 'Reader candidate', fetchedAt: '2026-10-15T12:00:00.000Z', paragraphs: ['x'], candidateId: id,
    });
    expect(again.status).toBe(409);
  });
});

// Aozora Bunko style page encoded in Shift_JIS, with ruby readings.
const SJIS_HTML = Buffer.from('3c68746d6c3e3c686561643e3c6d65746120687474702d65717569763d22436f6e74656e742d547970652220636f6e74656e743d22746578742f68746d6c3b636861727365743d53686966745f4a4953223e3c7469746c653e8ce1947982cd944c82c582a082e93c2f7469746c653e3c2f686561643e3c626f64793e3c64697620636c6173733d226d61696e5f74657874223e3c703e8ce1947982cd3c727562793e3c72623e944c3c2f72623e3c72703e81693c2f72703e3c72743e82cb82b13c2f72743e3c72703e816a3c2f72703e3c2f727562793e82c582a082e9814296bc914f82cd82dc82be96b382a2814282c782b182c590b682ea82bd82a982c682f182c68ca9939682aa82c282a982ca814289bd82c582e0949688c382a282b682df82b682df82b582bd8f8a82c5836a8383815b836a8383815b8b8382a282c482a282bd8e9682be82af82cd8b4c89af82b582c482a282e981423c2f703e3c703e8ce1947982cd82b182b182c58e6e82df82c4906c8ad482c682a282a482e082cc82f08ca982bd814282b582a982e082a082c682c595b782ad82c682bb82ea82cd8f9190b682c682a282a4906c8ad4928682c588ea94d4e0d688ab82c88eed91b082c582a082c182bd82bb82a482be81423c2f703e3c2f6469763e3c2f626f64793e3c2f68746d6c3e', 'hex');

describe('reader: encodings, ruby, images (feedback 2026-10-15)', () => {
  it('decodes Shift_JIS pages using the meta charset (no mojibake)', () => {
    const html = decodeHtml(new Uint8Array(SJIS_HTML), 'text/html');
    expect(html).toContain('吾輩は');
    expect(html).not.toContain('\ufffd');
  });

  it('prefers the Content-Type charset and falls back to UTF-8 for unknown labels', () => {
    expect(decodeHtml(new Uint8Array(SJIS_HTML), 'text/html; charset=Shift_JIS')).toContain('名前はまだ無い');
    expect(decodeHtml(new TextEncoder().encode('<p>こんにちは</p>'), 'text/html; charset=x-unknown')).toContain('こんにちは');
  });

  it('keeps ruby base text without the reading glued in', async () => {
    const sjisFetch = (async () => new Response(SJIS_HTML, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const article = await fetchReadable('https://www.aozora.gr.jp/cards/000148/files/789_14547.html', sjisFetch);
    const text = article.paragraphs.join('');
    expect(text).toContain('吾輩は猫である。名前はまだ無い。');
    expect(text).not.toContain('ねこ');
  });

  it('keeps images as Markdown links to the original, in reading order', () => {
    const html = `<html><body><article><h1>Images</h1><p>前の段落です。説明のための十分な長さの文章をここに置いておきます。読みやすさの判定のために。</p>
      <p><img src="/images/diagram.png" alt="構成図"></p><p>後の段落です。こちらも十分な長さの文章をここに置いておきます。読みやすさの判定のために。</p>
      <img src="data:image/png;base64,AAAA" alt="inline"></article></body></html>`;
    const article = extractReadable(html, 'https://zenn.dev/someone/articles/abc');
    const imageAt = article.paragraphs.findIndex(p => p.startsWith('!['));
    expect(article.paragraphs[imageAt]).toBe('![構成図](https://zenn.dev/images/diagram.png)');
    expect(article.paragraphs[imageAt - 1]).toContain('前の段落');
    expect(article.paragraphs[imageAt + 1]).toContain('後の段落');
    expect(article.paragraphs.some(p => p.includes('data:'))).toBe(false);
  });
});

describe('reader: inline character images', () => {
  it('keeps Aozora gaiji as alt text inside the sentence', () => {
    const html = `<html><body><div class="main_text"><p>彼は<img src="../../../gaiji/1-15/1-15-56.png" alt="※(「土へん＋竒」、第3水準1-15-56)" class="gaiji">を越えた。ここに十分な長さの本文を置いて、読みやすさの判定が通るようにしておく。さらに文を足しておく。</p>
      <p>次の段落にも十分な長さの本文を置いて、読みやすさの判定が通るようにしておく。さらに文を足しておく。</p></div></body></html>`;
    const article = extractReadable(html, 'https://www.aozora.gr.jp/cards/000148/files/794_14946.html');
    expect(article.paragraphs.some(p => p.startsWith('!['))).toBe(false);
    expect(article.paragraphs.join('')).toContain('彼は※(「土へん＋竒」、第3水準1-15-56)を越えた。');
  });
});

describe('reader: editing existing cards', () => {
  const source = { title: '記事', url: 'https://blog.example.com/a', byline: null, siteName: 'Example', fetchedAt: '2026-10-15T12:00:00.000Z' };

  it('parses a reader card back into memo, source and text (round trip)', () => {
    const body = composeReaderCardBody({ memo: '一行目\n\n二行目', source, paragraphs: ['段落A', '![図](https://blog.example.com/x.png)', '段落B'] });
    const parsed = parseReaderCardBody(body);
    expect(parsed.isReaderFormat).toBe(true);
    expect(parsed.memo).toBe('一行目\n\n二行目');
    expect(parsed.source.url).toBe('https://blog.example.com/a');
    expect(parsed.source.siteName).toBe('Example');
    expect(parsed.paragraphs).toEqual(['段落A', '![図](https://blog.example.com/x.png)', '段落B']);
    expect(composeReaderCardBody({ memo: parsed.memo, source, paragraphs: parsed.paragraphs })).toBe(body);
  });

  it('treats any other card body as memo only', () => {
    const parsed = parseReaderCardBody('ふつうのメモ');
    expect(parsed.isReaderFormat).toBe(false);
    expect(parsed.memo).toBe('ふつうのメモ');
    expect(parsed.paragraphs).toEqual([]);
  });

  it('opens a card in the reader and saves edits back to the same card', async () => {
    const created = await request(app).post('/api/reader/save').send({
      url: 'https://blog.example.com/edit-me', title: 'Edit me', fetchedAt: '2026-10-15T12:00:00.000Z', paragraphs: ['元の本文'], memo: '最初のメモ', tags: ['a'],
    });
    const id = created.body.card.id;
    const opened = await request(app).get(`/api/reader/cards/${id}`);
    expect(opened.status).toBe(200);
    expect(opened.body.memo).toBe('最初のメモ');
    expect(opened.body.paragraphs).toEqual(['元の本文']);
    const updated = await request(app).put(`/api/reader/cards/${id}`).send({
      title: opened.body.title, url: opened.body.url, fetchedAt: opened.body.fetchedAt, paragraphs: opened.body.paragraphs, memo: '書き足したメモ', tags: ['a', 'b'],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.id).toBe(id);
    expect(updated.body.body).toContain('書き足したメモ');
    expect(updated.body.body).toContain('元の本文');
    expect(updated.body.tags).toEqual(expect.arrayContaining(['a', 'b']));
    expect((await request(app).get('/api/reader/cards/does-not-exist')).status).toBe(404);
  });
});
