import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { buildStoredTokenSet } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';

type BeirDocument = { _id: string; title?: string; text?: string };
type BeirQuery = { _id: string; text: string };
type EvaluatedQuery = { id: string; groupId: string; text: string; judgments: Map<string, number> };
type Posting = { docIndex: number; tf: number };
type Ranked = { id: string; rank: number };
type Metrics = { hit1: number; hit10: number; recall100: number; mrr10: number; ndcg10: number; map100: number };
type QueryResult = { queryId: string; groupId: string; parserTermCount: number; morphologyQueryTokenCount: number; standard: Metrics; ftsMorph: Metrics; ftsRaw: Metrics; ftsPorter: Metrics; standardMorphRrf: Metrics; standardMorphRawRrf: Metrics };

const [datasetArg, outputArg, queryLimitArg, queryOffsetArg] = process.argv.slice(2);
if (!datasetArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_beir_standard_fts.ts <extracted-dataset-dir> <new-output.json> [query-limit] [hash-rank-offset]');
const queryLimit = queryLimitArg === undefined ? Number.POSITIVE_INFINITY : Number(queryLimitArg);
if (!(queryLimit === Number.POSITIVE_INFINITY || (Number.isInteger(queryLimit) && queryLimit > 0))) throw new Error('query-limit must be a positive integer.');
const queryOffset = queryOffsetArg === undefined ? 0 : Number(queryOffsetArg);
if (!Number.isInteger(queryOffset) || queryOffset < 0) throw new Error('hash-rank-offset must be a non-negative integer.');
const datasetDir = path.resolve(datasetArg);
const outputPath = path.resolve(outputArg);
if (!fs.existsSync(datasetDir) || fs.existsSync(outputPath)) throw new Error('Dataset directory must exist and output path must be new.');
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('Output must be under artifacts/.');
const datasetName = path.basename(datasetDir).toLowerCase();
const readJsonl = <T>(file: string): T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as T);
const hashFile = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const queriesPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels', 'test.tsv');
for (const file of [corpusPath, queriesPath, qrelsPath]) if (!fs.existsSync(file)) throw new Error(`Missing BEIR input: ${file}`);

const corpus = readJsonl<BeirDocument>(corpusPath);
const queryById = new Map(readJsonl<BeirQuery>(queriesPath).map(query => [query._id, query.text]));
const qrels = new Map<string, Map<string, number>>();
for (const [lineNumber, line] of fs.readFileSync(qrelsPath, 'utf8').split(/\r?\n/u).entries()) {
  if (!line.trim() || line.startsWith('query-id')) continue;
  const [queryId, docId, scoreText] = line.split('\t');
  if (!queryId || !docId || !scoreText || !queryById.has(queryId)) throw new Error(`Invalid qrels row ${lineNumber + 1}.`);
  const score = Number(scoreText);
  if (!Number.isFinite(score)) throw new Error(`Invalid qrels score on row ${lineNumber + 1}.`);
  const docs = qrels.get(queryId) ?? new Map<string, number>();
  docs.set(docId, Math.max(docs.get(docId) ?? 0, score));
  qrels.set(queryId, docs);
}
const parent = new Map<string, string>();
const find = (id: string): string => {
  const current = parent.get(id);
  if (!current) { parent.set(id, id); return id; }
  if (current === id) return id;
  const root = find(current);
  parent.set(id, root);
  return root;
};
const union = (left: string, right: string) => {
  const leftRoot = find(left);
  const rightRoot = find(right);
  if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
};
for (const [queryId, judgments] of qrels) for (const [docId, grade] of judgments) {
  if (grade > 0) union(`q:${queryId}`, `d:${docId}`);
}
const allEvaluatedQueries: EvaluatedQuery[] = [...qrels.entries()].map(([queryId, judgments]) => ({
  id: queryId,
  groupId: parent.has(`q:${queryId}`) ? find(`q:${queryId}`) : `q:${queryId}`,
  text: queryById.get(queryId)!,
  judgments,
}));
const evaluatedQueries = Number.isFinite(queryLimit)
  ? allEvaluatedQueries.sort((left, right) => crypto.createHash('sha256').update(left.id).digest('hex').localeCompare(crypto.createHash('sha256').update(right.id).digest('hex'))).slice(queryOffset, queryOffset + queryLimit)
  : allEvaluatedQueries;
if (!evaluatedQueries.length) throw new Error('No test queries have qrels.');

const database = new Database(':memory:');
database.pragma('journal_mode = OFF');
database.pragma('synchronous = OFF');
database.exec(`CREATE VIRTUAL TABLE morph_fts USING fts5(id UNINDEXED, tokens, tokenize='unicode61 remove_diacritics 0');
CREATE VIRTUAL TABLE raw_fts USING fts5(id UNINDEXED, content, tokenize='unicode61 remove_diacritics 0');
CREATE VIRTUAL TABLE porter_fts USING fts5(id UNINDEXED, content, tokenize='porter unicode61 remove_diacritics 0');`);
const insertMorph = database.prepare('INSERT INTO morph_fts(id,tokens) VALUES (?,?)');
const insertRaw = database.prepare('INSERT INTO raw_fts(id,content) VALUES (?,?)');
const insertPorter = database.prepare('INSERT INTO porter_fts(id,content) VALUES (?,?)');
const insertRows = database.transaction((rows: Array<{ id: string; morph: string; raw: string }>) => {
  for (const row of rows) { insertMorph.run(row.id, row.morph); insertRaw.run(row.id, row.raw); insertPorter.run(row.id, row.raw); }
});
const encodeMorphToken = (token: string) => `m${Buffer.from(token, 'utf8').toString('hex')}`;
const docIds = new Set<string>();
const documentLengths: number[] = [];
const postings = new Map<string, Posting[]>();
const indexStart = performance.now();
const indexedRows: Array<{ id: string; morph: string; raw: string }> = [];
for (let index = 0; index < corpus.length; index++) {
  const doc = corpus[index]!;
  if (!doc._id || docIds.has(doc._id)) throw new Error(`Duplicate or missing corpus ID: ${doc._id}`);
  docIds.add(doc._id);
  const raw = `${doc.title ?? ''} ${doc.text ?? ''}`.normalize('NFKC');
  const tokens = await buildStoredTokenSet(raw);
  const morph = tokens.morphologicalTokens.map(encodeMorphToken).join(' ');
  const tf = new Map<string, number>();
  for (const token of tokens.morphologicalTokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  documentLengths.push(tokens.morphologicalDocLength);
  for (const [term, frequency] of tf) {
    const rows = postings.get(term) ?? [];
    rows.push({ docIndex: index, tf: frequency });
    postings.set(term, rows);
  }
  indexedRows.push({ id: doc._id, morph, raw });
  if (indexedRows.length === 500) { insertRows(indexedRows.splice(0)); }
}
if (indexedRows.length) insertRows(indexedRows);
const missingPositiveQrels = evaluatedQueries.flatMap(query => [...query.judgments]
  .filter(([relevantId, grade]) => grade > 0 && !docIds.has(relevantId))
  .map(([relevantId]) => ({ queryId: query.id, documentId: relevantId })));
const indexBuildMs = performance.now() - indexStart;
const averageLength = documentLengths.reduce((sum, value) => sum + value, 0) / Math.max(documentLengths.length, 1);
const morphStatement = database.prepare('SELECT id, ROW_NUMBER() OVER (ORDER BY bm25(morph_fts), id) AS rank FROM morph_fts WHERE morph_fts MATCH ?');
const rawStatement = database.prepare('SELECT id, ROW_NUMBER() OVER (ORDER BY bm25(raw_fts), id) AS rank FROM raw_fts WHERE raw_fts MATCH ?');
const porterStatement = database.prepare('SELECT id, ROW_NUMBER() OVER (ORDER BY bm25(porter_fts), id) AS rank FROM porter_fts WHERE porter_fts MATCH ?');
const makeExpression = (tokens: readonly string[]) => [...new Set(tokens.map(token => token.trim()).filter(Boolean))].map(token => `"${token.replace(/"/gu, '""')}"`).join(' OR ');
const standardRank = (terms: readonly string[]): string[] => {
  const scores = new Map<number, number>();
  const totalDocs = corpus.length;
  for (const term of new Set(terms)) {
    const rows = postings.get(term) ?? [];
    if (!rows.length) continue;
    const idf = Math.log(1 + (totalDocs - rows.length + 0.5) / (rows.length + 0.5));
    for (const row of rows) {
      const length = documentLengths[row.docIndex]!;
      const denominator = row.tf + 1.2 * (1 - 0.75 + 0.75 * length / Math.max(averageLength, 1));
      scores.set(row.docIndex, (scores.get(row.docIndex) ?? 0) + idf * (row.tf * 2.2) / denominator);
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1] || corpus[a[0]]!._id.localeCompare(corpus[b[0]]!._id)).map(([index]) => corpus[index]!._id);
};
const scoreRrf = (rankedLists: readonly (readonly Ranked[])[]) => {
  const scores = new Map<string, number>();
  for (const list of rankedLists) for (const item of list) scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (60 + item.rank));
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
};
const scoreMetrics = (ids: readonly string[], judgments: Map<string, number>): Metrics => {
  const relevant = new Set([...judgments].filter(([, grade]) => grade > 0).map(([id]) => id));
  const first = ids.findIndex(id => relevant.has(id));
  const top10 = ids.slice(0, 10);
  const dcg = top10.reduce((sum, id, index) => sum + ((2 ** (judgments.get(id) ?? 0)) - 1) / Math.log2(index + 2), 0);
  const ideal = [...judgments.values()].filter(score => score > 0).sort((a, b) => b - a).slice(0, 10)
    .reduce((sum, score, index) => sum + (2 ** score - 1) / Math.log2(index + 2), 0);
  let matched = 0;
  let precisionSum = 0;
  for (let index = 0; index < Math.min(ids.length, 100); index++) if (relevant.has(ids[index]!)) {
    matched++;
    precisionSum += matched / (index + 1);
  }
  return {
    hit1: first === 0 ? 1 : 0,
    hit10: first >= 0 && first < 10 ? 1 : 0,
    recall100: relevant.size ? ids.slice(0, 100).filter(id => relevant.has(id)).length / relevant.size : 0,
    mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0,
    ndcg10: ideal ? dcg / ideal : 0,
    map100: relevant.size ? precisionSum / relevant.size : 0,
  };
};
const results: QueryResult[] = [];
const queryTimes: number[] = [];
let standardMorphFtsTop10Mismatches = 0;
let maxHeapUsedBytes = process.memoryUsage().heapUsed;
for (let index = 0; index < evaluatedQueries.length; index++) {
  const started = performance.now();
  const query = evaluatedQueries[index]!;
  const words = await purposeWords(query.text);
  const parsed = analyzeQuery(query.text, words.length ? words : query.text.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const terms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
  const queryTokens = await buildStoredTokenSet(terms.join(' '));
  const standardIds = standardRank(queryTokens.morphologicalTokens);
  const morph = queryTokens.morphologicalTokens.length
    ? morphStatement.all(makeExpression(queryTokens.morphologicalTokens.map(encodeMorphToken))) as Ranked[]
    : [];
  const raw = terms.length ? rawStatement.all(makeExpression(terms)) as Ranked[] : [];
  const porter = terms.length ? porterStatement.all(makeExpression(terms)) as Ranked[] : [];
  if (JSON.stringify(standardIds.slice(0, 10)) !== JSON.stringify(morph.map(row => row.id).slice(0, 10))) standardMorphFtsTop10Mismatches++;
  const standard = standardIds.map((id, rank) => ({ id, rank: rank + 1 }));
  results.push({
    queryId: query.id,
    groupId: query.groupId,
    parserTermCount: terms.length,
    morphologyQueryTokenCount: queryTokens.morphologicalTokens.length,
    standard: scoreMetrics(standardIds, query.judgments),
    ftsMorph: scoreMetrics(morph.map(row => row.id), query.judgments),
    ftsRaw: scoreMetrics(raw.map(row => row.id), query.judgments),
    ftsPorter: scoreMetrics(porter.map(row => row.id), query.judgments),
    standardMorphRrf: scoreMetrics(scoreRrf([standard, morph]), query.judgments),
    standardMorphRawRrf: scoreMetrics(scoreRrf([standard, morph, raw]), query.judgments),
  });
  queryTimes.push(performance.now() - started);
  maxHeapUsedBytes = Math.max(maxHeapUsedBytes, process.memoryUsage().heapUsed);
  if ((index + 1) % 100 === 0 || index + 1 === evaluatedQueries.length) console.log(`evaluated ${index + 1}/${evaluatedQueries.length}`);
}

const methodNames = ['standard', 'ftsMorph', 'ftsRaw', 'ftsPorter', 'standardMorphRrf', 'standardMorphRawRrf'] as const;
const metricNames = ['hit1', 'hit10', 'recall100', 'mrr10', 'ndcg10', 'map100'] as const;
const means = Object.fromEntries(methodNames.map(method => [method, Object.fromEntries(metricNames.map(metric => [metric,
  results.reduce((sum, row) => sum + row[method][metric], 0) / results.length,
]))]));
const bootstrapDifference = (method: typeof methodNames[number], metric: typeof metricNames[number]) => {
  const deltas = results.map(row => row[method][metric] - row.standard[metric]);
  const groups = new Map<string, number[]>();
  results.forEach((row, index) => groups.set(row.groupId, [...(groups.get(row.groupId) ?? []), deltas[index]!]));
  const clusters = [...groups.values()];
  let seed = Number.parseInt(crypto.createHash('sha256').update(`${datasetName}\0${method}\0${metric}`).digest('hex').slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = new Array<number>(20_000);
  for (let i = 0; i < draws.length; i++) {
    let total = 0;
    let observationCount = 0;
    for (let j = 0; j < clusters.length; j++) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      total += cluster.reduce((sum, value) => sum + value, 0);
      observationCount += cluster.length;
    }
    draws[i] = total / observationCount;
  }
  draws.sort((a, b) => a - b);
  return { meanDifference: deltas.reduce((sum, value) => sum + value, 0) / deltas.length, pairedClusterBootstrap95CI: [draws[499]!, draws[19_499]!], clusterCount: clusters.length };
};
const differences = Object.fromEntries(methodNames.filter(method => method !== 'standard').map(method => [method,
  Object.fromEntries(metricNames.map(metric => [metric, bootstrapDifference(method, metric)])),
]));
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const result = {
  dataset: { name: datasetName, split: 'BEIR official test qrels', documents: corpus.length, queries: results.length, allTestQueries: allEvaluatedQueries.length,
    querySelection: Number.isFinite(queryLimit) ? { method: 'ascending SHA-256 of query ID, selected before metric computation', limit: queryLimit, hashRankOffset: queryOffset, selectedIds: evaluatedQueries.map(query => query.id) } : { method: 'all test qrels', limit: null },
    positiveQrelConnectedComponents: new Set(evaluatedQueries.map(query => query.groupId)).size,
    corpusSha256: hashFile(corpusPath), queriesSha256: hashFile(queriesPath), qrelsSha256: hashFile(qrelsPath) },
  corpusQrelsAudit: { positiveQrelCount: evaluatedQueries.reduce((sum, query) => sum + [...query.judgments.values()].filter(grade => grade > 0).length, 0),
    positiveQrelsAbsentFromCorpus: missingPositiveQrels.length, missingPositiveQrels },
  definitions: {
    standard: 'Independent exact-token BM25 over Kuromoji document tokens and the exact same Kuromoji morphology query tokens used by ftsMorph; k1=1.2,b=0.75; full corpus; app BM25 IDF formula log(1+(N-df+0.5)/(df+0.5)); no custom boosts.',
    ftsMorph: 'SQLite FTS5 bm25() over a reversible hex encoding of each Kuromoji morphology token, guaranteeing one FTS token per exact morphology token for documents and queries; full corpus; SQLite-native IDF and default k1/b.',
    ftsRaw: 'SQLite FTS5 bm25() over original title+text with unicode61 and parser output terms as raw query; full corpus. This is a full tokenization+ranking engine comparison, not an isolated ranker ablation against standard morphology BM25.',
    ftsPorter: 'SQLite FTS5 bm25() over original title+text with the built-in Porter stemming tokenizer over unicode61; parser output terms are submitted unchanged so query and document terms are stemmed by the same FTS tokenizer; full corpus.',
    standardMorphRrf: 'Equal RRF k=60 over standard BM25 and morphology FTS5 ranks.',
    standardMorphRawRrf: 'Equal RRF k=60 over standard BM25, morphology FTS5, and raw FTS5 ranks.',
    queryParser: 'Same purposeWords() and analyzeQuery() functions used by my-search; applied before all rankers.',
    relevant: 'BEIR test qrels with relevance score > 0; nDCG uses graded gains 2^relevance-1; MAP@100 denominator is total relevant documents.',
    evaluationStatus: 'Independent corpora from TOMT development experiments. ArguAna/NFCorpus test sets are new to this harness; treat the multi-method results as exploratory. Positive query-document qrels are clustered by bipartite connected components for paired bootstrap intervals. standard and ftsMorph use exactly the same Kuromoji document/query token strings (ftsMorph hex-encodes each token to prevent SQLite re-tokenization); ftsRaw uses its own unicode61 tokenizer as an end-to-end alternative.',
  },
  rankingAudit: { standardMorphFtsTop10Mismatches, comparedQueries: results.length },
  metrics: means,
  differencesVsStandard: differences,
  resources: { indexingChanged: false, database: ':memory:', indexBuildMs, queryLatencyMs: { p50: percentile(queryTimes, .5), p95: percentile(queryTimes, .95) },
    processRssBytes: process.memoryUsage().rss, processHeapUsedBytes: process.memoryUsage().heapUsed, maxObservedHeapUsedBytes: maxHeapUsedBytes },
  perQuery: results,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, dataset: result.dataset, metrics: result.metrics, differencesVsStandard: result.differencesVsStandard, resources: result.resources }, null, 2));
database.close();
