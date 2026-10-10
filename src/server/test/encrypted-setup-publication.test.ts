import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import {
  captureUnlockPhysicalWitness,
  unlockPhysicalIdentity,
  verifyUnlockPhysicalWitness,
} from '../encrypted-unlock-physical.ts';
import {
  stageSetupImmutableAdditions,
  finishSetupManifestWitness,
} from '../encrypted-setup-publication.ts';

function fixture(t: TestContext) {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-owned-setup-')),
    root = resolve(base, 'original'),
    candidate = resolve(base, 'candidate'),
    witness = resolve(base, 'physical.sqlite');
  for (const path of [root, candidate]) {
    mkdirSync(resolve(path, 'objects'), { recursive: true });
    writeFileSync(resolve(path, 'manifest.enc'), 'Fictional original manifest ciphertext');
    writeFileSync(resolve(path, 'objects/original.enc'), 'Fictional unchanged original ciphertext');
  }
  writeFileSync(resolve(candidate, 'objects/new.enc'), 'Fictional new candidate ciphertext');
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const original = captureUnlockPhysicalWitness(root, witness);
  const db = new DatabaseSync(witness, { readOnly: true });
  const originalRows = db.prepare('SELECT * FROM physical ORDER BY path').all();
  db.close();
  return { base, root, candidate, witness, original, originalRows };
}
function unchangedOriginalRows(f: ReturnType<typeof fixture>) {
  const db = new DatabaseSync(f.witness, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT * FROM physical ORDER BY path').all(), f.originalRows);
  } finally {
    db.close();
  }
}
test('owned setup overlay preserves original rows and certifies only exact complete new ciphertext', (t) => {
  const f = fixture(t),
    candidate = readFileSync(resolve(f.candidate, 'objects/new.enc'));
  const staged = stageSetupImmutableAdditions(f.root, f.candidate, f.witness, f.original);
  assert.deepEqual(readFileSync(resolve(f.root, 'objects/new.enc')), candidate);
  assert.equal(verifyUnlockPhysicalWitness(f.root, f.witness, staged), staged.entries);
  unchangedOriginalRows(f);
});
test('owned setup output cannot overwrite a competing newly installed filename', (t) => {
  const f = fixture(t),
    target = resolve(f.root, 'objects/new.enc'),
    raw = fs.openSync;
  const mocked = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof raw>) => {
    if (String(args[0]) === target && args[1] === 'wx')
      writeFileSync(target, 'Fictional competing ciphertext');
    return raw(...args);
  }) as typeof raw);
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => stageSetupImmutableAdditions(f.root, f.candidate, f.witness, f.original),
      /EEXIST/,
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(target, 'utf8'), 'Fictional competing ciphertext');
  unchangedOriginalRows(f);
});
test('owned setup overlay refuses a parent directory replaced after output creation', (t) => {
  const f = fixture(t),
    parent = resolve(f.root, 'objects'),
    raw = fs.openSync;
  let swapped = false;
  const mocked = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof raw>) => {
    if (String(args[0]) === parent && args[1] === 'r' && !swapped) {
      swapped = true;
      renameSync(parent, resolve(f.base, 'retired'));
      mkdirSync(parent);
    }
    return raw(...args);
  }) as typeof raw);
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => stageSetupImmutableAdditions(f.root, f.candidate, f.witness, f.original),
      /publication changed/,
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  unchangedOriginalRows(f);
});
test('manifest overlay refuses root metadata changed after the exact owned rename receipt', (t) => {
  const f = fixture(t),
    staged = stageSetupImmutableAdditions(f.root, f.candidate, f.witness, f.original);
  renameSync(resolve(f.candidate, 'manifest.enc'), resolve(f.root, 'manifest.enc'));
  const manifestIdentity = unlockPhysicalIdentity(resolve(f.root, 'manifest.enc')).value,
    ownedRoot = unlockPhysicalIdentity(f.root).value;
  mkdirSync(resolve(f.root, 'foreign'));
  assert.throws(
    () => finishSetupManifestWitness(f.root, f.witness, staged, manifestIdentity, ownedRoot),
    /publication changed/,
  );
  unchangedOriginalRows(f);
});
