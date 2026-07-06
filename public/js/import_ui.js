//  CSV/JSON 取り込み
// ════════════════════════════════════════
function openCSVModal() {
  document.getElementById('csv-text').value=''; document.getElementById('json-text').value='';
  document.getElementById('csv-preview').textContent=''; document.getElementById('json-preview').textContent='';
  importTab='csv'; document.getElementById('import-tab-csv').style.display=''; document.getElementById('import-tab-json').style.display='none';
  document.querySelectorAll('.modal-tab').forEach((t,i)=>t.classList.toggle('active',i===0));
  openModal('modal-csv');
}
function switchImportTab(tab,el) {
  importTab=tab;
  document.querySelectorAll('.modal-tab').forEach(t=>t.classList.remove('active')); el.classList.add('active');
  document.getElementById('import-tab-csv').style.display=tab==='csv'?'':'none';
  document.getElementById('import-tab-json').style.display=tab==='json'?'':'none';
}
function csvDragOver(e){e.preventDefault()}
function csvDrop(e,type){e.preventDefault();const f=e.dataTransfer.files[0];if(f)readImportFile(f,type)}
function csvFileSelect(input,type){if(input.files[0])readImportFile(input.files[0],type)}
function readImportFile(file,type) {
  const reader=new FileReader();
  reader.onload=e=>{
    const text=e.target.result;
    const lines=text.split('\n').filter(l=>l.trim()).length;
    if(type==='csv'){document.getElementById('csv-text').value=text;document.getElementById('csv-preview').textContent=`✓ ${file.name}（${lines}行）を読み込みました`;}
    else{document.getElementById('json-text').value=text;document.getElementById('json-preview').textContent=`✓ ${file.name} を読み込みました`;}
  };
  reader.readAsText(file,'utf-8');
}
async function submitImport() {
  if(importTab==='csv') {
    const csv=document.getElementById('csv-text').value.trim();
    if(!csv){toast('CSVを入力してください','warn');return;}
    const r=await api.post('/api/cards/import-csv',{csv});
    closeModal('modal-csv'); toast(`${r.count}件を取り込みました`); await Promise.all([loadCards(),loadTags()]);
  } else {
    const json=document.getElementById('json-text').value.trim();
    if(!json){toast('JSONを入力してください','warn');return;}
    const r=await api.post('/api/cards/import-json',{json});
    closeModal('modal-csv'); toast(`${r.count}件を取り込みました${r.warnings?.length?`（警告${r.warnings.length}件）`:''}`);
    await Promise.all([loadCards(),loadTags()]);
  }
}

// ════════════════════════════════════════
//  AI要約
