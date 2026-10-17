import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';
import {
  cleanCjkSpacing,
  detectPrintedNumber,
  extractPdf,
  guessBibliographicHints,
  findRunningHeads,
  guessPageLabels,
  itemsToLines,
  longestIncreasingChain,
  pageNumberCandidates,
  romanToNumber,
  linesToParagraphs,
  relabelPages,
  type PdfLine,
} from '../services/pdf_service.js';

/** Minimal PDF (Helvetica, one text line per entry) built by hand so the test needs no PDF library. */
function buildPdf(pages: Array<Array<{ text: string; x: number; y: number; size?: number }>>): Buffer {
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objects.length + 1 + pages.length * 2; // reserved below
  const pageIds: number[] = [];
  for (const lines of pages) {
    const stream = lines.map(l => `BT /F1 ${l.size ?? 11} Tf ${l.x} ${l.y} Td (${l.text.replace(/[()\\]/g, m => `\\${m}`)}) Tj ET`).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  add(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const TWO_PAGES = buildPdf([
  [
    { text: 'Reporting Effect Sizes', x: 72, y: 780, size: 18 },
    { text: 'Journal of Testing (2008), 57-58.', x: 72, y: 750 },
    { text: 'Effect sizes should be reported in every results section of', x: 72, y: 700 },
    { text: 'a research paper because significance tests alone are not enough.', x: 72, y: 686 },
    { text: '- 57 -', x: 290, y: 40 },
  ],
  [
    { text: 'The second page continues the argument about sample size and', x: 72, y: 780 },
    { text: 'statistical power in small classroom studies.', x: 72, y: 766 },
    { text: '- 58 -', x: 290, y: 40 },
  ],
]);

const line = (text: string, x: number, right: number, y: number, size = 10): PdfLine => ({ text, x, right, y, size });

// A small "book": cover, roman-numbered front matter, an unnumbered plate, and running heads.
const body = (text: string) => [{ text, x: 72, y: 700 }, { text: 'More text on this page about effect sizes.', x: 72, y: 686 }];
const BOOK = buildPdf([
  [{ text: 'A Practical Book', x: 72, y: 700, size: 20 }, { text: 'Some Publisher', x: 72, y: 600 }],
  [...body('Preface text of the book.'), { text: 'ii', x: 290, y: 40 }],
  [...body('Acknowledgements of the book.'), { text: 'iii', x: 290, y: 40 }],
  [...body('Contents of the book.'), { text: 'iv', x: 290, y: 40 }],
  [{ text: 'Chapter 1', x: 72, y: 760, size: 16 }, ...body('Chapter one starts here.'), { text: '1', x: 290, y: 40 }],
  [{ text: '2 Effect Sizes in Practice', x: 72, y: 800 }, ...body('Page two of chapter one.')],
  [{ text: 'Basics of Reporting 3', x: 72, y: 800 }, ...body('Page three of chapter one.')],
  [],
  [{ text: '4 Effect Sizes in Practice', x: 72, y: 800 }, ...body('Page four after the plate.')],
  [{ text: 'Basics of Reporting 5', x: 72, y: 800 }, ...body('Page five of chapter one.')],
  [{ text: '6 Effect Sizes in Practice', x: 72, y: 800 }, ...body('Page six of chapter one.')],
  [{ text: 'Basics of Reporting 7', x: 72, y: 800 }, ...body('Page seven of chapter one.')],
]);

describe('pdf: page labels (no AI)', () => {
  it('uses the printed page numbers when the PDF has no real labels', () => {
    expect(guessPageLabels([57, 58, null, 60], null)).toEqual({ labels: ['57', '58', '59', '60'], source: 'printed-numbers' });
    // cover sheet without a number keeps no label
    expect(guessPageLabels([null, 27, 28, 29], ['1', '2', '3', '4'])).toEqual({ labels: [null, '27', '28', '29'], source: 'printed-numbers' });
  });

  it('prefers the PDF page labels when they are not just 1..n', () => {
    expect(guessPageLabels([null, null], ['i', '1'])).toEqual({ labels: ['i', '1'], source: 'pdf-labels' });
  });

  it('gives up rather than guessing from a single stray number', () => {
    expect(guessPageLabels([null, 3, null, null], null).source).toBe('none');
  });

  it('reads roman numerals strictly', () => {
    expect(romanToNumber('xiv')).toBe(14);
    expect(romanToNumber('IV')).toBe(4);
    expect(romanToNumber('iiii')).toBeNull();
    expect(romanToNumber('Iv')).toBeNull();
  });

  it('takes candidates from the outermost lines only, alone or at the ends of a short running head', () => {
    const lines = [line('28 日本語と日本文学', 72, 300, 800), line('本文 24 本の研究', 72, 500, 700), line('xii', 290, 300, 40)];
    expect(pageNumberCandidates(lines).map(c => [c.type, c.value])).toEqual([['arabic', 28], ['roman', 12]]);
  });

  it('chooses the longest increasing chain, so stray numbers lose', () => {
    expect(longestIncreasingChain([[{ value: 1999 }], [{ value: 27 }], [{ value: 28 }, { value: 3 }], [{ value: 29 }]]))
      .toEqual([{ page: 1, value: 27 }, { page: 2, value: 28 }, { page: 3, value: 29 }]);
    // a year in the last footer does not replace the page number
    expect(longestIncreasingChain([[{ value: 65 }], [{ value: 66 }, { value: 2008 }]]).map(x => x.value)).toEqual([65, 66]);
    expect(longestIncreasingChain([[{ value: 65 }], [{ value: 2008 }, { value: 66 }]]).map(x => x.value)).toEqual([65, 66]);
  });

  it('lets the user correct the mapping', () => {
    expect(relabelPages(4, 2, 27)).toEqual([null, '27', '28', '29']);
  });

  it('finds the printed number at the top or bottom of the page', () => {
    expect(detectPrintedNumber([line('- 58 -', 290, 310, 800), line('本文', 72, 500, 700)])).toEqual({ value: 58, line: 0 });
    expect(detectPrintedNumber([line('本文', 72, 500, 700), line('27', 290, 300, 40)])).toEqual({ value: 27, line: 1 });
    expect(detectPrintedNumber([line('第 3 章', 72, 500, 700), line('本文', 72, 500, 600)])).toBeNull();
  });
});

describe('pdf: text layout (no AI)', () => {
  it('removes letter spacing between Japanese characters only', () => {
    expect(cleanCjkSpacing('本 稿 は 、 一 般 に')).toBe('本稿は、一般に');
    expect(cleanCjkSpacing('APA 第 5 版 (2001)')).toBe('APA 第 5 版 (2001)');
  });

  it('groups items on the same baseline into one line, top to bottom', () => {
    const lines = itemsToLines([
      { str: 'world', x: 140, y: 700, width: 40, height: 10 },
      { str: 'Hello', x: 100, y: 700, width: 30, height: 10 },
      { str: 'Title', x: 100, y: 760, width: 50, height: 18 },
    ]);
    expect(lines.map(l => l.text)).toEqual(['Title', 'Hello world']);
  });

  it('joins wrapped lines and splits paragraphs at short lines and indents', () => {
    const paragraphs = linesToParagraphs([
      line('最初の段落は二行に', 72, 520, 700),
      line('わたる。', 72, 200, 686),
      line('次の段落はここから', 82, 520, 672),
      line('始まって続く。', 72, 300, 658),
      line('Effect sizes should be', 72, 520, 644),
      line('reported. ', 72, 200, 630),
    ]);
    expect(paragraphs).toEqual(['最初の段落は二行にわたる。', '次の段落はここから始まって続く。', 'Effect sizes should be reported.']);
  });

  it('reads year and journal hints from the first page', () => {
    expect(guessBibliographicHints('『英語教育研究』31 (2008), 57-66.')).toEqual({ year: '2008', siteName: '英語教育研究' });
    expect(guessBibliographicHints('筑波大学\n1999 年 3 月')).toEqual({ year: '1999', siteName: null });
  });
});

describe('pdf: a book with front matter, a plate and running heads', () => {
  it('labels roman front matter, leaves the cover and the plate unlabelled, and drops running heads', async () => {
    const pdf = await extractPdf(new Uint8Array(BOOK));
    expect(pdf.pageLabels).toEqual([null, 'ii', 'iii', 'iv', '1', '2', '3', null, '4', '5', '6', '7']);
    const text = pdf.paragraphs.join('\n');
    expect(text).not.toContain('Effect Sizes in Practice');
    expect(text).not.toContain('Basics of Reporting');
    expect(text).toContain('Page four after the plate.');
    expect(pdf.paragraphs).toContain('[[page:2|ii]]');
  });

  it('finds running heads only when they repeat on enough pages', () => {
    const page = (head: string) => [line(head, 72, 300, 800), line('本文', 72, 500, 700)];
    const heads = findRunningHeads([page('12 日本語と日本文学'), page('13 日本語と日本文学'), page('14 日本語と日本文学'), page('論文の題名')]);
    expect([...heads]).toEqual(['#日本語と日本文学']);
  });
});

describe('pdf: extraction from a real PDF file', () => {
  it('returns page markers with printed page labels and the text', async () => {
    const pdf = await extractPdf(new Uint8Array(TWO_PAGES));
    expect(pdf.pageCount).toBe(2);
    expect(pdf.pageLabels).toEqual(['57', '58']);
    expect(pdf.title).toBe('Reporting Effect Sizes');
    expect(pdf.year).toBe('2008');
    expect(pdf.copyAllowed).toBe(true);
    expect(pdf.paragraphs[0]).toBe('[[page:1|57]]');
    expect(pdf.paragraphs).toContain('[[page:2|58]]');
    expect(pdf.paragraphs.join('\n')).toContain('Effect sizes should be reported in every results section of a research paper because significance tests alone are not enough.');
    expect(pdf.paragraphs.join('\n')).not.toContain('- 57 -');
  });

  it('rejects files that are not PDFs', async () => {
    await expect(extractPdf(new Uint8Array(Buffer.from('not a pdf')))).rejects.toThrow(/could not be read/);
  });
});

describe('pdf: API', () => {
  it('reads an uploaded PDF and saves it as a card with the full text kept', async () => {
    const read = await request(app).post('/api/reader/pdf').set('Content-Type', 'application/pdf').set('X-File-Name', encodeURIComponent('効果量.pdf')).send(TWO_PAGES);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ kind: 'pdf', url: null, fileName: '効果量.pdf', pageCount: 2, pageLabelSource: 'printed-numbers' });

    const saved = await request(app).post('/api/reader/save').send({
      title: read.body.title, fileName: read.body.fileName, byline: '水本・竹内', year: '2008', siteName: 'Journal of Testing',
      fetchedAt: read.body.fetchedAt, paragraphs: read.body.paragraphs, memo: 'メモ',
    });
    expect(saved.status).toBe(201);
    const opened = await request(app).get(`/api/reader/cards/${saved.body.card.id}`);
    expect(opened.body).toMatchObject({ fileName: '効果量.pdf', year: '2008', byline: '水本・竹内', url: null });
    expect(opened.body.paragraphs).toEqual(read.body.paragraphs);
  });

  it('keeps the whole text even when it is longer than a card body', async () => {
    const paragraphs = ['[[page:1|1]]', ...Array.from({ length: 30 }, (_, i) => `${i}: ${'長い本文。'.repeat(200)}`)];
    const saved = await request(app).post('/api/reader/save').send({ title: '長い本', fileName: 'book.pdf', fetchedAt: new Date().toISOString(), paragraphs, memo: '' });
    expect(saved.status).toBe(201);
    expect(saved.body.card.body.length).toBeLessThanOrEqual(20000);
    const opened = await request(app).get(`/api/reader/cards/${saved.body.card.id}`);
    expect(opened.body.paragraphs).toEqual(paragraphs);
  });

  it('refuses an empty upload and a save without url or file name', async () => {
    expect((await request(app).post('/api/reader/pdf').set('Content-Type', 'application/pdf').send(Buffer.alloc(0))).status).toBe(400);
    expect((await request(app).post('/api/reader/pdf').set('Content-Type', 'application/pdf').send(Buffer.from('nope'))).status).toBe(422);
    expect((await request(app).post('/api/reader/save').send({ title: 't', fetchedAt: new Date().toISOString(), paragraphs: ['p'] })).status).toBe(400);
  });
});
