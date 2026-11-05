import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import Database from 'better-sqlite3';
import { tokenizeMorphological } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';

type Document = { _id: string; title?: string; text?: string };
type Query = { _id: string; text: string };
type Metric = { hit1: number; hit10: number; recall100: number; mrr10: number; ndcg10: number; map100: number };
type QueryRow = { id: string; groupId: string; standard: Metric; morphologyFts: Metric; standardMorphRrf: Metric;
  candidateRecall: { standard: number; morphologyFts: number; union: number } };
const resume = process.argv.includes('--resume');
const [datasetArg, indexArg, outputArg] = process.argv.slice(2).filter(arg => arg !== '--resume');
if (!datasetArg || !indexArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_beir_bm25_fts_rrf.ts <dataset-dir> <new-index.sqlite> <new-output.json> [--resume]');
const datasetDir = path.resolve(datasetArg);
const indexPath = path.resolve(indexArg);
const outputPath = path.resolve(outputArg);
if ((fs.existsSync(indexPath) && !resume) || fs.existsSync(outputPath)) throw new Error('Refusing to overwrite an existing index or output. Use --resume only for an existing partial index.');
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('Output must be under artifacts/.');
const datasetName = path.basename(datasetDir).toLowerCase();
fs.mkdirSync(path.dirname(indexPath), { recursive: true });
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const queriesPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels', 'test.tsv');
for (const file of [corpusPath, queriesPath, qrelsPath]) if (!fs.existsSync(file)) throw new Error(`Missing BEIR input: ${file}`);
const readJsonl = <T>(file: string): T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as T);
const hashFile = async (file: string) => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const readJsonlLines = async function* (file: string): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  for await (const chunk of createReadStream(file)) {
    remainder += decoder.write(chunk);
    let newline = remainder.indexOf('\n');
    while (newline >= 0) {
      const line = remainder.slice(0, newline).replace(/\r$/u, '');
      if (line) yield line;
      remainder = remainder.slice(newline + 1);
      newline = remainder.indexOf('\n');
    }
  }
  remainder += decoder.end();
  if (remainder) yield remainder.replace(/\r$/u, '');
};
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
  const docs = qrels.get(queryId) ?? new Map<string, number>();
  docs.set(docId, Math.max(docs.get(docId) ?? 0, grade));
  qrels.set(queryId, docs);
}
const parent = new Map<string, string>();
const find = (id: string): string => {
  const current = parent.get(id);
  if (!current) { parent.set(id, id); return id; }
  if (current === id) return id;
  const root = find(current); parent.set(id, root); return root;
};
for (const [queryId, judgments] of qrels) for (const [docId, grade] of judgments) {
  if (grade <= 0) continue;
  const queryRoot = find(`q:${queryId}`);
  const docRoot = find(`d:${docId}`);
  if (queryRoot !== docRoot) parent.set(docRoot, queryRoot);
}
const allJudgedQueries = [...qrels.entries()].map(([id, judgments]) => ({ id, groupId: find(`q:${id}`), text: queryById.get(id)!, judgments }));
const evaluatedQueries = allJudgedQueries.filter(query => [...query.judgments.values()].some(grade => grade > 0));
const omittedQueriesWithoutPositiveQrels = allJudgedQueries.length - evaluatedQueries.length;
if (!evaluatedQueries.length) throw new Error('No official test queries have qrels after excluding self-qrels.');

const database = new Database(indexPath);
database.pragma('journal_mode = WAL');
database.pragma('synchronous = NORMAL');
database.pragma('cache_size = -64000');
database.exec(`CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, length INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS postings(term TEXT NOT NULL, doc_id TEXT NOT NULL, tf INTEGER NOT NULL, PRIMARY KEY(term,doc_id)) WITHOUT ROWID;
CREATE VIRTUAL TABLE IF NOT EXISTS morphology_fts USING fts5(id UNINDEXED, tokens, tokenize='unicode61 remove_diacritics 0');`);
const existingDocumentCount = Number((database.prepare('SELECT COUNT(*) AS value FROM documents').get() as { value: number }).value);
const ftsCount = Number((database.prepare('SELECT COUNT(*) AS value FROM morphology_fts').get() as { value: number }).value);
if (ftsCount !== existingDocumentCount) throw new Error(`Partial index is inconsistent: docs=${existingDocumentCount}, FTS=${ftsCount}.`);
if (existingDocumentCount && !resume) throw new Error('Index contains documents; refusing to append without --resume.');
if (resume && existingDocumentCount) {
  const hasDocument = database.prepare('SELECT 1 FROM documents WHERE id=?');
  let verified = 0;
  for await (const line of readJsonlLines(corpusPath)) {
    if (verified >= existingDocumentCount) break;
    const document = JSON.parse(line) as Document;
    if (!document._id || !hasDocument.get(document._id)) throw new Error(`Partial index does not match corpus prefix at document ${verified + 1}.`);
    verified++;
  }
  if (verified !== existingDocumentCount) throw new Error('Partial index is larger than the supplied corpus.');
  console.log(`verified ${verified} existing documents for resume`);
}
const insertDocument = database.prepare('INSERT INTO documents(id,length) VALUES (?,?)');
const insertPosting = database.prepare('INSERT INTO postings(term,doc_id,tf) VALUES (?,?,?)');
const insertFts = database.prepare('INSERT INTO morphology_fts(id,tokens) VALUES (?,?)');
const insertBatch = database.transaction((rows: Array<{ id: string; length: number; encodedTokens: string; terms: Array<[string, number]> }>) => {
  for (const row of rows) {
    insertDocument.run(row.id, row.length);
    for (const [term, tf] of row.terms) insertPosting.run(term, row.id, tf);
    insertFts.run(row.id, row.encodedTokens);
  }
});
const encodeToken = (token: string) => `m${Buffer.from(token, 'utf8').toString('hex')}`;
const maxHeap = { value: process.memoryUsage().heapUsed };
const indexStarted = performance.now();
let documentCount = existingDocumentCount;
let sourceDocumentCount = 0;
let batch: Array<{ id: string; length: number; encodedTokens: string; terms: Array<[string, number]> }> = [];
for await (const line of readJsonlLines(corpusPath)) {
  sourceDocumentCount++;
  if (sourceDocumentCount <= existingDocumentCount) continue;
  const doc = JSON.parse(line) as Document;
  if (!doc._id) throw new Error(`Missing corpus ID at document ${sourceDocumentCount}.`);
  const text = `${doc.title ?? ''} ${doc.text ?? ''}`.normalize('NFKC');
  const tokens = await tokenizeMorphological(text);
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  batch.push({ id: doc._id, length: tokens.length, encodedTokens: tokens.map(encodeToken).join(' '), terms: [...tf] });
  documentCount++;
  if (batch.length >= 250) { insertBatch(batch); batch = []; maxHeap.value = Math.max(maxHeap.value, process.memoryUsage().heapUsed); }
  if (documentCount % 10_000 === 0) console.log(`indexed ${documentCount} documents`);
}
if (batch.length) insertBatch(batch);
if (sourceDocumentCount < documentCount) throw new Error('Indexed document count exceeds the corpus size.');
const averageLength = Number((database.prepare('SELECT AVG(length) AS value FROM documents').get() as { value: number }).value);
const documentStats = database.prepare('SELECT COUNT(*) AS value FROM documents').get() as { value: number };
const n = Number(documentStats.value);
const indexBuildMs = performance.now() - indexStarted;
const countTermDocs = database.prepare('SELECT COUNT(*) AS value FROM postings WHERE term=?');
const postingRows = database.prepare('SELECT doc_id,tf,length FROM postings JOIN documents ON documents.id=postings.doc_id WHERE term=?');
database.exec(`CREATE TEMP TABLE standard_scores(doc_id TEXT PRIMARY KEY, score REAL NOT NULL) WITHOUT ROWID;
CREATE TEMP TABLE standard_ranks(doc_id TEXT PRIMARY KEY, rank INTEGER NOT NULL) WITHOUT ROWID;
CREATE TEMP TABLE fts_ranks(doc_id TEXT PRIMARY KEY, rank INTEGER NOT NULL) WITHOUT ROWID;`);
const insertStandardScore = database.prepare('INSERT INTO standard_scores(doc_id,score) VALUES (?,?)');
const insertStandardScores = database.transaction((entries: Array<[string, number]>) => {
  for (const [id, score] of entries) insertStandardScore.run(id, score);
});
const rankStandard = database.prepare(`INSERT INTO standard_ranks(doc_id,rank)
  SELECT doc_id,ROW_NUMBER() OVER (ORDER BY score DESC,doc_id) FROM standard_scores`);
const rankFts = database.prepare(`INSERT INTO fts_ranks(doc_id,rank)
  SELECT id,ROW_NUMBER() OVER (ORDER BY bm25(morphology_fts),id)
  FROM morphology_fts WHERE morphology_fts MATCH ?`);
const topStandard = database.prepare('SELECT doc_id FROM standard_ranks ORDER BY rank LIMIT 100');
const topMorphologyFts = database.prepare('SELECT doc_id FROM fts_ranks ORDER BY rank LIMIT 100');
const topRrf = database.prepare(`SELECT doc_id FROM (
  SELECT doc_id,SUM(1.0/(60+rank)) AS score FROM (
    SELECT doc_id,rank FROM standard_ranks UNION ALL SELECT doc_id,rank FROM fts_ranks
  ) GROUP BY doc_id
) ORDER BY score DESC,doc_id LIMIT 100`);
const hasStandardCandidate = database.prepare('SELECT 1 FROM standard_scores WHERE doc_id=? LIMIT 1');
const hasFtsCandidate = database.prepare('SELECT 1 FROM fts_ranks WHERE doc_id=? LIMIT 1');
const ftsExpression = (tokens: readonly string[]) => [...new Set(tokens)].map(token => `"${encodeToken(token).replace(/"/gu, '""')}"`).join(' OR ');
const results: QueryRow[] = [];
const queryLatency: number[] = [];
const missingPositiveQrels = new Set<string>();
const hasDocument = database.prepare('SELECT 1 FROM documents WHERE id=?');
for (let index = 0; index < evaluatedQueries.length; index++) {
  const query = evaluatedQueries[index]!;
  const started = performance.now();
  const words = await purposeWords(query.text);
  const parsed = analyzeQuery(query.text, words.length ? words : query.text.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const terms = [...new Set(parsed.keywords.map(item => item.term))];
  const queryTokens = [...new Set(await tokenizeMorphological(terms.join(' ')))];
  const scores = new Map<string, number>();
  for (const term of queryTokens) {
    const df = Number((countTermDocs.get(term) as { value: number }).value);
    if (!df) continue;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (const posting of postingRows.iterate(term) as Iterable<{ doc_id: string; tf: number; length: number }>) {
      const norm = posting.tf + 1.2 * (1 - 0.75 + 0.75 * posting.length / Math.max(averageLength, 1));
      scores.set(posting.doc_id, (scores.get(posting.doc_id) ?? 0) + idf * ((posting.tf * 2.2) / norm));
    }
  }
  database.exec('DELETE FROM standard_scores; DELETE FROM standard_ranks; DELETE FROM fts_ranks;');
  insertStandardScores([...scores]);
  rankStandard.run();
  const encodedQuery = ftsExpression(queryTokens);
  if (encodedQuery) rankFts.run(encodedQuery);
  const standard = (topStandard.all() as Array<{ doc_id: string }>).map(row => row.doc_id);
  const morphologyFts = (topMorphologyFts.all() as Array<{ doc_id: string }>).map(row => row.doc_id);
  const fused = (topRrf.all() as Array<{ doc_id: string }>).map(row => row.doc_id);
  const metric = (ids: string[]): Metric => {
    const relevant = new Set([...query.judgments].filter(([, grade]) => grade > 0).map(([id]) => id));
    for (const id of relevant) if (!hasDocument.get(id)) missingPositiveQrels.add(`${query.id}\0${id}`);
    const first = ids.findIndex(id => relevant.has(id));
    const top = ids.slice(0, 10);
    const dcg = top.reduce((sum, id, rank) => sum + (2 ** (query.judgments.get(id) ?? 0) - 1) / Math.log2(rank + 2), 0);
    const ideal = [...query.judgments.values()].filter(grade => grade > 0).sort((a, b) => b - a).slice(0, 10)
      .reduce((sum, grade, rank) => sum + (2 ** grade - 1) / Math.log2(rank + 2), 0);
    let found = 0;
    let precisionSum = 0;
    for (let rank = 0; rank < Math.min(ids.length, 100); rank++) if (relevant.has(ids[rank]!)) { found++; precisionSum += found / (rank + 1); }
    return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0,
      recall100: relevant.size ? ids.slice(0, 100).filter(id => relevant.has(id)).length / relevant.size : 0,
      mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0,
      map100: relevant.size ? precisionSum / relevant.size : 0 };
  };
  const relevant = [...query.judgments].filter(([, grade]) => grade > 0).map(([id]) => id);
  const standardCandidates = relevant.filter(id => hasStandardCandidate.get(id)).length;
  const ftsCandidates = relevant.filter(id => hasFtsCandidate.get(id)).length;
  const unionCandidates = relevant.filter(id => hasStandardCandidate.get(id) || hasFtsCandidate.get(id)).length;
  results.push({ id: query.id, groupId: query.groupId, standard: metric(standard), morphologyFts: metric(morphologyFts),
    standardMorphRrf: metric(fused), candidateRecall: { standard: relevant.length ? standardCandidates / relevant.length : 0,
      morphologyFts: relevant.length ? ftsCandidates / relevant.length : 0, union: relevant.length ? unionCandidates / relevant.length : 0 } });
  queryLatency.push(performance.now() - started);
  maxHeap.value = Math.max(maxHeap.value, process.memoryUsage().heapUsed);
  if ((index + 1) % 10 === 0 || index + 1 === evaluatedQueries.length) {
    const memory = process.memoryUsage();
    console.log(`evaluated ${index + 1}/${evaluatedQueries.length}; rss=${memory.rss}; heap=${memory.heapUsed}`);
  }
}
const metricNames = ['hit1', 'hit10', 'recall100', 'mrr10', 'ndcg10', 'map100'] as const;
const methods = ['standard', 'morphologyFts', 'standardMorphRrf'] as const;
const means = Object.fromEntries(methods.map(method => [method, Object.fromEntries(metricNames.map(metric => [metric,
  results.reduce((sum, row) => sum + row[method][metric], 0) / results.length,
]))]));
const candidateRecall = Object.fromEntries(['standard', 'morphologyFts', 'union'].map(method => [method,
  results.reduce((sum, row) => sum + row.candidateRecall[method as 'standard' | 'morphologyFts' | 'union'], 0) / results.length,
]));
const clusterBootstrap = (method: 'morphologyFts' | 'standardMorphRrf', metric: typeof metricNames[number]) => {
  const grouped = new Map<string, number[]>();
  for (const row of results) grouped.set(row.groupId, [...(grouped.get(row.groupId) ?? []), row[method][metric] - row.standard[metric]]);
  const clusters = [...grouped.values()];
  let seed = Number.parseInt(crypto.createHash('sha256').update(`${datasetName}\0${method}\0${metric}`).digest('hex').slice(0, 8), 16) >>> 0;
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
  return { meanDifference: results.reduce((sum, row) => sum + row[method][metric] - row.standard[metric], 0) / results.length,
    pairedClusterBootstrap95CI: [draws[499]!, draws[19_499]!], clusterCount: clusters.length };
};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
database.pragma('wal_checkpoint(TRUNCATE)');
const indexBytes = fs.statSync(indexPath).size;
database.close();
const result = {
  dataset: { name: datasetName, split: 'BEIR official test qrels', documents: documentCount, queries: results.length,
    positiveQrelConnectedComponents: new Set(evaluatedQueries.map(query => query.groupId)).size,
    corpusSha256: await hashFile(corpusPath), queriesSha256: await hashFile(queriesPath), qrelsSha256: await hashFile(qrelsPath) },
  definitions: { standard: 'Full-corpus BM25 using exact Kuromoji morphology tokens, k1=1.2,b=0.75, positive-smoothed IDF log(1+(N-df+0.5)/(df+0.5)).',
    standardMorphRrf: 'Equal reciprocal-rank fusion (k=60) of the standard BM25 ranks and SQLite FTS5 morphology ranks; same exact encoded Kuromoji tokens and full corpus.',
    parser: 'Shared purposeWords() and analyzeQuery(); resulting terms are passed through tokenizeMorphological() for both rankers.',
    selfQrels: 'queryId==documentId qrels excluded as in official BEIR evaluation; count is reported.',
    metrics: 'Macro query averages; qrel grade >0 relevant; graded nDCG gain 2^grade-1; MAP@100 denominator is all relevant documents.' },
  corpusQrelsAudit: { positiveQrelCount: evaluatedQueries.reduce((sum, query) => sum + [...query.judgments.values()].filter(grade => grade > 0).length, 0),
    positiveQrelsAbsentFromCorpus: missingPositiveQrels.size, ignoredSelfQrels, omittedQueriesWithoutPositiveQrels },
  metrics: means, candidateRecall,
  differencesVsStandard: Object.fromEntries(methods.filter(method => method !== 'standard').map(method => [method,
    Object.fromEntries(metricNames.map(metric => [metric, clusterBootstrap(method, metric)]))])),
  resources: { indexDatabase: indexPath, indexBytes, indexBuildMs: existingDocumentCount ? null : indexBuildMs,
    indexBuildDurationStatus: existingDocumentCount ? 'not measured; full index existed before this timed resume run' : 'measured',
    resumeScanAndStatsMs: existingDocumentCount ? indexBuildMs : null,
    queryLatencyMs: { p50: percentile(queryLatency, 0.5), p95: percentile(queryLatency, 0.95) },
    processRssBytes: process.memoryUsage().rss, processHeapUsedBytes: process.memoryUsage().heapUsed, maxObservedHeapUsedBytes: maxHeap.value },
  evaluation: { status: 'single preregistered comparison; do not tune on these test sets', evaluatorSha256: await hashFile(fileURLToPath(import.meta.url)), perQuery: results },
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, dataset: result.dataset, metrics: result.metrics, candidateRecall: result.candidateRecall,
  differencesVsStandard: result.differencesVsStandard,
  corpusQrelsAudit: result.corpusQrelsAudit, resources: result.resources }, null, 2));
