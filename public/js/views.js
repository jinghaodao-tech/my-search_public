//  ビュー切替
// ════════════════════════════════════════
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.tab[data-view]').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
  document.getElementById('card-grid').style.display = view==='cards' ? 'grid' : 'none';
  document.getElementById('candidate-view').classList.toggle('active', view==='candidates');
  document.getElementById('kj-board').classList.toggle('active', view==='kj');
  document.getElementById('zettel-view').classList.toggle('active', view==='zettel');
  document.getElementById('bm25-view').classList.toggle('active', view==='bm25');
  const writing = view === 'writing';
  const investigations = view === 'investigations';
  document.getElementById('main').style.display = writing || investigations ? 'none' : 'flex';
  document.getElementById('research-writing-view').classList.toggle('active', writing);
  document.getElementById('investigations-view').classList.toggle('active', investigations);
  document.getElementById('sidebar').style.display = view==='cards' ? 'flex' : 'none';
  if (view==='cards') applySidebarState();
  if (view==='bm25') applySidebarState();
  document.getElementById('content-header').style.display = view==='bm25' || investigations || writing ? 'none' : 'flex';
  const titles = {candidates:'候補レビュー',cards:currentFilter.archived?'アーカイブ一覧':'カード一覧',kj:'グルーピングボード',zettel:'Zettelkasten ネットワーク',bm25:'探す',investigations:'調査',writing:'調査して書く'};
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
  if (investigations && typeof loadInvestigationWorkspaces === 'function') { loadInvestigationWorkspaces(); loadInvestigationChoices(); }
  if (view!=='cards') closeDetail();
}

// ════════════════════════════════════════
