import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type QueryRow = {
  qid: string;
  group_id?: string;
  groupId?: string;
  expected: string[];
  top10?: string[];
  keyword_terms?: string[];
  parserTerms?: string[];
  rankTop10?: number | null;
  success?: boolean;
  status?: string;
};

const [appPathArg, standardPathArg, outputPathArg] = process.argv.slice(2);
if (!appPathArg || !standardPathArg || !outputPathArg) {
  throw new Error('Usage: npx tsx scripts/bench/compare_article_api_to_standard.ts <api-baseline.json> <standard-bm25.json> <output.json>');
}

const appPath = path.resolve(appPathArg);
const standardPath = path.resolve(standardPathArg);
const outputPath = path.resolve(outputPathArg);
if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite ${outputPath}`);

const app = JSON.parse(fs.readFileSync(appPath, 'utf8')) as {
  stage: string;
  source_sha256: string;
  build_source_fingerprint: string;
  method: string;
  latency_ms_median: number;
  latency_ms_p95: number;
  all_results: QueryRow[];
};
const standard = JSON.parse(fs.readFileSync(standardPath, 'utf8')) as {
  stage: string;
  documentCount: number;
  method: string;
  results: QueryRow[];
};
if (app.stage !== standard.stage) throw new Error(`Stage mismatch: API=${app.stage}, standard=${standard.stage}`);

const appById = new Map(app.all_results.map(row => [row.qid, row]));
const standardById = new Map(standard.results.map(row => [row.qid, row]));
if (!appById.size || appById.size !== standardById.size) throw new Error('Query count mismatch');
for (const id of appById.keys()) if (!standardById.has(id)) throw new Error(`Missing standard result for ${id}`);

const queryIds = [...appById.keys()];
const parent = new Map(queryIds.map(id => [id, id]));
const find = (id: string): string => {
  const previous = parent.get(id);
  if (!previous) throw new Error(`Unknown qid in cluster map: ${id}`);
  if (previous === id) return id;
  const root = find(previous);
  parent.set(id, root);
  return root;
};
const union = (left: string, right: string) => parent.set(find(left), find(right));
const firstForTarget = new Map<string, string>();
const firstForSourceGroup = new Map<string, string>();

for (const id of queryIds) {
  const apiRow = appById.get(id)!;
  const standardRow = standardById.get(id)!;
  if (JSON.stringify(apiRow.expected) !== JSON.stringify(standardRow.expected)) throw new Error(`Expected labels differ for ${id}`);
  if (!apiRow.keyword_terms || !standardRow.parserTerms || JSON.stringify(apiRow.keyword_terms) !== JSON.stringify(standardRow.parserTerms)) {
    throw new Error(`Parser terms differ or are missing for ${id}`);
  }
  if (apiRow.group_id && standardRow.groupId && apiRow.group_id !== standardRow.groupId) throw new Error(`Group ID differs for ${id}`);
  const sourceGroup = apiRow.group_id ?? standardRow.groupId ?? id;
  const groupPrevious = firstForSourceGroup.get(sourceGroup);
  if (groupPrevious) union(id, groupPrevious);
  else firstForSourceGroup.set(sourceGroup, id);
  for (const target of apiRow.expected) {
    const targetPrevious = firstForTarget.get(target);
    if (targetPrevious) union(id, targetPrevious);
    else firstForTarget.set(target, id);
  }
}

type Outcome = { hit1: number; hit10: number; mrr10: number; ndcg10: number };
const metricRows = queryIds.map(id => {
  const apiRow = appById.get(id)!;
  const standardRow = standardById.get(id)!;
  const expected = new Set(apiRow.expected);
  if (!expected.size) throw new Error(`No expected targets for ${id}`);
  const score = (ranking: string[] | undefined): Outcome => {
    const ids = ranking ?? [];
    const positions = ids.slice(0, 10).flatMap((target, index) => expected.has(target) ? [index + 1] : []);
    const first = positions[0];
    const dcg = positions.reduce((sum, rank) => sum + 1 / Math.log2(rank + 1), 0);
    const ideal = Array.from({ length: Math.min(expected.size, 10) }, (_, index) => 1 / Math.log2(index + 2))
      .reduce((sum, value) => sum + value, 0);
    return {
      hit1: Number(ids[0] !== undefined && expected.has(ids[0])),
      hit10: Number(first !== undefined),
      mrr10: first === undefined ? 0 : 1 / first,
      ndcg10: ideal === 0 ? 0 : dcg / ideal,
    };
  };
  if (!apiRow.top10 || !standardRow.top10) throw new Error(`Top10 rank list missing for ${id}`);
  const apiRanking = apiRow.top10;
  const standardRanking = standardRow.top10;
  const api = score(apiRanking);
  const bm25 = score(standardRanking);
  return {
    queryId: id,
    clusterId: find(id),
    expected: apiRow.expected,
    apiStatus: apiRow.status ?? (apiRow.success === false ? 'miss' : 'ok'),
    api,
    standard: bm25,
    difference: Object.fromEntries((Object.keys(api) as Array<keyof Outcome>).map(key => [key, api[key] - bm25[key]])) as Outcome,
  };
});

const grouped = new Map<string, typeof metricRows>();
for (const row of metricRows) grouped.set(row.clusterId, [...(grouped.get(row.clusterId) ?? []), row]);
const clusters = [...grouped.values()];
const metrics = ['hit1', 'hit10', 'mrr10', 'ndcg10'] as const;
const mean = (rows: typeof metricRows, field: 'api' | 'standard' | 'difference', metric: typeof metrics[number]) =>
  rows.reduce((sum, row) => sum + row[field][metric], 0) / rows.length;
const observed = Object.fromEntries(metrics.map(metric => [metric, {
  api: mean(metricRows, 'api', metric),
  standardBm25: mean(metricRows, 'standard', metric),
  difference: mean(metricRows, 'difference', metric),
}]));

const replicates = 20_000;
let randomState = Number.parseInt(crypto.createHash('sha256').update(`article-api-vs-standard|${app.stage}`).digest('hex').slice(0, 8), 16) >>> 0;
const random = () => {
  randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
  return randomState / 0x1_0000_0000;
};
const samples = Object.fromEntries(metrics.map(metric => [metric, [] as number[]])) as Record<typeof metrics[number], number[]>;
for (let replicate = 0; replicate < replicates; replicate += 1) {
  const totals = Object.fromEntries(metrics.map(metric => [metric, 0])) as Record<typeof metrics[number], number>;
  let queryCount = 0;
  for (let draw = 0; draw < clusters.length; draw += 1) {
    const cluster = clusters[Math.floor(random() * clusters.length)]!;
    queryCount += cluster.length;
    for (const metric of metrics) totals[metric] += cluster.reduce((sum, row) => sum + row.difference[metric], 0);
  }
  for (const metric of metrics) samples[metric].push(totals[metric] / queryCount);
}
const percentile = (values: number[], p: number) => values[Math.floor(p * values.length)] ?? 0;
const intervals = Object.fromEntries(metrics.map(metric => {
  samples[metric].sort((left, right) => left - right);
  return [metric, [percentile(samples[metric], 0.025), percentile(samples[metric], 0.975)]];
}));

const output = {
  generatedAt: new Date().toISOString(),
  dataset: {
    name: 'Japanese public technical article metadata',
    stage: app.stage,
    documents: standard.documentCount,
    queries: metricRows.length,
    labelWarning: 'Queries were self-derived from title/tags; these are not natural my-search user sessions.',
  },
  pairing: {
    parserTermsVerifiedSeparately: true,
    queryAndExpectedSetMatch: true,
    sharedGoldTargetClusters: clusters.length,
    bootstrapUnit: 'connected components by source group ID and shared expected target IDs',
    replicates,
    seed: `sha256(article-api-vs-standard|${app.stage}) first 32 bits`,
    interval: 'paired percentile cluster bootstrap 95%; exploratory, not confirmatory',
  },
  method: {
    app: app.method,
    standardBm25: standard.method,
    apiBuildFingerprint: app.build_source_fingerprint,
    appErrors: metricRows.filter(row => row.apiStatus !== 'ok').length,
    latencyScopeWarning: 'API p50/p95 includes two HTTP endpoints and route work; standard p50/p95 is in-process ranker timing. Do not interpret as a latency head-to-head.',
  },
  metrics: observed,
  differenceCi95: intervals,
  latencyMs: { api: { p50: app.latency_ms_median, p95: app.latency_ms_p95 } },
  inputs: [appPath, standardPath].map(file => ({ path: path.relative(process.cwd(), file), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
  perQuery: metricRows,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: outputPath, queries: metricRows.length, clusters: clusters.length, metrics: observed, differenceCi95: intervals, appErrors: output.method.appErrors }, null, 2));
