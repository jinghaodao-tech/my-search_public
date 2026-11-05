import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { tokenizeMorphological } from '../../bm25_engine.js';

type CardRow = { id: string; title: string; body: string; tags_json: string; morphological_tokens_json: string; morphological_doc_length: number };
type QueryCase = { id: string; group_id: string; query: string; gold_ids: string[] };
type StandardRow = { qid: string; groupId: string; expected: string[]; query: string; parserTerms: string[]; top10: string[] };
type Document = { id: string; titleTf: Map<string, number>; bodyTf: Map<string, number>; allTf: Map<string, number>; titleLength: number; bodyLength: number; allLength: number };
type Metric = { hit1: number; hit10: number; mrr10: number; ndcg10: number; recall100: number };

const [dbArg, dataDirArg, standardPathArg, outputArg] = process.argv.slice(2);
if (!dbArg || !dataDirArg || !standardPathArg || !outputArg) {
  throw new Error('Usage: npx tsx scripts/bench/benchmark_article_bm25f_transfer.ts <isolated.sqlite> <api_dataset-dir> <standard-bm25.json> <output.json>');
}
const dbPath = path.resolve(dbArg);
const dataDir = path.resolve(dataDirArg);
const standardPath = path.resolve(standardPathArg);
const outputPath = path.resolve(outputArg);
if (!fs.existsSync(dbPath) || !fs.existsSync(standardPath)) throw new Error('Missing isolated DB or standard result JSON');
if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite ${outputPath}`);

const standard = JSON.parse(fs.readFileSync(standardPath, 'utf8')) as { stage: string; documentCount: number; results: StandardRow[] };
const queryPath = path.join(dataDir, `${standard.stage}.jsonl`);
const queryCases = fs.readFileSync(queryPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as QueryCase);
const qrelById = new Map(queryCases.map(row => [row.id, row]));
if (queryCases.length !== standard.results.length) throw new Error(`Query count mismatch ${queryCases.length} != ${standard.results.length}`);
for (const result of standard.results) {
  const query = qrelById.get(result.qid);
  if (!query || query.group_id !== result.groupId || query.query !== result.query || JSON.stringify(query.gold_ids) !== JSON.stringify(result.expected)) {
    throw new Error(`Query/qrel mismatch for ${result.qid}`);
  }
  if (!result.parserTerms.length || !result.top10) throw new Error(`Missing parsed terms or standard Top10 for ${result.qid}`);
}

const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = sqlite.prepare(`SELECT id,title,body,tags_json,morphological_tokens_json,morphological_doc_length FROM cards WHERE archived=0 ORDER BY id`).all() as CardRow[];
sqlite.close();
if (rows.length !== standard.documentCount) throw new Error(`Document count mismatch ${rows.length} != ${standard.documentCount}`);

const count = (tokens: string[]) => {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
};
const documents: Document[] = [];
for (let index = 0; index < rows.length; index += 1) {
  const row = rows[index]!;
  const titleTokens = await tokenizeMorphological(row.title);
  const tags = JSON.parse(row.tags_json || '[]') as string[];
  const bodyTokens = await tokenizeMorphological(`${row.body} ${tags.join(' ')}`);
  const allTokens = JSON.parse(row.morphological_tokens_json || '[]') as string[];
  documents.push({ id: row.id.replace(/^benchmark-/, ''), titleTf: count(titleTokens), bodyTf: count(bodyTokens), allTf: count(allTokens),
    titleLength: titleTokens.length, bodyLength: bodyTokens.length, allLength: row.morphological_doc_length || allTokens.length });
  if ((index + 1) % 500 === 0 || index + 1 === rows.length) console.error(`tokenized fields ${index + 1}/${rows.length}`);
}

const docCount = documents.length;
const df = new Map<string, number>();
let allLengthSum = 0;
let titleLengthSum = 0;
let bodyLengthSum = 0;
for (const doc of documents) {
  for (const term of doc.allTf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  allLengthSum += doc.allLength;
  titleLengthSum += doc.titleLength;
  bodyLengthSum += doc.bodyLength;
}
const averageAllLength = allLengthSum / docCount;
const averageTitleLength = titleLengthSum / docCount;
const averageBodyLength = bodyLengthSum / docCount;
const k1 = 1.2;
const b = 0.75;
const titleWeight = 2;
const titleB = 0.3;
const bodyB = 0.75;
const idf = (term: string) => {
  const frequency = df.get(term) ?? 0;
  return Math.log(1 + (docCount - frequency + 0.5) / (frequency + 0.5));
};

const metric = (ranking: string[], expectedIds: string[]): Metric => {
  const expected = new Set(expectedIds);
  const hitPositions = ranking.slice(0, 10).flatMap((id, index) => expected.has(id) ? [index + 1] : []);
  const first = hitPositions[0];
  const dcg = hitPositions.reduce((sum, rank) => sum + 1 / Math.log2(rank + 1), 0);
  const ideal = Array.from({ length: Math.min(expected.size, 10) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
  return {
    hit1: Number(ranking[0] !== undefined && expected.has(ranking[0])),
    hit10: Number(first !== undefined),
    mrr10: first === undefined ? 0 : 1 / first,
    ndcg10: ideal === 0 ? 0 : dcg / ideal,
    recall100: ranking.slice(0, 100).filter(id => expected.has(id)).length / Math.max(expected.size, 1),
  };
};

const timings: Record<'standard' | 'bm25f', number[]> = { standard: [], bm25f: [] };
const standardAgreement: Array<{ qid: string; expectedTop10: string[]; computedTop10: string[]; exact: boolean }> = [];
const perQuery: Array<{ qid: string; groupId: string; expected: string[]; standard: Metric; bm25f: Metric; standardTop10: string[]; bm25fTop10: string[] }> = [];
for (const query of standard.results) {
  const terms = [...new Set(query.parserTerms)];
  const expectedIds = query.expected;

  let start = performance.now();
  const standardRanked = documents.map(doc => {
    let score = 0;
    for (const term of terms) {
      const tf = doc.allTf.get(term) ?? 0;
      if (!tf) continue;
      const denom = tf + k1 * (1 - b + b * doc.allLength / Math.max(averageAllLength, 1));
      score += idf(term) * (tf * (k1 + 1)) / denom;
    }
    return { id: doc.id, score };
  }).filter(row => row.score > 0).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).map(row => row.id);
  timings.standard.push(performance.now() - start);

  start = performance.now();
  const bm25fRanked = documents.map(doc => {
    let score = 0;
    for (const term of terms) {
      const titleTf = doc.titleTf.get(term) ?? 0;
      const bodyTf = doc.bodyTf.get(term) ?? 0;
      const tfNorm = titleWeight * titleTf / (1 - titleB + titleB * doc.titleLength / Math.max(averageTitleLength, 1))
        + bodyTf / (1 - bodyB + bodyB * doc.bodyLength / Math.max(averageBodyLength, 1));
      if (!tfNorm) continue;
      score += idf(term) * (tfNorm * (k1 + 1)) / (tfNorm + k1);
    }
    return { id: doc.id, score };
  }).filter(row => row.score > 0).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).map(row => row.id);
  timings.bm25f.push(performance.now() - start);

  const computedTop10 = standardRanked.slice(0, 10);
  const exact = JSON.stringify(computedTop10) === JSON.stringify(query.top10);
  standardAgreement.push({ qid: query.qid, expectedTop10: query.top10, computedTop10, exact });
  perQuery.push({ qid: query.qid, groupId: query.groupId, expected: expectedIds,
    standard: metric(standardRanked, expectedIds), bm25f: metric(bm25fRanked, expectedIds),
    standardTop10: computedTop10, bm25fTop10: bm25fRanked.slice(0, 10) });
}

const parents = new Map(perQuery.map(row => [row.qid, row.qid]));
const find = (id: string): string => {
  const p = parents.get(id);
  if (!p) throw new Error(`Unknown query ${id}`);
  if (p === id) return id;
  const root = find(p);
  parents.set(id, root);
  return root;
};
const union = (left: string, right: string) => parents.set(find(left), find(right));
const firstByGroup = new Map<string, string>();
const firstByTarget = new Map<string, string>();
for (const row of perQuery) {
  const groupPrevious = firstByGroup.get(row.groupId);
  if (groupPrevious) union(row.qid, groupPrevious); else firstByGroup.set(row.groupId, row.qid);
  for (const target of row.expected) {
    const targetPrevious = firstByTarget.get(target);
    if (targetPrevious) union(row.qid, targetPrevious); else firstByTarget.set(target, row.qid);
  }
}
const clusterMap = new Map<string, typeof perQuery>();
for (const row of perQuery) clusterMap.set(find(row.qid), [...(clusterMap.get(find(row.qid)) ?? []), row]);
const clusters = [...clusterMap.values()];
const metricNames = ['hit1', 'hit10', 'mrr10', 'ndcg10', 'recall100'] as const;
const mean = (field: 'standard' | 'bm25f', key: typeof metricNames[number]) => perQuery.reduce((sum, row) => sum + row[field][key], 0) / perQuery.length;
const observed = Object.fromEntries(metricNames.map(key => [key, { standard: mean('standard', key), bm25f: mean('bm25f', key), difference: mean('bm25f', key) - mean('standard', key) }]));

const replicates = 20_000;
let randomState = Number.parseInt(crypto.createHash('sha256').update(`article-bm25f-transfer|${standard.stage}`).digest('hex').slice(0, 8), 16) >>> 0;
const random = () => { randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0; return randomState / 0x1_0000_0000; };
const bootstrap = Object.fromEntries(metricNames.map(key => [key, [] as number[]])) as Record<typeof metricNames[number], number[]>;
for (let replicate = 0; replicate < replicates; replicate += 1) {
  const sums = Object.fromEntries(metricNames.map(key => [key, 0])) as Record<typeof metricNames[number], number>;
  let queryCount = 0;
  for (let draw = 0; draw < clusters.length; draw += 1) {
    const cluster = clusters[Math.floor(random() * clusters.length)]!;
    queryCount += cluster.length;
    for (const key of metricNames) sums[key] += cluster.reduce((sum, row) => sum + row.bm25f[key] - row.standard[key], 0);
  }
  for (const key of metricNames) bootstrap[key].push(sums[key] / queryCount);
}
const interval = Object.fromEntries(metricNames.map(key => {
  bootstrap[key].sort((left, right) => left - right);
  return [key, [bootstrap[key][Math.floor(0.025 * replicates)]!, bootstrap[key][Math.floor(0.975 * replicates)]!]];
}));
const percentile = (values: number[], p: number) => [...values].sort((left, right) => left - right)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const output = {
  generatedAt: new Date().toISOString(),
  dataset: { name: 'Japanese public technical article metadata', stage: standard.stage, documents: docCount, queries: perQuery.length, split: 'fixed source-provided split',
    queryWarning: 'Queries are self-derived from title/tags; not natural user search sessions.' },
  definitions: {
    standard: 'stored morphology-token BM25; k1=1.2,b=0.75, positive-smoothed IDF; all ranking documents scored.',
    bm25f: 'fixed transfer from prior Books development: titleWeight=2, title b=0.3, body+tags weight=1 and b=0.75, k1=1.2; shared IDF from stored concatenated morphology tokens.',
    queryTerms: 'exact parserTerms from the matched standard-BM25 benchmark result; query text, expected IDs and group IDs checked against the source split.',
    caveat: 'The standard implementation is independently recomputed and must exactly match the stored standard Top10 before this comparison can be used.',
  },
  standardAgreement: { exactTop10Queries: standardAgreement.filter(row => row.exact).length, totalQueries: standardAgreement.length, mismatches: standardAgreement.filter(row => !row.exact) },
  rankingParameters: { k1, b, titleWeight, titleB, bodyWeight: 1, bodyB, averageAllLength, averageTitleLength, averageBodyLength },
  metrics: observed,
  differenceCi95: interval,
  latencyMs: { standard: { p50: percentile(timings.standard, .5), p95: percentile(timings.standard, .95) }, bm25f: { p50: percentile(timings.bm25f, .5), p95: percentile(timings.bm25f, .95) }, scope: 'in-process full-corpus scoring and sorting; field tokenization and common preparation excluded' },
  bootstrap: { unit: 'connected components by source group ID and shared expected targets', clusters: clusters.length, replicates, seed: `sha256(article-bm25f-transfer|${standard.stage}) first 32 bits`, interval: 'paired percentile cluster bootstrap 95%, exploratory transfer' },
  inputs: [dbPath, queryPath, standardPath].map(file => ({ path: path.relative(process.cwd(), file), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
  perQuery,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: outputPath, standardAgreement: output.standardAgreement.exactTop10Queries, queries: perQuery.length, clusters: clusters.length, metrics: observed, differenceCi95: interval, latencyMs: output.latencyMs }, null, 2));
