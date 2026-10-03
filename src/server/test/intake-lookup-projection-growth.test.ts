import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { attachRecordDurability, type RecordStorage } from '../record-versions.ts';
import { registerRawIntakeFixture } from './helpers/intake-authority-fixture.ts';
import { stageIntakeEnvelope } from '../intake-authority.ts';
import { intakeLookupCounters, clearIntakeLookupCache } from '../intake-lookup-projection.ts';
import {
  maximumReportDiscoveryOrder,
  retainedReportAcceptance,
  intakeIdentityConfirmations,
} from '../intake-state-access.ts';

test('300 contributions keep warm lookups indexed and changed projection writes bounded', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'intake-lookup-growth-'));
  const profileId = 'fictional-lookup-growth';
  const db = openDatabase(join(root, 'current.sqlite'), profileId);
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable(name, value) {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(value));
    },
    publishHead(value) {
      objects.set('head', Buffer.from(value));
    },
  };
  t.after(() => {
    clearIntakeLookupCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  attachRecordDurability(db, { profileId, storage });
  const insert = (id: string, details: unknown) =>
    registerRawIntakeFixture(db, id, JSON.stringify(details));
  insert('untouched', {
    intake: {
      workflow: {
        fictionalUnrelatedText: 'Independently fictional Ω. '.repeat(5000),
        reportGroups: [{ discoveryOrder: 7 }],
        reportAcceptances: [{ receipt: { operationId: 'duplicate-operation' }, marker: 'first' }],
        identityConfirmations: [{ marker: 'first' }],
      },
    },
  });
  insert('changing', { intake: { workflow: {} } });
  const originalObjects = new Map([...objects].filter(([name]) => name !== 'head'));
  assert.equal(maximumReportDiscoveryOrder(db), 7);
  assert.deepEqual(retainedReportAcceptance(db, 'duplicate-operation'), {
    receipt: { operationId: 'duplicate-operation' },
    marker: 'first',
  });
  const initial = { ...intakeLookupCounters(db) };
  assert.equal(initial.builds, 1);
  assert.ok(initial.authorityBytes > 100_000);
  const measure = () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__record_intake_lookup_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    assert.ok(tables.length > 0);
    const projection = tables.map((name) => {
      assert.match(name, /^__record_intake_lookup_[a-z_]+$/);
      const rows = db.prepare(`SELECT * FROM "${name}"`).all();
      const columns = db
        .prepare(`PRAGMA table_info("${name}")`)
        .all()
        .map((row) => String(row.name));
      const textExpressions = columns.map((column) => {
        assert.match(column, /^[a-z_]+$/);
        return `CASE WHEN typeof("${column}") IN ('text','blob') THEN length(CAST("${column}" AS BLOB)) ELSE 0 END`;
      });
      const storedTextBytes = Number(
        db
          .prepare(`SELECT coalesce(sum(${textExpressions.join('+')}),0) bytes FROM "${name}"`)
          .get()!.bytes,
      );
      return {
        name,
        rows: rows.length,
        serializedRowsBytes: Buffer.byteLength(JSON.stringify(rows)),
        storedTextBytes,
      };
    });
    const versions = db
      .prepare(
        'SELECT count(*) rows,coalesce(sum(length(CAST(contents_json AS BLOB))),0) contents_bytes,coalesce(sum(length(CAST(metadata_json AS BLOB))),0) metadata_bytes FROM __record_versions',
      )
      .get()!;
    const fields = db
      .prepare(
        'SELECT count(*) rows,coalesce(sum(length(CAST(field AS BLOB))+coalesce(length(CAST(before_version AS BLOB)),0)),0) storedTextBytes FROM __record_fields',
      )
      .get()!;
    const transactions = db
      .prepare(
        'SELECT count(*) rows,coalesce(sum(length(CAST(result_json AS BLOB))),0) result_bytes,coalesce(sum(length(CAST(commit_json AS BLOB))),0) commit_bytes FROM __record_transactions',
      )
      .get()!;
    return {
      counters: { ...intakeLookupCounters(db) },
      projection,
      versions,
      fields,
      transactions,
      allocatedBytes:
        Number(db.prepare('PRAGMA page_count').get()!.page_count) *
        Number(db.prepare('PRAGMA page_size').get()!.page_size),
      authorityBytes: [...objects.values()].reduce((sum, value) => sum + value.length, 0),
      authorityObjects: objects.size,
    };
  };
  const baseline = measure();
  const groups: Array<{ discoveryOrder: number }> = [];
  const acceptances: Array<{ receipt: { operationId: string }; marker: string }> = [];
  const confirmations: Array<{ marker: string }> = [];
  const samples: Array<ReturnType<typeof measure> & { contributions: number }> = [];
  for (let step = 1; step <= 300; step++) {
    groups.push({ discoveryOrder: step + 7 });
    acceptances.push({
      receipt: { operationId: step === 1 ? 'duplicate-operation' : `operation-${step}` },
      marker: `receipt-${step}`,
    });
    confirmations.push({ marker: `confirmation-${step}` });
    const before = { ...intakeLookupCounters(db) };
    transaction(db, () => {
      stageIntakeEnvelope(
        db,
        { id: 'changing' },
        {
          intake: {
            workflow: {
              reportGroups: groups,
              reportAcceptances: acceptances,
              identityConfirmations: confirmations,
            },
          },
        },
      );
    });
    assert.equal(maximumReportDiscoveryOrder(db), step + 7);
    assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 'first' }, ...confirmations]);
    assert.deepEqual(retainedReportAcceptance(db, 'duplicate-operation'), {
      receipt: { operationId: 'duplicate-operation' },
      marker: 'first',
    });
    if (step > 1)
      assert.deepEqual(retainedReportAcceptance(db, `operation-${step}`), acceptances.at(-1));
    const after = { ...intakeLookupCounters(db) };
    assert.equal(
      after.cleanupQueries,
      0,
      'appending contributions cannot rescan reverse references',
    );
    assert.equal(after.authorityReads - before.authorityReads, 1);
    assert.equal(after.reconciledSources - before.reconciledSources, 1);
    assert.ok(after.projectionWrites - before.projectionWrites <= 12);
    assert.ok(after.projectionBytes - before.projectionBytes < 4096);
    for (let repeat = 0; repeat < 3; repeat++) maximumReportDiscoveryOrder(db);
    transaction(db, () => db.prepare('SELECT 1').get());
    maximumReportDiscoveryOrder(db);
    assert.deepEqual(intakeLookupCounters(db), after);
    if (step % 100 === 0) samples.push({ contributions: step, ...measure() });
  }
  for (const [name, value] of originalObjects) assert.deepEqual(objects.get(name), value);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM __record_versions WHERE entity LIKE '__record_intake_lookup_%'",
      )
      .get()!.n,
    0,
  );
  clearIntakeLookupCache(db);
  assert.equal(maximumReportDiscoveryOrder(db), 307);
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 'first' }, ...confirmations]);
  assert.deepEqual(retainedReportAcceptance(db, 'operation-300'), acceptances.at(-1));
  t.diagnostic(
    JSON.stringify({
      baseline,
      samples,
      limitation:
        'Lookup projection mutation fixture only; reconciliation reads the changed full view. Real batch/review/acceptance growth qualification remains CRS-210.',
    }),
  );
});
