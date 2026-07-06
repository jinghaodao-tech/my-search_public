//  カラーストリップ
// ════════════════════════════════════════
function buildColorStrips(){
  ['new-color-strip','edit-color-strip','group-color-strip'].forEach(id=>{
    const el=document.getElementById(id); if(!el)return;
    el.innerHTML=[null,...COLORS].map(c=>c
      ?`<span class="color-dot" data-color="${c}" style="background:${c}" title="${c}"></span>`
      :`<span class="color-dot" data-color="" style="background:var(--surface2);border-color:var(--border)" title="色なし">✕</span>`
    ).join('');
  });
}
function updateColorStrip(stripId,selected,onSelect){
  const strip=document.getElementById(stripId); if(!strip)return;
  strip.querySelectorAll('.color-dot').forEach(dot=>{
    const c=dot.dataset.color||null;
    dot.classList.toggle('selected',c===selected);
    dot.onclick=()=>{onSelect(c);updateColorStrip(stripId,c,onSelect)};
  });
}

// ════════════════════════════════════════
//  モーダル
// ════════════════════════════════════════
function openModal(id){document.getElementById(id).classList.add('active')}
function closeModal(id){document.getElementById(id).classList.remove('active')}
document.querySelectorAll('.modal-overlay').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('active')}));

// ════════════════════════════════════════
//  トースト
// ════════════════════════════════════════
function toast(msg,type='ok'){
  const el=document.getElementById('toast');
  el.textContent=msg; el.style.borderColor=type==='warn'?'var(--warning)':'var(--border)';
  el.classList.add('show'); clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('show'),2800);
}

// キーボード
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){document.querySelectorAll('.modal-overlay.active').forEach(m=>m.classList.remove('active'));closeDetail();}
  if((e.ctrlKey||e.metaKey)&&e.key==='n'){e.preventDefault();openNewCardModal();}
  if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&currentView==='bm25'){e.preventDefault();runBM25();}
});


// ════════════════════════════════════════
//  FAB（スマホフローティングボタン）
// ════════════════════════════════════════
let fabOpen = false;
function toggleFab(){
  fabOpen = !fabOpen;
  document.getElementById('fab-menu').classList.toggle('open', fabOpen);
  document.getElementById('fab-main').textContent = fabOpen ? '✕' : '＋';
}

// ════════════════════════════════════════
