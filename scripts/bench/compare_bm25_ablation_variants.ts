import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type Metric = 'ndcg10' | 'recall100' | 'mrr10' | 'map100';
type QueryResult = { queryId: string; metrics: Record<Metric, number> };
type EvalResult = {
  dataset: string;
  documents: number;
  evaluatedQueries: number;
  variants: Record<string, Record<string, unknown>>;
  perQuery: Record<string, QueryResult[]>;
};
type EvalLabels = { qrels: Record<string, Record<string, number>> };

const [resultArg, labelsArg, outputArg, baselineArg] = process.argv.slice(2);
if (!resultArg || !labelsArg || !outputArg) {
  throw new Error('Usage: npx tsx scripts/bench/compare_bm25_ablation_variants.ts <ablation.json> <eval.json> <output.json> [baselineVariantId]');
}
const resultPath = path.resolve(resultArg);
const labelsPath = path.resolve(labelsArg);
const outputPath = path.resolve(outputArg);
if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite ${outputPath}`);
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as EvalResult;
const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8')) as EvalLabels;
const metricNames: Metric[] = ['ndcg10', 'recall100', 'mrr10', 'map100'];
const variantIds = Object.keys(result.perQuery);
const baselineId = baselineArg ?? 'A0-current-custom';
if (!result.perQuery[baselineId]) throw new Error(`Missing ${baselineId}`);

const rowsByVariant = new Map(variantIds.map(id => [id, new Map(result.perQuery[id]!.map(row => [row.queryId, row]))]));
const queryIds = [...rowsByVariant.get(baselineId)!.keys()];
if (queryIds.length !== result.evaluatedQueries) throw new Error('Baseline query count does not match the artifact summary');
for (const id of queryIds) {
  if (!labels.qrels[id] || Object.keys(labels.qrels[id]!).length === 0) throw new Error(`Missing qrels for ${id}`);
  for (const variant of variantIds) {
    if (!rowsByVariant.get(variant)!.has(id)) throw new Error(`Variant ${variant} is missing ${id}`);
  }
}

const parent = new Map(queryIds.map(id => [id, id]));
const find = (id: string): string => {
  const current = parent.get(id);
  if (!current) throw new Error(`Unknown query ${id}`);
  if (current === id) return id;
  const root = find(current);
  parent.set(id, root);
  return root;
};
const union = (left: string, right: string) => parent.set(find(left), find(right));
const firstForTarget = new Map<string, string>();
for (const queryId of queryIds) {
  for (const target of Object.keys(labels.qrels[queryId]!)) {
    const previous = firstForTarget.get(target);
    if (previous) union(queryId, previous);
    else firstForTarget.set(target, queryId);
  }
}
const grouped = new Map<string, string[]>();
for (const id of queryIds) grouped.set(find(id), [...(grouped.get(find(id)) ?? []), id]);
const clusters = [...grouped.values()];
const replicates = 20_000;
const metrics = Object.fromEntries(variantIds.map(id => [id, Object.fromEntries(metricNames.map(metric => {
  const values = queryIds.map(qid => rowsByVariant.get(id)!.get(qid)!.metrics[metric]);
  return [metric, values.reduce((sum, value) => sum + value, 0) / values.length];
}))]));

const pairedDifference: Record<string, Record<Metric, { mean: number; ci95: [number, number] }>> = {};
for (const variantId of variantIds.filter(id => id !== baselineId)) {
  pairedDifference[variantId] = {} as Record<Metric, { mean: number; ci95: [number, number] }>;
  for (const metric of metricNames) {
    const clusterDeltas = clusters.map(cluster => cluster.map(qid =>
      rowsByVariant.get(variantId)!.get(qid)!.metrics[metric] - rowsByVariant.get(baselineId)!.get(qid)!.metrics[metric],
    ));
    const differences = clusterDeltas.flat();
    const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
    let state = Number.parseInt(crypto.createHash('sha256').update(`${result.dataset}|${variantId}|${metric}`).digest('hex').slice(0, 8), 16) >>> 0;
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const samples: number[] = [];
    for (let replicate = 0; replicate < replicates; replicate += 1) {
      let deltaTotal = 0;
      let queryCount = 0;
      for (let draw = 0; draw < clusters.length; draw += 1) {
        const cluster = clusterDeltas[Math.floor(random() * clusterDeltas.length)]!;
        for (const value of cluster) deltaTotal += value;
        queryCount += cluster.length;
      }
      samples.push(deltaTotal / queryCount);
    }
    samples.sort((left, right) => left - right);
    pairedDifference[variantId]![metric] = {
      mean: Number(mean.toFixed(6)),
      ci95: [Number(samples[Math.floor(0.025 * replicates)]!.toFixed(6)), Number(samples[Math.floor(0.975 * replicates)]!.toFixed(6))],
    };
  }
}

const output = {
  generatedAt: new Date().toISOString(),
  dataset: result.dataset,
  documents: result.documents,
  queries: queryIds.length,
  bootstrap: {
    unit: 'connected query clusters sharing one or more relevant target document IDs',
    clusters: clusters.length,
    replicates,
    seed: 'SHA-256(dataset|variant|metric), first 32 bits; LCG',
    interval: 'paired percentile cluster bootstrap 95%; exploratory because query labels are self-derived',
  },
  metrics,
  baselineVariant: baselineId,
  pairedDifferenceVsBaseline: pairedDifference,
  inputs: [resultPath, labelsPath].map(file => ({ path: path.relative(process.cwd(), file), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: outputPath, baselineVariant: baselineId, queries: queryIds.length, clusters: clusters.length, metrics, pairedDifferenceVsBaseline: pairedDifference }, null, 2));
