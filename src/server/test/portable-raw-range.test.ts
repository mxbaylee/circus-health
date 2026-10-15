import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPortableRawRange } from '../portable-raw-range.ts';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('fictional large canonical range rereads bounded pieces and refuses path replacement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-raw-range-'));
  const path = join(directory, 'source.txt');
  const text = 'prefix\n' + 'fictional-🌿'.repeat(100_000) + '\nsuffix';
  const full = Buffer.from(text);
  const prefix = Buffer.byteLength('prefix\n');
  const bytes = full.length - prefix - Buffer.byteLength('\nsuffix');
  const range = full.subarray(prefix, prefix + bytes);
  writeFileSync(path, full);
  const selected = openPortableRawRange(path, full.length, prefix, bytes, sha256(range), () => {});
  try {
    let length = 0;
    const digest = createHash('sha256');
    for (const part of selected.pieces()) {
      const encoded = Buffer.from(part);
      assert.ok(encoded.length <= 16 * 1024 + 4);
      length += encoded.length;
      digest.update(encoded);
    }
    selected.assertComplete();
    assert.equal(length, bytes);
    assert.equal(digest.digest('hex'), sha256(range));
    const iterator = selected.pieces()[Symbol.iterator]();
    assert.equal(iterator.next().done, false);
    const replacement = join(directory, 'replacement.txt');
    writeFileSync(replacement, full);
    renameSync(replacement, path);
    assert.throws(() => iterator.next(), /source changed/);
    assert.throws(() => selected.close(), /range incomplete/);
  } finally {
    try {
      selected.close();
    } catch {
      // The deliberate aborted second pass already asserted this refusal.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('canonical range rejects invalid UTF-8 despite a matching raw digest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-invalid-range-'));
  const path = join(directory, 'source.txt');
  const bytes = Buffer.from([0x7b, 0xff, 0x7d]);
  writeFileSync(path, bytes);
  const selected = openPortableRawRange(
    path,
    bytes.length,
    0,
    bytes.length,
    sha256(bytes),
    () => {},
  );
  try {
    assert.throws(() => [...selected.pieces()], /not valid UTF-8/);
    assert.throws(() => selected.close(), /range incomplete/);
  } finally {
    try {
      selected.close();
    } catch {
      // Deliberately refused range.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
