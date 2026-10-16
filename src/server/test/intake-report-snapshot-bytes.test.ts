/** Real existing catalog/byte owner and contributor durability. Warning rows are
 * synthetic owner inputs; these cases make no native policy/model claim. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability, rebuildProfile } from '../portable.ts';
import { createBackup } from '../recovery.ts';
import { uploadIntake, updateIntakeMetadataRead } from '../intake.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import {
  createReportSnapshotCatalog,
  type ReportSnapshotCatalog,
  type ReportSnapshotMapReader,
} from '../intake-report-snapshot-catalog.ts';
import {
  clearIntakeCollectionCache,
  type IntakeByteValue,
  type IntakeCollectionChange,
} from '../intake-state-collections.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-identity-alias-bytes-')),
    profileId = 'fictional-byte-owner',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId),
    recovered: DatabaseSync[] = [];
  t.after(() => {
    for (const connection of recovered) if (connection.isOpen) connection.close();
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  attachPersonalDurability(db, { root, profileId });
  const original = uploadIntake(db, root, profileId, {
    filename: 'fictional-bytes.txt',
    bytes: Buffer.from('Independently fictional byte owner original'),
    newProviderName: 'Invented Byte Clinic',
  });
  await buildIntakeCollectionEnvelope(db, { id: original.id });
  return { root, profileId, db, original, recovered };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const catalogFor = (f: Fixture) =>
  createReportSnapshotCatalog(f.db, { id: f.original.id }, { catalogArea: 'builds' });
async function commit(f: Fixture, changes: readonly IntakeCollectionChange[]) {
  await runExclusiveClinicalOperation(f.db, async () => {
    const collections = selectedEnvelopeStore(f.db, {
        id: f.original.id,
      }).collections,
      operationId = randomUUID();
    collections.commitMaintenance(
      collections.prepare(collections.openView(), {
        operationId,
        requestDigest: hash(operationId),
        domainVersion: intakeSourceVersion(f.db, f.original.id).rawVersion,
        changes,
      }),
    );
  });
}
async function select(f: Fixture, catalog: ReportSnapshotCatalog) {
  await commit(f, await catalog.finalChanges());
}
const text = (reader: ReportSnapshotMapReader) => [...reader.chunks('warning')].join('');

for (const mode of ['reader', 'writer'] as const)
  for (const change of ['auxiliary', 'cache', 'logical'] as const)
    test(`started snapshot ${mode} stream checks ${change} changes inside a prefetched page`, async (t) => {
      const f = await fixture(t),
        catalog = catalogFor(f),
        writer = await catalog.fork(),
        expected = 'f' + '🦊'.repeat(3001);
      await writer.putText('warning', [expected]);
      let reader: ReportSnapshotMapReader = writer;
      if (mode === 'reader') {
        await catalog.publish('fictional-selected', writer);
        await select(f, catalog);
        reader = catalogFor(f).open('fictional-selected')!;
      }
      const pending = reader.chunks('warning')[Symbol.iterator](),
        first = pending.next();
      assert.equal(first.done, false);
      assert.ok(Buffer.byteLength(first.value!) < Buffer.byteLength(expected));
      await setImmediate();
      if (change === 'cache') clearIntakeCollectionCache(f.db);
      else if (change === 'logical')
        await updateIntakeMetadataRead(f.db, f.root, f.profileId, f.original.id, {
          version: intakeSourceVersion(f.db, f.original.id).rawVersion,
          operationId: 'fictional-stream-metadata-change',
          metadata: { topics: ['Independently fictional changed topic'] },
        });
      else
        await commit(f, [
          { area: 'builds', collection: 'unrelated', op: 'put', key: 'checkpoint', value: 'ready' },
        ]);
      if (change === 'auxiliary')
        assert.equal(first.value + [...{ [Symbol.iterator]: () => pending }].join(''), expected);
      else {
        assert.throws(() => pending.next(), /stale|expired|logical|authority/i);
        if (change === 'cache')
          assert.equal(text(reader), expected, 'fresh traversal remains usable after disposal');
      }
    });

test('snapshot stream seals cache lifetime after its owner current-check callback', async (t) => {
  const f = await fixture(t);
  let armed = false,
    disposed = false;
  const catalog = createReportSnapshotCatalog(
    f.db,
    { id: f.original.id },
    {
      catalogArea: 'builds',
      assertRunning() {
        if (armed) {
          armed = false;
          disposed = true;
          clearIntakeCollectionCache(f.db);
        }
      },
    },
  );
  const writer = await catalog.fork();
  await writer.putText('warning', ['f'.repeat(12000)]);
  const pending = writer.chunks('warning')[Symbol.iterator]();
  assert.equal(pending.next().done, false);
  armed = true;
  assert.throws(() => pending.next(), /expired/);
  assert.equal(
    disposed,
    true,
    'the actual catalog callback disposed the registry during its current check',
  );
});

for (const value of ['', 'Fictional inline', '🦊'.repeat(3001)])
  test(`snapshot stream checks terminal resume for ${value.length} characters`, async (t) => {
    const f = await fixture(t),
      catalog = catalogFor(f),
      writer = await catalog.fork();
    await writer.putText('warning', [value]);
    const expected = [...writer.chunks('warning')],
      pending = writer.chunks('warning')[Symbol.iterator]();
    for (const part of expected) assert.deepEqual(pending.next(), { done: false, value: part });
    if (expected.length) {
      clearIntakeCollectionCache(f.db);
      assert.throws(() => pending.next(), /expired/);
      assert.equal(text(writer), value);
    } else {
      assert.deepEqual(pending.next(), { done: true, value: undefined });
      const get = writer.get;
      writer.get = (key) => {
        const result = get(key);
        clearIntakeCollectionCache(f.db);
        return result;
      };
      assert.throws(
        () => writer.chunks('warning')[Symbol.iterator]().next(),
        /expired/,
        'even an empty traversal seals its get before reporting completion',
      );
    }
  });

test('fresh singleton indexes combine construction and publication in both catalog areas', async (t) => {
  for (const catalogArea of ['logical', 'builds'] as const) {
    const f = await fixture(t),
      create = () => createReportSnapshotCatalog(f.db, { id: f.original.id }, { catalogArea }),
      collections = selectedEnvelopeStore(f.db, { id: f.original.id }).collections,
      sequence = () => collections.binding(collections.openView())!.storageSequence,
      catalog = create(),
      start = sequence();
    const first = await catalog.prepareSingleton!('fictional-entry', '1');
    assert.equal(sequence(), start, 'preparation publishes no unreadable partial map');
    assert.deepEqual(await catalog.finalChanges(), []);
    assert.equal(catalog.open('first'), undefined);
    await first.publish('first');
    assert.equal(
      sequence() - start,
      1,
      'format, singleton, catalog and reference share one publication',
    );
    assert.equal(catalog.open('first')!.get('fictional-entry'), '1');
    assert.equal(create().open('first'), undefined, 'auxiliary publication is not final selection');
    await assert.rejects(first.publish('reuse'), /publication changed/);
    const second = await catalog.prepareSingleton!('another-entry', '2'),
      beforeSecond = sequence();
    await second.publish('second');
    assert.equal(sequence() - beforeSecond, 1, 'subsequent publication stays one checkpoint');
    const operationId = randomUUID(),
      prepared = collections.prepare(collections.openView(), {
        operationId,
        requestDigest: hash(operationId),
        domainVersion: intakeSourceVersion(f.db, f.original.id).rawVersion,
        changes: await catalog.finalChanges(),
      });
    transaction(f.db, () => collections.stage(prepared));
    clearIntakeCollectionCache(f.db);
    const inherited = create(),
      duplicate = await inherited.prepareSingleton!('replacement', 'forbidden'),
      beforeDuplicate = sequence();
    await assert.rejects(duplicate.publish('first'), /already exists/);
    assert.equal(sequence(), beforeDuplicate);
    assert.deepEqual(await inherited.finalChanges(), []);
    assert.equal(inherited.open('first')!.get('fictional-entry'), '1');
    const third = await inherited.prepareSingleton!('third-entry', '3'),
      beforeThird = sequence();
    await third.publish('third');
    assert.equal(sequence() - beforeThird, 1, 'inherited catalog adoption is also combined');
    assert.equal(inherited.open('first')!.get('fictional-entry'), '1');
    assert.equal(inherited.open('second')!.get('another-entry'), '2');
    assert.equal(inherited.open('third')!.get('third-entry'), '3');
  }
});

test('singleton preparation preserves eager callback order and rejects invalid initial entries', async (t) => {
  const f = await fixture(t),
    events: string[] = [];
  let phase = 'before append';
  const catalog = createReportSnapshotCatalog(
    f.db,
    { id: f.original.id },
    {
      onCheckpoint: () => {
        events.push(phase);
      },
    },
  );
  for (const [key, value] of [
    ['$format', 'wrong'],
    ['x'.repeat(1025), '1'],
    ['key', 'x'.repeat(9000)],
  ])
    await assert.rejects(catalog.prepareSingleton!(key!, value!), /initial entry/);
  assert.deepEqual(events, []);
  const pending = await catalog.prepareSingleton!('fictional', '1');
  assert.deepEqual(events, ['before append']);
  assert.deepEqual(await catalog.finalChanges(), []);
  phase = 'after append';
  await pending.publish('callback-order');
  assert.deepEqual(events, ['before append', 'after append', 'after append']);
  assert.equal(catalog.open('callback-order')!.get('fictional'), '1');
});

test('singleton publication retains cancellation and the terminal publication verifier', async (t) => {
  const f = await fixture(t),
    collections = selectedEnvelopeStore(f.db, { id: f.original.id }).collections,
    sequence = () => collections.binding(collections.openView())!.storageSequence;
  let cancelled = false,
    refused = false,
    verifications = 0;
  const options: NonNullable<Parameters<typeof createReportSnapshotCatalog>[2]> = {
    catalogArea: 'builds',
    assertRunning: () => {
      if (cancelled) throw Error('Fictional cancellation');
    },
    withVerifiedPublication: async (commit) => {
      verifications++;
      commit(() => {
        if (refused) throw Error('Fictional physical refusal');
      });
    },
  };
  const catalog = createReportSnapshotCatalog(f.db, { id: f.original.id }, options),
    pending = await catalog.prepareSingleton!('fictional', '1'),
    before = sequence();
  refused = true;
  await assert.rejects(pending.publish('refused'), /physical refusal/);
  assert.equal(verifications, 1);
  assert.equal(sequence(), before);
  assert.deepEqual(await catalog.finalChanges(), []);
  assert.equal(catalog.open('refused'), undefined);
  refused = false;
  const next = await catalog.prepareSingleton!('fictional', '2');
  cancelled = true;
  await assert.rejects(next.publish('cancelled'), /cancellation/);
  assert.equal(sequence(), before);
  cancelled = false;
  const lateHook = await catalog.prepareSingleton!('fictional', '3');
  options.onCheckpoint = () => {};
  await assert.rejects(lateHook.publish('changed-hook'), /publication changed/);
  assert.equal(sequence(), before);
  options.onCheckpoint = undefined;
  const valid = await catalog.prepareSingleton!('fictional', '4');
  await valid.publish('valid');
  assert.equal(verifications, 2);
  assert.equal(sequence() - before, 1);
  assert.equal(catalog.open('valid')!.get('fictional'), '4');
});

test('singleton publications reject overlap and cannot select after a failed closing check', async (t) => {
  const f = await fixture(t);
  let cancelAfterCommit = false,
    cancelled = false;
  const catalog = createReportSnapshotCatalog(
    f.db,
    { id: f.original.id },
    {
      catalogArea: 'builds',
      assertRunning: () => {
        if (cancelled) throw Error('Fictional closing cancellation');
      },
      withVerifiedPublication: async (commit) => {
        commit(() => {});
        if (cancelAfterCommit) cancelled = true;
      },
    },
  );
  const first = await catalog.prepareSingleton!('first', '1'),
    second = await catalog.prepareSingleton!('second', '2'),
    publication = first.publish('first');
  await assert.rejects(second.publish('second'), /publication is pending/);
  await assert.rejects(catalog.finalChanges(), /pending/);
  await publication;
  assert.equal(catalog.open('first')!.get('first'), '1');
  assert.equal(catalog.open('second'), undefined);
  const abandoned = createReportSnapshotCatalog(
      f.db,
      { id: f.original.id },
      {
        catalogArea: 'builds',
        assertRunning: () => {
          if (cancelled) throw Error('Fictional closing cancellation');
        },
        withVerifiedPublication: async (commit) => {
          commit(() => {});
          if (cancelAfterCommit) cancelled = true;
        },
      },
    ),
    pending = await abandoned.prepareSingleton!('abandoned', '3');
  cancelAfterCommit = true;
  await assert.rejects(pending.publish('abandoned'), /closing cancellation/);
  await assert.rejects(abandoned.finalChanges(), /closing cancellation/);
  cancelled = false;
  assert.deepEqual(
    await abandoned.finalChanges(),
    [],
    'failed closing validation admits no catalog selection',
  );
  assert.equal(catalogFor(f).open('abandoned'), undefined);
});

test('ordinary and singleton publications share a guard before initialization and through verification', async (t) => {
  for (const initialized of [false, true])
    for (const firstKind of ['ordinary', 'singleton'] as const) {
      const f = await fixture(t),
        entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let pause = false;
      const catalog = createReportSnapshotCatalog(
          f.db,
          { id: f.original.id },
          {
            catalogArea: 'builds',
            withVerifiedPublication: async (commit) => {
              if (pause) {
                entered.resolve();
                await release.promise;
              }
              commit(() => {});
            },
          },
        ),
        ordinary = await catalog.fork(undefined, [{ key: 'ordinary', value: '1' }]),
        singleton = await catalog.prepareSingleton!('singleton', '2'),
        lateSingleton = await catalog.prepareSingleton!('late', '3');
      if (initialized) {
        const seed = await catalog.prepareSingleton!('seed', '0');
        await seed.publish('seed');
      }
      pause = true;
      const publication =
        firstKind === 'ordinary'
          ? catalog.publish('shared-id', ordinary)
          : singleton.publish('shared-id');
      try {
        await assert.rejects(
          firstKind === 'ordinary'
            ? singleton.publish('shared-id')
            : catalog.publish('shared-id', ordinary),
          /publication is pending/,
          'overlap is refused from entry, including initial catalog construction',
        );
        await entered.promise;
        await assert.rejects(
          firstKind === 'ordinary'
            ? lateSingleton.publish('shared-id')
            : catalog.publish('shared-id', ordinary),
          /publication is pending/,
          'overlap remains refused after the duplicate check while the verifier awaits',
        );
        await assert.rejects(catalog.finalChanges(), /publication is pending/);
      } finally {
        release.resolve();
        await publication;
      }
      const retained = catalog.open('shared-id')!;
      assert.equal(retained.get(firstKind), firstKind === 'ordinary' ? '1' : '2');
      assert.equal(retained.get(firstKind === 'ordinary' ? 'singleton' : 'ordinary'), undefined);
      const duplicate = await catalog.prepareSingleton!('replacement', 'forbidden');
      await assert.rejects(duplicate.publish('shared-id'), /already exists/);
      assert.equal((await catalog.finalChanges()).length, 1);
    }
});

test('singleton preparation and publication refuse source or selected-catalog drift', async (t) => {
  for (const drift of ['source', 'catalog'] as const) {
    const f = await fixture(t),
      catalog = catalogFor(f),
      pending = await catalog.prepareSingleton!('unselected', '1');
    if (drift === 'source')
      await updateIntakeMetadataRead(f.db, f.root, f.profileId, f.original.id, {
        version: intakeSourceVersion(f.db, f.original.id).rawVersion,
        operationId: 'fictional-singleton-source-drift',
        metadata: { topics: ['Fictional changed source metadata'] },
      });
    else {
      const other = catalogFor(f),
        entry = await other.prepareSingleton!('other', '2');
      await entry.publish('other');
      await select(f, other);
    }
    await assert.rejects(pending.publish('unselected'), /Stale/);
    await assert.rejects(catalog.finalChanges(), /Stale/);
    assert.equal(catalogFor(f).open('unselected'), undefined);
  }
  const f = await fixture(t);
  let cancelled = false;
  const catalog = createReportSnapshotCatalog(
    f.db,
    { id: f.original.id },
    {
      assertRunning: () => {
        if (cancelled) throw Error('Fictional preparation cancellation');
      },
    },
  );
  const preparing = catalog.prepareSingleton!('fictional', '1');
  cancelled = true;
  await assert.rejects(preparing, /preparation cancellation/);
});

test('real snapshot catalog commits 64 inline entries together and refuses a 65-entry batch', async (t) => {
  const f = await fixture(t);
  let checkpoints = 0;
  const catalog = createReportSnapshotCatalog(
      f.db,
      { id: f.original.id },
      {
        catalogArea: 'builds',
        onCheckpoint: () => {
          checkpoints++;
        },
      },
    ),
    writer = await catalog.fork(),
    entries = Array.from({ length: 64 }, (_, n) => ({
      key: 'fictional:' + String(n).padStart(4, '0'),
      value: 'retained-' + n,
    })),
    before = checkpoints;
  await writer.putMany(entries);
  assert.equal(checkpoints - before, 1);
  for (const { key, value } of entries) assert.equal(writer.get(key), value);
  await assert.rejects(
    writer.putMany([...entries, { key: 'overflow', value: 'refused' }]),
    /bounded change batch/,
  );
  assert.equal(checkpoints - before, 1);
  assert.equal(writer.get('overflow'), undefined);
  await catalog.publish('fictional-inline-batch', writer);
  await select(f, catalog);
  clearIntakeCollectionCache(f.db);
  const retained = catalogFor(f).open('fictional-inline-batch')!;
  for (const { key, value } of entries) assert.equal(retained.get(key), value);
});

const prefix =
    '{"kind":"model_birth_date_mismatch","modelBirthDate":"1990-01-01","savedBirthDate":"1991-01-01","personName":"Fictional ',
  suffix = '"}';
function warning(chunks: number, edited = false) {
  const body = 'A'.repeat(chunks * 1024 - prefix.length - suffix.length),
    at = Math.floor(chunks / 2) * 1024;
  return prefix + (edited ? body.slice(0, at) + 'B' + body.slice(at + 1) : body) + suffix;
}
async function seed(f: Fixture, value: string, id = 'fictional-byte-old') {
  const catalog = catalogFor(f),
    writer = await catalog.fork();
  await writer.putText('warning', [value]);
  await catalog.publish(id, writer);
  await select(f, catalog);
}
async function edit(f: Fixture, priorId: string, nextId: string, value: string) {
  const catalog = catalogFor(f),
    writer = await catalog.fork(priorId),
    before = { ...intakeWorkCounters(f.db).warm };
  await writer.putText('warning', [value]);
  const after = intakeWorkCounters(f.db).warm,
    work = {
      checkpointChanges:
        after.reportSnapshotCheckpointChanges - before.reportSnapshotCheckpointChanges,
      comparedChunks:
        after.reportSnapshotTextComparedChunks - before.reportSnapshotTextComparedChunks,
      changedChunks: after.reportSnapshotTextChangedChunks - before.reportSnapshotTextChangedChunks,
      deletedChunks: after.reportSnapshotTextDeletedChunks - before.reportSnapshotTextDeletedChunks,
      writtenBytes: after.reportSnapshotTextWrittenBytes - before.reportSnapshotTextWrittenBytes,
      readBytes: after.reportSnapshotTextReadBytes - before.reportSnapshotTextReadBytes,
      hashBytes: after.reportSnapshotTextHashBytes - before.reportSnapshotTextHashBytes,
      treeNodesWritten: after.collectionNodesWritten - before.collectionNodesWritten,
      treeBytesWritten: after.collectionWrittenBytes - before.collectionWrittenBytes,
    };
  await catalog.publish(nextId, writer);
  await select(f, catalog);
  assert.equal(text(catalogFor(f).open(nextId)!), value);
  return work;
}

test(
  'real catalog fragmented synthetic warnings publish only changed leaves at small and large sizes and after cache reconstruction',
  { timeout: 120000 },
  async (t) => {
    const observations = [];
    for (const chunks of [64, 512]) {
      const f = await fixture(t),
        original = warning(chunks),
        changed = warning(chunks, true);
      assert.equal(Buffer.byteLength(original), chunks * 1024);
      await seed(f, original);
      const scalar = await edit(f, 'fictional-byte-old', 'fictional-byte-changed', changed);
      assert.equal(scalar.comparedChunks, chunks);
      assert.equal(scalar.changedChunks, 1);
      assert.equal(scalar.deletedChunks, 0);
      assert.equal(scalar.writtenBytes, 1024);
      assert.equal(scalar.checkpointChanges, 3, 'one adopt, one replacement, one map attachment');
      const shorter = changed.slice(0, -suffix.length - 2048) + suffix,
        shrunk = await edit(f, 'fictional-byte-changed', 'fictional-byte-shrunk', shorter);
      assert.equal(Buffer.byteLength(shorter), (chunks - 2) * 1024);
      assert.equal(
        shrunk.changedChunks,
        1,
        'closing JSON suffix changes only the final retained leaf',
      );
      assert.equal(shrunk.deletedChunks, 2);
      assert.equal(
        shrunk.checkpointChanges,
        5,
        'adopt, terminal replacement, two suffix deletions, attachment',
      );
      const grown = await edit(f, 'fictional-byte-shrunk', 'fictional-byte-grown', changed);
      assert.equal(
        grown.changedChunks,
        3,
        'previous closing leaf replacement plus two appended leaves',
      );
      assert.equal(grown.deletedChunks, 0);
      assert.equal(grown.checkpointChanges, 5);
      const current = catalogFor(f);
      assert.equal(text(current.open('fictional-byte-old')!), original);
      assert.equal(text(current.open('fictional-byte-changed')!), changed);
      assert.equal(text(current.open('fictional-byte-shrunk')!), shorter);
      const tiny = '{"personName":"Fictional Tiny"}',
        inline = await edit(f, 'fictional-byte-grown', 'fictional-byte-inline', tiny);
      assert.equal(catalogFor(f).open('fictional-byte-inline')!.get('warning'), tiny);
      assert.equal(inline.comparedChunks, 0);
      assert.equal(inline.changedChunks, 0);
      assert.equal(inline.deletedChunks, 0);
      assert.equal(
        inline.checkpointChanges,
        2,
        'one bounded eager adoption and one inline map put preserve producer capability lifetime without copying or deleting historical byte leaves',
      );
      assert.equal(text(catalogFor(f).open('fictional-byte-grown')!), changed);
      observations.push({
        chunks,
        scalar,
        shrink: shrunk,
        grow: grown,
        inline,
      });
      if (chunks === 64) {
        const evictionCatalog = catalogFor(f),
          evictionWriter = await evictionCatalog.fork('fictional-byte-grown'),
          historical = evictionCatalog.open('fictional-byte-grown')!,
          collections = selectedEnvelopeStore(f.db, {
            id: f.original.id,
          }).collections,
          evictionEdited = changed.slice(0, 7000) + 'C' + changed.slice(7001),
          beforeEviction = { ...intakeWorkCounters(f.db).warm };
        let evicted = false;
        await evictionWriter.putText(
          'warning',
          (async function* () {
            const witness = historical.get('warning');
            assert.ok(witness && typeof witness !== 'string');
            assert.equal(
              collections.readBytes(witness, { items: 1, bytes: 4096 }).chunks.length,
              1,
            );
            for (let n = 0; n < 129; n++) {
              const minted = historical.get('warning');
              assert.ok(minted && typeof minted !== 'string');
            }
            assert.throws(
              () => collections.readBytes(witness, { items: 1, bytes: 4096 }),
              /foreign or expired byte value/,
            );
            evicted = true;
            yield evictionEdited;
          })(),
        );
        assert.equal(evicted, true, 'the real 128-entry capability registry was exercised');
        assert.equal(
          intakeWorkCounters(f.db).warm.reportSnapshotTextChangedChunks -
            beforeEviction.reportSnapshotTextChangedChunks,
          1,
        );
        assert.equal(
          intakeWorkCounters(f.db).warm.reportSnapshotCheckpointChanges -
            beforeEviction.reportSnapshotCheckpointChanges,
          3,
        );
        await evictionCatalog.publish('fictional-byte-producer-eviction', evictionWriter);
        await select(f, evictionCatalog);
        assert.equal(text(catalogFor(f).open('fictional-byte-producer-eviction')!), evictionEdited);
        assert.equal(text(catalogFor(f).open('fictional-byte-grown')!), changed);
      }
      if (chunks === 512) {
        const backup = await createBackup(f.db, f.root, f.profileId),
          root = join(f.root, 'recovered'),
          rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, root),
          db = openDatabase(rebuilt.database, f.profileId);
        f.recovered.push(db);
        attachPersonalDurability(db, {
          root,
          profileId: f.profileId,
          initialize: false,
        });
        const recovered = { ...f, db, root },
          restored = catalogFor(recovered);
        assert.equal(text(restored.open('fictional-byte-old')!), original);
        assert.equal(text(restored.open('fictional-byte-grown')!), changed);
        const restoredEdit = await edit(
          recovered,
          'fictional-byte-grown',
          'fictional-byte-recovered-edit',
          original,
        );
        assert.equal(restoredEdit.changedChunks, 1);
        assert.equal(restoredEdit.deletedChunks, 0);
        assert.equal(restoredEdit.writtenBytes, 1024);
        assert.equal(restoredEdit.checkpointChanges, 3);
        assert.equal(text(catalogFor(recovered).open('fictional-byte-grown')!), changed);
        observations.push({ recoveredScalar: restoredEdit });
      }
    }
    t.diagnostic(
      JSON.stringify({
        syntheticOwnerByteConstructionWork: observations,
        interval:
          'putText only; excludes enclosing map fork, catalog publication and final selection',
        recovery: 'contributor backup and rebuilt cache',
        resegmentationLimit:
          'unaligned insertion or deletion can change the remaining deterministic chunks; this fixture proves stable-position edits and exact suffix changes',
      }),
    );
  },
);

test(
  'real catalog byte codec preserves surrogate pairs split at producer and deterministic leaf boundaries',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      original = prefix + 'A'.repeat(1023 - prefix.length) + '🌿' + 'A'.repeat(72 * 1024) + suffix,
      changed = original.slice(0, 20000) + 'B' + original.slice(20001),
      catalog = catalogFor(f),
      writer = await catalog.fork();
    assert.match(original.slice(1023, 1025), /🌿/);
    await writer.putText(
      'warning',
      (function* () {
        for (let at = 0; at < original.length; at += 19) yield original.slice(at, at + 19);
      })(),
    );
    await catalog.publish('fictional-byte-old', writer);
    await select(f, catalog);
    assert.equal(text(catalogFor(f).open('fictional-byte-old')!), original);
    const work = await edit(f, 'fictional-byte-old', 'fictional-byte-unicode-edited', changed);
    assert.equal(work.changedChunks, 1);
    assert.equal(work.deletedChunks, 0);
    assert.equal(work.checkpointChanges, 3);
    assert.equal(text(catalogFor(f).open('fictional-byte-old')!), original);
  },
);

test(
  'real byte owner rejects forged foreign expired and logically stale adoption plus invalid replacement or truncation',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await seed(f, warning(64));
    const collections = selectedEnvelopeStore(f.db, {
        id: f.original.id,
      }).collections,
      getCap = () => {
        const value = catalogFor(f).open('fictional-byte-old')!.get('warning');
        assert.ok(value && typeof value !== 'string');
        return value;
      },
      prepare = (value: IntakeByteValue) => {
        const operationId = randomUUID();
        return collections.prepare(collections.openView(), {
          operationId,
          requestDigest: hash(operationId),
          domainVersion: intakeSourceVersion(f.db, f.original.id).rawVersion,
          changes: [
            {
              area: 'builds',
              collection: 'fictional.byte.adopted',
              op: 'adoptBytesReferenced',
              value,
            },
          ],
        });
      };
    const prior = getCap();
    await commit(f, [
      {
        area: 'builds',
        collection: 'fictional.byte.adopted',
        op: 'adoptBytesReferenced',
        value: prior,
      },
    ]);
    const descriptor = () =>
      collections.collection(collections.openView(), 'builds', 'fictional.byte.adopted')!;
    assert.equal(descriptor().bytes, 64 * 1024);
    assert.equal(descriptor().root?.count, 64);
    await commit(f, [
      {
        area: 'builds',
        collection: 'fictional.byte.adopted',
        op: 'replaceBytes',
        index: 32,
        bytes: Buffer.alloc(1024, 67),
      },
    ]);
    assert.equal(descriptor().bytes, 64 * 1024);
    assert.equal(descriptor().root?.count, 64);
    await commit(f, [
      {
        area: 'builds',
        collection: 'fictional.byte.adopted',
        op: 'truncateBytes',
        length: 63,
      },
    ]);
    assert.equal(descriptor().bytes, 63 * 1024);
    assert.equal(descriptor().root?.count, 63);
    const invalid: IntakeCollectionChange[] = [
      {
        area: 'builds',
        collection: 'fictional.byte.adopted',
        op: 'replaceBytes',
        index: 63,
        bytes: Buffer.from('x'),
      },
      {
        area: 'builds',
        collection: 'fictional.byte.adopted',
        op: 'replaceBytes',
        index: 0,
        bytes: Buffer.alloc(0),
      },
      {
        area: 'builds',
        collection: 'fictional.byte.adopted',
        op: 'replaceBytes',
        index: 0,
        bytes: Buffer.alloc(4097),
      },
      {
        area: 'builds',
        collection: 'fictional.byte.adopted',
        op: 'truncateBytes',
        length: 61,
      },
    ];
    for (const change of invalid) {
      const operationId = randomUUID();
      assert.throws(
        () =>
          collections.prepare(collections.openView(), {
            operationId,
            requestDigest: hash(operationId),
            domainVersion: intakeSourceVersion(f.db, f.original.id).rawVersion,
            changes: [change],
          }),
        /byte|index|chunk|truncation/,
      );
      assert.equal(descriptor().bytes, 63 * 1024);
      assert.equal(descriptor().root?.count, 63);
    }
    assert.equal(
      text(catalogFor(f).open('fictional-byte-old')!),
      warning(64),
      'an adopted mutable fork never changes its historical reference',
    );
    await commit(f, [
      {
        area: 'builds',
        collection: 'fictional.byte.single',
        op: 'appendBytes',
        bytes: Buffer.from('fictional'),
      },
    ]);
    await commit(f, [
      {
        area: 'builds',
        collection: 'fictional.byte.single',
        op: 'truncateBytes',
        length: 0,
      },
    ]);
    const empty = collections.collection(
      collections.openView(),
      'builds',
      'fictional.byte.single',
    )!;
    assert.equal(empty.bytes, 0);
    assert.equal(empty.root, null);
    assert.throws(() => prepare({ ...prior } as IntakeByteValue), /byte reference/);
    const foreign = await fixture(t);
    await seed(foreign, warning(64));
    const foreignCap = catalogFor(foreign).open('fictional-byte-old')!.get('warning');
    assert.ok(foreignCap && typeof foreignCap !== 'string');
    assert.throws(() => prepare(foreignCap), /byte reference/);
    const other = uploadIntake(f.db, f.root, f.profileId, {
      filename: 'fictional-foreign-source.txt',
      bytes: Buffer.from('A different independently fictional source'),
      newProviderName: 'Invented Byte Clinic',
    });
    await buildIntakeCollectionEnvelope(f.db, { id: other.id });
    const otherCollections = selectedEnvelopeStore(f.db, {
        id: other.id,
      }).collections,
      operationId = randomUUID();
    assert.throws(
      () =>
        otherCollections.prepare(otherCollections.openView(), {
          operationId,
          requestDigest: hash(operationId),
          domainVersion: intakeSourceVersion(f.db, other.id).rawVersion,
          changes: [
            {
              area: 'builds',
              collection: 'fictional.cross.source',
              op: 'adoptBytesReferenced',
              value: getCap(),
            },
          ],
        }),
      /byte reference/,
    );
    const stale = getCap();
    await updateIntakeMetadataRead(f.db, f.root, f.profileId, f.original.id, {
      version: intakeSourceVersion(f.db, f.original.id).rawVersion,
      operationId: 'fictional-byte-logical-progress',
      metadata: { topics: ['Independently fictional metadata change'] },
    });
    assert.throws(() => prepare(stale), /byte reference/);
    const expired = getCap();
    clearIntakeCollectionCache(f.db);
    assert.throws(() => prepare(expired), /byte reference/);
  },
);

test(
  'real catalog raw byte pages read a linear number of variable UTF-8 leaves and preserve exact boundaries',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const samples: Array<{
      bytes: number;
      leaves: number;
      reads: number;
      pages: number;
    }> = [];
    for (const repeats of [16000, 128000]) {
      const value = 'Fictional ' + 'A🌿界\\'.repeat(repeats),
        id = 'fictional-cursor-' + repeats;
      await seed(f, value, id);
      const reader = catalogFor(f).open(id)!;
      const descriptor = reader.get('warning');
      assert.ok(descriptor && typeof descriptor !== 'string');
      const before = intakeWorkCounters(f.db).warm.collectionByteChunkReads;
      let position = { after: null as string | null, skip: 0 },
        pages = 0;
      const pieces: Buffer[] = [];
      for (;;) {
        const page = reader.bytePage('warning', position);
        pages++;
        assert.ok(page.data.length > 0 && page.data.length <= 32768);
        pieces.push(page.data);
        if (page.complete) break;
        position = { after: page.after, skip: page.skip };
      }
      assert.deepEqual(Buffer.concat(pieces), Buffer.from(value));
      const reads = intakeWorkCounters(f.db).warm.collectionByteChunkReads - before;
      // At most one partial leaf, bounded lookahead and one budget leaf per page;
      // this bound would fail a byte-zero prefix replay across the whole traversal.
      assert.ok(
        reads <= descriptor.chunks + pages * 8,
        JSON.stringify({ reads, leaves: descriptor.chunks, pages }),
      );
      samples.push({
        bytes: descriptor.bytes,
        leaves: descriptor.chunks,
        reads,
        pages,
      });
      assert.throws(() => reader.bytePage('warning', { after: null, skip: 4096 }), /position/);
      assert.throws(
        () => reader.bytePage('warning', { after: '9999999999999999', skip: 0 }),
        /ordinal/,
      );
    }
    t.diagnostic(JSON.stringify({ linearRawBytePageWork: samples }));
  },
);
