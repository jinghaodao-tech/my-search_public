import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

type Metric = { hit1: number; hit10: number; mrr10: number; ndcg10: number };
type QueryRow = {
  group_id: string;
  standard: Metric;
  signalVariants: Record<string, Metric>;
  titleVariants?: Record<string, Metric>;
};
type Input = { dataset: { sourceSha256: string; split: string }; perQuery: QueryRow[] };
const [outputArg, ...inputArgs] = process.argv.slice(2);
if (!outputArg || inputArgs.length < 1) throw new Error('Usage: summarize_fts_signal_comparison.ts <output.json> <benchmark.json> [...benchmarks]');
const output = path.resolve(outputArg);
if (fs.existsSync(output)) throw new Error(`Refusing to overwrite ${output}`);
const reports = inputArgs.map(file => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as Input);
if (reports.some(report => report.dataset.split !== 'development' || report.dataset.sourceSha256 !== reports[0]!.dataset.sourceSha256)) throw new Error('All inputs must use the same development corpus');
const rows = reports.flatMap(report => report.perQuery);
if (new Set(rows.map(row => row.group_id)).size !== rows.length) throw new Error('Benchmark samples overlap in target groups');
const metrics: Record<string, (row: QueryRow) => Metric> = {
  standardMorphologyBm25: row => row.standard,
  fts5MorphologyOnly: row => row.signalVariants['signals_morphologyOnly']!,
  fts5RawOnly: row => row.signalVariants['signals_rawOnly']!,
  fts5MorphologyRawRrf: row => row.signalVariants['signals_morphologyRaw']!,
  fts5AllThreeRrf: row => row.signalVariants['signals_allThree']!,
  standardPlusFtsMorphologyRrf: row => row.titleVariants!['standardPlusMorphology']!,
  standardPlusFtsRawRrf: row => row.titleVariants!['standardPlusRaw']!,
  standardPlusFtsMorphologyRawRrf: row => row.titleVariants!['standardPlusMorphologyRaw']!,
};
let seed = Number.parseInt(createHash('sha256').update(inputArgs.join('\n')).digest('hex').slice(0, 8), 16) >>> 0;
const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
const differenceCi = (left: number[], right: number[], iterations = 20_000) => {
  const sampled = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let n = 0; n < left.length; n++) {
      const j = Math.floor(random() * left.length);
      sum += left[j]! - right[j]!;
    }
    sampled[i] = sum / left.length;
  }
  sampled.sort((a, b) => a - b);
  return { low95: sampled[Math.floor(iterations * 0.025)]!, high95: sampled[Math.floor(iterations * 0.975)]!, iterations };
};
const summarizePair = (values: QueryRow[]) => {
  const standard = values.map(row => metrics.standardMorphologyBm25(row));
  const names = Object.keys(metrics).filter(name => name !== 'standardMorphologyBm25');
  const modeSummary = (items: Metric[]) => ({
    hitAt1: items.reduce((sum, item) => sum + item.hit1, 0),
    hitAt10: items.reduce((sum, item) => sum + item.hit10, 0),
    mrrAt10: items.reduce((sum, item) => sum + item.mrr10, 0) / items.length,
    nDCGAt10: items.reduce((sum, item) => sum + item.ndcg10, 0) / items.length,
  });
  return Object.fromEntries(names.map(name => {
    const candidate = values.map(row => metrics[name]!(row));
    const discordant = values.reduce((result, row, index) => {
      const baselineHit = standard[index]!.hit10;
      const candidateHit = candidate[index]!.hit10;
      if (candidateHit && !baselineHit) result.candidateOnly++;
      if (baselineHit && !candidateHit) result.standardOnly++;
      return result;
    }, { candidateOnly: 0, standardOnly: 0 });
    const diff = (key: 'hit10' | 'mrr10' | 'ndcg10') => candidate.map((item, index) => item[key] - standard[index]![key]);
    const means = (key: 'hit10' | 'mrr10' | 'ndcg10') => diff(key).reduce((sum, value) => sum + value, 0) / values.length;
    const results = candidate;
    return [name, {
      metrics: modeSummary(results),
      differenceVsStandard: {
        hitAt10: means('hit10'), hitAt10Bootstrap95: differenceCi(candidate.map(item => item.hit10), standard.map(item => item.hit10)),
        mrrAt10: means('mrr10'), mrrAt10Bootstrap95: differenceCi(candidate.map(item => item.mrr10), standard.map(item => item.mrr10)),
        nDCGAt10: means('ndcg10'), nDCGAt10Bootstrap95: differenceCi(candidate.map(item => item.ndcg10), standard.map(item => item.ndcg10)),
        hitTransitions: discordant,
      },
    }];
  }));
};

const perSample = reports.map((report, index) => ({ source: path.resolve(inputArgs[index]!), groups: report.perQuery.length, methods: summarizePair(report.perQuery) }));
const result = {
  purpose: 'Exploratory fixed-method comparison. Target groups are resampled as paired units; the same source corpus is used throughout, so these intervals do not establish independent-corpus generalization.',
  inputs: inputArgs.map(file => path.resolve(file)),
  split: reports[0]!.dataset.split,
  corpusSha256: reports[0]!.dataset.sourceSha256,
  groups: rows.length,
  uniqueTargetGroups: new Set(rows.map(row => row.group_id)).size,
  pooledMethods: summarizePair(rows),
  perSample,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output, groups: result.groups, pooledMethods: result.pooledMethods, perSample: perSample.map(sample => ({ groups: sample.groups, methods: sample.methods })) }, null, 2));
