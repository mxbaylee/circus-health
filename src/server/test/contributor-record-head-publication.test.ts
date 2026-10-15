import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { openDatabase } from '../database.ts';
import { attachRecordDurability } from '../record-versions.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  openContributorRecordStorage,
  contributorAuthorityPath,
  prepareContributorRecordHeadPublication,
  contributorRecordHeadPublicationCurrent,
  installContributorRecordHeadPublication,
  closeContributorRecordHeadPublication,
} from '../contributor-record-storage.ts';

function fixture(t: TestContext) {
  const root = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'fictional-contributor-head-publication-')),
    ),
    profileId = 'fictional',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    storage = openContributorRecordStorage(root, profileId, { initialize: true }),
    payload = Buffer.from('fictional immutable transport payload'),
    reference = {
      name: 'objects/' + randomUUID(),
      sha256: createHash('sha256').update(payload).digest('hex'),
      bytes: payload.length,
    };
  attachRecordDurability(db, { profileId, storage });
  storage.writeImmutable(reference.name, payload);
  t.after(() => {
    storage.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { storage, reference, head: join(contributorAuthorityPath(root, profileId), 'head') };
}

test('genuine contributor HEAD transport installs its fixed retained reference exactly once', (t) => {
  const f = fixture(t),
    cap = prepareContributorRecordHeadPublication(f.storage, f.reference)!;
  try {
    assert.ok(contributorRecordHeadPublicationCurrent(f.storage, cap));
    f.reference.sha256 = '0'.repeat(64);
    installContributorRecordHeadPublication(f.storage, cap);
    assert.notEqual(JSON.parse(readFileSync(f.head, 'utf8')).sha256, f.reference.sha256);
    assert.equal(contributorRecordHeadPublicationCurrent(f.storage, cap), false);
    assert.throws(() => installContributorRecordHeadPublication(f.storage, cap), /expired/);
  } finally {
    closeContributorRecordHeadPublication(cap);
  }
});

test('contributor HEAD transport refuses original same-byte rewrite and foreign adapter', (t) => {
  const f = fixture(t),
    original = readFileSync(f.head),
    cap = prepareContributorRecordHeadPublication(f.storage, f.reference)!;
  try {
    assert.equal(prepareContributorRecordHeadPublication({ ...f.storage }, f.reference), undefined);
    assert.equal(contributorRecordHeadPublicationCurrent({ ...f.storage }, cap), false);
    writeFileSync(f.head, original);
    assert.throws(() => installContributorRecordHeadPublication(f.storage, cap), /expired/);
    assert.deepEqual(readFileSync(f.head), original);
  } finally {
    closeContributorRecordHeadPublication(cap);
  }
});

test('contributor HEAD transport rejects public method getters without invoking them', (t) => {
  const f = fixture(t),
    original = readFileSync(f.head),
    publish = f.storage.publishHead,
    cap = prepareContributorRecordHeadPublication(f.storage, f.reference)!;
  let calls = 0;
  try {
    Object.defineProperty(f.storage, 'publishHead', {
      configurable: true,
      get() {
        calls++;
        writeFileSync(f.head, original);
        return publish;
      },
    });
    assert.throws(() => installContributorRecordHeadPublication(f.storage, cap), /expired/);
    assert.equal(calls, 0);
    assert.deepEqual(readFileSync(f.head), original);
  } finally {
    Object.defineProperty(f.storage, 'publishHead', {
      configurable: true,
      writable: true,
      value: publish,
    });
    closeContributorRecordHeadPublication(cap);
  }
});
