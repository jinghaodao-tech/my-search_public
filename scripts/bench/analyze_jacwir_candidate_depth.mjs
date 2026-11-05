import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [top100Arg, top200Arg, outputArg] = process.argv.slice(2);
if (!top100Arg || !top200Arg || !outputArg) throw new Error('Usage: node scripts/bench/analyze_jacwir_candidate_depth.mjs <top100.json> <top200.json> <new-output.json>');
const inputs = [top100Arg, top200Arg].map(file => path.resolve(file));
const outputPath = path.resolve(outputArg);
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new file under artifacts/.');
const [top100, top200] = inputs.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
if (top100.dataset.candidateDepth !== 100 || top200.dataset.candidateDepth !== 200) throw new Error('Expected top-100 and top-200 benchmark artifacts.');
if (top100.perQuery.length !== 100 || top200.perQuery.length !== 100) throw new Error('Expected 100 paired query results in each input.');
if (top100.dataset.corpusDocuments !== top200.dataset.corpusDocuments || top100.dataset.inputSha256.sourceEvaluationParquet !== top200.dataset.inputSha256.sourceEvaluationParquet) throw new Error('Corpus or source evaluation inputs differ.');
const rightById = new Map(top200.perQuery.map(row => [row.queryId, row]));
if (rightById.size !== 100 || top100.perQuery.some(row => !rightById.has(row.queryId))) throw new Error('Query IDs are not an exact one-to-one match.');
const rows = top100.perQuery.map(left => {
  const right = rightById.get(left.queryId);
  if (!right || JSON.stringify([...left.positiveDocumentIds].sort()) !== JSON.stringify([...right.positiveDocumentIds].sort())) throw new Error(`Positive qrels differ for ${left.queryId}.`);
  return { left, right };
});

const parent = new Map();
const find = id => {
  const root = parent.get(id);
  if (!root) { parent.set(id, id); return id; }
  if (root === id) return id;
  const canonical = find(root);
  parent.set(id, canonical);
  return canonical;
};
for (const { left } of rows) for (const docId of left.positiveDocumentIds) {
  const queryRoot = find(`q:${left.queryId}`);
  const docRoot = find(`d:${docId}`);
  if (queryRoot !== docRoot) parent.set(docRoot, queryRoot);
}
const groups = new Map();
for (const pair of rows) {
  const id = find(`q:${pair.left.queryId}`);
  groups.set(id, [...(groups.get(id) ?? []), pair]);
}
const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const compare = (leftMethod, rightMethod, metric, draws = 20_000) => {
  const deltaFor = ({ left, right }) => right.metrics[rightMethod][metric] - left.metrics[leftMethod][metric];
  const deltas = rows.map(deltaFor);
  const clustered = [...groups.values()].map(group => group.map(deltaFor));
  let seed = Number.parseInt(crypto.createHash('sha256').update(`${inputs.join('|')}|${leftMethod}|${rightMethod}|${metric}|depth-comparison-v1`).digest('hex').slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const samples = new Array(draws);
  for (let draw = 0; draw < draws; draw++) {
    let sum = 0; let count = 0;
    for (let index = 0; index < clustered.length; index++) for (const delta of clustered[Math.floor(random() * clustered.length)]) { sum += delta; count++; }
    samples[draw] = count ? sum / count : 0;
  }
  return { deltaTop200MinusTop100: mean(deltas), ci95: [percentile(samples, 0.025), percentile(samples, 0.975)], clusters: clustered.length, bootstrapSamples: draws };
};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const methods = ['standard-bm25', 'e5-rerank-bm25-top100', 'rrf-bm25-e5-bm25-top100'];
const top200Method = { 'standard-bm25': 'standard-bm25', 'e5-rerank-bm25-top100': 'e5-rerank-bm25-top200', 'rrf-bm25-e5-bm25-top100': 'rrf-bm25-e5-bm25-top200' };
const summary = Object.fromEntries(methods.map(method => [method, {
  top100: top100.metrics[method], top200: top200.metrics[top200Method[method]],
  metricDeltas: Object.fromEntries(['hit1', 'hit10', 'ndcg10', 'map100', 'recall100'].map(metric => [metric, compare(method, top200Method[method], metric)])),
  latencyMs: { top100: top100.metrics[method].latencyMs, top200: top200.metrics[top200Method[method]].latencyMs },
}]));
const result = {
  dataset: { source: 'hotchpotch/JaCWIR', corpusDocuments: top100.dataset.corpusDocuments, queryCount: rows.length, querySelection: top100.dataset.querySelection,
    qrelsWarning: top100.dataset.labels },
  inputs: inputs.map(file => ({ path: file, sha256: hash(file) })),
  candidateCoverage: { top100: top100.retrievalCeiling.bm25Top100ContainsAtLeastOneKnownPositive, top200: top200.retrievalCeiling.bm25Top200ContainsAtLeastOneKnownPositive },
  uniqueCandidates: { top100: top100.resources.uniqueBm25CandidateDocuments, top200: top200.resources.uniqueBm25CandidateDocuments },
  vectorBytes: { top100: top100.resources.candidateVectorBytes, top200: top200.resources.candidateVectorBytes },
  embeddingBuildMs: { top100: top100.resources.candidateEmbeddingPreparationMs, top200: top200.resources.candidateEmbeddingPreparationMs },
  comparisons: summary,
  interpretation: 'Same 100 queries and source judgments, but the depth comparison was added after inspecting earlier results and is exploratory. Bootstrap clusters queries sharing known-positive documents. Source qrels are not exhaustive.',
};
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, candidateCoverage: result.candidateCoverage, comparisons: Object.fromEntries(Object.entries(summary).map(([method, value]) => [method, { ndcg10: value.metricDeltas.ndcg10, recall100: value.metricDeltas.recall100 }])) }, null, 2));
