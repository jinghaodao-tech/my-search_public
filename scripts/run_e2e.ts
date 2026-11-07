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

function runSuite(name: string, grep: string[] = [], researchExperimentsEnabled = false) {
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
      E2E_RESEARCH_EXPERIMENTS_ENABLED: String(researchExperimentsEnabled),
    },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, reportPath };
}

const defaultSuite = runSuite('default', ['--grep-invert', `${enabledExperimentTests}|${desktopTests}`]);
const enabledSuite = runSuite('research-enabled', ['--grep', enabledExperimentTests], true);
const desktopSuite = runSuite('desktop', ['--grep', desktopTests]);

const readReport = (filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, any>;
const defaultReport = readReport(defaultSuite.reportPath);
const enabledReport = readReport(enabledSuite.reportPath);
const desktopReport = readReport(desktopSuite.reportPath);
const numericStats = ['expected', 'skipped', 'unexpected', 'flaky', 'duration'];
const stats = Object.fromEntries(numericStats.map((key) => [
  key,
  Number(defaultReport.stats?.[key] ?? 0) + Number(enabledReport.stats?.[key] ?? 0),
]));
const mergedReport = {
  ...defaultReport,
  stats: { ...defaultReport.stats, ...stats },
  suites: [...(defaultReport.suites ?? []), ...(enabledReport.suites ?? []), ...(desktopReport.suites ?? [])],
};
fs.writeFileSync(path.join(artifactsDir, 'e2e-tests.json'), JSON.stringify(mergedReport, null, 2), 'utf-8');

process.exit(defaultSuite.status || enabledSuite.status || desktopSuite.status);
