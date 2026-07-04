import fs from "fs";
import path from "path";
import { loadCards, loadKJGroups } from "../cards_engine.js";

const outDir = process.env.EXPORT_DIR ?? path.join(process.cwd(), "backups");
const fileName = `cards-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const outPath = path.join(outDir, fileName);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify({ exportedAt: new Date().toISOString(), cards: loadCards(), kjGroups: loadKJGroups() }, null, 2),
  "utf-8",
);

console.log(JSON.stringify({ ok: true, path: outPath }, null, 2));
