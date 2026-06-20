import fs from "fs";
import Database from "better-sqlite3";

fs.mkdirSync("data", { recursive: true });

const DB_PATH = process.env.DB_PATH ?? "data/cards.db";
console.log("DB_PATH =", DB_PATH);
export const db = new Database(DB_PATH);

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

CREATE INDEX IF NOT EXISTS idx_cards_title ON cards(title);
CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(type);
CREATE INDEX IF NOT EXISTS idx_cards_created_at ON cards(created_at);
`);