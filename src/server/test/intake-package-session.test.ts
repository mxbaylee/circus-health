import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachRecordDurability, type RecordStorage } from '../record-versions.ts';
import {
  clearPackageSourceSession,
  packageSessionAssertionPrerequisites,
  packageSessionOriginalPhysicalSource,
  packageSourceSessionWork,
  withPackageSessionSource,
} from '../intake-package-session.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-source-session-'));
  const profileId = 'cookie-dough';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  const id = 'fictional-source';
  const bytes = Buffer.alloc(700000, 'fictional source');
  const path = paths.relativeRoot + '/sources/fictional.zip';
  writeFileSync(join(root, path), bytes);
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(
    id,
    path,
    createHash('sha256').update(bytes).digest('hex'),
    bytes.length,
    'intake_original',
    '{}',
  );
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read: (key) => objects.get(key) ?? null,
    writeImmutable: (key, value) => {
      assert.ok(!objects.has(key));
      objects.set(key, Buffer.from(value));
    },
    publishHead: (value) => {
      objects.set('head', Buffer.from(value));
    },
  };
  t.after(() => {
    clearPackageSourceSession(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { context: { db, root, profileId, id }, bytes, storage };
}

test('terminal session issuer exposes only active exact lease assertions and original dependencies', async (t) => {
  const { context, storage } = fixture(t);
  attachRecordDurability(context.db, { profileId: context.profileId, storage });
  let runningChecks = 0;
  let publicationChecks = 0;
  const assertRunning = () => {
    runningChecks++;
  };
  const assertPublicationCurrent = () => {
    publicationChecks++;
  };
  let expired: (() => void) | undefined;
  await assert.rejects(
    withPackageSessionSource(
      { ...context, assertRunning, assertPublicationCurrent },
      async (lease) => {
        expired = lease.assertPublicationCurrent;
        const checks = [runningChecks, publicationChecks];
        assert.deepEqual(packageSessionAssertionPrerequisites(lease.assertCurrent, context.db), [
          assertRunning,
          assertPublicationCurrent,
        ]);
        assert.deepEqual(
          packageSessionAssertionPrerequisites(lease.assertPublicationCurrent, context.db),
          [assertRunning, assertPublicationCurrent],
        );
        assert.deepEqual([runningChecks, publicationChecks], checks);
        const original = packageSessionOriginalPhysicalSource(
          lease.assertPublicationCurrent,
          context.db,
        );
        assert.ok(original);
        assert.equal(original.sourceFd, lease.sourceFd);
        assert.equal(
          original.acceptedPath,
          context.db.prepare('SELECT path FROM source_files WHERE id=?').get(context.id)?.path,
        );
        assert.notEqual(original.path, original.acceptedPath);
        assert.equal(original.binding.sourceHash, lease.binding.sourceHash);
        assert.equal(Object.isFrozen(original), true);
        assert.equal(Object.isFrozen(original.binding), true);
        assert.equal(
          packageSessionOriginalPhysicalSource(lease.assertCurrent, context.db),
          original,
        );
        assert.equal(
          packageSessionAssertionPrerequisites(() => lease.assertPublicationCurrent(), context.db),
          undefined,
        );
        const foreign = new DatabaseSync(':memory:');
        try {
          assert.equal(
            packageSessionAssertionPrerequisites(lease.assertPublicationCurrent, foreign),
            undefined,
          );
        } finally {
          foreign.close();
        }
        clearPackageSourceSession(context.db);
        assert.equal(
          packageSessionAssertionPrerequisites(lease.assertPublicationCurrent, context.db),
          undefined,
        );
        assert.equal(
          packageSessionOriginalPhysicalSource(lease.assertPublicationCurrent, context.db),
          undefined,
        );
      },
    ),
    { code: 'PROFILE_LOCKED' },
  );
  assert.equal(packageSessionAssertionPrerequisites(expired!, context.db), undefined);
});

test('session physical transport never recaptures a same-byte rewritten original', async (t) => {
  const { context, storage, bytes } = fixture(t);
  attachRecordDurability(context.db, { profileId: context.profileId, storage });
  const row = context.db.prepare('SELECT path FROM source_files WHERE id=?').get(context.id)!;
  const path = join(context.root, String(row.path));
  await assert.rejects(
    withPackageSessionSource(context, async (lease) => {
      const original = packageSessionOriginalPhysicalSource(
        lease.assertPublicationCurrent,
        context.db,
      );
      assert.ok(original);
      writeFileSync(path, bytes);
      assert.equal(
        packageSessionOriginalPhysicalSource(lease.assertPublicationCurrent, context.db),
        original,
      );
      assert.throws(() => lease.assertPublicationCurrent(), { code: 'SOURCE_CHANGED' });
    }),
    { code: 'SOURCE_CHANGED' },
  );
});

test('session cache survives accepted metadata edits but rejects changed source and scoped owner/lifecycle reuse', async (t) => {
  const { context, bytes, storage } = fixture(t);
  const { db } = context;
  await assert.rejects(
    withPackageSessionSource(context, async () => {}),
    { code: 'SOURCE_AUTHORITY' },
  );
  attachRecordDurability(db, { profileId: context.profileId, storage });
  await withPackageSessionSource(context, async (lease) => lease.assertCurrent());
  const snapshot = packageSourceSessionWork(db)!;
  assert.equal(snapshot.coldHashBytes, bytes.length);
  transaction(db, () =>
    db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run('{"fictional":"changed domain metadata"}', context.id),
  );
  await withPackageSessionSource(context, async (lease) => lease.assertCurrent());
  assert.equal(packageSourceSessionWork(db)!.coldHashBytes, bytes.length);
  assert.equal(packageSourceSessionWork(db)!.verificationCacheHits, 1);
  assert.equal(snapshot.verificationCacheHits, 0);
  await assert.rejects(
    withPackageSessionSource({ ...context, root: join(context.root, 'elsewhere') }, async () => {}),
    { code: 'PROFILE_BOUNDARY' },
  );
  await assert.rejects(
    withPackageSessionSource({ ...context, profileId: 'snickerdoodle' }, async () => {}),
    { code: 'PROFILE_BOUNDARY' },
  );
  await assert.rejects(
    withPackageSessionSource(context, async (lease) => {
      transaction(db, () =>
        db.prepare('UPDATE source_files SET bytes=? WHERE id=?').run(bytes.length + 1, context.id),
      );
      lease.assertCurrent();
    }),
    { code: 'SOURCE_CHANGED' },
  );
  transaction(db, () =>
    db.prepare('UPDATE source_files SET bytes=? WHERE id=?').run(bytes.length, context.id),
  );
  await withPackageSessionSource(context, async (lease) => lease.assertCurrent());
  await assert.rejects(
    withPackageSessionSource(context, async (lease) => {
      clearPackageSourceSession(db);
      lease.assertCurrent();
    }),
    { code: 'PROFILE_LOCKED' },
  );
  assert.equal(packageSourceSessionWork(db), null);
  await withPackageSessionSource(context, async (lease) => lease.assertCurrent());
  assert.equal(packageSourceSessionWork(db)!.coldHashBytes, bytes.length);
  await assert.rejects(
    withPackageSessionSource(context, async (lease) => {
      db.close();
      lease.assertCurrent();
    }),
    { code: 'PROFILE_LOCKED' },
  );
});

test('existing source session refuses a projection behind its accepted head', async (t) => {
  const { context, storage } = fixture(t);
  attachRecordDurability(context.db, { profileId: context.profileId, storage });
  await withPackageSessionSource(context, async (lease) => lease.assertCurrent());
  const oldHead = storage.read('head')!;
  transaction(context.db, () =>
    context.db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run('fictional_changed', '1'),
  );
  storage.publishHead(oldHead);
  await assert.rejects(
    withPackageSessionSource(context, async () => assert.fail('Dirty authority was consumed')),
    { code: 'SOURCE_AUTHORITY' },
  );
});

test('session materialization preserves the lexical final path so a same-byte symlink never reaches its consumer', async (t) => {
  const { context, storage } = fixture(t);
  attachRecordDurability(context.db, { profileId: context.profileId, storage });
  await withPackageSessionSource(context, async (lease) => lease.assertCurrent());
  const row = context.db.prepare('SELECT path FROM source_files WHERE id=?').get(context.id)!;
  const original = join(context.root, String(row.path));
  const moved = original + '.moved';
  renameSync(original, moved);
  symlinkSync(moved, original);
  await assert.rejects(
    withPackageSessionSource(context, async () => assert.fail('Symlink reached consumer')),
    { code: 'SOURCE_CHANGED' },
  );
});
