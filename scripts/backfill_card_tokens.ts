import { db } from "../db/database.js";
import { tokenize } from "../bm25_engine.js";

type CardRow = {
  id: string;
  title: string;
  body: string;
  tags_json: string;
};

const rows = db.prepare(`
  SELECT id, title, body, tags_json
  FROM cards
`).all() as CardRow[];

const update = db.prepare(`
  UPDATE cards
  SET tokens_json = @tokens_json,
      doc_length = @doc_length
  WHERE id = @id
`);

const updates: Array<{ id: string; tokens_json: string; doc_length: number }> = [];

for (const row of rows) {
  const tags = JSON.parse(row.tags_json ?? "[]") as string[];
  const tokens = await tokenize(`${row.title} ${row.body} ${tags.join(" ")}`);
  updates.push({
    id: row.id,
    tokens_json: JSON.stringify(tokens),
    doc_length: tokens.length,
  });
}

db.transaction(() => {
  for (const item of updates) update.run(item);
})();

console.log(`backfilled card tokens: ${updates.length}`);
