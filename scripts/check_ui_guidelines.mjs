import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const html = read('public/index.html');
const cards = read('public/js/cards_ui.js');
const reader = read('public/js/reader_ui.js');
const styles = read('public/styles.css');
const modes = read('public/js/bm25_modes_ui.js');
const fail = message => { console.error(`UI guideline check failed: ${message}`); process.exitCode = 1; };
const requireText = (source, text, message) => { if (!source.includes(text)) fail(message); };
const forbidText = (source, text, message) => { if (source.includes(text)) fail(message); };

if ((html.match(/id="modal-reader"/g) ?? []).length !== 1) fail('Reader Editor must be the single card editing modal.');
for (const obsolete of ['id="modal-edit"', 'id="modal-new"', 'id="mobile-edit-panel"', 'js/mobile_edit.js']) {
  forbidText(html, obsolete, `obsolete editor remains in HTML: ${obsolete}`);
}
for (const obsolete of ['submitEdit(', 'confirmDelete(', 'mepSave(', 'mepDelete(']) {
  forbidText(cards + reader, obsolete, `separate card-edit handler remains: ${obsolete}`);
}
requireText(cards, 'function openEditModal(id) { return openReaderForCard(id); }', 'card edit entry must open the shared editor.');
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

if (!process.exitCode) console.log('UI guidelines check passed: one responsive editor, one save entry, format-aware APIs, and source paragraph preservation.');
