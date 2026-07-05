import fs from "fs";
import path from "path";
import { db } from "../db/database.js";

type LegacyKJGroup = {
  id: string;
  name: string;
  color?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
};

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const jsonPath = process.env.KJ_GROUPS_JSON_PATH ?? path.join(dataDir, "kj_groups.json");

if (!fs.existsSync(jsonPath)) {
  console.log(`No KJ group JSON found at ${jsonPath}`);
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as LegacyKJGroup[];
const groups = Array.isArray(raw) ? raw : [];
const now = new Date().toISOString();

const insert = db.prepare(`
  INSERT OR REPLACE INTO kj_groups (
    id,
    name,
    color,
    description,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?)
`);

const tx = db.transaction(() => {
  for (const group of groups) {
    if (!group.id || !group.name) continue;
    insert.run(
      group.id,
      group.name,
      group.color ?? null,
      group.description ?? null,
      group.createdAt ?? now,
      group.updatedAt ?? group.createdAt ?? now,
    );
  }
});

tx();

console.log(`Migrated ${groups.length} KJ groups into SQLite`);
