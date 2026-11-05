import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';

type Query = { id: string; query: string; gold_ids: string[]; group_id: string; split: string };
type Doc = { id: string; morphological_tokens_json: string; morphological_doc_length: number };
type Metric = { hit1: number; hit10: number; recall100: number; mrr10: number; ndcg10: number; map100: number };
type Config = { k1: number; b: number; key: string };
const [datasetArg, databaseArg, outputArg] = process.argv.slice(2);
if (!datasetArg || !databaseArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_tomt_bm25_parameter_grid.ts <dataset-dir> <read-only-isolated-db> <new-output.json>');
const datasetDir = path.resolve(datasetArg);
const databasePath = path.resolve(databaseArg);
const outputPath = path.resolve(outputArg);
if (fs.existsSync(outputPath) || !outputPath.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('Output must be new and under artifacts/.');
const queryPath = path.join(datasetDir, 'development.jsonl');
const docsPath = path.join(datasetDir, 'documents.jsonl');
const readJsonl = <T>(file: string): T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as T);
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const sourceHash = (file: string) => hash(fs.readFileSync(file));
const allQueries = readJsonl<Query>(queryPath);
const groups = new Map<string, Query[]>();
for (const query of allQueries) {
  if (query.split !== 'development' || !query.gold_ids.length) throw new Error('Only labeled development queries are allowed.');
  groups.set(query.group_id, [...(groups.get(query.group_id) ?? []), query]);
}
const queries = [...groups.keys()].sort((a, b) => hash(a).localeCompare(hash(b))).map(group =>
  groups.get(group)!.sort((a, b) => hash(`${group}\0${a.id}`).localeCompare(hash(`${group}\0${b.id}`)))[0]!);
const configs: Config[] = [0.8, 1.2, 1.6].flatMap(k1 => [0.25, 0.5, 0.75, 1.0].map(b => ({ k1, b, key: `k1=${k1},b=${b}` })));
const baseline = configs.find(config => config.k1 === 1.2 && config.b === 0.75)!;
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
const docs = database.prepare('SELECT id,morphological_tokens_json,morphological_doc_length FROM cards WHERE archived=0 ORDER BY id').all() as Doc[];
const expectedDocs = JSON.parse(fs.readFileSync(path.join(datasetDir, 'provenance.json'), 'utf8')).documents as number;
if (docs.length !== expectedDocs) throw new Error(`Expected ${expectedDocs} docs; found ${docs.length}.`);
const documentMapping = JSON.parse(fs.readFileSync(path.join(path.dirname(databasePath), 'mapping.json'), 'utf8')) as Record<string, string>;
const canonicalIdBySeededId = new Map(Object.entries(documentMapping).map(([canonicalId, seededId]) => [seededId, canonicalId]));
if (canonicalIdBySeededId.size !== expectedDocs || docs.some(doc => !canonicalIdBySeededId.has(doc.id))) {
  throw new Error('Database document IDs do not exactly map to the source corpus IDs.');
}
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
const scoreAndRank = (terms: readonly string[], config: Config) => {
  const scores = new Map<number, number>();
  for (const term of new Set(terms)) {
    const rows = postings.get(term);
    if (!rows?.length) continue;
    const idf = Math.log(1 + (docs.length - rows.length + 0.5) / (rows.length + 0.5));
    for (const row of rows) {
      const norm = row.tf + config.k1 * (1 - config.b + config.b * lengths[row.index]! / Math.max(avgLength, 1));
      scores.set(row.index, (scores.get(row.index) ?? 0) + idf * ((row.tf * (config.k1 + 1)) / norm));
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1] || docs[a[0]]!.id.localeCompare(docs[b[0]]!.id))
    .map(([index]) => canonicalIdBySeededId.get(docs[index]!.id)!);
};
const metric = (ids: string[], goldIds: string[]): Metric => {
  const gold = new Set(goldIds);
  const first = ids.findIndex(id => gold.has(id));
  const dcg = ids.slice(0, 10).reduce((sum, id, rank) => sum + (gold.has(id) ? 1 / Math.log2(rank + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(gold.size, 10) }, (_, rank) => 1 / Math.log2(rank + 2)).reduce((sum, value) => sum + value, 0);
  let found = 0; let ap = 0;
  for (let rank = 0; rank < Math.min(ids.length, 100); rank++) if (gold.has(ids[rank]!)) { found++; ap += found / (rank + 1); }
  return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0,
    recall100: gold.size ? ids.slice(0, 100).filter(id => gold.has(id)).length / gold.size : 0,
    mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0, map100: gold.size ? ap / gold.size : 0 };
};
const perQuery: Array<{ id: string; groupId: string; metrics: Record<string, Metric> }> = [];
const timings = new Map(configs.map(config => [config.key, [] as number[]]));
for (let index = 0; index < queries.length; index++) {
  const query = queries[index]!;
  const words = await purposeWords(query.query);
  const parsed = analyzeQuery(query.query, words.length ? words : query.query.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const terms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
  const metrics: Record<string, Metric> = {};
  for (const config of configs) {
    const started = performance.now();
    metrics[config.key] = metric(scoreAndRank(terms, config), query.gold_ids);
    timings.get(config.key)!.push(performance.now() - started);
  }
  perQuery.push({ id: query.id, groupId: query.group_id, metrics });
  if ((index + 1) % 100 === 0 || index + 1 === queries.length) console.log(`evaluated ${index + 1}/${queries.length}`);
}
database.close();
const metricNames = ['hit1', 'hit10', 'recall100', 'mrr10', 'ndcg10', 'map100'] as const;
const means = Object.fromEntries(configs.map(config => [config.key, Object.fromEntries(metricNames.map(metric => [metric,
  perQuery.reduce((sum, row) => sum + row.metrics[config.key]![metric], 0) / perQuery.length]))]));
const meanMap = means as Record<string, Metric>;
const chosen = [...configs].sort((a, b) => meanMap[b.key]!.ndcg10 - meanMap[a.key]!.ndcg10
  || meanMap[b.key]!.mrr10 - meanMap[a.key]!.mrr10
  || (Math.abs(a.k1 - 1.2) + Math.abs(a.b - 0.75)) - (Math.abs(b.k1 - 1.2) + Math.abs(b.b - 0.75)))[0]!;
const pairedBootstrap = (metric: typeof metricNames[number]) => {
  const grouped = new Map<string, number[]>();
  for (const row of perQuery) grouped.set(row.groupId, [...(grouped.get(row.groupId) ?? []), row.metrics[chosen.key]![metric] - row.metrics[baseline.key]![metric]]);
  const clusters = [...grouped.values()];
  let seed = Number.parseInt(hash(`tomt-books-bm25-grid-${chosen.key}-${metric}`).slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = new Array<number>(20_000);
  for (let i = 0; i < draws.length; i++) {
    let total = 0; let count = 0;
    for (let j = 0; j < clusters.length; j++) { const c = clusters[Math.floor(random() * clusters.length)]!; total += c.reduce((sum, value) => sum + value, 0); count += c.length; }
    draws[i] = total / count;
  }
  draws.sort((a, b) => a - b);
  return { meanDifference: perQuery.reduce((sum, row) => sum + row.metrics[chosen.key]![metric] - row.metrics[baseline.key]![metric], 0) / perQuery.length,
    clusterBootstrap95CI: [draws[499]!, draws[19_499]!], clusterCount: clusters.length };
};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const result = {
  dataset: { name: 'Reddit-TOMT Books', split: 'development; exploratory grid', documents: docs.length, queries: perQuery.length, groups: new Set(perQuery.map(row => row.groupId)).size,
    queryIdsSha256: hash(perQuery.map(row => row.id).sort().join('\n')), querySourceSha256: sourceHash(queryPath), documentSourceSha256: sourceHash(docsPath),
    mappingSourceSha256: sourceHash(path.join(path.dirname(databasePath), 'mapping.json')) },
  definitions: { formula: 'Positive-smoothed IDF; score = IDF * tf*(k1+1)/(tf+k1*(1-b+b*docLength/avgLength)).',
    grid: configs.map(({ k1, b }) => ({ k1, b })), primaryMetric: 'nDCG@10', selection: 'max mean nDCG@10; then MRR@10; then closest to defaults k1=1.2,b=0.75.',
    baseline: baseline.key, selectedCandidate: chosen.key, developmentOnly: true },
  means, selectedCandidateDifferenceVsStandard: Object.fromEntries(metricNames.map(metric => [metric, pairedBootstrap(metric)])),
  resources: { databaseOpenedReadOnly: true, processRssBytes: process.memoryUsage().rss, processHeapUsedBytes: process.memoryUsage().heapUsed,
    latencyMsByMode: Object.fromEntries(configs.map(config => [config.key, { p50: percentile(timings.get(config.key)!, .5), p95: percentile(timings.get(config.key)!, .95) }])) },
  perQuery,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, dataset: result.dataset, selectedCandidate: chosen.key, means: result.means,
  selectedCandidateDifferenceVsStandard: result.selectedCandidateDifferenceVsStandard }, null, 2));
