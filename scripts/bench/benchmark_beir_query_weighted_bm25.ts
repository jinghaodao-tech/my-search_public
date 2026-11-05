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
type QueryResult = { id: string; groupId: string; standard: Metric; parserWeighted: Metric; standardTop10: string[]; parserWeightedTop10: string[] };
const resume = process.argv.includes('--resume');
const split = process.argv.find(arg => arg.startsWith('--split='))?.slice('--split='.length) ?? 'test';
const [datasetArg, indexArg, outputArg] = process.argv.slice(2).filter(arg => arg !== '--resume' && !arg.startsWith('--split='));
if (!datasetArg || !indexArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_beir_query_weighted_bm25.ts <dataset-dir> <new-index.sqlite> <new-output.json> [--split=test|dev|train] [--resume]');
if (!['test', 'dev', 'train'].includes(split)) throw new Error('Split must be test, dev, or train.');
const datasetDir = path.resolve(datasetArg);
const indexPath = path.resolve(indexArg);
const outputPath = path.resolve(outputArg);
if ((fs.existsSync(indexPath) && !resume) || fs.existsSync(outputPath)) throw new Error('Refusing to overwrite an existing index or output. Use --resume only for a partial index.');
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('Output must be under artifacts/.');
fs.mkdirSync(path.dirname(indexPath), { recursive: true });
const datasetName = path.basename(datasetDir).toLowerCase();
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const queriesPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels', `${split}.tsv`);
for (const file of [corpusPath, queriesPath, qrelsPath]) if (!fs.existsSync(file)) throw new Error(`Missing BEIR input: ${file}`);
const readJsonl = <T>(file: string): T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as T);
const hashFile = async (file: string) => { const hash = crypto.createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
const queries = readJsonl<Query>(queriesPath);
const queryById = new Map(queries.map(query => [query._id, query.text]));
const qrels = new Map<string, Map<string, number>>();
let ignoredSelfQrels = 0;
for (const [lineNumber, line] of fs.readFileSync(qrelsPath, 'utf8').split(/\r?\n/u).entries()) {
  if (!line.trim() || line.startsWith('query-id')) continue;
  const [queryId, docId, gradeText] = line.split('\t');
  const grade = Number(gradeText);
  if (!queryId || !docId || !queryById.has(queryId) || !Number.isFinite(grade)) throw new Error(`Invalid qrels row ${lineNumber + 1}.`);
  if (queryId === docId) { ignoredSelfQrels++; continue; }
  const judgments = qrels.get(queryId) ?? new Map<string, number>();
  judgments.set(docId, Math.max(judgments.get(docId) ?? 0, grade));
  qrels.set(queryId, judgments);
}
const parent = new Map<string, string>();
const find = (id: string): string => {
  const current = parent.get(id);
  if (!current) { parent.set(id, id); return id; }
  if (current === id) return id;
  const root = find(current); parent.set(id, root); return root;
};
const evaluatedQueries = [...qrels.entries()].filter(([, rows]) => [...rows.values()].some(grade => grade > 0)).map(([id, judgments]) => ({ id, text: queryById.get(id)!, judgments }));
const omittedQueriesWithoutPositiveQrels = qrels.size - evaluatedQueries.length;
if (!evaluatedQueries.length) throw new Error('No positive test qrels remain.');
for (const query of evaluatedQueries) for (const [docId, grade] of query.judgments) if (grade > 0) {
  const queryRoot = find(`q:${query.id}`);
  const docRoot = find(`d:${docId}`);
  if (queryRoot !== docRoot) parent.set(docRoot, queryRoot);
}
const groupId = (id: string) => find(`q:${id}`);

const database = new Database(indexPath);
database.pragma('journal_mode = WAL');
database.pragma('synchronous = NORMAL');
database.pragma('cache_size = -64000');
database.exec('CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,length INTEGER NOT NULL) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS postings(term TEXT NOT NULL,doc_id TEXT NOT NULL,tf INTEGER NOT NULL,PRIMARY KEY(term,doc_id)) WITHOUT ROWID;');
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
    if (!doc._id || !hasDocument.get(doc._id)) throw new Error(`Partial index does not match corpus prefix at document ${verified + 1}.`);
    verified++;
  }
  if (verified !== existingDocumentCount) throw new Error('Partial index is larger than the supplied corpus.');
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
let sourceCount = 0;
let batch: Array<{ id: string; length: number; terms: Array<[string, number]> }> = [];
const lines = readline.createInterface({ input: createReadStream(corpusPath), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line) continue;
  sourceCount++;
  if (sourceCount <= existingDocumentCount) continue;
  const doc = JSON.parse(line) as Document;
  if (!doc._id) throw new Error(`Missing document ID at line ${sourceCount}.`);
  const tokens = await tokenizeMorphological(`${doc.title ?? ''} ${doc.text ?? ''}`.normalize('NFKC'));
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  batch.push({ id: doc._id, length: tokens.length, terms: [...tf] });
  documentCount++;
  if (batch.length >= 250) { insertBatch(batch); batch = []; maxHeap.value = Math.max(maxHeap.value, process.memoryUsage().heapUsed); }
  if (documentCount % 10_000 === 0) console.log(`indexed ${documentCount} documents`);
}
if (batch.length) insertBatch(batch);
if (sourceCount < documentCount) throw new Error('Indexed document count exceeds corpus size.');
const averageLength = Number((database.prepare('SELECT AVG(length) AS value FROM documents').get() as { value: number }).value);
const indexBuildMs = performance.now() - indexStarted;
const documentTotal = Number((database.prepare('SELECT COUNT(*) AS value FROM documents').get() as { value: number }).value);
const countDf = database.prepare('SELECT COUNT(*) AS value FROM postings WHERE term=?');
const readPostings = database.prepare('SELECT doc_id,tf,length FROM postings JOIN documents ON documents.id=postings.doc_id WHERE term=?');
const hasDocument = database.prepare('SELECT 1 FROM documents WHERE id=?');
const results: QueryResult[] = [];
const queryLatency: number[] = [];
const missingPositiveQrels = new Set<string>();
for (let index = 0; index < evaluatedQueries.length; index++) {
  const query = evaluatedQueries[index]!;
  const started = performance.now();
  const words = await purposeWords(query.text);
  const parsed = analyzeQuery(query.text, words.length ? words : query.text.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const parsedTokens = new Map<string, number>();
  for (const keyword of parsed.keywords) {
    const tokens = await tokenizeMorphological(keyword.term);
    for (const token of tokens) parsedTokens.set(token, Math.max(parsedTokens.get(token) ?? 0, keyword.weight));
  }
  const queryTokens = [...new Set(await tokenizeMorphological(parsed.keywords.map(keyword => keyword.term).join(' ')))];
  for (const token of queryTokens) if (!parsedTokens.has(token)) parsedTokens.set(token, 1);
  const modes = { standard: new Map<string, number>(), parserWeighted: new Map<string, number>() };
  for (const term of queryTokens) {
    const df = Number((countDf.get(term) as { value: number }).value);
    if (!df) continue;
    const idf = Math.log(1 + (documentTotal - df + 0.5) / (df + 0.5));
    for (const posting of readPostings.iterate(term) as Iterable<{ doc_id: string; tf: number; length: number }>) {
      const norm = posting.tf + 1.2 * (1 - 0.75 + 0.75 * posting.length / Math.max(averageLength, 1));
      const tfComponent = (posting.tf * 2.2) / norm;
      modes.standard.set(posting.doc_id, (modes.standard.get(posting.doc_id) ?? 0) + idf * tfComponent);
      modes.parserWeighted.set(posting.doc_id, (modes.parserWeighted.get(posting.doc_id) ?? 0) + idf * tfComponent * parsedTokens.get(term)!);
    }
  }
  const ranked = Object.fromEntries(Object.entries(modes).map(([mode, scores]) => [mode,
    [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id),
  ])) as Record<'standard' | 'parserWeighted', string[]>;
  const metric = (ids: string[]): Metric => {
    const relevant = new Set([...query.judgments].filter(([, grade]) => grade > 0).map(([id]) => id));
    for (const id of relevant) if (!hasDocument.get(id)) missingPositiveQrels.add(`${query.id}\0${id}`);
    const first = ids.findIndex(id => relevant.has(id));
    const dcg = ids.slice(0, 10).reduce((sum, id, rank) => sum + (2 ** (query.judgments.get(id) ?? 0) - 1) / Math.log2(rank + 2), 0);
    const ideal = [...query.judgments.values()].filter(grade => grade > 0).sort((a, b) => b - a).slice(0, 10)
      .reduce((sum, grade, rank) => sum + (2 ** grade - 1) / Math.log2(rank + 2), 0);
    let found = 0;
    let ap = 0;
    for (let rank = 0; rank < Math.min(ids.length, 100); rank++) if (relevant.has(ids[rank]!)) { found++; ap += found / (rank + 1); }
    return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0,
      recall100: relevant.size ? ids.slice(0, 100).filter(id => relevant.has(id)).length / relevant.size : 0,
      mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0,
      map100: relevant.size ? ap / relevant.size : 0 };
  };
  results.push({ id: query.id, groupId: groupId(query.id), standard: metric(ranked.standard), parserWeighted: metric(ranked.parserWeighted),
    standardTop10: ranked.standard.slice(0, 10), parserWeightedTop10: ranked.parserWeighted.slice(0, 10) });
  queryLatency.push(performance.now() - started);
  maxHeap.value = Math.max(maxHeap.value, process.memoryUsage().heapUsed);
  if ((index + 1) % 500 === 0 || index + 1 === evaluatedQueries.length) console.log(`evaluated ${index + 1}/${evaluatedQueries.length}`);
}
const metricNames = ['hit1', 'hit10', 'recall100', 'mrr10', 'ndcg10', 'map100'] as const;
const means = Object.fromEntries(['standard', 'parserWeighted'].map(method => [method, Object.fromEntries(metricNames.map(metric => [metric,
  results.reduce((sum, row) => sum + row[method as 'standard' | 'parserWeighted'][metric], 0) / results.length,
]))]));
const clusterBootstrap = (metric: typeof metricNames[number]) => {
  const groups = new Map<string, number[]>();
  for (const row of results) groups.set(row.groupId, [...(groups.get(row.groupId) ?? []), row.parserWeighted[metric] - row.standard[metric]]);
  const clusters = [...groups.values()];
  let seed = Number.parseInt(crypto.createHash('sha256').update(`${datasetName}\0parserWeighted\0${metric}`).digest('hex').slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = new Array<number>(20_000);
  for (let iteration = 0; iteration < draws.length; iteration++) {
    let total = 0; let count = 0;
    for (let draw = 0; draw < clusters.length; draw++) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      total += cluster.reduce((sum, value) => sum + value, 0); count += cluster.length;
    }
    draws[iteration] = total / count;
  }
  draws.sort((a, b) => a - b);
  return { meanDifference: results.reduce((sum, row) => sum + row.parserWeighted[metric] - row.standard[metric], 0) / results.length,
    pairedClusterBootstrap95CI: [draws[499]!, draws[19_499]!], clusterCount: clusters.length };
};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
database.pragma('wal_checkpoint(TRUNCATE)');
const indexBytes = fs.statSync(indexPath).size;
database.close();
const result = {
  dataset: { name: datasetName, split: `BEIR official ${split} qrels`, documents: documentCount, queries: results.length,
    positiveQrelConnectedComponents: new Set(evaluatedQueries.map(query => groupId(query.id))).size,
    corpusSha256: await hashFile(corpusPath), queriesSha256: await hashFile(queriesPath), qrelsSha256: await hashFile(qrelsPath) },
  definitions: { standard: 'Full-corpus BM25 with exact Kuromoji morphology tokens, k1=1.2,b=0.75, positive-smoothed IDF.',
    parserWeighted: 'Same BM25 and candidate set; each matching token contribution is multiplied by the existing analyzeQuery() keyword weight mapped through tokenizeMorphological().',
    parser: 'Shared purposeWords() and analyzeQuery(); query weighting uses existing defaults and purposeTermWeight, no fitted coefficient.',
    selfQrels: 'queryId==documentId qrels excluded; queries with no positive qrels excluded and counted.',
    metrics: 'Macro query averages; qrel grade >0 relevant; graded nDCG gain 2^grade-1; MAP@100 denominator is all positive qrels.' },
  corpusQrelsAudit: { positiveQrelCount: evaluatedQueries.reduce((sum, query) => sum + [...query.judgments.values()].filter(grade => grade > 0).length, 0),
    positiveQrelsAbsentFromCorpus: missingPositiveQrels.size, ignoredSelfQrels, omittedQueriesWithoutPositiveQrels },
  metrics: means, differencesVsStandard: Object.fromEntries(metricNames.map(metric => [metric, clusterBootstrap(metric)])),
  resources: { indexDatabase: indexPath, indexBytes, indexBuildMs,
    queryLatencyMs: { p50: percentile(queryLatency, .5), p95: percentile(queryLatency, .95) },
    processRssBytes: process.memoryUsage().rss, processHeapUsedBytes: process.memoryUsage().heapUsed, maxObservedHeapUsedBytes: maxHeap.value },
  evaluation: { status: 'single preregistered comparison; do not tune on this test', evaluatorSha256: await hashFile(fileURLToPath(import.meta.url)), perQuery: results },
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, dataset: result.dataset, metrics: result.metrics,
  differencesVsStandard: result.differencesVsStandard, corpusQrelsAudit: result.corpusQrelsAudit, resources: result.resources }, null, 2));
