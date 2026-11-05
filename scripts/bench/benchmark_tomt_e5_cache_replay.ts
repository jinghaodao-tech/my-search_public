import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

type Query = { id: string; query: string; gold_ids: string[]; group_id: string; split: string };
type BaselineRow = { id: string; group_id: string; query: string; gold_ids: string[]; bm25: { hit1: boolean; hit10: boolean; mrr10: number; ndcg10: number }; e5Rrf: { hit1: boolean; hit10: boolean; mrr10: number; ndcg10: number; top10: string[] } };
type SearchItem = { article?: { id?: string } };
type MetricRow = { hit1: boolean; hit10: boolean; mrr10: number; ndcg10: number; latencyMs: number; top10: string[] };

const baselinePath = path.resolve('artifacts/tomt-movies-e5-dev-100-offset0-20261025.json');
const outputPath = path.resolve('artifacts/tomt-movies-e5-cache10k-replay-20261025.json');
if (!fs.existsSync(baselinePath) || fs.existsSync(outputPath)) throw new Error('Expected the fixed Movies baseline and a new output path.');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as { dataset: { documents: number; queries: number }; perQuery: BaselineRow[] };
if (baseline.dataset.documents !== 8845 || baseline.dataset.queries !== 100 || baseline.perQuery.length !== 100) throw new Error('Unexpected Movies baseline dimensions.');
const queries = baseline.perQuery.map(row => ({ id: row.id, query: row.query, gold_ids: row.gold_ids, group_id: row.group_id, split: 'development' } satisfies Query));
const documents = fs.readFileSync('quality/e2e/data/reddit_tomt/movies/documents.jsonl', 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as { id: string });
if (documents.length !== baseline.dataset.documents) throw new Error('Movies corpus size does not match the frozen baseline.');

const databasePath = path.resolve('data/movies-dev-bm25-vs-rrf-20261022.sqlite');
process.env.DB_PATH = databasePath;
process.env.NODE_ENV = 'test';
process.env.SITE_SYNC = 'off';
process.env.CARD_SEARCH_ENGINE = 'e5-rrf';
process.env.CARD_SEARCH_E5_CANDIDATES = '100';
process.env.E5_VECTOR_CACHE_LIMIT = '10000';
delete process.env.API_KEY;
const [{ app }, requestModule, { db }, cardRepository] = await Promise.all([
  import('../../app.js'), import('supertest'), import('../../db/database.js'), import('../../repositories/cards_repository.js'),
]);
const request = requestModule.default;
const actualIds = (db.prepare('SELECT id FROM cards ORDER BY id').all() as Array<{ id: string }>).map(row => row.id);
const expectedIds = documents.map(row => row.id).sort((a, b) => a.localeCompare(b));
if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) throw new Error('Refusing to replay against a database with different article IDs.');
const indexStatus = cardRepository.savedCardTokenFtsStatus();
if (!indexStatus.ready || indexStatus.cards !== documents.length) throw new Error(`Saved-card index is not ready: ${JSON.stringify(indexStatus)}`);

const modes = await request(app).get('/api/modes');
if (modes.status !== 200 || !Object.keys(modes.body ?? {}).length) throw new Error('Could not load the application search mode.');
const baseMode = Object.values(modes.body)[0] as { description?: string; k1: number; b: number; lambda: number; contextBonus: number };
const rows: Array<{ query: Query; baseline: BaselineRow; result: MetricRow; error: string | null }> = [];
let peakRssBytes = process.memoryUsage().rss;
let peakHeapUsedBytes = process.memoryUsage().heapUsed;
const memorySampler = setInterval(() => {
  const usage = process.memoryUsage();
  peakRssBytes = Math.max(peakRssBytes, usage.rss);
  peakHeapUsedBytes = Math.max(peakHeapUsedBytes, usage.heapUsed);
}, 20);
const started = performance.now();

try {
  for (const query of queries) {
    const parsed = await request(app).post('/api/search/terms').send({ text: query.query }).timeout({ response: 30_000, deadline: 45_000 });
    if (parsed.status !== 200 || !Array.isArray(parsed.body?.keywords)) throw new Error(`Query parser failed for ${query.id}.`);
    const config = { label: 'tomt-movies-cache-replay', description: baseMode.description ?? '', k1: baseMode.k1, b: baseMode.b,
      lambda: baseMode.lambda, contextBonus: baseMode.contextBonus, keywords: parsed.body.keywords };
    const startedQuery = performance.now();
    try {
      const response = await request(app).post('/api/cards/search').send({ config,
        options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 50 },
        filters: { excludedTerms: [], sources: [], status: 'all' },
      }).timeout({ response: 45_000, deadline: 60_000 });
      if (response.status !== 200 || !Array.isArray(response.body?.active)) throw new Error(`HTTP ${response.status}`);
      const ranked = (response.body.active as SearchItem[]).slice(0, 50).map(item => item.article?.id).filter((id): id is string => typeof id === 'string');
      const gold = new Set(query.gold_ids);
      const first = ranked.findIndex(id => gold.has(id));
      const dcg = ranked.slice(0, 10).reduce((sum, id, rank) => sum + (gold.has(id) ? 1 / Math.log2(rank + 2) : 0), 0);
      const ideal = Array.from({ length: Math.min(gold.size, 10) }, (_, rank) => 1 / Math.log2(rank + 2)).reduce((sum, value) => sum + value, 0);
      const baselineRow = baseline.perQuery.find(row => row.id === query.id);
      if (!baselineRow || baselineRow.group_id !== query.group_id) throw new Error(`Query mapping mismatch for ${query.id}.`);
      rows.push({ query, baseline: baselineRow, result: { hit1: first === 0, hit10: first >= 0 && first < 10,
        mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0,
        latencyMs: performance.now() - startedQuery, top10: ranked.slice(0, 10) }, error: null });
    } catch (error) {
      rows.push({ query, baseline: baseline.perQuery.find(row => row.id === query.id)!, result: { hit1: false, hit10: false,
        mrr10: 0, ndcg10: 0, latencyMs: performance.now() - startedQuery, top10: [] }, error: error instanceof Error ? error.message : String(error) });
    }
  }
} finally {
  clearInterval(memorySampler);
}

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const resultMetrics = {
  queries: rows.length,
  errors: rows.filter(row => row.error).length,
  hit1: rows.filter(row => row.result.hit1).length / rows.length,
  hit10: rows.filter(row => row.result.hit10).length / rows.length,
  mrr10: rows.reduce((sum, row) => sum + row.result.mrr10, 0) / rows.length,
  ndcg10: rows.reduce((sum, row) => sum + row.result.ndcg10, 0) / rows.length,
  latencyP50Ms: percentile(rows.map(row => row.result.latencyMs), 0.5),
  latencyP95Ms: percentile(rows.map(row => row.result.latencyMs), 0.95),
  warmTailN: rows.slice(-25).length,
  warmTailP50Ms: percentile(rows.slice(-25).map(row => row.result.latencyMs), 0.5),
  warmTailP95Ms: percentile(rows.slice(-25).map(row => row.result.latencyMs), 0.95),
};
const exactTop10Matches = rows.filter(row => JSON.stringify(row.result.top10) === JSON.stringify(row.baseline.e5Rrf.top10)).length;
const paired = (metric: 'hit10' | 'mrr10' | 'ndcg10') => {
  const groups = new Map<string, number[]>();
  for (const row of rows) groups.set(row.query.group_id, [...(groups.get(row.query.group_id) ?? []), Number(row.result[metric]) - Number(row.baseline.bm25[metric])]);
  const clusters = [...groups.values()];
  let seed = 0x9d481a73;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const samples = new Array<number>(20_000);
  for (let draw = 0; draw < samples.length; draw++) {
    let sum = 0; let count = 0;
    for (let index = 0; index < clusters.length; index++) for (const value of clusters[Math.floor(random() * clusters.length)]!) { sum += value; count++; }
    samples[draw] = count ? sum / count : 0;
  }
  samples.sort((a, b) => a - b);
  return { meanDifference: rows.reduce((sum, row) => sum + Number(row.result[metric]) - Number(row.baseline.bm25[metric]), 0) / rows.length,
    clusterBootstrap95CI: [samples[499]!, samples[19_499]!], clusters: clusters.length, replicates: samples.length };
};
const result = {
  purpose: 'Cache-capacity replay of an already evaluated, fixed E5-RRF arm; not a new quality holdout.',
  dataset: { name: 'Reddit-TOMT Movies development', queries: rows.length, groups: new Set(rows.map(row => row.query.group_id)).size,
    queriesSha256: JSON.parse(fs.readFileSync(baselinePath, 'utf8')).dataset.queriesSha256, sourceSha256: '99cafecf4432dfe6c5677774cf92cbce9b9ab570823edfe39454718c2b91296a',
    databasePath, databaseReusedReadOnly: true, indexStatus },
  method: { endpoint: 'POST /api/search/terms + POST /api/cards/search', baselineArtifact: path.relative(process.cwd(), baselinePath),
    cacheLimit: Number(process.env.E5_VECTOR_CACHE_LIMIT), candidateCount: 100, sameQueryAndDocuments: true, rankingMode: 'e5-rrf', noUserDatabaseWrites: true },
  comparison: { baselineBm25: baseline.perQuery.reduce((sum, row) => sum + row.bm25.ndcg10, 0) / rows.length,
    baselineE5Rrf: baseline.perQuery.reduce((sum, row) => sum + row.e5Rrf.ndcg10, 0) / rows.length,
    replayE5Rrf: resultMetrics.ndcg10, top10ExactMatchesAgainstCache5000: exactTop10Matches, totalQueries: rows.length,
    pairedAgainstStandardBm25: { hit10: paired('hit10'), mrr10: paired('mrr10'), ndcg10: paired('ndcg10') } },
  replay: resultMetrics,
  resources: { processRssBytes: process.memoryUsage().rss, processHeapUsedBytes: process.memoryUsage().heapUsed, peakRssBytes, peakHeapUsedBytes,
    elapsedMs: performance.now() - started, memoryScope: 'whole isolated benchmark process; not incremental cache usage' },
  perQuery: rows.map(row => ({ id: row.query.id, group_id: row.query.group_id, error: row.error,
    bm25: row.baseline.bm25, priorE5RrfTop10: row.baseline.e5Rrf.top10, replayE5Rrf: row.result })),
};
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ outputPath, comparison: result.comparison, replay: result.replay, resources: result.resources }, null, 2));
db.close();
