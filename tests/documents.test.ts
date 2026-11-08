import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { app, database } from './helpers.js';
import { getReaderTextRevision, saveReaderText } from '../repositories/reader_texts_repository.js';

async function createSource(title: string, paragraphs: string[]) {
  const response = await request(app).post('/api/reader/save').send({
    title, url: `https://example.test/${encodeURIComponent(title)}`, fetchedAt: new Date().toISOString(), paragraphs, memo: '', tags: [],
  });
  expect(response.status).toBe(201);
  return response.body.card as { id: string; title: string };
}

describe('research documents', () => {
  it('keeps citations verified when an uncited paragraph changes and retains each quoted revision', async () => {
    const suffix = randomUUID();
    const paragraphs = Array.from({ length: 11 }, (_, index) => `引用用の段落${index}です。`);
    const source = await createSource(`Unrelated revision ${suffix}`, paragraphs);
    const created = await request(app).post('/api/documents').send({ title: `10 citations ${suffix}`, markdown: '' });
    let document = created.body.document;
    for (let index = 0; index < 10; index += 1) {
      const cited = await request(app).post(`/api/documents/${document.id}/citations`).send({
        sourceCardId: source.id, paragraphIndex: index, quote: paragraphs[index], title: document.title,
        markdown: document.markdown, version: document.version, insertAt: document.markdown.length,
      });
      expect(cited.status).toBe(201);
      document = cited.body.document;
    }
    const revisionTwo = [...paragraphs.slice(0, 10), '引用していない段落だけを変更しました。'];
    saveReaderText(source.id, revisionTwo);
    saveReaderText(source.id, revisionTwo);
    expect((database.db.prepare('SELECT COUNT(*) AS count FROM reader_text_revisions WHERE card_id=?').get(source.id) as { count: number }).count).toBe(2);
    saveReaderText(source.id, [...paragraphs.slice(0, 10), '未引用段落を2回目に変更しました。']);
    saveReaderText(source.id, [...paragraphs.slice(0, 10), '未引用段落を3回目に変更しました。']);
    const loaded = await request(app).get(`/api/documents/${document.id}`);
    expect(loaded.status).toBe(200);
    expect(loaded.body.document.citations).toHaveLength(10);
    expect(loaded.body.document.citations.every((citation: { verification: string; sourceRevisedElsewhere: boolean }) => citation.verification === 'verified' && citation.sourceRevisedElsewhere)).toBe(true);
    expect(getReaderTextRevision(source.id, 1)).toEqual(paragraphs);
    expect(getReaderTextRevision(source.id, 4)?.[10]).toBe('未引用段落を3回目に変更しました。');
  });

  it('detects moved quotes without changing the old anchor and relocates only on explicit confirmation', async () => {
    const suffix = randomUUID();
    const quote = '移動した引用を正確に再結合します。';
    const original = ['前段落。', quote, '後段落。'];
    const source = await createSource(`Moved citation ${suffix}`, original);
    const created = await request(app).post('/api/documents').send({ title: `Relocation ${suffix}`, markdown: '記述。' });
    const cited = await request(app).post(`/api/documents/${created.body.document.id}/citations`).send({
      sourceCardId: source.id, paragraphIndex: 1, quote, title: created.body.document.title,
      markdown: created.body.document.markdown, version: created.body.document.version, insertAt: created.body.document.markdown.length,
    });
    expect(cited.status).toBe(201);
    const oldCitationId = cited.body.citationId as string;
    saveReaderText(source.id, ['追加された前段落。', ...original]);
    const changed = await request(app).get(`/api/documents/${created.body.document.id}`);
    expect(changed.body.document.citations[0]).toMatchObject({ verification: 'quote_moved', paragraphIndex: 1, currentParagraphIndex: 2, citedParagraph: quote, currentParagraph: quote });
    const before = database.db.prepare('SELECT paragraph_index FROM document_citations WHERE id=?').get(oldCitationId) as { paragraph_index: number };
    expect(before.paragraph_index).toBe(1);

    const relocated = await request(app).post(`/api/documents/${created.body.document.id}/citations/${oldCitationId}/relocate`).send({
      paragraphIndex: 2, markdown: changed.body.document.markdown, version: changed.body.document.version,
    });
    expect(relocated.status).toBe(201);
    expect(relocated.body.citationId).not.toBe(oldCitationId);
    expect(relocated.body.document.citations).toHaveLength(1);
    expect(relocated.body.document.citations[0]).toMatchObject({ paragraphIndex: 2, sourceRevision: 2, verification: 'verified' });
    expect(database.db.prepare('SELECT paragraph_index FROM document_citations WHERE id=?').get(oldCitationId)).toEqual({ paragraph_index: 1 });
    expect(database.db.prepare('SELECT supersedes_id FROM document_citations WHERE id=?').get(relocated.body.citationId)).toEqual({ supersedes_id: oldCitationId });
    expect(getReaderTextRevision(source.id, 1)).toEqual(original);
    expect(getReaderTextRevision(source.id, 2)).toEqual(['追加された前段落。', ...original]);
  });

  it('creates a document, stores an anchored citation, exports it, searches it, and finds its source backlink', async () => {
    const suffix = randomUUID();
    const quote = '元資料にある確認済みの一文です。';
    const source = await createSource(`Document source ${suffix}`, ['前置き。', quote, '後続。']);
    const created = await request(app).post('/api/documents').send({ title: `調査原稿 ${suffix}`, markdown: '主張を書く。' });
    expect(created.status).toBe(201);
    const document = created.body.document;
    expect(document.version).toBe(1);

    const cited = await request(app).post(`/api/documents/${document.id}/citations`).send({
      sourceCardId: source.id, paragraphIndex: 1, quote, title: document.title, markdown: document.markdown, version: 1, insertAt: document.markdown.length,
    });
    expect(cited.status).toBe(201);
    expect(cited.body.document.markdown).toContain(`[[citation:${cited.body.citationId}]]`);
    expect(cited.body.document.citations[0]).toMatchObject({ sourceCardId: source.id, paragraphIndex: 1, verification: 'verified' });

    const staleSave = await request(app).put(`/api/documents/${document.id}`).send({ title: '古い保存', markdown: document.markdown, version: 1 });
    expect(staleSave.status).toBe(409);
    const saved = await request(app).put(`/api/documents/${document.id}`).send({ title: `確定原稿 ${suffix}`, markdown: cited.body.document.markdown, version: 2 });
    expect(saved.status).toBe(200);
    expect(saved.body.document.version).toBe(3);

    const searched = await request(app).get(`/api/documents?q=${encodeURIComponent(`確定原稿 ${suffix}`)}`);
    expect(searched.body.documents.map((row: { id: string }) => row.id)).toContain(document.id);
    const exported = await request(app).get(`/api/documents/${document.id}/export.md`);
    expect(exported.status).toBe(200);
    expect(exported.text).toContain(quote);
    expect(exported.text).toContain(`#my-search-source:${encodeURIComponent(source.id)}`);
    const backlink = await request(app).get(`/api/reader/cards/${source.id}/documents`);
    expect(backlink.body.documents.map((row: { id: string }) => row.id)).toContain(document.id);

    await request(app).delete(`/api/documents/${document.id}`).expect(200);
  });

  it('rejects missing, ambiguous, or wrong-version source quotes without writing a citation', async () => {
    const suffix = randomUUID();
    const source = await createSource(`Ambiguous source ${suffix}`, ['同じ引用文。', '同じ引用文。']);
    const created = await request(app).post('/api/documents').send({ title: `原稿 ${suffix}`, markdown: '' });
    const id = created.body.document.id as string;
    const wrongVersion = await request(app).post(`/api/documents/${id}/citations`).send({ sourceCardId: source.id, paragraphIndex: 0, quote: '同じ引用文。', title: `原稿 ${suffix}`, markdown: '', version: 2, insertAt: 0 });
    expect(wrongVersion.status).toBe(409);
    const ambiguous = await request(app).post(`/api/documents/${id}/citations`).send({ sourceCardId: source.id, paragraphIndex: 0, quote: '同じ引用文。', title: `原稿 ${suffix}`, markdown: '', version: 1, insertAt: 0 });
    expect(ambiguous.status).toBe(409);
    const invalidMarker = await request(app).post(`/api/documents/${id}/citations`).send({ sourceCardId: source.id, paragraphIndex: 0, quote: '同じ引用文。', title: `原稿 ${suffix}`, markdown: `[[citation:${randomUUID()}]]`, version: 1, insertAt: 0 });
    expect(invalidMarker.status).toBe(409);
    expect((await request(app).get(`/api/documents/${id}`)).body.document.citations).toHaveLength(0);
    await request(app).delete(`/api/documents/${id}`).expect(200);
  });

  it('applies the migration once and leaves existing card and reader rows untouched', () => {
    const db = new Database(':memory:');
    try {
      const applied = runMigrations(db);
      expect(applied).toContain('027_create_research_documents');
      db.prepare('INSERT INTO cards(id,title,body,created_at,updated_at) VALUES(?,?,?,?,?)').run('legacy-card', '既存カード', '既存本文', new Date().toISOString(), new Date().toISOString());
      db.prepare('INSERT INTO reader_texts(card_id,paragraphs_json,updated_at) VALUES(?,?,?)').run('legacy-card', JSON.stringify(['保存本文']), new Date().toISOString());
      expect(runMigrations(db)).toEqual([]);
      expect(db.prepare('SELECT title,body FROM cards WHERE id=?').get('legacy-card')).toEqual({ title: '既存カード', body: '既存本文' });
      expect(JSON.parse((db.prepare('SELECT paragraphs_json FROM reader_texts WHERE card_id=?').get('legacy-card') as { paragraphs_json: string }).paragraphs_json)).toEqual(['保存本文']);
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_citations'").get()).toBeTruthy();
    } finally { db.close(); }
  });

  it('keeps the saved quotation when its source card is deleted', async () => {
    const suffix = randomUUID();
    const source = await createSource(`Deleted source ${suffix}`, ['[[page:7|iv]]', '削除後にも残る引用。']);
    const created = await request(app).post('/api/documents').send({ title: `保持原稿 ${suffix}`, markdown: '' });
    const id = created.body.document.id as string;
    const cited = await request(app).post(`/api/documents/${id}/citations`).send({ sourceCardId: source.id, paragraphIndex: 1, quote: '削除後にも残る引用。', title: `保持原稿 ${suffix}`, markdown: '', version: 1, insertAt: 0 });
    expect(cited.status).toBe(201);
    expect(cited.body.document.citations[0].pageLabel).toBe('p. iv');
    database.db.prepare('DELETE FROM cards WHERE id=?').run(source.id);
    const loaded = await request(app).get(`/api/documents/${id}`);
    expect(loaded.body.document.citations[0]).toMatchObject({ sourceCardId: null, sourceTitle: source.title, quote: '削除後にも残る引用。', verification: 'source_missing' });
    await request(app).delete(`/api/documents/${id}`).expect(200);
  });

  it('stores selected browser text as a durable, explicitly unverified clip', async () => {
    const suffix = randomUUID();
    const created = await request(app).post('/api/documents').send({ title: `Browser clip ${suffix}`, markdown: '調査メモ。' });
    const document = created.body.document;
    const clip = await request(app).post(`/api/documents/${document.id}/clips`).send({
      clipText: 'ブラウザーで選択した本文です。', sourceTitle: '外部記事', sourceUrl: 'https://example.test/source',
      markdown: document.markdown, version: document.version, insertAt: document.markdown.length,
    });
    expect(clip.status).toBe(201);
    expect(clip.body.document.markdown).toContain(`[[clip:${clip.body.clipId}]]`);
    expect(clip.body.document.clips[0]).toMatchObject({ sourceTitle: '外部記事', verification: 'unverified_clip' });
    const exported = await request(app).get(`/api/documents/${document.id}/export.md`);
    expect(exported.text).toContain('未検証クリップ');
    expect(exported.text).toContain('https://example.test/source');
    await request(app).put(`/api/documents/${document.id}`).send({ title: document.title, markdown: '引用候補を破棄。', version: clip.body.document.version }).expect(200);
    expect((await request(app).get(`/api/documents/${document.id}`)).body.document.clips).toHaveLength(0);
    await request(app).post(`/api/documents/${document.id}/clips`).send({
      clipText: '本文', sourceTitle: '安全でないURL', sourceUrl: 'http://example.test/',
      markdown: '引用候補を破棄。', version: clip.body.document.version + 1, insertAt: 0,
    }).expect(400);
    await request(app).delete(`/api/documents/${document.id}`).expect(200);
  });

  it('rejects browser-originated cross-site mutations while allowing the configured local app origin', async () => {
    const blocked = await request(app).post('/api/documents').set('Origin', 'https://attacker.example').send({ title: '拒否', markdown: '' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('cross_origin_mutation_blocked');
    const allowed = await request(app).post('/api/documents').set('Origin', 'http://localhost:3000').send({ title: `origin allow ${randomUUID()}`, markdown: '' });
    expect(allowed.status).toBe(201);
    await request(app).delete(`/api/documents/${allowed.body.document.id}`).expect(200);
  });
});
