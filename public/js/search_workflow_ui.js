// Saved searches live in SQLite. Review state belongs to the candidate, across searches.
let savedSearches = [];
let currentSearchId = '';
let searchResultSource = 'articles';
let searchReaderQueue = [];
let searchReaderIndex = -1;
let searchActionBusy = false;
let lastSearchTerms = [];
let completedSearchAt = null;
let completedSearchId = '';

function syncSimpleTerms() {
  document.getElementById('search-terms').value = bm25Keywords.map(keyword => keyword.term).filter(Boolean).join(' ');
}
function setSimpleSearchTerms(value) {
  const previous = new Map(bm25Keywords.map(keyword => [keyword.term, keyword]));
  bm25Keywords = value.trim().split(/\s+/).filter(Boolean).map(term => previous.get(term) || { term, weight: 1, synonyms: '' });
  // Keep typing focus and whitespace while refreshing the advanced fields.
  renderKeywords();
  document.getElementById('search-terms').value = value;
}
function keywordInputKeydown(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const term = event.target.value.trim();
  if (term) { bm25Keywords.push({ term, weight: 1, synonyms: '' }); renderKeywords(); event.target.value = ''; }
}
async function expandKeywordsWithAI() {
  try {
    const result = await api.post('/api/search/expand-keywords', { keywords: bm25Keywords.map(keyword => keyword.term).filter(Boolean) });
    bm25Keywords.push(...result.expandedKeywords.map(term => ({ term, weight: 1, synonyms: '' })));
    renderKeywords();
  } catch (error) { showApiError(error); }
}
function setSearchOrder(value) {
  if (value === 'custom') return;
  syncParam('lambda', value === 'recent' ? 0.1 : 0);
  document.getElementById('p-lambda').value = bm25Params.lambda;
}
function searchSettings() {
  return {
    name: document.getElementById('saved-search-name').value.trim(),
    source: document.querySelector('input[name="bm25src"]:checked')?.value || 'articles',
    config: { label: document.getElementById('saved-search-name').value.trim() || '検索', description: document.getElementById('mode-desc').value, k1: bm25Params.k1, b: bm25Params.b, lambda: bm25Params.lambda, contextBonus: bm25Params.ctx,
      keywords: bm25Keywords.filter(keyword => keyword.term.trim()).map(keyword => ({ term: keyword.term.trim(), weight: keyword.weight, synonyms: (keyword.synonyms || '').split(',').map(value => value.trim()).filter(Boolean) })) },
    options: { dedupThreshold: bm25Params.dedup, archiveScoreThreshold: bm25Params.arch, resultLimit: bm25Params.limit },
    filters: { excludedTerms: document.getElementById('search-excluded').value.trim().split(/\s+/).filter(Boolean), sources: Array.from(document.getElementById('search-sources').selectedOptions).map(option => option.value), status: document.getElementById('search-status').value },
  };
}
function renderSearchSources(sources, selected = []) {
  const select = document.getElementById('search-sources');
  select.replaceChildren(...[...new Set([...sources, ...selected])].map(source => {
    const option = document.createElement('option'); option.value = source; option.textContent = source; option.selected = selected.includes(source); return option;
  }));
}
async function loadSavedSearches() {
  savedSearches = await api.get('/api/saved-searches');
  const select = document.getElementById('saved-search-select');
  select.replaceChildren(new Option('検索条件を選ぶ', ''), ...savedSearches.map(search => new Option(search.name, search.id)));
  select.value = currentSearchId;
}
async function saveCurrentSearch(copy = false) {
  try {
    const settings = searchSettings();
    if (!settings.name) { toast('検索名を入力してください', 'warn'); return; }
    const saved = currentSearchId && !copy ? await api.put(`/api/saved-searches/${encodeURIComponent(currentSearchId)}`, settings) : await api.post('/api/saved-searches', settings);
    currentSearchId = saved.id; await loadSavedSearches(); toast('検索条件を保存しました');
  } catch (error) { showApiError(error); }
}
async function deleteSavedSearch() {
  if (!currentSearchId || !confirm('この保存した検索条件を削除しますか？')) return;
  try { await api.del(`/api/saved-searches/${encodeURIComponent(currentSearchId)}`); currentSearchId = ''; await loadSavedSearches(); }
  catch (error) { showApiError(error); }
}
function restoreSavedSearch(id) {
  currentSearchId = id;
  const saved = savedSearches.find(search => search.id === id);
  if (!saved) return;
  document.getElementById('saved-search-name').value = saved.name;
  bm25Modes.saved = saved.config; selectBM25Mode('saved');
  for (const [key, value] of Object.entries({ dedup: saved.options.dedupThreshold ?? 0.8, arch: saved.options.archiveScoreThreshold ?? 0.5, limit: saved.options.resultLimit ?? 50 })) {
    syncParam(key, value); document.getElementById(`p-${key}`).value = value;
  }
  document.querySelector(`input[name="bm25src"][value="${saved.source}"]`).checked = true;
  document.getElementById('search-excluded').value = saved.filters.excludedTerms.join(' ');
  document.getElementById('search-status').value = saved.filters.status;
  renderSearchSources([], saved.filters.sources);
  document.getElementById('search-status').disabled = saved.source === 'cards';
  document.getElementById('search-sources').disabled = saved.source === 'cards';
  updateBM25SourceInfo();
  toast('条件を復元しました。「実行」で最新の候補を確認できます');
}
async function runBM25() {
  const button = document.getElementById('bm25-run-btn');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const settings = searchSettings();
    if (!settings.config.keywords.length) { toast('検索語を入力してください', 'warn'); return; }
    const startedAt = new Date().toISOString();
    const searchId = currentSearchId;
    const saved = savedSearches.find(item => item.id === searchId);
    if (document.getElementById('search-new-only').checked && !searchId) { toast('先に検索条件を保存してください', 'warn'); return; }
    const payload = { config: settings.config, options: settings.options, filters: { ...settings.filters } };
    if (settings.source === 'articles' && document.getElementById('search-new-only').checked && saved?.checkedAt) payload.filters.since = saved.checkedAt;
    if (settings.source === 'cards') {
      payload.filters = { ...settings.filters, sources: [], status: 'all' };
      payload.articles = (await api.get('/api/cards')).map(card => ({ id: card.id, title: card.title, body: card.body, summary: card.summary, publishedAt: card.createdAt, url: card.url || '', tags: card.tags, sourceAuthority: 0.8 }));
    }
    const result = await api.post('/api/run', payload);
    completedSearchAt = startedAt; completedSearchId = searchId;
    bm25Result = result; searchResultSource = settings.source;
    lastSearchTerms = settings.config.keywords.flatMap(keyword => [keyword.term, ...keyword.synonyms]);
    showArchived = false;
    renderSearchSources(result.scope.availableSources, settings.filters.sources);
    renderBM25Result();
  } catch (error) { showApiError(error); }
  finally { button.disabled = false; button.textContent = '実行'; }
}
function searchResultItems() { return showArchived ? bm25Result?.archived || [] : bm25Result?.active || []; }
function highlightSearchText(text, terms) {
  // Escape each segment separately: neither source markup nor keywords become HTML.
  const value = String(text || '').normalize('NFKC');
  const words = [...new Set(terms.map(term => term.normalize('NFKC')).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!words.length) return esc(value);
  const expression = new RegExp(words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu');
  let result = '', end = 0;
  for (const match of value.matchAll(expression)) { result += esc(value.slice(end, match.index)) + '<mark>' + esc(match[0]) + '</mark>'; end = match.index + match[0].length; }
  return result + esc(value.slice(end));
}
function resultButton(label, action) {
  const button = document.createElement('button'); button.className = 'btn btn-secondary btn-sm'; button.textContent = label; button.onclick = action; return button;
}
function renderBM25Result() {
  if (!bm25Result) return;
  const body = document.getElementById('bm25-result-body');
  const scroll = body.scrollTop;
  const scope = bm25Result.scope;
  document.getElementById('bm25-stats').textContent = `${scope.corpus === 'cards' ? '保存済みカード' : '収集済み記事'} ${scope.totalCount}件のうち${scope.searchedCount}件を検索。対象: ${scope.sources.join('、') || 'なし'}。Web全体の検索ではありません。`;
  body.replaceChildren();
  for (const [index, item] of searchResultItems().entries()) {
    const article = item.article;
    const card = document.createElement('article'); card.className = 'score-card'; card.dataset.articleId = article.id;
    const status = item.candidate?.status;
    const label = { unreviewed: '未確認', reviewed_not_saved: '確認済み', deferred: '保留', saved_as_card: '保存済み', expired: '見送り' }[status] || (searchResultSource === 'cards' ? '保存済み' : '');
    card.innerHTML = `<div class="score-card-header"><span class="score-badge">#${index + 1} ${Number(item.score).toFixed(2)} · ${esc(label)}</span><div class="score-title">${highlightSearchText(article.title, lastSearchTerms)}</div></div><p>${highlightSearchText(item.snippet || article.summary || article.body, [...lastSearchTerms, ...(item.matchedKeywords || [])])}</p><small>${esc(article.source || '')} · ${esc(article.publishedAt ? new Date(article.publishedAt).toLocaleDateString('ja-JP') : '')}</small>`;
    const actions = document.createElement('div'); actions.className = 'score-actions';
    if (searchResultSource === 'cards' || status === 'saved_as_card') {
      actions.append(resultButton('保存済みメモを読む', () => { searchReaderIndex = -1; openReaderForCard(item.candidate?.savedCardId || article.id); }));
    } else if (status !== 'expired') {
      actions.append(resultButton('読んでメモ', () => openSearchArticle(article.id)), resultButton('カードに保存', () => saveOneAsCard(article.id)), resultButton('保留', () => changeSearchCandidate(article.id, 'defer')), resultButton('見送る', () => changeSearchCandidate(article.id, 'expire')));
    }
    if (/^https?:\/\//i.test(article.url || '')) {
      const link = document.createElement('a'); link.href = article.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '元記事'; actions.append(link);
    }
    card.append(actions); body.append(card);
  }
  if (document.getElementById('search-group-similar').checked) groupSimilarSearchCards(body);
  if (!body.childElementCount) body.textContent = '該当する記事がありません。除外語・状態・情報源を見直すか、Web検索で範囲を広げてください。';
  document.getElementById('bm25-result-actions').style.display = 'flex';
  body.scrollTop = scroll;
}
function toggleArchived() { showArchived = !showArchived; renderBM25Result(); }
function findSearchItem(id) { return [...(bm25Result?.active || []), ...(bm25Result?.archived || [])].find(item => item.article.id === id); }
async function changeSearchCandidate(id, action) {
  if (searchActionBusy) return false;
  searchActionBusy = true;
  try {
    const candidate = await api.put(`/api/candidates/${encodeURIComponent(id)}/${action}`, {});
    const item = findSearchItem(id); if (item) item.candidate = candidate;
    renderBM25Result(); await loadCandidates(); return true;
  } catch (error) { showApiError(error); return false; }
  finally { searchActionBusy = false; }
}
async function saveOneAsCard(id) {
  const item = findSearchItem(id);
  if (!item || searchResultSource === 'cards' || item.candidate?.status === 'saved_as_card' || item.candidate?.status === 'expired' || searchActionBusy) return;
  searchActionBusy = true;
  try {
    // Full text first (same card format as the reader); fall back to the feed snippet if the page cannot be read.
    const full = item.article.url ? await saveArticleWithFullText(item.article.url, id) : false;
    const result = full || await api.post(`/api/candidates/${encodeURIComponent(id)}/save`, {});
    item.candidate = result.candidate; renderBM25Result(); await loadCards(); await loadCandidates();
    toast(full ? '本文ごとカードに保存しました' : '本文を取得できなかったため、抜粋のみ保存しました', full ? 'ok' : 'warn');
  } catch (error) { showApiError(error); }
  finally { searchActionBusy = false; }
}
async function saveTopAsCards() { for (const item of searchResultItems()) await saveOneAsCard(item.article.id); }
function openExternalSearch() {
  const query = bm25Keywords.map(keyword => keyword.term).filter(Boolean).join(' ');
  if (!query) { toast('検索語を入力してください', 'warn'); return; }
  const exclusions = document.getElementById('search-excluded').value.trim().split(/\s+/).filter(Boolean).map(term => `-${term}`).join(' ');
  window.open(`https://www.google.com/search?q=${encodeURIComponent([query, exclusions].filter(Boolean).join(' '))}`, '_blank', 'noopener,noreferrer');
}
function openSearchArticle(id) {
  searchReaderQueue = searchResultItems().map(item => item.article.id);
  searchReaderIndex = searchReaderQueue.indexOf(id);
  openSearchReaderItem();
}
function openSearchReaderItem() {
  const item = findSearchItem(searchReaderQueue[searchReaderIndex]);
  if (!item) return;
  openReader(item.article.url || '', item.article.id, true);
  document.getElementById('reader-search-position').textContent = `${searchReaderIndex + 1} / ${searchReaderQueue.length}`;
}
function nextSearchArticle(skipDraftCheck = false) {
  if (typeof syncMemoTable === 'function') syncMemoTable();
  if (!skipDraftCheck && document.getElementById('reader-memo').value.trim() && !confirm('未保存のメモを破棄して次へ進みますか？')) return;
  do { searchReaderIndex++; } while (searchReaderIndex < searchReaderQueue.length && ['saved_as_card', 'expired'].includes(findSearchItem(searchReaderQueue[searchReaderIndex])?.candidate?.status));
  if (searchReaderIndex >= searchReaderQueue.length) { searchReaderIndex = -1; closeModal('modal-reader'); toast('この検索結果の最後まで確認しました'); return; }
  openSearchReaderItem();
}
async function decideReaderSearch(action) {
  if (typeof syncMemoTable === 'function') syncMemoTable();
  if (document.getElementById('reader-memo').value.trim() && !confirm('未保存のメモを破棄して進みますか？')) return;
  if (await changeSearchCandidate(searchReaderQueue[searchReaderIndex], action)) nextSearchArticle(true);
}
async function searchReaderSaved(candidate) {
  if (candidate) { const item = findSearchItem(candidate.candidateId); if (item) item.candidate = candidate; renderBM25Result(); }
  if (searchReaderIndex >= 0) nextSearchArticle(true);
}
document.addEventListener('DOMContentLoaded', () => {
  loadSavedSearches().catch(error => showApiError(error));
  api.get('/api/candidates').then(candidates => renderSearchSources(candidates.map(candidate => candidate.source || 'unknown'))).catch(error => showApiError(error));
});
document.querySelectorAll('input[name="bm25src"]').forEach(input => input.addEventListener('change', () => {
  document.getElementById('search-status').disabled = input.value === 'cards';
  document.getElementById('search-sources').disabled = input.value === 'cards';
  updateBM25SourceInfo();
}));

async function markSearchChecked() {
  if (!completedSearchAt || !completedSearchId || completedSearchId !== currentSearchId) { toast('保存した条件で検索を実行してください', 'warn'); return; }
  try {
    await api.post(`/api/saved-searches/${encodeURIComponent(completedSearchId)}/checkpoint`, { checkedAt: completedSearchAt });
    await loadSavedSearches(); toast('今回の検索開始時点までを確認済みにしました');
  } catch (error) { showApiError(error); }
}
function similarTitleTokens(title) {
  const normalized = title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return new Set(Array.from({ length: Math.max(0, normalized.length - 1) }, (_, i) => normalized.slice(i, i + 2)));
}
function groupSimilarSearchCards(body) {
  const groups = [];
  for (const card of Array.from(body.children)) {
    const item = findSearchItem(card.dataset.articleId);
    if (!item) continue;
    const tokens = similarTitleTokens(item.article.title);
    const group = groups.find(group => {
      if (tokens.size < 4 || group.tokens.size < 4) return false;
      const intersection = [...tokens].filter(token => group.tokens.has(token)).length;
      return intersection / (tokens.size + group.tokens.size - intersection) >= 0.65;
    });
    if (!group) { groups.push({ card, tokens, details: null, count: 0 }); continue; }
    if (!group.details) {
      group.details = document.createElement('details');
      group.details.append(document.createElement('summary'));
      group.card.append(group.details);
    }
    group.count++;
    group.details.firstElementChild.textContent = `似た記事 ${group.count}件を比較（タイトルの類似度）`;
    group.details.append(card);
  }
}
