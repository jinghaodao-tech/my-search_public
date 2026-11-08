//  カードグリッド
// ════════════════════════════════════════
function renderCardGrid() {
  const grid = document.getElementById('card-grid');
  document.getElementById('count-badge').textContent = `${allCards.length}件`;
  if (!allCards.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="icon">📭</div><p>${currentFilter.archived?'アーカイブされたカードはありません':'カードがありません'}</p>${currentFilter.archived?'':'<button class="btn btn-primary btn-sm" onclick="openNewCardModal()">メモを作成</button>'}</div>`;
    return;
  }
  if (typeof cardLayout !== 'undefined' && cardLayout === 'table') { renderCardTable(grid); return; }
  grid.classList.remove('as-table');
  grid.innerHTML = allCards.map(card => {
    const safeColor = /^(#[a-fA-F0-9]{3,8}|[a-zA-Z]{1,30}|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\))$/.test(card.color || '') ? card.color : '';
    const strip = safeColor ? `<div class="card-color-strip" style="background:${esc(safeColor)}"></div>` : '';
    const typeMap = {article:'📰 記事',memo:'📝 メモ',csv:'📊 CSV'};
    const typeCls = `card-type-${card.type}`;
    const tagHtml = card.tags.slice(0,4).map(t=>`<span class="card-tag">${esc(t)}</span>`).join('');
    const moreTags = card.tags.length>4 ? `<span class="card-tag">+${card.tags.length-4}</span>` : '';
    const links = Array.isArray(card.links) ? card.links : [];
    const sourceText = showCardSummaries && card.summary ? card.summary : ((typeof memoPreviewText === 'function' && memoPreviewText(card.body)) || card.body);
    const disp = esc(sourceText||'').slice(0,120)+((sourceText||'').length>120?'...':'');
    const date = new Date(card.createdAt).toLocaleDateString('ja-JP',{month:'short',day:'numeric'});
    const restoreButton = currentFilter.archived
      ? `<button class="btn-icon btn-sm" onclick="event.stopPropagation();restoreOne(${jsArg(card.id)})" title="復元">↩</button>`
      : '';
    return `<div class="card ${selectedCards.has(card.id)?'selected':''}" id="card-${esc(card.id)}" onclick="cardClick(${jsArg(card.id)})">
      ${strip}
      <div style="display:flex;align-items:center;gap:6px">
        <span class="card-type-badge ${typeCls}">${typeMap[card.type]??card.type}</span>
        <div class="card-actions">
          ${restoreButton}
          <button class="btn-icon btn-sm" onclick="event.stopPropagation();selectCard(${jsArg(card.id)})" title="詳細" aria-label="${esc(card.title)} の詳細">ⓘ</button>
          <button class="btn-icon btn-sm needs-ai" onclick="event.stopPropagation();summarizeOne(${jsArg(card.id)})" title="AI要約">⚡</button>
        </div>
      </div>
      <div class="card-title">${esc(card.title)}</div>
      ${disp?`<div class="card-summary">${disp}</div>`:''}
      ${card.tags.length?`<div class="card-tags">${tagHtml}${moreTags}</div>`:''}
      <div class="card-footer">
        ${links.length?`<span style="font-size:11px;color:var(--text-dim)">🔗 ${links.length}</span>`:''}
        <span class="card-date">${date}</span>
      </div>
    </div>`;
  }).join('');
}

function toggleMultiSelect() {
  multiSelectMode = !multiSelectMode;
  selectedCards.clear();
  if (multiSelectMode) closeDetail();
  renderCardGrid();
  updateSelectedUI();
}

function cardClick(id) {
  if (!multiSelectMode) {
    void openReaderForCard(id);
    return;
  }
  if (selectedCards.has(id)) selectedCards.delete(id);
  else selectedCards.add(id);
  updateSelectedUI();
}

function updateSelectedUI() {
  document.querySelectorAll('#card-grid .card').forEach(card => {
    card.classList.toggle('selected', selectedCards.has(card.id.replace('card-', '')));
  });
  const count = selectedCards.size;
  document.getElementById('count-badge').textContent =
    multiSelectMode ? `${count}件選択中 / ${allCards.length}件` : `${allCards.length}件`;
  document.getElementById('multi-select-btn').textContent = multiSelectMode ? '選択終了' : '選択';
  document.getElementById('bulk-archive-btn').style.display =
    multiSelectMode && !currentFilter.archived ? '' : 'none';
  document.getElementById('bulk-restore-btn').style.display =
    multiSelectMode && currentFilter.archived ? '' : 'none';
  document.getElementById('bulk-export-md-btn').style.display = multiSelectMode ? '' : 'none';
  document.getElementById('bulk-delete-btn').style.display = multiSelectMode ? '' : 'none';
  document.getElementById('bulk-archive-btn').disabled = count === 0;
  document.getElementById('bulk-restore-btn').disabled = count === 0;
  document.getElementById('bulk-export-md-btn').disabled = count === 0;
  document.getElementById('bulk-delete-btn').disabled = count === 0;
}

async function archiveSelected() {
  if (!selectedCards.size) return;
  await api.post('/api/cards/bulk-archive', { ids: [...selectedCards] });
  selectedCards.clear();
  await Promise.all([loadCards(), loadTags()]);
  toast('選択したカードをアーカイブしました');
}

async function restoreOne(id) {
  await api.post(`/api/cards/${id}/restore`, {});
  selectedCards.delete(id);
  await Promise.all([loadCards(), loadTags()]);
  toast('カードを復元しました');
}

async function restoreSelected() {
  if (!selectedCards.size) return;
  await api.post('/api/cards/bulk-restore', { ids: [...selectedCards] });
  selectedCards.clear();
  await Promise.all([loadCards(), loadTags()]);
  toast('選択したカードを復元しました');
}

async function deleteSelected() {
  if (!selectedCards.size) return;
  if (!confirm(`${selectedCards.size}件のカードを削除しますか？`)) return;
  await api.post('/api/cards/bulk-delete', { ids: [...selectedCards] });
  selectedCards.clear();
  await Promise.all([loadCards(), loadTags()]);
  toast('選択したカードを削除しました');
}

async function exportSelectedMarkdown() {
  if (!selectedCards.size) return;
  let response;
  try {
    response = await api.download('/api/cards/export-md-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedCards] }),
    });
  } catch (error) {
    toast(error.message || 'Export failed');
    return;
  }
  const blob = response.blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const disposition = response.headers.get('Content-Disposition') || '';
  const filename = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  a.href = url;
  a.download = filename ? decodeURIComponent(filename) : 'cards-markdown.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`${selectedCards.size}件のMarkdownを書き出しました`);
}

function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function jsArg(value) { return esc(JSON.stringify(String(value ?? ''))); }
function safeLinkUrl(value) { try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; } }

function escapeRegExp(s){return String(s??'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}

function resultKeywords(item) {
  const fromMeta = item?.matchedKeywords || [];
  const fromBreakdown = item?.breakdown?.matchedTerms?.map(t=>t.term) || [];
  const seen = new Set();
  return [...fromMeta, ...fromBreakdown]
    .map(k=>String(k??'').trim())
    .filter(k=>{
      const key = k.toLocaleLowerCase();
      if(!k || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a,b)=>b.length-a.length)
    .slice(0,10);
}

function highlightSearchText(text, keywords) {
  const source = String(text??'');
  const terms = (keywords||[]).filter(Boolean);
  if(!terms.length) return esc(source);
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  return source.split(pattern).map(part=>{
    const matched = terms.some(term=>part.toLocaleLowerCase()===term.toLocaleLowerCase());
    return matched ? `<mark class="search-mark">${esc(part)}</mark>` : esc(part);
  }).join('');
}

// ════════════════════════════════════════
//  タグ・フィルター
// ════════════════════════════════════════
let tagSort = 'count';
let showAllTags = false;
const TAG_PREVIEW = 15;
try { if (localStorage.getItem('tagSort') === 'name') tagSort = 'name'; } catch { /* storage unavailable */ }
function visibleTags() {
  const q = (document.getElementById('tag-search')?.value || '').trim().toLowerCase();
  const list = allTags.filter(({ tag }) => !q || tag.toLowerCase().includes(q));
  if (tagSort === 'name') list.sort((a, b) => a.tag.localeCompare(b.tag, 'ja'));
  return list;
}
function renderTagCloud() {
  const cloud = document.getElementById('tag-cloud');
  const searching = !!(document.getElementById('tag-search')?.value || '').trim();
  const list = visibleTags();
  const shown = showAllTags || searching ? list : list.slice(0, TAG_PREVIEW);
  if (currentFilter.tag && !shown.some(t => t.tag === currentFilter.tag)) {
    const active = allTags.find(t => t.tag === currentFilter.tag);
    if (active) shown.unshift(active);
  }
  document.getElementById('tag-count').textContent = currentFilter.tag ? `(絞込: ${currentFilter.tag})` : `(${allTags.length})`;
  cloud.innerHTML = shown.map(({tag,count})=>
    `<span class="tag-pill ${currentFilter.tag===tag?'active':''}" onclick="filterTag(${jsArg(tag)})">${esc(tag)} <small>${count}</small></span>`
  ).join('') || '<span class="muted" style="font-size:12px">該当するタグはありません</span>';
  const more = document.getElementById('tag-more');
  if (more) {
    more.style.display = !searching && list.length > TAG_PREVIEW ? '' : 'none';
    more.textContent = showAllTags ? '少なく表示' : `すべて表示（${list.length}）`;
  }
  const sortBtn = document.getElementById('tag-sort-btn');
  if (sortBtn) sortBtn.textContent = tagSort === 'name' ? '名前順' : '件数順';
}
function toggleTagSort() {
  tagSort = tagSort === 'count' ? 'name' : 'count';
  try { localStorage.setItem('tagSort', tagSort); } catch { /* storage unavailable */ }
  renderTagCloud();
}
function toggleAllTags() { showAllTags = !showAllTags; renderTagCloud(); }
function filterTag(tag) { currentFilter.tag = currentFilter.tag===tag?null:tag; renderTagCloud(); loadCards(); }
function filterType(type,el) { currentFilter.type=type; document.querySelectorAll('#card-type-filter .type-btn').forEach(b=>b.classList.remove('active')); el.classList.add('active'); loadCards(); }
let cardSearchDebounce = null;
function onSearch(q) {
  currentFilter.q=q;
  cardListSearchCaptureRequested = true;
  clearTimeout(cardSearchDebounce);
  cardSearchDebounce = setTimeout(() => loadCards(), 180);
}
function filterArchived(archived) {
  currentFilter.archived = archived;
  selectedCards.clear();
  multiSelectMode = false;
  closeDetail();
  document.getElementById('normal-filter-btn').classList.toggle('active', !archived);
  document.getElementById('archive-filter-btn').classList.toggle('active', archived);
  document.getElementById('view-title').textContent = archived ? 'アーカイブ一覧' : 'カード一覧';
  loadCards();
}

// ════════════════════════════════════════
//  カード詳細パネル
// ════════════════════════════════════════
async function selectCard(id) {
  currentCardId = id;
  document.querySelectorAll('.card').forEach(c=>c.classList.remove('selected'));
  const el = document.getElementById(`card-${id}`); if(el) el.classList.add('selected');
  const data = await api.get(`/api/cards/${id}`);
  renderDetailPanel(data);
  document.getElementById('detail-panel').classList.remove('hidden');
}
function closeDetail() {
  currentCardId=null;
  document.getElementById('detail-panel').classList.add('hidden');
  document.querySelectorAll('.card').forEach(c=>c.classList.remove('selected'));
}
function exportMarkdown(id) {
  if(!id) return;
  window.open(`/api/cards/${encodeURIComponent(id)}/export-md`, '_blank');
}
// Reader cards: show the memo formatted (quotes, tables) and the source; the copied text stays in the reader.
function renderDetailBody(card) {
  const parts = typeof splitReaderBody === 'function' ? splitReaderBody(card.body) : null;
  if (!parts) return `<div class="detail-section"><h4>本文</h4><div class="detail-body-text">${esc(card.body).slice(0,400)}${card.body.length>400?'...':''}</div></div>`;
  const source = parts.sourceLines.map(line => `<div>${esc(line.replace(/^- /, ''))}</div>`).join('');
  return `<div class="detail-section"><h4>メモ</h4><div class="memo-view">${parts.memo ? renderMemoHtml(parts.memo) : '<span style="color:var(--text-dim)">（なし）</span>'}</div></div>`
    + `<div class="detail-section"><h4>出典</h4><div class="detail-source">${source}</div></div>`;
}
function renderDetailPanel(card) {
  document.getElementById('detail-title').textContent = card.title;
  const linksHtml = (card.links||[]).map(lid=>{
    const lc = allCards.find(c=>c.id===lid); if(!lc) return '';
    return `<div class="linked-card" onclick="selectCard(${jsArg(lid)})"><span>📇 ${esc(lc.title)}</span><button class="btn-icon btn-sm" onclick="event.stopPropagation();unlinkCard(${jsArg(card.id)},${jsArg(lid)})">✕</button></div>`;
  }).join('');
  const backHtml = (card.backlinks||[]).map(bl=>`<div class="linked-card" onclick="selectCard(${jsArg(bl.id)})"><span>← ${esc(bl.title)}</span></div>`).join('');
  const tagsHtml = (card.tags||[]).map(t=>`<span class="tag-edit-pill">${esc(t)}</span>`).join('');
  document.getElementById('detail-body').innerHTML = `
    ${safeLinkUrl(card.url)?`<div class="detail-section detail-url"><h4>リンク</h4><a href="${esc(safeLinkUrl(card.url))}" target="_blank" rel="noopener noreferrer">🔗 ${esc(card.url)}</a></div>`:''}
    <div class="detail-section">
      <h4>AI要約${card.summary?'':'<span style="color:var(--text-dim);font-weight:400"> (未生成)</span>'}</h4>
      ${card.summary?`<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><button class="btn btn-secondary btn-sm" onclick="deleteSummary(${jsArg(card.id)})">要約を削除</button></div><div class="detail-summary">${esc(card.summary)}</div>`:`<button class="btn btn-secondary btn-sm needs-ai" onclick="summarizeOne(${jsArg(card.id)})">⚡ AI要約を生成</button>`}
    </div>
    ${renderDetailBody(card)}
    <div class="detail-section">
      <h4>タグ</h4>
      <div class="tag-edit">${tagsHtml||'<span style="color:var(--text-dim)">タグなし</span>'}</div>
    </div>
    <div class="detail-section">
      <h4>Zettelkastenリンク (${(card.links||[]).length})</h4>
      ${linksHtml||'<div style="font-size:12px;color:var(--text-dim)">リンクなし</div>'}
      <div class="link-search" style="margin-top:8px">
        <input type="text" id="link-search" placeholder="リンク先を検索..." oninput="searchLinkCandidates(this.value,'${card.id}')">
      </div>
      <div class="link-candidates" id="link-candidates"></div>
    </div>
    ${backHtml?`<div class="detail-section"><h4>バックリンク (${(card.backlinks||[]).length})</h4>${backHtml}</div>`:''}`;
}
function searchLinkCandidates(q,currentId) {
  const box=document.getElementById('link-candidates');
  const cur=allCards.find(c=>c.id===currentId);
  if(!q.trim()){box.innerHTML='';return;}
  const res=allCards.filter(c=>c.id!==currentId&&!(cur?.links||[]).includes(c.id)&&(c.title.toLowerCase().includes(q.toLowerCase())||c.tags.some(t=>t.includes(q)))).slice(0,8);
  box.innerHTML=res.map(c=>`<div class="link-candidate" onclick="addLink(${jsArg(currentId)},${jsArg(c.id)})">📇 ${esc(c.title)}</div>`).join('')||'<div class="link-candidate" style="color:var(--text-dim)">該当なし</div>';
}
async function addLink(id1,id2) {
  await api.post(`/api/cards/${id1}/links`,{targetId:id2});
  toast('リンクを追加しました'); document.getElementById('link-search').value=''; document.getElementById('link-candidates').innerHTML='';
  await loadCards(); selectCard(id1);
}
async function unlinkCard(id1,id2) {
  await api.del(`/api/cards/${id1}/links/${id2}`); toast('リンクを解除しました'); await loadCards(); selectCard(id1);
}

// ════════════════════════════════════════
//  新規カード・削除
// ════════════════════════════════════════
function openNewCardModal() {
  openPlainCardEditor();
}

// ════════════════════════════════════════
document.addEventListener('click', event => {
  const link = event.target?.closest?.('.memo-source-link');
  if (!link) return;
  event.preventDefault();
  let sourceCardId;
  try { sourceCardId = decodeURIComponent(link.dataset.sourceId || ''); } catch { return; }
  const sourceHash = link.dataset.sourceHash || '';
  const paragraphIndex = Number(link.dataset.sourceParagraph) - 1;
  if (!sourceCardId || !/^[a-f0-9]{64}$/.test(sourceHash) || !Number.isInteger(paragraphIndex) || paragraphIndex < 0) return;
  void jumpToCrossCardSource(sourceCardId, sourceHash, paragraphIndex);
});
