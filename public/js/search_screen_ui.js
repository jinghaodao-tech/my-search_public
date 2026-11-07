// 探す: one screen for every place to look.
//   collected — registered sites and feeds, already in the database (BM25, instant)
//   cards     — the user's own cards
//   web:*     — Qiita / Hatena Bookmark / GitHub / arXiv, searched on the spot
// The chosen places are remembered in this browser; new places are chosen by default.
let searchTargets = { collected: [], collectedTotal: 0, cards: null, web: [] };
let searchTargetChoice = null; // { selected: string[], known: string[] }
let searchKeywordsText = '';
// what /api/search/terms said about the text (generic words, kind of question, too broad?)
let searchAnalysis = null;
let cardSearchResult = null;
const REFIND_CONSENT_KEY = 'mySearch.personalRefindCaptureConsent20261025';
const REFIND_PARTICIPANT_KEY = 'mySearch.personalRefindCaptureParticipant20261025';
const REFIND_SESSION_KEY = 'mySearch.personalRefindCaptureSession20261025';
let refindStudyAvailable = false;
let refindStudyPlan = null;
let activeRefindStudy = null;

const DEFAULT_WEB_TARGETS = ['web:qiita', 'web:hatena'];

function loadTargetChoice() {
  try { return JSON.parse(localStorage.getItem('searchTargets') || 'null'); } catch { return null; }
}
function storeTargetChoice() {
  try { localStorage.setItem('searchTargets', JSON.stringify(searchTargetChoice)); } catch { /* storage unavailable */ }
}

function allTargetValues() {
  return [...searchTargets.collected.map(target => target.value), ...(searchTargets.cards ? ['cards'] : []), ...searchTargets.web.map(target => target.value)];
}

function selectedSearchTargets() {
  return [...document.querySelectorAll('#search-targets input[type=checkbox]:checked')].map(box => box.value);
}
function selectedCollectedTargets() {
  return selectedSearchTargets().filter(value => value !== 'cards' && !value.startsWith('web:'));
}
function searchTargetLabel(value) {
  const target = searchTargets.collected.find(item => item.value === value);
  return target ? target.label : value;
}

/** Choose these targets (from a saved search). null = keep the current choice. */
function applySearchTargets(values) {
  if (!values) return;
  const wanted = new Set(values);
  for (const box of document.querySelectorAll('#search-targets input[type=checkbox]')) box.checked = wanted.has(box.value);
  rememberTargetChoice();
}

function rememberTargetChoice() {
  searchTargetChoice = { selected: selectedSearchTargets(), known: allTargetValues() };
  storeTargetChoice();
  renderScopeLine();
}

// Named sets of search targets ("論文だけ", "技術ブログだけ"), kept in this browser like the last choice.
const TARGET_SETS_KEY = 'mySearch.targetSets';
function loadTargetSets() {
  try { const value = JSON.parse(localStorage.getItem(TARGET_SETS_KEY) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}
function storeTargetSets(sets) {
  try { localStorage.setItem(TARGET_SETS_KEY, JSON.stringify(sets)); } catch { /* storage unavailable: sets last until reload */ }
}
function renderTargetSets(host) {
  const row = document.createElement('div');
  row.className = 'search-target-sets';
  const select = document.createElement('select');
  const sets = loadTargetSets();
  select.innerHTML = '<option value="">検索先のセット…</option>';
  for (const [index, set] of sets.entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${set.name}（${set.values.length}）`;
    select.append(option);
  }
  select.onchange = () => { const set = sets[Number(select.value)]; if (set) { applySearchTargets(set.values); rememberTargetChoice(); } };
  const name = document.createElement('input');
  name.placeholder = 'セットの名前';
  name.maxLength = 30;
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-secondary btn-sm';
  save.textContent = '今の選択を保存';
  save.onclick = () => {
    const label = name.value.trim();
    if (!label) { name.focus(); return; }
    const next = loadTargetSets().filter(set => set.name !== label);
    next.push({ name: label, values: selectedSearchTargets() });
    storeTargetSets(next.slice(-12));
    loadSearchTargets();
  };
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-secondary btn-sm';
  remove.textContent = 'セットを削除';
  remove.onclick = () => { if (select.value === '') return; storeTargetSets(sets.filter((_, index) => String(index) !== select.value)); loadSearchTargets(); };
  row.append(select, name, save, remove);
  host.append(row);
}

async function loadSearchTargets() {
  try {
    searchTargets = await api.get('/api/search/targets');
  } catch (error) {
    document.getElementById('search-targets').textContent = `検索先を読み込めませんでした: ${formatApiError(error)}`;
    return;
  }
  const stored = searchTargetChoice || loadTargetChoice();
  const known = new Set(stored?.known || []);
  const selected = new Set(stored?.selected || []);
  const hasCollectedArticles = searchTargets.collected.some(target => target.count > 0);
  const isChosen = value => {
    // Configured feeds with zero articles are not a searchable corpus.
    if (!stored) {
      if (value === 'cards') return !hasCollectedArticles && searchTargets.cards?.count > 0;
      if (value.startsWith('web:')) return !hasCollectedArticles && DEFAULT_WEB_TARGETS.includes(value);
      return searchTargets.collected.some(target => target.value === value && target.count > 0);
    }
    if (!known.has(value)) return searchTargets.collected.some(target => target.value === value && target.count > 0);
    return selected.has(value);
  };
  const host = document.getElementById('search-targets');
  host.textContent = '';
  const group = (title, targets, parent = host) => {
    if (!targets.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'search-target-group';
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'search-target-group-label';
    label.textContent = title;
    label.title = 'このまとまりを全部選ぶ／全部外す';
    label.onclick = () => {
      const boxes = [...wrap.querySelectorAll('input[type=checkbox]')];
      const all = boxes.every(box => box.checked);
      for (const box of boxes) box.checked = !all;
      rememberTargetChoice();
    };
    wrap.append(label);
    for (const target of targets) {
      const chip = document.createElement('label');
      chip.className = 'search-target';
      chip.dataset.label = target.label;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = target.value;
      box.checked = isChosen(target.value);
      box.onchange = rememberTargetChoice;
      chip.append(box, document.createTextNode(` ${target.label}${typeof target.count === 'number' ? ` (${target.count})` : ''}`));
      if (target.kind === 'site') chip.title = `${target.statusLabel} · ${target.bodyPolicyLabel}`;
      wrap.append(chip);
    }
    parent.append(wrap);
  };
  renderTargetSets(host);
  // Sources with no articles, paused or failing go into a folded group, so the list stays short.
  const idle = target => target.count === 0 || (target.kind === 'site' && (target.enabled === false || target.status === 'error' || target.status === 'unsupported'));
  const collected = searchTargets.collected;
  const feedKind = target => (target.value.startsWith('arxiv:') ? 'paper' : target.value.startsWith('github:') ? 'code' : 'news');
  group('登録サイト', collected.filter(target => target.kind === 'site' && !idle(target)));
  group('ニュース・ブログ', collected.filter(target => target.kind === 'feed' && feedKind(target) === 'news' && !idle(target)));
  group('論文（arXiv）', collected.filter(target => target.kind === 'feed' && feedKind(target) === 'paper' && !idle(target)));
  group('コード（GitHub）', collected.filter(target => target.kind === 'feed' && feedKind(target) === 'code' && !idle(target)));
  const idleTargets = collected.filter(idle);
  if (idleTargets.length) {
    const fold = document.createElement('details');
    fold.className = 'search-target-idle';
    const summary = document.createElement('summary');
    fold.append(summary);
    group('記事がない・停止中', idleTargets, fold);
    const updateSummary = () => { summary.textContent = `記事がない・停止中（${idleTargets.length}・選択中 ${fold.querySelectorAll('input:checked').length}）`; };
    fold.addEventListener('change', updateSummary);
    fold.addEventListener('click', () => setTimeout(updateSummary, 0));
    host.append(fold);
    updateSummary();
  }
  group('Web（その場で検索）', searchTargets.web);
  if (searchTargets.cards) group('メモ', [searchTargets.cards]);
  if (host.querySelectorAll('.search-target').length > 15) {
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'search-target-filter';
    filter.placeholder = '検索先を絞り込む';
    filter.oninput = () => {
      const q = filter.value.trim().toLowerCase();
      for (const chip of host.querySelectorAll('.search-target')) chip.hidden = Boolean(q) && !String(chip.dataset.label || '').toLowerCase().includes(q);
      if (q) host.querySelector('.search-target-idle')?.setAttribute('open', '');
    };
    host.prepend(filter);
  }
  if (!hasCollectedArticles) {
    const hint = document.createElement('p');
    hint.className = 'reader-note';
    hint.textContent = 'まだ記事が集まっていません。「情報源を管理」でよく読むブログを登録するか、Webを選んで検索してください。';
    host.append(hint);
  }
  rememberTargetChoice();
  renderTargetStatus();
}

function renderTargetStatus() {
  const host = document.getElementById('search-target-status-body');
  if (!host) return;
  host.textContent = '';
  const table = document.createElement('table');
  table.className = 'search-status-table';
  table.innerHTML = '<thead><tr><th>情報源</th><th>記事</th><th>最終更新</th><th>本文</th><th>状態</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const target of searchTargets.collected) {
    const row = document.createElement('tr');
    const cells = [
      target.label,
      `${target.count}件`,
      target.lastCheckedAt ? new Date(target.lastCheckedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
      target.searchable === 'fulltext' ? '本文も検索' : target.searchable === 'mixed' ? '一部の本文も検索' : 'タイトル・概要のみ',
      target.kind === 'site' ? `${target.statusLabel}${target.pastArticles ? '' : '（最新のみ）'}${target.lastError ? `：${target.lastError}` : ''}` : '—',
    ];
    for (const text of cells) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
    tbody.append(row);
  }
  table.append(tbody);
  host.append(table);
  const note = document.createElement('p');
  note.className = 'reader-note';
  note.textContent = '「タイトル・概要のみ」のサイトは、本文中の言葉では見つかりません。本文を検索するには、情報源の管理でそのサイトの利用条件を確認して「本文も取得」にしてください。';
  host.append(note);
}

function renderScopeLine() {
  const output = document.getElementById('bm25-stats');
  if (!output) return;
  const collected = selectedCollectedTargets();
  const collectedCount = searchTargets.collected.filter(target => collected.includes(target.value)).reduce((sum, target) => sum + target.count, 0);
  const sites = searchTargets.collected.filter(target => collected.includes(target.value) && target.kind === 'site').length;
  const feeds = collected.length - sites;
  const web = selectedSearchTargets().filter(value => value.startsWith('web:')).map(value => searchTargets.web.find(target => target.value === value)?.label || value);
  const parts = [];
  if (collected.length) parts.push(`収集済み記事 ${collectedCount}件を検索（登録サイト ${sites}・フィード ${feeds}）`);
  if (selectedSearchTargets().includes('cards')) parts.push(`自分のカード ${searchTargets.cards?.count ?? 0}件`);
  if (web.length) parts.push(`Web: ${web.join('・')} をその場で検索`);
  output.textContent = parts.length ? parts.join(' · ') : '検索先を選んでください';
}

// 0 results: say what was searched, in what state, without claiming the article does not exist.
const SEARCHABLE_LABEL = { fulltext: 'タイトル・概要・本文', mixed: 'タイトル・概要（一部の記事は本文も）', title_summary: 'タイトル・概要のみ（本文は検索していません）' };
function renderNoResultStatus(host, scope) {
  const box = document.createElement('div');
  box.className = 'no-result-box';
  const title = document.createElement('p');
  title.className = 'no-result-title';
  title.textContent = scope.totalCount === 0 ? '収集済みの記事がまだありません' : scope.searchedCount === 0 ? '指定した検索先・条件に合う記事がありません' : '収集済みの記事からは見つかりませんでした';
  box.append(title);
  const heading = document.createElement('p');
  heading.className = 'reader-note';
  heading.textContent = '検索対象の状態';
  box.append(heading);
  const list = document.createElement('ul');
  list.className = 'no-result-list';
  const selected = selectedCollectedTargets();
  const targets = searchTargets.collected.filter(target => selected.includes(target.value));
  const retryable = [];
  for (const target of targets) {
    const counts = scope.bySource?.[target.value] || { total: target.count, searched: 0 };
    const item = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = target.label;
    const lines = [];
    lines.push(counts.total === counts.searched ? `${counts.searched}件を検索しました` : `${counts.total}件のうち、条件に合う${counts.searched}件を検索しました`);
    lines.push(`検索した内容: ${SEARCHABLE_LABEL[target.searchable] || 'タイトル・概要'}`);
    if (target.lastCheckedAt) lines.push(`最終確認: ${new Date(target.lastCheckedAt).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
    if (target.kind === 'site') {
      if (target.status === 'error' || target.lastError) { lines.push(`前回の更新に失敗しました${target.lastError ? `（${target.lastError}）` : ''}`); retryable.push(target); }
      else if (target.status === 'partial') { lines.push('前回の更新で一部の記事を取得できませんでした'); retryable.push(target); }
      if (target.enabled === false) lines.push('自動収集を停止中です（集めた記事だけを検索しています）');
      if (!target.pastArticles) lines.push('この情報源は最新の記事だけを集める方式です');
      if (target.count === 0) lines.push('まだ記事を集めていません');
    } else {
      lines.push('収集済みの記事だけを検索しています');
    }
    item.append(name, document.createTextNode(` — ${lines.join('。')}`));
    list.append(item);
  }
  const unselected = searchTargets.collected.filter(target => selected.length && !selected.includes(target.value)).length;
  if (unselected) { const item = document.createElement('li'); item.textContent = `検索先から外している情報源が ${unselected}件あります`; list.append(item); }
  const filters = scope.filtersApplied || {};
  const filterNotes = [];
  if (filters.excludedTerms?.length) filterNotes.push(`除外語: ${filters.excludedTerms.join(' ')}`);
  if (filters.status && filters.status !== 'all') filterNotes.push(`状態で絞り込み: ${filters.status}`);
  if (filters.since) filterNotes.push('前回確認後の新着だけ');
  if (filterNotes.length) { const item = document.createElement('li'); item.textContent = `条件で候補を減らしています（${filterNotes.join('・')}）。全体 ${scope.totalCount}件 → 条件に合う ${scope.searchedCount}件`; list.append(item); }
  if (!selectedSearchTargets().some(value => value.startsWith('web:'))) { const item = document.createElement('li'); item.textContent = 'Webは検索していません（検索先で選べます）'; list.append(item); }
  box.append(list);
  const actions = document.createElement('div');
  actions.className = 'evidence-actions';
  actions.append(resultButton('検索条件を変更', () => { const details = document.getElementById('search-details'); details.open = true; details.scrollIntoView({ block: 'nearest' }); }));
  actions.append(resultButton('収集状況を確認', () => openSourceModal()));
  if (!selectedSearchTargets().some(value => value.startsWith('web:'))) {
    actions.append(resultButton('Webで探す', () => {
      const web = searchTargets.web.filter(target => DEFAULT_WEB_TARGETS.includes(target.value)).map(target => target.value);
      applySearchTargets([...selectedSearchTargets(), ...web]);
      runSearchScreen({ webOnly: true });
    }));
  }
  for (const target of retryable) {
    actions.append(resultButton(`「${target.label}」を今すぐ更新`, async () => {
      try { const { jobId } = await api.post(`/api/sites/${encodeURIComponent(target.value.slice(5))}/sync`, {}); toast('更新を始めました'); if (typeof watchSiteJob === 'function') watchSiteJob(jobId); }
      catch (error) { showApiError(error); }
    }));
  }
  box.append(actions);
  host.append(box);
}

async function ensureKeywordsFor(text) {
  if (text === searchKeywordsText && bm25Keywords.some(keyword => keyword.term.trim())) return;
  try {
    const { keywords, analysis } = await api.post('/api/search/terms', { text });
    bm25Keywords = keywords.map(keyword => ({ term: keyword.term, weight: keyword.weight, synonyms: '' }));
    searchAnalysis = analysis || null;
  } catch {
    searchAnalysis = null;
    bm25Keywords = text.split(/\s+/).filter(Boolean).map(term => ({ term, weight: 1, synonyms: '' }));
  }
  renderKeywords();
  searchKeywordsText = text;
  document.getElementById('search-terms').value = text;
}

async function runCardSearch() {
  const host = document.getElementById('search-cards');
  host.textContent = '';
  const heading = document.createElement('h4');
  heading.className = 'search-section-title';
  heading.textContent = '自分のカードから';
  host.append(heading);
  const settings = searchSettings();
  const started = performance.now();
  let result;
  try {
    result = await api.post('/api/cards/search', {
      config: settings.config,
      options: settings.options,
      filters: { excludedTerms: [], sources: [], status: 'all' },
    });
    if (activeRefindStudy) await recordRefindInteraction({ action: 'search_response',
      top10: result.active.slice(0, 10).map(item => item.article.id),
      candidateIdsBeforeRerank: Array.isArray(result.scope?.candidateIdsBeforeRerank) ? result.scope.candidateIdsBeforeRerank : null,
      actualEngine: result.scope?.searchMethod ?? null, fallbackUsed: result.scope?.fallbackUsed ?? null,
      httpStatus: 200, latencyMs: performance.now() - started });
  } catch (error) {
    if (activeRefindStudy) await recordRefindInteraction({ action: 'search_response', top10: [],
      httpStatus: Number.isInteger(error?.status) ? error.status : null,
      error: formatApiError(error), latencyMs: performance.now() - started }).catch(() => {});
    throw error;
  }
  cardSearchResult = result;
  heading.textContent = `自分のカードから（${result.scope.totalCount}枚を検索）`;
  if (!result.active.length) {
    const none = document.createElement('p');
    none.className = 'reader-note';
    none.textContent = '合うカードはありませんでした。';
    host.append(none);
    const contextual = typeof ContextualAutomation === 'undefined'
      || ContextualAutomation.resolve('f2', { eligible: true, contextKey: document.getElementById('search-terms').value.trim() }) === 'eligible';
    if (contextual) renderSavedCardNoResultHelp(host, result);
    await renderRefindStudyReview();
    return;
  }
  for (const [index, item] of result.active.entries()) {
    const article = item.article;
    const card = document.createElement('article');
    card.className = 'score-card';
    card.innerHTML = `<div class="score-card-header"><span class="score-badge">#${index + 1} ${Number(item.score).toFixed(2)} · 保存済み</span><div class="score-title">${highlightSearchText(article.title, lastSearchTerms)}</div></div><p>${highlightSearchText(item.snippet || article.summary || '', [...lastSearchTerms, ...(item.matchedKeywords || [])])}</p>`;
    const actions = document.createElement('div');
    actions.className = 'score-actions';
    const contextual = typeof ContextualAutomation === 'undefined' ? true : ContextualAutomation.resolve('f1', { eligible: Boolean(item.snippet), contextKey: article.id }) === 'eligible';
    if (contextual && item.snippet) {
      if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f1', event: 'shown', trigger: 'snippet_match' });
      actions.append(resultButton('本文の該当箇所を見る', () => openSavedCardSearchItemAtSnippet(item)));
    }
    const contextualRelated = typeof ContextualAutomation === 'undefined' ? true : ContextualAutomation.resolve('f6', { eligible: document.getElementById('search-terms').value.trim().length >= 2, contextKey: article.id }) === 'eligible';
    if (contextualRelated) {
      if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f6', event: 'shown', trigger: 'search_result' });
      actions.append(resultButton('検索目的に近い箇所を見る', () => openSavedCardForRelatedPassage(item)));
    }
    actions.append(resultButton('メモを読む', () => {
      if (activeRefindStudy) recordRefindInteraction({ action: 'opened', cardId: article.id }).catch(() => {});
      searchReaderIndex = -1; openReaderForCard(article.id);
    }));
    if (window.mySearchDesktop && article.url) actions.append(resultButton('内蔵ブラウザーで開く', () => window.mySearchDesktop.openBrowser(article.url)));
    card.append(actions);
    host.append(card);
  }
  await renderRefindStudyReview();
}

function renderSavedCardNoResultHelp(host, result) {
  const box = document.createElement('div');
  box.className = 'no-result-box';
  box.setAttribute('role', 'status');
  const scope = result.scope || {};
  const heading = document.createElement('p');
  heading.className = 'no-result-title';
  heading.textContent = Number(scope.totalCount) === 0 ? '保存済みカードがまだありません' : `保存済みカード${scope.totalCount}件では見つかりませんでした`;
  box.append(heading);
  const note = document.createElement('p');
  note.textContent = '検索文と条件はそのままです。検索語を変えるか、収集記事・Webなど別の検索先を選んで試せます。検索先の取得エラーがあった場合は、記事が存在しないとは判断できません。';
  box.append(note);
  const actions = document.createElement('div');
  actions.className = 'evidence-actions';
  actions.append(resultButton('検索語を見直す', () => { const input = document.getElementById('search-terms'); input.focus(); input.select(); }));
  actions.append(resultButton('検索先を見直す', () => { document.getElementById('search-targets')?.scrollIntoView({ block: 'center' }); }));
  actions.append(resultButton('同じ語でWeb検索', () => openExternalSearch()));
  actions.append(resultButton('この案内を閉じる', () => {
    if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f2', event: 'ignored', trigger: 'user_action', outcome: 'ignored' });
    if (typeof ContextualAutomation !== 'undefined') {
      ContextualAutomation.suppress('f2', document.getElementById('search-terms').value.trim());
    }
    box.remove();
  }));
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f2', event: 'shown', trigger: 'search_no_results' });
  box.append(actions);
  host.append(box);
}

function renderSavedCardSearchFailureHelp(host) {
  const box = document.createElement('div');
  box.className = 'no-result-box';
  box.setAttribute('role', 'status');
  const note = document.createElement('p');
  note.textContent = '保存カードの検索APIでエラーが発生しました。カードに該当記事がないとは判断できません。検索語と条件は保持しています。';
  box.append(note);
  const actions = document.createElement('div');
  actions.className = 'evidence-actions';
  actions.append(resultButton('同じ条件で再試行', () => {
    if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f2', event: 'started', trigger: 'user_action', mode: 'manual', outcome: 'retry' });
    box.remove(); runSearchScreen();
  }));
  actions.append(resultButton('検索条件を確認', () => { document.getElementById('search-details').open = true; document.getElementById('search-details').scrollIntoView({ block: 'nearest' }); }));
  actions.append(resultButton('この案内を閉じる', () => {
    if (typeof ContextualAutomation !== 'undefined') ContextualAutomation.suppress('f2', document.getElementById('search-terms').value.trim());
    box.remove();
  }));
  box.append(actions);
  host.append(box);
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f2', event: 'failed', trigger: 'search_api_error', outcome: 'error' });
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f2', event: 'shown', trigger: 'search_api_error' });
}

function renderCollectedSearchFailureHelp(host) {
  host.querySelector('#collected-search-failure')?.remove();
  const box = document.createElement('div');
  box.id = 'collected-search-failure';
  box.className = 'no-result-box';
  box.setAttribute('role', 'status');
  const title = document.createElement('p');
  title.className = 'no-result-title';
  title.textContent = '今回の収集記事検索を完了できませんでした';
  const note = document.createElement('p');
  note.textContent = '記事が存在しないとは判断できません。検索語・条件は保持しています。下に前回の結果が表示されている場合は、今回の検索結果ではありません。';
  box.append(title, note);
  const actions = document.createElement('div');
  actions.className = 'evidence-actions';
  actions.append(resultButton('同じ条件で再試行', () => {
    if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f2', event: 'started', trigger: 'user_action', mode: 'manual', outcome: 'retry' });
    box.remove(); runBM25();
  }));
  actions.append(resultButton('検索先・条件を確認', () => {
    const details = document.getElementById('search-details');
    if (details) { details.open = true; details.scrollIntoView({ block: 'nearest' }); }
  }));
  actions.append(resultButton('この案内を閉じる', () => {
    if (typeof ContextualAutomation !== 'undefined') ContextualAutomation.suppress('f2', 'collected-search-api-error');
    box.remove();
  }));
  box.append(actions);
  host.prepend(box);
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f2', event: 'failed', trigger: 'search_api_error', outcome: 'error' });
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f2', event: 'shown', trigger: 'search_api_error' });
}

async function openSavedCardSearchItemAtSnippet(item) {
  if (typeof isContextualFeatureEnabled === 'function' && !isContextualFeatureEnabled('f1')) return;
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f1', event: 'started', trigger: 'user_action', mode: 'manual' });
  if (!await openReaderForCard(item.article.id)) {
    if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f1', event: 'failed', trigger: 'user_action', outcome: 'error' });
    return;
  }
  presentSearchSnippetTarget(item.snippet);
  const choice = document.getElementById('reader-search-passage-choice');
  const ambiguous = Boolean(choice?.querySelector('button'));
  const matched = choice?.textContent.includes('一意な一致を確認') === true;
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f1', event: matched ? 'completed' : ambiguous ? 'completed' : 'failed', trigger: 'user_action', outcome: matched ? 'ok' : ambiguous ? 'ambiguous' : 'unmatched' });
}

async function openSavedCardForRelatedPassage(item) {
  if (typeof isContextualFeatureEnabled === 'function' && !isContextualFeatureEnabled('f6')) return;
  const purpose = document.getElementById('search-terms').value.trim();
  if (purpose.length < 2 || !await openReaderForCard(item.article.id)) return;
  if (typeof ContextualStudy !== 'undefined') ContextualStudy.record({ feature: 'f6', event: 'started', trigger: 'user_action', mode: 'manual', processor: 'rules' });
  document.getElementById('evidence-purpose').value = purpose;
  await runEvidence({ forceWords: true });
}

/** The 検索 button / Enter. webOnly: re-run just the web part (after editing the web queries). */
async function runSearchScreen(options = {}) {
  if (typeof cancelKeywordExpansion === 'function') cancelKeywordExpansion();
  const input = document.getElementById('search-terms');
  const text = input.value.trim();
  if (!text) { toast('調べたいことを入れてください', 'warn'); input.focus(); return; }
  const targets = selectedSearchTargets();
  if (!targets.length) { toast('検索先を1つ以上選んでください', 'warn'); return; }
  const button = document.getElementById('bm25-run-btn');
  button.disabled = true;
  try {
    await ensureKeywordsFor(text);
    lastSearchTerms = bm25Keywords.map(keyword => keyword.term);
    const cardsSelected = selectedSearchTargets().includes('cards');
    if (!options.webOnly && cardsSelected && hasRefindStudyConsent()) {
      activeRefindStudy = await beginRefindStudy(text);
    } else if (!cardsSelected && activeRefindStudy) {
      await expireRefindStudy();
    }
    const collected = selectedCollectedTargets();
    const web = targets.filter(value => value.startsWith('web:')).map(value => value.slice(4));
    const tasks = [];
    if (!options.webOnly) {
      if (collected.length) {
        button.disabled = false; // runBM25 guards itself with the same button
        tasks.push(runBM25());
      } else {
        bm25Result = null;
        document.getElementById('search-collected').textContent = '';
      }
      if (targets.includes('cards')) tasks.push(runCardSearch().catch(async error => {
        const host = document.getElementById('search-cards');
        host.replaceChildren();
        const failure = document.createElement('p');
        failure.className = 'reader-note';
        failure.textContent = `カードを検索できませんでした: ${formatApiError(error)}`;
        host.append(failure);
        const contextual = typeof ContextualAutomation === 'undefined'
          || ContextualAutomation.resolve('f2', { eligible: true, contextKey: document.getElementById('search-terms').value.trim() }) === 'eligible';
        if (contextual) renderSavedCardSearchFailureHelp(host, error);
        await renderRefindStudyReview();
      }));
      else { cardSearchResult = null; document.getElementById('search-cards').textContent = ''; }
    }
    if (web.length) tasks.push(runWebSearch(text, web));
    else if (!options.webOnly) { discoverLastResult = null; document.getElementById('search-web').textContent = ''; }
    await Promise.allSettled(tasks);
    renderScopeLine();
    renderBroadQuestion(text);
    renderIntentAnswer(text);
  } finally {
    button.disabled = false;
  }
}

// Saved searches: how many new articles match each one since it was last marked checked.
async function loadSavedSearchNewCounts() {
  let counts;
  try { ({ counts } = await api.get('/api/search/new-counts')); } catch { return; }
  const select = document.getElementById('saved-search-select');
  let total = 0;
  for (const option of select.options) {
    const count = counts[option.value]?.newCount ?? 0;
    const search = savedSearches.find(item => item.id === option.value);
    if (!search) continue;
    option.textContent = count ? `${search.name}（新着 ${count}件）` : search.name;
    total += count;
  }
  const tab = [...document.querySelectorAll('.tab')].find(element => element.getAttribute('onclick') === "switchView('bm25')");
  if (tab) tab.textContent = total ? `探す（新着 ${total}）` : '探す';
}

// ─── broad questions ("IT業界で今問題になっていること") ─────────────────────────
// Keyword search looks for the words of the text in articles. A question without a topic word finds
// articles that merely contain "問題" or "最近". Say so, and offer concrete topics to search instead.

/** A result that hits less than half of the topic words (generic words do not count). */
function isWeakMatch(item) {
  const specific = (searchAnalysis?.specificTerms || []).map(term => term.toLowerCase());
  if (!specific.length) return Boolean(searchAnalysis?.broad);
  const matched = new Set((item.matchedKeywords || []).map(term => String(term).toLowerCase()));
  return specific.filter(term => matched.has(term)).length * 2 < specific.length;
}

let broadTopicsRequest = 0;
let searchCarry = null;

// ─── answers by kind of question ───────────────────────────────────
// Rules on titles only (no AI; snippets mention 基本 or 運用 in passing): which results fit the kind of question, in which order.
const INTENT_STAGES = {
  learn: [['入門・基礎', /(入門|はじめ|初心者|基礎|基本|超入門|ゼロから|getting started|beginner|introduction|101)/i], ['解説・まとめ', /(解説|仕組み|とは|まとめ|ガイド|guide|tutorial|チュートリアル|ロードマップ|roadmap|学び|知っておき)/i], ['実践・応用', /(実践|応用|やってみた|ハンズオン|運用|改善|事例|best practice)/i]],
  howto: [['手順・やり方', /(手順|方法|やり方|やってみた|ハンズオン|how to|導入|設定|構築|実装)/i]],
  why: [['理由・原因の説明', /(なぜ|理由|原因|背景|仕組み|とは|why)/i]],
  compare: [['比べている記事', /(比較|vs\.?|違い|選び方|どっち|benchmark|ベンチマーク)/i]],
  case: [['導入・移行・振り返り', /(事例|導入|移行|振り返り|活用|運用|実践|レポート|ケーススタディ|case study)/i]],
  future: [['展望・予測', /(今後|将来|これから|展望|予測|未来|ロードマップ|roadmap|trend|トレンド)/i]],
};

function intentNow(text) {
  if (searchAnalysis?.intent) return { intent: searchAnalysis.intent, label: searchAnalysis.intentLabel };
  if (searchCarry && searchCarry.text === text && searchCarry.intent) return { intent: searchCarry.intent, label: searchCarry.intentLabel };
  return null;
}

function intentArticleLink(article) {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'intent-article';
  link.textContent = article.title;
  link.onclick = () => (findSearchItem(article.id) ? openSearchArticle(article.id) : openReader(article.url || '', article.id));
  return link;
}

let intentRequest = 0;
async function renderIntentAnswer(text) {
  let host = document.getElementById('search-intent');
  if (!host) {
    host = document.createElement('div');
    host.id = 'search-intent';
    const broad = document.getElementById('search-broad');
    if (broad) broad.after(host); else document.getElementById('bm25-result-body')?.prepend(host);
  }
  host.replaceChildren();
  const now = intentNow(text);
  if (!now) return;
  const request = ++intentRequest;
  const box = document.createElement('div');
  box.className = 'intent-box';
  const title = document.createElement('p');
  title.className = 'intent-title';
  box.append(title);
  const items = bm25Result?.active || [];

  if (now.intent === 'trend') {
    title.textContent = `〈${now.label}〉として、集めた記事のタイトルから話題を数えています…`;
    host.append(box);
    let data;
    try { data = await api.post('/api/search/insights', { kind: 'trend', sources: selectedCollectedTargets(), days: 30 }); } catch { title.textContent = '話題を数えられませんでした'; return; }
    if (request !== intentRequest) return;
    title.textContent = data.compared
      ? `〈${now.label}〉直近${data.days}日の記事（${data.recentCount}件）で、それ以前（${data.olderCount}件）より多く出ている話題`
      : `〈${now.label}〉直近${data.days}日の記事（${data.recentCount}件）でよく出ている話題（比べられる古い記事が少ないため「増えた」かどうかは分かりません）`;
    if (!data.topics.length) { title.textContent += '：見つかりませんでした'; return; }
    for (const topic of data.topics) {
      const row = document.createElement('div');
      row.className = 'intent-topic';
      const term = document.createElement('button');
      term.type = 'button';
      term.className = 'btn btn-secondary btn-sm';
      term.textContent = `${topic.term}（${topic.count}件${data.compared ? `／以前 ${topic.before}件` : ''}）`;
      term.title = 'この言葉で検索';
      term.onclick = () => { document.getElementById('search-terms').value = topic.term; runSearchScreen(); };
      row.append(term, ...topic.articles.map(intentArticleLink));
      box.append(row);
    }
    const note = document.createElement('p');
    note.className = 'reader-note';
    note.textContent = '記事のタイトルに出る言葉を数えただけです。何が問題なのかは、記事を読んで確かめてください。';
    box.append(note);
    return;
  }

  if (now.intent === 'overview') {
    if (items.length < 4) return;
    title.textContent = `〈${now.label}〉結果を、共通する言葉でまとめています…`;
    host.append(box);
    let data;
    try { data = await api.post('/api/search/insights', { kind: 'overview', ids: items.slice(0, 80).map(item => item.article.id), terms: lastSearchTerms }); } catch { title.textContent = 'まとめられませんでした'; return; }
    if (request !== intentRequest) return;
    if (!data.topics.length) { host.replaceChildren(); return; }
    title.textContent = `〈${now.label}〉結果を共通する言葉でまとめると`;
    for (const topic of data.topics) {
      const row = document.createElement('div');
      row.className = 'intent-topic';
      const label = document.createElement('strong');
      label.textContent = `${topic.term}（${topic.count}件）`;
      row.append(label, ...topic.articles.map(intentArticleLink));
      box.append(row);
    }
    return;
  }

  if (now.intent === 'mine') {
    if (selectedSearchTargets().includes('cards')) return;
    title.textContent = `〈${now.label}〉を探すなら、検索先の「自分のカード」にチェックを入れてください。`;
    host.append(box);
    return;
  }

  const stages = INTENT_STAGES[now.intent];
  if (!stages || !items.length) return;
  const used = new Set();
  const groups = stages.map(([label, pattern]) => {
    const list = items.filter(item => !used.has(item.article.id) && pattern.test(item.article.title || ''));
    list.forEach(item => used.add(item.article.id));
    return [label, list.slice(0, 5)];
  }).filter(([, list]) => list.length);
  title.textContent = groups.length
    ? `〈${now.label}〉に合いそうな記事${now.intent === 'learn' ? '（学ぶ順）' : ''}`
    : `〈${now.label}〉に合いそうな記事（タイトルに「${stages.map(([label]) => label).join('・')}」らしい言葉があるもの）は、今の結果にはありませんでした`;
  for (const [label, list] of groups) {
    const row = document.createElement('div');
    row.className = 'intent-topic';
    const head = document.createElement('strong');
    head.textContent = label;
    row.append(head, ...list.map(item => intentArticleLink(item.article)));
    box.append(row);
  }
  host.append(box);
}

async function renderBroadQuestion(text) {
  let host = document.getElementById('search-broad');
  if (!host) {
    host = document.createElement('div');
    host.id = 'search-broad';
    document.getElementById('bm25-result-body')?.prepend(host);
  }
  host.replaceChildren();
  const items = [...(bm25Result?.active || []), ...(cardSearchResult?.active || [])];
  const allWeak = items.length > 0 && items.slice(0, 5).every(item => isWeakMatch(item));
  if (!searchAnalysis?.broad && !allWeak) return;
  const box = document.createElement('div');
  box.className = 'broad-box';
  const title = document.createElement('p');
  title.className = 'broad-title';
  title.textContent = searchAnalysis?.broad
    ? `広い質問です（${searchAnalysis.reason}）。この検索は記事に書かれた言葉で探すため、このままでは関係の薄い記事が並びます。`
    : '上位の結果は、調べたいことの一部の言葉にしか当たっていません。';
  box.append(title);
  if (searchAnalysis?.intentLabel) {
    const kind = document.createElement('p');
    kind.className = 'reader-note';
    kind.textContent = `質問の種類: ${searchAnalysis.intentLabel}`;
    box.append(kind);
  }
  const chips = document.createElement('div');
  chips.className = 'broad-topics';
  box.append(chips);
  host.append(box);
  const request = ++broadTopicsRequest;
  const note = document.createElement('p');
  note.className = 'reader-note';
  chips.append(note);
  const ready = typeof localAi !== 'undefined' && await localAi.isReady('prompt').catch(() => false);
  if (!ready) {
    note.textContent = '技術名・製品名・分野名を1つ足すと絞り込めます（例: 「生成AI セキュリティ」）。端末内蔵のAIを準備すると、具体的なテーマの候補をここに出します。';
    return;
  }
  note.textContent = '端末内蔵のAIでテーマの候補を作っています…';
  let topics = [];
  try { topics = await localAi.splitTopics(text); } catch { topics = []; }
  if (request !== broadTopicsRequest) return;
  if (!topics.length) { note.textContent = 'テーマの候補を作れませんでした。技術名・製品名・分野名を1つ足してみてください。'; return; }
  note.textContent = 'どの方向で調べますか？（AIの候補です。選ぶとその言葉で検索します）';
  for (const topic of topics) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'btn btn-secondary btn-sm';
    chip.textContent = topic;
    chip.onclick = () => {
      // the kind of question stays with the topic (学ぶべきこと → the topic's learning order)
      searchCarry = { text: topic, intent: searchAnalysis?.intent || null, intentLabel: searchAnalysis?.intentLabel || null };
      document.getElementById('search-terms').value = topic;
      runSearchScreen();
    };
    chips.append(chip);
  }
}

let searchScreenReady = false;
function initSearchScreen() {
  if (typeof renderLocalAiControl === 'function') renderLocalAiControl(document.getElementById('discover-ai-status'), 'prompt');
  if (typeof renderDiscoverQueries === 'function') renderDiscoverQueries();
  if (!searchScreenReady) {
    searchScreenReady = true;
    document.querySelector('input[name="bm25src"][value="articles"]').checked = true;
  }
  loadSearchTargets();
  loadRefindStudyControl();
}

async function loadRefindStudyControl() {
  const checkboxes = [...document.querySelectorAll('.refind-study-consent')];
  const statuses = [...document.querySelectorAll('.refind-study-status')];
  if (!checkboxes.length || !statuses.length) return;
  const setConsentCheckboxes = value => { for (const checkbox of checkboxes) checkbox.checked = value; };
  const setStatuses = value => { for (const status of statuses) status.textContent = value; };
  refindStudyAvailable = false;
  refindStudyPlan = null;
  try {
    const data = await api.get('/api/refind-study/status');
    refindStudyPlan = data;
    refindStudyAvailable = Boolean(data.available);
    setConsentCheckboxes(refindStudyAvailable && localStorage.getItem(REFIND_CONSENT_KEY) === 'yes');
    if (data.expiredByRetention) setStatuses('保持期限を過ぎた記録は自動削除されました。');
    else if (!data.preregistered) setStatuses('検索語と結果を評価用に記録するには、このコードに対応する個人向けコホートの初期化が必要です。');
    else if (!data.buildMatches) setStatuses('この記録コホートと現在の検索コードが一致しないため、このビルドでは記録を停止しています。');
    else if (data.sealed) setStatuses('この記録コホートは封印済みです。');
    else setStatuses(`個人の自然な再発見検索を記録します。計画n=${data.plannedN}。現在${data.collected}件をこのPCに保存しています。結果集計は評価用に固定するまで表示しません。`);
  } catch {
    setConsentCheckboxes(false);
    setStatuses('計測状態を確認できません。検索は通常どおり利用でき、記録は行いません。');
  }
  for (const checkbox of checkboxes) checkbox.onchange = async () => {
    if (checkbox.checked) {
      if (!refindStudyAvailable) {
        setConsentCheckboxes(false);
        toast('このコードに一致する事前登録がないため参加できません', 'warn');
        return;
      }
      const plan = refindStudyPlan;
      const accepted = confirm(`個人向け検索評価への任意参加\n\n保存した記事を自然に探す検索だけを記録してください。検索文は検索開始時に固定し、初回Top10・APIエラー・応答時間・検索後に本人が確認した検索目的と正解記事をこのPCの quality/e2e/local/personal-refind/study に保存します。外部送信はありません。\n\n対象: ${plan?.targetPopulation || '本人の自然な保存記事再発見'}\n計画件数: ${plan?.plannedN}。記録は初期OFFで、検索結果の良し悪しは収集終了まで表示しません。チェックを外すと今後の記録を停止します。削除ボタンでローカル記録をすべて消せます。\n\n参加しますか？`);
      if (!accepted) { setConsentCheckboxes(false); return; }
      if (!localStorage.getItem(REFIND_PARTICIPANT_KEY)) localStorage.setItem(REFIND_PARTICIPANT_KEY, crypto.randomUUID().replace(/-/g, ''));
      localStorage.setItem(REFIND_CONSENT_KEY, 'yes');
      setConsentCheckboxes(true);
    } else {
      if (activeRefindStudy && !confirm('現在の検索セッションを未完了として記録します。既に保存された調査データの削除には「参加を撤回して記録を削除」を選んでください。参加を停止しますか？')) {
        setConsentCheckboxes(true);
        return;
      }
      localStorage.removeItem(REFIND_CONSENT_KEY);
      setConsentCheckboxes(false);
      expireRefindStudy();
    }
  };
  const saved = sessionStorage.getItem(REFIND_SESSION_KEY);
  if (saved && hasRefindStudyConsent()) {
    try {
      activeRefindStudy = JSON.parse(saved);
      const remaining = 180000 - (Date.now() - activeRefindStudy.startedMs);
      if (remaining <= 0) expireRefindStudy();
      else {
        const sid = activeRefindStudy.sid;
        window.setTimeout(() => { if (activeRefindStudy?.sid === sid) expireRefindStudy(); }, remaining);
      }
    } catch { sessionStorage.removeItem(REFIND_SESSION_KEY); }
  }
}

function hasRefindStudyConsent() {
  return refindStudyAvailable && [...document.querySelectorAll('.refind-study-consent')].some(checkbox => checkbox.checked);
}

async function beginRefindStudy(query) {
  if (!hasRefindStudyConsent()) return null;
  if (activeRefindStudy) {
    if (Date.now() - activeRefindStudy.startedMs > 180000 || activeRefindStudy.searchCount >= 3) {
      await expireRefindStudy();
    } else {
      activeRefindStudy.searchCount += 1;
      await recordRefindInteraction({ action: 'query', query });
      sessionStorage.setItem(REFIND_SESSION_KEY, JSON.stringify(activeRefindStudy));
      return activeRefindStudy;
    }
  }
  const participant = localStorage.getItem(REFIND_PARTICIPANT_KEY);
  if (!participant) return null;
  try {
    const session = await api.post('/api/refind-study/sessions', { participant, query, consent: true });
    activeRefindStudy = { sid: session.sid, startedMs: Date.now(), searchCount: 1 };
    sessionStorage.setItem(REFIND_SESSION_KEY, JSON.stringify(activeRefindStudy));
    window.setTimeout(() => { if (activeRefindStudy?.sid === session.sid) expireRefindStudy(); }, 180000);
    return activeRefindStudy;
  } catch (error) {
    toast(`調査記録を開始できませんでした。検索は続行します: ${formatApiError(error)}`, 'warn');
    return null;
  }
}

async function recordRefindInteraction(payload) {
  if (!activeRefindStudy) return;
  const session = activeRefindStudy;
  try {
    await api.post(`/api/refind-study/sessions/${encodeURIComponent(session.sid)}/interactions`, payload);
  } catch (error) {
    for (const status of document.querySelectorAll('.refind-study-status')) status.textContent = `調査記録に失敗しました。通常検索は継続します。${formatApiError(error)}`;
    for (const checkbox of document.querySelectorAll('.refind-study-consent')) checkbox.checked = false;
    localStorage.removeItem(REFIND_CONSENT_KEY);
    activeRefindStudy = null;
    sessionStorage.removeItem(REFIND_SESSION_KEY);
    await api.post(`/api/refind-study/sessions/${encodeURIComponent(session.sid)}/expire`, {}).catch(() => {});
  }
}

async function expireRefindStudy() {
  if (!activeRefindStudy) return;
  const session = activeRefindStudy;
  activeRefindStudy = null;
  sessionStorage.removeItem(REFIND_SESSION_KEY);
  await api.post(`/api/refind-study/sessions/${encodeURIComponent(session.sid)}/expire`, {}).catch(() => {});
}

async function renderRefindStudyReview(mountId = 'refind-study-review') {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  const prefix = mountId === 'refind-study-review' ? 'refind-study' : 'refind-study-list';
  mount.replaceChildren();
  if (!activeRefindStudy || !hasRefindStudyConsent()) return;
  const row = document.createElement('div');
  row.className = 'refind-study-review';
  const label = document.createElement('label');
  label.textContent = '検索後の人手確認';
  const category = document.createElement('select');
  category.id = `${prefix}-category`;
  category.setAttribute('aria-label', '今回の検索目的');
  category.innerHTML = '<option value="">検索目的を選択…</option><option value="memory">内容の記憶や関連語から保存記事を探した</option><option value="exact-title">正確な記事タイトルで探した</option><option value="no-saved-target">保存記事の再発見ではなかった</option><option value="unresolved">目的や正解を確認できなかった</option>';
  const select = document.createElement('select');
  select.id = `${prefix}-gold-cards`;
  select.multiple = true;
  select.size = 4;
  select.setAttribute('aria-label', '探していた保存カード。複数ある場合は複数選択');
  select.disabled = true;
  category.addEventListener('change', () => {
    const needsGold = category.value === 'memory' || category.value === 'exact-title';
    select.disabled = !needsGold;
    if (!needsGold) for (const option of select.options) option.selected = false;
  });
  const help = document.createElement('span');
  help.textContent = '正解記事は複数選択できます。';
  help.className = 'reader-note';
  const finish = document.createElement('button');
  finish.type = 'button'; finish.className = 'btn btn-secondary btn-sm'; finish.textContent = '検索を終了して判定を記録';
  let cards = [];
  try { cards = await api.get('/api/refind-study/cards'); } catch { /* the measured search remains available */ }
  for (const card of cards) {
    const option = document.createElement('option'); option.value = card.id; option.textContent = card.title || card.id; select.append(option);
  }
  finish.onclick = async () => {
    const selectedGoldIds = [...select.selectedOptions].map(option => option.value);
    const needsGold = category.value === 'memory' || category.value === 'exact-title';
    if (!category.value || (needsGold && !selectedGoldIds.length) || (!needsGold && selectedGoldIds.length)) {
      toast('検索目的を選び、記憶検索・正確なタイトル検索では対象カードも選んでください', 'warn'); return;
    }
    const categoryLabels = { memory: '内容の記憶や関連語からの再発見', 'exact-title': '正確なタイトル検索', 'no-saved-target': '保存記事の再発見ではない', unresolved: '未確認' };
    if (!confirm(`検索後の人手確認として「${categoryLabels[category.value]}」で記録します。選んだ記事が本当に探していた対象か確認してください。`)) return;
    finish.disabled = true;
    try {
      const result = await api.post(`/api/refind-study/sessions/${encodeURIComponent(activeRefindStudy.sid)}/adjudication`, {
        category: category.value, goldIds: selectedGoldIds, unknown: !needsGold, humanChecked: category.value !== 'unresolved',
      });
      sessionStorage.removeItem(REFIND_SESSION_KEY); activeRefindStudy = null;
      mount.textContent = result.category === 'memory' ? '自然な再発見としてローカル記録を保存しました。'
        : '検索目的をローカル記録に保存しました。正確なタイトル検索や未確認の記録は主評価から除外します。';
    } catch (error) { finish.disabled = false; toast(`判定を保存できませんでした: ${formatApiError(error)}`, 'warn'); }
  };
  label.htmlFor = category.id;
  row.append(label, category, select, help, finish); mount.append(row);
}

async function withdrawRefindStudy() {
  if (!confirm('このPCに保存された調査ログ（検索語を含む）をすべて削除し、現在の調査から撤回します。続けますか？')) return;
  try {
    const result = await api.del('/api/refind-study');
    localStorage.removeItem(REFIND_CONSENT_KEY); localStorage.removeItem(REFIND_PARTICIPANT_KEY);
    sessionStorage.removeItem(REFIND_SESSION_KEY); activeRefindStudy = null;
    for (const checkbox of document.querySelectorAll('.refind-study-consent')) checkbox.checked = false;
    document.getElementById('refind-study-review')?.replaceChildren();
    document.getElementById('refind-study-review-list')?.replaceChildren();
    toast(result.deleted ? '調査記録を削除しました' : '記録を削除できませんでした');
    loadRefindStudyControl();
  } catch (error) { toast(`撤回できませんでした: ${formatApiError(error)}`, 'warn'); }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSearchTargets();
  setTimeout(() => { if (typeof loadSavedSearchNewCounts === 'function' && savedSearches.length) loadSavedSearchNewCounts(); }, 1500);
});
