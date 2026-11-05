import test from 'node:test';
import assert from 'node:assert/strict';
import {compareMiraclReports} from './compare_miracl_results.mjs';

test('paired comparison resamples target clusters and keeps shared-target queries grouped', () => {
  const baseline = new Map([
    ['q1', {expected: ['d1'], group: 'g1', hit: false}],
    ['q2', {expected: ['d2'], group: 'g1', hit: false}],
    ['q3', {expected: ['d3'], group: 'g2', hit: true}],
  ]);
  const candidate = new Map([
    ['q1', {expected: ['d1'], group: 'g1', hit: true}],
    ['q2', {expected: ['d2'], group: 'g1', hit: false}],
    ['q3', {expected: ['d3'], group: 'g2', hit: true}],
  ]);
  const result = compareMiraclReports(baseline, candidate, {bootstrap: 500, seed: 42});
  assert.equal(result.n, 3);
  assert.equal(result.clusters, 2);
  assert.equal(result.repeatedClusters, 1);
  assert.equal(result.improvedQueries, 1);
  assert.equal(result.exactMcNemarTwoSidedP, null);
  assert.deepEqual(result, compareMiraclReports(baseline, candidate, {bootstrap: 500, seed: 42}));
});

test('paired comparison rejects changed labels and changed clusters', () => {
  const baseline = new Map([['q1', {expected: ['d1'], group: 'g1', hit: false}]]);
  assert.throws(() => compareMiraclReports(baseline, new Map([['q1', {expected: ['d2'], group: 'g1', hit: true}]]), {bootstrap: 10}), /Gold labels differ/);
  assert.throws(() => compareMiraclReports(baseline, new Map([['q1', {expected: ['d1'], group: 'g2', hit: true}]]), {bootstrap: 10}), /Cluster differs/);
});
