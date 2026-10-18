// Registering a site by its URL: the app looks at the site (public API, sitemap, article list, RSS),
// shows what it found, and starts collecting once the user confirms. Text from other sites is only
// ever put into the page with textContent.
let sitePreviewResult = null;

function siteEl(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function siteDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function previewSite(prefixes) {
  const input = document.getElementById('site-url');
  const url = input.value.trim();
  if (!url) { toast('ブログか記事のURLを入れてください', 'warn'); input.focus(); return; }
  const host = document.getElementById('site-preview');
  const button = document.getElementById('site-preview-btn');
  button.disabled = true;
  host.textContent = prefixes
    ? '指定した範囲で調べ直しています…'
    : 'URLを調べています…（記事のURLなら、そのブログを探します。公開API・サイトマップ・記事一覧・RSSを順に確認するので、数十秒かかることがあります）';
  try {
    sitePreviewResult = await api.post('/api/sites/preview', prefixes ? { url, prefixes } : { url });
    renderSitePreview();
  } catch (error) {
    host.textContent = `調べられませんでした: ${formatApiError(error)}`;
  } finally {
    button.disabled = false;
  }
}

function siteLink(url, text) {
  const link = siteEl('a', '', text || url);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

// "Save just this article" from the preview of an article URL.
async function saveOnlyArticle(button, url) {
  button.disabled = true;
  button.textContent = '保存しています…';
  try {
    const saved = await saveArticleWithFullText(url);
    if (saved) { button.textContent = '保存しました'; toast('記事を本文ごとカードに保存しました', 'success'); if (typeof loadCards === 'function') loadCards(); }
    else { button.disabled = false; button.textContent = 'この記事だけ保存する'; toast('本文を取得できませんでした。「読んでメモ」から本文を貼り付けて保存できます', 'warn'); }
  } catch (error) {
    button.disabled = false;
    button.textContent = 'この記事だけ保存する';
    showApiError(error, '保存できませんでした');
  }
}

function renderSitePreview() {
  const result = sitePreviewResult;
  const host = document.getElementById('site-preview');
  host.textContent = '';
  if (!result) return;
  if (result.kind === 'article' && result.article) {
    const box = siteEl('div', 'site-preview-box');
    box.append(siteEl('h5', '', 'この記事'));
    const line = siteEl('p');
    line.append(siteLink(result.article.url, result.article.title || result.article.url));
    if (result.article.publishedAt) line.append(siteEl('span', 'reader-note', ` ${new Date(result.article.publishedAt).toLocaleDateString('ja-JP')}`));
    box.append(line);
    const only = siteEl('button', 'btn btn-secondary btn-sm', 'この記事だけ保存する');
    only.type = 'button';
    only.onclick = () => saveOnlyArticle(only, result.article.url);
    box.append(only);
    if (result.alreadyIn) box.append(siteEl('p', 'site-ok', `このブログは「${result.alreadyIn.name}」として登録済みです。新しい記事は自動で集まります。`));
    else if (result.candidates.length) box.append(siteEl('p', 'reader-note', 'または、この記事が載っているブログを情報源として登録できます（以下）。'));
    host.append(box);
  }
  if (result.alreadyIn && result.kind === 'article') return;
  if (!result.candidates.length) {
    const box = siteEl('div', 'site-preview-box');
    box.append(siteEl('p', 'site-error', result.error || 'このサイトは自動では登録できません'));
    host.append(box);
    return;
  }
  result.candidates.forEach((candidate, index) => host.append(renderSiteCandidate(candidate, index, result.candidates.length)));
}

function renderSiteCandidate(candidate, index, total) {
  const box = siteEl('div', 'site-preview-box');
  if (total > 1) box.append(siteEl('h5', '', index === 0 ? '候補1（おすすめ）' : `候補${index + 1}`));
  if (!candidate.ok) {
    box.append(siteEl('p', 'site-error', candidate.error || 'このサイトは自動では登録できません'));
    for (const note of candidate.notes || []) box.append(siteEl('p', 'reader-note', note));
    return box;
  }
  if (candidate.existing) box.append(siteEl('p', 'site-error', `このサイトは「${candidate.existing.name}」として登録済みです`));
  const name = siteEl('input', 'site-name-input');
  name.value = candidate.name;
  name.maxLength = 100;
  const nameRow = siteEl('label', 'site-field', '情報源の名前 ');
  nameRow.append(name);
  const facts = siteEl('dl', 'site-facts');
  const fact = (term, value) => { const dd = siteEl('dd'); if (value instanceof Node) dd.append(value); else dd.textContent = value; facts.append(siteEl('dt', '', term), dd); };
  fact('登録URL', siteLink(candidate.siteUrl));
  fact('取得方法', `${candidate.adapterLabel}${candidate.availableLabels.length > 1 ? `（ほかに使える方法: ${candidate.availableLabels.filter(label => label !== candidate.adapterLabel).join('・')}）` : ''}`);
  const inScope = candidate.pathGroups.filter(group => group.inScope);
  const outside = candidate.pathGroups.filter(group => !group.inScope);
  fact('対象の範囲', `${candidate.scope.hosts[0]} の ${candidate.prefixes.join('、')} 以下${candidate.scope.linked ? '（このページとそのRSSに載っている記事）' : ''}${inScope.length ? `　見つかった記事 ${inScope.reduce((sum, group) => sum + group.count, 0)}件` : ''}`);
  fact('対象外', outside.length ? outside.map(group => `${group.prefix}（${group.count}件）`).join('、') : (candidate.scope.linked ? '同じサイトのほかのページ' : '同じホストのこれ以外のパス・ほかのサイト'));
  fact('記事の数', candidate.estimatedCount != null ? `約${candidate.estimatedCount}件（見つかった範囲）` : '不明');
  fact('自動収集', `${candidate.plan.pastArticles ? '過去の記事も取得できます' : '最新の記事だけ（この方法では過去の記事は取れません）'}・以後1日1回、新しい記事を確認${candidate.plan.pagesAllowed ? '' : '・robots.txt により記事ページは読みません（一覧の情報だけ）'}`);
  box.append(nameRow, facts);

  // The scope can be checked and changed before registering (same host only; several paths allowed).
  const scopeEdit = siteEl('details', 'site-scope-edit');
  scopeEdit.append(siteEl('summary', '', '対象の範囲を変える'));
  const area = siteEl('textarea');
  area.rows = 3;
  area.value = candidate.prefixes.join('\n');
  area.placeholder = '/blog/\n/tech/';
  scopeEdit.append(siteEl('p', 'reader-note', `パスを1行に1つ（${candidate.scope.hosts[0]} の中だけ）。記事が複数の場所にあるときは複数書けます。`), area);
  const retry = siteEl('button', 'btn btn-secondary btn-sm', 'この範囲で調べ直す');
  retry.type = 'button';
  retry.onclick = () => {
    document.getElementById('site-url').value = candidate.siteUrl;
    previewSite(area.value.split(/\n+/).map(value => value.trim()).filter(Boolean));
  };
  scopeEdit.append(retry);
  box.append(scopeEdit);

  if (candidate.samples.length) {
    box.append(siteEl('h5', '', '取得できた記事の例'));
    const list = siteEl('ul', 'site-samples');
    for (const sample of candidate.samples) {
      const item = siteEl('li');
      item.append(siteLink(sample.url, sample.title || `${sample.url}（タイトルは登録後に取得）`));
      if (sample.publishedAt) item.append(siteEl('span', 'reader-note', ` ${new Date(sample.publishedAt).toLocaleDateString('ja-JP')}`));
      list.append(item);
    }
    box.append(list);
  }
  for (const note of candidate.notes) box.append(siteEl('p', 'reader-note', `※ ${note}`));

  // Full text needs the site's permission: the user decides after reading the terms (never assumed).
  const policy = siteEl('fieldset', 'site-policy');
  policy.append(siteEl('legend', '', '検索に使う内容'));
  const group = `site-body-policy-${index}`;
  const option = (value, label, checked) => {
    const row = siteEl('label', 'site-policy-option');
    const radio = siteEl('input');
    radio.type = 'radio';
    radio.name = group;
    radio.value = value;
    radio.checked = checked;
    row.append(radio, document.createTextNode(` ${label}`));
    return row;
  };
  policy.append(
    option('pending', 'タイトル・概要だけ（利用規約をまだ確認していない。あとで変えられます）', true),
    option('body', '本文も（利用規約を確認し、自分の検索用に本文を取得してよいと判断した）', false),
  );
  if (candidate.policyLinks.length) {
    const links = siteEl('p', 'reader-note', '確認先: ');
    candidate.policyLinks.forEach((policyLink, linkIndex) => {
      if (linkIndex) links.append(document.createTextNode('・'));
      links.append(siteLink(policyLink.url, policyLink.text || policyLink.url));
    });
    policy.append(links);
  }
  policy.append(siteEl('p', 'reader-note', 'サイトマップや記事一覧が公開されていても、本文をまとめて取得してよいとは限りません。本文はあなたの検索用にだけ保存し、公開・再配信はしません。'));
  box.append(policy);

  const limitRow = siteEl('label', 'site-field', '最初に取り込む記事 ');
  const limit = siteEl('input');
  limit.type = 'number';
  limit.min = '1';
  limit.max = '500';
  limit.value = '50';
  const planned = siteEl('span', 'reader-note');
  const updatePlanned = () => {
    const wanted = Math.min(500, Math.max(1, Number(limit.value) || 50));
    planned.textContent = candidate.estimatedCount != null ? ` → 最初に ${Math.min(wanted, candidate.estimatedCount)}件（新しい順）` : '';
  };
  limit.oninput = updatePlanned;
  updatePlanned();
  limitRow.append(limit, document.createTextNode(' 件まで'), planned);
  box.append(limitRow);

  let confirmBox = null;
  if (candidate.needsScopeConfirm) {
    const confirmRow = siteEl('label', 'site-confirm');
    confirmBox = siteEl('input');
    confirmBox.type = 'checkbox';
    confirmRow.append(confirmBox, document.createTextNode(` ${candidate.scope.hosts[0]} 全体を対象にすることを確認しました（ニュース・採用情報なども含まれる場合は、上の「対象の範囲を変える」で絞ってください）`));
    box.append(confirmRow);
  }

  const register = siteEl('button', 'btn btn-primary btn-sm', 'この範囲で情報源に登録する');
  register.type = 'button';
  register.disabled = !!candidate.existing;
  register.onclick = async () => {
    if (confirmBox && !confirmBox.checked) { toast('サイト全体を対象にするか、範囲を確認してください', 'warn'); return; }
    register.disabled = true;
    register.textContent = '登録しています…';
    try {
      const bodyPolicy = box.querySelector(`input[name="${group}"]:checked`)?.value || 'pending';
      const created = await api.post('/api/sites', {
        url: candidate.siteUrl,
        prefixes: candidate.prefixes,
        confirmWholeSite: !!confirmBox?.checked,
        name: name.value.trim() || undefined,
        bodyPolicy,
        maxInitial: Math.min(500, Math.max(1, Number(limit.value) || 50)),
      });
      toast(`「${created.site.name}」を登録しました。記事の取り込みを始めます`, 'success');
      sitePreviewResult = null;
      document.getElementById('site-preview').textContent = '';
      document.getElementById('site-url').value = '';
      await loadSiteList();
      watchSiteJob(created.jobId);
    } catch (error) {
      register.disabled = false;
      register.textContent = 'この範囲で情報源に登録する';
      showApiError(error, '登録できませんでした');
    }
  };
  box.append(register);
  return box;
}

/** From the reader: register the site of the article being read. */
function registerReaderSite() {
  const url = (typeof readerArticle !== 'undefined' && readerArticle?.url) || document.getElementById('reader-url').value.trim();
  if (!/^https?:\/\//i.test(url || '')) { toast('記事のURLがありません', 'warn'); return; }
  openSourceModal();
  switchSourceTab('site', document.querySelector('#source-modal .modal-tab'));
  document.getElementById('site-url').value = url;
  previewSite();
}

// Follow the background collection and refresh the list and the search targets when it ends.
async function watchSiteJob(jobId) {
  if (!jobId) return;
  for (let i = 0; i < 120; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    let job;
    try { job = await api.get(`/api/jobs/${encodeURIComponent(jobId)}`); } catch { return; }
    if (job.status === 'succeeded' || job.status === 'completed' || job.status === 'failed') {
      await loadSiteList();
      if (typeof loadSearchTargets === 'function') loadSearchTargets();
      const result = job.result || {};
      if (job.status === 'failed' || result.status === 'error') toast(`取り込みに失敗しました: ${result.error || job.error || ''}`, 'warn');
      else if (result.status === 'partial') toast(`一部の記事を取り込みました（新規 ${result.added ?? 0}件・失敗 ${result.failed ?? 0}件）。失敗した記事は次回再試行します`, 'warn');
      else toast(`取り込みました（新しい記事 ${result.added ?? 0}件${result.updated ? `・更新 ${result.updated}件` : ''}）`, 'success');
      return;
    }
    if (i % 3 === 0) loadSiteList();
  }
}

async function loadSiteList() {
  const host = document.getElementById('site-list');
  if (!host) return;
  let sites = [];
  try { sites = (await api.get('/api/sites')).sites; } catch (error) { host.textContent = `読み込めませんでした: ${formatApiError(error)}`; return; }
  host.textContent = '';
  if (!sites.length) { host.append(siteEl('p', 'reader-note', 'まだありません。')); return; }
  for (const site of sites) {
    const row = siteEl('div', `site-row site-status-${site.status}`);
    const head = siteEl('div', 'site-row-head');
    const link = siteEl('a', 'site-row-name', site.name);
    link.href = site.siteUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    head.append(link, siteEl('span', 'site-badge', site.statusLabel));
    const states = [site.missingCount ? `一覧から消えた ${site.missingCount}件` : '', site.goneCount ? `削除・非公開の可能性 ${site.goneCount}件` : '', site.restrictedCount ? `アクセス制限 ${site.restrictedCount}件` : '', site.errorCount ? `一時的に取得できない ${site.errorCount}件` : ''].filter(Boolean).join('・');
    const meta = siteEl('div', 'reader-note', `${site.adapterLabel} · 範囲 ${site.prefixes.join('、')} · 記事 ${site.articleCount}件（本文あり ${site.bodyCount}件）${states ? `（${states}。記事は残しています）` : ''} · 最終確認 ${siteDate(site.lastCheckedAt)}${site.pastArticles ? '' : ' · 最新の記事のみ（過去記事は取得できない方式）'}`);
    const policy = siteEl('label', 'reader-note');
    const select = siteEl('select');
    for (const [value, label] of [['pending', '利用条件の確認待ち（タイトル・概要のみ）'], ['metadata', 'タイトル・概要のみ'], ['body', '本文も取得（利用規約を確認済み）']]) {
      const optionElement = new Option(label, value);
      optionElement.selected = site.bodyPolicy === value;
      select.append(optionElement);
    }
    select.onchange = async () => {
      if (select.value === 'body' && !confirm('このサイトの利用規約で、本文の取得・保存（自分の検索用）が認められていることを確認しましたか？')) { select.value = site.bodyPolicy; return; }
      try { await api.put(`/api/sites/${encodeURIComponent(site.id)}`, { bodyPolicy: select.value }); toast('本文の扱いを変更しました（次の確認から反映）'); loadSiteList(); }
      catch (error) { showApiError(error); }
    };
    policy.append(document.createTextNode('本文: '), select);
    const actions = siteEl('div', 'evidence-actions');
    const sync = siteEl('button', 'btn btn-secondary btn-sm', '今すぐ確認');
    sync.onclick = async () => {
      sync.disabled = true;
      try { const { jobId } = await api.post(`/api/sites/${encodeURIComponent(site.id)}/sync`, {}); toast('新しい記事を確認しています'); watchSiteJob(jobId); setTimeout(loadSiteList, 1000); }
      catch (error) { sync.disabled = false; showApiError(error); }
    };
    const pause = siteEl('button', 'btn btn-secondary btn-sm', site.enabled ? '自動収集を停止' : '自動収集を再開');
    pause.title = site.enabled ? '定期的な確認を止めます。集めた記事・カード・メモはそのまま検索できます' : '確認を再開します（止めていた間の分も、一度に取りすぎないよう少しずつ）';
    pause.onclick = async () => {
      pause.disabled = true;
      try { await api.put(`/api/sites/${encodeURIComponent(site.id)}`, { enabled: !site.enabled }); toast(site.enabled ? '自動収集を停止しました' : '自動収集を再開しました'); loadSiteList(); }
      catch (error) { pause.disabled = false; showApiError(error); }
    };
    // Unregistering never deletes cards or memos; what happens to unsaved collected articles is asked here.
    const remove = siteEl('button', 'btn btn-secondary btn-sm', '登録を解除');
    remove.onclick = () => {
      const ask = siteEl('div', 'site-unregister');
      ask.append(siteEl('p', '', `「${site.name}」の登録を解除します。保存したカード・メモ・引用・タグは残ります。カードにしていない集めた記事（${site.unsavedCount}件）はどうしますか？`));
      const run = async choice => {
        try {
          const result = await api.del(`/api/sites/${encodeURIComponent(site.id)}?articles=${choice}`);
          toast(choice === 'delete' ? `登録を解除し、未保存の記事 ${result.removedArticles}件を削除しました` : '登録を解除しました（集めた記事は検索に残ります）');
          loadSiteList();
          if (typeof loadSearchTargets === 'function') loadSearchTargets();
        } catch (error) { showApiError(error); }
      };
      const keep = siteEl('button', 'btn btn-secondary btn-sm', '記事は残す');
      keep.onclick = () => run('keep');
      const drop = siteEl('button', 'btn btn-danger btn-sm', '未保存の記事を削除する');
      drop.onclick = () => run('delete');
      const cancel = siteEl('button', 'btn btn-secondary btn-sm', 'やめる');
      cancel.onclick = () => ask.remove();
      ask.append(keep, drop, cancel);
      row.append(ask);
      remove.disabled = true;
      cancel.addEventListener('click', () => { remove.disabled = false; });
    };
    actions.append(sync, pause, remove);
    row.append(head, meta, policy);
    if (site.lastError) row.append(siteEl('p', 'site-error', `前回の確認で問題: ${site.lastError}`));
    const warnings = site.lastResult?.warnings || [];
    if (warnings.length) row.append(siteEl('p', 'reader-note', `※ ${warnings.join(' / ')}`));
    row.append(actions);
    host.append(row);
  }
}
