import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { IntakeBatch } from '../../shared/intake-batch.ts';
import {
  assertCurrentIntakeBatch,
  clearIntakeBatchJournalCache,
  cloneIntakeBatch,
  copyIntakeBatchJournals,
  createIntakeBatchJournalWorkCounters,
  forgetIntakeBatchJournal,
  readIntakeBatch,
  refreshIntakeBatch,
  registerIntakeBatchPublication,
  trackIntakeBatch,
  withIntakeBatchJournalWork,
  writeIntakeBatch,
} from '../intake-batch-journal.ts';
import { profilePaths } from '../profile-storage.ts';
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), 'fictional-queue-authority-')),
    profileId = 'fictional-person';
  fs.mkdirSync(profilePaths(root, profileId).root, { recursive: true });
  const value: IntakeBatch = {
    id: randomUUID(),
    profileId,
    operationId: 'fictional-operation',
    status: 'paused',
    reason: null,
    currentIndex: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: [],
  };
  const batch = trackIntakeBatch(value),
    directory = join(profilePaths(root, profileId).root, 'intake-batches', batch.id, 'events');
  t.after(() => {
    clearIntakeBatchJournalCache(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    profileId,
    batch,
    directory,
    write: (reason = 'checkpoint') => writeIntakeBatch(root, profileId, batch, reason),
    read: () => readIntakeBatch(root, profileId, batch.id),
  };
}
function events(directory: string) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
}
function mockFs(t: test.TestContext) {
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test('tracked writes retain exact sequential object order, append evidence and isolate supplied aliases', (t) => {
  const f = fixture(t);
  f.write('initial');
  const supplied = { operationId: 'first', intakeIds: ['fictional-a'], at: 'fictional-time' };
  f.batch.appendOperations = [supplied];
  supplied.intakeIds.push('outside-alias');
  f.batch.appendOperations[0]!.intakeIds.push('fictional-b');
  f.batch.appendOperations[0]!.at = 'changed-time';
  delete (f.batch as Partial<IntakeBatch>).reason;
  f.batch.reason = 'reinserted-last';
  f.write();
  assert.equal(JSON.stringify(f.read()), JSON.stringify(f.batch));
  assert.deepEqual(f.read().appendOperations?.[0]?.intakeIds, ['fictional-a', 'fictional-b']);
  assert.equal(Object.keys(f.read()).at(-1), 'reason');
  const event = JSON.parse(fs.readFileSync(join(f.directory, events(f.directory).at(-1)!), 'utf8'));
  assert.deepEqual(
    event.changes[0].value[0].intakeIds,
    ['fictional-a'],
    'earlier sequential operation payload cannot be mutated by later operations',
  );
});

test('one field change does no retained-state clone, history read, hash or diff', (t) => {
  const f = fixture(t);
  f.batch.appendOperations = Array.from({ length: 300 }, (_, i) => ({
    operationId: `fictional-${i}`,
    intakeIds: ['fictional-'.repeat(1000)],
    at: '2026-01-01',
  }));
  f.write('initial');
  const work = createIntakeBatchJournalWorkCounters();
  withIntakeBatchJournalWork(work, () => {
    f.batch.reason = 'small';
    f.write();
  });
  assert.equal(work.eventReads, 0);
  assert.equal(work.replayedEvents, 0);
  assert.equal(work.directoryEntries, 0);
  assert.equal(work.diffCalls, 0);
  assert.ok(work.mutationCloneNodes < 10);
  assert.ok(work.replayCloneNodes < 10);
  assert.ok(work.hashedBytes < 1000);
  assert.ok(work.eventWriteBytes < 1000);
  assert.equal(work.headWrites, 1);
  const noChange = createIntakeBatchJournalWorkCounters();
  withIntakeBatchJournalWork(noChange, () => f.write());
  assert.equal(noChange.eventWrites, 0);
  assert.equal(noChange.headWrites, 0);
  assert.equal(JSON.stringify(f.read()), JSON.stringify(f.batch));
});

test('stale writer and untracked snapshot refuse without overwriting newer progress', (t) => {
  const f = fixture(t);
  f.write();
  const stale = f.read();
  f.batch.reason = 'newer';
  f.write();
  stale.reason = 'stale';
  assert.throws(() => writeIntakeBatch(f.root, f.profileId, stale, 'stale'), /changed/);
  const detached = cloneIntakeBatch(f.read());
  detached.reason = 'untracked';
  assert.throws(() => writeIntakeBatch(f.root, f.profileId, detached, 'snapshot'), /changed/);
  assert.equal(f.read().reason, 'newer');
  assert.equal(events(f.directory).length, 2);
});

test('descriptor access stays tracked; detached children and invalid mutation forms refuse', (t) => {
  const f = fixture(t);
  f.batch.appendOperations = [{ operationId: 'a', intakeIds: [], at: 'before' }];
  f.write();
  const descriptor = Object.getOwnPropertyDescriptor(f.batch, 'appendOperations')!;
  descriptor.value[0].at = 'descriptor-change';
  f.write();
  assert.equal(f.read().appendOperations![0]!.at, 'descriptor-change');
  assert.throws(() => {
    (f.batch as any).__proto__.fictionalPollution = true;
  }, /Invalid tracked/);
  assert.throws(() => {
    (f.batch.items as any).__proto__.fictionalPollution = true;
  }, /Invalid tracked/);
  assert.equal(Object.hasOwn(Object.prototype, 'fictionalPollution'), false);
  assert.equal(Object.hasOwn(Array.prototype, 'fictionalPollution'), false);
  const stale = f.batch.appendOperations![0]!;
  f.batch.appendOperations = [];
  assert.throws(() => {
    stale.at = 'detached';
  }, /Invalid tracked/);
  assert.throws(
    () => Object.defineProperty(f.batch, 'reason', { get: () => 'getter' }),
    /Invalid tracked/,
  );
  assert.throws(() => {
    (f.batch as any).__proto__ = {};
  }, /Invalid tracked/);
  assert.throws(() => {
    f.batch.items.length = 2;
  }, /Invalid tracked/);
  f.batch.appendOperations = f.batch.appendOperations;
  f.write();
  assert.deepEqual(f.read().appendOperations, []);
});

test('refresh after failure preserves surviving item references and rebinds only authoritative progress', (t) => {
  const f = fixture(t);
  f.batch.appendOperations = [{ operationId: 'a', intakeIds: [], at: 'saved' }];
  f.write();
  const item = f.batch.appendOperations![0]!;
  item.at = 'unsaved';
  forgetIntakeBatchJournal(f.batch);
  assert.throws(() => f.write(), /changed/);
  refreshIntakeBatch(f.root, f.profileId, f.batch);
  assert.equal(item.at, 'saved');
  item.at = 'retried';
  f.write();
  assert.equal(f.read().appendOperations![0]!.at, 'retried');
  clearIntakeBatchJournalCache(f.root, f.profileId);
  assert.throws(() => {
    f.batch.reason = 'after-lock';
  }, /Invalid tracked/);
});

test('cold validation catches historical corruption, missing markers and unknown event files', (t) => {
  const f = fixture(t);
  f.write();
  f.batch.reason = 'second';
  f.write();
  const first = join(f.directory, events(f.directory)[0]!);
  const bytes = fs.readFileSync(first);
  fs.writeFileSync(first, bytes.toString().replace('fictional-operation', 'fictional-corrupted'));
  assert.throws(() => f.read(), /Invalid/);
  fs.writeFileSync(first, bytes);
  const marker = fs.readFileSync(join(f.directory, 'current'));
  fs.unlinkSync(join(f.directory, 'current'));
  assert.throws(() => f.read(), /Invalid/);
  fs.writeFileSync(join(f.directory, 'current'), marker);
  fs.writeFileSync(join(f.directory, 'unsupported.json'), '{}');
  assert.throws(() => f.read(), /Invalid/);
});

test('warm selected-event tampering and hardlinked authority refuse', (t) => {
  const f = fixture(t);
  f.write();
  const tail = join(f.directory, events(f.directory)[0]!);
  fs.writeFileSync(tail, fs.readFileSync(tail));
  f.batch.reason = 'change';
  assert.throws(() => f.write(), /Invalid/);
  const retained = tail + '.retained';
  fs.linkSync(tail, retained);
  assert.throws(() => f.read(), /Invalid/);
});

test('supported legacy history adopts v3 without changing bytes and old discovery sees unsupported format', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.directory, { recursive: true });
  const name = '000000000001-' + randomUUID() + '.json';
  const bytes = Buffer.from(
    JSON.stringify({
      format: 'health-intake-batch-v1',
      profileId: f.profileId,
      sequence: 1,
      reason: 'legacy',
      savedAt: '2026-01-01T00:00:00.000Z',
      batch: cloneIntakeBatch(f.batch),
    }),
  );
  fs.writeFileSync(join(f.directory, name), bytes);
  const loaded = f.read();
  loaded.reason = 'new progress';
  writeIntakeBatch(f.root, f.profileId, loaded, 'adopted');
  assert.deepEqual(fs.readFileSync(join(f.directory, name)), bytes);
  assert.equal(f.read().reason, 'new progress');
  const oldRecognized = events(f.directory).filter((name) =>
    /^\d{12}-[0-9a-f-]{36}\.json$/.test(name),
  );
  assert.equal(oldRecognized.length, 2);
  assert.equal(
    JSON.parse(fs.readFileSync(join(f.directory, oldRecognized[1]!), 'utf8')).format,
    'health-intake-batch-delta-v3',
  );
  const copy = join(f.root, 'copy');
  const paths = copyIntakeBatchJournals(f.root, f.profileId, copy);
  assert.equal(paths.length, 3);
  assert.equal(readIntakeBatch(copy, f.profileId, loaded.id).reason, 'new progress');
  assert.ok(paths.every((path) => !path.includes('writer.lock') && !path.includes('unpublished')));
});

test('publication flushes staging removals before selecting and acknowledging the new head', (t) => {
  const f = fixture(t);
  f.write();
  const source = fs.statSync(join(f.directory, '..', 'unpublished'));
  const target = fs.statSync(f.directory);
  const order: string[] = [];
  mockFs(t);
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (...args: Parameters<typeof unlink>) => {
    unlink(...args);
    order.push('unlink-event-staging');
  });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
    rename(...args);
    if (basename(String(args[1])) === 'current') order.push('select-head');
  });
  const fsync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    fsync(fd);
    const stat = fs.fstatSync(fd);
    if (stat.dev === source.dev && stat.ino === source.ino) order.push('flush-source');
    if (stat.dev === target.dev && stat.ino === target.ino) order.push('flush-events');
  });
  syncBuiltinESMExports();
  f.batch.reason = 'decision';
  f.write();
  order.push('acknowledged');
  assert.deepEqual(order, [
    'unlink-event-staging',
    'flush-source',
    'flush-events',
    'select-head',
    'flush-source',
    'flush-events',
    'acknowledged',
  ]);
});

for (const boundary of [
  'staging',
  'event-link',
  'event-source-sync',
  'before-head',
  'after-head',
  'head-source-sync',
] as const)
  test(`failure at ${boundary} recovers selected state and retry records one decision`, (t) => {
    const f = fixture(t);
    f.write();
    const previous = JSON.stringify(f.batch);
    const notifications: string[][] = [];
    t.after(
      registerIntakeBatchPublication(f.root, f.profileId, (names) => notifications.push(names)),
    );
    f.batch.reason = 'decision';
    const next = JSON.stringify(f.batch);
    const selected = boundary === 'after-head' || boundary === 'head-source-sync';
    mockFs(t);
    let failed = false;
    if (boundary === 'staging') {
      const original = fs.writeFileSync;
      t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof original>) => {
        if (!failed) {
          failed = true;
          throw Error('fictional staging failure');
        }
        return original(...args);
      });
    } else if (boundary === 'event-link') {
      const original = fs.linkSync;
      t.mock.method(fs, 'linkSync', (...args: Parameters<typeof original>) => {
        if (!failed) {
          failed = true;
          throw Error('fictional event-link failure');
        }
        return original(...args);
      });
    } else if (boundary === 'event-source-sync' || boundary === 'head-source-sync') {
      const original = fs.fsyncSync;
      const source = fs.statSync(join(f.directory, '..', 'unpublished'));
      let sourceFlushes = 0;
      t.mock.method(fs, 'fsyncSync', (fd: number) => {
        const stat = fs.fstatSync(fd);
        if (stat.dev === source.dev && stat.ino === source.ino) {
          sourceFlushes++;
          if (!failed && sourceFlushes === (boundary === 'event-source-sync' ? 1 : 2)) {
            failed = true;
            throw Error('fictional source-directory flush failure');
          }
        }
        return original(fd);
      });
    } else {
      const original = fs.renameSync;
      t.mock.method(fs, 'renameSync', (...args: Parameters<typeof original>) => {
        if (!failed && basename(String(args[1])) === 'current') {
          failed = true;
          if (boundary === 'after-head') original(...args);
          throw Error('fictional publication failure');
        }
        return original(...args);
      });
    }
    syncBuiltinESMExports();
    assert.throws(() => f.write(), /fictional/);
    assert.ok(failed);
    if (selected)
      assert.ok(
        notifications.some((names) => names.some((name) => name.endsWith('.json'))),
        'uncertain selected publication is delivered to encrypted vault',
      );
    else assert.equal(notifications.length, 0);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    const recovered = f.read();
    assert.equal(JSON.stringify(recovered), selected ? next : previous);
    refreshIntakeBatch(f.root, f.profileId, f.batch);
    f.batch.reason = 'decision';
    f.write();
    assert.equal(f.read().reason, 'decision');
    assert.equal(events(f.directory).length, 2);
  });

test('a crash-left unselected event never becomes committed and is retained outside authority on retry', (t) => {
  const f = fixture(t);
  f.write();
  const head = JSON.parse(fs.readFileSync(join(f.directory, 'current'), 'utf8'));
  const orphanName = '000000000002-' + randomUUID() + '.json';
  const orphanBytes = Buffer.from(
    JSON.stringify({
      format: 'health-intake-batch-delta-v3',
      profileId: f.profileId,
      batchId: f.batch.id,
      sequence: 2,
      previous: head.tail,
      reason: 'unacknowledged',
      savedAt: '2026-01-01T00:00:01.000Z',
      changes: [{ op: 'set', path: ['reason'], value: 'orphan' }],
    }),
  );
  fs.writeFileSync(join(f.directory, orphanName), orphanBytes);
  const reopened = f.read();
  assert.equal(reopened.reason, null);
  reopened.reason = 'retry';
  writeIntakeBatch(f.root, f.profileId, reopened, 'retry');
  assert.equal(f.read().reason, 'retry');
  assert.equal(events(f.directory).length, 2);
  const pending = join(f.directory, '..', 'unpublished');
  const retained = fs.readdirSync(pending).find((name) => name.startsWith(orphanName));
  assert.ok(retained);
  assert.deepEqual(fs.readFileSync(join(pending, retained)), orphanBytes);
});

test('a crash before first selected event retains empty selection and can retry creation', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.directory, { recursive: true });
  const head = {
    format: 'health-intake-batch-head-v3',
    profileId: f.profileId,
    batchId: f.batch.id,
    tail: null,
    usage: { eventBytes: 0 },
    legacy: null,
  };
  fs.writeFileSync(join(f.directory, 'current'), JSON.stringify(head));
  const orphanName = '000000000001-' + randomUUID() + '.json';
  const orphanBytes = Buffer.from(
    JSON.stringify({
      format: 'health-intake-batch-delta-v3',
      profileId: f.profileId,
      batchId: f.batch.id,
      sequence: 1,
      previous: null,
      reason: 'unacknowledged',
      savedAt: '2026-01-01T00:00:00.000Z',
      changes: [{ op: 'set', path: [], value: cloneIntakeBatch(f.batch) }],
    }),
  );
  fs.writeFileSync(join(f.directory, orphanName), orphanBytes);
  assert.throws(() => f.read(), /not found/);
  f.write('creation retry');
  assert.equal(events(f.directory).length, 1);
  assert.equal(f.read().operationId, 'fictional-operation');
});

test('legacy v2 truncation/removal semantics and original ordering remain readable after adoption', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.directory, { recursive: true });
  const initial = cloneIntakeBatch(f.batch);
  initial.selectionIntakeIds = ['one', 'two', 'three'];
  const names = [
    '000000000001-' + randomUUID() + '.json',
    '000000000002-' + randomUUID() + '.json',
  ];
  const initialBytes = JSON.stringify({
    format: 'health-intake-batch-v1',
    profileId: f.profileId,
    sequence: 1,
    reason: 'legacy',
    savedAt: '2026-01-01T00:00:00Z',
    batch: initial,
  });
  const deltaBytes = JSON.stringify({
    format: 'health-intake-batch-delta-v2',
    profileId: f.profileId,
    batchId: f.batch.id,
    sequence: 2,
    reason: 'legacy delta',
    savedAt: '2026-01-01T00:00:01Z',
    changes: [
      [['selectionIntakeIds', '1'], 'changed'],
      [['selectionIntakeIds', 'length'], 2],
    ],
    removed: [['selectionIntakeIds', '2']],
  });
  fs.writeFileSync(join(f.directory, names[0]!), initialBytes);
  fs.writeFileSync(join(f.directory, names[1]!), deltaBytes);
  const loaded = f.read();
  assert.deepEqual(loaded.selectionIntakeIds, ['one', 'changed']);
  loaded.reason = 'adopted';
  writeIntakeBatch(f.root, f.profileId, loaded, 'adoption');
  assert.deepEqual(f.read().selectionIntakeIds, ['one', 'changed']);
  assert.equal(fs.readFileSync(join(f.directory, names[0]!), 'utf8'), initialBytes);
  assert.equal(fs.readFileSync(join(f.directory, names[1]!), 'utf8'), deltaBytes);
});

test('process death between immutable link and staging unlink preserves acknowledged head and retries safely', (t) => {
  const f = fixture(t);
  f.write();
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {readIntakeBatch,writeIntakeBatch} from ${JSON.stringify(new URL('../intake-batch-journal.ts', import.meta.url).href)}; const batch=readIntakeBatch(${JSON.stringify(f.root)},${JSON.stringify(f.profileId)},${JSON.stringify(f.batch.id)});batch.reason='unacknowledged';const original=fs.linkSync;fs.linkSync=(...args)=>{original(...args);process.exit(73);};syncBuiltinESMExports();writeIntakeBatch(${JSON.stringify(f.root)},${JSON.stringify(f.profileId)},batch,'interrupted');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 73, result.stderr);
  const reopened = f.read();
  assert.equal(reopened.reason, null);
  reopened.reason = 'retry';
  writeIntakeBatch(f.root, f.profileId, reopened, 'retried');
  assert.equal(f.read().reason, 'retry');
  assert.equal(events(f.directory).length, 2);
});

test('current assertions check stale and corrupt authority without publishing pending edits', (t) => {
  const f = fixture(t);
  f.write();
  f.batch.reason = 'pending';
  const work = createIntakeBatchJournalWorkCounters();
  withIntakeBatchJournalWork(work, () => assertCurrentIntakeBatch(f.root, f.profileId, f.batch));
  assert.equal(work.currentAssertions, 1);
  assert.equal(work.eventReads, 0);
  assert.equal(work.eventWrites, 0);
  assert.equal(work.changeCloneNodes, 0);
  assert.equal(f.read().reason, null);
  const other = f.read();
  other.reason = 'external';
  writeIntakeBatch(f.root, f.profileId, other, 'external');
  assert.throws(() => assertCurrentIntakeBatch(f.root, f.profileId, f.batch), /changed/);
  const current = f.read();
  const tail = join(f.directory, events(f.directory).at(-1)!);
  fs.writeFileSync(tail, fs.readFileSync(tail));
  assert.throws(() => assertCurrentIntakeBatch(f.root, f.profileId, current), /Invalid/);
});

test('archive copy streams batches once to its sink and preserves per-journal publication notifications', (t) => {
  const f = fixture(t),
    target = join(f.root, 'streamed-batches');
  const expected = new Map<string, IntakeBatch>();
  for (let ordinal = 0; ordinal < 4; ordinal++) {
    const batch = trackIntakeBatch({
      ...f.batch,
      id: randomUUID(),
      operationId: 'fictional-' + ordinal,
      items: [],
    });
    writeIntakeBatch(f.root, f.profileId, batch, 'initial');
    batch.reason = 'Fictional progress ' + ordinal;
    writeIntakeBatch(f.root, f.profileId, batch, 'progress');
    expected.set(batch.id, batch);
  }
  const notifications: string[][] = [];
  const stop = registerIntakeBatchPublication(target, f.profileId, (names) =>
    notifications.push(names),
  );
  const work = createIntakeBatchJournalWorkCounters();
  let files = 0;
  try {
    const collected = withIntakeBatchJournalWork(work, () =>
      copyIntakeBatchJournals(f.root, f.profileId, target, {
        onFile(path) {
          files++;
          assert.equal(fs.existsSync(join(target, path)), true);
        },
      }),
    );
    assert.equal(collected.length, 0);
    assert.equal(files, 12);
    assert.equal(work.replayedEvents, 8);
    assert.equal(work.copiedEvents, 8);
    assert.equal(notifications.length, 4);
    for (const names of notifications) {
      assert.equal(names.length, 3);
      assert.ok(names.at(-1)?.endsWith('/current'));
    }
    for (const [id, batch] of expected)
      assert.deepEqual(readIntakeBatch(target, f.profileId, id), batch);
  } finally {
    stop();
    clearIntakeBatchJournalCache(target);
  }
});
