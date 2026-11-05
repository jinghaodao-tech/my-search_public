import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type MetricRow = { queryId: string; metrics: Record<string, number> };
type Evaluation = { queries: Array<{ id: string }>; qrels: Record<string, Record<string, number>> };
type Result = { perQuery: Record<string, MetricRow[]> };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resultPath = path.resolve(process.argv[2] ?? path.join(root, 'quality/e2e/artifacts/jagov-a8-transfer.json'));
const evaluationPath = path.resolve(process.argv[3] ?? path.join(root, 'quality/e2e/artifacts/jagov-development/jagov-dev.eval.json'));
const outputPath = path.resolve(process.argv[4] ?? path.join(root, 'quality/e2e/artifacts/jagov-a8-transfer-bootstrap.json'));
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Result;
const evaluation = JSON.parse(fs.readFileSync(evaluationPath, 'utf8')) as Evaluation;
const names = {
  current: 'A0-current-custom',
  custom: 'A8-no-context-no-coverage',
  standard: 'S3-standard-morph-k1.2-b0.75',
};
const metrics = ['ndcg10', 'recall100', 'mrr10', 'map100'] as const;
const rowsByVariant = Object.fromEntries(Object.entries(names).map(([key, id]) => {
  const rows = result.perQuery[id];
  if (!rows) throw new Error(`missing variant results: ${id}`);
  return [key, new Map(rows.map(row => [row.queryId, row]))];
})) as Record<keyof typeof names, Map<string, MetricRow>>;
const queryIds = evaluation.queries.map(query => query.id);
if (new Set(queryIds).size !== queryIds.length) throw new Error('duplicate query IDs in evaluation labels');
for (const queryId of queryIds) for (const rows of Object.values(rowsByVariant)) {
  if (!rows.has(queryId)) throw new Error(`missing paired result for query ${queryId}`);
}

const parent = new Map(queryIds.map(id => [id, id]));
const find = (id: string): string => {
  const current = parent.get(id);
  if (!current) throw new Error(`unknown query ID in qrels: ${id}`);
  if (current === id) return id;
  const rootId = find(current);
  parent.set(id, rootId);
  return rootId;
};
const union = (left: string, right: string) => { parent.set(find(left), find(right)); };
const firstQueryByDocument = new Map<string, string>();
for (const queryId of queryIds) for (const [documentId, grade] of Object.entries(evaluation.qrels[queryId] ?? {})) {
  if (grade <= 0) continue;
  const previous = firstQueryByDocument.get(documentId);
  if (previous) union(queryId, previous);
  else firstQueryByDocument.set(documentId, queryId);
}
const clusters = [...new Set(queryIds.map(find))].map(clusterId => queryIds.filter(id => find(id) === clusterId));
const seed = 20261023;
let randomState = seed;
const random = () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x1_0000_0000;
};
const replicates = 20_000;
const percentile = (values: number[], p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))] ?? 0;
const comparisons = [
  { id: 'standard-minus-custom-mixture', left: 'standard', right: 'custom' },
  { id: 'standard-minus-current-custom', left: 'standard', right: 'current' },
  { id: 'current-custom-minus-custom-mixture', left: 'current', right: 'custom' },
] as const;
const output = {
  dataset: 'JAGOV official FAQ retrieval, development split only',
  sourceResult: resultPath,
  sourceEvaluation: evaluationPath,
  queries: queryIds.length,
  positiveQrelDocuments: firstQueryByDocument.size,
  sharedGoldDocumentClusters: clusters.length,
  bootstrapUnit: 'connected components of queries sharing any positive-qrel document; resample components with replacement, then average over included queries',
  replicates,
  seed,
  confidenceInterval: 'paired percentile bootstrap 95% interval; exploratory development-set inference, not independent confirmation',
  comparisons: Object.fromEntries(comparisons.map(comparison => {
    const deltas = queryIds.map(queryId => {
      const left = rowsByVariant[comparison.left].get(queryId)!.metrics;
      const right = rowsByVariant[comparison.right].get(queryId)!.metrics;
      return Object.fromEntries(metrics.map(metric => [metric, left[metric]! - right[metric]!])) as Record<typeof metrics[number], number>;
    });
    const deltaByQuery = new Map(queryIds.map((queryId, index) => [queryId, deltas[index]!]));
    const observed = Object.fromEntries(metrics.map(metric => [metric, deltas.reduce((sum, row) => sum + row[metric], 0) / deltas.length]));
    const ndcgSamples = Array.from({ length: replicates }, () => {
      let sum = 0;
      let count = 0;
      for (let clusterDraw = 0; clusterDraw < clusters.length; clusterDraw += 1) {
        const cluster = clusters[Math.floor(random() * clusters.length)]!;
        for (const queryId of cluster) {
          sum += deltaByQuery.get(queryId)!.ndcg10;
          count += 1;
        }
      }
      return sum / Math.max(count, 1);
    }).sort((left, right) => left - right);
    const intervals = Object.fromEntries(metrics.map(metric => {
      const wins = deltas.filter(row => row[metric] > 0).length;
      const losses = deltas.filter(row => row[metric] < 0).length;
      return [metric, {
        meanDifference: observed[metric],
        ...(metric === 'ndcg10' ? { ci95: [percentile(ndcgSamples, 0.025), percentile(ndcgSamples, 0.975)] } : {}),
        positiveQueryCount: wins,
        negativeQueryCount: losses,
        tiedQueryCount: deltas.length - wins - losses,
      }];
    }));
    return [comparison.id, intervals];
  })),
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: outputPath, queries: output.queries, clusters: output.sharedGoldDocumentClusters, comparisons: output.comparisons }, null, 2));
