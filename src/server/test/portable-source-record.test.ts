import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareIntakeJsonCanonicalSteps } from '../intake-json-canonical.ts';
import { createPortableSourceIndex } from '../portable-source-index.ts';
import { withPortableSourceRecordCells } from '../portable-source-record.ts';
import { profilePaths } from '../profile-storage.ts';

function parsed(text: string) {
  const steps = prepareIntakeJsonCanonicalSteps([text], { mode: 'stringify' });
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

test('fictional raw reference streams exact selected original bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-raw-source-'));
  const profileId = 'cookie-dough';
  const relative = `${profilePaths(root, profileId).relativeRoot}/sources/original.json`;
  const original = JSON.stringify({ fictional: '🌿'.repeat(6_000) });
  const bytes = Buffer.from(original);
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  const id = 'fictional-source-' + 'x'.repeat(16_000);
  const source = JSON.stringify({
    id,
    path: relative,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  const index = createPortableSourceIndex(() => {});
  const row = parsed(
    JSON.stringify({
      id: 'fictional-record',
      source_file_id: id,
      raw_source: {
        sourceFileId: id,
        offset: 0,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    }),
  );
  try {
    index.add(
      () => [id],
      () => [source],
    );
    withPortableSourceRecordCells(
      row,
      ['id', 'source_file_id', 'raw_json'],
      index,
      root,
      profileId,
      () => {},
      (cells) => {
        const raw = cells.find((cell) => cell.name === 'raw_json');
        assert.equal(raw?.kind, 'text');
        if (raw?.kind !== 'text') return;
        assert.equal([...raw.pieces()].join(''), original);
      },
    );
  } finally {
    row.close();
    index.close();
    rmSync(root, { recursive: true, force: true });
  }
});
