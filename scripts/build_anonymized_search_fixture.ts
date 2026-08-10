import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tokenize, tokenizeMorphological } from '../bm25_engine.js';

type CardRow = {
  id: string;
  title: string;
  body: string;
  summary: string | null;
  tags_json: string | null;
  created_at: string;
  updated_at: string;
  tokens_json: string | null;
  doc_length: number | null;
  archived: number | null;
};

const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'cards.db');
const outputPath = process.env.SEARCH_FIXTURE_PATH ?? path.join(process.cwd(), 'data', 'search-evaluation', 'anonymized-corpus.json');
const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(`SELECT id, title, body, summary, tags_json, created_at, updated_at, tokens_json, doc_length, archived FROM cards ORDER BY rowid`).all() as CardRow[];
db.close();

const newestTimestamp = Math.max(...rows.map(row => Date.parse(row.updated_at)).filter(Number.isFinite), Date.now());
  const documents = [];
for (const [index, row] of rows.entries()) {
  let tokens: string[] = [];
  try {
    const parsed = JSON.parse(row.tokens_json ?? '[]');
    tokens = Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    tokens = [];
  }
  let morphologicalTokens: string[] = [];
  if (tokens.length === 0) {
    let tags = '';
    try { tags = JSON.parse(row.tags_json ?? '[]').join(' '); } catch { tags = ''; }
    const text = `${row.title} ${row.body} ${row.summary ?? ''} ${tags}`;
    morphologicalTokens = await tokenizeMorphological(text);
    tokens = await tokenize(text);
  } else {
    let tags = '';
    try { tags = JSON.parse(row.tags_json ?? '[]').join(' '); } catch { tags = ''; }
    morphologicalTokens = await tokenizeMorphological(`${row.title} ${row.body} ${row.summary ?? ''} ${tags}`);
  }
  const stableId = crypto.createHash('sha256').update(row.id).digest('hex').slice(0, 16);
  const updatedAt = Date.parse(row.updated_at);
  const elapsedDays = Number.isFinite(updatedAt) ? Math.max(0, (newestTimestamp - updatedAt) / 86_400_000) : 0;
  documents.push({
    id: `anon-${stableId}`,
    title: `匿名カード ${index + 1}`,
    body: '匿名化済みローカルカード',
    url: `https://example.invalid/anon-${stableId}`,
    sourceAuthority: 0.8,
    publishedAt: new Date(Date.UTC(2000, 0, 1) - Math.min(elapsedDays, 365) * 86_400_000).toISOString(),
    tokens,
    morphologicalTokens,
    docLength: tokens.length,
    archived: Boolean(row.archived),
  });
}

const output = {
  version: 'anonymized-card-corpus-v1',
  source: 'local SQLite cards table',
  privacy: { rawIds: false, rawText: false, rawUrls: false, preserved: ['token arrays', 'document length', 'relative update age', 'archive flag'] },
  documents,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
console.log(JSON.stringify({ outputPath, documents: documents.length, active: documents.filter(document => !document.archived).length, tokenCount: documents.reduce((sum, document) => sum + document.tokens.length, 0) }, null, 2));
