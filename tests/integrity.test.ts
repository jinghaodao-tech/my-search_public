import { describe, expect, it } from "vitest";
import { database } from "./helpers.js";

describe("SQLite relational integrity", () => {
  it("enables foreign keys on every application connection", () => {
    const row = database.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  it("enforces card link targets and KJ group references", () => {
    const now = new Date().toISOString();
    const insertCard = database.db.prepare(`INSERT INTO cards (id, title, body, type, tags_json, links_json, archived, tokens_json, doc_length, created_at, updated_at) VALUES (?, ?, ?, 'memo', '[]', '[]', 0, '[]', 0, ?, ?)`);
    insertCard.run("integrity-card", "Integrity card", "body", now, now);
    expect(() => database.db.prepare("INSERT INTO card_links (source_card_id, target_card_id, created_at) VALUES (?, ?, ?)").run("integrity-card", "missing-card", now)).toThrow();
    expect(() => database.db.prepare("UPDATE cards SET kj_group_id = ? WHERE id = ?").run("missing-group", "integrity-card")).toThrow();
    database.db.prepare("DELETE FROM cards WHERE id = ?").run("integrity-card");
  });
});