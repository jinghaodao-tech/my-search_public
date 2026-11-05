import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { auditFreezePayload, createFreezePayload, sealFreezePayload } from '../scripts/bench/personal_refind_freeze.mjs';

const previouslyUsedQueryHashes = Array.from({ length: 50 }, (_, index) => crypto.createHash('sha256').update(`old benchmark query ${index}`).digest('hex'));

const cases = Array.from({ length: 100 }, (_, index) => ({
  id: `case-${index}`,
  query: `remembered topic ${index}`,
  queryLockedAt: '2026-01-01T00:00:00.000Z',
  origin: 'human-natural-refind',
  category: 'memory',
  split: 'final',
  goldIds: [`article-${index}`],
  humanVerified: true,
  savedBeforeQuery: true,
  verifiedAt: '2026-01-01T00:01:00.000Z',
  eligibility: 'eligible',
  collectionChannel: 'natural-first-query',
  evaluationRun: null,
}));
const developmentCases = Array.from({ length: 20 }, (_, index) => ({
  id: `development-${index}`,
  query: `development memory ${index}`,
  queryLockedAt: '2026-01-01T00:00:00.000Z',
  origin: 'human-memory-development',
  category: 'memory',
  split: 'development',
  goldIds: [`dev-article-${index}`],
  humanVerified: true,
  savedBeforeQuery: true,
  verifiedAt: '2026-01-01T00:01:00.000Z',
  eligibility: 'eligible',
  collectionChannel: 'guided-development-query',
}));
const allCases = [...cases, ...developmentCases];
const corpusArticleIds = new Set(allCases.map(record => record.goldIds[0]));
const inputs = { finalRecords: cases, developmentRecords: developmentCases, corpusArticleIds,
  previouslyUsedQueryHashes,
  corpusCreatedAtById: new Map(allCases.map(record => [record.goldIds[0], '2025-12-31T23:59:00.000Z'])),
  fingerprints: { corpusSha256: 'c'.repeat(64), configurationSha256: 'f'.repeat(64), implementationSha256: 'a'.repeat(64) },
  sources: { recordsDirectory: 'final', developmentDirectory: 'development', corpusPath: 'corpus.sqlite', configurationPath: 'config.json' } };

test('freezes a complete human-final set and verifies unchanged inputs', () => {
  const result = createFreezePayload(inputs);
  assert.equal(result.status, 'FROZEN');
  assert.equal(result.payload.caseCount, 100);
  assert.equal(result.payload.developmentCaseCount, 20);
  assert.equal(result.payload.targetGroupCount, 100);
  const manifest = sealFreezePayload(result.payload, '2026-01-02T00:00:00.000Z');
  assert.equal(auditFreezePayload(manifest, inputs).valid, true);
  assert.equal(JSON.stringify(manifest).includes(cases[0].query), false);
});

test('a changed query, target, corpus, configuration, or implementation invalidates the freeze', () => {
  const manifest = sealFreezePayload(createFreezePayload(inputs).payload, '2026-01-02T00:00:00.000Z');
  const changedRecords = cases.map(record => ({ ...record }));
  changedRecords[0].query += ' changed';
  assert.ok(auditFreezePayload(manifest, { ...inputs, finalRecords: changedRecords }).issues.includes('frozen-inputs-changed'));
  const changedTargets = cases.map(record => ({ ...record }));
  changedTargets[0].goldIds = ['article-1'];
  const targetAudit = auditFreezePayload(manifest, { ...inputs, finalRecords: changedTargets });
  assert.ok(targetAudit.issues.includes('frozen-inputs-changed'), JSON.stringify(targetAudit));
  assert.ok(auditFreezePayload(manifest, { ...inputs, fingerprints: { ...inputs.fingerprints, corpusSha256: 'd'.repeat(64) } }).issues.includes('frozen-inputs-changed'));
  assert.ok(auditFreezePayload(manifest, { ...inputs, fingerprints: { ...inputs.fingerprints, configurationSha256: 'e'.repeat(64) } }).issues.includes('frozen-inputs-changed'));
  assert.ok(auditFreezePayload(manifest, { ...inputs, fingerprints: { ...inputs.fingerprints, implementationSha256: 'b'.repeat(64) } }).issues.includes('frozen-inputs-changed'));
  const changedDevelopment = developmentCases.map(record => ({ ...record }));
  changedDevelopment[0].query += ' changed';
  assert.ok(auditFreezePayload(manifest, { ...inputs, developmentRecords: changedDevelopment }).issues.includes('frozen-inputs-changed'));
  const modifiedManifest = { ...manifest, caseCount: 99 };
  assert.ok(auditFreezePayload(modifiedManifest, inputs).issues.includes('manifest-signature-mismatch'));
});

test('insufficient, unconfirmed, non-natural, missing-label and cross-split records cannot freeze', () => {
  assert.ok(createFreezePayload({ ...inputs, finalRecords: cases.slice(0, 99) }).issues.includes('insufficient-final-cases'));
  assert.ok(createFreezePayload({ ...inputs, developmentRecords: developmentCases.slice(0, 19) }).issues.includes('insufficient-development-cases'));
  assert.ok(createFreezePayload({ ...inputs, finalRecords: cases.map((r, i) => i ? r : { ...r, humanVerified: false }) }).issues.includes('case-not-human-verified'));
  assert.ok(createFreezePayload({ ...inputs, finalRecords: cases.map((r, i) => i ? r : { ...r, origin: 'ai-generated' }) }).issues.includes('case-not-natural-human-query'));
  assert.ok(createFreezePayload({ ...inputs, finalRecords: cases.map((r, i) => i ? r : { ...r, goldIds: ['missing-article'] }) }).issues.includes('gold-article-missing-from-corpus'));
  const developmentRecords = [{ ...cases[0], id: 'dev-case', split: 'development', origin: 'human-memory-development' }, ...developmentCases.slice(1)];
  assert.ok(createFreezePayload({ ...inputs, developmentRecords }).issues.includes('cross-split-target-overlap'));
});

test('duplicate questions and invalid lock timestamps cannot inflate the final set', () => {
  const duplicate = cases.map(record => ({ ...record }));
  duplicate[1].query = duplicate[0].query;
  assert.ok(createFreezePayload({ ...inputs, finalRecords: duplicate }).issues.includes('duplicate-final-query'));
  const unlocked = cases.map((record, index) => index ? record : { ...record, queryLockedAt: null });
  assert.ok(createFreezePayload({ ...inputs, finalRecords: unlocked }).issues.includes('invalid-query-lock-or-verification-time'));
  const normalizedDuplicate = cases.map(record => ({ ...record }));
  normalizedDuplicate[1].query = `  ${normalizedDuplicate[0].query.replace(' ', '　')}  `;
  assert.ok(createFreezePayload({ ...inputs, finalRecords: normalizedDuplicate }).issues.includes('duplicate-final-query'));
});

test('the previously used 50-query saved-card benchmark cannot be frozen as a new final holdout', () => {
  const exposedQuery = 'old benchmark query 17';
  const reused = cases.map((record, index) => index ? record : { ...record, query: exposedQuery });
  assert.ok(createFreezePayload({ ...inputs, finalRecords: reused }).issues.includes('final-query-already-exposed-in-previous-50'));
  assert.ok(createFreezePayload({ ...inputs, previouslyUsedQueryHashes: previouslyUsedQueryHashes.slice(0, 49) }).issues.includes('invalid-prior-exposure-registry'));
});

test('rejects malformed cases and edited freeze metadata', () => {
  assert.ok(createFreezePayload({ ...inputs, finalRecords: [null, ...cases.slice(1)] }).issues.includes('invalid-case-record'));
  const manifest = sealFreezePayload(createFreezePayload(inputs).payload, '2026-01-02T00:00:00.000Z');
  assert.ok(auditFreezePayload({ ...manifest, status: 'DEVELOPMENT' }, inputs).issues.includes('invalid-manifest-metadata'));
  assert.ok(auditFreezePayload({ ...manifest, frozenAt: 'not-a-date' }, inputs).issues.includes('invalid-manifest-metadata'));
});

test('requires every confirmed target to exist in the corpus before the locked query', () => {
  const createdAt = new Map(inputs.corpusCreatedAtById);
  createdAt.set(cases[0].goldIds[0], '2026-01-01T00:00:01.000Z');
  assert.ok(createFreezePayload({ ...inputs, corpusCreatedAtById: createdAt }).issues.includes('target-not-saved-before-query'));
});

test('requires resolvable development targets and disjoint normalized final queries', () => {
  const unresolvedDevelopment = [{ id: 'dev-pending', query: 'not yet confirmed', split: 'development', category: 'memory', goldIds: [] }];
  assert.ok(createFreezePayload({ ...inputs, developmentRecords: unresolvedDevelopment }).issues
    .includes('development-target-unresolved-for-split-audit'));
  const duplicateDevelopment = [{ ...cases[0], id: 'dev-same-query', split: 'development', origin: 'human-memory-development' }, ...developmentCases.slice(1)];
  assert.ok(createFreezePayload({ ...inputs, developmentRecords: duplicateDevelopment }).issues.includes('duplicate-cross-split-query'));
});
