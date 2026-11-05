import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const web = [{ value: 'web:qiita', label: 'Qiita' }, { value: 'web:hatena', label: 'Hatena' }, { value: 'web:arxiv', label: 'arXiv' }];
const feed = (count: number) => ({ value: 'rss:Blog', kind: 'feed', label: 'Blog', count });

function screen(collected = [feed(0)], cards = 0, stored?: unknown) {
  const dom = new JSDOM('<div id="search-targets"></div><div id="bm25-stats"></div><div id="results"></div><div id="search-collected"></div><div id="search-cards"></div><div id="search-web"></div><input id="search-terms" value="SQLite locks"><button id="bm25-run-btn"></button><input type="checkbox" class="refind-study-consent" id="refind-study-consent"><span class="refind-study-status" id="refind-study-status"></span><div id="refind-study-review"></div>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  if (stored) w.localStorage.setItem('searchTargets', JSON.stringify(stored));
  w.eval(`var bm25Result = null, bm25Keywords = [{term:'SQLite'}], lastSearchTerms = [], discoverLastResult = { results: ['old'] };
    var api = {postCalls: [], get: async (path) => path === '/api/refind-study/cards' ? [{id:'gold-a',title:'First saved note'},{id:'gold-b',title:'Second saved note'}] : (${JSON.stringify({ collected, cards: { value: 'cards', label: 'Memo', count: cards }, web })}), post: async function(path, body) { this.postCalls.push({path,body}); return {category:body.category}; }};
    function formatApiError(error) { return String(error); }
    function resultButton(label, action) { const button = document.createElement('button'); button.textContent = label; button.onclick = action; return button; }
    function openSourceModal() {}
    function toast() {}
    ${fs.readFileSync('public/js/search_screen_ui.js', 'utf8').replace(/document.addEventListener\('DOMContentLoaded',[\s\S]*?\n}\);/, '')}
    window.firstSearch = { loadSearchTargets, loadRefindStudyControl, selectedSearchTargets, rememberTargetChoice, renderNoResultStatus, runSearchScreen,
      renderReview: async () => { refindStudyAvailable = true; activeRefindStudy = {sid:'study-session',startedMs:Date.now(),searchCount:1}; document.getElementById('refind-study-consent').checked = true; return renderRefindStudyReview(); },
      recordResponse: payload => recordRefindInteraction(payload),
      posts: () => api.postCalls, state: () => ({cardSearchResult, discoverLastResult}) };`);
  w.confirm = () => true;
  return { dom, w, ui: w.firstSearch };
}

describe('first search with an empty local corpus', () => {
  it('selects Web rather than configured but empty feeds on first visit', async () => {
    const { dom, w, ui } = screen();
    try {
      await ui.loadSearchTargets();
      expect(ui.selectedSearchTargets()).toEqual(['web:qiita', 'web:hatena']);
      expect(w.document.querySelector('#search-targets')!.textContent).toContain('まだ記事が集まっていません');
    } finally { dom.window.close(); }
  });

  it('selects collected articles when present, without silently sending the query to Web', async () => {
    const { dom, ui } = screen([feed(2)]);
    try {
      await ui.loadSearchTargets();
      expect(ui.selectedSearchTargets()).toEqual(['rss:Blog']);
    } finally { dom.window.close(); }
  });

  it('preserves an explicitly saved empty selection, including after reload', async () => {
    const { dom, ui } = screen([feed(0)], 0, { known: ['rss:Blog', 'cards', ...web.map(item => item.value)], selected: [] });
    try {
      await ui.loadSearchTargets();
      expect(ui.selectedSearchTargets()).toEqual([]);
      await ui.loadSearchTargets();
      expect(ui.selectedSearchTargets()).toEqual([]);
    } finally { dom.window.close(); }
  });

  it('does not overlook existing cards when the collected corpus is empty', async () => {
    const { dom, ui } = screen([feed(0)], 3);
    try {
      await ui.loadSearchTargets();
      expect(ui.selectedSearchTargets()).toContain('cards');
    } finally { dom.window.close(); }
  });

  it('distinguishes an empty corpus from a query with no matches and offers explicit Web search', async () => {
    const { dom, w, ui } = screen([feed(0)], 0, { known: ['rss:Blog'], selected: ['rss:Blog'] });
    try {
      await ui.loadSearchTargets();
      const host = w.document.getElementById('results')!;
      ui.renderNoResultStatus(host, { totalCount: 0, searchedCount: 0 });
      expect(host.querySelector('.no-result-title')!.textContent).toBe('収集済みの記事がまだありません');
      const run = vi.fn();
      w.runSearchScreen = run;
      [...host.querySelectorAll('button')].find(button => button.textContent === 'Webで探す')!.click();
      expect(run).toHaveBeenCalledWith({ webOnly: true });
      expect(ui.selectedSearchTargets()).toEqual(['rss:Blog', 'web:qiita', 'web:hatena']);
      host.replaceChildren();
      ui.renderNoResultStatus(host, { totalCount: 2, searchedCount: 2 });
      expect(host.querySelector('.no-result-title')!.textContent).toBe('収集済みの記事からは見つかりませんでした');
    } finally { dom.window.close(); }
  });

  it('clears stale Web results when searching only local sources', async () => {
    const { dom, w, ui } = screen([feed(2)]);
    try {
      await ui.loadSearchTargets();
      w.ensureKeywordsFor = async () => {};
      w.runBM25 = async () => {};
      w.renderBroadQuestion = () => {};
      w.renderIntentAnswer = async () => {};
      await ui.runSearchScreen();
      expect(ui.state().discoverLastResult).toBeNull();
    } finally { dom.window.close(); }
  });

  it('renders the post-search purpose selector and submits multiple human-confirmed gold cards', async () => {
    const { dom, w, ui } = screen();
    try {
      await ui.renderReview();
      const review = w.document.getElementById('refind-study-review')!;
      const category = review.querySelector<HTMLSelectElement>('#refind-study-category')!;
      const targets = review.querySelector<HTMLSelectElement>('#refind-study-gold-cards')!;
      const finish = [...review.querySelectorAll('button')].find(button => button.textContent === '検索を終了して判定を記録')!;
      expect(category).not.toBeNull();
      expect(targets.disabled).toBe(true);
      category.value = 'memory';
      category.dispatchEvent(new w.Event('change'));
      expect(targets.disabled).toBe(false);
      targets.options[0]!.selected = true;
      targets.options[1]!.selected = true;
      await finish.onclick!(new w.MouseEvent('click') as unknown as PointerEvent);
      expect(ui.posts()[0].body).toMatchObject({ category: 'memory', goldIds: ['gold-a', 'gold-b'], unknown: false, humanChecked: true });
      expect(review.textContent).toContain('自然な再発見としてローカル記録を保存しました');
    } finally { dom.window.close(); }
  });

  it('captures no search without consent and locks the query before recording the first response after consent', async () => {
    const { dom, w, ui } = screen([feed(0)], 2, { known: ['rss:Blog', 'cards', ...web.map(item => item.value)], selected: ['cards'] });
    try {
      await ui.loadSearchTargets();
      w.api.get = async (path: string) => path === '/api/refind-study/status'
        ? { available: true, preregistered: true, buildMatches: true, plannedN: 300, collected: 0, sealed: false }
        : path === '/api/refind-study/cards' ? [{ id: 'gold-a', title: 'Synthetic saved card' }] : {};
      const postCalls: Array<{path: string; body: Record<string, unknown>}> = [];
      w.api.postCalls = postCalls;
      w.api.post = async (path: string, body: Record<string, unknown>) => {
        postCalls.push({ path, body });
        return path === '/api/refind-study/sessions' ? { sid: 'study-session' } : { ok: true };
      };
      await ui.loadRefindStudyControl();
      w.ensureKeywordsFor = async () => {};
      w.renderBroadQuestion = () => {};
      w.renderIntentAnswer = async () => {};
      w.runCardSearch = async () => ui.recordResponse({ action: 'search_response', top10: ['gold-a'],
        candidateIdsBeforeRerank: ['gold-a'], actualEngine: 'fixture-engine', fallbackUsed: false, httpStatus: 200, latencyMs: 12 });

      await ui.runSearchScreen();
      expect(ui.posts().some((call: {path: string; body: Record<string, unknown>}) => call.path === '/api/refind-study/sessions')).toBe(false);

      const consent = w.document.querySelector<HTMLInputElement>('#refind-study-consent')!;
      consent.checked = true;
      consent.dispatchEvent(new w.Event('change'));
      w.document.querySelector<HTMLInputElement>('#search-terms')!.value = 'remembered synthetic topic';
      await ui.runSearchScreen();

      expect(ui.posts().find((call: {path: string; body: Record<string, unknown>}) => call.path === '/api/refind-study/sessions')?.body).toMatchObject({
        query: 'remembered synthetic topic', consent: true,
      });
      expect(ui.posts().find((call: {path: string; body: Record<string, unknown>}) => call.path.endsWith('/interactions'))?.body).toMatchObject({
        action: 'search_response', top10: ['gold-a'], candidateIdsBeforeRerank: ['gold-a'],
        actualEngine: 'fixture-engine', httpStatus: 200,
      });
    } finally { dom.window.close(); }
  });
});
