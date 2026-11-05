import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { finished } from 'node:stream/promises';
import { tokenizeMorphological } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { scoreWeightedBm25 } from './bm25_rm3.js';
import { reciprocalRankFusion } from './embedding_rankers.js';

type Document = { _id: string; title?: string; text?: string };
type Query = { _id: string; text: string };
type CandidateSet = { query_id: string; candidate_ids: string[] };
type Metrics = { hit1: number; hit10: number; mrr10: number; ndcg10: number; map10: number };
type Result = { queryId: string; queryText: string; groupId: string; expectedId: string; ranks: Record<string, number | null>; metrics: Record<string, Metrics>; latencyMs: Record<string, number> };
type ModelModule = { env: { cacheDir: string; allowRemoteModels: boolean }; pipeline: (task: string, model: string, options: object) => Promise<((texts: string[], options: object) => Promise<{ data: Float32Array; dims: number[] }>)> };

const [datasetArg, outputArg] = process.argv.slice(2);
if (!datasetArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_jacwir_rerank.ts <dataset-dir> <new-output.json>');
const datasetDir = path.resolve(datasetArg);
const outputPath = path.resolve(outputArg);
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new path under artifacts/.');
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const queriesPath = path.join(datasetDir, 'queries.jsonl');
const candidatesPath = path.join(datasetDir, 'candidates.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels', 'test.tsv');
for (const file of [corpusPath, queriesPath, candidatesPath, qrelsPath]) if (!fs.existsSync(file)) throw new Error(`Missing input: ${file}`);

const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const shaFile = async (file: string) => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const mean = (values: readonly number[]) => values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1);
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

const documents = new Map<string, Document>();
for await (const document of readJsonl<Document>(corpusPath)) {
  if (!document._id || documents.has(document._id)) throw new Error(`Missing or duplicate document ID: ${document._id}`);
  documents.set(document._id, document);
}
const queries = new Map<string, string>();
for await (const query of readJsonl<Query>(queriesPath)) {
  if (!query._id || queries.has(query._id)) throw new Error(`Missing or duplicate query ID: ${query._id}`);
  queries.set(query._id, query.text);
}
const candidateSets = new Map<string, string[]>();
for await (const row of readJsonl<CandidateSet>(candidatesPath)) {
  if (!queries.has(row.query_id) || candidateSets.has(row.query_id) || !Array.isArray(row.candidate_ids)) throw new Error(`Invalid candidate set for ${row.query_id}`);
  if (row.candidate_ids.length !== 100 || new Set(row.candidate_ids).size !== 100) throw new Error(`Expected 100 unique candidates for ${row.query_id}`);
  for (const id of row.candidate_ids) if (!documents.has(id)) throw new Error(`Candidate document ${id} is absent from corpus.`);
  candidateSets.set(row.query_id, row.candidate_ids);
}
const qrels = new Map<string, string>();
for (const [lineIndex, line] of fs.readFileSync(qrelsPath, 'utf8').split(/\r?\n/u).entries()) {
  if (!line.trim() || line.startsWith('query_id')) continue;
  const [queryId, docId, grade] = line.split('\t');
  if (!queryId || !docId || grade !== '1' || !queries.has(queryId) || qrels.has(queryId)) throw new Error(`Invalid qrels row ${lineIndex + 1}`);
  if (!candidateSets.get(queryId)?.includes(docId)) throw new Error(`Positive ${docId} is outside query ${queryId}'s candidate set.`);
  qrels.set(queryId, docId);
}
if (queries.size !== candidateSets.size || queries.size !== qrels.size || queries.size !== 100) throw new Error('Expected exactly 100 queries with one candidate set and one positive each.');

const documentIds = [...documents.keys()].sort((a, b) => a.localeCompare(b));
const documentIndex = new Map(documentIds.map((id, index) => [id, index]));
const documentTerms: Array<Map<string, number>> = [];
const documentLengths: number[] = [];
console.log(`tokenizing ${documentIds.length} unique candidate documents`);
for (let index = 0; index < documentIds.length; index += 1) {
  const document = documents.get(documentIds[index]!)!;
  const text = `${document.title ?? ''} ${document.text ?? ''}`.normalize('NFKC');
  const tokens = await tokenizeMorphological(text);
  const frequencies = new Map<string, number>();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  documentTerms.push(frequencies);
  documentLengths.push(tokens.length);
  if ((index + 1) % 2000 === 0 || index + 1 === documentIds.length) console.log(`tokenized ${index + 1}/${documentIds.length}`);
}

const runtimeRoot = path.resolve('quality/e2e/local/embedding-runtime');
const require = createRequire(path.join(runtimeRoot, 'runner.cjs'));
const { env, pipeline: createPipeline } = require('@huggingface/transformers') as ModelModule;
env.cacheDir = path.resolve('quality/e2e/local/embedding-cache');
env.allowRemoteModels = false;
console.log('loading cached multilingual-e5-small q8 model');
const extractor = await createPipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' });
const modelPath = path.join(env.cacheDir, 'Xenova/multilingual-e5-small/onnx/model_quantized.onnx');
const tokenizerPath = path.join(env.cacheDir, 'Xenova/multilingual-e5-small/tokenizer.json');
const tokenizerConfigPath = path.join(env.cacheDir, 'Xenova/multilingual-e5-small/tokenizer_config.json');
for (const file of [modelPath, tokenizerPath, tokenizerConfigPath]) if (!fs.existsSync(file)) throw new Error(`Offline model file missing: ${file}`);
const runtimePackage = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'node_modules/@huggingface/transformers/package.json'), 'utf8')) as { version: string };
const modelSha = await shaFile(modelPath);
const tokenizerSha = sha(`${await shaFile(tokenizerPath)}|${await shaFile(tokenizerConfigPath)}`);
const corpusSha = await shaFile(corpusPath);
const vectorKey = sha(`${corpusSha}|${modelSha}|${tokenizerSha}|${runtimePackage.version}|q8|mean|normalized|384`);
const vectorRoot = path.resolve('quality/e2e/local/jacwir-experiment/vectors');
fs.mkdirSync(vectorRoot, { recursive: true });
const vectorPath = path.join(vectorRoot, `${vectorKey}.f32`);
const metadataPath = `${vectorPath}.json`;
const dimension = 384;
const vectorBytesExpected = documentIds.length * dimension * Float32Array.BYTES_PER_ELEMENT;
const embeddingPreparationStarted = performance.now();
let vectorBytes: Buffer;
let vectorCacheHit = false;
if (fs.existsSync(vectorPath) && fs.existsSync(metadataPath)) {
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { documents: number; dimension: number; bytes: number };
  if (metadata.documents !== documentIds.length || metadata.dimension !== dimension || metadata.bytes !== vectorBytesExpected || fs.statSync(vectorPath).size !== vectorBytesExpected) throw new Error('Cached vector metadata mismatch.');
  vectorBytes = fs.readFileSync(vectorPath);
  vectorCacheHit = true;
} else {
  const tempPath = `${vectorPath}.${process.pid}.tmp`;
  const stream = createWriteStream(tempPath, { flags: 'wx' });
  const batchSize = 32;
  for (let offset = 0; offset < documentIds.length; offset += batchSize) {
    const batch = documentIds.slice(offset, offset + batchSize).map(id => {
      const doc = documents.get(id)!;
      return `passage: ${`${doc.title ?? ''} ${doc.text ?? ''}`.normalize('NFKC')}`;
    });
    const output = await extractor(batch, { pooling: 'mean', normalize: true });
    if (output.dims.at(-1) !== dimension || output.data.length !== batch.length * dimension) throw new Error(`Unexpected model output shape: ${output.dims.join('x')}`);
    if (!stream.write(Buffer.from(output.data.buffer, output.data.byteOffset, output.data.byteLength))) await once(stream, 'drain');
    if ((offset + batch.length) % 1024 === 0 || offset + batch.length === documentIds.length) console.log(`embedded ${Math.min(offset + batch.length, documentIds.length)}/${documentIds.length}`);
  }
  stream.end();
  await finished(stream);
  if (fs.statSync(tempPath).size !== vectorBytesExpected) throw new Error('Incomplete E5 vector cache.');
  fs.renameSync(tempPath, vectorPath);
  fs.writeFileSync(metadataPath, `${JSON.stringify({ documents: documentIds.length, dimension, bytes: vectorBytesExpected, corpusSha256: corpusSha, modelSha256: modelSha, tokenizerSha256: tokenizerSha, runtimeVersion: runtimePackage.version, quantization: 'q8', pooling: 'mean', normalized: true }, null, 2)}\n`, { flag: 'wx' });
  vectorBytes = fs.readFileSync(vectorPath);
}
if (vectorBytes.length !== vectorBytesExpected) throw new Error('E5 vector cache size is invalid.');
const vectors = new Float32Array(vectorBytes.buffer, vectorBytes.byteOffset, vectorBytesExpected / Float32Array.BYTES_PER_ELEMENT);
const embeddingPreparationMs = performance.now() - embeddingPreparationStarted;
const embeddingBuildMs = vectorCacheHit ? 0 : embeddingPreparationMs;

const parent = new Map<string, string>();
const find = (id: string): string => {
  const root = parent.get(id);
  if (!root) { parent.set(id, id); return id; }
  if (root === id) return id;
  const canonical = find(root);
  parent.set(id, canonical);
  return canonical;
};
for (const [queryId, docId] of qrels) {
  const queryRoot = find(`q:${queryId}`);
  const docRoot = find(`d:${docId}`);
  if (queryRoot !== docRoot) parent.set(docRoot, queryRoot);
}

function metrics(ranking: readonly string[], expectedId: string): Metrics {
  const rank = ranking.indexOf(expectedId);
  const reciprocalRank = rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0;
  return { hit1: rank === 0 ? 1 : 0, hit10: rank >= 0 && rank < 10 ? 1 : 0, mrr10: reciprocalRank,
    ndcg10: reciprocalRank, map10: reciprocalRank };
}

const methodNames = ['standard-bm25', 'e5-small', 'rrf-bm25-e5'] as const;
const results: Result[] = [];
const latencies: Record<typeof methodNames[number], number[]> = { 'standard-bm25': [], 'e5-small': [], 'rrf-bm25-e5': [] };
const queryEmbeddingMs: number[] = [];
for (const [queryId, queryText] of queries) {
  const candidateIds = candidateSets.get(queryId)!;
  const candidates = candidateIds.map(id => documentIndex.get(id)!);
  const candidateLengths = candidates.map(index => documentLengths[index]!);
  const averageLength = mean(candidateLengths);
  const termsFromPurpose = await purposeWords(queryText);
  const parsed = analyzeQuery(queryText, termsFromPurpose.length ? termsFromPurpose : queryText.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const queryTerms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
  const postings = new Map<string, Array<{ docIndex: number; tf: number }>>();
  for (const term of queryTerms) postings.set(term, []);
  candidates.forEach((docIndex, localIndex) => {
    for (const [term, tf] of documentTerms[docIndex]!) postings.get(term)?.push({ docIndex: localIndex, tf });
  });
  const bm25Started = performance.now();
  const scored = scoreWeightedBm25(new Map(queryTerms.map(term => [term, 1])), candidates.length, averageLength, candidateLengths, postings, 1.2, 0.75, 100);
  const bm25Scores = new Map(scored.map(row => [row.docIndex, row.score]));
  const bm25Ranking = candidates.map((_, localIndex) => ({ index: localIndex, score: bm25Scores.get(localIndex) ?? 0 }))
    .sort((a, b) => b.score - a.score || candidateIds[a.index]!.localeCompare(candidateIds[b.index]!)).map(row => candidateIds[row.index]!);
  const bm25Ms = performance.now() - bm25Started;

  const queryStarted = performance.now();
  const queryOutput = await extractor([`query: ${queryText}`.normalize('NFKC')], { pooling: 'mean', normalize: true });
  if (queryOutput.data.length !== dimension) throw new Error(`Unexpected query embedding size for ${queryId}`);
  const queryVector = queryOutput.data;
  const qMs = performance.now() - queryStarted;
  queryEmbeddingMs.push(qMs);
  const denseStarted = performance.now();
  const e5Scored = candidates.map((docIndex, localIndex) => {
    const base = docIndex * dimension;
    let score = 0;
    for (let axis = 0; axis < dimension; axis += 1) score += vectors[base + axis]! * queryVector[axis]!;
    return { id: candidateIds[localIndex]!, score };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const e5Ranking = e5Scored.map(row => row.id);
  const e5Ms = qMs + performance.now() - denseStarted;
  const fusionStarted = performance.now();
  const rrfRanking = reciprocalRankFusion([bm25Ranking, e5Ranking], 60, 100);
  const rrfMs = bm25Ms + e5Ms + performance.now() - fusionStarted;
  const rankings = { 'standard-bm25': bm25Ranking, 'e5-small': e5Ranking, 'rrf-bm25-e5': rrfRanking };
  const expectedId = qrels.get(queryId)!;
  const groupId = find(`q:${queryId}`);
  const rowMetrics = Object.fromEntries(methodNames.map(method => [method, metrics(rankings[method], expectedId)])) as Record<string, Metrics>;
  const ranks = Object.fromEntries(methodNames.map(method => [method, rankings[method].indexOf(expectedId) < 0 ? null : rankings[method].indexOf(expectedId) + 1]));
  results.push({ queryId, queryText, groupId, expectedId, ranks, metrics: rowMetrics, latencyMs: { 'standard-bm25': bm25Ms, 'e5-small': e5Ms, 'rrf-bm25-e5': rrfMs } });
  latencies['standard-bm25'].push(bm25Ms);
  latencies['e5-small'].push(e5Ms);
  latencies['rrf-bm25-e5'].push(rrfMs);
}

function bootstrapDelta(leftMethod: typeof methodNames[number], rightMethod: typeof methodNames[number], metric: keyof Metrics, draws = 20_000) {
  const grouped = new Map<string, number[]>();
  for (const row of results) {
    const values = grouped.get(row.groupId) ?? [];
    values.push(row.metrics[leftMethod][metric] - row.metrics[rightMethod][metric]);
    grouped.set(row.groupId, values);
  }
  const groups = [...grouped.values()];
  const observed = results.reduce((sum, row) => sum + row.metrics[leftMethod][metric] - row.metrics[rightMethod][metric], 0) / results.length;
  let state = 0x73ab19d3;
  const samples: number[] = [];
  for (let draw = 0; draw < draws; draw += 1) {
    let sum = 0;
    let count = 0;
    for (let index = 0; index < groups.length; index += 1) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      const group = groups[(state >>> 0) % groups.length]!;
      for (const value of group) { sum += value; count += 1; }
    }
    samples.push(sum / count);
  }
  return { meanDelta: observed, ci95: [percentile(samples, 0.025), percentile(samples, 0.975)], clusterCount: groups.length, bootstrapSamples: draws };
}

function pairedHit10(leftMethod: typeof methodNames[number], rightMethod: typeof methodNames[number]) {
  let gains = 0;
  let losses = 0;
  for (const row of results) {
    const delta = row.metrics[leftMethod].hit10 - row.metrics[rightMethod].hit10;
    if (delta > 0) gains += 1;
    else if (delta < 0) losses += 1;
  }
  const discordant = gains + losses;
  const smallerSide = Math.min(gains, losses);
  let tailProbability = 0;
  for (let successes = 0; successes <= smallerSide; successes += 1) {
    let coefficient = 1;
    for (let index = 1; index <= successes; index += 1) coefficient *= (discordant - index + 1) / index;
    tailProbability += coefficient * 0.5 ** discordant;
  }
  return { gains, losses, ties: results.length - discordant, exactTwoSidedMcNemarP: Math.min(1, 2 * tailProbability) };
}

const summary = Object.fromEntries(methodNames.map(method => [method, {
  hit1: mean(results.map(row => row.metrics[method].hit1)),
  hit10: mean(results.map(row => row.metrics[method].hit10)),
  mrr10: mean(results.map(row => row.metrics[method].mrr10)),
  ndcg10: mean(results.map(row => row.metrics[method].ndcg10)),
  map10: mean(results.map(row => row.metrics[method].map10)),
  latencyMs: { p50: percentile(latencies[method], 0.5), p95: percentile(latencies[method], 0.95) },
}]));

const output = {
  dataset: { name: 'JaCWIR Japanese candidate reranking subset', source: 'hotchpotch/JaCWIR', licenseNote: 'Research/non-commercial use only; source webpage terms apply to title/description; query terms apply to queries.',
    task: 'Per-query reranking of the fixed 100 candidates (one positive and 99 mined negatives); not full-corpus retrieval.', queryCount: queries.size, uniqueCandidateDocumentCount: documents.size,
    querySelection: 'ascending SHA-256(query) among source eval rows; first 100, fixed before ranking', onePositivePerQuery: true, candidatesPerQuery: 100,
    sourceParquetSha256: { collection: await shaFile(path.resolve('quality/e2e/local/jacwir-experiment/collection-00000-of-00001.parquet')), eval: await shaFile(path.resolve('quality/e2e/local/jacwir-experiment/eval-00000-of-00001.parquet')) },
    inputSha256: { corpus: await shaFile(corpusPath), queries: await shaFile(queriesPath), candidates: await shaFile(candidatesPath), qrels: await shaFile(qrelsPath) } },
  model: { id: 'Xenova/multilingual-e5-small', quantization: 'q8', dimension, pooling: 'mean', normalized: true, onnxSha256: modelSha, tokenizerSha256: tokenizerSha, transformersJsVersion: runtimePackage.version },
  definitions: { bm25: 'k1=1.2, b=0.75, morphology tokens; N/IDF and average length are computed from each query’s 100 candidates.', rrf: 'RRF k=60, equal reciprocal-rank weight over the complete BM25 and E5 rankings of the same 100 candidates.', latency: 'Per-query parser and tokenization work are not timed; BM25 ranking and query embedding plus 100-candidate dense rerank are timed; one-time document embedding build excluded.', embeddingPreparation: 'Embedding build time is reported separately; embeddingPreparationMs includes either generation on a cold cache or loading the persisted vectors on a warm cache.' },
  metrics: summary,
  pairedComparisons: {
    'e5-small-vs-standard-bm25': { hit10: pairedHit10('e5-small', 'standard-bm25'), ndcg10: bootstrapDelta('e5-small', 'standard-bm25', 'ndcg10'), map10: bootstrapDelta('e5-small', 'standard-bm25', 'map10') },
    'rrf-bm25-e5-vs-standard-bm25': { hit10: pairedHit10('rrf-bm25-e5', 'standard-bm25'), ndcg10: bootstrapDelta('rrf-bm25-e5', 'standard-bm25', 'ndcg10'), map10: bootstrapDelta('rrf-bm25-e5', 'standard-bm25', 'map10') },
  },
  inference: { caveat: 'Exploratory, one hash-selected 100-query sample; source queries are model-generated, and candidates are mined negatives. This is not a natural-user-query or full-corpus test. Confidence intervals are conditional on this query/candidate sampling protocol; no independent deployment claim is made.' },
  resources: { embeddingBuildMs, embeddingPreparationMs, embeddingCacheHit: vectorCacheHit, vectorBytes: vectorBytesExpected, vectorCachePath: vectorPath, modelBytes: fs.statSync(modelPath).size, processRssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
    queryEmbeddingMs: { p50: percentile(queryEmbeddingMs, 0.5), p95: percentile(queryEmbeddingMs, 0.95) }, runtime: 'Transformers.js 3.8.1 / ONNX Runtime CPU' },
  perQuery: results,
};
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, metrics: summary, pairedComparisons: output.pairedComparisons, resources: output.resources }, null, 2));
