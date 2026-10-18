import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from './helpers.js';
import { overviewTopics, titleTerms, topicWord, trendTopics } from '../services/topic_insights.js';
import { saveArticlesToDb } from '../repositories/articles_repository.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-18T00:00:00Z');
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const art = (id: string, tokens: string[], daysAgo: number) => ({ id, title: id, publishedAt: at(daysAgo), tokens });

describe('topics for broad questions', () => {
  it('topic words: no generic words, function words, numbers or punctuation', () => {
    expect(topicWord('エージェント')).toBe(true);
    expect(topicWord('mcp')).toBe(true);
    for (const word of ['問題', 'こと', '2026', '),', 'the', '公開', 'ai']) expect(topicWord(word), word).toBe(false);
  });

  it('rising words are words in many more recent articles than older ones', () => {
    const articles = [
      ...Array.from({ length: 6 }, (_, i) => art(`new-mcp-${i}`, ['mcp', 'サーバー'], 3)),
      ...Array.from({ length: 4 }, (_, i) => art(`new-k8s-${i}`, ['kubernetes'], 5)),
      ...Array.from({ length: 30 }, (_, i) => art(`old-k8s-${i}`, ['kubernetes'], 90)),
    ];
    const result = trendTopics(articles, { now: NOW, days: 30 });
    expect(result.compared).toBe(true);
    expect(result.topics[0].term).toBe('mcp');
    expect(result.topics[0].articles).toHaveLength(3);
    // "サーバー" names the same articles as "mcp": not listed twice
    expect(result.topics.map(topic => topic.term)).not.toContain('サーバー');
  });

  it('overview: each result in one group, by the words they share beyond the searched ones', () => {
    const articles = [art('a', ['rust', 'wasm'], 1), art('b', ['rust', 'wasm'], 2), art('c', ['rust', 'cli'], 3), art('d', ['rust', 'cli'], 4), art('e', ['rust'], 5)];
    const { topics, rest } = overviewTopics(articles, ['rust']);
    expect(topics.map(topic => topic.term).sort()).toEqual(['cli', 'wasm']);
    expect(rest.map(item => item.id)).toEqual(['e']);
  });

  it('title words come from nouns and Latin names', async () => {
    expect(await titleTerms('Rustで作るMCPサーバー入門')).toEqual(expect.arrayContaining(['rust', 'mcp', 'サーバー']));
  });

  it('API: trend over the collected articles, overview over given results', async () => {
    saveArticlesToDb([0, 1, 2].map(i => ({ id: `ti-${i}`, title: `MCPサーバーの作り方 ${i}`, body: 'b', url: `https://ti.example.com/${i}`, source: 'rss:TI', sourceAuthority: 0.5, publishedAt: new Date(Date.now() - i * DAY), tokens: [], docLength: 0 })) as never);
    const trend = await request(app).post('/api/search/insights').send({ kind: 'trend', sources: ['rss:TI'] });
    expect(trend.status).toBe(200);
    expect(trend.body.topics.map((topic: { term: string }) => topic.term)).toContain('mcp');
    expect(trend.body.topics[0].articles[0].url).toMatch(/^https:\/\/ti\.example\.com\//);
    const overview = await request(app).post('/api/search/insights').send({ kind: 'overview', ids: ['ti-0', 'ti-1', 'ti-2'], terms: [] });
    expect(overview.status).toBe(200);
    expect((await request(app).post('/api/search/insights').send({ kind: 'nope' })).status).toBe(400);
  });
});
