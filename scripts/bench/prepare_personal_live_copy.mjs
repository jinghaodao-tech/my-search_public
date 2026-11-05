import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const sourcePath = path.resolve('data/cards.db');
const personalRoot = fs.realpathSync('quality/e2e/local/personal-refind');
const outputDirectory = path.join(personalRoot, 'live-copy-v1');
const databasePath = path.join(outputDirectory, 'cards.sqlite');
if (fs.existsSync(outputDirectory)) throw Error('Refusing to overwrite an existing live copy');

const fields = ['id', 'title', 'body', 'summary', 'url', 'type', 'color', 'tags_json', 'links_json', 'kj_group_id',
  'archived', 'archived_at', 'tokens_json', 'doc_length', 'morphological_tokens_json', 'ngram_tokens_json',
  'morphological_doc_length', 'ngram_doc_length', 'created_at', 'updated_at'];
const select = `SELECT ${fields.join(',')} FROM cards ORDER BY id`;
const hash = rows => crypto.createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
let expectedCount;
let expectedHash;
try {
  if (source.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('Source database failed integrity_check');
  const rows = source.prepare(select).all();
  expectedCount = rows.length;
  expectedHash = hash(rows);
  if (!expectedCount) throw Error('Refusing to create a live copy of an empty corpus');
  fs.mkdirSync(outputDirectory, { recursive: false });
  await source.backup(databasePath);
} finally { source.close(); }

const copy = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('Live copy failed integrity_check');
  const rows = copy.prepare(select).all();
  if (rows.length !== expectedCount || hash(rows) !== expectedHash) throw Error('Card and memo content changed during backup');
  const tables = new Set(copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cards_fts','cards_morph_fts','cards_ngram_fts')").all().map(row => row.name));
  const fts = { raw: tables.has('cards_fts'), morphological: tables.has('cards_morph_fts'), ngram: tables.has('cards_ngram_fts') };
  if (!fts.raw || !fts.morphological || !fts.ngram) throw Error('The source copy does not contain all prepared saved-card FTS indexes');
  for (const [key, table] of Object.entries({ raw: 'cards_fts', morphological: 'cards_morph_fts', ngram: 'cards_ngram_fts' })) {
    const indexed = Number(copy.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    if (indexed !== expectedCount) throw Error(`The ${key} FTS index is incomplete`);
  }
  fs.writeFileSync(path.join(outputDirectory, 'manifest.json'), JSON.stringify({
    purpose: 'isolated-local-live-search-copy; no production database writes',
    source: 'data/cards.db', database: 'cards.sqlite', createdAt: new Date().toISOString(),
    cardCount: expectedCount, cardAndMemoFieldsSha256: expectedHash, integrityCheck: 'ok',
    preparedFtsIndexes: fts, copiedWith: 'SQLite online backup API', userDataIncluded: true,
    externalTransmission: false,
  }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: 'READY', cardCount: expectedCount, integrityCheck: 'ok',
    preparedFtsIndexes: fts, outputDirectory, sourceContentPreserved: true }));
} finally { copy.close(); }
