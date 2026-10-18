// Japanese translation of an English article, made by Chrome's on-device Translator
// (nothing is sent anywhere). The translation is kept paragraph by paragraph next to
// the original and saved with it in the card. Papers (PDF) are not translated here.
//
// Quoting: the original stays the source. A quote taken from the translation is
// marked as the quoter's translation (引用者訳), see markIfTranslated in reader_ui.js.
let readerTranslation = null; // { from, to:'ja', engine, translatedAt, paragraphs: (string|null)[] }
let readerTextView = 'original'; // 'original' | 'translation' | 'both'
let readerTranslating = null; // AbortController while translating

function resetReaderTranslation(saved = null) {
  if (readerTranslating) readerTranslating.abort();
  readerTranslating = null;
  readerTranslation = saved && Array.isArray(saved.paragraphs) ? saved : null;
  readerTextView = readerTranslation ? 'both' : 'original';
}

/** Save payload: the translation only when it was made for this exact text. */
function readerTranslationPayload(paragraphs) {
  if (!readerTranslation || readerTranslation.paragraphs.length !== paragraphs.length) return {};
  return { translation: readerTranslation };
}

function renderReaderParagraph(pane, text, index) {
  const translated = readerTranslation?.paragraphs[index];
  const showOriginal = readerTextView !== 'translation' || !translated;
  const showTranslation = readerTextView !== 'original' && translated;
  if (showOriginal) {
    const p = document.createElement('p');
    p.textContent = text;
    p.dataset.index = index;
    if (showTranslation) p.className = 'reader-original';
    pane.appendChild(p);
  }
  if (showTranslation) {
    const p = document.createElement('p');
    p.className = 'reader-translation';
    p.textContent = translated;
    p.lang = 'ja';
    // Same paragraph number as the original: a quote from the translation still points to ¶n.
    p.dataset.index = index;
    pane.appendChild(p);
  }
}

function translationBarButton(label, title, onClick, active = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `type-btn${active ? ' active' : ''}`;
  button.textContent = label;
  button.title = title;
  button.onclick = onClick;
  return button;
}

async function renderTranslationBar(meta) {
  if (!readerArticle || typeof localAi === 'undefined') return;
  const english = localAi.looksEnglish(readerArticle.paragraphs);
  if (!english && !readerTranslation) return;
  const bar = document.createElement('div');
  bar.className = 'reader-translation-bar';
  meta.appendChild(bar);
  if (readerTranslation) {
    const label = document.createElement('span');
    label.textContent = '表示:';
    bar.appendChild(label);
    [['original', '原文', '原文だけ'], ['translation', '訳', '日本語訳だけ（訳の無い段落は原文）'], ['both', '対訳', '段落ごとに原文と訳を並べる']].forEach(([view, text, title]) => {
      bar.appendChild(translationBarButton(text, title, () => { readerTextView = view; renderReaderArticle(); }, readerTextView === view));
    });
    const note = document.createElement('span');
    note.className = 'reader-note';
    note.textContent = '機械翻訳（Chrome内蔵）。保存すると原文と一緒にカードに残ります。引用は原文から。訳から引用すると「引用者訳」と付きます。';
    bar.appendChild(note);
    return;
  }
  const state = await localAi.availability('translator');
  if (state === 'unavailable') {
    const note = document.createElement('span');
    note.className = 'reader-note';
    note.textContent = '英語の記事です（このブラウザでは内蔵の翻訳が使えないため、日本語訳は作れません）。';
    bar.appendChild(note);
    return;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-secondary btn-sm';
  button.textContent = state === 'available' ? '日本語訳を作る' : '日本語訳を作る（初回は翻訳モデルをダウンロード）';
  button.title = 'Chrome内蔵の翻訳で段落ごとに訳します。端末の中で動き、外部に送りません。';
  button.onclick = () => translateReaderArticle(button);
  bar.appendChild(button);
}

async function translateReaderArticle(button) {
  if (!readerArticle || readerTranslating) return;
  const article = readerArticle;
  const controller = new AbortController();
  readerTranslating = controller;
  button.disabled = true;
  try {
    let from = 'en';
    if (await localAi.isReady('detector')) {
      const detected = await localAi.detectLanguage(article.paragraphs.join(' ')).catch(() => null);
      if (detected?.language && detected.language !== 'ja' && detected.confidence > 0.6) from = detected.language;
    }
    const paragraphs = await localAi.translateParagraphs(article.paragraphs, {
      from,
      signal: controller.signal,
      onDownload: loaded => { button.textContent = `翻訳モデルをダウンロード中… ${Math.round(loaded * 100)}%`; },
      onProgress: (done, total) => { button.textContent = `翻訳中… ${done}/${total}`; },
    });
    if (readerArticle !== article || controller.signal.aborted) return;
    readerTranslation = { from, to: 'ja', engine: 'chrome-translator', translatedAt: new Date().toISOString(), paragraphs };
    readerTextView = 'both';
    renderReaderArticle();
    toast('日本語訳を作りました。保存すると原文と一緒に残ります', 'success');
  } catch (error) {
    if (controller.signal.aborted) return;
    button.disabled = false;
    button.textContent = '日本語訳を作る（再試行）';
    toast(`翻訳できませんでした: ${error?.message || error}`, 'warn');
  } finally {
    if (readerTranslating === controller) readerTranslating = null;
  }
}
