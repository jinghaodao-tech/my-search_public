async function loadBM25Modes() {
  bm25Modes = await api.get('/api/modes');
  const ids = Object.keys(bm25Modes);
  const tabs = document.getElementById('mode-tabs');
  if (tabs) tabs.innerHTML = ids.map(id => `<button class="mode-tab" id="mtab-${esc(id)}" onclick="selectBM25Mode('${esc(id)}')">${esc(bm25Modes[id].label || id)}</button>`).join('');
  if (ids.length) selectBM25Mode(ids[0]);
}
function selectBM25Mode(modeId) {
  bm25ActiveMode = modeId;
  document.querySelectorAll('.mode-tab').forEach(tab => tab.classList.toggle('active', tab.id === `mtab-${modeId}`));
  const mode = bm25Modes[modeId];
  if (!mode) return;
  bm25Params = { ...bm25Params, k1: mode.k1, b: mode.b, lambda: mode.lambda, ctx: mode.contextBonus };
  ['k1', 'b', 'lambda'].forEach(key => { const input = document.getElementById(`p-${key}`); const value = document.getElementById(`v-${key}`); if (input) input.value = mode[key]; if (value) value.textContent = Number(mode[key]).toFixed(2); });
  const ctx = document.getElementById('p-ctx'); const ctxValue = document.getElementById('v-ctx'); if (ctx) ctx.value = mode.contextBonus; if (ctxValue) ctxValue.textContent = Number(mode.contextBonus).toFixed(2);
  const description = document.getElementById('mode-desc'); if (description) description.value = mode.description || '';
  bm25Keywords = (mode.keywords || []).map(keyword => ({ term: keyword.term, weight: keyword.weight, synonyms: (keyword.synonyms || []).join(',') }));
  renderKeywords();
}
function updateBM25ModeDescription(value) { if (bm25Modes[bm25ActiveMode]) bm25Modes[bm25ActiveMode].description = value; }
function syncParam(key, value) { const parsed = key === 'limit' ? Number.parseInt(value, 10) : Number.parseFloat(value); bm25Params[key] = Number.isFinite(parsed) ? parsed : 0; const output = document.getElementById(`v-${key}`); if (output) output.textContent = String(bm25Params[key]); }
function renderKeywords() {
  const list = document.getElementById('kw-list');
  if (!list) return;
  list.innerHTML = bm25Keywords.map((keyword, index) => `<div class="kw-row"><input class="kw-term" value="${esc(keyword.term)}" oninput="bm25Keywords[${index}].term=this.value"><input class="kw-weight" type="number" value="${keyword.weight}" oninput="bm25Keywords[${index}].weight=parseFloat(this.value)||1"><input class="kw-syn" value="${esc(keyword.synonyms || '')}" oninput="bm25Keywords[${index}].synonyms=this.value"><button type="button" onclick="removeKeyword(${index})">Remove</button></div>`).join('');
}
function addKeyword() { bm25Keywords.push({ term: '', weight: 1, synonyms: '' }); renderKeywords(); }
function removeKeyword(index) { bm25Keywords.splice(index, 1); renderKeywords(); }
function updateBM25SourceInfo() { const output = document.getElementById('bm25-source-info'); if (!output) return; const source = document.querySelector('input[name="bm25src"]:checked')?.value || 'articles'; output.textContent = source === 'cards' ? `Saved cards: ${allCards.length}` : 'Collected articles'; }
async function updateArticleAutoStatus() { const output = document.getElementById('article-auto-status'); if (!output) return; try { const status = await api.get('/api/scheduler/status'); output.textContent = `${status.articleCount || 0} articles`; } catch { output.textContent = 'Status unavailable'; } }
async function refreshInputArticlesNow() { try { await api.post('/api/articles/refresh', { background: true }); await updateArticleAutoStatus(); } catch (error) { toast(error.message, 'warn'); } }
async function runBM25() {
  const button = document.getElementById('bm25-run-btn');
  if (button) button.disabled = true;
  try {
    const source = document.querySelector('input[name="bm25src"]:checked')?.value || 'articles';
    const keywords = bm25Keywords.filter(keyword => keyword.term.trim()).map(keyword => ({ term: keyword.term.trim(), weight: keyword.weight, synonyms: (keyword.synonyms || '').split(',').map(value => value.trim()).filter(Boolean) }));
    const mode = bm25Modes[bm25ActiveMode] || {};
    const payload = { modeId: bm25ActiveMode || 'custom', config: { label: mode.label || 'Custom', description: mode.description || '', k1: bm25Params.k1, b: bm25Params.b, lambda: bm25Params.lambda, contextBonus: bm25Params.ctx, keywords }, options: { dedupThreshold: bm25Params.dedup, archiveScoreThreshold: bm25Params.arch, resultLimit: bm25Params.limit } };
    if (source === 'cards') payload.articles = (await api.get('/api/cards')).map(card => ({ id: card.id, title: card.title, body: `${card.summary || ''} ${card.body}`, publishedAt: card.createdAt, sourceAuthority: 0.8, url: card.url || '', tokens: card.tokens, docLength: card.docLength, tags: card.tags }));
    bm25Result = await api.post('/api/run', payload);
    renderBM25Result();
  } catch (error) { toast(error.message, 'warn'); }
  finally { if (button) { button.disabled = false; button.textContent = 'Run'; } }
}
function renderBM25Result() {
  const body = document.getElementById('bm25-result-body'); if (!body || !bm25Result) return;
  const items = showArchived ? (bm25Result.archived || []).map(item => ({ ...item, _archived: true })) : (bm25Result.active || []);
  const maxScore = items.length ? Number(items[0].score || 1) : 1;
  body.innerHTML = items.length ? items.map((item, index) => { const article = item.article || item; const score = Number(item.score || 0); return `<article class="score-card"><div class="score-card-header"><span class="score-badge">${item._archived ? 'ARCHIVED' : `#${index + 1} ${score.toFixed(2)}`}</span><div class="score-title">${esc(article.title || '')}</div></div>${item._archived ? '' : `<div class="score-bar"><div class="score-bar-fill" style="width:${Math.min(100, score / maxScore * 100)}%"></div></div>`}<p>${esc(String(article.summary || article.body || '').slice(0, 220))}</p><div class="score-actions"><button class="btn btn-secondary btn-sm" onclick="saveOneAsCard('${esc(article.id)}')">Save as card</button></div></article>`; }).join('') : '<div class="empty-state"><p>No results</p></div>';
  const actions = document.getElementById('bm25-result-actions'); if (actions) actions.style.display = 'flex';
}
function toggleArchived() { showArchived = !showArchived; renderBM25Result(); }
async function saveTopAsCards() { for (const item of (bm25Result?.active || []).slice(0, bm25Params.limit)) { await saveOneAsCard(item.article.id); } await loadCards(); }
async function saveOneAsCard(articleId) { const item = (bm25Result?.active || []).concat(bm25Result?.archived || []).find(result => result.article?.id === articleId); const article = item?.article || allCards.find(card => card.id === articleId); if (!article) return; await api.post('/api/cards', { title: article.title, body: article.body, summary: article.summary, url: article.url, tags: article.tags || [], type: 'article' }); toast('Saved as card'); await loadCards(); }
function showScoreDetail() { toast('Score details are available in the API response'); }
document.querySelectorAll('input[name="bm25src"]').forEach(input => input.addEventListener('change', updateBM25SourceInfo));
