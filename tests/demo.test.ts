import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';
import { DEMO_DOCUMENTS, demoUrl, isDemoMode, readDemoDocument, seedDemoData } from '../services/demo_service.js';
import { pdfMaxBytes } from '../services/pdf_service.js';

const original = process.env.DEMO_MODE;
const originalDataScope = process.env.DEMO_DATA_SCOPE;
afterEach(() => {
  if (original === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = original;
  if (originalDataScope === undefined) delete process.env.DEMO_DATA_SCOPE; else process.env.DEMO_DATA_SCOPE = originalDataScope;
});

describe('demo mode', () => {
  it('is off unless DEMO_MODE=true', () => {
    expect(isDemoMode({})).toBe(false);
    expect(isDemoMode({ DEMO_MODE: 'TRUE' })).toBe(true);
  });

  it('serves the sample documents only in demo mode and only from the reserved host', async () => {
    expect(await readDemoDocument(demoUrl('/reading-notes'), {})).toBeNull();
    expect(await readDemoDocument('https://example.com/reading-notes', { DEMO_MODE: 'true' })).toBeNull();
    const article = await readDemoDocument(demoUrl('/reading-notes'), { DEMO_MODE: 'true' });
    expect(article?.title).toContain('読みながらメモを取るための三つの習慣');
    const interactive = await readDemoDocument(demoUrl('/reader-tools'), { DEMO_MODE: 'true' });
    expect(interactive?.title).toContain('記事内の計算と比較を操作する見本');
    expect(interactive?.paragraphs).toContain('計算: 月額料金の簡易見積もり');
    const pdf = await readDemoDocument(demoUrl('/sample-paper.pdf'), { DEMO_MODE: 'true' });
    expect(pdf?.paragraphs).toContain('[[page:2|41]]');
    expect(pdf?.paragraphs.join('\n')).not.toContain('見本紀要 第3号'); // running head removed
  });

  it('has a sample for every listed document', async () => {
    for (const pathname of Object.keys(DEMO_DOCUMENTS)) {
      expect(await readDemoDocument(demoUrl(pathname), { DEMO_MODE: 'true' })).not.toBeNull();
    }
  });

  it('does not seed over existing data', async () => {
    const ctx = { getCards: () => [{}], loadArticles: () => null, createCard: async () => ({ id: 'x' }), setCachedArticles: () => {} };
    expect(await seedDemoData(ctx)).toBe(false);
  });

  it('reports features, reads samples and blocks collecting in demo mode', async () => {
    process.env.DEMO_MODE = 'true';
    process.env.DEMO_DATA_SCOPE = 'shared';
    const features = await request(app).get('/api/features');
    expect(features.body).toMatchObject({ demo: true, demoDataScope: 'shared' });
    expect(features.body.samples.length).toBe(Object.keys(DEMO_DOCUMENTS).length);
    const read = await request(app).post('/api/reader/extract').send({ url: demoUrl('/citation-pages') });
    expect(read.status).toBe(200);
    expect(read.body.title).toContain('引用にページ番号を付ける理由');
    const interactive = await request(app).post('/api/reader/extract').send({ url: demoUrl('/reader-tools') });
    expect(interactive.status).toBe(200);
    expect(interactive.body.tools.map((tool: { kind: string }) => tool.kind)).toEqual(['calculator', 'comparison']);
    expect((await request(app).post('/api/collect').send({})).status).toBe(403);
    const modes = await request(app).get('/api/modes');
    expect(Object.keys(modes.body)[0]).toBe('demo');
    expect(modes.body.demo.keywords.map((k: { term: string }) => k.term)).toEqual(['引用', 'ページ', 'メモ']);
    const pdf = await request(app).get('/demo/sample-paper.pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  it('reports local storage scope for isolated trial mode', async () => {
    process.env.DEMO_MODE = 'true';
    process.env.DEMO_DATA_SCOPE = 'local';
    const features = await request(app).get('/api/features');
    expect(features.body).toMatchObject({ demo: true, demoDataScope: 'local' });
  });

  it('reports no demo outside demo mode', async () => {
    delete process.env.DEMO_MODE;
    const features = await request(app).get('/api/features');
    expect(features.body).toMatchObject({ demo: false, samples: [] });
    expect(Object.keys((await request(app).get('/api/modes')).body)).not.toContain('demo');
  });

  it('lets the PDF size limit be lowered', () => {
    expect(pdfMaxBytes({})).toBe(30 * 1024 * 1024);
    expect(pdfMaxBytes({ READER_PDF_MAX_MB: '10' })).toBe(10 * 1024 * 1024);
    expect(pdfMaxBytes({ READER_PDF_MAX_MB: '100' })).toBe(30 * 1024 * 1024);
  });
});
