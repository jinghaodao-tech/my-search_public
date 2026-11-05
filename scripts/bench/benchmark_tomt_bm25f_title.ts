import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { tokenizeMorphological } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';

type Query = { id: string; query: string; gold_ids: string[]; group_id: string; split: string };
type SourceDoc = { id: string; title: string; body: string };
type DbDoc = { id: string; title: string; body: string; morphological_tokens_json: string };
type FieldDoc = { id: string; titleTokens: string[]; bodyTokens: string[]; allTokens: string[]; titleLength: number; bodyLength: number };
type Metric = { hit1: number; hit10: number; recall100: number; mrr10: number; ndcg10: number; map100: number };
const fixedWeightArg = process.argv.find(arg => arg.startsWith('--fixed-title-weight='))?.slice('--fixed-title-weight='.length);
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--fixed-title-weight='));
const [datasetArg, databaseArg, outputArg] = args;
if (!datasetArg || !databaseArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_tomt_bm25f_title.ts <dataset-dir> <read-only-isolated-db> <new-output.json> [--fixed-title-weight=1|1.5|2]');
if (fixedWeightArg !== undefined && !['1', '1.5', '2'].includes(fixedWeightArg)) throw new Error('Fixed title weight must be 1, 1.5, or 2.');
const datasetDir = path.resolve(datasetArg);
const databasePath = path.resolve(databaseArg);
const outputPath = path.resolve(outputArg);
if (fs.existsSync(outputPath) || !outputPath.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('Output must be new and under artifacts/.');
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const hashFile = (file: string) => hash(fs.readFileSync(file));
const readJsonl = <T>(file: string): T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as T);
const queryPath = path.join(datasetDir, 'development.jsonl');
const docsPath = path.join(datasetDir, 'documents.jsonl');
const provenancePath = path.join(datasetDir, 'provenance.json');
const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as { dataset: string; domain: string; documents: number };
const allQueries = readJsonl<Query>(queryPath);
const grouped = new Map<string, Query[]>();
for (const query of allQueries) {
  if (query.split !== 'development' || !query.gold_ids.length) throw new Error('Only labeled development queries are allowed.');
  grouped.set(query.group_id, [...(grouped.get(query.group_id) ?? []), query]);
}
const queries = [...grouped.keys()].sort((a, b) => hash(a).localeCompare(hash(b))).map(group =>
  grouped.get(group)!.sort((a, b) => hash(`${group}\0${a.id}`).localeCompare(hash(`${group}\0${b.id}`)))[0]!);
const sourceDocs = readJsonl<SourceDoc>(docsPath);
if (sourceDocs.length !== provenance.documents) throw new Error('Document JSONL count does not match source provenance.');
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const storedDocs = db.prepare('SELECT id,title,body,morphological_tokens_json FROM cards WHERE archived=0 ORDER BY id').all() as DbDoc[];
const mappingPath = path.join(path.dirname(databasePath), 'mapping.json');
const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) as Record<string, string>;
const databaseIdByCanonicalId = new Map(Object.entries(mapping));
const storedById = new Map(storedDocs.map(doc => [doc.id, doc]));
if (storedDocs.length !== sourceDocs.length || storedDocs.length !== Object.keys(mapping).length) throw new Error('Source, DB, and mapping document counts differ.');
const docs: FieldDoc[] = [];
for (const source of sourceDocs) {
  const dbId = databaseIdByCanonicalId.get(source.id);
  const stored = dbId ? storedById.get(dbId) : undefined;
  if (!stored || stored.title !== source.title || stored.body !== source.body) throw new Error(`Source and isolated DB differ for ${source.id}.`);
  const titleTokens = await tokenizeMorphological(source.title);
  const allTokens = JSON.parse(stored.morphological_tokens_json || '[]') as string[];
  const remainingTitleTf = new Map<string, number>();
  for (const token of titleTokens) remainingTitleTf.set(token, (remainingTitleTf.get(token) ?? 0) + 1);
  const bodyTokens: string[] = [];
  for (const token of allTokens) {
    const titleCount = remainingTitleTf.get(token) ?? 0;
    if (titleCount > 0) remainingTitleTf.set(token, titleCount - 1);
    else bodyTokens.push(token);
  }
  if ([...remainingTitleTf.values()].some(count => count !== 0)) throw new Error(`Title tokens are not present in saved full-field tokens for ${source.id}.`);
  docs.push({ id: source.id, titleTokens, bodyTokens, allTokens, titleLength: titleTokens.length, bodyLength: bodyTokens.length });
  if (docs.length % 250 === 0 || docs.length === sourceDocs.length) console.log(`verified and tokenized ${docs.length}/${sourceDocs.length} documents`);
}
db.close();

const titleAverage = docs.reduce((sum, doc) => sum + doc.titleLength, 0) / docs.length;
const bodyAverage = docs.reduce((sum, doc) => sum + doc.bodyLength, 0) / docs.length;
const allAverage = docs.reduce((sum, doc) => sum + doc.allTokens.length, 0) / docs.length;
type Posting = { index: number; titleTf: number; bodyTf: number; allTf: number };
const postings = new Map<string, Posting[]>();
for (let index = 0; index < docs.length; index++) {
  const doc = docs[index]!;
  const titleTf = new Map<string, number>(); const bodyTf = new Map<string, number>(); const allTf = new Map<string, number>();
  for (const term of doc.titleTokens) titleTf.set(term, (titleTf.get(term) ?? 0) + 1);
  for (const term of doc.bodyTokens) bodyTf.set(term, (bodyTf.get(term) ?? 0) + 1);
  for (const term of doc.allTokens) allTf.set(term, (allTf.get(term) ?? 0) + 1);
  for (const term of new Set([...titleTf.keys(), ...bodyTf.keys(), ...allTf.keys()])) {
    const rows = postings.get(term) ?? [];
    rows.push({ index, titleTf: titleTf.get(term) ?? 0, bodyTf: bodyTf.get(term) ?? 0, allTf: allTf.get(term) ?? 0 });
    postings.set(term, rows);
  }
}
const titleWeights: number[] = fixedWeightArg === undefined ? [1, 1.5, 2] : [Number(fixedWeightArg)];
const names = ['standard', ...titleWeights.map(weight => `bm25f-title-${weight}`)] as const;
type Mode = typeof names[number];
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
const rank = (terms: string[], mode: Mode) => {
  const scores = new Map<number, number>();
  for (const term of new Set(terms)) {
    const rows = postings.get(term);
    if (!rows?.length) continue;
    const idf = Math.log(1 + (docs.length - rows.length + 0.5) / (rows.length + 0.5));
    for (const row of rows) {
      let contribution: number;
      if (mode === 'standard') {
        const length = docs[row.index]!.allTokens.length;
        const norm = row.allTf + 1.2 * (1 - 0.75 + 0.75 * length / Math.max(allAverage, 1));
        contribution = idf * row.allTf * 2.2 / norm;
      } else {
        const weight = Number(mode.slice('bm25f-title-'.length));
        const titleTfNorm = row.titleTf / Math.max(1 - 0.3 + 0.3 * docs[row.index]!.titleLength / Math.max(titleAverage, 1), 1e-9);
        const bodyTfNorm = row.bodyTf / Math.max(1 - 0.75 + 0.75 * docs[row.index]!.bodyLength / Math.max(bodyAverage, 1), 1e-9);
        const combinedTf = weight * titleTfNorm + bodyTfNorm;
        contribution = idf * combinedTf * 2.2 / (combinedTf + 1.2);
      }
      scores.set(row.index, (scores.get(row.index) ?? 0) + contribution);
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1] || docs[a[0]]!.id.localeCompare(docs[b[0]]!.id)).map(([index]) => docs[index]!.id);
};
const perQuery: Array<{ id: string; groupId: string; metrics: Record<Mode, Metric> }> = [];
const timings = new Map(names.map(name => [name, [] as number[]]));
for (let index = 0; index < queries.length; index++) {
  const query = queries[index]!;
  const words = await purposeWords(query.query);
  const parsed = analyzeQuery(query.query, words.length ? words : query.query.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const terms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
  const metrics = {} as Record<Mode, Metric>;
  for (const mode of names) {
    const started = performance.now();
    metrics[mode] = metric(rank(terms, mode), query.gold_ids);
    timings.get(mode)!.push(performance.now() - started);
  }
  perQuery.push({ id: query.id, groupId: query.group_id, metrics });
  if ((index + 1) % 100 === 0 || index + 1 === queries.length) console.log(`evaluated ${index + 1}/${queries.length}`);
}
const metricNames = ['hit1', 'hit10', 'recall100', 'mrr10', 'ndcg10', 'map100'] as const;
const means = Object.fromEntries(names.map(name => [name, Object.fromEntries(metricNames.map(key => [key,
  perQuery.reduce((sum, row) => sum + row.metrics[name][key], 0) / perQuery.length]))]));
const meanMap = means as Record<Mode, Metric>;
const selected = fixedWeightArg === undefined
  ? [...titleWeights].sort((a, b) => meanMap[`bm25f-title-${b}`].ndcg10 - meanMap[`bm25f-title-${a}`].ndcg10
    || meanMap[`bm25f-title-${b}`].mrr10 - meanMap[`bm25f-title-${a}`].mrr10)[0]!
  : titleWeights[0]!;
const selectedMode = `bm25f-title-${selected}` as Mode;
const bootstrap = (key: typeof metricNames[number]) => {
  const byGroup = new Map<string, number[]>();
  for (const row of perQuery) byGroup.set(row.groupId, [...(byGroup.get(row.groupId) ?? []), row.metrics[selectedMode][key] - row.metrics.standard[key]]);
  const clusters = [...byGroup.values()];
  let seed = Number.parseInt(hash(`tomt-books-bm25f-title-${selected}-${key}`).slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = new Array<number>(20_000);
  for (let draw = 0; draw < draws.length; draw++) {
    let sum = 0; let count = 0;
    for (let group = 0; group < clusters.length; group++) { const sample = clusters[Math.floor(random() * clusters.length)]!; sum += sample.reduce((total, value) => total + value, 0); count += sample.length; }
    draws[draw] = sum / count;
  }
  draws.sort((a, b) => a - b);
  return { meanDifference: meanMap[selectedMode][key] - meanMap.standard[key], clusterBootstrap95CI: [draws[499]!, draws[19_499]!], clusterCount: clusters.length };
};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const result = {
  dataset: { name: `${provenance.dataset} ${provenance.domain}`, split: fixedWeightArg === undefined ? 'development; BM25F field-weight exploration' : 'development; fixed BM25F transfer evaluation', documents: docs.length, queries: perQuery.length,
    groups: new Set(perQuery.map(row => row.groupId)).size, queryIdsSha256: hash(perQuery.map(row => row.id).sort().join('\n')),
    querySourceSha256: hashFile(queryPath), documentSourceSha256: hashFile(docsPath) },
  definitions: { standard: 'positive-smoothed BM25, k1=1.2,b=0.75, concatenated morphology tokens. BM25F uses the same morphology tokens, query parser, IDF, and candidates; title b=0.3, body b=0.75, k1=1.2, bodyWeight=1.0.',
    titleWeightsEvaluated: titleWeights, selection: fixedWeightArg === undefined ? 'development nDCG@10; tie by MRR@10' : `fixed preselected titleWeight=${selected}; no candidate selection on this dataset`,
    selectedCandidate: selectedMode, developmentOnly: true,
    fieldTokenAllocation: 'Saved app morphology tokens provide the exact concatenated field term frequencies. Titles are re-tokenized with the app tokenizer; their term counts must be a subset of the saved sequence. Body term frequencies are the multiset difference.',
    preregisteredContinuationRule: 'selected nDCG@10 delta >= 0.005 and cluster bootstrap 95% CI lower bound > 0' },
  means, selectedCandidateDifferenceVsStandard: Object.fromEntries(metricNames.map(key => [key, bootstrap(key)])),
  resources: { isolatedDatabaseReadOnly: true, processRssBytes: process.memoryUsage().rss, processHeapUsedBytes: process.memoryUsage().heapUsed,
    latencyMsByMode: Object.fromEntries(names.map(name => [name, { p50: percentile(timings.get(name)!, .5), p95: percentile(timings.get(name)!, .95) }])) }, perQuery,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, selectedCandidate: selectedMode, means: result.means,
  selectedCandidateDifferenceVsStandard: result.selectedCandidateDifferenceVsStandard }, null, 2));
