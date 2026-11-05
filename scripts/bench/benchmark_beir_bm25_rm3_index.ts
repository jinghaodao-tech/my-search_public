import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { tokenizeMorphological } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { buildBo1ExpansionWeights } from './bo1_expansion.js';
import { buildRm3QueryWeights, scoreWeightedBm25 } from './bm25_rm3.js';
import type { Posting } from './bm25_adaptive_tf.js';

type Document = { _id: string; title?: string; text?: string };
type Query = { _id: string; text: string };
type Metrics = { hit1: number; hit10: number; mrr10: number; ndcg10: number; map100: number; recall100: number };
type Ranked = { docIndex: number; score: number };
const [datasetArg, splitArg, indexArg, outputArg, queryLimitArg] = process.argv.slice(2);
if (!datasetArg || splitArg !== 'dev' || !indexArg || !outputArg) {
  throw new Error('Usage: tsx scripts/bench/benchmark_beir_bm25_rm3_index.ts <dataset-dir> dev <read-only-index.sqlite> <new-output.json> [query-limit]');
}
const queryLimit = queryLimitArg === undefined ? Number.POSITIVE_INFINITY : Number(queryLimitArg);
if (!(queryLimit === Number.POSITIVE_INFINITY || (Number.isInteger(queryLimit) && queryLimit > 0))) throw new Error('query-limit must be a positive integer.');
const datasetDir = path.resolve(datasetArg);
const indexPath = path.resolve(indexArg);
const outputPath = path.resolve(outputArg);
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new path under artifacts/.');
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const queriesPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels', 'dev.tsv');
for (const file of [corpusPath, queriesPath, qrelsPath, indexPath]) if (!fs.existsSync(file)) throw new Error(`Missing input: ${file}`);
const hashFile = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJsonl = async function* <T>(file: string): AsyncGenerator<T> {
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line) as T;
};
const queryTexts = new Map<string, string>();
for await (const query of readJsonl<Query>(queriesPath)) queryTexts.set(query._id, query.text);
const qrelMap = new Map<string, Map<string, number>>();
for (const [lineNumber, line] of fs.readFileSync(qrelsPath, 'utf8').split(/\r?\n/u).entries()) {
  if (!line.trim() || line.startsWith('query-id')) continue;
  const [queryId, docId, scoreText] = line.split('\t');
  if (!queryId || !docId || !queryTexts.has(queryId) || !Number.isFinite(Number(scoreText))) throw new Error(`Invalid qrels row ${lineNumber + 1}.`);
  const judgments = qrelMap.get(queryId) ?? new Map<string, number>();
  judgments.set(docId, Math.max(judgments.get(docId) ?? 0, Number(scoreText)));
  qrelMap.set(queryId, judgments);
}
const parents = new Map<string, string>();
const find = (id: string): string => {
  const parent = parents.get(id);
  if (!parent) { parents.set(id, id); return id; }
  if (parent === id) return id;
  const root = find(parent); parents.set(id, root); return root;
};
for (const [queryId, judgments] of qrelMap) for (const [docId, grade] of judgments) if (grade > 0) {
  const queryRoot = find(`q:${queryId}`);
  const docRoot = find(`d:${docId}`);
  if (queryRoot !== docRoot) parents.set(docRoot, queryRoot);
}
const allDevQrels = [...qrelMap].map(([id, judgments]) => ({ id, groupId: parents.has(`q:${id}`) ? find(`q:${id}`) : `q:${id}`, judgments, text: queryTexts.get(id)! }));
const qrels = Number.isFinite(queryLimit)
  ? allDevQrels.sort((left, right) => crypto.createHash('sha256').update(left.id).digest('hex').localeCompare(crypto.createHash('sha256').update(right.id).digest('hex'))).slice(0, queryLimit)
  : allDevQrels;
if (!qrels.length) throw new Error('No dev qrels.');

const db = new Database(indexPath, { readonly: true, fileMustExist: true });
try {
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`Index integrity_check failed: ${String(integrity)}`);
  const indexedDocuments = db.prepare('SELECT id,length FROM documents ORDER BY id').all() as Array<{ id: string; length: number }>;
  const docIndex = new Map(indexedDocuments.map((row, index) => [row.id, index]));
  const lengths = indexedDocuments.map(row => row.length);
  const corpusIds = new Set<string>();
  const paritySamples: Array<{ id: string; document: Document; hash: string }> = [];
  for await (const row of readJsonl<Document>(corpusPath)) {
    if (!row._id || corpusIds.has(row._id)) throw new Error(`Missing or duplicate corpus document ID: ${row._id}`);
    corpusIds.add(row._id);
    const hash = crypto.createHash('sha256').update(row._id).digest('hex');
    paritySamples.push({ id: row._id, document: row, hash });
    paritySamples.sort((left, right) => left.hash.localeCompare(right.hash));
    if (paritySamples.length > 25) paritySamples.pop();
  }
  const indexMatchesCorpusIds = corpusIds.size === docIndex.size && [...corpusIds].every(id => docIndex.has(id));
  if (!indexMatchesCorpusIds) throw new Error('Read-only index document IDs do not exactly match the corpus.');

  const sampleIds = paritySamples.map(sample => sample.id);
  const sampleParity: Array<{ id: string; matches: boolean }> = [];
  const postingByDocument = db.prepare('SELECT term,tf FROM postings WHERE doc_id=? ORDER BY term');
  for (const { id: sampleId, document: sample } of paritySamples) {
    const tokens = await tokenizeMorphological(`${sample.title ?? ''} ${sample.text ?? ''}`.normalize('NFKC'));
    const expected = new Map<string, number>();
    for (const token of tokens) expected.set(token, (expected.get(token) ?? 0) + 1);
    const stored = new Map((postingByDocument.all(sampleId) as Array<{ term: string; tf: number }>).map(row => [row.term, row.tf]));
    const matches = expected.size === stored.size && [...expected].every(([term, tf]) => stored.get(term) === tf);
    sampleParity.push({ id: sampleId, matches });
  }
  if (sampleParity.some(row => !row.matches)) throw new Error('Read-only index morphology-token parity sample failed.');

  const averageLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(lengths.length, 1);
  const collectionLength = lengths.reduce((sum, value) => sum + value, 0);
  const postingCache = new Map<string, Posting[]>();
  const collectionFrequencyCache = new Map<string, number>();
  const maximumCachedPostingRows = 1_000_000;
  let cachedPostingRows = 0;
  let postingCacheHits = 0;
  let postingCacheMisses = 0;
  const getPostings = (terms: readonly string[]) => {
    const results = new Map<string, Posting[]>();
    const unique = [...new Set(terms)];
    const missing: string[] = [];
    for (const term of unique) {
      const cached = postingCache.get(term);
      if (cached) {
        postingCache.delete(term);
        postingCache.set(term, cached);
        results.set(term, cached);
        postingCacheHits++;
      } else {
        missing.push(term);
        postingCacheMisses++;
      }
    }
    for (let offset = 0; offset < missing.length; offset += 400) {
      const batch = missing.slice(offset, offset + 400);
      if (!batch.length) continue;
      const grouped = new Map<string, Posting[]>();
      const rows = db.prepare(`SELECT term,doc_id,tf FROM postings WHERE term IN (${batch.map(() => '?').join(',')}) ORDER BY term,doc_id`).all(...batch) as Array<{ term: string; doc_id: string; tf: number }>;
      for (const row of rows) {
        const index = docIndex.get(row.doc_id);
        if (index === undefined) throw new Error(`Posting refers to a missing document: ${row.doc_id}`);
        const postingRows = grouped.get(row.term) ?? [];
        postingRows.push({ docIndex: index, tf: row.tf });
        grouped.set(row.term, postingRows);
      }
      for (const term of batch) {
        const postingRows = grouped.get(term) ?? [];
        results.set(term, postingRows);
        if (postingRows.length > maximumCachedPostingRows) continue;
        while (cachedPostingRows + postingRows.length > maximumCachedPostingRows && postingCache.size) {
          const oldest = postingCache.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          cachedPostingRows -= postingCache.get(oldest)!.length;
          postingCache.delete(oldest);
        }
        if (cachedPostingRows + postingRows.length <= maximumCachedPostingRows) {
          postingCache.set(term, postingRows);
          cachedPostingRows += postingRows.length;
        }
      }
    }
    return results;
  };
  const getCollectionFrequencies = (terms: readonly string[]) => {
    const results = new Map<string, number>();
    const unique = [...new Set(terms)];
    const missing = unique.filter(term => !collectionFrequencyCache.has(term));
    for (const term of unique) if (collectionFrequencyCache.has(term)) results.set(term, collectionFrequencyCache.get(term)!);
    for (let offset = 0; offset < missing.length; offset += 400) {
      const batch = missing.slice(offset, offset + 400);
      if (!batch.length) continue;
      const rows = db.prepare(`SELECT term,SUM(tf) AS cf FROM postings WHERE term IN (${batch.map(() => '?').join(',')}) GROUP BY term`).all(...batch) as Array<{ term: string; cf: number }>;
      for (const row of rows) collectionFrequencyCache.set(row.term, row.cf);
      for (const term of batch) if (!collectionFrequencyCache.has(term)) collectionFrequencyCache.set(term, 0);
      for (const term of batch) results.set(term, collectionFrequencyCache.get(term)!);
    }
    return results;
  };
  const scoreWeightedBm25InSql = (weights: ReadonlyMap<string, number>, limit = 100) => {
    const terms = [...weights].filter(([, weight]) => weight > 0);
    if (!terms.length) return [] as Ranked[];
    const dfRows = db.prepare(`SELECT term,COUNT(*) AS df FROM postings WHERE term IN (${terms.map(() => '?').join(',')}) GROUP BY term`)
      .all(...terms.map(([term]) => term)) as Array<{ term: string; df: number }>;
    const documentFrequencies = new Map(dfRows.map(row => [row.term, row.df]));
    const weightedIdfs = terms.flatMap(([term, weight]) => {
      const df = documentFrequencies.get(term);
      if (!df) return [];
      return [{ term, weightedIdf: weight * Math.log(1 + (indexedDocuments.length - df + 0.5) / (df + 0.5)) }];
    });
    if (!weightedIdfs.length) return [] as Ranked[];
    const valueRows = weightedIdfs.map(() => '(?,?)').join(',');
    const values = weightedIdfs.flatMap(row => [row.term, row.weightedIdf]);
    const rows = db.prepare(`
      WITH query_terms(term,weighted_idf) AS (VALUES ${valueRows})
      SELECT d.id AS id,
        SUM(q.weighted_idf * ((p.tf * 2.2) / (p.tf + 1.2 * (0.25 + 0.75 * d.length / ?)))) AS score
      FROM query_terms q
      JOIN postings p ON p.term=q.term
      JOIN documents d ON d.id=p.doc_id
      GROUP BY d.id
      ORDER BY score DESC,d.id ASC
      LIMIT ?
    `).all(...values, averageLength, limit) as Array<{ id: string; score: number }>;
    return rows.map(row => {
      const index = docIndex.get(row.id);
      if (index === undefined) throw new Error(`SQL scorer returned an unknown document: ${row.id}`);
      return { docIndex: index, score: row.score };
    });
  };
  const metric = (rankedIds: readonly string[], judgments: Map<string, number>): Metrics => {
    const relevant = new Set([...judgments].filter(([, grade]) => grade > 0).map(([id]) => id));
    const first = rankedIds.findIndex(id => relevant.has(id));
    const dcg = rankedIds.slice(0, 10).reduce((sum, id, index) => sum + (2 ** (judgments.get(id) ?? 0) - 1) / Math.log2(index + 2), 0);
    const ideal = [...judgments.values()].filter(grade => grade > 0).sort((a, b) => b - a).slice(0, 10)
      .reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
    let hits = 0; let precisionSum = 0;
    for (const [index, id] of rankedIds.slice(0, 100).entries()) if (relevant.has(id)) { hits++; precisionSum += hits / (index + 1); }
    return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0,
      mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0,
      map100: relevant.size ? precisionSum / relevant.size : 0, recall100: relevant.size ? hits / relevant.size : 0 };
  };

  const output: Record<'standard' | 'bo1' | 'rm3', Array<{ id: string; groupId: string; metrics: Metrics; top10: string[] }>> = { standard: [], bo1: [], rm3: [] };
  const latency: Record<'standard' | 'bo1' | 'rm3', number[]> = { standard: [], bo1: [], rm3: [] };
  const analysisMs: number[] = [];
  let queriesWithOutOfVocabularyTerms = 0;
  let outOfVocabularyQueryTermCount = 0;
  let sqlParityQueryCount = 0;
  for (let queryIndex = 0; queryIndex < qrels.length; queryIndex++) {
    const query = qrels[queryIndex]!;
    const analysisStarted = performance.now();
    const words = await purposeWords(query.text);
    const parsed = analyzeQuery(query.text, words.length ? words : query.text.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
    const terms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
    analysisMs.push(performance.now() - analysisStarted);
    const firstPassStarted = performance.now();
    const queryPostings = getPostings(terms);
    const initialRanked = scoreWeightedBm25(new Map(terms.map(term => [term, 1])), indexedDocuments.length, averageLength, lengths, queryPostings, 1.2, 0.75, 100);
    const firstPassMs = performance.now() - firstPassStarted;
    const ids = (ranked: readonly Ranked[]) => ranked.map(row => indexedDocuments[row.docIndex]!.id);
    const standardIds = ids(initialRanked);
    output.standard.push({ id: query.id, groupId: query.groupId, metrics: metric(standardIds, query.judgments), top10: standardIds.slice(0, 10) });
    latency.standard.push(firstPassMs);

    const feedbackStarted = performance.now();
    const feedbackRanked = initialRanked.slice(0, 10);
    const feedbackIds = feedbackRanked.map(row => indexedDocuments[row.docIndex]!.id);
    const feedbackRows = feedbackIds.length
      ? db.prepare(`SELECT term,doc_id,tf FROM postings WHERE doc_id IN (${feedbackIds.map(() => '?').join(',')}) ORDER BY doc_id,term`).all(...feedbackIds) as Array<{ term: string; doc_id: string; tf: number }>
      : [];
    const localDocumentById = new Map(feedbackIds.map((id, index) => [id, index]));
    const feedbackDocuments = feedbackIds.map((id, index) => ({ length: lengths[docIndex.get(id)!]!, termFrequencies: new Map<string, number>(), sourceIndex: index }));
    for (const row of feedbackRows) feedbackDocuments[localDocumentById.get(row.doc_id)!]!.termFrequencies.set(row.term, row.tf);
    const feedbackTerms = [...new Set(feedbackDocuments.flatMap(document => [...document.termFrequencies.keys()]))];
    const collectionFrequencies = getCollectionFrequencies([...terms, ...feedbackTerms]);
    const outOfVocabularyTerms = terms.filter(term => !((collectionFrequencies.get(term) ?? 0) > 0));
    if (outOfVocabularyTerms.length) queriesWithOutOfVocabularyTerms++;
    outOfVocabularyQueryTermCount += outOfVocabularyTerms.length;
    const feedbackPreparationMs = performance.now() - feedbackStarted;
    const allFeedbackTf = new Map<string, number>();
    for (const document of feedbackDocuments) for (const [term, tf] of document.termFrequencies) allFeedbackTf.set(term, (allFeedbackTf.get(term) ?? 0) + tf);

    const bo1Started = performance.now();
    const bo1Expansion = buildBo1ExpansionWeights(allFeedbackTf, collectionFrequencies, indexedDocuments.length, new Set(terms), 10);
    const bo1Weights = new Map(terms.map(term => [term, 1]));
    for (const [term, weight] of bo1Expansion) bo1Weights.set(term, weight);
    const bo1Postings = getPostings([...bo1Weights.keys()]);
    const bo1Ranked = scoreWeightedBm25(bo1Weights, indexedDocuments.length, averageLength, lengths, bo1Postings, 1.2, 0.75, 100);
    const bo1Ids = ids(bo1Ranked);
    output.bo1.push({ id: query.id, groupId: query.groupId, metrics: metric(bo1Ids, query.judgments), top10: bo1Ids.slice(0, 10) });
    latency.bo1.push(firstPassMs + feedbackPreparationMs + performance.now() - bo1Started);

    const rm3Started = performance.now();
    const rm3Weights = buildRm3QueryWeights(terms, feedbackDocuments.map((_, index) => ({ docIndex: index })), feedbackDocuments,
      indexedDocuments.length, collectionLength, collectionFrequencies);
    const rm3Ranked = scoreWeightedBm25InSql(rm3Weights, 100);
    const rm3Ids = ids(rm3Ranked);
    if (sqlParityQueryCount < 3) {
      const rm3Postings = getPostings([...rm3Weights.keys()]);
      const javascriptRanked = scoreWeightedBm25(rm3Weights, indexedDocuments.length, averageLength, lengths, rm3Postings, 1.2, 0.75, 100);
      const sameTopK = rm3Ranked.length === javascriptRanked.length && rm3Ranked.every((row, index) => {
        const jsRow = javascriptRanked[index]!;
        return row.docIndex === jsRow.docIndex && Math.abs(row.score - jsRow.score) <= 1e-10 * Math.max(1, Math.abs(jsRow.score));
      });
      if (!sameTopK) {
        throw new Error(`SQL and JavaScript RM3 ranking parity failed for query ${query.id}.`);
      }
      sqlParityQueryCount++;
    }
    output.rm3.push({ id: query.id, groupId: query.groupId, metrics: metric(rm3Ids, query.judgments), top10: rm3Ids.slice(0, 10) });
    latency.rm3.push(firstPassMs + feedbackPreparationMs + performance.now() - rm3Started);
    if ((queryIndex + 1) % 10 === 0 || queryIndex + 1 === qrels.length) console.log(`evaluated ${queryIndex + 1}/${qrels.length} queries`);
  }

  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
  const metricKeys: (keyof Metrics)[] = ['hit1', 'hit10', 'mrr10', 'ndcg10', 'map100', 'recall100'];
  const bootstrap = (mode: 'bo1' | 'rm3', key: keyof Metrics) => {
    const groupDiffs = new Map<string, number[]>();
    qrels.forEach((row, index) => groupDiffs.set(row.groupId, [...(groupDiffs.get(row.groupId) ?? []), output[mode][index]!.metrics[key] - output.standard[index]!.metrics[key]]));
    const groups = [...groupDiffs.values()];
    let seed = Number.parseInt(crypto.createHash('sha256').update(`${path.basename(datasetDir)}|${mode}|${key}`).digest('hex').slice(0, 8), 16) >>> 0;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
    const draws = new Array<number>(20_000);
    for (let draw = 0; draw < draws.length; draw++) {
      let total = 0; let count = 0;
      for (let i = 0; i < groups.length; i++) { const group = groups[Math.floor(random() * groups.length)]!; total += group.reduce((sum, value) => sum + value, 0); count += group.length; }
      draws[draw] = total / count;
    }
    draws.sort((a, b) => a - b);
    return { meanDifference: mean([...groupDiffs.values()].flat()), clusterCount: groups.length, pairedClusterBootstrap95CI: [draws[499]!, draws[19_499]!] };
  };
  const result = {
    dataset: { name: path.basename(datasetDir), split: 'BEIR dev', documents: indexedDocuments.length, queries: qrels.length,
      allDevQueries: allDevQrels.length, querySelection: Number.isFinite(queryLimit)
        ? { method: 'ascending SHA-256 of query ID, selected before metric computation', limit: queryLimit, selectedIds: qrels.map(row => row.id) }
        : { method: 'all development qrels', limit: null },
      positiveQrelConnectedComponents: new Set(qrels.map(row => row.groupId)).size,
      queryVocabularyAudit: { queriesWithOutOfVocabularyTerms, outOfVocabularyQueryTermCount },
      corpusSha256: hashFile(corpusPath), queriesSha256: hashFile(queriesPath), qrelsSha256: hashFile(qrelsPath),
      indexSha256: hashFile(indexPath), indexPath, sqliteIntegrityCheck: integrity, indexMatchesCorpusIds,
      sqlScorerParity: { verifiedQueries: sqlParityQueryCount, method: 'identical top-100 document order and score tolerance <= 1e-10 * max(1, abs(score)) against JavaScript weighted BM25' },
      tokenParitySample: { count: sampleParity.length, allMatched: sampleParity.every(row => row.matches), sampleIds, rows: sampleParity } },
    definitions: {
      standard: 'Shared query analysis; positive-smoothed BM25 k1=1.2,b=0.75 over the indexed full Kuromoji morphology corpus.',
      bo1: 'Bo1-style comparison variant using the same read-only postings, exact shared query analysis, top 10 feedback documents, and top 10 expansion terms; this is not the existing top 3 feedback-document configuration.',
      rm3: 'RM3-style model fixed before metrics: standard BM25 top 10; Dirichlet mu=1000 query-likelihood posterior; top 10 non-query expansion terms; 0.5 original-query / 0.5 feedback interpolation; full-corpus weighted BM25 rerank.',
      evaluationStatus: 'Exploratory dev comparison. The benchmark index is opened read-only; full document ID parity and a deterministic 25-document exact token-frequency parity sample were verified, not a full re-tokenization of every document.',
    },
    metrics: Object.fromEntries((['standard', 'bo1', 'rm3'] as const).map(mode => [mode, {
      values: Object.fromEntries(metricKeys.map(key => [key, mean(output[mode].map(row => row.metrics[key]))])),
      rankLatencyMs: { p50: percentile(latency[mode], 0.5), p95: percentile(latency[mode], 0.95) },
    }])),
    differencesVsStandard: Object.fromEntries((['bo1', 'rm3'] as const).map(mode => [mode, Object.fromEntries(metricKeys.map(key => [key, bootstrap(mode, key)]))])),
    resources: { indexOpenedReadOnly: true, processRssBytes: process.memoryUsage().rss, processHeapUsedBytes: process.memoryUsage().heapUsed,
      indexBuildMs: null, postingCache: { maximumRows: maximumCachedPostingRows, cachedRows: cachedPostingRows,
        cachedTerms: postingCache.size, hits: postingCacheHits, misses: postingCacheMisses },
      queryAnalysisMs: { p50: percentile(analysisMs, 0.5), p95: percentile(analysisMs, 0.95) } },
    perQuery: qrels.map((row, index) => ({ id: row.id, groupId: row.groupId, query: row.text, standard: output.standard[index], bo1: output.bo1[index], rm3: output.rm3[index] })),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ outputPath, dataset: result.dataset, metrics: result.metrics, differencesVsStandard: result.differencesVsStandard, resources: result.resources }, null, 2));
} finally {
  db.close();
}
