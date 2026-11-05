import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {hitMetrics} from './miracl_metrics.js';

const [checkpointArg, outputArg] = process.argv.slice(2);
if (!checkpointArg || !outputArg) {
  throw new Error('Usage: npx tsx quality/japanese-human-retrieval-datasets/audit_miracl_hit10_checkpoint.ts <consumed-checkpoint.jsonl> <new-audit.json>');
}
const checkpointPath = path.resolve(checkpointArg);
const outputPath = path.resolve(outputArg);
if (!checkpointPath.endsWith(`${path.sep}miracl-holdout-api-20261022.checkpoint.jsonl`)) {
  throw new Error('Refusing an unexpected checkpoint; this is a post-hoc audit of the consumed 2026-10-22 run only.');
}
if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite ${outputPath}`);
const raw = fs.readFileSync(checkpointPath);
const rows = raw.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) as Array<{
  qid:string; group_id:string; gold_ids:string[];
  arms:Record<'0'|'0.2',{top10:string[];hit10:boolean;hit50:boolean;error:string|null}>;
}>;
if (rows.length !== 726) throw new Error(`Expected exactly 726 frozen rows; found ${rows.length}`);

const summarize = (arm:'0'|'0.2') => {
  let hit1 = 0, hit10 = 0, hit50 = 0, mrr10 = 0, ndcg10 = 0, storedHit10Mismatch = 0;
  for (const row of rows) {
    const stored = row.arms[arm];
    const corrected = hitMetrics(stored.top10, row.gold_ids);
    hit1 += Number(corrected.hit1);
    hit10 += Number(corrected.hit10);
    hit50 += Number(stored.hit50);
    mrr10 += corrected.rr10;
    ndcg10 += corrected.ndcg10;
    storedHit10Mismatch += Number(corrected.hit10 !== stored.hit10);
  }
  return {n:rows.length,hit1,correctedHit10:hit10,storedHit10:rows.filter(row => row.arms[arm].hit10).length,
    storedHit10Mismatch,storedHit50:hit50,mrr10:mrr10/rows.length,ndcg10:ndcg10/rows.length};
};

let both = 0, baselineOnly = 0, candidateOnly = 0, neither = 0;
for (const row of rows) {
  const gold = new Set(row.gold_ids);
  const baseline = row.arms['0'].top10.some(id => gold.has(id));
  const candidate = row.arms['0.2'].top10.some(id => gold.has(id));
  if (baseline && candidate) both++;
  else if (baseline) baselineOnly++;
  else if (candidate) candidateOnly++;
  else neither++;
}
const nDiscordant = baselineOnly + candidateOnly;
const lower = Math.min(baselineOnly, candidateOnly);
let probability = 0.5 ** nDiscordant, exactMcNemarTwoSided = 0;
for (let k = 0; k <= nDiscordant; k++) {
  if (k <= lower || k >= nDiscordant - lower) exactMcNemarTwoSided += probability;
  probability *= (nDiscordant - k) / (k + 1);
}

const result = {
  audit:'post-hoc correction of a consumed holdout evaluator; not independent validation and not for tuning',
  checkpointPath,
  checkpointSha256:crypto.createHash('sha256').update(raw).digest('hex'),
  queryCount:rows.length,
  metricDefinition:'Hit@10 and MRR@10 are recomputed only from the stored top10 IDs; Hit@50 is the stored flag computed from the API response top50. Returned result counts and ranks 11-50 were not persisted.',
  baseline:summarize('0'),
  titleCoverageRerank:summarize('0.2'),
  correctedPairedHit10:{both,baselineOnly,candidateOnly,neither,absoluteDifference:(candidateOnly-baselineOnly)/rows.length,exactMcNemarTwoSided},
  independentEvaluation:'NOT_EVALUABLE: the holdout was already consumed; this correction only diagnoses the metric bug.',
};
fs.mkdirSync(path.dirname(outputPath), {recursive:true});
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), {flag:'wx'});
console.log(JSON.stringify(result, null, 2));
