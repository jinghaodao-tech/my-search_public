//  ビュー切替
// ════════════════════════════════════════
function switchView(view) {
  currentView = view;
  const tabs = ['cards','candidates','kj','zettel','bm25','writing'];
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', tabs[i]===view));
  document.getElementById('card-grid').style.display = view==='cards' ? 'grid' : 'none';
  document.getElementById('candidate-view').classList.toggle('active', view==='candidates');
  document.getElementById('kj-board').classList.toggle('active', view==='kj');
  document.getElementById('zettel-view').classList.toggle('active', view==='zettel');
  document.getElementById('bm25-view').classList.toggle('active', view==='bm25');
  const writing = view === 'writing';
  document.getElementById('main').style.display = writing ? 'none' : 'flex';
  document.getElementById('research-writing-view').classList.toggle('active', writing);
  document.getElementById('sidebar').style.display = view==='cards' ? 'flex' : 'none';
  if (view==='cards') applySidebarState();
  if (view==='bm25') applySidebarState();
  document.getElementById('content-header').style.display = view==='bm25' ? 'none' : 'flex';
  const titles = {candidates:'候補レビュー',cards:currentFilter.archived?'アーカイブ一覧':'カード一覧',kj:'KJ法ボード',zettel:'Zettelkasten ネットワーク',bm25:'探す',writing:'調査して書く'};
  document.getElementById('view-title').textContent = titles[view];
  document.getElementById('header-actions').style.display = view==='cards' ? 'flex' : 'none';
  document.getElementById('refind-study-list-control').style.display = view==='cards' ? 'flex' : 'none';
  document.getElementById('refind-study-review-list').style.display = view==='cards' ? 'flex' : 'none';
  if (view==='candidates') loadCandidates();
  if (view==='kj') loadKJBoard();
  if (view==='zettel') loadZettelkasten();
  if (view==='bm25') updateBM25SourceInfo();
  if (view==='bm25' && typeof initSearchScreen === 'function') initSearchScreen();
  if (writing && typeof loadResearchDocuments === 'function') loadResearchDocuments();
  if (view!=='cards') closeDetail();
}

// ════════════════════════════════════════
