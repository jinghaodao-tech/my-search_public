import Database from "better-sqlite3";

const dbPath = process.env.DB_PATH ?? "data/cards.db";
const db = new Database(dbPath, { readonly: true });
const count = (sql: string) => Number((db.prepare(sql).get() as { count: number }).count);
const errors: string[] = [];
try {
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  if (integrity.integrity_check !== "ok") errors.push(`integrity_check:${integrity.integrity_check}`);
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
  if (foreignKeys.length) errors.push(`foreign_key_check:${foreignKeys.length}`);
  const cards = count("SELECT COUNT(*) AS count FROM cards");
  const fts = count("SELECT COUNT(*) AS count FROM cards_fts");
  const orphanFts = count("SELECT COUNT(*) AS count FROM cards_fts f LEFT JOIN cards c ON c.id=f.id WHERE c.id IS NULL");
  const missingFts = count("SELECT COUNT(*) AS count FROM cards c LEFT JOIN cards_fts f ON f.id=c.id WHERE f.id IS NULL");
  const missingTokens = count("SELECT COUNT(*) AS count FROM cards WHERE tokens_json IS NULL OR tokens_json='[]' OR doc_length=0");
  const result = { ok: errors.length === 0, dbPath, cards, fts, orphanFts, missingFts, missingTokens, errors };
  if (orphanFts || missingFts) errors.push("cards_fts_out_of_sync");
  if (errors.length) { result.ok = false; result.errors = errors; console.error(JSON.stringify(result, null, 2)); process.exitCode = 1; }
  else console.log(JSON.stringify(result, null, 2));
} finally { db.close(); }
