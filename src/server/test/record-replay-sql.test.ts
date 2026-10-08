/** Replay-only work regression; the full HTTP/encrypted acceptance gate remains separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction, type Database } from '../database.ts';
import { rebuildRecordDatabase, queryRecordHistory } from '../record-versions.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

const snapshot = (db: Database) =>
  [
    'people',
    '__record_versions',
    '__record_current',
    '__record_fields',
    '__record_transactions',
    '__record_state',
  ].map((table) => [
    table,
    db
      .prepare(`SELECT * FROM "${table}"`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort(),
  ]);

for (const count of [4, 64])
  test(`replay prepares row SQL per table/transaction rather than per version: ${count} people`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-replay-sql-'));
    const profileId = 'fictional-replay-sql';
    const db = openDatabase(join(root, 'source.sqlite'), profileId);
    const opened = [db];
    t.after(() => {
      for (const connection of opened) if (connection.isOpen) connection.close();
      rmSync(root, { recursive: true, force: true });
    });
    const authority = memoryRecordAuthority(db);
    transaction(db, () => {
      const insert = db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)');
      for (let i = 0; i < count; i++) insert.run(`fictional-person-${i}`, `Fictional person ${i}`);
    });
    transaction(db, () => {
      const update = db.prepare('UPDATE people SET display_name=? WHERE id=?');
      for (let i = 0; i < count; i++)
        update.run(`Revised fictional person ${i}`, `fictional-person-${i}`);
    });
    transaction(db, () => db.prepare('DELETE FROM people WHERE id=?').run('fictional-person-0'));
    const expected = snapshot(db);
    const history = queryRecordHistory(db, {
      profileId,
      entity: 'people',
      recordId: 'fictional-person-0',
    });
    assert.deepEqual(
      history.entries.map((entry) => entry.deleted),
      [true, false, false],
    );
    const archiveHash = () => {
      const hash = createHash('sha256');
      for (const [name, bytes] of [...authority.objects].sort(([a], [b]) => a.localeCompare(b)))
        hash.update(name).update(bytes);
      return hash.digest('hex');
    };
    const originalArchive = archiveHash();
    // Two independent cold rebuilds from exactly the same accepted archive.
    // No cross-connection cache or successful first replay may authorize the second.
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = { remove: 0, insert: 0 };
      const executed = { remove: 0, insert: 0 };
      const scratch = {
        ancestry: { inserts: 0, outsideTransaction: 0, connections: 0 },
        segments: { inserts: 0, outsideTransaction: 0, connections: 0 },
      };
      const scratchConnections: Array<{ db: DatabaseSync; path: string }> = [];
      const prepare = DatabaseSync.prototype.prepare;
      const probe = t.mock.method(
        DatabaseSync.prototype,
        'prepare',
        function (this: DatabaseSync, sql: string) {
          const statement = prepare.call(this, sql);
          const scratchKind =
            sql === 'INSERT INTO ancestry VALUES(?,?,?)'
              ? 'ancestry'
              : sql === 'INSERT INTO segments VALUES(?,?)'
                ? 'segments'
                : undefined;
          if (scratchKind) {
            const connection = this;
            const work = scratch[scratchKind];
            work.connections++;
            scratchConnections.push({ db: connection, path: connection.location()! });
            const run = statement.run;
            statement.run = (...args: unknown[]) => {
              work.inserts++;
              if (!connection.isTransaction) work.outsideTransaction++;
              return Reflect.apply(run, statement, args) as ReturnType<typeof run>;
            };
          }
          const kind =
            sql === 'DELETE FROM "people" WHERE "id"=?'
              ? 'remove'
              : sql.startsWith('INSERT INTO "people" (')
                ? 'insert'
                : undefined;
          if (kind) {
            prepared[kind]++;
            const run = statement.run;
            statement.run = (...args: unknown[]) => {
              executed[kind]++;
              return Reflect.apply(run, statement, args) as ReturnType<typeof run>;
            };
          }
          return statement;
        },
      );
      const work = createRecordVersionWorkCounters();
      const path = join(root, `rebuilt-${attempt}.sqlite`);
      try {
        withRecordVersionWork(work, () =>
          rebuildRecordDatabase(path, { profileId, storage: authority.storage }),
        );
      } finally {
        probe.mock.restore();
      }
      const measuredScratch = structuredClone(scratch);
      assert.ok(scratchConnections.length > 0, 'the real disk-backed ordering indexes were used');
      for (const connection of scratchConnections) {
        assert.equal(connection.db.isOpen, false, 'scratch never outlives its traversal');
        assert.equal(existsSync(connection.path), false, 'scratch is deleted after consumption');
      }
      const rebuilt = openDatabase(path, profileId);
      opened.push(rebuilt);
      authority.attach(rebuilt);
      assert.deepEqual(snapshot(rebuilt), expected, 'all current and historical rows remain exact');
      assert.deepEqual(
        queryRecordHistory(rebuilt, {
          profileId,
          entity: 'people',
          recordId: 'fictional-person-0',
        }),
        history,
        'tombstones and predecessor/field history survive cold replay',
      );
      assert.equal(archiveHash(), originalArchive, 'replay never rewrites its accepted archive');
      assert.deepEqual(executed, { remove: 2 * count + 2, insert: 2 * count + 1 });
      assert.equal(
        work.reconstruction.versionValidations,
        2 * work.reconstruction.indexedVersionAttempts,
      );
      assert.equal(
        work.reconstruction.replayDeleteAttempts,
        work.reconstruction.indexedVersionAttempts,
      );
      t.diagnostic(
        JSON.stringify({
          count,
          attempt,
          prepared,
          executed,
          scratch: measuredScratch,
          work: work.reconstruction,
        }),
      );
      assert.equal(measuredScratch.ancestry.inserts, work.reconstruction.ancestryReferencesSpooled);
      assert.equal(measuredScratch.segments.inserts, work.reconstruction.segmentReferencesSpooled);
      for (const kind of ['ancestry', 'segments'] as const) {
        assert.ok(measuredScratch[kind].inserts > 0);
        assert.equal(
          measuredScratch[kind].outsideTransaction,
          0,
          kind + ': ordering-index inserts share one private transaction per traversal',
        );
      }
      assert.deepEqual(
        prepared,
        { remove: 4, insert: 3 },
        'one statement per touched table/transaction and replay phase',
      );
    }
  });
