//  モバイル用カード編集パネル
// ════════════════════════════════════════
let mepCardId = null;   // null = 新規作成
let mepZkLinks = [];    // 現在のリンクリスト

function openMobileEdit(cardId) {
  mepCardId = cardId || null;
  mepZkLinks = [];
  const panel = document.getElementById('mobile-edit-panel');
  const delBtn = document.getElementById('mep-del-btn');

  if (cardId) {
    // 既存カード編集
    const card = allCards.find(c => c.id === cardId) || {};
    document.getElementById('mep-title').textContent = card.title || '無題';
    document.getElementById('mep-title-in').value   = card.title || '';
    document.getElementById('mep-body-in').value    = card.body  || '';
    document.getElementById('mep-url-in').value     = card.url   || '';
    document.getElementById('mep-tags-in').value    = (card.tags||[]).join(', ');
    document.getElementById('mep-note-in').value    = card.note  || '';
    mepZkLinks = [...(card.links||[])];
    delBtn.style.display = '';
  } else {
    // 新規
    document.getElementById('mep-title').textContent = '新規メモ';
    ['mep-title-in','mep-body-in','mep-url-in','mep-tags-in','mep-note-in'].forEach(id=>document.getElementById(id).value='');
    mepZkLinks = [];
    delBtn.style.display = 'none';
  }

  renderMepZkLinks();
  panel.classList.add('open');
  document.getElementById('mep-title-in').focus();
}

function renderMepZkLinks(){
  const el = document.getElementById('mep-zk-links');
  el.innerHTML = mepZkLinks.map(lid => {
    const c = allCards.find(x=>x.id===lid);
    return `<span style="font-size:11px;padding:2px 8px;border-radius:5px;background:var(--surface2);
      border:1px solid var(--border);color:var(--accent);display:inline-flex;align-items:center;gap:4px">
      ${esc(c?.title?.slice(0,16)||lid)}
      <button onclick="mepRemLink('${lid}')" style="background:transparent;border:none;cursor:pointer;color:var(--text-dim);font-size:12px">✕</button>
    </span>`;
  }).join('');
}
function mepRemLink(lid){
  mepZkLinks = mepZkLinks.filter(x=>x!==lid);
  renderMepZkLinks();
}
function mepAddLink(){
  const lid = document.getElementById('mep-zk-in').value.trim();
  if(!lid) return;
  if(!allCards.find(c=>c.id===lid)){ toast('カードが見つかりません: '+lid,'warn'); return; }
  if(lid===mepCardId){ toast('自分自身にはリンクできません','warn'); return; }
  if(!mepZkLinks.includes(lid)) mepZkLinks.push(lid);
  document.getElementById('mep-zk-in').value='';
  renderMepZkLinks();
}

async function mepSave(){
  const title = document.getElementById('mep-title-in').value.trim();
  const body  = document.getElementById('mep-body-in').value.trim();
  const url   = document.getElementById('mep-url-in').value.trim();
  const tags  = document.getElementById('mep-tags-in').value.split(',').map(t=>t.trim()).filter(Boolean);
  const note  = document.getElementById('mep-note-in').value.trim();
  if(!title && !body){ toast('タイトルか本文を入力してください','warn'); return; }

  try {
    if(mepCardId){
      // 更新
      await api.put('/api/cards/'+mepCardId, { title: title||body.slice(0,40), body, url, tags, note });
      // ZKリンク同期（既存を一旦全解除→再付与）
      const old = allCards.find(c=>c.id===mepCardId);
      for(const lid of (old?.links||[])) await api.del(`/api/cards/${mepCardId}/links/${lid}`);
      for(const lid of mepZkLinks)        await api.post(`/api/cards/${mepCardId}/links`,{targetId:lid});
      toast('保存しました');
    } else {
      // 新規
      const card = await api.post('/api/cards', { title: title||body.slice(0,40), body, url, tags, note, type:'memo' });
      for(const lid of mepZkLinks) await api.post(`/api/cards/${card.id}/links`,{targetId:lid});
      toast('メモを作成しました');
    }
    await loadCards();
    closeMobileEdit();
  } catch(e) { toast('保存エラー: '+String(e),'warn'); }
}

async function mepDelete(){
  if(!mepCardId || !confirm('このカードを削除しますか？')) return;
  await api.del('/api/cards/'+mepCardId);
  toast('削除しました');
  await loadCards();
  closeMobileEdit();
}

function closeMobileEdit(){
  document.getElementById('mobile-edit-panel').classList.remove('open');
  mepCardId = null;
}

// スマホでカードをタップしたらモバイルパネルを開く（768px以下）
function openCardMobile(cardId){
  if(window.innerWidth <= 700){ openMobileEdit(cardId); }
  else { selectCard(cardId); }
}

// ════════════════════════════════════════
