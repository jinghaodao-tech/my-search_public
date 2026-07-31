import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const dbPath = path.join(os.tmpdir(), `my-search-http-benchmark-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.NODE_ENV = 'test';
const { app } = await import('../app.js');
const { db } = await import('../db/database.js');
const now = new Date().toISOString();
const insert = db.prepare(`INSERT INTO cards (id, title, body, type, tags_json, links_json, archived, tokens_json, doc_length, created_at, updated_at) VALUES (?, ?, ?, 'memo', '[]', '[]', 0, '[]', 0, ?, ?)`);
const tx = db.transaction(() => { for (let index = 0; index < 100; index += 1) insert.run(`http-bench-${index}`, `HTTP benchmark card ${index}`, 'saved knowledge search fixture', now, now); });
tx();
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', () => resolve()));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Unable to determine benchmark port');
const url = `http://127.0.0.1:${address.port}/api/cards?q=benchmark&limit=100`;
const coldStart = performance.now();
const coldResponse = await fetch(url);
await coldResponse.arrayBuffer();
const coldStartMs = performance.now() - coldStart;
const warmStart = performance.now();
for (let index = 0; index < 10; index += 1) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP benchmark failed: ${response.status}`);
  await response.arrayBuffer();
}
const warmSearchMs = (performance.now() - warmStart) / 10;
server.close();
db.close();
console.log(JSON.stringify({ ok: true, scope: 'end-to-end-http', corpusSize: 100, coldStartMs: Number(coldStartMs.toFixed(3)), warmSearchMs: Number(warmSearchMs.toFixed(3)), endpoint: 'GET /api/cards?q=benchmark&limit=100' }, null, 2));