import { db } from "../db/database.js";
import { tokenize } from "../bm25_engine.js";

type CardRow = {
  id: string;
  title: string;
  body: string;
  tags_json: string;
};

const args = process.argv.slice(2);
const readOption = (name: string, fallback: number) => { const index = args.indexOf(name); const value = index >= 0 ? Number(args[index + 1]) : fallback; return Number.isInteger(value) && value > 0 ? value : fallback; };
const batchSize = readOption("--batch-size", 500);
const afterId = args.includes("--after-id") ? String(args[args.indexOf("--after-id") + 1] ?? "") : "";

const update = db.prepare(`
  UPDATE cards
  SET tokens_json = @tokens_json,
      doc_length = @doc_length
  WHERE id = @id
`);

let cursor = afterId;
let processed = 0;
while (true) {
  const rows = db.prepare(`SELECT id, title, body, tags_json FROM cards WHERE id > ? ORDER BY id LIMIT ?`).all(cursor, batchSize) as CardRow[];
  if (!rows.length) break;
  const updates: Array<{ id: string; tokens_json: string; doc_length: number }> = [];
  for (const row of rows) {
    const tags = JSON.parse(row.tags_json ?? "[]") as string[];
    const tokens = await tokenize(`${row.title} ${row.body} ${tags.join(" ")}`);
    updates.push({ id: row.id, tokens_json: JSON.stringify(tokens), doc_length: tokens.length });
  }
  db.transaction(() => { for (const item of updates) update.run(item); })();
  processed += updates.length;
  cursor = rows.at(-1)!.id;
  console.log(JSON.stringify({ processed, lastId: cursor, batchSize }));
}
console.log(JSON.stringify({ ok: true, backfilled: processed, lastId: cursor, batchSize }));
