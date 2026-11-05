import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fingerprintSavedCardCorpus, fingerprintSavedCardFtsIndexes } from '../scripts/bench/personal_refind_freeze_io.mjs';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE cards (
    id TEXT PRIMARY KEY,title TEXT,body TEXT,summary TEXT,url TEXT,type TEXT,color TEXT,tags_json TEXT,links_json TEXT,
    kj_group_id TEXT,archived INTEGER,archived_at TEXT,tokens_json TEXT,doc_length INTEGER,morphological_tokens_json TEXT,
    ngram_tokens_json TEXT,morphological_doc_length INTEGER,ngram_doc_length INTEGER,created_at TEXT,updated_at TEXT
  );
  CREATE TABLE card_tags(card_id TEXT,tag TEXT,created_at TEXT);
  CREATE TABLE card_links(source_card_id TEXT,target_card_id TEXT,created_at TEXT);
  CREATE TABLE cards_fts(id TEXT,title TEXT,body TEXT,summary TEXT,tags TEXT);
  CREATE TABLE cards_morph_fts(id TEXT,tokens TEXT);
  CREATE TABLE cards_ngram_fts(id TEXT,tokens TEXT);`);
  db.prepare(`INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'card-1', 'Title', 'Body', '', 'https://example.test', 'article', null, '["tag"]', '[]', null, 0, null,
    '["body"]', 1, '["body"]', '["bo"]', 1, 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO card_tags VALUES (?,?,?)').run('card-1', 'tag', '2025-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO cards_fts VALUES (?,?,?,?,?)').run('card-1', 'Title', 'Body', '', 'tag');
  db.prepare('INSERT INTO cards_morph_fts VALUES (?,?)').run('card-1', 'body');
  db.prepare('INSERT INTO cards_ngram_fts VALUES (?,?)').run('card-1', 'bo');
  return db;
}

test('fingerprints saved-card fields, token caches, relationships and FTS contents', () => {
  const db = fixture();
  try {
    const first = fingerprintSavedCardCorpus(db);
    const ftsFirst = fingerprintSavedCardFtsIndexes(db);
    assert.equal(first.count, 1);
    assert.deepEqual([...first.articleIds], ['card-1']);
    assert.equal(first.createdAtById.get('card-1'), '2025-01-01T00:00:00.000Z');
    assert.equal(ftsFirst.cards_morph_fts.count, 1);

    db.prepare('UPDATE cards SET morphological_tokens_json=? WHERE id=?').run('["changed"]', 'card-1');
    assert.notEqual(fingerprintSavedCardCorpus(db).sha256, first.sha256);
    db.prepare('UPDATE cards_morph_fts SET tokens=? WHERE id=?').run('changed', 'card-1');
    assert.notEqual(fingerprintSavedCardFtsIndexes(db).cards_morph_fts.sha256, ftsFirst.cards_morph_fts.sha256);
    db.prepare('INSERT INTO card_links VALUES (?,?,?)').run('card-1', 'another-card', '2025-01-02T00:00:00.000Z');
    assert.notEqual(fingerprintSavedCardCorpus(db).sha256, first.sha256);
  } finally { db.close(); }
});
