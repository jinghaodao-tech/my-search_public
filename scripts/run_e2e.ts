import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const artifactsDir = path.join(process.cwd(), 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });
const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npx.cmd playwright test'] : ['playwright', 'test'];
const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: { ...process.env, E2E_JSON_OUTPUT_FILE: path.join(artifactsDir, 'e2e-tests.json') },
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
