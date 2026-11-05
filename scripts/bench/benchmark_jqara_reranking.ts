import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream, createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { finished } from 'node:stream/promises';
import { tokenizeMorphological } from '../../bm25_engine.js';

type ParquetRow = { q_id: string; question: string; id: string; passage_row_id: string; label: number; title: string; text: string };
type Passage = { id: string; title: string; text: string; tokens: string[] };
type Query = { id: string; text: string; rows: Array<{ id: string; passageId: string; label: number }> };
type Metrics = { hit1: number; hit10: number; mrr10: number; ndcg10: number; map100: number; recall100: number };
type ModelModule = { env: { cacheDir: string; allowRemoteModels: boolean }; pipeline: (task: string, model: string, options: object) => Promise<((texts: string[], options: object) => Promise<{ data: Float32Array; dims: number[] }>)> };

const [parquetArg, duckdbArg, outputArg, offsetArg] = process.argv.slice(2);
if (!parquetArg || !duckdbArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_jqara_reranking.ts <test.parquet> <duckdb.exe> <new-artifact.json> [qid-hash-offset:0|500|1000|1500]');
const queryOffset = offsetArg === undefined ? 0 : Number(offsetArg);
if (![0, 500, 1000, 1500].includes(queryOffset)) throw new Error('Only preregistered qid-hash offsets 0, 500, 1000, and 1500 are allowed.');
const parquetPath = path.resolve(parquetArg);
const duckdbPath = path.resolve(duckdbArg);
const outputPath = path.resolve(outputArg);
if (!fs.existsSync(parquetPath) || !fs.existsSync(duckdbPath)) throw new Error('JQaRA parquet or DuckDB CLI is missing.');
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new path under artifacts/.');
const sha256File = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha256Stream = (file: string) => new Promise<string>((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});
const parquetSha256 = await sha256Stream(parquetPath);
const tempRoot = path.resolve('quality/e2e/local/jqara/runtime');
fs.mkdirSync(tempRoot, { recursive: true });
const normalizedPath = path.join(tempRoot, `test-${parquetSha256}.jsonl`);
if (!fs.existsSync(normalizedPath)) {
  const quoteSql = (value: string) => value.replaceAll("'", "''");
  const sql = `COPY (SELECT q_id, question, id, passage_row_id, label, title, text FROM read_parquet('${quoteSql(parquetPath)}') ORDER BY q_id, id) TO '${quoteSql(normalizedPath)}' (FORMAT JSON, ARRAY false);`;
  const converted = spawnSync(duckdbPath, [':memory:', '-c', sql], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (converted.status !== 0) throw new Error(`DuckDB parquet normalization failed: ${converted.stderr || converted.stdout}`);
}

const passages = new Map<string, Passage>();
const queriesById = new Map<string, Query>();
const lines = readline.createInterface({ input: createReadStream(normalizedPath), crlfDelay: Infinity });
let rowsRead = 0;
for await (const line of lines) {
  if (!line) continue;
  const row = JSON.parse(line) as ParquetRow;
  if (!row.q_id || !row.question || !row.id || !row.passage_row_id || !Number.isFinite(row.label) || !row.title || typeof row.text !== 'string') throw new Error(`Invalid JQaRA row at ${rowsRead + 1}.`);
  let passage = passages.get(row.passage_row_id);
  if (!passage) {
    passage = { id: row.passage_row_id, title: row.title, text: row.text, tokens: [] };
    passages.set(passage.id, passage);
  } else if (passage.title !== row.title || passage.text !== row.text) throw new Error(`Conflicting passage content for ${row.passage_row_id}.`);
  let query = queriesById.get(row.q_id);
  if (!query) {
    query = { id: row.q_id, text: row.question, rows: [] };
    queriesById.set(row.q_id, query);
  } else if (query.text !== row.question) throw new Error(`Conflicting question text for ${row.q_id}.`);
  query.rows.push({ id: row.id, passageId: row.passage_row_id, label: row.label });
  rowsRead++;
}
const allQueries = [...queriesById.values()];
if (allQueries.length !== 1667 || rowsRead !== 166700 || allQueries.some(query => query.rows.length !== 100 || new Set(query.rows.map(row => row.id)).size !== 100 || !query.rows.some(row => row.label > 0))) {
  throw new Error(`JQaRA test split shape mismatch: rows=${rowsRead}, queries=${allQueries.length}.`);
}
const hashOrderedQueries = allQueries.sort((a, b) => crypto.createHash('sha256').update(a.id).digest('hex').localeCompare(crypto.createHash('sha256').update(b.id).digest('hex')));
const queries = hashOrderedQueries.slice(queryOffset, queryOffset + 500);
const expectedQueryCount = queryOffset === 1500 ? 167 : 500;
if (queries.length !== expectedQueryCount) throw new Error(`Requested query block at offset ${queryOffset} should contain ${expectedQueryCount}; got ${queries.length}.`);
const earlierPositivePassages = new Set(hashOrderedQueries.slice(0, queryOffset)
  .flatMap(query => query.rows.filter(row => row.label > 0).map(row => row.passageId)));
const queriesSharingEarlierPositivePassages = queries.filter(query =>
  query.rows.some(row => row.label > 0 && earlierPositivePassages.has(row.passageId))).length;
const distinctEarlierPositivePassageOverlap = new Set(queries.flatMap(query =>
  query.rows.filter(row => row.label > 0 && earlierPositivePassages.has(row.passageId)).map(row => row.passageId))).size;
const selectedQidsSha256 = crypto.createHash('sha256').update(queries.map(query => query.id).sort().join('\n')).digest('hex');
const selectedPassageIds = new Set(queries.flatMap(query => query.rows.map(row => row.passageId)));
for (const passageId of passages.keys()) if (!selectedPassageIds.has(passageId)) passages.delete(passageId);
const passagesToRank = [...passages.values()].sort((a, b) => a.id.localeCompare(b.id));
let tokenizedPassages = 0;
for (const passage of passagesToRank) {
  passage.tokens = await tokenizeMorphological(`${passage.title} ${passage.text}`.normalize('NFKC'));
  tokenizedPassages++;
  if (tokenizedPassages % 5000 === 0 || tokenizedPassages === passagesToRank.length) console.log(`tokenized ${tokenizedPassages}/${passagesToRank.length} passages`);
}
console.log(`selected ${queries.length}/1667 SHA-256 qid-ordered queries; ${queries.reduce((sum, query) => sum + query.rows.length, 0)} candidates / ${passagesToRank.length} unique passages`);

const runtimeRoot = path.resolve('quality/e2e/local/embedding-runtime');
const require = createRequire(path.join(runtimeRoot, 'runner.cjs'));
const { env, pipeline: createPipeline } = require('@huggingface/transformers') as ModelModule;
env.cacheDir = path.resolve('quality/e2e/local/embedding-cache');
env.allowRemoteModels = false;
const modelId = 'Xenova/multilingual-e5-small';
const modelPath = path.join(env.cacheDir, `${modelId}/onnx/model_quantized.onnx`);
const tokenizerPath = path.join(env.cacheDir, `${modelId}/tokenizer.json`);
if (!fs.existsSync(modelPath) || !fs.existsSync(tokenizerPath)) throw new Error(`Offline E5 q8 model is missing from ${env.cacheDir}.`);
const modelSha256 = await sha256Stream(modelPath);
const tokenizerSha256 = crypto.createHash('sha256').update(await sha256Stream(tokenizerPath)).update(await sha256Stream(path.join(env.cacheDir, `${modelId}/tokenizer_config.json`))).digest('hex');
console.log('loading cached multilingual-e5-small q8 model');
const loadStarted = performance.now();
const extractor = await createPipeline('feature-extraction', modelId, { dtype: 'q8' });
const modelLoadMs = performance.now() - loadStarted;

const passagesSorted = passagesToRank;
const vectorRoot = path.resolve('quality/e2e/local/jqara/vectors');
fs.mkdirSync(vectorRoot, { recursive: true });
const vectorCacheKey = crypto.createHash('sha256').update(`${parquetSha256}|${selectedQidsSha256}|${modelSha256}|${tokenizerSha256}`).digest('hex');
const vectorPath = path.join(vectorRoot, `${vectorCacheKey}.f32`);
const expectedVectorBytes = passagesSorted.length * 384 * Float32Array.BYTES_PER_ELEMENT;
const vectorBuildStarted = performance.now();
if (!fs.existsSync(vectorPath)) {
  const recordBytes = 384 * Float32Array.BYTES_PER_ELEMENT;
  const partialPrefix = `${path.basename(vectorPath)}.`;
  const partials = fs.readdirSync(vectorRoot)
    .filter(name => name.startsWith(partialPrefix) && name.endsWith('.tmp'))
    .map(name => ({ path: path.join(vectorRoot, name), bytes: fs.statSync(path.join(vectorRoot, name)).size }))
    .filter(partial => partial.bytes <= expectedVectorBytes && partial.bytes % recordBytes === 0)
    .sort((left, right) => right.bytes - left.bytes);
  const resumablePartial = partials[0];
  const tempVectorPath = resumablePartial?.path ?? `${vectorPath}.${process.pid}.tmp`;
  const startOffset = resumablePartial ? resumablePartial.bytes / recordBytes : 0;
  if (startOffset) console.log(`resuming ${startOffset}/${passagesSorted.length} cached passage vectors`);
  const stream = createWriteStream(tempVectorPath, { flags: resumablePartial ? 'a' : 'wx' });
  for (let offset = startOffset; offset < passagesSorted.length; offset += 32) {
    const batch = passagesSorted.slice(offset, offset + 32).map(passage => `passage: ${passage.title}\n${passage.text}`.normalize('NFKC'));
    const output = await extractor(batch, { pooling: 'mean', normalize: true });
    if (output.dims.at(-1) !== 384 || output.data.length !== batch.length * 384) throw new Error(`Unexpected E5 output dimensions ${output.dims.join('x')}.`);
    if (!stream.write(Buffer.from(output.data.buffer, output.data.byteOffset, output.data.byteLength))) await once(stream, 'drain');
    if ((offset + batch.length) % 512 === 0 || offset + batch.length === passagesSorted.length) console.log(`embedded ${Math.min(offset + batch.length, passagesSorted.length)}/${passagesSorted.length}; rss=${process.memoryUsage().rss}`);
  }
  stream.end();
  await finished(stream);
  if (fs.statSync(tempVectorPath).size !== expectedVectorBytes) throw new Error('Incomplete JQaRA passage embedding file.');
  fs.renameSync(tempVectorPath, vectorPath);
  for (const name of fs.readdirSync(vectorRoot).filter(name => name.startsWith(partialPrefix) && name.endsWith('.tmp'))) {
    fs.unlinkSync(path.join(vectorRoot, name));
  }
}
if (fs.statSync(vectorPath).size !== expectedVectorBytes) throw new Error('Cached JQaRA vector file has an unexpected size.');
const vectorBytes = fs.readFileSync(vectorPath);
const passageVectors = new Float32Array(vectorBytes.buffer, vectorBytes.byteOffset, vectorBytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
const embeddingBuildMs = performance.now() - vectorBuildStarted;
const passageIndex = new Map(passagesSorted.map((passage, index) => [passage.id, index]));

const dot = (left: Float32Array, right: Float32Array) => { let sum = 0; for (let i = 0; i < left.length; i++) sum += left[i]! * right[i]!; return sum; };
const reciprocalRankFusion = (lexical: string[], semantic: string[], lexicalWeight = 1, semanticWeight = 1) => {
  const scores = new Map<string, number>();
  lexical.forEach((id, index) => scores.set(id, lexicalWeight / (60 + index + 1)));
  semantic.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + semanticWeight / (60 + index + 1)));
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
};
const rankings: Record<'standardBm25' | 'e5Dense' | 'equalRrf' | 'weightedRrfBm25Half', string[][]> = { standardBm25: [], e5Dense: [], equalRrf: [], weightedRrfBm25Half: [] };
const lexicalMs: number[] = [];
const semanticMs: number[] = [];
const fusionMs: number[] = [];
const queryEmbeddingMs: number[] = [];
const hybridMs: number[] = [];

for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
  const query = queries[queryIndex]!;
  const lexicalStarted = performance.now();
  const terms = [...new Set(await tokenizeMorphological(query.text.normalize('NFKC')))].filter(Boolean);
  const tokensByRow = query.rows.map(row => passages.get(row.passageId)!.tokens);
  const lengths = tokensByRow.map(tokens => tokens.length);
  const avgLength = lengths.reduce((sum, length) => sum + length, 0) / Math.max(lengths.length, 1);
  const termFrequencies = tokensByRow.map(tokens => {
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
  });
  const df = new Map<string, number>();
  for (const counts of termFrequencies) for (const term of terms) if (counts.has(term)) df.set(term, (df.get(term) ?? 0) + 1);
  const lexical = query.rows.map((row, index) => {
    const counts = termFrequencies[index]!;
    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term) ?? 0;
      const docFrequency = df.get(term) ?? 0;
      if (!tf || !docFrequency) continue;
      const idf = Math.log(1 + (query.rows.length - docFrequency + 0.5) / (docFrequency + 0.5));
      score += idf * (tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * lengths[index]! / Math.max(avgLength, 1)));
    }
    return { id: row.id, score };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(row => row.id);
  rankings.standardBm25.push(lexical);
  lexicalMs.push(performance.now() - lexicalStarted);
  const semanticStarted = performance.now();
  const queryEmbeddingStarted = performance.now();
  const queryOutput = await extractor([`query: ${query.text.normalize('NFKC')}`], { pooling: 'mean', normalize: true });
  if (queryOutput.dims.at(-1) !== 384 || queryOutput.data.length !== 384) throw new Error(`Unexpected E5 query dimensions ${queryOutput.dims.join('x')}.`);
  const queryVector = queryOutput.data;
  queryEmbeddingMs.push(performance.now() - queryEmbeddingStarted);
  const dense = query.rows.map(row => {
    const index = passageIndex.get(row.passageId);
    if (index === undefined) throw new Error(`Missing passage embedding ${row.passageId}.`);
    return { id: row.id, score: dot(queryVector, passageVectors.subarray(index * 384, (index + 1) * 384)) };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(row => row.id);
  rankings.e5Dense.push(dense);
  semanticMs.push(performance.now() - semanticStarted);
  const fusionStarted = performance.now();
  rankings.equalRrf.push(reciprocalRankFusion(lexical, dense));
  rankings.weightedRrfBm25Half.push(reciprocalRankFusion(lexical, dense, 0.5, 1));
  fusionMs.push(performance.now() - fusionStarted);
  hybridMs.push(lexicalMs.at(-1)! + semanticMs.at(-1)! + fusionMs.at(-1)!);
  if ((queryIndex + 1) % 200 === 0 || queryIndex + 1 === queries.length) console.log(`ranked ${queryIndex + 1}/${queries.length}; rss=${process.memoryUsage().rss}`);
}

const relevance = queries.map(query => new Map(query.rows.map(row => [row.id, row.label])));
function score(ranking: string[], labels: Map<string, number>): Metrics {
  const firstRelevant = ranking.findIndex(id => (labels.get(id) ?? 0) > 0);
  let dcg = 0; let hits = 0; let ap = 0;
  for (let rank = 0; rank < Math.min(100, ranking.length); rank++) {
    const grade = labels.get(ranking[rank]!) ?? 0;
    if (rank < 10 && grade > 0) dcg += (2 ** grade - 1) / Math.log2(rank + 2);
    if (grade > 0) { hits++; ap += hits / (rank + 1); }
  }
  const idealGrades = [...labels.values()].sort((a, b) => b - a).slice(0, 10);
  const ideal = idealGrades.reduce((sum, grade, rank) => sum + (2 ** grade - 1) / Math.log2(rank + 2), 0);
  const relevantCount = [...labels.values()].filter(grade => grade > 0).length;
  return { hit1: Number(firstRelevant === 0), hit10: Number(firstRelevant >= 0 && firstRelevant < 10), mrr10: firstRelevant >= 0 && firstRelevant < 10 ? 1 / (firstRelevant + 1) : 0, ndcg10: ideal ? dcg / ideal : 0, map100: relevantCount ? ap / relevantCount : 0, recall100: relevantCount ? hits / relevantCount : 0 };
}
const metricNames = Object.keys(score([], new Map())) as Array<keyof Metrics>;
const metrics = Object.fromEntries(Object.entries(rankings).map(([method, rows]) => [method, Object.fromEntries(metricNames.map(metric => [metric, rows.reduce((sum, ranking, index) => sum + score(ranking, relevance[index]!)[metric], 0) / rows.length]))])) as Record<keyof typeof rankings, Metrics>;

const parent = queries.map((_, index) => index);
const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
const union = (left: number, right: number) => { const a = find(left); const b = find(right); if (a !== b) parent[b] = a; };
const firstQueryByPositivePassage = new Map<string, number>();
queries.forEach((query, index) => query.rows.filter(row => row.label > 0).forEach(row => {
  const previous = firstQueryByPositivePassage.get(row.passageId);
  if (previous === undefined) firstQueryByPositivePassage.set(row.passageId, index); else union(index, previous);
}));
const clusterMap = new Map<number, number[]>();
queries.forEach((_, index) => { const root = find(index); const members = clusterMap.get(root) ?? []; members.push(index); clusterMap.set(root, members); });
const clusters = [...clusterMap.values()];
const randomWithSeed = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
function pairedBootstrap(left: string[][], right: string[][], seed: number) {
  const deltas = queries.map((query, index) => score(right[index]!, relevance[index]!).ndcg10 - score(left[index]!, relevance[index]!).ndcg10);
  const random = randomWithSeed(seed);
  const draws = new Array<number>(20_000);
  for (let draw = 0; draw < draws.length; draw++) {
    let sum = 0; let count = 0;
    for (let sample = 0; sample < clusters.length; sample++) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      for (const queryIndex of cluster) { sum += deltas[queryIndex]!; count++; }
    }
    draws[draw] = sum / count;
  }
  draws.sort((a, b) => a - b);
  return { meanDelta: deltas.reduce((sum, value) => sum + value, 0) / deltas.length, ci95: [draws[499]!, draws[19499]!], clusterCount: clusters.length, bootstrapSamples: draws.length };
}
const pairedVsBm25 = {
  e5Dense: pairedBootstrap(rankings.standardBm25, rankings.e5Dense, 0x7218e5a1),
  equalRrf: pairedBootstrap(rankings.standardBm25, rankings.equalRrf, 0x7218e5a2),
  weightedRrfBm25Half: pairedBootstrap(rankings.standardBm25, rankings.weightedRrfBm25Half, 0x7218e5a3),
};
const artifact = {
  dataset: { name: 'hotchpotch/JQaRA', revision: 'e8016f8cf40f2fd51145be618ebc5a0963831d42', split: 'test', totalQueries: allQueries.length, qidHashOffset: queryOffset, queries: queries.length, selectedQidsSha256, sourceCandidateRows: rowsRead, evaluatedCandidateRows: queries.reduce((sum, query) => sum + query.rows.length, 0), uniquePassages: passagesSorted.length, positiveLabels: queries.reduce((sum, query) => sum + query.rows.filter(row => row.label > 0).length, 0), unusedQueries: allQueries.length - queryOffset - queries.length, queriesSharingEarlierPositivePassages, distinctEarlierPositivePassageOverlap, candidateScope: 'fixed official 100-candidate reranking; not full-corpus retrieval', status: `single-use preregistered SHA-256 query block (${queries.length} queries); labels are automated with partial human review` },
  provenance: { parquetSha256, modelId, modelSha256, tokenizerSha256, tokenization: 'my-search tokenizeMorphological; NFKC', rankingImplementation: 'standard Okapi BM25 with k1=1.2 b=0.75 and per-query candidate-pool statistics; E5 q8 exact cosine over all 100 supplied candidates; equal RRF k=60; weighted RRF uses BM25 weight 0.5 and E5 weight 1.0, k=60' },
  metrics,
  pairedNdcg10VsStandardBm25: pairedVsBm25,
  latencyMs: { modelLoad: modelLoadMs, passageEmbeddingBuild: embeddingBuildMs, queryEmbedding: { p50: percentile(queryEmbeddingMs, 0.5), p95: percentile(queryEmbeddingMs, 0.95), total: queryEmbeddingMs.reduce((sum, value) => sum + value, 0) }, bm25PerQuery: { p50: percentile(lexicalMs, 0.5), p95: percentile(lexicalMs, 0.95) }, e5QueryEmbeddingPlusCandidateScoring: { p50: percentile(semanticMs, 0.5), p95: percentile(semanticMs, 0.95) }, rrfOnly: { p50: percentile(fusionMs, 0.5), p95: percentile(fusionMs, 0.95) }, bm25E5RrfTotal: { p50: percentile(hybridMs, 0.5), p95: percentile(hybridMs, 0.95) } },
  resources: { passageVectorBytes: expectedVectorBytes, modelFileBytes: fs.statSync(modelPath).size, processRssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, uniquePassageCount: passagesSorted.length },
  perQuery: queries.map((query, index) => ({ id: query.id, query: query.text, positiveIds: query.rows.filter(row => row.label > 0).map(row => row.id), ranks: Object.fromEntries(Object.entries(rankings).map(([method, rows]) => [method, rows[index]!.findIndex(id => (relevance[index]!.get(id) ?? 0) > 0) + 1 || null])) })),
};
function percentile(values: number[], p: number) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0; }
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, dataset: artifact.dataset, metrics, pairedNdcg10VsStandardBm25: pairedVsBm25, latencyMs: artifact.latencyMs, resources: artifact.resources }, null, 2));
