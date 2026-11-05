import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { readJsonObjects } from './miracl_json_stream.js';

const [databaseArg, corpusDirectoryArg, maxDocumentsArg, resumeArg] = process.argv.slice(2);
if (!databaseArg || !corpusDirectoryArg) {
  throw new Error('Usage: import_miracl_full_fts.ts <new-isolated.sqlite> <miracl-corpus-dir> [max-documents-for-smoke-test|--resume]');
}
const finalPath = path.resolve(databaseArg);
const corpusDirectory = path.resolve(corpusDirectoryArg);
const buildPath = `${finalPath}.building`;
const resume = maxDocumentsArg === '--resume' || resumeArg === '--resume';
const maxDocuments = maxDocumentsArg && maxDocumentsArg !== '--resume' ? Number.parseInt(maxDocumentsArg, 10) : undefined;
if (maxDocuments !== undefined && (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1)) {
  throw new Error('max-documents-for-smoke-test must be a positive integer');
}
if (fs.existsSync(finalPath)) throw new Error(`Refusing to overwrite existing path: ${finalPath}`);
if (fs.existsSync(buildPath) !== resume) throw new Error(resume
  ? `No staging database to resume: ${buildPath}`
  : `Refusing to overwrite existing staging database: ${buildPath}`);
if (!resume && (fs.existsSync(`${buildPath}-wal`) || fs.existsSync(`${buildPath}-shm`))) throw new Error('Refusing to overwrite existing SQLite staging sidecars');
const manifestPath = path.join(corpusDirectory, 'corpus_manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
  dataset: string;
  revision: string;
  language: string;
  document_count: number;
  shards: Array<{path: string; bytes: number; rows: number; sha256: string}>;
};
if (manifest.dataset !== 'miracl/miracl-corpus' || manifest.language !== 'ja') throw new Error('Unexpected MIRACL manifest identity');
const shardDirectory = fs.existsSync(path.join(corpusDirectory, 'docs-0.jsonl.gz'))
  ? corpusDirectory
  : path.join(corpusDirectory, 'miracl-corpus-v1.0-ja');
const expectedDocuments = maxDocuments === undefined ? manifest.document_count : Math.min(maxDocuments, manifest.document_count);
process.env.DB_PATH = buildPath;
const { db } = await import('../../db/database.js');
const { buildStoredTokenSet } = await import('../../bm25_engine.js');
type BatchRow = {
  id: string; title: string; body: string; url: string; tokens: string; morphologicalTokens: string;
  ngramTokens: string; docLength: number; morphologicalDocLength: number; ngramDocLength: number; contentHash: string;
};
const now = '2020-01-01T00:00:00.000Z';
const insertArticle = db.prepare(`INSERT OR IGNORE INTO articles (
  id,title,body,url,source,source_authority,published_at,summary,tags_json,tokens_json,doc_length,
  morphological_tokens_json,ngram_tokens_json,morphological_doc_length,ngram_doc_length,content_hash,
  created_at,first_seen_at,updated_at,last_fetched_at,body_kind,source_updated_at,normalized_url
) VALUES (
  @id,@title,@body,@url,'miracl-ja',0.5,NULL,NULL,'[]',@tokens,@docLength,
  @morphologicalTokens,@ngramTokens,@morphologicalDocLength,@ngramDocLength,@contentHash,
  @now,@now,@now,@now,'fulltext',NULL,@url
)`);
const insertSource = db.prepare("INSERT OR IGNORE INTO article_sources(article_id,source,first_seen_at,last_seen_at) VALUES (?,'miracl-ja',?,?)");
const insertBatch = db.transaction((rows: BatchRow[]) => {
  for (const row of rows) {
    insertArticle.run({...row, now});
    insertSource.run(row.id, now, now);
  }
});
const started = performance.now();
const sourceDigests: Array<{file: string; sha256: string; rows: number}> = [];
let inserted = 0;
let inputBytes = 0;
let batch: BatchRow[] = [];

try {
  for (const shard of manifest.shards) {
    if (inserted >= expectedDocuments) break;
    const filePath = path.join(shardDirectory, path.basename(shard.path));
    const digest = crypto.createHash('sha256');
    for await (const chunk of createReadStream(filePath)) digest.update(chunk);
    const sha256 = digest.digest('hex');
    if (sha256 !== shard.sha256) throw new Error(`SHA-256 mismatch for ${filePath}`);
    let shardRows = 0;
    const gunzip = createReadStream(filePath).pipe(createGunzip());
    try {
      for await (const {raw, value: source} of readJsonObjects<{docid: string; title: string; text: string}>(gunzip)) {
        if (!source.docid || typeof source.text !== 'string') throw new Error(`Malformed MIRACL row in ${filePath}`);
        const title = source.title ?? '';
        const body = source.text;
        const id = `miracl-ja-${source.docid}`;
        const url = `https://miracl.invalid/doc/${encodeURIComponent(source.docid)}`;
        const tokenSet = await buildStoredTokenSet(`${title} ${body}`);
        batch.push({
          id,title,body,url,
          tokens: JSON.stringify(tokenSet.ngramTokens),
          morphologicalTokens: JSON.stringify(tokenSet.morphologicalTokens),
          ngramTokens: JSON.stringify(tokenSet.ngramTokens),
          docLength: tokenSet.ngramDocLength,
          morphologicalDocLength: tokenSet.morphologicalDocLength,
          ngramDocLength: tokenSet.ngramDocLength,
          contentHash: crypto.createHash('sha256').update(title).update('\0').update(body).digest('hex'),
        });
        inputBytes += Buffer.byteLength(raw, 'utf8');
        inserted += 1;
        shardRows += 1;
        if (batch.length >= 500) { insertBatch(batch); batch = []; }
        if (inserted % 25_000 === 0) {
          console.log(JSON.stringify({inserted,expectedDocuments,elapsedSeconds:Math.round((performance.now()-started)/1000),documentsPerSecond:Math.round(inserted/((performance.now()-started)/1000)),rssBytes:process.memoryUsage().rss,diskBytes:fs.statSync(buildPath).size}));
        }
        if (inserted >= expectedDocuments) break;
      }
    } finally {
      gunzip.destroy();
    }
    if (maxDocuments === undefined && shardRows !== shard.rows) throw new Error(`Row count mismatch for ${filePath}: expected ${shard.rows}, got ${shardRows}`);
    sourceDigests.push({file: path.basename(filePath),sha256,rows:shardRows});
  }
  if (batch.length) insertBatch(batch);
  if (inserted !== expectedDocuments) throw new Error(`Document count mismatch: expected ${expectedDocuments}, got ${inserted}`);
  const counts = {
    articles: Number((db.prepare('SELECT COUNT(*) AS n FROM articles').get() as {n:number}).n),
    morphologyRows: Number((db.prepare('SELECT COUNT(*) AS n FROM articles_morph_fts').get() as {n:number}).n),
    ngramRows: Number((db.prepare('SELECT COUNT(*) AS n FROM articles_ngram_fts').get() as {n:number}).n),
    sourceRows: Number((db.prepare("SELECT COUNT(*) AS n FROM article_sources WHERE source='miracl-ja'").get() as {n:number}).n),
  };
  if (Object.values(counts).some(count => count !== expectedDocuments)) throw new Error(`Index completeness mismatch: ${JSON.stringify(counts)}`);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  fs.renameSync(buildPath, finalPath);
  const result = {
    dataset: manifest.dataset, revision: manifest.revision, expectedDocuments, inserted,
    complete: maxDocuments === undefined && inserted === manifest.document_count,
    smokeTestOnly: maxDocuments !== undefined,
    sourceDigests, counts, inputBytes,
    elapsedSeconds: (performance.now()-started)/1000,
    documentsPerSecond: inserted/((performance.now()-started)/1000),
    databaseBytes: fs.statSync(finalPath).size,
    maxRssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
  };
  fs.writeFileSync(`${finalPath}.import.json`, `${JSON.stringify(result,null,2)}\n`, 'utf8');
  console.log(JSON.stringify(result,null,2));
} catch (error) {
  db.close();
  throw error;
}
