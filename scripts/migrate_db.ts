import { db } from "../db/database.js";
import { runMigrations } from "../db/migrate.js";

const applied = runMigrations(db);

if (applied.length) {
  console.log(JSON.stringify({ ok: true, applied }, null, 2));
} else {
  console.log(JSON.stringify({ ok: true, applied: [], message: "Database is up to date" }, null, 2));
}
