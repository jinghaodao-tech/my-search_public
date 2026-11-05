import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { tokenizeMorphological } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';

type Document = { _id: string; title?: string; text?: string };
type Query = { _id: string; text: string };
type Metric = { hit1: number; hit10: number; recall100: number; mrr10: number; ndcg10: number; map100: number };
type QueryResult = { id: string; groupId: string; standard: Metric; rsjZero: Metric; rsjEpsilon: Metric };
const resume = process.argv.includes('--resume');
const [datasetArg, indexArg, outputArg] = process.argv.slice(2).filter(arg => arg !== '--resume');
if (!datasetArg || !indexArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_beir_bm25_idf.ts <extracted-dataset-dir> <new-index.sqlite> <new-output.json>');
const datasetDir = path.resolve(datasetArg);
const indexPath = path.resolve(indexArg);
const outputPath = path.resolve(outputArg);
if ((fs.existsSync(indexPath) && !resume) || fs.existsSync(outputPath)) throw new Error('Refusing to overwrite an existing benchmark index or output. Use --resume only for an existing partial index.');
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('Output must be under artifacts/.');
const datasetName = path.basename(datasetDir).toLowerCase();
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const queriesPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels', 'test.tsv');
for (const file of [corpusPath, queriesPath, qrelsPath]) if (!fs.existsSync(file)) throw new Error(`Missing BEIR input: ${file}`);
const hashFile = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJsonl = <T>(file: string): T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as T);
const queries = readJsonl<Query>(queriesPath);
const queryById = new Map(queries.map(query => [query._id, query.text]));
const qrels = new Map<string, Map<string, number>>();
for (const [lineNumber, line] of fs.readFileSync(qrelsPath, 'utf8').split(/\r?\n/u).entries()) {
  if (!line.trim() || line.startsWith('query-id')) continue;
  const [queryId, docId, scoreText] = line.split('\t');
  const score = Number(scoreText);
  if (!queryId || !docId || !queryById.has(queryId) || !Number.isFinite(score)) throw new Error(`Invalid qrels row ${lineNumber + 1}.`);
  const rows = qrels.get(queryId) ?? new Map<string, number>();
  rows.set(docId, Math.max(rows.get(docId) ?? 0, score));
  qrels.set(queryId, rows);
}

const parent = new Map<string, string>();
const find = (id: string): string => {
  const current = parent.get(id);
  if (!current) { parent.set(id, id); return id; }
  if (current === id) return id;
  const root = find(current); parent.set(id, root); return root;
};
const union = (left: string, right: string) => { const a = find(left); const b = find(right); if (a !== b) parent.set(b, a); };
for (const [queryId, judgments] of qrels) for (const [docId, grade] of judgments) if (grade > 0) union(`q:${queryId}`, `d:${docId}`);
const evaluatedQueries = [...qrels.entries()].map(([id, judgments]) => ({ id, groupId: parent.has(`q:${id}`) ? find(`q:${id}`) : `q:${id}`, text: queryById.get(id)!, judgments }));
if (!evaluatedQueries.length) throw new Error('No official test queries have qrels.');

const database = new Database(indexPath);
database.pragma('journal_mode = WAL');
database.pragma('synchronous = NORMAL');
database.pragma('cache_size = -64000');
database.exec('CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, length INTEGER NOT NULL) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS postings(term TEXT NOT NULL, doc_id TEXT NOT NULL, tf INTEGER NOT NULL, PRIMARY KEY(term,doc_id)) WITHOUT ROWID;');
const existingDocumentCount = Number((database.prepare('SELECT COUNT(*) AS value FROM documents').get() as { value: number }).value);
if (existingDocumentCount && !resume) throw new Error('Index contains documents; refusing to append without --resume.');
if (resume && existingDocumentCount) {
  const hasDocument = database.prepare('SELECT 1 FROM documents WHERE id=?');
  let verified = 0;
  const prefix = readline.createInterface({ input: createReadStream(corpusPath), crlfDelay: Infinity });
  for await (const line of prefix) {
    if (!line) continue;
    if (verified >= existingDocumentCount) break;
    const doc = JSON.parse(line) as Document;
    if (!doc._id || !hasDocument.get(doc._id)) throw new Error(`Existing partial index does not match the corpus prefix at document ${verified + 1}.`);
    verified++;
  }
  if (verified !== existingDocumentCount) throw new Error('Existing partial index is larger than the supplied corpus.');
  console.log(`verified ${verified} existing documents for resume`);
}
const insertDocument = database.prepare('INSERT INTO documents(id,length) VALUES (?,?)');
const insertPosting = database.prepare('INSERT INTO postings(term,doc_id,tf) VALUES (?,?,?)');
const insertBatch = database.transaction((rows: Array<{ id: string; length: number; terms: Array<[string, number]> }>) => {
  for (const row of rows) { insertDocument.run(row.id, row.length); for (const [term, tf] of row.terms) insertPosting.run(term, row.id, tf); }
});
const maxHeap = { value: process.memoryUsage().heapUsed };
const indexStarted = performance.now();
let documentCount = existingDocumentCount;
let sourceDocumentCount = 0;
let batch: Array<{ id: string; length: number; terms: Array<[string, number]> }> = [];
const lines = readline.createInterface({ input: createReadStream(corpusPath), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line) continue;
  sourceDocumentCount++;
  if (sourceDocumentCount <= existingDocumentCount) continue;
  const doc = JSON.parse(line) as Document;
  if (!doc._id) throw new Error('Missing corpus document ID.');
  const text = `${doc.title ?? ''} ${doc.text ?? ''}`.normalize('NFKC');
  const morphologicalTokens = await tokenizeMorphological(text);
  const tf = new Map<string, number>();
  for (const token of morphologicalTokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  batch.push({ id: doc._id, length: morphologicalTokens.length, terms: [...tf] });
  documentCount++;
  if (batch.length >= 250) { insertBatch(batch); batch = []; maxHeap.value = Math.max(maxHeap.value, process.memoryUsage().heapUsed); }
  if (documentCount % 10_000 === 0) console.log(`indexed ${documentCount} documents`);
}
if (batch.length) insertBatch(batch);
database.exec('CREATE TABLE term_stats(term TEXT PRIMARY KEY, df INTEGER NOT NULL, raw_idf REAL NOT NULL) WITHOUT ROWID; INSERT INTO term_stats SELECT term, COUNT(*), 0.0 FROM postings GROUP BY term;');
const updateStats = database.prepare('UPDATE term_stats SET raw_idf=? WHERE term=?');
const readStatsBatch = database.prepare('SELECT term,df FROM term_stats WHERE term>? ORDER BY term LIMIT 10000');
const updateStatsBatch = database.transaction((rows: Array<{ term: string; df: number }>) => {
  for (const row of rows) updateStats.run(Math.log((documentCount - row.df + 0.5) / (row.df + 0.5)), row.term);
});
let rawIdfSum = 0;
let vocabularySize = 0;
let lastTerm = '';
while (true) {
  const rows = readStatsBatch.all(lastTerm) as Array<{ term: string; df: number }>;
  if (!rows.length) break;
  updateStatsBatch(rows);
  for (const row of rows) { rawIdfSum += Math.log((documentCount - row.df + 0.5) / (row.df + 0.5)); vocabularySize++; }
  lastTerm = rows[rows.length - 1]!.term;
}
const averageRawIdf = rawIdfSum / Math.max(vocabularySize, 1);
database.exec('ANALYZE;');
const indexBuildMs = performance.now() - indexStarted;
const averageLength = Number((database.prepare('SELECT AVG(length) AS value FROM documents').get() as { value: number }).value);
const statsStatement = database.prepare('SELECT df,raw_idf FROM term_stats WHERE term=?');
const postingStatement = database.prepare('SELECT p.doc_id,p.tf,d.length FROM postings p JOIN documents d ON d.id=p.doc_id WHERE p.term=?');
const results: QueryResult[] = [];
const latencyMs: number[] = [];
const missingPositiveQrels = new Set<string>();
for (const query of evaluatedQueries) {
  const started = performance.now();
  const words = await purposeWords(query.text);
  const parsed = analyzeQuery(query.text, words.length ? words : query.text.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const parsedTerms = [...new Set(parsed.keywords.map(item => item.term))];
  const queryTokens = [...new Set(await tokenizeMorphological(parsedTerms.join(' ')))];
  const scores = { standard: new Map<string, number>(), rsjZero: new Map<string, number>(), rsjEpsilon: new Map<string, number>() };
  for (const term of queryTokens) {
    const stats = statsStatement.get(term) as { df: number; raw_idf: number } | undefined;
    if (!stats) continue;
    const idfs = {
      standard: Math.log(1 + (documentCount - stats.df + 0.5) / (stats.df + 0.5)),
      rsjZero: Math.max(0, stats.raw_idf),
      rsjEpsilon: stats.raw_idf > 0 ? stats.raw_idf : Math.max(0, 0.25 * averageRawIdf),
    };
    for (const posting of postingStatement.iterate(term) as Iterable<{ doc_id: string; tf: number; length: number }>) {
      const denominator = posting.tf + 1.2 * (1 - 0.75 + 0.75 * posting.length / Math.max(averageLength, 1));
      const tfComponent = (posting.tf * 2.2) / denominator;
      for (const method of Object.keys(scores) as Array<keyof typeof scores>) {
        scores[method].set(posting.doc_id, (scores[method].get(posting.doc_id) ?? 0) + idfs[method] * tfComponent);
      }
    }
  }
  const ranked = Object.fromEntries((Object.keys(scores) as Array<keyof typeof scores>).map(method => [method,
    [...scores[method]].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id),
  ])) as Record<keyof typeof scores, string[]>;
  const metric = (ids: string[]): Metric => {
    const relevant = new Set([...query.judgments].filter(([, grade]) => grade > 0).map(([id]) => id));
    for (const id of relevant) if (!database.prepare('SELECT 1 FROM documents WHERE id=?').get(id)) missingPositiveQrels.add(`${query.id}\0${id}`);
    const first = ids.findIndex(id => relevant.has(id));
    const top = ids.slice(0, 10);
    const dcg = top.reduce((sum, id, index) => sum + (2 ** (query.judgments.get(id) ?? 0) - 1) / Math.log2(index + 2), 0);
    const ideal = [...query.judgments.values()].filter(grade => grade > 0).sort((a, b) => b - a).slice(0, 10)
      .reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
    let found = 0; let precisionSum = 0;
    for (let index = 0; index < Math.min(ids.length, 100); index++) if (relevant.has(ids[index]!)) { found++; precisionSum += found / (index + 1); }
    return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0,
      recall100: relevant.size ? ids.slice(0, 100).filter(id => relevant.has(id)).length / relevant.size : 0,
      mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0,
      map100: relevant.size ? precisionSum / relevant.size : 0 };
  };
  results.push({ id: query.id, groupId: query.groupId, standard: metric(ranked.standard), rsjZero: metric(ranked.rsjZero), rsjEpsilon: metric(ranked.rsjEpsilon) });
  latencyMs.push(performance.now() - started);
  maxHeap.value = Math.max(maxHeap.value, process.memoryUsage().heapUsed);
  if (results.length % 100 === 0 || results.length === evaluatedQueries.length) console.log(`evaluated ${results.length}/${evaluatedQueries.length}`);
}

const methods = ['standard', 'rsjZero', 'rsjEpsilon'] as const;
const metricNames = ['hit1', 'hit10', 'recall100', 'mrr10', 'ndcg10', 'map100'] as const;
const means = Object.fromEntries(methods.map(method => [method, Object.fromEntries(metricNames.map(metric => [metric,
  results.reduce((sum, row) => sum + row[method][metric], 0) / results.length,
]))]));
const differences = Object.fromEntries(methods.filter(method => method !== 'standard').map(method => [method,
  Object.fromEntries(metricNames.map(metric => [metric, clusterBootstrap(method, metric)])),
]));
function clusterBootstrap(method: typeof methods[number], metric: typeof metricNames[number]) {
  const grouped = new Map<string, number[]>();
  for (const row of results) grouped.set(row.groupId, [...(grouped.get(row.groupId) ?? []), row[method][metric] - row.standard[metric]]);
  const clusters = [...grouped.values()];
  let seed = Number.parseInt(crypto.createHash('sha256').update(`${datasetName}\0${method}\0${metric}`).digest('hex').slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = new Array<number>(20_000);
  for (let iteration = 0; iteration < draws.length; iteration++) {
    let total = 0; let count = 0;
    for (let sample = 0; sample < clusters.length; sample++) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      total += cluster.reduce((sum, value) => sum + value, 0); count += cluster.length;
    }
    draws[iteration] = total / count;
  }
  draws.sort((a, b) => a - b);
  return { meanDifference: results.reduce((sum, row) => sum + row[method][metric] - row.standard[metric], 0) / results.length,
    pairedClusterBootstrap95CI: [draws[499]!, draws[19_499]!], clusterCount: clusters.length };
}
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
database.pragma('wal_checkpoint(TRUNCATE)');
database.close();
const result = {
  dataset: { name: datasetName, split: 'test qrels', documents: documentCount, queries: results.length,
    positiveQrelConnectedComponents: new Set(evaluatedQueries.map(query => query.groupId)).size,
    corpusSha256: hashFile(corpusPath), queriesSha256: hashFile(queriesPath), qrelsSha256: hashFile(qrelsPath) },
  definitions: { standard: 'Same exact Kuromoji morphology token stream, candidate set, k1=1.2,b=0.75; IDF=log(1+RSJ ratio).',
    rsjZero: 'Same exact tokens, candidate set and k1/b; non-positive RSJ IDF clamped to zero.',
    rsjEpsilon: 'Same exact tokens, candidate set and k1/b; non-positive RSJ IDF replaced with 0.25 times corpus-average RSJ IDF.',
    tokenizationAndParser: 'my-search buildStoredTokenSet(), purposeWords(), analyzeQuery(); morphology tokens only; no FTS or custom ranking boosts.',
    qrels: 'Official BEIR test qrels; missing positive qrels are preserved and reported; nDCG uses graded gain 2^grade-1.' },
  corpusQrelsAudit: { positiveQrelCount: evaluatedQueries.reduce((sum, query) => sum + [...query.judgments.values()].filter(grade => grade > 0).length, 0),
    positiveQrelsAbsentFromCorpus: missingPositiveQrels.size },
  metrics: means, differencesVsStandard: differences,
  resources: { indexDatabase: indexPath, indexBytes: fs.statSync(indexPath).size, indexBuildMs, queryLatencyMs: { p50: percentile(latencyMs, 0.5), p95: percentile(latencyMs, 0.95) },
    processRssBytes: process.memoryUsage().rss, processHeapUsedBytes: process.memoryUsage().heapUsed, maxObservedHeapUsedBytes: maxHeap.value },
  evaluation: { status: 'single preregistered comparison; do not tune on these test sets', evaluatorSha256: hashFile(fileURLToPath(import.meta.url)),
    perQuery: results },
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, dataset: result.dataset, metrics: result.metrics, differencesVsStandard: result.differencesVsStandard,
  corpusQrelsAudit: result.corpusQrelsAudit, resources: result.resources }, null, 2));
