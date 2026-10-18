// `npm run trial`: start the app in demo mode with the sample data, for trying it out
// (hackathon judges etc.). Works the same on Windows, macOS and Linux.
//
// - Uses its own database (data/trial.db), so your own cards are never touched.
// - Starts from the sample every time (add --keep to keep what you did last time).
// - --watch restarts the server by itself when a file changes (for development).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = path.join(root, 'data', 'trial.db');
fs.mkdirSync(path.dirname(db), { recursive: true });
if (!process.argv.includes('--keep')) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(db + suffix, { force: true });
}

const port = process.env.PORT || '3000';
const env = { ...process.env, DEMO_MODE: 'true', DB_PATH: db, HOST: process.env.HOST || '127.0.0.1', PORT: port };
const tsx = createRequire(import.meta.url).resolve('tsx/cli');

console.log('\nmy-search お試し版を起動しています…');
console.log(`起動したらブラウザで http://localhost:${port} を開いてください（止めるときは Ctrl+C）\n`);

const args = process.argv.includes('--watch') ? [tsx, 'watch', 'server.ts'] : [tsx, 'server.ts'];
const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 0));
