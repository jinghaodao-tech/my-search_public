// `npm run trial`: start the app in demo mode with the sample data, for trying it out
// (hackathon judges etc.). Works the same on Windows, macOS and Linux.
//
// - Uses a fresh temporary database by default; existing data/trial.db is untouched.
// - Starts from the sample every time (add --keep to retain the demo database).
// - TRIAL_DB_PATH opts into a persistent database; it is never reset unless --reset is explicit.
// - --watch restarts the server by itself when a file changes (for development).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const reset = args.includes('--reset');
const requestedDb = process.env.TRIAL_DB_PATH;
let tempDir = null;

if (keep && reset) throw new Error('--keep と --reset は同時に指定できません');
if (reset && !requestedDb) throw new Error('--reset は TRIAL_DB_PATH を指定した場合だけ使えます');

let db;
if (requestedDb) {
  db = path.resolve(root, requestedDb);
} else if (keep) {
  db = path.join(os.tmpdir(), 'my-search-trial-kept', 'trial.db');
} else {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-search-trial-'));
  db = path.join(tempDir, 'trial.db');
}

fs.mkdirSync(path.dirname(db), { recursive: true });
if (reset) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(db + suffix, { force: true });
}

function cleanup() {
  if (!tempDir) return;
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  const resolvedTempDir = path.resolve(tempDir);
  if (!resolvedTempDir.startsWith(tempRoot) || !path.basename(resolvedTempDir).startsWith('my-search-trial-')) {
    throw new Error('Refusing to remove a path outside this run\'s temporary trial directory');
  }
  fs.rmSync(resolvedTempDir, { recursive: true, force: true });
}

const port = process.env.PORT || '3000';
const env = { ...process.env, DEMO_MODE: 'true', DB_PATH: db, HOST: process.env.HOST || '127.0.0.1', PORT: port };
const tsx = createRequire(import.meta.url).resolve('tsx/cli');

console.log('\nmy-search お試し版を起動しています…');
console.log(`データベース: ${db}`);
if (tempDir) console.log('この起動専用の一時データベースです。終了時に削除します。');
else if (!requestedDb) console.log('--keep 用の永続デモデータベースを使用します。既存の試用データは削除しません。');
console.log(`起動したらブラウザで http://localhost:${port} を開いてください（止めるときは Ctrl+C）\n`);

const childArgs = args.includes('--watch') ? [tsx, 'watch', 'server.ts'] : [tsx, 'server.ts'];
const child = spawn(process.execPath, childArgs, { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => {
  console.error(error);
  cleanup();
  process.exit(1);
});
child.on('exit', code => {
  cleanup();
  process.exit(code ?? 0);
});
