import crypto from 'node:crypto';
import { targetGroups } from './personal_refind_metrics.mjs';

export const IMPLEMENTATION_FILES = [
  'package.json',
  'app.ts',
  'config/runtime_config.ts',
  'db/database.ts',
  'db/migrate.ts',
  'search/tokenizer.ts',
  'bm25_engine.ts',
  'services/discover_service.ts',
  'services/query_analysis.ts',
  'routes/cards_routes.ts',
  'routes/search_routes.ts',
  'services/route_context.ts',
  'repositories/cards_repository.ts',
  'services/e5_embedding_service.ts',
  'services/e5_rrf_ranker.ts',
  'scripts/bench/personal_refind_metrics.mjs',
  'scripts/bench/personal_refind_evaluator.mjs',
  'scripts/bench/personal_refind_freeze.mjs',
  'scripts/bench/personal_refind_freeze_io.mjs',
  'scripts/bench/replay_personal_refind.mjs',
  'scripts/bench/freeze_personal_refind.mjs',
  'scripts/bench/audit_personal_refind_freeze.mjs',
  'scripts/bench/replay_frozen_personal_refind.mjs',
  'scripts/bench/search_run_provenance.mjs',
  'package-lock.json',
  'quality/e2e/docs/PERSONAL-REFIND-PROTOCOL-ja.md',
  'quality/e2e/docs/PERSONAL-REFIND-COLLECTION-ja.md',
  'quality/e2e/docs/PERSONAL-REFIND-RESULT-TEMPLATE-ja.md',
  'docs/search-goals-ja.md',
];

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function frozenCaseProjection(record) {
  return {
    id: record.id,
    query: record.query,
    queryLockedAt: record.queryLockedAt,
    origin: record.origin,
    category: record.category,
    split: record.split,
    goldIds: [...(record.goldIds ?? [])].sort(),
    humanVerified: record.humanVerified,
    savedBeforeQuery: record.savedBeforeQuery,
    verifiedAt: record.verifiedAt,
    eligibility: record.eligibility,
    collectionChannel: record.collectionChannel,
  };
}

export function validateFreezeCases(finalRecords, developmentRecords, corpusArticleIds,
  { minimumCases = 100, minimumDevelopmentCases = 20, corpusCreatedAtById, previouslyUsedQueryHashes } = {}) {
  const issues = [];
  if (!Array.isArray(finalRecords) || finalRecords.length < minimumCases) issues.push('insufficient-final-cases');
  if (!Number.isInteger(minimumCases) || minimumCases < 100) issues.push('invalid-minimum-case-count');
  if (!Array.isArray(developmentRecords) || developmentRecords.length < minimumDevelopmentCases) issues.push('insufficient-development-cases');
  if (!Number.isInteger(minimumDevelopmentCases) || minimumDevelopmentCases < 20) issues.push('invalid-minimum-development-case-count');
  if (!(corpusArticleIds instanceof Set)) issues.push('invalid-corpus-id-set');
  const records = Array.isArray(finalRecords) ? finalRecords : [];
  const development = Array.isArray(developmentRecords) ? developmentRecords : [];
  const ids = records.map(record => record?.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) issues.push('invalid-or-duplicate-case-id');
  const allIds = [...records, ...development].map(record => record?.id);
  if (allIds.some(id => typeof id !== 'string' || !id) || new Set(allIds).size !== allIds.length) issues.push('invalid-or-duplicate-case-id');
  const normalizeQuery = query => sha256(query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und'));
  if (!Array.isArray(previouslyUsedQueryHashes) || previouslyUsedQueryHashes.length !== 50
    || previouslyUsedQueryHashes.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value))
    || new Set(previouslyUsedQueryHashes).size !== 50) issues.push('invalid-prior-exposure-registry');
  const previouslyUsed = new Set(previouslyUsedQueryHashes ?? []);
  for (const record of records) if (typeof record?.query === 'string' && previouslyUsed.has(normalizeQuery(record.query))) {
    issues.push('final-query-already-exposed-in-previous-50');
  }
  const finalQueryHashes = records.map(record => typeof record?.query === 'string' ? normalizeQuery(record.query) : null).filter(Boolean);
  if (new Set(finalQueryHashes).size !== finalQueryHashes.length) issues.push('duplicate-final-query');
  const finalQueryHashSet = new Set(finalQueryHashes);

  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      issues.push('invalid-case-record');
      continue;
    }
    if (record.split !== 'final') issues.push('case-not-in-final-split');
    if (record.category !== 'memory') issues.push('case-not-refind-memory');
    if (record.origin !== 'human-natural-refind') issues.push('case-not-natural-human-query');
    if (record.eligibility !== 'eligible') issues.push('case-not-eligible');
    if (record.humanVerified !== true || record.savedBeforeQuery !== true) issues.push('case-not-human-verified');
    if (typeof record.query !== 'string' || !record.query.trim()) issues.push('missing-query');
    if (!timestamp(record.queryLockedAt) || !timestamp(record.verifiedAt)
      || Date.parse(record.queryLockedAt) > Date.parse(record.verifiedAt)) issues.push('invalid-query-lock-or-verification-time');
    if (typeof record.collectionChannel !== 'string' || !record.collectionChannel.trim()) issues.push('missing-human-provenance');
    if (!Array.isArray(record.goldIds) || !record.goldIds.length
      || record.goldIds.some(id => typeof id !== 'string' || !id)
      || new Set(record.goldIds).size !== record.goldIds.length) issues.push('invalid-gold-labels');
    else if (corpusArticleIds instanceof Set && record.goldIds.some(id => !corpusArticleIds.has(id))) issues.push('gold-article-missing-from-corpus');
    if (Array.isArray(record.goldIds) && corpusCreatedAtById instanceof Map && timestamp(record.queryLockedAt)) {
      for (const id of record.goldIds) {
        const savedAt = corpusCreatedAtById.get(id);
        if (!timestamp(savedAt) || Date.parse(savedAt) > Date.parse(record.queryLockedAt)) issues.push('target-not-saved-before-query');
      }
    }
  }

  for (const record of development) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      issues.push('invalid-development-case');
      continue;
    }
    if (record.split !== 'development') issues.push('case-not-in-development-split');
    if (record.category !== 'memory') issues.push('development-case-not-refind-memory');
    if (record.origin !== 'human-memory-development') issues.push('development-case-not-human-memory-query');
    if (record.eligibility !== 'eligible') issues.push('development-case-not-eligible');
    if (record.humanVerified !== true || record.savedBeforeQuery !== true) issues.push('development-case-not-human-verified');
    if (typeof record.query !== 'string' || !record.query.trim()) issues.push('missing-development-query');
    if (!timestamp(record.queryLockedAt) || !timestamp(record.verifiedAt)
      || Date.parse(record.queryLockedAt) > Date.parse(record.verifiedAt)) issues.push('invalid-development-query-lock-or-verification-time');
    if (typeof record.collectionChannel !== 'string' || !record.collectionChannel.trim()) issues.push('missing-development-human-provenance');
    if (typeof record.query === 'string' && finalQueryHashSet.has(normalizeQuery(record.query))) issues.push('duplicate-cross-split-query');
    if (!Array.isArray(record.goldIds) || !record.goldIds.length
      || record.goldIds.some(id => typeof id !== 'string' || !id)) issues.push('development-target-unresolved-for-split-audit');
    else {
      if (corpusArticleIds instanceof Set && record.goldIds.some(id => !corpusArticleIds.has(id))) issues.push('development-gold-article-missing-from-corpus');
      if (corpusCreatedAtById instanceof Map && timestamp(record.queryLockedAt)) {
        for (const id of record.goldIds) {
          const savedAt = corpusCreatedAtById.get(id);
          if (!timestamp(savedAt) || Date.parse(savedAt) > Date.parse(record.queryLockedAt)) issues.push('development-target-not-saved-before-query');
        }
      }
    }
  }

  const combined = [...records, ...development];
  const groups = targetGroups(combined);
  const splitByGroup = new Map();
  combined.forEach((record, index) => {
    const group = groups[index];
    const split = record?.split;
    const set = splitByGroup.get(group) ?? new Set();
    set.add(split);
    splitByGroup.set(group, set);
  });
  if ([...splitByGroup.values()].some(splits => splits.has('final') && splits.has('development'))) issues.push('cross-split-target-overlap');
  return [...new Set(issues)];
}

export function createFreezePayload({ finalRecords, developmentRecords = [], corpusArticleIds, corpusCreatedAtById,
  fingerprints, sources, previouslyUsedQueryHashes, minimumCases = 100, minimumDevelopmentCases = 20 }) {
  const issues = validateFreezeCases(finalRecords, developmentRecords, corpusArticleIds,
    { minimumCases, minimumDevelopmentCases, corpusCreatedAtById, previouslyUsedQueryHashes });
  if (issues.length) return { status: 'NOT_FROZEN', issues };
  const records = [...finalRecords].sort((a, b) => a.id.localeCompare(b.id));
  const devRecords = [...developmentRecords].sort((a, b) => a.id.localeCompare(b.id));
  const combined = [...records, ...devRecords];
  const groups = targetGroups(combined);
  const groupHashes = new Map();
  combined.forEach((record, index) => {
    const key = groups[index];
    const ids = groupHashes.get(key) ?? new Set();
    for (const id of record.goldIds) ids.add(id);
    groupHashes.set(key, ids);
  });
  const projections = records.map(record => {
    const group = combined.findIndex(item => item.id === record.id);
    const targets = [...(groupHashes.get(groups[group]) ?? [])].sort();
    return {
      caseId: record.id,
      caseSha256: sha256(JSON.stringify(frozenCaseProjection(record))),
      querySha256: sha256(record.query),
      targetGroupSha256: sha256(targets.join('\n')),
    };
  });
  const groupCount = new Set(records.map(record => {
    const index = combined.findIndex(item => item.id === record.id);
    return groups[index];
  })).size;
  const developmentProjections = devRecords.map(record => {
    const index = combined.findIndex(item => item.id === record.id);
    const targets = [...(groupHashes.get(groups[index]) ?? [])].sort();
    return {
      caseId: record.id,
      caseSha256: sha256(JSON.stringify(frozenCaseProjection(record))),
      querySha256: typeof record.query === 'string' ? sha256(record.query) : null,
      targetGroupSha256: sha256(targets.join('\n')),
    };
  });
  return {
    status: 'FROZEN',
    issues: [],
    payload: {
      version: 1,
      split: 'final',
      minimumCases,
      minimumDevelopmentCases,
      caseCount: records.length,
      developmentCaseCount: devRecords.length,
      targetGroupCount: groupCount,
      developmentTargetGroupCount: new Set(devRecords.map(record => groups[combined.findIndex(item => item.id === record.id)])).size,
      protocolVersion: 'PERSONAL-REFIND-PROTOCOL-ja',
      sources,
      fingerprints,
      previouslyUsedQueryCount: previouslyUsedQueryHashes.length,
      previouslyUsedQuerySetSha256: sha256([...previouslyUsedQueryHashes].sort().join('\n')),
      recordSetSha256: sha256(JSON.stringify({ final: projections, development: developmentProjections })),
      cases: projections,
      developmentCases: developmentProjections,
    },
  };
}

export function sealFreezePayload(payload, frozenAt = new Date().toISOString()) {
  if (!timestamp(frozenAt)) throw Error('Freeze timestamp must be an ISO-compatible date');
  const manifest = { ...payload, status: 'FROZEN', frozenAt };
  manifest.manifestSha256 = sha256(JSON.stringify(manifest));
  return manifest;
}

export function auditFreezePayload(manifest, currentInputs) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { valid: false, issues: ['invalid-manifest'] };
  if (manifest.status !== 'FROZEN' || !timestamp(manifest.frozenAt) || !Number.isInteger(manifest.minimumCases) || manifest.minimumCases < 100
    || !Number.isInteger(manifest.minimumDevelopmentCases) || manifest.minimumDevelopmentCases < 20) {
    return { valid: false, issues: ['invalid-manifest-metadata'] };
  }
  const rebuilt = createFreezePayload({ ...currentInputs, minimumCases: manifest.minimumCases,
    minimumDevelopmentCases: manifest.minimumDevelopmentCases });
  if (rebuilt.status !== 'FROZEN') return { valid: false, issues: rebuilt.issues };
  const unsigned = { ...manifest };
  delete unsigned.manifestSha256;
  const actualManifestHash = sha256(JSON.stringify(unsigned));
  const expectedPayloadHash = sha256(JSON.stringify(rebuilt.payload));
  const actualPayloadHash = sha256(JSON.stringify(Object.fromEntries(Object.entries(unsigned).filter(([key]) => !['frozenAt', 'status'].includes(key)))));
  const issues = [];
  if (actualManifestHash !== manifest.manifestSha256) issues.push('manifest-signature-mismatch');
  if (actualPayloadHash !== expectedPayloadHash) issues.push('frozen-inputs-changed');
  return { valid: issues.length === 0, issues, manifestSha256: actualManifestHash, payloadSha256: actualPayloadHash };
}
