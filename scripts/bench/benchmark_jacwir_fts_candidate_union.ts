import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { tokenizeMorphological } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { scoreWeightedBm25 } from './bm25_rm3.js';

type Query = { _id: string; text: string };
type Judgment = { query_id: string; doc_id: string; relevance: number };
type IndexedDocument = { id: string; length: number };
type Metric = { hit1: number; hit10: number; mrr10: number; ndcg10: number; map100: number; recall100: number };
type Method = 'standard-bm25' | 'fts5-morphology' | 'bm25-fts5-union-rrf';
type PerQuery = {
  queryId: string;
  positiveDocumentIds: string[];
  groupId: string;
  tokenCount: number;
  candidates: { bm25Top100: number; fts5Top100: number; union: number };
  candidateRecall: { bm25Top100: number; fts5Top100: number; union: number };
  metrics: Record<Method, Metric>;
  latencyMs: Record<Method, number>;
};

const [datasetArg, bm25IndexArg, ftsIndexArg, outputArg] = process.argv.slice(2);
if (!datasetArg || !bm25IndexArg || !ftsIndexArg || !outputArg) {
  throw new Error('Usage: tsx scripts/bench/benchmark_jacwir_fts_candidate_union.ts <query-dir> <bm25-index.sqlite> <fts-index.sqlite> <new-output.json>');
}
const datasetDir = path.resolve(datasetArg);
const bm25IndexPath = path.resolve(bm25IndexArg);
const ftsIndexPath = path.resolve(ftsIndexArg);
const outputPath = path.resolve(outputArg);
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) {
  throw new Error('Output must be a new file under an artifacts/ directory.');
}
const queryPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels.jsonl');
const manifestPath = path.join(datasetDir, 'manifest.json');
for (const file of [queryPath, qrelsPath, manifestPath, bm25IndexPath, ftsIndexPath]) {
  if (!fs.existsSync(file)) throw new Error(`Missing input: ${file}`);
}

const sha = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = async (file: string) => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
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
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
  queryCount: number;
  positiveJudgmentCount: number;
  querySelection: string;
  warning: string;
};
const queryTexts = new Map<string, string>();
for await (const query of readJsonl<Query>(queryPath)) {
  if (!query._id || !query.text || sha(query.text) !== query._id || queryTexts.has(query._id)) {
    throw new Error(`Invalid, duplicate, or non-hash query: ${query._id}`);
  }
  queryTexts.set(query._id, query.text);
}
if (queryTexts.size !== manifest.queryCount) throw new Error(`Query count mismatch: ${queryTexts.size} != ${manifest.queryCount}`);
const positivesByQuery = new Map<string, Set<string>>();
for await (const judgment of readJsonl<Judgment>(qrelsPath)) {
  if (!queryTexts.has(judgment.query_id) || !judgment.doc_id || judgment.relevance <= 0) {
    throw new Error(`Invalid positive qrel: ${JSON.stringify(judgment)}`);
  }
  const positives = positivesByQuery.get(judgment.query_id) ?? new Set<string>();
  positives.add(judgment.doc_id);
  positivesByQuery.set(judgment.query_id, positives);
}
if ([...queryTexts.keys()].some(id => !positivesByQuery.has(id))) throw new Error('Selected query without a positive qrel.');
const positiveJudgmentCount = [...positivesByQuery.values()].reduce((sum, positives) => sum + positives.size, 0);
if (positiveJudgmentCount !== manifest.positiveJudgmentCount) throw new Error('Positive qrel count differs from manifest.');

const parent = new Map<string, string>();
const find = (id: string): string => {
  const current = parent.get(id);
  if (!current) { parent.set(id, id); return id; }
  if (current === id) return id;
  const root = find(current);
  parent.set(id, root);
  return root;
};
for (const [queryId, positives] of positivesByQuery) {
  for (const docId of positives) {
    const queryRoot = find(`q:${queryId}`);
    const docRoot = find(`d:${docId}`);
    if (queryRoot !== docRoot) parent.set(docRoot, queryRoot);
  }
}

const bm25Db = new Database(bm25IndexPath, { readonly: true, fileMustExist: true });
const ftsDb = new Database(ftsIndexPath, { readonly: true, fileMustExist: true });
const docs = bm25Db.prepare('SELECT id,length FROM documents ORDER BY id').all() as IndexedDocument[];
if (docs.length !== 513107) throw new Error(`Expected 513,107 corpus documents; got ${docs.length}.`);
const ftsCount = Number((ftsDb.prepare('SELECT COUNT(*) AS count FROM morphology_fts').get() as { count: number }).count);
if (ftsCount !== docs.length) throw new Error(`FTS5 document count mismatch: ${ftsCount} != ${docs.length}.`);
const ftsDocumentIds = new Set<string>();
for (const row of ftsDb.prepare('SELECT id FROM morphology_fts').iterate() as Iterable<{ id: string }>) {
  if (ftsDocumentIds.has(row.id)) throw new Error(`Duplicate FTS5 document ID: ${row.id}`);
  ftsDocumentIds.add(row.id);
}
const bm25IdsMissingFromFts5 = docs.reduce((count, row) => count + Number(!ftsDocumentIds.has(row.id)), 0);
const fts5IdsMissingFromBm25 = ftsDocumentIds.size - docs.length + bm25IdsMissingFromFts5;
if (ftsDocumentIds.size !== docs.length || bm25IdsMissingFromFts5 || fts5IdsMissingFromBm25) {
  throw new Error(`BM25/FTS5 ID mismatch: docs=${docs.length}, fts=${ftsDocumentIds.size}, bm25Missing=${bm25IdsMissingFromFts5}, ftsMissing=${fts5IdsMissingFromBm25}.`);
}

const docIndex = new Map(docs.map((row, index) => [row.id, index]));
const lengths = docs.map(row => row.length);
const averageLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
const absentPositives = [...new Set([...positivesByQuery.values()].flatMap(set => [...set]))]
  .filter(id => !docIndex.has(id));
if (absentPositives.length) throw new Error(`Positive qrels absent from BM25 corpus: ${absentPositives.length}.`);
const postingCache = new Map<string, Array<{ docIndex: number; tf: number }>>();
const getPostings = (terms: readonly string[]) => {
  const unique = [...new Set(terms)];
  const missing = unique.filter(term => !postingCache.has(term));
  for (let offset = 0; offset < missing.length; offset += 300) {
    const batch = missing.slice(offset, offset + 300);
    const rows = bm25Db.prepare(`SELECT term,doc_id,tf FROM postings WHERE term IN (${batch.map(() => '?').join(',')}) ORDER BY term,doc_id`)
      .all(...batch) as Array<{ term: string; doc_id: string; tf: number }>;
    const grouped = new Map<string, Array<{ docIndex: number; tf: number }>>();
    for (const row of rows) {
      const index = docIndex.get(row.doc_id);
      if (index === undefined) throw new Error(`Posting references unknown document: ${row.doc_id}`);
      const list = grouped.get(row.term) ?? [];
      list.push({ docIndex: index, tf: row.tf });
      grouped.set(row.term, list);
    }
    for (const term of batch) postingCache.set(term, grouped.get(term) ?? []);
  }
  return new Map(unique.map(term => [term, postingCache.get(term) ?? []]));
};

const encodeToken = (token: string) => `m${Buffer.from(token, 'utf8').toString('hex')}`;
const ftsExpression = (tokens: readonly string[]) => [...new Set(tokens)]
  .map(token => `"${encodeToken(token).replace(/"/gu, '""')}"`).join(' OR ');
const ftsTop100 = ftsDb.prepare(`SELECT id FROM morphology_fts
  WHERE morphology_fts MATCH ? ORDER BY bm25(morphology_fts),id LIMIT 100`);
const ftsTokenExists = ftsDb.prepare('SELECT 1 FROM morphology_fts WHERE morphology_fts MATCH ? AND id=? LIMIT 1');
const queryRows = [...queryTexts].map(([id, text]) => ({ id, text, positives: positivesByQuery.get(id)! }));
const outputRows: PerQuery[] = [];
const latencies: Record<Method, number[]> = {
  'standard-bm25': [], 'fts5-morphology': [], 'bm25-fts5-union-rrf': [],
};
const candidateHits = { bm25Top100: 0, fts5Top100: 0, union: 0, totalPositiveJudgments: 0 };
const missingPositiveIds = new Set<string>();
const maxHeapStart = process.memoryUsage().heapUsed;
let maxHeap = maxHeapStart;
let maxRss = process.memoryUsage().rss;

const measure = (ranking: readonly string[], positives: ReadonlySet<string>): Metric => {
  const first = ranking.findIndex(id => positives.has(id));
  const top10 = ranking.slice(0, 10);
  const dcg = top10.reduce((sum, id, index) => sum + (positives.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const idealCount = Math.min(positives.size, 10);
  const ideal = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
  let found = 0;
  let precisionSum = 0;
  for (const [index, id] of ranking.slice(0, 100).entries()) {
    if (positives.has(id)) { found += 1; precisionSum += found / (index + 1); }
  }
  return {
    hit1: first === 0 ? 1 : 0,
    hit10: first >= 0 && first < 10 ? 1 : 0,
    mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0,
    ndcg10: ideal ? dcg / ideal : 0,
    map100: positives.size ? precisionSum / positives.size : 0,
    recall100: positives.size ? found / positives.size : 0,
  };
};

for (let queryNumber = 0; queryNumber < queryRows.length; queryNumber += 1) {
  const query = queryRows[queryNumber]!;
  const parseStarted = performance.now();
  const words = await purposeWords(query.text);
  const parsed = analyzeQuery(query.text, words.length ? words : query.text.split(/\s+/u).filter(Boolean),
    term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const tokens = [...new Set(await tokenizeMorphological([...new Set(parsed.keywords.map(item => item.term))].join(' ')))];
  const parseMs = performance.now() - parseStarted;

  const bm25Started = performance.now();
  const postings = getPostings(tokens);
  const bm25Rows = scoreWeightedBm25(new Map(tokens.map(token => [token, 1])), docs.length, averageLength,
    lengths, postings, 1.2, 0.75, 100);
  const bm25Ids = bm25Rows.map(row => docs[row.docIndex]!.id);
  const bm25Ms = parseMs + performance.now() - bm25Started;

  const ftsStarted = performance.now();
  const expression = ftsExpression(tokens);
  const ftsIds = expression
    ? (ftsTop100.all(expression) as Array<{ id: string }>).map(row => row.id)
    : [];
  const ftsMs = parseMs + performance.now() - ftsStarted;

  const rrf = new Map<string, number>();
  for (const [rankIndex, id] of bm25Ids.entries()) rrf.set(id, (rrf.get(id) ?? 0) + 1 / (60 + rankIndex + 1));
  for (const [rankIndex, id] of ftsIds.entries()) rrf.set(id, (rrf.get(id) ?? 0) + 1 / (60 + rankIndex + 1));
  const unionIds = [...rrf].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 100).map(([id]) => id);
  const unionMs = parseMs + performance.now() - bm25Started;

  const bm25Set = new Set(bm25Ids);
  const ftsSet = new Set(ftsIds);
  const unionSet = new Set([...bm25Set, ...ftsSet]);
  for (const id of query.positives) {
    if (!docIndex.has(id)) missingPositiveIds.add(id);
    candidateHits.totalPositiveJudgments += 1;
    if (bm25Set.has(id)) candidateHits.bm25Top100 += 1;
    if (ftsSet.has(id)) candidateHits.fts5Top100 += 1;
    if (unionSet.has(id)) candidateHits.union += 1;
  }
  const positives = query.positives;
  const parentId = find(`q:${query.id}`);
  const row: PerQuery = {
    queryId: query.id,
    positiveDocumentIds: [...positives],
    groupId: parentId,
    tokenCount: tokens.length,
    candidates: { bm25Top100: bm25Ids.length, fts5Top100: ftsIds.length, union: unionIds.length },
    candidateRecall: {
      bm25Top100: [...positives].filter(id => bm25Set.has(id)).length / positives.size,
      fts5Top100: [...positives].filter(id => ftsSet.has(id)).length / positives.size,
      union: [...positives].filter(id => unionSet.has(id)).length / positives.size,
    },
    metrics: {
      'standard-bm25': measure(bm25Ids, positives),
      'fts5-morphology': measure(ftsIds, positives),
      'bm25-fts5-union-rrf': measure(unionIds, positives),
    },
    latencyMs: { 'standard-bm25': bm25Ms, 'fts5-morphology': ftsMs, 'bm25-fts5-union-rrf': unionMs },
  };
  outputRows.push(row);
  latencies['standard-bm25'].push(bm25Ms);
  latencies['fts5-morphology'].push(ftsMs);
  latencies['bm25-fts5-union-rrf'].push(unionMs);
  const currentMemory = process.memoryUsage();
  maxHeap = Math.max(maxHeap, currentMemory.heapUsed);
  maxRss = Math.max(maxRss, currentMemory.rss);
  if ((queryNumber + 1) % 25 === 0 || queryNumber + 1 === queryRows.length) {
    console.log(`evaluated ${queryNumber + 1}/${queryRows.length}; rss=${currentMemory.rss}; heap=${currentMemory.heapUsed}`);
  }
}

if (missingPositiveIds.size) throw new Error(`Positive documents absent from corpus: ${missingPositiveIds.size}.`);
const methodNames: Method[] = ['standard-bm25', 'fts5-morphology', 'bm25-fts5-union-rrf'];
const metricNames: (keyof Metric)[] = ['hit1', 'hit10', 'mrr10', 'ndcg10', 'map100', 'recall100'];
const means = Object.fromEntries(methodNames.map(method => [method, Object.fromEntries(metricNames.map(metric => [metric,
  outputRows.reduce((sum, row) => sum + row.metrics[method][metric], 0) / outputRows.length,
]))]));
const methodLatency = Object.fromEntries(methodNames.map(method => [method, {
  p50: percentile(latencies[method], 0.5), p95: percentile(latencies[method], 0.95),
}]));
const candidateRecall = {
  bm25Top100: candidateHits.bm25Top100 / candidateHits.totalPositiveJudgments,
  fts5Top100: candidateHits.fts5Top100 / candidateHits.totalPositiveJudgments,
  unionTop200: candidateHits.union / candidateHits.totalPositiveJudgments,
};
const pairedBootstrap = (candidate: Method, metric: keyof Metric, draws = 20_000) => {
  const grouped = new Map<string, number[]>();
  for (const row of outputRows) {
    const values = grouped.get(row.groupId) ?? [];
    values.push(row.metrics[candidate][metric] - row.metrics['standard-bm25'][metric]);
    grouped.set(row.groupId, values);
  }
  const clusters = [...grouped.values()];
  let seed = Number.parseInt(sha(`${datasetDir}|${candidate}|${metric}|cluster-bootstrap-v1`).slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const samples = new Array<number>(draws);
  for (let draw = 0; draw < draws; draw += 1) {
    let total = 0;
    let count = 0;
    for (let clusterDraw = 0; clusterDraw < clusters.length; clusterDraw += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      total += cluster.reduce((sum, value) => sum + value, 0);
      count += cluster.length;
    }
    samples[draw] = total / count;
  }
  samples.sort((a, b) => a - b);
  const point = outputRows.reduce((sum, row) => sum + row.metrics[candidate][metric] - row.metrics['standard-bm25'][metric], 0) / outputRows.length;
  return { meanDifference: point, ci95: [samples[Math.floor(draws * 0.025)]!, samples[Math.floor(draws * 0.975)]!], clusters: clusters.length, draws };
};
const result = {
  dataset: {
    name: 'JaCWIR full-corpus known-positive retrieval', source: 'hotchpotch/JaCWIR', corpusDocuments: docs.length,
    queryCount: outputRows.length, positiveJudgmentCount, querySelection: manifest.querySelection,
    inputSha256: { queries: await shaFile(queryPath), qrels: await shaFile(qrelsPath), bm25Index: await shaFile(bm25IndexPath), fts5Index: await shaFile(ftsIndexPath) },
    labels: 'Known-positive qrels are not exhaustive; unjudged documents must not be interpreted as judged non-relevant.',
    warnings: [manifest.warning],
  },
  definitions: {
    parser: 'Shared purposeWords() -> analyzeQuery() -> tokenizeMorphological(); identical unique token list is passed to BM25 postings and FTS5.',
    standardBm25: 'Full-corpus morphology-token BM25, k1=1.2, b=0.75, top 100.',
    fts5: 'SQLite FTS5 BM25 over the same hex-encoded morphology tokens, top 100.',
    union: 'Union of the two top-100 lists (at most 200); equal RRF k=60, missing rank contributes zero; return top 100.',
    metrics: 'Macro query averages; known-positive binary relevance; MAP@100 denominator is all known positives for the query.',
    candidateRecall: 'Fraction of all positive qrels contained in the first-stage candidate sets, before RRF: BM25 Top100, FTS5 Top100, and their union (up to 200).',
    latency: 'Per-query wall time includes query parse/tokenization and the named ranker; union time includes both retrievals and fusion. Corpus startup/load excluded.',
    bootstrap: 'Paired percentile cluster bootstrap with connected components over shared positive document IDs, 20,000 draws, two-sided 95% interval.',
  },
  indexValidation: { bm25DocumentCount: docs.length, fts5DocumentCount: ftsCount, bm25IdsMissingFromFts5, fts5IdsMissingFromBm25, bm25ContainsEveryPositiveQrel: absentPositives.length === 0 },
  metrics: means,
  candidateRecall,
  pairedComparisons: Object.fromEntries((['fts5-morphology', 'bm25-fts5-union-rrf'] as const).map(method => [method, {
    ndcg10: pairedBootstrap(method, 'ndcg10'), hit10: pairedBootstrap(method, 'hit10'),
  }])),
  latencyMs: methodLatency,
  resources: {
    bm25IndexBytes: fs.statSync(bm25IndexPath).size, fts5IndexBytes: fs.statSync(ftsIndexPath).size,
    processRssAtEndBytes: process.memoryUsage().rss, maxObservedRssBytes: maxRss,
    heapUsedAtEndBytes: process.memoryUsage().heapUsed, maxObservedHeapUsedBytes: maxHeap,
  },
  evaluation: { status: 'preregistered single-source comparison; do not tune on this query block', perQuery: outputRows },
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
bm25Db.close();
ftsDb.close();
console.log(JSON.stringify({ output: outputPath, queries: outputRows.length, metrics: means, candidateRecall, pairedComparisons: result.pairedComparisons, latencyMs: methodLatency, resources: result.resources }, null, 2));
