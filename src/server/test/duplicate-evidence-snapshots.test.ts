import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../database.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { canonicalLiteral } from '../intake-format.ts';
import {
  createDuplicateEvidenceSnapshotPreparation,
  prepareRetainedDuplicateEvidenceSnapshot,
} from '../duplicate-evidence-snapshots.ts';
import type { SavedDuplicateEvidenceValue } from '../../shared/saved-duplicate-evidence.ts';

const value = (id: string, note = 'Fictional source ' + id): SavedDuplicateEvidenceValue => ({
  label: 'Fictional clinic',
  locator: 'Fictional paragraph',
  sourceRecordId: id,
  original: { note, literal: JSON.rawJSON('12.00') },
  contentUrl: '/api/sources/fictional-original/content',
});
type Row = { id: string; value: SavedDuplicateEvidenceValue };
const ordered = (rows: Row[]) =>
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-duplicate-snapshot-')),
    db = openDatabase(join(root, 'cache.sqlite'), 'fictional'),
    authority = memoryRecordAuthority(db),
    source = { id: 'fictional-original' };
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  registerRawIntakeFixture(db, source.id, JSON.stringify({ intake: { version: 1 } }));
  await buildIntakeCollectionEnvelope(db, source);
  return { db, source, authority };
}
async function publish(
  builder: ReturnType<typeof createDuplicateEvidenceSnapshotPreparation>,
  db: ReturnType<typeof openDatabase>,
) {
  const stage = await builder.finish(),
    prepared = stage.prepareStandalone();
  try {
    transaction(db, () => prepared.apply());
  } finally {
    prepared.dispose();
    stage.dispose();
  }
}

test('duplicate evidence snapshots retain exact binary order, giant IDs, composed selection and unchanged replay', async (t) => {
  const { db, source, authority } = await fixture(t),
    rows = ordered(
      ['fictional-a', 'fictional-' + 'x'.repeat(1500), '\ue000', '😀'].map((id) => ({
        id,
        value: value(id),
      })),
    ),
    expected = canonicalLiteral(rows.map((row) => row.value)),
    first = createDuplicateEvidenceSnapshotPreparation(db, source),
    reference = await first.prepareTarget({
      kind: 'document',
      recordId: 'fictional-document',
      evidence: () => rows,
    });
  assert.equal(reference.digest, createHash('sha256').update(expected).digest('hex'));
  const stage = await first.finish(),
    version = intakeSourceVersion(db, source.id).version,
    view = openIntakeCollectionEnvelope(db, source),
    intake = view.child(view.root(), 'intake')!,
    operationId = randomUUID(),
    mutation = await prepareIntakeEnvelopeMutation(db, source, {
      reader: view,
      changes: [{ op: 'set', record: intake, field: 'fictionalAudit', jsonText: 'true' }],
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: version + 1,
      prepareDerived: async () => stage.changes,
    });
  try {
    transaction(db, () => {
      stage.assertCurrent();
      selectedEnvelopeStore(db, source).collections.stage(mutation.prepared!);
    });
  } finally {
    stage.dispose();
    selectedEnvelopeStore(db, source).collections.disposePreparation(mutation.prepared!);
  }
  assert.equal(intakeSourceVersion(db, source.id).version, version + 1);
  clearIntakeStateCache(db);
  const retained = await prepareRetainedDuplicateEvidenceSnapshot(db, reference);
  try {
    assert.deepEqual(
      [...retained.entries()].map((row) => row.id),
      rows.map((row) => row.id),
    );
    assert.equal([...retained.chunks()].join(''), expected);
  } finally {
    retained.close();
  }
  const objects = authority.objects.size,
    unchanged = createDuplicateEvidenceSnapshotPreparation(db, source),
    replay = await unchanged.prepareTarget({
      kind: 'document',
      recordId: 'fictional-document',
      previous: reference,
      evidence: () => rows,
    }),
    noChanges = await unchanged.finish();
  assert.deepEqual(replay, reference);
  assert.deepEqual(noChanges.changes, []);
  assert.equal(authority.objects.size, objects);
  noChanges.dispose();
  const invalid = createDuplicateEvidenceSnapshotPreparation(db, source);
  await assert.rejects(
    invalid.prepareTarget({
      kind: 'document',
      recordId: 'wrong-target',
      previous: reference,
      evidence: () => rows,
    }),
    /target changed/,
  );
  await assert.rejects(
    invalid.prepareTarget({
      kind: 'document',
      recordId: 'fictional-document',
      evidence: () => [...rows].reverse(),
    }),
    /BINARY order/,
  );
  invalid.dispose();
  await assert.rejects(
    prepareRetainedDuplicateEvidenceSnapshot(db, { ...reference, digest: '0'.repeat(64) }),
    /disagrees/,
  );
});

test('an explicitly proven kind change forks target metadata while retaining exact evidence entries', async (t) => {
  const { db, source } = await fixture(t),
    rows = ordered(
      Array.from({ length: 128 }, (_, index) => {
        const id = 'fictional-' + String(index).padStart(4, '0');
        return { id, value: value(id) };
      }),
    ),
    initial = createDuplicateEvidenceSnapshotPreparation(db, source),
    first = await initial.prepareTarget({
      kind: 'document',
      recordId: 'fictional-stable',
      evidence: () => rows,
    });
  await publish(initial, db);
  const before = intakeWorkCounters(db).warm.duplicateSnapshotChangedRows,
    next = createDuplicateEvidenceSnapshotPreparation(db, source);
  await assert.rejects(
    next.prepareTarget({
      kind: 'observation',
      recordId: 'fictional-stable',
      previous: first,
      evidence: () => rows,
    }),
    /target changed/,
  );
  await assert.rejects(
    next.prepareTarget({
      kind: 'observation',
      previousKind: 'document',
      recordId: 'unrelated',
      previous: first,
      evidence: () => rows,
    }),
    /target changed/,
  );
  const second = await next.prepareTarget({
    kind: 'observation',
    previousKind: 'document',
    recordId: 'fictional-stable',
    previous: first,
    evidence: () => rows,
  });
  await publish(next, db);
  assert.equal(intakeWorkCounters(db).warm.duplicateSnapshotChangedRows - before, 0);
  assert.notEqual(first.snapshotId, second.snapshotId);
  assert.equal(first.digest, second.digest);
  assert.equal(first.count, second.count);
  for (const [reference, kind] of [
    [first, 'document'],
    [second, 'observation'],
  ] as const) {
    const retained = await prepareRetainedDuplicateEvidenceSnapshot(db, reference);
    try {
      assert.deepEqual(retained.target, [kind, 'fictional-stable']);
      assert.equal([...retained.chunks()].join(''), canonicalLiteral(rows.map((row) => row.value)));
    } finally {
      retained.close();
    }
  }
});

test('duplicate evidence changed-row journal growth remains bounded across two history sizes', async (t) => {
  const measurements: Array<{ size: number; bytes: number; objects: number; changed: number }> = [];
  for (const size of [8, 128]) {
    const { db, source, authority } = await fixture(t),
      rows = Array.from({ length: size }, (_, index) => {
        const id = 'fictional-' + String(index).padStart(5, '0');
        return { id, value: value(id, 'Fictional retained evidence '.repeat(12)) };
      }),
      first = createDuplicateEvidenceSnapshotPreparation(db, source),
      reference = await first.prepareTarget({
        kind: 'document',
        recordId: 'fictional-document',
        evidence: () => rows,
      });
    await publish(first, db);
    const before = new Set(authority.objects.keys()),
      beforeWork = intakeWorkCounters(db).warm.duplicateSnapshotChangedRows,
      changedRows = rows
        .slice(1)
        .map((row, index) =>
          index === 0 ? { ...row, value: value(row.id, 'Fictional corrected evidence') } : row,
        );
    changedRows.push({ id: 'fictional-new', value: value('fictional-new') });
    const next = createDuplicateEvidenceSnapshotPreparation(db, source),
      after = await next.prepareTarget({
        kind: 'document',
        recordId: 'fictional-document',
        previous: reference,
        evidence: () => changedRows,
      });
    await publish(next, db);
    const added = [...authority.objects].filter(([id]) => !before.has(id));
    measurements.push({
      size,
      bytes: added.reduce((sum, [, bytes]) => sum + bytes.length, 0),
      objects: added.length,
      changed: intakeWorkCounters(db).warm.duplicateSnapshotChangedRows - beforeWork,
    });
    clearIntakeStateCache(db);
    for (const [ref, values] of [
      [reference, rows],
      [after, changedRows],
    ] as const) {
      const read = await prepareRetainedDuplicateEvidenceSnapshot(db, ref);
      try {
        assert.equal([...read.chunks()].join(''), canonicalLiteral(values.map((row) => row.value)));
      } finally {
        read.close();
      }
    }
  }
  assert.deepEqual(
    measurements.map((item) => item.changed),
    [3, 3],
  );
  assert.ok(measurements[1]!.bytes < measurements[0]!.bytes * 4, JSON.stringify(measurements));
  assert.ok(measurements[1]!.objects < measurements[0]!.objects * 2, JSON.stringify(measurements));
  t.diagnostic(JSON.stringify(measurements));
});

test('same-custodian duplicate snapshots compose and reject stale publication and cancelled preparation', async (t) => {
  const { db, source } = await fixture(t),
    factory = createDuplicateEvidenceSnapshotPreparation(db, source),
    one = await factory.prepareTarget({
      kind: 'document',
      recordId: 'fictional-one',
      evidence: () => [{ id: 'one', value: value('one') }],
    }),
    two = await factory.prepareTarget({
      kind: 'document',
      recordId: 'fictional-two',
      evidence: () => [{ id: 'two', value: value('two') }],
    });
  await publish(factory, db);
  for (const reference of [one, two]) {
    const read = await prepareRetainedDuplicateEvidenceSnapshot(db, reference);
    try {
      assert.equal([...read.entries()].length, 1);
    } finally {
      read.close();
    }
  }
  const left = createDuplicateEvidenceSnapshotPreparation(db, source),
    right = createDuplicateEvidenceSnapshotPreparation(db, source);
  await left.prepareTarget({ kind: 'document', recordId: 'fictional-left', evidence: () => [] });
  await right.prepareTarget({ kind: 'document', recordId: 'fictional-right', evidence: () => [] });
  const leftStage = await left.finish(),
    rightStage = await right.finish(),
    leftSelection = leftStage.prepareStandalone(),
    rightSelection = rightStage.prepareStandalone();
  try {
    transaction(db, () => leftSelection.apply());
    assert.throws(
      () => transaction(db, () => rightSelection.apply()),
      /Stale report snapshot|evidence changed/,
    );
  } finally {
    leftSelection.dispose();
    rightSelection.dispose();
    leftStage.dispose();
    rightStage.dispose();
  }
  let aborted = false;
  const cancelled = createDuplicateEvidenceSnapshotPreparation(db, source, {
    assertRunning: () => {
      if (aborted) throw Error('Fictional cancellation');
    },
  });
  await assert.rejects(
    cancelled.prepareTarget({
      kind: 'document',
      recordId: 'fictional-cancelled',
      evidence: function* () {
        for (let index = 0; index < 20; index++) {
          if (index === 12) aborted = true;
          const id = 'cancelled-' + String(index).padStart(2, '0');
          yield { id, value: value(id) };
        }
      },
    }),
    /Fictional cancellation/,
  );
  cancelled.dispose();
  clearIntakeStateCache(db);
  const retained = await prepareRetainedDuplicateEvidenceSnapshot(db, one);
  try {
    assert.equal([...retained.chunks()].join(''), canonicalLiteral([value('one')]));
  } finally {
    retained.close();
  }
});
