import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { buildStoredTokenSet } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { reciprocalRankFusion } from './embedding_rankers.js';

type Query = { query_id: string; query: string };
type Candidate = { id: string; title: string; body: string };
type ModelModule = {
  env: { cacheDir: string; allowRemoteModels: boolean };
  pipeline: (task: string, model: string, options: object) => Promise<((texts: string[], options: object) => Promise<{ data: Float32Array; dims: number[] }>)>;
};

const dataDir = path.resolve(process.argv[2] ?? 'quality/e2e/local/ntcir-tot-2026-ja');
const databasePath = path.resolve(process.argv[3] ?? path.join(dataDir, 'corpus.sqlite'));
const outputPath = path.resolve(process.argv[4] ?? 'artifacts/ntcir-tot-2026-ja-dev-e5-20261026.json');
const candidateDepth = Number(process.argv[5] ?? 100);
const queriesPath = path.join(dataDir, 'queries-dev-ja.jsonl');
const qrelsPath = path.join(dataDir, 'qrels-dev-ja.txt');
const indexManifestPath = path.join(dataDir, 'index-provenance.json');
if (!fs.existsSync(queriesPath) || !fs.existsSync(qrelsPath) || !fs.existsSync(indexManifestPath)) {
  throw new Error('NTCIR dev queries, qrels, or validated corpus-index manifest are missing.');
}
if (!Number.isSafeInteger(candidateDepth) || candidateDepth < 10 || candidateDepth > 200) throw new Error('candidateDepth must be between 10 and 200.');
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new file under artifacts/.');

const queryBytes = fs.readFileSync(queriesPath);
const qrelBytes = fs.readFileSync(qrelsPath);
const sourceQueries = queryBytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Query);
const positives = new Map<string, string>();
for (const line of qrelBytes.toString('utf8').split(/\r?\n/u).filter(Boolean)) {
  const [queryId, _iteration, documentId, grade] = line.trim().split(/\s+/u);
  if (!queryId || !documentId || grade !== '1' || positives.has(queryId)) throw new Error('Unexpected NTCIR qrels structure.');
  positives.set(queryId, documentId);
}
if (sourceQueries.length !== 500 || positives.size !== sourceQueries.length || new Set(sourceQueries.map(query => query.query_id)).size !== sourceQueries.length) {
  throw new Error(`Expected the complete 500-query NTCIR Japanese dev set with one qrel each; got ${sourceQueries.length} queries and ${positives.size} qrels.`);
}
const groupByQuery = new Map(sourceQueries.map(query => [query.query_id, positives.get(query.query_id)!]));
const parent = new Map<string, string>();
const find = (id: string): string => {
  const known = parent.get(id);
  if (!known) { parent.set(id, id); return id; }
  if (known === id) return id;
  const root = find(known);
  parent.set(id, root);
  return root;
};
for (const query of sourceQueries) {
  const root = find(`q:${query.query_id}`);
  const docRoot = find(`d:${positives.get(query.query_id)!}`);
  if (root !== docRoot) parent.set(docRoot, root);
}
const groupIds = new Map(sourceQueries.map(query => [query.query_id, find(`q:${query.query_id}`)]));

const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const expression = (tokens: string[]) => [...new Set(tokens.map(token => token.trim()).filter(Boolean))]
  .map(token => `"${token.replace(/"/gu, '""')}"`).join(' OR ');

const database = new Database(databasePath, { readonly: true, fileMustExist: true });
const documentCount = (database.prepare('SELECT COUNT(*) AS count FROM articles').get() as { count: number }).count;
if (documentCount !== 1_389_467) throw new Error(`Expected 1,389,467 indexed Japanese Wikipedia pages; got ${documentCount}.`);
const fts = database.prepare('SELECT id FROM articles_morph_fts WHERE articles_morph_fts MATCH ? ORDER BY rank,id LIMIT ?');
const articleById = database.prepare('SELECT id,title,body FROM articles WHERE id=?');
const prepared: Array<{ query: Query; goldId: string; groupId: string; bm25Ids: string[] }> = [];
const uniqueCandidates = new Map<string, Candidate>();
const parserMs: number[] = [];
const retrievalMs: number[] = [];
const runStarted = performance.now();
const errors: Array<{ queryIdHash: string; type: string }> = [];

for (const query of sourceQueries) {
  const queryId = query.query_id;
  try {
    const parseStarted = performance.now();
    const words = await purposeWords(query.query);
    const parsed = analyzeQuery(query.query, words.length ? words : query.query.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
    const tokens = await buildStoredTokenSet(parsed.keywords.map(item => item.term).join(' '));
    const match = expression(tokens.morphologicalTokens);
    parserMs.push(performance.now() - parseStarted);

    const retrievalStarted = performance.now();
    const bm25Ids = match ? (fts.all(match, candidateDepth) as Array<{ id: string }>).map(row => row.id) : [];
    retrievalMs.push(performance.now() - retrievalStarted);
    for (const id of bm25Ids) {
      const row = articleById.get(id) as Candidate | undefined;
      if (!row) throw new Error('An FTS candidate has no article row.');
      uniqueCandidates.set(id, row);
    }
    prepared.push({ query, goldId: positives.get(queryId)!, groupId: groupIds.get(queryId)!, bm25Ids });
  } catch (error) {
    errors.push({ queryIdHash: crypto.createHash('sha256').update(queryId).digest('hex'), type: error instanceof Error ? error.name : 'Error' });
    prepared.push({ query, goldId: positives.get(queryId)!, groupId: groupIds.get(queryId)!, bm25Ids: [] });
  }
}
database.close();

const runtimeRoot = path.resolve('quality/e2e/local/embedding-runtime');
const runtimePackage = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'node_modules/@huggingface/transformers/package.json'), 'utf8')) as { version: string };
const { env, pipeline: createPipeline } = createRequire(path.join(runtimeRoot, 'runner.cjs'))('@huggingface/transformers') as ModelModule;
env.cacheDir = path.resolve('quality/e2e/local/embedding-cache');
env.allowRemoteModels = false;
const modelId = 'Xenova/multilingual-e5-small';
const modelPath = path.join(env.cacheDir, modelId, 'onnx', 'model_quantized.onnx');
for (const file of [modelPath, path.join(env.cacheDir, modelId, 'tokenizer.json'), path.join(env.cacheDir, modelId, 'tokenizer_config.json')]) {
  if (!fs.existsSync(file)) throw new Error(`Offline E5 asset missing: ${file}`);
}
const modelSha256 = await new Promise<string>((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(modelPath).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});
const extractor = await createPipeline('feature-extraction', modelId, { dtype: 'q8' });
const dimension = 384;
const vectorById = new Map<string, Float32Array>();
const vectorIds = [...uniqueCandidates.keys()].sort((a, b) => a.localeCompare(b));
const candidateEmbeddingStarted = performance.now();
for (let offset = 0; offset < vectorIds.length; offset += 32) {
  const ids = vectorIds.slice(offset, offset + 32);
  const texts = ids.map(id => {
    const candidate = uniqueCandidates.get(id)!;
    return `passage: ${`${candidate.title} ${candidate.body}`.normalize('NFKC')}`;
  });
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  if (output.dims.at(-1) !== dimension || output.data.length !== ids.length * dimension) throw new Error('Unexpected E5 candidate-vector shape.');
  ids.forEach((id, index) => vectorById.set(id, output.data.slice(index * dimension, (index + 1) * dimension)));
  if ((offset + ids.length) % 1024 === 0 || offset + ids.length === vectorIds.length) {
    console.log(JSON.stringify({ phase: 'candidate-embedding', completed: offset + ids.length, total: vectorIds.length, elapsedSeconds: Math.round((performance.now() - candidateEmbeddingStarted) / 1000) }));
  }
}
const candidateEmbeddingMs = performance.now() - candidateEmbeddingStarted;

type Method = 'fts5-bm25' | 'e5-rerank' | 'rrf-bm25-e5';
const methods: Method[] = ['fts5-bm25', 'e5-rerank', 'rrf-bm25-e5'];
const scores: Record<Method, Array<{ hit1: number; hit10: number; ndcg10: number; mrr10: number; candidateHit: number }>> = {
  'fts5-bm25': [], 'e5-rerank': [], 'rrf-bm25-e5': [],
};
const latency: Record<Method, number[]> = { 'fts5-bm25': [], 'e5-rerank': [], 'rrf-bm25-e5': [] };
const queryEmbeddingMs: number[] = [];
for (const [index, item] of prepared.entries()) {
  const queryStarted = performance.now();
  let queryVector: Float32Array<ArrayBufferLike> = new Float32Array(dimension);
  let embeddingMs = 0;
  let queryEmbeddingFailed = false;
  try {
    const started = performance.now();
    const output = await extractor([`query: ${item.query.query}`.normalize('NFKC')], { pooling: 'mean', normalize: true });
    if (output.data.length !== dimension) throw new Error('Unexpected E5 query-vector shape.');
    queryVector = output.data;
    embeddingMs = performance.now() - started;
    queryEmbeddingMs.push(embeddingMs);
  } catch {
    queryEmbeddingFailed = true;
    errors.push({ queryIdHash: crypto.createHash('sha256').update(item.query.query_id).digest('hex'), type: 'QueryEmbeddingError' });
  }
  const e5Ids = item.bm25Ids.map(id => {
    const vector = vectorById.get(id)!;
    let score = 0;
    for (let axis = 0; axis < dimension; axis++) score += vector[axis]! * queryVector[axis]!;
    return { id, score };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(row => row.id);
  const fusedIds = reciprocalRankFusion([item.bm25Ids, e5Ids], 60, candidateDepth);
  const ranked: Record<Method, string[]> = { 'fts5-bm25': item.bm25Ids, 'e5-rerank': e5Ids, 'rrf-bm25-e5': fusedIds };
  for (const method of methods) {
    const list = ranked[method];
    const rank = list.indexOf(item.goldId);
    const failed = (method !== 'fts5-bm25' && queryEmbeddingFailed) || (method === 'fts5-bm25' && errors.some(error => error.queryIdHash === crypto.createHash('sha256').update(item.query.query_id).digest('hex') && error.type !== 'QueryEmbeddingError'));
    const hit1 = Number(!failed && rank === 0);
    const hit10 = Number(!failed && rank >= 0 && rank < 10);
    const dcg = !failed && rank >= 0 && rank < 10 ? 1 / Math.log2(rank + 2) : 0;
    const duration = method === 'fts5-bm25'
      ? (parserMs[index] ?? 0) + (retrievalMs[index] ?? 0)
      : (parserMs[index] ?? 0) + (retrievalMs[index] ?? 0) + embeddingMs;
    latency[method].push(duration);
    scores[method].push({ hit1, hit10, ndcg10: dcg, mrr10: hit10 ? 1 / (rank + 1) : 0, candidateHit: Number(item.bm25Ids.includes(item.goldId)) });
  }
  if ((index + 1) % 50 === 0 || index + 1 === prepared.length) console.log(JSON.stringify({ phase: 'rerank', completed: index + 1, total: prepared.length, errors: errors.length }));
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const metricSummary = (method: Method) => Object.fromEntries((['hit1', 'hit10', 'ndcg10', 'mrr10', 'candidateHit'] as const)
  .map(metric => [metric, mean(scores[method].map(row => row[metric]))]));
let seed = Number.parseInt(digest(queryBytes).slice(0, 8), 16) >>> 0;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
const hitInterval = (method: Method, draws = 20000) => {
  const clusterRows = new Map<string, number[]>();
  prepared.forEach((query, index) => clusterRows.set(query.groupId, [...(clusterRows.get(query.groupId) ?? []), scores[method][index]!.hit10]));
  const clusters = [...clusterRows.values()];
  const samples = new Array<number>(draws);
  for (let i = 0; i < draws; i++) {
    let successes = 0; let total = 0;
    for (let j = 0; j < clusters.length; j++) {
      const sample = clusters[Math.floor(random() * clusters.length)]!;
      successes += sample.reduce((sum, value) => sum + value, 0);
      total += sample.length;
    }
    samples[i] = total ? successes / total : 0;
  }
  samples.sort((a, b) => a - b);
  return { percentile95: [samples[Math.floor(draws * .025)]!, samples[Math.floor(draws * .975)]!], targetGroups: clusters.length, draws };
};
const indexManifest = JSON.parse(fs.readFileSync(indexManifestPath, 'utf8')) as { corpusSha256: string; corpusMd5: string; documents: number };
const result = {
  purpose: 'Exploratory development-only benchmark on NTCIR 2026 Japanese ToT dev. All queries are synthetic; this is not human-query final evidence.',
  dataset: {
    name: 'NTCIR-ToT-2026-ja-dev', queries: sourceQueries.length, qrels: positives.size,
    uniquePositiveDocuments: new Set(positives.values()).size, groups: new Set(groupIds.values()).size,
    querySha256: digest(queryBytes), qrelsSha256: digest(qrelBytes), corpusMd5: indexManifest.corpusMd5,
    corpusSha256: indexManifest.corpusSha256, documents: documentCount,
  },
  implementation: {
    applicationBaseline: 'my-search query parsing + morphology-tokenized SQLite FTS5 BM25; same top-candidate depth for all methods.',
    e5: 'Xenova/multilingual-e5-small q8, 384 dimensions, query/passage prefixes, mean pooling, L2 normalization.',
    fusion: 'Equal reciprocal-rank fusion, k=60, restricted to BM25 candidates.',
    candidateDepth, modelSha256, transformersVersion: runtimePackage.version,
    embeddingPreparationMs: candidateEmbeddingMs, uniqueCandidates: vectorIds.length,
    databaseReadOnly: true, productionDatabaseChanged: false, outputContainsQueryText: false,
  },
  outcomes: {
    errors: errors.length, errorsByType: Object.fromEntries([...new Set(errors.map(error => error.type))].map(type => [type, errors.filter(error => error.type === type).length])),
    denominator: sourceQueries.length,
    metrics: Object.fromEntries(methods.map(method => [method, metricSummary(method)])),
    hit10ClusterBootstrap95: Object.fromEntries(methods.map(method => [method, hitInterval(method)])),
    candidateMisses: prepared.filter((_, index) => scores['fts5-bm25'][index]?.candidateHit === 0).length,
    rerankMissesAfterCandidateHit: prepared.filter((_, index) => scores['fts5-bm25'][index]?.candidateHit === 1 && scores['rrf-bm25-e5'][index]?.hit10 === 0).length,
  },
  latencyMs: Object.fromEntries(methods.map(method => [method, { p50: percentile(latency[method], .5), p95: percentile(latency[method], .95) }])),
  phases: { parserP95: percentile(parserMs, .95), retrievalP95: percentile(retrievalMs, .95), queryEmbeddingP95: percentile(queryEmbeddingMs, .95), totalElapsedMs: performance.now() - runStarted },
};
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, dataset: result.dataset, outcomes: result.outcomes, latencyMs: result.latencyMs, phases: result.phases }, null, 2));
