import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { analyzeQuery } from '../../services/query_analysis.js';

type Query = { id: string; query: string; gold_ids: string[]; group_id: string; split: string };
type Doc = { id: string; morphological_tokens_json: string; morphological_doc_length: number };
type Metric = { hit1: number; hit10: number; recall100: number; mrr10: number; ndcg10: number };
const [datasetArg, databaseArg, outputArg, deltaArg] = process.argv.slice(2);
if (!datasetArg || !databaseArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_tomt_bm25plus.ts <dataset-dir> <read-only-isolated-db> <new-output.json> [delta=1]');
const delta = Number(deltaArg ?? 1);
if (!Number.isFinite(delta) || delta < 0) throw new Error('delta must be a finite non-negative number.');
const datasetDir = path.resolve(datasetArg);
const databasePath = path.resolve(databaseArg);
const outputPath = path.resolve(outputArg);
if (fs.existsSync(outputPath) || !outputPath.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('Output must be a new path under artifacts/.');
const hashFile = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJsonl = <T>(file: string): T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as T);
const queryPath = path.join(datasetDir, 'development.jsonl');
const docPath = path.join(datasetDir, 'documents.jsonl');
const provenancePath = path.join(datasetDir, 'provenance.json');
const queries = readJsonl<Query>(queryPath);
if (!queries.length || queries.some(query => query.split !== 'development' || !query.gold_ids.length)) throw new Error('Expected labeled development queries only.');
const expectedDocuments = JSON.parse(fs.readFileSync(provenancePath, 'utf8')).documents as number;
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const docs = db.prepare('SELECT id, morphological_tokens_json, morphological_doc_length FROM cards WHERE archived=0 ORDER BY id').all() as Doc[];
if (docs.length !== expectedDocuments) throw new Error(`Expected ${expectedDocuments} indexed cards; found ${docs.length}.`);

const lengths: number[] = [];
const postings = new Map<string, Array<{ index: number; tf: number }>>();
for (let index = 0; index < docs.length; index++) {
  const tokens = JSON.parse(docs[index]!.morphological_tokens_json || '[]') as string[];
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  lengths.push(docs[index]!.morphological_doc_length || tokens.length);
  for (const [term, frequency] of tf) {
    let rows = postings.get(term);
    if (!rows) { rows = []; postings.set(term, rows); }
    rows.push({ index, tf: frequency });
  }
}
const averageLength = lengths.reduce((sum, length) => sum + length, 0) / docs.length;
const metric = (ids: readonly string[], goldIds: readonly string[]): Metric => {
  const gold = new Set(goldIds);
  const rank = ids.findIndex(id => gold.has(id));
  let found = 0;
  let recall = 0;
  for (const id of ids.slice(0, 100)) if (gold.has(id)) { found++; recall++; }
  const dcg = ids.slice(0, 10).reduce((sum, id, index) => sum + (gold.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(gold.size, 10) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
  return { hit1: rank === 0 ? 1 : 0, hit10: rank >= 0 && rank < 10 ? 1 : 0,
    recall100: gold.size ? recall / gold.size : 0, mrr10: rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0, ndcg10: ideal ? dcg / ideal : 0 };
};
const score = (terms: readonly string[], bm25Plus: boolean) => {
  const scores = new Map<number, number>();
  for (const term of new Set(terms)) {
    const rows = postings.get(term);
    if (!rows?.length) continue;
    const df = rows.length;
    const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
    for (const row of rows) {
      const norm = row.tf + 1.2 * (1 - 0.75 + 0.75 * lengths[row.index]! / Math.max(averageLength, 1));
      const tf = (row.tf * 2.2) / norm;
      scores.set(row.index, (scores.get(row.index) ?? 0) + idf * (tf + (bm25Plus ? delta : 0)));
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1] || docs[a[0]]!.id.localeCompare(docs[b[0]]!.id)).map(([index]) => docs[index]!.id);
};
const rows: Array<{ id: string; groupId: string; standard: Metric; bm25Plus: Metric; standardTop10: string[]; bm25PlusTop10: string[] }> = [];
const standardLatency: number[] = [];
const plusLatency: number[] = [];
for (let index = 0; index < queries.length; index++) {
  const query = queries[index]!;
  const words = await purposeWords(query.query);
  const parsed = analyzeQuery(query.query, words.length ? words : query.query.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const terms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
  const startedStandard = performance.now();
  const standard = score(terms, false);
  standardLatency.push(performance.now() - startedStandard);
  const startedPlus = performance.now();
  const bm25Plus = score(terms, true);
  plusLatency.push(performance.now() - startedPlus);
  rows.push({ id: query.id, groupId: query.group_id, standard: metric(standard, query.gold_ids), bm25Plus: metric(bm25Plus, query.gold_ids),
    standardTop10: standard.slice(0, 10), bm25PlusTop10: bm25Plus.slice(0, 10) });
  if ((index + 1) % 100 === 0 || index + 1 === queries.length) console.log(`evaluated ${index + 1}/${queries.length}`);
}
db.close();
const metrics = (mode: 'standard' | 'bm25Plus'): Metric => Object.fromEntries((['hit1', 'hit10', 'recall100', 'mrr10', 'ndcg10'] as const)
  .map(key => [key, rows.reduce((sum, row) => sum + row[mode][key], 0) / rows.length])) as Metric;
const pairedClusterBootstrap = (key: keyof Metric) => {
  const groups = new Map<string, number[]>();
  for (const row of rows) groups.set(row.groupId, [...(groups.get(row.groupId) ?? []), row.bm25Plus[key] - row.standard[key]]);
  const clusters = [...groups.values()];
  let seed = Number.parseInt(crypto.createHash('sha256').update(`tomt-books-bm25plus-${delta}-${key}`).digest('hex').slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = new Array<number>(20_000);
  for (let iteration = 0; iteration < draws.length; iteration++) {
    let total = 0;
    let count = 0;
    for (let draw = 0; draw < clusters.length; draw++) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      total += cluster.reduce((sum, value) => sum + value, 0);
      count += cluster.length;
    }
    draws[iteration] = total / count;
  }
  draws.sort((a, b) => a - b);
  return { meanDifference: rows.reduce((sum, row) => sum + row.bm25Plus[key] - row.standard[key], 0) / rows.length,
    clusterBootstrap95CI: [draws[499]!, draws[19_499]!], clusterCount: clusters.length };
};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const result = {
  dataset: { name: `Reddit-TOMT ${path.basename(datasetDir)}`, split: 'development; exploratory only', documents: docs.length, queries: rows.length,
    groups: new Set(rows.map(row => row.groupId)).size, queryIdsSha256: crypto.createHash('sha256').update(rows.map(row => row.id).sort().join('\n')).digest('hex'),
    sourceSha256: hashFile(queryPath), documentSourceSha256: hashFile(docPath) },
  definitions: { standard: 'Current positive-smoothed IDF BM25, k1=1.2, b=0.75.', bm25Plus: `BM25+ with same IDF, k1=1.2, b=0.75 and delta=${delta}; adds IDF*delta only for matched query terms.`,
    shared: 'Same saved morphology tokens, document lengths, purposeWords/analyzeQuery parser, candidate set, and labels.' },
  metrics: { standard: metrics('standard'), bm25Plus: metrics('bm25Plus') },
  differencesVsStandard: Object.fromEntries((['hit1', 'hit10', 'recall100', 'mrr10', 'ndcg10'] as const).map(key => [key, pairedClusterBootstrap(key)])),
  resources: { databaseOpenedReadOnly: true, processRssBytes: process.memoryUsage().rss, processHeapUsedBytes: process.memoryUsage().heapUsed,
    queryLatencyMs: { standardP50: percentile(standardLatency, 0.5), standardP95: percentile(standardLatency, 0.95),
      bm25PlusP50: percentile(plusLatency, 0.5), bm25PlusP95: percentile(plusLatency, 0.95) } },
  perQuery: rows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, dataset: result.dataset, metrics: result.metrics,
  differencesVsStandard: result.differencesVsStandard, resources: result.resources }, null, 2));
