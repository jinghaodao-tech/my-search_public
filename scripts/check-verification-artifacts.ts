import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const files = ["artifacts/vitest-results.json", "artifacts/acceptance-tests.json", "artifacts/search-quality.json", "artifacts/ranking-engine-quality.json", "artifacts/end-to-end-query-quality.json", "artifacts/benchmark-results.json"];
const missing = files.filter((file) => !existsSync(file));
assert.equal(missing.length, 0, `verification artifacts missing: ${missing.join(", ")}`);
for (const file of files) assert.ok(JSON.parse(readFileSync(file, "utf8")));
const quality = JSON.parse(readFileSync("artifacts/search-quality.json", "utf8")) as { metrics?: { precisionAt1?: number; mrr?: number } };
assert.ok((quality.metrics?.precisionAt1 ?? 0) >= 0.8, "precisionAt1 below threshold");
assert.ok((quality.metrics?.mrr ?? 0) >= 0.8, "MRR below threshold");
console.log("verification artifact check passed");
