// `npm run bench -- <name>`: start my-search on an isolated benchmark DB (data/bench/<name>.db)
// at http://localhost:3100, with /bench/ open for the runner (scripts/bench/README.md).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const name = process.argv[2];
const benchDir = path.join(root, 'data', 'bench');
const db = name && path.join(benchDir, `${name}.db`);
if (!name || !fs.existsSync(db)) {
  const have = fs.existsSync(benchDir) ? fs.readdirSync(benchDir).filter(f => f.endsWith('.db')).map(f => f.slice(0, -3)) : [];
  console.error(`usage: npm run bench -- <name>   (available: ${have.join(', ') || 'none — run scripts/bench/import_benchmark.ts first'})`);
  process.exit(1);
}
const port = process.env.PORT || '3100';
const env = { ...process.env, DB_PATH: db, BENCH_DIR: benchDir, SITE_SYNC: 'off', DEMO_MODE: '', HOST: '127.0.0.1', PORT: port, KJ_FILE: path.join(benchDir, `${name}.kj.json`) };
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
console.log(`\nベンチマーク「${name}」で起動します: http://localhost:${port}  （止めるときは Ctrl+C）\n`);
const child = spawn(process.execPath, [tsx, 'server.ts'], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 0));
