import assert from 'node:assert/strict';
import {
  closeSync,
  linkSync as rawLinkSync,
  mkdtempSync,
  realpathSync,
  renameSync as rawRenameSync,
  rmSync,
  symlinkSync,
  writeFileSync as rawWriteFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import {
  captureManagedPhysicalScope,
  managedPhysicalScopeCurrent,
} from '../clinical-review-physical-epoch.ts';
import {
  linkSync,
  linkExclusiveJournalFileSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeExclusiveJournalFileSync,
} from '../journal-physical-write.ts';

test('journal writes outside an original record backing do not revoke its scoped witness', (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-journal-scope-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const record = join(base, 'record');
  const journal = join(base, 'journal');
  mkdirSync(record);
  mkdirSync(journal);
  const original = captureManagedPhysicalScope(record);
  assert.ok(original);

  const batch = join(journal, 'batch');
  mkdirSync(batch);
  const source = join(batch, 'source');
  writeFileSync(relative(process.cwd(), source), 'fictional journal');
  const fd = openSync(join(batch, 'opened'), 'w');
  closeSync(fd);
  const staged = writeExclusiveJournalFileSync(join(batch, 'exclusive'), 'fictional journal');
  linkExclusiveJournalFileSync(staged, join(batch, 'installed'));
  renameSync(join(batch, 'installed'), join(batch, 'renamed'));
  unlinkSync(join(batch, 'renamed'));
  assert.equal(managedPhysicalScopeCurrent(original), true);

  const predecessor = join(record, 'predecessor');
  writeFileSync(predecessor, 'fictional original');
  const sameByte = captureManagedPhysicalScope(record);
  assert.ok(sameByte);
  writeFileSync(predecessor, 'fictional original');
  assert.equal(managedPhysicalScopeCurrent(sameByte), false);
});

test('exclusive journal installation is one-use and fails closed on duplicate destinations', (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-journal-duplicate-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const record = join(base, 'record');
  const journal = join(base, 'journal');
  mkdirSync(record);
  mkdirSync(journal);
  const original = captureManagedPhysicalScope(record);
  assert.ok(original);
  const temporary = join(journal, 'temporary');
  const destination = join(journal, 'existing');
  writeFileSync(destination, 'fictional existing');
  const staged = writeExclusiveJournalFileSync(temporary, 'fictional journal');
  assert.throws(() => linkExclusiveJournalFileSync(staged, destination), { code: 'EEXIST' });
  assert.equal(managedPhysicalScopeCurrent(original), false);
  unlinkSync(temporary);
  assert.throws(() => linkExclusiveJournalFileSync(staged, join(journal, 'reused')));
});

test('exclusive install rejects same-byte overwrite and path replacement before link', (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-journal-stale-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const record = join(base, 'record');
  const journal = join(base, 'journal');
  mkdirSync(record);
  mkdirSync(journal);

  const first = join(journal, 'first');
  const sameByte = writeExclusiveJournalFileSync(first, 'fictional journal');
  const original = captureManagedPhysicalScope(record);
  assert.ok(original);
  rawWriteFileSync(first, 'fictional journal');
  assert.throws(
    () => linkExclusiveJournalFileSync(sameByte, join(journal, 'first-installed')),
    /changed before installation/,
  );
  assert.equal(managedPhysicalScopeCurrent(original), false);

  const second = join(journal, 'second');
  const replaced = writeExclusiveJournalFileSync(second, 'fictional journal');
  const replacement = captureManagedPhysicalScope(record);
  assert.ok(replacement);
  rawRenameSync(second, join(journal, 'old-second'));
  rawWriteFileSync(second, 'fictional journal');
  assert.throws(
    () => linkExclusiveJournalFileSync(replaced, join(journal, 'second-installed')),
    /changed before installation/,
  );
  assert.equal(managedPhysicalScopeCurrent(replacement), false);
});

test('journal paths cover aliases, both endpoints and ancestor renames', (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-journal-alias-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const record = join(base, 'record');
  const journal = join(base, 'journal');
  mkdirSync(record);
  mkdirSync(journal);
  symlinkSync(record, join(base, 'alias'));
  const predecessor = join(record, 'predecessor');
  writeFileSync(predecessor, 'fictional original');

  const alias = captureManagedPhysicalScope(record);
  assert.ok(alias);
  writeFileSync(join(base, 'alias', 'predecessor'), 'fictional original');
  assert.equal(managedPhysicalScopeCurrent(alias), false);

  const source = captureManagedPhysicalScope(record);
  assert.ok(source);
  linkSync(predecessor, join(journal, 'linked'));
  assert.equal(managedPhysicalScopeCurrent(source), false);

  const destination = captureManagedPhysicalScope(record);
  assert.ok(destination);
  renameSync(join(journal, 'linked'), join(record, 'linked'));
  assert.equal(managedPhysicalScopeCurrent(destination), false);

  const ancestor = captureManagedPhysicalScope(record);
  assert.ok(ancestor);
  renameSync(record, join(base, 'moved'));
  assert.equal(managedPhysicalScopeCurrent(ancestor), false);
});

test('a preexisting hard link cannot disguise a record predecessor as a journal path', (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-journal-hardlink-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const record = join(base, 'record');
  const journal = join(base, 'journal');
  mkdirSync(record);
  mkdirSync(journal);
  const predecessor = join(record, 'predecessor');
  writeFileSync(predecessor, 'fictional original');
  const alias = join(journal, 'alias');
  rawLinkSync(predecessor, alias);
  const original = captureManagedPhysicalScope(record);
  assert.ok(original);
  writeFileSync(alias, 'fictional original');
  assert.equal(managedPhysicalScopeCurrent(original), false);
});

test('unsupported journal path operands stay unknown and revoke a scoped witness', (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-journal-unknown-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const record = join(base, 'record');
  const journal = join(base, 'journal');
  mkdirSync(record);
  mkdirSync(journal);
  const destination = join(journal, 'source');

  const bufferPath = captureManagedPhysicalScope(record);
  assert.ok(bufferPath);
  writeFileSync(Buffer.from(destination), 'fictional journal');
  assert.equal(managedPhysicalScopeCurrent(bufferPath), false);

  const urlPath = captureManagedPhysicalScope(record);
  assert.ok(urlPath);
  writeFileSync(new URL(`file://${destination}`), 'fictional journal');
  assert.equal(managedPhysicalScopeCurrent(urlPath), false);

  const fd = openSync(destination, 'r+');
  try {
    const descriptor = captureManagedPhysicalScope(record);
    assert.ok(descriptor);
    writeFileSync(fd, 'fictional journal');
    assert.equal(managedPhysicalScopeCurrent(descriptor), false);
  } finally {
    closeSync(fd);
  }

  const exclusive = join(journal, 'exclusive');
  const opened = openSync(exclusive, 'wx');
  closeSync(opened);
  const reused = captureManagedPhysicalScope(record);
  assert.ok(reused);
  const reopened = openSync(exclusive, 'r+');
  try {
    writeFileSync(reopened, 'fictional journal');
    assert.equal(managedPhysicalScopeCurrent(reused), false);
  } finally {
    closeSync(reopened);
  }
});

test('an exclusive journal pathname replacement fails closed after opening', (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-journal-replace-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const record = join(base, 'record');
  const journal = join(base, 'journal');
  mkdirSync(record);
  mkdirSync(journal);
  const original = captureManagedPhysicalScope(record);
  assert.ok(original);
  const pathname = join(journal, 'exclusive');
  const moved = join(journal, 'moved');
  const native = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const write = native.writeFileSync;
  native.writeFileSync = ((fd: number, data: string | Buffer) => {
    native.renameSync(pathname, moved);
    return write(fd, data);
  }) as typeof native.writeFileSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => writeExclusiveJournalFileSync(pathname, 'fictional journal'),
      /changed during exclusive write/,
    );
    assert.equal(managedPhysicalScopeCurrent(original), false);
  } finally {
    native.writeFileSync = write;
    syncBuiltinESMExports();
  }
});
