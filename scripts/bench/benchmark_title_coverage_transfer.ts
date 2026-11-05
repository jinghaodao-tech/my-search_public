import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';

type CorpusRow = { _id: string; title?: string; text?: string };
type QueryRow = { _id: string; text: string };
type Judgment = Map<string, number>;
type Query = { id: string; text: string; groupId: string; judgments: Judgment };
type Metrics = { hit1: number; hit10: number; recall100: number; mrr10: number; ndcg10: number; map100: number };
const [datasetArg, outputArg, split = 'test', weightArg = '0.2'] = process.argv.slice(2);
const titleCoverageWeight = Number(weightArg);
if (!datasetArg || !outputArg || !['train', 'dev', 'test'].includes(split) || !Number.isFinite(titleCoverageWeight) || titleCoverageWeight < 0 || titleCoverageWeight > 1) throw new Error('Usage: tsx scripts/bench/benchmark_title_coverage_transfer.ts <beir-dir> <new-output.json> [train|dev|test] [title-coverage-weight 0..1]');
const datasetDir = path.resolve(datasetArg);
const outputPath = path.resolve(outputArg);
const datasetName = path.basename(datasetDir).toLowerCase();
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const queriesPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels', `${split}.tsv`);
if (!fs.existsSync(corpusPath) || !fs.existsSync(queriesPath) || !fs.existsSync(qrelsPath) || !outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) {
  throw new Error('Inputs must exist and output must be a new path under artifacts/.');
}
const digest = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJsonl = <T>(file: string): T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as T);
const tokenize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu)?.filter(token => token.length > 1) ?? [];
const parseCorpus = async (visit: (row: CorpusRow, index: number) => void | Promise<void>) => {
  let index = 0;
  const input = createInterface({ input: createReadStream(corpusPath), crlfDelay: Infinity });
  for await (const line of input) {
    if (!line) continue;
    await visit(JSON.parse(line) as CorpusRow, index++);
  }
  return index;
};

const queryById = new Map(readJsonl<QueryRow>(queriesPath).map(row => [row._id, row.text]));
const parent = new Map<string, string>();
const find = (id: string): string => {
  const value = parent.get(id);
  if (!value) { parent.set(id, id); return id; }
  if (value === id) return id;
  const root = find(value); parent.set(id, root); return root;
};
const union = (left: string, right: string) => { const a = find(left); const b = find(right); if (a !== b) parent.set(b, a); };
const judgmentRows = new Map<string, Judgment>();
for (const [lineNo, line] of fs.readFileSync(qrelsPath, 'utf8').split(/\r?\n/u).entries()) {
  if (!line.trim() || line.startsWith('query-id')) continue;
  const [qid, did, raw] = line.split('\t');
  const grade = Number(raw);
  if (!qid || !did || !Number.isFinite(grade) || !queryById.has(qid)) throw new Error(`Invalid qrels row ${lineNo + 1}`);
  const row = judgmentRows.get(qid) ?? new Map<string, number>();
  row.set(did, Math.max(row.get(did) ?? 0, grade)); judgmentRows.set(qid, row);
  if (grade > 0) union(`q:${qid}`, `d:${did}`);
}
const queries: Query[] = [...judgmentRows].map(([id, judgments]) => ({ id, text: queryById.get(id)!, groupId: parent.has(`q:${id}`) ? find(`q:${id}`) : `q:${id}`, judgments }));

const documentIds: string[] = [];
const documentIndex = new Map<string, number>();
const titles: string[] = [];
const lengths: number[] = [];
const termToId = new Map<string, number>();
const documentFrequency: number[] = [];
let lengthTotal = 0;
const firstCount = await parseCorpus((row, index) => {
  if (!row._id || documentIndex.has(row._id)) throw new Error(`Duplicate or missing document id at ${index}`);
  documentIds.push(row._id); documentIndex.set(row._id, index);
  const title = (row.title ?? '').normalize('NFKC').toLocaleLowerCase('en-US');
  titles.push(title);
  const tokens = tokenize(`${title} ${row.text ?? ''}`);
  lengths.push(tokens.length); lengthTotal += tokens.length;
  const unique = new Set(tokens);
  for (const token of unique) {
    let termId = termToId.get(token);
    if (termId === undefined) { termId = termToId.size; termToId.set(token, termId); documentFrequency.push(0); }
    documentFrequency[termId] = documentFrequency[termId]! + 1;
  }
  if ((index + 1) % 25_000 === 0) console.log(`indexed vocabulary ${index + 1}`);
});
if (firstCount !== documentIds.length) throw new Error('First-pass document count mismatch.');
const offsets = new Uint32Array(documentFrequency.length + 1);
for (let termId = 0; termId < documentFrequency.length; termId++) offsets[termId + 1] = offsets[termId]! + documentFrequency[termId]!;
const next = offsets.slice(0, -1);
const postingDocs = new Uint32Array(offsets[offsets.length - 1]!);
const postingTf = new Uint16Array(postingDocs.length);
const secondCount = await parseCorpus((row, index) => {
  if (documentIds[index] !== row._id) throw new Error(`Corpus order changed at ${index}`);
  const title = (row.title ?? '').normalize('NFKC').toLocaleLowerCase('en-US');
  const counts = new Map<string, number>();
  for (const token of tokenize(`${title} ${row.text ?? ''}`)) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const [token, tf] of counts) {
    const termId = termToId.get(token)!;
    const slot = next[termId]!;
    postingDocs[slot] = index;
    postingTf[slot] = Math.min(tf, 65_535);
    next[termId] = slot + 1;
  }
  if ((index + 1) % 25_000 === 0) console.log(`built postings ${index + 1}`);
});
if (secondCount !== firstCount) throw new Error('Second-pass document count mismatch.');

const avgLength = lengthTotal / firstCount;
const scoreStandard = (queryTerms: readonly string[]) => {
  const scores = new Map<number, number>();
  for (const term of new Set(queryTerms)) {
    const termId = termToId.get(term);
    if (termId === undefined) continue;
    const df = documentFrequency[termId]!;
    const idf = Math.log(1 + (firstCount - df + 0.5) / (df + 0.5));
    for (let slot = offsets[termId]!; slot < offsets[termId + 1]!; slot++) {
      const doc = postingDocs[slot]!;
      const tf = postingTf[slot]!;
      const norm = tf + 1.2 * (1 - 0.75 + 0.75 * lengths[doc]! / Math.max(avgLength, 1));
      scores.set(doc, (scores.get(doc) ?? 0) + idf * tf * 2.2 / norm);
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1] || documentIds[a[0]]!.localeCompare(documentIds[b[0]]));
};
const metric = (ranked: readonly string[], qrels: Judgment): Metrics => {
  const relevant = new Set([...qrels].filter(([, grade]) => grade > 0).map(([id]) => id));
  const first = ranked.findIndex(id => relevant.has(id));
  const dcg = ranked.slice(0, 10).reduce((sum, id, pos) => sum + ((2 ** (qrels.get(id) ?? 0)) - 1) / Math.log2(pos + 2), 0);
  const ideal = [...qrels.values()].filter(grade => grade > 0).sort((a, b) => b - a).slice(0, 10).reduce((sum, grade, pos) => sum + (2 ** grade - 1) / Math.log2(pos + 2), 0);
  let found = 0; let ap = 0;
  for (let pos = 0; pos < Math.min(ranked.length, 100); pos++) if (relevant.has(ranked[pos]!)) { found++; ap += found / (pos + 1); }
  return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0,
    recall100: relevant.size ? ranked.slice(0, 100).filter(id => relevant.has(id)).length / relevant.size : 0,
    mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0,
    map100: relevant.size ? ap / relevant.size : 0 };
};
const metricNames = ['hit1', 'hit10', 'recall100', 'mrr10', 'ndcg10', 'map100'] as const;
const resultRows: Array<{ id: string; groupId: string; standard: Metrics; titleCoverage: Metrics }> = [];
const times = { standard: [] as number[], titleCoverage: [] as number[] };
for (const [queryIndex, query] of queries.entries()) {
  const purpose = await purposeWords(query.text);
  const parsed = analyzeQuery(query.text, purpose.length ? purpose : query.text.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const keywordUnits = [...new Set(parsed.keywords.map(keyword => keyword.term).filter(Boolean))];
  const queryTokens = tokenize(keywordUnits.join(' '));
  const started = performance.now();
  const top = scoreStandard(queryTokens).slice(0, 1000);
  const standardMs = performance.now() - started;
  const startedRerank = performance.now();
  const min = top.length ? Math.min(...top.map(([, score]) => score)) : 0;
  const max = top.length ? Math.max(...top.map(([, score]) => score)) : 0;
  const range = max - min || 1;
  const terms = [...new Set(keywordUnits.map(term => term.normalize('NFKC').toLocaleLowerCase('en-US')).filter(Boolean))];
  const reranked = top.map(([docIndex, score], position) => ({
    id: documentIds[docIndex]!, position,
    score: (score - min) / range + titleCoverageWeight * (terms.length ? terms.filter(term => titles[docIndex]!.includes(term)).length / terms.length : 0),
  })).sort((a, b) => b.score - a.score || a.position - b.position).map(row => row.id);
  const rerankMs = performance.now() - startedRerank;
  const standardIds = top.map(([index]) => documentIds[index]!);
  resultRows.push({ id: query.id, groupId: query.groupId, standard: metric(standardIds, query.judgments), titleCoverage: metric(reranked, query.judgments) });
  times.standard.push(standardMs); times.titleCoverage.push(standardMs + rerankMs);
  if ((queryIndex + 1) % 10 === 0 || queryIndex + 1 === queries.length) console.log(`evaluated ${queryIndex + 1}/${queries.length}`);
}
const mean = (mode: 'standard' | 'titleCoverage') => Object.fromEntries(metricNames.map(name => [name,
  resultRows.reduce((sum, row) => sum + row[mode][name], 0) / resultRows.length]));
const standardMean = mean('standard'); const titleMean = mean('titleCoverage');
const random = (seedValue: number) => { let seed = seedValue >>> 0; return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000); };
const bootstrap = (name: typeof metricNames[number]) => {
  const grouped = new Map<string, number[]>();
  for (const row of resultRows) grouped.set(row.groupId, [...(grouped.get(row.groupId) ?? []), row.titleCoverage[name] - row.standard[name]]);
  const clusters = [...grouped.values()]; const rand = random(Number.parseInt(crypto.createHash('sha256').update(`${datasetName}-${split}-${titleCoverageWeight}-${name}`).digest('hex').slice(0, 8), 16));
  const meanDifference = titleMean[name] as number - (standardMean[name] as number);
  if (clusters.length < 2) return { meanDifference, clusterBootstrap95CI: null, clusters: clusters.length, inferenceStatus: 'NOT_EVALUABLE_SINGLE_CLUSTER' };
  const draws = new Array<number>(20_000);
  for (let draw = 0; draw < draws.length; draw++) {
    let sum = 0; let count = 0;
    for (let i = 0; i < clusters.length; i++) { const values = clusters[Math.floor(rand() * clusters.length)]!; sum += values.reduce((acc, value) => acc + value, 0); count += values.length; }
    draws[draw] = sum / count;
  }
  draws.sort((a, b) => a - b);
  return { meanDifference, clusterBootstrap95CI: [draws[499]!, draws[19_499]!], clusters: clusters.length, inferenceStatus: 'ESTIMATED' };
};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const missingRelevant = new Set([...queries.flatMap(query => [...query.judgments].filter(([, grade]) => grade > 0).map(([id]) => id))].filter(id => !documentIndex.has(id)));
const result = {
  dataset: { name: datasetName, split, documents: firstCount, queries: queries.length,
    positiveQrelConnectedComponents: new Set(resultRows.map(row => row.groupId)).size,
    corpusSha256: digest(corpusPath), queriesSha256: digest(queriesPath), qrelsSha256: digest(qrelsPath) },
  definitions: {
    standard: 'Unicode word tokens (NFKC, lowercase, letters/digits, length > 1), standard BM25 k1=1.2,b=0.75 over title+body, top 1000 exact candidates.',
    titleCoverage: `Rerank the same standard-BM25 top 1000; min-max normalize scores within those 1000, then add fixed ${titleCoverageWeight} * fraction of parsed keyword units found as title substrings.`,
    transferScope: 'Candidate and weight fixed from MIRACL Japanese development. These datasets were previously used for other BM25 variants; this is exploratory candidate-specific cross-domain transfer, not an untouched confirmatory set or app-production-tokenizer evaluation.',
    tokenizerAmendment: datasetName === 'trec-covid'
      ? 'The initial Kuromoji attempt was stopped after 1,000 documents and before metric computation due impractical full-corpus tokenization time. Both document and query terms use the same fixed Unicode tokenizer. The amendment was recorded before observing ranking metrics.'
      : 'Both document and query terms use the same fixed NFKC + lowercase Unicode letter/digit tokenizer; this lexical benchmark is not the app production tokenizer.',
    missingRelevantDocumentsRemainInDenominator: true,
  },
  parameters: { titleCoverageWeight },
  audit: { missingPositiveQrelDocumentCount: missingRelevant.size, missingPositiveQrelDocumentIds: [...missingRelevant], postings: postingDocs.length,
    postingMemoryBytes: postingDocs.byteLength + postingTf.byteLength + offsets.byteLength, indexPasses: 2 },
  metrics: { standard: standardMean, titleCoverage: titleMean },
  differencesTitleCoverageVsStandard: Object.fromEntries(metricNames.map(name => [name, bootstrap(name)])),
  latencyMs: { standard: { p50: percentile(times.standard, .5), p95: percentile(times.standard, .95) },
    titleCoverageTotal: { p50: percentile(times.titleCoverage, .5), p95: percentile(times.titleCoverage, .95) } },
  resources: { processRssBytes: process.memoryUsage().rss, processHeapUsedBytes: process.memoryUsage().heapUsed },
  perQuery: resultRows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, dataset: result.dataset, metrics: result.metrics,
  differences: result.differencesTitleCoverageVsStandard, latencyMs: result.latencyMs, resources: result.resources }, null, 2));
