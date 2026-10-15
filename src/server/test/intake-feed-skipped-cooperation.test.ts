import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { envelope } from './intake-identity-native-fixture.ts';
import { prepareCollectionQueueRead } from '../intake-queue-native.ts';
import {
  readCollectionImportFeed,
  clearCollectionImportFeeds,
} from '../intake-import-feed-collection.ts';
import { clearCollectionReportQueues } from '../intake-report-group-collection.ts';

test(
  'native feed yields across filtered-out groups without inventing visible records',
  { timeout: 300_000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fictional-filtered-feed-'))),
      profileId = 'fictional-filtered-feed',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    t.after(() => {
      clearCollectionImportFeeds(db);
      clearCollectionReportQueues(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional-many-groups.jsonl',
      bytes: Buffer.from(
        Array.from({ length: 65 }, (_, index) => {
          const value = envelope(`fictional-${index}`);
          return JSON.stringify({
            ...value,
            report: {
              ...value.report,
              anchor: {
                locator: `page ${index + 1} heading`,
                text: `Fictional report ${index + 1}`,
              },
            },
          });
        }).join('\n'),
      ),
    });
    await buildIntakeCollectionEnvelope(db, { id: source.id });
    await prepareCollectionQueueRead(db, root, profileId);
    const prepare = DatabaseSync.prototype.prepare,
      iterate = StatementSync.prototype.iterate,
      selected = new WeakSet<StatementSync>();
    let read = 0,
      firstTurn = -1;
    t.after(() => {
      DatabaseSync.prototype.prepare = prepare;
      StatementSync.prototype.iterate = iterate;
    });
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = prepare.call(this, sql);
      if (
        sql.startsWith('SELECT g.* FROM groupVisibility v JOIN groups g') &&
        sql.includes(' AND v.intake=?') &&
        !sql.includes('LIMIT')
      )
        selected.add(statement);
      return statement;
    };
    StatementSync.prototype.iterate = function (
      this: StatementSync,
      ...args: Parameters<StatementSync['iterate']>
    ) {
      const iterator = Reflect.apply(iterate, this, args);
      if (!selected.has(this)) return iterator;
      const next = iterator.next.bind(iterator);
      iterator.next = (...input: Parameters<typeof next>) => {
        const row = next(...input);
        if (!row.done) {
          if (++read === 1)
            setImmediate(() => {
              firstTurn = read;
            });
        }
        return row;
      };
      return iterator;
    } as typeof StatementSync.prototype.iterate;
    const result = await readCollectionImportFeed(db, root, profileId, {
      groupId: 'fictional-nonmatching-group',
    });
    assert.equal(result.totalRecords, 0);
    assert.equal(result.records.length, 0);
    assert.equal(read, 65);
    assert.ok(
      firstTurn > 0 && firstTurn <= 64,
      `read ${firstTurn} filtered-out groups before a host turn`,
    );
  },
);
