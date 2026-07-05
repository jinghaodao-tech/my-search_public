import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Article } from "../bm25_engine.js";
import { saveArticlesToDb } from "../repositories/articles_repository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);
const dataDir = process.env.DATA_DIR ?? path.join(projectRoot, "data");
const articlesPath = path.join(dataDir, "articles.json");
const statsPath = path.join(dataDir, "stats.json");

function normalizeDate(value: unknown): Date {
  const parsed = value ? new Date(String(value)) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function normalizeArticle(value: unknown): Article | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const id = String(item.id ?? "").trim();
  const title = String(item.title ?? "").trim();
  const url = String(item.url ?? "").trim();
  if (!id || !title || !url) return null;

  const tokens = Array.isArray(item.tokens) ? item.tokens.map(String) : undefined;
  const docLength = typeof item.docLength === "number"
    ? item.docLength
    : typeof item.doc_length === "number"
      ? item.doc_length
      : tokens?.length;

  return {
    id,
    title,
    body: String(item.body ?? ""),
    url,
    source: typeof item.source === "string" ? item.source : undefined,
    sourceAuthority: typeof item.sourceAuthority === "number"
      ? item.sourceAuthority
      : typeof item.source_authority === "number"
        ? item.source_authority
        : 0,
    publishedAt: normalizeDate(item.publishedAt ?? item.published_at),
    summary: typeof item.summary === "string" ? item.summary : undefined,
    tags: Array.isArray(item.tags) ? item.tags.map(String) : undefined,
    tokens,
    docLength,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
  };
}

if (!fs.existsSync(articlesPath)) {
  console.log(`articles migration skipped: ${articlesPath} not found`);
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(articlesPath, "utf8"));
if (!Array.isArray(raw)) {
  throw new Error("articles.json must be an array");
}

let statsFetchedAt: string | undefined;
if (fs.existsSync(statsPath)) {
  try {
    const stats = JSON.parse(fs.readFileSync(statsPath, "utf8")) as { fetchedAt?: string };
    statsFetchedAt = stats.fetchedAt;
  } catch {
    statsFetchedAt = undefined;
  }
}

const articles: Article[] = [];
let invalid = 0;
for (const item of raw) {
  const article = normalizeArticle(item);
  if (article) articles.push(article);
  else invalid += 1;
}

const result = saveArticlesToDb(articles, statsFetchedAt ?? new Date().toISOString());
console.log(
  `articles migration complete: input=${raw.length}, imported=${result.inserted + result.updated}, ` +
  `inserted=${result.inserted}, updated=${result.updated}, duplicateUrls=${result.skippedDuplicateUrls}, invalid=${invalid}`,
);
