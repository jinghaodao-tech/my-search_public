import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { testDir } from "./helpers.js";
import { runMigrations } from "../db/migrate.js";

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

  it("migrates collected articles from JSON into SQLite idempotently", () => {
    const migrationDir = path.join(testDir, "articles-migration");
    fs.rmSync(migrationDir, { recursive: true, force: true });
    fs.mkdirSync(migrationDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationDir, "articles.json"),
      JSON.stringify([
        {
          id: "article-1",
          title: "SQLite article",
          body: "Article body",
          url: "https://example.test/article-1",
          source: "rss:Example",
          sourceAuthority: 0.8,
          publishedAt: "2026-01-06T00:00:00.000Z",
          summary: "Article summary",
          tags: ["sqlite", "article"],
          tokens: ["sqlite", "article"],
          docLength: 2,
        },
        {
          id: "article-duplicate-url",
          title: "Duplicate article",
          body: "Duplicate body",
          url: "https://example.test/article-1",
          source: "rss:Example",
          sourceAuthority: 0.8,
          publishedAt: "2026-01-06T00:00:00.000Z",
        },
      ]),
      "utf8",
    );
    fs.writeFileSync(
      path.join(migrationDir, "stats.json"),
      JSON.stringify({ fetchedAt: "2026-01-07T00:00:00.000Z" }),
      "utf8",
    );

    const dbPath = path.join(migrationDir, "cards.db");
    const env = {
      ...process.env,
      DATA_DIR: migrationDir,
      DB_PATH: dbPath,
    };

    const first = runTsx("scripts/migrate_articles_json_to_sqlite.ts", env);
    expect(first.status, first.error?.message || first.stderr || first.stdout).toBe(0);
    expect(first.stdout).toContain("duplicateUrls=1");

    const second = runTsx("scripts/migrate_articles_json_to_sqlite.ts", env);
    expect(second.status, second.error?.message || second.stderr || second.stdout).toBe(0);

    const db = new Database(dbPath);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toContain("articles");

      const columns = db.prepare("PRAGMA table_info(articles)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          "id",
          "title",
          "body",
          "url",
          "source",
          "source_authority",
          "published_at",
          "summary",
          "tags_json",
          "tokens_json",
          "doc_length",
          "content_hash",
          "created_at",
          "updated_at",
          "last_fetched_at",
        ]),
      );

      const indexes = db.prepare("PRAGMA index_list(articles)").all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toEqual(
        expect.arrayContaining([
          "idx_articles_url_unique",
          "idx_articles_published_at",
          "idx_articles_source",
          "idx_articles_doc_length",
          "idx_articles_content_hash",
        ]),
      );

      const rows = db.prepare("SELECT * FROM articles").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "article-1",
        title: "SQLite article",
        body: "Article body",
        url: "https://example.test/article-1",
        source: "rss:Example",
        source_authority: 0.8,
        published_at: "2026-01-06T00:00:00.000Z",
        summary: "Article summary",
        doc_length: 2,
        last_fetched_at: "2026-01-07T00:00:00.000Z",
      });
      expect(JSON.parse(rows[0].tags_json)).toEqual(["sqlite", "article"]);
      expect(JSON.parse(rows[0].tokens_json)).toEqual(["sqlite", "article"]);
      expect(rows[0].content_hash).toEqual(expect.any(String));
    } finally {
      db.close();
    }
  });

  it("applies relation foreign keys transactionally and is safe to rerun", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`CREATE TABLE kj_groups (id TEXT PRIMARY KEY); CREATE TABLE cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, summary TEXT, url TEXT, type TEXT NOT NULL DEFAULT 'memo', color TEXT, tags_json TEXT NOT NULL DEFAULT '[]', links_json TEXT NOT NULL DEFAULT '[]', kj_group_id TEXT, archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT, tokens_json TEXT NOT NULL DEFAULT '[]', doc_length INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE card_tags (card_id TEXT NOT NULL, tag TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(card_id, tag)); CREATE TABLE card_links (source_card_id TEXT NOT NULL, target_card_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(source_card_id, target_card_id));`);
    db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);");
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run("001_create_migrations_table", "now");
    for (const id of ["002_add_search_token_columns", "003_create_kj_groups", "004_create_card_relation_tables", "005_create_articles_table", "006_add_candidate_lifecycle"]) db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(id, "now");
    const applied = runMigrations(db);
    expect(applied).toContain("007_enforce_relation_foreign_keys");
    const rerun = runMigrations(db);
    expect(rerun).toEqual([]);
    expect((db.prepare("PRAGMA foreign_key_list(card_links)").all() as any[]).map(row => row.from)).toEqual(expect.arrayContaining(["source_card_id", "target_card_id"]));
    db.close();
  });

  it("does not record a failed migration", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE kj_groups (id TEXT PRIMARY KEY); CREATE TABLE cards (id TEXT PRIMARY KEY); CREATE TABLE card_tags (card_id TEXT, tag TEXT, created_at TEXT); CREATE TABLE card_links (source_card_id TEXT, target_card_id TEXT, created_at TEXT); CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES ('001_create_migrations_table', 'now'), ('002_add_search_token_columns', 'now'), ('003_create_kj_groups', 'now'), ('004_create_card_relation_tables', 'now'), ('005_create_articles_table', 'now'), ('006_add_candidate_lifecycle', 'now');`);
    expect(() => runMigrations(db)).toThrow();
    expect(db.prepare("SELECT id FROM schema_migrations WHERE id = '007_enforce_relation_foreign_keys'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'cards_new'").get()).toBeUndefined();
    db.close();
  });});