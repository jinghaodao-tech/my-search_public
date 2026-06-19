import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DATA_DIR = path.join(process.cwd(), "data");
const JSON_PATH = path.join(DATA_DIR, "cards.json");
const DB_PATH = path.join(DATA_DIR, "cards.db");

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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
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

const tx = db.transaction(() => {
  for (const card of cards) {
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
      created_at: card.createdAt ?? now,
      updated_at: card.updatedAt ?? now,
    });
  }
});

tx();

console.log(`${cards.length} 件を cards.db に移行しました`);