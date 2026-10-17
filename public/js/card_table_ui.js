// Card list as a table: one row per card, sortable by clicking a column header.
// The choice (cards / table) is remembered in this browser only.
let cardLayout = 'cards';
let cardTableSort = { key: 'createdAt', dir: -1 };
try { if (localStorage.getItem('cardLayout') === 'table') cardLayout = 'table'; } catch { /* storage unavailable */ }

const CARD_TABLE_COLUMNS = [
  { key: 'type', label: '種類', value: card => ({ article: '記事', memo: 'メモ', csv: 'CSV' })[card.type] ?? card.type },
  { key: 'title', label: 'タイトル', value: card => card.title },
  { key: 'source', label: '出典', value: card => cardSourceLabel(card) },
  { key: 'tags', label: 'タグ', value: card => (card.tags || []).join(' ') },
  { key: 'createdAt', label: '作成日', value: card => card.createdAt, display: card => new Date(card.createdAt).toLocaleDateString('ja-JP') },
  { key: 'updatedAt', label: '更新日', value: card => card.updatedAt, display: card => new Date(card.updatedAt).toLocaleDateString('ja-JP') },
];

/** Site name from a reader card's 出典 section, else the URL host. */
function cardSourceLabel(card) {
  const site = /^- サイト: (.*)$/m.exec(card.body || '')?.[1];
  if (site) return site.trim();
  try { return card.url ? new URL(card.url).hostname : ''; } catch { return ''; }
}

function setCardLayout(layout) {
  cardLayout = layout;
  try { localStorage.setItem('cardLayout', layout); } catch { /* storage unavailable */ }
  document.getElementById('layout-cards').classList.toggle('active', layout === 'cards');
  document.getElementById('layout-table').classList.toggle('active', layout === 'table');
  renderCardGrid();
}

function sortCardTable(key) {
  cardTableSort = cardTableSort.key === key ? { key, dir: -cardTableSort.dir } : { key, dir: 1 };
  renderCardGrid();
}

function renderCardTable(grid) {
  grid.classList.add('as-table');
  const column = CARD_TABLE_COLUMNS.find(c => c.key === cardTableSort.key) ?? CARD_TABLE_COLUMNS[4];
  const rows = [...allCards].sort((a, b) => String(column.value(a) ?? '').localeCompare(String(column.value(b) ?? ''), 'ja') * cardTableSort.dir);
  const arrow = key => (key === cardTableSort.key ? (cardTableSort.dir === 1 ? ' ▲' : ' ▼') : '');
  const head = CARD_TABLE_COLUMNS.map(c => `<th onclick="sortCardTable('${c.key}')">${esc(c.label)}${arrow(c.key)}</th>`).join('');
  const body = rows.map(card => `<tr class="card-row ${selectedCards.has(card.id) ? 'selected' : ''}" onclick="cardClick('${esc(card.id)}')">${
    CARD_TABLE_COLUMNS.map(c => `<td class="${c.key === 'title' ? '' : 'muted'}">${esc((c.display ?? c.value)(card) ?? '')}</td>`).join('')
  }</tr>`).join('');
  grid.innerHTML = `<table class="card-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('layout-cards')?.classList.toggle('active', cardLayout === 'cards');
  document.getElementById('layout-table')?.classList.toggle('active', cardLayout === 'table');
});
