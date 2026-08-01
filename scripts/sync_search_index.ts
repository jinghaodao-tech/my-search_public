import Database from "better-sqlite3";

const dbPath = process.env.DB_PATH ?? "data/cards.db";
const db = new Database(dbPath);
try {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM cards_fts WHERE id NOT IN (SELECT id FROM cards) OR id IN (SELECT f.id FROM cards_fts f JOIN cards c ON c.id=f.id WHERE f.title<>c.title OR f.body<>c.body OR COALESCE(f.summary,'')<>COALESCE(c.summary,'') OR f.tags<>COALESCE((SELECT group_concat(tag,' ') FROM card_tags t WHERE t.card_id=c.id),''))");
    db.exec("INSERT INTO cards_fts (id,title,body,summary,tags) SELECT c.id,c.title,c.body,COALESCE(c.summary,''),COALESCE((SELECT group_concat(tag,' ') FROM card_tags t WHERE t.card_id=c.id),'') FROM cards c LEFT JOIN cards_fts f ON f.id=c.id WHERE f.id IS NULL");
    const indexed = Number((db.prepare("SELECT COUNT(*) AS count FROM cards_fts").get() as { count: number }).count);
    db.exec("COMMIT");
    console.log(JSON.stringify({ ok: true, dbPath, mode: "incremental", indexed }, null, 2));
  } catch (error) { db.exec("ROLLBACK"); throw error; }
} finally { db.close(); }
