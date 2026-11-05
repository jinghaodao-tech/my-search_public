import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.MOCK_AI_SUMMARY = "true";
process.env.CORS_ORIGIN = "http://localhost:3000";
process.env.IMPORT_RATE_LIMIT = "1000";

const testDirPrefix = `my-search-acceptance-vitest-${process.pid}-`;
export const testDir = fs.mkdtempSync(path.join(os.tmpdir(), testDirPrefix));

process.env.DB_PATH = path.join(testDir, "cards.db");
process.env.KJ_FILE = path.join(testDir, "kj_groups.json");

export const cardsEngine = await import("../cards_engine.js");
export const bm25Engine = await import("../bm25_engine.js");
export const database = await import("../db/database.js");
export const { app } = await import("../server.js");

process.once("exit", () => {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  const resolvedTestDir = path.resolve(testDir);
  if (!resolvedTestDir.startsWith(tempRoot) || !path.basename(resolvedTestDir).startsWith(testDirPrefix)) {
    console.error("Refusing to remove a path outside this run's isolated test directory");
    return;
  }
  if (database.db.open) database.db.close();
  fs.rmSync(resolvedTestDir, { recursive: true, force: true });
});

export function resetCards() {
  cardsEngine.saveCards([]);
  cardsEngine.saveKJGroups([]);
}

export function article(id: string, title: string, body: string) {
  return {
    id,
    title,
    body,
    publishedAt: new Date(),
    sourceAuthority: 1,
    url: `https://example.test/${id}`,
  };
}

export function tokenArticle(id: string, title: string, tokens: string[]) {
  return {
    ...article(id, title, tokens.join(" ")),
    tokens,
    docLength: tokens.length,
  };
}

export function searchMode(keywords: Array<{ term: string; weight: number; synonyms?: string[] }>) {
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
