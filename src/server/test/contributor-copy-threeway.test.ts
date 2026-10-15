import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import type { Database } from '../database.ts';
import { openDatabase, transaction } from '../database.ts';
import { createProfileLifecycle } from '../profile-lifecycle.ts';
import { intakeCopyNativeSqlite } from '../intake-copy-native-sqlite.ts';
import {
  contributorCopyComparisonTraversalWork,
  disposeContributorCopyCertification,
  prepareContributorCopyCertification,
} from '../contributor-durability.ts';

test('backup comparison serializes each of three complete row sets once', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-threeway-copy-'));
  const databases = new Map<string, Database>();
  const lifecycle = createProfileLifecycle({ root, databases });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const profile = await lifecycle.create({
    name: 'Fictional three-way source',
    fullName: 'Fictional three-way source',
    birthDate: '1980-02-17',
  });
  const source = databases.get(profile.id)!;
  transaction(source, () => {
    const insert = source.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)');
    for (let index = 0; index < 4; index++)
      insert.run('fictional:threeway:' + index, 'Independently fictional value ' + index);
  });
  const path = join(root, 'fictional-backup.sqlite');
  await backup(source, path);
  const copied = openDatabase(path, profile.id);
  try {
    const withBackup = await prepareContributorCopyCertification(source, root, profile.id, copied);
    try {
      const work = contributorCopyComparisonTraversalWork(source);
      assert.ok(work.sourceRows > 0);
      assert.equal(work.selectedRows, work.sourceRows);
      assert.equal(work.backupRows, work.sourceRows);
      assert.ok(work.sourceRows > 1, 'the callback probes require multiple selected rows');
      assert.equal(work.sourceRows + work.selectedRows + work.backupRows, 3 * work.sourceRows);
    } finally {
      await disposeContributorCopyCertification(withBackup);
    }

    const withoutBackup = await prepareContributorCopyCertification(source, root, profile.id);
    try {
      const work = contributorCopyComparisonTraversalWork(source);
      assert.ok(work.sourceRows > 0);
      assert.equal(work.selectedRows, work.sourceRows);
      assert.equal(work.backupRows, 0);
    } finally {
      await disposeContributorCopyCertification(withoutBackup);
    }

    const native = intakeCopyNativeSqlite();
    const read = native.blobRead;
    const controller = new AbortController();
    let cancelled = false;
    native.blobRead = (...args) => {
      if (!cancelled && contributorCopyComparisonTraversalWork(source).selectedRows > 0) {
        cancelled = true;
        controller.abort(Error('Fictional three-way comparison cancellation'));
      }
      return read(...args);
    };
    try {
      await assert.rejects(
        prepareContributorCopyCertification(source, root, profile.id, copied, controller.signal),
        /Fictional three-way comparison cancellation/,
      );
      assert.equal(cancelled, true);
    } finally {
      native.blobRead = read;
    }

    copied
      .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
      .run('fictional:copy-divergence', 'Fictional changed copy');
    await assert.rejects(
      prepareContributorCopyCertification(source, root, profile.id, copied),
      /conflicts with selected record authority/,
    );
    const refused = contributorCopyComparisonTraversalWork(source);
    assert.ok(refused.selectedRows > 0);
    assert.ok(refused.sourceRows > 0);
    assert.ok(refused.backupRows > 0);

    const secondPath = join(root, 'fictional-source-advance-backup.sqlite');
    await backup(source, secondPath);
    const secondCopy = openDatabase(secondPath, profile.id);
    try {
      let advanced = false;
      native.blobRead = (...args) => {
        if (!advanced && contributorCopyComparisonTraversalWork(source).selectedRows > 0) {
          advanced = true;
          source
            .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
            .run('fictional:mid-comparison', 'Fictional source advance');
        }
        return read(...args);
      };
      try {
        await assert.rejects(
          prepareContributorCopyCertification(source, root, profile.id, secondCopy),
          /changed|conflicts with selected record authority/,
        );
        assert.equal(advanced, true);
      } finally {
        native.blobRead = read;
      }
    } finally {
      secondCopy.close();
    }
  } finally {
    copied.close();
  }
});
