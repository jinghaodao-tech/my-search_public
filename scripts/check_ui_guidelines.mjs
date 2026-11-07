import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const html = read('public/index.html');
const cards = read('public/js/cards_ui.js');
const reader = read('public/js/reader_ui.js');
const styles = read('public/styles.css');
const modes = read('public/js/bm25_modes_ui.js');
const ai = read('public/js/ai_ui.js');
const keywords = read('public/js/bm25_ui.js');
const audit = read('docs/ui-operation-audit.md');
const fail = message => { console.error(`UI guideline check failed: ${message}`); process.exitCode = 1; };
const requireText = (source, text, message) => { if (!source.includes(text)) fail(message); };
const forbidText = (source, text, message) => { if (source.includes(text)) fail(message); };

if ((html.match(/id="modal-reader"/g) ?? []).length !== 1) fail('Reader Editor must be the single card editing modal.');
for (const obsolete of ['id="modal-edit"', 'id="modal-new"', 'id="mobile-edit-panel"', 'js/mobile_edit.js']) {
  forbidText(html, obsolete, `obsolete editor remains in HTML: ${obsolete}`);
}
for (const match of html.matchAll(/class="modal-overlay" id="([^"]+)"/g)) {
  if (!audit.includes(`#${match[1]}`)) fail(`modal is missing from docs/ui-operation-audit.md: #${match[1]}`);
}
for (const viewId of ['card-grid', 'candidate-view', 'kj-board', 'zettel-view', 'bm25-view']) {
  if (!audit.includes(`#${viewId}`)) fail(`primary view is missing from docs/ui-operation-audit.md: #${viewId}`);
}
for (const obsolete of ['submitEdit(', 'confirmDelete(', 'mepSave(', 'mepDelete(']) {
  forbidText(cards + reader, obsolete, `separate card-edit handler remains: ${obsolete}`);
}
requireText(cards, 'function openEditModal(id) { return openReaderForCard(id); }', 'card edit entry must open the shared editor.');
requireText(cards, 'openEditModal(${jsArg(card.id)})', 'the card-list pencil must remain a shortcut to the shared editor.');
requireText(html, 'id="reader-edit-btn" onclick="openEditModal(currentCardId)"', 'the detail editor must use the same entry function as the card-list pencil.');
for (const obsolete of ['読んで編集', '本文と一緒に開く']) {
  forbidText(html + cards, obsolete, `duplicate detail editor entry remains: ${obsolete}`);
}
requireText(cards, 'function openNewCardModal() {\n  openPlainCardEditor();', 'new memo creation must use the shared editor.');
requireText(reader, 'async function saveReaderCardOnce()', 'shared save handler is missing.');
requireText(reader, 'if (readerPlainCardMode)', 'plain cards need an explicit format-aware save adapter.');
requireText(reader, "'/api/cards'", 'plain card creation must retain the card API.');
requireText(reader, '`/api/reader/cards/${', 'saved Reader cards must use the Reader API.');
requireText(reader, 'paragraphs: article.paragraphs', 'Reader source paragraphs must be saved without reading from editable memo content.');
requireText(html, 'id="reader-edit-title"', 'the shared editor needs an editable title field.');
requireText(html, 'id="reader-tags"', 'the shared editor needs a tag field.');
requireText(html, 'id="reader-card-color-strip"', 'the shared editor needs the existing card-color control.');
requireText(reader, 'readerEditorColorTouched', 'the shared editor must distinguish an untouched color from an explicit clear.');
requireText(styles, '.reader-plain-mode .reader-split', 'plain-card layout must be a conditional layout of the shared editor.');
requireText(styles, '@media (max-width:768px)', 'the shared editor must retain responsive layout rules.');
requireText(modes, 'function addBM25Mode(){\n  openModeManagerModal();', 'the quick-add mode shortcut must open the shared mode manager.');
requireText(modes, 'function confirmAddMode(){', 'mode creation must use the shared manager form.');
forbidText(modes, "prompt('新しいモード名を入力してください')", 'mode creation must not retain a second prompt flow.');
requireText(html, 'openSourceModal();this.closest(\'details\').open=false">情報源を管理</button>', 'source-management entry must have a consistent purpose label.');
requireText(html, 'onclick="openSourceModal()">情報源を管理</button>', 'search-screen source entry must use the shared source-management label.');
requireText(html, 'aria-label="メモを作成"', 'compact memo shortcut must expose the shared accessible name.');
requireText(html, 'aria-label="データ取り込み"', 'compact import shortcut must expose the shared accessible name.');
requireText(html, '>Markdown出力</button>', 'bulk export must use the full Japanese format name.');
requireText(html, 'title="Markdown出力" aria-label="Markdown出力"', 'detail export must have a Japanese accessible name.');
requireText(cards, '>要約を削除</button>', 'summary removal action must be labeled in Japanese.');
requireText(ai, "confirm('要約を削除しますか？')", 'summary removal confirmation must explain its effect in Japanese.');
requireText(keywords, '>削除</button>', 'search-keyword removal action must be labeled in Japanese.');
for (const obsolete of ['ソース管理', '＋ サイトを追加', '情報源を追加', 'MD Export', 'Export Markdown', 'Toggle sidebar']) {
  forbidText(html, obsolete, `inconsistent or untranslated action label remains: ${obsolete}`);
}
forbidText(cards + ai + keywords, '>Delete</button>', 'English deletion action remains in card or search UI.');
forbidText(keywords, '>Remove</button>', 'English removal action remains in search UI.');

if (!process.exitCode) console.log('UI guidelines check passed: shared edit entry, documented modal/view inventory, format-aware saves, source preservation, and consistent action labels.');
