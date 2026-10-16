import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureUnlockPhysicalWitness,
  unlockPhysicalEntries,
  unlockPhysicalIdentity,
  verifyUnlockPhysicalWitness,
} from '../encrypted-unlock-physical.ts';

function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-physical-resolver-'))),
    evidence = join(root, 'evidence'),
    nested = join(evidence, 'nested'),
    file = join(nested, 'record');
  mkdirSync(nested, { recursive: true });
  writeFileSync(file, 'Independently fictional physical evidence.');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, evidence, nested, file };
}

test('native canonical resolution preserves the complete physical roster and witness', (t) => {
  const f = fixture(t),
    rows = [...unlockPhysicalEntries(f.evidence)];
  assert.deepEqual(rows.map((row) => row.path).sort(), ['', 'nested', 'nested/record']);
  for (const row of rows) {
    const path = join(f.evidence, row.path);
    assert.equal(realpathSync.native(path), realpathSync(path));
    assert.deepEqual(unlockPhysicalIdentity(path), { kind: row.kind, value: row.identity });
  }
  const scratch = join(f.root, 'witness.sqlite'),
    witness = captureUnlockPhysicalWitness(f.evidence, scratch);
  assert.equal(witness.entries, rows.length);
  assert.equal(verifyUnlockPhysicalWitness(f.evidence, scratch, witness), rows.length);
});

test('physical identity refuses endpoint links, ancestor links and noncanonical aliases', (t) => {
  const f = fixture(t),
    fileAlias = join(f.root, 'file-alias'),
    directoryAlias = join(f.root, 'directory-alias');
  symlinkSync(f.file, fileAlias);
  symlinkSync(f.evidence, directoryAlias);
  for (const path of [
    fileAlias,
    join(directoryAlias, 'nested', 'record'),
    f.nested + '/../nested/record',
  ])
    assert.throws(() => unlockPhysicalIdentity(path), /physical evidence changed/);
  assert.throws(() => [...unlockPhysicalEntries(directoryAlias)], /physical evidence changed/);
});

test('late resolver property replacement cannot admit an ancestor alias', (t) => {
  const f = fixture(t),
    alias = join(f.root, 'directory-alias'),
    descriptor = Object.getOwnPropertyDescriptor(realpathSync, 'native')!;
  symlinkSync(f.evidence, alias);
  let calls = 0;
  Object.defineProperty(realpathSync, 'native', {
    ...descriptor,
    value: (path: string) => {
      calls++;
      return path;
    },
  });
  try {
    assert.throws(
      () => unlockPhysicalIdentity(join(alias, 'nested', 'record')),
      /physical evidence changed/,
    );
    assert.equal(unlockPhysicalIdentity(f.file).kind, 'file');
    assert.equal(calls, 0, 'physical proof uses its captured original resolver');
  } finally {
    Object.defineProperty(realpathSync, 'native', descriptor);
  }
});

test('physical identity refuses a hard-linked file without changing ordinary file support', (t) => {
  const f = fixture(t),
    alias = join(f.root, 'hard-link');
  linkSync(f.file, alias);
  assert.throws(() => unlockPhysicalIdentity(alias), /physical evidence changed/);
  assert.throws(() => unlockPhysicalIdentity(f.file), /physical evidence changed/);
  rmSync(alias);
  assert.equal(unlockPhysicalIdentity(f.file).kind, 'file');
});

test('a same-byte replacement cannot satisfy the original physical witness', (t) => {
  const f = fixture(t),
    scratch = join(f.root, 'witness.sqlite'),
    witness = captureUnlockPhysicalWitness(f.evidence, scratch),
    replacement = join(f.root, 'replacement');
  writeFileSync(replacement, 'Independently fictional physical evidence.');
  renameSync(replacement, f.file);
  assert.throws(
    () => verifyUnlockPhysicalWitness(f.evidence, scratch, witness),
    /physical evidence changed/,
  );
});

test('an ancestor replacement by a symlink cannot satisfy the original physical witness', (t) => {
  const f = fixture(t),
    scratch = join(f.root, 'witness.sqlite'),
    witness = captureUnlockPhysicalWitness(f.evidence, scratch),
    moved = join(f.root, 'moved');
  renameSync(f.nested, moved);
  symlinkSync(moved, f.nested);
  assert.throws(
    () => verifyUnlockPhysicalWitness(f.evidence, scratch, witness),
    /physical evidence changed/,
  );
});
