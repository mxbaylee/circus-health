import { validEmojiTitle } from './src/scripts/emoji-title.ts';

export default {
  // Keep commitlint's default merge/revert/fixup ignores and Husky's bypasses.
  plugins: [
    {
      rules: {
        'leading-emoji': ({ raw }: { raw: string }) => [
          validEmojiTitle(raw.split(/\r?\n/, 1)[0]),
          'Start with an emoji (or Gitmoji shortcode), a space and a description, e.g. 📚 Update docs.',
        ],
      },
    },
  ],
  rules: { 'leading-emoji': [2, 'always'] },
};
