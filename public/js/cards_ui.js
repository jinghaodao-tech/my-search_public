//  カードグリッド
// ════════════════════════════════════════
function renderCardGrid() {
  const grid = document.getElementById('card-grid');
  document.getElementById('count-badge').textContent = `${allCards.length}件`;
  if (!allCards.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="icon">📭</div><p>${currentFilter.archived?'アーカイブされたカードはありません':'カードがありません'}</p>${currentFilter.archived?'':'<button class="btn btn-primary btn-sm" onclick="openNewCardModal()">メモを作成</button>'}</div>`;
    return;
  }
  grid.innerHTML = allCards.map(card => {
    const strip = card.color ? `<div class="card-color-strip" style="background:${card.color}"></div>` : '';
    const typeMap = {article:'📰 記事',memo:'📝 メモ',csv:'📊 CSV'};
    const typeCls = `card-type-${card.type}`;
    const tagHtml = card.tags.slice(0,4).map(t=>`<span class="card-tag">${esc(t)}</span>`).join('');
    const moreTags = card.tags.length>4 ? `<span class="card-tag">+${card.tags.length-4}</span>` : '';
    const sourceText = showCardSummaries && card.summary ? card.summary : card.body;
    const disp = esc(sourceText||'').slice(0,120)+((sourceText||'').length>120?'...':'');
    const date = new Date(card.createdAt).toLocaleDateString('ja-JP',{month:'short',day:'numeric'});
    const restoreButton = currentFilter.archived
      ? `<button class="btn-icon btn-sm" onclick="event.stopPropagation();restoreOne('${card.id}')" title="復元">↩</button>`
      : '';
    return `<div class="card ${selectedCards.has(card.id)?'selected':''}" id="card-${card.id}" onclick="cardClick('${card.id}')">
      ${strip}
      <div style="display:flex;align-items:center;gap:6px">
        <span class="card-type-badge ${typeCls}">${typeMap[card.type]??card.type}</span>
        <div class="card-actions">
          ${restoreButton}
          <button class="btn-icon btn-sm" onclick="event.stopPropagation();openEditModal('${card.id}')" title="編集">✏️</button>
          <button class="btn-icon btn-sm" onclick="event.stopPropagation();summarizeOne('${card.id}')" title="AI要約">⚡</button>
        </div>
      </div>
      <div class="card-title">${esc(card.title)}</div>
      ${disp?`<div class="card-summary">${disp}</div>`:''}
      ${card.tags.length?`<div class="card-tags">${tagHtml}${moreTags}</div>`:''}
      <div class="card-footer">
        ${card.links.length?`<span style="font-size:11px;color:var(--text-dim)">🔗 ${card.links.length}</span>`:''}
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
    selectCard(id);
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
  const response = await fetch('/api/cards/export-md-bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [...selectedCards] }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Export failed' }));
    toast(error.error || 'Export failed');
    return;
  }
  const blob = await response.blob();
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
function renderTagCloud() {
  const cloud = document.getElementById('tag-cloud');
  document.getElementById('tag-count').textContent = `(${allTags.length})`;
  cloud.innerHTML = allTags.map(({tag,count})=>
    `<span class="tag-pill ${currentFilter.tag===tag?'active':''}" onclick="filterTag('${esc(tag)}')">${esc(tag)} <small>${count}</small></span>`
  ).join('');
}
function filterTag(tag) { currentFilter.tag = currentFilter.tag===tag?null:tag; renderTagCloud(); loadCards(); }
function filterType(type,el) { currentFilter.type=type; document.querySelectorAll('#card-type-filter .type-btn').forEach(b=>b.classList.remove('active')); el.classList.add('active'); loadCards(); }
function onSearch(q) { currentFilter.q=q; loadCards(); }
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
function renderDetailPanel(card) {
  document.getElementById('detail-title').textContent = card.title;
  const linksHtml = (card.links||[]).map(lid=>{
    const lc = allCards.find(c=>c.id===lid); if(!lc) return '';
    return `<div class="linked-card" onclick="selectCard('${lid}')"><span>📇 ${esc(lc.title)}</span><button class="btn-icon btn-sm" onclick="event.stopPropagation();unlinkCard('${card.id}','${lid}')">✕</button></div>`;
  }).join('');
  const backHtml = (card.backlinks||[]).map(bl=>`<div class="linked-card" onclick="selectCard('${bl.id}')"><span>← ${esc(bl.title)}</span></div>`).join('');
  const tagsHtml = (card.tags||[]).map(t=>`<span class="tag-edit-pill">${esc(t)}<button onclick="removeTagFromCard('${card.id}','${esc(t)}')">×</button></span>`).join('');
  document.getElementById('detail-body').innerHTML = `
    ${card.url?`<div class="detail-section detail-url"><h4>リンク</h4><a href="${esc(card.url)}" target="_blank">🔗 ${esc(card.url)}</a></div>`:''}
    <div class="detail-section">
      <h4>AI要約${card.summary?'':'<span style="color:var(--text-dim);font-weight:400"> (未生成)</span>'}</h4>
      ${card.summary?`<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><button class="btn btn-secondary btn-sm" onclick="deleteSummary('${card.id}')">Delete</button></div><div class="detail-summary">${esc(card.summary)}</div>`:`<button class="btn btn-secondary btn-sm" onclick="summarizeOne('${card.id}')">⚡ AI要約を生成</button>`}
    </div>
    <div class="detail-section"><h4>本文</h4><div class="detail-body-text">${esc(card.body).slice(0,400)}${card.body.length>400?'...':''}</div></div>
    <div class="detail-section">
      <h4>タグ</h4>
      <div class="tag-edit">${tagsHtml}</div>
      <div class="tag-input-row" style="margin-top:8px">
        <input type="text" id="tag-add-input" placeholder="タグ追加..." onkeydown="if(event.key==='Enter')addTagToCard('${card.id}')">
        <button class="btn btn-secondary btn-sm" onclick="addTagToCard('${card.id}')">追加</button>
      </div>
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
async function addTagToCard(cardId) {
  const inp=document.getElementById('tag-add-input'); const tag=inp.value.trim(); if(!tag) return;
  const card=allCards.find(c=>c.id===cardId); if(!card) return;
  await api.put(`/api/cards/${cardId}`,{tags:[...new Set([...card.tags,tag])]});
  inp.value=''; await Promise.all([loadCards(),loadTags()]); selectCard(cardId);
}
async function removeTagFromCard(cardId,tag) {
  const card=allCards.find(c=>c.id===cardId); if(!card) return;
  await api.put(`/api/cards/${cardId}`,{tags:card.tags.filter(t=>t!==tag)});
  await Promise.all([loadCards(),loadTags()]); selectCard(cardId);
}
function searchLinkCandidates(q,currentId) {
  const box=document.getElementById('link-candidates');
  const cur=allCards.find(c=>c.id===currentId);
  if(!q.trim()){box.innerHTML='';return;}
  const res=allCards.filter(c=>c.id!==currentId&&!(cur?.links||[]).includes(c.id)&&(c.title.toLowerCase().includes(q.toLowerCase())||c.tags.some(t=>t.includes(q)))).slice(0,8);
  box.innerHTML=res.map(c=>`<div class="link-candidate" onclick="addLink('${currentId}','${c.id}')">📇 ${esc(c.title)}</div>`).join('')||'<div class="link-candidate" style="color:var(--text-dim)">該当なし</div>';
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
//  新規カード・編集・削除
// ════════════════════════════════════════
function openNewCardModal() {
  selectedNewColor=null;
  ['new-title','new-body','new-url','new-tags'].forEach(id=>document.getElementById(id).value='');
  updateColorStrip('new-color-strip',null,c=>selectedNewColor=c);
  openModal('modal-new'); setTimeout(()=>document.getElementById('new-title').focus(),100);
}
async function submitNewCard() {
  const title=document.getElementById('new-title').value.trim();
  if(!title){toast('タイトルを入力してください','warn');return;}
  const tags=document.getElementById('new-tags').value.trim().split(/\s+/).filter(Boolean);
  await api.post('/api/cards',{title,body:document.getElementById('new-body').value,url:document.getElementById('new-url').value||undefined,tags,color:selectedNewColor||undefined,type:'memo'});
  closeModal('modal-new'); toast('カードを作成しました'); await Promise.all([loadCards(),loadTags()]);
}
async function openEditModal(id) {
  const card=allCards.find(c=>c.id===id)||await api.get(`/api/cards/${id}`);
  document.getElementById('edit-id').value=card.id;
  document.getElementById('edit-title').value=card.title;
  document.getElementById('edit-body').value=card.body;
  document.getElementById('edit-url').value=card.url??'';
  document.getElementById('edit-tags').value=card.tags.join(' ');
  selectedEditColor=card.color||null; updateColorStrip('edit-color-strip',selectedEditColor,c=>selectedEditColor=c);
  openModal('modal-edit');
}
async function submitEdit() {
  const id=document.getElementById('edit-id').value;
  const tags=document.getElementById('edit-tags').value.trim().split(/\s+/).filter(Boolean);
  await api.put(`/api/cards/${id}`,{title:document.getElementById('edit-title').value,body:document.getElementById('edit-body').value,url:document.getElementById('edit-url').value||undefined,tags,color:selectedEditColor||undefined});
  closeModal('modal-edit'); toast('保存しました'); await Promise.all([loadCards(),loadTags()]);
  if(currentCardId===id) selectCard(id);
}
async function confirmDelete() {
  const id=document.getElementById('edit-id').value;
  if(!confirm('このカードを削除しますか？')) return;
  await api.del(`/api/cards/${id}`); closeModal('modal-edit');
  if(currentCardId===id) closeDetail(); toast('削除しました'); await Promise.all([loadCards(),loadTags()]);
}

// ════════════════════════════════════════
