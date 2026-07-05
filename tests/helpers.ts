import fs from "node:fs";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.MOCK_AI_SUMMARY = "true";
process.env.CORS_ORIGIN = "http://localhost:3000";
process.env.IMPORT_RATE_LIMIT = "1000";

export const testDir = path.join(process.cwd(), "data", `acceptance-vitest-${process.pid}`);

fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

process.env.DB_PATH = path.join(testDir, "cards.db");
process.env.KJ_FILE = path.join(testDir, "kj_groups.json");

export const cardsEngine = await import("../cards_engine.js");
export const bm25Engine = await import("../bm25_engine.js");
export const { app } = await import("../server.js");

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
