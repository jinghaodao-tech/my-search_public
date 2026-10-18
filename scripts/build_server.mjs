// `npm run build`: compile the server's TypeScript to plain JavaScript in dist/ (same folder layout),
// so a deployment can run `node dist/server.js` without tsx. That saves memory: no TypeScript
// loader, no source maps of every loaded module, and no npm / tsx parent processes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipDirs = new Set(['node_modules', 'dist', 'tests', 'e2e', 'frontend', 'public', 'data', 'docs', 'notes', 'artifacts', 'backups', 'demo', 'deploy', '.git', 'scripts']);
const entryPoints = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!skipDirs.has(entry.name)) walk(full); continue; }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts')) entryPoints.push(full);
  }
})(root);

fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
await build({ entryPoints, outdir: path.join(root, 'dist'), outbase: root, bundle: false, platform: 'node', format: 'esm', target: 'node22', sourcemap: false, logLevel: 'warning' });
console.log(`built ${entryPoints.length} files into dist/ — start with: node dist/server.js`);
