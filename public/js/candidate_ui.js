let candidateArticles = new Map();
let candidateStatusFilter = '';
const candidateStatusLabels = { unreviewed: '未確認', reviewed_not_saved: '確認済み・未保存', saved_as_card: '保存済み', expired: '期限切れ' };

async function loadCandidates() {
  const grid = document.getElementById('candidate-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="empty-state"><p>候補を読み込み中...</p></div>';
  try {
    const query = candidateStatusFilter ? `?status=${encodeURIComponent(candidateStatusFilter)}` : '';
    const candidates = await api.get(`/api/candidates${query}`);
    document.getElementById('candidate-count').textContent = `${candidates.length}件`;
    if (!candidates.length) {
      grid.innerHTML = '<div class="empty-state"><p>候補はありません</p></div>';
      return;
    }
    grid.innerHTML = candidates.map(candidate => {
      const article = candidate;
      const label = candidateStatusLabels[candidate.status] || candidate.status;
      const actions = candidate.status === 'unreviewed'
        ? `<button class="btn btn-secondary btn-sm" onclick="reviewCandidate('${esc(candidate.candidateId)}')">レビュー済み</button>` : '';
      const save = candidate.status === 'saved_as_card' || candidate.status === 'expired' ? ''
        : `<button class="btn btn-primary btn-sm" onclick="saveCandidateAsCard('${esc(candidate.candidateId)}')">カードに保存</button>`;
      const expire = candidate.status === 'saved_as_card' || candidate.status === 'expired' ? ''
        : `<button class="btn btn-secondary btn-sm" onclick="expireOneCandidate('${esc(candidate.candidateId)}')">見送る</button>`;
      const published = article.publishedAt ? `公開: ${new Date(article.publishedAt).toLocaleDateString('ja-JP')} · ` : '';
      return `<article class="candidate-card"><div class="candidate-card-header"><span class="candidate-status status-${candidate.status}">${label}</span><time>初回: ${new Date(candidate.firstSeenAt).toLocaleDateString('ja-JP')} / 最終: ${new Date(candidate.lastSeenAt).toLocaleDateString('ja-JP')}</time></div><h3>${esc(article.title || candidate.candidateId)}</h3><p>${esc((article.summary || article.body || '').slice(0, 220))}</p><div class="candidate-meta">${published}${article.score != null ? `スコア: ${Number(article.score).toFixed(3)} · ` : ''}${article.matchReason ? `${esc(article.matchReason)} · ` : ''}${esc(article.source || 'source')} ${article.url ? `<a href="${esc(article.url)}" target="_blank" rel="noreferrer">元記事</a>` : ''}</div><div class="candidate-actions">${actions}${save}${expire}</div></article>`;    }).join('');
  } catch (error) {
    grid.innerHTML = `<div class="empty-state"><p>候補の読み込みに失敗しました: ${esc(error.message)}</p></div>`;
  }
}
async function reviewCandidate(id) { await api.put(`/api/candidates/${encodeURIComponent(id)}/review`, {}); await loadCandidates(); }
async function saveCandidateAsCard(id) { await api.post(`/api/candidates/${encodeURIComponent(id)}/save`, {}); toast('カードに保存しました'); await loadCandidates(); await loadCards(); }
async function expireOneCandidate(id) { await api.put(`/api/candidates/${encodeURIComponent(id)}/expire`, {}); await loadCandidates(); }