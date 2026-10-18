/**
 * Reader: fetch an article page and extract its readable text without AI.
 *
 * Why: collected candidates only keep RSS snippets, so a saved card loses the
 * article it came from, and the original opens in another tab, so the user
 * cannot read and take notes side by side. This service keeps a copy of the
 * readable text (personal use) together with the user's memo and the source.
 *
 * Extraction is deterministic (Mozilla Readability rules), so the same HTML
 * always yields the same text and no tokens are spent.
 */
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { PdfReadError, extractPdf, pdfMaxBytes } from './pdf_service.js';
import { assertPublicUrl, safeFetch, SafeFetchError } from './safe_fetch.js';

export const READER_MAX_HTML_BYTES = 3 * 1024 * 1024;
export const READER_TIMEOUT_MS = 10_000;
/**
 * Card bodies are limited to 20,000 chars by the existing card schema, so the card keeps
 * only the beginning of the text; the full text is kept separately (reader_texts).
 */
export const CARD_BODY_LIMIT = 20_000;
/** Long PDFs (books) may be slow to download. */
export const READER_PDF_TIMEOUT_MS = 60_000;

export class ReaderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type ReadableArticle = {
  url: string | null;
  title: string;
  byline: string | null;
  siteName: string | null;
  paragraphs: string[];
  fetchedAt: string;
  /** PDF only */
  kind?: 'html' | 'pdf';
  fileName?: string | null;
  year?: string | null;
  pageCount?: number;
  pageLabelSource?: 'pdf-labels' | 'printed-numbers' | 'none';
  copyAllowed?: boolean;
};

/** PDF bytes → the same shape as an article, with page markers in the paragraphs. */
export async function readPdf(bytes: Uint8Array, source: { url: string | null; fileName: string | null }, fetchedAt = new Date().toISOString()): Promise<ReadableArticle> {
  try {
    const pdf = await extractPdf(bytes);
    return {
      kind: 'pdf',
      url: source.url,
      fileName: source.fileName,
      title: pdf.title || source.fileName || 'PDF',
      // PDF "Author" metadata is often a login name ("tmogi"); only offer it when it looks like a name.
      byline: pdf.byline && /[\s\u3040-\u9fff]/.test(pdf.byline) ? pdf.byline : null,
      siteName: pdf.siteName,
      year: pdf.year,
      paragraphs: pdf.paragraphs,
      fetchedAt,
      pageCount: pdf.pageCount,
      pageLabelSource: pdf.pageLabelSource,
      copyAllowed: pdf.copyAllowed,
    };
  } catch (error) {
    if (error instanceof PdfReadError) throw new ReaderError(error.message, error.status);
    throw error;
  }
}

/** URL syntax check; the production transport also validates and pins DNS addresses. */
export function assertFetchableUrl(raw: string): URL {
  try { return assertPublicUrl(raw); }
  catch (error) { throw new ReaderError((error as Error).message, 400); }
}

const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, pre, blockquote';
const BARE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
export const IMAGE_LINE = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/;

function toImageLine(image: Element, base: string): string | null {
  const raw = image.getAttribute('src') || image.getAttribute('data-src');
  if (!raw || raw.startsWith('data:')) return null;
  let src: URL;
  try {
    src = new URL(raw, base);
  } catch {
    return null;
  }
  if (src.protocol !== 'http:' && src.protocol !== 'https:') return null;
  const alt = (image.getAttribute('alt') ?? '').replace(/[\[\]\n]/g, ' ').trim();
  return `![${alt}](${src.href.replace(/\)/g, '%29').replace(/\s/g, '%20')})`;
}

/** Pure function: HTML in, readable paragraphs out. */
export function extractReadable(html: string, url: string, fetchedAt = new Date().toISOString()): ReadableArticle {
  const dom = new JSDOM(html, { url });
  // Ruby readings (<rt>/<rp>, common in Aozora Bunko) would be glued into the text; keep the base text only.
  dom.window.document.querySelectorAll('rt, rp').forEach(node => node.remove());
  // Character images (Aozora Bunko "gaiji", or tiny inline glyph images) belong inside the sentence:
  // replace them with their alt text instead of turning them into separate image lines.
  for (const img of Array.from(dom.window.document.querySelectorAll('img'))) {
    const tiny = Number(img.getAttribute('width')) > 0 && Number(img.getAttribute('width')) <= 32 && Number(img.getAttribute('height') || 0) <= 32;
    if (img.classList.contains('gaiji') || tiny) img.replaceWith(dom.window.document.createTextNode(img.getAttribute('alt') ?? ''));
  }
  const parsed = new Readability(dom.window.document).parse();
  if (!parsed || !parsed.content) throw new ReaderError('No readable article text was found on this page', 422);

  const content = new JSDOM(parsed.content).window.document;
  const paragraphs: string[] = [];
  for (const element of Array.from(content.querySelectorAll(`${BLOCK_SELECTOR}, img`))) {
    if (element.tagName === 'IMG') {
      // Images are kept as Markdown links to the original (the image file itself is not copied).
      const image = toImageLine(element, url);
      if (image) paragraphs.push(image);
      continue;
    }
    // Skip containers whose text is already captured by a nested block (e.g. <li><p>..</p></li>).
    if (element.querySelector(BLOCK_SELECTOR)) continue;
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    // Embedded link cards (e.g. Hatena's blog cards) leave only the linked site's name, such as
    // "techblog.zozo.com", as a paragraph of its own. That is not part of the article text.
    if (BARE_HOST.test(text) && Array.from(element.querySelectorAll('a')).some(link => (link.textContent ?? '').trim() === text)) continue;
    if (text) paragraphs.push(text);
  }
  if (!paragraphs.some(p => !IMAGE_LINE.test(p))) {
    const fallback = (parsed.textContent ?? '').split(/\n\s*\n/).map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
    paragraphs.push(...fallback);
  }
  if (paragraphs.length === 0) throw new ReaderError('No readable article text was found on this page', 422);

  return {
    url,
    title: (parsed.title ?? '').trim() || url,
    byline: parsed.byline?.trim() || null,
    siteName: parsed.siteName?.trim() || null,
    paragraphs,
    fetchedAt,
  };
}

/**
 * Decode HTML bytes with the page's own charset (e.g. Aozora Bunko is Shift_JIS).
 * Order: Content-Type header -> <meta charset> / http-equiv in the first bytes -> UTF-8.
 */
export function decodeHtml(bytes: Uint8Array, contentType = ''): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  for (const label of [fromHeader, fromMeta, 'utf-8']) {
    if (!label) continue;
    try {
      return new TextDecoder(label.toLowerCase()).decode(bytes);
    } catch {
      // unknown label: try the next candidate
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Fetch a public page (with timeout and size limit) and extract it. */
export async function fetchReadable(raw: string, fetchImpl?: typeof fetch): Promise<ReadableArticle> {
  const url = assertFetchableUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READER_PDF_TIMEOUT_MS);
  try {
    // Optional transport is for deterministic tests; production always uses DNS-pinned fetching.
    let response: Response;
    let finalUrl = url.toString();
    if (fetchImpl) {
      response = await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
      if (response.url) finalUrl = assertFetchableUrl(response.url).toString();
    } else {
      const fetched = await safeFetch(url, { timeoutMs: READER_PDF_TIMEOUT_MS, maxBytes: Math.max(pdfMaxBytes(), READER_MAX_HTML_BYTES),
        allowedContentTypes: /(?:text\/html|application\/xhtml\+xml|application\/pdf)/i,
        contentTypeLimits: [{ pattern: /html/i, maxBytes: READER_MAX_HTML_BYTES }], retries: 0 });
      finalUrl = fetched.url;
      response = new Response(new Uint8Array(fetched.bytes), { status: fetched.status, headers: { 'content-type': fetched.contentType } });
    }
    if (!response.ok) throw new ReaderError(`The page returned HTTP ${response.status}`, 502);
    const type = response.headers.get('content-type') ?? '';
    if (/application\/pdf/i.test(type)) {
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > pdfMaxBytes()) throw new ReaderError(`PDF is too large (max ${Math.round(pdfMaxBytes() / 1024 / 1024)}MB)`, 413);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return await readPdf(bytes, { url: finalUrl, fileName: decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || '') || null });
    }
    if (!/html/i.test(type)) throw new ReaderError('The page is not HTML or PDF', 415);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > READER_MAX_HTML_BYTES) throw new ReaderError('The page is too large to read', 413);
    return extractReadable(decodeHtml(bytes, type), finalUrl);
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    if (error instanceof SafeFetchError) throw new ReaderError(error.message,
      error.code === 'blocked' || error.code === 'invalid_url' ? 400 : error.code === 'too_large' ? 413 : error.code === 'timeout' ? 504 : error.status === 415 ? 415 : 502);
    if ((error as Error).name === 'AbortError') throw new ReaderError('Fetching the page timed out', 504);
    throw new ReaderError('The page could not be fetched', 502);
  } finally {
    clearTimeout(timer);
  }
}

export type ReaderCardInput = {
  memo: string;
  source: Pick<ReadableArticle, 'title' | 'url' | 'byline' | 'siteName' | 'fetchedAt'> & { year?: string | null; fileName?: string | null };
  paragraphs: string[];
  /** Japanese machine translation aligned to paragraphs (null = not translated). */
  translation?: { from: string; engine: string; paragraphs: Array<string | null> } | null;
};

export const TRANSLATION_ENGINES: Record<string, string> = { 'chrome-translator': 'Chrome内蔵の翻訳' };

/**
 * One card keeps three things together: the memo, where it came from, and a
 * copy of what was read. The copy is cut to fit the card body limit.
 */
export function composeReaderCardBody({ memo, source, paragraphs, translation }: ReaderCardInput): string {
  const sourceLines = [
    `- タイトル: ${source.title}`,
    source.url ? `- URL: ${source.url}` : null,
    source.fileName ? `- ファイル: ${source.fileName}` : null,
    source.siteName ? `- サイト: ${source.siteName}` : null,
    source.byline ? `- 著者: ${source.byline}` : null,
    source.year ? `- 発行年: ${source.year}` : null,
    `- 取得日時: ${source.fetchedAt}`,
    translation ? `- 日本語訳: 機械翻訳（${TRANSLATION_ENGINES[translation.engine] ?? translation.engine}、${translation.from}→ja）` : null,
  ].filter(Boolean).join('\n');
  const head = `## メモ\n\n${memo.trim() || '（なし）'}\n\n## 出典\n\n${sourceLines}${TEXT_HEAD}`;
  const fullText = paragraphs.join('\n\n');
  const translatedText = translation ? translation.paragraphs.filter((text): text is string => !!text && !!text.trim()).join('\n\n') : '';
  const room = CARD_BODY_LIMIT - head.length;
  if (!translatedText) return head + fitText(fullText, room, '本文');
  // The translation goes into the card too, so the article is found by Japanese words when searching cards.
  const textRoom = Math.max(Math.floor(room * 0.55), room - TRANSLATION_HEAD.length - translatedText.length);
  const text = fitText(fullText, textRoom, '本文');
  return head + text + TRANSLATION_HEAD + fitText(translatedText, room - text.length - TRANSLATION_HEAD.length, '日本語訳');
}

function fitText(text: string, room: number, label: string): string {
  if (text.length <= room) return text;
  const note = `\n\n（以下省略：${label}は全${text.length}文字。カードの上限のため途中まで保存）`;
  return text.slice(0, Math.max(0, room - note.length)) + note;
}

export type ParsedReaderCard = {
  isReaderFormat: boolean;
  memo: string;
  source: { title: string | null; url: string | null; siteName: string | null; byline: string | null; fetchedAt: string | null; year: string | null; fileName: string | null };
  paragraphs: string[];
};

const MEMO_HEAD = '## メモ\n\n';
const SOURCE_HEAD = '\n\n## 出典\n\n';
const TEXT_HEAD = '\n\n## 本文（取得時点のコピー・私的利用）\n\n';
const TRANSLATION_HEAD = '\n\n## 日本語訳（機械翻訳・私的利用）\n\n';

function textPart(rest: string): string {
  const at = rest.indexOf(TRANSLATION_HEAD);
  return at < 0 ? rest : rest.slice(0, at);
}

/** Inverse of composeReaderCardBody. Cards in any other format are treated as memo only. */
export function parseReaderCardBody(body: string): ParsedReaderCard {
  const empty = { title: null, url: null, siteName: null, byline: null, fetchedAt: null, year: null, fileName: null };
  const sourceAt = body.indexOf(SOURCE_HEAD);
  const textAt = body.indexOf(TEXT_HEAD);
  if (!body.startsWith(MEMO_HEAD) || sourceAt < 0 || textAt < sourceAt) {
    return { isReaderFormat: false, memo: body, source: empty, paragraphs: [] };
  }
  const memo = body.slice(MEMO_HEAD.length, sourceAt);
  const field = (name: string) => new RegExp(`^- ${name}: (.*)$`, 'm').exec(body.slice(sourceAt, textAt))?.[1]?.trim() ?? null;
  return {
    isReaderFormat: true,
    memo: memo === '（なし）' ? '' : memo,
    source: { title: field('タイトル'), url: field('URL'), siteName: field('サイト'), byline: field('著者'), fetchedAt: field('取得日時'), year: field('発行年'), fileName: field('ファイル') },
    paragraphs: textPart(body.slice(textAt + TEXT_HEAD.length)).split(/\n\n/).filter(Boolean),
  };
}
