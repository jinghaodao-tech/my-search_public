//  ソースURL管理
// ════════════════════════════════════════
let sourceConfig = null;
let sourceTab    = 'rss';

async function openSourceModal(){
  try{
    sourceConfig = await api.get('/api/source/config');
    // 旧エンドポイント名フォールバック
  }catch{
    try{ sourceConfig = await api.get('/api/collect/config'); }
    catch{ sourceConfig = { rss:[], arxiv:[], github:[] }; }
  }
  renderSourceList();
  openModal('source-modal');
}

function switchSourceTab(tab, el){
  sourceTab = tab;
  document.querySelectorAll('#source-modal .modal-tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  ['rss','arxiv','github'].forEach(t=>{
    document.getElementById('source-'+t+'-tab').style.display = t===tab?'block':'none';
  });
}

function renderSourceList(){
  const rss    = sourceConfig?.rss    ?? [];
  const arxiv  = sourceConfig?.arxiv  ?? [];
  const github = sourceConfig?.github ?? [];

  // RSS
  document.getElementById('src-rss-list').innerHTML = rss.map((s,i)=>`
    <div class="src-row">
      <input class="src-in" value="${esc(s.url)}" placeholder="https://example.com/feed.xml"
        oninput="sourceConfig.rss[${i}].url=this.value">
      <input class="src-label-in" value="${esc(s.label??'')}" placeholder="ラベル"
        oninput="sourceConfig.rss[${i}].label=this.value">
      <input class="src-auth" type="number" min="0" max="1" step="0.05" value="${s.authority??0.8}"
        oninput="sourceConfig.rss[${i}].authority=parseFloat(this.value)">
      <button class="src-del" onclick="sourceConfig.rss.splice(${i},1);renderSourceList()">🗑</button>
    </div>`).join('');

  // arXiv
  document.getElementById('src-arxiv-list').innerHTML = arxiv.map((s,i)=>`
    <div class="src-row">
      <input class="src-in" value="${esc(s.query)}" placeholder="例: large language model"
        oninput="sourceConfig.arxiv[${i}].query=this.value">
      <input class="src-auth" type="number" min="1" max="50" step="1" value="${s.maxResults??10}"
        title="最大件数" oninput="sourceConfig.arxiv[${i}].maxResults=parseInt(this.value)">
      <input class="src-auth" type="number" min="0" max="1" step="0.05" value="${s.authority??0.95}"
        oninput="sourceConfig.arxiv[${i}].authority=parseFloat(this.value)">
      <button class="src-del" onclick="sourceConfig.arxiv.splice(${i},1);renderSourceList()">🗑</button>
    </div>`).join('');

  // GitHub
  document.getElementById('src-github-list').innerHTML = github.map((s,i)=>`
    <div class="src-row">
      <input class="src-in" value="${esc(s.language)}" placeholder="例: typescript"
        oninput="sourceConfig.github[${i}].language=this.value">
      <select class="src-label-in" onchange="sourceConfig.github[${i}].since=this.value">
        <option value="daily"${s.since==='daily'?' selected':''}>daily</option>
        <option value="weekly"${s.since==='weekly'?' selected':''}>weekly</option>
        <option value="monthly"${s.since==='monthly'?' selected':''}>monthly</option>
      </select>
      <input class="src-auth" type="number" min="0" max="1" step="0.05" value="${s.authority??0.8}"
        oninput="sourceConfig.github[${i}].authority=parseFloat(this.value)">
      <button class="src-del" onclick="sourceConfig.github.splice(${i},1);renderSourceList()">🗑</button>
    </div>`).join('');
}

function addSrcRow(type){
  if(!sourceConfig) sourceConfig={rss:[],arxiv:[],github:[]};
  if(type==='rss')    sourceConfig.rss.push({url:'',label:'新しいフィード',authority:0.8});
  if(type==='arxiv')  sourceConfig.arxiv.push({query:'',maxResults:10,authority:0.95});
  if(type==='github') sourceConfig.github.push({language:'',since:'weekly',authority:0.8});
  renderSourceList();
}

async function saveSourceConfig(){
  try{
    // 新エンドポイントを試してフォールバック
    try{ await api.post('/api/source/config', sourceConfig); }
    catch{ await api.post('/api/collect/config', sourceConfig); }
    toast('ソース設定を保存しました');
    closeModal('source-modal');
  } catch(e){ toast('保存エラー: '+String(e),'warn'); }
}

init();
