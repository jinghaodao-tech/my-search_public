import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import Database from 'better-sqlite3';
import { tokenizeMorphological } from '../../bm25_engine.js';

type Document = { _id: string; title?: string; text?: string };
const datasetDir = path.resolve(process.argv[2] ?? 'quality/e2e/local/jacwir-experiment/full-retrieval-queries-100');
const indexPath = path.join(datasetDir, 'index.sqlite');
const manifestPath = path.join(datasetDir, 'index-provenance.json');
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels.jsonl');
if (![corpusPath, qrelsPath].every(file => fs.existsSync(file))) throw new Error('Full JaCWIR corpus or qrels are missing.');
if (fs.existsSync(indexPath) || fs.existsSync(manifestPath)) throw new Error('Refusing to overwrite an existing JaCWIR BM25 index or provenance file.');

const readJsonl = async function* <T>(file: string): AsyncGenerator<T> {
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  for await (const chunk of createReadStream(file)) {
    remainder += decoder.write(chunk);
    let newline = remainder.indexOf('\n');
    while (newline >= 0) {
      const line = remainder.slice(0, newline).replace(/\r$/u, '');
      if (line) yield JSON.parse(line) as T;
      remainder = remainder.slice(newline + 1);
      newline = remainder.indexOf('\n');
    }
  }
  remainder += decoder.end();
  if (remainder) yield JSON.parse(remainder.replace(/\r$/u, '')) as T;
};
const shaFile = (file: string) => new Promise<string>((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});

fs.mkdirSync(datasetDir, { recursive: true });
const db = new Database(indexPath);
let count = 0;
let totalTokens = 0;
const seenIds = new Set<string>();
try {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec('CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,text TEXT NOT NULL,length INTEGER NOT NULL) WITHOUT ROWID; CREATE TABLE postings(term TEXT NOT NULL,doc_id TEXT NOT NULL,tf INTEGER NOT NULL,PRIMARY KEY(term,doc_id)) WITHOUT ROWID;');
  const insertDocument = db.prepare('INSERT INTO documents(id,title,text,length) VALUES (?,?,?,?)');
  const insertPosting = db.prepare('INSERT INTO postings(term,doc_id,tf) VALUES (?,?,?)');
  const insertBatch = db.transaction((batch: Array<{ id: string; title: string; text: string; tokens: string[] }>) => {
    for (const row of batch) {
      insertDocument.run(row.id, row.title, row.text, row.tokens.length);
      const frequencies = new Map<string, number>();
      for (const token of row.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      for (const [term, tf] of frequencies) insertPosting.run(term, row.id, tf);
      totalTokens += row.tokens.length;
      count += 1;
    }
  });
  let batch: Array<{ id: string; title: string; text: string; tokens: string[] }> = [];
  for await (const document of readJsonl<Document>(corpusPath)) {
    if (!document._id || seenIds.has(document._id)) throw new Error(`Missing or duplicate document ID: ${document._id}`);
    seenIds.add(document._id);
    const title = document.title ?? '';
    const text = document.text ?? '';
    const tokens = await tokenizeMorphological(`${title} ${text}`.normalize('NFKC'));
    batch.push({ id: document._id, title, text, tokens });
    if (batch.length >= 200) {
      insertBatch(batch);
      batch = [];
      if (count % 5000 === 0) console.log(`indexed ${count}/513107 documents; rss=${process.memoryUsage().rss}`);
    }
  }
  if (batch.length) insertBatch(batch);
  const expectedDocs = 513107;
  if (count !== expectedDocs) throw new Error(`Expected ${expectedDocs} documents, indexed ${count}.`);
  const positives = new Set<string>();
  for await (const row of readJsonl<{ doc_id: string }>(qrelsPath)) positives.add(row.doc_id);
  for (const docId of positives) if (!db.prepare('SELECT 1 FROM documents WHERE id=?').get(docId)) throw new Error(`Known-positive document is absent from full corpus: ${docId}`);
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`Index integrity check failed: ${String(integrity)}`);
  const metadata = {
    corpus: corpusPath, corpusSha256: await shaFile(corpusPath), corpusDocuments: count, totalMorphologyTokens: totalTokens,
    tokenizer: 'tokenizeMorphological after NFKC(title + space + description)',
    storage: 'SQLite documents plus exact term/document-frequency postings; source parquet remains unchanged',
    positiveJudgmentDocuments: positives.size, allPositiveDocumentsPresent: true, integrityCheck: integrity,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ indexPath, metadata, rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed }, null, 2));
} finally {
  db.close();
}
