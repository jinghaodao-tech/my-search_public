import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length < 3) throw new Error('Usage: node scripts/bench/analyze_jacwir_full_retrieval_replication.mjs <slice.json> <slice.json> [more-slices.json ...] <new-output.json>');
const inputs = args.slice(0, -1).map(file => path.resolve(file));
const outputPath = path.resolve(args.at(-1));
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new path under artifacts/.');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const reports = inputs.map(read);
const queries = reports.flatMap(report => report.perQuery);
const queryIds = queries.map(row => row.queryId);
if (reports.some(report => report.perQuery.length !== 100) || new Set(queryIds).size !== reports.length * 100) throw new Error('Expected disjoint 100-query slices.');
if (reports.some(report => report.dataset.corpusDocuments !== reports[0].dataset.corpusDocuments) || reports[0].dataset.corpusDocuments !== 513107) throw new Error('Corpus sizes differ or are not 513,107.');

const parent = new Map();
const find = id => {
  const root = parent.get(id);
  if (!root) { parent.set(id, id); return id; }
  if (root === id) return id;
  const canonical = find(root);
  parent.set(id, canonical);
  return canonical;
};
for (const row of queries) for (const docId of row.positiveDocumentIds) {
  const queryRoot = find(`q:${row.queryId}`);
  const docRoot = find(`d:${docId}`);
  if (queryRoot !== docRoot) parent.set(docRoot, queryRoot);
}
const groups = new Map();
for (const row of queries) {
  const id = find(`q:${row.queryId}`);
  const list = groups.get(id) ?? [];
  list.push(row);
  groups.set(id, list);
}
const methods = ['standard-bm25', 'e5-rerank-bm25-top100', 'rrf-bm25-e5-bm25-top100'];
const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const bootstrapDelta = (method, metric, draws = 20_000) => {
  const clustered = [...groups.values()].map(rows => rows.map(row => row.metrics[method][metric] - row.metrics['standard-bm25'][metric]));
  const observed = mean(queries.map(row => row.metrics[method][metric] - row.metrics['standard-bm25'][metric]));
  let seed = Number.parseInt(crypto.createHash('sha256').update(`${inputs.join('|')}|${method}|${metric}|cluster-bootstrap-v2`).digest('hex').slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const samples = new Array(draws);
  for (let draw = 0; draw < draws; draw++) {
    let sum = 0; let count = 0;
    for (let index = 0; index < clustered.length; index++) for (const delta of clustered[Math.floor(random() * clustered.length)]) { sum += delta; count++; }
    samples[draw] = count ? sum / count : 0;
  }
  return { meanDelta: observed, ci95: [percentile(samples, 0.025), percentile(samples, 0.975)], clusterCount: clustered.length, bootstrapSamples: draws };
};
const summary = Object.fromEntries(methods.map(method => [method, {
  metrics: Object.fromEntries(['hit1', 'hit10', 'mrr10', 'ndcg10', 'map100', 'recall100'].map(metric => [metric, mean(queries.map(row => row.metrics[method][metric]))])),
  latencyMs: { p50: percentile(queries.map(row => row.latencyMs[method]), 0.5), p95: percentile(queries.map(row => row.latencyMs[method]), 0.95) },
}]));
const output = {
  plan: 'quality/e2e/docs/JACWIR-FULL-RETRIEVAL-REPLICATION-PLAN-2026-10-24-ja.md',
  dataset: { source: 'hotchpotch/JaCWIR', corpusDocuments: 513107, queryCount: queries.length, querySlices: reports.map(report => report.dataset.querySelection), uniqueQueries: new Set(queryIds).size,
    qrelsWarning: 'Known-positive judgments only; qrels are not exhaustive over all 513,107 documents.' },
  inputs: inputs.map((file, index) => ({ path: file, sha256: hashFile(file), querySelection: reports[index].dataset.querySelection })),
  metrics: summary,
  primaryComparison: { method: 'rrf-bm25-e5-bm25-top100', metric: 'nDCG@10', ...bootstrapDelta('rrf-bm25-e5-bm25-top100', 'ndcg10') },
  secondaryComparisons: { e5RerankNdcg10: bootstrapDelta('e5-rerank-bm25-top100', 'ndcg10'), rrfHit10: bootstrapDelta('rrf-bm25-e5-bm25-top100', 'hit10') },
  candidateGeneration: { bm25Top100KnownPositiveCoverage: mean(queries.map(row => row.bm25CandidateHit ? 1 : 0)), note: 'Reranking cannot recover any known positive absent from the full-corpus BM25 Top100.' },
  interpretation: `${reports.length} disjoint 100-query slices (${queries.length} distinct questions) from one model-generated Japanese dataset. The aggregate is supplementary and exploratory because later slices were added after earlier results were observed. A positive clustered bootstrap CI supports superiority only within this benchmark distribution; it does not establish cross-dataset or real-user superiority.`,
};
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, primaryComparison: output.primaryComparison, secondaryComparisons: output.secondaryComparisons, metrics: summary, candidateGeneration: output.candidateGeneration }, null, 2));
