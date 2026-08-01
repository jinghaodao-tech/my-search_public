import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const files = ["artifacts/vitest-results.json", "artifacts/acceptance-tests.json", "artifacts/search-quality.json", "artifacts/ranking-engine-quality.json", "artifacts/end-to-end-query-quality.json", "artifacts/benchmark-results.json"];
const missing = files.filter((file) => !existsSync(file));
assert.equal(missing.length, 0, `verification artifacts missing: ${missing.join(", ")}`);
for (const file of files) assert.ok(JSON.parse(readFileSync(file, "utf8")));
const quality = JSON.parse(readFileSync("artifacts/search-quality.json", "utf8")) as { ranking?: { metrics?: { precisionAt1?: number; mrr?: number } }; endToEnd?: { metrics?: { precisionAt1?: number; mrr?: number } } };
const rankingMetrics = quality.ranking?.metrics ?? {};
const endToEndMetrics = quality.endToEnd?.metrics ?? {};
assert.ok((rankingMetrics.precisionAt1 ?? 0) >= 0.75, "ranking precisionAt1 below threshold");
assert.ok((rankingMetrics.mrr ?? 0) >= 0.8, "ranking MRR below threshold");
assert.ok((endToEndMetrics.precisionAt1 ?? 0) >= 0.75, "end-to-end precisionAt1 below threshold");
assert.ok((endToEndMetrics.mrr ?? 0) >= 0.8, "end-to-end MRR below threshold");
console.log("verification artifact check passed");
