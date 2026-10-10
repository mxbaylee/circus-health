import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openDatabase, transaction } from '../database.ts';
import { freshKey } from '../vault-crypto.ts';
import {
  openVault,
  captureVaultRecordStaging,
  stageVaultRecordObject,
  vaultRecordStagingCurrent,
  discardVaultRecordStaging,
} from '../vault-store.ts';
import {
  captureManagedPhysicalEpoch,
  withManagedPhysicalMutation,
} from '../clinical-review-physical-epoch.ts';

function reference(bytes: Buffer) {
  return {
    name: 'objects/' + randomUUID(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-record-staging-'));
  const db = openDatabase(':memory:', 'fictional-staging');
  const key = freshKey();
  const vault = openVault({
    directory: root,
    profileId: 'fictional-staging',
    key,
    initialize: true,
  });
  const storage = vault.recordStorage();
  const retainedBytes = Buffer.from('Independently fictional prior immutable object.');
  const retained = { bytes: retainedBytes, ref: reference(retainedBytes) };
  storage.writeImmutable(retained.ref.name, retained.bytes);
  t.after(() => {
    vault.close();
    key.fill(0);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const capture = () => captureVaultRecordStaging(db, storage, captureManagedPhysicalEpoch()!)!;
  return { root, db, vault, storage, capture, retained };
}

test('actual vault staging admits only exact fresh objects in its original private continuation', (t) => {
  const { root, db, storage, capture, retained } = fixture(t);
  const bytes = Buffer.from('Independently fictional immutable record object.'),
    ref = reference(bytes);
  const own = capture(),
    other = capture();
  transaction(db, () => {
    stageVaultRecordObject(own, ref, bytes);
    assert.equal(vaultRecordStagingCurrent(own), true);
    assert.equal(
      vaultRecordStagingCurrent(other),
      false,
      'foreign own-write credit is not adopted',
    );
    assert.throws(() => stageVaultRecordObject(other, reference(bytes), bytes), /expired/);
    assert.deepEqual(storage.read(ref.name), bytes);
    stageVaultRecordObject(own, reference(bytes), bytes);
    assert.equal(vaultRecordStagingCurrent(own), true);
    assert.equal(storage.read('head'), null, 'staging never selects an accepted head');
  });
  assert.equal(vaultRecordStagingCurrent(own), false, 'transaction exit expires the transport');
  assert.equal(readdirSync(join(root, 'vault/versions')).length, 3);
  assert.deepEqual(storage.read(retained.ref.name), retained.bytes);
  assert.equal(
    captureVaultRecordStaging(db, { ...storage }, captureManagedPhysicalEpoch()!),
    undefined,
  );
  discardVaultRecordStaging(own);
});

test('vault staging never replaces existing targets and refuses wrong bytes or managed ABA', (t) => {
  const { root, db, storage, capture, retained } = fixture(t);
  const { bytes, ref } = retained;
  const existing = capture();
  assert.throws(
    () => transaction(db, () => stageVaultRecordObject(existing, ref, bytes)),
    /EEXIST/,
  );
  assert.deepEqual(storage.read(ref.name), bytes);
  assert.equal(vaultRecordStagingCurrent(existing), false);
  assert.equal(
    readdirSync(join(root, 'vault/versions')).length,
    1,
    'only our pending file is removed',
  );
  const wrong = capture();
  assert.throws(
    () =>
      transaction(db, () =>
        stageVaultRecordObject(wrong, reference(bytes), Buffer.from('changed')),
      ),
    /reference changed/,
  );
  assert.equal(vaultRecordStagingCurrent(wrong), false);
  const aba = capture();
  withManagedPhysicalMutation(() => {
    const path = join(root, 'fictional-unselected');
    writeFileSync(path, 'fictional');
    rmSync(path);
  });
  assert.equal(vaultRecordStagingCurrent(aba), false);
  assert.throws(
    () => transaction(db, () => stageVaultRecordObject(aba, reference(bytes), bytes)),
    /expired/,
  );
});

test('vault staging refuses changed methods and redirected parents without adopting their namespace', (t) => {
  const { root, db, storage, capture } = fixture(t);
  const bytes = Buffer.from('Independently fictional no-redirect control.');
  const changed = capture(),
    read = storage.read;
  storage.read = (name) => read(name);
  assert.equal(vaultRecordStagingCurrent(changed), false);
  assert.throws(capture, /owner changed/);
  storage.read = read;
  const parent = capture();
  const versions = join(root, 'vault/versions'),
    original = versions + '.original';
  renameSync(versions, original);
  symlinkSync(original, versions);
  try {
    assert.throws(
      () => transaction(db, () => stageVaultRecordObject(parent, reference(bytes), bytes)),
      /parent changed/,
    );
    assert.equal(readdirSync(original).length, 1);
  } finally {
    rmSync(versions);
    renameSync(original, versions);
  }
  assert.equal(
    vaultRecordStagingCurrent(parent),
    false,
    'a refused redirected parent cannot be renewed',
  );
});

test('vault staging refuses a deterministic no-replace race without overwriting the competing ciphertext', (t) => {
  const { root, db, storage, capture, retained } = fixture(t);
  const bytes = Buffer.from('Independently fictional racing immutable object.'),
    ref = reference(bytes);
  const witness = capture(),
    link = fs.linkSync;
  const target = join(root, 'vault/versions', ref.name.slice(8) + '.enc');
  const competing = fs.readFileSync(
    join(root, 'vault/versions', retained.ref.name.slice(8) + '.enc'),
  );
  let raced = false;
  fs.linkSync = (from, to) => {
    if (String(to) === target) {
      raced = true;
      fs.writeFileSync(target, competing, { flag: 'wx' });
    }
    return link(from, to);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => transaction(db, () => stageVaultRecordObject(witness, ref, bytes)),
      /EEXIST/,
    );
  } finally {
    fs.linkSync = link;
    syncBuiltinESMExports();
  }
  assert.equal(raced, true);
  assert.deepEqual(fs.readFileSync(target), competing);
  assert.deepEqual(storage.read(retained.ref.name), retained.bytes);
  assert.equal(vaultRecordStagingCurrent(witness), false);
  assert.equal(storage.read('head'), null);
});

test('vault staging revokes successful installation when directory durability fails', (t) => {
  const { root, db, storage, capture } = fixture(t);
  const bytes = Buffer.from('Independently fictional failed directory synchronization.'),
    ref = reference(bytes);
  const witness = capture(),
    fsync = fs.fsyncSync;
  let failed = false;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory()) {
      failed = true;
      throw Error('fictional directory fsync failure');
    }
    return fsync(fd);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => transaction(db, () => stageVaultRecordObject(witness, ref, bytes)),
      /directory fsync failure/,
    );
  } finally {
    fs.fsyncSync = fsync;
    syncBuiltinESMExports();
  }
  assert.equal(failed, true);
  assert.equal(vaultRecordStagingCurrent(witness), false);
  assert.equal(storage.read('head'), null);
  assert.deepEqual(storage.read(ref.name), bytes, 'the installed orphan is unselected');
  assert.equal(
    readdirSync(join(root, 'vault/versions')).some((name) => name.includes('.pending-')),
    false,
  );
});

test('vault staging refuses nested unknown managed attempts instead of adopting their epoch', (t) => {
  const { db, storage, capture } = fixture(t);
  const bytes = Buffer.from('Independently fictional nested mutation attempt.'),
    ref = reference(bytes);
  const witness = capture(),
    read = fs.readSync;
  let nested = false;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    if (!nested) {
      nested = true;
      withManagedPhysicalMutation(() => undefined);
    }
    return (read as (...input: Parameters<typeof fs.readSync>) => number)(...args);
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => transaction(db, () => stageVaultRecordObject(witness, ref, bytes)),
      /unknown mutation/,
    );
  } finally {
    fs.readSync = read;
    syncBuiltinESMExports();
  }
  assert.equal(nested, true);
  assert.equal(vaultRecordStagingCurrent(witness), false);
  assert.equal(storage.read('head'), null);
});
