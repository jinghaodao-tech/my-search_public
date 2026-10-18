import { db } from "../db/database.js";
import { runMigrations } from "../db/migrate.js";

const applied = runMigrations(db);
const siteArticleRepairs = db.prepare('SELECT reason, COUNT(*) AS count FROM site_article_repairs GROUP BY reason ORDER BY reason').all();

if (applied.length) {
  console.log(JSON.stringify({ ok: true, applied, siteArticleRepairs }, null, 2));
} else {
  console.log(JSON.stringify({ ok: true, applied: [], siteArticleRepairs, message: "Database is up to date" }, null, 2));
}
db.close();
