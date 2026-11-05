import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { finished } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { scoreWeightedBm25 } from './bm25_rm3.js';
import { reciprocalRankFusion } from './embedding_rankers.js';

type Query = { _id: string; text: string };
type Judgment = { query_id: string; doc_id: string; relevance: number };
type QueryCase = { id: string; text: string; positives: Set<string>; groupId: string };
type IndexedDocument = { id: string; length: number };
type CandidateDocument = { id: string; title: string; text: string };
type Metrics = { hit1: number; hit10: number; mrr10: number; ndcg10: number; map100: number; recall100: number };
type Result = { queryId: string; queryText: string; positiveDocumentIds: string[]; bm25CandidateHit: boolean; bm25CandidateCount: number; ranks: Record<string, number | null>; metrics: Record<string, Metrics>; latencyMs: Record<string, number> };
type ModelModule = { env: { cacheDir: string; allowRemoteModels: boolean }; pipeline: (task: string, model: string, options: object) => Promise<((texts: string[], options: object) => Promise<{ data: Float32Array; dims: number[] }>)> };

const [datasetArg, outputArg, indexDirArg, candidateDepthArg = '100'] = process.argv.slice(2);
if (!datasetArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_jacwir_full_bm25_e5_rerank.ts <query-dir> <new-output.json> [existing-index-dir] [candidate-depth:100|200]');
const candidateDepth = Number(candidateDepthArg);
if (![100, 200].includes(candidateDepth)) throw new Error('candidate-depth must be 100 or 200.');
const datasetDir = path.resolve(datasetArg);
const indexDir = path.resolve(indexDirArg ?? datasetDir);
const outputPath = path.resolve(outputArg);
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new path under artifacts/.');
const indexPath = path.join(indexDir, 'index.sqlite');
const indexManifestPath = path.join(indexDir, 'index-provenance.json');
const queryPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels.jsonl');
const queryManifestPath = path.join(datasetDir, 'manifest.json');
for (const file of [indexPath, indexManifestPath, queryPath, qrelsPath, queryManifestPath]) if (!fs.existsSync(file)) throw new Error(`Missing input: ${file}`);
const queryManifest = JSON.parse(fs.readFileSync(queryManifestPath, 'utf8')) as { querySelection: string; queryCount: number; positiveJudgmentCount: number; warning: string };

const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const shaFile = (file: string) => new Promise<string>((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});
const readJsonl = async function* <T>(file: string): AsyncGenerator<T> {
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  for await (const chunk of createReadStream(file)) {
    remainder += decoder.write(chunk);
    let newline = remainder.indexOf('\n');
    while (newline >= 0) {
      const line = remainder.slice(0, newline).replace(/\r$/u, '');
      if (line) yield JSON.parse(line) as T;
      remainder = remainder.slice(newline + 1);
      newline = remainder.indexOf('\n');
    }
  }
  remainder += decoder.end();
  if (remainder) yield JSON.parse(remainder.replace(/\r$/u, '')) as T;
};
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;

const queriesById = new Map<string, string>();
for await (const query of readJsonl<Query>(queryPath)) {
  if (!query._id || queriesById.has(query._id) || sha(query.text) !== query._id) throw new Error(`Invalid, duplicate, or non-hash query ID: ${query._id}`);
  queriesById.set(query._id, query.text);
}
if (queriesById.size !== queryManifest.queryCount) throw new Error(`Expected ${queryManifest.queryCount} fixed queries; got ${queriesById.size}.`);
const judgmentsByQuery = new Map<string, Set<string>>();
for await (const judgment of readJsonl<Judgment>(qrelsPath)) {
  if (!queriesById.has(judgment.query_id) || !judgment.doc_id || judgment.relevance !== 1) throw new Error(`Invalid qrel: ${JSON.stringify(judgment)}`);
  const positives = judgmentsByQuery.get(judgment.query_id) ?? new Set<string>();
  positives.add(judgment.doc_id);
  judgmentsByQuery.set(judgment.query_id, positives);
}
if ([...queriesById.keys()].some(id => !judgmentsByQuery.has(id))) throw new Error('A selected query has no known positive qrel.');

const db = new Database(indexPath, { readonly: true, fileMustExist: true });
const indexDocuments = db.prepare('SELECT id,length FROM documents ORDER BY id').all() as IndexedDocument[];
if (indexDocuments.length !== 513107) throw new Error(`Expected 513,107 indexed documents; got ${indexDocuments.length}.`);
const documentIndex = new Map(indexDocuments.map((row, index) => [row.id, index]));
const lengths = indexDocuments.map(row => row.length);
const positiveDocuments = new Set([...judgmentsByQuery.values()].flatMap(rows => [...rows]));
for (const id of positiveDocuments) if (!documentIndex.has(id)) throw new Error(`Known-positive document is missing from index: ${id}`);
const collectionLength = lengths.reduce((sum, length) => sum + length, 0);
const averageLength = collectionLength / indexDocuments.length;
const queryCases: QueryCase[] = [...queriesById].map(([id, text]) => ({ id, text, positives: judgmentsByQuery.get(id)!, groupId: id }));
const parent = new Map<string, string>();
const find = (id: string): string => {
  const root = parent.get(id);
  if (!root) { parent.set(id, id); return id; }
  if (root === id) return id;
  const canonical = find(root);
  parent.set(id, canonical);
  return canonical;
};
for (const query of queryCases) for (const docId of query.positives) {
  const queryRoot = find(`q:${query.id}`);
  const documentRoot = find(`d:${docId}`);
  if (queryRoot !== documentRoot) parent.set(documentRoot, queryRoot);
}
for (const query of queryCases) query.groupId = find(`q:${query.id}`);

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

type PreparedQuery = { query: QueryCase; bm25Ids: string[]; bm25Ms: number; candidates: string[]; matchedPositiveCount: number };
const prepared: PreparedQuery[] = [];
const candidateIds = new Set<string>();
const bm25QueryLatency: number[] = [];
for (const query of queryCases) {
  const started = performance.now();
  const termsFromPurpose = await purposeWords(query.text);
  const parsed = analyzeQuery(query.text, termsFromPurpose.length ? termsFromPurpose : query.text.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const terms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
  const postings = getPostings(terms);
  const ranked = scoreWeightedBm25(new Map(terms.map(term => [term, 1])), indexDocuments.length, averageLength, lengths, postings, 1.2, 0.75, candidateDepth);
  const bm25Ids = ranked.map(row => indexDocuments[row.docIndex]!.id);
  const bm25Ms = performance.now() - started;
  const candidates = bm25Ids;
  for (const id of candidates) candidateIds.add(id);
  const matchedPositiveCount = candidates.filter(id => query.positives.has(id)).length;
  prepared.push({ query, bm25Ids, bm25Ms, candidates, matchedPositiveCount });
  bm25QueryLatency.push(bm25Ms);
}
console.log(`BM25 retrieved up to ${candidateDepth} candidates for ${queryCases.length} full-corpus queries; unique rerank documents=${candidateIds.size}`);

const runtimeRoot = path.resolve('quality/e2e/local/embedding-runtime');
const require = createRequire(path.join(runtimeRoot, 'runner.cjs'));
const { env, pipeline: createPipeline } = require('@huggingface/transformers') as ModelModule;
env.cacheDir = path.resolve('quality/e2e/local/embedding-cache');
env.allowRemoteModels = false;
const modelId = 'Xenova/multilingual-e5-small';
const modelPath = path.join(env.cacheDir, modelId, 'onnx', 'model_quantized.onnx');
const tokenizerPath = path.join(env.cacheDir, modelId, 'tokenizer.json');
const tokenizerConfigPath = path.join(env.cacheDir, modelId, 'tokenizer_config.json');
for (const file of [modelPath, tokenizerPath, tokenizerConfigPath]) if (!fs.existsSync(file)) throw new Error(`Offline E5 model file missing: ${file}`);
console.log('loading cached multilingual-e5-small q8 model');
const extractor = await createPipeline('feature-extraction', modelId, { dtype: 'q8' });
const runtimeVersion = (JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'node_modules/@huggingface/transformers/package.json'), 'utf8')) as { version: string }).version;
const modelSha = await shaFile(modelPath);
const tokenizerSha = sha(`${await shaFile(tokenizerPath)}|${await shaFile(tokenizerConfigPath)}`);
const indexManifest = JSON.parse(fs.readFileSync(indexManifestPath, 'utf8')) as { corpusSha256: string; corpusDocuments: number };
const sourceRoot = path.resolve('quality/e2e/local/jacwir-experiment');
const inputSha256 = {
  sourceCollectionParquet: await shaFile(path.join(sourceRoot, 'collection-00000-of-00001.parquet')),
  sourceEvaluationParquet: await shaFile(path.join(sourceRoot, 'eval-00000-of-00001.parquet')),
  fullCorpusJsonl: indexManifest.corpusSha256,
  fullCorpusIndexSqlite: await shaFile(indexPath),
  queryManifest: await shaFile(queryManifestPath),
  queriesJsonl: await shaFile(queryPath),
  qrelsJsonl: await shaFile(qrelsPath),
};
const candidateList = [...candidateIds].sort((a, b) => a.localeCompare(b));
const candidateDocuments = new Map<string, CandidateDocument>();
for (let offset = 0; offset < candidateList.length; offset += 300) {
  const batch = candidateList.slice(offset, offset + 300);
  const rows = db.prepare(`SELECT id,title,text FROM documents WHERE id IN (${batch.map(() => '?').join(',')})`).all(...batch) as CandidateDocument[];
  for (const row of rows) candidateDocuments.set(row.id, row);
}
if (candidateDocuments.size !== candidateList.length) throw new Error('Could not load every unique BM25 candidate document for E5 reranking.');
const candidateSha = sha(candidateList.join('\n'));
const vectorKey = sha(`${indexManifest.corpusSha256}|${candidateSha}|${modelSha}|${tokenizerSha}|${runtimeVersion}|q8|mean|normalized|passage-prefix|384`);
const vectorRoot = path.join(datasetDir, 'candidate-vectors');
fs.mkdirSync(vectorRoot, { recursive: true });
const vectorPath = path.join(vectorRoot, `${vectorKey}.f32`);
const vectorMetaPath = `${vectorPath}.json`;
const dimension = 384;
const expectedVectorBytes = candidateList.length * dimension * Float32Array.BYTES_PER_ELEMENT;
const embeddingPreparationStarted = performance.now();
let vectorsBuffer: Buffer;
let vectorCacheHit = false;
if (fs.existsSync(vectorPath) && fs.existsSync(vectorMetaPath)) {
  const metadata = JSON.parse(fs.readFileSync(vectorMetaPath, 'utf8')) as { candidates: number; dimension: number; bytes: number; corpusSha256: string; candidateSha256: string; modelSha256: string; tokenizerSha256: string; runtimeVersion: string };
  if (metadata.candidates !== candidateList.length || metadata.dimension !== dimension || metadata.bytes !== expectedVectorBytes || metadata.corpusSha256 !== indexManifest.corpusSha256 || metadata.candidateSha256 !== candidateSha || metadata.modelSha256 !== modelSha || metadata.tokenizerSha256 !== tokenizerSha || metadata.runtimeVersion !== runtimeVersion || fs.statSync(vectorPath).size !== expectedVectorBytes) throw new Error('Cached candidate vector metadata mismatch.');
  vectorsBuffer = fs.readFileSync(vectorPath);
  vectorCacheHit = true;
} else {
  const tempPath = `${vectorPath}.${process.pid}.tmp`;
  const stream = createWriteStream(tempPath, { flags: 'wx' });
  const batchSize = 32;
  for (let offset = 0; offset < candidateList.length; offset += batchSize) {
    const batch = candidateList.slice(offset, offset + batchSize).map(id => {
      const document = candidateDocuments.get(id)!;
      return `passage: ${`${document.title} ${document.text}`.normalize('NFKC')}`;
    });
    const embedding = await extractor(batch, { pooling: 'mean', normalize: true });
    if (embedding.dims.at(-1) !== dimension || embedding.data.length !== batch.length * dimension) throw new Error(`Unexpected E5 output shape ${embedding.dims.join('x')}`);
    if (!stream.write(Buffer.from(embedding.data.buffer, embedding.data.byteOffset, embedding.data.byteLength))) await once(stream, 'drain');
    if ((offset + batch.length) % 1024 === 0 || offset + batch.length === candidateList.length) console.log(`embedded ${Math.min(offset + batch.length, candidateList.length)}/${candidateList.length} BM25 candidates`);
  }
  stream.end();
  await finished(stream);
  if (fs.statSync(tempPath).size !== expectedVectorBytes) throw new Error('Incomplete E5 candidate vector file.');
  fs.renameSync(tempPath, vectorPath);
  fs.writeFileSync(vectorMetaPath, `${JSON.stringify({ candidates: candidateList.length, dimension, bytes: expectedVectorBytes, corpusSha256: indexManifest.corpusSha256, candidateSha256: candidateSha, modelSha256: modelSha, tokenizerSha256: tokenizerSha, runtimeVersion, quantization: 'q8', pooling: 'mean', normalized: true }, null, 2)}\n`, { flag: 'wx' });
  vectorsBuffer = fs.readFileSync(vectorPath);
}
const embeddingPreparationMs = performance.now() - embeddingPreparationStarted;
const vectors = new Float32Array(vectorsBuffer.buffer, vectorsBuffer.byteOffset, vectorsBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
const vectorIndex = new Map(candidateList.map((id, index) => [id, index]));

const metrics = (ranking: readonly string[], positives: ReadonlySet<string>): Metrics => {
  const firstRankIndex = ranking.findIndex(id => positives.has(id));
  const dcg = ranking.slice(0, 10).reduce((sum, id, index) => sum + (positives.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const idealCount = Math.min(positives.size, 10);
  const ideal = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, score) => sum + score, 0);
  let hits = 0;
  let precisionSum = 0;
  for (const [index, id] of ranking.slice(0, 100).entries()) if (positives.has(id)) { hits += 1; precisionSum += hits / (index + 1); }
  return { hit1: firstRankIndex === 0 ? 1 : 0, hit10: firstRankIndex >= 0 && firstRankIndex < 10 ? 1 : 0,
    mrr10: firstRankIndex >= 0 && firstRankIndex < 10 ? 1 / (firstRankIndex + 1) : 0, ndcg10: ideal ? dcg / ideal : 0,
    map100: positives.size ? precisionSum / positives.size : 0, recall100: positives.size ? hits / positives.size : 0 };
};
const e5Method = `e5-rerank-bm25-top${candidateDepth}` as const;
const rrfMethod = `rrf-bm25-e5-bm25-top${candidateDepth}` as const;
const methodNames = ['standard-bm25', e5Method, rrfMethod] as const;
type MethodName = typeof methodNames[number];
const perQuery: Result[] = [];
const latencies: Record<MethodName, number[]> = { 'standard-bm25': [], [e5Method]: [], [rrfMethod]: [] };
const queryEmbeddingMs: number[] = [];
for (const row of prepared) {
  const queryStarted = performance.now();
  const queryEmbedding = await extractor([`query: ${row.query.text}`.normalize('NFKC')], { pooling: 'mean', normalize: true });
  if (queryEmbedding.data.length !== dimension) throw new Error(`Unexpected query vector size for ${row.query.id}`);
  const queryVector = queryEmbedding.data;
  const queryMs = performance.now() - queryStarted;
  queryEmbeddingMs.push(queryMs);
  const denseStarted = performance.now();
  const e5Ranking = row.candidates.map(id => {
    const base = vectorIndex.get(id)! * dimension;
    let score = 0;
    for (let axis = 0; axis < dimension; axis += 1) score += vectors[base + axis]! * queryVector[axis]!;
    return { id, score };
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).map(item => item.id);
  const e5ScoringMs = queryMs + performance.now() - denseStarted;
  const e5Ms = row.bm25Ms + e5ScoringMs;
  const fusionStarted = performance.now();
  const rrfRanking = reciprocalRankFusion([row.bm25Ids, e5Ranking], 60, candidateDepth);
  const rrfMs = e5Ms + performance.now() - fusionStarted;
  const expected = row.query.positives;
  const rankings: Record<MethodName, string[]> = { 'standard-bm25': row.bm25Ids, [e5Method]: e5Ranking, [rrfMethod]: rrfRanking };
  const rankValues = Object.fromEntries(methodNames.map(method => {
    const rankIndex = rankings[method].findIndex(id => expected.has(id));
    return [method, rankIndex < 0 ? null : rankIndex + 1];
  }));
  const metricValues = Object.fromEntries(methodNames.map(method => [method, metrics(rankings[method], expected)]));
  perQuery.push({ queryId: row.query.id, queryText: row.query.text, positiveDocumentIds: [...expected], bm25CandidateHit: row.matchedPositiveCount > 0,
    bm25CandidateCount: row.candidates.length, ranks: rankValues, metrics: metricValues,
    latencyMs: { 'standard-bm25': row.bm25Ms, [e5Method]: e5Ms, [rrfMethod]: rrfMs } });
  latencies['standard-bm25'].push(row.bm25Ms);
  latencies[e5Method].push(e5Ms);
  latencies[rrfMethod].push(rrfMs);
}

function bootstrapDelta(left: MethodName, metric: keyof Metrics, draws = 20_000) {
  const grouped = new Map<string, number[]>();
  for (let index = 0; index < perQuery.length; index++) {
    const query = prepared[index]!.query;
    const values = grouped.get(query.groupId) ?? [];
    values.push(perQuery[index]!.metrics[left][metric] - perQuery[index]!.metrics['standard-bm25'][metric]);
    grouped.set(query.groupId, values);
  }
  const groups = [...grouped.values()];
  const observed = mean(perQuery.map(row => row.metrics[left][metric] - row.metrics['standard-bm25'][metric]));
  let seed = Number.parseInt(sha(`${datasetDir}|${left}|${metric}|jacwir-full-v1`).slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const samples: number[] = [];
  for (let draw = 0; draw < draws; draw++) {
    let sum = 0; let count = 0;
    for (let index = 0; index < groups.length; index++) for (const value of groups[Math.floor(random() * groups.length)]!) { sum += value; count += 1; }
    samples.push(count ? sum / count : 0);
  }
  return { meanDelta: observed, ci95: [percentile(samples, 0.025), percentile(samples, 0.975)], clusterCount: groups.length, bootstrapSamples: draws };
}
const meanMetric = (method: MethodName) => Object.fromEntries((['hit1', 'hit10', 'mrr10', 'ndcg10', 'map100', 'recall100'] as const).map(metric => [metric, mean(perQuery.map(row => row.metrics[method][metric]))]));
const summary = Object.fromEntries(methodNames.map(method => [method, { metrics: meanMetric(method), latencyMs: { p50: percentile(latencies[method], 0.5), p95: percentile(latencies[method], 0.95) } } ]));
const candidateHitCount = perQuery.filter(row => row.bm25CandidateHit).length;
const output = {
  dataset: { name: 'JaCWIR full-corpus known-positive retrieval', source: 'hotchpotch/JaCWIR', corpusDocuments: indexDocuments.length,
    queryCount: queryCases.length, positiveJudgmentCount: [...judgmentsByQuery.values()].reduce((sum, rows) => sum + rows.size, 0),
    querySelection: queryManifest.querySelection,
    inputSha256,
    labels: 'Official source supplies known positive documents, not exhaustive judgments over the full corpus. Metrics count known positives and treat unjudged documents as non-relevant; do not interpret as exhaustive relevance precision.',
    candidateDepth, candidateGeneration: `Full-corpus standard BM25 top ${candidateDepth}; E5 rerank and RRF are restricted to this same BM25 candidate set.` },
  model: { id: modelId, quantization: 'q8', dimension, pooling: 'mean', normalized: true, onnxSha256: modelSha, tokenizerSha256: tokenizerSha, transformersJsVersion: runtimeVersion },
  bm25: { k1: 1.2, b: 0.75, tokenizer: 'Japanese morphology after NFKC(title + description)', documents: indexDocuments.length, averageDocumentLength: averageLength, collectionTokenCount: collectionLength },
  definitions: { e5Rerank: `multilingual-e5-small reranks only the full-corpus BM25 top ${candidateDepth}; it cannot recover documents missed by first-stage retrieval.`, rrf: `RRF k=60, equal weights, combining full-corpus BM25 top ${candidateDepth} with E5 ranking over those same candidates.`, latency: `BM25 includes query parsing, posting retrieval, scoring and top-${candidateDepth} selection. E5 includes query embedding and dense dot products over the retrieved candidates; one-time candidate document embedding generation is separate.`, metrics: 'Known-positive hit/rank metrics over the supplied qrels only; qrels are not exhaustive.' },
  metrics: summary,
  pairedComparisons: { [`${e5Method}-vs-standard-bm25`]: { ndcg10: bootstrapDelta(e5Method, 'ndcg10'), hit10: bootstrapDelta(e5Method, 'hit10') }, [`${rrfMethod}-vs-standard-bm25`]: { ndcg10: bootstrapDelta(rrfMethod, 'ndcg10'), hit10: bootstrapDelta(rrfMethod, 'hit10') } },
  retrievalCeiling: { [`bm25Top${candidateDepth}ContainsAtLeastOneKnownPositive`]: candidateHitCount / perQuery.length, hitQueries: candidateHitCount, totalQueries: perQuery.length },
  resources: { indexBytes: fs.statSync(indexPath).size, modelBytes: fs.statSync(modelPath).size, candidateEmbeddingBuildMs: vectorCacheHit ? 0 : embeddingPreparationMs,
    candidateEmbeddingPreparationMs: embeddingPreparationMs, candidateEmbeddingCacheHit: vectorCacheHit, candidateVectorBytes: expectedVectorBytes, uniqueBm25CandidateDocuments: candidateList.length,
    queryEmbeddingMs: { p50: percentile(queryEmbeddingMs, 0.5), p95: percentile(queryEmbeddingMs, 0.95) }, processRssAtEndBytes: process.memoryUsage().rss, heapUsedAtEndBytes: process.memoryUsage().heapUsed, runtime: 'Transformers.js / ONNX Runtime CPU' },
  perQuery,
};
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
db.close();
console.log(JSON.stringify({ outputPath, metrics: summary, retrievalCeiling: output.retrievalCeiling, resources: output.resources }, null, 2));
