export type RankedId = { id: string };
export type ScoredId = { id: string; score: number };

export function* tieBreakByScore(rows: Iterator<ScoredId>): Generator<RankedId> {
  let next = rows.next();
  try {
    while (!next.done) {
      const score = next.value.score;
      const tied = [next.value.id];
      next = rows.next();
      while (!next.done && next.value.score === score) {
        tied.push(next.value.id);
        next = rows.next();
      }
      tied.sort((a, b) => a.localeCompare(b));
      for (const id of tied) yield { id };
    }
  } finally {
    rows.return?.();
  }
}

export function exactRrfTopK(
  first: Iterator<RankedId>,
  second: Iterator<RankedId>,
  limit: number,
  offset = 60,
): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  let firstNext = first.next();
  let secondNext = second.next();
  let firstRank = 0;
  let secondRank = 0;
  const seen = new Map<string, { firstRank?: number; secondRank?: number }>();
  const score = (ranks: { firstRank?: number; secondRank?: number }) =>
    (ranks.firstRank === undefined ? 0 : 1 / (offset + ranks.firstRank)) +
    (ranks.secondRank === undefined ? 0 : 1 / (offset + ranks.secondRank));

  try {
    while (!firstNext.done || !secondNext.done) {
      if (!firstNext.done) {
        firstRank++;
        const ranks = seen.get(firstNext.value.id) ?? {};
        ranks.firstRank = firstRank;
        seen.set(firstNext.value.id, ranks);
        firstNext = first.next();
      }
      if (!secondNext.done) {
        secondRank++;
        const ranks = seen.get(secondNext.value.id) ?? {};
        ranks.secondRank = secondRank;
        seen.set(secondNext.value.id, ranks);
        secondNext = second.next();
      }
      if (seen.size < limit) continue;

      const nextFirst = firstNext.done ? 0 : 1 / (offset + firstRank + 1);
      const nextSecond = secondNext.done ? 0 : 1 / (offset + secondRank + 1);
      const ordered = [...seen].map(([id, ranks]) => ({ id, score: score(ranks),
        upper: score(ranks) + (ranks.firstRank === undefined ? nextFirst : 0) + (ranks.secondRank === undefined ? nextSecond : 0),
      })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      const top = ordered.slice(0, limit);
      const unseenUpper = nextFirst + nextSecond;
      const orderIsCertain = top.every((row, index) => row.score > Math.max(unseenUpper, ...ordered.slice(index + 1).map(other => other.upper)));
      if (orderIsCertain) return top.map(row => row.id);
    }

    return [...seen].map(([id, ranks]) => ({ id, score: score(ranks) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit).map(row => row.id);
  } finally {
    first.return?.();
    second.return?.();
  }
}
