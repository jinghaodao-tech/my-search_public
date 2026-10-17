/**
 * PDF reader: turn a (DRM-free) PDF into page-tagged paragraphs without AI.
 *
 * Why: papers and technical books are read as PDFs, and a quotation from them
 * needs the page number. The page is taken from the PDF itself (and the page
 * number printed on the page), never guessed by AI.
 *
 * Paragraph list format (shared with the article reader):
 *   "[[page:3|57]]"  page marker = 3rd sheet of the PDF, printed page "57" ("" if unknown)
 *   "本文の段落…"     paragraphs of that page follow the marker
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PDF_MAX_BYTES = 30 * 1024 * 1024;
export const PDF_MAX_PAGES = 2000;

export const PAGE_MARKER = /^\[\[page:(\d+)\|([^\]]*)\]\]$/;

export function pageMarker(sheet: number, label: string | null): string {
  return `[[page:${sheet}|${label ?? ''}]]`;
}

export type PdfLine = { text: string; x: number; right: number; y: number; size: number };

export type PdfTextItem = { str: string; x: number; y: number; width: number; height: number; hasEOL?: boolean };

export type PdfDocumentText = {
  title: string;
  byline: string | null;
  siteName: string | null;
  year: string | null;
  paragraphs: string[];
  pageCount: number;
  pageLabels: Array<string | null>;
  pageLabelSource: 'pdf-labels' | 'printed-numbers' | 'none';
  copyAllowed: boolean;
};

const CJK = '\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const CJK_GAP = new RegExp(`([${CJK}])[ \\t\\u00a0]+(?=[${CJK}])`, 'g');
const LATIN_END = /[A-Za-z0-9,;:)\].]$/;
const LATIN_START = /^[A-Za-z0-9(“"'‘[]/;

/** Remove the letter-spacing some PDFs put between Japanese characters ("本 稿 は" → "本稿は"). */
export function cleanCjkSpacing(text: string): string {
  return String(text ?? '').replace(CJK_GAP, '$1').replace(/[ \t ]{2,}/g, ' ').trim();
}

/** Group positioned text items into visual lines (top to bottom). */
export function itemsToLines(items: PdfTextItem[]): PdfLine[] {
  const rows: Array<{ y: number; size: number; items: PdfTextItem[] }> = [];
  for (const item of items) {
    if (!item.str) continue;
    const size = Math.max(1, item.height || 10);
    const row = rows.find(r => Math.abs(r.y - item.y) <= Math.min(r.size, size) * 0.45);
    if (row) { row.items.push(item); row.size = Math.max(row.size, size); }
    else rows.push({ y: item.y, size, items: [item] });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map(row => {
      const sorted = row.items.sort((a, b) => a.x - b.x);
      let text = '';
      let lastRight: number | null = null;
      for (const item of sorted) {
        const gap = lastRight === null ? 0 : item.x - lastRight;
        if (text && gap > row.size * 0.25 && !text.endsWith(' ') && !item.str.startsWith(' ')) text += ' ';
        text += item.str;
        lastRight = item.x + item.width;
      }
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      return { text: cleanCjkSpacing(text), x: first.x, right: last.x + last.width, y: row.y, size: row.size };
    })
    .filter(line => line.text);
}

const PAGE_NUMBER_LINE = /^[-－―–—\s]*(\d{1,4})[-－―–—\s]*$/;
const ROMAN_LINE = /^[-－―–—\s]*([ivxlcdm]{1,7}|[IVXLCDM]{1,7})[-－―–—\s]*$/;

export type PageNumberCandidate = { type: 'arabic' | 'roman'; value: number; text: string; line: number };

export function romanToNumber(text: string): number | null {
  if (!/^([ivxlcdm]+|[IVXLCDM]+)$/.test(text)) return null;
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  const chars = text.toLowerCase();
  for (let i = 0; i < chars.length; i++) {
    const value = values[chars[i]];
    const next = values[chars[i + 1]] ?? 0;
    total += value < next ? -value : value;
  }
  // reject non-canonical forms such as "iiii" or "vx"
  return total > 0 && numberToRoman(total) === chars ? total : null;
}

function numberToRoman(value: number): string {
  const table: Array<[number, string]> = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [n, r] of table) while (value >= n) { out += r; value -= n; }
  return out;
}

/**
 * Numbers that may be the printed page number: found in the outermost line at the top and at the
 * bottom of the page (where page numbers are printed), either alone ("- 57 -", "xii") or at the
 * start/end of a short running head ("28 日本語と日本文学").
 */
export function pageNumberCandidates(lines: PdfLine[]): PageNumberCandidate[] {
  if (!lines.length) return [];
  const edges = [...new Set([0, lines.length - 1])];
  const out: PageNumberCandidate[] = [];
  for (const i of edges) {
    const text = lines[i].text;
    const alone = PAGE_NUMBER_LINE.exec(text);
    if (alone) { out.push({ type: 'arabic', value: Number(alone[1]), text: alone[1], line: i }); continue; }
    const roman = ROMAN_LINE.exec(text);
    const romanValue = roman ? romanToNumber(roman[1]) : null;
    if (roman && romanValue) { out.push({ type: 'roman', value: romanValue, text: roman[1].toLowerCase(), line: i }); continue; }
    if (text.length > 60) continue;
    const tokens = text.split(/\s+/).filter(Boolean);
    for (const token of [tokens[0], tokens[tokens.length - 1]]) {
      if (token && /^\d{1,4}$/.test(token) && !out.some(c => c.line === i && c.value === Number(token))) out.push({ type: 'arabic', value: Number(token), text: token, line: i });
    }
  }
  return out;
}

/** Kept for compatibility: the page number printed alone at the top or bottom of the page. */
export function detectPrintedNumber(lines: PdfLine[]): { value: number; line: number } | null {
  const found = pageNumberCandidates(lines).find(c => c.type === 'arabic' && PAGE_NUMBER_LINE.test(lines[c.line].text));
  return found ? { value: found.value, line: found.line } : null;
}

/**
 * Longest chain of candidates whose values increase together with the page (one per page).
 * Stray numbers (years, figure numbers) rarely form a long chain, so the real page numbers win.
 */
export function longestIncreasingChain(perPage: Array<Array<{ value: number }>>): Array<{ page: number; value: number }> {
  const nodes: Array<{ page: number; value: number; length: number; prev: number }> = [];
  for (let page = 0; page < perPage.length; page++) {
    const added: typeof nodes = [];
    for (const candidate of perPage[page] ?? []) {
      let best = -1;
      for (let j = 0; j < nodes.length; j++) {
        const node = nodes[j];
        // strictly increasing; sheets without a number in between (plates, blank pages) are allowed,
        // but not a jump far beyond the sheets passed (a year such as 2008 in a footer)
        const step = candidate.value - node.value;
        if (step > 0 && step <= page - node.page + 20 && (best < 0 || node.length > nodes[best].length)) best = j;
      }
      added.push({ page, value: candidate.value, length: best < 0 ? 1 : nodes[best].length + 1, prev: best });
    }
    nodes.push(...added);
  }
  let end = -1;
  nodes.forEach((node, i) => { if (end < 0 || node.length > nodes[end].length) end = i; });
  const chain: Array<{ page: number; value: number }> = [];
  for (let i = end; i >= 0; i = nodes[i].prev) chain.unshift({ page: nodes[i].page, value: nodes[i].value });
  return chain;
}

/** Labels from a chain: the found pages, gaps filled only where the numbering runs on evenly, then onwards after the last one. */
function labelsFromChain(chain: Array<{ page: number; value: number }>, count: number, format: (n: number) => string, fillAfter: boolean, stopAt = count): Array<string | null> {
  const labels: Array<string | null> = Array(count).fill(null);
  chain.forEach((item, k) => {
    labels[item.page] = format(item.value);
    const next = chain[k + 1];
    if (next && next.value - item.value === next.page - item.page) {
      for (let p = item.page + 1; p < next.page; p++) labels[p] = format(item.value + (p - item.page));
    }
  });
  const last = chain[chain.length - 1];
  if (fillAfter && last) for (let p = last.page + 1; p < Math.min(count, stopAt); p++) labels[p] = format(last.value + (p - last.page));
  return labels;
}

/**
 * Printed page label for every PDF sheet.
 * 1) The PDF's own page labels, when they are not just 1..n.
 * 2) Otherwise the numbers printed on the pages: the longest increasing chain of arabic numbers
 *    (it must cover 30% of the sheets, and at least two), plus roman numerals for front matter
 *    (i, ii, …; at least three) before the first arabic page. Sheets before the first numbered
 *    sheet (covers) get no label.
 */
export function guessPageLabels(detected: Array<number | null | PageNumberCandidate[]>, pdfLabels: string[] | null): { labels: Array<string | null>; source: PdfDocumentText['pageLabelSource'] } {
  const count = detected.length;
  if (pdfLabels && pdfLabels.length === count && pdfLabels.some((label, i) => label !== String(i + 1))) {
    return { labels: pdfLabels.map(label => label || null), source: 'pdf-labels' };
  }
  const perPage: PageNumberCandidate[][] = detected.map(entry => (Array.isArray(entry) ? entry : entry === null ? [] : [{ type: 'arabic', value: entry, text: String(entry), line: -1 }]));
  const arabic = longestIncreasingChain(perPage.map(list => list.filter(c => c.type === 'arabic')));
  const arabicOk = arabic.length >= (count === 1 ? 1 : 2) && arabic.length >= count * 0.3;
  const firstArabic = arabicOk ? arabic[0].page : count;
  const roman = longestIncreasingChain(perPage.map((list, page) => (page < firstArabic ? list.filter(c => c.type === 'roman') : [])));
  const romanOk = roman.length >= 3;
  if (!arabicOk && !romanOk) return { labels: Array(count).fill(null), source: 'none' };
  const labels: Array<string | null> = Array(count).fill(null);
  if (romanOk) labelsFromChain(roman, count, numberToRoman, true, firstArabic).forEach((label, i) => { if (label) labels[i] = label; });
  if (arabicOk) labelsFromChain(arabic, count, String, true).forEach((label, i) => { if (label) labels[i] = label; });
  return { labels, source: 'printed-numbers' };
}

/** Shift every label so that `sheet` shows `printed` (user correction). Sheets before `sheet` keep no label. */
export function relabelPages(pageCount: number, sheet: number, printed: number): Array<string | null> {
  return Array.from({ length: pageCount }, (_, i) => (i + 1 >= sheet && printed + (i + 1 - sheet) > 0 ? String(printed + (i + 1 - sheet)) : null));
}

/**
 * Running heads/feet (journal or chapter name printed on many pages) are not part of the text.
 * An outermost line counts as one when the same text (numbers ignored) is on at least 3 pages
 * and on at least a quarter of them.
 */
export function findRunningHeads(pages: PdfLine[][]): Set<string> {
  const key = (text: string) => text.replace(/\d+/g, '#').replace(/\s+/g, '');
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const seen = new Set<string>();
    for (const i of new Set([0, lines.length - 1])) {
      if (!lines[i]) continue;
      const k = key(lines[i].text);
      if (k.replace(/#/g, '').length < 4 || seen.has(k)) continue;
      seen.add(k);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const repeated = new Set<string>();
  for (const [k, n] of counts) if (n >= 3 && n >= pages.length * 0.25) repeated.add(k);
  return repeated;
}

export function isRunningHead(text: string, heads: Set<string>): boolean {
  return heads.has(text.replace(/\d+/g, '#').replace(/\s+/g, ''));
}

const HEADING = /^(\d+(\.\d+)*\.?\s|[0-9０-９]+[.．]\s?|第.{1,4}[章節]|[（(][0-9０-９a-z]{1,3}[)）]|[•・●■◆]|\d+\)\s?|【)/;

/** Rebuild paragraphs from lines: a short line, an indented next line or a numbered heading starts a new paragraph. */
export function linesToParagraphs(lines: PdfLine[]): string[] {
  if (!lines.length) return [];
  const lefts = lines.map(l => Math.round(l.x));
  const leftCounts = new Map<number, number>();
  lefts.forEach(x => leftCounts.set(x, (leftCounts.get(x) ?? 0) + 1));
  const left = [...leftCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const rights = lines.map(l => l.right).sort((a, b) => a - b);
  const right = rights[Math.floor((rights.length - 1) * 0.9)];
  const paragraphs: string[] = [];
  let current = '';
  const flush = () => { const text = cleanCjkSpacing(current); if (text) paragraphs.push(text); current = ''; };
  lines.forEach((line, i) => {
    const next = lines[i + 1];
    if (current && HEADING.test(line.text)) flush();
    if (!current) current = line.text;
    else if (current.endsWith('-') && /^[a-z]/.test(line.text)) current += line.text; // keep hyphenated words joined
    else current += LATIN_END.test(current) && LATIN_START.test(line.text) ? ` ${line.text}` : line.text;
    const short = line.right < right - line.size * 1.5;
    const indentedNext = next ? next.x > left + next.size * 0.8 && Math.abs(next.x - line.x) > next.size * 0.5 : false;
    const bigGap = next ? line.y - next.y > Math.max(line.size, next.size) * 2.2 : false;
    if (!next || short || indentedNext || bigGap) flush();
  });
  return paragraphs;
}

function guessTitle(metaTitle: string | null, firstPage: PdfLine[]): string {
  const meta = (metaTitle ?? '').trim();
  const looksGenerated = !meta || /^(microsoft\s+word\s*-|untitled)/i.test(meta) || /\.(docx?|pdf|tex|indd)$/i.test(meta);
  if (!looksGenerated) return meta;
  const body = firstPage.filter(l => !PAGE_NUMBER_LINE.test(l.text) && l.text.length >= 4);
  if (!body.length) return meta.replace(/^microsoft\s+word\s*-\s*/i, '') || '無題のPDF';
  const max = Math.max(...body.map(l => l.size));
  const title = body.filter(l => l.size >= max * 0.95).slice(0, 2).map(l => l.text).join(' ');
  return title.slice(0, 200);
}

/** Year and journal/book title from the first page ("(2008)", "1999年", 『英語教育研究』). Only a hint for the user to confirm. */
export function guessBibliographicHints(firstPageText: string): { year: string | null; siteName: string | null } {
  const year = /(?:\(|（)\s*((?:19|20)\d{2})\s*(?:\)|）)|((?:19|20)\d{2})\s*年/.exec(firstPageText);
  const journal = /『([^』]{1,80})』/.exec(firstPageText);
  return { year: year ? (year[1] ?? year[2]) : null, siteName: journal ? journal[1].trim() : null };
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<{ pdfjs: PdfJs; root: string }> | null = null;
function loadPdfJs() {
  pdfjsPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const pdfjs = (await import(pathToFileURL(path.join(root, 'legacy/build/pdf.mjs')).href)) as PdfJs;
    return { pdfjs, root };
  })();
  return pdfjsPromise;
}

export class PdfReadError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Extract page-tagged paragraphs from PDF bytes. */
export async function extractPdf(bytes: Uint8Array): Promise<PdfDocumentText> {
  if (bytes.byteLength > PDF_MAX_BYTES) throw new PdfReadError('PDF is too large (max 30MB)', 413);
  const { pdfjs, root } = await loadPdfJs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: bytes,
      cMapUrl: path.join(root, 'cmaps') + path.sep,
      cMapPacked: true,
      standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === 'PasswordException') throw new PdfReadError('Password-protected PDFs cannot be read', 422);
    throw new PdfReadError('This file could not be read as a PDF', 422);
  }
  try {
    if (doc.numPages > PDF_MAX_PAGES) throw new PdfReadError(`PDF has too many pages (max ${PDF_MAX_PAGES})`, 413);
    const permissions = await doc.getPermissions();
    const copyAllowed = !permissions || permissions.includes(pdfjs.PermissionFlag.COPY);
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as { Title?: string; Author?: string };
    const pdfLabels = await doc.getPageLabels().catch(() => null);

    const pages: PdfLine[][] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        items.push({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height || Math.abs(item.transform[3]), hasEOL: item.hasEOL });
      }
      pages.push(itemsToLines(items));
      page.cleanup();
    }
    const candidates = pages.map(lines => pageNumberCandidates(lines));
    const { labels, source } = guessPageLabels(candidates, pdfLabels);
    const heads = findRunningHeads(pages);

    const paragraphs: string[] = [];
    pages.forEach((lines, i) => {
      paragraphs.push(pageMarker(i + 1, labels[i]));
      const edge = new Set([0, lines.length - 1]);
      // Drop the page number and running heads printed at the top/bottom; they are not part of the text.
      const body = lines.filter((line, at) => !(edge.has(at) && (
        PAGE_NUMBER_LINE.test(line.text)
        || (ROMAN_LINE.test(line.text) && labels[i] !== null && ROMAN_LINE.exec(line.text)![1].toLowerCase() === labels[i])
        || isRunningHead(line.text, heads)
      )));
      paragraphs.push(...linesToParagraphs(body));
    });
    const textCount = paragraphs.filter(p => !PAGE_MARKER.test(p)).join('').length;
    if (textCount < 20) throw new PdfReadError('No text could be found in this PDF (it may be a scan without a text layer)', 422);

    const firstText = (pages[0] ?? []).map(l => l.text).join('\n') + '\n' + (pages[1] ?? []).map(l => l.text).join('\n');
    const hints = guessBibliographicHints(firstText);
    const author = (info.Author ?? '').trim();
    return {
      title: guessTitle(info.Title ?? null, pages[0] ?? []),
      byline: author || null,
      siteName: hints.siteName,
      year: hints.year,
      paragraphs,
      pageCount: doc.numPages,
      pageLabels: labels,
      pageLabelSource: source,
      copyAllowed,
    };
  } finally {
    await doc.destroy();
  }
}
