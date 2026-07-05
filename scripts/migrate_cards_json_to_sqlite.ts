import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const JSON_PATH = process.env.CARDS_JSON_PATH ?? path.join(DATA_DIR, "cards.json");
const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, "cards.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

type Card = {
  id: string;
  title: string;
  body?: string;
  summary?: string;
  url?: string;
  type?: string;
  color?: string;
  tags?: string[];
  links?: string[];
  kjGroupId?: string;
  archived?: boolean;
  archivedAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

if (!fs.existsSync(JSON_PATH)) {
  console.error("data/cards.json が見つかりません");
  process.exit(1);
}

const cards = JSON.parse(fs.readFileSync(JSON_PATH, "utf-8")) as Card[];

const db = new Database(DB_PATH);

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
`);

const insert = db.prepare(`
INSERT OR REPLACE INTO cards (
  id,
  title,
  body,
  summary,
  url,
  type,
  color,
  tags_json,
  links_json,
  kj_group_id,
  archived,
  archived_at,
  created_at,
  updated_at
)
VALUES (
  @id,
  @title,
  @body,
  @summary,
  @url,
  @type,
  @color,
  @tags_json,
  @links_json,
  @kj_group_id,
  @archived,
  @archived_at,
  @created_at,
  @updated_at
)
`);

const now = new Date().toISOString();
const insertTag = db.prepare(`
INSERT OR IGNORE INTO card_tags (card_id, tag, created_at)
VALUES (?, ?, ?)
`);
const insertLink = db.prepare(`
INSERT OR IGNORE INTO card_links (source_card_id, target_card_id, created_at)
VALUES (?, ?, ?)
`);

const tx = db.transaction(() => {
  for (const card of cards) {
    const createdAt = card.createdAt ?? now;
    insert.run({
      id: card.id,
      title: card.title,
      body: card.body ?? "",
      summary: card.summary ?? null,
      url: card.url ?? null,
      type: card.type ?? "memo",
      color: card.color ?? null,
      tags_json: JSON.stringify(card.tags ?? []),
      links_json: JSON.stringify(card.links ?? []),
      kj_group_id: card.kjGroupId ?? null,
      archived: card.archived ? 1 : 0,
      archived_at: card.archivedAt ?? null,
      created_at: createdAt,
      updated_at: card.updatedAt ?? now,
    });
    for (const tag of [...new Set((card.tags ?? []).map(tag => String(tag).trim()).filter(Boolean))]) {
      insertTag.run(card.id, tag, createdAt);
    }
    for (const linkId of [...new Set((card.links ?? []).map(link => String(link).trim()).filter(Boolean))]) {
      insertLink.run(card.id, linkId, createdAt);
    }
  }
});

tx();

console.log(`${cards.length} 件を cards.db に移行しました`);
