import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import request from 'supertest';
import { app } from './helpers.js';

it('restores search conditions, reviews ranked candidates and advances after reader save', async () => {
  await request(app).post('/api/collect').send({ fixture: 'portfolio-demo' }).expect(200);
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.confirm = () => true;
  w.fetch = (async (url: string, options: { method?: string; body?: string } = {}) => {
    if (url === '/api/reader/extract') {
      const { url: articleUrl } = JSON.parse(options.body!);
      return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ url: articleUrl, title: 'Reader fixture', fetchedAt: new Date().toISOString(), paragraphs: ['<script>unsafe</script> Portfolio body'], byline: null, siteName: 'fixture' }) };
    }
    const method = (options.method || 'GET').toLowerCase() as 'get' | 'post' | 'put' | 'delete';
    const response = await request(app)[method](url).send(options.body ? JSON.parse(options.body) : undefined);
    return { ok: response.status < 400, status: response.status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => response.body };
  }) as unknown as typeof w.fetch;
  // Run the actual scripts in one realm, preserving their shared lexical globals.
  const scripts = [...w.document.querySelectorAll('script[src]')].map(script => script.getAttribute('src')!).filter(src => !src.startsWith('vendor/') && !src.includes('/typed/'));
  w.eval(scripts.map(src => fs.readFileSync(`public/${src}`, 'utf8')).join('\n;\n') + '\nwindow.testSearch = { runBM25, loadSavedSearches, saveCurrentSearch, restoreSavedSearch, openSearchArticle, saveReaderCard, nextSearchArticle, changeSearchCandidate, setSimpleSearchTerms, getResult: () => bm25Result };');
  try {
    const workflow = w.testSearch;
    await expect.poll(() => w.document.querySelector('#mode-tabs')!.childElementCount).toBeGreaterThan(0);
    await workflow.loadSavedSearches();
    const input = (id: string) => w.document.getElementById(id) as HTMLInputElement;
    input('saved-search-name').value = '調査の続き';
    workflow.setSimpleSearchTerms('portfolio');
    input('search-excluded').value = 'advertisement';
    await workflow.saveCurrentSearch();
    const saved = (await request(app).get('/api/saved-searches')).body.find((item: { name: string }) => item.name === '調査の続き');
    workflow.setSimpleSearchTerms('wrong');
    await workflow.loadSavedSearches(); workflow.restoreSavedSearch(saved.id);
    expect(input('search-terms').value).toBe('portfolio');
    expect(input('search-excluded').value).toBe('advertisement');
    await workflow.runBM25();
    expect(w.document.getElementById('bm25-stats')!.textContent).toContain('3件');
    expect(w.document.querySelectorAll('.score-card mark').length).toBeGreaterThan(0);
    const results = workflow.getResult().active;
    expect(results.length).toBeGreaterThan(1);
    const id = results[0].article.id;
    await workflow.changeSearchCandidate(id, 'defer');
    expect((await request(app).get(`/api/candidates/${id}`)).body.status).toBe('deferred');
    workflow.openSearchArticle(id);
    await expect.poll(() => w.document.getElementById('reader-article')!.textContent).toContain('Portfolio body');
    expect(w.document.querySelector('#reader-article script')).toBeNull();
    input('reader-memo').value = '自分のメモ';
    await workflow.saveReaderCard();
    expect((await request(app).get(`/api/candidates/${id}`)).body.status).toBe('saved_as_card');
    expect(w.document.getElementById('reader-search-position')!.textContent).toContain('2 /');
    expect(input('search-terms').value).toBe('portfolio');
    // Reopening the search must show saved state and must not offer another card creation.
    await workflow.runBM25();
    const row = w.document.querySelector(`[data-article-id="${id}"]`)!;
    expect(row.textContent).toContain('保存済みメモを読む');
    expect(row.textContent).not.toContain('カードに保存');
  } finally { w.close(); }
}, 20000);

it('groups similar titles without removing comparison articles', () => {
  const dom = new JSDOM('<div id="results"></div>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(fs.readFileSync('public/js/search_workflow_ui.js', 'utf8').replace(/document.addEventListener\('DOMContentLoaded',[\s\S]*?\n}\);/, '') + '\nwindow.group = groupSimilarSearchCards; window.setItems = items => { bm25Result = { active: items }; };');
  w.setItems([{ article: { id: 'a', title: 'SQLite 同時書き込みの制約と実装例' } }, { article: { id: 'b', title: 'SQLite 同時書き込みの制約と実装例 解説' } }, { article: { id: 'c', title: 'TypeScript 型推論' } }]);
  const body = w.document.getElementById('results')!;
  for (const id of ['a', 'b', 'c']) { const card = w.document.createElement('article'); card.dataset.articleId = id; body.append(card); }
  w.group(body);
  expect(body.children.length).toBe(2);
  expect(body.querySelector('details [data-article-id="b"]')).not.toBeNull();
  expect(body.querySelectorAll('article').length).toBe(3);
  dom.window.close();
});
