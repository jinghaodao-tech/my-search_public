import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [denseArg, pairedArg, outputArg] = process.argv.slice(2);
if (!denseArg || !pairedArg || !outputArg) throw new Error('Usage: node scripts/bench/analyze_tomt_books_full_e5_fusion.mjs <full-e5.json> <paired-books-api.json> <new-output.json>');
const dense = JSON.parse(fs.readFileSync(path.resolve(denseArg), 'utf8'));
const paired = JSON.parse(fs.readFileSync(path.resolve(pairedArg), 'utf8'));
const outputPath = path.resolve(outputArg);
if (!outputPath.startsWith(`${path.resolve('quality/e2e/local')}${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new file under the Git-ignored quality/e2e/local directory.');
if (dense.dataset?.name !== 'Reddit-TOMT Books' || dense.dataset?.split !== 'development'
  || paired.dataset?.name !== 'Reddit-TOMT Books' || !/^development\b/iu.test(paired.dataset?.split ?? '')
  || dense.dataset.sourceSha256 !== paired.dataset.sourceSha256
  || dense.dataset.selectedQueryIdsSha256 !== paired.dataset.querySampling?.selectionSha256
  || dense.dataset.queries !== paired.perQuery?.length
  || dense.outcomes.errors !== 0) {
  throw new Error('Dense and paired API results must cover the same error-free development sample and corpus.');
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const denseByQueryHash = new Map(dense.perQueryRankings.map(row => [row.queryIdHash, row]));
const rows = paired.perQuery.map(row => {
  const queryHash = sha(row.id);
  const denseRow = denseByQueryHash.get(queryHash);
  if (!denseRow || denseRow.groupIdHash !== sha(row.group_id) || denseRow.top100Ids.length !== 100) throw new Error('Dense query hashes or ranking depth do not match the paired API sample.');
  return { queryHash, groupHash: sha(row.group_id), gold: new Set(row.gold_ids), paired: row, denseIds: denseRow.top100Ids };
});
if (new Set(rows.map(row => row.queryHash)).size !== rows.length || denseByQueryHash.size !== rows.length) throw new Error('Duplicate or unmatched query IDs in the selected sample.');

const metric = (ids, gold) => {
  const rank = ids.findIndex(id => gold.has(id));
  return { hit1: Number(rank === 0), hit10: Number(rank >= 0 && rank < 10), mrr10: rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0, ndcg10: rank >= 0 && rank < 10 ? 1 / Math.log2(rank + 2) : 0 };
};
const methods = new Map();
for (const [name, accessor] of [
  ['app-bm25', row => row.paired.bm25.top50],
  ['app-fts5-morph', row => row.paired.fts5Morph.top50],
  ['candidate-e5-rrf', row => row.paired.e5Rrf.top50],
  ['full-corpus-e5', row => row.denseIds],
]) {
  methods.set(name, rows.map(row => metric(accessor(row), row.gold)));
}

const weights = [{ bm25: 1, dense: 0.25 }, { bm25: 1, dense: 0.5 }, { bm25: 1, dense: 1 }, { bm25: 2, dense: 1 }, { bm25: 4, dense: 1 }];
for (const weight of weights) {
  methods.set(`fusion-bm25-${weight.bm25}-dense-${weight.dense}`, rows.map(row => {
    const scores = new Map();
    row.paired.fts5Morph.top50.forEach((id, index) => scores.set(id, { score: weight.bm25 / (60 + index + 1), lexicalRank: index + 1, denseRank: Infinity }));
    row.denseIds.forEach((id, index) => {
      const current = scores.get(id);
      if (current) { current.score += weight.dense / (60 + index + 1); current.denseRank = index + 1; }
      else scores.set(id, { score: weight.dense / (60 + index + 1), lexicalRank: Infinity, denseRank: index + 1 });
    });
    const ranking = [...scores].sort((left, right) => right[1].score - left[1].score || left[1].lexicalRank - right[1].lexicalRank || left[1].denseRank - right[1].denseRank || left[0].localeCompare(right[0])).map(([id]) => id);
    return metric(ranking, row.gold);
  }));
}

const groups = new Map();
rows.forEach((row, index) => groups.set(row.groupHash, [...(groups.get(row.groupHash) ?? []), index]));
const clusters = [...groups.values()];
const seedText = dense.dataset.selectedQueryIdsSha256;
let seed = Number.parseInt(sha(seedText).slice(0, 8), 16) >>> 0;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
const summarize = outcomes => {
  const fields = ['hit1', 'hit10', 'mrr10', 'ndcg10'];
  const means = Object.fromEntries(fields.map(field => [field, outcomes.reduce((sum, row) => sum + row[field], 0) / outcomes.length]));
  const bootstrap = [];
  for (let sample = 0; sample < 10000; sample++) {
    let successes = 0; let total = 0;
    for (let draw = 0; draw < clusters.length; draw++) {
      const group = clusters[Math.floor(random() * clusters.length)];
      for (const index of group) { successes += outcomes[index].hit10; total++; }
    }
    bootstrap.push(successes / total);
  }
  bootstrap.sort((a, b) => a - b);
  return { ...means, hit10ClusterBootstrap95: [bootstrap[Math.floor(0.025 * (bootstrap.length - 1))], bootstrap[Math.floor(0.975 * (bootstrap.length - 1))]] };
};
const baseline = methods.get('app-fts5-morph');
const comparisons = Object.fromEntries([...methods].map(([name, outcomes]) => {
  let both = 0; let baselineOnly = 0; let candidateOnly = 0; let neither = 0;
  outcomes.forEach((row, index) => {
    const baseHit = baseline[index].hit10;
    if (baseHit && row.hit10) both++;
    else if (baseHit) baselineOnly++;
    else if (row.hit10) candidateOnly++;
    else neither++;
  });
  return [name, { ...summarize(outcomes), pairedVsAppFts5Morph: { both, baselineOnly, candidateOnly, neither, netDifference: (candidateOnly - baselineOnly) / outcomes.length } }];
}));
const result = {
  audit: 'Exploratory post-hoc dense retrieval/fusion analysis on a previously used Books development sample; no final or independent quality claim.',
  dataset: dense.dataset,
  comparison: 'Ranks are fused only from app FTS5 morphology top 50 and full-corpus dense E5 top 100; documents outside these lists are not observable to fusion.',
  targetGroups: clusters.length,
  outcomes: comparisons,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, dataset: result.dataset, targetGroups: result.targetGroups, outcomes: comparisons }, null, 2));
