//  ビュー切替
// ════════════════════════════════════════
function switchView(view) {
  currentView = view;
  const tabs = ['cards','kj','zettel','bm25'];
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', tabs[i]===view));
  document.getElementById('card-grid').style.display = view==='cards' ? 'grid' : 'none';
  document.getElementById('kj-board').classList.toggle('active', view==='kj');
  document.getElementById('zettel-view').classList.toggle('active', view==='zettel');
  document.getElementById('bm25-view').classList.toggle('active', view==='bm25');
  document.getElementById('sidebar').style.display = view==='cards' ? 'flex' : 'none';
  if (view==='cards') applySidebarState();
  if (view==='bm25') applySidebarState();
  document.getElementById('content-header').style.display = view==='bm25' ? 'none' : 'flex';
  const titles = {cards:currentFilter.archived?'アーカイブ一覧':'カード一覧',kj:'KJ法ボード',zettel:'Zettelkasten ネットワーク',bm25:'BM25スコアリング'};
  document.getElementById('view-title').textContent = titles[view];
  document.getElementById('header-actions').style.display = view==='cards' ? 'flex' : 'none';
  if (view==='kj') loadKJBoard();
  if (view==='zettel') loadZettelkasten();
  if (view==='bm25') updateBM25SourceInfo();
  if (view!=='cards') closeDetail();
}

// ════════════════════════════════════════
