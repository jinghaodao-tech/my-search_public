import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type RankedMethod = { top100: string[] };
type QueryRow = { id: string; groupId: string; 'standard-bm25': RankedMethod; 'e5-small': RankedMethod };
type BenchmarkArtifact = {
  dataset: { name: string; split: string; queries: number; corpusSha256: string; queriesSha256: string; qrelsSha256: string };
  model: { id: string; onnxSha256: string; tokenizerSha256: string };
  perQuery: QueryRow[];
};
type QueryCase = { id: string; groupId: string; lexical: string[]; semantic: string[]; judgments: Map<string, number> };
type Metrics = { hit1: number; hit10: number; mrr10: number; ndcg10: number; recall100: number; map100: number };

const args = process.argv.slice(2);
const outputArg = args[0];
const pairs = args.slice(1);
if (!outputArg || pairs.length < 4 || pairs.length % 2 !== 0) {
  throw new Error('Usage: tsx scripts/bench/analyze_e5_rrf_weight_transfer.ts <new-output.json> <selection-artifact.json> <selection-dataset-dir> <transfer-artifact.json> <transfer-dataset-dir> [...]');
}
const outputPath = path.resolve(outputArg);
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new file under artifacts/.');
const weightGrid = [0.5, 0.75, 1, 1.5, 2, 3, 4];
const k = 60;

const hashFile = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readInputs = (artifactArg: string, datasetArg: string) => {
  const artifactPath = path.resolve(artifactArg);
  const datasetDir = path.resolve(datasetArg);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as BenchmarkArtifact;
  if (artifact.model.id !== 'Xenova/multilingual-e5-small' || !artifact.perQuery?.length) throw new Error(`Unexpected or empty embedding artifact: ${artifactPath}`);
  const qrelsPath = path.join(datasetDir, 'qrels', `${artifact.dataset.split}.tsv`);
  if (!fs.existsSync(qrelsPath)) throw new Error(`Missing qrels: ${qrelsPath}`);
  const qrels = new Map<string, Map<string, number>>();
  for (const [lineNumber, line] of fs.readFileSync(qrelsPath, 'utf8').split(/\r?\n/u).entries()) {
    if (!line.trim() || line.startsWith('query-id')) continue;
    const [queryId, docId, scoreText] = line.split('\t');
    const score = Number(scoreText);
    if (!queryId || !docId || !Number.isFinite(score)) throw new Error(`Invalid qrels at ${qrelsPath}:${lineNumber + 1}`);
    const judgments = qrels.get(queryId) ?? new Map<string, number>();
    judgments.set(docId, Math.max(judgments.get(docId) ?? 0, score));
    qrels.set(queryId, judgments);
  }
  if (artifact.perQuery.length !== artifact.dataset.queries || qrels.size !== artifact.dataset.queries) {
    throw new Error(`Query count mismatch for ${artifact.dataset.name}: artifact=${artifact.perQuery.length}, qrels=${qrels.size}, declared=${artifact.dataset.queries}`);
  }
  const queries = artifact.perQuery.map(row => {
    const judgments = qrels.get(row.id);
    if (!judgments || !row.groupId || !Array.isArray(row['standard-bm25']?.top100) || !Array.isArray(row['e5-small']?.top100)) {
      throw new Error(`Missing query/ranking data for ${row.id} in ${artifactPath}`);
    }
    return { id: row.id, groupId: row.groupId, lexical: row['standard-bm25'].top100, semantic: row['e5-small'].top100, judgments } satisfies QueryCase;
  });
  return { artifactPath, artifact, qrelsPath, queries, hashes: { artifactSha256: hashFile(artifactPath), qrelsSha256: hashFile(qrelsPath) } };
};

const fuse = (query: QueryCase, lexicalWeight: number): string[] => {
  const scores = new Map<string, number>();
  const add = (ranking: string[], weight: number) => ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank + 1)));
  add(query.lexical, lexicalWeight);
  add(query.semantic, 1);
  return [...scores].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 100).map(([id]) => id);
};

const score = (ranking: string[], judgments: Map<string, number>): Metrics => {
  const relevant = new Set([...judgments].filter(([, grade]) => grade > 0).map(([id]) => id));
  const first = ranking.findIndex(id => relevant.has(id));
  const top10 = ranking.slice(0, 10);
  const dcg = top10.reduce((sum, id, index) => sum + (2 ** (judgments.get(id) ?? 0) - 1) / Math.log2(index + 2), 0);
  const ideal = [...judgments.values()].filter(grade => grade > 0).sort((a, b) => b - a).slice(0, 10)
    .reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  let hitCount = 0;
  let precisionSum = 0;
  for (const [index, id] of ranking.entries()) if (relevant.has(id)) { hitCount++; precisionSum += hitCount / (index + 1); }
  return { hit1: first === 0 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0,
    mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0,
    recall100: relevant.size ? hitCount / relevant.size : 0, map100: relevant.size ? precisionSum / relevant.size : 0 };
};
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const bootstrap = (queries: QueryCase[], deltas: number[], datasetKey: string) => {
  const grouped = new Map<string, number[]>();
  queries.forEach((query, index) => grouped.set(query.groupId, [...(grouped.get(query.groupId) ?? []), deltas[index]!]));
  const groups = [...grouped.values()];
  let seed = Number.parseInt(crypto.createHash('sha256').update(`${datasetKey}|rrf-weight-grid-v1`).digest('hex').slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = new Array<number>(10_000);
  for (let draw = 0; draw < draws.length; draw++) {
    let sum = 0;
    let count = 0;
    for (let index = 0; index < groups.length; index++) for (const value of groups[Math.floor(random() * groups.length)]!) { sum += value; count++; }
    draws[draw] = count ? sum / count : 0;
  }
  draws.sort((a, b) => a - b);
  return { clusters: groups.length, ci95: [draws[249]!, draws[9749]!] };
};
const evaluate = (dataset: ReturnType<typeof readInputs>, lexicalWeight: number) => {
  const metrics = dataset.queries.map(query => score(fuse(query, lexicalWeight), query.judgments));
  const standard = dataset.queries.map(query => score(query.lexical, query.judgments));
  const keys: (keyof Metrics)[] = ['hit1', 'hit10', 'mrr10', 'ndcg10', 'recall100', 'map100'];
  const values = Object.fromEntries(keys.map(key => [key, mean(metrics.map(row => row[key]))])) as Metrics;
  const bm25 = Object.fromEntries(keys.map(key => [key, mean(standard.map(row => row[key]))])) as Metrics;
  const deltas = Object.fromEntries(keys.map(key => {
    const differences = metrics.map((row, index) => row[key] - standard[index]![key]);
    return [key, { mean: mean(differences), ...bootstrap(dataset.queries, differences, `${dataset.artifact.dataset.name}|${dataset.artifact.dataset.split}|bm25-weight-${lexicalWeight}|${key}`) }];
  }));
  return { bm25, rrf: values, deltas };
};

const datasets = [];
for (let index = 0; index < pairs.length; index += 2) datasets.push(readInputs(pairs[index]!, pairs[index + 1]!));
const selection = datasets[0]!;
const selectionGrid = weightGrid.map(weight => ({ weight, result: evaluate(selection, weight) }));
selectionGrid.sort((left, right) => right.result.rrf.ndcg10 - left.result.rrf.ndcg10 || Math.abs(left.weight - 1) - Math.abs(right.weight - 1));
const selectedWeight = selectionGrid[0]!.weight;
const result = {
  method: { name: 'BM25 + E5 weighted reciprocal rank fusion', formula: 'wBM25/(60+rank) + 1*E5/(60+rank)', k, semanticWeight: 1,
    grid: weightGrid, selectionMetric: 'FiQA development nDCG@10', selectionTieBreak: 'weight closest to 1',
    selectionDataset: { name: selection.artifact.dataset.name, split: selection.artifact.dataset.split, queries: selection.queries.length, qrelsSha256: selection.artifact.dataset.qrelsSha256 },
    selectedBm25Weight: selectedWeight, status: 'exploratory transfer; all datasets were used in prior retrieval exploration' },
  selectionGrid: selectionGrid.map(row => ({ bm25Weight: row.weight, bm25Ndcg10: row.result.bm25.ndcg10, rrfNdcg10: row.result.rrf.ndcg10,
    deltaNdcg10: row.result.deltas.ndcg10.mean, ci95: row.result.deltas.ndcg10.ci95 })),
  transfer: datasets.map(dataset => ({ dataset: dataset.artifact.dataset.name, split: dataset.artifact.dataset.split,
    queries: dataset.queries.length, clusters: new Set(dataset.queries.map(query => query.groupId)).size,
    sourceArtifactSha256: dataset.hashes.artifactSha256, qrelsSha256: dataset.hashes.qrelsSha256,
    ...evaluate(dataset, selectedWeight) })),
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, method: result.method, selectionGrid: result.selectionGrid,
  transfer: result.transfer.map(({ dataset, split, queries, clusters, bm25, rrf, deltas }) => ({ dataset, split, queries, clusters,
    bm25Ndcg10: bm25.ndcg10, rrfNdcg10: rrf.ndcg10, delta: deltas.ndcg10.mean, ci95: deltas.ndcg10.ci95 })) }, null, 2));
