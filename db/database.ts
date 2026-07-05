import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrate.js";

const dbPath = process.env.DB_PATH ?? "data/cards.db";
const dbDir = path.dirname(dbPath);

if (dbDir && dbDir !== ".") {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  type TEXT NOT NULL DEFAULT 'memo',
  color TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  links_json TEXT NOT NULL DEFAULT '[]',
  kj_group_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  tokens_json TEXT NOT NULL DEFAULT '[]',
  doc_length INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_title ON cards(title);
CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(type);
CREATE INDEX IF NOT EXISTS idx_cards_created_at ON cards(created_at);
CREATE INDEX IF NOT EXISTS idx_cards_kj_group_id ON cards(kj_group_id);

CREATE TABLE IF NOT EXISTS card_tags (
  card_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (card_id, tag),
  FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_card_tags_tag ON card_tags(tag);
CREATE INDEX IF NOT EXISTS idx_card_tags_card_id ON card_tags(card_id);

CREATE TABLE IF NOT EXISTS card_links (
  source_card_id TEXT NOT NULL,
  target_card_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_card_id, target_card_id),
  FOREIGN KEY (source_card_id) REFERENCES cards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_card_links_source ON card_links(source_card_id);
CREATE INDEX IF NOT EXISTS idx_card_links_target ON card_links(target_card_id);

CREATE TABLE IF NOT EXISTS kj_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kj_groups_created_at ON kj_groups(created_at);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT,
  source_authority REAL NOT NULL DEFAULT 0,
  published_at TEXT,
  summary TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  tokens_json TEXT,
  doc_length INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_fetched_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_url_unique ON articles(url);
CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at);
CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source);
CREATE INDEX IF NOT EXISTS idx_articles_doc_length ON articles(doc_length);
CREATE INDEX IF NOT EXISTS idx_articles_content_hash ON articles(content_hash);
`);

const cardColumns = db.prepare(`PRAGMA table_info(cards)`).all() as Array<{ name: string }>;
const cardColumnNames = new Set(cardColumns.map((column) => column.name));

if (!cardColumnNames.has("tokens_json")) {
  db.exec(`ALTER TABLE cards ADD COLUMN tokens_json TEXT NOT NULL DEFAULT '[]'`);
}

if (!cardColumnNames.has("doc_length")) {
  db.exec(`ALTER TABLE cards ADD COLUMN doc_length INTEGER NOT NULL DEFAULT 0`);
}

runMigrations(db);

db.exec(`
INSERT OR IGNORE INTO card_tags (card_id, tag, created_at)
SELECT cards.id, json_each.value, cards.created_at
FROM cards, json_each(COALESCE(cards.tags_json, '[]'))
WHERE json_each.value IS NOT NULL AND TRIM(json_each.value) <> '';

INSERT OR IGNORE INTO card_links (source_card_id, target_card_id, created_at)
SELECT cards.id, json_each.value, cards.created_at
FROM cards, json_each(COALESCE(cards.links_json, '[]'))
WHERE json_each.value IS NOT NULL AND TRIM(json_each.value) <> '';
`);
