import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFreezePayload, sealFreezePayload } from '../scripts/bench/personal_refind_freeze.mjs';
import { evaluateFrozenPersonalRefind } from '../scripts/bench/personal_refind_evaluator.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const previouslyUsedQueryHashes = Array.from({ length: 50 }, (_, index) => sha256(`old benchmark query ${index}`));
const records = Array.from({ length: 100 }, (_, index) => ({
  id: `final-${index}`,
  query: `natural memory query ${index}`,
  queryLockedAt: '2026-01-01T00:00:00.000Z',
  origin: 'human-natural-refind',
  category: 'memory',
  split: 'final',
  goldIds: [`saved-${index}`],
  humanVerified: true,
  savedBeforeQuery: true,
  verifiedAt: '2026-01-01T00:01:00.000Z',
  eligibility: 'eligible',
  collectionChannel: 'natural-first-search',
}));
const developmentRecords = Array.from({ length: 20 }, (_, index) => ({
  id: `development-${index}`, query: `development query ${index}`, queryLockedAt: '2026-01-01T00:00:00.000Z',
  verifiedAt: '2026-01-01T00:01:00.000Z', split: 'development', category: 'memory', eligibility: 'eligible',
  humanVerified: true, savedBeforeQuery: true, collectionChannel: 'guided-development-query',
  goldIds: [`development-saved-${index}`], origin: 'human-memory-development',
}));
const inputs = {
  finalRecords: records,
  developmentRecords,
  previouslyUsedQueryHashes,
  corpusArticleIds: new Set([...records, ...developmentRecords].map(record => record.goldIds[0])),
  corpusCreatedAtById: new Map([...records, ...developmentRecords].map(record => [record.goldIds[0], '2025-12-31T23:59:00.000Z'])),
  fingerprints: { corpusSha256: 'c'.repeat(64), configurationSha256: 'f'.repeat(64), implementationSha256: 'a'.repeat(64), ftsIndexes: {} },
  sources: { method: 'fts5-morph', recordsDirectory: 'final', developmentDirectory: 'development', corpusPath: 'corpus.sqlite', configurationPath: 'config.json' },
};
const manifest = sealFreezePayload(createFreezePayload(inputs).payload, '2026-01-02T00:00:00.000Z');
const observations = records.map(record => ({
  runId: 'run-1', caseId: record.id, querySha256: sha256(record.query),
  evaluationMode: 'frozen-isolated-replay', requestedEngine: 'fts5-morph',
  corpusSha256: inputs.fingerprints.corpusSha256, contentPreserved: true,
  actualEngine: 'fts5-morph-saved-cards', fallbackUsed: false,
  httpStatus: 200, error: null, timedOut: false, totalLatencyMs: 100,
  top10Ids: [record.goldIds[0]], candidateIdsBeforeRerank: [record.goldIds[0]],
}));

test('scores only complete observations tied to the valid frozen manifest', () => {
  const result = evaluateFrozenPersonalRefind(manifest, inputs, observations);
  assert.equal(result.status, 'PASS');
  assert.equal(result.questions, 100);
  assert.equal(result.successes, 100);
  assert.equal(result.candidateCoverage, 1);
  assert.equal(result.fallbackCount, 0);
});

test('incomplete, mixed-run, changed-query, wrong-method and changed-freeze evidence cannot pass', () => {
  assert.equal(evaluateFrozenPersonalRefind(manifest, inputs, observations.slice(0, 99)).status, 'NOT_EVALUABLE');
  assert.ok(evaluateFrozenPersonalRefind(manifest, inputs, observations.map((row, i) => i ? row : { ...row, runId: 'other' }))
    .issues.includes('mixed-or-missing-run-ids'));
  assert.ok(evaluateFrozenPersonalRefind(manifest, inputs, observations.map((row, i) => i ? row : { ...row, requestedEngine: 'like' }))
    .issues.includes('observation-method-mismatch'));
  assert.ok(evaluateFrozenPersonalRefind(manifest, inputs, observations.map((row, i) => i ? row : { ...row, candidateIdsBeforeRerank: null }))
    .issues.includes('missing-or-invalid-pre-rerank-candidates'));
  const changedInputs = { ...inputs, finalRecords: records.map((record, i) => i ? record : { ...record, query: `${record.query} edited` }) };
  assert.ok(evaluateFrozenPersonalRefind(manifest, changedInputs, observations).issues.includes('freeze-audit-failed'));
});
