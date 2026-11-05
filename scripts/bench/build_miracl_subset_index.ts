import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tokenizeMorphological } from '../../bm25_engine.js';

const sourceDbPath = path.resolve('data/bench/miracl-ja.db');
const outputRoot = path.resolve('data/ir_benchmark/work/miracl-ja-e5-20261024');
const outputPath = path.join(outputRoot, 'index.sqlite');
const sourceEvalPath = path.resolve('data/bench/miracl-ja.eval.json');
const outputManifestPath = path.join(outputRoot, 'index-provenance.json');
for (const input of [sourceDbPath, sourceEvalPath]) if (!fs.existsSync(input)) throw new Error(`Missing input: ${input}`);
if (fs.existsSync(outputPath) || fs.existsSync(outputManifestPath)) throw new Error('Refusing to overwrite an existing MIRACL E5 index/provenance file.');

const evaluation = JSON.parse(fs.readFileSync(sourceEvalPath, 'utf8')) as { documents: number; queries: Array<{ id: string }>; qrels: Record<string, Record<string, number>> };
const source = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
const rows = source.prepare("SELECT id,title,body,morphological_tokens_json FROM articles WHERE source='bench:miracl-ja' ORDER BY id")
  .all() as Array<{ id: string; title: string; body: string; morphological_tokens_json: string }>;
if (rows.length !== evaluation.documents) throw new Error(`Expected ${evaluation.documents} source subset rows, got ${rows.length}.`);

const samples = rows.map(row => ({ row, hash: crypto.createHash('sha256').update(row.id).digest('hex') }))
  .sort((left, right) => left.hash.localeCompare(right.hash)).slice(0, 25);
for (const { row } of samples) {
  const stored = JSON.parse(row.morphological_tokens_json) as string[];
  const current = await tokenizeMorphological(`${row.title} ${row.body}`.normalize('NFKC'));
  if (stored.length !== current.length || stored.some((token, index) => token !== current[index])) {
    throw new Error(`Stored morphology tokens differ from current tokenizer for ${row.id}; refusing to index stale terms.`);
  }
}

const indexedArticleIds = new Set(rows.map(row => row.id));
const absentPositiveQrels: Array<{ queryId: string; docId: string }> = [];
for (const [queryId, judgments] of Object.entries(evaluation.qrels)) for (const [rawDocId, grade] of Object.entries(judgments)) {
  const docId = `bench-miracl-ja-${rawDocId}`;
  if (grade > 0 && !indexedArticleIds.has(docId)) absentPositiveQrels.push({ queryId, docId });
}
if (absentPositiveQrels.length) throw new Error(`Positive qrels absent from the fixed subset: ${absentPositiveQrels.length}.`);

fs.mkdirSync(outputRoot, { recursive: true });
const db = new Database(outputPath);
try {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec('CREATE TABLE documents(id TEXT PRIMARY KEY,length INTEGER NOT NULL) WITHOUT ROWID; CREATE TABLE postings(term TEXT NOT NULL,doc_id TEXT NOT NULL,tf INTEGER NOT NULL,PRIMARY KEY(term,doc_id)) WITHOUT ROWID;');
  const insertDocument = db.prepare('INSERT INTO documents(id,length) VALUES (?,?)');
  const insertPosting = db.prepare('INSERT INTO postings(term,doc_id,tf) VALUES (?,?,?)');
  const insertBatch = db.transaction((batch: typeof rows) => {
    for (const row of batch) {
      const tokens = JSON.parse(row.morphological_tokens_json) as string[];
      insertDocument.run(row.id, tokens.length);
      const tf = new Map<string, number>();
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
      for (const [term, count] of tf) insertPosting.run(term, row.id, count);
    }
  });
  for (let offset = 0; offset < rows.length; offset += 250) {
    insertBatch(rows.slice(offset, offset + 250));
    if ((offset + 250) % 5000 === 0 || offset + 250 >= rows.length) console.log(`indexed ${Math.min(offset + 250, rows.length)}/${rows.length}`);
  }
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`Generated index integrity check failed: ${String(integrity)}`);
} finally {
  db.close();
  source.close();
}
const manifest = {
  sourceDatabase: sourceDbPath, sourceDatabaseOpenedReadOnly: true,
  sourceEval: sourceEvalPath, documents: rows.length, queries: evaluation.queries.length,
  positiveQrelsAbsentFromCorpus: 0, tokenizerParity: { method: 'ascending SHA-256 article ID', checked: samples.length, allMatched: true },
  indexSha256: crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex'),
};
fs.writeFileSync(outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, manifest }, null, 2));
