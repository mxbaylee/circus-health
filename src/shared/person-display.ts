import { lucidePersonIcon } from './person-icon.ts';
import { ICON_SEARCH_ALIASES } from './person-icon-vocabulary.ts';

/** Display identity is separate from the names used to match medical evidence. */
export function canonicalPersonDisplayName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}
export function canonicalPersonDisplayIcon(icon: string | null | undefined): string {
  const lucide = lucidePersonIcon(icon || '');
  return lucide ? ICON_SEARCH_ALIASES[lucide] || lucide : icon || '';
}
export function personDisplayKey(name: string, icon: string | null | undefined): string {
  return JSON.stringify([canonicalPersonDisplayName(name), canonicalPersonDisplayIcon(icon)]);
}
