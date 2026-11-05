import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';
import Database from 'better-sqlite3';
import { tokenizeMorphological, tokenizerName } from '../../bm25_engine.js';

type Question = { qid: string; question: string; answer_entity: string | string[] };
type Document = { title: string; text: string };
const dataDir = path.resolve(process.argv[2] ?? 'quality/e2e/local/jaqket-public');
const corpusPath = path.join(dataDir, 'candidate_entities.json.gz');
const databasePath = path.join(dataDir, 'corpus.sqlite');
const manifestPath = path.join(dataDir, 'index-provenance.json');
const questionPaths = ['dev1_questions.json', 'dev2_questions.json'].map(name => path.join(dataDir, name));
if (![corpusPath, ...questionPaths].every(file => fs.existsSync(file))) throw new Error('JAQKET corpus and both public dev question files are required.');
if (fs.existsSync(databasePath) || fs.existsSync(manifestPath)) throw new Error('Refusing to overwrite an existing JAQKET index or provenance file.');

const digestFile = async (file: string, algorithm = 'sha256') => {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const norm = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ja-JP');
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

const questionFiles = await Promise.all(questionPaths.map(async file => ({
  name: path.basename(file), sha256: await digestFile(file),
  rows: fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Question),
})));
for (const file of questionFiles) {
  if (!file.rows.length || new Set(file.rows.map(row => row.qid)).size !== file.rows.length
    || file.rows.some(row => !row.qid || !row.question || !row.answer_entity)) {
    throw new Error(`Invalid or duplicate JAQKET questions in ${file.name}.`);
  }
}
const goldTitles = [...new Set(questionFiles.flatMap(file => file.rows.flatMap(row => Array.isArray(row.answer_entity) ? row.answer_entity : [row.answer_entity])).map(norm))];
const goldTitleSet = new Set(goldTitles);
const corpusSha256 = await digestFile(corpusPath);
const database = new Database(databasePath);
let documentCount = 0;
let tokenCount = 0;
let batch: Array<{ id: string; title: string; body: string; tokens: string }> = [];
const seenTitles = new Map<string, string>();
let sourceRows = 0;
let duplicateRowsSkipped = 0;
let duplicateGoldRows = 0;
let duplicateRowsWithDifferentBody = 0;
try {
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.exec('CREATE TABLE articles(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL) WITHOUT ROWID; CREATE VIRTUAL TABLE articles_morph_fts USING fts5(id UNINDEXED,tokens);');
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
    sourceRows++;
    if (!document.title || typeof document.text !== 'string') throw new Error(`Invalid candidate entity at row ${documentCount + 1}.`);
    const id = norm(document.title);
    if (!id) throw new Error(`Missing candidate title at source row ${sourceRows}.`);
    const bodyHash = crypto.createHash('sha256').update(document.text).digest('hex');
    const firstBodyHash = seenTitles.get(id);
    if (firstBodyHash !== undefined) {
      duplicateRowsSkipped++;
      if (goldTitleSet.has(id)) duplicateGoldRows++;
      if (firstBodyHash !== bodyHash) duplicateRowsWithDifferentBody++;
      continue;
    }
    seenTitles.set(id, bodyHash);
    const tokens = (await tokenizeMorphological(`${document.title} ${document.text}`.normalize('NFKC'))).join(' ');
    batch.push({ id, title: document.title, body: document.text, tokens });
    if (batch.length >= 100) {
      insertBatch(batch);
      batch = [];
      if (documentCount % 10_000 === 0) console.log(JSON.stringify({ phase: 'index', completedDocuments: documentCount, rssBytes: process.memoryUsage().rss }));
    }
  }
  if (batch.length) insertBatch(batch);
  const missingGoldCount = goldTitles.filter(title => !seenTitles.has(title)).length;
  if (missingGoldCount) throw new Error(`${missingGoldCount} JAQKET gold article titles are missing from candidate_entities.`);
  const integrity = database.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${String(integrity)}`);
  database.pragma('wal_checkpoint(TRUNCATE)');
  const manifest = {
    dataset: 'JAQKET Japanese quiz QA retrieval proxy; candidate_entities public development corpus',
    source: 'https://www.nlp.ecei.tohoku.ac.jp/projects/jaqket/',
    corpusFile: path.basename(corpusPath), corpusBytes: fs.statSync(corpusPath).size, corpusSha256,
    sourceRows, documents: documentCount, uniqueNormalizedTitles: seenTitles.size,
    duplicateRowsSkipped, duplicateGoldRows, duplicateRowsWithDifferentBody, morphologyTokens: tokenCount,
    tokenizer: `my-search tokenizeMorphological (${tokenizerName()}) after NFKC(title + space + text)`,
    questionFiles: questionFiles.map(({ name, sha256, rows }) => ({ name, sha256, queries: rows.length, uniqueTargets: new Set(rows.flatMap(row => Array.isArray(row.answer_entity) ? row.answer_entity : [row.answer_entity]).map(norm)).size })),
    uniqueGoldTitles: goldTitles.length, allGoldTitlesCovered: true, integrityCheck: integrity,
    searchIndex: 'isolated SQLite FTS5; not connected to application DB; source data remains in ignored local directory',
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ phase: 'complete', databasePath, manifest, databaseBytes: fs.statSync(databasePath).size, rssBytes: process.memoryUsage().rss }, null, 2));
} finally {
  database.close();
}
