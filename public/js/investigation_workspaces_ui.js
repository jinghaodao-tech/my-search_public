let investigationWorkspaces = [];
let activeInvestigationWorkspace = null;
let investigationSearchConfig = null;
let investigationGraph = null;
let investigationSearchDebounce = null;
let investigationCompareDebounce = null;
let activeInvestigationPanel = 'materials';
let activeInvestigationOrganizeView = 'board';
let thoughtSearchResults = [];
let selectedThoughtNote = null;
let thoughtEditorDirty = false;
let activeThoughtView = 'list';
let thoughtNetwork = null;
let thoughtCompareTimer = null;
let thoughtAIController = null;
let thoughtAIRequestId = 0;
let thoughtComparisonHome = null;
let investigationMobileView = 'work';

function mountThoughtComparisonForWritingPanel(embedded) {
  const tableHost = document.getElementById('investigation-thought-comparison-table');
  const referenceHost = document.getElementById('thought-comparison-reference');
  if (!tableHost || !referenceHost) return;
  if (!thoughtComparisonHome) {
    thoughtComparisonHome = document.createComment('thought-comparison-home');
    tableHost.parentNode?.insertBefore(thoughtComparisonHome, tableHost);
  }
  if (embedded) referenceHost.append(tableHost);
  else if (thoughtComparisonHome.parentNode) thoughtComparisonHome.parentNode.insertBefore(tableHost, thoughtComparisonHome.nextSibling);
}

function initializeInvestigationPanels() {
  const content = document.getElementById('investigation-content');
  if (!content || content.dataset.integrated === 'true') return;
  const nav = content.querySelector('.investigation-tabs');
  const thoughtSection = content.querySelector(':scope > [data-thought-section]');
  const sections = [...content.querySelectorAll(':scope > .investigation-section')].filter(section => section !== thoughtSection);
  if (sections.length < 5) return;
  const workbench = document.createElement('div'); workbench.className = 'investigation-workbench';
  const sourceDetails = document.createElement('details'); sourceDetails.id = 'investigation-source-details'; sourceDetails.className = 'investigation-source-drawer'; sourceDetails.open = true;
  const sourceSummary = document.createElement('summary'); sourceSummary.textContent = '資料・検索・調査の設定'; sourceDetails.append(sourceSummary);
  const sourceRail = document.createElement('div'); sourceRail.id = 'investigation-source-rail'; sourceRail.className = 'investigation-workbench-sources'; sourceRail.setAttribute('aria-label', 'この調査の情報源'); sourceDetails.append(sourceRail);
  const toolbar = document.createElement('div'); toolbar.className = 'investigation-workbench-toolbar';
  const referenceToggle = investigationButton('参照を隠す', () => toggleInvestigationReferencePanel(), 'btn btn-secondary btn-sm');
  referenceToggle.id = 'investigation-reference-toggle'; referenceToggle.setAttribute('aria-expanded', 'true'); toolbar.append(referenceToggle);
  const widthLabel = document.createElement('label'); widthLabel.htmlFor = 'investigation-reference-width'; widthLabel.textContent = '参照幅';
  const width = document.createElement('input'); width.type = 'range'; width.id = 'investigation-reference-width'; width.min = '30'; width.max = '55'; width.value = '40'; width.setAttribute('aria-label', '参照パネルの幅');
  width.addEventListener('input', () => setInvestigationReferenceWidth(Number(width.value)));
  toolbar.append(widthLabel, width);
  const mobileSwitch = document.createElement('div'); mobileSwitch.className = 'investigation-mobile-switch'; mobileSwitch.setAttribute('role', 'group'); mobileSwitch.setAttribute('aria-label', '調査の表示');
  for (const [view, label] of [['work', '作業'], ['reference', '参照']]) {
    const button = investigationButton(label, () => setInvestigationMobileView(view));
    button.dataset.investigationMobileView = view; mobileSwitch.append(button);
  }
  const primary = document.createElement('main'); primary.id = 'investigation-primary-work'; primary.className = 'investigation-primary-work'; primary.setAttribute('aria-label', '調査の主作業');
  const thoughtCanvas = document.createElement('section'); thoughtCanvas.id = 'investigation-thought-canvas'; thoughtCanvas.className = 'investigation-workbench-thoughts'; thoughtCanvas.setAttribute('aria-label', '思考メモ');
  const contextCompare = document.createElement('section'); contextCompare.id = 'investigation-context-compare'; contextCompare.className = 'investigation-context-compare'; contextCompare.dataset.investigationContext = 'compare';
  const reference = document.createElement('aside'); reference.id = 'investigation-reference-work'; reference.className = 'investigation-reference-work'; reference.setAttribute('aria-label', '資料の参照');
  const referenceHeader = document.createElement('header'); referenceHeader.className = 'investigation-reference-header';
  const referenceTitle = document.createElement('h3'); referenceTitle.textContent = '資料を参照';
  const referenceSelect = document.createElement('select'); referenceSelect.id = 'investigation-reference-source'; referenceSelect.setAttribute('aria-label', '参照する調査資料');
  referenceSelect.add(new Option('資料を選択', ''));
  referenceSelect.addEventListener('change', () => { if (referenceSelect.value) void openReaderForCard(referenceSelect.value); });
  referenceHeader.append(referenceTitle, referenceSelect);
  const readerHost = document.createElement('div'); readerHost.id = 'investigation-reference-reader-host'; readerHost.className = 'investigation-reference-reader-host';
  const readerEmpty = document.createElement('p'); readerEmpty.id = 'investigation-reference-empty'; readerEmpty.className = 'reader-note'; readerEmpty.textContent = '資料を選ぶと、思考メモを編集しながら原文やPDFを確認できます。';
  readerHost.append(readerEmpty);
  reference.append(referenceHeader, readerHost);
  workbench.append(sourceDetails, toolbar, mobileSwitch, primary, reference);
  content.append(workbench);
  const [sourceSearch, sourceList, savedSearch, compare, documents] = sections;
  sourceRail.append(sourceSearch, sourceList, savedSearch);
  if (thoughtSection) thoughtCanvas.append(thoughtSection);
  primary.append(thoughtCanvas);
  contextCompare.append(compare);
  documents.dataset.workspaceRequired = 'true';
  const associations = document.createElement('details'); associations.className = 'investigation-document-associations';
  const associationSummary = document.createElement('summary'); associationSummary.textContent = 'この調査の原稿・保存検索'; associations.append(associationSummary);
  while (documents.firstChild) associations.append(documents.firstChild);
  documents.append(associations);

  const organizeSection = document.createElement('details'); organizeSection.className = 'investigation-source-details';
  const detailsHeading = document.createElement('summary'); detailsHeading.textContent = '資料の分類・リンク'; organizeSection.append(detailsHeading);
  const layoutSwitch = document.createElement('div'); layoutSwitch.className = 'investigation-layout-switch';
  for (const [view, label] of [['list', '一覧'], ['board', 'ボード'], ['graph', '関係図']]) {
    const button = investigationButton(label, () => setInvestigationOrganizeView(view));
    button.dataset.organizeViewButton = view; layoutSwitch.append(button);
  }
  organizeSection.append(layoutSwitch);
  const list = document.createElement('div'); list.id = 'investigation-organize-list'; list.dataset.organizeView = 'list'; organizeSection.append(list);
  const groupCreate = document.getElementById('investigation-group-name')?.closest('.investigation-group-create'); if (groupCreate) organizeSection.append(groupCreate);
  for (const [id, view] of [['investigation-groups', 'board'], ['investigation-graph', 'graph']]) {
    const node = document.getElementById(id); if (node) { node.dataset.organizeView = view; organizeSection.append(node); }
  }
  sourceList.append(organizeSection);
  primary.append(contextCompare);

  const editor = document.getElementById('research-writing-view');
  if (editor) { editor.classList.add('embedded'); editor.setAttribute('aria-label', '調査内の原稿エディタ'); primary.append(editor); }
  const thoughtEditor = document.getElementById('investigation-thought-editor');
  if (thoughtEditor) {
    const thoughtEmpty = document.createElement('p'); thoughtEmpty.id = 'thought-editor-empty'; thoughtEmpty.className = 'thought-editor-empty';
    thoughtEmpty.textContent = '一覧または関係マップから思考メモを選ぶと、ここで編集できます。';
    thoughtEditor.parentElement?.insertBefore(thoughtEmpty, thoughtEditor);
  }
  nav?.remove();
  content.dataset.integrated = 'true';
  setInvestigationPanel(activeInvestigationPanel, { persist: false });
  setInvestigationOrganizeView(activeInvestigationOrganizeView, false);
}

function setInvestigationPanel(panel, options = {}) {
  if (!['materials', 'thoughts', 'organize', 'compare', 'documents'].includes(panel)) return;
  if (!activeInvestigationWorkspace && panel !== 'documents') return;
  const editor = document.getElementById('research-writing-view');
  if (activeInvestigationPanel === 'documents' && panel !== 'documents' && typeof persistResearchDraft === 'function') persistResearchDraft();
  if (activeInvestigationPanel === 'thoughts' && panel !== 'thoughts' && thoughtEditorDirty) persistThoughtDraft();
  const requestedPanel = panel;
  if (panel === 'organize') { setThoughtView('map'); panel = 'thoughts'; }
  const context = panel === 'compare' ? 'compare' : panel === 'documents' ? 'documents' : 'thoughts';
  activeInvestigationPanel = panel === 'materials' ? 'thoughts' : panel;
  mountThoughtComparisonForWritingPanel(context === 'documents');
  const content = document.getElementById('investigation-content');
  if (content) content.hidden = !activeInvestigationWorkspace && context !== 'documents';
  const thinking = context === 'thoughts';
  const comparing = context === 'compare';
  const writing = context === 'documents';
  document.getElementById('investigation-source-details')?.toggleAttribute('hidden', !activeInvestigationWorkspace || writing);
  document.getElementById('investigation-thought-canvas')?.toggleAttribute('hidden', !activeInvestigationWorkspace || comparing || writing);
  document.getElementById('investigation-context-compare')?.toggleAttribute('hidden', !comparing);
  document.getElementById('investigation-reference-work')?.toggleAttribute('hidden', !thinking);
  const workbench = document.querySelector('.investigation-workbench');
  workbench?.classList.toggle('documents-only', writing);
  workbench?.classList.toggle('comparison-focus', comparing);
  workbench?.classList.toggle('thinking-mode', thinking);
  document.querySelectorAll('[data-context-action]').forEach(button => button.classList.toggle('active', button.dataset.contextAction === context || (context === 'thoughts' && button.dataset.contextAction === 'thoughts')));
  editor?.classList.toggle('active', context === 'documents');
  if (typeof mountThoughtEditorForCurrentContext === 'function') mountThoughtEditorForCurrentContext();
  if (typeof renderInvestigationReferenceSources === 'function') renderInvestigationReferenceSources();
  if (context === 'documents' && typeof loadResearchDocuments === 'function') void loadResearchDocuments();
  if (context === 'thoughts') { void searchThoughtNotes(); renderThoughtEditorSections(); renderThoughtComparison(); }
  if (context === 'compare') renderThoughtComparison();
  if (thinking) restoreInvestigationLayoutState();
  if (requestedPanel === 'materials') document.getElementById('investigation-source-query')?.focus({ preventScroll: true });
  if (options.persist !== false && activeInvestigationWorkspace) void saveInvestigationState({ activePanel: panel });
}

function investigationLayoutKey(name) { return `my-search:investigation:${activeInvestigationWorkspace?.id ?? 'none'}:${name}`; }

function setInvestigationReferenceWidth(referencePercent) {
  const width = Math.max(30, Math.min(55, Math.round(referencePercent)));
  const workbench = document.querySelector('.investigation-workbench');
  if (!workbench) return;
  workbench.style.setProperty('--investigation-reference-percent', `${width}%`);
  const input = document.getElementById('investigation-reference-width'); if (input) input.value = String(width);
  if (activeInvestigationWorkspace) { try { localStorage.setItem(investigationLayoutKey('reference-width'), String(width)); } catch { /* browser storage may be disabled */ } }
}

function toggleInvestigationReferencePanel(force = undefined) {
  const workbench = document.querySelector('.investigation-workbench'); if (!workbench) return;
  const collapsed = force ?? !workbench.classList.contains('reference-collapsed');
  workbench.classList.toggle('reference-collapsed', collapsed);
  const button = document.getElementById('investigation-reference-toggle');
  if (button) { button.textContent = collapsed ? '参照を表示' : '参照を隠す'; button.setAttribute('aria-expanded', String(!collapsed)); }
  if (activeInvestigationWorkspace) { try { localStorage.setItem(investigationLayoutKey('reference-collapsed'), String(collapsed)); } catch { /* browser storage may be disabled */ } }
}

function setInvestigationMobileView(view, persist = true) {
  if (!['work', 'reference'].includes(view)) return;
  investigationMobileView = view;
  const workbench = document.querySelector('.investigation-workbench'); if (workbench) workbench.dataset.mobileView = view;
  document.querySelectorAll('[data-investigation-mobile-view]').forEach(button => button.classList.toggle('active', button.dataset.investigationMobileView === view));
  if (persist && activeInvestigationWorkspace) { try { localStorage.setItem(investigationLayoutKey('mobile-view'), view); } catch { /* browser storage may be disabled */ } }
}

function restoreInvestigationLayoutState() {
  if (!activeInvestigationWorkspace) return;
  try {
    const width = Number(localStorage.getItem(investigationLayoutKey('reference-width')));
    setInvestigationReferenceWidth(Number.isFinite(width) && width > 0 ? width : 40);
    toggleInvestigationReferencePanel(localStorage.getItem(investigationLayoutKey('reference-collapsed')) === 'true');
    const mobileView = localStorage.getItem(investigationLayoutKey('mobile-view'));
    setInvestigationMobileView(mobileView === 'reference' ? 'reference' : 'work', false);
  } catch { setInvestigationReferenceWidth(40); toggleInvestigationReferencePanel(false); setInvestigationMobileView('work', false); }
}

function renderInvestigationReferenceSources() {
  const select = document.getElementById('investigation-reference-source'); if (!select) return;
  const selected = (typeof readerCardId === 'string' && readerCardId) || select.value;
  select.replaceChildren(new Option('資料を選択', ''));
  for (const source of activeInvestigationWorkspace?.sources ?? []) select.add(new Option(source.card.title, source.card.id));
  select.value = [...select.options].some(option => option.value === selected) ? selected : '';
  const empty = document.getElementById('investigation-reference-empty');
  if (empty) empty.hidden = Boolean(document.getElementById('modal-reader')?.dataset.readerEmbedded === 'true');
}

function syncInvestigationReferenceSource(cardId) {
  const select = document.getElementById('investigation-reference-source'); if (select) select.value = cardId;
  const empty = document.getElementById('investigation-reference-empty'); if (empty) empty.hidden = true;
}

function isInvestigationThoughtWorkspaceActive() {
  return Boolean(typeof currentView !== 'undefined' && currentView === 'investigations'
    && activeInvestigationWorkspace && activeInvestigationPanel === 'thoughts'
    && document.getElementById('investigation-reference-reader-host'));
}

function mountThoughtEditorForCurrentContext() {
  const editor = document.getElementById('investigation-thought-editor'); if (!editor) return;
  const inDocumentThoughts = typeof isResearchDocumentWorkspaceActive === 'function'
    && isResearchDocumentWorkspaceActive() && typeof documentReferenceTab !== 'undefined'
    && documentReferenceTab === 'thoughts';
  const target = inDocumentThoughts
    ? document.getElementById('document-reference-thought-editor')
    : document.querySelector('#investigation-thought-canvas .thought-work-area');
  if (target && editor.parentElement !== target) target.append(editor);
}

async function openThoughtNoteInDocumentReference(id) {
  if (!id) return;
  if (typeof setDocumentReferenceTab === 'function') setDocumentReferenceTab('thoughts');
  const select = document.getElementById('document-reference-thought-select'); if (select) select.value = id;
  await openThoughtNote(id, { keepContext: true });
  mountThoughtEditorForCurrentContext();
}

function setInvestigationOrganizeView(view, persist = true) {
  if (!['list', 'board', 'graph'].includes(view)) return;
  activeInvestigationOrganizeView = view;
  document.querySelectorAll('[data-organize-view]').forEach(node => { node.hidden = node.dataset.organizeView !== view; });
  document.querySelectorAll('[data-organize-view-button]').forEach(button => button.classList.toggle('active', button.dataset.organizeViewButton === view));
  if (view === 'list') renderInvestigationOrganizeList();
  if (view === 'graph' && activeInvestigationWorkspace) requestAnimationFrame(() => void loadInvestigationGraph());
  if (persist && activeInvestigationWorkspace) void saveInvestigationState({ organizeView: view });
}

function renderInvestigationOrganizeList() {
  const host = document.getElementById('investigation-organize-list'); if (!host) return;
  host.replaceChildren();
  const sources = activeInvestigationWorkspace?.sources ?? [];
  if (!sources.length) { host.textContent = 'この調査にはまだ資料がありません。'; return; }
  for (const source of sources) {
    const row = document.createElement('div'); row.className = 'document-source-row investigation-source-row';
    const title = document.createElement('span'); title.className = 'investigation-source-title'; title.textContent = source.card.title;
    const group = document.createElement('select'); group.setAttribute('aria-label', `${source.card.title}の調査内分類`);
    const none = document.createElement('option'); none.value = ''; none.textContent = '未分類'; group.append(none);
    for (const item of activeInvestigationWorkspace.groups ?? []) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; group.append(option); }
    group.value = source.groupId ?? ''; group.onchange = () => updateInvestigationSourceGroup(source.card.id, group.value || null);
    row.append(title, group, investigationButton('Reader', () => openReaderForCard(source.card.id))); host.append(row);
  }
}

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
  const previousWorkspaceId = activeInvestigationWorkspace?.id ?? null;
  const workspaceChanged = previousWorkspaceId !== (workspace?.id ?? null);
  if (workspaceChanged && thoughtEditorDirty) persistThoughtDraft();
  activeInvestigationWorkspace = workspace;
  if (workspaceChanged) { selectedThoughtNote = null; thoughtEditorDirty = false; }
  const enabled = Boolean(workspace);
  for (const id of ['investigation-name', 'investigation-purpose', 'investigation-save', 'investigation-delete']) document.getElementById(id).disabled = !enabled;
  document.getElementById('investigation-content').hidden = !enabled && !['documents', 'thoughts'].includes(activeInvestigationPanel);
  document.querySelectorAll('[data-investigation-panel]').forEach(button => { button.disabled = !enabled && !['documents', 'thoughts'].includes(button.dataset.investigationPanel); });
  document.querySelectorAll('[data-workspace-required="true"]').forEach(node => { node.hidden = !enabled; });
  document.querySelectorAll('[data-thought-workspace-only]').forEach(node => { node.hidden = !enabled; });
  document.getElementById('investigation-name').value = workspace?.name ?? '';
  document.getElementById('investigation-purpose').value = workspace?.purpose ?? '';
  document.getElementById('investigation-search-query').value = workspace?.state?.searchQuery ?? '';
  document.getElementById('investigation-compare-purpose').value = workspace?.state?.comparePurpose ?? '';
  activeInvestigationPanel = window.mySearchOpenDocumentsOnEnter ? 'documents' : (workspace?.state?.activePanel ?? activeInvestigationPanel);
  window.mySearchOpenDocumentsOnEnter = false;
  activeInvestigationOrganizeView = workspace?.state?.organizeView ?? activeInvestigationOrganizeView;
  activeThoughtView = workspace?.state?.thoughtView ?? activeThoughtView;
  initializeInvestigationPanels();
  setInvestigationPanel(activeInvestigationPanel, { persist: false });
  setInvestigationOrganizeView(activeInvestigationOrganizeView, false);
  setThoughtView(activeThoughtView, false);
  renderInvestigationWorkspaceList();
  if (!workspace) return;
  renderInvestigationSources();
  renderInvestigationOrganizeList();
  renderInvestigationGroups();
  renderInvestigationCompareSelection();
  renderInvestigationDocuments();
  renderInvestigationSavedSearches();
  renderThoughtNoteList();
  renderThoughtEditorSections();
  renderDocumentThoughtOptions();
  renderInvestigationReferenceSources();
  renderThoughtComparison();
  void loadInvestigationGraph();
  const rememberedThoughtId = workspace?.state?.thoughtNoteId;
  if (workspaceChanged && rememberedThoughtId) void openThoughtNote(rememberedThoughtId, { keepContext: true });
  investigationSearchConfig = null;
}

async function loadInvestigationWorkspaces(preferredId = null) {
  try {
    const result = await api.get('/api/workspaces');
    investigationWorkspaces = result.workspaces ?? [];
    renderInvestigationWorkspaceList();
    let rememberedId = null;
    try { rememberedId = localStorage.getItem('my-search:active-investigation-workspace'); } catch { /* local storage may be disabled */ }
    const targetId = preferredId || activeInvestigationWorkspace?.id || rememberedId;
    const selected = investigationWorkspaces.find(row => row.id === targetId) || investigationWorkspaces[0];
    if (selected) await openInvestigationWorkspace(selected.id);
    else {
      setInvestigationWorkspace(null);
      investigationStatus('調査を作成するか、既存の調査を選んでください。');
    }
  } catch (error) { investigationStatus(error.message || '調査一覧を読み込めませんでした。', true); }
}

async function openInvestigationWorkspace(id) {
  if (thoughtEditorDirty) persistThoughtDraft();
  try {
    const result = await api.get(`/api/workspaces/${encodeURIComponent(id)}`);
    try { localStorage.setItem('my-search:active-investigation-workspace', id); } catch { /* local storage may be disabled */ }
    setInvestigationWorkspace(result.workspace);
    investigationStatus('調査を開きました。検索結果は「資料に追加」を押したときだけ関連付けます。');
  } catch (error) { investigationStatus(error.message || '調査を開けませんでした。', true); }
}

async function openAllResearchDocuments() {
  if (thoughtEditorDirty && !(await saveThoughtNote())) return;
  if (activeResearchDocument && !preserveResearchDraftBeforeSwitch()) return;
  setInvestigationWorkspace(null);
  setInvestigationPanel('documents', { persist: false });
  investigationStatus('すべての原稿を表示しています。原稿は調査へ関連付けずに編集できます。');
  void loadResearchDocuments();
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
  if (thoughtEditorDirty && !(await saveThoughtNote())) return;
  const oldId = activeInvestigationWorkspace.id;
  try {
    await api.del(`/api/workspaces/${encodeURIComponent(oldId)}`);
    try { if (localStorage.getItem('my-search:active-investigation-workspace') === oldId) localStorage.removeItem('my-search:active-investigation-workspace'); } catch { /* local storage may be disabled */ }
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
    const compare = document.createElement('input'); compare.type = 'checkbox'; compare.className = 'investigation-compare-source';
    compare.setAttribute('aria-label', `${source.card.title}を比較対象にする`);
    const selectedIds = activeInvestigationWorkspace.state?.compareCardIds;
    compare.checked = Array.isArray(selectedIds) ? selectedIds.includes(source.card.id) : true;
    compare.dataset.cardId = source.card.id;
    compare.onchange = () => updateInvestigationCompareSelection(source.card.id, compare.checked);
    const group = document.createElement('select'); group.setAttribute('aria-label', `${source.card.title}の調査内分類`);
    const ungrouped = document.createElement('option'); ungrouped.value = ''; ungrouped.textContent = '未分類'; group.append(ungrouped);
    for (const item of activeInvestigationWorkspace.groups ?? []) {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; group.append(option);
    }
    group.value = source.groupId ?? '';
    group.onchange = () => updateInvestigationSourceGroup(source.card.id, group.value || null);
    row.append(compare, label, group,
      investigationButton('Readerで開く', () => openReaderForCard(source.card.id)),
      investigationButton('関連解除', () => removeInvestigationSource(source.card.id), 'btn btn-secondary btn-sm'));
    host.append(row);
  }
}

function renderInvestigationCompareSelection() {
  const host = document.getElementById('investigation-compare-source-selection'); if (!host) return;
  host.replaceChildren();
  const sources = activeInvestigationWorkspace?.sources ?? [];
  if (!sources.length) { host.textContent = '先に「資料」から保存記事やメモを追加してください。'; return; }
  const selectedIds = activeInvestigationWorkspace.state?.compareCardIds;
  for (const source of sources) {
    const label = document.createElement('label'); label.className = 'investigation-compare-choice';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.cardId = source.card.id;
    checkbox.checked = Array.isArray(selectedIds) ? selectedIds.includes(source.card.id) : true;
    checkbox.setAttribute('aria-label', `${source.card.title}を比較対象にする`);
    checkbox.onchange = () => updateInvestigationCompareSelection(source.card.id, checkbox.checked);
    const title = document.createElement('span'); title.textContent = source.card.title;
    label.append(checkbox, title); host.append(label);
  }
}

function updateInvestigationCompareSelection(cardId, checked) {
  if (!activeInvestigationWorkspace) return;
  const current = activeInvestigationWorkspace.state?.compareCardIds;
  const selected = new Set(Array.isArray(current) ? current : (activeInvestigationWorkspace.sources ?? []).map(source => source.card.id));
  if (checked && !selected.has(cardId) && selected.size >= 10) {
    document.querySelectorAll('#investigation-sources .investigation-compare-source, #investigation-compare-source-selection input[type="checkbox"]').forEach(input => {
      if (input.dataset.cardId === cardId) input.checked = false;
    });
    investigationStatus('一度に比較できる資料は10件までです。', true);
    return;
  }
  if (checked) selected.add(cardId); else selected.delete(cardId);
  const compareCardIds = [...selected].filter(id => activeInvestigationWorkspace.sources?.some(source => source.card.id === id));
  activeInvestigationWorkspace.state = { ...(activeInvestigationWorkspace.state ?? {}), compareCardIds };
  document.querySelectorAll('#investigation-sources .investigation-compare-source, #investigation-compare-source-selection input[type="checkbox"]').forEach(input => {
    if (input.dataset.cardId === cardId) input.checked = checked;
  });
  void saveInvestigationState({ compareCardIds });
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
  const columns = [{ id: null, name: '未分類' }, ...groups];
  if (!activeInvestigationWorkspace?.sources?.length && !groups.length) { host.textContent = '資料を追加し、分類を作るとボードで整理できます。'; return; }
  host.classList.add('investigation-kanban');
  for (const group of columns) {
    const column = document.createElement('section'); column.className = 'investigation-kanban-column investigation-group-drop';
    column.dataset.groupId = group.id ?? '';
    column.addEventListener('dragover', event => { event.preventDefault(); column.classList.add('drag-over'); });
    column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
    column.addEventListener('drop', event => {
      event.preventDefault(); column.classList.remove('drag-over');
      const cardId = event.dataTransfer?.getData('text/plain'); if (cardId) void updateInvestigationSourceGroup(cardId, group.id);
    });
    const heading = document.createElement('header'); heading.className = 'investigation-kanban-heading';
    const label = document.createElement('strong'); label.textContent = group.name;
    const members = (activeInvestigationWorkspace.sources ?? []).filter(source => (source.groupId ?? null) === group.id);
    const tally = document.createElement('span'); tally.textContent = `${members.length}`;
    heading.append(label, tally);
    if (group.id) {
      heading.append(investigationButton('名前変更', async () => {
        const name = prompt('新しい分類名', group.name)?.trim(); if (!name || name === group.name) return;
        try {
          const result = await api.put(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/groups/${encodeURIComponent(group.id)}`, { name });
          setInvestigationWorkspace(result.workspace);
        } catch (error) { investigationStatus(error.message || '分類名を変更できませんでした。', true); }
      }));
      heading.append(investigationButton('削除', () => deleteInvestigationGroup(group.id)));
    }
    column.append(heading);
    for (const source of members) {
      const card = document.createElement('article'); card.className = 'investigation-kanban-card'; card.draggable = true;
      card.addEventListener('dragstart', event => event.dataTransfer?.setData('text/plain', source.card.id));
      const title = document.createElement('strong'); title.textContent = source.card.title; title.title = source.card.title;
      const select = document.createElement('select'); select.setAttribute('aria-label', `${source.card.title}の調査内分類`);
      for (const item of [{ id: '', name: '未分類' }, ...groups.map(item => ({ id: item.id, name: item.name }))]) {
        const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; select.append(option);
      }
      select.value = source.groupId ?? ''; select.onchange = () => updateInvestigationSourceGroup(source.card.id, select.value || null);
      card.append(title, select, investigationButton('Readerで読む', () => openReaderForCard(source.card.id)));
      column.append(card);
    }
    if (!members.length) { const empty = document.createElement('p'); empty.className = 'reader-note'; empty.textContent = '資料をここへドラッグできます'; column.append(empty); }
    host.append(column);
  }
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
  const selectedIds = activeInvestigationWorkspace.state?.compareCardIds;
  const cardIds = (Array.isArray(selectedIds) ? selectedIds : (activeInvestigationWorkspace.sources ?? []).map(source => source.card.id)).slice(0, 10);
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
      actions.append(investigationButton(activeInvestigationWorkspace.documents?.length ? '原稿に引用' : '原稿を作成して引用', () => insertInvestigationCitation(evidence)));
      row.append(source, quote, claim, actions); host.append(row);
    }
    if (!host.childElementCount) host.textContent = '一致箇所を確認できませんでした。資料をReaderで確認してください。';
    await saveInvestigationState({ comparePurpose: purpose });
  } catch (error) { host.textContent = error.message || '資料を比較できませんでした。'; }
}

async function insertInvestigationCitation(evidence) {
  if (typeof insertVerifiedDocumentCitation !== 'function') return;
  let documentId = activeInvestigationWorkspace?.documents?.[0]?.id;
  if (!documentId) {
    setInvestigationPanel('documents');
    await newResearchDocument();
    documentId = activeResearchDocument?.id;
    if (documentId) {
      try {
        const result = await api.post(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/documents`, { id: documentId });
        setInvestigationWorkspace(result.workspace);
      } catch (error) { investigationStatus(error.message || '原稿を調査に関連付けられませんでした。', true); return; }
    }
  }
  if (!documentId) return;
  setInvestigationPanel('documents');
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
    row.append(label, investigationButton('編集', async () => { setInvestigationPanel('documents'); await openResearchDocument(doc.id); }), investigationButton('関連解除', () => detachInvestigationItem('documents', doc.id)));
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
    const searches = await api.get('/api/saved-searches');
    const saved = searches.find(search => search.id === id);
    if (!saved) throw new Error('保存検索が見つかりません。');
    if (saved.source === 'cards') {
      const host = document.getElementById('investigation-search-results'); host.replaceChildren();
      document.getElementById('investigation-search-query').value = saved.name;
      investigationStatus('保存した条件で保存資料を検索しています…');
      const result = await api.post('/api/cards/search', { config: saved.config, options: saved.options, filters: saved.filters });
      for (const item of result.active ?? []) {
        const row = document.createElement('div'); row.className = 'document-source-row';
        const label = document.createElement('span'); label.textContent = `${item.article.title} · ${item.snippet || ''}`;
        row.append(label, investigationButton('Readerで読む', () => openReaderForCard(item.article.id)), investigationButton('資料に追加', () => addInvestigationSource(item.article.id)));
        host.append(row);
      }
      if (!host.childElementCount) host.textContent = '一致する保存記事はありませんでした。';
      await saveInvestigationState({ searchQuery: saved.name });
      investigationStatus(`${result.active?.length ?? 0}件を調査内に表示しました。`);
      return;
    }
    if (typeof loadSavedSearches === 'function') await loadSavedSearches();
    investigationStatus('Web・収集記事を含む保存検索は「探す」で再実行します。調査と選択状態は保持されます。');
    switchView('bm25');
    restoreSavedSearch(id);
    await runSearchScreen();
  } catch (error) { investigationStatus(error.message || '保存検索を再実行できませんでした。', true); }
}

function thoughtKindLabel(kind) {
  return ({ free: '自由メモ', question: '疑問', hypothesis: '仮説', interpretation: '解釈', evidence: '根拠', counterargument: '反論候補', decision: '判断' })[kind] ?? '自由メモ';
}

function thoughtText(tag, text, className = '') {
  const node = document.createElement(tag); if (className) node.className = className; node.textContent = text; return node;
}

function thoughtDraftKey(id) { return `my-search:thought-draft:${id}`; }

function persistThoughtDraft() {
  if (!selectedThoughtNote || !thoughtEditorDirty) return;
  try {
    localStorage.setItem(thoughtDraftKey(selectedThoughtNote.id), JSON.stringify({
      version: selectedThoughtNote.version,
      title: document.getElementById('thought-edit-title').value,
      body: document.getElementById('thought-edit-body').value,
      kind: document.getElementById('thought-edit-kind').value,
      savedAt: new Date().toISOString(),
    }));
  } catch { /* browser storage can be disabled or full; server save remains available */ }
}

function setThoughtView(view, persist = true) {
  if (!['list', 'map'].includes(view)) return;
  activeThoughtView = view;
  document.querySelectorAll('[data-thought-view]').forEach(node => { node.hidden = node.dataset.thoughtView !== view; });
  document.querySelectorAll('[data-thought-view-button]').forEach(button => button.classList.toggle('active', button.dataset.thoughtViewButton === view));
  document.querySelectorAll('[data-thought-view-controls]').forEach(node => { node.hidden = node.dataset.thoughtViewControls !== view; });
  if (view === 'map' && activeInvestigationWorkspace) void loadThoughtMap();
  else if (view === 'map') {
    const host = document.getElementById('investigation-thought-map');
    if (host) host.textContent = '関係マップは調査ごとに表示されます。調査を開くと、同じ思考メモを関係付けて配置できます。';
  }
  if (persist && activeInvestigationWorkspace) void saveInvestigationState({ thoughtView: view });
}

async function searchThoughtNotes() {
  const query = document.getElementById('investigation-thought-search')?.value.trim() ?? '';
  const host = document.getElementById('investigation-thought-list');
  if (!host) return;
  try {
    const result = await api.get(`/api/thought-notes${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    thoughtSearchResults = result.thoughts ?? [];
    renderThoughtNoteList();
  } catch (error) { host.textContent = error.message || '思考メモを検索できませんでした。'; }
}

function renderThoughtNoteList() {
  const host = document.getElementById('investigation-thought-list'); if (!host) return;
  host.replaceChildren();
  const workspace = activeInvestigationWorkspace;
  const attached = workspace?.thoughts ?? [];
  const rows = new Map();
  for (const note of [...attached, ...thoughtSearchResults]) rows.set(note.id, note);
  if (!rows.size) { host.textContent = '思考メモはまだありません。形式を決めずに上から書き始められます。'; return; }
  for (const note of rows.values()) {
    const membership = attached.find(row => row.id === note.id);
    const item = document.createElement('article'); item.className = 'thought-note-item';
    item.classList.toggle('active', selectedThoughtNote?.id === note.id);
    const select = investigationButton(note.title || note.body.slice(0, 72) || '無題の思考メモ', () => void openThoughtNote(note.id), 'thought-note-select');
    select.setAttribute('aria-label', `思考メモを開く: ${note.title || note.body.slice(0, 72)}`);
    const summary = thoughtText('small', `${thoughtKindLabel(note.kind)} · ${new Date(note.updatedAt ?? note.updated_at).toLocaleDateString()}`, 'thought-note-meta');
    item.append(select, summary);
    if (workspace && membership) {
      const compare = document.createElement('label'); compare.className = 'thought-compare-check';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = Boolean(workspace.state?.thoughtCompare?.noteIds?.includes(note.id));
      checkbox.setAttribute('aria-label', `${note.title || note.body.slice(0, 40)}を比較に含める`);
      checkbox.onchange = () => setThoughtComparisonNote(note.id, checkbox.checked);
      compare.append(checkbox, thoughtText('span', '比較')); item.append(compare);
      const group = document.createElement('select'); group.setAttribute('aria-label', `${note.title || '思考メモ'}の調査内分類`);
      const none = document.createElement('option'); none.value = ''; none.textContent = '未分類'; group.append(none);
      for (const row of workspace.groups ?? []) { const option = document.createElement('option'); option.value = row.id; option.textContent = row.name; group.append(option); }
      group.value = membership.groupId ?? ''; group.onchange = () => void updateThoughtPlacement(note.id, { groupId: group.value || null }); item.append(group);
    } else if (workspace) {
      item.append(investigationButton('この調査に追加', () => void attachThoughtNote(note.id)));
    }
    host.append(item);
  }
  const selectedCount = workspace?.state?.thoughtCompare?.noteIds?.filter(id => attached.some(note => note.id === id)).length ?? 0;
  const compareButton = document.querySelector('[data-context-action="compare"][data-workspace-required="true"]');
  if (compareButton) compareButton.textContent = selectedCount ? `選択したメモを比較 (${selectedCount})` : '選択したメモを比較';
}

function openSelectedThoughtComparison() {
  const ids = activeInvestigationWorkspace?.state?.thoughtCompare?.noteIds?.filter(id => activeInvestigationWorkspace.thoughts.some(note => note.id === id)) ?? [];
  if (ids.length < 2) { investigationStatus('比較する思考メモを2件以上選んでください。', true); return; }
  setInvestigationPanel('compare');
}

async function createThoughtNote() {
  const title = document.getElementById('thought-new-title').value.trim();
  const body = document.getElementById('thought-new-body').value;
  if (!title && !body.trim()) { investigationStatus('思い出したことを短くても入力してください。', true); return; }
  try {
    const result = await api.post('/api/thought-notes', { title, body, kind: document.getElementById('thought-new-kind').value });
    if (activeInvestigationWorkspace) {
      const attached = await api.post(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/thought-notes`, { thoughtNoteId: result.thought.id });
      setInvestigationWorkspace(attached.workspace);
    }
    document.getElementById('thought-new-title').value = '';
    document.getElementById('thought-new-body').value = '';
    await searchThoughtNotes();
    await openThoughtNote(result.thought.id);
    investigationStatus('思考メモを保存しました。分類や関係はあとから変更できます。');
  } catch (error) { investigationStatus(error.message || '思考メモを作成できませんでした。', true); }
}

async function attachThoughtNote(id) {
  if (!activeInvestigationWorkspace) return;
  try {
    const result = await api.post(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/thought-notes`, { thoughtNoteId: id });
    setInvestigationWorkspace(result.workspace); await openThoughtNote(id);
    investigationStatus('既存の思考メモをこの調査に関連付けました。本文は複製していません。');
  } catch (error) { investigationStatus(error.message || '思考メモを追加できませんでした。', true); }
}

async function openThoughtNote(id, options = {}) {
  if (!options.keepContext && activeInvestigationWorkspace && activeInvestigationPanel !== 'thoughts') setInvestigationPanel('thoughts');
  if (thoughtEditorDirty) persistThoughtDraft();
  try {
    const result = await api.get(`/api/thought-notes/${encodeURIComponent(id)}`);
    selectedThoughtNote = result.thought; thoughtEditorDirty = false;
    if (activeInvestigationWorkspace) void saveInvestigationState({ thoughtNoteId: id });
    const selectedLabel = document.getElementById('investigation-context-selection');
    if (selectedLabel) selectedLabel.textContent = `選択中: ${selectedThoughtNote.title || selectedThoughtNote.body.slice(0, 60) || '無題の思考メモ'}`;
    cancelThoughtAI(); document.getElementById('thought-ai-result')?.replaceChildren();
    document.getElementById('investigation-thought-editor').hidden = false;
    const emptyState = document.getElementById('thought-editor-empty'); if (emptyState) emptyState.hidden = true;
    document.getElementById('thought-edit-title').value = selectedThoughtNote.title;
    document.getElementById('thought-edit-kind').value = selectedThoughtNote.kind;
    document.getElementById('thought-edit-body').value = selectedThoughtNote.body;
    document.getElementById('thought-editor-status').textContent = selectedThoughtNote.title || selectedThoughtNote.body.slice(0, 50) || '思考メモ';
    document.getElementById('thought-version-label').textContent = `版 ${selectedThoughtNote.version}`;
    try {
      const rawDraft = localStorage.getItem(thoughtDraftKey(id));
      const draft = rawDraft ? JSON.parse(rawDraft) : null;
      if (draft && draft.version === selectedThoughtNote.version) {
        document.getElementById('thought-edit-title').value = draft.title ?? selectedThoughtNote.title;
        document.getElementById('thought-edit-kind').value = draft.kind ?? selectedThoughtNote.kind;
        document.getElementById('thought-edit-body').value = draft.body ?? selectedThoughtNote.body;
        const differs = draft.title !== selectedThoughtNote.title || draft.body !== selectedThoughtNote.body || draft.kind !== selectedThoughtNote.kind;
        thoughtEditorDirty = differs;
        if (differs) document.getElementById('thought-version-label').textContent = '未保存の変更を復元';
      } else if (draft) {
        document.getElementById('thought-version-label').textContent = `保存済み版 ${selectedThoughtNote.version} と未保存下書きが競合しています。下書きはブラウザー内に保持しました。`;
      }
    } catch { /* retain server copy if a local draft is unreadable */ }
    document.getElementById('thought-history').replaceChildren();
    renderThoughtNoteList(); renderThoughtEditorSections(); renderDocumentThoughtOptions(); mountThoughtEditorForCurrentContext();
  } catch (error) { investigationStatus(error.message || '思考メモを開けませんでした。', true); }
}

async function saveThoughtNote() {
  if (!selectedThoughtNote) return true;
  if (!thoughtEditorDirty) return true;
  const title = document.getElementById('thought-edit-title').value;
  const body = document.getElementById('thought-edit-body').value;
  const kind = document.getElementById('thought-edit-kind').value;
  if (!title.trim() && !body.trim()) { investigationStatus('タイトルか本文のどちらかを残してください。', true); return false; }
  try {
    const result = await api.put(`/api/thought-notes/${encodeURIComponent(selectedThoughtNote.id)}`, { title, body, kind, version: selectedThoughtNote.version });
    selectedThoughtNote = result.thought; thoughtEditorDirty = false;
    try { localStorage.removeItem(thoughtDraftKey(selectedThoughtNote.id)); } catch { /* ignore unavailable browser storage */ }
    thoughtSearchResults = thoughtSearchResults.map(note => note.id === selectedThoughtNote.id ? selectedThoughtNote : note);
    document.getElementById('thought-editor-status').textContent = title.trim() || body.slice(0, 50);
    document.getElementById('thought-version-label').textContent = `版 ${selectedThoughtNote.version} · 保存済み`;
    const workspaceNote = activeInvestigationWorkspace?.thoughts?.find(note => note.id === selectedThoughtNote.id);
    if (workspaceNote) Object.assign(workspaceNote, { title: selectedThoughtNote.title, body: selectedThoughtNote.body, kind, version: selectedThoughtNote.version, updatedAt: selectedThoughtNote.updatedAt });
    renderThoughtNoteList();
    return true;
  } catch (error) { investigationStatus(error.message || '思考メモを保存できませんでした。', true); return false; }
}

function renderThoughtEditorSections() {
  const editor = document.getElementById('investigation-thought-editor'); if (!editor) return;
  const note = selectedThoughtNote;
  editor.hidden = !note;
  const emptyState = document.getElementById('thought-editor-empty'); if (emptyState) emptyState.hidden = Boolean(note);
  const workspace = activeInvestigationWorkspace;
  document.querySelectorAll('[data-thought-document-only]').forEach(node => { node.hidden = !(typeof activeResearchDocument !== 'undefined' && activeResearchDocument); });
  const group = document.getElementById('thought-edit-group');
  if (group) {
    const value = workspace?.thoughts?.find(row => row.id === note?.id)?.groupId ?? '';
    group.replaceChildren(); const none = document.createElement('option'); none.value = ''; none.textContent = '未分類'; group.append(none);
    for (const item of workspace?.groups ?? []) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; group.append(option); }
    group.value = value; group.onchange = () => note && void updateThoughtPlacement(note.id, { groupId: group.value || null });
  }
  const source = document.getElementById('thought-reference-source');
  if (source) {
    const previous = source.value; source.replaceChildren();
    for (const item of workspace?.sources ?? []) { const option = document.createElement('option'); option.value = item.card.id; option.textContent = item.card.title; source.append(option); }
    if ([...source.options].some(option => option.value === previous)) source.value = previous;
  }
  renderThoughtReferences(); renderThoughtLinks(); void refreshThoughtAIStatus();
  mountThoughtEditorForCurrentContext();
}

function renderDocumentThoughtOptions() {
  const select = document.getElementById('document-reference-thought-select'); if (!select) return;
  const selectedId = selectedThoughtNote?.id ?? select.value;
  select.replaceChildren(new Option('思考メモを選択', ''));
  for (const note of activeInvestigationWorkspace?.thoughts ?? []) {
    select.add(new Option(note.title || note.body.slice(0, 60) || '無題の思考メモ', note.id));
  }
  select.value = [...select.options].some(option => option.value === selectedId) ? selectedId : '';
}

async function refreshThoughtAIStatus() {
  const status = document.getElementById('thought-ai-status'); const prepare = document.getElementById('thought-ai-prepare');
  if (!status || !prepare) return;
  if (typeof localAi === 'undefined') { status.textContent = '端末内AI機能が読み込まれていません。AIなしのメモ・関係・比較は利用できます。'; prepare.hidden = true; return; }
  try {
    const availability = await localAi.availability('prompt');
    status.textContent = availability === 'available' ? 'Chromeの端末内Prompt AIを利用できます。入力は外部へ送信しません。'
      : availability === 'unavailable' ? 'このブラウザーでは端末内AIを利用できません。AIなしの機能はそのまま使えます。'
        : `端末内AIモデルの状態: ${availability}。準備後に利用できます。`;
    prepare.hidden = !['downloadable', 'downloading'].includes(availability);
  } catch { status.textContent = '端末内AIの状態を確認できません。AIなしの機能は利用できます。'; prepare.hidden = true; }
}

async function prepareThoughtAI() {
  if (typeof localAi === 'undefined') return;
  const button = document.getElementById('thought-ai-prepare'); const status = document.getElementById('thought-ai-status');
  button.disabled = true; status.textContent = 'Chrome端末内AIを準備しています。初回はモデル取得が必要です…';
  try {
    await localAi.prepare('prompt', loaded => { status.textContent = `端末内AIモデルを準備中… ${Math.round(loaded * 100)}%`; });
    status.textContent = 'Chromeの端末内Prompt AIを利用できます。入力は外部へ送信しません。'; button.hidden = true;
  } catch (error) { status.textContent = `モデルを準備できませんでした: ${error.message || error}`; }
  finally { button.disabled = false; }
}

function cancelThoughtAI() {
  thoughtAIRequestId += 1;
  thoughtAIController?.abort(); thoughtAIController = null;
  const button = document.getElementById('thought-ai-cancel'); if (button) button.disabled = true;
}

async function runThoughtAI(kind) {
  if (!selectedThoughtNote) return;
  const host = document.getElementById('thought-ai-result'); const cancel = document.getElementById('thought-ai-cancel');
  if (typeof localAi === 'undefined') { host.textContent = '端末内AI機能がありません。AIなしで操作を続けられます。'; return; }
  if (!(await saveThoughtNote())) return;
  const originalId = selectedThoughtNote.id;
  const baseVersion = selectedThoughtNote.version; const baseTitle = selectedThoughtNote.title; const baseBody = selectedThoughtNote.body; const baseKind = selectedThoughtNote.kind;
  const ready = await localAi.isReady('prompt');
  if (!ready) { host.textContent = '端末内AIモデルが利用可能ではありません。上の「端末内AIを準備」または別のブラウザーを確認してください。モデルなしの生成結果は表示しません。'; void refreshThoughtAIStatus(); return; }
  if (selectedThoughtNote?.id !== originalId) return;
  cancelThoughtAI();
  const controller = new AbortController(); thoughtAIController = controller; const requestId = ++thoughtAIRequestId;
  cancel.disabled = false; host.textContent = '端末内AIに検討候補を依頼しています…';
  try {
    const wantsSourceCandidates = kind === 'related' || kind === 'evidence';
    let pool = activeInvestigationWorkspace?.thoughts ?? thoughtSearchResults;
    let thoughtSearchScope = null;
    if (kind === 'related') {
      const retrievalText = `${selectedThoughtNote.title} ${selectedThoughtNote.body}`.slice(0, 700);
      const noteMatches = await api.get(`/api/thought-notes?q=${encodeURIComponent(retrievalText)}&mode=related`);
      thoughtSearchScope = noteMatches.scope ?? null;
      pool = noteMatches.thoughts ?? [];
    }
    const chosenIds = activeInvestigationWorkspace?.state?.thoughtCompare?.noteIds ?? [];
    const candidates = (kind === 'relations'
      ? pool.filter(note => chosenIds.includes(note.id))
      : kind === 'related' ? pool.filter(note => note.id !== originalId) : []).filter(note => note.id !== originalId).slice(0, kind === 'relations' ? 3 : 8);
    if (kind === 'relations' && !chosenIds.includes(originalId)) throw new Error('現在のメモも一覧の「比較」で選んでください。');
    const refs = selectedThoughtNote.references ?? [];
    let sourceCandidates = []; let sourceSearchScope = null;
    if (wantsSourceCandidates) {
      const retrievalText = `${selectedThoughtNote.title} ${selectedThoughtNote.body}`.slice(0, 700);
      const analyzed = await api.post('/api/search/terms', { text: retrievalText });
      const keywords = (analyzed.keywords ?? []).slice(0, 12);
      if (keywords.length) {
        const config = { label: '思考メモの保存資料候補', description: '', k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5, keywords };
        const result = await api.post('/api/cards/search', {
          config, options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 12 },
          filters: { excludedTerms: [], sources: [], status: 'all' },
        });
        sourceSearchScope = result.scope ?? null;
        sourceCandidates = (result.active ?? []).filter(item => item.article.id !== selectedThoughtNote.sourceCardId).slice(0, 8).map(item => ({
          id: item.article.id, sourceCardId: item.article.id, title: item.article.title,
          excerpt: String(item.snippet || item.article.summary || item.article.body || '').slice(0, 500),
          searchMethod: item.scoreSources?.method ?? 'saved-card-search',
        }));
      }
    }
    if (kind === 'related' && !candidates.length && !sourceCandidates.length) throw new Error('語句検索で関連メモ・保存資料候補が見つかりませんでした。検索語を短くして再試行できます。');
    if (kind === 'relations' && !candidates.length) throw new Error('比較対象に選んだ別の思考メモがありません。');
    if (kind === 'evidence' && !refs.some(reference => reference.verification === 'verified') && !sourceCandidates.length) throw new Error('照合済み引用も保存資料候補もありません。先に調査内の資料を検索してください。');
    const result = await localAi.assistThought(kind, selectedThoughtNote, candidates, refs, { signal: controller.signal, sources: sourceCandidates });
    if (requestId !== thoughtAIRequestId || controller.signal.aborted || selectedThoughtNote?.id !== originalId) return;
    if (selectedThoughtNote.version !== baseVersion || document.getElementById('thought-edit-title').value !== baseTitle || document.getElementById('thought-edit-body').value !== baseBody || document.getElementById('thought-edit-kind').value !== baseKind) {
      host.textContent = '処理中にメモが変更されたため、古い提案を破棄しました。最新の内容で再実行してください。'; return;
    }
    host.replaceChildren();
    host.append(thoughtText('strong', '端末内AIの提案 · 未検証 · 未保存', 'thought-ai-result-label'));
    host.append(thoughtText('p', `入力: メモ1件、関連メモ${result.includedNotes}件、保存資料の語句検索候補${result.includedSources}件、原文照合済み引用${result.includedReferences}件。保存資料は意味一致・引用位置とも未確認です${result.truncated ? '（入力上限により一部のみ）' : ''}`, 'reader-note'));
    if (wantsSourceCandidates) {
      const scopeText = [
        thoughtSearchScope ? `思考メモ: 全メモの部分語句検索で${thoughtSearchScope.matchedCount}件一致、最大${thoughtSearchScope.maxCandidates}件を取得` : '',
        sourceSearchScope ? `保存記事・Reader: ${sourceSearchScope.searchedCount ?? '?'}件を検索対象、${sourceSearchScope.readerTextCandidateCount ?? 0}件がReader本文語句一致、候補を最大8件AIへ渡した` : '保存記事・Reader: 検索語を抽出できず未検索',
        'いずれも語句検索で、意味検索・網羅性判定ではありません。',
      ].filter(Boolean).join(' ');
      host.append(thoughtText('p', `検索範囲: ${scopeText}`, 'reader-note'));
    }
    host.append(thoughtText('pre', result.text || 'モデルから提案が返りませんでした。', 'thought-ai-result-text'));
    if (candidates.length) {
      host.append(thoughtText('strong', 'AIへ渡した関連候補（原文）'));
      candidates.forEach((candidate, index) => {
        const row = document.createElement('article'); row.className = 'thought-reference';
        row.append(thoughtText('strong', `候補${index + 1} · ${candidate.title || 'タイトルなし'}`));
        row.append(thoughtText('p', candidate.body.slice(0, 500)));
        row.append(investigationButton('候補メモを開く', () => void openThoughtNote(candidate.id)));
        host.append(row);
      });
    }
    if (kind === 'evidence') {
      host.append(thoughtText('strong', 'AIへ渡した原文（保存資料）'));
      refs.filter(reference => reference.verification === 'verified').slice(0, 8).forEach(reference => {
        const row = document.createElement('article'); row.className = 'thought-reference';
        row.append(thoughtText('strong', reference.sourceTitle)); row.append(thoughtText('blockquote', `“${reference.quote}”`));
        if (reference.sourceCardId) row.append(investigationButton('Readerで照合', async () => { if (await openReaderForCard(reference.sourceCardId)) jumpToParagraph(reference.paragraphIndex); }));
        host.append(row);
      });
    }
    if (sourceCandidates.length) {
      host.append(thoughtText('strong', '保存記事・Reader本文の検索候補（語句一致。AIの関連提案と原文照合は別工程）'));
      sourceCandidates.forEach(candidate => {
        const row = document.createElement('article'); row.className = 'thought-reference';
        row.append(thoughtText('strong', candidate.title), thoughtText('blockquote', candidate.excerpt || '検索結果の抜粋はありません。'));
        row.append(thoughtText('p', `取得元: 保存記事検索 · ${candidate.searchMethod}`));
        row.append(investigationButton('Readerで原文確認', async () => { if (await openReaderForCard(candidate.sourceCardId)) await saveInvestigationState({ thoughtNoteId: selectedThoughtNote.id }); }));
        row.append(investigationButton('出典引用を追加', async () => {
          const quoteInput = document.getElementById('thought-reference-quote');
          const sourceSelect = document.getElementById('thought-reference-source');
          if (sourceSelect) {
            if (![...sourceSelect.options].some(option => option.value === candidate.sourceCardId)) {
              const option = document.createElement('option'); option.value = candidate.sourceCardId; option.textContent = `${candidate.title} · 検索候補`; sourceSelect.append(option);
            }
            sourceSelect.value = candidate.sourceCardId;
          }
          if (quoteInput) { quoteInput.value = candidate.excerpt; quoteInput.focus(); }
          investigationStatus('検索抜粋を引用欄へ入れました。Readerで原文を確認し、必要なら引用範囲を調整してから「出典引用を追加」を押してください。');
        }));
        host.append(row);
      });
    }
  } catch (error) {
    if (requestId === thoughtAIRequestId && !controller.signal.aborted) host.textContent = error.message || '端末内AIを実行できませんでした。';
  } finally {
    if (requestId === thoughtAIRequestId) { thoughtAIController = null; cancel.disabled = true; }
  }
}

async function addThoughtNoteToActiveDocument() {
  if (!selectedThoughtNote || typeof activeResearchDocument === 'undefined' || !activeResearchDocument) {
    investigationStatus('先に「原稿」タブで原稿を開いてください。', true); return;
  }
  if (!(await saveThoughtNote())) return;
  try {
    const result = await api.post(`/api/documents/${encodeURIComponent(activeResearchDocument.id)}/thought-notes`, { thoughtNoteId: selectedThoughtNote.id });
    activeResearchDocument = result.document;
    renderDocumentThoughtNotes(result.document.thoughtNotes ?? []);
    investigationStatus('原稿から思考メモを参照できるようにしました。本文は複製していません。');
  } catch (error) { investigationStatus(error.message || '原稿への思考メモ参照を追加できませんでした。', true); }
}

function renderThoughtReferences() {
  const host = document.getElementById('thought-reference-list'); if (!host) return;
  host.replaceChildren();
  for (const reference of selectedThoughtNote?.references ?? []) {
    const row = document.createElement('article'); row.className = 'thought-reference';
    const verificationLabel = ({ verified: '原文照合済み', ambiguous: '一致箇所が複数', missing: '引用が見つからない', source_changed: '原文変更・未確認', source_missing: '出典カードなし', text_missing: '保存本文なし' })[reference.verification] ?? '未確認';
    const heading = thoughtText('strong', `${reference.sourceTitle} · ${verificationLabel}`);
    const quote = thoughtText('blockquote', `“${reference.quote}”`);
    const actions = document.createElement('div'); actions.className = 'thought-editor-actions';
    if (reference.sourceCardId) actions.append(investigationButton('Readerで照合', async () => { if (!(await saveThoughtNote())) return; if (await openReaderForCard(reference.sourceCardId)) jumpToParagraph(reference.paragraphIndex); }));
    actions.append(investigationButton('参照を外す', async () => {
      try { await api.del(`/api/thought-notes/${encodeURIComponent(selectedThoughtNote.id)}/references/${encodeURIComponent(reference.id)}`); await openThoughtNote(selectedThoughtNote.id); }
      catch (error) { investigationStatus(error.message || '出典参照を外せませんでした。', true); }
    }));
    row.append(heading, quote, actions); host.append(row);
  }
  if (!host.childElementCount) host.textContent = '引用を追加すると、原文変更や位置の曖昧さもここで確認できます。';
}

async function addThoughtReference() {
  if (!selectedThoughtNote) return;
  const sourceCardId = document.getElementById('thought-reference-source').value;
  const quote = document.getElementById('thought-reference-quote').value;
  if (!sourceCardId || !quote.trim()) { investigationStatus('資料と本文中の引用文を選んでください。', true); return; }
  try {
    await api.post(`/api/thought-notes/${encodeURIComponent(selectedThoughtNote.id)}/references`, { sourceCardId, quote });
    document.getElementById('thought-reference-quote').value = '';
    await openThoughtNote(selectedThoughtNote.id);
    investigationStatus('引用文字列を保存済み原文と照合して関連付けました。');
  } catch (error) { investigationStatus(error.message || '引用を照合できませんでした。', true); }
}

function renderThoughtLinks() {
  const list = document.getElementById('thought-link-list'); const target = document.getElementById('thought-link-target');
  if (!list || !target) return;
  list.replaceChildren(); target.replaceChildren();
  const notes = activeInvestigationWorkspace?.thoughts ?? [];
  for (const note of notes) if (note.id !== selectedThoughtNote?.id) {
    const option = document.createElement('option'); option.value = note.id; option.textContent = note.title || note.body.slice(0, 60); target.append(option);
  }
  const links = (activeInvestigationWorkspace?.thoughtLinks ?? []).filter(link => link.sourceThoughtId === selectedThoughtNote?.id || link.targetThoughtId === selectedThoughtNote?.id);
  for (const link of links) {
    const outgoing = link.sourceThoughtId === selectedThoughtNote.id;
    const related = notes.find(note => note.id === (outgoing ? link.targetThoughtId : link.sourceThoughtId));
    const row = document.createElement('div'); row.className = 'thought-link-row';
    const open = investigationButton(`${outgoing ? '→' : '←'} ${related?.title || related?.body.slice(0, 60) || '関連メモ'}`, () => related && void openThoughtNote(related.id));
    open.className = 'thought-link-target';
    const description = document.createElement('input'); description.maxLength = 300; description.value = link.description; description.setAttribute('aria-label', '関係の説明（任意）');
    const save = investigationButton('説明を保存', async () => {
      try { const result = await api.put(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/thought-links/${encodeURIComponent(link.id)}`, { description: description.value }); setInvestigationWorkspace(result.workspace); }
      catch (error) { investigationStatus(error.message || '関係を更新できませんでした。', true); }
    });
    const remove = investigationButton('関係を外す', async () => {
      try { const result = await api.del(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/thought-links/${encodeURIComponent(link.id)}`); setInvestigationWorkspace(result.workspace); }
      catch (error) { investigationStatus(error.message || '関係を外せませんでした。', true); }
    });
    row.append(open, description, save, remove); list.append(row);
  }
  if (!links.length) list.textContent = notes.length > 1 ? 'まだ関係はありません。相手を選び、意味を言葉にするのは任意です。' : '関係を作るには、先に別の思考メモをこの調査へ追加してください。';
}

async function createThoughtLink() {
  if (!activeInvestigationWorkspace || !selectedThoughtNote) return;
  const targetThoughtId = document.getElementById('thought-link-target').value;
  if (!targetThoughtId) { investigationStatus('関連付ける思考メモを選んでください。', true); return; }
  try {
    const result = await api.post(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/thought-links`, {
      sourceThoughtId: selectedThoughtNote.id, targetThoughtId, description: document.getElementById('thought-link-description').value,
    });
    document.getElementById('thought-link-description').value = '';
    setInvestigationWorkspace(result.workspace); investigationStatus('人が作成した関係をこの調査に保存しました。');
  } catch (error) { investigationStatus(error.message || '関係を追加できませんでした。', true); }
}

async function updateThoughtPlacement(id, patch) {
  if (!activeInvestigationWorkspace) return;
  try {
    const result = await api.put(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/thought-notes/${encodeURIComponent(id)}`, {
      groupId: patch.groupId ?? activeInvestigationWorkspace.thoughts.find(note => note.id === id)?.groupId ?? null,
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      ...(patch.x !== undefined ? { x: patch.x } : {}), ...(patch.y !== undefined ? { y: patch.y } : {}),
    });
    activeInvestigationWorkspace.thoughts = result.workspace.thoughts;
    renderThoughtNoteList(); renderThoughtEditorSections(); renderThoughtComparison();
  } catch (error) { investigationStatus(error.message || '調査内の配置を更新できませんでした。', true); }
}

async function moveThoughtNote(delta) {
  const notes = activeInvestigationWorkspace?.thoughts ?? [];
  const index = notes.findIndex(note => note.id === selectedThoughtNote?.id); const next = index + delta;
  if (index < 0 || next < 0 || next >= notes.length) return;
  await updateThoughtPlacement(notes[index].id, { groupId: notes[index].groupId, position: notes[next].position });
  await updateThoughtPlacement(notes[next].id, { groupId: notes[next].groupId, position: notes[index].position });
}

async function detachThoughtNote() {
  if (!activeInvestigationWorkspace || !selectedThoughtNote || !(await saveThoughtNote())) return;
  try {
    const workspaceId = activeInvestigationWorkspace.id;
    await api.del(`/api/workspaces/${encodeURIComponent(workspaceId)}/thought-notes/${encodeURIComponent(selectedThoughtNote.id)}`);
    const result = await api.get(`/api/workspaces/${encodeURIComponent(workspaceId)}`); setInvestigationWorkspace(result.workspace);
    investigationStatus('この調査から関連を外しました。思考メモ自体と他の調査での利用は残っています。');
  } catch (error) { investigationStatus(error.message || 'この調査から外せませんでした。', true); }
}

async function deleteThoughtNote() {
  if (!selectedThoughtNote || !confirm('この思考メモ、変更履歴、すべての調査との関連を削除しますか？')) return;
  if (!(await saveThoughtNote())) return;
  try {
    await api.del(`/api/thought-notes/${encodeURIComponent(selectedThoughtNote.id)}`);
    selectedThoughtNote = null; thoughtEditorDirty = false; document.getElementById('investigation-thought-editor').hidden = true;
    const emptyState = document.getElementById('thought-editor-empty'); if (emptyState) emptyState.hidden = false;
    if (activeInvestigationWorkspace) await saveInvestigationState({ thoughtNoteId: null });
    await searchThoughtNotes();
    if (activeInvestigationWorkspace) { const result = await api.get(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}`); setInvestigationWorkspace(result.workspace); }
  } catch (error) { investigationStatus(error.message || '思考メモを削除できませんでした。', true); }
}

async function loadThoughtHistory() {
  if (!selectedThoughtNote) return;
  const host = document.getElementById('thought-history'); host.replaceChildren();
  try {
    const result = await api.get(`/api/thought-notes/${encodeURIComponent(selectedThoughtNote.id)}/revisions`);
    if (!result.revisions.length) { host.textContent = '変更履歴はまだありません。'; return; }
    for (const revision of result.revisions) {
      const card = document.createElement('article'); card.className = 'thought-history-item';
      card.append(thoughtText('strong', `版 ${revision.version} · ${new Date(revision.savedAt).toLocaleString()}`));
      card.append(thoughtText('p', revision.title || '（タイトルなし）'));
      card.append(thoughtText('pre', revision.body));
      card.append(investigationButton('この版から復元', async () => {
        if (!(await saveThoughtNote())) return;
        try {
          const updated = await api.put(`/api/thought-notes/${encodeURIComponent(selectedThoughtNote.id)}`, { title: revision.title, body: revision.body, kind: revision.kind, version: selectedThoughtNote.version });
          selectedThoughtNote = updated.thought; thoughtEditorDirty = false;
          document.getElementById('thought-edit-title').value = updated.thought.title; document.getElementById('thought-edit-body').value = updated.thought.body; document.getElementById('thought-edit-kind').value = updated.thought.kind;
          document.getElementById('thought-version-label').textContent = `版 ${updated.thought.version} · 復元済み`; renderThoughtNoteList();
          investigationStatus('過去の版を新しい版として復元しました。');
        } catch (error) { investigationStatus(error.message || '過去の版を復元できませんでした。', true); }
      }));
      host.append(card);
    }
  } catch (error) { host.textContent = error.message || '変更履歴を読み込めませんでした。'; }
}

async function loadThoughtMap() {
  const host = document.getElementById('investigation-thought-map');
  if (!host || !activeInvestigationWorkspace) return;
  if (thoughtNetwork) { thoughtNetwork.destroy(); thoughtNetwork = null; }
  try {
    const result = await api.get(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/thought-map`);
    if (!result.nodes.length) { host.textContent = 'この調査に思考メモを追加すると、関係マップが表示されます。'; return; }
    if (!window.vis?.Network) { host.textContent = '関係マップを読み込めませんでした。一覧は利用できます。'; return; }
    host.replaceChildren();
    const nodes = new vis.DataSet(result.nodes.map(node => ({ ...node, shape: 'box', font: { color: '#e2e8f0', size: 14 }, color: { background: '#252836', border: '#6c8aff' }, borderWidth: 1 })));
    const edges = new vis.DataSet(result.edges.map(edge => ({ ...edge, label: edge.label || '関係（説明なし）', title: edge.label || '関係の説明は未記入です', color: { color: '#6c8aff', highlight: '#a78bfa' }, font: { color: '#cbd5e1', size: 11, background: '#161821' }, smooth: { type: 'continuous' } })));
    thoughtNetwork = new vis.Network(host, { nodes, edges }, {
      physics: { enabled: false },
      interaction: { hover: true, tooltipDelay: 150, navigationButtons: true, keyboard: { enabled: true }, multiselect: true },
      edges: { arrows: { to: { enabled: true, scaleFactor: 0.7 } } },
      manipulation: {
        enabled: true,
        addNode: false,
        deleteNode: false,
        addEdge: (edge, callback) => {
          const description = prompt('この2つの考えを結ぶ説明（任意）', '');
          if (description === null) { callback(null); return; }
          void api.post(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/thought-links`, {
            sourceThoughtId: String(edge.from), targetThoughtId: String(edge.to), description,
          }).then(result => {
            const linkId = result.linkId ?? result.workspace?.thoughtLinks?.at(-1)?.id;
            callback({ ...edge, id: linkId, label: description || '関係（説明なし）', title: description || '関係の説明は未記入です', arrows: 'to' });
            setInvestigationWorkspace(result.workspace);
          }).catch(error => { callback(null); investigationStatus(error.message || '関係を作成できませんでした。', true); });
        },
        editEdge: (edge, callback) => {
          const linkId = edge.id;
          const current = result.edges.find(item => item.id === linkId)?.label ?? '';
          const description = prompt('関係の説明（空欄にすると説明なし）', current);
          if (description === null) { callback(null); return; }
          void api.put(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/thought-links/${encodeURIComponent(linkId)}`, { description }).then(updated => {
            callback({ ...edge, label: description || '関係（説明なし）', title: description || '関係の説明は未記入です' });
            setInvestigationWorkspace(updated.workspace);
          }).catch(error => { callback(null); investigationStatus(error.message || '関係を更新できませんでした。', true); });
        },
        deleteEdge: (edge, callback) => {
          const selected = Array.isArray(edge.edges) ? edge.edges : [edge.id];
          const remove = async () => {
            let workspace = activeInvestigationWorkspace;
            for (const id of selected) {
              const removed = await api.del(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/thought-links/${encodeURIComponent(id)}`);
              workspace = removed.workspace;
            }
            callback({ edges: selected }); setInvestigationWorkspace(workspace);
          };
          void remove().catch(error => { callback(null); investigationStatus(error.message || '関係を削除できませんでした。', true); });
        },
      },
    });
    thoughtNetwork.on('click', ({ nodes: selected }) => { if (selected.length === 1) void openThoughtNote(selected[0]); });
    thoughtNetwork.on('dragEnd', ({ nodes: moved }) => {
      for (const id of moved) { const position = thoughtNetwork.getPositions([id])[id]; if (position) void updateThoughtPlacement(id, { x: position.x, y: position.y }); }
    });
  } catch (error) { host.textContent = error.message || '関係マップを読み込めませんでした。'; }
}

function beginThoughtLinkCreation() {
  if (!thoughtNetwork) { investigationStatus('先に関係マップを開いてください。', true); return; }
  thoughtNetwork.addEdgeMode();
  investigationStatus('マップ上で始点と終点のメモを選び、関係の説明を入力してください。');
}

function thoughtCompareState() {
  return activeInvestigationWorkspace?.state?.thoughtCompare ?? { noteIds: [], criteria: ['主張', '条件', '懸念', '未確認'], values: {}, reflection: '' };
}

function setThoughtComparisonNote(id, checked) {
  if (!activeInvestigationWorkspace) return;
  const current = thoughtCompareState(); const ids = [...(current.noteIds ?? [])];
  if (checked && !ids.includes(id)) {
    if (ids.length >= 4) { investigationStatus('思考メモの比較は一度に4件までです。', true); renderThoughtNoteList(); return; }
    ids.push(id);
  } else if (!checked) { const at = ids.indexOf(id); if (at >= 0) ids.splice(at, 1); }
  activeInvestigationWorkspace.state = { ...activeInvestigationWorkspace.state, thoughtCompare: { ...current, noteIds: ids } };
  void saveInvestigationState({ thoughtCompare: activeInvestigationWorkspace.state.thoughtCompare }); renderThoughtComparison();
}

function renderThoughtComparison() {
  const host = document.getElementById('investigation-thought-comparison-table'); if (!host) return;
  host.replaceChildren();
  const workspace = activeInvestigationWorkspace;
  const criteriaInput = document.getElementById('thought-compare-criteria');
  if (!workspace) { host.textContent = '調査を開くと、この調査の思考メモを比較できます。'; return; }
  const state = thoughtCompareState(); const ids = (state.noteIds ?? []).filter(id => workspace.thoughts.some(note => note.id === id));
  const reflection = document.getElementById('thought-compare-reflection');
  if (reflection && document.activeElement !== reflection) reflection.value = state.reflection ?? '';
  const criteria = [...new Set((state.criteria ?? []).map(value => String(value).trim()).filter(Boolean))].slice(0, 12);
  if (!criteria.length) criteria.push('主張', '条件', '懸念', '未確認');
  if (document.activeElement !== criteriaInput) criteriaInput.value = criteria.join('\n');
  if (!ids.length) { host.textContent = '一覧の「比較」にチェックを入れてください。'; return; }
  const selected = ids.map(id => workspace.thoughts.find(note => note.id === id)).filter(Boolean);
  const table = document.createElement('table'); table.className = 'thought-comparison-grid';
  const thead = document.createElement('thead'); const header = document.createElement('tr'); header.append(thoughtText('th', '論点'));
  for (const note of selected) header.append(thoughtText('th', note.title || note.body.slice(0, 48)));
  thead.append(header); table.append(thead); const tbody = document.createElement('tbody');
  const values = { ...(state.values ?? {}) };
  criteria.forEach((criterion, rowIndex) => {
    const row = document.createElement('tr'); row.append(thoughtText('th', criterion));
    for (const note of selected) {
      const cell = document.createElement('td'); const input = document.createElement('textarea'); input.rows = 3;
      const key = `${note.id}:criterion:${encodeURIComponent(criterion)}`; input.value = values[key] ?? values[`${note.id}:${rowIndex}`] ?? ''; input.setAttribute('aria-label', `${note.title || '思考メモ'}の${criterion}`);
      input.oninput = () => {
        values[key] = input.value; clearTimeout(thoughtCompareTimer);
        thoughtCompareTimer = setTimeout(() => { if (!activeInvestigationWorkspace) return; void saveInvestigationState({ thoughtCompare: { ...thoughtCompareState(), noteIds: ids, criteria, values } }); }, 400);
      };
      cell.append(input); row.append(cell);
    }
    tbody.append(row);
  });
  table.append(tbody); host.append(table);
}

async function createThoughtFromComparison() {
  if (!activeInvestigationWorkspace) return;
  const state = thoughtCompareState();
  const reflection = document.getElementById('thought-compare-reflection')?.value.trim() ?? '';
  const ids = (state.noteIds ?? []).filter(id => activeInvestigationWorkspace.thoughts.some(note => note.id === id));
  if (ids.length < 2) { investigationStatus('比較からメモを作るには、思考メモを2件以上選んでください。', true); return; }
  if (!reflection) { investigationStatus('比較して気付いたことを入力してください。', true); return; }
  try {
    await saveInvestigationState({ thoughtCompare: { ...state, reflection } });
    const result = await api.post('/api/thought-notes', { title: '比較からの気付き', body: reflection, kind: 'interpretation' });
    const attached = await api.post(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/thought-notes`, { thoughtNoteId: result.thought.id });
    activeInvestigationWorkspace = attached.workspace;
    for (const sourceThoughtId of ids) {
      const linked = await api.post(`/api/workspaces/${encodeURIComponent(activeInvestigationWorkspace.id)}/thought-links`, { sourceThoughtId, targetThoughtId: result.thought.id, description: '比較から生まれた気付き' });
      activeInvestigationWorkspace = linked.workspace;
    }
    selectedThoughtNote = result.thought; thoughtEditorDirty = false;
    await searchThoughtNotes(); setInvestigationWorkspace(activeInvestigationWorkspace); await openThoughtNote(result.thought.id);
    investigationStatus('比較から思考メモを作成し、比較対象との関係を保存しました。');
  } catch (error) { investigationStatus(error.message || '比較から思考メモを作成できませんでした。', true); }
}

document.getElementById('thought-edit-title')?.addEventListener('input', () => { thoughtEditorDirty = true; persistThoughtDraft(); document.getElementById('thought-version-label').textContent = '未保存の変更'; });
document.getElementById('thought-edit-kind')?.addEventListener('change', () => { thoughtEditorDirty = true; persistThoughtDraft(); document.getElementById('thought-version-label').textContent = '未保存の変更'; });
document.getElementById('thought-edit-body')?.addEventListener('input', () => { thoughtEditorDirty = true; persistThoughtDraft(); document.getElementById('thought-version-label').textContent = '未保存の変更'; });
document.getElementById('thought-compare-criteria')?.addEventListener('input', () => {
  if (!activeInvestigationWorkspace) return;
  const criteria = [...new Set(document.getElementById('thought-compare-criteria').value.split('\n').map(value => value.trim()).filter(Boolean))].slice(0, 12);
  clearTimeout(thoughtCompareTimer);
  thoughtCompareTimer = setTimeout(() => { void saveInvestigationState({ thoughtCompare: { ...thoughtCompareState(), criteria } }); renderThoughtComparison(); }, 400);
});
document.getElementById('thought-compare-reflection')?.addEventListener('input', () => {
  if (!activeInvestigationWorkspace) return;
  const reflection = document.getElementById('thought-compare-reflection').value;
  clearTimeout(thoughtCompareTimer);
  thoughtCompareTimer = setTimeout(() => { void saveInvestigationState({ thoughtCompare: { ...thoughtCompareState(), reflection } }); }, 400);
});

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('investigation-thought-search')?.addEventListener('keydown', event => { if (event.key === 'Enter') searchThoughtNotes(); });
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
