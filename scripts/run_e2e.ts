import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const artifactsDir = path.join(process.cwd(), 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });
const playwrightCli = path.join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js');
const result = spawnSync(process.execPath, [playwrightCli, 'test'], {
  stdio: 'inherit',
  env: { ...process.env, E2E_JSON_OUTPUT_FILE: path.join(artifactsDir, 'e2e-tests.json') },
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
