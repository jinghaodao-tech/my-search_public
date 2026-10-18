// Web search on the spot (part of the 探す screen): the search text → queries (its own words,
// plus the on-device AI's other wordings when ready) → Qiita / Hatena Bookmark / GitHub / arXiv
// → ranked by BM25 × trust on the server → read with a memo, find evidence, save, or pass.
let discoverQueries = [];
let discoverQuerySource = null; // 'local-ai' | 'words'
let discoverQueriesText = '';
let discoverQueriesEdited = false;
let discoverLastResult = null;
const DISCOVER_VIA_LABEL = { qiita: 'Qiita', hatena: 'はてブ', github: 'GitHub', arxiv: 'arXiv', feed: 'フィード' };

function discoverEl(id) { return document.getElementById(id); }

const LOCAL_AI_TEXT = {
  prompt: { name: '端末のAI（Chrome内蔵）', use: '検索語づくりと根拠えらびに使います' },
  translator: { name: 'Chrome内蔵の翻訳（英→日）', use: '英語の記事の日本語訳に使います' },
};

async function renderLocalAiControl(host, kind, onReady) {
  if (!host || typeof localAi === 'undefined') return;
  const text = LOCAL_AI_TEXT[kind];
  const state = await localAi.availability(kind);
  host.textContent = '';
  host.dataset.state = state;
  const line = document.createElement('span');
  if (state === 'available') {
    line.textContent = `${text.name}: 使えます（${text.use}。端末の中で動き、外部に送りません）`;
    host.appendChild(line);
    return;
  }
  if (state === 'unavailable') {
    line.textContent = `${text.name}: このブラウザでは使えません。AIなしで動きます（目的の語で検索・語の一致で根拠えらび）。`;
    host.appendChild(line);
    return;
  }
  line.textContent = `${text.name}: ${state === 'downloading' ? 'ダウンロード中' : '未ダウンロード'}。${text.use}。`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-secondary btn-sm';
  button.textContent = kind === 'prompt' ? 'AIモデルをダウンロード' : '翻訳モデルをダウンロード';
  button.title = 'Chromeがモデルを端末に保存します（初回のみ。数GBになることがあります）。以後はオフラインでも動きます。';
  button.onclick = async () => {
    button.disabled = true;
    try {
      await localAi.prepare(kind, loaded => { button.textContent = `ダウンロード中… ${Math.round(loaded * 100)}%`; });
      toast(`${text.name}の準備ができました`, 'success');
      await renderLocalAiControl(host, kind, onReady);
      if (onReady) onReady();
    } catch (error) {
      button.disabled = false;
      button.textContent = '再試行';
      toast(`準備できませんでした: ${error?.message || error}`, 'warn');
    }
  };
  host.append(line, button);
}

// ── queries ──


// ── queries ──
/** Queries for a text; kept as they are when the user edited them for the same text. */
async function makeWebQueries(text, onStatus) {
  if (text === discoverQueriesText && discoverQueriesEdited && discoverQueries.some(query => query.trim())) return discoverQueries.map(query => query.trim()).filter(Boolean);
  discoverQueriesEdited = false;
  // The text's own words always come first (the small on-device model sometimes changes the
  // meaning, e.g. 再現 → 再現率/recall); the AI adds other wordings and an English query.
  const words = (await api.post('/api/discover/queries', { purpose: text })).queries;
  let queries = words.slice(0, 1);
  discoverQuerySource = 'words';
  if (typeof localAi !== 'undefined' && await localAi.isReady('prompt')) {
    if (onStatus) onStatus('端末のAIがWeb用の検索語を考えています…（数秒）');
    try {
      const ai = await localAi.makeQueries(text);
      if (ai.length) discoverQuerySource = 'local-ai';
      queries = queries.concat(ai);
    } catch (error) {
      console.warn('local AI failed, using the words of the text', error);
    }
  }
  if (queries.length < 2) queries = queries.concat(words.slice(1));
  if (!queries.length && text.trim()) queries = [text.trim().slice(0, 100)];
  const seen = new Set();
  queries = queries.filter(query => { const key = query.toLowerCase().replace(/\s+/g, ' ').trim(); if (!key || seen.has(key)) return false; seen.add(key); return true; }).slice(0, 4);
  discoverQueries = queries;
  discoverQueriesText = text;
  renderDiscoverQueries();
  return queries;
}

function renderDiscoverQueries() {
  const host = discoverEl('discover-queries');
  host.textContent = '';
  if (discoverQueries.length) {
    const label = document.createElement('span');
    label.className = 'reader-note';
    label.textContent = discoverQuerySource === 'local-ai' ? '検索語（1つ目は目的の語、残りは端末のAIの提案。書き換えできます）:' : discoverQuerySource === 'words' ? '検索語（目的の語から作成・書き換えできます）:' : '検索語:';
    host.appendChild(label);
  }
  discoverQueries.forEach((query, index) => {
    const chip = document.createElement('span');
    chip.className = 'discover-query';
    const input = document.createElement('input');
    input.value = query;
    input.maxLength = 100;
    input.size = Math.max(8, query.length + 2);
    input.oninput = () => { discoverQueries[index] = input.value; discoverQueriesEdited = true; };
    input.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) runSearchScreen({ webOnly: true }); };
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-icon';
    remove.textContent = '×';
    remove.title = 'この検索語を外す';
    remove.onclick = () => { discoverQueries.splice(index, 1); discoverQueriesEdited = true; renderDiscoverQueries(); };
    chip.append(input, remove);
    host.appendChild(chip);
  });
  if (discoverQueries.length < 4) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn btn-secondary btn-sm';
    add.textContent = '＋ 検索語';
    add.onclick = () => { discoverQueries.push(''); discoverQueriesEdited = true; renderDiscoverQueries(); host.querySelectorAll('input')[discoverQueries.length - 1]?.focus(); };
    host.appendChild(add);
  }
}


function discoverFormatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ja-JP');
}


// ── web results ──
function savedCardUrlKeys() {
  const keys = new Set();
  for (const card of (typeof allCards !== 'undefined' ? allCards : [])) {
    if (!card.url) continue;
    try { const url = new URL(card.url); keys.add(`${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`); } catch { /* ignore */ }
  }
  return keys;
}
function urlKey(raw) {
  try { const url = new URL(raw); return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`; } catch { return raw; }
}

async function runWebSearch(text, sources) {
  const host = discoverEl('search-web');
  host.textContent = '';
  const heading = document.createElement('h4');
  heading.className = 'search-section-title';
  heading.textContent = 'Webから（その場で検索）';
  const status = document.createElement('p');
  status.className = 'reader-note';
  status.textContent = '検索語を作っています…';
  const list = document.createElement('div');
  list.className = 'discover-results';
  host.append(heading, status, list);
  try {
    const queries = await makeWebQueries(text, message => { status.textContent = message; });
    if (!queries.length) { status.textContent = 'Web用の検索語を作れませんでした。詳細条件の「Webで使う検索語」に入れてください。'; return; }
    status.textContent = `${sources.map(id => DISCOVER_VIA_LABEL[id] || id).join('・')} を検索しています…（検索語: ${queries.join(' / ')}）`;
    discoverLastResult = await api.post('/api/discover', { purpose: text, queries, sources });
    const result = discoverLastResult;
    const sourceText = result.sources.map(source => `${source.label} ${source.error ? `（失敗: ${source.error}）` : `${source.count}件`}`).join('・');
    status.textContent = `検索語: ${result.queries.join(' / ')} → ${sourceText} → 重複を除いて${result.stats.unique}件 → 関連する${result.results.length}件`;
    if (!result.results.length) {
      const none = document.createElement('p');
      none.className = 'reader-note';
      none.textContent = '関連する記事が見つかりませんでした。検索語を短くするか、別の言い方（英語の専門用語など）を試してください。';
      list.append(none);
      return;
    }
    const saved = savedCardUrlKeys();
    const max = Math.max(...result.results.map(item => item.score), 0.0001);
    result.results.forEach((item, rank) => list.append(renderDiscoverItem(item, rank, max, saved.has(urlKey(item.url)))));
  } catch (error) {
    status.textContent = `Webを検索できませんでした: ${formatApiError(error)}`;
  }
}

function renderDiscoverItem(item, rank, max, alreadySaved = false) {
  const card = document.createElement('div');
  card.className = 'discover-item';
  const head = document.createElement('div');
  head.className = 'discover-item-head';
  const num = document.createElement('span');
  num.className = 'discover-rank';
  num.textContent = String(rank + 1);
  const link = document.createElement('a');
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = item.title;
  head.append(num, link);
  const meta = document.createElement('div');
  meta.className = 'discover-meta';
  meta.textContent = [item.site, item.author, discoverFormatDate(item.publishedAt), item.popularityLabel, `検索元: ${item.foundBy.map(id => DISCOVER_VIA_LABEL[id] || id).join('・')}`].filter(Boolean).join(' · ');
  const summary = document.createElement('p');
  summary.className = 'discover-summary';
  summary.textContent = item.summary;
  const score = document.createElement('div');
  score.className = 'discover-score';
  const bar = document.createElement('span');
  bar.className = 'discover-bar';
  bar.style.width = `${Math.max(2, Math.round((item.score / max) * 120))}px`;
  const why = document.createElement('span');
  const b = item.breakdown;
  why.textContent = `点数 ${item.score.toFixed(3)} = 関連度 ${b.relevance.toFixed(3)} × (0.5 + 0.5 × 信頼 ${b.trust.toFixed(2)})`;
  why.title = `関連度: BM25（一致した語: ${b.matchedTerms.join(', ') || 'なし'}）× 新しさ ${b.timeDecay} × 目的の語の一致による補正（0.4 + 0.6 × ${b.purposeCoverage ?? 1}）\n信頼: ${b.trustReason} ${b.trustBase} ＋ 人気 ${b.popularityBonus}`;
  const terms = document.createElement('span');
  terms.className = 'reader-note';
  terms.textContent = (b.missingKeyTerms?.length ? ` ${b.missingKeyTerms.join('・')} を含まないため下げています ·` : '') + (typeof b.purposeCoverage === 'number' ? ` 目的の語 ${Math.round(b.purposeCoverage * 100)}%` : '') + (b.matchedTerms.length ? ` 一致: ${b.matchedTerms.slice(0, 6).join('・')}` : '');
  score.append(bar, why, terms);
  const actions = document.createElement('div');
  actions.className = 'evidence-actions';
  actions.appendChild(evidenceButton('読んでメモ', '本文を開いて、読みながらメモを書く', () => openDiscoverItem(item, false)));
  actions.appendChild(evidenceButton('根拠を探す', '本文を開いて、目的に関係する一節を探す', () => openDiscoverItem(item, true)));
  if (alreadySaved) meta.textContent += ' · 保存済み';
  const save = evidenceButton(alreadySaved ? '保存済み' : '保存', '本文ごとカードに保存（あとで読む）', async () => {
    save.disabled = true;
    save.textContent = '保存中…';
    try {
      const saved = await saveArticleWithFullText(item.url);
      if (saved) {
        save.textContent = '保存済み';
        toast('本文ごとカードに保存しました', 'success');
        if (typeof loadCards === 'function') loadCards();
      } else {
        save.disabled = false;
        save.textContent = '保存';
        toast('本文を取得できませんでした（「読んでメモ」から本文を貼り付けて保存できます）', 'warn');
      }
    } catch (error) {
      save.disabled = false;
      save.textContent = '保存';
      showApiError(error, '保存できませんでした');
    }
  });
  save.disabled = alreadySaved;
  actions.appendChild(save);
  // Pass on this one (only hides it from this result list).
  actions.appendChild(evidenceButton('見送る', 'この結果を一覧から外す', () => card.remove()));
  card.append(head, meta, summary, score, actions);
  return card;
}

function openDiscoverItem(item, findEvidence) {
  const purpose = (document.getElementById('search-terms')?.value || '').trim();
  readerPendingPurpose = { purpose, run: findEvidence };
  openReader(item.url);
}
