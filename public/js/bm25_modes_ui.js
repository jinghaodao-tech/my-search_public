//  BM25 モード追加・管理
// ════════════════════════════════════════
function addBM25Mode(){
  const name = prompt('新しいモード名を入力してください');
  if(!name?.trim()) return;
  const id = 'mode_'+Date.now();
  bm25Modes[id] = {
    label: name.trim(),
    description: '',
    status: 'stopped',
    k1: 1.5, b: 0.75, lambda: 0.1, contextBonus: 1.5,
    keywords: [{term:'キーワード1', weight:1.0, synonyms:[]}],
  };
  loadBM25Modes();          // タブ再描画
  selectBM25Mode(id);       // 新モードを選択状態に
  toast('モード「'+name+'」を追加しました');
  // サーバーには /api/run 時に config として渡すので永続化不要
}

function openModeManagerModal(){
  renderModeManagerList();
  openModal('mode-manager-modal');
}

function renderModeManagerList(){
  const ids = Object.keys(bm25Modes);
  const lbl = {active:'稼働',paused:'停止',stopped:'無効'};
  const pillCls = {active:'pill-active',paused:'pill-paused',stopped:'pill-stopped'};
  document.getElementById('mode-manager-list').innerHTML = ids.map(id=>{
    const m = bm25Modes[id];
    return `<div class="mode-edit-row">
      <input class="mode-edit-name" value="${esc(m.label)}"
        oninput="bm25Modes['${id}'].label=this.value;loadBM25Modes()">
      <div style="display:flex;align-items:center;gap:6px">
        <span class="mode-badge-pill ${pillCls[m.status]??'pill-stopped'}">${lbl[m.status]??'—'}</span>
        <select style="background:var(--surface2);border:1px solid var(--border);border-radius:5px;
          color:var(--text);font-size:11px;padding:2px 5px;outline:none"
          onchange="bm25Modes['${id}'].status=this.value;renderModeManagerList()">
          <option value="active"${m.status==='active'?' selected':''}>稼働</option>
          <option value="paused"${m.status==='paused'?' selected':''}>停止</option>
          <option value="stopped"${m.status==='stopped'?' selected':''}>無効</option>
        </select>
        <button class="btn btn-secondary btn-sm" onclick="selectBM25Mode('${id}');closeModal('mode-manager-modal')">選択</button>
        ${ids.length>1?`<button class="btn btn-danger btn-sm" onclick="deleteBM25Mode('${id}')">削除</button>`:''}
      </div>
      <textarea class="mode-edit-desc" placeholder="説明" oninput="bm25Modes['${id}'].description=this.value;if(bm25ActiveMode==='${id}')document.getElementById('mode-desc').value=this.value">${esc(m.description||'')}</textarea>
    </div>`;
  }).join('');
}

function confirmAddMode(){
  const name = document.getElementById('new-mode-name').value.trim();
  if(!name){ toast('モード名を入力してください','warn'); return; }
  const id = 'mode_'+Date.now();
  bm25Modes[id] = {
    label: name, description:'', status:'stopped',
    k1:1.5, b:0.75, lambda:0.1, contextBonus:1.5,
    keywords:[{term:'キーワード1',weight:1.0,synonyms:[]}],
  };
  document.getElementById('new-mode-name').value='';
  loadBM25Modes();
  renderModeManagerList();
  toast('モード追加: '+name);
}

function deleteBM25Mode(id){
  if(!confirm(`モード「${bm25Modes[id]?.label}」を削除しますか？`)) return;
  delete bm25Modes[id];
  const remaining = Object.keys(bm25Modes);
  if(remaining.length) selectBM25Mode(remaining[0]);
  loadBM25Modes();
  renderModeManagerList();
  toast('削除しました');
}

// loadBM25Modes をオーバーライド（非同期を同期的に使えるよう）
const _origLoadBM25 = loadBM25Modes;
loadBM25Modes = async function(){
  // サーバーからのロードは初回のみ、以降は bm25Modes を直接使う
  if(!Object.keys(bm25Modes).length){
    try{
      bm25Modes = await api.get('/api/modes');
    } catch(e){ console.warn('modes load failed',e); }
  }
  const ids = Object.keys(bm25Modes);
  if(!ids.length) return;
  const tabsEl = document.getElementById('mode-tabs');
  if(!tabsEl) return;
  tabsEl.innerHTML = ids.map(id=>
    `<button class="mode-tab" id="mtab-${id}" onclick="selectBM25Mode('${id}')">${esc(bm25Modes[id].label)}</button>`
  ).join('');
  if(!bm25ActiveMode || !bm25Modes[bm25ActiveMode]) selectBM25Mode(ids[0]);
  else { document.getElementById('mtab-'+bm25ActiveMode)?.classList.add('active'); }
};

// ════════════════════════════════════════
