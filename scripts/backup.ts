import fs from "fs";
import path from "path";

const dbPath = process.env.DB_PATH ?? path.join("data", "cards.db");
const backupDir = process.env.BACKUP_DIR ?? path.join(process.cwd(), "backups");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(backupDir, `cards-${timestamp}.db`);

if (!fs.existsSync(dbPath)) {
  console.error(JSON.stringify({ ok: false, error: `Database not found: ${dbPath}` }, null, 2));
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });
fs.copyFileSync(dbPath, backupPath);

const kjPath = path.join(process.cwd(), "data", "kj_groups.json");
if (fs.existsSync(kjPath)) {
  fs.copyFileSync(kjPath, path.join(backupDir, `kj-groups-${timestamp}.json`));
}

console.log(JSON.stringify({ ok: true, path: backupPath }, null, 2));
