import crypto from 'node:crypto';
import { auditFreezePayload } from './personal_refind_freeze.mjs';
import { summarizeQuality } from './personal_refind_metrics.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

export function evaluateFrozenPersonalRefind(manifest, inputs, observations) {
  const audit = auditFreezePayload(manifest, inputs);
  if (!audit.valid) return { status: 'NOT_EVALUABLE', issues: ['freeze-audit-failed', ...audit.issues], audit };
  if (!Array.isArray(observations)) return { status: 'NOT_EVALUABLE', issues: ['invalid-observation-set'], audit };

  const records = inputs.finalRecords;
  const expected = new Map(manifest.cases.map(item => [item.caseId, item]));
  const seen = new Set();
  const issues = [];
  const runIds = new Set();
  for (const observation of observations) {
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
      issues.push('invalid-observation-record');
      continue;
    }
    if (!expected.has(observation.caseId) || seen.has(observation.caseId)) issues.push('unknown-or-duplicate-observation-case');
    else seen.add(observation.caseId);
    if (observation.evaluationMode !== 'frozen-isolated-replay') issues.push('observation-not-frozen-replay');
    if (observation.requestedEngine !== manifest.sources.method) issues.push('observation-method-mismatch');
    if (observation.corpusSha256 !== manifest.fingerprints.corpusSha256) issues.push('observation-corpus-mismatch');
    if (observation.contentPreserved !== true) issues.push('evaluation-copy-content-not-preserved');
    if (observation.httpStatus === 200 && !observation.error && (typeof observation.actualEngine !== 'string' || typeof observation.fallbackUsed !== 'boolean')) {
      issues.push('missing-actual-engine-or-fallback-record');
    }
    if (observation.httpStatus === 200 && !observation.error && (!Array.isArray(observation.candidateIdsBeforeRerank)
      || observation.candidateIdsBeforeRerank.some(id => typeof id !== 'string')
      || new Set(observation.candidateIdsBeforeRerank).size !== observation.candidateIdsBeforeRerank.length)) {
      issues.push('missing-or-invalid-pre-rerank-candidates');
    }
    if (typeof observation.runId !== 'string' || !observation.runId) issues.push('missing-run-id');
    else runIds.add(observation.runId);
    const locked = expected.get(observation.caseId);
    if (locked && observation.querySha256 !== locked.querySha256) issues.push('observation-query-mismatch');
  }
  if (seen.size !== expected.size) issues.push('incomplete-observation-set');
  if (runIds.size !== 1) issues.push('mixed-or-missing-run-ids');
  if (issues.length) return { status: 'NOT_EVALUABLE', issues: [...new Set(issues)], audit };

  const summary = summarizeQuality(records, observations, {
    split: 'final',
    expectedCount: manifest.minimumCases,
    freezeVerified: true,
  });
  return {
    ...summary,
    audit: { manifestSha256: audit.manifestSha256, payloadSha256: audit.payloadSha256 },
    requestedEngine: manifest.sources.method,
    actualEngines: Object.fromEntries([...new Set(observations.map(row => row.actualEngine ?? 'unknown'))]
      .map(engine => [engine, observations.filter(row => (row.actualEngine ?? 'unknown') === engine).length])),
    fallbackCount: observations.filter(row => row.fallbackUsed === true).length,
    corpusSha256: manifest.fingerprints.corpusSha256,
    observationSetSha256: sha256(JSON.stringify(observations.map(({ caseId, querySha256, httpStatus, error, timedOut,
      totalLatencyMs, top10Ids, candidateIdsBeforeRerank, actualEngine, fallbackUsed, contentPreserved }) => ({
      caseId, querySha256, httpStatus, error, timedOut, totalLatencyMs, top10Ids,
      candidateIdsBeforeRerank, actualEngine, fallbackUsed, contentPreserved,
    })))),
  };
}
