import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream, createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { finished } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { tokenizeMorphological } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { scoreWeightedBm25 } from './bm25_rm3.js';
import { exactTopK, reciprocalRankFusion, type ScoredDocument } from './embedding_rankers.js';

type Document = { _id: string; title?: string; text?: string };
type Query = { _id: string; text: string };
type Metrics = { hit1: number; hit10: number; mrr10: number; ndcg10: number; map100: number; recall100: number };
type QueryCase = { id: string; groupId: string; text: string; judgments: Map<string, number> };
type ModelModule = { env: { cacheDir: string; allowRemoteModels: boolean }; pipeline: (task: string, model: string, options: object) => Promise<((texts: string[], options: object) => Promise<{ data: Float32Array; dims: number[] }>)> };

const [datasetArg, splitArg, indexArg, outputArg, queryLimitArg] = process.argv.slice(2);
if (!datasetArg || !['dev', 'test'].includes(splitArg ?? '') || !indexArg || !outputArg) {
  throw new Error('Usage: tsx scripts/bench/benchmark_beir_e5_embeddings.ts <dataset-dir> <dev|test> <read-only-index.sqlite> <new-output.json> [query-limit]');
}
const queryLimit = queryLimitArg === undefined ? Number.POSITIVE_INFINITY : Number(queryLimitArg);
if (!(queryLimit === Number.POSITIVE_INFINITY || (Number.isInteger(queryLimit) && queryLimit > 0))) throw new Error('query-limit must be a positive integer.');
const datasetDir = path.resolve(datasetArg);
const indexPath = path.resolve(indexArg);
const outputPath = path.resolve(outputArg);
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new path under artifacts/.');
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const queriesPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels', `${splitArg}.tsv`);
for (const file of [corpusPath, queriesPath, qrelsPath, indexPath]) if (!fs.existsSync(file)) throw new Error(`Missing input: ${file}`);
const hashFile = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJsonl = async function* <T>(file: string): AsyncGenerator<T> {
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line) as T;
};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const shaFile = (file: string) => new Promise<string>((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});

const queryTexts = new Map<string, string>();
for await (const query of readJsonl<Query>(queriesPath)) queryTexts.set(query._id, query.text);
const qrelMap = new Map<string, Map<string, number>>();
for (const [lineNumber, line] of fs.readFileSync(qrelsPath, 'utf8').split(/\r?\n/u).entries()) {
  if (!line.trim() || line.startsWith('query-id')) continue;
  const [queryId, docId, gradeText] = line.split('\t');
  if (!queryId || !docId || !queryTexts.has(queryId) || !Number.isFinite(Number(gradeText))) throw new Error(`Invalid qrels row ${lineNumber + 1}.`);
  const judgments = qrelMap.get(queryId) ?? new Map<string, number>();
  judgments.set(docId, Math.max(judgments.get(docId) ?? 0, Number(gradeText)));
  qrelMap.set(queryId, judgments);
}
const parents = new Map<string, string>();
const find = (id: string): string => {
  const parent = parents.get(id);
  if (!parent) { parents.set(id, id); return id; }
  if (parent === id) return id;
  const root = find(parent); parents.set(id, root); return root;
};
for (const [queryId, judgments] of qrelMap) for (const [docId, grade] of judgments) if (grade > 0) {
  const queryRoot = find(`q:${queryId}`);
  const docRoot = find(`d:${docId}`);
  if (queryRoot !== docRoot) parents.set(docRoot, queryRoot);
}
const allQueries: QueryCase[] = [...qrelMap].map(([id, judgments]) => ({
  id, groupId: parents.has(`q:${id}`) ? find(`q:${id}`) : `q:${id}`, text: queryTexts.get(id)!, judgments,
}));
const queries = Number.isFinite(queryLimit)
  ? allQueries.sort((left, right) => crypto.createHash('sha256').update(left.id).digest('hex').localeCompare(crypto.createHash('sha256').update(right.id).digest('hex'))).slice(0, queryLimit)
  : allQueries;
if (!queries.length) throw new Error('No qrels for selected split.');

const runtimeRoot = path.resolve('quality/e2e/local/embedding-runtime');
const require = createRequire(path.join(runtimeRoot, 'runner.cjs'));
const { env, pipeline: createPipeline } = require('@huggingface/transformers') as ModelModule;
env.cacheDir = path.resolve('quality/e2e/local/embedding-cache');
env.allowRemoteModels = false;
console.log('loading cached E5 q8 model');
const extractor = await createPipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' });
console.log('model loaded; reading corpus and index');
const modelPath = path.join(env.cacheDir, 'Xenova/multilingual-e5-small/onnx/model_quantized.onnx');
if (!fs.existsSync(modelPath)) throw new Error(`Offline model cache missing: ${modelPath}`);
const modelSha256 = await shaFile(modelPath);
const runtimePackage = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'node_modules/@huggingface/transformers/package.json'), 'utf8')) as { version: string };
const tokenizerSha256 = crypto.createHash('sha256').update(await shaFile(path.join(env.cacheDir, 'Xenova/multilingual-e5-small/tokenizer.json')))
  .update(await shaFile(path.join(env.cacheDir, 'Xenova/multilingual-e5-small/tokenizer_config.json'))).digest('hex');

const db = new Database(indexPath, { readonly: true, fileMustExist: true });
const indexDocuments = db.prepare('SELECT id,length FROM documents ORDER BY id').all() as Array<{ id: string; length: number }>;
const documentIndex = new Map(indexDocuments.map((row, index) => [row.id, index]));
const lengths = indexDocuments.map(row => row.length);
const documentTexts = new Array<string | undefined>(indexDocuments.length);
const seenIds = new Set<string>();
const paritySamples: Array<{ id: string; hash: string; text: string }> = [];
for await (const document of readJsonl<Document>(corpusPath)) {
  if (!document._id || seenIds.has(document._id)) throw new Error(`Missing or duplicate document ID: ${document._id}`);
  seenIds.add(document._id);
  const index = documentIndex.get(document._id);
  if (index === undefined) throw new Error(`Corpus document is absent from index: ${document._id}`);
  const text = `${document.title ?? ''} ${document.text ?? ''}`.normalize('NFKC');
  documentTexts[index] = `passage: ${text}`;
  paritySamples.push({ id: document._id, hash: crypto.createHash('sha256').update(document._id).digest('hex'), text });
  paritySamples.sort((left, right) => left.hash.localeCompare(right.hash));
  if (paritySamples.length > 25) paritySamples.pop();
}
if (seenIds.size !== indexDocuments.length || documentTexts.some(text => text === undefined)) throw new Error('Corpus and index document IDs do not exactly match.');
const positiveQrelDocIds = [...qrelMap.values()].flatMap(judgments => [...judgments].filter(([, grade]) => grade > 0).map(([id]) => id));
const positiveQrelsAbsentFromCorpus = positiveQrelDocIds.filter(id => !documentIndex.has(id));
const postingByDocument = db.prepare('SELECT term,tf FROM postings WHERE doc_id=? ORDER BY term');
const tokenParity = await Promise.all(paritySamples.map(async ({ id, text }) => {
  const expected = new Map<string, number>();
  for (const token of await tokenizeMorphological(text)) expected.set(token, (expected.get(token) ?? 0) + 1);
  const stored = new Map((postingByDocument.all(id) as Array<{ term: string; tf: number }>).map(row => [row.term, row.tf]));
  return expected.size === stored.size && [...expected].every(([term, tf]) => stored.get(term) === tf);
}));
if (tokenParity.some(matches => !matches)) throw new Error('Deterministic 25-document morphology frequency parity failed; BM25 comparison is not valid.');

const corpusSha256 = await shaFile(corpusPath);
const vectorRoot = path.resolve('quality/e2e/local/embedding-vectors');
fs.mkdirSync(vectorRoot, { recursive: true });
const vectorKey = crypto.createHash('sha256').update(`${corpusSha256}|${modelSha256}|${tokenizerSha256}|${runtimePackage.version}|q8|mean|normalized|passage-prefix|384`).digest('hex');
const vectorPath = path.join(vectorRoot, `${vectorKey}.f32`);
const metadataPath = `${vectorPath}.json`;
const dimension = 384;
const expectedBytes = indexDocuments.length * dimension * Float32Array.BYTES_PER_ELEMENT;
const buildStarted = performance.now();
let vectorCacheHit = false;
let vectorBytes: Buffer;
if (fs.existsSync(vectorPath) && fs.existsSync(metadataPath)) {
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { bytes: number; corpusSha256: string; modelSha256: string; tokenizerSha256: string; runtimeVersion: string; documents: number; dimension: number };
  if (metadata.bytes !== expectedBytes || metadata.corpusSha256 !== corpusSha256 || metadata.modelSha256 !== modelSha256 || metadata.tokenizerSha256 !== tokenizerSha256 || metadata.runtimeVersion !== runtimePackage.version || metadata.documents !== indexDocuments.length || metadata.dimension !== dimension || fs.statSync(vectorPath).size !== expectedBytes) {
    throw new Error('Cached vectors metadata does not match the corpus/model; refusing reuse.');
  }
  vectorBytes = fs.readFileSync(vectorPath);
  vectorCacheHit = true;
} else {
  const tempPath = `${vectorPath}.${process.pid}.tmp`;
  const stream = createWriteStream(tempPath, { flags: 'wx' });
  const batchSize = 32;
  for (let offset = 0; offset < documentTexts.length; offset += batchSize) {
    const batch = documentTexts.slice(offset, offset + batchSize) as string[];
    const output = await extractor(batch, { pooling: 'mean', normalize: true });
    if (output.dims.at(-1) !== dimension || output.data.length !== batch.length * dimension) throw new Error(`Unexpected model output shape: ${output.dims.join('x')}`);
    if (!stream.write(Buffer.from(output.data.buffer, output.data.byteOffset, output.data.byteLength))) {
      await once(stream, 'drain');
    }
    if ((offset + batch.length) % 256 === 0 || offset + batch.length === documentTexts.length) {
      console.log(`embedded ${Math.min(offset + batch.length, documentTexts.length)}/${documentTexts.length}; rss=${process.memoryUsage().rss}`);
    }
  }
  stream.end();
  await finished(stream);
  if (fs.statSync(tempPath).size !== expectedBytes) throw new Error(`Incomplete vector file: expected ${expectedBytes} bytes.`);
  fs.renameSync(tempPath, vectorPath);
  fs.writeFileSync(metadataPath, `${JSON.stringify({ bytes: expectedBytes, corpusSha256, modelSha256, tokenizerSha256, runtimeVersion: runtimePackage.version, documents: indexDocuments.length, dimension, dtype: 'float32', model: 'Xenova/multilingual-e5-small', quantization: 'q8' }, null, 2)}\n`, { flag: 'wx' });
  vectorBytes = fs.readFileSync(vectorPath);
}
if (vectorBytes.byteLength !== expectedBytes) throw new Error(`Vector byte length ${vectorBytes.byteLength} differs from expected ${expectedBytes}.`);
const vectors = new Float32Array(vectorBytes.buffer, vectorBytes.byteOffset, expectedBytes / Float32Array.BYTES_PER_ELEMENT);
const embeddingBuildMs = performance.now() - buildStarted;
documentTexts.fill(undefined);

const postingCache = new Map<string, Array<{ docIndex: number; tf: number }>>();
const getPostings = (terms: readonly string[]) => {
  const uniqueTerms = [...new Set(terms)];
  const missing = uniqueTerms.filter(term => !postingCache.has(term));
  for (let offset = 0; offset < missing.length; offset += 300) {
    const batch = missing.slice(offset, offset + 300);
    const rows = batch.length ? db.prepare(`SELECT term,doc_id,tf FROM postings WHERE term IN (${batch.map(() => '?').join(',')}) ORDER BY term,doc_id`).all(...batch) as Array<{ term: string; doc_id: string; tf: number }> : [];
    const grouped = new Map<string, Array<{ docIndex: number; tf: number }>>();
    for (const row of rows) {
      const docIndex = documentIndex.get(row.doc_id);
      if (docIndex === undefined) throw new Error(`Posting references unknown document ${row.doc_id}`);
      const list = grouped.get(row.term) ?? [];
      list.push({ docIndex, tf: row.tf });
      grouped.set(row.term, list);
    }
    for (const term of batch) postingCache.set(term, grouped.get(term) ?? []);
  }
  return new Map(uniqueTerms.map(term => [term, postingCache.get(term) ?? []]));
};
const idsFrom = (ranked: readonly ScoredDocument[]) => ranked.map(row => indexDocuments[row.docIndex]!.id);
const metric = (ranked: readonly string[], judgments: Map<string, number>): Metrics => {
  const relevant = new Set([...judgments].filter(([, grade]) => grade > 0).map(([id]) => id));
  const first = ranked.findIndex(id => relevant.has(id));
  const dcg = ranked.slice(0, 10).reduce((sum, id, index) => sum + (2 ** (judgments.get(id) ?? 0) - 1) / Math.log2(index + 2), 0);
  const ideal = [...judgments.values()].filter(grade => grade > 0).sort((a, b) => b - a).slice(0, 10)
    .reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  let hits = 0; let precisionSum = 0;
  for (const [index, id] of ranked.slice(0, 100).entries()) if (relevant.has(id)) { hits++; precisionSum += hits / (index + 1); }
  return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0, mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0,
    ndcg10: ideal ? dcg / ideal : 0, map100: relevant.size ? precisionSum / relevant.size : 0, recall100: relevant.size ? hits / relevant.size : 0 };
};

type Method = 'standard-bm25' | 'e5-small' | 'rrf-bm25-e5';
const perMethod: Record<Method, Array<{ id: string; groupId: string; metrics: Metrics; top10: string[]; top100: string[] }>> = {
  'standard-bm25': [], 'e5-small': [], 'rrf-bm25-e5': [],
};
const latencies: Record<Method, number[]> = { 'standard-bm25': [], 'e5-small': [], 'rrf-bm25-e5': [] };
const queryEmbeddingLatencies: number[] = [];
const analysisLatencies: number[] = [];
const collectionLength = lengths.reduce((sum, length) => sum + length, 0);
for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
  const query = queries[queryIndex]!;
  const analysisStarted = performance.now();
  const words = await purposeWords(query.text);
  const parsed = analyzeQuery(query.text, words.length ? words : query.text.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const terms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
  analysisLatencies.push(performance.now() - analysisStarted);
  const postings = getPostings(terms);
  const bm25Started = performance.now();
  const bm25 = scoreWeightedBm25(new Map(terms.map(term => [term, 1])), indexDocuments.length,
    collectionLength / Math.max(indexDocuments.length, 1), lengths, postings, 1.2, 0.75, 100);
  const bm25Ids = idsFrom(bm25);
  const bm25Ms = performance.now() - bm25Started;

  const queryStarted = performance.now();
  const queryOutput = await extractor([`query: ${query.text}`.normalize('NFKC')], { pooling: 'mean', normalize: true });
  if (queryOutput.data.length !== dimension) throw new Error(`Unexpected query embedding dimension ${queryOutput.data.length}`);
  const queryVector = queryOutput.data;
  const queryEmbeddingMs = performance.now() - queryStarted;
  queryEmbeddingLatencies.push(queryEmbeddingMs);

  const denseStarted = performance.now();
  const scores = new Float32Array(indexDocuments.length);
  for (let doc = 0; doc < indexDocuments.length; doc++) {
    const base = doc * dimension;
    let score = 0;
    for (let axis = 0; axis < dimension; axis++) score += vectors[base + axis]! * queryVector[axis]!;
    scores[doc] = score;
  }
  const e5Ids = idsFrom(exactTopK(scores, 100));
  const denseMs = performance.now() - denseStarted;
  const e5Ms = queryEmbeddingMs + denseMs;
  const fusionStarted = performance.now();
  const fusedIds = reciprocalRankFusion([bm25Ids, e5Ids], 60, 100);
  const fusionMs = performance.now() - fusionStarted;

  const rows: Record<Method, { ids: string[]; ms: number }> = {
    'standard-bm25': { ids: bm25Ids, ms: bm25Ms }, 'e5-small': { ids: e5Ids, ms: e5Ms },
    'rrf-bm25-e5': { ids: fusedIds, ms: bm25Ms + e5Ms + fusionMs },
  };
  for (const method of Object.keys(rows) as Method[]) {
    const { ids, ms } = rows[method]!;
    perMethod[method].push({ id: query.id, groupId: query.groupId, metrics: metric(ids, query.judgments), top10: ids.slice(0, 10), top100: ids });
    latencies[method].push(ms);
  }
  if ((queryIndex + 1) % 10 === 0 || queryIndex + 1 === queries.length) console.log(`ranked ${queryIndex + 1}/${queries.length}`);
}

const metricKeys: (keyof Metrics)[] = ['hit1', 'hit10', 'mrr10', 'ndcg10', 'map100', 'recall100'];
const groupedDiffs = (method: Method, key: keyof Metrics) => {
  const grouped = new Map<string, number[]>();
  queries.forEach((query, index) => grouped.set(query.groupId, [...(grouped.get(query.groupId) ?? []), perMethod[method][index]!.metrics[key] - perMethod['standard-bm25'][index]!.metrics[key]]));
  return [...grouped.values()];
};
const bootstrap = (method: Method, key: keyof Metrics) => {
  const groups = groupedDiffs(method, key);
  if (!groups.length) return { meanDifference: 0, clusterCount: 0, pairedClusterBootstrap95CI: null };
  let seed = Number.parseInt(crypto.createHash('sha256').update(`${path.basename(datasetDir)}|${splitArg}|${method}|${key}|e5-v1`).digest('hex').slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = new Array<number>(10_000);
  for (let draw = 0; draw < draws.length; draw++) {
    let sum = 0; let count = 0;
    for (let index = 0; index < groups.length; index++) for (const value of groups[Math.floor(random() * groups.length)]!) { sum += value; count++; }
    draws[draw] = count ? sum / count : 0;
  }
  draws.sort((a, b) => a - b);
  return { meanDifference: mean(groups.flat()), clusterCount: groups.length, pairedClusterBootstrap95CI: [draws[249]!, draws[9749]!] };
};
const metrics = Object.fromEntries((Object.keys(perMethod) as Method[]).map(method => [method, {
  values: Object.fromEntries(metricKeys.map(key => [key, mean(perMethod[method].map(row => row.metrics[key]))])),
  queryRankLatencyMs: { p50: percentile(latencies[method], 0.5), p95: percentile(latencies[method], 0.95) },
}]));
const result = {
  dataset: { name: path.basename(datasetDir), split: splitArg, documents: indexDocuments.length, queries: queries.length,
    querySelection: Number.isFinite(queryLimit) ? { method: 'ascending SHA-256 query-ID order, selected before scoring', limit: queryLimit } : { method: 'all split qrels', limit: null },
    positiveQrelConnectedComponents: new Set(queries.map(query => query.groupId)).size,
    corpusSha256, queriesSha256: hashFile(queriesPath), qrelsSha256: hashFile(qrelsPath), indexSha256: hashFile(indexPath), indexPath,
    corpusIndexIdParity: true, positiveQrelCount: positiveQrelDocIds.length,
    positiveQrelsAbsentFromCorpus: positiveQrelsAbsentFromCorpus.length, sqliteIntegrity: db.pragma('integrity_check', { simple: true }) },
  model: { id: 'Xenova/multilingual-e5-small', quantization: 'q8', dimension, pooling: 'mean', normalized: true,
    queryPrefix: 'query: ', documentPrefix: 'passage: ', documentInput: 'title + body, NFKC normalized, tokenizer truncation defaults (512 max tokens)',
    onnxSha256: modelSha256, tokenizerSha256, transformersJsVersion: runtimePackage.version, cacheDir: env.cacheDir, localOnly: true },
  definitions: { standardBm25: 'Shared purposeWords/analyzeQuery, unique morphological terms, k1=1.2,b=0.75, exact read-only postings, exact top-100.',
    e5: 'Multilingual E5 query/document prefixes; mean pooled L2-normalized q8 ONNX outputs. Exact cosine/dot-product scan over every corpus vector, exact heap top-100. Query latency includes query embedding plus full vector scan; excludes one-time model load and corpus embedding build.',
    fusion: 'RRF k=60 over complete exact BM25 Top-100 and E5 Top-100; pipeline latency sums measured BM25, query embedding, dense scan and fusion.',
    evaluationStatus: 'Exploratory fixed-corpus comparison; not an independent confirmation because these benchmark sources have been used in earlier exploration.' },
  metrics,
  differencesVsStandard: Object.fromEntries((['e5-small', 'rrf-bm25-e5'] as const).map(method => [method,
    Object.fromEntries((['hit10', 'ndcg10', 'mrr10'] as const).map(key => [key, bootstrap(method, key)]))])),
  resources: { embeddingBuildMs, embeddingBuildCacheHit: vectorCacheHit, vectorIndexBytes: expectedBytes, vectorIndexPath: vectorPath,
    modelBytes: fs.statSync(modelPath).size, processRssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
    queryEmbeddingMs: { p50: percentile(queryEmbeddingLatencies, 0.5), p95: percentile(queryEmbeddingLatencies, 0.95) },
    queryAnalysisMs: { p50: percentile(analysisLatencies, 0.5), p95: percentile(analysisLatencies, 0.95) },
    morphologyTokenFrequencyParitySample: { size: tokenParity.length, allMatched: true },
    latencyIncludesFullDenseScan: true, inferenceRuntime: 'Transformers.js 3.8.1 / ONNX Runtime CPU', vectorFormat: 'row-major float32, cached outside git' },
  perQuery: queries.map((query, index) => ({ id: query.id, groupId: query.groupId, query: query.text,
    ...Object.fromEntries((Object.keys(perMethod) as Method[]).map(method => [method, perMethod[method][index]])) })),
};
db.close();
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, dataset: result.dataset, model: result.model, metrics: result.metrics,
  differencesVsStandard: result.differencesVsStandard, resources: result.resources }, null, 2));
