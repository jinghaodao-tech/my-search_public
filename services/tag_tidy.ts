/** Tidying tags: finding spellings of the same tag, and merging them. Nothing is deleted automatically. */

/** AI / ai / ＡＩ / "A I" → the same key. */
export function tagKey(tag: string): string {
  return tag.normalize('NFKC').toLowerCase().replace(/[\s_\-・／/]+/g, '');
}

export type TagVariantGroup = { key: string; tags: Array<{ tag: string; count: number }>; suggested: string };

/** Tags that differ only in width, case, spaces or hyphens. The most used spelling is suggested. */
export function tagVariantGroups(tags: Array<{ tag: string; count: number }>): TagVariantGroup[] {
  const groups = new Map<string, Array<{ tag: string; count: number }>>();
  for (const item of tags) groups.set(tagKey(item.tag), [...(groups.get(tagKey(item.tag)) ?? []), item]);
  return [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ja'));
      return { key, tags: sorted, suggested: sorted[0].tag };
    })
    .sort((a, b) => b.tags.reduce((s, t) => s + t.count, 0) - a.tags.reduce((s, t) => s + t.count, 0));
}

/** The tags of one card after merging `from` into `to` (order kept, no duplicates). */
export function mergeTagList(tags: string[], from: string[], to: string): string[] {
  const merged = tags.map(tag => (from.includes(tag) ? to : tag));
  return [...new Set(merged)];
}
