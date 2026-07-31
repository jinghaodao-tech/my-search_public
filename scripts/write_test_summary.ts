import fs from 'node:fs';
import path from 'node:path';

type JsonRecord = Record<string, any>;
const artifactsDir = path.join(process.cwd(), 'artifacts');
const countTestFiles = (directory: string) => fs.readdirSync(path.join(process.cwd(), directory)).filter(name => name.endsWith('.test.ts')).length;
const read = (name: string): JsonRecord => JSON.parse(fs.readFileSync(path.join(artifactsDir, name), 'utf-8')) as JsonRecord;
const vitestSummary = (report: JsonRecord) => ({
  total: report.numTotalTests ?? 0,
  passed: report.numPassedTests ?? 0,
  failed: report.numFailedTests ?? 0,
  skipped: report.numPendingTests ?? 0,
});
const unitReport = read('vitest-results.json');
const acceptanceReport = read('acceptance-tests.json');
const unit = vitestSummary(unitReport);
const acceptance = vitestSummary(acceptanceReport);
const e2eStats = read('e2e-tests.json').stats ?? {};
const summary = {
  generatedAt: new Date().toISOString(),
  suites: {
    unit: { ...unit, files: 1 },
    acceptance: { ...acceptance, files: countTestFiles('tests') },
    e2e: {
      total: e2eStats.expected ?? 0,
      passed: Math.max(0, (e2eStats.expected ?? 0) - (e2eStats.unexpected ?? 0) - (e2eStats.skipped ?? 0)),
      failed: e2eStats.unexpected ?? 0,
      skipped: e2eStats.skipped ?? 0,
      flaky: e2eStats.flaky ?? 0,
    },
  },
};
fs.writeFileSync(path.join(artifactsDir, 'test-summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
console.log(JSON.stringify(summary, null, 2));
