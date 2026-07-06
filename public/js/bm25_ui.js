//  BM25 エンジン
// ════════════════════════════════════════
async function loadBM25Modes() {
  try {
    bm25Modes = await api.get('/api/modes');
    const ids = Object.keys(bm25Modes);
    if(!ids.length) return;
    // モードタブ描画
    const tabsEl = document.getElementById('mode-tabs');
    tabsEl.innerHTML = ids.map(id=>`<button class="mode-tab" id="mtab-${id}" onclick="selectBM25Mode('${id}')">${bm25Modes[id].label}</button>`).join('');
    selectBM25Mode(ids[0]);
  } catch(e) { console.warn('BM25 modes load failed', e); }
}

function selectBM25Mode(modeId) {
  bm25ActiveMode = modeId;
  document.querySelectorAll('.mode-tab').forEach(t=>t.classList.remove('active'));
  const el=document.getElementById(`mtab-${modeId}`); if(el) el.classList.add('active');
  const mode = bm25Modes[modeId];
  if(!mode) return;
  const descEl = document.getElementById('mode-desc');
  if(descEl) descEl.value = mode.description || '';
  // パラメーター同期
  bm25Params.k1 = mode.k1; bm25Params.b = mode.b; bm25Params.lambda = mode.lambda; bm25Params.ctx = mode.contextBonus;
  ['k1','b','lambda','ctx'].forEach(k=>{
    const raw = k==='ctx'?mode.contextBonus:mode[k];
    document.getElementById(`p-${k}`).value = raw;
    document.getElementById(`v-${k}`).textContent = Number(raw).toFixed(2);
  });
  // キーワード同期
  bm25Keywords = (mode.keywords||[]).map(kw=>({term:kw.term,weight:kw.weight,synonyms:(kw.synonyms||[]).join(',')}));
  renderKeywords();
}

function updateBM25ModeDescription(value) {
  if(!bm25ActiveMode || !bm25Modes[bm25ActiveMode]) return;
  bm25Modes[bm25ActiveMode].description = value;
}

function syncParam(key, val) {
  const n = key === 'limit' ? parseInt(val, 10) : parseFloat(val);
  bm25Params[key] = Number.isFinite(n) ? n : (key === 'limit' ? 50 : 0);
  document.getElementById(`v-${key}`).textContent = key === 'limit' ? String(bm25Params[key]) : Number(bm25Params[key]).toFixed(2);
}

function renderKeywords() {
  document.getElementById('kw-list').innerHTML = bm25Keywords.map((kw,i)=>`
    <div class="kw-row">
      <input class="kw-term" type="text" value="${esc(kw.term)}" placeholder="キーワード" oninput="bm25Keywords[${i}].term=this.value">
      <input class="kw-weight" type="number" value="${kw.weight}" step="0.1" min="0" max="5" oninput="bm25Keywords[${i}].weight=parseFloat(this.value)||1">
      <input class="kw-syn" type="text" value="${esc(kw.synonyms||'')}" placeholder="同義語,..." oninput="bm25Keywords[${i}].synonyms=this.value">
      <button onclick="removeKeyword(${i})">×</button>
    </div>`).join('');
}
function addKeyword() { bm25Keywords.push({term:'',weight:1.0,synonyms:''}); renderKeywords(); }
function removeKeyword(i) { bm25Keywords.splice(i,1); renderKeywords(); }

function updateBM25SourceInfo() {
  const el = document.getElementById('bm25-source-info');
  if(!el) return;
  const src = document.querySelector('input[name="bm25src"]:checked')?.value||'articles';
  if(src==='cards') el.textContent = `カード ${allCards.length} 件を使用`;
  else el.textContent = `収集記事を使用（/api/articles）`;
  updateArticleAutoStatus();
}

async function updateArticleAutoStatus() {
  const el = document.getElementById('article-auto-status');
  if(!el) return;
  try {
    const status = await api.get('/api/scheduler/status');
    const fetched = status.lastFetchedAt ? new Date(status.lastFetchedAt).toLocaleString() : '-';
    el.textContent = `${status.running ? 'Auto update: ON' : 'Auto update: OFF'}${status.collecting ? ' / updating...' : ''} / Articles: ${status.articleCount ?? '-'} / Last: ${fetched}`;
  } catch {
    el.textContent = 'Auto update status unavailable';
  }
}

async function refreshInputArticlesNow() {
  try {
    const result = await api.post('/api/articles/refresh', { background: true });
    toast(result.running ? 'Article refresh started' : (result.message || 'Article refresh requested'));
    updateArticleAutoStatus();
  } catch(e) {
    toast('Article refresh failed: '+String(e), 'warn');
  }
}

async function runBM25() {
  const btn = document.getElementById('bm25-run-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 実行中...';
  showArchived = false;

  try {
    const src = document.querySelector('input[name="bm25src"]:checked')?.value||'articles';

    // キーワードを構築
    const keywords = bm25Keywords.filter(kw=>kw.term.trim()).map(kw=>({
      term: kw.term.trim(),
      weight: kw.weight,
      synonyms: kw.synonyms ? kw.synonyms.split(',').map(s=>s.trim()).filter(Boolean) : [],
    }));

    const config = {
      label: bm25Modes[bm25ActiveMode]?.label || 'カスタム',
      description: bm25Modes[bm25ActiveMode]?.description || '',
      k1: bm25Params.k1,
      b: bm25Params.b,
      lambda: bm25Params.lambda,
      contextBonus: bm25Params.ctx,
      keywords,
    };

    // カードをarticle形式に変換して渡す
    let articles = null;
    if(src === 'cards') {
      const cards = await api.get('/api/cards');
      articles = cards.map(c=>({
        id: c.id,
        title: c.title,
        body: c.summary ? `${c.summary} ${c.body}` : c.body,
        publishedAt: c.createdAt,
        sourceAuthority: 0.8,
        url: c.url||'',
        tokens: c.tokens,
        docLength: c.docLength,
      }));
    }

    const payload = { modeId: bm25ActiveMode, config, options: {
      dedupThreshold: bm25Params.dedup,
      archiveScoreThreshold: bm25Params.arch,
        resultLimit: bm25Params.limit,
      }};
    if(articles) payload.articles = articles;

    bm25Result = await api.post('/api/run', payload);
    renderBM25Result();

  } catch(e) {
    toast('実行エラー: '+String(e), 'warn');
  } finally {
    btn.disabled=false; btn.innerHTML='▶ 実行';
  }
}

function renderBM25Result() {
  if(!bm25Result) return;
  const { active, archived, stats } = bm25Result;

  // 統計
  const maxScore = active.length ? active[0].score : 1;
  document.getElementById('bm25-stats').innerHTML = `
    <div class="bm25-stat"><div class="bm25-stat-val">${stats.inputCount}</div><div class="bm25-stat-lbl">入力</div></div>
    <div class="bm25-stat"><div class="bm25-stat-val">${stats.afterDedup}</div><div class="bm25-stat-lbl">重複除去後</div></div>
    <div class="bm25-stat"><div class="bm25-stat-val" style="color:var(--success)">${stats.activeCount}</div><div class="bm25-stat-lbl">アクティブ</div></div>
    <div class="bm25-stat"><div class="bm25-stat-val" style="color:var(--text-dim)">${stats.archivedCount}</div><div class="bm25-stat-lbl">アーカイブ</div></div>
    <div class="bm25-stat"><div class="bm25-stat-val">${stats.avgScore.toFixed(2)}</div><div class="bm25-stat-lbl">平均スコア</div></div>`;
  document.getElementById('bm25-result-actions').style.display = 'flex';

  // 結果一覧
  const items = showArchived ? archived.map(a=>({...a,_archived:true,_reason:a.reason,score:0,breakdown:null})) : active;
  document.getElementById('bm25-result-body').innerHTML = items.length === 0
    ? `<div class="empty-state"><div class="icon">📭</div><p>${showArchived?'アーカイブなし':'結果なし'}</p></div>`
    : items.map((item,i) => {
        const isActive = !item._archived;
        const s = isActive ? item : null;
        const art = item.article;
        const score = isActive ? item.score : 0;
        const bd = isActive ? item.breakdown : null;
        const pct = isActive ? Math.min(100, (score/maxScore)*100) : 0;
        const keywords = resultKeywords(item);
        const fieldLabels = { title:'タイトル', body:'本文', summary:'要約', tags:'タグ' };
        const matchedFields = (item.matchedFields||[]).map(f=>fieldLabels[f]||f);
        const matchExplainHtml = (matchedFields.length || keywords.length) ? `
          <div class="match-explain">
            ${matchedFields.length?`<span>一致: ${matchedFields.map(esc).join('・')}</span>`:''}
            ${keywords.length?`<span class="match-pill">キーワード: ${keywords.map(esc).join(', ')}</span>`:''}
          </div>` : '';
        const snippetSource = art.summary || art.body || '';
        const snippet = snippetSource.slice(0,180);

        const termsHtml = bd ? (bd.matchedTerms||[]).map(t=>
          `<span class="matched-term" title="TF:${t.tf?.toFixed(2)} IDF:${t.idf?.toFixed(2)} BM25:${t.bm25?.toFixed(2)}">${esc(t.term)} ×${t.weight?.toFixed(1)}</span>`
        ).join('') : '';

        const breakdownHtml = bd ? `
          <div class="score-breakdown">
            <span class="breakdown-pill highlight">BM25: ${bd.bm25Raw?.toFixed(3)}</span>
            <span class="breakdown-pill">文脈ボーナス: +${bd.contextBonus?.toFixed(3)}</span>
            <span class="breakdown-pill">時間減衰: ×${bd.timeDecay?.toFixed(3)}</span>
            <span class="breakdown-pill highlight">最終: ${bd.finalScore?.toFixed(3)}</span>
          </div>
          ${termsHtml?`<div class="matched-terms">${termsHtml}</div>`:''}` : '';

        const date = new Date(art.publishedAt||art.createdAt||Date.now()).toLocaleDateString('ja-JP',{year:'numeric',month:'short',day:'numeric'});

        return `<div class="score-card">
          <div class="score-card-header">
            <span class="score-badge ${isActive?'':'archived'}">${isActive?`#${i+1} ${score.toFixed(2)}`:'ARCHIVED'}</span>
            <div class="score-title">${highlightSearchText(art.title, keywords)}</div>
          </div>
          ${isActive?`<div class="score-bar"><div class="score-bar-fill" style="width:${pct}%"></div></div>`:''}
          <div class="score-meta">
            <span>📅 ${date}</span>
            ${art.url?`<span><a href="${esc(art.url)}" target="_blank" style="color:var(--accent);text-decoration:none">🔗 リンク</a></span>`:''}
            ${item._reason?`<span style="color:var(--warning)">⚠ ${esc(item._reason)}</span>`:''}
          </div>
          ${snippet?`<div style="font-size:12px;color:var(--text-dim);line-height:1.5;margin-bottom:8px">${highlightSearchText(snippet, keywords)}${snippetSource.length>180?'...':''}</div>`:''}
          ${art.tags?.length?`<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">${art.tags.map(t=>`<span class="card-tag">${highlightSearchText(t, keywords)}</span>`).join('')}</div>`:''}
          ${matchExplainHtml}
          ${breakdownHtml}
          <div class="score-actions">
            <button class="btn btn-secondary btn-sm" onclick="saveOneAsCard('${esc(art.id).replace(/'/g,"\\'")}')">💾 カードに保存</button>
            ${isActive?`<button class="btn btn-secondary btn-sm" onclick="showScoreDetail(${i})">詳細</button>`:''}
          </div>
        </div>`;
      }).join('');
}

function toggleArchived() { showArchived=!showArchived; renderBM25Result(); }

async function saveTopAsCards() {
  if(!bm25Result) return;
  const n = Math.min(bm25Result.active.length, bm25Params.limit || 50);
  const top = bm25Result.active.slice(0,n);
  let saved=0;
  for(const s of top) {
    const art=s.article;
    try {
      await api.post('/api/cards',{title:art.title,body:art.body,url:art.url,tags:[],type:'article',summary:undefined});
      saved++;
    } catch {}
  }
  toast(`${saved}件をカードに保存しました`);
  await loadCards();
}

async function saveOneAsCard(artId) {
  const src = document.querySelector('input[name="bm25src"]:checked')?.value||'articles';
  let art;
  if(src==='cards') {
    art = allCards.find(c=>c.id===artId);
    if(art) { toast('このカードは既にカード一覧にあります'); return; }
  }
  if(!art && bm25Result) {
    const found = bm25Result.active.find(s=>s.article.id===artId)||bm25Result.archived.find(s=>s.article.id===artId);
    if(found) art = found.article||found;
  }
  if(!art) { toast('記事が見つかりません','warn'); return; }
  await api.post('/api/cards',{title:art.title,body:art.body,url:art.url,tags:[],type:'article'});
  toast('カードに保存しました'); await loadCards();
}

function showScoreDetail(idx) {
  if(!bm25Result) return;
  const s = bm25Result.active[idx];
  const bd = s.breakdown;
  const terms = (bd.matchedTerms||[]).map(t=>
    `${t.term}: TF=${t.tf?.toFixed(3)}, IDF=${t.idf?.toFixed(3)}, BM25=${t.bm25?.toFixed(3)}, W=${t.weight?.toFixed(2)}, contribution=${t.contribution?.toFixed(3)}`
  ).join('\n');
  alert(`【${s.article.title}】\n\n最終スコア: ${bd.finalScore?.toFixed(4)}\nBM25生: ${bd.bm25Raw?.toFixed(4)}\n文脈ボーナス: ${bd.contextBonus?.toFixed(4)}\n時間減衰: ${bd.timeDecay?.toFixed(4)}\n\n■マッチタームの内訳:\n${terms||'（なし）'}`);
}

document.querySelectorAll('input[name="bm25src"]').forEach(r=>r.addEventListener('change',updateBM25SourceInfo));

// ════════════════════════════════════════
