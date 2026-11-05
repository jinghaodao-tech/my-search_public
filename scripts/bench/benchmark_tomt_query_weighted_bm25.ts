import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { analyzeQuery } from '../../services/query_analysis.js';

type Query = { id: string; query: string; gold_ids: string[]; group_id: string; split: string };
type Doc = { id: string; morphological_tokens_json: string; morphological_doc_length: number };
type Metric = { hit1: number; hit10: number; recall100: number; mrr10: number; ndcg10: number; map100: number };
const [datasetArg, databaseArg, outputArg] = process.argv.slice(2);
if (!datasetArg || !databaseArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_tomt_query_weighted_bm25.ts <dataset-dir> <read-only-isolated-db> <new-output.json>');
const datasetDir = path.resolve(datasetArg);
const databasePath = path.resolve(databaseArg);
const outputPath = path.resolve(outputArg);
if (fs.existsSync(outputPath) || !outputPath.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('Output must be new and under artifacts/.');
const queryPath = path.join(datasetDir, 'development.jsonl');
const docsPath = path.join(datasetDir, 'documents.jsonl');
const sourceHash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJsonl = <T>(file: string): T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as T);
const allQueries = readJsonl<Query>(queryPath);
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const byGroup = new Map<string, Query[]>();
for (const query of allQueries) {
  if (query.split !== 'development' || !query.gold_ids.length) throw new Error('Only labeled development queries are allowed.');
  byGroup.set(query.group_id, [...(byGroup.get(query.group_id) ?? []), query]);
}
const queries = [...byGroup.keys()].sort((a, b) => hash(a).localeCompare(hash(b))).map(group =>
  byGroup.get(group)!.sort((a, b) => hash(`${group}\0${a.id}`).localeCompare(hash(`${group}\0${b.id}`)))[0]!);
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
const docs = database.prepare('SELECT id, morphological_tokens_json, morphological_doc_length FROM cards WHERE archived=0 ORDER BY id').all() as Doc[];
const expectedDocuments = JSON.parse(fs.readFileSync(path.join(datasetDir, 'provenance.json'), 'utf8')).documents as number;
if (docs.length !== expectedDocuments) throw new Error(`Expected ${expectedDocuments} documents, found ${docs.length}.`);
const lengths: number[] = [];
const postings = new Map<string, Array<{ index: number; tf: number }>>();
for (let index = 0; index < docs.length; index++) {
  const tokens = JSON.parse(docs[index]!.morphological_tokens_json || '[]') as string[];
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  lengths.push(docs[index]!.morphological_doc_length || tokens.length);
  for (const [term, count] of tf) {
    let rows = postings.get(term);
    if (!rows) { rows = []; postings.set(term, rows); }
    rows.push({ index, tf: count });
  }
}
const avgLength = lengths.reduce((sum, value) => sum + value, 0) / docs.length;
const metric = (ids: string[], goldIds: string[]): Metric => {
  const gold = new Set(goldIds);
  const first = ids.findIndex(id => gold.has(id));
  const top10 = ids.slice(0, 10);
  const dcg = top10.reduce((sum, id, index) => sum + (gold.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(gold.size, 10) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
  let found = 0;
  let ap = 0;
  for (let rank = 0; rank < Math.min(ids.length, 100); rank++) if (gold.has(ids[rank]!)) { found++; ap += found / (rank + 1); }
  return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0,
    recall100: gold.size ? ids.slice(0, 100).filter(id => gold.has(id)).length / gold.size : 0,
    mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0, map100: gold.size ? ap / gold.size : 0 };
};
const rank = (termWeights: Map<string, number>) => {
  const scores = new Map<number, number>();
  for (const [term, weight] of termWeights) {
    const rows = postings.get(term);
    if (!rows?.length) continue;
    const idf = Math.log(1 + (docs.length - rows.length + 0.5) / (rows.length + 0.5));
    for (const row of rows) {
      const norm = row.tf + 1.2 * (1 - 0.75 + 0.75 * lengths[row.index]! / Math.max(avgLength, 1));
      const contribution = idf * (row.tf * 2.2) / norm * weight;
      scores.set(row.index, (scores.get(row.index) ?? 0) + contribution);
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1] || docs[a[0]]!.id.localeCompare(docs[b[0]]!.id)).map(([index]) => docs[index]!.id);
};
const evaluated: Array<{ id: string; groupId: string; standard: Metric; parserWeighted: Metric; standardTop10: string[]; parserWeightedTop10: string[] }> = [];
const latencies = { standard: [] as number[], parserWeighted: [] as number[] };
for (let index = 0; index < queries.length; index++) {
  const query = queries[index]!;
  const words = await purposeWords(query.query);
  const parsed = analyzeQuery(query.query, words.length ? words : query.query.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const standardWeights = new Map<string, number>();
  const parserWeights = new Map<string, number>();
  for (const keyword of parsed.keywords) {
    standardWeights.set(keyword.term, 1);
    parserWeights.set(keyword.term, Math.max(parserWeights.get(keyword.term) ?? 0, keyword.weight));
  }
  let started = performance.now();
  const standard = rank(standardWeights);
  latencies.standard.push(performance.now() - started);
  started = performance.now();
  const weighted = rank(parserWeights);
  latencies.parserWeighted.push(performance.now() - started);
  evaluated.push({ id: query.id, groupId: query.group_id, standard: metric(standard, query.gold_ids), parserWeighted: metric(weighted, query.gold_ids),
    standardTop10: standard.slice(0, 10), parserWeightedTop10: weighted.slice(0, 10) });
  if ((index + 1) % 100 === 0 || index + 1 === queries.length) console.log(`evaluated ${index + 1}/${queries.length}`);
}
database.close();
const metricNames = ['hit1', 'hit10', 'recall100', 'mrr10', 'ndcg10', 'map100'] as const;
const metrics = (method: 'standard' | 'parserWeighted') => Object.fromEntries(metricNames.map(key => [key,
  evaluated.reduce((sum, row) => sum + row[method][key], 0) / evaluated.length])) as Metric;
const bootstrap = (key: typeof metricNames[number]) => {
  const clusters = new Map<string, number[]>();
  for (const row of evaluated) clusters.set(row.groupId, [...(clusters.get(row.groupId) ?? []), row.parserWeighted[key] - row.standard[key]]);
  const groups = [...clusters.values()];
  let seed = Number.parseInt(hash(`tomt-books-parser-weighted-${key}`).slice(0, 8), 16) >>> 0;
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
  return { meanDifference: evaluated.reduce((sum, row) => sum + row.parserWeighted[key] - row.standard[key], 0) / evaluated.length,
    clusterBootstrap95CI: [draws[499]!, draws[19_499]!], clusterCount: groups.length };
};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const result = {
  dataset: { name: 'Reddit-TOMT Books', split: 'development; exploratory only', documents: docs.length, queries: evaluated.length, groups: new Set(evaluated.map(row => row.groupId)).size,
    selectedQueryIdsSha256: hash(evaluated.map(row => row.id).sort().join('\n')), querySourceSha256: sourceHash(queryPath), documentSourceSha256: sourceHash(docsPath) },
  definitions: { standard: 'Positive-smoothed IDF BM25; k1=1.2,b=0.75; each parsed query term weight=1.',
    parserWeighted: 'Same BM25 and candidate set; multiply each matched term contribution by the existing analyzeQuery() keyword.weight. No tuning.',
    weights: 'Existing parser defaults: specific terms use purposeTermWeight-derived 1 or 1.5; generic terms 0.4; intentional acronym/Go 0.5.',
    selection: 'One query per target group, fixed SHA-256 ordering; labels/scores are not used for selection.' },
  metrics: { standard: metrics('standard'), parserWeighted: metrics('parserWeighted') },
  differencesVsStandard: Object.fromEntries(metricNames.map(key => [key, bootstrap(key)])),
  resources: { databaseOpenedReadOnly: true, processRssBytes: process.memoryUsage().rss, processHeapUsedBytes: process.memoryUsage().heapUsed,
    queryLatencyMs: { standardP50: percentile(latencies.standard, .5), standardP95: percentile(latencies.standard, .95),
      parserWeightedP50: percentile(latencies.parserWeighted, .5), parserWeightedP95: percentile(latencies.parserWeighted, .95) } },
  perQuery: evaluated,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, dataset: result.dataset, metrics: result.metrics,
  differencesVsStandard: result.differencesVsStandard, resources: result.resources }, null, 2));
