import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreDiscoveryRun } from '../scripts/bench/new_discovery_metrics.mjs';

const query = () => ({ id: 'q1', queryLockedAt: '2026-01-01T00:00:00Z', resultsGeneratedAt: '2026-01-01T00:01:00Z',
  judgmentsLockedAt: '2026-01-01T00:02:00Z', judgments: [
    { blindId: 'x', grade: 3, humanJudged: true }, { blindId: 'y', grade: 0, humanJudged: true },
  ], engines: [{ name: 'A', top10BlindIds: ['x', 'y'] }, { name: 'B', top10BlindIds: ['y', 'x'] }] });
const study = () => ({ purpose: 'new-article-discovery', frozenAt: '2026-01-01T00:00:30Z', queryFingerprint: 'q',
  corpusFingerprint: 'c', engineFingerprint: 'e', queries: [query()] });

test('computes graded nDCG and separates engine rankings', () => {
  const result = scoreDiscoveryRun(study());
  assert.equal(result.status, 'SCORED_NO_TARGET_THRESHOLD');
  assert.equal(result.metrics.A.meanNdcg10, 1);
  assert.ok(Math.abs(result.metrics.B.meanNdcg10 - 1 / Math.log2(3)) < 1e-12);
});
test('does not score unjudged pooled results as irrelevant', () => {
  const input = study(); input.queries[0].engines[0].top10BlindIds.push('unjudged');
  const result = scoreDiscoveryRun(input);
  assert.equal(result.status, 'NOT_EVALUABLE');
  assert.ok(result.issues.some(issue => issue.startsWith('incomplete-pooled-judgments')));
});
test('rejects temporal leakage, invalid grades, duplicates and incomplete fingerprints', () => {
  const input = study(); input.queries[0].judgments[0].grade = 4;
  input.queries[0].resultsGeneratedAt = '2025-12-31T00:00:00Z';
  input.corpusFingerprint = null;
  const result = scoreDiscoveryRun(input);
  assert.equal(result.status, 'NOT_EVALUABLE');
  assert.ok(result.issues.includes('study-not-frozen'));
  assert.ok(result.issues.includes('invalid-temporal-order:q1'));
  assert.ok(result.issues.includes('invalid-or-duplicate-judgment:q1'));
});
test('counts all-zero-judgment queries separately instead of mixing them into nDCG', () => {
  const input = study(); input.queries[0].judgments.forEach(item => { item.grade = 0; });
  const result = scoreDiscoveryRun(input);
  assert.equal(result.status, 'NOT_EVALUABLE');
  assert.equal(result.zeroIdcgQueries, 1);
  assert.equal(result.positiveIdcgQueries, 0);
  assert.ok(result.issues.includes('no-query-has-positive-judgment'));
});
test('never turns discovery scores into a refind or target-threshold pass', () => {
  const result = scoreDiscoveryRun(study());
  assert.equal(result.status, 'SCORED_NO_TARGET_THRESHOLD');
  assert.equal('hit10' in result, false);
  assert.equal(result.queryCount, 1);
});
