#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

function loadReport(file) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = report.all_results ?? report.results ?? report.outcomes;
  if (!Array.isArray(rows)) throw new Error(`${file}: result rows missing`);
  const byId = new Map();
  for (const item of rows) {
    const id = String(item.qid ?? item.id ?? '');
    const expected = item.expected ?? item.gold_ids;
    if (!id || byId.has(id) || !Array.isArray(expected) || !expected.length || typeof item.hit10 !== 'boolean') throw new Error(`${file}: invalid/duplicate result ${id}`);
    byId.set(id, {expected: [...expected].map(String).sort(), group: String(item.group_id ?? item.groupId ?? id), hit: item.hit10});
  }
  return {report, byId, bytes: fs.readFileSync(file)};
}
function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
function quantile(sorted, p) {
  const index = (sorted.length - 1) * p, low = Math.floor(index), high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] * (high - index) + sorted[high] * (index - low);
}
function logFactorials(n) { const result = Array(n + 1).fill(0); for (let i = 1; i <= n; i++) result[i] = result[i - 1] + Math.log(i); return result; }
function exactMcNemar(improved, worsened) {
  const n = improved + worsened;
  if (!n) return 1;
  const facts = logFactorials(n), cutoff = Math.min(improved, worsened);
  let tail = 0;
  for (let k = 0; k <= cutoff; k++) tail += Math.exp(facts[n] - facts[k] - facts[n-k] - n * Math.log(2));
  return Math.min(1, 2 * tail);
}
export function compareMiraclReports(before, after, {bootstrap = 20000, seed = 20261021} = {}) {
  const baseline = before.byId ?? before;
  const candidate = after.byId ?? after;
  if (baseline.size !== candidate.size || [...baseline.keys()].some(id => !candidate.has(id))) throw new Error('Reports must contain exactly the same query IDs');
  const groups = new Map();
  let baselineHits = 0, candidateHits = 0, improved = 0, worsened = 0;
  for (const [id, prior] of baseline) {
    const current = candidate.get(id);
    if (JSON.stringify(prior.expected) !== JSON.stringify(current.expected)) throw new Error(`Gold labels differ for ${id}`);
    if (prior.group !== current.group) throw new Error(`Cluster differs for ${id}`);
    baselineHits += Number(prior.hit);
    candidateHits += Number(current.hit);
    if (!prior.hit && current.hit) improved++;
    if (prior.hit && !current.hit) worsened++;
    const group = groups.get(prior.group) ?? [];
    group.push([prior.hit, current.hit]);
    groups.set(prior.group, group);
  }
  const n = baseline.size, delta = (candidateHits - baselineHits) / n, groupRows = [...groups.values()];
  const random = randomGenerator(seed), samples = [];
  for (let replicate = 0; replicate < bootstrap; replicate++) {
    let totalDelta = 0, totalQueries = 0;
    for (let index = 0; index < groupRows.length; index++) {
      const rows = groupRows[Math.floor(random() * groupRows.length)];
      for (const [pre, post] of rows) { totalDelta += Number(post) - Number(pre); totalQueries++; }
    }
    samples.push(totalDelta / totalQueries);
  }
  const centeredExceedances = samples.filter(value => Math.abs(value - delta) >= Math.abs(delta)).length;
  const allSingletons = groupRows.every(rows => rows.length === 1);
  const sortedSamples = samples.sort((a,b)=>a-b);
  return {
    n,
    clusters: groups.size,
    repeatedClusters: groupRows.filter(rows => rows.length > 1).length,
    baselineHit10: baselineHits / n,
    candidateHit10: candidateHits / n,
    pairedDifference: delta,
    clusterBootstrap95PctCi: [quantile(sortedSamples, .025), quantile(sortedSamples, .975)],
    centeredClusterBootstrapTwoSidedP: (centeredExceedances + 1) / (bootstrap + 1),
    discordantQueries: improved + worsened,
    improvedQueries: improved,
    worsenedQueries: worsened,
    exactMcNemarTwoSidedP: allSingletons ? exactMcNemar(improved, worsened) : null,
    bootstrapReplicates: bootstrap,
    seed,
    note: 'Exploratory for development/validation; not a substitute for the sealed final holdout.',
  };
}

async function main() {
  const [baselinePath, candidatePath, outputPath, bootstrapArg, seedArg] = process.argv.slice(2);
  if (!baselinePath || !candidatePath) throw new Error('Usage: node compare_miracl_results.mjs <baseline.json> <candidate.json> [new-output.json] [bootstrap=20000] [seed=20261021]');
  const before = loadReport(baselinePath), after = loadReport(candidatePath);
  const result = {
    dataset: before.report.dataset ?? after.report.dataset ?? 'MIRACL Japanese',
    baseline: {path: path.resolve(baselinePath), sha256: crypto.createHash('sha256').update(before.bytes).digest('hex'), engine: before.report.engine ?? before.report.ranking ?? 'baseline'},
    candidate: {path: path.resolve(candidatePath), sha256: crypto.createHash('sha256').update(after.bytes).digest('hex'), engine: after.report.engine ?? 'candidate'},
    comparison: compareMiraclReports(before, after, {bootstrap: bootstrapArg ? Number(bootstrapArg) : 20000, seed: seedArg ? Number(seedArg) : 20261021}),
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    const target = path.resolve(outputPath);
    if (fs.existsSync(target)) throw new Error(`Refusing to overwrite comparison artifact: ${target}`);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, output, {encoding: 'utf8', flag: 'wx'});
  }
  process.stdout.write(output);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(error); process.exitCode = 1; });
