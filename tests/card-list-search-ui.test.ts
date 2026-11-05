import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const appSource = fs.readFileSync('public/app.js', 'utf8');
const loadCardsSource = appSource.slice(
  appSource.indexOf('async function loadCards()'),
  appSource.indexOf('\nasync function loadTags()', appSource.indexOf('async function loadCards()')),
);

function createUiHarness() {
  const dom = new JSDOM('<div id="card-grid"></div>', { url: 'http://localhost/', runScripts: 'outside-only' });
  dom.window.eval(`
    let currentFilter = { tag: 'saved', type: 'article', q: '５億', archived: false };
    let cardLoadSequence = 0;
    let cardListSearchCaptureRequested = false;
    let allCards = [];
    let selectedCards = new Set();
    let bm25Params = { k1: 1.5, b: 0.75 };
    const calls = [];
    const interactions = [];
    let activeRefindStudy = null;
    let searchResponse = { active: [{ article: { id: 'rank-1' } }], belowThreshold: [{ article: { id: 'rank-2' } }], scope: { candidateIdsBeforeRerank: ['candidate-1'], searchMethod: 'fts5-morph', fallbackUsed: false } };
    let searchError = null;
    const api = {
      get: async path => { calls.push({ method: 'GET', path }); return [{ id: 'list' }]; },
      post: async (path, body) => {
        calls.push({ method: 'POST', path, body });
        if (path === '/api/search/terms') return { keywords: [{ term: '5億', weight: 1 }] };
        if (searchError) throw searchError;
        return searchResponse;
      },
    };
    async function beginRefindStudy(query) { activeRefindStudy = { sid: 'session-1', query }; return activeRefindStudy; }
    async function recordRefindInteraction(payload) { interactions.push(payload); }
    async function renderRefindStudyReview(mountId) { interactions.push({ action: 'review', mountId }); }
    function formatApiError(error) { return error.message || 'failed'; }
    function renderCardGrid() {}
    function updateSelectedUI() {}
    function updateBM25SourceInfo() {}
    ${loadCardsSource}
    window.cardListTest = {
      loadCards,
      calls,
      interactions,
      cards: () => allCards,
      setFilter: filter => { currentFilter = filter; },
      setResponse: response => { searchResponse = response; },
      setError: error => { searchError = error; },
      requestCapture: () => { cardListSearchCaptureRequested = true; },
    };
  `);
  return { dom, ui: (dom.window as unknown as { cardListTest: {
    loadCards: () => Promise<void>;
    calls: Array<Record<string, unknown>>;
    interactions: Array<Record<string, unknown>>;
    cards: () => Array<{ id: string }>;
    setFilter: (filter: { tag: string | null; type: string | null; q: string; archived: boolean }) => void;
    setResponse: (response: unknown) => void;
    setError: (error: Error | null) => void;
    requestCapture: () => void;
  } }).cardListTest };
}

describe('saved-card list search UI', () => {
  it('uses local query analysis and ranked search while preserving list filters and rank order', async () => {
    const { dom, ui } = createUiHarness();
    try {
      await ui.loadCards();

      expect(ui.calls.map(call => [call.method, call.path])).toEqual([
        ['POST', '/api/search/terms'], ['POST', '/api/cards/search'],
      ]);
      expect(ui.calls[1]?.body).toMatchObject({
        config: { keywords: [{ term: '5億', weight: 1 }] },
        options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 500 },
        cardFilters: { tag: 'saved', type: 'article', archived: false },
      });
      expect(ui.cards().map(card => card.id)).toEqual(['rank-1', 'rank-2']);
    } finally { dom.window.close(); }
  });

  it('keeps the plain list endpoint for an empty search', async () => {
    const { dom, ui } = createUiHarness();
    try {
      ui.setFilter({ tag: null, type: null, q: '  ', archived: true });
      await ui.loadCards();

      expect(ui.calls).toEqual([{ method: 'GET', path: '/api/cards?archived=true' }]);
      expect(ui.cards()).toEqual([{ id: 'list' }]);
    } finally { dom.window.close(); }
  });

  it('records the ordered first response and opens human adjudication for an opted-in list search', async () => {
    const { dom, ui } = createUiHarness();
    try {
      ui.requestCapture();
      await ui.loadCards();

      expect(ui.interactions).toEqual([
        { action: 'search_response', top10: ['rank-1', 'rank-2'], candidateIdsBeforeRerank: ['candidate-1'],
          actualEngine: 'fts5-morph', fallbackUsed: false, httpStatus: 200, latencyMs: expect.any(Number) },
        { action: 'review', mountId: 'refind-study-review-list' },
      ]);
    } finally { dom.window.close(); }
  });

  it('records a list-search API failure as a result instead of dropping the task', async () => {
    const { dom, ui } = createUiHarness();
    try {
      ui.requestCapture();
      ui.setError(Object.assign(new Error('search unavailable'), { status: 503 }));
      await expect(ui.loadCards()).rejects.toThrow('search unavailable');

      expect(ui.interactions).toHaveLength(2);
      expect(ui.interactions[0]).toMatchObject({ action: 'search_response', top10: [], httpStatus: 503, error: 'search unavailable' });
      expect(ui.interactions[1]).toEqual({ action: 'review', mountId: 'refind-study-review-list' });
    } finally { dom.window.close(); }
  });
});
