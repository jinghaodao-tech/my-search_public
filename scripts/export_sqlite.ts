import fs from "fs";
import path from "path";

const dbPath = process.env.DB_PATH ?? path.join("data", "cards.db");
const outDir = process.env.EXPORT_DIR ?? path.join(process.cwd(), "backups");
const outPath = path.join(outDir, `cards-db-export-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);

if (!fs.existsSync(dbPath)) {
  console.error(JSON.stringify({ ok: false, error: `Database not found: ${dbPath}` }, null, 2));
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(dbPath, outPath);

console.log(JSON.stringify({ ok: true, path: outPath }, null, 2));
