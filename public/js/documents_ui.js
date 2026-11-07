let activeResearchDocument = null;
let researchEvidenceRows = [];
let selectedDocumentSearchText = '';
let researchDocumentRows = [];
let pendingResearchAIOutline = '';
let pendingResearchAICitations = [];
let researchAIController = null;
let researchAIRequestId = 0;
let pendingResearchAIProposal = null;
let researchSearchHandoff = null;
let pendingResearchCitationSelection = null;
let pendingBrowserClip = null;

function documentApi() {
  return window.mySearchContextualApi;
}

function openDesktopBrowser(url) {
  if (!window.mySearchDesktop) return false;
  return window.mySearchDesktop.openBrowser(url || '').catch(error => setDocumentMessage(error.message || '内蔵ブラウザーを開けませんでした', true));
}

function researchDraftKey(id) { return `my-search:document-draft:${id}`; }

function readResearchDraft(id) {
  try {
    const raw = localStorage.getItem(researchDraftKey(id));
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && value.documentId === id && typeof value.title === 'string' && typeof value.markdown === 'string' ? value : null;
  } catch { return null; }
}

function persistResearchDraft() {
  if (!activeResearchDocument) return;
  const draft = {
    documentId: activeResearchDocument.id,
    baseVersion: activeResearchDocument.version,
    title: document.getElementById('document-title').value,
    markdown: document.getElementById('document-markdown').value,
    updatedAt: new Date().toISOString(),
  };
  try { localStorage.setItem(researchDraftKey(activeResearchDocument.id), JSON.stringify(draft)); }
  catch { setDocumentMessage('ブラウザー内に下書きを保存できません。内容を早めに保存してください。', true); }
}

function clearResearchDraft(id) {
  try { localStorage.removeItem(researchDraftKey(id)); } catch { /* storage may be disabled */ }
  const banner = document.getElementById('document-draft');
  if (banner) banner.hidden = true;
}

function showResearchDraftIfAvailable(documentValue) {
  const banner = document.getElementById('document-draft');
  if (!banner) return;
  banner.hidden = true;
  if (!documentValue) return;
  const draft = readResearchDraft(documentValue.id);
  if (!draft || (draft.title === documentValue.title && draft.markdown === documentValue.markdown)) return;
  document.getElementById('document-draft-label').textContent = `未保存の下書きがあります（保存版 v${documentValue.version} を基準に編集中）。`;
  banner.hidden = false;
}

function restoreResearchDraft() {
  if (!activeResearchDocument) return;
  const draft = readResearchDraft(activeResearchDocument.id);
  if (!draft) { clearResearchDraft(activeResearchDocument.id); return; }
  document.getElementById('document-title').value = draft.title;
  document.getElementById('document-markdown').value = draft.markdown;
  renderDocumentPreview();
  document.getElementById('document-draft').hidden = true;
  setDocumentMessage('ブラウザー内の未保存下書きを復旧しました。保存版の変更と競合する場合は再読込してください。', true);
}

function discardResearchDraft() {
  if (activeResearchDocument) clearResearchDraft(activeResearchDocument.id);
  setDocumentMessage('未保存下書きを破棄しました。');
}

function setDocumentMessage(message, error = false) {
  const state = document.getElementById('document-save-state');
  if (!state) return;
  state.textContent = message;
  state.classList.toggle('document-error', error);
}

function appendDocumentPreviewInline(parent, value, citations, clips) {
  const pattern = /(\[\[(citation|clip):([0-9a-f-]{36})\]\]|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let last = 0;
  for (const match of value.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parent.append(document.createTextNode(value.slice(last, at)));
    const marker = match[1];
    const sourceMarker = /^\[\[(citation|clip):([0-9a-f-]{36})\]\]$/.exec(marker);
    if (sourceMarker?.[1] === 'citation') {
      const citation = citations.get(sourceMarker[2]);
      if (!citation) parent.append(document.createTextNode(marker));
      else {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'document-preview-citation';
        button.textContent = `【引用元: ${citation.sourceTitle} · ${citation.pageLabel || `段落${citation.paragraphIndex + 1}`} · ${citation.verification}】`;
        button.title = `原文: ${citation.quote}`;
        button.onclick = () => openDocumentCitationSource(citation);
        parent.append(button);
      }
    } else if (sourceMarker?.[1] === 'clip') {
      const clip = clips.get(sourceMarker[2]);
      if (!clip) parent.append(document.createTextNode(marker));
      else {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'document-preview-citation document-preview-unverified-clip';
        button.textContent = `【未検証クリップ: ${clip.sourceTitle}】`;
        button.title = `原文未照合: ${clip.text}\n${clip.sourceUrl}`;
        button.onclick = () => window.mySearchDesktop?.openBrowser(clip.sourceUrl);
        parent.append(button);
      }
    } else if (match[6] !== undefined || match[7] !== undefined) {
      const strong = document.createElement('strong');
      appendDocumentPreviewInline(strong, match[6] ?? match[7] ?? '', citations, clips);
      parent.append(strong);
    } else if (match[8] !== undefined || match[9] !== undefined) {
      const emphasis = document.createElement('em');
      appendDocumentPreviewInline(emphasis, match[8] ?? match[9] ?? '', citations, clips);
      parent.append(emphasis);
    } else {
      try {
        const url = new URL(match[5]);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
        const anchor = document.createElement('a');
        anchor.href = url.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
        anchor.textContent = match[4]; parent.append(anchor);
      } catch { parent.append(document.createTextNode(match[0])); }
    }
    last = at + match[0].length;
  }
  if (last < value.length) parent.append(document.createTextNode(value.slice(last)));
}

function renderDocumentPreview() {
  const preview = document.getElementById('document-preview');
  if (!preview) return;
  preview.replaceChildren();
  const markdown = document.getElementById('document-markdown').value.replace(/\r\n?/g, '\n');
  const citations = new Map((activeResearchDocument?.citations ?? []).map(citation => [citation.id, citation]));
  const clips = new Map((activeResearchDocument?.clips ?? []).map(clip => [clip.id, clip]));
  const lines = markdown.split('\n');
  const special = line => /^\s*(#{1,6}\s|[-*]\s|\d+\.\s|>\s*)/.test(line);
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendDocumentPreviewInline(element, heading[2], citations, clips); preview.append(element); i += 1; continue;
    }
    if (i + 1 < lines.length && line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const table = document.createElement('table'); table.className = 'document-preview-table';
      const head = document.createElement('thead'); const headRow = document.createElement('tr');
      for (const cell of cells(line)) { const th = document.createElement('th'); appendDocumentPreviewInline(th, cell, citations, clips); headRow.append(th); }
      head.append(headRow); table.append(head); i += 2;
      const body = document.createElement('tbody');
      while (i < lines.length && lines[i].includes('|')) {
        const row = document.createElement('tr');
        for (const cell of cells(lines[i])) { const td = document.createElement('td'); appendDocumentPreviewInline(td, cell, citations, clips); row.append(td); }
        body.append(row); i += 1;
      }
      table.append(body); preview.append(table); continue;
    }
    const listMatch = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length) {
        const item = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const li = document.createElement('li'); appendDocumentPreviewInline(li, item[2], citations, clips); list.append(li); i += 1;
      }
      preview.append(list); continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = document.createElement('blockquote');
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        const p = document.createElement('p'); appendDocumentPreviewInline(p, lines[i].replace(/^>\s?/, ''), citations, clips); quote.append(p); i += 1;
      }
      preview.append(quote); continue;
    }
    const paragraph = document.createElement('p');
    const content = [];
    while (i < lines.length && lines[i].trim() && !special(lines[i])) { content.push(lines[i]); i += 1; }
    appendDocumentPreviewInline(paragraph, content.join(' '), citations, clips); preview.append(paragraph);
  }
}

function renderResearchDocumentList(rows) {
  const host = document.getElementById('document-list');
  host.textContent = '';
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'reader-note';
    empty.textContent = '原稿はまだありません。';
    host.append(empty);
    return;
  }
  for (const row of rows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'document-list-item';
    button.classList.toggle('active', activeResearchDocument?.id === row.id);
    button.textContent = row.title;
    button.title = row.updatedAt ? `更新 ${new Date(row.updatedAt).toLocaleString()}` : row.title;
    button.onclick = () => openResearchDocument(row.id);
    host.append(button);
  }
}

async function loadResearchDocuments() {
  try {
    const query = document.getElementById('document-search')?.value.trim() ?? '';
    const result = await documentApi().get(`/api/documents${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    researchDocumentRows = result.documents ?? [];
    renderResearchDocumentList(researchDocumentRows);
  } catch (error) { setDocumentMessage(error.message || '原稿一覧を読み込めませんでした', true); }
}

function setResearchDocument(documentValue) {
  activeResearchDocument = documentValue;
  document.getElementById('document-title').value = documentValue?.title ?? '';
  document.getElementById('document-markdown').value = documentValue?.markdown ?? '';
  document.getElementById('document-sources').textContent = '';
  document.getElementById('document-source-results').textContent = '';
  document.getElementById('document-evidence-results').textContent = '';
  if (documentValue) {
    setDocumentMessage(`保存済み · v${documentValue.version}`);
    renderDocumentSources(documentValue.sources ?? []);
    renderDocumentCitations(documentValue.citations ?? [], documentValue.clips ?? []);
  } else {
    setDocumentMessage('原稿を選ぶか、新規作成してください。');
    document.getElementById('document-citations').textContent = '';
  }
  renderResearchDocumentList(researchDocumentRows);
  renderDocumentPreview();
  showResearchDraftIfAvailable(documentValue);
}

async function openResearchDocument(id) {
  try {
    const result = await documentApi().get(`/api/documents/${encodeURIComponent(id)}`);
    setResearchDocument(result.document);
  } catch (error) { setDocumentMessage(error.message || '原稿を開けませんでした', true); }
}

async function newResearchDocument() {
  const createButton = document.getElementById('document-new');
  const titleInput = document.getElementById('document-title');
  const markdownInput = document.getElementById('document-markdown');
  if (createButton?.disabled) return;
  if (createButton) createButton.disabled = true;
  if (titleInput) titleInput.disabled = true;
  if (markdownInput) markdownInput.disabled = true;
  try {
    const result = await documentApi().post('/api/documents', { title: '新しい調査原稿', markdown: '' });
    setResearchDocument(result.document);
    await loadResearchDocuments();
    titleInput?.focus();
    titleInput?.select();
  } catch (error) { setDocumentMessage(error.message || '原稿を作成できませんでした', true); }
  finally {
    if (createButton) createButton.disabled = false;
    if (titleInput) titleInput.disabled = false;
    if (markdownInput) markdownInput.disabled = false;
  }
}

async function saveResearchDocument() {
  if (!activeResearchDocument) { setDocumentMessage('先に原稿を新規作成してください。', true); return; }
  const title = document.getElementById('document-title').value.trim();
  const markdown = document.getElementById('document-markdown').value;
  try {
    const result = await documentApi().put(`/api/documents/${encodeURIComponent(activeResearchDocument.id)}`, { title, markdown, version: activeResearchDocument.version });
    clearResearchDraft(activeResearchDocument.id);
    setResearchDocument(result.document);
    await loadResearchDocuments();
  } catch (error) { setDocumentMessage(error.message || '保存に失敗しました。再読込して競合を確認してください。', true); }
}

async function deleteResearchDocument() {
  if (!activeResearchDocument || !confirm(`「${activeResearchDocument.title}」を削除しますか？`)) return;
  try {
    await documentApi().del(`/api/documents/${encodeURIComponent(activeResearchDocument.id)}`);
    setResearchDocument(null);
    await loadResearchDocuments();
  } catch (error) { setDocumentMessage(error.message || '削除できませんでした', true); }
}

async function exportResearchDocument() {
  if (!activeResearchDocument) { setDocumentMessage('出力する原稿を選んでください。', true); return; }
  try {
    const result = await documentApi().download(`/api/documents/${encodeURIComponent(activeResearchDocument.id)}/export.md`);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(result.blob);
    link.download = `document-${activeResearchDocument.id}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  } catch (error) { setDocumentMessage(error.message || 'Markdownを書き出せませんでした', true); }
}

function insertDocumentText(value) {
  const editor = document.getElementById('document-markdown');
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.setRangeText(value, start, end, 'end');
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.focus();
}

function wrapDocumentSelection(before, after) {
  const editor = document.getElementById('document-markdown');
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.slice(start, end);
  const content = selected || 'テキスト';
  editor.setRangeText(`${before}${content}${after}`, start, end, 'select');
  editor.setSelectionRange(start + before.length, start + before.length + content.length);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.focus();
}

function prefixDocumentLines(prefix) {
  const editor = document.getElementById('document-markdown');
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const lineStart = editor.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const foundLineEnd = editor.value.indexOf('\n', end);
  const lineEnd = foundLineEnd < 0 ? editor.value.length : foundLineEnd;
  const original = editor.value.slice(lineStart, lineEnd);
  const lines = original.split('\n');
  const nonempty = lines.filter(line => line.trim());
  const alreadyPrefixed = nonempty.length > 0 && nonempty.every(line => line.startsWith(prefix));
  const replacement = lines.map(line => {
    if (!line.trim()) return line;
    return alreadyPrefixed ? line.slice(prefix.length) : `${prefix}${line}`;
  }).join('\n');
  editor.setRangeText(replacement, lineStart, lineEnd, 'end');
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.focus();
}

function insertDocumentLink() {
  const editor = document.getElementById('document-markdown');
  const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim();
  const entered = prompt('リンク先URL（http:// または https://）');
  if (entered === null) return;
  try {
    const url = new URL(entered.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP(S) only');
    const label = selected || 'リンクテキスト';
    insertDocumentText(`[${label}](${url.href})`);
  } catch { setDocumentMessage('HTTPまたはHTTPSのリンク先を入力してください。', true); }
}

function searchFromDocumentSelection() {
  const editor = document.getElementById('document-markdown');
  selectedDocumentSearchText = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim();
  if (!selectedDocumentSearchText) { setDocumentMessage('原稿中の一節を選択してから検索してください。', true); return; }
  if (activeResearchDocument) {
    persistResearchDraft();
    researchSearchHandoff = {
      documentId: activeResearchDocument.id,
      version: activeResearchDocument.version,
      title: document.getElementById('document-title').value.trim(),
      markdown: editor.value,
      insertAt: editor.selectionEnd,
    };
  }
  switchView('bm25');
  if (typeof setSimpleSearchTerms === 'function') setSimpleSearchTerms(selectedDocumentSearchText);
  else document.getElementById('search-terms').value = selectedDocumentSearchText;
  setDocumentMessage('選択した一節を検索欄へ渡しました。検索条件・原稿は保持されています。');
}

function hasResearchSearchHandoff() { return Boolean(researchSearchHandoff && activeResearchDocument?.id === researchSearchHandoff.documentId); }

async function addSelectedQuoteToResearchDocument() {
  if (!hasResearchSearchHandoff()) { setDocumentMessage('原稿から検索を開始して、戻り先を用意してください。', true); return; }
  if (!readerCardId || !readerArticle) { toast('引用元をカードに保存してから原稿へ追加してください', 'warn'); return; }
  if (typeof currentReaderMemo === 'function' && currentReaderMemo() !== readerInitialMemo) {
    toast('先にReaderのメモを保存してください。原稿へ戻る操作でメモを失わないためです', 'warn');
    return;
  }
  const captured = pendingResearchCitationSelection;
  pendingResearchCitationSelection = null;
  const quote = captured?.quote ?? (typeof selectedReaderText === 'function' ? selectedReaderText() : '');
  const paragraphIndex = captured?.paragraphIndex ?? (typeof selectionParagraphIndex === 'function' ? selectionParagraphIndex() : null);
  if (!quote || !Number.isInteger(paragraphIndex)) { toast('原稿へ追加する引用文を本文上で選択してください', 'warn'); return; }
  if (!activeResearchDocument || activeResearchDocument.version !== researchSearchHandoff.version
      || document.getElementById('document-title').value.trim() !== researchSearchHandoff.title
      || document.getElementById('document-markdown').value !== researchSearchHandoff.markdown) {
    toast('検索へ移動した後に原稿が変わっています。原稿を保存してから、もう一度検索してください', 'warn');
    return;
  }
  const handoff = researchSearchHandoff;
  try {
    const result = await documentApi().post(`/api/documents/${encodeURIComponent(handoff.documentId)}/citations`, {
      sourceCardId: readerCardId, paragraphIndex, quote, title: handoff.title,
      markdown: handoff.markdown, version: handoff.version, insertAt: handoff.insertAt,
    });
    clearResearchDraft(handoff.documentId);
    researchSearchHandoff = null;
    setResearchDocument(result.document);
    await loadResearchDocuments();
    switchView('writing');
    const editor = document.getElementById('document-markdown');
    const caret = handoff.insertAt + `[[citation:${result.citationId}]]`.length;
    editor.focus();
    editor.setSelectionRange(caret, caret);
    closeModal('modal-reader');
    setDocumentMessage('検索から戻り、原文と照合した引用を元の原稿位置へ追加しました。原稿の変更は「保存」で確定してください。');
  } catch (error) { toast(error.message || '引用を原稿へ追加できませんでした', 'warn'); }
}

async function searchResearchSources() {
  const host = document.getElementById('document-source-results');
  const query = document.getElementById('document-source-search').value.trim();
  host.textContent = '';
  if (!query) { host.textContent = '検索語を入力してください。'; return; }
  try {
    const result = await documentApi().get(`/api/cards?q=${encodeURIComponent(query)}&limit=25&sort=created_at_desc`);
    const rows = result.items ?? result.cards ?? [];
    if (!rows.length) { host.textContent = '保存資料が見つかりません。先に「探す」から記事を保存してください。'; return; }
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'document-source-row';
      const name = document.createElement('span'); name.textContent = row.title;
      const add = document.createElement('button'); add.type = 'button'; add.className = 'btn btn-secondary btn-sm'; add.textContent = '資料に追加';
      add.onclick = () => addResearchSource(row.id);
      line.append(name, add); host.append(line);
    }
  } catch (error) { host.textContent = error.message || '資料検索に失敗しました。'; }
}

async function addResearchSource(sourceCardId) {
  if (!activeResearchDocument) { setDocumentMessage('先に原稿を新規作成してください。', true); return; }
  try {
    const result = await documentApi().post(`/api/documents/${encodeURIComponent(activeResearchDocument.id)}/sources`, { sourceCardId });
    activeResearchDocument = result.document;
    renderDocumentSources(activeResearchDocument.sources);
    renderDocumentCitations(activeResearchDocument.citations, activeResearchDocument.clips);
    setDocumentMessage('資料を原稿に関連付けました。');
  } catch (error) { setDocumentMessage(error.message || '資料を追加できませんでした', true); }
}

function renderDocumentSources(sources = []) {
  const host = document.getElementById('document-sources');
  host.textContent = '';
  if (!sources.length) { host.textContent = '保存資料を検索して追加してください。'; return; }
  for (const source of sources) {
    const row = document.createElement('div'); row.className = 'document-source-row';
    const title = document.createElement('span'); title.textContent = source.title + (source.missing ? '（元資料削除済み）' : '');
    row.append(title);
    if (source.sourceCardId) {
      const open = document.createElement('button'); open.className = 'btn btn-secondary btn-sm'; open.textContent = 'Reader';
      open.onclick = () => openReaderForCard(source.sourceCardId);
      row.append(open);
      const backlinks = document.createElement('button'); backlinks.className = 'btn btn-secondary btn-sm'; backlinks.textContent = '使用原稿';
      backlinks.onclick = async () => {
        try {
          const result = await documentApi().get(`/api/reader/cards/${encodeURIComponent(source.sourceCardId)}/documents`);
          const uses = result.documents ?? [];
          if (!uses.length) { setDocumentMessage('この資料を使っている原稿はありません。'); return; }
          const host = document.createElement('div'); host.className = 'document-backlinks';
          for (const use of uses) {
            const target = document.createElement('button'); target.type = 'button'; target.className = 'btn btn-secondary btn-sm';
            target.textContent = `${use.title}${use.paragraph_index == null ? '' : ` · 段落${Number(use.paragraph_index) + 1}`}`;
            target.onclick = async () => {
              await openResearchDocument(use.id);
              if (!activeResearchDocument || activeResearchDocument.id !== use.id || !use.citation_id) return;
              const editor = document.getElementById('document-markdown');
              const marker = `[[citation:${use.citation_id}]]`;
              const at = editor.value.indexOf(marker);
              if (at >= 0) { editor.focus(); editor.setSelectionRange(at, at + marker.length); }
              setDocumentMessage(`原稿「${use.title}」の出典位置を開きました。引用本文は原資料と照合して確認してください。`);
            };
            host.append(target);
          }
          row.append(host);
          setDocumentMessage(`${uses.length}件の原稿使用位置を表示しています。`);
        } catch (error) { setDocumentMessage(error.message || '原稿への逆引きに失敗しました。', true); }
      };
      row.append(backlinks);
      const unlink = document.createElement('button'); unlink.className = 'btn btn-secondary btn-sm'; unlink.textContent = '解除';
      unlink.onclick = async () => {
        try { const result = await documentApi().del(`/api/documents/${encodeURIComponent(activeResearchDocument.id)}/sources/${encodeURIComponent(source.sourceCardId)}`); activeResearchDocument = result.document; renderDocumentSources(result.document.sources); }
        catch (error) { setDocumentMessage(error.message || '資料リンクを解除できませんでした', true); }
      };
      row.append(unlink);
    }
    host.append(row);
  }
}

async function compareResearchSources() {
  if (!activeResearchDocument) { setDocumentMessage('先に原稿を選んでください。', true); return; }
  const cardIds = (activeResearchDocument.sources ?? []).map(source => source.sourceCardId).filter(Boolean);
  const purpose = document.getElementById('document-compare-purpose').value.trim();
  if (cardIds.length < 3) { setDocumentMessage('比較には保存資料を3件以上追加してください。', true); return; }
  if (cardIds.length > 10) { setDocumentMessage('比較対象は10件以内にしてください。', true); return; }
  if (purpose.length < 2) { setDocumentMessage('比較したい論点を入力してください。', true); return; }
  const host = document.getElementById('document-evidence-results');
  host.textContent = '保存本文から一致箇所を抽出しています…';
  try {
    const result = await documentApi().post('/api/reader/passages', { purpose, cardIds });
    researchEvidenceRows = result.rows ?? [];
    host.textContent = '';
    if (!researchEvidenceRows.length) { host.textContent = '一致箇所を確認できませんでした。各資料をReaderで確認してください。'; return; }
    const method = document.createElement('p'); method.className = 'reader-note'; method.textContent = `ルール抽出 · ${researchEvidenceRows.length}件。意味上の比較は未評価です。`; host.append(method);
    for (const row of researchEvidenceRows) {
      const article = document.createElement('article'); article.className = 'document-evidence-row';
      const source = document.createElement('strong'); source.textContent = `${row.sourceTitle} · ${row.location || `段落${Number(row.paragraphIndex) + 1}`}`;
      const quote = document.createElement('blockquote'); quote.textContent = row.quote;
      const claim = document.createElement('p'); claim.textContent = row.claim;
      const insert = document.createElement('button'); insert.type = 'button'; insert.className = 'btn btn-secondary btn-sm'; insert.textContent = '原稿カーソルに引用を挿入';
      insert.onclick = () => insertVerifiedDocumentCitation(row.sourceId, row.paragraphIndex, row.quote);
      const reader = document.createElement('button'); reader.type = 'button'; reader.className = 'btn btn-secondary btn-sm'; reader.textContent = 'Readerで原文確認';
      reader.onclick = () => openReaderForCard(row.sourceId);
      article.append(source, quote, claim, insert, reader); host.append(article);
    }
  } catch (error) { host.textContent = error.message || '資料比較の根拠抽出に失敗しました。'; }
}

function cancelResearchAI() {
  researchAIRequestId += 1;
  researchAIController?.abort();
  researchAIController = null;
  document.getElementById('document-ai-cancel').disabled = true;
  setDocumentMessage('端末内AIの処理を中止しました。');
}

function researchAIResultText(result) {
  if (result?.status === 'ok') return { text: result.output?.markdown || result.output?.review || result.output?.rewrite || '', processor: result.processor };
  if (result?.status === 'unavailable') throw new Error('このブラウザーでは端末内AIを利用できません。AIなしの出力は作成していません。');
  if (result?.status === 'cancelled') throw new Error('端末内AIの処理は中止されました。');
  throw new Error(result?.failureReason || '端末内AIの提案に失敗しました。');
}

function verifiedResearchCitations() {
  return (activeResearchDocument?.citations ?? []).filter(row => row.verification === 'verified' && row.id && row.quote);
}

async function runResearchAI(kind) {
  if (!activeResearchDocument) { setDocumentMessage('先に原稿を新規作成してください。', true); return; }
  const doc = activeResearchDocument;
  const editor = document.getElementById('document-markdown');
  const baseMarkdown = editor.value;
  const title = document.getElementById('document-title').value.trim();
  const purpose = document.getElementById('document-compare-purpose').value.trim();
  const selectionStart = editor.selectionStart;
  const selectionEnd = editor.selectionEnd;
  const selection = baseMarkdown.slice(selectionStart, selectionEnd).trim();
  const citations = verifiedResearchCitations();
  const host = document.getElementById('document-ai-outline');
  const actions = document.getElementById('document-ai-result-actions');
  if (kind === 'rewrite' || kind === 'review') {
    if (!selection) { setDocumentMessage('原稿中の文章を選択してから実行してください。', true); return; }
  }
  if (!citations.length && kind !== 'rewrite') { setDocumentMessage('本文と一致する確認済み引用を先に追加してください。', true); return; }
  if (typeof contextualAi === 'undefined') { setDocumentMessage('執筆用AI機能を読み込めませんでした。', true); return; }
  researchAIController?.abort();
  const controller = new AbortController();
  researchAIController = controller;
  const requestId = ++researchAIRequestId;
  pendingResearchAIProposal = null;
  actions.hidden = true;
  host.textContent = 'Chrome端末内AIを準備しています。初回はモデルの準備に時間がかかります…';
  document.getElementById('document-ai-cancel').disabled = false;
  try {
    let result;
    let citationMap = citations;
    if (kind === 'outline') {
      result = await contextualAi.proposeOutline(title, purpose, citations.map(row => ({ id: row.id, sourceTitle: row.sourceTitle, quote: row.quote, verification: row.verification })), controller.signal);
    } else if (kind === 'compare') {
      const grouped = new Map();
      for (const citation of citations) {
        const key = citation.sourceCardId || `missing:${citation.sourceTitle}`;
        if (!grouped.has(key)) grouped.set(key, { id: key, title: citation.sourceTitle || '出典名なし', citations: [] });
        grouped.get(key).citations.push({ citationId: citation.id, quote: citation.quote, verification: citation.verification });
      }
      const sources = [...grouped.values()];
      if (sources.length < 3) throw new Error('AI資料比較には、3件以上の別資料から確認済み引用を追加してください。');
      result = await contextualAi.compareSources(purpose, sources, controller.signal);
      citationMap = sources.flatMap(source => source.citations.map(row => citations.find(citation => citation.id === row.citationId))).filter(Boolean);
    } else if (kind === 'review') {
      result = await contextualAi.reviewClaim(selection, citations.map(row => ({ citationId: row.id, sourceTitle: row.sourceTitle, quote: row.quote, verification: row.verification })), controller.signal);
    } else {
      result = await contextualAi.rewriteSelection(selection, purpose, citations.map(row => ({ sourceTitle: row.sourceTitle, quote: row.quote, verification: row.verification })), controller.signal);
    }
    if (requestId !== researchAIRequestId || controller.signal.aborted) return;
    if (activeResearchDocument?.id !== doc.id || activeResearchDocument.version !== doc.version
        || document.getElementById('document-title').value.trim() !== title
        || document.getElementById('document-compare-purpose').value.trim() !== purpose || editor.value !== baseMarkdown) {
      throw new Error('原稿が処理中に変更されました。提案を破棄してください。');
    }
    if (citations.length) {
      const latest = await documentApi().get(`/api/documents/${encodeURIComponent(doc.id)}`);
      if (requestId !== researchAIRequestId || controller.signal.aborted) return;
      const liveById = new Map((latest.document?.citations ?? []).map(row => [row.id, row]));
      if (activeResearchDocument?.id !== doc.id || editor.value !== baseMarkdown
          || citations.some(row => liveById.get(row.id)?.verification !== 'verified' || liveById.get(row.id)?.sourceHash !== row.sourceHash)) {
        throw new Error('引用元または原稿が処理中に変更されました。最新状態を確認して再実行してください。');
      }
    }
    const generated = researchAIResultText(result);
    if (!generated.text.trim()) throw new Error('モデルから提案が返りませんでした。');
    const insertable = kind === 'outline' || kind === 'compare' || kind === 'rewrite';
    pendingResearchAIProposal = insertable ? {
      kind, text: generated.text, citations: citationMap, documentId: doc.id,
      baseVersion: doc.version, baseMarkdown, selectionStart, selectionEnd,
      selection, appliedValue: null,
    } : null;
    host.textContent = `[${generated.processor} / Chrome端末内AI・未検証の生成案]\n\n${generated.text}`;
    actions.hidden = !insertable;
    document.getElementById('document-ai-apply').textContent = kind === 'rewrite' ? '選択範囲に適用' : '提案を原稿カーソルに挿入';
    document.getElementById('document-ai-revert').hidden = true;
    setDocumentMessage('AI提案を表示しました。内容を確認するまで原稿は変更されません。');
  } catch (error) {
    if (requestId === researchAIRequestId) {
      host.textContent = error.message || '端末内AIの提案を生成できませんでした。';
      actions.hidden = true;
      setDocumentMessage(host.textContent, true);
    }
  } finally {
    if (requestId === researchAIRequestId) {
      researchAIController = null;
      document.getElementById('document-ai-cancel').disabled = true;
    }
  }
}

function applyResearchAIProposal() {
  const proposal = pendingResearchAIProposal;
  const editor = document.getElementById('document-markdown');
  if (!proposal || proposal.appliedValue || activeResearchDocument?.id !== proposal.documentId
      || activeResearchDocument.version !== proposal.baseVersion || editor.value !== proposal.baseMarkdown) {
    setDocumentMessage('提案の対象原稿が変更されています。新しい状態で再生成してください。', true); return;
  }
  let replacement = proposal.text;
  if (proposal.kind === 'outline' || proposal.kind === 'compare') {
    replacement = replacement.replace(/\[S(\d+)\]/g, (_marker, numberText) => {
      const citation = proposal.citations[Number(numberText) - 1];
      return citation ? `[[citation:${citation.id}]]` : '[出典要確認]';
    });
  }
  const start = proposal.selectionStart;
  const end = proposal.selectionEnd;
  const insertion = proposal.kind === 'rewrite' ? replacement : `${start === 0 || editor.value.slice(0, start).endsWith('\n') ? '' : '\n\n'}${replacement}`;
  editor.setRangeText(insertion, start, end, 'end');
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  proposal.appliedValue = editor.value;
  document.getElementById('document-ai-revert').hidden = false;
  setDocumentMessage('提案を未保存原稿へ適用しました。保存前なら「適用を戻す」または Ctrl+Z で戻せます。');
}

function revertResearchAIProposal() {
  const proposal = pendingResearchAIProposal;
  const editor = document.getElementById('document-markdown');
  if (!proposal?.appliedValue || editor.value !== proposal.appliedValue || activeResearchDocument?.id !== proposal.documentId) {
    setDocumentMessage('適用後に原稿が編集されています。上書きせず、Ctrl+Zで直前の編集を戻してください。', true); return;
  }
  editor.value = proposal.baseMarkdown;
  editor.setSelectionRange(proposal.selectionStart, proposal.selectionEnd);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  proposal.appliedValue = null;
  document.getElementById('document-ai-revert').hidden = true;
  setDocumentMessage('AI提案の適用を戻しました。');
}

async function insertVerifiedDocumentCitation(sourceCardId, paragraphIndex, quote) {
  if (!activeResearchDocument) return;
  const editor = document.getElementById('document-markdown');
  const insertAt = editor.selectionStart;
  try {
    const result = await documentApi().post(`/api/documents/${encodeURIComponent(activeResearchDocument.id)}/citations`, {
      sourceCardId, paragraphIndex, quote, title: document.getElementById('document-title').value.trim(),
      markdown: editor.value, version: activeResearchDocument.version, insertAt,
    });
    clearResearchDraft(activeResearchDocument.id);
    setResearchDocument(result.document);
    editor.focus();
    editor.setSelectionRange(insertAt + `[[citation:${result.citationId}]]`.length, insertAt + `[[citation:${result.citationId}]]`.length);
    await loadResearchDocuments();
    setDocumentMessage('保存本文と一致する引用を原稿に挿入しました。引用の正確さと主張への適合は別に確認してください。');
  } catch (error) { setDocumentMessage(error.message || '引用を挿入できませんでした', true); }
}

async function openDocumentCitationSource(citation) {
  if (!citation.sourceCardId) { setDocumentMessage('引用元カードが削除されています。保存済み引用スナップショットは残っています。', true); return; }
  const opened = await openReaderForCard(citation.sourceCardId);
  if (!opened) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const target = document.querySelector(`#reader-article [data-index="${Number(citation.paragraphIndex)}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.add('document-citation-focus');
      setTimeout(() => target.classList.remove('document-citation-focus'), 1800);
      if (typeof showOriginalPdfAtParagraph === 'function') showOriginalPdfAtParagraph(Number(citation.paragraphIndex));
    } else setDocumentMessage('保存本文の段落位置を表示できません。引用と出典情報は保持されています。', true);
  }));
}

function renderDocumentCitations(citations = [], clips = []) {
  const host = document.getElementById('document-citations');
  host.textContent = '';
  if (!citations.length && !clips.length) return;
  const title = document.createElement('h4'); title.textContent = '引用の状態'; host.append(title);
  for (const citation of citations) {
    const line = document.createElement('p');
    line.textContent = `${citation.sourceTitle} · ${citation.pageLabel || `段落${citation.paragraphIndex + 1}`} · ${citation.verification} · ${citation.quote} `;
    line.className = citation.verification === 'verified' ? 'citation-verified' : 'citation-unverified';
    if (citation.sourceCardId) {
      const open = document.createElement('button'); open.type = 'button'; open.className = 'btn btn-secondary btn-sm'; open.textContent = 'Readerで引用元へ';
      open.onclick = () => openDocumentCitationSource(citation);
      line.append(open);
    }
    host.append(line);
  }
  for (const clip of clips) {
    const line = document.createElement('p');
    line.className = 'citation-unverified';
    line.textContent = `未検証クリップ · ${clip.sourceTitle} · ${clip.text} `;
    const open = document.createElement('button'); open.type = 'button'; open.className = 'btn btn-secondary btn-sm'; open.textContent = '元ページを開く';
    open.onclick = () => window.mySearchDesktop?.openBrowser(clip.sourceUrl);
    line.append(open); host.append(line);
  }
}

function renderPendingBrowserClip() {
  const host = document.getElementById('document-browser-clip');
  if (!host) return;
  host.hidden = !pendingBrowserClip;
  if (!pendingBrowserClip) return;
  document.getElementById('document-browser-clip-text').textContent = pendingBrowserClip.text;
  document.getElementById('document-browser-clip-status').textContent = `${pendingBrowserClip.title} · ${pendingBrowserClip.url} · 未検証。保存済み原文との照合はしていません。`;
}

async function addBrowserClipToDocument() {
  if (!activeResearchDocument || !pendingBrowserClip) { setDocumentMessage('原稿を開き、内蔵ブラウザーからクリップを受け取ってください。', true); return; }
  const editor = document.getElementById('document-markdown');
  try {
    const result = await documentApi().post(`/api/documents/${encodeURIComponent(activeResearchDocument.id)}/clips`, {
      clipText: pendingBrowserClip.text, sourceTitle: pendingBrowserClip.title || pendingBrowserClip.url,
      sourceUrl: pendingBrowserClip.url, markdown: editor.value,
      version: activeResearchDocument.version, insertAt: editor.selectionStart,
    });
    clearResearchDraft(activeResearchDocument.id);
    setResearchDocument(result.document);
    pendingBrowserClip = null;
    renderPendingBrowserClip();
    await loadResearchDocuments();
    setDocumentMessage('未検証クリップを出典URL付きで保存しました。原文と一致する引用ではありません。');
  } catch (error) { setDocumentMessage(error.message || 'クリップを保存できませんでした', true); }
}

function discardBrowserClip() {
  pendingBrowserClip = null;
  renderPendingBrowserClip();
  setDocumentMessage('受け取った未検証クリップを破棄しました。');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('desktop-browser-open').hidden = !window.mySearchDesktop;
  const editor = document.getElementById('document-markdown');
  const captureResearchCitationSelection = () => {
    pendingResearchCitationSelection = null;
    const selection = window.getSelection?.();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const selectedNode = range?.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range?.startContainer.parentElement;
    const paragraph = selectedNode?.closest?.('#reader-article [data-index]');
    const paragraphIndex = paragraph ? Number(paragraph.getAttribute('data-index')) : null;
    if (selection && !selection.isCollapsed && selection.toString().trim() && Number.isInteger(paragraphIndex)) {
      pendingResearchCitationSelection = { quote: selectedReaderText(), paragraphIndex };
    }
  };
  const citationButton = document.getElementById('reader-research-citation-add');
  citationButton?.addEventListener('pointerdown', captureResearchCitationSelection);
  citationButton?.addEventListener('mousedown', captureResearchCitationSelection);
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    const selectedNode = range?.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range?.startContainer.parentElement;
    const paragraph = selectedNode?.closest?.('#reader-article [data-index]');
    const paragraphIndex = paragraph ? Number(paragraph.getAttribute('data-index')) : null;
    if (Number.isInteger(paragraphIndex)) {
      pendingResearchCitationSelection = { quote: selectedReaderText(), paragraphIndex };
    }
  });
  editor?.addEventListener('input', () => { renderDocumentPreview(); persistResearchDraft(); setDocumentMessage('未保存の変更があります。下書きはこのブラウザー内に保存しています。', true); });
  document.getElementById('document-title')?.addEventListener('input', () => { persistResearchDraft(); setDocumentMessage('未保存の変更があります。下書きはこのブラウザー内に保存しています。', true); });
  document.getElementById('document-source-search')?.addEventListener('keydown', event => { if (event.key === 'Enter') searchResearchSources(); });
  window.mySearchDesktop?.onBrowserClip(clip => {
    if (!clip || typeof clip.text !== 'string' || typeof clip.url !== 'string' || !clip.text.trim()) return;
    let url;
    try { url = new URL(clip.url); } catch { return; }
    if (url.protocol !== 'https:') return;
    pendingBrowserClip = { text: clip.text.slice(0, 5000), title: String(clip.title || '').slice(0, 200), url: url.href };
    renderPendingBrowserClip();
    setDocumentMessage('内蔵ブラウザーから未検証の選択文を受け取りました。原文を確認してから保存してください。');
  });
  renderPendingBrowserClip();
});
