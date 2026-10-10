import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { openDatabase } from '../database.ts';
import {
  prepareTerminalStatements,
  withTerminalStatements,
} from '../database-terminal-statements.ts';
import {
  openContributorRecordStorage,
  contributorAuthorityPath,
} from '../contributor-record-storage.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  attachRecordDurability,
  captureRecordReadOwner,
  assertRecordReadOwnerBeforeVerification,
  assertRecordReadOwnerTerminal,
  assertRecordReadOwnerInterval,
  closeRecordReadOwner,
} from '../record-versions.ts';
import { freshKey } from '../vault-crypto.ts';
import { openVault } from '../vault-store.ts';

function contributor(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-record-read-owner-')),
    profileId = 'fictional',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    storage = openContributorRecordStorage(root, profileId, { initialize: true });
  attachRecordDurability(db, { profileId, storage });
  t.after(() => {
    storage.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    profileId,
    db,
    storage,
    head: join(contributorAuthorityPath(root, profileId), 'head'),
  };
}

test('original contributor read owner closes native SQL then survives only its original outer interval', (t) => {
  const f = contributor(t),
    owner = captureRecordReadOwner(f.db, f.profileId);
  try {
    const statements = prepareTerminalStatements(f.db, { statements: [] });
    // Arm private cached status after all real prepare-time authorization effects.
    assertRecordReadOwnerBeforeVerification(f.db, owner);
    withTerminalStatements(f.db, statements, () => assertRecordReadOwnerTerminal(f.db, owner));
    assertRecordReadOwnerInterval(f.db, owner);
    assert.throws(() => assertRecordReadOwnerTerminal(f.db, owner), /terminal authority/);
  } finally {
    closeRecordReadOwner(owner);
  }
  assert.throws(() => assertRecordReadOwnerInterval(f.db, owner), /interval changed/);
});

test('same-byte original contributor HEAD rewrite refuses without rereading a caller adapter', (t) => {
  const f = contributor(t),
    owner = captureRecordReadOwner(f.db, f.profileId),
    bytes = readFileSync(f.head);
  try {
    writeFileSync(f.head, bytes);
    assert.deepEqual(readFileSync(f.head), bytes);
    assert.throws(() => assertRecordReadOwnerInterval(f.db, owner), /interval changed/);
  } finally {
    closeRecordReadOwner(owner);
  }
});

test('original record read owner refuses an accessor without invoking it', (t) => {
  const f = contributor(t),
    owner = captureRecordReadOwner(f.db, f.profileId),
    original = f.storage.read,
    bytes = readFileSync(f.head);
  let getters = 0;
  try {
    Object.defineProperty(f.storage, 'read', {
      configurable: true,
      get() {
        getters++;
        writeFileSync(f.head, bytes);
        return original;
      },
    });
    assert.throws(() => assertRecordReadOwnerInterval(f.db, owner), /interval changed/);
    assert.equal(getters, 0);
    assert.deepEqual(readFileSync(f.head), bytes);
  } finally {
    Object.defineProperty(f.storage, 'read', {
      configurable: true,
      writable: true,
      value: original,
    });
    closeRecordReadOwner(owner);
  }
});

test('original actual-vault read owner binds its encrypted manifest and lexical lifetime', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-vault-read-owner-')),
    profileId = 'fictional',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    key = freshKey(),
    vault = openVault({ directory: paths.root, profileId, key, initialize: true }),
    storage = vault.recordStorage();
  attachRecordDurability(db, { profileId, storage });
  t.after(() => {
    vault.close();
    key.fill(0);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const owner = captureRecordReadOwner(db, profileId);
  try {
    const statements = prepareTerminalStatements(db, { statements: [] });
    assertRecordReadOwnerBeforeVerification(db, owner);
    withTerminalStatements(db, statements, () => assertRecordReadOwnerTerminal(db, owner));
    const manifest = join(paths.root, 'vault/manifest.enc'),
      bytes = readFileSync(manifest);
    writeFileSync(manifest, bytes);
    assert.throws(() => assertRecordReadOwnerInterval(db, owner), /interval changed/);
    assert.deepEqual(readFileSync(manifest), bytes);
  } finally {
    closeRecordReadOwner(owner);
  }
});
