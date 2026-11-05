import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const names = {
  books100: 'tomt-books-e5-dev-100-offset100-20261025',
  books50: 'tomt-books-e5-candidates50-dev-offset100-20261025',
  movies50: 'tomt-movies-e5-candidates50-dev-offset100-20261025',
};
const inputs = Object.fromEntries(Object.entries(names).map(([key, name]) => {
  const file = `artifacts/${name}.json`;
  const bytes = fs.readFileSync(file);
  return [key, { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), data: JSON.parse(bytes) }];
}));
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
function paired(left, right, leftArm, rightArm, metric) {
  const lookup = new Map(left.map(row => [row.id, row]));
  assert.equal(lookup.size, right.length);
  const groups = new Map();
  for (const row of right) {
    const before = lookup.get(row.id);
    assert.ok(before, `Missing paired query ${row.id}`);
    assert.equal(before.group_id, row.group_id);
    assert.equal(before.query, row.query);
    assert.deepEqual(before.gold_ids, row.gold_ids);
    const values = groups.get(row.group_id) ?? [];
    values.push(Number(row[rightArm][metric]) - Number(before[leftArm][metric]));
    groups.set(row.group_id, values);
  }
  const clusters = [...groups.values()];
  let seed = 0x25c0ffee;
  const samples = [];
  for (let i = 0; i < 10000; i++) {
    const values = [];
    for (let j = 0; j < clusters.length; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      values.push(...clusters[Math.floor(seed / 0x100000000 * clusters.length)]);
    }
    samples.push(mean(values));
  }
  samples.sort((a, b) => a - b);
  return { difference: mean(clusters.flat()), ci95: [samples[249], samples[9749]], groups: clusters.length };
}
for (const { data } of Object.values(inputs)) {
  assert.equal(data.perQuery.length, 100);
  assert.equal(new Set(data.perQuery.map(row => row.id)).size, 100);
  for (const arm of ['bm25', 'fts5Rrf', 'fts5Raw', 'fts5Morph', 'e5Rrf']) {
    for (const row of data.perQuery) {
      assert.equal(row[arm].error, null);
      const gold = new Set(row.gold_ids);
      const top = row[arm].top10;
      const dcg = top.reduce((sum, id, i) => sum + (gold.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
      const ideal = Array.from({ length: Math.min(10, gold.size) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(row[arm].ndcg10 - dcg / ideal) < 1e-12);
      assert.equal(row[arm].hit10, top.some(id => gold.has(id)));
    }
    assert.ok(Math.abs(mean(data.perQuery.map(row => row[arm].ndcg10)) - data.results[arm].ndcg10) < 1e-12);
  }
}
const a = inputs.books100.data, b = inputs.books50.data, m = inputs.movies50.data;
assert.equal(a.dataset.queriesSha256, b.dataset.queriesSha256);
assert.equal(a.dataset.sourceSha256, b.dataset.sourceSha256);
for (let i = 0; i < a.perQuery.length; i++) assert.deepEqual(a.perQuery[i].bm25.top10, b.perQuery[i].bm25.top10);
const report = {
  inputs: Object.fromEntries(Object.entries(inputs).map(([key, { file, sha256 }]) => [key, { file, sha256 }])),
  method: { bootstrapReplicates: 10000, seed: '0x25c0ffee', unit: 'target group', independentValidation: false, candidateDepthProvenance: 'Historical run labels; input JSON does not record effective candidate depth.', latency: 'Separate runs, descriptive only; no causal speedup claim.' },
  books50Minus100: Object.fromEntries(['ndcg10', 'hit10'].map(metric => [metric, paired(a.perQuery, b.perQuery, 'e5Rrf', 'e5Rrf', metric)])),
  movies50MinusApplicationBm25: Object.fromEntries(['ndcg10', 'hit10'].map(metric => [metric, paired(m.perQuery, m.perQuery, 'bm25', 'e5Rrf', metric)])),
  summaries: Object.fromEntries(Object.entries(inputs).map(([key, { data }]) => [key, { bm25: data.results.bm25, e5Rrf: data.results.e5Rrf }])),
};
const output = 'artifacts/tomt-candidate-depth-analysis-20261025.json';
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
