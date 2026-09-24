import { gitmojis } from 'gitmojis';

// Unicode emoji sequences, including flags, skin tones, keycaps and joined emoji.
// Use the catalog only for backward-compatible shortcodes, never to limit emoji.
const leadingEmoji = new RegExp('^\\p{RGI_Emoji} ', 'v');

export function validEmojiTitle(title: string): boolean {
  if (/[\r\n]/.test(title)) return false;
  const prefix = leadingEmoji.exec(title)?.[0];
  if (prefix) return title.slice(prefix.length).trim().length > 0;
  return gitmojis.some(
    ({ code }) => title.startsWith(`${code} `) && title.slice(code.length + 1).trim().length > 0,
  );
}
