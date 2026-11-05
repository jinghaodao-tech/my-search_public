import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreObservation, targetGroups, summarizeQuality } from '../scripts/bench/personal_refind_metrics.mjs';

const record = (id = 'a') => ({ id, goldIds: [id], humanVerified: true, savedBeforeQuery: true,
  split: 'final', category: 'memory', eligibility: 'eligible', origin: 'human-natural-refind' });
const observation = (id = 'a') => ({ caseId: id, httpStatus: 200, top10Ids: [id], error: null, timedOut: false, totalLatencyMs: 20 });
test('rank 1 and 10 succeed, rank 11 fails; multiple golds count once', () => {
  for (const rank of [1, 10, 11]) {
    const top10Ids = Array.from({ length: rank - 1 }, (_, i) => `other-${i}`).concat('a');
    assert.equal(scoreObservation(record(), { ...observation(), top10Ids }).hit, Number(rank <= 10));
  }
  assert.equal(scoreObservation({ ...record(), goldIds: ['a', 'b'] }, { ...observation(), top10Ids: ['b', 'a'] }).hit, 1);
});
test('API and timeout failures stay in the denominator', () => {
  const cases = Array.from({ length: 100 }, (_, i) => record(String(i)));
  const results = cases.map(c => observation(c.id));
  for (let i = 0; i < 5; i++) results[i] = { ...results[i], error: 'error', timedOut: i === 0 };
  const summary = summarizeQuality(cases, results, { freezeVerified: true });
  assert.equal(summary.questions, 100); assert.equal(summary.hit10, .95); assert.equal(summary.status, 'PASS');
  assert.equal(summary.failures['api-error'], 4); assert.equal(summary.failures.timeout, 1);
  results[5].error = 'error'; assert.equal(summarizeQuality(cases, results, { freezeVerified: true }).status, 'FAIL');
});
test('unverified, missing, too few and unfrozen records never pass', () => {
  assert.equal(scoreObservation({ ...record(), humanVerified: false }, observation()).status, 'NOT_EVALUABLE');
  assert.equal(scoreObservation(record(), null).status, 'NOT_EVALUABLE');
  assert.equal(summarizeQuality([record()], [observation()], { freezeVerified: true }).status, 'NOT_EVALUABLE');
  const cases = Array.from({ length: 100 }, (_, i) => record(String(i)));
  assert.equal(summarizeQuality(cases, cases.map(c => observation(c.id))).status, 'NOT_EVALUABLE');
});
test('shared golds join transitively and cross-split contamination invalidates evaluation', () => {
  const cases = [{ ...record('x'), goldIds: ['A', 'B'] }, { ...record('y'), goldIds: ['B', 'C'] },
    { ...record('z'), goldIds: ['C'], split: 'development' }];
  assert.equal(new Set(targetGroups(cases)).size, 1);
  assert.ok(summarizeQuality(cases, cases.map(c => observation(c.id))).issues.includes('cross-split-target-overlap'));
});
test('missing candidate evidence is not inferred from top10; contradictions invalidate', () => {
  assert.equal(scoreObservation(record(), observation()).candidateHit, null);
  assert.equal(scoreObservation(record(), { ...observation(), candidateIdsBeforeRerank: [] }).status, 'NOT_EVALUABLE');
  assert.equal(scoreObservation(record(), { ...observation(), top10Ids: [], candidateIdsBeforeRerank: ['a'] }).failure, 'ranking');
});
test('development success and AI-authored final cases cannot become final PASS', () => {
  assert.equal(summarizeQuality([{ ...record(), split: 'development' }], [observation()], { split: 'development' }).status, 'DEVELOPMENT_ONLY');
  const cases = Array.from({ length: 100 }, (_, i) => ({ ...record(String(i)), origin: 'ai-generated' }));
  assert.equal(summarizeQuality(cases, cases.map(c => observation(c.id)), { freezeVerified: true }).status, 'NOT_EVALUABLE');
});
test('duplicate observations are not cherry-picked and CI is deterministic', () => {
  assert.ok(summarizeQuality([record()], [observation(), observation()]).issues.includes('multiple-observations-select-explicit-run'));
  const cases = Array.from({ length: 100 }, (_, i) => record(String(i)));
  const rows = cases.map(c => observation(c.id)); rows[0].top10Ids = [];
  assert.deepEqual(summarizeQuality(cases, rows).clusterBootstrap95CI, summarizeQuality(cases, rows).clusterBootstrap95CI);
});
test('the final set may exceed its frozen minimum count', () => {
  const cases = Array.from({ length: 101 }, (_, i) => record(String(i)));
  const summary = summarizeQuality(cases, cases.map(c => observation(c.id)), { expectedCount: 100, freezeVerified: true });
  assert.equal(summary.questions, 101);
  assert.equal(summary.status, 'PASS');
});
test('late successful response is a timeout and missing timing is incomplete', () => {
  assert.equal(scoreObservation(record(), { ...observation(), totalLatencyMs: 30001 }).failure, 'timeout');
  assert.equal(scoreObservation(record(), { ...observation(), totalLatencyMs: null }).status, 'NOT_EVALUABLE');
});
