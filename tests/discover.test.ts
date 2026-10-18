import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';
import {
  PROVIDERS,
  clearDiscoverCache,
  discoverMode,
  protectAlnum,
  restoreAlnum,
  discover,
  fallbackQueries,
  markdownToText,
  mergeHits,
  normalizeUrl,
  parseFeed,
  trustOf,
  type FetchText,
} from '../services/discover_service.js';

const QIITA = JSON.stringify([
  {
    title: 'BM25で全文検索を作る',
    url: 'https://qiita.com/someone/items/abc',
    body: '# はじめに\nBM25 は検索の **定番** です。\n```js\nconst x = 1;\n```\n[リンク](https://example.com) 再現性があります。',
    created_at: '2026-09-01T00:00:00+09:00',
    likes_count: 120,
    stocks_count: 80,
    user: { id: 'someone', name: '' },
    tags: [{ name: '検索' }, { name: 'BM25' }],
  },
]);

const HATENA = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:hatena="http://www.hatena.ne.jp/info/xmlns#">
<item rdf:about="https://zenn.dev/x/articles/bm25">
  <title>BM25 と検索の再現性 &amp; 評価</title>
  <link>https://zenn.dev/x/articles/bm25</link>
  <description>BM25 による検索の再現性について。</description>
  <dc:date>2026-08-01T10:00:00+09:00</dc:date>
  <dc:subject>テクノロジー</dc:subject>
  <hatena:bookmarkcount>350</hatena:bookmarkcount>
</item>
<item rdf:about="https://qiita.com/someone/items/abc">
  <title>BM25で全文検索を作る</title>
  <link>https://qiita.com/someone/items/abc?utm_source=hatena</link>
  <description>短い説明</description>
  <dc:date>2026-09-01T10:00:00+09:00</dc:date>
  <hatena:bookmarkcount>500</hatena:bookmarkcount>
</item>
<item rdf:about="https://example.com/cooking">
  <title>今日の料理</title>
  <link>https://example.com/cooking</link>
  <description>カレーの作り方。</description>
  <dc:date>2026-08-01T10:00:00+09:00</dc:date>
  <hatena:bookmarkcount>3</hatena:bookmarkcount>
</item>
</rdf:RDF>`;

const GITHUB = JSON.stringify({ items: [{ full_name: 'org/bm25-search', html_url: 'https://github.com/org/bm25-search', description: 'A BM25 search engine', stargazers_count: 999, pushed_at: '2026-10-01T00:00:00Z', topics: ['bm25', 'search'], language: 'TypeScript', owner: { login: 'org' } }] });

const ARXIV = `<feed><entry><id>http://arxiv.org/abs/2601.00001v1</id><published>2026-01-01T00:00:00Z</published><title>Revisiting
 BM25</title><summary>We study BM25 ranking and reproducibility.</summary><author><name>A. One</name></author></entry></feed>`;

function fakeFetch(map: Partial<Record<string, string | Error>>, seen: string[] = []): FetchText {
  return async url => {
    seen.push(url);
    const key = Object.keys(map).find(prefix => url.startsWith(prefix));
    const value = key ? map[key] : undefined;
    if (value === undefined) throw new Error('HTTP 404');
    if (value instanceof Error) throw value;
    return value;
  };
}

const ALL = {
  'https://qiita.com/api/v2/items': QIITA,
  'https://b.hatena.ne.jp/q/': HATENA,
  'https://api.github.com/search/repositories': GITHUB,
  'https://export.arxiv.org/api/query': ARXIV,
};

beforeEach(() => clearDiscoverCache());

describe('discover: providers parse their answers', () => {
  it('Qiita: markdown body without code, popularity from likes + stocks', () => {
    const [hit] = PROVIDERS.qiita.parse(QIITA);
    expect(hit).toMatchObject({ title: 'BM25で全文検索を作る', site: 'qiita.com', popularity: 200, author: 'someone', tags: ['検索', 'BM25'] });
    expect(hit.body).not.toContain('const x');
    expect(hit.body).toContain('再現性があります');
  });

  it('Hatena RSS (RDF): entities, bookmark counts, Zenn pages', () => {
    const hits = PROVIDERS.hatena.parse(HATENA);
    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({ title: 'BM25 と検索の再現性 & 評価', site: 'zenn.dev', popularity: 350 });
  });

  it('GitHub and arXiv', () => {
    expect(PROVIDERS.github.parse(GITHUB)[0]).toMatchObject({ title: 'org/bm25-search', popularity: 999, tags: ['bm25', 'search'] });
    expect(PROVIDERS.arxiv.parse(ARXIV)[0]).toMatchObject({ title: 'Revisiting BM25', url: 'https://arxiv.org/abs/2601.00001v1', author: 'A. One' });
    expect(PROVIDERS.arxiv.url('bm25 ranking', 5)).toContain('search_query=all:bm25+AND+all:ranking');
  });

  it('generic RSS 2.0 and Atom feeds', () => {
    const rss = '<rss><channel><item><title>注意喚起</title><link>https://www.example.go.jp/a.html</link><description><![CDATA[<p>脆弱性の情報</p>]]></description><pubDate>Mon, 05 Oct 2026 10:00:00 +0900</pubDate></item></channel></rss>';
    expect(parseFeed(rss, 'https://www.example.go.jp/rss.xml')[0]).toMatchObject({ title: '注意喚起', body: '脆弱性の情報', site: 'example.go.jp', via: 'feed' });
    const atom = '<feed><entry><title>Mars</title><link rel="alternate" href="/news/mars"/><summary>Rover news</summary><updated>2026-10-01T00:00:00Z</updated></entry></feed>';
    expect(parseFeed(atom, 'https://www.example.org/feed')[0]).toMatchObject({ title: 'Mars', url: 'https://www.example.org/news/mars' });
  });

  it('helpers', () => {
    expect(markdownToText('## 見出し\n![図](a.png) `code` text')).toBe('見出し code text');
    expect(normalizeUrl('https://www.Qiita.com/a/?utm_source=x#top')).toBe('qiita.com/a');
  });
});

describe('discover: trust rule and merging', () => {
  it('base by site plus a capped log bonus for popularity', () => {
    expect(trustOf({ site: 'example.com', popularity: 0 })).toMatchObject({ authority: 0.45, popularityBonus: 0 });
    expect(trustOf({ site: 'zenn.dev', popularity: 99 })).toMatchObject({ base: 0.5, popularityBonus: 0.2, authority: 0.7 });
    expect(trustOf({ site: 'www.ipa.go.jp', popularity: 1e9 }).authority).toBe(1);
  });

  it('one entry per page, keeping the longer text and the larger count', () => {
    const merged = mergeHits([...PROVIDERS.qiita.parse(QIITA), ...PROVIDERS.hatena.parse(HATENA)]);
    const qiita = merged.find(hit => hit.site === 'qiita.com')!;
    expect(merged).toHaveLength(3);
    expect(qiita.foundBy).toEqual(['qiita', 'hatena']);
    expect(qiita.body).toContain('再現性があります');
    expect(qiita.popularity).toBe(500);
  });
});

describe('discover: whole run', () => {
  it('searches every source for every query, ranks relevant pages first and explains the score', async () => {
    const seen: string[] = [];
    const out = await discover({ queries: ['BM25 再現性', 'BM25 reproducibility'] }, { fetchText: fakeFetch(ALL, seen), env: {}, sleep: async () => {} });
    // arXiv is English only: the Japanese query is not sent there
    expect(seen).toHaveLength(7);
    expect(seen.filter(url => url.includes('arxiv'))).toHaveLength(1);
    expect(out.querySource).toBe('given');
    expect(out.sources.map(s => [s.id, s.error])).toEqual([['qiita', null], ['hatena', null], ['github', null], ['arxiv', null]]);
    expect(out.results.map(r => r.title)).not.toContain('今日の料理');
    expect(out.results.length).toBeGreaterThanOrEqual(3);
    const top = out.results[0];
    expect(top.breakdown.matchedTerms.length).toBeGreaterThan(0);
    expect(top.score).toBeCloseTo(top.breakdown.relevance * (0.5 + 0.5 * top.breakdown.trust), 3);
    for (let i = 1; i < out.results.length; i++) expect(out.results[i - 1].score).toBeGreaterThanOrEqual(out.results[i].score);
  });

  it('paces arXiv (one request every 3 s) and retries a 429 once', async () => {
    const waits: number[] = [];
    let calls = 0;
    const fetchText: FetchText = async () => { calls += 1; if (calls === 1) throw new Error('HTTP 429'); return ARXIV; };
    const out = await discover({ queries: ['bm25', 'ranking'], sources: ['arxiv'] }, { fetchText, env: {}, sleep: async ms => { waits.push(ms); } });
    expect(waits).toEqual([3100, 3100]);
    expect(calls).toBe(3);
    expect(out.sources[0]).toMatchObject({ count: 2, error: null });
  });

  it('ranks on the same length of text for every source', async () => {
    const longQiita = JSON.stringify([{ title: '長い記事', url: 'https://qiita.com/x/items/long', body: '前置き。'.repeat(400) + 'BM25 再現性', created_at: '2026-09-01T00:00:00+09:00', likes_count: 0, stocks_count: 0, user: { id: 'x' }, tags: [] }]);
    const out = await discover({ queries: ['BM25 再現性'], sources: ['qiita'] }, { fetchText: async () => longQiita, env: {} });
    // the words are only after the first 1500 characters: not counted
    expect(out.results).toHaveLength(0);
  });

  it('keeps going when a source fails, and reports it', async () => {
    const out = await discover({ queries: ['BM25'], sources: ['qiita', 'github'] }, { fetchText: fakeFetch({ ...ALL, 'https://qiita.com/api/v2/items': new Error('HTTP 403') }), env: {} });
    expect(out.sources).toEqual([{ id: 'qiita', label: 'Qiita', count: 0, error: 'HTTP 403' }, { id: 'github', label: 'GitHub', count: 1, error: null }]);
    expect(out.results[0].site).toBe('github.com');
  });

  it('caches answers (rate limits), and sends a token only when one is set', async () => {
    const seen: string[] = [];
    const headersSeen: Record<string, string>[] = [];
    const fetchText: FetchText = async (url, headers) => { seen.push(url); headersSeen.push(headers); return QIITA; };
    await discover({ queries: ['BM25'], sources: ['qiita'] }, { fetchText, env: { QIITA_TOKEN: 't' } });
    await discover({ queries: ['BM25'], sources: ['qiita'] }, { fetchText, env: {} });
    expect(seen).toHaveLength(1);
    expect(headersSeen[0].Authorization).toBe('Bearer t');
  });

  it('without queries, uses the words of the purpose (no AI)', async () => {
    const queries = await fallbackQueries('BM25の再現性について調べたい');
    expect(queries[0]).toContain('bm25');
    expect(queries[0]).toContain('再現');
    const out = await discover({ purpose: 'BM25の再現性について調べたい', sources: ['hatena'] }, { fetchText: fakeFetch(ALL), env: {} });
    expect(out.querySource).toBe('purpose');
    expect(out.results[0].site).toBe('zenn.dev');
  });
});

describe('discover API', () => {
  it('validates input and lists sources', async () => {
    expect((await request(app).post('/api/discover').send({})).status).toBe(400);
    expect((await request(app).post('/api/discover').send({ queries: ['x'], sources: ['google'] })).status).toBe(400);
    expect((await request(app).post('/api/discover').send({ queries: ['x'], feeds: ['http://127.0.0.1/'] })).status).toBe(400);
    const list = await request(app).get('/api/discover/sources');
    expect(list.status).toBe(200);
    expect(list.body.sources.map((s: { id: string }) => s.id)).toEqual(['qiita', 'hatena', 'github', 'arxiv']);
  });
});

describe('discover: ranking keeps the purpose in charge', () => {
  it('BM25 is one word: a text with just "25" in it does not match', async () => {
    const qiita = JSON.stringify([
      { title: '統計の検定 25 例', url: 'https://qiita.com/a/items/1', body: '25 人のデータで検定する。確率分布の話。', created_at: '2026-09-01T00:00:00+09:00', likes_count: 0, stocks_count: 0, user: { id: 'a' }, tags: [] },
      { title: 'BM25 の再現性', url: 'https://qiita.com/a/items/2', body: 'BM25 は同じ設定なら同じ順位を返す。', created_at: '2026-09-01T00:00:00+09:00', likes_count: 0, stocks_count: 0, user: { id: 'a' }, tags: [] },
    ]);
    const out = await discover({ purpose: 'BM25の検索結果が再現できる理由', queries: ['BM25 確率分布'], sources: ['qiita'] }, { fetchText: async () => qiita, env: {} });
    expect(out.results[0].title).toBe('BM25 の再現性');
    expect(out.results[0].breakdown.matchedTerms).toContain('bm25');
    expect(protectAlnum('BM25 と e5-large')).toBe('bmzqczqf と e5-large'.replace('e5', 'ezqf'));
    expect(restoreAlnum('bmzqczqf')).toBe('bm25');
  });

  it('words of the purpose weigh more than the other query words', () => {
    const mode = discoverMode(['BM25 確率分布'], ['bm25', '再現']);
    expect(mode.keywords).toEqual([{ term: 'bmzqczqf', weight: 3, synonyms: [] }, { term: '再現', weight: 2, synonyms: [] }, { term: '確率分布', weight: 1, synonyms: [] }]);
  });
});

describe('discover: purpose coverage', () => {
  it('a page matching only the extra query words sinks below one that covers the purpose', async () => {
    const qiita = JSON.stringify([
      { title: 'BASIC の授業の仕組み', url: 'https://qiita.com/a/items/1', body: '昔のパソコンを再現する。仕組みを説明する。仕組みの図。', created_at: '2026-09-01T00:00:00+09:00', likes_count: 0, stocks_count: 0, user: { id: 'a' }, tags: [] },
      { title: 'BM25 検索の再現性', url: 'https://qiita.com/a/items/2', body: 'BM25 の検索は同じ設定なら再現できる。', created_at: '2026-09-01T00:00:00+09:00', likes_count: 0, stocks_count: 0, user: { id: 'a' }, tags: [] },
    ]);
    const out = await discover({ purpose: 'BM25の検索結果が再現できる理由を知りたい', queries: ['BM25 仕組み'], sources: ['qiita'] }, { fetchText: async () => qiita, env: {} });
    expect(out.results[0].title).toBe('BM25 検索の再現性');
    expect(out.results[0].breakdown.purposeCoverage).toBe(1);
    expect(out.results[1].breakdown.purposeCoverage).toBeLessThan(0.5);
    expect(await fallbackQueries('BM25の検索結果が再現できる理由を知りたい')).toEqual(['bm25 検索 再現', 'bm25 検索']);
  });
});

describe('discover: the specific word of the purpose counts more', () => {
  it('a page with BM25 beats one with only the general Japanese words', async () => {
    const qiita = JSON.stringify([
      { title: 'データ形式で検索を再現する', url: 'https://qiita.com/a/items/1', body: '検索を再現する。検索の再現。検索と再現。', created_at: '2026-09-01T00:00:00+09:00', likes_count: 0, stocks_count: 0, user: { id: 'a' }, tags: [] },
      { title: 'BM25 とベクトルのハイブリッド検索', url: 'https://qiita.com/a/items/2', body: 'BM25 の検索を比べる。', created_at: '2026-09-01T00:00:00+09:00', likes_count: 0, stocks_count: 0, user: { id: 'a' }, tags: [] },
    ]);
    const out = await discover({ purpose: 'BM25の検索結果が再現できる理由を知りたい', queries: ['bm25 検索 再現'], sources: ['qiita'] }, { fetchText: async () => qiita, env: {} });
    expect(out.results[0].title).toBe('BM25 とベクトルのハイブリッド検索');
    expect(out.results[0].breakdown.purposeCoverage).toBeCloseTo(5 / 7, 2);
  });
});

describe('discover: pages without the topic word go down', () => {
  it('shows which key word is missing', async () => {
    const qiita = JSON.stringify([
      { title: '再現と検索', url: 'https://qiita.com/a/items/1', body: '再現 再現 再現 検索 検索 検索 再現 検索 再現。', created_at: '2026-09-01T00:00:00+09:00', likes_count: 0, stocks_count: 0, user: { id: 'a' }, tags: [] },
      { title: 'BM25 を使う', url: 'https://qiita.com/a/items/2', body: 'BM25 の検索。', created_at: '2026-09-01T00:00:00+09:00', likes_count: 0, stocks_count: 0, user: { id: 'a' }, tags: [] },
    ]);
    const out = await discover({ purpose: 'BM25の検索結果が再現できる理由', queries: ['bm25 検索 再現'], sources: ['qiita'] }, { fetchText: async () => qiita, env: {} });
    expect(out.results[0].title).toBe('BM25 を使う');
    expect(out.results[1].breakdown.missingKeyTerms).toEqual(['bm25']);
    expect(out.results[0].breakdown.missingKeyTerms).toEqual([]);
  });
});
