// Temporary diagnosis for this PR; remove before merge after applying the reported patch.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { test } from 'vitest';

test('show pinned formatter differences without rewriting repository files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'checker-format-'));
  try {
    for (const file of [
      'src/app/passkey-checker/RoundApp.tsx',
      'src/tests/passkey-checker-round.test.ts',
    ]) {
      const formatted = await format(readFileSync(file, 'utf8'), {
        ...(await resolveConfig(file)),
        filepath: file,
      });
      const output = join(directory, 'formatted.txt');
      writeFileSync(output, formatted);
      try {
        execFileSync('diff', ['-u', file, output], { encoding: 'utf8' });
      } catch (error) {
        console.log(String((error as { stdout?: unknown }).stdout ?? 'No formatter diff available'));
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
