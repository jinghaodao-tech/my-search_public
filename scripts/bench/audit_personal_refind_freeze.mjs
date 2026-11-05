import { auditFreezePayload } from './personal_refind_freeze.mjs';
import { readFreezeInputs, readPrivateManifest } from './personal_refind_freeze_io.mjs';

const [manifestPath] = process.argv.slice(2);
if (!manifestPath) throw Error('Usage: node scripts/bench/audit_personal_refind_freeze.mjs <private-freeze-manifest.json>');
const manifest = readPrivateManifest(manifestPath);
const inputs = readFreezeInputs({
  recordsDirectory: `quality/e2e/local/personal-refind/${manifest.sources.recordsDirectory}`,
  developmentDirectory: `quality/e2e/local/personal-refind/${manifest.sources.developmentDirectory}`,
  corpusPath: `quality/e2e/local/personal-refind/${manifest.sources.corpusPath}`,
  configurationPath: `quality/e2e/local/personal-refind/${manifest.sources.configurationPath}`,
});
const audit = auditFreezePayload(manifest, { ...inputs, minimumCases: manifest.minimumCases });
console.log(JSON.stringify({ status: audit.valid ? 'FREEZE_VALID' : 'NOT_EVALUABLE', ...audit }));
if (!audit.valid) process.exitCode = 2;
