import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tokenizeMorphological } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { buildAdaptiveTermModels, scoreAdaptiveBm25, type Posting } from './bm25_adaptive_tf.js';
import { buildBo1ExpansionWeights, scoreWeightedStandardBm25 } from './bo1_expansion.js';
import { scorePl2 } from './pl2.js';
import { reciprocalRankFusion } from './rrf.js';

type Document = { _id: string; title?: string; text?: string };
type Query = { _id: string; text: string };
type ScoredMode = 'standard' | 'adaptive-k1' | 'bm25-adpt' | 'pl2';
type Mode = ScoredMode | 'bm25-pl2-rrf' | 'bo1-expansion' | 'bm25-bo1-rrf';
type Metrics = { hit1: number; hit10: number; mrr10: number; ndcg10: number; map100: number; recall100: number };
const [datasetArg, splitArg, outputArg] = process.argv.slice(2);
if (!datasetArg || !splitArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_beir_bm25_adaptive_tf.ts <dataset-dir> <train|dev> <new-output.json>');
if (!['train', 'dev'].includes(splitArg)) throw new Error('Exploration is restricted to BEIR train/dev splits.');
const datasetDir = path.resolve(datasetArg);
const split = splitArg;
const outputPath = path.resolve(outputArg);
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new path under artifacts/.');
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const queriesPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels', `${split}.tsv`);
for (const file of [corpusPath, queriesPath, qrelsPath]) if (!fs.existsSync(file)) throw new Error(`Missing BEIR input: ${file}`);
const hashFile = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJsonl = async function* <T>(file: string): AsyncGenerator<T> {
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line) as T;
};

const qrelMap = new Map<string, Map<string, number>>();
const queriesById = new Map<string, string>();
for await (const query of readJsonl<Query>(queriesPath)) queriesById.set(query._id, query.text);
for (const [lineNumber, line] of fs.readFileSync(qrelsPath, 'utf8').split(/\r?\n/u).entries()) {
  if (!line.trim() || line.startsWith('query-id')) continue;
  const [queryId, docId, scoreText] = line.split('\t');
  if (!queryId || !docId || !queriesById.has(queryId) || !Number.isFinite(Number(scoreText))) throw new Error(`Invalid qrels row ${lineNumber + 1}.`);
  const rows = qrelMap.get(queryId) ?? new Map<string, number>();
  rows.set(docId, Math.max(rows.get(docId) ?? 0, Number(scoreText)));
  qrelMap.set(queryId, rows);
}

const parent = new Map<string, string>();
const find = (id: string): string => {
  const current = parent.get(id);
  if (!current) { parent.set(id, id); return id; }
  if (current === id) return id;
  const root = find(current); parent.set(id, root); return root;
};
const union = (left: string, right: string) => { const a = find(left); const b = find(right); if (a !== b) parent.set(b, a); };
for (const [queryId, judgments] of qrelMap) for (const [docId, grade] of judgments) if (grade > 0) union(`q:${queryId}`, `d:${docId}`);
const qrels = [...qrelMap].map(([id, judgments]) => ({ id, groupId: parent.has(`q:${id}`) ? find(`q:${id}`) : `q:${id}`, judgments }));
if (!qrels.length) throw new Error(`No qrels in the ${split} split.`);

type IndexedDocument = { id: string; length: number; termFrequencies: Map<string, number> };
const documents: IndexedDocument[] = [];
const lengths: number[] = [];
const postings = new Map<string, Posting[]>();
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
    let rows = postings.get(term);
    if (!rows) { rows = []; postings.set(term, rows); }
    rows.push({ docIndex, tf });
  }
  if (documents.length % 1000 === 0) console.log(`tokenized ${documents.length} documents`);
}
const averageLength = lengths.reduce((sum, length) => sum + length, 0) / Math.max(lengths.length, 1);
const collectionFrequencies = new Map([...postings].map(([term, rows]) => [term, rows.reduce((sum, row) => sum + row.tf, 0)]));
const modelStarted = performance.now();
const models = buildAdaptiveTermModels(documents.length, averageLength, lengths, postings);
const modelBuildMs = performance.now() - modelStarted;

const metric = (rankedIds: string[], judgments: Map<string, number>): Metrics => {
  const relevant = new Set([...judgments].filter(([, grade]) => grade > 0).map(([id]) => id));
  const rank = rankedIds.findIndex(id => relevant.has(id));
  let hits100 = 0;
  let precisionSum = 0;
  for (const [index, id] of rankedIds.slice(0, 100).entries()) {
    if (relevant.has(id)) { hits100++; precisionSum += (hits100 / (index + 1)); }
  }
  const dcg = rankedIds.slice(0, 10).reduce((sum, id, index) => sum + ((2 ** (judgments.get(id) ?? 0) - 1) / Math.log2(index + 2)), 0);
  const idealGains = [...judgments.values()].sort((a, b) => b - a).slice(0, 10);
  const ideal = idealGains.reduce((sum, grade, index) => sum + ((2 ** grade - 1) / Math.log2(index + 2)), 0);
  return { hit1: rank === 0 ? 1 : 0, hit10: rank >= 0 && rank < 10 ? 1 : 0,
    mrr10: rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0, ndcg10: ideal ? dcg / ideal : 0,
    map100: relevant.size ? precisionSum / relevant.size : 0, recall100: relevant.size ? hits100 / relevant.size : 0 };
};
const scoredModes: ScoredMode[] = ['standard', 'adaptive-k1', 'bm25-adpt', 'pl2'];
const modes: Mode[] = [...scoredModes, 'bm25-pl2-rrf', 'bo1-expansion', 'bm25-bo1-rrf'];
const outcomes: Record<Mode, Array<{ id: string; groupId: string; metrics: Metrics; top10: string[] }>> = { standard: [], 'adaptive-k1': [], 'bm25-adpt': [], pl2: [], 'bm25-pl2-rrf': [], 'bo1-expansion': [], 'bm25-bo1-rrf': [] };
const latency: Record<Mode, number[]> = { standard: [], 'adaptive-k1': [], 'bm25-adpt': [], pl2: [], 'bm25-pl2-rrf': [], 'bo1-expansion': [], 'bm25-bo1-rrf': [] };
const queryAnalysisMs: number[] = [];
for (const qrel of qrels) {
  const text = queriesById.get(qrel.id)!;
  const queryStarted = performance.now();
  const dictionaryWords = await purposeWords(text);
  const parsed = analyzeQuery(text, dictionaryWords.length ? dictionaryWords : text.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const terms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
  queryAnalysisMs.push(performance.now() - queryStarted);
  const rankedByMode = new Map<ScoredMode, Array<{ docIndex: number; score: number }>>();
  const modeLatency = new Map<ScoredMode, number>();
  for (const mode of scoredModes) {
    const started = performance.now();
    const ranked = mode === 'pl2'
      ? scorePl2(terms, documents.length, averageLength, lengths, collectionFrequencies, postings)
      : scoreAdaptiveBm25(terms, documents.length, averageLength, lengths, postings, models, mode);
    const rankMs = performance.now() - started;
    rankedByMode.set(mode, ranked);
    modeLatency.set(mode, rankMs);
    latency[mode].push(rankMs);
    const rankedIds = ranked.map(row => documents[row.docIndex]!.id);
    outcomes[mode].push({ id: qrel.id, groupId: qrel.groupId, metrics: metric(rankedIds, qrel.judgments), top10: rankedIds.slice(0, 10) });
  }
  const fusionStarted = performance.now();
  const fused = reciprocalRankFusion([rankedByMode.get('standard')!, rankedByMode.get('pl2')!], 60);
  const fusionMs = performance.now() - fusionStarted;
  const fusedIds = fused.map(row => documents[row.docIndex]!.id);
  latency['bm25-pl2-rrf'].push(modeLatency.get('standard')! + modeLatency.get('pl2')! + fusionMs);
  outcomes['bm25-pl2-rrf'].push({ id: qrel.id, groupId: qrel.groupId, metrics: metric(fusedIds, qrel.judgments), top10: fusedIds.slice(0, 10) });

  const bo1Started = performance.now();
  const feedbackTermFrequencies = new Map<string, number>();
  for (const hit of rankedByMode.get('standard')!.slice(0, 3)) {
    for (const [term, tf] of documents[hit.docIndex]!.termFrequencies) {
      feedbackTermFrequencies.set(term, (feedbackTermFrequencies.get(term) ?? 0) + tf);
    }
  }
  const expansionWeights = buildBo1ExpansionWeights(feedbackTermFrequencies, collectionFrequencies, documents.length, new Set(terms), 10);
  const weightedTerms = new Map<string, number>(terms.map(term => [term, 1]));
  for (const [term, weight] of expansionWeights) weightedTerms.set(term, weight);
  const expanded = scoreWeightedStandardBm25(weightedTerms, documents.length, averageLength, lengths, postings);
  const expandedIds = expanded.map(row => documents[row.docIndex]!.id);
  const feedbackAndRescoreMs = performance.now() - bo1Started;
  latency['bo1-expansion'].push(modeLatency.get('standard')! + feedbackAndRescoreMs);
  outcomes['bo1-expansion'].push({ id: qrel.id, groupId: qrel.groupId, metrics: metric(expandedIds, qrel.judgments), top10: expandedIds.slice(0, 10) });
  const bo1FusionStarted = performance.now();
  const bo1Fused = reciprocalRankFusion([rankedByMode.get('standard')!, expanded], 60);
  const bo1FusedIds = bo1Fused.map(row => documents[row.docIndex]!.id);
  latency['bm25-bo1-rrf'].push(modeLatency.get('standard')! + feedbackAndRescoreMs + performance.now() - bo1FusionStarted);
  outcomes['bm25-bo1-rrf'].push({ id: qrel.id, groupId: qrel.groupId, metrics: metric(bo1FusedIds, qrel.judgments), top10: bo1FusedIds.slice(0, 10) });
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const groupBootstrap = (candidate: Mode, key: keyof Metrics, seedText: string) => {
  const groupDiffs = new Map<string, number[]>();
  for (let index = 0; index < qrels.length; index++) {
    const group = qrels[index]!.groupId;
    const difference = outcomes[candidate][index]!.metrics[key] - outcomes.standard[index]!.metrics[key];
    groupDiffs.set(group, [...(groupDiffs.get(group) ?? []), difference]);
  }
  const groups = [...groupDiffs.values()];
  let seed = Number.parseInt(crypto.createHash('sha256').update(seedText).digest('hex').slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = new Array<number>(20_000);
  for (let iteration = 0; iteration < draws.length; iteration++) {
    let total = 0; let count = 0;
    for (let draw = 0; draw < groups.length; draw++) {
      const group = groups[Math.floor(random() * groups.length)]!;
      total += group.reduce((sum, value) => sum + value, 0); count += group.length;
    }
    draws[iteration] = total / count;
  }
  draws.sort((a, b) => a - b);
  return { meanDifference: mean(outcomes[candidate].map((row, index) => row.metrics[key] - outcomes.standard[index]!.metrics[key])),
    clusterCount: groups.length, ci95: [draws[499]!, draws[19_499]!] };
};
const summary = Object.fromEntries(modes.map(mode => [mode, {
  metrics: Object.fromEntries((Object.keys(outcomes[mode][0]!.metrics) as Array<keyof Metrics>).map(key => [key, mean(outcomes[mode].map(row => row.metrics[key]))])),
  latencyMs: { p50: percentile(latency[mode], 0.5), p95: percentile(latency[mode], 0.95) },
}])) as Record<Mode, unknown>;
const paired = Object.fromEntries((['adaptive-k1', 'bm25-adpt', 'pl2', 'bm25-pl2-rrf', 'bo1-expansion', 'bm25-bo1-rrf'] as const).map(mode => [mode,
  Object.fromEntries((['hit1', 'hit10', 'mrr10', 'ndcg10', 'map100', 'recall100'] as const).map(key => [key, groupBootstrap(mode, key, `${path.basename(datasetDir)}|${split}|${mode}|${key}`)]))]));
const result = {
  generatedAt: new Date().toISOString(),
  dataset: { name: path.basename(datasetDir), split, documents: documents.length, queries: qrels.length,
    positiveQrelGroups: new Set(qrels.map(row => row.groupId)).size,
    corpusSha256: hashFile(corpusPath), queriesSha256: hashFile(queriesPath), qrelsSha256: hashFile(qrelsPath) },
  method: { tokenizer: 'my-search Kuromoji morphology tokens for documents and shared query analysis for queries',
    standard: 'positive-smoothed IDF BM25, k1=1.2,b=0.75',
    adaptiveK1: 'per-term k1 fitted by squared error between BM25 TF saturation and normalized corpus information-gain curve; standard positive-smoothed IDF retained',
    bm25Adpt: 'per-term k1 plus paper information-gain IDF (Lv & Zhai, CIKM 2011); b=0.75; grid fit k1=0.05..20.0, terms with nonpositive IG1 omitted',
    pl2: 'Xapian PL2 weighting implementation formula; c=1, unique query terms, same morphology tokens and candidate set',
    bm25Pl2Rrf: 'equal reciprocal-rank fusion of standard BM25 and PL2, k=60 fixed from Cormack et al. SIGIR 2009; same candidate lists',
    bo1Expansion: 'two-pass pseudo-relevance feedback: standard BM25 top 3 documents, Terrier-style Bo1 term weights, remove original query terms, keep top 10, normalize expansion weights by maximum, then weighted standard BM25; first and second passes are included in per-query latency',
    bm25Bo1Rrf: 'RRF k=60 fusion of standard BM25 and the Bo1-expanded weighted BM25 ranking; both first/second pass scoring and fusion are included in per-query latency',
    qrelsAndQueryUnchanged: true, independentFinalEvaluation: false },
  setup: { tokenizeMs: modelStarted - prepStarted, adaptiveStatisticsBuildMs: modelBuildMs, queryAnalysisP50Ms: percentile(queryAnalysisMs, 0.5),
    queryAnalysisP95Ms: percentile(queryAnalysisMs, 0.95), vocabulary: postings.size,
    adaptiveTerms: models.size, adaptiveFitFallbackTerms: [...models.values()].filter(model => model.fitPoints === 0).length,
    nonpositiveInformationGainTerms: [...models.values()].filter(model => model.informationGainIdf <= 0).length,
    peakRssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed },
  summary,
  pairedVsStandard: paired,
  perQuery: qrels.map((row, index) => ({ id: row.id, groupId: row.groupId, standard: outcomes.standard[index], adaptiveK1: outcomes['adaptive-k1'][index], bm25Adpt: outcomes['bm25-adpt'][index], pl2: outcomes.pl2[index], bm25Pl2Rrf: outcomes['bm25-pl2-rrf'][index], bo1Expansion: outcomes['bo1-expansion'][index], bm25Bo1Rrf: outcomes['bm25-bo1-rrf'][index] })),
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, dataset: result.dataset, summary: result.summary, pairedVsStandard: result.pairedVsStandard, setup: result.setup }, null, 2));
