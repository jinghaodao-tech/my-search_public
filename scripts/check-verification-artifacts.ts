import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { assertSearchQualityMetrics } from "./search_quality_config.js";

const files = ["artifacts/vitest-results.json", "artifacts/acceptance-tests.json", "artifacts/search-quality.json", "artifacts/ranking-engine-quality.json", "artifacts/end-to-end-query-quality.json", "artifacts/benchmark-results.json"];
const missing = files.filter((file) => !existsSync(file));
assert.equal(missing.length, 0, `verification artifacts missing: ${missing.join(", ")}`);
for (const file of files) assert.ok(JSON.parse(readFileSync(file, "utf8")));
const quality = JSON.parse(readFileSync("artifacts/search-quality.json", "utf8")) as { ranking?: { metrics?: Record<string, number>; thresholds?: Record<string, number>; rows?: Array<{ rankingDetails?: unknown[] }> }; endToEnd?: { metrics?: Record<string, number>; thresholds?: Record<string, number>; rows?: Array<{ rankingDetails?: unknown[] }> }; tokenizationDiagnostics?: unknown; failureCases?: unknown[]; successNearNegativeCases?: unknown[] };
const rankingMetrics = quality.ranking?.metrics ?? {};
const endToEndMetrics = quality.endToEnd?.metrics ?? {};
assertSearchQualityMetrics('ranking', rankingMetrics);
assertSearchQualityMetrics('endToEnd', endToEndMetrics);
assert.ok(quality.ranking?.rows?.every(row => Array.isArray(row.rankingDetails)), 'ranking details missing');
assert.ok(quality.endToEnd?.rows?.every(row => Array.isArray(row.rankingDetails)), 'end-to-end ranking details missing');
assert.ok(quality.tokenizationDiagnostics, 'tokenization diagnostics missing');
assert.ok(Array.isArray(quality.failureCases), 'failure case table missing');
assert.ok(Array.isArray(quality.successNearNegativeCases), 'near-negative table missing');
console.log("verification artifact check passed");
