// ════════════════════════════════════════
//  状態
// ════════════════════════════════════════
let currentView = 'cards';
let currentCardId = null;
let currentFilter = { tag: null, type: null, q: '', archived: false };
let cardLoadSequence = 0;
let cardListSearchCaptureRequested = false;
let allCards = [];
let allTags = [];
let kjData = { groups: [], ungrouped: [] };
let selectedNewColor = null, selectedEditColor = null, selectedGroupColor = null;
let dragCardId = null;
let zettelNetwork = null;
let importTab = 'csv';

// BM25 状態
let bm25Modes = {};
let bm25ActiveMode = '';
let bm25Params = { k1:1.5, b:0.75, lambda:0.1, ctx:1.5, dedup:1, arch:0.5, limit:50 };
let bm25Keywords = [];
let bm25Result = null;
let showArchived = false;
let selectedCards = new Set();
let multiSelectMode = false;
let showCardSummaries = localStorage.getItem('showCardSummaries') !== 'false';
let cardSidebarCollapsed = localStorage.getItem('cardSidebarCollapsed') === 'true';
let bm25SidebarCollapsed = localStorage.getItem('bm25SidebarCollapsed') === 'true';

const COLORS = ['#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#C77DFF','#FF9A3C','#00C9A7','#F72585','#94a3b8'];

// ════════════════════════════════════════
//  API ヘルパー
// ════════════════════════════════════════
async function apiRequest(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload?.code || 'request_failed';
    error.requestId = payload?.requestId || response.headers.get('x-request-id') || '';
    throw error;
  }
  return payload;
}
const api = {
  async get(p) { return window.typedApiClient?.get(p) ?? apiRequest(p) },
  async post(p,b,options = {}) { return window.typedApiClient?.post(p,b,options) ?? apiRequest(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b),...options}) },
  async put(p,b) { return window.typedApiClient?.put(p,b) ?? apiRequest(p,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}) },
  async del(p) { return window.typedApiClient?.del(p) ?? apiRequest(p,{method:'DELETE'}) },
  async download(p, options = {}) {
    const response = await fetch(p, options);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(payload.error || 'Request failed (' + response.status + ')');
      error.status = response.status; error.code = payload.code || 'request_failed'; error.requestId = payload.requestId || response.headers.get('x-request-id') || '';
      throw error;
    }
    return { blob: await response.blob(), headers: response.headers };
  },
};
window.mySearchContextualApi = api;

function formatApiError(error, fallback = '通信に失敗しました') {
  const message = error?.message || fallback;
  const details = [error?.code, error?.requestId ? `requestId: ${error.requestId}` : ''].filter(Boolean).join(' / ');
  return details ? `${message} (${details})` : message;
}

function showApiError(error, fallback) {
  const message = formatApiError(error, fallback);
  if (typeof toast === 'function') toast(message, 'warn');
  else console.error(message, error);
  return message;
}

window.addEventListener('unhandledrejection', event => {
  if (event.reason) showApiError(event.reason);
});

// ════════════════════════════════════════
//  初期化
// ════════════════════════════════════════
function applySidebarState(){
  document.getElementById('sidebar')?.classList.toggle('collapsed', cardSidebarCollapsed);
  document.getElementById('bm25-config')?.classList.toggle('collapsed', bm25SidebarCollapsed);
}
function toggleCardSidebar(){
  cardSidebarCollapsed = !cardSidebarCollapsed;
  localStorage.setItem('cardSidebarCollapsed', cardSidebarCollapsed ? 'true' : 'false');
  applySidebarState();
}
function toggleBM25Sidebar(){
  bm25SidebarCollapsed = !bm25SidebarCollapsed;
  localStorage.setItem('bm25SidebarCollapsed', bm25SidebarCollapsed ? 'true' : 'false');
  applySidebarState();
}

async function init() {
  buildColorStrips();
  await Promise.all([loadCards(), loadTags(), loadBM25Modes()]);
  if (typeof loadRefindStudyControl === 'function') await loadRefindStudyControl();
  const summaryToggle = document.getElementById('summary-toggle');
  if(summaryToggle) summaryToggle.checked = showCardSummaries;
}

async function loadCards() {
  const sequence = ++cardLoadSequence;
  const captureRequested = cardListSearchCaptureRequested;
  cardListSearchCaptureRequested = false;
  const params = new URLSearchParams();
  params.set('archived', String(currentFilter.archived));
  if (currentFilter.tag)  params.set('tag', currentFilter.tag);
  if (currentFilter.type) params.set('type', currentFilter.type);
  let cards;
  if (currentFilter.q.trim()) {
    const query = currentFilter.q.trim();
    let studySession = null;
    if (captureRequested && typeof beginRefindStudy === 'function') {
      studySession = await beginRefindStudy(query);
    }
    const searchStarted = performance.now();
    try {
      let keywords;
      try {
        const analysis = await api.post('/api/search/terms', { text: query });
        keywords = analysis.keywords;
      } catch {
        keywords = query.split(/\s+/).filter(Boolean).map(term => ({ term, weight: 1 }));
      }
      const result = await api.post('/api/cards/search', {
        config: {
          label: 'カード一覧検索', description: '', k1: bm25Params.k1, b: bm25Params.b,
          lambda: 0, contextBonus: 1,
          keywords: keywords.length ? keywords : query.split(/\s+/).filter(Boolean).map(term => ({ term, weight: 1 })),
        },
        options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 500 },
        filters: { excludedTerms: [], sources: [], status: 'all' },
        cardFilters: {
          ...(currentFilter.tag ? { tag: currentFilter.tag } : {}),
          ...(currentFilter.type ? { type: currentFilter.type } : {}),
          archived: currentFilter.archived,
        },
      });
      cards = [...result.active, ...(result.belowThreshold ?? result.archived ?? [])].map(item => item.article);
      if (studySession && activeRefindStudy === studySession) {
        await recordRefindInteraction({ action: 'search_response',
          top10: cards.slice(0, 10).map(card => card.id),
          candidateIdsBeforeRerank: Array.isArray(result.scope?.candidateIdsBeforeRerank) ? result.scope.candidateIdsBeforeRerank : null,
          actualEngine: result.scope?.searchMethod ?? null, fallbackUsed: result.scope?.fallbackUsed ?? null,
          httpStatus: 200, latencyMs: performance.now() - searchStarted });
      }
    } catch (error) {
      if (studySession && activeRefindStudy === studySession) {
        await recordRefindInteraction({ action: 'search_response', top10: [],
          httpStatus: Number.isInteger(error?.status) ? error.status : null,
          error: formatApiError(error), latencyMs: performance.now() - searchStarted }).catch(() => {});
        if (typeof renderRefindStudyReview === 'function') await renderRefindStudyReview('refind-study-review-list');
      }
      throw error;
    }
  } else {
    cards = await api.get('/api/cards?' + params);
  }
  if (sequence !== cardLoadSequence) return;
  allCards = cards;
  selectedCards = new Set([...selectedCards].filter(id => allCards.some(card => card.id === id)));
  renderCardGrid();
  updateSelectedUI();
  updateBM25SourceInfo();
  if (captureRequested && typeof renderRefindStudyReview === 'function') {
    await renderRefindStudyReview('refind-study-review-list');
  }
}

async function loadTags() {
  allTags = await api.get('/api/tags');
  renderTagCloud();
}

// ════════════════════════════════════════
