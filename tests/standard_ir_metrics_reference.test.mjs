import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreObservation } from '../scripts/bench/personal_refind_metrics.mjs';
import { scoreDiscoveryRun } from '../scripts/bench/new_discovery_metrics.mjs';
import { referenceDcgAtK, referenceHitAtK, referenceMrrAtK, referenceNdcgAtK, referenceRecallAtK } from '../scripts/bench/standard_ir_metrics_reference.mjs';

test('personal refind Hit@10 matches an independent binary reference at the cutoff', () => {
  const ranking = Array.from({ length: 11 }, (_, index) => `doc-${index + 1}`);
  const record = { humanVerified: true, savedBeforeQuery: true, goldIds: ['doc-11'], category: 'memory' };
  assert.equal(scoreObservation(record, { httpStatus: 200, totalLatencyMs: 1, top10Ids: ranking.slice(0, 9).concat('doc-10') }).hit,
    referenceHitAtK(ranking.slice(0, 9).concat('doc-10'), record.goldIds, 10));
  assert.equal(scoreObservation(record, { httpStatus: 200, totalLatencyMs: 1, top10Ids: ranking }).hit,
    referenceHitAtK(ranking, record.goldIds, 10));
});

test('new-discovery nDCG uses standard exponential gain and log2 rank discount', () => {
  const ranking = ['unjudged-is-not-allowed', 'relevant-low', 'relevant-high'];
  const relevance = { 'relevant-low': 1, 'relevant-high': 3 };
  const run = { purpose: 'new-article-discovery', frozenAt: '2026-01-01T00:00:30Z', queryFingerprint: 'q', corpusFingerprint: 'c', engineFingerprint: 'e', queries: [{
    id: 'q1', queryLockedAt: '2026-01-01T00:00:00Z', resultsGeneratedAt: '2026-01-01T00:01:00Z', judgmentsLockedAt: '2026-01-01T00:02:00Z',
    judgments: Object.entries(relevance).map(([blindId, grade]) => ({ blindId, grade, humanJudged: true })),
    engines: [{ name: 'candidate', top10BlindIds: ranking.slice(0, 2) }],
  }] };
  // Use only judged documents for a complete pooled evaluation.
  run.queries[0].engines[0].top10BlindIds = ['relevant-low', 'relevant-high'];
  const actual = scoreDiscoveryRun(run).metrics.candidate.meanNdcg10;
  assert.equal(actual, referenceNdcgAtK(['relevant-low', 'relevant-high'], relevance, 10));
  assert.ok(Math.abs(referenceDcgAtK(['relevant-high', 'relevant-low'], relevance, 10) - (7 + 1 / Math.log2(3))) < 1e-12);
  assert.equal(referenceMrrAtK(['irrelevant', 'relevant-high'], ['relevant-high'], 10), 0.5);
  assert.equal(referenceRecallAtK(['relevant-low', 'irrelevant'], ['relevant-low', 'relevant-high'], 10), 0.5);
});
