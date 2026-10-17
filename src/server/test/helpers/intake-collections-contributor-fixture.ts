import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs, { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { StatementSync } from 'node:sqlite';
import { openDatabase, transaction, type Database } from '../../database.ts';
import { ensureProfileDirectories, profilePaths } from '../../profile-storage.ts';
import {
  openContributorRecordStorage,
  contributorAuthorityPath,
} from '../../contributor-record-storage.ts';
import { attachRecordDurability, rebuildRecordDatabase } from '../../record-versions.ts';
import {
  clearIntakeStateCache,
  createIntakeStateStorage,
  type IntakeCollectionChange,
} from '../../intake-state-storage.ts';

/** Genuine contributor authority and physical fictional original. No wrapper
 * supplies read-owner provenance, publication ownership or source authority. */
export function intakeCollectionsContributorFixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-collection-state-')));
  const profileId = 'fictional-collections';
  const paths = ensureProfileDirectories(root, profileId);
  const original = Buffer.from('Independently fictional collection original.\n');
  const identity = {
    profileId,
    intakeId: 'fictional-package',
    sourceHash: createHash('sha256').update(original).digest('hex'),
  };
  const path = profilePaths(root, profileId).relativeRoot + '/sources/fictional.zip';
  writeFileSync(join(root, path), original);
  const db = openDatabase(paths.database, profileId);
  const dbs: Database[] = [db];
  const storage = openContributorRecordStorage(root, profileId, { initialize: true });
  const headPath = join(contributorAuthorityPath(root, profileId), 'head');
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(identity.intakeId, path, identity.sourceHash, original.length, 'intake_original', '{}');
  attachRecordDurability(db, { profileId, storage });
  let restoreRename: (() => void) | undefined;
  t.after(() => {
    restoreRename?.();
    for (const item of dbs) {
      clearIntakeStateCache(item);
      if (item.isOpen) item.close();
    }
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    identity,
    rebuild() {
      const path = join(root, randomUUID() + '.sqlite');
      rebuildRecordDatabase(path, { profileId, storage });
      const next = openDatabase(path, profileId);
      attachRecordDurability(next, { profileId, storage });
      dbs.push(next);
      return next;
    },
    acceptedHead: () => storage.read('head') ?? undefined,
    ambiguous() {
      assert.equal(restoreRename, undefined, 'one publication fault per fixture');
      const nativeRename = fs.renameSync;
      let armed = true;
      const mock = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
        nativeRename(...args);
        if (armed && String(args[1]) === headPath) {
          armed = false;
          throw Error('fictional ambiguous publication');
        }
      });
      syncBuiltinESMExports();
      restoreRename = () => {
        mock.mock.restore();
        syncBuiltinESMExports();
      };
    },
  };
}

type Collections = ReturnType<typeof createIntakeStateStorage>['collections'];
export async function prepareCollectionMutation(
  store: Collections,
  view: Parameters<Collections['prepare']>[0],
  input: Parameters<Collections['prepare']>[1],
) {
  await store.admitCurrentLogAsync();
  try {
    return store.prepare(view, input);
  } finally {
    store.releaseLogAdmission();
  }
}

export async function mutateCollection(
  db: Database,
  store: Collections,
  changes: IntakeCollectionChange[],
  version: number,
  id = randomUUID(),
) {
  const prepared = await prepareCollectionMutation(store, store.openView(), {
    operationId: id,
    requestDigest: createHash('sha256').update(id).digest('hex'),
    domainVersion: version,
    changes,
  });
  return transaction(db, () => store.stage(prepared));
}

export async function withCollectionAdmission<T>(store: Collections, read: () => T): Promise<T> {
  await store.admitCurrentLogAsync();
  try {
    return read();
  } finally {
    store.releaseLogAdmission();
  }
}

/** Capture only this virgin owner's real metadata reader statements. Production
 * deliberately creates them through its captured native prepare method. Restore
 * the prototype before any codec admission/index exists; later probes are local
 * to these statements and cannot intercept the private log index. */
export function collectionStoreWithMetaReadProbe(
  t: TestContext,
  db: Database,
  identity: Parameters<typeof createIntakeStateStorage>[1],
  probe: (this: import('node:sqlite').StatementSync, ...args: unknown[]) => unknown,
) {
  const originalGet = StatementSync.prototype.get;
  const capture = t.mock.method(
    StatementSync.prototype,
    'get',
    function (this: StatementSync, ...args: unknown[]) {
      if (
        this.sourceSQL === 'SELECT value FROM main.app_meta WHERE key=?' ||
        this.sourceSQL.startsWith('SELECT length(CAST(value AS BLOB))')
      ) {
        Object.defineProperty(this, 'get', { configurable: true, writable: true, value: probe });
        return Reflect.apply(probe, this, args);
      }
      return Reflect.apply(originalGet, this, args);
    },
  );
  try {
    const storage = createIntakeStateStorage(db, identity);
    assert.equal(storage.read(), undefined, 'reader capture requires virgin selected state');
    storage.collections.openView();
    return storage.collections;
  } finally {
    capture.mock.restore();
  }
}
