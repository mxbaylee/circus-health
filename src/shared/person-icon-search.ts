import catalog from './person-icon-catalog.json' with { type: 'json' };

import { ICON_EXTRA_TAGS, ICON_SEARCH_ALIASES } from './person-icon-vocabulary.ts';

const words = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const catalogByName = new Map(catalog.icons.map((icon) => [icon.name, icon]));
export const ICON_CATALOG = catalog.icons.map((icon) => {
  const canonical = catalogByName.get(ICON_SEARCH_ALIASES[icon.name]) || icon;
  const localTags = ICON_EXTRA_TAGS[canonical.name] || [];
  const upstreamTags = [...new Set([...icon.tags, ...canonical.tags])];
  const categories = [...new Set([...icon.categories, ...canonical.categories])];
  const searchWords = new Map<string, number>();
  // For the same match quality, names outrank upstream metadata, which outranks
  // supplemental vocabulary. Repeated tags add no weight.
  for (const [text, priority] of [
    [[icon.name, canonical.name].join(' '), 40],
    [[...upstreamTags, ...categories].join(' '), 20],
    [localTags.join(' '), 0],
  ] as const) {
    for (const word of words(text)) {
      searchWords.set(word, Math.max(searchWords.get(word) ?? 0, priority));
    }
  }
  return {
    value: `lucide:${icon.name}`,
    name: icon.name,
    canonicalName: canonical.name,
    label: icon.name
      .split('-')
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(' '),
    categories,
    tags: [...upstreamTags, ...localTags],
    searchWords: [...searchWords],
  };
});
export type IconChoice = (typeof ICON_CATALOG)[number];
export const ICON_CATEGORIES = [...new Set(ICON_CATALOG.flatMap((icon) => icon.categories))].sort();

/** Adjacent transpositions count as one typo; short words require exact/prefix matches. */
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  return rows[a.length][b.length];
}
export function searchPersonIcons(query: string, category = 'All'): IconChoice[] {
  const tokens = words(query).slice(0, 8);
  if (query.trim() && !tokens.length) return [];
  const candidates = ICON_CATALOG.filter(
    (icon) => category === 'All' || icon.categories.includes(category),
  );
  if (!tokens.length) return candidates.filter((icon) => icon.name === icon.canonicalName);
  const seen = new Set<string>();
  return candidates
    .map((icon) => {
      let score = 0;
      for (const token of tokens) {
        let best = 0;
        for (const [word, priority] of icon.searchWords) {
          if (word === token) best = Math.max(best, 100 + priority);
          else if (word.startsWith(token)) best = Math.max(best, 70 + priority);
          else if (token.length >= 3 && word.includes(token)) best = Math.max(best, 40 + priority);
          else if (
            token.length >= 4 &&
            token.length <= 40 &&
            Math.abs(token.length - word.length) <= (token.length >= 8 ? 2 : 1)
          ) {
            const difference = distance(token, word);
            if (difference <= (token.length >= 8 ? 2 : 1))
              best = Math.max(best, 25 - difference * 5 + priority);
          }
        }
        if (!best) return { icon, score: 0 };
        score += best;
      }
      if (tokens.join('-') === icon.name) score += 200;
      return { icon, score };
    })
    .filter((match) => match.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.icon.canonicalName.localeCompare(b.icon.canonicalName) ||
        Number(a.icon.name !== a.icon.canonicalName) -
          Number(b.icon.name !== b.icon.canonicalName) ||
        a.icon.name.localeCompare(b.icon.name),
    )
    .filter(({ icon }) => {
      if (seen.has(icon.canonicalName)) return false;
      seen.add(icon.canonicalName);
      return true;
    })
    .map((match) => match.icon);
}
