import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { tokenizeMorphological } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';

type Document = { _id: string; title?: string; text?: string };
type Query = { _id: string; text: string };
type Judgment = Map<string, number>;
type EvaluatedQuery = { id: string; text: string; groupId: string; judgments: Judgment };
type Metrics = { hit1: number; hit10: number; recall100: number; mrr10: number; ndcg10: number; map100: number };
type FieldDoc = { id: string; title: string; titleTokens: string[]; bodyTokens: string[]; allTokens: string[]; titleLength: number; bodyLength: number };
type Posting = { index: number; titleTf: number; bodyTf: number; allTf: number };

const [datasetArg, outputArg, splitArg = 'test'] = process.argv.slice(2);
if (!datasetArg || !outputArg) throw new Error('Usage: tsx scripts/bench/benchmark_beir_bm25f_title_transfer.ts <extracted-dataset-dir> <new-output.json> [train|dev|test]');
if (!['train', 'dev', 'test'].includes(splitArg)) throw new Error('Split must be train, dev, or test.');
const split = splitArg;
const datasetDir = path.resolve(datasetArg);
const outputPath = path.resolve(outputArg);
if (!fs.existsSync(datasetDir) || fs.existsSync(outputPath) || !outputPath.includes(`${path.sep}artifacts${path.sep}`)) {
  throw new Error('Dataset must exist; output must be new and under artifacts/.');
}
const datasetName = path.basename(datasetDir).toLowerCase();
const tokenizeDatasetText = async (text: string): Promise<string[]> => {
  if (datasetName === 'trec-covid') {
    return text.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu)?.filter(token => token.length > 1) ?? [];
  }
  return tokenizeMorphological(text);
};
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const queriesPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels', `${split}.tsv`);
const readJsonl = <T>(file: string): T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as T);
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const hashFile = (file: string) => hash(fs.readFileSync(file));
for (const file of [corpusPath, queriesPath, qrelsPath]) if (!fs.existsSync(file)) throw new Error(`Missing BEIR input: ${file}`);

const corpus = readJsonl<Document>(corpusPath);
const queryById = new Map(readJsonl<Query>(queriesPath).map(query => [query._id, query.text]));
const parent = new Map<string, string>();
const find = (id: string): string => {
  const current = parent.get(id);
  if (!current) { parent.set(id, id); return id; }
  if (current === id) return id;
  const root = find(current); parent.set(id, root); return root;
};
const union = (left: string, right: string) => {
  const leftRoot = find(left); const rightRoot = find(right);
  if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
};
const judgmentsByQuery = new Map<string, Judgment>();
for (const [lineNumber, line] of fs.readFileSync(qrelsPath, 'utf8').split(/\r?\n/u).entries()) {
  if (!line.trim() || line.startsWith('query-id')) continue;
  const [queryId, documentId, scoreText] = line.split('\t');
  const score = Number(scoreText);
  if (!queryId || !documentId || !Number.isFinite(score) || !queryById.has(queryId)) throw new Error(`Invalid qrels row ${lineNumber + 1}.`);
  const judgments = judgmentsByQuery.get(queryId) ?? new Map<string, number>();
  judgments.set(documentId, Math.max(judgments.get(documentId) ?? 0, score));
  judgmentsByQuery.set(queryId, judgments);
  if (score > 0) union(`q:${queryId}`, `d:${documentId}`);
}
const queries: EvaluatedQuery[] = [...judgmentsByQuery].map(([id, judgments]) => ({
  id,
  text: queryById.get(id)!,
  groupId: parent.has(`q:${id}`) ? find(`q:${id}`) : `q:${id}`,
  judgments,
}));
if (!queries.length) throw new Error('No test queries have qrels.');

const docs: FieldDoc[] = [];
const ids = new Set<string>();
const relevantIds = new Set<string>();
for (const query of queries) for (const [id, grade] of query.judgments) if (grade > 0) relevantIds.add(id);
const corpusById = new Map<string, Document>();
for (const source of corpus) {
  if (!source._id || ids.has(source._id)) throw new Error(`Duplicate or missing corpus id: ${source._id}`);
  ids.add(source._id); corpusById.set(source._id, source);
  const titleText = (source.title ?? '').normalize('NFKC');
  const bodyText = (source.text ?? '').normalize('NFKC');
  const titleTokens = await tokenizeDatasetText(titleText);
  const bodyTokens = await tokenizeDatasetText(bodyText);
  const allTokens = [...titleTokens, ...bodyTokens];
  docs.push({ id: source._id, title: titleText.toLocaleLowerCase('en-US'), titleTokens, bodyTokens, allTokens, titleLength: titleTokens.length, bodyLength: bodyTokens.length });
  if (docs.length % 1000 === 0 || docs.length === corpus.length) console.log(`tokenized ${docs.length}/${corpus.length}`);
}
const missingRelevantIds = [...relevantIds].filter(id => !ids.has(id));

const titleAverage = docs.reduce((sum, doc) => sum + doc.titleLength, 0) / docs.length;
const bodyAverage = docs.reduce((sum, doc) => sum + doc.bodyLength, 0) / docs.length;
const allAverage = docs.reduce((sum, doc) => sum + doc.allTokens.length, 0) / docs.length;
const postings = new Map<string, Posting[]>();
for (let index = 0; index < docs.length; index++) {
  const doc = docs[index]!;
  const counts = (tokens: string[]) => {
    const map = new Map<string, number>();
    for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
    return map;
  };
  const titleTf = counts(doc.titleTokens); const bodyTf = counts(doc.bodyTokens); const allTf = counts(doc.allTokens);
  for (const term of new Set([...titleTf.keys(), ...bodyTf.keys(), ...allTf.keys()])) {
    const rows = postings.get(term) ?? [];
    rows.push({ index, titleTf: titleTf.get(term) ?? 0, bodyTf: bodyTf.get(term) ?? 0, allTf: allTf.get(term) ?? 0 });
    postings.set(term, rows);
  }
}

const modes = ['standard', 'bm25-b1', 'bm25f-title-2', 'bm25f-title-2-b1', 'bm25-title-only-rrf', 'bm25-title-only-rrf-w01', 'bm25-title-coverage-02'] as const;
type Mode = typeof modes[number];
type ScoringMode = 'standard' | 'bm25-b1' | 'bm25f-title-2' | 'bm25f-title-2-b1' | 'title-only';
const scoreRank = (terms: readonly string[], mode: ScoringMode): string[] => {
  const scores = new Map<number, number>();
  for (const term of new Set(terms)) {
    const rows = postings.get(term);
    if (!rows?.length) continue;
    const titleDf = rows.filter(row => row.titleTf > 0).length;
    const idf = mode === 'title-only'
      ? (titleDf ? Math.log(1 + (docs.length - titleDf + 0.5) / (titleDf + 0.5)) : 0)
      : Math.log(1 + (docs.length - rows.length + 0.5) / (rows.length + 0.5));
    for (const row of rows) {
      let contribution: number;
      if (mode === 'title-only') {
        if (!row.titleTf) continue;
        const normalizedTf = row.titleTf / Math.max(0.25 + 0.75 * docs[row.index]!.titleLength / Math.max(titleAverage, 1), 1e-9);
        contribution = idf * normalizedTf * 2.2 / (normalizedTf + 1.2);
      } else if (mode === 'standard' || mode === 'bm25-b1') {
        const length = docs[row.index]!.allTokens.length;
        const b = mode === 'bm25-b1' ? 1 : 0.75;
        const norm = row.allTf + 1.2 * (1 - b + b * length / Math.max(allAverage, 1));
        contribution = idf * row.allTf * 2.2 / norm;
      } else {
        const fieldB = mode === 'bm25f-title-2-b1' ? 1 : undefined;
        const titleB = fieldB ?? 0.3;
        const bodyB = fieldB ?? 0.75;
        const titleTf = row.titleTf / Math.max(1 - titleB + titleB * docs[row.index]!.titleLength / Math.max(titleAverage, 1), 1e-9);
        const bodyTf = row.bodyTf / Math.max(1 - bodyB + bodyB * docs[row.index]!.bodyLength / Math.max(bodyAverage, 1), 1e-9);
        const combinedTf = 2 * titleTf + bodyTf;
        contribution = idf * combinedTf * 2.2 / (combinedTf + 1.2);
      }
      scores.set(row.index, (scores.get(row.index) ?? 0) + contribution);
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1] || docs[a[0]]!.id.localeCompare(docs[b[0]]!.id)).map(([index]) => docs[index]!.id);
};
const rank = (terms: readonly string[], mode: Exclude<Mode, 'bm25-title-coverage-02'>): string[] => {
  if (mode !== 'bm25-title-only-rrf' && mode !== 'bm25-title-only-rrf-w01') return scoreRank(terms, mode);
  const standard = scoreRank(terms, 'standard');
  const titleOnly = scoreRank(terms, 'title-only');
  const fused = new Map<string, number>();
  standard.forEach((id, index) => fused.set(id, 1 / (60 + index + 1)));
  const titleWeight = mode === 'bm25-title-only-rrf-w01' ? 0.1 : 1;
  titleOnly.forEach((id, index) => fused.set(id, (fused.get(id) ?? 0) + titleWeight / (60 + index + 1)));
  return [...fused].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([id]) => id);
};
const rankTitleCoverage = (tokens: readonly string[], queryTerms: readonly string[]): string[] => {
  const scores = new Map<number, number>();
  for (const term of new Set(tokens)) {
    const rows = postings.get(term);
    if (!rows?.length) continue;
    const idf = Math.log(1 + (docs.length - rows.length + 0.5) / (rows.length + 0.5));
    for (const row of rows) {
      const length = docs[row.index]!.allTokens.length;
      const norm = row.allTf + 1.2 * (1 - 0.75 + 0.75 * length / Math.max(allAverage, 1));
      scores.set(row.index, (scores.get(row.index) ?? 0) + idf * row.allTf * 2.2 / norm);
    }
  }
  const baseline = [...scores].sort((a, b) => b[1] - a[1] || docs[a[0]]!.id.localeCompare(docs[b[0]]!.id)).slice(0, 1000);
  if (!baseline.length) return [];
  const minScore = Math.min(...baseline.map(([, score]) => score));
  const maxScore = Math.max(...baseline.map(([, score]) => score));
  const range = maxScore - minScore || 1;
  const termsLower = [...new Set(queryTerms.map(term => term.normalize('NFKC').toLocaleLowerCase('en-US')).filter(Boolean))];
  return baseline.map(([index, score], position) => ({
    id: docs[index]!.id,
    position,
    rerankScore: (score - minScore) / range + 0.2 * (termsLower.length
      ? termsLower.filter(term => docs[index]!.title.includes(term)).length / termsLower.length
      : 0),
  })).sort((a, b) => b.rerankScore - a.rerankScore || a.position - b.position).map(row => row.id);
};
const metric = (ranked: readonly string[], judgments: Judgment): Metrics => {
  const relevant = new Set([...judgments].filter(([, grade]) => grade > 0).map(([id]) => id));
  const first = ranked.findIndex(id => relevant.has(id));
  const dcg = ranked.slice(0, 10).reduce((sum, id, index) => sum + ((2 ** (judgments.get(id) ?? 0)) - 1) / Math.log2(index + 2), 0);
  const ideal = [...judgments.values()].filter(grade => grade > 0).sort((a, b) => b - a).slice(0, 10)
    .reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  let found = 0; let ap = 0;
  for (let index = 0; index < Math.min(ranked.length, 100); index++) if (relevant.has(ranked[index]!)) { found++; ap += found / (index + 1); }
  return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0,
    recall100: relevant.size ? ranked.slice(0, 100).filter(id => relevant.has(id)).length / relevant.size : 0,
    mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0,
    map100: relevant.size ? ap / relevant.size : 0 };
};
const metricNames = ['hit1', 'hit10', 'recall100', 'mrr10', 'ndcg10', 'map100'] as const;
const results: Array<{ id: string; groupId: string; metrics: Record<Mode, Metrics> }> = [];
const times = new Map(modes.map(mode => [mode, [] as number[]]));
for (let index = 0; index < queries.length; index++) {
  const query = queries[index]!;
  const purpose = await purposeWords(query.text);
  const parsed = analyzeQuery(query.text, purpose.length ? purpose : query.text.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const terms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
  const queryTokens = await tokenizeDatasetText(terms.join(' '));
  const metrics = {} as Record<Mode, Metrics>;
  for (const mode of modes) {
    const started = performance.now();
    const ranked = mode === 'bm25-title-coverage-02' ? rankTitleCoverage(queryTokens, terms) : rank(queryTokens, mode);
    metrics[mode] = metric(ranked, query.judgments);
    times.get(mode)!.push(performance.now() - started);
  }
  results.push({ id: query.id, groupId: query.groupId, metrics });
  if ((index + 1) % 100 === 0 || index + 1 === queries.length) console.log(`evaluated ${index + 1}/${queries.length}`);
}

const means = Object.fromEntries(modes.map(mode => [mode, Object.fromEntries(metricNames.map(name => [name,
  results.reduce((sum, row) => sum + row.metrics[mode][name], 0) / results.length]))])) as Record<Mode, Metrics>;
const bootstrap = (mode: Exclude<Mode, 'standard'>, name: typeof metricNames[number]) => {
  const grouped = new Map<string, number[]>();
  for (const row of results) grouped.set(row.groupId, [...(grouped.get(row.groupId) ?? []), row.metrics[mode][name] - row.metrics.standard[name]]);
  const clusters = [...grouped.values()];
  let seed = Number.parseInt(hash(`${datasetName}\0${split}\0${mode}\0${name}`).slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = new Array<number>(20_000);
  for (let draw = 0; draw < draws.length; draw++) {
    let sum = 0; let count = 0;
    for (let i = 0; i < clusters.length; i++) { const sample = clusters[Math.floor(random() * clusters.length)]!; sum += sample.reduce((total, value) => total + value, 0); count += sample.length; }
    draws[draw] = sum / count;
  }
  draws.sort((a, b) => a - b);
  return { meanDifference: means[mode][name] - means.standard[name], clusterBootstrap95CI: [draws[499]!, draws[19_499]!], clusterCount: clusters.length };
};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const result = {
  dataset: { name: datasetName, split: `BEIR ${split}; exploratory fixed-parameter transfer`, documents: corpus.length,
    queries: results.length, positiveQrelConnectedComponents: new Set(results.map(row => row.groupId)).size,
    corpusSha256: hashFile(corpusPath), queriesSha256: hashFile(queriesPath), qrelsSha256: hashFile(qrelsPath) },
  definitions: { primaryMetric: 'nDCG@10; candidates fixed before these test runs from Reddit-TOMT Books development.',
    standard: datasetName === 'trec-covid'
      ? 'Exact Unicode-word-token BM25, k1=1.2, b=0.75, all title+body tokens concatenated; identical tokenizer is shared by baseline and reranker.'
      : 'Exact morphology-token BM25, k1=1.2, b=0.75, all title+body tokens concatenated.',
    candidateBm25B1: 'Exact morphology-token BM25, k1=1.2,b=1.0; selected on Reddit-TOMT Books development, same tokenizer/parser/IDF/qrels/full-corpus candidate set.',
    candidateBm25f: 'BM25F with titleWeight=2, bodyWeight=1, title b=0.3, body b=0.75, k1=1.2; selected on Reddit-TOMT Books development, same morphology tokenizer, parser, IDF, qrels and full-corpus candidate set.',
    candidateBm25fB1: 'BM25F combination: titleWeight=2, bodyWeight=1, title b=1.0, body b=1.0, k1=1.2; fixed combination of Books-development candidates, not tuned on this split.',
    titleOnlyRrf: 'Equal reciprocal-rank fusion of standard morphology-token BM25 and title-only BM25, RRF k=60; title-only IDF/length statistics are field-specific. This adds no effect when all titles are empty.',
    titleOnlyRrfWeight01: 'RRF of standard morphology-token BM25 and title-only BM25 using fixed title-signal weight 0.1 and k=60; weight transferred from the prior Movies development experiment without retuning here.',
    bm25TitleCoverage02: `Standard ${datasetName === 'trec-covid' ? 'Unicode-word-token' : 'morphology-token'} BM25 top 1000; min-max normalize BM25 scores in that candidate set, then add fixed 0.2 times the fraction of parsed keyword units occurring as substrings in the title. Weight transferred unchanged from MIRACL Japanese development; no TREC-COVID tuning.`,
    sourceCorpus: 'Official BEIR corpus and qrels. Any positive qrel whose document is absent from the supplied corpus remains in the official metric denominator and is listed in the audit.',
    tokenizerAmendment: datasetName === 'trec-covid'
      ? 'Before observing any ranking metric, the initial full-corpus Kuromoji pass was stopped at 1,000/171,332 documents because it was operationally impractical. For this English corpus only, a fixed NFKC + lowercase Unicode letter/digit tokenizer is applied identically to documents and parsed query terms; this is a protocol amendment and is not comparable to the app production tokenizer.'
      : null,
    exploratory: 'Fixed candidates are transferred without tuning on this split; this is development/transfer evidence, not an independent final evaluation or a claim about my-search user sessions.' },
  audit: { positiveQrels: [...judgmentsByQuery.values()].reduce((sum, row) => sum + [...row.values()].filter(grade => grade > 0).length, 0),
    positiveQrelsMissingFromCorpus: missingRelevantIds.length, missingPositiveQrelIds: missingRelevantIds,
    comparedQueries: results.length, groupCount: new Set(results.map(row => row.groupId)).size },
  means,
  differencesVsStandard: Object.fromEntries(modes.filter((mode): mode is Exclude<Mode, 'standard'> => mode !== 'standard').map(mode => [mode,
    Object.fromEntries(metricNames.map(name => [name, bootstrap(mode, name)]))])),
  resources: { indexBuildMs: null, measuredRankingOnly: true,
    latencyMs: Object.fromEntries(modes.map(mode => [mode, { p50: percentile(times.get(mode)!, .5), p95: percentile(times.get(mode)!, .95) }])),
    processRssBytes: process.memoryUsage().rss, processHeapUsedBytes: process.memoryUsage().heapUsed },
  perQuery: results,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, dataset: result.dataset, means: result.means, differencesVsStandard: result.differencesVsStandard, resources: result.resources }, null, 2));
