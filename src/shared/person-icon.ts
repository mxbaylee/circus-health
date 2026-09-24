import catalog from './person-icon-catalog.json' with { type: 'json' };
/** Portable identity decoration; stored with the person's ordinary versioned fields. */
export const PERSON_ICONS = [
  'person',
  'star',
  'moon',
  'sun',
  'heart',
  'sparkles',
  'flower',
  'cat',
  'dog',
  'bird',
  'cookie',
  'crown',
  'stethoscope',
] as const;
const names = new Set(catalog.icons.map((icon) => icon.name));
export function lucidePersonIcon(value: string): string | null {
  if (value.startsWith('lucide:')) return names.has(value.slice(7)) ? value.slice(7) : null;
  if (value === 'person' || !value) return 'user-round';
  if (value === 'flower') return 'flower-2'; // Preserve the existing icon's shape.
  return (PERSON_ICONS as readonly string[]).includes(value) ? value : null;
}
export function validPersonIcon(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (lucidePersonIcon(value)) return true;
  // One grapheme supports flags, skin tones and joined emoji without accepting text/URLs/markup.
  return (
    value.length <= 32 &&
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length === 1 &&
    /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(value) &&
    !/[<>\r\n]/.test(value)
  );
}
