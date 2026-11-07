//  ビュー切替
// ════════════════════════════════════════
function switchView(view) {
  // Backwards-compatible entry point: there is one editor, hosted in the
  // active investigation shell (or in its all-documents mode).
  if (view === 'writing') {
    view = 'investigations';
    window.mySearchOpenDocumentsOnEnter = true;
    if (typeof setInvestigationPanel === 'function') setInvestigationPanel('documents', { persist: false });
  }
  currentView = view;
  const primaryView = view === 'kj' || view === 'zettel' ? 'cards' : view;
  const primaryNavGroup = ['cards', 'candidates', 'kj', 'zettel'].includes(view) ? 'library' : primaryView;
  document.querySelectorAll('.tab[data-view]').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view || tab.dataset.view === primaryView));
  document.querySelectorAll('[data-nav-group]').forEach(tab => tab.classList.toggle('active', tab.dataset.navGroup === primaryNavGroup));
  document.getElementById('card-grid').style.display = view==='cards' ? 'grid' : 'none';
  document.getElementById('candidate-view').classList.toggle('active', view==='candidates');
  document.getElementById('kj-board').classList.toggle('active', view==='kj');
  document.getElementById('zettel-view').classList.toggle('active', view==='zettel');
  document.getElementById('bm25-view').classList.toggle('active', view==='bm25');
  const investigations = view === 'investigations';
  document.getElementById('main').style.display = investigations ? 'none' : 'flex';
  document.getElementById('research-writing-view').classList.toggle('active', false);
  document.getElementById('investigations-view').classList.toggle('active', investigations);
  document.getElementById('sidebar').style.display = view==='cards' ? 'flex' : 'none';
  if (view==='cards') applySidebarState();
  if (view==='bm25') applySidebarState();
  document.getElementById('content-header').style.display = view==='bm25' || investigations ? 'none' : 'flex';
  const titles = {candidates:'候補レビュー',cards:currentFilter.archived?'アーカイブ一覧':'保存済み',kj:'全カードのグルーピング',zettel:'全カードの関係図',bm25:'探す',investigations:'調査'};
  document.getElementById('view-title').textContent = titles[view];
  document.getElementById('header-actions').style.display = view==='cards' ? 'flex' : 'none';
  document.getElementById('refind-study-list-control').style.display = view==='cards' ? 'flex' : 'none';
  document.getElementById('refind-study-review-list').style.display = view==='cards' ? 'flex' : 'none';
  if (view==='candidates') loadCandidates();
  if (view==='kj') loadKJBoard();
  if (view==='zettel') loadZettelkasten();
  if (view==='bm25') updateBM25SourceInfo();
  if (view==='bm25' && typeof initSearchScreen === 'function') initSearchScreen();
  if (investigations && typeof loadInvestigationWorkspaces === 'function') { loadInvestigationWorkspaces(); loadInvestigationChoices(); loadResearchDocuments?.(); }
  if (view!=='cards') closeDetail();
}

// ════════════════════════════════════════
