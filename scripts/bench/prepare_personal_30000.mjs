import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const baseDirectory = path.resolve('quality/e2e/local/personal-refind/scale-10000-v2');
const baseManifest = JSON.parse(fs.readFileSync(path.join(baseDirectory, 'manifest.json'), 'utf8'));
if (baseManifest.documents !== 10000) throw Error('The required 10,000-document base corpus is not ready');
const output = path.resolve('quality/e2e/local/personal-refind/scale-30000-v2');
if (fs.existsSync(output)) throw Error('Refusing to overwrite a prepared corpus');
fs.mkdirSync(output, { recursive: true });
const destination = path.join(output, 'corpus.sqlite');
const baseDb = new Database(path.join(baseDirectory, 'corpus.sqlite'), { readonly: true, fileMustExist: true });
try { await baseDb.backup(destination); } finally { baseDb.close(); }

const db = new Database(destination);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const contentHash = row => hash(`${row.title}\n${row.body ?? ''}`.normalize('NFKC').replace(/\s+/gu, ' ').trim());
const cardFields = ['id','title','body','summary','url','type','color','tags_json','links_json','kj_group_id','archived','archived_at',
  'tokens_json','doc_length','created_at','updated_at','morphological_tokens_json','ngram_tokens_json','morphological_doc_length','ngram_doc_length'];
const cardSelect = `SELECT ${cardFields.join(',')} FROM cards ORDER BY id`;
const baseCards = db.prepare(cardSelect).all();
const baseHash = hash(JSON.stringify(baseCards));
const ids = new Set(baseCards.map(row => row.id));
const content = new Set(baseCards.map(contentHash));
const insert = db.prepare(`INSERT INTO cards (${cardFields.join(',')}) VALUES (${cardFields.map(() => '?').join(',')})`);
const source = new Database('data/bench/miracl-ja.db', { readonly: true, fileMustExist: true });
const articleFields = ['id','title','body','url','summary','tags_json','tokens_json','doc_length','morphological_tokens_json','ngram_tokens_json','morphological_doc_length','ngram_doc_length','created_at','updated_at','published_at'];
const articles = source.prepare(`SELECT ${articleFields.join(',')} FROM articles ORDER BY id`).iterate();
let added = 0;
let duplicateId = 0;
let duplicateText = 0;
try {
  db.transaction(() => {
    for (const row of articles) {
      if (ids.size >= 30000) break;
      if (ids.has(`perf-miracl-${row.id}`)) { duplicateId++; continue; }
      const fingerprint = contentHash(row);
      if (content.has(fingerprint)) { duplicateText++; continue; }
      const createdAt = row.created_at ?? row.updated_at ?? row.published_at ?? '2000-01-01T00:00:00.000Z';
      const values = {
        id: `perf-miracl-${row.id}`, title: row.title ?? '', body: row.body ?? '', summary: row.summary ?? null,
        url: row.url ?? '', type: 'bookmark', color: null, tags_json: row.tags_json ?? '[]', links_json: '[]',
        kj_group_id: null, archived: 0, archived_at: null, tokens_json: row.tokens_json ?? '[]', doc_length: row.doc_length ?? 0,
        created_at: createdAt, updated_at: row.updated_at ?? createdAt,
        morphological_tokens_json: row.morphological_tokens_json ?? row.tokens_json ?? '[]',
        ngram_tokens_json: row.ngram_tokens_json ?? row.tokens_json ?? '[]',
        morphological_doc_length: row.morphological_doc_length ?? 0, ngram_doc_length: row.ngram_doc_length ?? row.doc_length ?? 0,
      };
      insert.run(...cardFields.map(field => values[field]));
      ids.add(values.id);
      content.add(fingerprint);
      added++;
    }
  })();
} finally { source.close(); }

if (ids.size !== 30000) throw Error(`Only ${ids.size} unique cards are available; refusing to pad the corpus`);
const preserved = baseCards.map(row => db.prepare(`${cardSelect.replace(' ORDER BY id', '')} WHERE id=?`).get(row.id));
if (hash(JSON.stringify(preserved)) !== baseHash) throw Error('The 10,000-document base corpus changed in the isolated copy');
if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('SQLite integrity check failed');
const ftsCounts = Object.fromEntries(['cards_fts','cards_morph_fts','cards_ngram_fts'].map(table => [table,
  Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
if (Object.values(ftsCounts).some(count => count !== 30000)) throw Error(`Saved-card FTS indexes are not synchronized: ${JSON.stringify(ftsCounts)}`);
const corpusHasher = crypto.createHash('sha256');
for (const row of db.prepare(cardSelect).iterate()) corpusHasher.update(JSON.stringify(row)).update('\n');
const corpusSha256 = corpusHasher.digest('hex');
db.close();

const querySource = path.resolve('quality/e2e/local/personal-refind/scale-10000-v2/diagnostic-queries.json');
const queries = JSON.parse(fs.readFileSync(querySource, 'utf8'));
if (queries.length !== 20 || queries.some(query => query.origin !== 'public-development-diagnostic')) throw Error('Unexpected performance query set');
fs.writeFileSync(path.join(output, 'diagnostic-queries.json'), JSON.stringify(queries, null, 2));
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({
  purpose: '30,000-document scalability diagnostic only; not personal quality evidence',
  documents: 30000,
  baseCorpus: 'scale-10000-v2',
  baseDocuments: baseCards.length,
  baseCorpusSha256: baseManifest.corpusSha256,
  publicSource: 'MIRACL Japanese article corpus, data/bench/miracl-ja.db',
  publicDocumentsAdded: added,
  duplicateIdsSkipped: duplicateId,
  duplicateNormalizedTitleBodySkipped: duplicateText,
  deduplication: 'Preserve all documents in the 10,000-document base corpus including genuine duplicates; added public articles are deduplicated against the base by NFKC and whitespace-normalized title+body SHA-256; no synthetic replication',
  ftsIndexCounts: ftsCounts,
  baseCorpusPreserved: true,
  corpusSha256,
  sourceCorpusDocuments: 29937,
  createdAt: new Date().toISOString(),
}, null, 2));
console.log(JSON.stringify({ output, documents: ids.size, baseDocuments: baseCards.length, publicDocumentsAdded: added,
  duplicateNormalizedTitleBodySkipped: duplicateText, ftsIndexCounts: ftsCounts, status: 'PREPARED_DIAGNOSTIC_ONLY' }));
