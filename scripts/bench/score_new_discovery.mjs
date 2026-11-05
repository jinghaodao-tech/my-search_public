import fs from 'node:fs';
import path from 'node:path';
import { scoreDiscoveryRun } from './new_discovery_metrics.mjs';

const [inputArg] = process.argv.slice(2);
if (!inputArg) throw Error('Usage: node scripts/bench/score_new_discovery.mjs <private-study.json>');
const privateRoot = fs.realpathSync('quality/e2e/local');
const inputPath = path.resolve(inputArg);
const relative = path.relative(privateRoot, inputPath);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Study data must be inside quality/e2e/local/');
const actualPath = fs.realpathSync(inputPath);
const actualRelative = path.relative(privateRoot, actualPath);
if (!actualRelative || actualRelative.startsWith('..') || path.isAbsolute(actualRelative)) throw Error('Study path escapes the private directory through a link');

const study = JSON.parse(fs.readFileSync(actualPath, 'utf8'));
const result = scoreDiscoveryRun(study);
// Do not print source queries, judged articles, or private identifiers.
console.log(JSON.stringify({
  status: result.status,
  issues: result.issues,
  metric: result.metric,
  queryCount: result.queryCount,
  positiveIdcgQueries: result.positiveIdcgQueries,
  zeroIdcgQueries: result.zeroIdcgQueries,
  metrics: Object.fromEntries(Object.entries(result.metrics).map(([engine, values]) => [engine, {
    n: values.n,
    meanNdcg10: values.meanNdcg10,
  }])),
  note: result.note,
}, null, 2));
if (result.status === 'NOT_EVALUABLE') process.exitCode = 2;
