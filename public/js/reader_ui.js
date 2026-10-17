// Reader: read an article on the left and write a memo on the right.
// The article text comes from POST /api/reader/extract (no AI) and is shown
// with textContent only, so markup from external pages is never executed.
let readerArticle = null;
let readerCandidateId = null;
let readerCardId = null; // set when an existing card is opened for editing
const READER_IMAGE_LINE = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/;

function openReader(url = '', candidateId = null) {
  readerArticle = null;
  readerCandidateId = candidateId;
  readerCardId = null;
  setReaderSaveLabel();
  document.getElementById('reader-url').value = url;
  document.getElementById('reader-memo').value = '';
  document.getElementById('reader-tags').value = '';
  if (typeof setMemoMode === 'function') setMemoMode('text');
  renderReaderArticle();
  openModal('modal-reader');
  if (url) loadReaderArticle();
  else document.getElementById('reader-url').focus();
}

// Open an existing card: left = the saved copy (refetched only if none was saved), right = its memo.
async function openReaderForCard(id) {
  try {
    const data = await api.get(`/api/reader/cards/${encodeURIComponent(id)}`);
    readerCandidateId = null;
    readerCardId = id;
    setReaderSaveLabel();
    document.getElementById('reader-url').value = data.url || '';
    document.getElementById('reader-memo').value = data.memo || '';
    document.getElementById('reader-tags').value = (data.tags || []).join(' ');
    if (typeof setMemoMode === 'function') setMemoMode('text');
    readerArticle = data.paragraphs.length
      ? { url: data.url, title: data.title, byline: data.byline, siteName: data.siteName, fetchedAt: data.fetchedAt || new Date().toISOString(), paragraphs: data.paragraphs }
      : null;
    renderReaderArticle();
    openModal('modal-reader');
    if (!readerArticle && data.url) await loadReaderArticle();
  } catch (error) {
    showApiError(error, 'カードを開けませんでした');
  }
}

function setReaderSaveLabel() {
  const button = document.getElementById('reader-save-btn');
  if (button) button.textContent = readerCardId ? 'カードを更新' : 'メモと本文を保存';
}

async function loadReaderArticle() {
  const url = document.getElementById('reader-url').value.trim();
  if (!url) { toast('URLを入力してください', 'warn'); return; }
  const pane = document.getElementById('reader-article');
  pane.textContent = '本文を取得中...';
  try {
    readerArticle = await api.post('/api/reader/extract', { url });
    renderReaderArticle();
    document.getElementById('reader-memo').focus();
  } catch (error) {
    readerArticle = null;
    pane.textContent = '';
    const message = document.createElement('p');
    message.className = 'reader-error';
    message.textContent = `本文を取得できませんでした: ${formatApiError(error)}`;
    pane.appendChild(message);
  }
}

function renderReaderArticle() {
  const pane = document.getElementById('reader-article');
  const meta = document.getElementById('reader-meta');
  pane.textContent = '';
  meta.textContent = '';
  if (!readerArticle) {
    pane.textContent = 'URLを入れて「読む」を押すと、ここに本文が出ます。';
    return;
  }
  const title = document.createElement('h3');
  title.textContent = readerArticle.title;
  pane.appendChild(title);
  for (const text of readerArticle.paragraphs) {
    const image = READER_IMAGE_LINE.exec(text);
    if (image) {
      // Linked from the original page; only the link is stored in the card.
      const img = document.createElement('img');
      img.src = image[2];
      img.alt = image[1];
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.className = 'reader-image';
      pane.appendChild(img);
      continue;
    }
    const p = document.createElement('p');
    p.textContent = text;
    pane.appendChild(p);
  }
  meta.textContent = [readerArticle.siteName, readerArticle.byline, `取得: ${new Date(readerArticle.fetchedAt).toLocaleString('ja-JP')}`].filter(Boolean).join(' · ');
}

// Quote the selected article text into the memo as a Markdown quote.
function quoteReaderSelection() {
  const selected = String(window.getSelection?.() || '').trim();
  if (!selected) { toast('引用したい文を左で選択してください', 'warn'); return; }
  const memo = document.getElementById('reader-memo');
  const quote = selected.split(/\n+/).map(line => `> ${line}`).join('\n');
  memo.value = `${memo.value ? `${memo.value.trimEnd()}\n\n` : ''}${quote}\n\n`;
  memo.focus();
}

async function saveReaderCard() {
  if (typeof syncMemoTable === 'function') syncMemoTable();
  if (!readerArticle && !readerCardId) { toast('先に本文を読み込んでください', 'warn'); return; }
  const tags = document.getElementById('reader-tags').value.split(/\s+/).map(tag => tag.trim()).filter(Boolean);
  if (readerCardId) {
    const article = readerArticle || { url: document.getElementById('reader-url').value.trim() || null, title: '', byline: null, siteName: null, fetchedAt: null, paragraphs: [] };
    const current = allCards?.find?.(card => card.id === readerCardId);
    try {
      await api.put(`/api/reader/cards/${encodeURIComponent(readerCardId)}`, {
        title: (article.title || current?.title || 'Untitled').slice(0, 200),
        url: article.url || null,
        byline: article.byline,
        siteName: article.siteName,
        fetchedAt: article.fetchedAt,
        paragraphs: article.paragraphs,
        memo: document.getElementById('reader-memo').value,
        tags,
      });
      toast('カードを更新しました');
      closeModal('modal-reader');
      if (typeof loadCards === 'function') await loadCards();
      if (typeof selectCard === 'function') selectCard(readerCardId);
    } catch (error) {
      showApiError(error, '更新に失敗しました');
    }
    return;
  }
  const payload = {
    url: readerArticle.url,
    title: readerArticle.title.slice(0, 200),
    byline: readerArticle.byline,
    siteName: readerArticle.siteName,
    fetchedAt: readerArticle.fetchedAt,
    paragraphs: readerArticle.paragraphs,
    memo: document.getElementById('reader-memo').value,
    tags,
  };
  if (readerCandidateId) payload.candidateId = readerCandidateId;
  try {
    await api.post('/api/reader/save', payload);
    toast('メモと本文をカードに保存しました');
    closeModal('modal-reader');
    if (typeof loadCandidates === 'function') await loadCandidates();
    if (typeof loadCards === 'function') await loadCards();
  } catch (error) {
    showApiError(error, '保存に失敗しました');
  }
}

// Drag the divider to change how much width the article and the memo get.
(function setupReaderDivider() {
  const apply = percent => document.querySelector('.reader-split')?.style.setProperty('--reader-left', `${percent}%`);
  let saved = 60;
  try { saved = Number(localStorage.getItem('readerSplit')) || 60; } catch { /* storage unavailable */ }
  document.addEventListener('DOMContentLoaded', () => {
    apply(saved);
    const divider = document.getElementById('reader-divider');
    if (!divider) return;
    divider.addEventListener('pointerdown', event => {
      const split = divider.parentElement;
      divider.setPointerCapture(event.pointerId);
      const move = e => {
        const rect = split.getBoundingClientRect();
        saved = Math.min(85, Math.max(15, ((e.clientX - rect.left) / rect.width) * 100));
        apply(saved);
      };
      const up = () => {
        divider.removeEventListener('pointermove', move);
        try { localStorage.setItem('readerSplit', String(Math.round(saved))); } catch { /* ignore */ }
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', up, { once: true });
    });
    divider.addEventListener('dblclick', () => { saved = 60; apply(saved); try { localStorage.removeItem('readerSplit'); } catch { /* ignore */ } });
  });
})();
