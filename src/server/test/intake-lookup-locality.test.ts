import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { intakeLookupCounters } from '../intake-lookup-projection.ts';
import {
  maximumReportDiscoveryOrder,
  retainedReportAcceptance,
  intakeIdentityConfirmations,
} from '../intake-state-access.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
  writeIntakeFixtureEnvelope,
} from './helpers/intake-authority-fixture.ts';

test('front insertion, movement, removal and duplicate occurrence changes write bounded lookup rows', (t) => {
  const samples: unknown[] = [];
  for (const size of [20, 80, 160]) {
    const root = mkdtempSync(join(tmpdir(), 'fictional-lookup-locality-'));
    const db = openDatabase(join(root, 'cache.sqlite'), 'fictional-profile');
    const authority = memoryRecordAuthority(db);
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const item = (marker: number) => ({ marker, receipt: { operationId: `operation-${marker}` } });
    let values = Array.from({ length: size }, (_, i) => item(i));
    const envelope = () => ({
      intake: {
        workflow: {
          reportGroups: values.map(({ marker }) => ({ discoveryOrder: marker })),
          reportAcceptances: values,
          identityConfirmations: values,
        },
      },
    });
    registerRawIntakeFixture(db, 'one', JSON.stringify(envelope()));
    writeIntakeFixtureEnvelope(db, 'one', envelope());
    maximumReportDiscoveryOrder(db);
    const retained = new Map([...authority.objects].filter(([name]) => name !== 'head'));
    db.exec('CREATE TEMP TABLE lookup_changes(name TEXT,bytes INTEGER)');
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '__record_intake_lookup_*'",
      )
      .all();
    for (const { name } of tables) {
      const columns = db
        .prepare(`PRAGMA table_info(${name})`)
        .all()
        .map((row) => String(row.name));
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        const ref = action === 'DELETE' ? 'OLD' : 'NEW';
        const fields = columns.flatMap((column) => [`'${column}'`, `${ref}.${column}`]).join(',');
        db.exec(
          `CREATE TEMP TRIGGER audit_${name}_${action} AFTER ${action} ON main.${name} BEGIN INSERT INTO lookup_changes VALUES('${name}',length(CAST(json_object(${fields}) AS BLOB))); END`,
        );
      }
    }
    const mutate = (label: string, next: typeof values) => {
      const before = { ...intakeLookupCounters(db) };
      db.exec('DELETE FROM lookup_changes');
      values = next;
      writeIntakeFixtureEnvelope(db, 'one', envelope());
      assert.equal(
        maximumReportDiscoveryOrder(db),
        Math.max(...values.map((value) => value.marker)),
      );
      const after = { ...intakeLookupCounters(db) };
      const delta = Object.fromEntries(
        Object.entries(after).map(([key, value]) => [
          key,
          value - before[key as keyof typeof before],
        ]),
      );
      const actual = db
        .prepare('SELECT COUNT(*) rows,COALESCE(SUM(bytes),0) bytes FROM lookup_changes')
        .get()!;
      assert.equal(actual.rows, delta.projectionWrites, 'every projection row mutation is counted');
      assert.ok(Number(actual.rows) <= 12, `${label}: ${actual.rows} rows`);
      assert.ok(Number(actual.bytes) < 5000, `${label}: ${actual.bytes} SQL row bytes`);
      assert.ok(delta.hashedPayloadBytes! < 300, `${label}: only introduced payloads are hashed`);
      assert.ok(delta.identityLinksWritten! <= 5, `${label}: bounded order maintenance`);
      assert.deepEqual(intakeIdentityConfirmations(db), values);
      for (const operation of new Set(values.map((value) => value.receipt.operationId)))
        assert.deepEqual(
          retainedReportAcceptance(db, operation),
          values.find((value) => value.receipt.operationId === operation),
        );
      samples.push({ size, label, delta, actual });
    };
    mutate('front insert', [item(size), ...values]);
    mutate('last to front', [values.at(-1)!, ...values.slice(0, -1)]);
    mutate('front delete', values.slice(1));
    mutate('identical duplicate at front', [values.at(-1)!, ...values]);
    mutate('duplicate first-operation winner', [{ ...item(size), marker: -1 }, ...values]);
    mutate('remove duplicate winner', values.slice(1));
    for (const [name, bytes] of retained) assert.deepEqual(authority.objects.get(name), bytes);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM __record_versions WHERE entity GLOB '__record_intake_lookup_*'",
        )
        .get()!.n,
      0,
    );
  }
  t.diagnostic(
    JSON.stringify({
      samples,
      scope:
        'Logical projection rows and SQL row bytes include identity head/link maintenance. Changed-array enumeration and existing payload reads remain linear and are counted separately; SQLite pages/indexes and TEMP dirty markers are outside logical write bytes.',
    }),
  );
});
