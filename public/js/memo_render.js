// Memo helpers shared by the reader and the card detail panel (pure functions, tested).
//
// Quotes carry a marker "[¶n]" (n = 1-based paragraph in the saved copy) so the memo can jump
// back to where a quote came from. For PDFs the marker also holds the page: "[¶12|p. 57]",
// "[¶12|pp. 57–58]" or "[¶12|PDF 3枚目]" when the printed page number is unknown.

const QUOTE_MARKER = /\[¶(\d+)(?:\|([^\]]+))?\]/;
const PAGE_MARKER_LINE = /^\[\[page:(\d+)\|([^\]]*)\]\]$/;

function quoteMarker(paragraphIndex, location) {
  if (!Number.isInteger(paragraphIndex)) return '';
  return location ? `[¶${paragraphIndex + 1}|${location}]` : `[¶${paragraphIndex + 1}]`;
}

/** Text quote for the memo textarea: every line prefixed with "> ", marker at the end. */
function formatTextQuote(text, paragraphIndex, location) {
  const lines = String(text).split(/\n+/).map(line => line.trim()).filter(Boolean);
  const marker = Number.isInteger(paragraphIndex) ? ` ${quoteMarker(paragraphIndex, location)}` : '';
  return lines.map((line, i) => `> ${line}${i === lines.length - 1 ? marker : ''}`).join('\n');
}

/** Quote for a table cell: one line in 「」 with the marker. */
function formatCellQuote(text, paragraphIndex, location) {
  return `「${String(text).replace(/\s+/g, ' ').trim()}」${quoteMarker(paragraphIndex, location)}`;
}

// ── Pages (PDF) ──────────────────────────────────────────────
/** Page { sheet, label } that paragraph `index` belongs to (last page marker at or before it), or null. */
function pageAt(paragraphs, index) {
  for (let i = Math.min(index, paragraphs.length - 1); i >= 0; i--) {
    const found = PAGE_MARKER_LINE.exec(paragraphs[i] ?? '');
    if (found) return { sheet: Number(found[1]), label: found[2] || null };
  }
  return null;
}

/** "p. 57" / "pp. 57–58" / "PDF 3枚目" / null (articles have no pages). Same rule as the server. */
function formatPageLocation(start, end) {
  if (!start) return null;
  const last = end || start;
  if (start.label && last.label) return start.label === last.label ? `p. ${start.label}` : `pp. ${start.label}–${last.label}`;
  return start.sheet === last.sheet ? `PDF ${start.sheet}枚目` : `PDF ${start.sheet}–${last.sheet}枚目`;
}

function locationBetween(paragraphs, startIndex, endIndex) {
  if (!Array.isArray(paragraphs) || !Number.isInteger(startIndex)) return null;
  return formatPageLocation(pageAt(paragraphs, startIndex), pageAt(paragraphs, Number.isInteger(endIndex) ? endIndex : startIndex));
}

/** Rewrite the printed page labels so that PDF sheet `sheet` is printed page `printed` (sheets before it get none). */
function relabelParagraphs(paragraphs, sheet, printed) {
  return paragraphs.map(paragraph => {
    const found = PAGE_MARKER_LINE.exec(paragraph);
    if (!found) return paragraph;
    const n = Number(found[1]);
    const label = n >= sheet && printed + (n - sheet) > 0 ? String(printed + (n - sheet)) : '';
    return `[[page:${n}|${label}]]`;
  });
}

// ── Citation (copy with source) ──────────────────────────────
/**
 * Quote with its in-text citation, following the usual rules: the wording as is, quotation
 * marks by language (「」 / “ ”, inner marks changed to 『』 / ‘ ’), author, year and page.
 * Japanese: 「…」（水本・竹内，2008，p. 57）  English: “…” (Mizumoto & Takeuchi, 2008, p. 57)
 */
function formatCitedQuote({ quote, author, year, location }) {
  const text = String(quote ?? '').replace(/\s+/g, ' ').trim();
  const latin = (text.match(/[A-Za-z]/g) ?? []).length > text.length * 0.5;
  const who = String(author ?? '').trim() || (latin ? 'Author' : '著者未入力');
  const when = String(year ?? '').trim() || (latin ? 'n.d.' : '年未入力');
  if (latin) {
    let straight = 0;
    const body = text.replace(/“/g, '‘').replace(/”/g, '’').replace(/"/g, () => (straight++ % 2 === 0 ? '‘' : '’'));
    return `“${body}” (${[who, when, location].filter(Boolean).join(', ')})`;
  }
  const body = text.replace(/「/g, '『').replace(/」/g, '』');
  return `「${body}」（${[who, when, location].filter(Boolean).join('，')}）`;
}

/**
 * Paragraph index (0-based) of the quote under the caret, or null.
 * A quote may span several "> " lines; the marker sits on its last line.
 */
function findQuoteMarkerAt(text, caret) {
  const source = String(text ?? '');
  const lines = source.split('\n');
  let offset = 0;
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    if (caret <= offset + lines[i].length) { at = i; break; }
    offset += lines[i].length + 1;
    at = i;
  }
  const own = QUOTE_MARKER.exec(lines[at]);
  if (own) return Number(own[1]) - 1;
  if (!lines[at].startsWith('>')) return null;
  for (let i = at + 1; i < lines.length && lines[i].startsWith('>'); i++) {
    const found = QUOTE_MARKER.exec(lines[i]);
    if (found) return Number(found[1]) - 1;
  }
  return null;
}

/** Paragraph index (0-based) from any text that contains a marker (e.g. a table cell). */
function findMarkerIn(text) {
  const found = QUOTE_MARKER.exec(String(text ?? ''));
  return found ? Number(found[1]) - 1 : null;
}

function escapeMemoHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineMemoHtml(text) {
  return escapeMemoHtml(text).replace(/\[¶(\d+)(?:\|([^\]]+))?\]/g, (_, n, where) => `<span class="quote-marker">¶${n}${where ? ` · ${where}` : ''}</span>`);
}

/**
 * Render a memo (plain lines, "> " quotes and Markdown tables) to safe HTML.
 * Everything is escaped first; only the structure is turned into tags.
 */
function renderMemoHtml(memo) {
  const lines = String(memo ?? '').replace(/\r\n/g, '\n').split('\n');
  const isRow = line => /^\s*\|.*\|\s*$/.test(line);
  const isSeparator = line => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
  const cells = line => {
    const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    const out = [];
    let current = '';
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '\\' && inner[i + 1] === '|') { current += '|'; i++; continue; }
      if (inner[i] === '|') { out.push(current.trim()); current = ''; continue; }
      current += inner[i];
    }
    out.push(current.trim());
    return out;
  };
  const html = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (isRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const head = cells(line);
      const body = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) body.push(cells(lines[i++]));
      html.push(`<table class="memo-view-table"><thead><tr>${head.map(c => `<th>${inlineMemoHtml(c)}</th>`).join('')}</tr></thead><tbody>${
        body.map(row => `<tr>${head.map((_, c) => `<td>${inlineMemoHtml(row[c] ?? '')}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`);
      continue;
    }
    if (line.startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''));
      html.push(`<blockquote class="memo-view-quote">${quote.map(inlineMemoHtml).join('<br>')}</blockquote>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('>') && !(isRow(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1]))) para.push(lines[i++]);
    html.push(`<p>${para.map(inlineMemoHtml).join('<br>')}</p>`);
  }
  return html.join('');
}

/** Split a card body written by the reader into { memo, sourceLines } (null if not that format). */
function splitReaderBody(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  if (!text.startsWith('## メモ\n\n')) return null;
  const sourceAt = text.indexOf('\n\n## 出典\n\n');
  const textAt = text.indexOf('\n\n## 本文（取得時点のコピー・私的利用）\n\n');
  if (sourceAt < 0 || textAt < sourceAt) return null;
  const memo = text.slice('## メモ\n\n'.length, sourceAt);
  const sourceLines = text.slice(sourceAt + '\n\n## 出典\n\n'.length, textAt).split('\n').filter(Boolean);
  return { memo: memo === '（なし）' ? '' : memo, sourceLines };
}

/** Short plain-text preview for the card list: the memo only, without Markdown marks. Null if not a reader card. */
function memoPreviewText(body) {
  const parts = splitReaderBody(body);
  if (!parts) return null;
  return parts.memo
    .split('\n')
    .filter(line => !/^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line))
    .map(line => line.replace(/^>\s?/, '').replace(/\[¶\d+(?:\|[^\]]+)?\]/g, '').replace(/^\s*\||\|\s*$/g, '').replace(/\s*\|\s*/g, ' / ').trim())
    .filter(Boolean)
    .join(' ') || '（メモなし）';
}
