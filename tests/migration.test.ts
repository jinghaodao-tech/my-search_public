import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { testDir } from "./helpers.js";

describe("DB migration", () => {
  function runTsx(script: string, env: NodeJS.ProcessEnv) {
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    return spawnSync(process.execPath, [tsxCli, script], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
  }

  it("preserves count and key fields after JSON to SQLite migration", () => {
    const migrationDir = path.join(testDir, "migration");
    fs.rmSync(migrationDir, { recursive: true, force: true });
    fs.mkdirSync(migrationDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationDir, "cards.json"),
      JSON.stringify([
        {
          id: "migrate-1",
          title: "Migration card",
          body: "Migration body",
          summary: "Summary",
          url: "https://example.test/migrate",
          type: "memo",
          tags: ["migration", "sqlite"],
          links: ["linked-card"],
          archived: true,
          archivedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ]),
      "utf8",
    );

    const dbPath = path.join(migrationDir, "cards.db");
    const result = runTsx("scripts/migrate_cards_json_to_sqlite.ts", {
      ...process.env,
      DATA_DIR: migrationDir,
      DB_PATH: dbPath,
    });
    expect(result.status, result.error?.message || result.stderr || result.stdout).toBe(0);

    const rerun = runTsx("scripts/migrate_cards_json_to_sqlite.ts", {
      ...process.env,
      DATA_DIR: migrationDir,
      DB_PATH: dbPath,
    });
    expect(rerun.status, rerun.error?.message || rerun.stderr || rerun.stdout).toBe(0);

    const db = new Database(dbPath);
    try {
      const rows = db.prepare("SELECT * FROM cards").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("migrate-1");
      expect(rows[0].title).toBe("Migration card");
      expect(rows[0].body).toBe("Migration body");
      expect(JSON.parse(rows[0].tags_json)).toEqual(["migration", "sqlite"]);
      expect(JSON.parse(rows[0].links_json)).toEqual(["linked-card"]);
      expect(rows[0].archived).toBe(1);

      const relationTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      expect(relationTables.map((table) => table.name)).toEqual(expect.arrayContaining(["card_tags", "card_links"]));

      const tagRows = db.prepare("SELECT card_id, tag FROM card_tags WHERE card_id = ? ORDER BY tag").all("migrate-1");
      expect(tagRows).toEqual([
        { card_id: "migrate-1", tag: "migration" },
        { card_id: "migrate-1", tag: "sqlite" },
      ]);

      const linkRows = db.prepare("SELECT source_card_id, target_card_id FROM card_links WHERE source_card_id = ?").all("migrate-1");
      expect(linkRows).toEqual([{ source_card_id: "migrate-1", target_card_id: "linked-card" }]);

      const cardIndexes = db.prepare("PRAGMA index_list(card_tags)").all() as Array<{ name: string }>;
      const linkIndexes = db.prepare("PRAGMA index_list(card_links)").all() as Array<{ name: string }>;
      expect(cardIndexes.map((index) => index.name)).toContain("idx_card_tags_tag");
      expect(linkIndexes.map((index) => index.name)).toContain("idx_card_links_target");
    } finally {
      db.close();
    }
  });

  it("creates KJ group schema, indexes, and migrates KJ group JSON into SQLite", () => {
    const migrationDir = path.join(testDir, "kj-migration");
    fs.rmSync(migrationDir, { recursive: true, force: true });
    fs.mkdirSync(migrationDir, { recursive: true });
    fs.writeFileSync(path.join(migrationDir, "cards.json"), "[]", "utf8");

    fs.writeFileSync(
      path.join(migrationDir, "kj_groups.json"),
      JSON.stringify([
        {
          id: "kj-migrate-1",
          name: "Migrated group",
          color: "#4D96FF",
          description: "KJ group from JSON",
          createdAt: "2026-01-03T00:00:00.000Z",
          updatedAt: "2026-01-04T00:00:00.000Z",
        },
      ]),
      "utf8",
    );

    const dbPath = path.join(migrationDir, "cards.db");
    const env = {
      ...process.env,
      DATA_DIR: migrationDir,
      DB_PATH: dbPath,
    };

    const cardMigration = runTsx("scripts/migrate_cards_json_to_sqlite.ts", env);
    expect(cardMigration.status, cardMigration.error?.message || cardMigration.stderr || cardMigration.stdout).toBe(0);

    const kjMigration = runTsx("scripts/migrate_kj_groups_json_to_sqlite.ts", env);
    expect(kjMigration.status, kjMigration.error?.message || kjMigration.stderr || kjMigration.stdout).toBe(0);

    const db = new Database(dbPath);
    try {
      const groupColumns = db.prepare("PRAGMA table_info(kj_groups)").all() as Array<{ name: string }>;
      expect(groupColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["id", "name", "color", "description", "created_at", "updated_at"]),
      );

      const indexes = db.prepare("PRAGMA index_list(cards)").all() as Array<{ name: string }>;
      const kjIndexes = db.prepare("PRAGMA index_list(kj_groups)").all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain("idx_cards_kj_group_id");
      expect(kjIndexes.map((index) => index.name)).toContain("idx_kj_groups_created_at");

      const group = db.prepare("SELECT * FROM kj_groups WHERE id = ?").get("kj-migrate-1") as any;
      expect(group).toMatchObject({
        id: "kj-migrate-1",
        name: "Migrated group",
        color: "#4D96FF",
        description: "KJ group from JSON",
        created_at: "2026-01-03T00:00:00.000Z",
        updated_at: "2026-01-04T00:00:00.000Z",
      });

      db.prepare(`
        INSERT INTO cards (
          id,
          title,
          body,
          type,
          tags_json,
          links_json,
          kj_group_id,
          archived,
          tokens_json,
          doc_length,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "card-with-kj",
        "Card with KJ",
        "body",
        "memo",
        "[]",
        "[]",
        "kj-migrate-1",
        0,
        "[]",
        0,
        "2026-01-05T00:00:00.000Z",
        "2026-01-05T00:00:00.000Z",
      );

      const linked = db.prepare(`
        SELECT cards.id AS card_id, kj_groups.id AS group_id
        FROM cards
        JOIN kj_groups ON cards.kj_group_id = kj_groups.id
        WHERE cards.id = ?
      `).get("card-with-kj") as any;
      expect(linked).toEqual({ card_id: "card-with-kj", group_id: "kj-migrate-1" });
    } finally {
      db.close();
    }
  });
});
