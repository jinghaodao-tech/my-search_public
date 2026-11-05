import { createFreezePayload, sealFreezePayload } from './personal_refind_freeze.mjs';
import { readFreezeInputs, writePrivateManifest } from './personal_refind_freeze_io.mjs';

const [recordsDirectory, developmentDirectory, corpusPath, configurationPath, outputPath] = process.argv.slice(2);
if (!recordsDirectory || !developmentDirectory || !corpusPath || !configurationPath || !outputPath) {
  throw Error('Usage: node scripts/bench/freeze_personal_refind.mjs <final-records-dir> <development-records-dir> <private-corpus.sqlite> <private-configuration.json> <new-private-manifest.json>');
}
const inputs = readFreezeInputs({ recordsDirectory, developmentDirectory, corpusPath, configurationPath });
const result = createFreezePayload(inputs);
if (result.status !== 'FROZEN') {
  console.log(JSON.stringify({ status: result.status, issues: result.issues }));
  process.exitCode = 2;
} else {
  const manifest = sealFreezePayload(result.payload);
  const file = writePrivateManifest(outputPath, manifest);
  console.log(JSON.stringify({ status: 'FROZEN', manifest: file, caseCount: manifest.caseCount,
    targetGroupCount: manifest.targetGroupCount, manifestSha256: manifest.manifestSha256 }));
}
