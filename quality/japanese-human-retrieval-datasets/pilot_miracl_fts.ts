import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';

const [databasePath, limitText, corpusDirectory] = process.argv.slice(2);
if (!databasePath || !limitText || !corpusDirectory) {
  throw new Error('Usage: pilot_miracl_fts.ts <isolated.sqlite> <document-limit> <miracl-corpus-dir>');
}
const limit = Number.parseInt(limitText, 10);
if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('document-limit must be a positive integer');
process.env.DB_PATH = path.resolve(databasePath);
const { db } = await import('../../db/database.js');
const { buildStoredTokenSet } = await import('../../bm25_engine.js');
const shard = path.join(path.resolve(corpusDirectory), 'docs-0.jsonl.gz');
const started = performance.now();
const now = '2020-01-01T00:00:00.000Z';
const insertArticle = db.prepare(`INSERT INTO articles (
  id,title,body,url,source,source_authority,published_at,summary,tags_json,tokens_json,doc_length,
  morphological_tokens_json,ngram_tokens_json,morphological_doc_length,ngram_doc_length,content_hash,
  created_at,first_seen_at,updated_at,last_fetched_at,body_kind,source_updated_at,normalized_url
) VALUES (
  @id,@title,@body,@url,'miracl-ja',0.5,NULL,NULL,'[]',@tokens,@docLength,
  @morphologicalTokens,@ngramTokens,@morphologicalDocLength,@ngramDocLength,@contentHash,
  @now,@now,@now,@now,'fulltext',NULL,@url
)`);
const insertSource = db.prepare(`INSERT INTO article_sources(article_id,source,first_seen_at,last_seen_at)
  VALUES (?,'miracl-ja',?,?)`);
const insertBatch = db.transaction((rows: Array<{id:string;title:string;body:string;url:string;tokens:string;morphologicalTokens:string;ngramTokens:string;docLength:number;morphologicalDocLength:number;ngramDocLength:number;contentHash:string}>) => {
  for (const row of rows) {
    insertArticle.run({...row, now});
    insertSource.run(row.id, now, now);
  }
});

let batch: Array<{id:string;title:string;body:string;url:string;tokens:string;morphologicalTokens:string;ngramTokens:string;docLength:number;morphologicalDocLength:number;ngramDocLength:number;contentHash:string}> = [];
let count = 0;
let inputBytes = 0;
const input = createReadStream(shard).pipe(createGunzip());
const lines = readline.createInterface({input, crlfDelay: Infinity});

try {
  for await (const line of lines) {
    if (!line) continue;
    const source = JSON.parse(line) as {docid:string;title:string;text:string};
    const title = source.title ?? '';
    const body = source.text ?? '';
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
    inputBytes += Buffer.byteLength(line, 'utf8') + 1;
    count += 1;
    if (batch.length >= 250) {
      insertBatch(batch);
      batch = [];
    }
    if (count % 1000 === 0) {
      console.log(JSON.stringify({count,elapsedSeconds:Math.round((performance.now()-started)/1000),rssBytes:process.memoryUsage().rss}));
    }
    if (count >= limit) break;
  }
  if (batch.length) insertBatch(batch);
} finally {
  lines.close();
  input.destroy();
}

const articles = Number((db.prepare('SELECT COUNT(*) AS n FROM articles').get() as {n:number}).n);
const morphRows = Number((db.prepare('SELECT COUNT(*) AS n FROM articles_morph_fts').get() as {n:number}).n);
const ngramRows = Number((db.prepare('SELECT COUNT(*) AS n FROM articles_ngram_fts').get() as {n:number}).n);
const result = {databasePath:path.resolve(databasePath),shard,count,articles,morphRows,ngramRows,inputBytes,
  elapsedSeconds:(performance.now()-started)/1000,documentsPerSecond:count/((performance.now()-started)/1000),
  rssBytes:process.memoryUsage().rss,heapUsedBytes:process.memoryUsage().heapUsed,
  ftsComplete:articles===count&&morphRows===count&&ngramRows===count};
fs.writeFileSync(path.resolve(databasePath+'.pilot.json'),`${JSON.stringify(result,null,2)}\n`,'utf8');
console.log(JSON.stringify(result,null,2));
db.close();
if (!result.ftsComplete) process.exitCode=1;
