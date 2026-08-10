import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { tokenize, tokenizeMorphological } from '../bm25_engine.js';

type CardRow = { title: string; body: string; summary: string | null; tags_json: string | null; tokens_json: string | null };
const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'cards.db');
const db = new Database(dbPath, { readonly: true });
const rows = db.prepare('SELECT title, body, summary, tags_json, tokens_json FROM cards WHERE archived = 0').all() as CardRow[];
db.close();

const storedStart = performance.now();
const storedTokens = rows.flatMap(row => {
  try { return JSON.parse(row.tokens_json ?? '[]') as string[]; } catch { return []; }
});
const storedMs = performance.now() - storedStart;
const freshStart = performance.now();
let freshTokenCount = 0;
let morphologicalTokenCount = 0;
let expandedTokenBytes = 0;
let morphologicalTokenBytes = 0;
for (const row of rows) {
  const tags = (() => { try { return JSON.parse(row.tags_json ?? '[]').join(' '); } catch { return ''; } })();
  const text = `${row.title} ${row.body} ${row.summary ?? ''} ${tags}`;
  const morphologicalTokens = await tokenizeMorphological(text);
  const expandedTokens = await tokenize(text);
  morphologicalTokenCount += morphologicalTokens.length;
  freshTokenCount += expandedTokens.length;
  morphologicalTokenBytes += Buffer.byteLength(JSON.stringify(morphologicalTokens), 'utf8');
  expandedTokenBytes += Buffer.byteLength(JSON.stringify(expandedTokens), 'utf8');
}
const freshMs = performance.now() - freshStart;
const result = {
  generatedAt: new Date().toISOString(),
  corpus: { activeDocuments: rows.length, storedTokenCount: storedTokens.length, morphologicalTokenCount, expandedTokenCount: freshTokenCount, tokenCountMultiplier: morphologicalTokenCount > 0 ? Number((freshTokenCount / morphologicalTokenCount).toFixed(2)) : null, morphologicalTokenBytes, expandedTokenBytes, indexPayloadMultiplier: morphologicalTokenBytes > 0 ? Number((expandedTokenBytes / morphologicalTokenBytes).toFixed(2)) : null },
  storedTokenRead: { elapsedMs: Number(storedMs.toFixed(3)), meaning: 'SQLite tokens_json parse baseline' },
  freshTokenization: { elapsedMs: Number(freshMs.toFixed(3)), meaning: 'current kuromoji plus Japanese bigram path' },
  multiplier: storedMs > 0 ? Number((freshMs / storedMs).toFixed(2)) : null,
  limitation: 'This is a reproducible stored-token versus fresh-tokenization cost comparison; no pre-bigram historical implementation is reconstructed.',
};
fs.mkdirSync(path.join(process.cwd(), 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), 'artifacts', 'tokenization-cost.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify(result, null, 2));
