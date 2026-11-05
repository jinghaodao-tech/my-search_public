export type KeywordGroup = readonly string[];

function maximumDistinctInWindow(tokens: readonly string[], wanted: ReadonlySet<string>, windowSize: number) {
  const counts = new Map<string, number>();
  let distinct = 0;
  let maximum = 0;
  const change = (token: string, delta: number) => {
    if (!wanted.has(token)) return;
    const previous = counts.get(token) ?? 0;
    const next = previous + delta;
    if (previous === 0 && next > 0) distinct += 1;
    if (previous > 0 && next === 0) distinct -= 1;
    if (next > 0) counts.set(token, next);
    else counts.delete(token);
  };

  for (let index = 0; index < Math.min(windowSize, tokens.length); index += 1) change(tokens[index]!, 1);
  maximum = distinct;
  for (let start = 1; start < tokens.length; start += 1) {
    change(tokens[start - 1]!, -1);
    const entering = start + windowSize - 1;
    if (entering < tokens.length) change(tokens[entering]!, 1);
    maximum = Math.max(maximum, distinct);
    if (maximum === wanted.size) break;
  }
  return maximum;
}

/** Benchmark copy of the current production definition; terms are expected to be the matched terms. */
export function currentContextBonus(tokens: readonly string[], terms: readonly string[], maxBonus: number, windowSize = 50) {
  const uniqueTerms = new Set(terms);
  const maximum = maximumDistinctInWindow(tokens, uniqueTerms, windowSize);
  return 1 + (maxBonus - 1) * Math.min(maximum / Math.max(terms.length, 1), 1);
}

/** Corrects the denominator to include every analyzed query token, including absent tokens. */
export function allQueryTokenContextBonus(tokens: readonly string[], queryTerms: readonly string[], maxBonus: number, windowSize = 50) {
  const uniqueTerms = new Set(queryTerms);
  const maximum = maximumDistinctInWindow(tokens, uniqueTerms, windowSize);
  return 1 + (maxBonus - 1) * Math.min(maximum / Math.max(uniqueTerms.size, 1), 1);
}

/** Counts only fully matched original keyword groups in a window; partial group hits do not qualify. */
export function keywordUnitContextBonus(tokens: readonly string[], groups: readonly KeywordGroup[], maxBonus: number, windowSize = 50) {
  const normalizedGroups = groups.map(group => [...new Set(group.filter(Boolean))]);
  const usableGroups = normalizedGroups.filter(group => group.length > 0);
  if (usableGroups.length === 0) return 1;

  const tokenGroups = new Map<string, number[]>();
  usableGroups.forEach((group, groupIndex) => {
    for (const token of group) {
      const ids = tokenGroups.get(token) ?? [];
      ids.push(groupIndex);
      tokenGroups.set(token, ids);
    }
  });
  const tokenCounts = new Map<string, number>();
  const groupMatches = usableGroups.map(() => 0);
  let completeGroups = 0;
  let maximumCompleteGroups = 0;
  const change = (token: string, delta: number) => {
    const groupIds = tokenGroups.get(token);
    if (!groupIds) return;
    const previousTokenCount = tokenCounts.get(token) ?? 0;
    const nextTokenCount = previousTokenCount + delta;
    tokenCounts.set(token, nextTokenCount);
    if ((previousTokenCount > 0) === (nextTokenCount > 0)) return;
    const direction = nextTokenCount > 0 ? 1 : -1;
    for (const groupId of groupIds) {
      const previous = groupMatches[groupId]!;
      const next = previous + direction;
      if (previous === usableGroups[groupId]!.length && next < previous) completeGroups -= 1;
      if (previous < usableGroups[groupId]!.length && next === usableGroups[groupId]!.length) completeGroups += 1;
      groupMatches[groupId] = next;
    }
  };

  for (let index = 0; index < Math.min(windowSize, tokens.length); index += 1) change(tokens[index]!, 1);
  maximumCompleteGroups = completeGroups;
  for (let start = 1; start < tokens.length; start += 1) {
    change(tokens[start - 1]!, -1);
    const entering = start + windowSize - 1;
    if (entering < tokens.length) change(tokens[entering]!, 1);
    maximumCompleteGroups = Math.max(maximumCompleteGroups, completeGroups);
    if (maximumCompleteGroups === usableGroups.length) break;
  }
  return 1 + (maxBonus - 1) * maximumCompleteGroups / usableGroups.length;
}

/** Deliberately simple O(N*W) oracle used only to verify the sliding-window implementation. */
export function currentContextBonusNaive(tokens: readonly string[], terms: readonly string[], maxBonus: number, windowSize = 50) {
  const wanted = new Set(terms);
  let maximum = 0;
  for (let start = 0; start < tokens.length; start += 1) {
    const present = new Set(tokens.slice(start, start + windowSize).filter(token => wanted.has(token)));
    maximum = Math.max(maximum, present.size);
  }
  return 1 + (maxBonus - 1) * Math.min(maximum / Math.max(terms.length, 1), 1);
}
