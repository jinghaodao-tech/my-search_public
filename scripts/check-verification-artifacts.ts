import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { assertSearchQualityMetrics } from "./search_quality_config.js";

const files = ["artifacts/vitest-results.json", "artifacts/acceptance-tests.json", "artifacts/search-quality.json", "artifacts/ranking-engine-quality.json", "artifacts/end-to-end-query-quality.json", "artifacts/real-search-quality.json", "artifacts/benchmark-results.json", "artifacts/tokenization-cost.json"];
const missing = files.filter((file) => !existsSync(file));
assert.equal(missing.length, 0, `verification artifacts missing: ${missing.join(", ")}`);
for (const file of files) assert.ok(JSON.parse(readFileSync(file, "utf8")));
const quality = JSON.parse(readFileSync("artifacts/search-quality.json", "utf8")) as { ranking?: { metrics?: Record<string, number>; theoretical?: Record<string, number>; qualityGate?: boolean; rows?: Array<{ rankingDetails?: unknown[]; sensitivity?: unknown }> }; endToEnd?: { metrics?: Record<string, number>; theoretical?: Record<string, number>; qualityGate?: boolean; rows?: Array<{ rankingDetails?: unknown[]; sensitivity?: unknown }> }; real?: { metrics?: Record<string, number>; theoretical?: Record<string, number>; qualityGate?: boolean; qualityGateThresholds?: { precisionAt1?: number }; rows?: Array<{ rankingDetails?: unknown[]; sensitivity?: unknown }>; dataset?: { labelSource?: string }; datasetQuality?: { status?: string; issues?: string[]; allMetricsAtUpperBound?: boolean; duplicateQueryGroups?: string[]; degenerateQueryCount?: number; zeroRecallRate?: number; warning?: string | null } }; decaySweep?: { passingRange?: { lambdaWidth?: number }; floorProfiles?: Array<{ timeDecayFloor: number; passingRange?: { lambdaWidth?: number } | null; pAt1ByLambda: unknown[] }> }; tokenizationDiagnostics?: unknown; failureCases?: unknown[]; successNearNegativeCases?: unknown[] };
const rankingMetrics = quality.ranking?.metrics ?? {};
const endToEndMetrics = quality.endToEnd?.metrics ?? {};
assertSearchQualityMetrics('endToEnd', endToEndMetrics);
for (const [scope, evaluation] of [['ranking', quality.ranking], ['endToEnd', quality.endToEnd], ['real', quality.real]] as const) {
  assert.ok(evaluation?.theoretical, `${scope} theoretical upper bounds missing`);
  for (const [metric, actual] of Object.entries(evaluation?.metrics ?? {})) {
    const upperBound = evaluation?.theoretical?.[metric];
    assert.ok(typeof upperBound === 'number' && actual <= upperBound + 1e-9, `${scope} ${metric} exceeds theoretical upper bound`);
  }
}
assert.equal(quality.ranking?.qualityGate, false, 'ranking-only must remain diagnostic');
assert.equal(quality.endToEnd?.qualityGate, true, 'end-to-end must remain the primary gate');
assert.equal(quality.real?.qualityGate, true, 'real corpus must remain a release signal');
assert.ok((quality.real?.qualityGateThresholds?.precisionAt1 ?? 0) >= 0.7, 'real P@1 gate must be explicit');
assert.match(quality.real?.dataset?.labelSource ?? '', /common anonymized|manual relevance/);
if (quality.real?.datasetQuality?.allMetricsAtUpperBound) assert.match(quality.real.datasetQuality.warning ?? '', /識別力/);
assert.ok(Array.isArray(quality.real?.datasetQuality?.issues), 'real dataset quality assessment missing');
assert.ok((quality.real?.datasetQuality?.duplicateQueryGroups?.length ?? 0) === 0, 'real has conflicting duplicate queries');
assert.ok((quality.real?.datasetQuality?.degenerateQueryCount ?? 0) === 0, 'real has degenerate query language');
const defaultFloorProfile = quality.decaySweep?.floorProfiles?.find((profile) => profile.timeDecayFloor === 0.35);
assert.ok(defaultFloorProfile?.pAt1ByLambda.length, 'time-decay P@1 sweep missing');
assert.ok((defaultFloorProfile?.passingRange?.lambdaWidth ?? 0) > 0, 'time-decay passing window width missing');
assert.ok(quality.ranking?.rows?.every(row => Array.isArray(row.rankingDetails)), 'ranking details missing');
assert.ok(quality.endToEnd?.rows?.every(row => Array.isArray(row.rankingDetails)), 'end-to-end ranking details missing');
assert.ok(quality.ranking?.rows?.every(row => 'sensitivity' in row), 'ranking sensitivity summary missing');
assert.ok(quality.endToEnd?.rows?.every(row => 'sensitivity' in row), 'end-to-end sensitivity summary missing');
assert.ok(quality.real?.rows?.every(row => Array.isArray(row.rankingDetails) && 'sensitivity' in row), 'real sensitivity summary missing');
assert.ok(quality.tokenizationDiagnostics, 'tokenization diagnostics missing');
assert.ok(Array.isArray(quality.failureCases), 'failure case table missing');
assert.ok(Array.isArray(quality.successNearNegativeCases), 'near-negative table missing');
console.log("verification artifact check passed");
