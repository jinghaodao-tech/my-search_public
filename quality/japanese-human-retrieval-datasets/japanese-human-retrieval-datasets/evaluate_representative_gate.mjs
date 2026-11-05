#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    options[key.slice(2)] = argv[++index];
  }
  for (const required of ['representatives', 'candidate']) if (!options[required]) throw new Error(`--${required} is required`);
  return options;
}
function readJsonl(file) { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
function logFactorials(n) { const values = Array(n + 1).fill(0); for (let i = 1; i <= n; i++) values[i] = values[i - 1] + Math.log(i); return values; }
function binomialTail(k, n, p, logFact = logFactorials(n)) {
  if (k <= 0) return 1;
  if (k > n || p <= 0) return 0;
  if (p >= 1) return 1;
  let sum = 0;
  for (let x = k; x <= n; x++) {
    const logP = logFact[n] - logFact[x] - logFact[n - x] + x * Math.log(p) + (n - x) * Math.log1p(-p);
    sum += Math.exp(logP);
  }
  return Math.min(1, sum);
}
export function clopperPearsonLower(successes, n, alpha = 0.025) {
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(successes) || successes < 0 || successes > n || !(alpha > 0 && alpha < 1)) throw new Error('Invalid binomial inputs');
  if (successes === 0) return 0;
  if (successes === n) return Math.pow(alpha, 1 / n);
  const logFact = logFactorials(n);
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 64; iteration++) {
    const mid = (low + high) / 2;
    if (binomialTail(successes, n, mid, logFact) < alpha) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
function rng(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
function quantile(sorted, p) { const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
function resultMap(file, ids) {
  const rows = new Map();
  for (const row of readJsonl(file)) {
    const id = String(row.qid ?? row.id ?? '');
    if (!id || rows.has(id) || !ids.has(id) || typeof row.hit10 !== 'boolean') throw new Error(`Invalid, duplicate, or unexpected result: ${id}`);
    rows.set(id, row.hit10);
  }
  if (rows.size !== ids.size) throw new Error(`Incomplete results: expected ${ids.size}, got ${rows.size}`);
  return rows;
}
export function evaluateRepresentativeHits(representatives, candidate, baseline, {target = 0.95, alpha = 0.025, bootstrap = 20000, seed = 20261021} = {}) {
  const ids = new Set(representatives.map(row => String(row.id ?? '')));
  const groups = representatives.map(row => String(row.group_id ?? ''));
  if (!ids.size || ids.has('') || ids.size !== representatives.length || groups.includes('') || new Set(groups).size !== groups.length) throw new Error('Require unique IDs and exactly one query per cluster');
  for (const [label, results] of [['candidate', candidate], ['baseline', baseline]]) {
    if (results === null && label === 'baseline') continue;
    if (!(results instanceof Map) || results.size !== ids.size || [...results.keys()].some(id => !ids.has(id)) || [...results.values()].some(value => typeof value !== 'boolean')) throw new Error(`Incomplete or invalid ${label} Hit@10 results`);
  }
  const candidateHits = representatives.map(row => candidate.get(String(row.id)));
  const stats = hits => {
    const successes = hits.filter(Boolean).length, n = hits.length;
    return {n, hits: successes, rate: successes / n, oneSidedLowerBound: clopperPearsonLower(successes, n, alpha), nullTailPValue: binomialTail(successes, n, target), passes: clopperPearsonLower(successes, n, alpha) > target};
  };
  const candidateStats = stats(candidateHits);
  const report = {status: candidateStats.passes ? 'PASS' : 'FAIL', scope: 'selected MIRACL query representatives; not real-world saved-article refinding', representativeCount: representatives.length, clusterCount: new Set(groups).size, target, oneSidedAlpha: alpha, candidate: candidateStats};
  if (baseline) {
    const baselineHits = representatives.map(row => baseline.get(String(row.id)));
    let improved = 0, worsened = 0;
    const differences = candidateHits.map((after, index) => { const before = baselineHits[index]; if (!before && after) improved++; else if (before && !after) worsened++; return Number(after) - Number(before); });
    const discordant = improved + worsened;
    const discordantTail = (cutoff, n) => { const facts = logFactorials(n); let sum = 0; for (let k = 0; k <= cutoff; k++) sum += Math.exp(facts[n] - facts[k] - facts[n-k] - n * Math.log(2)); return sum; };
    const mcnemarP = discordant ? Math.min(1, 2 * discordantTail(Math.min(improved, worsened), discordant)) : 1;
    const random = rng(seed), samples = [];
    for (let i = 0; i < bootstrap; i++) { let sum = 0; for (let j = 0; j < differences.length; j++) sum += differences[Math.floor(random() * differences.length)]; samples.push(sum / differences.length); }
    samples.sort((a, b) => a - b);
    report.baseline = stats(baselineHits);
    report.pairedComparison = {differenceCandidateMinusBaseline: candidateStats.rate - report.baseline.rate, improvedClusters: improved, worsenedClusters: worsened, exactMcNemarTwoSidedP: mcnemarP, clusterBootstrap95PctCi: [quantile(samples, .025), quantile(samples, .975)], bootstrapReplicates: bootstrap, seed};
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const representativesPath = path.resolve(args.representatives);
  const representatives = readJsonl(representativesPath);
  const ids = new Set(representatives.map(row => String(row.id)));
  const candidate = resultMap(path.resolve(args.candidate), ids);
  const baseline = args.baseline ? resultMap(path.resolve(args.baseline), ids) : null;
  const report = evaluateRepresentativeHits(representatives, candidate, baseline, {
    target: args.target === undefined ? .95 : Number(args.target),
    alpha: args.alpha === undefined ? .025 : Number(args.alpha),
    bootstrap: args.bootstrap === undefined ? 20000 : Number(args.bootstrap),
    seed: args.seed === undefined ? 20261021 : Number(args.seed),
  });
  report.selectionSha256 = crypto.createHash('sha256').update(fs.readFileSync(representativesPath)).digest('hex');
  report.candidateResultsSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.resolve(args.candidate))).digest('hex');
  if (args.baseline) report.baselineResultsSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.resolve(args.baseline))).digest('hex');
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) {
    const destination = path.resolve(args.out);
    if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite result: ${destination}`);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.writeFileSync(destination, output, {encoding: 'utf8', flag: 'wx'});
  }
  process.stdout.write(output);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(error); process.exitCode = 1; });
