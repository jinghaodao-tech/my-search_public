import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type MethodResult = { top50: string[]; hit10: boolean; mrr10: number; ndcg10: number };
type QueryRow = { id: string; group_id: string; gold_ids: string[]; bm25: MethodResult; fts5Morph: MethodResult; fts5Raw: MethodResult };
type Report = { dataset: { name: string; sourceSha256: string; split: string }; perQuery: QueryRow[] };
const [outputArg, ...inputArgs] = process.argv.slice(2);
if (!outputArg || inputArgs.length < 1) throw new Error('Usage: tsx scripts/bench/evaluate_api_rank_fusion.ts <new-output.json> <api-report.json> [...reports]');
const outputPath = path.resolve(outputArg);
if (fs.existsSync(outputPath) || !outputPath.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('Output must be new and under artifacts/.');
const reports = inputArgs.map(file => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as Report);
if (reports.some(report => report.dataset.name !== reports[0]!.dataset.name || report.dataset.sourceSha256 !== reports[0]!.dataset.sourceSha256)) throw new Error('All inputs must use the same frozen dataset.');
const rows = reports.flatMap(report => report.perQuery);
if (!rows.length || new Set(rows.map(row => row.group_id)).size !== rows.length) throw new Error('Inputs must contain non-overlapping target groups.');

const metric = (ids: string[], goldIds: string[]) => {
  const gold = new Set(goldIds);
  const relevantRanks = ids.map((id, index) => gold.has(id) ? index + 1 : null).filter((rank): rank is number => rank !== null);
  const first = relevantRanks[0] ?? null;
  const top10 = ids.slice(0, 10);
  const dcg = top10.reduce((sum, id, index) => sum + (gold.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(gold.size, 10) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
  return { hit1: Number(first === 1), hit10: Number(first !== null && first <= 10), mrr10: first !== null && first <= 10 ? 1 / first : 0, nDCG10: ideal ? dcg / ideal : 0 };
};
const fusedIds = (row: QueryRow, signals: Array<'bm25' | 'fts5Morph' | 'fts5Raw'>) => {
  const scores = new Map<string, number>();
  for (const signal of signals) row[signal].top50.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + index + 1)));
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
};
const methods: Record<string, (row: QueryRow) => string[]> = {
  currentBm25: row => row.bm25.top50,
  morphologyFts: row => row.fts5Morph.top50,
  rawFts: row => row.fts5Raw.top50,
  currentBm25PlusMorphologyRrf60: row => fusedIds(row, ['bm25', 'fts5Morph']),
  currentBm25PlusRawRrf60: row => fusedIds(row, ['bm25', 'fts5Raw']),
};
const measured = Object.fromEntries(Object.entries(methods).map(([name, rank]) => [name, rows.map(row => metric(rank(row), row.gold_ids))]));
let seed = Number.parseInt(crypto.createHash('sha256').update(inputArgs.join('\n')).digest('hex').slice(0, 8), 16) >>> 0;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const paired = (candidate: string) => {
  const baseline = measured.currentBm25!;
  const values = measured[candidate]!;
  const difference = (key: 'hit10' | 'mrr10' | 'nDCG10') => values.map((row, index) => row[key] - baseline[index]![key]);
  const bootstrap = (key: 'hit10' | 'mrr10' | 'nDCG10') => {
    const diffs = difference(key);
    const draws = new Array<number>(20_000);
    for (let iteration = 0; iteration < draws.length; iteration++) {
      let sum = 0;
      for (let index = 0; index < diffs.length; index++) sum += diffs[Math.floor(random() * diffs.length)]!;
      draws[iteration] = sum / diffs.length;
    }
    draws.sort((a, b) => a - b);
    return { low95: draws[Math.floor(draws.length * 0.025)]!, high95: draws[Math.floor(draws.length * 0.975)]!, iterations: draws.length };
  };
  return Object.fromEntries((['hit10', 'mrr10', 'nDCG10'] as const).map(key => [key, {
    meanDifference: difference(key).reduce((sum, value) => sum + value, 0) / rows.length,
    pairedBootstrap95: bootstrap(key),
  }]));
};
const summary = Object.fromEntries(Object.entries(measured).map(([name, values]) => [name, {
  hit1: values!.reduce((sum, row) => sum + row.hit1, 0),
  hit10: values!.reduce((sum, row) => sum + row.hit10, 0),
  mrr10: values!.reduce((sum, row) => sum + row.mrr10, 0) / rows.length,
  nDCG10: values!.reduce((sum, row) => sum + row.nDCG10, 0) / rows.length,
}]));
const result = {
  purpose: 'Exploratory post-hoc RRF analysis on Books development API results; no parameters tuned, but the same development corpus has been used for previous method comparisons.',
  inputs: inputArgs.map(file => path.resolve(file)),
  dataset: reports[0]!.dataset,
  groups: rows.length,
  method: 'RRF(k=60) over the first 50 results from the real saved-card API; query and qrels unchanged; group bootstrap is paired by one target group per query.',
  metrics: summary,
  differenceVsCurrentBm25: Object.fromEntries(Object.keys(methods).filter(name => name !== 'currentBm25').map(name => [name, paired(name)])),
  perQuery: rows.map((row, index) => ({ id: row.id, group_id: row.group_id, gold_ids: row.gold_ids, metrics: Object.fromEntries(Object.keys(methods).map(name => [name, measured[name]![index]])) })),
  limits: 'Development-only diagnostic. No holdout or real-world generalization claim; fusion also requires both ranking computations and therefore should not be assumed faster.',
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, groups: result.groups, metrics: result.metrics, differenceVsCurrentBm25: result.differenceVsCurrentBm25 }, null, 2));
