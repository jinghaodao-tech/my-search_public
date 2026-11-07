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
});
