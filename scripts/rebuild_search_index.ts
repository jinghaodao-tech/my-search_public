import Database from "better-sqlite3";

const dbPath = process.env.DB_PATH ?? "data/cards.db";
const db = new Database(dbPath);
try {
  let indexed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM cards_fts");
    db.exec("INSERT INTO cards_fts (id,title,body,summary,tags) SELECT c.id,c.title,c.body,COALESCE(c.summary,''),COALESCE((SELECT group_concat(tag,' ') FROM card_tags t WHERE t.card_id=c.id),'') FROM cards c");
    indexed = Number((db.prepare("SELECT COUNT(*) AS count FROM cards_fts").get() as { count: number }).count);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(JSON.stringify({ ok: true, dbPath, source: "cards", indexed }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, dbPath, error: message, hint: "Stop writers and retry with exclusive access to the SQLite database." }, null, 2));
  process.exitCode = 1;
} finally { db.close(); }
