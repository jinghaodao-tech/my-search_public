import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const targetPath = process.env.DB_PATH ?? path.join(process.cwd(), "data", "cards.db");
const sourcePath = process.env.LEGACY_DB_PATH ?? path.join(process.cwd(), "..", "my-search-app", "data", "cards.db");

if (!fs.existsSync(targetPath)) throw new Error(`Target database not found: ${targetPath}`);
if (!fs.existsSync(sourcePath)) throw new Error(`Legacy database not found: ${sourcePath}`);
if (path.resolve(targetPath) === path.resolve(sourcePath)) throw new Error("Target and legacy databases must differ");

const db = new Database(targetPath);
const sourceSqlPath = sourcePath.replace(/'/g, "''");
db.exec(`ATTACH DATABASE '${sourceSqlPath}' AS legacy`);

const result = db.transaction(() => {
  const oldCards = db.prepare("SELECT * FROM legacy.cards").all() as Array<Record<string, unknown>>;
  const insertCard = db.prepare(`
    INSERT INTO cards (
      id, title, body, summary, url, type, color, tags_json, links_json,
      kj_group_id, archived, archived_at, tokens_json, doc_length,
      created_at, updated_at, morphological_tokens_json, ngram_tokens_json,
      morphological_doc_length, ngram_doc_length
    ) VALUES (
      @id, @title, @body, @summary, @url, @type, @color, @tags_json, @links_json,
      NULL, @archived, @archived_at, @tokens_json, @doc_length,
      @created_at, @updated_at, '[]', @tokens_json, 0, @doc_length
    )
  `);
  const findById = db.prepare("SELECT id FROM cards WHERE id = ?");
  const findByUrl = db.prepare("SELECT id FROM cards WHERE url = ? AND url IS NOT NULL AND url <> ''");
  const insertTag = db.prepare("INSERT OR IGNORE INTO card_tags (card_id, tag, created_at) VALUES (?, ?, ?)");
  const insertLink = db.prepare("INSERT OR IGNORE INTO card_links (source_card_id, target_card_id, created_at) VALUES (?, ?, ?)");
  const findCard = db.prepare("SELECT id FROM cards WHERE id = ?");
  let insertedCards = 0;
  let skippedCards = 0;
  let importedTags = 0;
  let importedLinks = 0;

  for (const card of oldCards) {
    const id = String(card.id ?? "");
    const url = card.url ? String(card.url) : null;
    if (!id || findById.get(id) || (url && findByUrl.get(url))) {
      skippedCards++;
      continue;
    }
    insertCard.run({
      id,
      title: String(card.title ?? ""),
      body: String(card.body ?? ""),
      summary: card.summary ?? null,
      url,
      type: String(card.type ?? "memo"),
      color: card.color ?? null,
      tags_json: String(card.tags_json ?? "[]"),
      links_json: String(card.links_json ?? "[]"),
      archived: Number(card.archived ?? 0),
      archived_at: card.archived_at ?? null,
      tokens_json: String(card.tokens_json ?? "[]"),
      doc_length: Number(card.doc_length ?? 0),
      created_at: String(card.created_at ?? new Date().toISOString()),
      updated_at: String(card.updated_at ?? card.created_at ?? new Date().toISOString()),
    });
    insertedCards++;
  }

  for (const card of oldCards) {
    const id = String(card.id ?? "");
    if (!findCard.get(id)) continue;
    const createdAt = String(card.created_at ?? new Date().toISOString());
    let tags: unknown[] = [];
    let links: unknown[] = [];
    try { tags = JSON.parse(String(card.tags_json ?? "[]")); } catch { /* ignore malformed legacy metadata */ }
    try { links = JSON.parse(String(card.links_json ?? "[]")); } catch { /* ignore malformed legacy metadata */ }
    for (const tag of tags) {
      if (typeof tag === "string" && tag.trim()) { insertTag.run(id, tag.trim(), createdAt); importedTags++; }
    }
    for (const target of links) {
      const targetId = typeof target === "string" ? target : "";
      if (targetId && findCard.get(targetId)) { insertLink.run(id, targetId, createdAt); importedLinks++; }
    }
  }

  return { sourceCards: oldCards.length, insertedCards, skippedCards, importedTags, importedLinks };
})();

db.exec("DETACH DATABASE legacy");
db.close();
console.log(JSON.stringify({ ok: true, sourcePath, targetPath, ...result }, null, 2));
