import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const artifactsDir = path.join(process.cwd(), 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });
const playwrightCli = path.join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js');
const enabledExperimentTests = [
  'opt-in local lab records synthetic consented events and permits deletion',
  'separated and integrated E6 workflows complete the same synthetic task with the same source and calculator',
  'E0 refind and resume tasks run their declared phase sequences and report completion separately',
].join('|');
const desktopTests = 'Electron separates remote pages, allows two HTTPS tabs, and refuses unsafe destinations';
const readerToolsDisabledTest = 'internal feature flag hides tools and preserves ordinary Reader';
const demoModeTest = 'demo sample supports the full saved-article, tool, memo and resume flow';
const conditionallyRunTests = [enabledExperimentTests, desktopTests, readerToolsDisabledTest, demoModeTest].join('|');

function runSuite(name: string, grep: string[] = [], options: {
  researchExperimentsEnabled?: boolean;
  env?: Record<string, string>;
} = {}) {
  const reportPath = path.join(artifactsDir, `e2e-tests-${name}.json`);
  const result = spawnSync(process.execPath, [
    playwrightCli,
    'test',
    ...grep,
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_JSON_OUTPUT_FILE: reportPath,
      E2E_RESEARCH_EXPERIMENTS_ENABLED: String(options.researchExperimentsEnabled ?? false),
      ...options.env,
    },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, reportPath };
}

// Run Electron before the long Chromium suites to avoid resource pressure from
// dozens of browser tests affecting native app startup on Windows runners.
const desktopSuite = runSuite('desktop', ['--grep', desktopTests]);
const defaultSuite = runSuite('default', ['--grep-invert', conditionallyRunTests]);
const enabledSuite = runSuite('research-enabled', ['--grep', enabledExperimentTests], { researchExperimentsEnabled: true });
const readerToolsDisabledSuite = runSuite('reader-tools-disabled', ['--grep', readerToolsDisabledTest], { env: { READER_TOOLS_ENABLED: 'false' } });
const demoSuite = runSuite('demo-mode', ['--grep', demoModeTest], { env: { DEMO_MODE: 'true', DEMO_DATA_SCOPE: 'local' } });

const readReport = (filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, any>;
const reports = [defaultSuite, enabledSuite, readerToolsDisabledSuite, demoSuite, desktopSuite].map(suite => readReport(suite.reportPath));
const numericStats = ['expected', 'skipped', 'unexpected', 'flaky', 'duration'];
const stats = Object.fromEntries(numericStats.map(key => [key,
  reports.reduce((total, report) => total + Number(report.stats?.[key] ?? 0), 0),
]));
const mergedReport = {
  ...reports[0],
  stats: { ...reports[0].stats, ...stats },
  suites: reports.flatMap(report => report.suites ?? []),
};
fs.writeFileSync(path.join(artifactsDir, 'e2e-tests.json'), JSON.stringify(mergedReport, null, 2), 'utf-8');

process.exit(defaultSuite.status || enabledSuite.status || readerToolsDisabledSuite.status || demoSuite.status || desktopSuite.status);
