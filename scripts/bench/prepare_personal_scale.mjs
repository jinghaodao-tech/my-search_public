import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const root = path.resolve('quality/e2e/local/personal-refind');
const output = path.join(root, 'scale-10000-v2');
if (fs.existsSync(output)) throw Error('Refusing to overwrite a prepared corpus');
fs.mkdirSync(output, { recursive: true });
const destination = path.join(output, 'corpus.sqlite');
const source = new Database('data/cards.db', { readonly: true, fileMustExist: true });
try { await source.backup(destination); } finally { source.close(); }
const db = new Database(destination);
const fields = ['id','title','body','summary','url','type','color','tags_json','links_json','kj_group_id','archived','archived_at',
  'tokens_json','doc_length','morphological_tokens_json','ngram_tokens_json','morphological_doc_length','ngram_doc_length','created_at','updated_at'];
const select = `SELECT ${fields.join(',')} FROM cards ORDER BY id`;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const textHash = row => hash(`${row.title}\n${row.body ?? ''}`.normalize('NFKC').replace(/\s+/gu, ' ').trim());
const personal = db.prepare(select).all();
const originalHash = hash(JSON.stringify(personal));
const ids = new Set(personal.map(row => row.id));
const content = new Set(personal.map(textHash));
const originalDuplicateContentCount = ids.size - content.size;
const sources = [];
const insert = db.prepare(`INSERT INTO cards (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`);
try {
  for (const file of ['data/movies-dev-bm25-vs-rrf-20261022.sqlite', 'data/tomt-books-e5-dev-100.sqlite']) {
    const publicDb = new Database(file, { readonly: true, fileMustExist: true });
    let added = 0, duplicates = 0;
    try {
      db.transaction(() => {
        for (const row of publicDb.prepare(select).iterate()) {
          if (ids.size >= 10000) break;
          const fingerprint = textHash(row);
          if (ids.has(row.id) || content.has(fingerprint)) { duplicates++; continue; }
          insert.run(...fields.map(field => row[field]));
          ids.add(row.id); content.add(fingerprint); added++;
        }
      })();
    } finally { publicDb.close(); }
    sources.push({ file, added, duplicates });
    console.log(JSON.stringify({ phase: 'import', added, total: ids.size }));
  }
  if (ids.size !== 10000) throw Error(`Only ${ids.size} distinct documents available`);
  const preserved = personal.map(row => db.prepare(`${select.replace(' ORDER BY id', '')} WHERE id=?`).get(row.id));
  if (hash(JSON.stringify(preserved)) !== originalHash) throw Error('Personal content changed in copy');
  if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('Integrity check failed');
  const corpusHash = crypto.createHash('sha256');
  for (const row of db.prepare(select).iterate()) corpusHash.update(JSON.stringify(row)).update('\n');
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ purpose: 'performance-only corpus; not final quality evidence',
    documents: ids.size, personalDocuments: personal.length, originalDuplicateContentCount, sources,
    deduplication: 'Preserve original personal cards including genuine duplicates; added public documents are unique by NFKC and whitespace-normalized title+body SHA-256; no synthetic replication',
    personalContentPreserved: true, corpusSha256: corpusHash.digest('hex'), createdAt: new Date().toISOString() }, null, 2));
  // Public development questions only: keep the untouched human final set out of profiling.
  const queries = [];
  for (const dataset of ['books', 'movies']) {
    const rows = fs.readFileSync(`quality/e2e/data/reddit_tomt/${dataset}/development.jsonl`, 'utf8').split(/\r?\n/u).filter(Boolean).map(JSON.parse);
    rows.sort((a, b) => hash(a.id).localeCompare(hash(b.id)));
    queries.push(...rows.slice(0, 10).map(row => ({ id: row.id, query: row.query, origin: 'public-development-diagnostic' })));
  }
  fs.writeFileSync(path.join(output, 'diagnostic-queries.json'), JSON.stringify(queries, null, 2));
  console.log(JSON.stringify({ output, documents: ids.size, personalDocuments: personal.length, status: 'PREPARED_DIAGNOSTIC_ONLY' }));
} finally { db.close(); }
