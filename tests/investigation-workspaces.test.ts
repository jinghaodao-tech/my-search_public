import { describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { app, database } from './helpers.js';
import { runMigrations } from '../db/migrate.js';

const savedSearch = {
  name: '保存検索を調査に使う',
  source: 'cards' as const,
  config: { label: 'test', description: '', k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1, keywords: [{ term: 'workspace', weight: 1 }] },
  options: { resultLimit: 10 },
  filters: { excludedTerms: [], sources: [], status: 'all' as const },
};

describe('investigation workspaces', () => {
  it('organizes shared cards, groups, documents, and saved searches without copying or deleting them', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const saved = await request(app).post('/api/reader/save').send({
      title: `Workspace source ${suffix}`,
      url: `https://example.test/workspace/${suffix}`,
      fetchedAt: new Date().toISOString(), paragraphs: ['調査用の保存本文です。'], memo: '', tags: [],
    }).expect(201);
    const sourceId = saved.body.card.id as string;
    const linked = await request(app).post('/api/cards').send({ title: `External link ${suffix}`, body: '外部リンク先', tags: [] }).expect(201);
    await request(app).post(`/api/cards/${sourceId}/links`).send({ targetId: linked.body.id }).expect(200);
    const document = await request(app).post('/api/documents').send({ title: `Workspace document ${suffix}`, markdown: '調査メモ' }).expect(201);
    const search = await request(app).post('/api/saved-searches').send({ ...savedSearch, name: `Search ${suffix}` }).expect(201);
    const first = await request(app).post('/api/workspaces').send({ name: `調査 ${suffix}`, purpose: '保存記事を比較する' }).expect(201);
    const second = await request(app).post('/api/workspaces').send({ name: `別の調査 ${suffix}`, purpose: '' }).expect(201);
    const firstId = first.body.workspace.id as string;
    const secondId = second.body.workspace.id as string;
    const group = await request(app).post(`/api/workspaces/${firstId}/groups`).send({ name: '根拠', position: 0 }).expect(201);
    const groupId = group.body.groupId as string;

    await request(app).post(`/api/workspaces/${firstId}/sources`).send({ cardId: sourceId, groupId }).expect(201);
    await request(app).post(`/api/workspaces/${secondId}/sources`).send({ cardId: sourceId }).expect(201);
    await request(app).put(`/api/workspaces/${firstId}/sources/${sourceId}`).send({ groupId: null }).expect(200);
    await request(app).put(`/api/workspaces/${firstId}/sources/${sourceId}`).send({ groupId }).expect(200);
    await request(app).post(`/api/workspaces/${firstId}/documents`).send({ id: document.body.document.id }).expect(201);
    await request(app).post(`/api/workspaces/${firstId}/searches`).send({ id: search.body.id }).expect(201);
    await request(app).put(`/api/workspaces/${firstId}/state`).send({ state: { lastView: 'board', query: '記憶した検索語' } }).expect(200);

    const loaded = await request(app).get(`/api/workspaces/${firstId}`).expect(200);
    expect(loaded.body.workspace).toMatchObject({ purpose: '保存記事を比較する', state: { lastView: 'board', query: '記憶した検索語' } });
    expect(loaded.body.workspace.sources.map((row: { card: { id: string }; groupId: string | null }) => [row.card.id, row.groupId])).toEqual([[sourceId, groupId]]);
    expect(loaded.body.workspace.documents.map((row: { id: string }) => row.id)).toContain(document.body.document.id);
    expect(loaded.body.workspace.searches.map((row: { id: string }) => row.id)).toContain(search.body.id);
    const graph = await request(app).get(`/api/workspaces/${firstId}/graph`).expect(200);
    expect(graph.body).toMatchObject({ externalLinks: 1, edges: [] });
    expect(graph.body.nodes[0]).toMatchObject({ id: sourceId, externalLinkCount: 1 });

    const wrongWorkspaceGroup = await request(app).post(`/api/workspaces/${secondId}/sources`).send({ cardId: sourceId, groupId });
    expect(wrongWorkspaceGroup.status).toBe(400);
    const reopened = new Database(process.env.DB_PATH!);
    try {
      expect(JSON.parse((reopened.prepare('SELECT state_json FROM investigation_workspaces WHERE id=?').get(firstId) as { state_json: string }).state_json)).toEqual({ lastView: 'board', query: '記憶した検索語' });
    } finally { reopened.close(); }

    await request(app).delete(`/api/workspaces/${firstId}`).expect(200);
    expect((await request(app).get(`/api/cards/${sourceId}`)).status).toBe(200);
    expect((await request(app).get(`/api/documents/${document.body.document.id}`)).body.document.title).toBe(`Workspace document ${suffix}`);
    expect((await request(app).get('/api/saved-searches')).body.map((row: { id: string }) => row.id)).toContain(search.body.id);
    const secondLoaded = await request(app).get(`/api/workspaces/${secondId}`).expect(200);
    expect(secondLoaded.body.workspace.sources.map((row: { card: { id: string } }) => row.card.id)).toContain(sourceId);
    await request(app).delete(`/api/workspaces/${secondId}/sources/${sourceId}`).expect(200);
    expect((await request(app).get(`/api/cards/${sourceId}`)).status).toBe(200);
    expect(database.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(runMigrations(database.db)).toEqual([]);
  });

  it('keeps thought notes shared, versioned, workspace-scoped, and safely linked to exact source quotes', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const source = await request(app).post('/api/reader/save').send({
      title: `Thought citation ${suffix}`,
      url: `https://example.test/thought/${suffix}`,
      fetchedAt: new Date().toISOString(),
      paragraphs: ['最初の引用可能な段落です。', '同じ引用候補です。', '同じ引用候補です。'],
      memo: '', tags: [],
    }).expect(201);
    const cardId = source.body.card.id as string;
    const first = await request(app).post('/api/workspaces').send({ name: `思考調査A ${suffix}`, purpose: '' }).expect(201);
    const second = await request(app).post('/api/workspaces').send({ name: `思考調査B ${suffix}`, purpose: '' }).expect(201);
    const firstId = first.body.workspace.id as string;
    const secondId = second.body.workspace.id as string;
    const created = await request(app).post('/api/thought-notes').send({ title: '検索の疑問', body: '未知語の扱いが検索漏れを起こすかもしれない。', kind: 'hypothesis' }).expect(201);
    const thoughtId = created.body.thought.id as string;

    await request(app).post(`/api/workspaces/${firstId}/thought-notes`).send({ thoughtNoteId: thoughtId }).expect(201);
    await request(app).post(`/api/workspaces/${secondId}/thought-notes`).send({ thoughtNoteId: thoughtId }).expect(201);
    const group = await request(app).post(`/api/workspaces/${firstId}/groups`).send({ name: '検証候補', position: 0 }).expect(201);
    await request(app).put(`/api/workspaces/${firstId}/thought-notes/${thoughtId}`).send({ groupId: group.body.groupId, position: 3, x: 180, y: 90 }).expect(200);

    await request(app).put(`/api/thought-notes/${thoughtId}`).send({
      title: '検索の疑問を更新', body: '未知語は別方式で拾えるか検証する。', kind: 'question', version: 1,
    }).expect(200);
    const stale = await request(app).put(`/api/thought-notes/${thoughtId}`).send({
      title: '古い編集', body: '古い内容', kind: 'free', version: 1,
    }).expect(409);
    expect(stale.body.current.version).toBe(2);
    const revisions = await request(app).get(`/api/thought-notes/${thoughtId}/revisions`).expect(200);
    expect(revisions.body.revisions[0]).toMatchObject({ version: 1, title: '検索の疑問' });

    const thoughtDocument = await request(app).post('/api/documents').send({ title: `思考メモを参照する原稿 ${suffix}`, markdown: '' }).expect(201);
    const linkedDocument = await request(app).post(`/api/documents/${thoughtDocument.body.document.id}/thought-notes`).send({ thoughtNoteId: thoughtId }).expect(200);
    expect(linkedDocument.body.document.thoughtNotes).toMatchObject([{ id: thoughtId, title: '検索の疑問を更新' }]);

    await request(app).post(`/api/thought-notes/${thoughtId}/references`).send({ sourceCardId: cardId, quote: '最初の引用可能な段落です。' }).expect(201);
    const ambiguous = await request(app).post(`/api/thought-notes/${thoughtId}/references`).send({ sourceCardId: cardId, quote: '同じ引用候補です。' }).expect(409);
    expect(ambiguous.body.error).toMatch(/複数箇所/);
    await request(app).post(`/api/thought-notes/${thoughtId}/references`).send({ sourceCardId: cardId, quote: '本文にない引用です。' }).expect(422);

    const secondThought = await request(app).post('/api/thought-notes').send({ title: '検証方法', body: '異なる検索方式を同一コーパスで比べる。', kind: 'free' }).expect(201);
    const secondThoughtId = secondThought.body.thought.id as string;
    await request(app).post(`/api/workspaces/${firstId}/thought-notes`).send({ thoughtNoteId: secondThoughtId }).expect(201);
    const link = await request(app).post(`/api/workspaces/${firstId}/thought-links`).send({
      sourceThoughtId: thoughtId, targetThoughtId: secondThoughtId, description: '検証が必要',
    }).expect(201);
    expect(link.body.workspace.thoughtLinks[0].description).toBe('検証が必要');
    const map = await request(app).get(`/api/workspaces/${firstId}/thought-map`).expect(200);
    expect(map.body.edges).toMatchObject([{ id: link.body.linkId, from: thoughtId, to: secondThoughtId, label: '検証が必要' }]);
    await request(app).put(`/api/workspaces/${firstId}/thought-links/${link.body.linkId}`).send({ description: '仮説を確かめる手段' }).expect(200);
    await request(app).delete(`/api/workspaces/${firstId}/groups/${group.body.groupId}`).expect(200);
    const loadedFirst = await request(app).get(`/api/workspaces/${firstId}`).expect(200);
    expect(loadedFirst.body.workspace.thoughts.find((row: { id: string }) => row.id === thoughtId)).toMatchObject({ groupId: null, position: 3, x: 180, y: 90 });
    expect(loadedFirst.body.workspace.thoughtLinks[0].description).toBe('仮説を確かめる手段');
    expect(loadedFirst.body.workspace.thoughts[0].references[0].verification).toBe('verified');

    await request(app).delete(`/api/workspaces/${firstId}/thought-notes/${thoughtId}`).expect(200);
    expect((await request(app).get(`/api/workspaces/${secondId}`)).body.workspace.thoughts.map((row: { id: string }) => row.id)).toContain(thoughtId);
    await request(app).delete(`/api/workspaces/${secondId}`).expect(200);
    expect((await request(app).get(`/api/thought-notes/${thoughtId}`)).body.thought).toMatchObject({
      id: thoughtId, title: '検索の疑問を更新', version: 2,
    });
    expect((await request(app).get(`/api/thought-notes/${thoughtId}`)).body.thought.references[0].verification).toBe('verified');
    expect((await request(app).get(`/api/cards/${cardId}`)).status).toBe(200);
    await request(app).delete(`/api/documents/${thoughtDocument.body.document.id}`).expect(200);
    expect((await request(app).get(`/api/thought-notes/${thoughtId}`)).status).toBe(200);
    expect(database.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(runMigrations(database.db)).toEqual([]);
  });
});
