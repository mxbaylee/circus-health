/** Real existing catalog/byte owner and contributor durability. Warning rows are
 * synthetic owner inputs; these cases make no native policy/model claim. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database.ts';
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
