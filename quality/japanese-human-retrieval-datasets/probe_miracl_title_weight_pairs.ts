import fs from 'node:fs';
import path from 'node:path';

const [databaseArg, queriesArg, sampleArg = '20', outputArg] = process.argv.slice(2);
if (!databaseArg || !queriesArg) throw new Error('Usage: probe_miracl_title_weight_pairs.ts <isolated.sqlite> <development.jsonl> [sample-count|all] [output.json]');
process.env.DB_PATH = path.resolve(databaseArg);
process.env.NODE_ENV = 'test';
process.env.SITE_SYNC = 'off';
process.env.ARTICLE_SEARCH_ENGINE = 'fts5-title-rerank';
delete process.env.API_KEY;

const queries = fs.readFileSync(path.resolve(queriesArg), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
const sampleCount = sampleArg.toLowerCase() === 'all' ? queries.length : Number.parseInt(sampleArg, 10);
if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) throw new Error('sample-count must be positive or all');
const selected = Array.from({ length: Math.min(sampleCount, queries.length) }, (_, index) =>
  queries[Math.floor(index * queries.length / Math.min(sampleCount, queries.length))]);
const [{ app }, requestModule, { db }] = await Promise.all([
  import('../../app.js'),
  import('supertest'),
  import('../../db/database.js'),
]);
const request = requestModule.default;
const configBase = { label: 'MIRACL paired title rerank', description: '', k1: 1.8, b: 0.8, lambda: 0.02, contextBonus: 2.2, keywords: [] };
const options = { dedupThreshold: 1, archiveScoreThreshold: -1, resultLimit: 50 };
const filters = { excludedTerms: [], sources: [], status: 'all' };
type Arm = { weight: number; latencyMs: number; error: string | null; top10: string[]; hit1: boolean; hit10: boolean; rr10: number; ndcg10: number; searchMethod: string | null };
const results: Array<{qid:string;group_id:string;query:string;gold_ids:string[];arms:Record<string,Arm>;parserMs:number}> = [];
const started = performance.now();
const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};

try {
  for (const [index, query] of selected.entries()) {
    const parserStarted = performance.now();
    const parsed = await request(app).post('/api/search/terms').send({ text: query.query }).timeout({ response: 30_000, deadline: 60_000 });
    const parserMs = performance.now() - parserStarted;
    const config = { ...configBase, keywords: parsed.status === 200 ? parsed.body.keywords : [] };
    const relevant = new Set(query.gold_ids as string[]);
    const arms: Record<string, Arm> = {};
    const weights = index % 2 ? [0.2, 0] : [0, 0.2];
    for (const weight of weights) {
      const before = performance.now();
      try {
        process.env.ARTICLE_SEARCH_TITLE_RERANK_WEIGHT = String(weight);
        if (parsed.status !== 200) throw new Error(`query parser returned ${parsed.status}`);
        const response = await request(app).post('/api/run').send({ modeId: 'custom', config, options, filters })
          .timeout({ response: 30_000, deadline: 60_000 });
        if (response.status !== 200) throw new Error(`search API returned ${response.status}`);
        const top10 = response.body.active.slice(0, 10).map((item: {article:{id:string}}) => item.article.id.replace(/^miracl-ja-/, '')) as string[];
        const first = top10.findIndex((id: string) => relevant.has(id));
        const dcg = top10.reduce((sum: number, id: string, rank: number) => sum + (relevant.has(id) ? 1 / Math.log2(rank + 2) : 0), 0);
        const ideal = Array.from({ length: Math.min(relevant.size, 10) }, (_, rank) => 1 / Math.log2(rank + 2)).reduce((sum, value) => sum + value, 0);
        arms[String(weight)] = {
          weight, latencyMs: performance.now() - before, error: null, top10,
          hit1: first === 0, hit10: first >= 0,
          rr10: first >= 0 ? 1 / (first + 1) : 0,
          ndcg10: ideal > 0 ? dcg / ideal : 0,
          searchMethod: response.body.scope?.searchMethod ?? null,
        };
      } catch (error) {
        arms[String(weight)] = {
          weight, latencyMs: performance.now() - before, error: error instanceof Error ? error.message : String(error),
          top10: [], hit1: false, hit10: false, rr10: 0, ndcg10: 0, searchMethod: null,
        };
      }
    }
    results.push({ qid: query.id, group_id: query.group_id, query: query.query, gold_ids: query.gold_ids, arms, parserMs });
    if ((index + 1) % 10 === 0) console.log(JSON.stringify({ completed: index + 1, total: selected.length, elapsedSeconds: Math.round((performance.now() - started) / 1000), rssBytes: process.memoryUsage().rss }));
  }
  delete process.env.ARTICLE_SEARCH_TITLE_RERANK_WEIGHT;
  const armSummaries = Object.fromEntries([0, 0.2].map(weight => {
    const rows = results.map(row => row.arms[String(weight)]);
    return [String(weight), {
      errors: rows.filter(row => row.error).length,
      hit1: rows.filter(row => row.hit1).length,
      hit10: rows.filter(row => row.hit10).length,
      mrr10: rows.reduce((sum, row) => sum + row.rr10, 0) / Math.max(1, rows.length),
      ndcg10: rows.reduce((sum, row) => sum + row.ndcg10, 0) / Math.max(1, rows.length),
      apiP50Ms: percentile(rows.map(row => row.latencyMs), 0.5),
      apiP95Ms: percentile(rows.map(row => row.latencyMs), 0.95),
    }];
  }));
  const paired = results.reduce((counts, row) => {
    const base = row.arms['0'].hit10 && !row.arms['0'].error;
    const rerank = row.arms['0.2'].hit10 && !row.arms['0.2'].error;
    if (base && rerank) counts.both += 1;
    else if (base) counts.baseOnly += 1;
    else if (rerank) counts.rerankOnly += 1;
    else counts.neither += 1;
    return counts;
  }, { both: 0, baseOnly: 0, rerankOnly: 0, neither: 0 });
  const result = {
    dataset: 'MIRACL Japanese official full corpus; development representative sample; exploratory paired API comparison',
    method: 'Actual /api/search/terms and /api/run; same query and candidate path per arm; title weight alternates by query order to balance warm-cache order.',
    databasePath: path.resolve(databaseArg), queryPath: path.resolve(queriesArg), queryCount: results.length,
    weightValues: [0, 0.2], armSummaries, pairedHit10: paired,
    parserP50Ms: percentile(results.map(row => row.parserMs), 0.5),
    parserP95Ms: percentile(results.map(row => row.parserMs), 0.95),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    heapUsedBytes: process.memoryUsage().heapUsed,
    totalMs: performance.now() - started,
    results,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputArg) fs.writeFileSync(path.resolve(outputArg), serialized, 'utf8');
  console.log(JSON.stringify({ ...result, results: undefined }, null, 2));
} finally {
  delete process.env.ARTICLE_SEARCH_TITLE_RERANK_WEIGHT;
  db.close();
}
