import fs from 'node:fs';
import { attachCardTokensMany } from '../../../services/card_token_service.js';
import { db } from '../../../db/database.js';
import { saveCards } from '../../../repositories/cards_repository.js';
import type { Card } from '../../../domain/card.js';
import { tokenizerName } from '../../../bm25_engine.js';

type CorpusDocument = { id: string; title: string; body: string; tags?: string[] };

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error('Usage: seed_corpus.ts <documents.json> <mapping.json>');
  const documents = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as CorpusDocument[];
  if (!documents.length || documents.some(document => !document.id || (!document.body && !document.title))) {
    throw new Error('Corpus contains no documents or a document without an ID/content');
  }
  const now = '2020-01-01T00:00:00.000Z';
  const cards = documents.map(document => ({
    id: `benchmark-${document.id}`,
    // An intentionally empty source title is not a missing field; do not inject
    // the document ID as searchable text.
    title: document.title ?? document.id,
    body: document.body,
    tags: document.tags ?? [],
    links: [],
    type: 'article' as const,
    createdAt: now,
    updatedAt: now,
  }));
  const tokenized: Card[] = [];
  for (let offset = 0; offset < cards.length; offset += 250) {
    tokenized.push(...await attachCardTokensMany(cards.slice(offset, offset + 250)));
    if ((offset + 250) % 1000 === 0 || offset + 250 >= cards.length) {
      console.log(`Tokenized ${Math.min(offset + 250, cards.length)} / ${cards.length}`);
    }
  }
  saveCards(tokenized);
  db.prepare(`INSERT INTO collector_settings(key, value) VALUES ('search_tokenizer', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(tokenizerName());
  fs.writeFileSync(outputPath, JSON.stringify(Object.fromEntries(documents.map((document, index) => [document.id, cards[index].id]))));
  console.log(JSON.stringify({ seeded: documents.length, mappingPath: outputPath }));
  db.close();
}

main().catch(error => {
  console.error(error);
  try { db.close(); } catch { /* already closed */ }
  process.exitCode = 1;
});
