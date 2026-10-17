import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';
import { DEMO_DOCUMENTS, demoUrl, isDemoMode, readDemoDocument, seedDemoData } from '../services/demo_service.js';
import { pdfMaxBytes } from '../services/pdf_service.js';

const original = process.env.DEMO_MODE;
afterEach(() => { if (original === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = original; });

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
    const features = await request(app).get('/api/features');
    expect(features.body).toMatchObject({ demo: true });
    expect(features.body.samples.length).toBe(Object.keys(DEMO_DOCUMENTS).length);
    const read = await request(app).post('/api/reader/extract').send({ url: demoUrl('/citation-pages') });
    expect(read.status).toBe(200);
    expect(read.body.title).toContain('引用にページ番号を付ける理由');
    expect((await request(app).post('/api/collect').send({})).status).toBe(403);
    const pdf = await request(app).get('/demo/sample-paper.pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  it('reports no demo outside demo mode', async () => {
    delete process.env.DEMO_MODE;
    const features = await request(app).get('/api/features');
    expect(features.body).toMatchObject({ demo: false, samples: [] });
  });

  it('lets the PDF size limit be lowered', () => {
    expect(pdfMaxBytes({})).toBe(30 * 1024 * 1024);
    expect(pdfMaxBytes({ READER_PDF_MAX_MB: '10' })).toBe(10 * 1024 * 1024);
    expect(pdfMaxBytes({ READER_PDF_MAX_MB: '100' })).toBe(30 * 1024 * 1024);
  });
});
