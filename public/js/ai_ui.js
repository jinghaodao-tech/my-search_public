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

// AI summaries: made by Chrome's on-device AI in this browser (nothing is sent anywhere),
// then saved to the card. Only when the browser has no on-device AI and this instance has
// an AI key is the server's AI used instead.
function summarySourceText(card) {
  const body = String(card.body || '');
  const at = body.indexOf('## 本文（取得時点のコピー・私的利用）');
  if (at < 0) return body;
  const end = body.indexOf('## 日本語訳（機械翻訳・私的利用）', at);
  return body.slice(at, end < 0 ? undefined : end).replace(/^## .*\n/, '');
}
async function summaryEngine() {
  if (typeof localAi !== 'undefined' && (await localAi.availability('prompt')) !== 'unavailable') return 'local-ai';
  if (typeof appFeatures !== 'undefined' && appFeatures.ai) return 'server-ai';
  return null;
}
async function summarizeCardLocally(id, onProgress) {
  const card = await api.get(`/api/cards/${encodeURIComponent(id)}`);
  const summary = await localAi.summarize(card.title, summarySourceText(card), { onProgress });
  if (!summary) throw new Error('本文が空です');
  await api.put(`/api/cards/${encodeURIComponent(id)}`, { summary });
  return summary;
}
async function summarizeOne(id) {
  const engine = await summaryEngine();
  if (!engine) { toast('このブラウザでは内蔵AIが使えないため、要約できません', 'warn'); return; }
  try {
    if (engine === 'local-ai') {
      toast('端末のAIで要約しています…（初回はモデルの準備に時間がかかります）');
      await summarizeCardLocally(id, (done, total) => { if (total > 1) toast(`要約中… ${done}/${total}`); });
    } else {
      toast('要約中...');
      const r = await api.post(`/api/cards/${id}/summarize`, {});
      if (!r.summary) { toast('要約に失敗しました', 'warn'); return; }
    }
    toast('要約しました', 'success');
    await loadCards();
    if (currentCardId === id) selectCard(id);
  } catch (error) {
    showApiError(error, '要約に失敗しました');
  }
}
let summarizeBulkRunning = false;
async function summarizeBulk() {
  const ids = allCards.filter(c => !c.summary).map(c => c.id);
  if (!ids.length) { toast('未要約のカードはありません'); return; }
  const engine = await summaryEngine();
  if (!engine) { toast('このブラウザでは内蔵AIが使えないため、要約できません', 'warn'); return; }
  if (engine === 'server-ai') {
    await api.post('/api/cards/summarize-bulk', { ids });
    toast(`${ids.length}件の要約を開始しました（バックグラウンド）`);
    setTimeout(() => loadCards(), 3000); setTimeout(() => loadCards(), 8000);
    return;
  }
  if (summarizeBulkRunning) { toast('一括要約を実行中です', 'warn'); return; }
  if (!confirm(`未要約の${ids.length}件を端末のAIで順番に要約します。1件に十数秒かかります。この画面を開いたままにしてください。始めますか？`)) return;
  summarizeBulkRunning = true;
  let done = 0, failed = 0;
  try {
    for (const id of ids) {
      toast(`一括要約 ${done + failed + 1}/${ids.length}`);
      try { await summarizeCardLocally(id); done += 1; } catch (error) { failed += 1; console.warn('summary failed', id, error); }
      if ((done + failed) % 5 === 0) await loadCards();
    }
  } finally {
    summarizeBulkRunning = false;
    await loadCards();
    toast(`一括要約が終わりました（${done}件${failed ? `・失敗 ${failed}件` : ''}）`, failed ? 'warn' : 'success');
  }
}

// ════════════════════════════════════════
