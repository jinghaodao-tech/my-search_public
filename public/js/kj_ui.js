//  KJ法ボード
// ════════════════════════════════════════
async function loadKJBoard(){kjData=await api.get('/api/kj/groups');renderKJBoard()}
function renderKJBoard(){
  const canvas=document.getElementById('kj-canvas');
  let html=kjData.groups.map(g=>{
    const cardHtml=g.cards.map(c=>renderKJCard(c,g.color)).join('');
    return `<div class="kj-group-col" data-group-id="${g.id}">
      <div class="kj-group-header" style="background:${g.color}22;border-bottom:2px solid ${g.color}">
        <span class="kj-group-name" style="color:${g.color}">${esc(g.name)}</span>
        <span style="font-size:11px;color:var(--text-dim)">${g.cards.length}</span>
        <button class="btn-icon btn-sm" onclick="editGroup('${g.id}','${esc(g.name)}')">✏️</button>
        <button class="btn-icon btn-sm" onclick="deleteGroup('${g.id}')">🗑</button>
      </div>
      <div class="kj-group-body kj-drop-zone" data-group-id="${g.id}" ondragover="kjDragOver(event)" ondrop="kjDrop(event,'${g.id}')">
        ${cardHtml}${!g.cards.length?'<div style="font-size:12px;color:var(--text-dim);text-align:center;padding:12px">カードをここへ</div>':''}
      </div></div>`;
  }).join('');
  const ugHtml=kjData.ungrouped.map(c=>renderKJCard(c,null)).join('');
  html+=`<div class="kj-ungrouped-col"><div class="kj-group-header" style="border-bottom:1px dashed var(--border)">
    <span class="kj-group-name" style="color:var(--text-dim)">未グループ</span>
    <span style="font-size:11px;color:var(--text-dim)">${kjData.ungrouped.length}</span></div>
    <div class="kj-group-body kj-drop-zone" data-group-id="__none__" ondragover="kjDragOver(event)" ondrop="kjDrop(event,'__none__')">${ugHtml}</div></div>`;
  canvas.innerHTML=html;
}
function renderKJCard(card,col){
  const bc=col||'var(--border)';
  const tags=card.tags.slice(0,3).map(t=>`<span class="kj-card-tag">${esc(t)}</span>`).join('');
  return `<div class="kj-card" draggable="true" data-card-id="${card.id}" style="border-left-color:${bc}"
    ondragstart="kjDragStart(event,'${card.id}')" ondragend="kjDragEnd(event)"
    onclick="selectCard('${card.id}');switchView('cards')">
    <div class="kj-card-title">${esc(card.title)}</div>
    ${tags?`<div class="kj-card-tags">${tags}</div>`:''}
  </div>`;
}
function kjDragStart(e,id){dragCardId=id;e.currentTarget.classList.add('dragging');e.dataTransfer.effectAllowed='move'}
function kjDragEnd(e){e.currentTarget.classList.remove('dragging');document.querySelectorAll('.kj-drop-zone').forEach(z=>z.classList.remove('drag-over'))}
function kjDragOver(e){e.preventDefault();e.currentTarget.classList.add('drag-over')}
async function kjDrop(e,gid){
  e.preventDefault();e.currentTarget.classList.remove('drag-over');if(!dragCardId)return;
  if(gid==='__none__') await api.put(`/api/cards/${dragCardId}`,{kjGroupId:null});
  else await api.post(`/api/kj/groups/${gid}/cards`,{cardId:dragCardId});
  dragCardId=null; await loadKJBoard();
}
function openNewGroupModal(){
  document.getElementById('group-name').value=''; document.getElementById('group-desc').value='';
  selectedGroupColor=COLORS[0]; updateColorStrip('group-color-strip',selectedGroupColor,c=>selectedGroupColor=c);
  openModal('modal-group'); setTimeout(()=>document.getElementById('group-name').focus(),100);
}
async function submitGroup(){
  const name=document.getElementById('group-name').value.trim();
  if(!name){toast('グループ名を入力してください','warn');return;}
  await api.post('/api/kj/groups',{name,description:document.getElementById('group-desc').value,color:selectedGroupColor});
  closeModal('modal-group'); toast('グループを作成しました'); await loadKJBoard();
}
async function editGroup(id,cur){const name=prompt('グループ名を変更:',cur);if(!name||name===cur)return;await api.put(`/api/kj/groups/${id}`,{name});await loadKJBoard()}
async function deleteGroup(id){if(!confirm('グループを削除しますか？（カードは未グループになります）'))return;await api.del(`/api/kj/groups/${id}`);toast('削除しました');await loadKJBoard()}

// ════════════════════════════════════════
