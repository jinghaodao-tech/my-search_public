// Reader: read an article on the left and write a memo on the right.
// The article text comes from POST /api/reader/extract (no AI) and is shown
// with textContent only, so markup from external pages is never executed.
let readerArticle = null;
let readerCandidateId = null;
let readerCardId = null; // set when an existing card is opened for editing
const documentReferenceReaderPositions = new Map();

function restoreReaderModalHome() {
  const modal = document.getElementById('modal-reader');
  const home = document.getElementById('reader-modal-home');
  if (!modal || !home?.parentNode) return;
  modal.dataset.readerEmbedded = 'false';
  modal.removeAttribute('data-reader-context');
  home.parentNode.insertBefore(modal, home.nextSibling);
  const thoughtEmpty = document.getElementById('investigation-reference-empty'); if (thoughtEmpty) thoughtEmpty.hidden = false;
}

function mountReaderForCurrentContext() {
  const modal = document.getElementById('modal-reader');
  const documentHost = document.getElementById('document-reader-host');
  const thoughtHost = document.getElementById('investigation-reference-reader-host');
  const inDocument = typeof isResearchDocumentWorkspaceActive === 'function' && isResearchDocumentWorkspaceActive() && documentHost;
  const inThoughts = typeof isInvestigationThoughtWorkspaceActive === 'function' && isInvestigationThoughtWorkspaceActive() && thoughtHost;
  const host = inDocument ? documentHost : inThoughts ? thoughtHost : null;
  const inline = Boolean(host);
  if (inline) {
    host.append(modal);
    modal.dataset.readerEmbedded = 'true';
    modal.dataset.readerContext = inDocument ? 'document' : 'thoughts';
    const thoughtEmpty = document.getElementById('investigation-reference-empty'); if (thoughtEmpty) thoughtEmpty.hidden = true;
  } else restoreReaderModalHome();
}

function saveEmbeddedReaderPosition(cardId = readerCardId) {
  if (!cardId || document.getElementById('modal-reader')?.dataset.readerEmbedded !== 'true') return;
  const left = document.querySelector('#modal-reader .reader-left');
  const originalCanvas = document.querySelector('#modal-reader .reader-original-pdf-canvas-wrap');
  const pageInput = document.getElementById('reader-original-pdf-page');
  const position = {
    articleTop: left?.scrollTop ?? 0,
    pdfTop: originalCanvas?.scrollTop ?? 0,
    pdfPage: Number(pageInput?.value) || 1,
  };
  documentReferenceReaderPositions.set(cardId, position);
  try { sessionStorage.setItem(`my-search:reader-position:${cardId}`, JSON.stringify(position)); } catch { /* session storage may be disabled */ }
}

function restoreEmbeddedReaderPosition(cardId) {
  let saved = documentReferenceReaderPositions.get(cardId);
  if (!saved) {
    try { saved = JSON.parse(sessionStorage.getItem(`my-search:reader-position:${cardId}`) || 'null'); } catch { /* stored state may be invalid */ }
  }
  if (!saved) return;
  requestAnimationFrame(() => {
    const left = document.querySelector('#modal-reader .reader-left');
    const originalCanvas = document.querySelector('#modal-reader .reader-original-pdf-canvas-wrap');
    if (left) left.scrollTop = saved.articleTop;
    if (originalCanvas) originalCanvas.scrollTop = saved.pdfTop;
    const pageInput = document.getElementById('reader-original-pdf-page');
    if (pageInput && saved.pdfPage > 1 && typeof goToOriginalPdfPage === 'function' && typeof readerOriginalPdfDocument !== 'undefined' && readerOriginalPdfDocument) {
      pageInput.value = String(saved.pdfPage);
      goToOriginalPdfPage();
    }
  });
}
let readerPlainCardMode = false; // ordinary cards share this editor but keep their existing card-body format
let readerEditorColor = null;
let readerEditorColorTouched = false;
let readerInitialMemo = '';
let readerCrossQuote = null;
const READER_IMAGE_LINE = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/;
let readerOriginalPdfDocument = null;
let readerOriginalPdfParagraphsJson = '';
let readerOriginalPdfPageCount = 0;
let readerOriginalPdfRenderToken = 0;
let readerOriginalPdfRenderTask = null;
let readerPdfJsPromise = null;

let readerRequestVersion = 0;
let readerSaving = false;
let readerToolValues = {};
let readerToolPanel = null;
let readerToolStateStale = false;
let readerToolInvalidInputs = new Set();
let ephemeralReaderToolIds = new Set();
let readerToolProposalToken = 0;
let readerToolProposalController = null;
let evidenceRequestToken = 0;
let evidenceRequestController = null;
// Set by 目的から探す before opening: fill the purpose, and optionally find evidence once the text is in.
let readerPendingPurpose = null;
const LAST_READER_SESSION_KEY = 'mySearch:lastReaderSession:v1';
const READER_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
let readerSessionRestorePending = false;
let readerSessionScrollTimer = null;

function invalidateContextualRequests() {
  readerToolProposalToken++;
  readerToolProposalController?.abort();
  readerToolProposalController = null;
  evidenceRequestToken++;
  evidenceRequestController?.abort();
  evidenceRequestController = null;
}

function clearLastReaderSession() {
  clearTimeout(readerSessionScrollTimer);
  readerSessionScrollTimer = null;
  try { localStorage.removeItem(LAST_READER_SESSION_KEY); } catch { /* storage unavailable */ }
}

function readerParagraphFingerprint(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function readLastReaderSession() {
  try {
    const raw = localStorage.getItem(LAST_READER_SESSION_KEY);
    if (!raw || raw.length > 4096) return null;
    const value = JSON.parse(raw);
    const validAnchor = value.paragraphIndex === null || (Number.isInteger(value.paragraphIndex) && value.paragraphIndex >= 0 && value.paragraphIndex <= 50000);
    const validFingerprint = value.paragraphFingerprint === null || (typeof value.paragraphFingerprint === 'string' && /^\d{1,7}:[a-f0-9]{8}$/.test(value.paragraphFingerprint));
    const validTarget = (typeof value.cardId === 'string' && value.cardId.length > 0 && value.cardId.length <= 256)
      || (typeof value.url === 'string' && /^https?:\/\//i.test(value.url) && value.url.length <= 2048);
    if (value.version !== 1 || !validTarget || !validAnchor || !validFingerprint || !Number.isFinite(value.updatedAt)) {
      clearLastReaderSession();
      return null;
    }
    if (Date.now() - value.updatedAt > READER_SESSION_MAX_AGE_MS || value.updatedAt > Date.now() + 60_000) {
      clearLastReaderSession();
      return null;
    }
    return value;
  } catch {
    clearLastReaderSession();
    return null;
  }
}

function currentReaderAnchor() {
  if (!readerArticle?.paragraphs?.length) return null;
  const container = document.querySelector('.reader-left');
  if (!container) return null;
  const containerTop = container.getBoundingClientRect().top;
  const elements = [...container.querySelectorAll('#reader-article [data-index]:not(.reader-translation)')];
  let nearest = null;
  let distance = Infinity;
  for (const element of elements) {
    const top = element.getBoundingClientRect().top;
    const candidateDistance = top <= containerTop ? containerTop - top : top - containerTop;
    if (candidateDistance < distance) { nearest = element; distance = candidateDistance; }
  }
  if (!nearest) return null;
  const index = Number(nearest.dataset.index);
  const text = readerArticle.paragraphs[index];
  return Number.isInteger(index) && typeof text === 'string'
    ? { paragraphIndex: index, paragraphFingerprint: readerParagraphFingerprint(text) }
    : null;
}

function persistLastReaderSession() {
  if (!document.getElementById('modal-reader')?.classList.contains('active')) return;
  const cardId = readerCardId || null;
  const url = cardId ? null : document.getElementById('reader-url')?.value.trim() || null;
  if (!cardId && (!url || !/^https?:\/\//i.test(url) || url.length > 2048)) {
    if (!readerSessionRestorePending) clearLastReaderSession();
    return;
  }
  const previous = readerSessionRestorePending ? readLastReaderSession() : null;
  const anchor = readerSessionRestorePending ? null : currentReaderAnchor();
  const candidateId = !cardId && typeof readerCandidateId === 'string' && readerCandidateId.length <= 256 ? readerCandidateId : null;
  const state = {
    version: 1,
    cardId: cardId && cardId.length <= 256 ? cardId : null,
    url,
    candidateId,
    paragraphIndex: anchor?.paragraphIndex ?? previous?.paragraphIndex ?? null,
    paragraphFingerprint: anchor?.paragraphFingerprint ?? previous?.paragraphFingerprint ?? null,
    updatedAt: Date.now(),
  };
  try { localStorage.setItem(LAST_READER_SESSION_KEY, JSON.stringify(state)); } catch { /* storage unavailable or full */ }
}

function scheduleReaderSessionSave() {
  clearTimeout(readerSessionScrollTimer);
  readerSessionScrollTimer = setTimeout(() => {
    readerSessionScrollTimer = null;
    persistLastReaderSession();
  }, 150);
}

function showReaderResumeStatus(message) {
  const meta = document.getElementById('reader-meta');
  if (!meta) return;
  let notice = meta.querySelector('#reader-resume-status');
  if (!notice) {
    notice = document.createElement('p');
    notice.id = 'reader-resume-status';
    notice.className = 'reader-note';
    notice.setAttribute('role', 'status');
    meta.appendChild(notice);
  }
  notice.textContent = message;
}

function restoreLastReaderPosition(session) {
  if (!readerArticle?.paragraphs?.length || !session.paragraphFingerprint) return true;
  const container = document.querySelector('.reader-left');
  if (!container) return false;
  const sourceElements = [...container.querySelectorAll('#reader-article [data-index]:not(.reader-translation)')];
  const expected = sourceElements.find(element => Number(element.dataset.index) === session.paragraphIndex
    && readerArticle.paragraphs[Number(element.dataset.index)] !== undefined
    && readerParagraphFingerprint(readerArticle.paragraphs[Number(element.dataset.index)]) === session.paragraphFingerprint);
  const matching = sourceElements.filter(element => {
    const index = Number(element.dataset.index);
    return typeof readerArticle.paragraphs[index] === 'string'
      && readerParagraphFingerprint(readerArticle.paragraphs[index]) === session.paragraphFingerprint;
  });
  const target = expected || (matching.length === 1 ? matching[0] : null);
  if (target) {
    target.scrollIntoView({ block: 'center' });
    if (!expected) showReaderResumeStatus('本文内で同じ段落を確認し、閲覧位置を合わせました。');
    return true;
  }
  container.scrollTop = 0;
  showReaderResumeStatus('本文が保存時から変わったため、閲覧位置は復元せず先頭を表示しています。保存済みのメモと道具の値は保持されています。');
  return false;
}

async function restoreLastReaderSession() {
  if (typeof isContextualFeatureEnabled === 'function' && !isContextualFeatureEnabled('f4')) return;
  const session = readLastReaderSession();
  if (!session) return;
  const studyStartedAt = performance.now();
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f4', event: 'started', trigger: 'reader_session', mode: 'safe_auto' });
  readerSessionRestorePending = true;
  try {
    let opened = true;
    if (session.cardId) {
      opened = await openReaderForCard(session.cardId);
      if (!opened) { clearLastReaderSession(); }
    } else {
      await openReader(session.url, session.candidateId, false);
      opened = Boolean(readerArticle);
    }
    const positionRestored = opened ? restoreLastReaderPosition(session) : false;
    if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f4', event: opened && positionRestored ? 'completed' : 'failed', trigger: 'reader_session', mode: 'safe_auto', outcome: opened && positionRestored ? 'ok' : 'error', latencyMs: performance.now() - studyStartedAt });
  } catch {
    clearLastReaderSession();
    if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f4', event: 'failed', trigger: 'reader_session', mode: 'safe_auto', outcome: 'error', latencyMs: performance.now() - studyStartedAt });
  } finally {
    readerSessionRestorePending = false;
    if (document.getElementById('modal-reader')?.classList.contains('active')) persistLastReaderSession();
  }
}

function openReader(url = '', candidateId = null, fromSearch = false) {
  mountReaderForCurrentContext();
  invalidateContextualRequests();
  resetEvidence();
  readerRequestVersion++;
  if (!fromSearch) searchReaderIndex = -1;
  document.getElementById('reader-search-actions').hidden = !fromSearch;
  readerArticle = null;
  ephemeralReaderToolIds = new Set();
  readerToolValues = {};
  readerToolPanel = null;
  readerCandidateId = candidateId;
  readerCardId = null;
  readerPlainCardMode = false;
  readerInitialMemo = '';
  readerCrossQuote = null;
  if (typeof resetReaderTranslation === 'function') resetReaderTranslation();
  if (readerPendingPurpose?.purpose) document.getElementById('evidence-purpose').value = readerPendingPurpose.purpose;
  document.getElementById('reader-fallback-title').value = (typeof findSearchItem === 'function' ? findSearchItem(candidateId)?.article.title : '') || '';
  document.getElementById('reader-edit-title').value = document.getElementById('reader-fallback-title').value;
  readerEditorColor = null;
  readerEditorColorTouched = false;
  updateColorStrip('reader-card-color-strip', readerEditorColor, color => { readerEditorColor = color; readerEditorColorTouched = true; });
  document.getElementById('reader-manual-text').value = '';
  setReaderSaveLabel();
  document.getElementById('reader-url').value = url;
  setReaderEditorMode(false);
  document.getElementById('reader-memo').value = '';
  document.getElementById('reader-tags').value = '';
  setReaderBiblio({});
  if (typeof resetMemoMode === 'function') resetMemoMode();
  cancelQuoteTransfer();
  updateQuoteTransferAvailability();
  renderReaderArticle();
  openModal('modal-reader');
  persistLastReaderSession();
  if (url) {
    const pending = loadReaderArticle();
    offerReaderDraft();
    return pending;
  }
  document.getElementById('reader-url').focus();
  offerReaderDraft();
}

function setReaderEditorMode(plainCard) {
  readerPlainCardMode = Boolean(plainCard);
  const modal = document.querySelector('#modal-reader .reader-modal');
  modal?.classList.toggle('reader-plain-mode', readerPlainCardMode);
  modal?.classList.toggle('reader-reading-mode', !readerPlainCardMode);
  updateReaderLayout();
  const del = document.getElementById('reader-delete-btn');
  if (del) del.hidden = !readerCardId;
  const save = document.getElementById('reader-save-btn');
  if (save) save.textContent = readerCardId ? '保存' : (readerPlainCardMode ? 'メモを作成' : 'メモと本文を保存');
  const url = document.getElementById('reader-url');
  if (url) {
    url.placeholder = readerPlainCardMode ? 'URL（任意）' : 'https://... 記事やPDFのURL';
    url.setAttribute('aria-label', readerPlainCardMode ? 'URL（任意）' : '記事のURL');
    url.onkeydown = event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (!readerPlainCardMode) loadReaderArticle();
    };
  }
}

function updateReaderLayout() {
  const paragraphs = Array.isArray(readerArticle?.paragraphs) ? readerArticle.paragraphs : [];
  const hasBody = readerArticle?.kind === 'pdf' || paragraphs.some(paragraph => {
    const text = String(paragraph || '').trim();
    return text && !PAGE_MARKER_LINE.test(text);
  });
  document.querySelector('#modal-reader .reader-modal')?.classList.toggle('reader-has-source', hasBody);
}

function openPlainCardEditor() {
  mountReaderForCurrentContext();
  invalidateContextualRequests();
  resetEvidence();
  readerRequestVersion++;
  searchReaderIndex = -1;
  document.getElementById('reader-search-actions').hidden = true;
  readerArticle = null;
  readerCandidateId = null;
  readerCardId = null;
  readerInitialMemo = '';
  readerCrossQuote = null;
  readerToolValues = {};
  ephemeralReaderToolIds = new Set();
  if (typeof resetReaderTranslation === 'function') resetReaderTranslation();
  document.getElementById('reader-edit-title').value = '';
  readerEditorColor = null;
  readerEditorColorTouched = false;
  updateColorStrip('reader-card-color-strip', readerEditorColor, color => { readerEditorColor = color; readerEditorColorTouched = true; });
  document.getElementById('reader-fallback-title').value = '';
  document.getElementById('reader-url').value = '';
  document.getElementById('reader-memo').value = '';
  document.getElementById('reader-tags').value = '';
  document.getElementById('reader-manual-text').value = '';
  setReaderBiblio({});
  if (typeof resetMemoMode === 'function') resetMemoMode();
  cancelQuoteTransfer();
  setReaderEditorMode(true);
  setReaderSaveLabel();
  renderReaderArticle();
  openModal('modal-reader');
  document.getElementById('reader-edit-title').focus();
}

// Open an existing card: left = the saved copy (refetched only if none was saved), right = its memo.
async function openReaderForCard(id) {
  saveEmbeddedReaderPosition();
  mountReaderForCurrentContext();
  invalidateContextualRequests();
  resetEvidence();
  searchReaderIndex = -1;
  document.getElementById('reader-search-actions').hidden = true;
  const requestVersion = ++readerRequestVersion;
  try {
    const data = await api.get(`/api/reader/cards/${encodeURIComponent(id)}`);
    if (requestVersion !== readerRequestVersion) return false;
    readerCandidateId = null;
    readerCardId = id;
    if (typeof syncInvestigationReferenceSource === 'function') syncInvestigationReferenceSource(id);
    setReaderEditorMode(!data.isReaderFormat);
    if (typeof resetReaderTranslation === 'function') resetReaderTranslation(data.translation);
    setReaderSaveLabel();
    document.getElementById('reader-url').value = data.url || '';
    document.getElementById('reader-memo').value = data.memo || '';
    readerInitialMemo = data.memo || '';
    // the title field must show this card, not the article opened before
    document.getElementById('reader-fallback-title').value = data.title || '';
    document.getElementById('reader-edit-title').value = data.title || '';
    readerEditorColor = data.color || null;
    readerEditorColorTouched = false;
    updateColorStrip('reader-card-color-strip', readerEditorColor, color => { readerEditorColor = color; readerEditorColorTouched = true; });
    document.getElementById('reader-manual-text').value = '';
    document.getElementById('reader-tags').value = (data.tags || []).join(' ');
    setReaderBiblio(data);
    if (typeof resetMemoMode === 'function') resetMemoMode();
    const isPdf = data.paragraphs.some(paragraph => PAGE_MARKER_LINE.test(paragraph));
    readerArticle = data.isReaderFormat
      ? { url: data.url, title: data.title, byline: data.byline, siteName: data.siteName, year: data.year, fileName: data.fileName, kind: isPdf ? 'pdf' : 'html', fetchedAt: data.fetchedAt || new Date().toISOString(), paragraphs: data.paragraphs, tools: data.tools || [], toolsSourceHash: data.toolsSourceHash, toolState: data.toolState }
      : null;
    initializeReaderToolValues(readerArticle);
    renderReaderArticle();
    updateQuoteTransferAvailability();
    openModal('modal-reader');
    restoreEmbeddedReaderPosition(id);
    persistLastReaderSession();
    offerReaderDraft();
    if (data.isReaderFormat && !readerArticle?.paragraphs.length && data.url) await loadReaderArticle();
    return true;
  } catch (error) {
    showApiError(error, 'カードを開けませんでした');
    return false;
  }
}

function updateQuoteTransferAvailability() {
  const button = document.getElementById('reader-cross-quote-open');
  if (button) button.hidden = !(readerCardId && (typeof isContextualFeatureEnabled !== 'function' || isContextualFeatureEnabled('f3')));
}

async function prepareQuoteTransfer() {
  if (!readerCardId) { toast('引用元を先に保存してください', 'warn'); return; }
  if (typeof isContextualFeatureEnabled === 'function' && !isContextualFeatureEnabled('f3')) { toast('この補助機能は設定で停止中です', 'warn'); return; }
  const quote = selectedReaderText();
  const paragraphIndex = selectionParagraphIndex();
  if (!quote || !Number.isInteger(paragraphIndex)) { toast('引用したい文を本文から選択してください', 'warn'); return; }
  readerCrossQuote = { quote, paragraphIndex };
  const panel = document.getElementById('reader-cross-quote');
  const select = document.getElementById('reader-cross-quote-target');
  select.replaceChildren(new Option('保存先を選択', ''));
  panel.hidden = false;
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f3', event: 'shown', trigger: 'quote_selected' });
  try {
    const cards = await api.get('/api/cards');
    if (!readerCrossQuote || !panel.isConnected) return;
    const available = (Array.isArray(cards) ? cards : []).filter(card => card.id !== readerCardId && !card.archived);
    for (const card of available) select.add(new Option(String(card.title || '無題').slice(0, 180), card.id));
    if (!available.length) {
      panel.hidden = true;
      toast('引用を追加できる保存メモがありません', 'warn');
      readerCrossQuote = null;
      return;
    }
    select.focus();
  } catch (error) {
    panel.hidden = true;
    readerCrossQuote = null;
    showApiError(error, '保存メモを読み込めませんでした');
  }
}

function cancelQuoteTransfer(completed = false) {
  if (!completed && readerCrossQuote && typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f3', event: 'cancelled', trigger: 'user_action', outcome: 'cancelled' });
  readerCrossQuote = null;
  const panel = document.getElementById('reader-cross-quote');
  if (panel) panel.hidden = true;
}

async function transferReaderQuote() {
  const targetCardId = document.getElementById('reader-cross-quote-target').value;
  if (!readerCrossQuote || !readerCardId || !targetCardId) { toast('引用元と保存先を確認してください', 'warn'); return; }
  const button = document.getElementById('reader-cross-quote-save');
  button.disabled = true;
  const studyStartedAt = performance.now();
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f3', event: 'started', trigger: 'user_action', mode: 'manual' });
  try {
    const response = await api.post('/api/reader/quotes/transfer', {
      targetCardId,
      sourceCardId: readerCardId,
      paragraphIndex: readerCrossQuote.paragraphIndex,
      quote: readerCrossQuote.quote,
    });
    cancelQuoteTransfer(true);
    toast(response.duplicate ? '同じ引用元・本文位置の引用は追加済みです' : '引用と出典を保存メモへ追加しました');
    if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f3', event: 'completed', trigger: 'user_action', outcome: 'ok', latencyMs: performance.now() - studyStartedAt });
    if (typeof loadCards === 'function') await loadCards();
  } catch (error) {
    if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f3', event: 'failed', trigger: 'user_action', outcome: 'error', latencyMs: performance.now() - studyStartedAt });
    showApiError(error, '引用を追加できませんでした');
  } finally { button.disabled = false; }
}

async function jumpToCrossCardSource(sourceCardId, expectedHash, paragraphIndex) {
  if (typeof isContextualFeatureEnabled === 'function' && !isContextualFeatureEnabled('f3')) { toast('引用元への移動は設定で停止中です', 'warn'); return false; }
  const readerOpen = document.getElementById('modal-reader')?.classList.contains('active');
  if (readerOpen && readerCardId !== sourceCardId) {
    if (currentReaderMemo() !== readerInitialMemo && !confirm('編集中のメモを保存せずに引用元へ移動しますか？')) return false;
  }
  const opened = readerOpen && readerCardId === sourceCardId && readerArticle ? true : await openReaderForCard(sourceCardId);
  if (!opened || !readerArticle?.paragraphs || typeof crypto === 'undefined' || !crypto.subtle) { toast('引用元本文を確認できません。引用とメモは保持されています', 'warn'); return false; }
  const sourceArticle = readerArticle;
  const bytes = new TextEncoder().encode(JSON.stringify(sourceArticle.paragraphs));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  if (readerCardId !== sourceCardId || readerArticle !== sourceArticle || hash !== expectedHash || !sourceArticle.paragraphs[paragraphIndex]) {
    showReaderResumeStatus('引用元本文が保存時から変わったため、位置へ移動しませんでした。引用とメモは保持されています。');
    return false;
  }
  jumpToParagraph(paragraphIndex);
  return true;
}

function setReaderSaveLabel() {
  const button = document.getElementById('reader-save-btn');
  if (button) button.textContent = readerCardId ? '保存' : (readerPlainCardMode ? 'メモを作成' : 'メモと本文を保存');
}

async function loadReaderArticle() {
  const url = document.getElementById('reader-url').value.trim();
  if (!url) { toast('URLを入力してください', 'warn'); return; }
  invalidateContextualRequests();
  const requestVersion = ++readerRequestVersion;
  const pane = document.getElementById('reader-article');
  readerArticle = null;
  updateReaderLayout();
  pane.textContent = '本文を取得中...';
  try {
    const extracted = await api.post('/api/reader/extract', { url });
    if (requestVersion !== readerRequestVersion) return;
    readerArticle = extracted;
    if (!readerCardId) document.getElementById('reader-edit-title').value = extracted.title || '';
    initializeReaderToolValues(readerArticle);
    if (typeof resetReaderTranslation === 'function' && !readerCardId) resetReaderTranslation();
    setReaderBiblio(readerArticle);
    renderReaderArticle();
    persistLastReaderSession();
    if (!readerCardId && !document.getElementById('reader-memo').value) offerReaderDraft();
    document.getElementById('reader-memo').focus();
    const pending = readerPendingPurpose;
    readerPendingPurpose = null;
    if (pending?.run) runEvidence();
  } catch (error) {
    if (requestVersion !== readerRequestVersion) return;
    readerArticle = null;
    updateReaderLayout();
    pane.textContent = '';
    const message = document.createElement('p');
    message.className = 'reader-error';
    message.textContent = `本文を取得できませんでした: ${formatApiError(error)}`;
    pane.appendChild(message);
  }
}

function renderReaderArticle() {
  resetEvidence();
  closeReaderToolPanel(false);
  updateReaderLayout();
  const pane = document.getElementById('reader-article');
  pane.hidden = false;
  document.getElementById('reader-original-pdf-view').hidden = true;
  const meta = document.getElementById('reader-meta');
  pane.textContent = '';
  meta.textContent = '';
  if (!readerArticle) {
    pane.textContent = 'URLを入れて「読む」を押すか、「PDFを開く」で手元のPDFを選ぶと、ここに本文が出ます。';
    updateResearchCitationTransferAvailability();
    return;
  }
  const title = document.createElement('h3');
  title.textContent = readerArticle.title;
  pane.appendChild(title);
  readerArticle.paragraphs.forEach((text, index) => {
    const page = PAGE_MARKER_LINE.exec(text);
    if (page) {
      // Page break of a PDF: sheet number and the page number printed on it.
      const divider = document.createElement('div');
      divider.className = 'reader-page';
      divider.dataset.index = index;
      // shown with CSS ::after so it is never part of a text selection (quotes stay word for word)
      divider.dataset.label = page[2] ? `p. ${page[2]}（PDF ${page[1]}枚目）` : `PDF ${page[1]}枚目（印刷ページ番号なし）`;
      pane.appendChild(divider);
      return;
    }
    const image = READER_IMAGE_LINE.exec(text);
    if (image) {
      // Linked from the original page; only the link is stored in the card.
      const img = document.createElement('img');
      img.src = image[2];
      img.alt = image[1];
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.className = 'reader-image';
      img.dataset.index = index;
      pane.appendChild(img);
      return;
    }
    if (typeof renderReaderParagraph === 'function') renderReaderParagraph(pane, text, index);
    else {
      const p = document.createElement('p');
      p.textContent = text;
      p.dataset.index = index;
      pane.appendChild(p);
    }
    bindReaderToolTargets(pane, index);
  });
  const parts = [readerArticle.fileName, readerArticle.siteName, readerArticle.byline, `取得: ${new Date(readerArticle.fetchedAt).toLocaleString('ja-JP')}`].filter(Boolean);
  meta.textContent = parts.join(' · ');
  if (readerToolStateStale) {
    const warning = document.createElement('p');
    warning.id = 'reader-tool-state-stale';
    warning.className = 'reader-note reader-tool-state-stale';
    warning.setAttribute('role', 'status');
    warning.textContent = '本文が保存時から変わったため、保存済みの計算・比較値はこの版へ適用していません。元のメモと道具の値は保持されています。';
    meta.appendChild(warning);
  }
  renderReaderMemoSourceWarning(meta);
  if (readerArticle.kind === 'pdf' || readerArticle.paragraphs.some(paragraph => PAGE_MARKER_LINE.test(paragraph))) renderPdfMeta(meta);
  else if (typeof renderTranslationBar === 'function') renderTranslationBar(meta);
  renderEvidenceEngine();
  updateResearchCitationTransferAvailability();
}

function updateResearchCitationTransferAvailability() {
  const button = document.getElementById('reader-research-citation-add');
  if (!button) return;
  const available = typeof canAddSelectedQuoteToResearchDocument === 'function'
    ? canAddSelectedQuoteToResearchDocument()
    : (typeof hasResearchSearchHandoff === 'function' && hasResearchSearchHandoff());
  button.hidden = !available;
  button.textContent = document.getElementById('modal-reader')?.dataset.readerEmbedded === 'true'
    ? '引用を原稿へ挿入'
    : '引用を原稿へ追加して戻る';
}

function initializeReaderToolValues(article) {
  readerToolValues = {};
  readerToolInvalidInputs = new Set();
  ephemeralReaderToolIds = new Set();
  readerToolStateStale = false;
  if (!article || !Array.isArray(article.tools)) return;
  const saved = article.toolState;
  const matches = saved?.version === 1 && saved.sourceHash === article.toolsSourceHash;
  readerToolStateStale = Boolean(saved && !matches);
  for (const tool of article.tools) {
    const values = matches ? saved.values?.[tool.id] : null;
    const initial = {};
    if (tool.kind === 'calculator') for (const variable of tool.variables) initial[variable.key] = values?.[variable.key] ?? variable.initial;
    else for (const option of tool.options) for (const cell of option.cells) initial[cell.key] = values?.[cell.key] ?? cell.value;
    readerToolValues[tool.id] = initial;
  }
}

function renderReaderMemoSourceWarning(meta = document.getElementById('reader-meta')) {
  if (!meta) return;
  let warning = meta.querySelector('#reader-memo-source-stale');
  const stale = readerArticle?.paragraphs?.length
    ? findStaleMemoQuoteAnchors(currentReaderMemo(), readerArticle.paragraphs)
    : [];
  const ambiguous = readerArticle?.paragraphs?.length
    ? findAmbiguousMemoQuoteAnchors(currentReaderMemo(), readerArticle.paragraphs)
    : [];
  if (!stale.length && !ambiguous.length) { warning?.remove(); return; }
  if (!warning) {
    warning = document.createElement('p');
    warning.id = 'reader-memo-source-stale';
    warning.className = 'reader-note reader-tool-state-stale';
    warning.setAttribute('role', 'status');
    meta.appendChild(warning);
  }
  const details = [
    ...(stale.length ? [`本文との一致がなく変更の可能性がある箇所: ${stale.map(index => `¶${index + 1}`).join('、')}`] : []),
    ...(ambiguous.length ? [`本文内で引用が重複し位置を確定できない箇所: ${ambiguous.map(index => `¶${index + 1}`).join('、')}`] : []),
  ];
  warning.textContent = `${details.join('。')}。引用とメモは保持しています。Alt+Jでは曖昧な箇所を自動移動しません。`;
}

function readerToolStatePayload() {
  if (readerToolStateStale || !readerArticle?.tools?.length || !readerArticle.toolsSourceHash) return undefined;
  const persistentIds = new Set(readerArticle.tools.filter(tool => !ephemeralReaderToolIds.has(tool.id)).map(tool => tool.id));
  if (!persistentIds.size) return undefined;
  const values = Object.fromEntries(Object.entries(readerToolValues).filter(([id]) => persistentIds.has(id)));
  return { version: 1, sourceHash: readerArticle.toolsSourceHash, values };
}

function bindReaderToolTargets(pane, index) {
  if (readerToolStateStale) return;
  const supported = (readerArticle?.tools || []).filter(tool => tool.sourceIndices?.includes(index));
  if (!supported.length) return;
  const candidates = [...pane.querySelectorAll(`[data-index="${index}"]`)].filter(element => !element.classList.contains('reader-translation'));
  for (const target of candidates) {
    target.classList.add('reader-tool-target');
    target.tabIndex = 0;
    target.setAttribute('role', 'button');
    target.setAttribute('aria-haspopup', 'group');
    target.setAttribute('aria-label', `${target.textContent}. 操作可能な${supported.map(tool => tool.kind === 'calculator' ? '計算' : '比較') .join('・')}。クリックまたはEnterで開く`);
    const activate = event => {
      const selection = window.getSelection?.();
      if (selection && !selection.isCollapsed && String(selection).trim()) return; // keep normal quote selection intact
      const tool = supported[0];
      openReaderToolPanel(tool, target);
    };
    target.addEventListener('click', activate);
    target.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openReaderToolPanel(supported[0], target); }
    });
  }
}

function toolSourceButton(index, label = `出典 ¶${index + 1}`) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reader-tool-source';
  button.textContent = label;
  button.onclick = () => {
    const source = document.querySelector(`#reader-article [data-index="${index}"]:not(.reader-translation)`);
    source?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    source?.classList.add('reader-tool-source-flash');
    setTimeout(() => source?.classList.remove('reader-tool-source-flash'), 1500);
  };
  return button;
}

function readerToolNumber(value) {
  return new Intl.NumberFormat('ja-JP', { maximumSignificantDigits: 10 }).format(value);
}

function evaluateReaderToolRpn(rpn, values) {
  const stack = [];
  for (const token of rpn) {
    if (typeof token === 'number') { stack.push(token); continue; }
    if (Object.hasOwn(values, token)) { stack.push(Number(values[token])); continue; }
    if (token === 'u+' || token === 'u-') {
      if (stack.length < 1) return null;
      const value = stack.pop(); stack.push(token === 'u-' ? -value : value); continue;
    }
    if (stack.length < 2) return null;
    const right = stack.pop(), left = stack.pop();
    if (token === '/' && right === 0) return null;
    const result = token === '+' ? left + right : token === '-' ? left - right : token === '*' ? left * right : left / right;
    if (!Number.isFinite(result) || Math.abs(result) > 1e15) return null;
    stack.push(result);
  }
  return stack.length === 1 ? stack[0] : null;
}

function closeReaderToolPanel(restoreFocus = true) {
  const panel = readerToolPanel;
  readerToolPanel = null;
  if (!panel) return;
  const target = panel._readerToolTarget;
  for (const input of readerToolInvalidInputs) if (panel.contains(input)) readerToolInvalidInputs.delete(input);
  panel.remove();
  if (restoreFocus) target?.focus?.();
}

function openReaderToolPanel(tool, target) {
  closeReaderToolPanel(false);
  const panel = document.createElement('section');
  panel.className = 'reader-tool-panel';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', `${tool.kind === 'calculator' ? '計算' : '比較'}: ${tool.title}`);
  panel._readerToolTarget = target;
  const headingRow = document.createElement('div'); headingRow.className = 'reader-tool-heading';
  const heading = document.createElement('strong'); heading.textContent = `${tool.kind === 'calculator' ? '計算' : '比較'}: ${tool.title}`;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'btn-icon'; close.textContent = '閉じる'; close.setAttribute('aria-label', '操作パネルを閉じる');
  close.onclick = () => closeReaderToolPanel();
  headingRow.append(heading, close); panel.appendChild(headingRow);
  if (ephemeralReaderToolIds.has(tool.id)) {
    const warning = document.createElement('p');
    warning.className = 'reader-note reader-tool-state-stale';
    warning.textContent = 'ローカルAIの実験提案です。式の意味・単位の整合性は未検証です。本文と照らして確認してください。この計算案と入力値は保存されません。';
    panel.appendChild(warning);
    const discard = document.createElement('button');
    discard.type = 'button'; discard.className = 'btn btn-secondary btn-sm'; discard.textContent = 'この提案を破棄';
    discard.onclick = () => discardEphemeralReaderTool(tool.id, target);
    panel.appendChild(discard);
  }
  if (tool.kind === 'calculator') renderReaderCalculator(tool, panel);
  else renderReaderComparison(tool, panel);
  if (tool.kind === 'calculator') {
    const sources = document.createElement('div'); sources.className = 'reader-tool-sources';
    for (const index of tool.sourceIndices) sources.appendChild(toolSourceButton(index));
    panel.appendChild(sources);
  }
  target.insertAdjacentElement('afterend', panel);
  readerToolPanel = panel;
  close.focus();
}

function discardEphemeralReaderTool(toolId, target) {
  if (!ephemeralReaderToolIds.has(toolId) || !readerArticle) return;
  closeReaderToolPanel(false);
  ephemeralReaderToolIds.delete(toolId);
  readerArticle.tools = (readerArticle.tools || []).filter(tool => tool.id !== toolId);
  delete readerToolValues[toolId];
  target?.focus?.();
}

function updateReaderToolProposalAction() {
  const button = document.getElementById('reader-ai-tool-propose');
  if (!button) return;
  const selection = window.getSelection?.();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const start = range ? blockIndexOf(range.startContainer) : null;
  const end = range ? blockIndexOf(range.endContainer) : null;
  const paragraph = Number.isInteger(start) && start === end ? readerArticle?.paragraphs?.[start] : '';
  const eligible = Boolean(readerArticle && paragraph && !selection?.isCollapsed && String(selection).trim()
    && !/^\[\[page:/.test(paragraph) && !selectionInTranslation() && /\d/.test(paragraph));
  const featureEnabled = typeof isContextualFeatureEnabled !== 'function' || isContextualFeatureEnabled('f5');
  const wasHidden = button.hidden;
  button.hidden = !(featureEnabled && eligible);
  if (wasHidden && !button.hidden && typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f5', event: 'shown', trigger: 'numeric_selection' });
}

async function proposeReaderToolForSelection() {
  if (typeof isContextualFeatureEnabled === 'function' && !isContextualFeatureEnabled('f5')) { toast('F5の実験機能は設定で停止中です', 'warn'); return; }
  const selection = window.getSelection?.();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const paragraphIndex = range ? blockIndexOf(range.startContainer) : null;
  if (!readerArticle || !Number.isInteger(paragraphIndex) || paragraphIndex !== blockIndexOf(range.endContainer) || selectionInTranslation()) {
    toast('本文の同じ段落内を選択してください', 'warn'); return;
  }
  const sourceArticle = readerArticle;
  const sourceParagraph = readerArticle.paragraphs[paragraphIndex];
  if (!sourceParagraph || sourceParagraph.length > 12000 || !/\d/.test(sourceParagraph)) { toast('数値を含む短い本文段落を選択してください', 'warn'); return; }
  if (typeof contextualAi === 'undefined') { toast('AI機能を利用できません。通常のReader操作は続けられます', 'warn'); return; }
  const token = ++readerToolProposalToken;
  const controller = new AbortController();
  readerToolProposalController = controller;
  const button = document.getElementById('reader-ai-tool-propose');
  const status = document.getElementById('reader-ai-tool-status');
  const cancel = document.getElementById('reader-ai-tool-cancel');
  if (button) button.disabled = true;
  if (status) { status.textContent = '端末内AIで提案を作成中…'; status.hidden = false; }
  if (cancel) cancel.hidden = false;
  const studyStartedAt = performance.now();
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f5', event: 'started', trigger: 'user_action', mode: 'manual', processor: 'chrome_local' });
  try {
    const generated = await contextualAi.proposeTool(sourceParagraph, paragraphIndex, sourceArticle, controller.signal);
    if (token !== readerToolProposalToken || readerArticle !== sourceArticle || readerArticle.paragraphs[paragraphIndex] !== sourceParagraph
      || (typeof isContextualFeatureEnabled === 'function' && !isContextualFeatureEnabled('f5'))) return;
    if (generated.status !== 'ok') throw new Error(generated.failureReason || '端末内AIを利用できません');
    const proposal = generated.output?.proposal;
    if (!proposal?.supported) {
      if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f5', event: 'completed', trigger: 'user_action', outcome: 'unavailable', processor: 'chrome_local', latencyMs: performance.now() - studyStartedAt });
      toast('この段落から安全に検証できる計算案は見つかりませんでした'); return;
    }
    const validated = await api.post('/api/reader/tools/validate-proposal', { sourceIndex: paragraphIndex, sourceParagraph, proposal: {
      title: proposal.title, expression: proposal.expression, resultUnit: proposal.resultUnit, sourceQuote: proposal.sourceQuote, variables: proposal.variables,
    } }, { signal: controller.signal });
    if (token !== readerToolProposalToken || readerArticle !== sourceArticle || readerArticle.paragraphs[paragraphIndex] !== sourceParagraph
      || (typeof isContextualFeatureEnabled === 'function' && !isContextualFeatureEnabled('f5'))) return;
    const tool = validated.tool;
    if (!tool || validated.persistent !== false || validated.verification !== 'source_and_syntax_checked_semantics_unverified') throw new Error('検証応答を確認できません');
    readerArticle.tools = [...(readerArticle.tools || []).filter(item => item.id !== tool.id), tool];
    ephemeralReaderToolIds.add(tool.id);
    readerToolValues[tool.id] = Object.fromEntries(tool.variables.map(variable => [variable.key, variable.initial]));
    const target = document.querySelector(`#reader-article [data-index="${paragraphIndex}"]`);
    if (!target) { discardEphemeralReaderTool(tool.id, null); throw new Error('選択した本文が表示中に変わりました'); }
    openReaderToolPanel(tool, target);
    if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f5', event: 'completed', trigger: 'user_action', outcome: 'ok', processor: generated.processor === 'chrome_local' ? 'chrome_local' : 'none', latencyMs: performance.now() - studyStartedAt });
  } catch (error) {
    if (!controller.signal.aborted && typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f5', event: 'failed', trigger: 'user_action', outcome: 'error', processor: 'chrome_local', latencyMs: performance.now() - studyStartedAt });
    if (token === readerToolProposalToken) showApiError(error, '計算案を作れませんでした。本文と保存データは変更していません');
  } finally {
    if (token === readerToolProposalToken) {
      if (button) button.disabled = false;
      if (status) { status.hidden = true; status.textContent = ''; }
      if (cancel) cancel.hidden = true;
      if (readerToolProposalController === controller) readerToolProposalController = null;
      updateReaderToolProposalAction();
    }
  }
}

function cancelReaderToolProposal() {
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f5', event: 'cancelled', trigger: 'user_action', outcome: 'cancelled', processor: 'chrome_local' });
  readerToolProposalToken++;
  readerToolProposalController?.abort();
  readerToolProposalController = null;
  const button = document.getElementById('reader-ai-tool-propose');
  const status = document.getElementById('reader-ai-tool-status');
  const cancel = document.getElementById('reader-ai-tool-cancel');
  if (button) button.disabled = false;
  if (status) { status.hidden = true; status.textContent = ''; }
  if (cancel) cancel.hidden = true;
}

function renderReaderCalculator(tool, panel) {
  const expression = document.createElement('p'); expression.className = 'reader-tool-formula';
  expression.textContent = `式: ${tool.expression} → ${tool.resultUnit}（入力に基づく演算結果）`;
  panel.appendChild(expression);
  const inputs = document.createElement('div'); inputs.className = 'reader-tool-inputs';
  for (const variable of tool.variables) {
    const label = document.createElement('label'); label.className = 'reader-tool-field';
    const caption = document.createElement('span'); caption.textContent = `${variable.label} (${variable.unit}) · ${variable.min}–${variable.max}`;
    const input = document.createElement('input'); input.type = 'number'; input.step = 'any'; input.min = String(variable.min); input.max = String(variable.max); input.value = String(readerToolValues[tool.id]?.[variable.key] ?? variable.initial);
    input.setAttribute('aria-label', `${variable.label} (${variable.unit})`);
    input.addEventListener('input', () => {
      const value = input.valueAsNumber;
      if (!Number.isFinite(value) || value < variable.min || value > variable.max || Math.abs(value) > 1e12) {
        input.setAttribute('aria-invalid', 'true'); readerToolInvalidInputs.add(input); result.textContent = '入力範囲を確認してください'; return;
      }
      input.removeAttribute('aria-invalid'); readerToolInvalidInputs.delete(input);
      readerToolValues[tool.id][variable.key] = value;
      const output = evaluateReaderToolRpn(tool.rpn, readerToolValues[tool.id]);
      result.textContent = output === null ? '計算できません（ゼロ除算または範囲外）' : `結果: ${readerToolNumber(output)} ${tool.resultUnit}`;
      if (typeof readerDraftChanged === 'function') readerDraftChanged();
    });
    label.append(caption, input); inputs.appendChild(label);
  }
  panel.appendChild(inputs);
  const output = evaluateReaderToolRpn(tool.rpn, readerToolValues[tool.id]);
  const result = document.createElement('output'); result.className = 'reader-tool-result';
  result.setAttribute('aria-live', 'polite');
  result.textContent = output === null ? '計算できません（入力値を確認してください）' : `結果: ${readerToolNumber(output)} ${tool.resultUnit}`;
  panel.appendChild(result);
}

function renderReaderComparison(tool, panel) {
  const note = document.createElement('p'); note.className = 'reader-note'; note.textContent = '値を編集できます。編集内容は元記事に反映されず、カードに保存した比較用入力として扱われます。'; panel.appendChild(note);
  const table = document.createElement('table'); table.className = 'reader-tool-table';
  const feedback = document.createElement('output'); feedback.className = 'reader-tool-feedback'; feedback.setAttribute('aria-live', 'polite');
  const head = document.createElement('thead'), headRow = document.createElement('tr');
  const optionHeading = document.createElement('th'); optionHeading.scope = 'col'; optionHeading.textContent = '候補'; headRow.appendChild(optionHeading);
  for (const criterion of tool.criteria) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = criterion.unit ? `${criterion.label} (${criterion.unit})` : criterion.label; headRow.appendChild(th); }
  const sourceHeading = document.createElement('th'); sourceHeading.scope = 'col'; sourceHeading.textContent = '出典'; headRow.appendChild(sourceHeading);
  head.appendChild(headRow); table.appendChild(head);
  const body = document.createElement('tbody');
  for (const option of tool.options) {
    const row = document.createElement('tr'); const name = document.createElement('th'); name.scope = 'row'; name.textContent = option.label; row.appendChild(name);
    for (const cell of option.cells) {
      const td = document.createElement('td'); const input = document.createElement('input'); input.type = 'number'; input.step = 'any'; input.value = String(readerToolValues[tool.id]?.[cell.key] ?? cell.value); input.setAttribute('aria-label', `${option.label} ${tool.criteria[Number(cell.key.split('.c')[1])]?.label || '比較値'}`);
      input.addEventListener('input', () => {
        const value = input.valueAsNumber;
        if (!Number.isFinite(value) || Math.abs(value) > 1e12) { input.setAttribute('aria-invalid', 'true'); readerToolInvalidInputs.add(input); feedback.textContent = '比較値は有限の数値で入力してください'; return; }
        input.removeAttribute('aria-invalid'); readerToolInvalidInputs.delete(input);
        readerToolValues[tool.id][cell.key] = value; feedback.textContent = '';
        if (typeof readerDraftChanged === 'function') readerDraftChanged();
      });
      td.appendChild(input); row.appendChild(td);
    }
    const source = document.createElement('td'); source.appendChild(toolSourceButton(option.sourceIndex, `出典 ¶${option.sourceIndex + 1}`)); row.appendChild(source);
    body.appendChild(row);
  }
  table.appendChild(body); panel.append(table, feedback);
}

// PDF: how the printed page numbers were found, a way to correct them, and the copy permission.
function renderPdfMeta(meta) {
  const pages = readerArticle.paragraphs.map(paragraph => PAGE_MARKER_LINE.exec(paragraph)).filter(Boolean);
  const labelled = pages.find(page => page[2]);
  const row = document.createElement('div');
  row.className = 'reader-pages-row';
  const note = document.createElement('span');
  const source = { 'pdf-labels': 'PDFのページ情報から', 'printed-numbers': '紙面のページ番号から推定' }[readerArticle.pageLabelSource] || '';
  note.textContent = labelled
    ? `全${pages.length}枚・印刷ページ p. ${labelled[2]}〜${source ? `（${source}）` : ''}。引用のページは印刷ページで付きます。違っていたら直してください:`
    : `全${pages.length}枚・印刷ページ番号が見つかりません。引用は「PDF n枚目」になります。紙面のページ番号を入れてください:`;
  const sheet = document.createElement('input');
  sheet.type = 'number'; sheet.min = '1'; sheet.max = String(pages.length); sheet.id = 'reader-relabel-sheet';
  sheet.value = labelled ? labelled[1] : '1';
  sheet.title = 'PDFの何枚目';
  const printed = document.createElement('input');
  printed.type = 'number'; printed.min = '1'; printed.id = 'reader-relabel-page';
  printed.value = labelled ? labelled[2].replace(/\D/g, '') : '';
  printed.title = 'その紙面に印刷されたページ番号';
  const apply = document.createElement('button');
  apply.type = 'button'; apply.className = 'btn btn-secondary btn-sm'; apply.textContent = 'ページを直す';
  apply.onclick = applyPageCorrection;
  const sheetLabel = document.createElement('span'); sheetLabel.textContent = 'PDF';
  const sheetUnit = document.createElement('span'); sheetUnit.textContent = '枚目 = p.';
  row.append(note, sheetLabel, sheet, sheetUnit, printed, apply);
  const originalAvailable = Boolean(readerOriginalPdfDocument && readerOriginalPdfParagraphsJson === JSON.stringify(readerArticle.paragraphs));
  if (originalAvailable) {
    const original = document.createElement('button');
    original.type = 'button'; original.className = 'btn btn-secondary btn-sm'; original.textContent = 'PDF原本を表示';
    original.onclick = () => showOriginalPdfAtSheet(1);
    row.append(original);
  }
  meta.appendChild(row);
  if (readerArticle.copyAllowed === false) {
    const warn = document.createElement('div');
    warn.className = 'reader-warn';
    warn.textContent = 'このPDFは作成者がテキストのコピーを許可しない設定です。読む・引用することはできますが、本文の写しをカードに保存するかは注意して判断してください。';
    meta.appendChild(warn);
  }
}

function applyPageCorrection() {
  const sheet = Number(document.getElementById('reader-relabel-sheet').value);
  const printed = Number(document.getElementById('reader-relabel-page').value);
  if (!Number.isInteger(sheet) || sheet < 1 || !Number.isInteger(printed) || printed < 1) { toast('PDFの枚目と、その紙面のページ番号を数字で入れてください', 'warn'); return; }
  const scroll = document.getElementById('reader-article').scrollTop;
  readerArticle = { ...readerArticle, paragraphs: relabelParagraphs(readerArticle.paragraphs, sheet, printed), pageLabelSource: 'manual' };
  renderReaderArticle();
  document.getElementById('reader-article').scrollTop = scroll;
  toast(`PDF ${sheet}枚目を p. ${printed} として付け直しました（保存すると残ります）`);
}

function showOriginalPdfAtSheet(sheet) {
  if (!readerOriginalPdfDocument || !readerArticle || readerOriginalPdfParagraphsJson !== JSON.stringify(readerArticle.paragraphs)) {
    toast('このPDF原本はこのセッションで開かれていません。ファイルを選び直してください', 'warn');
    return false;
  }
  const page = Math.max(1, Math.min(readerOriginalPdfPageCount || 1, Number(sheet) || 1));
  document.getElementById('reader-original-pdf-page').value = String(page);
  document.getElementById('reader-article').hidden = true;
  const viewer = document.getElementById('reader-original-pdf-view');
  viewer.hidden = false;
  void renderOriginalPdfPage(page);
  return true;
}

async function renderOriginalPdfPage(pageNumber) {
  const token = ++readerOriginalPdfRenderToken;
  readerOriginalPdfRenderTask?.cancel();
  readerOriginalPdfRenderTask = null;
  const status = document.getElementById('reader-original-pdf-status');
  const canvas = document.getElementById('reader-original-pdf-canvas');
  status.textContent = `PDF ${pageNumber}/${readerOriginalPdfPageCount}枚目を表示しています…`;
  try {
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    if (token !== readerOriginalPdfRenderToken || !readerOriginalPdfDocument) return;
    const page = await readerOriginalPdfDocument.getPage(pageNumber);
    if (token !== readerOriginalPdfRenderToken) return;
    const initial = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(240, document.querySelector('.reader-original-pdf-canvas-wrap').clientWidth - 24);
    const scale = Math.min(1.8, availableWidth / initial.width);
    const viewport = page.getViewport({ scale });
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.ceil(viewport.width * ratio);
    canvas.height = Math.ceil(viewport.height * ratio);
    canvas.style.width = `${Math.ceil(viewport.width)}px`;
    canvas.style.height = `${Math.ceil(viewport.height)}px`;
    const context = canvas.getContext('2d');
    const transform = ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0];
    const task = page.render({ canvasContext: context, viewport, transform });
    readerOriginalPdfRenderTask = task;
    await task.promise;
    if (token === readerOriginalPdfRenderToken) status.textContent = `PDF ${pageNumber}/${readerOriginalPdfPageCount}枚目 · 原本表示`;
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException' && token === readerOriginalPdfRenderToken) status.textContent = `PDFページを表示できませんでした: ${error.message || '描画エラー'}`;
  } finally {
    if (token === readerOriginalPdfRenderToken) readerOriginalPdfRenderTask = null;
  }
}

async function loadBrowserPdfJs() {
  if (!readerPdfJsPromise) {
    readerPdfJsPromise = import('/vendor/pdfjs/pdf.mjs').then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
      return pdfjs;
    });
  }
  return readerPdfJsPromise;
}

function showExtractedReaderText() {
  document.getElementById('reader-original-pdf-view').hidden = true;
  document.getElementById('reader-article').hidden = false;
}

function goToOriginalPdfPage() {
  const page = Number(document.getElementById('reader-original-pdf-page').value);
  if (!Number.isInteger(page) || page < 1 || page > readerOriginalPdfPageCount) {
    toast(`PDFのページは1〜${readerOriginalPdfPageCount}で指定してください`, 'warn');
    return;
  }
  showOriginalPdfAtSheet(page);
}

function showOriginalPdfAtParagraph(paragraphIndex) {
  if (!readerArticle) return false;
  let sheet = 1;
  for (let i = 0; i <= paragraphIndex && i < readerArticle.paragraphs.length; i += 1) {
    const marker = PAGE_MARKER_LINE.exec(readerArticle.paragraphs[i]);
    if (marker) sheet = Number(marker[1]);
  }
  return showOriginalPdfAtSheet(sheet);
}

// ── Source details used for citations (author, year, journal/book) ──
function setReaderBiblio(source) {
  document.getElementById('reader-author').value = source?.byline || '';
  document.getElementById('reader-year').value = source?.year || '';
  document.getElementById('reader-site').value = source?.siteName || '';
}
function readerBiblio() {
  const value = id => document.getElementById(id).value.trim() || null;
  return { byline: value('reader-author'), year: value('reader-year'), siteName: value('reader-site') };
}

// Open a PDF file from this computer (DRM-free PDFs: papers, technical books).
function chooseReaderPdf() { document.getElementById('reader-pdf-file').click(); }
async function openReaderPdf(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const pane = document.getElementById('reader-article');
  const requestVersion = ++readerRequestVersion;
  pane.textContent = `PDFを読み込み中...（${file.name}）`;
  try {
    const response = await fetch('/api/reader/pdf', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
    const payload = await response.json().catch(() => ({}));
    if (requestVersion !== readerRequestVersion) return;
    if (!response.ok) { const error = new Error(payload.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
    const pdfjs = await loadBrowserPdfJs();
    const loadedPdf = await pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    }).promise;
    if (requestVersion !== readerRequestVersion) { await loadedPdf.destroy(); return; }
    await readerOriginalPdfDocument?.destroy();
    readerOriginalPdfDocument = loadedPdf;
    readerOriginalPdfPageCount = loadedPdf.numPages;
    readerArticle = payload;
    if (!readerCardId) document.getElementById('reader-edit-title').value = payload.title || '';
    readerOriginalPdfParagraphsJson = JSON.stringify(payload.paragraphs);
    initializeReaderToolValues(readerArticle);
    document.getElementById('reader-url').value = '';
    setReaderBiblio(readerArticle);
    renderReaderArticle();
    if (!readerCardId && !document.getElementById('reader-memo').value) offerReaderDraft();
  } catch (error) {
    if (requestVersion !== readerRequestVersion) return;
    readerArticle = null;
    updateReaderLayout();
    pane.textContent = '';
    const message = document.createElement('p');
    message.className = 'reader-error';
    message.textContent = `PDFを読めませんでした: ${formatApiError(error)}`;
    pane.appendChild(message);
  }
}

/**
 * Save an article as a card WITH its full text (no memo), without opening the reader.
 * Returns true when the full text was saved, false when it fell back (caller decides what to do).
 */
async function saveArticleWithFullText(url, candidateId = null) {
  try {
    const article = await api.post('/api/reader/extract', { url });
    const payload = { url: article.url, title: article.title.slice(0, 200), byline: article.byline, siteName: article.siteName, fetchedAt: article.fetchedAt, paragraphs: article.paragraphs, memo: '' };
    if (candidateId) payload.candidateId = candidateId;
    return await api.post('/api/reader/save', payload); // { card, candidate }: truthy

  } catch (error) {
    if (error?.status === 409) throw error; // already saved / expired: not a text problem
    return false;
  }
}

function blockIndexOf(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  const block = element?.closest?.('#reader-article [data-index]');
  return block ? Number(block.dataset.index) : null;
}

// Paragraph (0-based) where the current selection starts, or null.
function selectionParagraphIndex() {
  const range = window.getSelection?.()?.rangeCount ? window.getSelection().getRangeAt(0) : null;
  return range ? blockIndexOf(range.startContainer) : null;
}

// Page location of the current selection ("p. 57", "pp. 57–58", "PDF 3枚目"), or null for articles.
function selectionLocation() {
  const range = window.getSelection?.()?.rangeCount ? window.getSelection().getRangeAt(0) : null;
  if (!range || !readerArticle) return null;
  return locationBetween(readerArticle.paragraphs, blockIndexOf(range.startContainer), blockIndexOf(range.endContainer));
}

/** Selected text with the paragraph/page breaks of the layout removed (Japanese joins directly). */
function selectedReaderText() {
  return String(window.getSelection?.() || '')
    .replace(/\s*\n+\s*/g, '\n')
    .replace(/([^\x00-\x7f])\n(?=[^\x00-\x7f])/g, '$1')
    .replace(/\n/g, ' ')
    .trim();
}

// Quote the selected article text into the memo (text: "> ... [¶n|p. 57]", table: 「...」[¶n|p. 57]).
function quoteReaderSelection() {
  const selected = selectedReaderText();
  if (!selected) { toast('引用したい文を左で選択してください', 'warn'); return; }
  insertReaderQuote(markIfTranslated(selected), selectionParagraphIndex(), undefined, selectionLocation());
}

// Copy the selection with its citation, e.g. 「…」（水本・竹内，2008，p. 57）.
async function copyCitedSelection() {
  const selected = selectedReaderText();
  if (!selected) { toast('引用したい文を左で選択してください', 'warn'); return; }
  await copyCitation(markIfTranslated(selected), selectionLocation());
}

// A quote taken from the Japanese translation is the quoter's translation, not the author's words.
const TRANSLATED_QUOTE_NOTE = '（引用者訳・機械翻訳をもとに）';
function selectionInTranslation() {
  const range = window.getSelection?.()?.rangeCount ? window.getSelection().getRangeAt(0) : null;
  const element = range ? (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement) : null;
  return !!element?.closest?.('.reader-translation');
}
function markIfTranslated(text) {
  return selectionInTranslation() ? text + TRANSLATED_QUOTE_NOTE : text;
}

async function copyCitation(quote, location) {
  const { byline, year } = readerBiblio();
  const text = formatCitedQuote({ quote, author: byline, year, location });
  try {
    await navigator.clipboard.writeText(text);
    toast(byline && year ? 'コピーしました: ' + text.slice(0, 40) + '…' : 'コピーしました（著者・発行年が未入力です）', byline && year ? 'ok' : 'warn');
  } catch {
    toast('クリップボードに書き込めませんでした', 'warn');
  }
}

function insertReaderQuote(text, index, caret, location) {
  if (typeof memoTableRows !== 'undefined' && memoTableRows) { quoteSelectionIntoTable(text, index, location); return; }
  const memo = document.getElementById('reader-memo');
  const quote = formatTextQuote(text, Number.isInteger(index) ? index : undefined, location);
  const at = Number.isInteger(caret) ? caret : memo.value.length;
  const before = memo.value.slice(0, at).trimEnd();
  const after = memo.value.slice(at).trimStart();
  memo.value = `${before ? `${before}\n\n` : ''}${quote}\n\n${after}`;
  const end = (before ? before.length + 2 : 0) + quote.length + 2;
  memo.focus();
  memo.setSelectionRange(end, end);
  readerDraftChanged();
}

// Jump back to where the quote under the caret (or in the focused cell) came from.
// Only by explicit action (button / Alt+J): clicking inside the memo never jumps.
function jumpToQuoteSource() {
  let index = null;
  let memoText = '';
  if (typeof memoTableRows !== 'undefined' && memoTableRows) {
    if (memoTableFocus) {
      memoText = memoTableRows[memoTableFocus.r]?.[memoTableFocus.c] || '';
      index = findMarkerIn(memoText);
    }
  } else {
    const memo = document.getElementById('reader-memo');
    memoText = memo.value;
    const crossSource = findCrossSourceLinkAt(memo.value, memo.selectionStart);
    if (crossSource) { void jumpToCrossCardSource(crossSource.cardId, crossSource.sourceHash, crossSource.paragraphIndex); return; }
    index = findQuoteMarkerAt(memo.value, memo.selectionStart);
  }
  if (typeof memoTableRows !== 'undefined' && memoTableRows && memoText) {
    const crossSource = parseCrossSourceLink(memoText);
    if (crossSource) { void jumpToCrossCardSource(crossSource.cardId, crossSource.sourceHash, crossSource.paragraphIndex); return; }
  }
  if (index === null) { toast('引用（[¶番号] 付き）の上にカーソルを置いてから押してください', 'warn'); return; }
  if (readerArticle?.paragraphs) {
    const anchorStatus = memoQuoteAnchorStatus(memoText, index, readerArticle.paragraphs);
    if (anchorStatus === 'stale') {
      renderReaderMemoSourceWarning();
      toast('引用元の本文と一致しません。メモと引用は保持し、別の段落には移動しません', 'warn');
      return;
    }
    if (anchorStatus === 'ambiguous') {
      renderReaderMemoSourceWarning();
      toast('引用文が本文内で重複しており位置を特定できません。該当段落へ自動移動しません', 'warn');
      return;
    }
  }
  jumpToParagraph(index);
}

function jumpToParagraph(index) {
  const target = document.querySelector(`#reader-article [data-index="${index}"]`);
  if (!target) { toast('本文に該当する段落が見つかりません', 'warn'); return; }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.querySelectorAll('#reader-article .quote-flash').forEach(el => el.classList.remove('quote-flash'));
  void target.offsetWidth; // restart the highlight animation
  target.classList.add('quote-flash');
}

function presentSearchSnippetTarget(snippet) {
  const host = document.getElementById('reader-meta');
  if (!host || !readerArticle?.paragraphs) return false;
  host.querySelector('#reader-search-passage-choice')?.remove();
  const indices = exactSnippetParagraphIndices(snippet, readerArticle.paragraphs);
  const notice = document.createElement('div');
  notice.id = 'reader-search-passage-choice';
  notice.className = 'reader-note reader-passage-choice';
  notice.setAttribute('role', 'status');
  if (indices.length === 1) {
    notice.textContent = '検索結果の抜粋と保存本文の一意な一致を確認しました。該当段落を表示しています。';
    host.append(notice);
    jumpToParagraph(indices[0]);
    return true;
  }
  if (indices.length > 1) {
    const label = document.createElement('p');
    label.textContent = `抜粋が保存本文の${indices.length}箇所に一致します。移動先を選んでください。`;
    notice.append(label);
    indices.forEach(index => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn btn-secondary btn-sm'; button.textContent = `段落 ${index + 1} を表示`;
      button.onclick = () => jumpToParagraph(index);
      notice.append(button);
    });
    host.append(notice);
    return true;
  }
  notice.textContent = '検索結果の抜粋を保存本文内で一意に確認できません。本文は開いたままなので、Reader内で探してください。';
  host.append(notice);
  return false;
}

// ── Drafts: memo is kept in this browser until it is saved ──
let readerDraftTimer = null;
function readerDraftKey() {
  if (readerCardId) return `readerDraft:card:${readerCardId}`;
  if (readerArticle && !readerArticle.url && readerArticle.fileName) return `readerDraft:file:${readerArticle.fileName}`;
  const url = readerArticle?.url || document.getElementById('reader-url').value.trim();
  return url ? `readerDraft:url:${url}` : null;
}
function currentReaderMemo() {
  const memo = document.getElementById('reader-memo').value;
  return typeof memoTableRows !== 'undefined' && memoTableRows ? replaceOrAppendTable(memo, memoTableRows) : memo;
}
function readerDraftChanged() {
  renderReaderMemoSourceWarning();
  clearTimeout(readerDraftTimer);
  readerDraftTimer = setTimeout(() => {
    const key = readerDraftKey();
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify({ memo: currentReaderMemo(), tags: document.getElementById('reader-tags').value, savedAt: new Date().toISOString() })); } catch { /* storage unavailable */ }
  }, 400);
}
function clearReaderDraft() {
  clearTimeout(readerDraftTimer);
  const key = readerDraftKey();
  try { if (key) localStorage.removeItem(key); } catch { /* ignore */ }
  document.getElementById('reader-draft').style.display = 'none';
}
function offerReaderDraft() {
  const banner = document.getElementById('reader-draft');
  banner.style.display = 'none';
  if (typeof isContextualFeatureEnabled === 'function' && !isContextualFeatureEnabled('f4')) return;
  const key = readerDraftKey();
  let draft = null;
  try { draft = key ? JSON.parse(localStorage.getItem(key) || 'null') : null; } catch { draft = null; }
  if (!draft) return;
  const memoMatches = draft.memo === currentReaderMemo();
  const tagsMatch = (draft.tags ?? '') === document.getElementById('reader-tags').value;
  if (memoMatches && tagsMatch) return;
  document.getElementById('reader-draft-time').textContent = new Date(draft.savedAt).toLocaleString('ja-JP');
  banner.style.display = '';
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f4', event: 'shown', trigger: 'draft_available' });
  banner.dataset.memo = draft.memo;
  banner.dataset.tags = draft.tags ?? '';
  if (readerSessionRestorePending) restoreReaderDraft({ automatic: true });
}
function restoreReaderDraft(options = {}) {
  const banner = document.getElementById('reader-draft');
  if (typeof setMemoMode === 'function') setMemoMode('text');
  document.getElementById('reader-memo').value = banner.dataset.memo || '';
  if (banner.dataset.tags) document.getElementById('reader-tags').value = banner.dataset.tags;
  banner.style.display = 'none';
  const mode = options.automatic ? 'safe_auto' : 'manual';
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f4', event: 'started', trigger: 'user_action', mode });
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f4', event: 'completed', trigger: 'user_action', outcome: 'ok', mode });
}
function discardReaderDraft() {
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f4', event: 'started', trigger: 'user_action', mode: 'manual' });
  clearReaderDraft();
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f4', event: 'completed', trigger: 'user_action', outcome: 'discarded' });
}

async function saveReaderCard() {
  if (readerSaving) return;
  if (readerToolInvalidInputs.size) {
    toast('操作パネルの入力値を確認してください', 'warn');
    readerToolInvalidInputs.values().next().value?.focus?.();
    return;
  }
  readerSaving = true;
  const controls = document.querySelectorAll('#modal-reader button');
  controls.forEach(button => button.disabled = true);
  try { await saveReaderCardOnce(); }
  finally { readerSaving = false; controls.forEach(button => button.disabled = false); }
}

async function deleteCurrentReaderCard() {
  if (!readerCardId || !confirm('このカードを削除しますか？')) return;
  const id = readerCardId;
  try {
    await api.del(`/api/cards/${encodeURIComponent(id)}`);
    closeModal('modal-reader');
    if (currentCardId === id && typeof closeDetail === 'function') closeDetail();
    toast('削除しました');
    if (typeof loadCards === 'function') await loadCards();
    if (typeof loadTags === 'function') await loadTags();
  } catch (error) {
    showApiError(error, '削除に失敗しました');
  }
}
async function saveReaderCardOnce() {
  if (typeof syncMemoTable === 'function') syncMemoTable();
  if (readerPlainCardMode) {
    const title = document.getElementById('reader-edit-title').value.trim();
    const body = document.getElementById('reader-memo').value;
    const url = document.getElementById('reader-url').value.trim();
    const tags = document.getElementById('reader-tags').value.split(/\s+/).map(tag => tag.trim()).filter(Boolean);
    if (!title) { toast('タイトルを入力してください', 'warn'); document.getElementById('reader-edit-title').focus(); return; }
    try {
      if (readerCardId) {
        await api.put(`/api/cards/${encodeURIComponent(readerCardId)}`, { title, body, url: url || null, tags, ...(readerEditorColorTouched ? { color: readerEditorColor } : {}) });
        toast('カードを更新しました');
      } else {
        await api.post('/api/cards', { title, body, url: url || undefined, tags, type: 'memo', ...(readerEditorColor ? { color: readerEditorColor } : {}) });
        toast('メモを作成しました');
      }
      clearReaderDraft();
      closeModal('modal-reader');
      if (typeof loadCards === 'function') await loadCards();
      if (typeof loadTags === 'function') await loadTags();
    } catch (error) {
      showApiError(error, readerCardId ? '更新に失敗しました' : '作成に失敗しました');
    }
    return;
  }
  if (!readerArticle && !readerCardId) {
    const url = document.getElementById('reader-url').value.trim();
    if (!/^https?:\/\//i.test(url)) { toast('記事のURLを入力してください', 'warn'); return; }
    readerArticle = { url, title: document.getElementById('reader-edit-title').value.trim() || document.getElementById('reader-fallback-title').value.trim() || url, paragraphs: [], byline: null, siteName: null, fetchedAt: new Date().toISOString() };
  }
  const tags = document.getElementById('reader-tags').value.split(/\s+/).map(tag => tag.trim()).filter(Boolean);
  if (readerCardId) {
    const article = readerArticle || { url: document.getElementById('reader-url').value.trim() || null, title: '', byline: null, siteName: null, fetchedAt: null, paragraphs: [] };
    const current = allCards?.find?.(card => card.id === readerCardId);
    try {
      await api.put(`/api/reader/cards/${encodeURIComponent(readerCardId)}`, {
        title: (document.getElementById('reader-edit-title').value.trim() || article.title || current?.title || 'Untitled').slice(0, 200),
        url: document.getElementById('reader-url').value.trim() || null,
        fileName: article.fileName || null,
        ...readerBiblio(),
        fetchedAt: article.fetchedAt,
        paragraphs: article.paragraphs,
        ...(typeof readerTranslationPayload === 'function' ? readerTranslationPayload(article.paragraphs) : {}),
        memo: document.getElementById('reader-memo').value,
        ...(readerToolStatePayload() ? { toolState: readerToolStatePayload() } : {}),
        tags,
        ...(readerEditorColorTouched ? { color: readerEditorColor } : {}),
      });
      clearReaderDraft();
      toast('カードを更新しました');
      closeModal('modal-reader');
      if (typeof loadCards === 'function') await loadCards();
    } catch (error) {
      showApiError(error, '更新に失敗しました');
    }
    return;
  }
  const payload = {
    url: document.getElementById('reader-url').value.trim() || null,
    fileName: readerArticle.fileName || null,
    title: (document.getElementById('reader-edit-title').value.trim() || readerArticle.title).slice(0, 200),
    ...readerBiblio(),
    fetchedAt: readerArticle.fetchedAt,
    paragraphs: readerArticle.paragraphs,
    ...(typeof readerTranslationPayload === 'function' ? readerTranslationPayload(readerArticle.paragraphs) : {}),
    memo: document.getElementById('reader-memo').value,
    ...(readerToolStatePayload() ? { toolState: readerToolStatePayload() } : {}),
    tags,
    ...(readerEditorColor ? { color: readerEditorColor } : {}),
  };
  if (readerCandidateId) payload.candidateId = readerCandidateId;
  try {
    const saved = await api.post('/api/reader/save', payload);
    clearReaderDraft();
    toast('メモと本文をカードに保存しました');
    closeModal('modal-reader');
    if (typeof loadCandidates === 'function') await loadCandidates();
    if (typeof loadCards === 'function') await loadCards();
    if (typeof searchReaderSaved === 'function') await searchReaderSaved(saved.candidate);
  } catch (error) {
    showApiError(error, '保存に失敗しました');
  }
}

// Drag the divider to change how much width the article and the memo get.
(function setupReaderDivider() {
  const apply = percent => document.querySelector('.reader-split')?.style.setProperty('--reader-left', `${percent}%`);
  let saved = 60;
  try { saved = Number(localStorage.getItem('readerSplit')) || 60; } catch { /* storage unavailable */ }
  document.addEventListener('DOMContentLoaded', () => {
    apply(saved);
    const divider = document.getElementById('reader-divider');
    if (!divider) return;
    divider.addEventListener('pointerdown', event => {
      const split = divider.parentElement;
      divider.setPointerCapture(event.pointerId);
      const move = e => {
        const rect = split.getBoundingClientRect();
        saved = Math.min(85, Math.max(15, ((e.clientX - rect.left) / rect.width) * 100));
        apply(saved);
      };
      const up = () => {
        divider.removeEventListener('pointermove', move);
        try { localStorage.setItem('readerSplit', String(Math.round(saved))); } catch { /* ignore */ }
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', up, { once: true });
    });
    divider.addEventListener('dblclick', () => { saved = 60; apply(saved); try { localStorage.removeItem('readerSplit'); } catch { /* ignore */ } });
  });
})();

// Keyboard (only while the reader is open): Alt+Q = quote selection, Alt+J = jump to quote source.
// Drag a selection from the article into the memo or a table cell = quote with marker.
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('modal-reader');
  document.addEventListener('keydown', event => {
    if (!modal?.classList.contains('active') || !event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === 'q') { event.preventDefault(); quoteReaderSelection(); }
    if (key === 'j') { event.preventDefault(); jumpToQuoteSource(); }
  });
  const pane = document.getElementById('reader-article');
  pane?.addEventListener('dragstart', event => {
    const text = selectedReaderText();
    if (!text || !event.dataTransfer) return;
    event.dataTransfer.setData('application/x-reader-quote', JSON.stringify({ text: markIfTranslated(text), index: selectionParagraphIndex(), location: selectionLocation() }));
    event.dataTransfer.setData('text/plain', text);
  });
  const memo = document.getElementById('reader-memo');
  memo?.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('application/x-reader-quote')) event.preventDefault(); });
  memo?.addEventListener('drop', event => {
    const data = event.dataTransfer?.getData('application/x-reader-quote');
    if (!data) return;
    event.preventDefault();
    const { text, index, location } = JSON.parse(data);
    insertReaderQuote(text, index, undefined, location); // dropped quotes go to the end, like Alt+Q and the button
  });
  memo?.addEventListener('input', readerDraftChanged);
  document.getElementById('reader-tags')?.addEventListener('input', readerDraftChanged);
});

let readerSelectionActionTimer = null;
document.addEventListener('selectionchange', () => {
  clearTimeout(readerSelectionActionTimer);
  readerSelectionActionTimer = setTimeout(updateReaderToolProposalAction, 100);
});

// ── AI evidence: the AI proposes claim ↔ quote rows for a purpose, the server
// checks each quote against the text (no AI), and only found quotes can be added.
let evidenceResult = null;

function resetEvidence() {
  evidenceRequestToken++;
  evidenceResult = null;
  const host = document.getElementById('evidence-results');
  if (host) host.textContent = '';
}

// Which picks the passages: the on-device AI in Chrome when it is ready, else the server's AI
// when this instance has a key, else the words of the purpose (no AI). Quotes are always checked.
async function evidenceEngine() {
  if (typeof localAi !== 'undefined' && await localAi.isReady('prompt')) return 'local-ai';
  if (typeof appFeatures !== 'undefined' && appFeatures.aiMode === 'mock') return 'mock';
  if (typeof appFeatures !== 'undefined' && appFeatures.ai) return 'server-ai';
  return 'words';
}
const EVIDENCE_ENGINE_TEXT = {
  'local-ai': '端末のAI（Chrome内蔵）が一節を選び、アプリが本文と一字一句照合します。',
  'server-ai': '実行ボタンを押すと、記事本文と検索目的を設定済みの外部AIへ送信します。返った引用はアプリが本文と一字一句照合します。',
  mock: 'テスト用のAIモックが応答します。実際のAIによる生成ではありません。引用は本文と一字一句照合します。',
  words: '目的の語を多く含む文を選びます（AIなし）。端末のAIを準備すると、意味で選べます。',
};
async function renderEvidenceEngine() {
  const host = document.getElementById('evidence-engine');
  if (!host) return;
  const engine = await evidenceEngine();
  host.textContent = EVIDENCE_ENGINE_TEXT[engine];
  if (engine === 'words' && typeof renderLocalAiControl === 'function' && typeof localAi !== 'undefined' && ['downloadable', 'downloading'].includes(await localAi.availability('prompt'))) {
    const control = document.createElement('div');
    host.appendChild(control);
    renderLocalAiControl(control, 'prompt', renderEvidenceEngine);
  }
}

async function runEvidence(options = {}) {
  if (!readerArticle) { toast('先に本文を読み込んでください', 'warn'); return; }
  const details = document.getElementById('reader-evidence-details');
  if (details) details.open = true;
  const purpose = document.getElementById('evidence-purpose').value.trim();
  if (purpose.length < 2) { toast('何のために読むのかを1行で書いてください', 'warn'); document.getElementById('evidence-purpose').focus(); return; }
  const host = document.getElementById('evidence-results');
  const button = document.getElementById('evidence-run');
  const cancel = document.getElementById('evidence-cancel');
  const sourceArticle = readerArticle;
  const article = { title: readerArticle.title.slice(0, 200), url: readerArticle.url || null, paragraphs: readerArticle.paragraphs };
  const requestToken = ++evidenceRequestToken;
  const controller = new AbortController();
  evidenceRequestController = controller;
  const engine = options.forceWords ? 'words' : await evidenceEngine();
  const studyStartedAt = performance.now();
  const studyProcessor = engine === 'words' ? 'rules' : engine === 'local-ai' ? 'chrome_local' : engine === 'mock' ? 'mock' : 'configured_server';
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f6', event: 'started', trigger: 'user_action', mode: 'manual', processor: studyProcessor });
  host.textContent = engine === 'words' ? '目的の語を含む文を探しています…' : engine === 'local-ai' ? '端末内AIが本文を読んでいます…（引用を照合します）' : engine === 'mock' ? '試験用モックを実行しています…' : '設定済み外部AIへ本文を送信しています…（引用を照合します）';
  button.disabled = true;
  if (cancel) cancel.hidden = false;
  try {
    const response = await contextualAi.articleSummary(engine, purpose, article, controller.signal);
    if (requestToken !== evidenceRequestToken || readerArticle !== sourceArticle) return;
    if (response.status !== 'ok' || !response.output) throw new Error(response.failureReason || '根拠候補を取得できませんでした');
    evidenceResult = {
      ...response.output,
      method: response.processor,
      modelVersion: response.modelVersion,
      source: response.source,
      verification: response.verification,
    };
    renderEvidence();
    if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f6', event: 'completed', trigger: 'user_action', outcome: 'ok', processor: studyProcessor, latencyMs: performance.now() - studyStartedAt });
  } catch (error) {
    if (requestToken !== evidenceRequestToken || readerArticle !== sourceArticle) return;
    evidenceResult = null;
    host.textContent = `根拠を探せませんでした: ${formatApiError(error)}`;
    if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f6', event: controller.signal.aborted ? 'cancelled' : 'failed', trigger: 'user_action', outcome: controller.signal.aborted ? 'cancelled' : 'error', processor: studyProcessor, latencyMs: performance.now() - studyStartedAt });
  } finally {
    if (requestToken === evidenceRequestToken) {
      button.disabled = false;
      if (cancel) cancel.hidden = true;
      if (evidenceRequestController === controller) evidenceRequestController = null;
    }
  }
}

function cancelEvidenceRequest() {
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f6', event: 'cancelled', trigger: 'user_action', outcome: 'cancelled' });
  evidenceRequestToken++;
  evidenceRequestController?.abort();
  evidenceRequestController = null;
  const button = document.getElementById('evidence-run');
  const cancel = document.getElementById('evidence-cancel');
  if (button) button.disabled = false;
  if (cancel) cancel.hidden = true;
  const host = document.getElementById('evidence-results');
  if (host) host.textContent = '結果を破棄しました。完了前のローカルモデル処理自体はブラウザ側で続く場合がありますが、保存・表示には反映しません。';
}

function evidenceButton(label, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-secondary btn-sm';
  button.textContent = label;
  button.title = title;
  button.onclick = onClick;
  return button;
}

function renderEvidence() {
  const host = document.getElementById('evidence-results');
  host.textContent = '';
  if (!evidenceResult) return;
  const { rows, rejected } = evidenceResult;
  if (evidenceResult.summary) {
    const summary = document.createElement('div');
    summary.className = 'reader-note contextual-summary';
    const label = document.createElement('strong');
    label.textContent = '検索目的に沿った要点候補';
    const body = document.createElement('p');
    body.textContent = evidenceResult.summary;
    const note = document.createElement('small');
    note.textContent = '各要点は下の本文一致済み引用に対応します。要点は生成文であり、記事の直接引用ではありません。';
    summary.append(label, body, note);
    host.appendChild(summary);
  }
  const provenance = document.createElement('p');
  provenance.className = 'reader-note';
  provenance.textContent = evidenceResult.method === 'chrome_local'
    ? '要点候補は端末内AIの生成です。表示した引用は本文と完全一致することを検証しています。'
    : evidenceResult.method === 'mock'
      ? '試験用モックの要点候補です。実際のAI生成結果ではありません。表示した引用は本文と一致することを検証しています。'
    : evidenceResult.method === 'configured_server'
      ? '要点候補は設定済み外部AIの生成です。表示した引用は本文と完全一致することを検証しています。'
      : '要点候補は検索目的の語をもとにしたルール処理です。表示した引用は本文から抽出しています。';
  host.appendChild(provenance);
  const head = document.createElement('div');
  head.className = 'evidence-head';
  const count = document.createElement('span');
  count.textContent = `本文と一致: ${rows.length}件` + (rejected.length ? ` ／ 本文に無いので除外: ${rejected.length}件` : '');
  head.appendChild(count);
  if (rows.length) head.appendChild(evidenceButton('すべて表に追加', '照合済みの行をメモの表に追加', () => addEvidence(rows)));
  host.appendChild(head);
  if (!rows.length && !rejected.length) {
    const none = document.createElement('p');
    none.className = 'reader-note';
    none.textContent = 'この目的に関係する箇所は見つかりませんでした。目的の書き方を変えて試せます。';
    host.appendChild(none);
  }
  rows.forEach(row => {
    const item = document.createElement('div');
    item.className = 'evidence-row';
    const claim = document.createElement('div');
    claim.className = 'evidence-claim';
    claim.textContent = row.claim;
    const quote = document.createElement('blockquote');
    quote.className = 'evidence-quote';
    quote.textContent = row.quote;
    const marker = document.createElement('span');
    marker.className = 'quote-marker';
    marker.textContent = ` ¶${row.paragraphIndex + 1}${row.location ? ` · ${row.location}` : ''}`;
    quote.appendChild(marker);
    const flags = document.createElement('div');
    flags.className = 'evidence-flags';
    if (row.secondary) {
      const flag = document.createElement('span');
      flag.className = 'evidence-flag';
      flag.textContent = '孫引きの可能性';
      flag.title = 'この一節は著者が他の文献から引いた文のようです。引用するなら原典を読んで原典から引用してください。原典が読めない場合は「〇〇によれば」として、読んだ文献を出典にします。';
      flags.appendChild(flag);
    }
    if (row.long) {
      const flag = document.createElement('span');
      flag.className = 'evidence-flag';
      flag.textContent = '長い引用';
      flag.title = '引用は必要な部分だけにとどめるのが原則です（自分の文が主、引用が従）。';
      flags.appendChild(flag);
    }
    const actions = document.createElement('div');
    actions.className = 'evidence-actions';
    actions.appendChild(evidenceButton('本文で見る', 'この引用の段落へ移動', () => jumpToParagraph(row.paragraphIndex)));
    actions.appendChild(evidenceButton('出典つきでコピー', '「引用」（著者，年，ページ）の形でコピー', () => copyCitation(row.quote, row.location)));
    actions.appendChild(evidenceButton('表に追加', 'この行をメモの表に追加', () => addEvidence([row])));
    item.append(claim, quote, flags, actions);
    host.appendChild(item);
  });
  if (rejected.length) {
    const details = document.createElement('details');
    details.className = 'evidence-rejected';
    const summary = document.createElement('summary');
    summary.textContent = `除外した${rejected.length}件（AIが出した引用が本文に一字一句は見つからなかったもの）`;
    details.appendChild(summary);
    rejected.forEach(row => {
      const p = document.createElement('p');
      p.textContent = `${row.claim} — 「${row.quote}」 (${row.reason === 'too_short' ? '短すぎて照合できない' : row.reason === 'invalid' ? '形式が不正' : '本文に無い'})`;
      details.appendChild(p);
    });
    host.appendChild(details);
  }
}

function addEvidence(rows) {
  const added = addEvidenceToMemoTable(rows);
  toast(added ? `${added}行を表に追加しました` : 'すでに表にある引用です', added ? 'success' : 'warn');
}

async function applyManualReaderText() {
  const text = document.getElementById('reader-manual-text').value.trim();
  if (!text) return;
  invalidateContextualRequests();
  readerRequestVersion++;
  readerArticle = { ...(readerArticle || {}), url: document.getElementById('reader-url').value.trim(), title: readerArticle?.title || document.getElementById('reader-fallback-title').value.trim() || 'Untitled', byline: readerArticle?.byline || null, siteName: readerArticle?.siteName || null, fetchedAt: new Date().toISOString(), paragraphs: text.split(/\n\s*\n/).filter(Boolean) };
  try {
    const prepared = await api.post('/api/reader/tools/prepare', { paragraphs: readerArticle.paragraphs });
    readerArticle.tools = prepared.tools || [];
    readerArticle.toolsSourceHash = prepared.sourceHash;
  } catch { readerArticle.tools = []; readerArticle.toolsSourceHash = null; }
  initializeReaderToolValues(readerArticle);
  renderReaderArticle();
  persistLastReaderSession();
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('.reader-left')?.addEventListener('scroll', scheduleReaderSessionSave, { passive: true });
  window.addEventListener('pagehide', persistLastReaderSession);
  setTimeout(() => { void restoreLastReaderSession(); }, 0);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && readerToolPanel) {
    event.preventDefault();
    event.stopImmediatePropagation(); // Escape closes the inline tool before the Reader modal handler runs.
    closeReaderToolPanel();
  }
}, true);
