import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import nodeFs, { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, clinicalReviewRevision, type Database } from '../database.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { ensureNativeIntakeSchema } from '../intake.ts';
import {
  hasIntakeCollectionEnvelope,
  iterateIntakeEnvelopeText,
  openIntakeCollectionEnvelope,
  prepareIntakeEnvelopeFieldMutation,
  selectedEnvelopeStore,
  stageIntakeEnvelopeFieldMutation,
} from '../intake-collection-envelope.ts';
import { clearIntakeStateCache, createIntakeStateStorage } from '../intake-state-storage.ts';
import { validateProductionIntakeAuthority } from '../intake-state-bootstrap.ts';
import { attachRecordDurability, rebuildRecordDatabase } from '../record-versions.ts';
import {
  contributorAuthorityPath,
  openContributorRecordStorage,
} from '../contributor-record-storage.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { intakeSourcePinKey, writeIntakeSourcePin } from '../intake-source-pin.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { createSourceDetailsSearch } from '../source-details-search.ts';
import {
  holdReadOnlySourceTextProjection,
  sourceTextProjectionReadOnly,
  sourceTextProjectionCounters,
} from '../source-text-projection.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(
  t: test.TestContext,
  histories = 3,
  largeUnits = 160_000,
  raw = true,
  leadingUnits = 0,
  contributor = false,
) {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-schema-resume-'));
  const identity = {
    profileId: 'fictional-schema-resume-profile',
    intakeId: 'fictional-schema-resume-source',
    sourceHash: sha('independently fictional original bytes'),
  };
  const db = openDatabase(join(directory, 'source.sqlite'), identity.profileId);
  const authority = contributor
    ? (() => {
        ensureProfileDirectories(directory, identity.profileId);
        const storage = openContributorRecordStorage(directory, identity.profileId, {
          initialize: true,
        });
        attachRecordDurability(db, { profileId: identity.profileId, storage });
        return {
          storage,
          attach(next: Database) {
            attachRecordDurability(next, { profileId: identity.profileId, storage });
          },
        };
      })()
    : memoryRecordAuthority(db);
  const input = {
    unknown: '🌿\\\"'.repeat(Math.ceil(largeUnits / 4)),
    intake: {
      version: 7,
      originalName: 'fictional-resume.zip',
      state: 'pending',
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: Array.from({ length: histories }, (_, ordinal) => ({
          id: ordinal < 2 ? 'same-public-id' : `fictional-candidate-${ordinal}`,
          marker: ordinal,
          versions: [
            {
              id: `fictional-version-${ordinal}`,
              status: 'pending',
              occurrences: [],
            },
          ],
        })),
      },
    },
  };
  const text = raw
    ? ' '.repeat(leadingUnits) +
      ' {"duplicate":1,"duplicate":2,' +
      JSON.stringify(input).slice(1) +
      '\n'
    : JSON.stringify(input);
  const initial = prepareInitialIntakeEnvelope(raw ? text : input);
  transaction(db, () => {
    db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(
      'fictional-schema-resume-provider',
      'Fictional resume clinic',
    );
    db.prepare(
      'INSERT INTO source_files(id,provider_id,path,sha256,bytes,kind,details_json,mime_type) VALUES(?,?,?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      'fictional-schema-resume-provider',
      `data/profiles/${identity.profileId}/sources/fictional-resume.zip`,
      identity.sourceHash,
      23,
      'intake_original',
      initial.detailsJson,
      'application/zip',
    );
    writeIntakeSourcePin(db, identity.intakeId, {
      revisionId: null,
      dependencyToken: null,
      requiresInterpretation: false,
      version: 1,
    });
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  const source = {
    id: identity.intakeId,
    kind: 'intake_original',
    sha256: identity.sourceHash,
  };
  const opened = [db];
  t.after(() => {
    for (const item of opened) {
      clearIntakeStateCache(item);
      if (item.isOpen) item.close();
    }
    if ('close' in authority.storage && typeof authority.storage.close === 'function')
      authority.storage.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const writes = { calls: 0, bytes: 0 };
  const write = authority.storage.writeImmutable.bind(authority.storage);
  authority.storage.writeImmutable = (name, bytes) => {
    writes.calls++;
    writes.bytes += bytes.length;
    write(name, bytes);
  };
  function rebuild() {
    clearIntakeStateCache(db);
    db.close();
    rmSync(join(directory, 'source.sqlite'), { force: true });
    const path = join(directory, randomUUID() + '.sqlite');
    rebuildRecordDatabase(path, {
      profileId: identity.profileId,
      storage: authority.storage,
    });
    const rebuilt = openDatabase(path, identity.profileId);
    opened.push(rebuilt);
    validateProductionIntakeAuthority(rebuilt, identity.profileId);
    authority.attach(rebuilt);
    return rebuilt;
  }
  return { db, source, identity, initial, text, rebuild, writes, directory };
}
function selectedProgress(db: Database, source: { id: string }) {
  const { collections } = selectedEnvelopeStore(db, source);
  const page = collections.range(collections.openView(), 'builds', 'schema.resume', {
    items: 16,
    bytes: 64 * 1024,
  });
  assert.equal(page.complete, true);
  assert.equal(page.items.length, 1);
  const item = page.items[0]!;
  assert.equal(typeof item.value, 'string');
  const raw = item.value as string;
  return {
    collections,
    build: item.key,
    raw,
    value: JSON.parse(raw) as { count: number; digest: string },
  };
}
async function pauseAfter(db: Database, source: { id: string }, checkpoints: number) {
  let seen = 0;
  await assert.rejects(
    () =>
      buildIntakeCollectionEnvelope(db, source, {
        onCheckpoint: () => {
          if (++seen === checkpoints) throw Error('fictional checkpoint pause');
        },
      }),
    /fictional checkpoint pause/,
  );
  return selectedProgress(db, source);
}

test('missing progress and zero-count progress refuse retained main or oversized-leading-whitespace blob data', async (t) => {
  for (const blobOnly of [false, true]) {
    const f = fixture(t, 3, 0, true, blobOnly ? 100_000 : 0);
    const paused = await pauseAfter(f.db, f.source, 1);
    const view = paused.collections.openView();
    assert.equal(
      paused.collections.collection(view, 'builds', paused.build) === undefined,
      blobOnly,
    );
    if (blobOnly)
      assert.equal(
        paused.collections.hasCollectionPrefix(view, 'builds', paused.build + '.'),
        true,
      );
    const id = randomUUID();
    paused.collections.commitMaintenance(
      paused.collections.prepare(view, {
        operationId: id,
        requestDigest: sha(id),
        domainVersion: 7,
        changes: [{ area: 'builds', collection: 'schema.resume', op: 'delete', key: paused.build }],
      }),
    );
    const before = { ...f.writes };
    await assert.rejects(
      () => ensureNativeIntakeSchema(f.db, f.identity.profileId, f.source.id),
      /missing progress for retained build data/,
    );
    assert.deepEqual(f.writes, before);
    const zero = { ...paused.value, count: 0, digest: sha('') };
    const nextId = randomUUID();
    paused.collections.commitMaintenance(
      paused.collections.prepare(paused.collections.openView(), {
        operationId: nextId,
        requestDigest: sha(nextId),
        domainVersion: 7,
        changes: [
          {
            area: 'builds',
            collection: 'schema.resume',
            op: 'put',
            key: paused.build,
            value: JSON.stringify(zero),
          },
        ],
      }),
    );
    const zeroBefore = { ...f.writes };
    await assert.rejects(
      () => ensureNativeIntakeSchema(f.db, f.identity.profileId, f.source.id),
      /missing progress for retained build data/,
    );
    assert.deepEqual(f.writes, zeroBefore);
  }
});

test('namespace presence lookup authenticates area, bounded prefix and current opaque view', async (t) => {
  const f = fixture(t, 3, 0);
  const paused = await pauseAfter(f.db, f.source, 1);
  const view = paused.collections.openView();
  assert.equal(paused.collections.hasCollectionPrefix(view, 'builds', paused.build), true);
  assert.equal(paused.collections.hasCollectionPrefix(view, 'builds', 'absent.'), false);
  assert.throws(
    () => paused.collections.hasCollectionPrefix(view, 'foreign' as 'builds', 'schema.'),
    /collection area/,
  );
  const current = paused.collections.openView();
  for (const prefix of ['', '*', 'a'.repeat(129)]) {
    assert.throws(
      () => paused.collections.hasCollectionPrefix(current, 'builds', prefix),
      /collection name|expired collection view/,
    );
  }
  const stale = paused.collections.openView();
  const id = randomUUID();
  paused.collections.commitMaintenance(
    paused.collections.prepare(stale, {
      operationId: id,
      requestDigest: sha(id),
      domainVersion: 7,
      changes: [
        { area: 'builds', collection: 'fictional.other', op: 'put', key: 'one', value: 'one' },
      ],
    }),
  );
  assert.throws(
    () => paused.collections.hasCollectionPrefix(stale, 'builds', 'schema.'),
    /stale collection view/,
  );
});

test('conversion result and production aggregate counters count the actual transcript, scratch and export work', async (t) => {
  const f = fixture(t, 2, 0);
  const before = intakeWorkCounters(f.db).warm;
  let cleanCheckpoints = 0;
  const built = await buildIntakeCollectionEnvelope(f.db, f.source, {
    onCheckpoint: () => {
      assert.equal(f.db.prepare('SELECT count(*) AS count FROM __record_changed').get()!.count, 0);
      cleanCheckpoints++;
    },
  });
  assert.ok(cleanCheckpoints > 1);
  const after = intakeWorkCounters(f.db).warm;
  for (const [local, metric] of Object.entries({
    operations: 'schemaBuildOperations',
    replayedOperations: 'schemaBuildReplayedOperations',
    transcriptHashBytes: 'schemaBuildTranscriptHashBytes',
    scratchReadBytes: 'schemaBuildScratchReadBytes',
    scratchWrittenBytes: 'schemaBuildScratchWrittenBytes',
    replayYields: 'schemaBuildReplayYields',
    validationHashBytes: 'schemaBuildValidationHashBytes',
    validationChunks: 'schemaBuildValidationChunks',
    validationYields: 'schemaBuildValidationYields',
    sourceHashBytes: 'schemaBuildSourceHashBytes',
  })) {
    assert.equal(
      built.work[local as keyof typeof built.work],
      after[metric as keyof typeof after] - before[metric as keyof typeof before],
    );
  }
  assert.equal(built.work.sourceHashBytes, Buffer.byteLength(f.text));
  assert.equal(built.work.validationHashBytes, Buffer.byteLength(f.text));
  assert.ok(built.work.scratchReadBytes > 0);
});

test('maintenance and transaction staging refuse asynchronous publication guards before accepted writes', async (t) => {
  for (const stage of [false, true]) {
    const f = fixture(t, 2, 0);
    const paused = await pauseAfter(f.db, f.source, 1);
    const id = randomUUID();
    const prepared = paused.collections.prepare(paused.collections.openView(), {
      operationId: id,
      requestDigest: sha(id),
      domainVersion: 7,
      changes: [
        { area: 'builds', collection: 'fictional.guard', op: 'put', key: 'one', value: 'one' },
      ],
    });
    const before = { ...f.writes };
    const options = { assertCurrent: () => Promise.resolve() };
    assert.throws(
      () =>
        stage
          ? transaction(f.db, () => paused.collections.stage(prepared, options))
          : paused.collections.commitMaintenance(prepared, options),
      /guard must finish synchronously/,
    );
    assert.deepEqual(f.writes, before);
  }
});

test('real contributor HEAD final physical checks refuse committed peer ABA and pre-mutation local rollback ABA', async (t) => {
  for (const boundary of [
    'source-final',
    'progress-final',
    'commit-ready',
    'transaction-begin',
  ] as const) {
    const f = fixture(t, 3, 0, true, 0, true);
    const paused = await pauseAfter(f.db, f.source, 1);
    const headPath = join(contributorAuthorityPath(f.directory, f.identity.profileId), 'head');
    const peer = new DatabaseSync(String(f.db.prepare('PRAGMA database_list').get()!.file));
    const physicalStat = nodeFs.lstatSync;
    const stackTraceLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 64;
    const before = {
      writes: { ...f.writes },
      nodes: intakeWorkCounters(f.db).warm.collectionNodesWritten,
    };
    let injected = false;
    let stimulus:
      | {
          transaction: boolean;
          before: unknown;
          after: unknown;
          row: unknown;
          capture: unknown;
          stack: string;
        }
      | undefined;
    Reflect.set(nodeFs, 'lstatSync', ((selected, ...args) => {
      const result = Reflect.apply(physicalStat, nodeFs, [selected, ...args]);
      if (String(selected) !== headPath || injected) return result;
      const stack = new Error('fictional physical HEAD stimulus').stack!;
      const selectedBoundary =
        boundary === 'source-final'
          ? stack.includes('assertCurrent') && !stack.includes('assertProgress')
          : boundary === 'progress-final'
            ? stack.includes('assertProgress') && stack.includes('runRead')
            : boundary === 'commit-ready'
              ? stack.includes('commitMaintenance') && !f.db.isTransaction
              : stack.includes('Object.begin') && f.db.isTransaction;
      if (!selectedBoundary) return result;
      injected = true;
      const key = 'fictional-real-head-aba';
      if (boundary === 'transaction-begin') {
        const stamp = f.db.prepare('SELECT total_changes() AS changes');
        const original = stamp.get()!.changes;
        f.db.exec('SAVEPOINT fictional_real_head_aba');
        f.db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(key, 'changed');
        f.db.exec('ROLLBACK TO fictional_real_head_aba');
        f.db.exec('RELEASE fictional_real_head_aba');
        stimulus = {
          transaction: f.db.isTransaction,
          before: original,
          after: stamp.get()!.changes,
          row: f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key),
          capture: f.db.prepare('SELECT count(*) AS count FROM __record_changed').get()!.count,
          stack,
        };
      } else {
        const original = f.db.prepare('PRAGMA data_version').get()!.data_version;
        peer.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(key, 'changed');
        peer.prepare('DELETE FROM app_meta WHERE key=?').run(key);
        stimulus = {
          transaction: f.db.isTransaction,
          before: original,
          after: f.db.prepare('PRAGMA data_version').get()!.data_version,
          row: peer.prepare('SELECT value FROM app_meta WHERE key=?').get(key),
          capture: f.db.prepare('SELECT count(*) AS count FROM __record_changed').get()!.count,
          stack,
        };
      }
      return result;
    }) as typeof nodeFs.lstatSync);
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => ensureNativeIntakeSchema(f.db, f.identity.profileId, f.source.id),
        /authority changed during preparation/,
      );
    } finally {
      Error.stackTraceLimit = stackTraceLimit;
      Reflect.set(nodeFs, 'lstatSync', physicalStat);
      syncBuiltinESMExports();
      peer.close();
    }
    // Prove the physical stimulus completed and restored its SQL rows outside
    // assert.rejects, so a setup/injection exception cannot qualify refusal.
    assert.equal(injected, true, `${boundary} reached its physical HEAD stat`);
    assert.ok(stimulus);
    assert.notEqual(stimulus.after, stimulus.before, 'actual SQL invalidation witness advanced');
    assert.equal(
      stimulus.row,
      undefined,
      'both committed peer writes or the local rollback restored the exact rows',
    );
    assert.equal(stimulus.capture, 0, 'local rollback restored captured rows, too');
    assert.equal(stimulus.transaction, boundary === 'transaction-begin');
    assert.deepEqual(f.writes, before.writes);
    assert.equal(intakeWorkCounters(f.db).warm.collectionNodesWritten, before.nodes);
    assert.equal(selectedProgress(f.db, f.source).raw, paused.raw);
    assert.equal(hasIntakeCollectionEnvelope(f.db, f.source), false);
  }
});

for (const raw of [false, true])
  test(`production ${raw ? 'raw' : 'normalized'} conversion reuses interrupted oversized-cell prefix after disposable SQLite loss`, async (t) => {
    const f = fixture(t, 3, 160_000, raw);
    const revision = clinicalReviewRevision(f.db);
    const pin = f.db
      .prepare('SELECT value FROM app_meta WHERE key=?')
      .get(intakeSourcePinKey(f.source.id))!.value;
    const paused = await pauseAfter(f.db, f.source, 3);
    assert.ok(paused.value.count >= 126);
    assert.equal(hasIntakeCollectionEnvelope(f.db, f.source), false);
    const prefixRoot = paused.collections.collection(
      paused.collections.openView(),
      'builds',
      paused.build,
    );
    const db = f.rebuild();
    const before = {
      writes: { ...f.writes },
      counters: intakeWorkCounters(db).warm,
    };
    await assert.rejects(
      () =>
        ensureNativeIntakeSchema(db, f.identity.profileId, f.source.id, {
          assertRunning: () => {
            if (intakeWorkCounters(db).warm.schemaBuildReplayedOperations === paused.value.count)
              throw Error('fictional stop at retained prefix');
          },
        }),
      /fictional stop at retained prefix/,
    );
    assert.deepEqual(f.writes, before.writes);
    assert.equal(
      intakeWorkCounters(db).warm.collectionNodesWritten,
      before.counters.collectionNodesWritten,
    );
    const retained = selectedProgress(db, f.source);
    assert.equal(retained.build, paused.build);
    assert.equal(retained.raw, paused.raw);
    assert.deepEqual(
      retained.collections.collection(retained.collections.openView(), 'builds', retained.build),
      prefixRoot,
    );
    const replayed = intakeWorkCounters(db).warm.schemaBuildReplayedOperations;
    await ensureNativeIntakeSchema(db, f.identity.profileId, f.source.id);
    assert.equal(
      intakeWorkCounters(db).warm.schemaBuildReplayedOperations - replayed,
      paused.value.count,
    );
    assert.ok(intakeWorkCounters(db).warm.schemaBuildTranscriptHashBytes > 0);
    assert.ok(intakeWorkCounters(db).warm.schemaBuildReplayYields > 0);
    assert.equal(
      intakeWorkCounters(db).warm.schemaBuildValidationHashBytes,
      Buffer.byteLength(f.text),
    );
    assert.ok(intakeWorkCounters(db).warm.schemaBuildValidationYields > 0);
    assert.equal([...iterateIntakeEnvelopeText(db, f.source)].join(''), f.text);
    validateProductionIntakeAuthority(db, f.identity.profileId);
    assert.equal(clinicalReviewRevision(db), revision);
    assert.equal(f.db.isOpen, false);
    assert.equal(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(f.source.id)!.details_json,
      f.initial.detailsJson,
    );
    assert.equal(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(intakeSourcePinKey(f.source.id))!
        .value,
      pin,
    );
    const reader = openIntakeCollectionEnvelope(db, f.source);
    const intake = reader.child(reader.root(), 'intake')!;
    assert.deepEqual(reader.field(intake, 'version', { bytes: 32 }), {
      kind: 'value',
      value: 7,
    });
    const workflow = reader.child(intake, 'workflow')!;
    const first = reader.find('candidate', workflow, 'same-public-id', {
      match: 'first',
    })!;
    const last = reader.find('candidate', workflow, 'same-public-id', {
      match: 'last',
    })!;
    assert.deepEqual(reader.field(first, 'marker', { bytes: 32 }), {
      kind: 'value',
      value: 0,
    });
    assert.deepEqual(reader.field(last, 'marker', { bytes: 32 }), {
      kind: 'value',
      value: 1,
    });
    if (raw) {
      const firstReader = openIntakeCollectionEnvelope(db, f.source, {
        fieldSelection: 'first',
      });
      assert.deepEqual(firstReader.field(firstReader.root(), 'duplicate', { bytes: 32 }), {
        kind: 'value',
        value: 1,
      });
      assert.deepEqual(reader.field(reader.root(), 'duplicate', { bytes: 32 }), {
        kind: 'value',
        value: 2,
      });
    }
  });

test('malformed, mismatched and overlong progress refuses before publishing a fresh prefix', async (t) => {
  for (const shape of ['null', 'bad-digest', 'zero-count', 'overlong']) {
    const f = fixture(t, 2, 0);
    const paused = await pauseAfter(f.db, f.source, 1);
    const bad =
      shape === 'null'
        ? null
        : {
            ...paused.value,
            ...(shape === 'bad-digest' ? { digest: 'a'.repeat(64) } : {}),
            ...(shape === 'zero-count' ? { count: 0 } : {}),
            ...(shape === 'overlong' ? { count: 1_000_000 } : {}),
          };
    const id = randomUUID();
    paused.collections.commitMaintenance(
      paused.collections.prepare(paused.collections.openView(), {
        operationId: id,
        requestDigest: sha(id),
        domainVersion: 7,
        changes: [
          {
            area: 'builds',
            collection: 'schema.resume',
            op: 'put',
            key: paused.build,
            value: JSON.stringify(bad),
          },
        ],
      }),
    );
    const before = { ...f.writes };
    await assert.rejects(
      () => ensureNativeIntakeSchema(f.db, f.identity.profileId, f.source.id),
      /invalid progress|prefix transcript|prefix exceeds/,
    );
    assert.deepEqual(f.writes, before);
    assert.equal([...iterateIntakeEnvelopeText(f.db, f.source)].join(''), f.text);
  }
});

test('active conversion refuses changed-and-restored source metadata and rollback across checkpoint gaps', async (t) => {
  for (const rollback of [false, true]) {
    const f = fixture(t, 3, 0);
    let changed = false;
    await assert.rejects(
      () =>
        buildIntakeCollectionEnvelope(f.db, f.source, {
          onCheckpoint: () => {
            if (changed) return;
            changed = true;
            const modify = () =>
              f.db
                .prepare('UPDATE source_files SET details_json=? WHERE id=?')
                .run(f.initial.detailsJson + ' ', f.source.id);
            if (rollback)
              assert.throws(
                () =>
                  transaction(f.db, () => {
                    modify();
                    throw Error('fictional rollback');
                  }),
                /fictional rollback/,
              );
            else {
              modify();
              f.db
                .prepare('UPDATE source_files SET details_json=? WHERE id=?')
                .run(f.initial.detailsJson, f.source.id);
            }
          },
        }),
      /authority changed|source binding changed/,
    );
    assert.equal(hasIntakeCollectionEnvelope(f.db, f.source), false);
  }
});

test('direct concurrent conversion cannot rewind a later authenticated checkpoint', async (t) => {
  const f = fixture(t, 3, 0);
  let release!: () => void;
  let reached!: () => void;
  const checkpoint = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = buildIntakeCollectionEnvelope(f.db, f.source, {
    onCheckpoint: async () => {
      reached();
      await hold;
    },
  });
  const refused = assert.rejects(first, /authority changed|progress changed/);
  await checkpoint;
  try {
    const later = await pauseAfter(f.db, f.source, 1);
    assert.ok(later.value.count > 63);
    const after = { ...f.writes };
    release();
    await refused;
    assert.deepEqual(f.writes, after);
    assert.equal(selectedProgress(f.db, f.source).raw, later.raw);
    await ensureNativeIntakeSchema(f.db, f.identity.profileId, f.source.id);
    assert.equal([...iterateIntakeEnvelopeText(f.db, f.source)].join(''), f.text);
  } finally {
    release();
  }
});

test('cold conversion and fixed warm edit count node and accepted journal writes separately at two history sizes', async (t) => {
  const rows = [];
  for (const histories of [4, 24]) {
    const f = fixture(t, histories, 0, false);
    const start = intakeWorkCounters(f.db).warm;
    const coldBefore = { ...f.writes };
    await ensureNativeIntakeSchema(f.db, f.identity.profileId, f.source.id);
    const cold = intakeWorkCounters(f.db).warm;
    const reader = openIntakeCollectionEnvelope(f.db, f.source);
    const intake = reader.child(reader.root(), 'intake')!;
    const id = randomUUID();
    const prepared = prepareIntakeEnvelopeFieldMutation(f.db, f.source, {
      reader,
      record: intake,
      field: 'version',
      jsonText: '8',
      operationId: id,
      requestDigest: sha(id),
      domainVersion: 8,
    });
    const warmBefore = { ...f.writes };
    const nodeBefore = intakeWorkCounters(f.db).warm;
    const nextText = f.text.replace('"version":7', '"version":8');
    const next = prepareInitialIntakeEnvelope(JSON.parse(nextText));
    transaction(f.db, () => {
      stageIntakeEnvelopeFieldMutation(f.db, f.source, prepared);
      f.db
        .prepare('UPDATE source_files SET details_json=? WHERE id=?')
        .run(next.detailsJson, f.source.id);
    });
    const warm = intakeWorkCounters(f.db).warm;
    rows.push({
      histories,
      coldNodes: cold.collectionNodesWritten - start.collectionNodesWritten,
      coldNodeBytes: cold.collectionWrittenBytes - start.collectionWrittenBytes,
      coldJournalWrites: warmBefore.calls - coldBefore.calls,
      coldJournalBytes: warmBefore.bytes - coldBefore.bytes,
      warmNodes: warm.collectionNodesWritten - nodeBefore.collectionNodesWritten,
      warmNodeBytes: warm.collectionWrittenBytes - nodeBefore.collectionWrittenBytes,
      warmJournalWrites: f.writes.calls - warmBefore.calls,
      warmJournalBytes: f.writes.bytes - warmBefore.bytes,
    });
    assert.ok(rows.at(-1)!.coldNodes > 0);
    assert.ok(rows.at(-1)!.coldJournalBytes > 0);
    assert.equal([...iterateIntakeEnvelopeText(f.db, f.source)].join(''), nextText);
  }
  assert.ok(rows[1]!.coldNodes > rows[0]!.coldNodes);
  assert.ok(rows[1]!.coldJournalBytes > rows[0]!.coldJournalBytes);
  // A fixed edit copies authenticated tree paths, rather than the retained schema.
  assert.ok(rows[1]!.warmNodes < rows[1]!.coldNodes / 4);
  assert.ok(rows[1]!.warmJournalBytes < rows[1]!.coldJournalBytes / 4);
  assert.ok(rows[1]!.warmNodes <= rows[0]!.warmNodes * 2 + 8);
  assert.ok(rows[1]!.warmJournalBytes <= rows[0]!.warmJournalBytes * 2 + 16 * 1024);
  t.diagnostic(JSON.stringify(rows));
});

function exactSearch(db: Database, text: string | string[], query: string, limits = {}) {
  const expected = (Array.isArray(text) ? text : [text]).reduce(
    (sum, value) => sum + Number(db.prepare('SELECT ? LIKE ? n').get(value, '%' + query + '%')!.n),
    0,
  );
  const plan = createSourceDetailsSearch(db, query, { limits });
  try {
    const actual = Number(
      db
        .prepare('SELECT count(*) n FROM source_files f WHERE ' + plan.predicate)
        .get(...plan.parameters)!.n,
    );
    assert.equal(actual, expected);
  } finally {
    plan.dispose();
  }
}
function rawSearchWitness(db: Database) {
  return JSON.stringify([
    db.prepare('SELECT total_changes() n').get(),
    db.prepare('PRAGMA data_version').get(),
    db.prepare('PRAGMA schema_version').get(),
    db.prepare('PRAGMA temp.schema_version').get(),
  ]);
}

test('conversion source search preserves exact text without projection SQL writes and releases its read scope', async (t) => {
  for (const warm of [false, true]) {
    const f = fixture(t, 3, 12000);
    const otherText =
      '{"duplicate":"retained neighbor","duplicate":"shown neighbor","escape":"\\u0041\\ud800","unicode":' +
      JSON.stringify('b'.repeat(2500) + 'boundaryΩ😀 ending') +
      '}';
    transaction(f.db, () => {
      f.db
        .prepare(
          'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
        )
        .run(
          'fictional-search-neighbor',
          'fictional-neighbor.txt',
          sha('fictional neighbor original'),
          0,
          'derived',
          otherText,
        );
    });
    const texts = [f.text, otherText];
    if (warm) exactSearch(f.db, texts, 'same-public-id');
    let inspected = 0;
    const built = await buildIntakeCollectionEnvelope(f.db, f.source, {
      onCheckpoint() {
        if (inspected++ >= 2) return;
        assert.equal(sourceTextProjectionReadOnly(f.db), true);
        const before = rawSearchWitness(f.db);
        const counters = structuredClone(sourceTextProjectionCounters(f.db));
        for (const query of [
          'same-public-id',
          'fictional-resume.zip',
          'absent fictional phrase',
          'retained neighbor',
          'shown neighbor',
          '\\u0041',
          '\\ud800',
          'boundaryΩ😀',
          'shown neighbor\",\"escape',
        ])
          exactSearch(f.db, texts, query);
        assert.throws(
          () => exactSearch(f.db, f.text, 'same-public-id', { maxReconstructedBytes: 1 }),
          /limit/,
        );
        assert.equal(rawSearchWitness(f.db), before);
        assert.equal(
          sourceTextProjectionCounters(f.db).projectionWrites,
          counters.projectionWrites,
        );
        assert.ok(sourceTextProjectionCounters(f.db).authorityBytes > counters.authorityBytes);
        // A nested host read scope cannot release this active preparation's lease.
        const release = holdReadOnlySourceTextProjection(f.db, () => {});
        release();
        release();
        assert.equal(sourceTextProjectionReadOnly(f.db), true);
      },
    });
    assert.ok(inspected >= 2);
    assert.equal(built.sourceTextHash, sha(f.text));
    assert.equal(sourceTextProjectionReadOnly(f.db), false);
    const beforeRepair = rawSearchWitness(f.db);
    exactSearch(f.db, texts, 'same-public-id');
    assert.notEqual(rawSearchWitness(f.db), beforeRepair);
    assert.equal([...iterateIntakeEnvelopeText(f.db, f.source)].join(''), f.text);
  }
  const cancelled = fixture(t, 3, 12000);
  let checkpoint = false;
  let heldPlan: ReturnType<typeof createSourceDetailsSearch> | undefined;
  await assert.rejects(
    () =>
      buildIntakeCollectionEnvelope(cancelled.db, cancelled.source, {
        onCheckpoint() {
          checkpoint = true;
          exactSearch(cancelled.db, cancelled.text, 'same-public-id');
          heldPlan = createSourceDetailsSearch(cancelled.db, 'same-public-id');
          throw Error('fictional search checkpoint cancellation');
        },
      }),
    /fictional search checkpoint cancellation/,
  );
  assert.equal(checkpoint, true);
  assert.equal(sourceTextProjectionReadOnly(cancelled.db), false);
  assert.ok(heldPlan);
  const beforePlanRepair = rawSearchWitness(cancelled.db);
  try {
    const expected = Number(
      cancelled.db.prepare('SELECT ? LIKE ? n').get(cancelled.text, '%same-public-id%')!.n,
    );
    const actual = Number(
      cancelled.db
        .prepare('SELECT count(*) n FROM source_files f WHERE ' + heldPlan.predicate)
        .get(...heldPlan.parameters)!.n,
    );
    assert.equal(actual, expected);
    assert.notEqual(rawSearchWitness(cancelled.db), beforePlanRepair);
  } finally {
    heldPlan.dispose();
  }
  // A fresh production invocation verifies/replays the retained prefix normally.
  await ensureNativeIntakeSchema(cancelled.db, cancelled.identity.profileId, cancelled.source.id);
  assert.equal(
    [...iterateIntakeEnvelopeText(cancelled.db, cancelled.source)].join(''),
    cancelled.text,
  );
});

test('conversion search does not credit unrelated SQL, TEMP or rolled-back writes', async (t) => {
  for (const stimulus of ['local', 'temp', 'rollback', 'peer'] as const) {
    const f = fixture(t, 3, 0);
    f.db.exec('CREATE TEMP TABLE fictional_search_observer(id TEXT PRIMARY KEY)');
    const peer =
      stimulus === 'peer'
        ? new DatabaseSync(String(f.db.prepare('PRAGMA database_list').get()!.file))
        : undefined;
    let injected = false;
    let beforeInjection = '',
      afterInjection = '';
    let atInjection = { ...f.writes };
    try {
      await assert.rejects(
        () =>
          buildIntakeCollectionEnvelope(f.db, f.source, {
            onCheckpoint() {
              if (injected) return;
              exactSearch(f.db, f.text, 'same-public-id');
              beforeInjection = rawSearchWitness(f.db);
              const target = peer ?? f.db;
              if (stimulus === 'temp') {
                target.exec(
                  "INSERT INTO fictional_search_observer VALUES('fictional'); DELETE FROM fictional_search_observer",
                );
              } else if (stimulus === 'rollback') {
                target.exec('SAVEPOINT fictional_search_rollback');
                target.prepare('UPDATE source_files SET bytes=bytes+1 WHERE id=?').run(f.source.id);
                target.exec(
                  'ROLLBACK TO fictional_search_rollback; RELEASE fictional_search_rollback',
                );
              } else {
                target.exec('BEGIN IMMEDIATE');
                target.prepare('UPDATE source_files SET bytes=bytes+1 WHERE id=?').run(f.source.id);
                target.prepare('UPDATE source_files SET bytes=bytes-1 WHERE id=?').run(f.source.id);
                target.exec('COMMIT');
              }
              injected = true;
              atInjection = { ...f.writes };
              afterInjection = rawSearchWitness(f.db);
            },
          }),
        /authority changed|source binding changed/,
      );
      assert.equal(injected, true);
      assert.notEqual(afterInjection, beforeInjection);
      assert.deepEqual(f.writes, atInjection);
      assert.equal(sourceTextProjectionReadOnly(f.db), false);
      assert.equal(
        Number(f.db.prepare('SELECT bytes FROM source_files WHERE id=?').get(f.source.id)!.bytes),
        23,
      );
      assert.equal(hasIntakeCollectionEnvelope(f.db, f.source), false);
    } finally {
      peer?.close();
    }
  }
});

test('conversion search refuses preexisting bad authority outside path matches and candidate filters without SQL mutation', async (t) => {
  for (const warm of [false, true])
    for (const fault of ['malformed', 'unsupported', 'missing'] as const) {
      const f = fixture(t, 3, 0);
      if (warm) exactSearch(f.db, f.text, 'same-public-id');
      f.db.exec('PRAGMA ignore_check_constraints=ON');
      transaction(f.db, () => {
        f.db
          .prepare(
            'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
          )
          .run(
            'fictional-bad-search-neighbor',
            'fictional-neighbor.txt',
            sha('fictional bad neighbor original'),
            0,
            fault === 'missing' ? 'intake_original' : 'derived',
            fault === 'missing'
              ? prepareInitialIntakeEnvelope({
                  intake: { version: 0, workflow: { format: 'health-intake-workflow-v1' } },
                }).detailsJson
              : fault === 'malformed'
                ? '{'
                : JSON.stringify({
                    intake: { version: 0, workflow: { format: 'fictional-unsupported-workflow' } },
                  }),
          );
      });
      assert.equal(Number(f.db.prepare('SELECT count(*) n FROM __record_changed').get()!.n), 0);
      let inspected = false;
      const built = await buildIntakeCollectionEnvelope(f.db, f.source, {
        onCheckpoint() {
          if (inspected) return;
          const before = rawSearchWitness(f.db);
          const writes = { ...f.writes };
          const projectionWrites = sourceTextProjectionCounters(f.db).projectionWrites;
          // % matches every path. Candidate SQL selects only the valid converting
          // source; upfront validation must still refuse its malformed neighbor.
          assert.throws(() => {
            const plan = createSourceDetailsSearch(f.db, '%');
            try {
              f.db
                .prepare('SELECT count(*) n FROM source_files f WHERE f.id=? AND ' + plan.predicate)
                .get(f.source.id, ...plan.parameters);
            } finally {
              plan.dispose();
            }
          }, /authority|corrupt|JSON|unsupported|workflow|missing|head/);
          assert.equal(rawSearchWitness(f.db), before);
          assert.deepEqual(f.writes, writes);
          assert.equal(sourceTextProjectionCounters(f.db).projectionWrites, projectionWrites);
          inspected = true;
        },
      });
      assert.equal(inspected, true);
      assert.equal(built.sourceTextHash, sha(f.text));
      assert.equal(sourceTextProjectionReadOnly(f.db), false);
      assert.equal([...iterateIntakeEnvelopeText(f.db, f.source)].join(''), f.text);
      assert.equal(
        Number(
          f.db
            .prepare('SELECT count(*) n FROM source_files WHERE id=?')
            .get('fictional-bad-search-neighbor')!.n,
        ),
        1,
      );
    }
});
