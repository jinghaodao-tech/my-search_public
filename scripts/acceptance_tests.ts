import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

const testDir = path.join(process.cwd(), "data", "acceptance-test");
fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

process.env.DB_PATH = path.join(testDir, "cards.db");
process.env.KJ_FILE = path.join(testDir, "kj_groups.json");
process.env.NODE_ENV = "test";

type TestFn = () => void | Promise<void>;

const passed: string[] = [];
const failed: Array<{ name: string; error: unknown }> = [];

async function run(name: string, fn: TestFn): Promise<void> {
  try {
    await fn();
    passed.push(name);
    console.log(`ok - ${name}`);
  } catch (error) {
    failed.push({ name, error });
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

function article(id: string, title: string, body: string) {
  return {
    id,
    title,
    body,
    publishedAt: new Date(),
    sourceAuthority: 1,
    url: `https://example.test/${id}`,
  };
}

function tokenArticle(id: string, title: string, tokens: string[]) {
  return {
    ...article(id, title, tokens.join(" ")),
    tokens,
    docLength: tokens.length,
  };
}

function searchMode(keywords: Array<{ term: string; weight: number; synonyms?: string[] }>) {
  return {
    label: "acceptance",
    description: "acceptance",
    k1: 1.2,
    b: 0.75,
    lambda: 0,
    contextBonus: 1,
    keywords,
  };
}

const cardsEngine = await import("../cards_engine.js");
const bm25Engine = await import("../bm25_engine.js");
const { app } = await import("../server.js");

await run("[S] BM25 exact and partial matches rank above unrelated cards", async () => {
  const result = await bm25Engine.runPipeline(
    [
      tokenArticle("exact", "exact search implementation", ["検索", "実装", "検索", "実装"]),
      tokenArticle("partial", "partial search", ["検索", "メモ"]),
      tokenArticle("noise", "cooking memo", ["料理", "珈琲"]),
    ],
    searchMode([
      { term: "検索", weight: 2 },
      { term: "実装", weight: 1 },
    ]),
    "acceptance",
    { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 10 }
  );
  const ids = result.active.map((item: any) => item.article.id);
  assert.equal(ids[0], "exact");
  assert.ok(ids.indexOf("partial") > 0);
  assert.equal(ids.includes("noise"), false);
});

await run("[S] BM25 empty and missing queries do not crash", async () => {
  const empty = await bm25Engine.runPipeline(
    [article("a", "sqlite memo", "body")],
    searchMode([]),
    "acceptance",
    { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 10 }
  );
  assert.equal(empty.active.length, 0);

  const missing = await bm25Engine.runPipeline(
    [article("a", "sqlite memo", "body")],
    searchMode([{ term: "wordthatdoesnotexist", weight: 1 }]),
    "acceptance",
    { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 10 }
  );
  assert.equal(missing.active.length, 0);
});

await run("[S] Card CRUD create, read, update, delete works", async () => {
  cardsEngine.saveCards([]);
  const created = await cardsEngine.createCard({ title: "CRUD card", body: "initial body", tags: ["crud"] });
  assert.equal(cardsEngine.getCard(created.id)?.title, "CRUD card");
  const updated = await cardsEngine.updateCard(created.id, { title: "CRUD card updated" });
  assert.equal(updated?.title, "CRUD card updated");
  assert.equal(cardsEngine.deleteCard(created.id), true);
  assert.equal(cardsEngine.getCard(created.id), null);
});

await run("[S] Archive and restore changes archived state", async () => {
  cardsEngine.saveCards([]);
  const card = await cardsEngine.createCard({ title: "Archive card", body: "body" });
  cardsEngine.bulkArchiveCards([card.id]);
  assert.equal(cardsEngine.getCard(card.id)?.archived, true);
  await cardsEngine.restoreCard(card.id);
  assert.equal(Boolean(cardsEngine.getCard(card.id)?.archived), false);
});

await run("[A] Bulk archive updates multiple cards", async () => {
  cardsEngine.saveCards([]);
  const a = await cardsEngine.createCard({ title: "Bulk archive A", body: "body" });
  const b = await cardsEngine.createCard({ title: "Bulk archive B", body: "body" });
  const updated = cardsEngine.bulkArchiveCards([a.id, b.id]);
  assert.deepEqual(new Set(updated), new Set([a.id, b.id]));
  assert.equal(cardsEngine.getCard(a.id)?.archived, true);
  assert.equal(cardsEngine.getCard(b.id)?.archived, true);
});

await run("[A] Bulk delete removes cards and references from links", async () => {
  cardsEngine.saveCards([]);
  const a = await cardsEngine.createCard({ title: "Bulk delete A", body: "body" });
  const b = await cardsEngine.createCard({ title: "Bulk delete B", body: "body" });
  const c = await cardsEngine.createCard({ title: "Bulk delete C", body: "body" });
  cardsEngine.linkCards(a.id, b.id);
  cardsEngine.linkCards(c.id, b.id);
  const deleted = cardsEngine.bulkDeleteCards([b.id]);
  assert.deepEqual(deleted, [b.id]);
  assert.equal(cardsEngine.getCard(b.id), null);
  assert.equal(cardsEngine.getCard(a.id)?.links.includes(b.id), false);
  assert.equal(cardsEngine.getCard(c.id)?.links.includes(b.id), false);
});

await run("[A] Tag add, remove, and search works", async () => {
  cardsEngine.saveCards([]);
  const card = await cardsEngine.createCard({ title: "Tag card", body: "body", tags: ["alpha"] });
  assert.equal(cardsEngine.getCards({ tag: "alpha" }).length, 1);
  await cardsEngine.updateCard(card.id, { tags: ["beta"] });
  assert.equal(cardsEngine.getCards({ tag: "alpha" }).length, 0);
  assert.equal(cardsEngine.getCards({ tag: "beta" }).length, 1);
  assert.equal(cardsEngine.getCards({ q: "beta" }).length, 1);
});

await run("[A] CSV import accepts valid CSV", () => {
  cardsEngine.saveCards([]);
  const imported = cardsEngine.parseAndImportCSV("title,body,tags\nCSV card,CSV body,\"csv,import\"");
  assert.equal(imported.length, 1);
  assert.equal(cardsEngine.loadCards().length, 1);
});

await run("[A] JSON import accepts valid JSON", () => {
  cardsEngine.saveCards([]);
  const result = cardsEngine.parseAndImportJSON(JSON.stringify([{ title: "JSON card", body: "JSON body", tags: ["json"] }]));
  assert.equal(result.cards.length, 1);
  assert.equal(cardsEngine.loadCards().length, 1);
});

await run("[A] Import invalid input does not crash the process", () => {
  assert.doesNotThrow(() => cardsEngine.parseAndImportCSV("title,body"));
  assert.throws(() => cardsEngine.parseAndImportJSON("{ invalid json"));
});

await run("[A] KJ groups create, update, assign, and delete works", async () => {
  cardsEngine.saveCards([]);
  cardsEngine.saveKJGroups([]);
  const card = await cardsEngine.createCard({ title: "KJ card", body: "body" });
  const group = cardsEngine.createKJGroup("Group A", "description");
  assert.equal(cardsEngine.loadKJGroups().length, 1);
  const updated = cardsEngine.updateKJGroup(group.id, { name: "Group B" });
  assert.equal(updated?.name, "Group B");
  await cardsEngine.assignKJGroup(card.id, group.id);
  assert.equal(cardsEngine.getCard(card.id)?.kjGroupId, group.id);
  cardsEngine.deleteKJGroup(group.id);
  assert.equal(cardsEngine.loadKJGroups().length, 0);
  assert.equal(cardsEngine.getCard(card.id)?.kjGroupId, undefined);
});

await run("[B] Backlinks are available when A links to B", async () => {
  cardsEngine.saveCards([]);
  const a = await cardsEngine.createCard({ title: "Backlink A", body: "body" });
  const b = await cardsEngine.createCard({ title: "Backlink B", body: "body" });
  cardsEngine.linkCards(a.id, b.id);
  assert.equal(cardsEngine.getBacklinks(b.id).some((card: any) => card.id === a.id), true);
});

await run("[B] Search ranking reflects keyword weight and synonyms", async () => {
  const result = await bm25Engine.runPipeline(
    [
      tokenArticle("weighted", "weighted implementation", ["大事", "実装", "大事"]),
      tokenArticle("low", "low implementation", ["実装"]),
    ],
    searchMode([
      { term: "重要", weight: 4, synonyms: ["大事"] },
      { term: "実装", weight: 1 },
    ]),
    "acceptance",
    { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 10 }
  );
  assert.equal(result.active[0].article.id, "weighted");
});

await run("[B] Performance stays under threshold for a moderate corpus", async () => {
  const corpus = Array.from({ length: 250 }, (_, index) =>
    tokenArticle(`perf-${index}`, `search card ${index}`, ["検索", "実装", "メモ", String(index)])
  );
  const start = performance.now();
  const result = await bm25Engine.runPipeline(
    corpus,
    searchMode([{ term: "検索", weight: 1 }, { term: "実装", weight: 1 }]),
    "acceptance",
    { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 200 }
  );
  const elapsedMs = performance.now() - start;
  assert.ok(result.active.length > 0);
  assert.ok(elapsedMs < 10_000, `elapsed ${elapsedMs.toFixed(1)}ms`);
});

await run("[B] API validation returns errors for invalid id and empty body", async () => {
  cardsEngine.saveCards([]);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const missing = await fetch(`${baseUrl}/api/cards/not-found-id`);
    assert.equal(missing.status, 404);

    const emptyCreate = await fetch(`${baseUrl}/api/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(emptyCreate.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

await run("[B] DB migration preserves count and key fields", () => {
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
    "utf8"
  );
  const dbPath = path.join(migrationDir, "cards.db");
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const result = spawnSync(process.execPath, [tsxCli, "scripts/migrate_cards_json_to_sqlite.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: migrationDir, DB_PATH: dbPath },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);

  const db = new Database(dbPath);
  try {
    const rows = db.prepare("SELECT * FROM cards").all() as any[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "migrate-1");
    assert.equal(rows[0].title, "Migration card");
    assert.equal(rows[0].body, "Migration body");
    assert.deepEqual(JSON.parse(rows[0].tags_json), ["migration", "sqlite"]);
    assert.deepEqual(JSON.parse(rows[0].links_json), ["linked-card"]);
    assert.equal(rows[0].archived, 1);
  } finally {
    db.close();
  }
});

await run("[S] Zettelkasten graph excludes isolated cards", async () => {
  cardsEngine.saveCards([]);
  const linkedA = await cardsEngine.createCard({ title: "Linked A", body: "body" });
  const linkedB = await cardsEngine.createCard({ title: "Linked B", body: "body" });
  await cardsEngine.createCard({ title: "Isolated", body: "body" });
  cardsEngine.linkCards(linkedA.id, linkedB.id);

  const allCards = cardsEngine.loadCards();
  const linkedIds = new Set<string>();
  for (const card of allCards) {
    if (card.links?.length) {
      linkedIds.add(card.id);
      for (const linkId of card.links) linkedIds.add(linkId);
    }
  }
  const visibleCards = allCards.filter((card: any) => linkedIds.has(card.id));
  assert.deepEqual(new Set(visibleCards.map((card: any) => card.id)), new Set([linkedA.id, linkedB.id]));
});

console.log("");
console.log(`passed: ${passed.length}`);

if (failed.length) {
  console.error(`failed: ${failed.length}`);
  process.exitCode = 1;
}
