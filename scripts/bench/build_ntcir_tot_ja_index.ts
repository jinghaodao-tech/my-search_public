import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';
import Database from 'better-sqlite3';
import { tokenizeMorphological, tokenizerName } from '../../bm25_engine.js';

type Document = { id: string; title?: string; text?: string };

const dataDir = path.resolve(process.argv[2] ?? 'quality/e2e/local/ntcir-tot-2026-ja');
const corpusPath = path.join(dataDir, 'corpus-ja-verified.gz');
const databasePath = path.join(dataDir, 'corpus.sqlite');
const manifestPath = path.join(dataDir, 'index-provenance.json');
const expectedDocuments = 1_389_467;

if (!fs.existsSync(corpusPath)) throw new Error(`Missing NTCIR Japanese corpus: ${corpusPath}`);
if (fs.existsSync(databasePath) || fs.existsSync(manifestPath)) {
  throw new Error('Refusing to overwrite an existing NTCIR corpus index or provenance file.');
}

async function* readGzipJsonl<T>(file: string): AsyncGenerator<T> {
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  const stream = createReadStream(file).pipe(createGunzip());
  for await (const chunk of stream) {
    remainder += decoder.write(chunk as Buffer);
    let newline = remainder.indexOf('\n');
    while (newline >= 0) {
      const line = remainder.slice(0, newline).replace(/\r$/u, '');
      if (line) yield JSON.parse(line) as T;
      remainder = remainder.slice(newline + 1);
      newline = remainder.indexOf('\n');
    }
  }
  remainder += decoder.end();
  if (remainder.trim()) yield JSON.parse(remainder.replace(/\r$/u, '')) as T;
}

async function hashFile(file: string, algorithm: 'md5' | 'sha256'): Promise<string> {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const officialCorpusMd5 = 'f0515675e955641ffd1fcf7c000a2d9f';
const corpusMd5 = await hashFile(corpusPath, 'md5');
if (corpusMd5 !== officialCorpusMd5) throw new Error('Corpus MD5 does not match the official NTCIR checksum; refusing to index.');
const corpusSha256 = await hashFile(corpusPath, 'sha256');

const database = new Database(databasePath);
let documentCount = 0;
let tokenCount = 0;
let batch: Array<{ id: string; title: string; body: string; tokens: string }> = [];
const seenIds = new Set<string>();

try {
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.exec(`
    CREATE TABLE articles(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL) WITHOUT ROWID;
    CREATE VIRTUAL TABLE articles_morph_fts USING fts5(id UNINDEXED,tokens);
  `);
  const insertArticle = database.prepare('INSERT INTO articles(id,title,body) VALUES (?,?,?)');
  const insertFts = database.prepare('INSERT INTO articles_morph_fts(id,tokens) VALUES (?,?)');
  const insertBatch = database.transaction((rows: typeof batch) => {
    for (const row of rows) {
      insertArticle.run(row.id, row.title, row.body);
      insertFts.run(row.id, row.tokens);
      documentCount++;
      tokenCount += row.tokens ? row.tokens.split(' ').length : 0;
    }
  });

  for await (const document of readGzipJsonl<Document>(corpusPath)) {
    if (!document.id || seenIds.has(document.id)) throw new Error(`Missing or duplicate Wikipedia page ID at document ${documentCount + 1}.`);
    seenIds.add(document.id);
    const title = document.title ?? '';
    const body = document.text ?? '';
    const tokens = (await tokenizeMorphological(`${title} ${body}`.normalize('NFKC'))).join(' ');
    batch.push({ id: document.id, title, body, tokens });
    if (batch.length >= 100) {
      insertBatch(batch);
      batch = [];
      if (documentCount % 10_000 === 0) {
        console.log(JSON.stringify({ phase: 'index', completedDocuments: documentCount, totalDocuments: expectedDocuments, rssBytes: process.memoryUsage().rss }));
      }
    }
  }
  if (batch.length) insertBatch(batch);
  if (documentCount !== expectedDocuments) {
    throw new Error(`Expected ${expectedDocuments} documents but read ${documentCount}.`);
  }
  const integrity = database.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${String(integrity)}`);
  database.pragma('wal_checkpoint(TRUNCATE)');

  const manifest = {
    dataset: 'NTCIR 2026 Tip-of-the-Tongue Japanese Wikipedia corpus',
    corpusFile: path.basename(corpusPath),
    corpusBytes: fs.statSync(corpusPath).size,
    corpusMd5,
    corpusSha256,
    expectedCorpusMd5: officialCorpusMd5,
    documents: documentCount,
    uniqueDocumentIds: seenIds.size,
    morphologyTokens: tokenCount,
    tokenizer: `my-search tokenizeMorphological (${tokenizerName()}) after NFKC(title + space + text)`,
    searchIndex: 'isolated SQLite FTS5; not connected to application DB',
    integrityCheck: integrity,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ phase: 'complete', databasePath, manifest, databaseBytes: fs.statSync(databasePath).size, rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed }, null, 2));
} finally {
  database.close();
}
