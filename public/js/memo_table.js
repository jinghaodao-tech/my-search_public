// Memo table: edit a table in cells, store it as a Markdown table inside the memo.
// The user never has to write Markdown; the Markdown form keeps the table
// searchable and exportable with the rest of the card.

/** Find the first Markdown table block in text. Returns { rows, start, end } (char offsets) or null. */
function parseFirstMarkdownTable(text) {
  const lines = String(text ?? '').split('\n');
  let offset = 0;
  const starts = lines.map(line => { const at = offset; offset += line.length + 1; return at; });
  const isRow = line => /^\s*\|.*\|\s*$/.test(line);
  const isSeparator = line => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isRow(lines[i]) || !isSeparator(lines[i + 1])) continue;
    let j = i + 2;
    while (j < lines.length && isRow(lines[j]) && !isSeparator(lines[j])) j++;
    const rows = [lines[i], ...lines.slice(i + 2, j)].map(splitMarkdownRow);
    const width = Math.max(...rows.map(row => row.length));
    const end = j < lines.length ? starts[j] - 1 : text.length;
    return { rows: rows.map(row => [...row, ...Array(width - row.length).fill('')]), start: starts[i], end };
  }
  return null;
}

function splitMarkdownRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let current = '';
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && inner[i + 1] === '|') { current += '|'; i++; continue; }
    if (inner[i] === '|') { cells.push(current.trim()); current = ''; continue; }
    current += inner[i];
  }
  cells.push(current.trim());
  return cells;
}

/** rows[0] is the header row. Pipes are escaped and line breaks become spaces. */
function serializeMarkdownTable(rows) {
  const width = Math.max(1, ...rows.map(row => row.length));
  const cell = value => String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  const line = row => `| ${Array.from({ length: width }, (_, i) => cell(row[i]) || ' ').join(' | ')} |`;
  const [header = [], ...body] = rows;
  return [line(header), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(line)].join('\n');
}

/** Put the table back where it was, or append it to the memo if there was none. */
function replaceOrAppendTable(text, rows) {
  const source = String(text ?? '');
  const table = serializeMarkdownTable(rows);
  const found = parseFirstMarkdownTable(source);
  if (found) return source.slice(0, found.start) + table + source.slice(found.end);
  return source.trim() ? `${source.trimEnd()}\n\n${table}\n` : `${table}\n`;
}

// ── Pure edits (tested) ──────────────────────────────────────
function insertTableRow(rows, at) { const copy = rows.map(r => [...r]); copy.splice(at, 0, rows[0].map(() => '')); return copy; }
function removeTableRow(rows, at) { if (rows.length <= 1 || at === 0) return rows.map(r => [...r]); const copy = rows.map(r => [...r]); copy.splice(at, 1); return copy; }
function insertTableColumn(rows, at) {
  let n = 1;
  while (rows[0].includes(`列${n}`)) n++; // first unused default name
  return rows.map((r, i) => { const copy = [...r]; copy.splice(at, 0, i === 0 ? `列${n}` : ''); return copy; });
}
function removeTableColumn(rows, at) { if (rows[0].length <= 1) return rows.map(r => [...r]); return rows.map(r => r.filter((_, c) => c !== at)); }

/**
 * Put a quote into a table cell. target = { r, c } of the last focused cell, or null.
 * With no target (or the header row as target), the first empty row is used, or a new row is added.
 * Text already in the cell is kept; the quote is appended after it.
 */
function quoteIntoTable(rows, target, text, paragraphIndex, location) {
  const marker = Number.isInteger(paragraphIndex) ? (location ? `[¶${paragraphIndex + 1}|${location}]` : `[¶${paragraphIndex + 1}]`) : '';
  const quote = `「${String(text).replace(/\s+/g, ' ').trim()}」${marker}`;
  let next = rows.map(r => [...r]);
  let at = target && target.r > 0 && target.r < next.length && target.c < next[0].length ? { r: target.r, c: target.c } : null;
  if (!at) {
    const empty = next.findIndex((row, r) => r > 0 && row.every(cell => !cell.trim()));
    if (empty > 0) at = { r: empty, c: 0 };
    else {
      next = insertTableRow(next, next.length);
      at = { r: next.length - 1, c: 0 };
    }
  }
  const current = next[at.r][at.c];
  next[at.r][at.c] = current ? `${current} ${quote}` : quote;
  return { rows: next, target: at };
}

const EVIDENCE_HEADER = ['主張', '根拠（本文の引用）', '自分の考え'];

/**
 * Add checked evidence rows ({ claim, quote, paragraphIndex }) to a table.
 * rows = current table or null (a new evidence table is started). Empty body rows are dropped,
 * a row whose quote is already in the table is skipped, and the quote cell carries the [¶n] marker.
 */
function appendEvidenceRows(rows, evidence) {
  const base = rows ? rows.map(r => [...r]) : [EVIDENCE_HEADER.slice()];
  const width = base[0].length;
  const kept = [base[0], ...base.slice(1).filter(row => row.some(cell => String(cell).trim()))];
  const present = new Set(kept.slice(1).map(row => row.join('\u0000')));
  let added = 0;
  for (const item of evidence) {
    const where = item.location ? `|${item.location}` : '';
    const quote = `「${String(item.quote).replace(/\s+/g, ' ').trim()}」${Number.isInteger(item.paragraphIndex) ? `[¶${item.paragraphIndex + 1}${where}]` : ''}`;
    if ([...present].some(line => line.includes(quote))) continue;
    const row = Array(width).fill('');
    row[0] = String(item.claim).replace(/\s+/g, ' ').trim();
    row[Math.min(1, width - 1)] = width > 1 ? quote : `${row[0]} ${quote}`;
    kept.push(row);
    present.add(row.join('\u0000'));
    added += 1;
  }
  if (kept.length === 1) kept.push(Array(width).fill(''));
  return { rows: kept, added };
}

// ── UI (reader memo) ─────────────────────────────────────────
let memoTableFocus = null; // last focused cell { r, c }, used by "選択を引用"
let memoTableRows = null; // null = text mode

function setMemoMode(mode) {
  const memo = document.getElementById('reader-memo');
  const editor = document.getElementById('reader-table');
  if (mode === 'table') {
    const found = parseFirstMarkdownTable(memo.value);
    memoTableRows = found ? found.rows : [['列1', '列2', '列3'], ['', '', ''], ['', '', '']];
    memoTableFocus = null;
    renderMemoTable();
  } else if (memoTableRows) {
    memo.value = replaceOrAppendTable(memo.value, memoTableRows);
    memoTableRows = null;
  }
  memo.style.display = mode === 'table' ? 'none' : '';
  editor.style.display = mode === 'table' ? '' : 'none';
  document.getElementById('memo-mode-text').classList.toggle('active', mode !== 'table');
  document.getElementById('memo-mode-table').classList.toggle('active', mode === 'table');
}

/** Fresh start when the reader opens: drop any table left from the previous session (never write it into the new memo). */
function resetMemoMode() {
  memoTableRows = null;
  memoTableFocus = null;
  setMemoMode('text');
}

/** Called before saving: write the table (if being edited) into the memo text. */
function syncMemoTable() {
  if (!memoTableRows) return;
  const memo = document.getElementById('reader-memo');
  memo.value = replaceOrAppendTable(memo.value, memoTableRows);
}

function editMemoTable(next, focus) {
  memoTableRows = next;
  renderMemoTable(focus);
  if (typeof readerDraftChanged === 'function') readerDraftChanged();
}

function smallButton(label, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'memo-table-btn';
  button.textContent = label;
  button.title = title;
  button.tabIndex = -1; // keep Tab for moving between cells
  button.onclick = onClick;
  return button;
}

function renderMemoTable(focus) {
  const host = document.getElementById('reader-table-grid');
  host.textContent = '';
  const table = document.createElement('table');
  table.className = 'memo-table';
  const width = memoTableRows[0].length;
  memoTableRows.forEach((row, r) => {
    const tr = document.createElement('tr');
    row.forEach((value, c) => {
      const cell = document.createElement(r === 0 ? 'th' : 'td');
      const input = document.createElement('input');
      input.value = value;
      input.dataset.r = r; input.dataset.c = c;
      input.oninput = () => { memoTableRows[r][c] = input.value; if (typeof readerDraftChanged === 'function') readerDraftChanged(); };
      input.ondragover = event => { if (event.dataTransfer?.types.includes('application/x-reader-quote')) event.preventDefault(); };
      input.ondrop = event => {
        const data = event.dataTransfer?.getData('application/x-reader-quote');
        if (!data) return; // plain drops keep the browser's default behaviour
        event.preventDefault();
        const { text, index, location } = JSON.parse(data);
        memoTableFocus = { r, c };
        quoteSelectionIntoTable(text, index, location);
      };
      input.onfocus = () => { memoTableFocus = { r, c }; };
      input.onkeydown = event => {
        const last = r === memoTableRows.length - 1;
        if (event.key === 'Enter') {
          event.preventDefault();
          if (last) editMemoTable(insertTableRow(memoTableRows, r + 1), [r + 1, c]);
          else focusMemoCell(r + 1, c);
        } else if (event.key === 'Tab' && !event.shiftKey && last && c === width - 1) {
          event.preventDefault();
          editMemoTable(insertTableRow(memoTableRows, r + 1), [r + 1, 0]);
        }
      };
      cell.appendChild(input);
      if (r === 0 && width > 1) cell.appendChild(smallButton('×', 'この列を削除', () => editMemoTable(removeTableColumn(memoTableRows, c))));
      tr.appendChild(cell);
    });
    const tail = document.createElement(r === 0 ? 'th' : 'td');
    tail.className = 'memo-table-tail';
    if (r === 0) tail.appendChild(smallButton('＋', '列を追加', () => editMemoTable(insertTableColumn(memoTableRows, width), [0, width])));
    else tail.appendChild(smallButton('×', 'この行を削除', () => editMemoTable(removeTableRow(memoTableRows, r))));
    tr.appendChild(tail);
    table.appendChild(tr);
  });
  const addRow = document.createElement('tr');
  const addCell = document.createElement('td');
  addCell.colSpan = width + 1;
  addCell.className = 'memo-table-addrow';
  addCell.appendChild(smallButton('＋ 行を追加', '行を追加（最後の行で Enter でも追加）', () => editMemoTable(insertTableRow(memoTableRows, memoTableRows.length), [memoTableRows.length, 0])));
  addRow.appendChild(addCell);
  table.appendChild(addRow);
  host.appendChild(table);
  if (focus) focusMemoCell(focus[0], focus[1]);
}

function focusMemoCell(r, c) {
  document.querySelector(`#reader-table-grid input[data-r="${r}"][data-c="${c}"]`)?.focus();
}

/** Put AI-proposed rows (already checked against the text by the server) into the memo table. */
function addEvidenceToMemoTable(evidence) {
  let current = memoTableRows;
  if (!current) {
    const hadTable = !!parseFirstMarkdownTable(document.getElementById('reader-memo').value);
    setMemoMode('table'); // shows the existing table, or a blank one
    current = hadTable ? memoTableRows : null; // no table yet: start an evidence table instead of the blank one
  }
  const result = appendEvidenceRows(current, evidence);
  editMemoTable(result.rows);
  return result.added;
}

/** Called by "選択を引用" while the table is shown. */
function quoteSelectionIntoTable(text, paragraphIndex, location) {
  const result = quoteIntoTable(memoTableRows, memoTableFocus, text, paragraphIndex, location);
  memoTableFocus = result.target;
  editMemoTable(result.rows, [result.target.r, result.target.c]);
  if (typeof readerDraftChanged === 'function') readerDraftChanged();
}
