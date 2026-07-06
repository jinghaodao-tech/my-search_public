// ════════════════════════════════════════

function toggleSummaryVisibility(checked){
  showCardSummaries = checked;
  localStorage.setItem('showCardSummaries', checked ? 'true' : 'false');
  renderCardGrid();
}
async function deleteSummary(id){
  if(!confirm('Delete summary?')) return;
  await api.del(`/api/cards/${id}/summary`);
  toast('Summary deleted');
  await loadCards();
  if(currentCardId===id) selectCard(id);
}

async function summarizeOne(id) {
  toast('要約中...');
  const r=await api.post(`/api/cards/${id}/summarize`,{});
  if(r.summary){toast('要約しました');await loadCards();if(currentCardId===id)selectCard(id);}
  else toast('要約に失敗しました','warn');
}
async function summarizeBulk() {
  const ids=allCards.filter(c=>!c.summary).map(c=>c.id);
  if(!ids.length){toast('未要約のカードはありません');return;}
  await api.post('/api/cards/summarize-bulk',{ids});
  toast(`${ids.length}件の要約を開始しました（バックグラウンド）`);
  setTimeout(()=>loadCards(),3000); setTimeout(()=>loadCards(),8000);
}

// ════════════════════════════════════════
