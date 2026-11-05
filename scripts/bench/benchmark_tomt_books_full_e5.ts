import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { exactTopK } from './embedding_rankers.js';

type Document = { id: string; title: string; body: string };
type Query = { id: string; query: string; gold_ids: string[]; group_id: string; split: string };
type ModelModule = {
  env: { cacheDir: string; allowRemoteModels: boolean };
  pipeline: (task: string, model: string, options: object) => Promise<((texts: string[], options: object) => Promise<{ data: Float32Array; dims: number[] }>)>;
};

const [datasetArg, outputArg, queryCountArg] = process.argv.slice(2);
if (!datasetArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_tomt_books_full_e5.ts <books-data-dir> <new-output-under-local.json> [query-count=100]');
const datasetDir = path.resolve(datasetArg);
const outputPath = path.resolve(outputArg);
const queryCount = Number(queryCountArg ?? 100);
const localRoot = path.resolve('quality/e2e/local');
if (!outputPath.startsWith(`${localRoot}${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new file under the Git-ignored quality/e2e/local directory.');
if (!Number.isSafeInteger(queryCount) || queryCount < 20) throw new Error('query-count must be an integer of at least 20.');

const documents = fs.readFileSync(path.join(datasetDir, 'documents.jsonl'), 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Document);
const allQueries = fs.readFileSync(path.join(datasetDir, 'development.jsonl'), 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Query);
const provenance = JSON.parse(fs.readFileSync(path.join(datasetDir, 'provenance.json'), 'utf8')) as { upstream_zip_sha256: string; documents: number; split_sizes: { development: number } };
if (documents.length !== provenance.documents || allQueries.length !== provenance.split_sizes.development || allQueries.some(row => row.split !== 'development' || !row.gold_ids.length)) {
  throw new Error('Books dataset counts or development qrels do not match the provenance manifest.');
}
const documentIds = new Set(documents.map(row => row.id));
if (documentIds.size !== documents.length || allQueries.some(row => row.gold_ids.some(id => !documentIds.has(id)))) throw new Error('Books documents contain duplicate IDs or omit a known positive.');
const digest = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const queryGroups = new Map<string, Query[]>();
for (const row of allQueries) queryGroups.set(row.group_id, [...(queryGroups.get(row.group_id) ?? []), row]);
const hash = (value: string) => digest(value);
const queries = [...queryGroups.entries()]
  .sort(([left], [right]) => hash(left).localeCompare(hash(right)))
  .slice(0, queryCount)
  .map(([groupId, rows]) => rows.sort((left, right) => hash(`${groupId}\0${left.id}`).localeCompare(hash(`${groupId}\0${right.id}`)))[0]!);
if (queries.length !== queryCount) throw new Error(`Requested ${queryCount} target groups but selected ${queries.length}.`);
queries.sort((left, right) => left.id.localeCompare(right.id));

const runtimeRoot = path.resolve('quality/e2e/local/embedding-runtime');
const { env, pipeline: createPipeline } = createRequire(path.join(runtimeRoot, 'runner.cjs'))('@huggingface/transformers') as ModelModule;
env.cacheDir = path.resolve('quality/e2e/local/embedding-cache');
env.allowRemoteModels = false;
const modelId = 'Xenova/multilingual-e5-small';
const modelPath = path.join(env.cacheDir, modelId, 'onnx', 'model_quantized.onnx');
for (const file of [modelPath, path.join(env.cacheDir, modelId, 'tokenizer.json'), path.join(env.cacheDir, modelId, 'tokenizer_config.json')]) {
  if (!fs.existsSync(file)) throw new Error('Offline E5 model files are missing.');
}
const modelSha256 = digest(fs.readFileSync(modelPath));
const extractor = await createPipeline('feature-extraction', modelId, { dtype: 'q8' });
const dimension = 384;
const vectors = new Map<string, Float32Array>();
const embeddingStarted = performance.now();
for (let offset = 0; offset < documents.length; offset += 16) {
  const batch = documents.slice(offset, offset + 16);
  const inputs = batch.map(row => `passage: ${`${row.title} ${row.body}`.normalize('NFKC')}`);
  const result = await extractor(inputs, { pooling: 'mean', normalize: true });
  if (result.dims.at(-1) !== dimension || result.data.length !== batch.length * dimension) throw new Error('Unexpected E5 passage-vector shape.');
  batch.forEach((row, index) => vectors.set(row.id, result.data.slice(index * dimension, (index + 1) * dimension)));
  if ((offset + batch.length) % 256 === 0 || offset + batch.length === documents.length) {
    console.log(JSON.stringify({ phase: 'passage-embedding', completed: offset + batch.length, total: documents.length }));
  }
}
const embeddingPreparationMs = performance.now() - embeddingStarted;

const latencyMs: number[] = [];
const outcomes: Array<{ groupId: string; hit1: number; hit10: number; mrr10: number; ndcg10: number }> = [];
const queryRankings: Array<{ queryIdHash: string; groupIdHash: string; top100Ids: string[] }> = [];
const errors: string[] = [];
const searchStarted = performance.now();
for (const [index, row] of queries.entries()) {
  try {
    const started = performance.now();
    const encoded = await extractor([`query: ${row.query}`.normalize('NFKC')], { pooling: 'mean', normalize: true });
    if (encoded.data.length !== dimension) throw new Error('Unexpected E5 query-vector shape.');
    const queryVector = encoded.data;
    const scores = new Float32Array(documents.length);
    for (let docIndex = 0; docIndex < documents.length; docIndex++) {
      const vector = vectors.get(documents[docIndex]!.id)!;
      let score = 0;
      for (let axis = 0; axis < dimension; axis++) score += vector[axis]! * queryVector[axis]!;
      scores[docIndex] = score;
    }
    const top100 = exactTopK(scores, 100).map(item => documents[item.docIndex]!.id);
    const top10 = top100.slice(0, 10);
    const gold = new Set(row.gold_ids);
    const rank = top10.findIndex(id => gold.has(id));
    outcomes.push({ groupId: row.group_id, hit1: Number(rank === 0), hit10: Number(rank >= 0), mrr10: rank >= 0 ? 1 / (rank + 1) : 0, ndcg10: rank >= 0 ? 1 / Math.log2(rank + 2) : 0 });
    queryRankings.push({ queryIdHash: hash(row.id), groupIdHash: hash(row.group_id), top100Ids: top100 });
    latencyMs.push(performance.now() - started);
  } catch (error) {
    errors.push(error instanceof Error ? error.name : 'Error');
    outcomes.push({ groupId: row.group_id, hit1: 0, hit10: 0, mrr10: 0, ndcg10: 0 });
    latencyMs.push(0);
  }
  if ((index + 1) % 25 === 0 || index + 1 === queries.length) console.log(JSON.stringify({ phase: 'query-search', completed: index + 1, total: queries.length, errors: errors.length }));
}

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
let seed = Number.parseInt(digest(queries.map(row => row.id).join('\n')).slice(0, 8), 16) >>> 0;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
const groups = new Map<string, number[]>();
outcomes.forEach((row, index) => groups.set(row.groupId, [...(groups.get(row.groupId) ?? []), index]));
const clusters = [...groups.values()];
const bootstrap: number[] = [];
for (let sample = 0; sample < 10000; sample++) {
  let successes = 0;
  let total = 0;
  for (let draw = 0; draw < clusters.length; draw++) {
    const cluster = clusters[Math.floor(random() * clusters.length)]!;
    for (const index of cluster) { successes += outcomes[index]!.hit10; total++; }
  }
  bootstrap.push(total ? successes / total : 0);
}
bootstrap.sort((a, b) => a - b);
const mean = (key: 'hit1' | 'hit10' | 'mrr10' | 'ndcg10') => outcomes.reduce((sum, row) => sum + row[key], 0) / outcomes.length;
const result = {
  purpose: 'Exploratory full-corpus local E5 retrieval on a previously used Reddit-TOMT Books development set; not final evidence for article re-finding.',
  dataset: { name: 'Reddit-TOMT Books', split: 'development', documents: documents.length, queries: queries.length, groups: clusters.length, sourceSha256: provenance.upstream_zip_sha256, selectedQueryIdsSha256: digest(queries.map(row => `${row.group_id}\t${row.id}`).join('\n')), orderedQueryIdsSha256: digest(queries.map(row => row.id).join('\n')) },
  implementation: { method: 'Full-corpus exact cosine retrieval; no BM25 candidate restriction; E5 q8, 384 dimensions, query/passage prefixes, mean pooling, L2 normalization.', modelSha256, databaseChanged: false, queryTextIncluded: false },
  outcomes: { errors: errors.length, errorsByType: Object.fromEntries([...new Set(errors)].map(type => [type, errors.filter(error => error === type).length])), denominator: queries.length, hit1: mean('hit1'), hit10: mean('hit10'), mrr10: mean('mrr10'), ndcg10: mean('ndcg10'), hit10ClusterBootstrap95: [bootstrap[Math.floor(0.025 * (bootstrap.length - 1))]!, bootstrap[Math.floor(0.975 * (bootstrap.length - 1))]!] },
  latencyMs: { p50: percentile(latencyMs, 0.5), p95: percentile(latencyMs, 0.95) },
  phases: { embeddingPreparationMs, querySearchElapsedMs: performance.now() - searchStarted },
  perQueryRankings: queryRankings,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, dataset: result.dataset, outcomes: result.outcomes, latencyMs: result.latencyMs, phases: result.phases }, null, 2));
