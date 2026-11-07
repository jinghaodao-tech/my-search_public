let investigationWorkspaces = [];
let activeInvestigationWorkspace = null;
let investigationSearchConfig = null;
let investigationGraph = null;
let investigationSearchDebounce = null;
let investigationCompareDebounce = null;

function investigationStatus(message, error = false) {
  const node = document.getElementById('investigation-status');
  node.textContent = message;
  node.classList.toggle('document-error', error);
}

function investigationButton(label, action, className = 'btn btn-secondary btn-sm') {
  const button = document.createElement('button');
  button.type = 'button'; button.className = className; button.textContent = label; button.onclick = action;
  return button;
}

function renderInvestigationWorkspaceList() {
  const host = document.getElementById('investigation-workspace-list');
  host.replaceChildren();
  if (!investigationWorkspaces.length) {
    const empty = document.createElement('p'); empty.className = 'reader-note'; empty.textContent = '調査はまだありません。'; host.append(empty); return;
  }
  for (const row of investigationWorkspaces) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'document-list-item';
    button.classList.toggle('active', activeInvestigationWorkspace?.id === row.id);
    button.textContent = row.name; button.title = `${row.source_count}件の資料 · ${row.document_count}件の原稿`;
    button.onclick = () => openInvestigationWorkspace(row.id);
    host.append(button);
  }
}

function setInvestigationWorkspace(workspace) {
  activeInvestigationWorkspace = workspace;
  const enabled = Boolean(workspace);
  for (const id of ['investigation-name', 'investigation-purpose', 'investigation-save', 'investigation-delete']) document.getElementById(id).disabled = !enabled;
  document.getElementById('investigation-content').hidden = !enabled;
  document.getElementById('investigation-name').value = workspace?.name ?? '';
  document.getElementById('investigation-purpose').value = workspace?.purpose ?? '';
  document.getElementById('investigation-search-query').value = workspace?.state?.searchQuery ?? '';
  document.getElementById('investigation-compare-purpose').value = workspace?.state?.comparePurpose ?? '';
  renderInvestigationWorkspaceList();
  if (!workspace) return;
  renderInvestigationSources();
  renderInvestigationGroups();
  renderInvestigationDocuments();
  renderInvestigationSavedSearches();
  void loadInvestigationGraph();
  investigationSearchConfig = null;
}

async function loadInvestigationWorkspaces(preferredId = null) {
  try {
    const result = await api.get('/api/workspaces');
    investigationWorkspaces = result.workspaces ?? [];
    renderInvestigationWorkspaceList();
    const targetId = preferredId || activeInvestigationWorkspace?.id;
    const selected = investigationWorkspaces.find(row => row.id === targetId) || investigationWorkspaces[0];
    if (selected) await openInvestigationWorkspace(selected.id);
    else {
      setInvestigationWorkspace(null);
      investigationStatus('調査を作成するか、既存の調査を選んでください。');
    }
  } catch (error) { investigationStatus(error.message || '調査一覧を読み込めませんでした。', true); }
}

async function openInvestigationWorkspace(id) {
  try {
    const result = await api.get(`/api/workspaces/${encodeURIComponent(id)}`);
    setInvestigationWorkspace(result.workspace);
    investigationStatus('調査を開きました。検索結果は「資料に追加」を押したときだけ関連付けます。');
  } catch (error) { investigationStatus(error.message || '調査を開けませんでした。', true); }
}

async function createInvestigationWorkspace() {
  const name = prompt('調査名を入力してください');
  if (name === null) return;
  if (!name.trim()) { investigationStatus('調査名を入力してください。', true); return; }
  const purpose = prompt('調査の目的（任意）') ?? '';
  try {
    const result = await api.post('/api/workspaces', { name: name.trim(), purpose });
    await loadInvestigationWorkspaces(result.workspace.id);
  } catch (error) { investigationStatus(error.message || '調査を作成できませんでした。', true); }
}

async function saveInvestigationWorkspace() {
  if (!activeInvestigationWorkspace) return;
  try {
    const result = await api.put(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}`, {
      name: document.getElementById('investigation-name').value,
      purpose: document.getElementById('investigation-purpose').value,
    });
    activeInvestigationWorkspace = { ...activeInvestigationWorkspace, ...result.workspace };
    renderInvestigationWorkspaceList(); investigationStatus('調査名と目的を保存しました。');
  } catch (error) { investigationStatus(error.message || '調査を保存できませんでした。', true); }
}

async function deleteInvestigationWorkspace() {
  if (!activeInvestigationWorkspace || !confirm(`「${activeInvestigationWorkspace.name}」の調査だけを削除しますか？保存記事・原稿・検索条件は削除されません。`)) return;
  const oldId = activeInvestigationWorkspace.id;
  try {
    await api.del(`/api/workspaces/${encodeURIComponent(oldId)}`);
    activeInvestigationWorkspace = null;
    await loadInvestigationWorkspaces();
    investigationStatus('調査の関連付けを削除しました。保存記事・原稿・検索条件は保持されています。');
  } catch (error) { investigationStatus(error.message || '調査を削除できませんでした。', true); }
}

async function saveInvestigationState(patch) {
  if (!activeInvestigationWorkspace) return;
  const state = { ...(activeInvestigationWorkspace.state ?? {}), ...patch };
  activeInvestigationWorkspace.state = state;
  try { await api.put(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/state`, { state }); }
  catch (error) { investigationStatus(error.message || '調査の再開状態を保存できませんでした。', true); }
}

async function searchInvestigationSources() {
  if (!activeInvestigationWorkspace) return;
  const query = document.getElementById('investigation-source-query').value.trim();
  const host = document.getElementById('investigation-source-results'); host.replaceChildren();
  if (!query) { host.textContent = '検索語を入力してください。'; return; }
  try {
    const response = await api.get(`/api/cards?q=${encodeURIComponent(query)}&limit=30`);
    const cards = Array.isArray(response) ? response : (response.items ?? []);
    if (!cards.length) { host.textContent = '保存記事・メモは見つかりませんでした。'; return; }
    for (const card of cards) {
      const row = document.createElement('div'); row.className = 'document-source-row';
      const label = document.createElement('span'); label.textContent = `${card.title} · ${card.type}`;
      row.append(label, investigationButton('資料に追加', () => addInvestigationSource(card.id)));
      host.append(row);
    }
  } catch (error) { host.textContent = error.message || '保存資料を検索できませんでした。'; }
}

async function addInvestigationSource(cardId) {
  if (!activeInvestigationWorkspace) return;
  try {
    const result = await api.post(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/sources`, { cardId });
    setInvestigationWorkspace(result.workspace); investigationStatus('保存資料をこの調査に追加しました。');
  } catch (error) { investigationStatus(error.message || '資料を追加できませんでした。', true); }
}

function renderInvestigationSources() {
  const host = document.getElementById('investigation-sources'); host.replaceChildren();
  const sources = activeInvestigationWorkspace?.sources ?? [];
  if (!sources.length) { host.textContent = 'まだ資料はありません。検索結果から必要な資料を追加してください。'; return; }
  for (const source of sources) {
    const row = document.createElement('div'); row.className = 'document-source-row investigation-source-row'; row.draggable = true;
    row.dataset.cardId = source.card.id;
    row.addEventListener('dragstart', event => event.dataTransfer?.setData('text/plain', source.card.id));
    const label = document.createElement('span'); label.className = 'investigation-source-title'; label.textContent = source.card.title;
    const group = document.createElement('select'); group.setAttribute('aria-label', `${source.card.title}の調査内分類`);
    const ungrouped = document.createElement('option'); ungrouped.value = ''; ungrouped.textContent = '未分類'; group.append(ungrouped);
    for (const item of activeInvestigationWorkspace.groups ?? []) {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; group.append(option);
    }
    group.value = source.groupId ?? '';
    group.onchange = () => updateInvestigationSourceGroup(source.card.id, group.value || null);
    row.append(label, group,
      investigationButton('Readerで開く', () => openReaderForCard(source.card.id)),
      investigationButton('関連解除', () => removeInvestigationSource(source.card.id), 'btn btn-secondary btn-sm'));
    host.append(row);
  }
}

async function updateInvestigationSourceGroup(cardId, groupId) {
  try {
    const result = await api.put(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/sources/${encodeURIComponent(cardId)}`, { groupId });
    setInvestigationWorkspace(result.workspace);
  } catch (error) { investigationStatus(error.message || '調査内の分類を更新できませんでした。', true); }
}

async function removeInvestigationSource(cardId) {
  try {
    await api.del(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/sources/${encodeURIComponent(cardId)}`);
    await openInvestigationWorkspace(activeInvestigationWorkspace.id);
    investigationStatus('この調査から関連を解除しました。保存カード自体は残っています。');
  } catch (error) { investigationStatus(error.message || '関連を解除できませんでした。', true); }
}

async function createInvestigationGroup() {
  if (!activeInvestigationWorkspace) return;
  const input = document.getElementById('investigation-group-name');
  const name = input.value.trim();
  if (!name) { investigationStatus('分類名を入力してください。', true); input.focus(); return; }
  try {
    const result = await api.post(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/groups`, { name });
    input.value = ''; setInvestigationWorkspace(result.workspace); investigationStatus('調査内の分類を追加しました。');
  } catch (error) { investigationStatus(error.message || '分類を追加できませんでした。', true); }
}

async function deleteInvestigationGroup(groupId) {
  try {
    const result = await api.del(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/groups/${encodeURIComponent(groupId)}`);
    if (result.workspace) setInvestigationWorkspace(result.workspace);
    else await openInvestigationWorkspace(activeInvestigationWorkspace.id);
    investigationStatus('分類を削除しました。資料の関連付けは未分類に戻しました。');
  } catch (error) { investigationStatus(error.message || '分類を削除できませんでした。', true); }
}

function renderInvestigationGroups() {
  const host = document.getElementById('investigation-groups'); host.replaceChildren();
  const groups = activeInvestigationWorkspace?.groups ?? [];
  if (!groups.length) { host.textContent = '分類はありません。分類を追加するか、資料一覧の選択欄で「未分類」のまま使えます。'; return; }
  for (const group of groups) {
    const row = document.createElement('div'); row.className = 'document-source-row investigation-group-drop'; row.dataset.groupId = group.id;
    row.addEventListener('dragover', event => event.preventDefault());
    row.addEventListener('drop', event => { event.preventDefault(); const cardId = event.dataTransfer?.getData('text/plain'); if (cardId) void updateInvestigationSourceGroup(cardId, group.id); });
    const label = document.createElement('strong'); label.textContent = group.name;
    const count = (activeInvestigationWorkspace.sources ?? []).filter(source => source.groupId === group.id).length;
    const tally = document.createElement('span'); tally.textContent = `${count}件 · 資料をここへドラッグできます`;
    row.append(label, tally, investigationButton('分類を削除', () => deleteInvestigationGroup(group.id)));
    host.append(row);
  }
  const ungrouped = document.createElement('div'); ungrouped.className = 'document-source-row investigation-group-drop'; ungrouped.textContent = '未分類へドラッグ';
  ungrouped.addEventListener('dragover', event => event.preventDefault());
  ungrouped.addEventListener('drop', event => { event.preventDefault(); const cardId = event.dataTransfer?.getData('text/plain'); if (cardId) void updateInvestigationSourceGroup(cardId, null); });
  host.append(ungrouped);
}

async function loadInvestigationGraph() {
  const host = document.getElementById('investigation-graph'); host.replaceChildren();
  investigationGraph?.destroy(); investigationGraph = null;
  if (!activeInvestigationWorkspace) return;
  try {
    const graph = await api.get(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/graph`);
    if (!graph.nodes.length) { host.textContent = '関連リンクはまだありません。カード一覧でリンクを作ると、この調査の資料だけをノードにした関係図が表示されます。'; return; }
    const container = document.createElement('div'); container.className = 'investigation-network'; container.setAttribute('aria-label', 'この調査の資料リンク図'); host.append(container);
    const nodes = new vis.DataSet(graph.nodes.map(node => ({ ...node, shape: 'box', font: { color: '#e2e8f0', size: 12 }, color: { background: '#252836', border: '#6c8aff' }, title: `${node.title}${node.externalLinkCount ? `\n調査外へのリンク ${node.externalLinkCount}件` : ''}` })));
    const edges = new vis.DataSet(graph.edges.map(edge => ({ ...edge, color: { color: '#6c8aff' } })));
    investigationGraph = new vis.Network(container, { nodes, edges }, { physics: { solver: 'forceAtlas2Based', stabilization: { iterations: 60 } }, interaction: { hover: true, tooltipDelay: 100 } });
    investigationGraph.on('selectNode', ({ nodes: selected }) => { if (selected.length === 1) void openReaderForCard(selected[0]); });
    if (graph.externalLinks) { const note = document.createElement('p'); note.className = 'reader-note'; note.textContent = `調査に含まれないカードへのリンク ${graph.externalLinks}件は外部リンクとして数えています。`; host.append(note); }
  } catch (error) { host.textContent = error.message || '調査の関係図を読み込めませんでした。'; }
}

async function runInvestigationSearch() {
  if (!activeInvestigationWorkspace) return;
  const query = document.getElementById('investigation-search-query').value.trim();
  const host = document.getElementById('investigation-search-results'); host.replaceChildren();
  if (query.length < 1) { investigationStatus('検索語を入力してください。', true); return; }
  investigationStatus('保存記事を検索しています…');
  try {
    const analyzed = await api.post('/api/search/terms', { text: query });
    const config = { label: '調査ワークスペース検索', description: '', k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5, keywords: analyzed.keywords };
    const options = { dedupThreshold: 1, archiveScoreThreshold: 0.5, resultLimit: 20 };
    const filters = { excludedTerms: [], sources: [], status: 'all' };
    investigationSearchConfig = { name: query.slice(0, 120), config, options, filters, source: 'cards', targets: ['cards'] };
    const result = await api.post('/api/cards/search', { config, options, filters });
    for (const item of result.active ?? []) {
      const row = document.createElement('div'); row.className = 'document-source-row';
      const label = document.createElement('span'); label.textContent = `${item.article.title} · ${item.snippet || ''}`;
      row.append(label, investigationButton('Readerで読む', () => openReaderForCard(item.article.id)), investigationButton('資料に追加', () => addInvestigationSource(item.article.id)));
      host.append(row);
    }
    if (!host.childElementCount) host.textContent = '一致する保存記事はありませんでした。';
    await saveInvestigationState({ searchQuery: query });
    investigationStatus(`${result.active?.length ?? 0}件を表示しています。結果の保存は「資料に追加」を押したものだけです。`);
  } catch (error) { investigationStatus(error.message || '保存記事を検索できませんでした。', true); }
}

async function saveInvestigationSearch() {
  if (!activeInvestigationWorkspace || !investigationSearchConfig) { investigationStatus('先に調査ワークスペース内で保存記事を検索してください。', true); return; }
  try {
    const saved = await api.post('/api/saved-searches', investigationSearchConfig);
    const result = await api.post(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/searches`, { id: saved.id });
    setInvestigationWorkspace(result.workspace); investigationStatus('検索条件を保存し、この調査に関連付けました。');
  } catch (error) { investigationStatus(error.message || '検索条件を保存できませんでした。', true); }
}

async function compareInvestigationSources() {
  if (!activeInvestigationWorkspace) return;
  const purpose = document.getElementById('investigation-compare-purpose').value.trim();
  const cardIds = (activeInvestigationWorkspace.sources ?? []).map(source => source.card.id).slice(0, 10);
  if (cardIds.length < 1) { investigationStatus('比較する保存資料を追加してください。', true); return; }
  if (purpose.length < 2) { investigationStatus('比較したい論点を入力してください。', true); return; }
  const host = document.getElementById('investigation-evidence'); host.textContent = '保存本文から一致箇所を抽出しています…';
  try {
    const result = await api.post('/api/reader/passages', { purpose, cardIds });
    host.replaceChildren();
    for (const evidence of result.rows ?? []) {
      const row = document.createElement('article'); row.className = 'document-evidence-row';
      const source = document.createElement('strong'); source.textContent = `${evidence.sourceTitle} · 段落${Number(evidence.paragraphIndex) + 1}`;
      const quote = document.createElement('blockquote'); quote.textContent = evidence.quote;
      const claim = document.createElement('p'); claim.textContent = evidence.claim;
      const actions = document.createElement('div'); actions.className = 'evidence-actions';
      actions.append(investigationButton('Readerで原文確認', async () => { if (await openReaderForCard(evidence.sourceId)) jumpToParagraph(evidence.paragraphIndex); }));
      if (activeInvestigationWorkspace.documents?.length) actions.append(investigationButton('既存原稿に引用', () => insertInvestigationCitation(evidence)));
      row.append(source, quote, claim, actions); host.append(row);
    }
    if (!host.childElementCount) host.textContent = '一致箇所を確認できませんでした。資料をReaderで確認してください。';
    await saveInvestigationState({ comparePurpose: purpose });
  } catch (error) { host.textContent = error.message || '資料を比較できませんでした。'; }
}

async function insertInvestigationCitation(evidence) {
  const documentId = activeInvestigationWorkspace?.documents?.[0]?.id;
  if (!documentId || typeof insertVerifiedDocumentCitation !== 'function') return;
  switchView('writing');
  await openResearchDocument(documentId);
  await insertVerifiedDocumentCitation(evidence.sourceId, evidence.paragraphIndex, evidence.quote);
}

async function loadInvestigationChoices() {
  try {
    const [documents, searches] = await Promise.all([api.get('/api/documents'), api.get('/api/saved-searches')]);
    const docSelect = document.getElementById('investigation-document-select'); docSelect.replaceChildren();
    for (const doc of documents.documents ?? []) { const option = document.createElement('option'); option.value = doc.id; option.textContent = doc.title; docSelect.append(option); }
    if (!docSelect.options.length) { const option = document.createElement('option'); option.textContent = '原稿はありません'; option.value = ''; docSelect.append(option); }
    const searchSelect = document.getElementById('investigation-search-select'); searchSelect.replaceChildren();
    for (const search of searches ?? []) { const option = document.createElement('option'); option.value = search.id; option.textContent = search.name; searchSelect.append(option); }
    if (!searchSelect.options.length) { const option = document.createElement('option'); option.textContent = '保存検索はありません'; option.value = ''; searchSelect.append(option); }
  } catch (error) { investigationStatus(error.message || '原稿・保存検索の一覧を読めませんでした。', true); }
}

function renderInvestigationDocuments() {
  const host = document.getElementById('investigation-documents'); host.replaceChildren();
  for (const doc of activeInvestigationWorkspace?.documents ?? []) {
    const row = document.createElement('div'); row.className = 'document-source-row'; const label = document.createElement('span'); label.textContent = `${doc.title} · v${doc.version}`;
    row.append(label, investigationButton('開いて執筆', async () => { switchView('writing'); await openResearchDocument(doc.id); }), investigationButton('関連解除', () => detachInvestigationItem('documents', doc.id)));
    host.append(row);
  }
  if (!host.childElementCount) host.textContent = '原稿は任意です。資料の整理や比較は原稿なしでもできます。';
}

function renderInvestigationSavedSearches() {
  const host = document.getElementById('investigation-saved-searches'); host.replaceChildren();
  for (const search of activeInvestigationWorkspace?.searches ?? []) {
    const row = document.createElement('div'); row.className = 'document-source-row'; const label = document.createElement('span'); label.textContent = search.name;
    row.append(label, investigationButton('この条件で探す', () => rerunInvestigationSearch(search.id)), investigationButton('関連解除', () => detachInvestigationItem('searches', search.id)));
    host.append(row);
  }
  if (!host.childElementCount) host.textContent = 'この調査に保存検索はありません。';
}

async function attachInvestigationDocument() {
  const id = document.getElementById('investigation-document-select').value;
  if (!id) { investigationStatus('関連付ける原稿がありません。', true); return; }
  try { const result = await api.post(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/documents`, { id }); setInvestigationWorkspace(result.workspace); }
  catch (error) { investigationStatus(error.message || '原稿を関連付けられませんでした。', true); }
}

async function attachInvestigationSavedSearch() {
  const id = document.getElementById('investigation-search-select').value;
  if (!id) { investigationStatus('関連付ける保存検索がありません。', true); return; }
  try { const result = await api.post(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/searches`, { id }); setInvestigationWorkspace(result.workspace); }
  catch (error) { investigationStatus(error.message || '保存検索を関連付けられませんでした。', true); }
}

async function detachInvestigationItem(kind, id) {
  try { await api.del(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/${kind}/${encodeURIComponent(id)}`); await openInvestigationWorkspace(activeInvestigationWorkspace.id); }
  catch (error) { investigationStatus(error.message || '関連付けを解除できませんでした。', true); }
}

async function rerunInvestigationSearch(id) {
  try {
    if (typeof loadSavedSearches === 'function') await loadSavedSearches();
    switchView('bm25');
    restoreSavedSearch(id);
    await runSearchScreen();
  } catch (error) { investigationStatus(error.message || '保存検索を再実行できませんでした。', true); }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('investigation-search-query')?.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) runInvestigationSearch(); });
  document.getElementById('investigation-source-query')?.addEventListener('keydown', event => { if (event.key === 'Enter') searchInvestigationSources(); });
  document.getElementById('investigation-search-query')?.addEventListener('input', () => {
    clearTimeout(investigationSearchDebounce);
    investigationSearchDebounce = setTimeout(() => { if (activeInvestigationWorkspace) void saveInvestigationState({ searchQuery: document.getElementById('investigation-search-query').value }); }, 350);
  });
  document.getElementById('investigation-compare-purpose')?.addEventListener('input', () => {
    clearTimeout(investigationCompareDebounce);
    investigationCompareDebounce = setTimeout(() => { if (activeInvestigationWorkspace) void saveInvestigationState({ comparePurpose: document.getElementById('investigation-compare-purpose').value }); }, 350);
  });
});
