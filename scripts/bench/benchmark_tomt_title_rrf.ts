import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { buildStoredTokenSet } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';

type Query = { id: string; query: string; gold_ids: string[]; group_id: string; split: string };
type Doc = { id: string; morphological_tokens_json: string; morphological_doc_length: number };
type Ranked = { id: string; rank: number };
type Metric = { hit1: number; hit10: number; mrr10: number; ndcg10: number };
type Bm25IdfMode = 'smoothPositive' | 'rsjZero' | 'rsjEpsilon';
const [datasetArg, databaseArg, outputArg, ...options] = process.argv.slice(2);
if (!datasetArg || !databaseArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_tomt_title_rrf.ts <dataset-dir> <isolated-db> <new-output.json> --source-results=<used-dev-results.json> OR --offset=N --groups=N --weight=W');
const option = (prefix: string) => options.find(value => value.startsWith(`${prefix}=`))?.slice(prefix.length + 1);
const datasetDir = path.resolve(datasetArg);
const datasetLabel = `Reddit-TOMT ${path.basename(datasetDir).replace(/^./, value => value.toUpperCase())}`;
const databasePath = path.resolve(databaseArg);
const outputPath = path.resolve(outputArg);
if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite ${outputPath}`);
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('Output must be under artifacts/.');
const sourceResultsPath = option('--source-results');
const referenceStandardPath = option('--reference-standard');
const sampleOffset = Number(option('--offset') ?? 0);
const groupLimit = Number(option('--groups') ?? 0);
const fixedWeight = option('--weight') === undefined ? undefined : Number(option('--weight'));
const maxTitleCandidates = option('--max-title-candidates') === undefined ? undefined : Number(option('--max-title-candidates'));
if (sourceResultsPath && (groupLimit || option('--offset') !== undefined || fixedWeight !== undefined)) throw new Error('Exploration mode takes only --source-results.');
if (!sourceResultsPath && (!Number.isInteger(sampleOffset) || sampleOffset < 0 || !Number.isInteger(groupLimit) || groupLimit < 2 || !Number.isFinite(fixedWeight) || fixedWeight! < 0)) throw new Error('Confirmation mode requires valid --offset, --groups and non-negative --weight.');
if (maxTitleCandidates !== undefined && (!Number.isInteger(maxTitleCandidates) || maxTitleCandidates < 0 || sourceResultsPath)) throw new Error('Title candidate gate must be a non-negative integer and is only supported in fixed-sample mode.');

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const readJsonl = <T>(file: string): T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
const allQueries = readJsonl<Query>(path.join(datasetDir, 'development.jsonl'));
const referenceRows = referenceStandardPath
  ? new Map((JSON.parse(fs.readFileSync(path.resolve(referenceStandardPath), 'utf8')) as { results: Array<{ qid: string; parserTerms: string[]; top10: string[] }> }).results.map(row => [row.qid, row]))
  : null;
let queries: Query[];
let selection: Record<string, unknown>;
if (sourceResultsPath) {
  const previous = JSON.parse(fs.readFileSync(path.resolve(sourceResultsPath), 'utf8')) as { perQuery: Array<Pick<Query, 'id' | 'query' | 'gold_ids' | 'group_id'>> };
  queries = previous.perQuery.map(row => ({ ...row, split: 'development' }));
  selection = { kind: 'previously consumed development sample; exploratory only', source: path.resolve(sourceResultsPath), queries: queries.length, groups: new Set(queries.map(row => row.group_id)).size };
} else {
  const byGroup = new Map<string, Query[]>();
  for (const query of allQueries) byGroup.set(query.group_id, [...(byGroup.get(query.group_id) ?? []), query]);
  const ordered = [...byGroup.keys()].sort((a, b) => hash(a).localeCompare(hash(b)));
  const selectedGroupIds = ordered.slice(sampleOffset, sampleOffset + groupLimit);
  if (selectedGroupIds.length !== groupLimit) throw new Error('Not enough development target groups for the fixed sample.');
  queries = selectedGroupIds.map(group => byGroup.get(group)!.sort((a, b) => hash(`${group}\0${a.id}`).localeCompare(hash(`${group}\0${b.id}`)))[0]!);
  selection = { kind: 'fixed hash-ordered development groups; one query per target group; labels and scores not used', offset: sampleOffset, groups: groupLimit, queryIdsSha256: hash(queries.map(row => `${row.group_id}\t${row.id}`).sort().join('\n')) };
}
if (!queries.length || queries.some(query => query.split !== 'development' || query.gold_ids.length === 0)) throw new Error('Expected non-empty development queries with relevance labels.');
const sourceDocCount = JSON.parse(fs.readFileSync(path.join(datasetDir, 'provenance.json'), 'utf8')).documents as number;
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const docs = db.prepare('SELECT id, morphological_tokens_json, morphological_doc_length FROM cards WHERE archived=0 ORDER BY id').all() as Doc[];
if (docs.length !== sourceDocCount) throw new Error(`Expected ${sourceDocCount} documents in the isolated DB; found ${docs.length}.`);
const ftsCounts = ['cards_morph_fts', 'cards_ngram_fts', 'cards_fts'].map(table => Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count));
if (ftsCounts.some(count => count !== docs.length)) throw new Error(`FTS index is incomplete: ${ftsCounts.join(',')}`);

const documentLengths: number[] = [];
const postings = new Map<string, Array<{ index: number; tf: number }>>();
for (let index = 0; index < docs.length; index++) {
  const tokens = JSON.parse(docs[index]!.morphological_tokens_json || '[]') as string[];
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  const length = docs[index]!.morphological_doc_length || tokens.length;
  documentLengths.push(length);
  for (const [term, frequency] of tf) {
    let rows = postings.get(term);
    if (!rows) { rows = []; postings.set(term, rows); }
    rows.push({ index, tf: frequency });
  }
}
const averageLength = documentLengths.reduce((sum, length) => sum + length, 0) / docs.length;
const rawIdfByTerm = new Map([...postings].map(([term, rows]) => [term, Math.log((docs.length - rows.length + 0.5) / (rows.length + 0.5))]));
const averageRawIdf = [...rawIdfByTerm.values()].reduce((sum, value) => sum + value, 0) / Math.max(rawIdfByTerm.size, 1);
const selectRanks = (table: 'cards_morph_fts' | 'cards_ngram_fts' | 'cards_fts', expression: string, titleOnly = false): Ranked[] => {
  const order = table === 'cards_fts' && titleOnly
    ? 'bm25(cards_fts, 0.0, 1.0, 0.0, 0.0, 0.0)'
    : `bm25(${table})`;
  return db.prepare(`SELECT id, ROW_NUMBER() OVER (ORDER BY ${order}, id) AS rank FROM ${table} WHERE ${table} MATCH ?`).all(expression) as Ranked[];
};
const ftsExpression = (tokens: readonly string[]) => [...new Set(tokens.map(token => token.trim()).filter(Boolean))].map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ');
const titleExpression = (tokens: readonly string[]) => `title : (${ftsExpression(tokens)})`;
const reciprocal = (rank: number, weight = 1) => weight / (60 + rank);
const scoreRankedLists = (lists: Ranked[][], titleList: Ranked[] | null, weight: number): string[] => {
  const scores = new Map<string, number>();
  for (const list of lists) for (const row of list) scores.set(row.id, (scores.get(row.id) ?? 0) + reciprocal(row.rank));
  if (titleList) for (const row of titleList) scores.set(row.id, (scores.get(row.id) ?? 0) + reciprocal(row.rank, weight));
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
};
const standardRank = (terms: readonly string[], idfMode: Bm25IdfMode = 'smoothPositive'): string[] => {
  const scores = new Map<number, number>();
  const n = docs.length;
  for (const term of new Set(terms)) {
    const rows = postings.get(term) ?? [];
    if (!rows.length) continue;
    const df = rows.length;
    const rawIdf = rawIdfByTerm.get(term)!;
    const idf = idfMode === 'smoothPositive' ? Math.log((n - df + 0.5) / (df + 0.5) + 1)
      : rawIdf > 0 ? rawIdf : idfMode === 'rsjZero' ? 0 : Math.max(0, 0.25 * averageRawIdf);
    for (const row of rows) {
      const length = documentLengths[row.index]!;
      const tf = row.tf;
      const termScore = idf * (tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * length / Math.max(averageLength, 1)));
      scores.set(row.index, (scores.get(row.index) ?? 0) + termScore);
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1] || docs[a[0]]!.id.localeCompare(docs[b[0]]!.id)).map(([index]) => docs[index]!.id);
};
const metric = (ids: readonly string[], goldIds: readonly string[]): Metric => {
  const gold = new Set(goldIds);
  const rank = ids.findIndex(id => gold.has(id));
  const top = ids.slice(0, 10);
  const dcg = top.reduce((sum, id, index) => sum + (gold.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(gold.size, 10) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
  return { hit1: rank === 0 ? 1 : 0, hit10: rank >= 0 && rank < 10 ? 1 : 0, mrr10: rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0, ndcg10: ideal ? dcg / ideal : 0 };
};
const mean = (rows: Metric[]): Metric => ({ hit1: rows.reduce((sum, row) => sum + row.hit1, 0), hit10: rows.reduce((sum, row) => sum + row.hit10, 0), mrr10: rows.reduce((sum, row) => sum + row.mrr10, 0) / rows.length, ndcg10: rows.reduce((sum, row) => sum + row.ndcg10, 0) / rows.length });

const evaluated: Array<{ query: Query; standard: Metric; currentFts: Metric; variants: Record<string, Metric>; bm25IdfVariants: Record<string, Metric>; bm25IdfTop10: Record<string, string[]>; standardTop10: string[]; currentFtsTop10: string[]; titleTop10: Record<string, string[]>; signalTop10: Record<string, string[]>; parserTerms: string[]; titleCandidateCount: number; titleSignalUsed: boolean; candidateDiagnostics: Record<string, { count: number; goldRecall: number }>; latencyMs: number }> = [];
let parserReferenceMismatches = 0;
let standardTop10ReferenceMismatches = 0;
const sweepWeights = sourceResultsPath ? [0, 0.1, 0.25, 0.5, 1] : [fixedWeight!];
for (let index = 0; index < queries.length; index++) {
  const query = queries[index]!;
  const started = performance.now();
  const words = await purposeWords(query.query);
  const analysis = analyzeQuery(query.query, words.length ? words : query.query.split(/\s+/).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const queryTerms = [...new Set(analysis.keywords.map(keyword => keyword.term))];
  const tokenSet = await buildStoredTokenSet(queryTerms.join(' '));
  const morph = tokenSet.morphologicalTokens.length ? selectRanks('cards_morph_fts', ftsExpression(tokenSet.morphologicalTokens)) : [];
  const ngram = tokenSet.ngramTokens.length ? selectRanks('cards_ngram_fts', ftsExpression(tokenSet.ngramTokens)) : [];
  const raw = queryTerms.length ? selectRanks('cards_fts', ftsExpression(queryTerms)) : [];
  const title = queryTerms.length ? selectRanks('cards_fts', titleExpression(queryTerms), true) : [];
  const useTitleSignal = maxTitleCandidates === undefined || title.length <= maxTitleCandidates;
  const baseLists = [morph, ngram, raw];
  const currentIds = scoreRankedLists(baseLists, null, 0);
  const standardIds = standardRank(queryTerms);
  const bm25IdfTop10 = Object.fromEntries((['rsjZero', 'rsjEpsilon'] as const).map(mode => [mode, standardRank(queryTerms, mode).slice(0, 10)]));
  const bm25IdfVariants = Object.fromEntries(Object.entries(bm25IdfTop10).map(([mode, ids]) => [mode, metric(ids, query.gold_ids)]));
  const standardRanked = standardIds.map((id, rank) => ({ id, rank: rank + 1 }));
  const candidateSets: Record<string, Set<string>> = {
    morphology: new Set(morph.map(row => row.id)),
    raw: new Set(raw.map(row => row.id)),
    morphologyRaw: new Set([...morph, ...raw].map(row => row.id)),
    morphologyNgramRaw: new Set([...morph, ...ngram, ...raw].map(row => row.id)),
  };
  const candidateDiagnostics = Object.fromEntries(Object.entries(candidateSets).map(([name, ids]) => [name, {
    count: ids.size,
    goldRecall: query.gold_ids.filter(id => ids.has(id)).length / query.gold_ids.length,
  }]));
  const reference = referenceRows?.get(query.id);
  if (reference) {
    const parserTermsMatch = JSON.stringify(queryTerms) === JSON.stringify(reference.parserTerms);
    if (!parserTermsMatch) parserReferenceMismatches++;
    if (JSON.stringify(standardIds.slice(0, 10)) !== JSON.stringify(reference.top10)) standardTop10ReferenceMismatches++;
  }
  const variants: Record<string, Metric> = {};
  const titleTop10: Record<string, string[]> = {};
  const signalLists: Record<string, Ranked[][]> = {
    morphologyOnly: [[...morph]],
    ngramOnly: [[...ngram]],
    rawOnly: [[...raw]],
    morphologyNgram: [[...morph], [...ngram]],
    morphologyRaw: [[...morph], [...raw]],
    ngramRaw: [[...ngram], [...raw]],
    allThree: baseLists,
  };
  const standardFusionLists: Record<string, Ranked[][]> = {
    standardPlusMorphology: [standardRanked, morph],
    standardPlusNgram: [standardRanked, ngram],
    standardPlusRaw: [standardRanked, raw],
    standardPlusMorphologyRaw: [standardRanked, morph, raw],
  };
  const signalTop10: Record<string, string[]> = {};
  for (const weight of sweepWeights) {
    const candidate = scoreRankedLists(baseLists, weight > 0 && useTitleSignal ? title : null, weight);
    variants[String(weight)] = metric(candidate, query.gold_ids);
    titleTop10[String(weight)] = candidate.slice(0, 10);
  }
  for (const [name, lists] of Object.entries(signalLists)) {
    const candidate = scoreRankedLists(lists, null, 0);
    variants[`signals_${name}`] = metric(candidate, query.gold_ids);
    signalTop10[name] = candidate.slice(0, 10);
  }
  for (const [name, lists] of Object.entries(standardFusionLists)) {
    const candidate = scoreRankedLists(lists, null, 0);
    variants[name] = metric(candidate, query.gold_ids);
    signalTop10[name] = candidate.slice(0, 10);
  }
  evaluated.push({ query, standard: metric(standardIds, query.gold_ids), currentFts: metric(currentIds, query.gold_ids), variants, bm25IdfVariants, bm25IdfTop10,
    standardTop10: standardIds.slice(0, 10), currentFtsTop10: currentIds.slice(0, 10), titleTop10, parserTerms: queryTerms,
    signalTop10, titleCandidateCount: title.length, titleSignalUsed: useTitleSignal, candidateDiagnostics, latencyMs: performance.now() - started });
  if ((index + 1) % 100 === 0 || index + 1 === queries.length) console.log(`evaluated ${index + 1}/${queries.length}`);
}

const compare = (candidate: 'currentFts' | string): { both: number; baselineOnly: number; candidateOnly: number; neither: number; difference: number; clusterBootstrap95CI: [number, number] } => {
  const candidateMetric = (row: typeof evaluated[number]) => candidate === 'currentFts' ? row.currentFts
    : candidate.startsWith('bm25Idf_') ? row.bm25IdfVariants[candidate.slice('bm25Idf_'.length)]!
      : row.variants[candidate]!;
  const values = evaluated.map(row => ({ group: row.query.group_id, baseline: row.standard.hit10, candidate: candidateMetric(row).hit10 }));
  const both = values.filter(row => row.baseline && row.candidate).length;
  const baselineOnly = values.filter(row => row.baseline && !row.candidate).length;
  const candidateOnly = values.filter(row => !row.baseline && row.candidate).length;
  const neither = values.length - both - baselineOnly - candidateOnly;
  const groups = new Map<string, typeof values>();
  for (const row of values) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  let seed = 0x41ab22d3;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
  const samples: number[] = [];
  const groupRows = [...groups.values()];
  for (let iteration = 0; iteration < 10_000; iteration++) {
    let delta = 0;
    for (let draw = 0; draw < groupRows.length; draw++) {
      const rows = groupRows[Math.floor(random() * groupRows.length)]!;
      delta += rows.reduce((sum, row) => sum + Number(row.candidate) - Number(row.baseline), 0) / rows.length;
    }
    samples.push(delta / groupRows.length);
  }
  samples.sort((a, b) => a - b);
  return { both, baselineOnly, candidateOnly, neither, difference: (candidateOnly - baselineOnly) / values.length,
    clusterBootstrap95CI: [samples[Math.floor(0.025 * (samples.length - 1))]!, samples[Math.floor(0.975 * (samples.length - 1))]!] };
};
const summaries: Record<string, Metric> = { standardMorphologyBm25: mean(evaluated.map(row => row.standard)), currentFts5Rrf: mean(evaluated.map(row => row.currentFts)) };
for (const mode of ['rsjZero', 'rsjEpsilon'] as const) summaries[`bm25Idf_${mode}`] = mean(evaluated.map(row => row.bm25IdfVariants[mode]!));
for (const weight of sweepWeights) summaries[`titleRrfWeight${weight}`] = mean(evaluated.map(row => row.variants[String(weight)]!));
const comparisons: Record<string, unknown> = {};
comparisons.currentFts5Rrf = compare('currentFts');
for (const mode of ['rsjZero', 'rsjEpsilon'] as const) comparisons[`bm25Idf_${mode}`] = compare(`bm25Idf_${mode}`);
for (const weight of sweepWeights) comparisons[`titleRrfWeight${weight}`] = compare(String(weight));
for (const name of ['morphologyOnly', 'ngramOnly', 'rawOnly', 'morphologyNgram', 'morphologyRaw', 'ngramRaw', 'allThree']) {
  summaries[`signalRrf_${name}`] = mean(evaluated.map(row => row.variants[`signals_${name}`]!));
  comparisons[`signalRrf_${name}`] = compare(`signals_${name}`);
}
for (const name of ['standardPlusMorphology', 'standardPlusNgram', 'standardPlusRaw', 'standardPlusMorphologyRaw']) {
  summaries[name] = mean(evaluated.map(row => row.variants[name]!));
  comparisons[name] = compare(name);
}
const candidateDiagnosticSummary = Object.fromEntries(Object.keys(evaluated[0]!.candidateDiagnostics).map(name => {
  const rows = evaluated.map(row => row.candidateDiagnostics[name]!);
  return [name, {
    meanCandidates: rows.reduce((sum, row) => sum + row.count, 0) / rows.length,
    medianCandidates: percentile(rows.map(row => row.count), 0.5),
    p95Candidates: percentile(rows.map(row => row.count), 0.95),
    queriesWithAllGoldCandidates: rows.filter(row => row.goldRecall === 1).length,
    goldRecall: rows.reduce((sum, row) => sum + row.goldRecall, 0) / rows.length,
  }];
}));
const result = {
  audit: sourceResultsPath ? `development exploration on a previously used ${datasetLabel} sample; exploratory only` : `fixed hash-ordered target groups from the ${datasetLabel} development split; not an independent source or final holdout`,
  dataset: { name: datasetLabel, split: 'development', documents: docs.length, queries: queries.length, groups: new Set(queries.map(row => row.group_id)).size,
    sourceSha256: (JSON.parse(fs.readFileSync(path.join(datasetDir, 'provenance.json'), 'utf8')) as { upstream_zip_sha256: string }).upstream_zip_sha256, selection },
  definitions: { standardMorphologyBm25: 'k1=1.2,b=0.75 over the exact stored morphology tokens; shared query parser; smooth positive IDF log(1+RSJ ratio); no app ranking corrections', bm25Idf_rsjZero: 'same BM25 k1/b and exact tokens as standard, but non-positive Robertson-Sparck Jones IDF is clamped to zero', bm25Idf_rsjEpsilon: 'same BM25 k1/b and exact tokens as standard, but non-positive RSJ IDF is replaced with 0.25 times corpus-average RSJ IDF', currentFts5Rrf: 'equal RRF of morphology FTS, n-gram FTS, and unweighted raw title/body/summary/tags FTS, k=60', standardBm25FtsRrf: 'equal RRF of the independent standard BM25 rank and the named FTS signal ranks, k=60; exploratory fixed weights, no tuning on this sample', titleRrf: 'same three FTS ranks plus a title-column-only BM25 rank from the existing cards_fts index, RRF k=60; no new tokenization or corpus fields' },
  summaries, comparisonsAgainstStandard: comparisons, candidateDiagnosticSummary,
  titleCandidateGate: maxTitleCandidates === undefined ? null : { maximumMatches: maxTitleCandidates,
    titleSignalUsedForQueries: evaluated.filter(row => row.titleSignalUsed).length },
  resources: { indexingChanged: false, databaseOpenedReadOnly: true, processRssBytes: process.memoryUsage().rss, processHeapUsedBytes: process.memoryUsage().heapUsed,
    queryLatencyMs: { p50: percentile(evaluated.map(row => row.latencyMs), 0.5), p95: percentile(evaluated.map(row => row.latencyMs), 0.95) } },
  referenceStandardAudit: referenceRows ? { queriesMatchedById: evaluated.filter(row => referenceRows.has(row.query.id)).length, parserReferenceMismatches, standardTop10ReferenceMismatches } : null,
  perQuery: evaluated.map(row => ({ id: row.query.id, group_id: row.query.group_id, query: row.query.query, parserTerms: row.parserTerms, gold_ids: row.query.gold_ids, standard: row.standard, standardTop10: row.standardTop10, bm25IdfVariants: row.bm25IdfVariants, bm25IdfTop10: row.bm25IdfTop10, currentFts: row.currentFts, currentFtsTop10: row.currentFtsTop10, titleVariants: Object.fromEntries(Object.entries(row.variants).filter(([name]) => !name.startsWith('signals_'))), signalVariants: Object.fromEntries(Object.entries(row.variants).filter(([name]) => name.startsWith('signals_'))), signalTop10: row.signalTop10, titleTop10: row.titleTop10, candidateDiagnostics: row.candidateDiagnostics, titleCandidateCount: row.titleCandidateCount, titleSignalUsed: row.titleSignalUsed, latencyMs: row.latencyMs })),
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, dataset: result.dataset, summaries, comparisonsAgainstStandard: comparisons, candidateDiagnosticSummary, resources: result.resources }, null, 2));
db.close();

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Number((sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0).toFixed(3));
}
