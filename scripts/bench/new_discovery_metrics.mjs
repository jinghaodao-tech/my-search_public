// Graded relevance scoring for new-article discovery; isolated from refind Hit@10.
const isGrade = value => Number.isInteger(value) && value >= 0 && value <= 3;
const dcg = grades => grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);

export function scoreDiscoveryRun(study) {
  const issues = [];
  if (!study || study.purpose !== 'new-article-discovery') issues.push('wrong-study-purpose');
  if (!study?.frozenAt || !study?.queryFingerprint || !study?.corpusFingerprint || !study?.engineFingerprint) issues.push('study-not-frozen');
  if (!Array.isArray(study?.queries) || !study.queries.length) issues.push('no-queries');
  const queryIds = new Set();
  const perEngine = new Map();
  let zeroIdcgQueries = 0;

  for (const query of study?.queries ?? []) {
    if (!query.id || queryIds.has(query.id)) { issues.push('missing-or-duplicate-query-id'); continue; }
    queryIds.add(query.id);
    const locked = Date.parse(query.queryLockedAt);
    const resultAt = Date.parse(query.resultsGeneratedAt);
    const judgedAt = Date.parse(query.judgmentsLockedAt);
    if (!Number.isFinite(locked) || !Number.isFinite(resultAt) || !Number.isFinite(judgedAt)
      || !(locked < resultAt && resultAt < judgedAt)) issues.push(`invalid-temporal-order:${query.id}`);
    if (!Array.isArray(query.judgments) || !Array.isArray(query.engines) || !query.engines.length) {
      issues.push(`missing-judgments-or-engines:${query.id}`); continue;
    }
    const grades = new Map();
    for (const judgment of query.judgments) {
      if (typeof judgment.blindId !== 'string' || !judgment.blindId || !isGrade(judgment.grade) || grades.has(judgment.blindId)) {
        issues.push(`invalid-or-duplicate-judgment:${query.id}`); continue;
      }
      if (judgment.humanJudged !== true) issues.push(`unverified-judgment:${query.id}`);
      grades.set(judgment.blindId, judgment.grade);
    }
    const ideal = dcg([...grades.values()].sort((a, b) => b - a).slice(0, 10));
    if (ideal === 0) { zeroIdcgQueries++; continue; }
    const engineNames = new Set();
    for (const engine of query.engines) {
      if (!engine.name || engineNames.has(engine.name) || !Array.isArray(engine.top10BlindIds) || engine.top10BlindIds.length > 10
        || new Set(engine.top10BlindIds).size !== engine.top10BlindIds.length) {
        issues.push(`invalid-engine-ranking:${query.id}`); continue;
      }
      engineNames.add(engine.name);
      if (engine.top10BlindIds.some(id => !grades.has(id))) issues.push(`incomplete-pooled-judgments:${query.id}:${engine.name}`);
      const value = dcg(engine.top10BlindIds.map(id => grades.get(id) ?? 0)) / ideal;
      perEngine.set(engine.name, [...(perEngine.get(engine.name) ?? []), value]);
    }
  }
  if (zeroIdcgQueries === study?.queries?.length) issues.push('no-query-has-positive-judgment');
  const metrics = Object.fromEntries([...perEngine].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => [name, {
    n: values.length, meanNdcg10: values.reduce((a, b) => a + b, 0) / values.length, perQuery: values,
  }]));
  return { status: issues.length ? 'NOT_EVALUABLE' : 'SCORED_NO_TARGET_THRESHOLD', issues: [...new Set(issues)],
    metric: 'macro-mean nDCG@10; gain=2^grade-1; discount=log2(rank+1)',
    queryCount: study?.queries?.length ?? 0, positiveIdcgQueries: (study?.queries?.length ?? 0) - zeroIdcgQueries,
    zeroIdcgQueries, metrics,
    note: 'New-article discovery only. No numerical target was set; this result does not establish refind Hit@10.' };
}
