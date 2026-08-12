import type { Card } from '../domain/card.js';
import { buildStoredTokenSet } from '../bm25_engine.js';

export async function attachCardTokens(card: Card): Promise<Card> {
  const stored = await buildStoredTokenSet(`${card.title} ${card.body} ${(card.tags ?? []).join(' ')}`);
  return {
    ...card,
    tokens: stored.ngramTokens,
    docLength: stored.ngramDocLength,
    ...stored,
  };
}

export async function attachCardTokensMany(cards: Card[]): Promise<Card[]> {
  return Promise.all(cards.map(attachCardTokens));
}
