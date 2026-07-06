import type { Card } from '../domain/card.js';
import { getCard } from '../repositories/cards_repository.js';
import { cardToMarkdown, safeMarkdownFilename } from '../utils/markdown_export.js';
import { createZip } from '../utils/zip_export.js';

export function buildCardMarkdown(card: Card) {
  const markdown = cardToMarkdown(card);
  const filename = `${safeMarkdownFilename(card.title, card.id)}.md`;
  return { markdown, filename };
}

export function buildBulkMarkdownZip(ids: string[]) {
  const usedNames = new Map<string, number>();
  const entries = ids
    .map((id) => getCard(id))
    .filter((card): card is Card => Boolean(card))
    .map((card) => {
      const baseName = safeMarkdownFilename(card.title, card.id);
      const count = usedNames.get(baseName) ?? 0;
      usedNames.set(baseName, count + 1);
      const filename = count === 0 ? `${baseName}.md` : `${baseName}-${count + 1}.md`;
      return {
        filename,
        content: cardToMarkdown(card),
      };
    });

  if (!entries.length) return null;

  return {
    filename: `cards-markdown-${new Date().toISOString().slice(0, 10)}.zip`,
    zip: createZip(entries),
  };
}