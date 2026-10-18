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
  if (document.getElementById('search-order')) document.getElementById('search-order').value = mode.lambda ? 'custom' : 'relevance';
}
function updateBM25ModeDescription(value) { if (bm25Modes[bm25ActiveMode]) bm25Modes[bm25ActiveMode].description = value; }
function syncParam(key, value) { const parsed = key === 'limit' ? Number.parseInt(value, 10) : Number.parseFloat(value); bm25Params[key] = Number.isFinite(parsed) ? parsed : 0; const output = document.getElementById(`v-${key}`); if (output) output.textContent = String(bm25Params[key]); }
function renderKeywords() {
  const list = document.getElementById('kw-list');
  if (!list) return;
  const simple = document.getElementById('search-terms');
  if (simple) simple.value = bm25Keywords.map(keyword => keyword.term).filter(Boolean).join(' ');
  // the box now shows exactly these keywords: searching it again keeps their weights
  if (simple && typeof searchKeywordsText !== 'undefined') searchKeywordsText = simple.value.trim();
  list.innerHTML = bm25Keywords.map((keyword, index) => `<div class="kw-row"><input class="kw-term" value="${esc(keyword.term)}" oninput="bm25Keywords[${index}].term=this.value; syncSimpleTerms()"><input class="kw-weight" type="number" value="${keyword.weight}" oninput="bm25Keywords[${index}].weight=parseFloat(this.value)||1"><input class="kw-syn" value="${esc(keyword.synonyms || '')}" oninput="bm25Keywords[${index}].synonyms=this.value"><button type="button" onclick="removeKeyword(${index})">Remove</button></div>`).join('');
}
function addKeyword() { bm25Keywords.push({ term: '', weight: 1, synonyms: '' }); renderKeywords(); }
function removeKeyword(index) { bm25Keywords.splice(index, 1); renderKeywords(); }
function updateBM25SourceInfo() { const output = document.getElementById('bm25-source-info'); if (!output) return; const source = document.querySelector('input[name="bm25src"]:checked')?.value || 'articles'; output.textContent = source === 'cards' ? `Saved cards: ${allCards.length}` : 'Collected articles'; }
async function updateArticleAutoStatus() { const output = document.getElementById('article-auto-status'); if (!output) return; try { const status = await api.get('/api/scheduler/status'); output.textContent = `${status.articleCount || 0} articles`; } catch { output.textContent = 'Status unavailable'; } }
async function refreshInputArticlesNow() { try { await api.post('/api/articles/refresh', { background: true }); await updateArticleAutoStatus(); } catch (error) { toast(error.message, 'warn'); } }
