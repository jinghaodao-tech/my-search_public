// Pure scoring: never reads a database or changes collection records.
export function scoreObservation(record, observation) {
  if (!record.humanVerified || record.savedBeforeQuery !== true || !Array.isArray(record.goldIds) || !record.goldIds.length) {
    return { status: 'NOT_EVALUABLE', reason: 'unverified-target' };
  }
  if (!observation) return { status: 'NOT_EVALUABLE', reason: 'missing-observation' };
  const timedOut = observation.timedOut || observation.totalLatencyMs >= 30000;
  if (observation.error || timedOut || observation.httpStatus >= 400) {
    return { status: 'EVALUATED', hit: 0, failure: timedOut ? 'timeout' : 'api-error', candidateHit: null };
  }
  if (observation.httpStatus !== 200 || !Number.isFinite(observation.totalLatencyMs) || observation.totalLatencyMs < 0 || !Array.isArray(observation.top10Ids)
    || observation.top10Ids.some(id => typeof id !== 'string')
    || new Set(observation.top10Ids).size !== observation.top10Ids.length) {
    return { status: 'NOT_EVALUABLE', reason: 'invalid-response-record' };
  }
  const gold = new Set(record.goldIds);
  const hit = Number(observation.top10Ids.slice(0, 10).some(id => gold.has(id)));
  const candidates = observation.candidateIdsBeforeRerank;
  const candidateHit = Array.isArray(candidates) ? Number(candidates.some(id => gold.has(id))) : null;
  if (hit && candidateHit === 0) return { status: 'NOT_EVALUABLE', reason: 'inconsistent-candidate-record' };
  return { status: 'EVALUATED', hit, candidateHit,
    failure: hit ? null : candidateHit === null ? 'unmeasured-cause' : candidateHit ? 'ranking' : 'candidate-miss' };
}

// Compute connected components from gold IDs; do not trust caller-supplied group labels.
export function targetGroups(records) {
  const parents = records.map((_, i) => i);
  const root = i => parents[i] === i ? i : (parents[i] = root(parents[i]));
  const owners = new Map();
  records.forEach((record, i) => {
    for (const id of record?.goldIds ?? []) {
      if (owners.has(id)) parents[root(i)] = root(owners.get(id));
      else owners.set(id, i);
    }
  });
  return records.map((_, i) => root(i));
}

export function clusterInterval(groups) {
  if (!groups.length) return null;
  let seed = 0x25c0ffee;
  const samples = [];
  for (let iteration = 0; iteration < 10000; iteration++) {
    let hits = 0, count = 0;
    for (let draw = 0; draw < groups.length; draw++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const group = groups[Math.floor(seed / 0x100000000 * groups.length)];
      hits += group.reduce((a, b) => a + b, 0);
      count += group.length;
    }
    samples.push(hits / count);
  }
  samples.sort((a, b) => a - b);
  return [samples[249], samples[9749]];
}

export function summarizeQuality(records, observations, { split = 'final', expectedCount = 100, freezeVerified = false } = {}) {
  const issues = [];
  if (!['development', 'final'].includes(split)) throw Error('Unknown split');
  if (!Number.isInteger(expectedCount) || expectedCount < 100) throw Error('Final count must be at least 100');
  const ids = records.map(record => record.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) issues.push('invalid-or-duplicate-case-id');
  const groups = targetGroups(records);
  const splits = new Map();
  records.forEach((record, i) => {
    const set = splits.get(groups[i]) ?? new Set(); set.add(record.split); splits.set(groups[i], set);
  });
  if ([...splits.values()].some(set => set.has('development') && set.has('final'))) issues.push('cross-split-target-overlap');
  const byCase = new Map();
  for (const row of observations) {
    if (byCase.has(row.caseId)) issues.push('multiple-observations-select-explicit-run');
    byCase.set(row.caseId, row);
  }
  const selected = records.map((record, i) => ({ record, group: groups[i] }))
    .filter(({ record }) => record.split === split && record.category === 'memory' && record.eligibility !== 'ineligible');
  const scored = selected.map(({ record, group }) => {
    if (record.eligibility !== 'eligible') issues.push('pending-eligibility');
    if (split === 'final' && record.origin !== 'human-natural-refind') issues.push('not-natural-human-query');
    const result = scoreObservation(record, byCase.get(record.id));
    if (result.status !== 'EVALUATED') issues.push(result.reason);
    return { group, ...result };
  });
  const valid = scored.filter(row => row.status === 'EVALUATED');
  const hits = valid.reduce((sum, row) => sum + row.hit, 0);
  const clustered = new Map();
  for (const row of valid) clustered.set(row.group, [...(clustered.get(row.group) ?? []), row.hit]);
  if (split === 'final' && selected.length < expectedCount) issues.push('minimum-final-count-not-met');
  if (split === 'final' && !freezeVerified) issues.push('freeze-not-verified');
  const complete = valid.length === selected.length && selected.length > 0;
  const rate = complete ? hits / selected.length : null;
  const candidateMeasured = valid.filter(row => row.candidateHit !== null);
  return { status: issues.length || !complete ? 'NOT_EVALUABLE' : split === 'development' ? 'DEVELOPMENT_ONLY' : rate >= 0.95 ? 'PASS' : 'FAIL',
    issues: [...new Set(issues)], questions: selected.length, evaluated: valid.length, successes: hits, hit10: rate,
    targetGroups: clustered.size, clusterBootstrap95CI: complete ? clusterInterval([...clustered.values()]) : null,
    candidateCoverage: complete && candidateMeasured.length === selected.length ? candidateMeasured.reduce((n, row) => n + row.candidateHit, 0) / selected.length : null,
    failures: Object.fromEntries(['api-error', 'timeout', 'candidate-miss', 'ranking', 'unmeasured-cause'].map(key => [key, valid.filter(row => row.failure === key).length])),
    qualification: 'Point estimate for the recorded owner/tasks; human provenance and freeze require independent verification. Not a population guarantee.' };
}
