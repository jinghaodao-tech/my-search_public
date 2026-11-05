import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { buildStoredTokenSet } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { reciprocalRankFusion } from './embedding_rankers.js';

type Query = { id: string; query: string; gold_ids: string[]; group_id: string };
type Candidate = { id: string; title: string; body: string };
type ModelModule = { env: { cacheDir: string; allowRemoteModels: boolean }; pipeline: (task: string, model: string, options: object) => Promise<((texts: string[], options: object) => Promise<{ data: Float32Array; dims: number[] }>)> };
type Method = 'fts5-bm25-top200' | 'e5-rerank-top200' | 'rrf-bm25-e5-top200';
type Metric = { hit1: number; hit10: number; hit100: number; mrr10: number; ndcg10: number; recall100: number };

const [queryPathArg, dbPathArg, outputArg, queryLimitArg = '100'] = process.argv.slice(2);
if (!queryPathArg || !dbPathArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_miracl_full_e5_candidates.ts <validation-representatives.jsonl> <read-only-full-corpus.sqlite> <new-artifacts-json> [query-limit=100|581]');
const queryPath = path.resolve(queryPathArg);
const dbPath = path.resolve(dbPathArg);
const outputPath = path.resolve(outputArg);
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new file under artifacts/.');
const queryRaw = readFileSync(queryPath);
const allQueries = queryRaw.toString('utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Query);
if (allQueries.length !== 581 || new Set(allQueries.map(query => query.group_id)).size !== 581) throw new Error(`Expected the 581 fixed MIRACL validation representatives; got ${allQueries.length}.`);
const queryLimit = Number(queryLimitArg);
if (![100, 581].includes(queryLimit)) throw new Error('query-limit must be 100 or 581.');
const queries = [...allQueries].sort((left, right) => crypto.createHash('sha256').update(left.id).digest('hex').localeCompare(crypto.createHash('sha256').update(right.id).digest('hex'))).slice(0, queryLimit);
const digestFile = (file: string) => new Promise<string>((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const expression = (tokens: string[]) => [...new Set(tokens.map(token => token.trim()).filter(Boolean))]
  .map(token => `"${token.replace(/"/gu, '""')}"`).join(' OR ');

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const docCount = (db.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number }).n;
if (docCount !== 6_953_614) throw new Error(`Expected 6,953,614 MIRACL passages; got ${docCount}.`);
const fts = db.prepare('SELECT id, rank AS score FROM articles_morph_fts WHERE articles_morph_fts MATCH ? ORDER BY rank, id LIMIT 200');
const candidateLookup = db.prepare('SELECT id,title,body FROM articles WHERE id=?');
type Prepared = { query: Query; bm25Ids: string[]; candidates: Candidate[]; bm25Ms: number };
const prepared: Prepared[] = [];
const uniqueCandidates = new Map<string, Candidate>();
const parserMs: number[] = [];
const retrievalMs: number[] = [];
const started = performance.now();
try {
  for (const [index, query] of queries.entries()) {
    const parserStarted = performance.now();
    const words = await purposeWords(query.query);
    const parsed = analyzeQuery(query.query, words.length ? words : query.query.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
    const tokenSet = await buildStoredTokenSet(parsed.keywords.map(item => item.term).join(' '));
    const match = expression(tokenSet.morphologicalTokens);
    parserMs.push(performance.now() - parserStarted);
    const retrievalStarted = performance.now();
    const bm25Ids = match ? (fts.all(match) as Array<{ id: string }>).map(row => row.id) : [];
    const candidates: Candidate[] = [];
    for (const id of bm25Ids) {
      const row = candidateLookup.get(id) as Candidate | undefined;
      if (!row) throw new Error(`FTS candidate is missing from articles: ${id}`);
      candidates.push(row);
      uniqueCandidates.set(id, row);
    }
    retrievalMs.push(performance.now() - retrievalStarted);
    prepared.push({ query, bm25Ids, candidates, bm25Ms: retrievalMs.at(-1)! + parserMs.at(-1)! });
    if ((index + 1) % 25 === 0 || index + 1 === queries.length) console.log(JSON.stringify({ phase: 'fts-retrieval', completed: index + 1, total: queries.length, uniqueCandidates: uniqueCandidates.size, elapsedSeconds: Math.round((performance.now() - started) / 1000) }));
  }
} finally {
  db.close();
}

const runtimeRoot = path.resolve('quality/e2e/local/embedding-runtime');
const require = createRequire(path.join(runtimeRoot, 'runner.cjs'));
const { env, pipeline: createPipeline } = require('@huggingface/transformers') as ModelModule;
env.cacheDir = path.resolve('quality/e2e/local/embedding-cache');
env.allowRemoteModels = false;
const modelId = 'Xenova/multilingual-e5-small';
const modelPath = path.join(env.cacheDir, modelId, 'onnx', 'model_quantized.onnx');
for (const file of [modelPath, path.join(env.cacheDir, modelId, 'tokenizer.json'), path.join(env.cacheDir, modelId, 'tokenizer_config.json')]) {
  if (!fs.existsSync(file)) throw new Error(`Offline model asset missing: ${file}`);
}
const modelSha256 = await digestFile(modelPath);
console.log(JSON.stringify({ phase: 'model-loading', model: modelId, quantization: 'q8', uniqueCandidates: uniqueCandidates.size }));
const extractor = await createPipeline('feature-extraction', modelId, { dtype: 'q8' });
const dimension = 384;
const vectorIds = [...uniqueCandidates.keys()].sort((a, b) => a.localeCompare(b));
const vectorById = new Map<string, Float32Array>();
const embeddingStarted = performance.now();
for (let offset = 0; offset < vectorIds.length; offset += 32) {
  const ids = vectorIds.slice(offset, offset + 32);
  const texts = ids.map(id => {
    const row = uniqueCandidates.get(id)!;
    return `passage: ${`${row.title} ${row.body}`.normalize('NFKC')}`;
  });
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  if (output.dims.at(-1) !== dimension || output.data.length !== ids.length * dimension) throw new Error(`Unexpected E5 output shape ${output.dims.join('x')}.`);
  ids.forEach((id, index) => vectorById.set(id, output.data.slice(index * dimension, (index + 1) * dimension)));
  if ((offset + ids.length) % 1024 === 0 || offset + ids.length === vectorIds.length) console.log(JSON.stringify({ phase: 'candidate-embedding', completed: offset + ids.length, total: vectorIds.length, elapsedSeconds: Math.round((performance.now() - embeddingStarted) / 1000), rssBytes: process.memoryUsage().rss }));
}
const embeddingBuildMs = performance.now() - embeddingStarted;

const perQuery: Array<{ id: string; groupId: string; q: string; goldCount: number; candidateHit: boolean; metrics: Record<Method, Metric>; latencyMs: Record<Method, number>; top10: Record<Method, string[]> }> = [];
const latencies: Record<Method, number[]> = { 'fts5-bm25-top200': [], 'e5-rerank-top200': [], 'rrf-bm25-e5-top200': [] };
const queryEmbeddingMs: number[] = [];
for (const [index, item] of prepared.entries()) {
  const qeStart = performance.now();
  const qe = await extractor([`query: ${item.query.query}`.normalize('NFKC')], { pooling: 'mean', normalize: true });
  if (qe.data.length !== dimension) throw new Error(`Unexpected query embedding dimensions for ${item.query.id}.`);
  const qeMs = performance.now() - qeStart;
  queryEmbeddingMs.push(qeMs);
  const denseStart = performance.now();
  const e5Ids = item.bm25Ids.map(id => {
    const vector = vectorById.get(id)!;
    let score = 0;
    for (let axis = 0; axis < dimension; axis++) score += vector[axis]! * qe.data[axis]!;
    return { id, score };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(row => row.id);
  const e5ScoringMs = performance.now() - denseStart;
  const rrfStarted = performance.now();
  const fused = reciprocalRankFusion([item.bm25Ids, e5Ids], 60, 200);
  const fusionMs = performance.now() - rrfStarted;
  const rankings: Record<Method, string[]> = { 'fts5-bm25-top200': item.bm25Ids, 'e5-rerank-top200': e5Ids, 'rrf-bm25-e5-top200': fused };
  const gold = new Set(item.query.gold_ids.map(id => `miracl-ja-${id}`));
  const metricsFor = (ids: string[]): Metric => {
    const first = ids.findIndex(id => gold.has(id));
    const dcg = ids.slice(0, 10).reduce((sum, id, rank) => sum + (gold.has(id) ? 1 / Math.log2(rank + 2) : 0), 0);
    const ideal = Array.from({ length: Math.min(gold.size, 10) }, (_, rank) => 1 / Math.log2(rank + 2)).reduce((sum, value) => sum + value, 0);
    const relevantAt100 = ids.slice(0, 100).filter(id => gold.has(id)).length;
    return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0, hit100: first >= 0 && first < 100 ? 1 : 0,
      mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0,
      recall100: gold.size ? relevantAt100 / gold.size : 0 };
  };
  const metrics = Object.fromEntries(Object.entries(rankings).map(([method, ids]) => [method, metricsFor(ids)])) as Record<Method, Metric>;
  const denseMs = item.bm25Ms + qeMs + e5ScoringMs;
  const rrfMs = denseMs + fusionMs;
  const latencyMs: Record<Method, number> = { 'fts5-bm25-top200': item.bm25Ms, 'e5-rerank-top200': denseMs, 'rrf-bm25-e5-top200': rrfMs };
  for (const method of Object.keys(latencyMs) as Method[]) latencies[method].push(latencyMs[method]);
  perQuery.push({ id: item.query.id, groupId: item.query.group_id, q: item.query.query, goldCount: gold.size,
    candidateHit: item.bm25Ids.some(id => gold.has(id)), metrics, latencyMs,
    top10: Object.fromEntries(Object.entries(rankings).map(([method, ids]) => [method, ids.slice(0, 10)])) as Record<Method, string[]> });
  if ((index + 1) % 50 === 0 || index + 1 === prepared.length) console.log(JSON.stringify({ phase: 'reranking', completed: index + 1, total: prepared.length, elapsedSeconds: Math.round((performance.now() - started) / 1000) }));
}

const methods: Method[] = ['fts5-bm25-top200', 'e5-rerank-top200', 'rrf-bm25-e5-top200'];
const meanMetric = (method: Method, key: keyof Metric) => perQuery.reduce((sum, row) => sum + row.metrics[method][key], 0) / perQuery.length;
let seed = Number.parseInt(crypto.createHash('sha256').update(queryRaw).update('miracl-full-e5-rerank-bootstrap-v1').digest('hex').slice(0, 8), 16) >>> 0;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
const clusterBootstrap = (method: Method, metric: keyof Metric, draws = 20000) => {
  const groups = new Map<string, number[]>();
  for (const row of perQuery) groups.set(row.groupId, [...(groups.get(row.groupId) ?? []), row.metrics[method][metric] - row.metrics['fts5-bm25-top200'][metric]]);
  const clusters = [...groups.values()];
  const values = new Array<number>(draws);
  for (let draw = 0; draw < draws; draw++) {
    let total = 0; let n = 0;
    for (let i = 0; i < clusters.length; i++) { const cluster = clusters[Math.floor(random() * clusters.length)]!; total += cluster.reduce((a, b) => a + b, 0); n += cluster.length; }
    values[draw] = n ? total / n : 0;
  }
  values.sort((a, b) => a - b);
  return { meanDifference: meanMetric(method, metric) - meanMetric('fts5-bm25-top200', metric), clusterBootstrap95CI: [values[Math.floor(draws * .025)]!, values[Math.floor(draws * .975)]!], clusters: clusters.length };
};
const result = {
  purpose: 'Exploratory transfer evaluation on the full 6,953,614-document MIRACL Japanese corpus. The validation split has already been used for FTS/title-weight exploration; this is not an independent confirmatory result.',
  dataset: { name: 'MIRACL Japanese validation representatives', queries: queries.length, selection: 'lowest SHA-256 query-ID hashes, fixed before evaluation and independent of text/ranking', selectionCount: queryLimit, independentPositiveTargetClusters: new Set(queries.map(row => row.group_id)).size,
    documents: docCount, queryPath, querySha256: crypto.createHash('sha256').update(queryRaw).digest('hex'), databasePath: dbPath, databaseBytes: fs.statSync(dbPath).size,
    model: 'Xenova/multilingual-e5-small', modelSha256, quantization: 'q8', dimensions: dimension, candidateDepth: 200, uniqueCandidates: uniqueCandidates.size },
  queryAnalysis: 'Same purposeWords(), purposeTermWeight(), analyzeQuery(), and morphology token preparation as existing MIRACL FTS5 benchmark.',
  methods: {
    'fts5-bm25-top200': 'SQLite FTS5 built-in BM25 morphology ranking over full corpus, top 200 candidates.',
    'e5-rerank-top200': 'E5 q8 cosine reranking restricted to the same top 200 FTS5 morphology candidates; no documents are added.',
    'rrf-bm25-e5-top200': 'RRF k=60 between the full-corpus FTS5 top-200 list and E5 reranking of those same candidates.',
  },
  metrics: Object.fromEntries(methods.map(method => [method, Object.fromEntries((['hit1', 'hit10', 'hit100', 'mrr10', 'ndcg10', 'recall100'] as const).map(key => [key, meanMetric(method, key)]))])),
  pairedClusterBootstrap: Object.fromEntries(methods.filter(method => method !== 'fts5-bm25-top200').map(method => [method, Object.fromEntries((['hit10', 'ndcg10', 'mrr10', 'recall100'] as const).map(key => [key, clusterBootstrap(method, key)]))])),
  latencyMs: Object.fromEntries(methods.map(method => [method, { p50: percentile(latencies[method], .5), p95: percentile(latencies[method], .95), mean: latencies[method].reduce((a, b) => a + b, 0) / latencies[method].length }])),
  phases: { parserP50Ms: percentile(parserMs, .5), parserP95Ms: percentile(parserMs, .95), ftsRetrievalP50Ms: percentile(retrievalMs, .5), ftsRetrievalP95Ms: percentile(retrievalMs, .95),
    queryEmbeddingP50Ms: percentile(queryEmbeddingMs, .5), queryEmbeddingP95Ms: percentile(queryEmbeddingMs, .95), candidateEmbeddingBuildMs: embeddingBuildMs,
    uniqueCandidateDocuments: uniqueCandidates.size, candidateVectorBytes: uniqueCandidates.size * dimension * Float32Array.BYTES_PER_ELEMENT },
  resources: { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, totalElapsedMs: performance.now() - started },
  perQuery,
};
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, dataset: result.dataset, metrics: result.metrics, pairedClusterBootstrap: result.pairedClusterBootstrap,
  latencyMs: result.latencyMs, phases: result.phases, resources: result.resources }, null, 2));
