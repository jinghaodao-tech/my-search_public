import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { testDir } from "./helpers.js";

describe("DB migration", () => {
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
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(process.execPath, [tsxCli, "scripts/migrate_cards_json_to_sqlite.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, DATA_DIR: migrationDir, DB_PATH: dbPath },
      encoding: "utf8",
    });
    expect(result.status, result.error?.message || result.stderr || result.stdout).toBe(0);

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
    } finally {
      db.close();
    }
  });
});
