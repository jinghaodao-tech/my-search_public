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
import { scoreWeightedBm25 } from './bm25_rm3.js';
import { reciprocalRankFusion, scoreQueryLikelihood, type LanguageModelOptions, type LanguageModelPosting } from './language_model_rankers.js';

type Document = { _id: string; title?: string; text?: string };
type Query = { _id: string; text: string };
type Metrics = { hit1: number; hit10: number; mrr10: number; ndcg10: number; map100: number; recall100: number };
type Ranked = { docIndex: number; score: number };
type QueryCase = { id: string; groupId: string; text: string; judgments: Map<string, number> };

const [datasetArg, splitArg, indexArg, outputArg, queryLimitArg] = process.argv.slice(2);
if (!datasetArg || !['dev', 'test'].includes(splitArg ?? '') || !indexArg || !outputArg) {
  throw new Error('Usage: tsx scripts/bench/benchmark_beir_language_models.ts <dataset-dir> <dev|test> <read-only-index.sqlite> <new-output.json> [query-limit]');
}
const queryLimit = queryLimitArg === undefined ? Number.POSITIVE_INFINITY : Number(queryLimitArg);
if (!(queryLimit === Number.POSITIVE_INFINITY || (Number.isInteger(queryLimit) && queryLimit > 0))) throw new Error('query-limit must be a positive integer.');
const datasetDir = path.resolve(datasetArg);
const indexPath = path.resolve(indexArg);
const outputPath = path.resolve(outputArg);
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new path under artifacts/.');
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const queriesPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels', `${splitArg}.tsv`);
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
  const [queryId, docId, gradeText] = line.split('\t');
  if (!queryId || !docId || !queryTexts.has(queryId) || !Number.isFinite(Number(gradeText))) throw new Error(`Invalid qrels row ${lineNumber + 1}.`);
  const grades = qrelMap.get(queryId) ?? new Map<string, number>();
  grades.set(docId, Math.max(grades.get(docId) ?? 0, Number(gradeText)));
  qrelMap.set(queryId, grades);
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
const allQueries: QueryCase[] = [...qrelMap].map(([id, judgments]) => ({
  id, groupId: parents.has(`q:${id}`) ? find(`q:${id}`) : `q:${id}`, text: queryTexts.get(id)!, judgments,
}));
const queries = Number.isFinite(queryLimit)
  ? allQueries.sort((left, right) => crypto.createHash('sha256').update(left.id).digest('hex').localeCompare(crypto.createHash('sha256').update(right.id).digest('hex'))).slice(0, queryLimit)
  : allQueries;
if (!queries.length) throw new Error('No qrels for the selected split.');

const muGrid = [250, 500, 1000, 2000, 4000] as const;
const lambdaGrid = [0.05, 0.1, 0.2, 0.3, 0.5] as const;
const methodNames = ['standard-bm25', ...muGrid.map(mu => `dirichlet-mu-${mu}`), ...lambdaGrid.map(lambda => `jm-lambda-${lambda}`),
  'rrf-bm25-dirichlet-250', 'rrf-bm25-jm-0.5'] as const;
type MethodName = typeof methodNames[number];
const output: Record<MethodName, Array<{ id: string; groupId: string; metrics: Metrics; top10: string[]; top100: string[] }>> = Object.fromEntries(methodNames.map(name => [name, []])) as Record<MethodName, Array<{ id: string; groupId: string; metrics: Metrics; top10: string[]; top100: string[] }>>;
const latency: Record<MethodName, number[]> = Object.fromEntries(methodNames.map(name => [name, []])) as Record<MethodName, number[]>;
const analysisLatency: number[] = [];
const db = new Database(indexPath, { readonly: true, fileMustExist: true });
try {
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`Index integrity_check failed: ${String(integrity)}`);
  const indexedDocuments = db.prepare('SELECT id,length FROM documents ORDER BY id').all() as Array<{ id: string; length: number }>;
  const documentIndex = new Map(indexedDocuments.map((row, index) => [row.id, index]));
  const lengths = indexedDocuments.map(row => row.length);
  const corpusIds = new Set<string>();
  const paritySamples: Array<{ id: string; hash: string; document: Document }> = [];
  for await (const document of readJsonl<Document>(corpusPath)) {
    if (!document._id || corpusIds.has(document._id)) throw new Error(`Missing or duplicate corpus document ID: ${document._id}`);
    corpusIds.add(document._id);
    paritySamples.push({ id: document._id, hash: crypto.createHash('sha256').update(document._id).digest('hex'), document });
    paritySamples.sort((a, b) => a.hash.localeCompare(b.hash));
    if (paritySamples.length > 25) paritySamples.pop();
  }
  if (corpusIds.size !== documentIndex.size || [...corpusIds].some(id => !documentIndex.has(id))) throw new Error('Index document IDs do not exactly match the corpus.');
  const postingByDocument = db.prepare('SELECT term,tf FROM postings WHERE doc_id=? ORDER BY term');
  const tokenParity: boolean[] = [];
  for (const { id, document } of paritySamples) {
    const tokens = await tokenizeMorphological(`${document.title ?? ''} ${document.text ?? ''}`.normalize('NFKC'));
    const expected = new Map<string, number>();
    for (const token of tokens) expected.set(token, (expected.get(token) ?? 0) + 1);
    const stored = new Map((postingByDocument.all(id) as Array<{ term: string; tf: number }>).map(row => [row.term, row.tf]));
    tokenParity.push(expected.size === stored.size && [...expected].every(([term, tf]) => stored.get(term) === tf));
  }
  if (tokenParity.some(matches => !matches)) throw new Error('Deterministic 25-document token parity failed.');

  const collectionLength = lengths.reduce((sum, length) => sum + length, 0);
  const postingCache = new Map<string, LanguageModelPosting[]>();
  const cfCache = new Map<string, number>();
  const getPostingsAndCf = (terms: readonly string[]) => {
    const uniqueTerms = [...new Set(terms)];
    const missing = uniqueTerms.filter(term => !postingCache.has(term));
    for (let offset = 0; offset < missing.length; offset += 300) {
      const batch = missing.slice(offset, offset + 300);
      if (!batch.length) continue;
      const placeholders = batch.map(() => '?').join(',');
      const rows = db.prepare(`SELECT term,doc_id,tf FROM postings WHERE term IN (${placeholders}) ORDER BY term,doc_id`).all(...batch) as Array<{ term: string; doc_id: string; tf: number }>;
      const grouped = new Map<string, LanguageModelPosting[]>();
      const frequencies = new Map<string, number>();
      for (const row of rows) {
        const docIndex = documentIndex.get(row.doc_id);
        if (docIndex === undefined) throw new Error(`Posting references unknown document ${row.doc_id}.`);
        const list = grouped.get(row.term) ?? [];
        list.push({ docIndex, tf: row.tf });
        grouped.set(row.term, list);
        frequencies.set(row.term, (frequencies.get(row.term) ?? 0) + row.tf);
      }
      for (const term of batch) {
        postingCache.set(term, grouped.get(term) ?? []);
        cfCache.set(term, frequencies.get(term) ?? 0);
      }
    }
    return {
      postings: new Map(uniqueTerms.map(term => [term, postingCache.get(term) ?? []])),
      frequencies: new Map(uniqueTerms.map(term => [term, cfCache.get(term) ?? 0])),
    };
  };
  const rankedIds = (ranked: readonly Ranked[]) => ranked.map(row => indexedDocuments[row.docIndex]!.id);
  const metric = (ranked: readonly string[], judgments: Map<string, number>): Metrics => {
    const relevant = new Set([...judgments].filter(([, grade]) => grade > 0).map(([id]) => id));
    const first = ranked.findIndex(id => relevant.has(id));
    const dcg = ranked.slice(0, 10).reduce((sum, id, index) => sum + (2 ** (judgments.get(id) ?? 0) - 1) / Math.log2(index + 2), 0);
    const ideal = [...judgments.values()].filter(grade => grade > 0).sort((a, b) => b - a).slice(0, 10)
      .reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
    let hits = 0; let precisionSum = 0;
    for (const [index, id] of ranked.slice(0, 100).entries()) if (relevant.has(id)) { hits++; precisionSum += hits / (index + 1); }
    return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0,
      mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0,
      map100: relevant.size ? precisionSum / relevant.size : 0, recall100: relevant.size ? hits / relevant.size : 0 };
  };
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
    const query = queries[queryIndex]!;
    const parseStarted = performance.now();
    const words = await purposeWords(query.text);
    const parsed = analyzeQuery(query.text, words.length ? words : query.text.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
    const terms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
    analysisLatency.push(performance.now() - parseStarted);
    const { postings, frequencies } = getPostingsAndCf(terms);

    const bm25Started = performance.now();
    const standard = scoreWeightedBm25(new Map(terms.map(term => [term, 1])), indexedDocuments.length,
      collectionLength / Math.max(indexedDocuments.length, 1), lengths, postings, 1.2, 0.75, 100);
    const standardIds = rankedIds(standard);
    const rankings = new Map<MethodName, string[]>([['standard-bm25', standardIds]]);
    output['standard-bm25'].push({ id: query.id, groupId: query.groupId, metrics: metric(standardIds, query.judgments), top10: standardIds.slice(0, 10), top100: standardIds });
    latency['standard-bm25'].push(performance.now() - bm25Started);

    const configs: Array<{ name: Exclude<MethodName, 'standard-bm25'>; options: LanguageModelOptions }> = [
      ...muGrid.map(mu => ({ name: `dirichlet-mu-${mu}` as const, options: { method: 'dirichlet' as const, mu } })),
      ...lambdaGrid.map(lambda => ({ name: `jm-lambda-${lambda}` as const, options: { method: 'jelinek-mercer' as const, lambda } })),
    ];
    for (const { name, options } of configs) {
      const started = performance.now();
      const ranked = scoreQueryLikelihood(terms, lengths, collectionLength, frequencies, postings, options, 100);
      const ids = rankedIds(ranked);
      rankings.set(name, ids);
      output[name].push({ id: query.id, groupId: query.groupId, metrics: metric(ids, query.judgments), top10: ids.slice(0, 10), top100: ids });
      latency[name].push(performance.now() - started);
    }
    for (const [fusionName, componentName] of [
      ['rrf-bm25-dirichlet-250', 'dirichlet-mu-250'],
      ['rrf-bm25-jm-0.5', 'jm-lambda-0.5'],
    ] as const) {
      const fusionStarted = performance.now();
      const fusedIds = reciprocalRankFusion([rankings.get('standard-bm25')!, rankings.get(componentName)!], 60, 100);
      output[fusionName].push({ id: query.id, groupId: query.groupId, metrics: metric(fusedIds, query.judgments), top10: fusedIds.slice(0, 10), top100: fusedIds });
      latency[fusionName].push(performance.now() - fusionStarted);
    }
    if ((queryIndex + 1) % 10 === 0 || queryIndex + 1 === queries.length) console.log(`evaluated ${queryIndex + 1}/${queries.length}`);
  }

  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
  const metricKeys: (keyof Metrics)[] = ['hit1', 'hit10', 'mrr10', 'ndcg10', 'map100', 'recall100'];
  const groupDiffs = (name: MethodName, key: keyof Metrics) => {
    const grouped = new Map<string, number[]>();
    queries.forEach((query, index) => grouped.set(query.groupId, [...(grouped.get(query.groupId) ?? []), output[name][index]!.metrics[key] - output['standard-bm25'][index]!.metrics[key]]));
    return [...grouped.values()];
  };
  const bootstrap = (name: MethodName, key: keyof Metrics) => {
    const groups = groupDiffs(name, key);
    let seed = Number.parseInt(crypto.createHash('sha256').update(`${path.basename(datasetDir)}|${splitArg}|${name}|${key}`).digest('hex').slice(0, 8), 16) >>> 0;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
    const draws = new Array<number>(10_000);
    for (let draw = 0; draw < draws.length; draw++) {
      let sum = 0; let count = 0;
      for (let index = 0; index < groups.length; index++) {
        const group = groups[Math.floor(random() * groups.length)]!;
        for (const value of group) { sum += value; count++; }
      }
      draws[draw] = count ? sum / count : 0;
    }
    draws.sort((a, b) => a - b);
    return { meanDifference: mean(groups.flat()), clusterCount: groups.length, pairedClusterBootstrap95CI: [draws[249]!, draws[9749]!] };
  };
  const metrics = Object.fromEntries(methodNames.map(name => [name, {
    values: Object.fromEntries(metricKeys.map(key => [key, mean(output[name].map(row => row.metrics[key]))])),
    rankLatencyMs: { p50: percentile(latency[name], 0.5), p95: percentile(latency[name], 0.95) },
    ...(name === 'rrf-bm25-dirichlet-250' || name === 'rrf-bm25-jm-0.5' ? {
      fusedPipelineLatencyMs: {
        p50: percentile(latency[name].map((value, index) => value + latency['standard-bm25'][index]! + latency[name === 'rrf-bm25-dirichlet-250' ? 'dirichlet-mu-250' : 'jm-lambda-0.5'][index]!), 0.5),
        p95: percentile(latency[name].map((value, index) => value + latency['standard-bm25'][index]! + latency[name === 'rrf-bm25-dirichlet-250' ? 'dirichlet-mu-250' : 'jm-lambda-0.5'][index]!), 0.95),
      },
    } : {}),
  }]));
  const differencesVsStandard = Object.fromEntries(methodNames.filter(name => name !== 'standard-bm25').map(name => [name,
    Object.fromEntries((['hit10', 'ndcg10', 'mrr10'] as const).map(key => [key, bootstrap(name, key)]))]));
  const result = {
    dataset: { name: path.basename(datasetDir), split: splitArg, documents: indexedDocuments.length, queries: queries.length,
      querySelection: Number.isFinite(queryLimit) ? { method: 'ascending SHA-256 query-ID order, selected before scoring', limit: queryLimit } : { method: 'all split qrels', limit: null },
      positiveQrelConnectedComponents: new Set(queries.map(query => query.groupId)).size,
      corpusSha256: hashFile(corpusPath), queriesSha256: hashFile(queriesPath), qrelsSha256: hashFile(qrelsPath), indexSha256: hashFile(indexPath), indexPath,
      indexIntegrity: integrity, indexMatchesCorpusIds: true, deterministicTokenParitySample: { size: tokenParity.length, allMatched: true } },
    definitions: {
      standardBm25: 'Shared query parser and exact unique morphology terms, k1=1.2,b=0.75; same read-only postings and exact top-100.',
      dirichlet: 'Exact query-likelihood ranking over every document: sum_t log((tf_td + mu*cf_t/collectionLength)/(docLength+mu)); OOV query terms are omitted consistently with BM25.',
      jelinekMercer: 'Exact query-likelihood ranking over every document: sum_t log((1-lambda)*tf_td/docLength + lambda*cf_t/collectionLength); OOV query terms omitted.',
      fusion: 'RRF k=60 over exact Top-100 lists from standard BM25 and FiQA-selected query-likelihood rankers; union contains at most 200 candidates.',
      parameters: { dirichletMuGrid: muGrid, jelinekMercerLambdaGrid: lambdaGrid },
      evaluationStatus: 'Exploratory fixed-corpus comparison; development data only; candidate parameters require transfer without retuning and independent confirmation before superiority claims.',
    },
    metrics, differencesVsStandard,
    resources: { processRssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
      queryAnalysisMs: { p50: percentile(analysisLatency, 0.5), p95: percentile(analysisLatency, 0.95) },
      postingCacheTerms: postingCache.size, rankingLatencyIncludesAllDocumentScoring: true, rrfUsesCompleteTop100Inputs: true },
    perQuery: queries.map((query, index) => ({ id: query.id, groupId: query.groupId, query: query.text,
      ...Object.fromEntries(methodNames.map(name => [name, output[name][index]])) })),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ outputPath, dataset: result.dataset, metrics: result.metrics, differencesVsStandard: result.differencesVsStandard, resources: result.resources }, null, 2));
} finally {
  db.close();
}
