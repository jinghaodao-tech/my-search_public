import fs from "fs";
import path from "path";

const sourcePath = process.argv[2];
const dbPath = process.env.DB_PATH ?? path.join("data", "cards.db");

if (!sourcePath) {
  console.error(JSON.stringify({ ok: false, error: "Usage: npm run restore -- <backup-db-path>" }, null, 2));
  process.exit(1);
}

if (!fs.existsSync(sourcePath)) {
  console.error(JSON.stringify({ ok: false, error: `Backup not found: ${sourcePath}` }, null, 2));
  process.exit(1);
}

const dbDir = path.dirname(dbPath);
if (dbDir && dbDir !== ".") {
  fs.mkdirSync(dbDir, { recursive: true });
}

for (const suffix of ["", "-wal", "-shm"]) {
  const target = `${dbPath}${suffix}`;
  if (fs.existsSync(target)) {
    fs.copyFileSync(target, `${target}.before-restore-${Date.now()}`);
  }
}

fs.copyFileSync(sourcePath, dbPath);

console.log(JSON.stringify({ ok: true, restoredFrom: sourcePath, restoredTo: dbPath }, null, 2));
