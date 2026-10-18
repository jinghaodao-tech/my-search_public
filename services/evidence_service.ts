// Evidence table: the AI proposes "claim ↔ quote" rows for a purpose; the app
// checks every quote against the saved text without AI.
//
// Split of work (the reason for this design):
//   AI     — reads many paragraphs and picks what supports / contradicts the purpose
//            (understanding meaning; a person cannot do this fast for many sources).
//   no AI  — whether the quote really exists in the saved copy, where it is (paragraph,
//            PDF sheet, printed page), and the exact wording that is put into the memo.
//            This must give the same answer every time and be explainable, so it is a
//            plain string match. The AI never decides the page, and a row whose quote is
//            not found is never put into the memo.
//
// Quotation rules followed here (see docs: citation conventions):
//   - the quote is copied word for word from the source (layout spaces/line breaks only are tidied);
//   - every quote carries its location (p. / pp. for PDFs with printed page numbers);
//   - a passage that is itself a quotation of another work is flagged (secondary citation, 孫引き);
//   - long quotations are flagged (quote only what is needed).

export type EvidenceSource = { id: string; title: string; url?: string | null; paragraphs: string[] };

export type ProposedRow = { claim: string; quote: string; source: string; secondary?: boolean };

export type QuoteLocation = {
  paragraphIndex: number; // 0-based index into the source paragraphs (start)
  endParagraphIndex: number;
  sheetStart: number | null; // PDF sheet (1-based), null for articles
  sheetEnd: number | null;
  pageStart: string | null; // printed page label, null if unknown
  pageEnd: string | null;
  text: string; // the exact wording taken from the source
};

export type VerifiedRow = QuoteLocation & {
  claim: string;
  quote: string; // = text from the source, not the AI's wording
  sourceId: string;
  sourceTitle: string;
  location: string | null; // "p. 57", "pp. 57–58", "PDF 3枚目"
  secondary: boolean; // the passage quotes another work (孫引きの可能性)
  long: boolean; // longer than a short quotation
};

export type RejectedRow = { claim: string; quote: string; reason: 'not_found' | 'too_short' | 'invalid' };

export type EvidenceResult = { rows: VerifiedRow[]; rejected: RejectedRow[]; chunks: number };

export const EVIDENCE_MAX_ROWS = 12;
export const EVIDENCE_ROWS_PER_CALL = 8;
export const EVIDENCE_CHUNK_CHARS = 50000;
export const EVIDENCE_MAX_CHUNKS = 12;
export const EVIDENCE_MIN_QUOTE_CHARS = 8;
export const LONG_QUOTE_CHARS = 200; // Japanese text
export const LONG_QUOTE_WORDS = 40; // English text (APA: 40 words or more is a block quotation)

const IMAGE_LINE = /^!\[[^\]]*\]\(https?:\/\/[^\s)]+\)$/;
export const PAGE_MARKER = /^\[\[page:(\d+)\|([^\]]*)\]\]$/;

function isText(paragraph: string): boolean {
  return !!paragraph.trim() && !IMAGE_LINE.test(paragraph) && !PAGE_MARKER.test(paragraph);
}

/** Per-character fold used only for matching: NFKC, no whitespace, dash and quote variants unified. */
function foldChar(char: string): string {
  return char.normalize('NFKC').replace(/\s+/g, '').replace(/[‐‑‒–—―－]/g, '-').replace(/[“”＂]/g, '"').replace(/[‘’＇]/g, "'");
}

/** Form used only for matching: width/compatibility folded, all whitespace removed. */
export function normalizeForMatch(text: string): string {
  let out = '';
  for (const char of String(text ?? '')) out += foldChar(char);
  return out;
}

/** Remove wrapping quote marks and trailing ellipses that models often add around a quote. */
export function cleanQuote(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/^[「『"“'‘]+/, '')
    .replace(/[」』"”'’]+$/, '')
    .replace(/(…|\.\.\.)+$/, '')
    .replace(/^(…|\.\.\.)+/, '')
    .trim();
}

const CJK = '\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const CJK_GAP = new RegExp(`([${CJK}])[ \\t\\u00a0]+(?=[${CJK}])`, 'g');

/** Join pieces of the source text that crossed a paragraph/page break, without changing the wording. */
function joinPieces(pieces: string[]): string {
  let out = '';
  for (const piece of pieces) {
    if (!out) { out = piece; continue; }
    out += /[A-Za-z0-9,.;:)]$/.test(out) && /^[A-Za-z0-9(]/.test(piece) ? ` ${piece}` : piece;
  }
  return out.replace(CJK_GAP, '$1').replace(/\s+/g, ' ').trim();
}

type SourceIndex = {
  folded: string;
  map: Array<{ p: number; o: number }>; // folded char → paragraph index, char offset in that paragraph
  pageOf: Array<{ sheet: number; label: string | null } | null>; // per paragraph
};

export function buildSourceIndex(source: EvidenceSource): SourceIndex {
  let folded = '';
  const map: SourceIndex['map'] = [];
  const pageOf: SourceIndex['pageOf'] = [];
  let page: { sheet: number; label: string | null } | null = null;
  source.paragraphs.forEach((paragraph, p) => {
    const marker = PAGE_MARKER.exec(paragraph);
    if (marker) page = { sheet: Number(marker[1]), label: marker[2] || null };
    pageOf.push(page);
    if (!isText(paragraph)) return;
    let o = 0;
    for (const char of paragraph) {
      const f = foldChar(char);
      for (const c of f) { folded += c; map.push({ p, o }); }
      o += char.length;
    }
  });
  return { folded, map, pageOf };
}

/** Find the quote in one source (across paragraph and page breaks). */
export function locateInSource(quote: string, source: EvidenceSource, index = buildSourceIndex(source)): (QuoteLocation & { secondaryHint: boolean }) | null {
  const needle = normalizeForMatch(quote);
  if (!needle) return null;
  const at = index.folded.indexOf(needle);
  if (at < 0) return null;
  const start = index.map[at];
  const end = index.map[at + needle.length - 1];
  const pieces: string[] = [];
  for (let p = start.p; p <= end.p; p++) {
    const paragraph = source.paragraphs[p];
    if (!isText(paragraph)) continue;
    const from = p === start.p ? start.o : 0;
    const lastChar = p === end.p ? end.o + (paragraph.codePointAt(end.o)! > 0xffff ? 2 : 1) : paragraph.length;
    pieces.push(paragraph.slice(from, lastChar));
  }
  const first = index.pageOf[start.p];
  const last = index.pageOf[end.p];
  return {
    paragraphIndex: start.p,
    endParagraphIndex: end.p,
    sheetStart: first?.sheet ?? null,
    sheetEnd: last?.sheet ?? null,
    pageStart: first?.label ?? null,
    pageEnd: last?.label ?? null,
    text: joinPieces(pieces),
    secondaryHint: citationFollows(index, at + needle.length) || exampleWithCitation(source, index, start.p, at + needle.length),
  };
}

/** "p. 57" / "pp. 57–58"; without printed numbers "PDF 3枚目"; null for articles. */
export function formatLocation(location: Pick<QuoteLocation, 'sheetStart' | 'sheetEnd' | 'pageStart' | 'pageEnd'>): string | null {
  if (location.sheetStart === null) return null;
  if (location.pageStart && location.pageEnd) {
    return location.pageStart === location.pageEnd ? `p. ${location.pageStart}` : `pp. ${location.pageStart}–${location.pageEnd}`;
  }
  return location.sheetStart === location.sheetEnd ? `PDF ${location.sheetStart}枚目` : `PDF ${location.sheetStart}–${location.sheetEnd}枚目`;
}

// A citation right after the passage (or right after the closing quote mark the passage is in),
// e.g. "(p. 25)", "（沼田 (1986), p.108）", "「…」(p.135)", "(Smith, 2001)".
const CITATION_AFTER = /^(?:[^「」『』（）()]{0,60}?[」』"”'])?[^（）()]{0,3}[（(](?:[^（）()]|[（(][^（）()]{0,12}[)）]){0,40}?(?:(?:19|20)\d{2}|p\.?\d+)[^（）()]{0,30}[)）]/;

/**
 * Is the passage followed by a citation in the same paragraph? Then the passage is itself a
 * quotation of another work, and quoting it from here would be a secondary citation (孫引き).
 */
function citationFollows(index: SourceIndex, end: number): boolean {
  if (end <= 0 || end > index.map.length) return false;
  const paragraph = index.map[end - 1].p;
  let stop = end;
  while (stop < index.map.length && index.map[stop].p === paragraph && stop - end < 80) stop++;
  return CITATION_AFTER.test(index.folded.slice(end, stop));
}

const CITATION_AT_END = /[（(](?:[^（）()]|[（(][^（）()]{0,12}[)）]){0,40}?(?:(?:19|20)\d{2}|p\.?\d+)[^（）()]{0,30}[)）][。.]?$/;
const EXAMPLE_HEAD = /^\s*[（(][0-9０-９]+['’]?[)）]/;

/** A numbered example "(1) …" that ends with a citation is a quotation of another work (common in linguistics). */
function exampleWithCitation(source: EvidenceSource, index: SourceIndex, startParagraph: number, end: number): boolean {
  if (!EXAMPLE_HEAD.test(source.paragraphs[startParagraph] ?? '')) return false;
  const paragraph = index.map[end - 1]?.p;
  let stop = end;
  while (stop < index.map.length && index.map[stop].p === paragraph) stop++;
  return stop - end <= 300 && CITATION_AT_END.test(index.folded.slice(end, stop));
}

export function isLongQuote(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  const latin = (text.match(/[A-Za-z]/g) ?? []).length > text.length * 0.5;
  return latin ? words.length >= LONG_QUOTE_WORDS : text.replace(/\s+/g, '').length > LONG_QUOTE_CHARS;
}

/** Paragraph chunks sent to the model: "[S1-3] text" (1-based), images and page markers left out. */
export function chunkSources(sources: EvidenceSource[], chunkChars = EVIDENCE_CHUNK_CHARS): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let used = 0;
  sources.forEach((source, s) => {
    current.push(`### S${s + 1}: ${source.title}`);
    source.paragraphs.forEach((paragraph, p) => {
      if (!isText(paragraph)) return;
      const line = `[S${s + 1}-${p + 1}] ${paragraph}`;
      if (used + line.length > chunkChars && used > 0) {
        chunks.push(current);
        current = [`### S${s + 1}: ${source.title}（続き）`];
        used = 0;
      }
      current.push(line.slice(0, chunkChars));
      used += Math.min(line.length, chunkChars);
    });
  });
  if (used > 0) chunks.push(current);
  return chunks;
}

export function buildEvidencePrompt(purpose: string, chunk: string[]): string {
  return [
    'あなたは資料読みの補助です。利用者の「目的」に関係する主張と、その根拠になる本文の一節を抜き出してください。',
    '',
    '規則:',
    '- quote は本文の一節を一字一句そのまま写すこと（言い換え・要約・省略・つなぎ合わせは禁止）。200字以内。',
    '- claim はその一節から言えることを、目的に照らして30〜80字の日本語で書く。',
    '- source は一節を取った資料の番号（"S1" など）。',
    '- その一節が、著者自身の文ではなく他の文献からの引用であれば secondary を true にする。',
    `- 最大${EVIDENCE_ROWS_PER_CALL}行。目的に関係するものだけ。反対の立場や限界を示す一節があれば含める。`,
    '- 該当がなければ空配列 []。',
    '- 出力は JSON 配列のみ。説明文やコードブロックは付けない。',
    '  例: [{"claim":"...","quote":"...","source":"S1","secondary":false}]',
    '',
    `目的: ${purpose}`,
    '',
    '資料:',
    chunk.join('\n'),
  ].join('\n');
}

/** Parse the model's answer. Anything that is not a well-formed row is dropped. */
export function parseProposedRows(text: string): ProposedRow[] {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(item => ({ claim: String(item.claim ?? '').trim(), quote: String(item.quote ?? '').trim(), source: String(item.source ?? '').trim(), secondary: item.secondary === true }))
    .filter(row => row.claim || row.quote)
    .slice(0, EVIDENCE_ROWS_PER_CALL * 2);
}

/** Deterministic check of every proposed row. Same input → same output, no AI involved. */
export function verifyRows(proposed: ProposedRow[], sources: EvidenceSource[]): { rows: VerifiedRow[]; rejected: RejectedRow[] } {
  const indexes = sources.map(source => buildSourceIndex(source));
  const rows: VerifiedRow[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Set<string>();
  for (const row of proposed) {
    const quote = cleanQuote(row.quote);
    const claim = row.claim.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!claim || !quote) { rejected.push({ claim, quote, reason: 'invalid' }); continue; }
    if (normalizeForMatch(quote).length < EVIDENCE_MIN_QUOTE_CHARS) { rejected.push({ claim, quote, reason: 'too_short' }); continue; }
    const preferred = Number(/^S(\d+)$/i.exec(row.source)?.[1] ?? 0) - 1;
    const order = [preferred, ...sources.map((_, i) => i).filter(i => i !== preferred)].filter(i => i >= 0 && i < sources.length);
    let found: { s: number; location: QuoteLocation & { secondaryHint: boolean } } | null = null;
    for (const s of order) {
      const location = locateInSource(quote, sources[s], indexes[s]);
      if (location) { found = { s, location }; break; }
    }
    if (!found) { rejected.push({ claim, quote, reason: 'not_found' }); continue; }
    const key = `${found.s}:${normalizeForMatch(found.location.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { secondaryHint, ...location } = found.location;
    rows.push({
      ...location,
      claim,
      quote: location.text,
      sourceId: sources[found.s].id,
      sourceTitle: sources[found.s].title,
      location: formatLocation(location),
      secondary: !!row.secondary || secondaryHint,
      long: isLongQuote(location.text),
    });
    if (rows.length >= EVIDENCE_MAX_ROWS) break;
  }
  return { rows, rejected };
}

/** Offline stand-in for the model (MOCK_AI_SUMMARY=true): picks paragraphs that share words with the purpose. */
export function mockProposeRows(purpose: string, sources: EvidenceSource[]): ProposedRow[] {
  const words = purpose.normalize('NFKC').split(/[\s、。,.・/]+/).filter(word => word.length >= 2);
  const out: ProposedRow[] = [];
  sources.forEach((source, s) => {
    const texts = source.paragraphs.filter(isText);
    const hits = texts.filter(text => words.some(word => text.normalize('NFKC').includes(word)));
    for (const text of (hits.length ? hits : texts).slice(0, 2)) {
      const sentence = (text.match(/^[^。！？!?]*[。！？!?]?/)?.[0] ?? text).slice(0, 120);
      out.push({ claim: `（試験用の応答）${sentence.slice(0, 40)}`, quote: sentence, source: `S${s + 1}` });
    }
  });
  return out.slice(0, EVIDENCE_ROWS_PER_CALL);
}

/**
 * Long documents (books) are sent in chunks, one AI call each (at most EVIDENCE_MAX_CHUNKS).
 * Every proposed row is then verified against the whole text.
 */
export async function buildEvidenceTable(
  purpose: string,
  sources: EvidenceSource[],
  complete: (prompt: string, maxTokens: number) => Promise<string>,
  mock = false,
): Promise<EvidenceResult> {
  if (mock) return { ...verifyRows(mockProposeRows(purpose, sources), sources), chunks: 1 };
  const chunks = chunkSources(sources).slice(0, EVIDENCE_MAX_CHUNKS);
  const proposed: ProposedRow[] = [];
  for (const chunk of chunks) proposed.push(...parseProposedRows(await complete(buildEvidencePrompt(purpose, chunk), 2000)));
  return { ...verifyRows(proposed, sources), chunks: chunks.length };
}

/**
 * Without any AI: the sentences that share the most (rarer) words with the purpose.
 * A BM25-style score over sentences — idf across all sentences, saturated term frequency.
 * The "claim" column names the matched words; the person writes their own reading.
 */
export async function pickPassagesByWords(
  purpose: string,
  sources: EvidenceSource[],
  tokenizer: (text: string) => Promise<string[]>,
  max = EVIDENCE_ROWS_PER_CALL,
): Promise<ProposedRow[]> {
  const queryTerms = [...new Set(await tokenizer(purpose))];
  if (queryTerms.length === 0) return [];
  type Sentence = { text: string; source: number; terms: Map<string, number> };
  const sentences: Sentence[] = [];
  for (const [s, source] of sources.entries()) {
    for (const paragraph of source.paragraphs.filter(isText)) {
      for (const raw of paragraph.match(/[^。！？!?]+[。！？!?]?|[^。！？!?]+$/g) ?? []) {
        const text = raw.trim();
        if (text.length < EVIDENCE_MIN_QUOTE_CHARS || text.length > 300) continue;
        const counts = new Map<string, number>();
        for (const token of await tokenizer(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
        sentences.push({ text, source: s, terms: counts });
      }
    }
  }
  const n = sentences.length;
  const idf = new Map(queryTerms.map(term => {
    const df = sentences.filter(sentence => sentence.terms.has(term)).length;
    return [term, Math.log(1 + (n - df + 0.5) / (df + 0.5))];
  }));
  const scored = sentences.map(sentence => {
    const matched = queryTerms.filter(term => sentence.terms.has(term));
    const score = matched.reduce((sum, term) => {
      const tf = sentence.terms.get(term)!;
      return sum + idf.get(term)! * (tf * 2.2) / (tf + 1.2);
    }, 0);
    return { sentence, matched, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.sentence.text.length - b.sentence.text.length);
  const out: ProposedRow[] = [];
  const seen = new Set<string>();
  for (const item of scored) {
    if (seen.has(item.sentence.text)) continue;
    seen.add(item.sentence.text);
    out.push({ claim: `（語の一致：${item.matched.slice(0, 4).join('・')}）`, quote: item.sentence.text, source: `S${item.sentence.source + 1}` });
    if (out.length >= max) break;
  }
  return out;
}
