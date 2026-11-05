import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

type Rank = number | string | null;
type Row = {
  groupId: string;
  current: { rankTop1000: Rank };
  standardBm25Morphology: { rankTop1000: Rank };
};
type Report = { queryCount: number; selection: Record<string, unknown>; results: Row[] };

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) throw new Error('Usage: summarize_ranking_comparison.ts <diagnostic.json> <summary.json>');
const input = path.resolve(inputArg);
const output = path.resolve(outputArg);
if (fs.existsSync(output)) throw new Error(`Refusing to overwrite ${output}`);
const report = JSON.parse(fs.readFileSync(input, 'utf8')) as Report;
if (report.results.length !== report.queryCount || report.results.some(row => !row.groupId)) throw new Error('Incomplete results or missing target-group IDs');
if (new Set(report.results.map(row => row.groupId)).size !== report.results.length) throw new Error('Expected exactly one query per independent target group');

const reciprocalRank = (rank: Rank) => typeof rank === 'number' && rank > 0 ? 1 / rank : 0;
const hit = (rank: Rank, k: number) => typeof rank === 'number' && rank <= k;
const currentHits = report.results.map(row => Number(hit(row.current.rankTop1000, 10)));
const standardHits = report.results.map(row => Number(hit(row.standardBm25Morphology.rankTop1000, 10)));
const currentMrr = report.results.map(row => reciprocalRank(row.current.rankTop1000) * Number(hit(row.current.rankTop1000, 10)));
const standardMrr = report.results.map(row => reciprocalRank(row.standardBm25Morphology.rankTop1000) * Number(hit(row.standardBm25Morphology.rankTop1000, 10)));
const countTrue = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
const discordantCurrentWins = currentHits.filter((value, index) => value === 1 && standardHits[index] === 0).length;
const discordantStandardWins = standardHits.filter((value, index) => value === 1 && currentHits[index] === 0).length;
const exactMcNemarTwoSided = (a: number, b: number) => {
  const n = a + b;
  if (!n) return 1;
  let tail = 0;
  for (let k = 0; k <= Math.min(a, b); k++) tail += choose(n, k) / 2 ** n;
  return Math.min(1, 2 * tail);
};
function choose(n: number, k: number): number {
  let value = 1;
  for (let i = 1; i <= k; i++) value = value * (n - k + i) / i;
  return value;
}

let seed = Number.parseInt(createHash('sha256').update(input).digest('hex').slice(0, 8), 16) >>> 0;
const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
const bootstrap = (left: number[], right: number[], iterations = 20_000) => {
  const differences = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration++) {
    let diff = 0;
    for (let sample = 0; sample < left.length; sample++) {
      const index = Math.floor(random() * left.length);
      diff += left[index]! - right[index]!;
    }
    differences[iteration] = diff / left.length;
  }
  differences.sort((a, b) => a - b);
  return { low95: differences[Math.floor(iterations * 0.025)]!, high95: differences[Math.floor(iterations * 0.975)]!, iterations };
};
const summary = {
  input,
  queryCount: report.queryCount,
  uniqueTargetGroups: new Set(report.results.map(row => row.groupId)).size,
  selection: report.selection,
  metrics: {
    current: { hitAt10: countTrue(currentHits) / currentHits.length, hitAt10Count: countTrue(currentHits), mrrAt10: currentMrr.reduce((a, b) => a + b, 0) / currentMrr.length },
    standardBm25: { hitAt10: countTrue(standardHits) / standardHits.length, hitAt10Count: countTrue(standardHits), mrrAt10: standardMrr.reduce((a, b) => a + b, 0) / standardMrr.length },
    currentMinusStandard: {
      hitAt10: countTrue(currentHits) / currentHits.length - countTrue(standardHits) / standardHits.length,
      hitAt10PairedBootstrap95: bootstrap(currentHits, standardHits),
      mrrAt10: currentMrr.reduce((a, b) => a + b, 0) / currentMrr.length - standardMrr.reduce((a, b) => a + b, 0) / standardMrr.length,
      mrrAt10PairedBootstrap95: bootstrap(currentMrr, standardMrr),
      discordantGroups: { currentOnlyHit: discordantCurrentWins, standardOnlyHit: discordantStandardWins },
      exactTwoSidedMcNemarP: exactMcNemarTwoSided(discordantCurrentWins, discordantStandardWins),
    },
  },
  interpretation: 'Exploratory development-data comparison only; paired bootstrap resamples target groups. The confidence interval and p-value do not establish performance on new corpora or real user sessions.',
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, ...summary.metrics }, null, 2));
