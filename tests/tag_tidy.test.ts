import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from './helpers.js';
import { mergeTagList, tagKey, tagVariantGroups } from '../services/tag_tidy.js';

describe('tidying tags', () => {
  it('spellings that differ only in width, case or spaces are one group; the most used is suggested', () => {
    expect(tagKey('ＡＩ')).toBe(tagKey('ai'));
    expect(tagKey('機械 学習')).toBe(tagKey('機械学習'));
    const groups = tagVariantGroups([{ tag: 'AI', count: 5 }, { tag: 'ai', count: 1 }, { tag: 'ＡＩ', count: 2 }, { tag: 'DB', count: 3 }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].suggested).toBe('AI');
    expect(mergeTagList(['ai', 'DB', 'AI'], ['ai', 'ＡＩ'], 'AI')).toEqual(['AI', 'DB']);
  });

  it('merging shows the cards first (dry run), then changes only those cards', async () => {
    const a = await request(app).post('/api/cards').send({ title: 'タグ1', body: 'b', tags: ['ai', 'メモ'] });
    const b = await request(app).post('/api/cards').send({ title: 'タグ2', body: 'b', tags: ['AI'] });
    const c = await request(app).post('/api/cards').send({ title: 'タグ3', body: 'b', tags: ['DB'] });
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
    const tidy = await request(app).get('/api/tags/tidy');
    expect(tidy.body.variants.some((group: { key: string }) => group.key === 'ai')).toBe(true);
    const preview = await request(app).post('/api/tags/merge').send({ from: ['ai'], to: 'AI', dryRun: true });
    expect(preview.body.cards).toBe(1);
    expect((await request(app).get(`/api/cards/${a.body.id}`)).body.tags).toContain('ai'); // dry run changed nothing
    const done = await request(app).post('/api/tags/merge').send({ from: ['ai'], to: 'AI' });
    expect(done.body.changed).toBe(1);
    expect((await request(app).get(`/api/cards/${a.body.id}`)).body.tags).toEqual(['AI', 'メモ']);
    expect((await request(app).get(`/api/cards/${c.body.id}`)).body.tags).toEqual(['DB']);
  });
});
