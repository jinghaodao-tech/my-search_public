import type { Card } from '../domain/card.js';
import { tokenize } from '../search/tokenizer.js';

export async function attachCardTokens(card: Card): Promise<Card> {
  const tokens = await tokenize(`${card.title} ${card.body} ${(card.tags ?? []).join(' ')}`);
  return {
    ...card,
    tokens,
    docLength: tokens.length,
  };
}

export async function attachCardTokensMany(cards: Card[]): Promise<Card[]> {
  return Promise.all(cards.map(attachCardTokens));
}
