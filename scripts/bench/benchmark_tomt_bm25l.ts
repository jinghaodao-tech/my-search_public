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
const groupLimitArg = process.argv.find(arg => arg.startsWith('--group-limit='))?.slice('--group-limit='.length);
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--group-limit='));
const [datasetArg, databaseArg, outputArg] = args;
if (!datasetArg || !databaseArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_tomt_bm25l.ts <dataset-dir> <read-only-isolated-db> <new-output.json> [--group-limit=N]');
const groupLimit = groupLimitArg === undefined ? undefined : Number(groupLimitArg);
if (groupLimit !== undefined && (!Number.isSafeInteger(groupLimit) || groupLimit < 1)) throw new Error('group-limit must be a positive integer.');
const datasetDir = path.resolve(datasetArg); const databasePath = path.resolve(databaseArg); const outputPath = path.resolve(outputArg);
if (fs.existsSync(outputPath) || !outputPath.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('Output must be new and under artifacts/.');
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const readJsonl = <T>(file: string): T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as T);
const queryPath = path.join(datasetDir, 'development.jsonl'); const docsPath = path.join(datasetDir, 'documents.jsonl');
const provenance = JSON.parse(fs.readFileSync(path.join(datasetDir, 'provenance.json'), 'utf8')) as { dataset: string; domain: string; documents: number };
const groups = new Map<string, Query[]>();
for (const query of readJsonl<Query>(queryPath)) {
  if (query.split !== 'development' || query.gold_ids.length === 0) throw new Error('Expected labeled development-only queries.');
  groups.set(query.group_id, [...(groups.get(query.group_id) ?? []), query]);
}
const orderedGroups = [...groups.keys()].sort((a, b) => hash(a).localeCompare(hash(b)));
const selectedGroups = groupLimit === undefined ? orderedGroups : orderedGroups.slice(0, groupLimit);
const queries = selectedGroups.map(group =>
  groups.get(group)!.sort((a, b) => hash(`${group}\0${a.id}`).localeCompare(hash(`${group}\0${b.id}`)))[0]!);
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const docs = db.prepare('SELECT id,morphological_tokens_json,morphological_doc_length FROM cards WHERE archived=0 ORDER BY id').all() as Doc[];
const mapping = JSON.parse(fs.readFileSync(path.join(path.dirname(databasePath), 'mapping.json'), 'utf8')) as Record<string, string>;
const canonicalIdBySeededId = new Map(Object.entries(mapping).map(([canonicalId, seededId]) => [seededId, canonicalId]));
if (docs.length !== provenance.documents || canonicalIdBySeededId.size !== provenance.documents || docs.some(doc => !canonicalIdBySeededId.has(doc.id))) {
  throw new Error('Source corpus, isolated DB, and ID mapping are inconsistent.');
}
const documentLengths: number[] = [];
const postings = new Map<string, Array<{ index: number; tf: number }>>();
for (let index = 0; index < docs.length; index++) {
  const tokens = JSON.parse(docs[index]!.morphological_tokens_json || '[]') as string[];
  documentLengths.push(docs[index]!.morphological_doc_length || tokens.length);
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  for (const [term, count] of tf) {
    const rows = postings.get(term) ?? []; rows.push({ index, tf: count }); postings.set(term, rows);
  }
}
db.close();
const avgLength = documentLengths.reduce((sum, value) => sum + value, 0) / docs.length;
const rank = (terms: string[], method: 'standard' | 'bm25l') => {
  const scores = new Map<number, number>();
  for (const term of new Set(terms)) {
    const rows = postings.get(term); if (!rows?.length) continue;
    const idf = Math.log(1 + (docs.length - rows.length + 0.5) / (rows.length + 0.5));
    for (const row of rows) {
      const tf = row.tf; const lengthNorm = 1 - 0.75 + 0.75 * documentLengths[row.index]! / Math.max(avgLength, 1);
      const normalizedTf = tf / lengthNorm;
      const tfScore = method === 'standard'
        ? tf * 2.2 / (tf + 1.2 * lengthNorm)
        : (2.2 * (normalizedTf + 0.5)) / (1.2 + normalizedTf + 0.5);
      scores.set(row.index, (scores.get(row.index) ?? 0) + idf * tfScore);
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1] || canonicalIdBySeededId.get(docs[a[0]]!.id)!.localeCompare(canonicalIdBySeededId.get(docs[b[0]]!.id)!))
    .map(([index]) => canonicalIdBySeededId.get(docs[index]!.id)!);
};
const metric = (ids: string[], goldIds: string[]): Metric => {
  const gold = new Set(goldIds); const first = ids.findIndex(id => gold.has(id));
  const dcg = ids.slice(0, 10).reduce((sum, id, rank) => sum + (gold.has(id) ? 1 / Math.log2(rank + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(gold.size, 10) }, (_, rank) => 1 / Math.log2(rank + 2)).reduce((sum, value) => sum + value, 0);
  let found = 0; let ap = 0;
  for (let rank = 0; rank < Math.min(ids.length, 100); rank++) if (gold.has(ids[rank]!)) { found++; ap += found / (rank + 1); }
  return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0,
    recall100: gold.size ? ids.slice(0, 100).filter(id => gold.has(id)).length / gold.size : 0,
    mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0, map100: gold.size ? ap / gold.size : 0 };
};
const perQuery: Array<{ id: string; groupId: string; standard: Metric; bm25l: Metric }> = [];
const latency = { standard: [] as number[], bm25l: [] as number[] };
for (let index = 0; index < queries.length; index++) {
  const query = queries[index]!; const words = await purposeWords(query.query);
  const parsed = analyzeQuery(query.query, words.length ? words : query.query.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const terms = parsed.keywords.map(keyword => keyword.term);
  let started = performance.now(); const standardIds = rank(terms, 'standard'); latency.standard.push(performance.now() - started);
  started = performance.now(); const bm25lIds = rank(terms, 'bm25l'); latency.bm25l.push(performance.now() - started);
  perQuery.push({ id: query.id, groupId: query.group_id, standard: metric(standardIds, query.gold_ids), bm25l: metric(bm25lIds, query.gold_ids) });
  if ((index + 1) % 100 === 0 || index + 1 === queries.length) console.log(`evaluated ${index + 1}/${queries.length}`);
}
const metricNames = ['hit1', 'hit10', 'recall100', 'mrr10', 'ndcg10', 'map100'] as const;
const means = Object.fromEntries((['standard', 'bm25l'] as const).map(method => [method, Object.fromEntries(metricNames.map(key => [key,
  perQuery.reduce((sum, row) => sum + row[method][key], 0) / perQuery.length]))])) as Record<'standard' | 'bm25l', Metric>;
const pairedBootstrap = (key: typeof metricNames[number]) => {
  const grouped = new Map<string, number[]>();
  for (const row of perQuery) grouped.set(row.groupId, [...(grouped.get(row.groupId) ?? []), row.bm25l[key] - row.standard[key]]);
  const clusters = [...grouped.values()]; let seed = Number.parseInt(hash(`tomt-${provenance.domain}-bm25l-${key}`).slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = new Array<number>(20_000);
  for (let draw = 0; draw < draws.length; draw++) { let sum = 0; let count = 0;
    for (let i = 0; i < clusters.length; i++) { const sample = clusters[Math.floor(random() * clusters.length)]!; sum += sample.reduce((a, b) => a + b, 0); count += sample.length; }
    draws[draw] = sum / count;
  }
  draws.sort((a, b) => a - b);
  return { meanDifference: means.bm25l[key] - means.standard[key], clusterBootstrap95CI: [draws[499]!, draws[19_499]!], clusterCount: clusters.length };
};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const result = { dataset: { name: `${provenance.dataset} ${provenance.domain}`, split: groupLimit === undefined ? 'development; exploratory BM25L comparison' : `development; fixed SHA-256 sample of ${groupLimit} target groups`, documents: docs.length, queries: perQuery.length,
    groups: new Set(perQuery.map(row => row.groupId)).size, queryIdsSha256: hash(perQuery.map(row => row.id).sort().join('\n')),
    querySourceSha256: hash(fs.readFileSync(queryPath)), documentSourceSha256: hash(fs.readFileSync(docsPath)) },
  definitions: { standard: 'positive-smoothed BM25 k1=1.2,b=0.75', bm25l: 'BM25L normalized TF with k1=1.2,b=0.75,delta=0.5; same IDF, tokens, parser, candidates, and labels.', deltaFixedBeforeEvaluation: 0.5 },
  means, bm25lDifferenceVsStandard: Object.fromEntries(metricNames.map(key => [key, pairedBootstrap(key)])),
  resources: { databaseReadOnly: true, rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
    latencyMs: { standard: { p50: percentile(latency.standard, .5), p95: percentile(latency.standard, .95) }, bm25l: { p50: percentile(latency.bm25l, .5), p95: percentile(latency.bm25l, .95) } } }, perQuery };
fs.mkdirSync(path.dirname(outputPath), { recursive: true }); fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, means, ndcg10: result.bm25lDifferenceVsStandard.ndcg10 }, null, 2));
