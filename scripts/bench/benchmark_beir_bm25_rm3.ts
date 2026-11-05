import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tokenizeMorphological } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { buildBo1ExpansionWeights, scoreWeightedStandardBm25 } from './bo1_expansion.js';
import { buildRm3QueryWeights, scoreWeightedBm25, type Rm3Document } from './bm25_rm3.js';
import type { Posting } from './bm25_adaptive_tf.js';

type Document = { _id: string; title?: string; text?: string };
type Query = { _id: string; text: string };
type Metrics = { hit1: number; hit10: number; mrr10: number; ndcg10: number; map100: number; recall100: number };
type Mode = 'standard' | 'bo1' | 'rm3';
const [datasetArg, splitArg, outputArg] = process.argv.slice(2);
if (!datasetArg || splitArg !== 'dev' || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_beir_bm25_rm3.ts <dataset-dir> dev <new-output.json>');
const datasetDir = path.resolve(datasetArg);
const outputPath = path.resolve(outputArg);
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new path under artifacts/.');
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const queriesPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels', 'dev.tsv');
for (const file of [corpusPath, queriesPath, qrelsPath]) if (!fs.existsSync(file)) throw new Error(`Missing BEIR input: ${file}`);
const hashFile = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJsonl = async function* <T>(file: string): AsyncGenerator<T> {
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line) as T;
};

const queryTexts = new Map<string, string>();
for await (const query of readJsonl<Query>(queriesPath)) queryTexts.set(query._id, query.text);
const qrelMap = new Map<string, Map<string, number>>();
for (const [lineNumber, line] of fs.readFileSync(qrelsPath, 'utf8').split(/\r?\n/u).entries()) {
  if (!line.trim() || line.startsWith('query-id')) continue;
  const [queryId, docId, scoreText] = line.split('\t');
  if (!queryId || !docId || !queryTexts.has(queryId) || !Number.isFinite(Number(scoreText))) throw new Error(`Invalid qrels row ${lineNumber + 1}.`);
  const judgments = qrelMap.get(queryId) ?? new Map<string, number>();
  judgments.set(docId, Math.max(judgments.get(docId) ?? 0, Number(scoreText)));
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
const qrels = [...qrelMap].map(([id, judgments]) => ({ id, groupId: parents.has(`q:${id}`) ? find(`q:${id}`) : `q:${id}`, judgments, text: queryTexts.get(id)! }));
if (!qrels.length) throw new Error('No development qrels.');

type IndexedDocument = Rm3Document & { id: string };
const documents: IndexedDocument[] = [];
const lengths: number[] = [];
const postings = new Map<string, Posting[]>();
const collectionFrequencies = new Map<string, number>();
const prepStarted = performance.now();
for await (const document of readJsonl<Document>(corpusPath)) {
  if (!document._id) throw new Error('Corpus row is missing _id.');
  const tokens = await tokenizeMorphological(`${document.title ?? ''} ${document.text ?? ''}`.normalize('NFKC'));
  const frequencies = new Map<string, number>();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const docIndex = documents.length;
  documents.push({ id: document._id, length: tokens.length, termFrequencies: frequencies });
  lengths.push(tokens.length);
  for (const [term, tf] of frequencies) {
    const rows = postings.get(term) ?? [];
    rows.push({ docIndex, tf });
    postings.set(term, rows);
    collectionFrequencies.set(term, (collectionFrequencies.get(term) ?? 0) + tf);
  }
}
const indexBuildMs = performance.now() - prepStarted;
const collectionLength = lengths.reduce((sum, value) => sum + value, 0);
const averageLength = collectionLength / Math.max(documents.length, 1);

const metric = (rankedIds: readonly string[], judgments: Map<string, number>): Metrics => {
  const relevant = new Set([...judgments].filter(([, grade]) => grade > 0).map(([id]) => id));
  const first = rankedIds.findIndex(id => relevant.has(id));
  const top10 = rankedIds.slice(0, 10);
  const dcg = top10.reduce((sum, id, index) => sum + (2 ** (judgments.get(id) ?? 0) - 1) / Math.log2(index + 2), 0);
  const ideal = [...judgments.values()].filter(grade => grade > 0).sort((a, b) => b - a).slice(0, 10)
    .reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  let hits = 0; let precisionSum = 0;
  for (const [index, id] of rankedIds.slice(0, 100).entries()) if (relevant.has(id)) { hits++; precisionSum += hits / (index + 1); }
  return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0,
    mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0,
    map100: relevant.size ? precisionSum / relevant.size : 0, recall100: relevant.size ? hits / relevant.size : 0 };
};

const modes: Mode[] = ['standard', 'bo1', 'rm3'];
const perMode: Record<Mode, Array<{ id: string; groupId: string; metrics: Metrics; top10: string[] }>> = { standard: [], bo1: [], rm3: [] };
const latency: Record<Mode, number[]> = { standard: [], bo1: [], rm3: [] };
const maxHeapUsedBytes = () => process.memoryUsage().heapUsed;
let peakHeapUsedBytes = maxHeapUsedBytes();
const analysisTimes: number[] = [];

for (const query of qrels) {
  const analysisStarted = performance.now();
  const dictionaryWords = await purposeWords(query.text);
  const parsed = analyzeQuery(query.text, dictionaryWords.length ? dictionaryWords : query.text.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const terms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
  analysisTimes.push(performance.now() - analysisStarted);

  const started = performance.now();
  const standard = scoreWeightedStandardBm25(new Map(terms.map(term => [term, 1])), documents.length, averageLength, lengths, postings);
  const standardMs = performance.now() - started;
  const standardIds = standard.map(row => documents[row.docIndex]!.id);
  perMode.standard.push({ id: query.id, groupId: query.groupId, metrics: metric(standardIds, query.judgments), top10: standardIds.slice(0, 10) });
  latency.standard.push(standardMs);

  const bo1Started = performance.now();
  const feedbackTermFrequencies = new Map<string, number>();
  for (const hit of standard.slice(0, 3)) for (const [term, tf] of documents[hit.docIndex]!.termFrequencies) {
    feedbackTermFrequencies.set(term, (feedbackTermFrequencies.get(term) ?? 0) + tf);
  }
  const bo1Expansion = buildBo1ExpansionWeights(feedbackTermFrequencies, collectionFrequencies, documents.length, new Set(terms), 10);
  const bo1Weights = new Map(terms.map(term => [term, 1]));
  for (const [term, weight] of bo1Expansion) bo1Weights.set(term, weight);
  const bo1 = scoreWeightedStandardBm25(bo1Weights, documents.length, averageLength, lengths, postings);
  const bo1Ms = performance.now() - bo1Started + standardMs;
  const bo1Ids = bo1.map(row => documents[row.docIndex]!.id);
  perMode.bo1.push({ id: query.id, groupId: query.groupId, metrics: metric(bo1Ids, query.judgments), top10: bo1Ids.slice(0, 10) });
  latency.bo1.push(bo1Ms);

  const rm3Started = performance.now();
  const rm3Weights = buildRm3QueryWeights(terms, standard, documents, documents.length, collectionLength, collectionFrequencies);
  const rm3 = scoreWeightedBm25(rm3Weights, documents.length, averageLength, lengths, postings);
  const rm3Ms = performance.now() - rm3Started + standardMs;
  const rm3Ids = rm3.map(row => documents[row.docIndex]!.id);
  perMode.rm3.push({ id: query.id, groupId: query.groupId, metrics: metric(rm3Ids, query.judgments), top10: rm3Ids.slice(0, 10) });
  latency.rm3.push(rm3Ms);
  peakHeapUsedBytes = Math.max(peakHeapUsedBytes, maxHeapUsedBytes());
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const percentile = (values: number[], probability: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * probability) - 1)] ?? 0;
const metricKeys: (keyof Metrics)[] = ['hit1', 'hit10', 'mrr10', 'ndcg10', 'map100', 'recall100'];
const bootstrap = (mode: Exclude<Mode, 'standard'>, key: keyof Metrics) => {
  const groupDeltas = new Map<string, number[]>();
  qrels.forEach((row, index) => groupDeltas.set(row.groupId, [...(groupDeltas.get(row.groupId) ?? []), perMode[mode][index]!.metrics[key] - perMode.standard[index]!.metrics[key]]));
  const groups = [...groupDeltas.values()];
  let seed = Number.parseInt(crypto.createHash('sha256').update(`${path.basename(datasetDir)}|${mode}|${key}`).digest('hex').slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = new Array<number>(20_000);
  for (let draw = 0; draw < draws.length; draw++) {
    let sum = 0; let count = 0;
    for (let index = 0; index < groups.length; index++) { const group = groups[Math.floor(random() * groups.length)]!; sum += group.reduce((total, value) => total + value, 0); count += group.length; }
    draws[draw] = sum / count;
  }
  draws.sort((a, b) => a - b);
  const allDeltas = [...groupDeltas.values()].flat();
  return { meanDifference: mean(allDeltas), clusterCount: groups.length, pairedClusterBootstrap95CI: [draws[499]!, draws[19_499]!] };
};
const summaries = Object.fromEntries(modes.map(mode => [mode, {
  metrics: Object.fromEntries(metricKeys.map(key => [key, mean(perMode[mode].map(row => row.metrics[key]))])),
  latencyMs: { p50: percentile(latency[mode], 0.5), p95: percentile(latency[mode], 0.95) },
}]));
const result = {
  dataset: { name: path.basename(datasetDir), split: 'BEIR dev', documents: documents.length, queries: qrels.length,
    positiveQrelConnectedComponents: new Set(qrels.map(row => row.groupId)).size,
    corpusSha256: hashFile(corpusPath), queriesSha256: hashFile(queriesPath), qrelsSha256: hashFile(qrelsPath) },
  definitions: {
    standard: 'Shared analyzed query terms; positive-smoothed BM25 k1=1.2,b=0.75 over the full Kuromoji morphology corpus.',
    bo1: 'Existing Terrier-inspired two-pass Bo1 expansion with top 3 feedback documents and top 10 expansion terms; parameters unchanged.',
    rm3: 'RM3-style query model: top 10 standard-BM25 documents; Dirichlet mu=1000 query-likelihood posterior over those documents; Dirichlet-smoothed term models; top 10 non-query terms; 0.5 original-query / 0.5 feedback model interpolation; weighted standard BM25 reranks the full corpus. Fixed before observing this run.',
    datasetStatus: 'Exploratory method-specific comparison on development data. These source datasets have other prior method experiments, so this is not a study-wide untouched holdout or final confirmation.',
  },
  metrics: summaries,
  differencesVsStandard: Object.fromEntries((['bo1', 'rm3'] as const).map(mode => [mode, Object.fromEntries(metricKeys.map(key => [key, bootstrap(mode, key)]))])),
  resources: { indexBuildMs, queryAnalysisMs: { p50: percentile(analysisTimes, 0.5), p95: percentile(analysisTimes, 0.95) },
    rankLatencyIncludesInitialBm25ForFeedback: true, processRssBytes: process.memoryUsage().rss,
    processHeapUsedBytes: process.memoryUsage().heapUsed, peakObservedHeapUsedBytes: peakHeapUsedBytes },
  perQuery: qrels.map((row, index) => ({ id: row.id, groupId: row.groupId, standard: perMode.standard[index], bo1: perMode.bo1[index], rm3: perMode.rm3[index] })),
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, dataset: result.dataset, metrics: result.metrics, differencesVsStandard: result.differencesVsStandard, resources: result.resources }, null, 2));
