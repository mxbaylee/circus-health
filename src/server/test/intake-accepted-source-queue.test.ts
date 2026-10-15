import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import nodeFs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDatabase, transaction } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { contributorAuthorityPath } from '../contributor-record-storage.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareIntakeCompactMetadata } from '../intake-compact-metadata.ts';
import { projectIntakeReferencedTargetCandidateAsync } from '../intake-state-migration.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import {
  withAcceptedSourceFileFormat,
  withAcceptedNativeIntakeSourceFormat,
  type AcceptedSourceFileFormatScope,
} from '../intake-accepted-source-format.ts';
import { closeRecordAcceptedIntakeHeadRead } from '../record-versions.ts';
import {
  captureReferencedEnvelopeReadFromFormat,
  closeReferencedEnvelopeRead,
  referencedEnvelopeCurrentSelection,
} from '../intake-referenced-envelope-access.ts';
import { committedColumnShmTimestampRefusal } from '../record-committed-column-reader.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';

type Work = ReturnType<typeof createRecordVersionWorkCounters>;
const counted = (work: Work, metric: keyof Work['operation']) =>
  work.operation[metric] + work.reconstruction[metric];

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-accepted-queue-')),
    profileId = 'fictional-accepted-queue',
    sourceId = 'fictional-accepted-queue-original',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  attachPersonalDurability(db, { root, profileId });
  const original = Buffer.from('Fictional queued accepted source.'),
    relativePath = paths.relativeRoot + '/sources/queued.txt';
  mkdirSync(dirname(join(root, relativePath)), { recursive: true });
  writeFileSync(join(root, relativePath), original);
  const initial = prepareInitialIntakeEnvelope({
    intake: { version: 1, originalName: 'fictional-queued.txt', state: 'ready' },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      sourceId,
      relativePath,
      createHash('sha256').update(original).digest('hex'),
      original.length,
      'intake_original',
      'text/plain',
      initial.detailsJson,
    );
  });
  const read = <T>(
    consume: (scope: AcceptedSourceFileFormatScope) => Promise<T> | T,
    assertRunning: () => void = () => {},
    options: { idempotent?: boolean } = {},
  ) =>
    withAcceptedSourceFileFormat(
      db,
      profileId,
      sourceId,
      assertRunning,
      (scope) => consume(scope),
      undefined,
      options,
    );
  return {
    db,
    read,
    path: paths.database,
    head: join(contributorAuthorityPath(root, profileId), 'head'),
    profileId,
    sourceId,
    sourceHash: createHash('sha256').update(original).digest('hex'),
  };
}
async function referencedFixture(t: TestContext) {
  const f = fixture(t),
    identity = { profileId: f.profileId, intakeId: f.sourceId, sourceHash: f.sourceHash },
    initial = prepareInitialIntakeEnvelope({
      intake: {
        version: 1,
        originalName: 'fictional-queued.txt',
        state: 'ready',
        metadata: { source: 'Fictional long metadata ' + 'x'.repeat(64 * 1024) },
      },
    });
  transaction(f.db, () => {
    f.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(initial.detailsJson, f.sourceId);
    createIntakeStateStorage(f.db, identity).stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(f.db, { id: f.sourceId, sha256: f.sourceHash });
  const collections = selectedEnvelopeStore(f.db, {
      id: f.sourceId,
      sha256: f.sourceHash,
    }).collections,
    before = collections.binding(collections.openView())!,
    headKey = intakeNamespace(identity) + 'head',
    headValue = String(f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(headKey)!.value),
    candidate = await projectIntakeReferencedTargetCandidateAsync(
      f.db,
      { identity, afterHead: headValue, writes: [] },
      () => {},
    );
  assert.ok(before.logical.root);
  assert.deepEqual(
    await prepareIntakeCompactMetadata(
      f.db,
      { id: f.sourceId, sha256: f.sourceHash },
      { referencedTargetCandidate: candidate },
    ),
    { changed: true },
  );
  return { ...f, identity };
}
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

function touchShmDuring(
  path: string,
  owner: 'committed-reader' | 'retained-format',
  maximum: number,
  onTouch: () => void = () => {},
  eligible: () => boolean = () => true,
) {
  const native = nodeFs.lstatSync;
  let observations = 0,
    touches = 0;
  const intercept = ((...args: Parameters<typeof native>) => {
    const value = Reflect.apply(native, nodeFs, args);
    if (String(args[0]) !== path + '-shm') return value;
    const stack = new Error().stack ?? '';
    const selected =
      owner === 'committed-reader'
        ? stack.includes('record-committed-column-reader.ts')
        : stack.includes('originalCurrent');
    if (!selected) return value;
    observations++;
    if (
      touches < maximum &&
      eligible() &&
      (owner === 'retained-format' || observations % 2 === 0)
    ) {
      const time = new Date(Date.now() + (touches + 1) * 60_000);
      nodeFs.utimesSync(path + '-shm', time, time);
      touches++;
      onTouch();
      return Reflect.apply(native, nodeFs, args);
    }
    return value;
  }) as typeof native;
  Object.defineProperty(nodeFs, 'lstatSync', { configurable: true, value: intercept });
  syncBuiltinESMExports();
  return {
    touches: () => touches,
    restore() {
      Object.defineProperty(nodeFs, 'lstatSync', { configurable: true, value: native });
      syncBuiltinESMExports();
    },
  };
}

test('accepted source proofs on one connection are admitted one at a time in FIFO order', async (t) => {
  const f = fixture(t),
    work = createRecordVersionWorkCounters(),
    order: string[] = [],
    first = gate(),
    entered = gate();
  await withRecordVersionWork(work, async () => {
    const a = f.read(async () => {
      order.push('a');
      entered.open();
      await first.opened;
      order.push('a-done');
    });
    await entered.opened;
    const b = f.read(() => void order.push('b'));
    const c = f.read(() => void order.push('c'));
    // Queued proofs do not start while the first is held.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(order, ['a']);
    first.open();
    await Promise.all([a, b, c]);
  });
  assert.deepEqual(order, ['a', 'a-done', 'b', 'c']);
  assert.equal(counted(work, 'acceptedSourceProofRetries'), 0);

  // Three uncontended admissions are the baseline; the two proofs queued behind
  // a held one poll for the whole hold, so they count strictly more.
  const sequential = createRecordVersionWorkCounters();
  await withRecordVersionWork(sequential, async () => {
    for (const value of ['one', 'two', 'three']) assert.equal(await f.read(() => value), value);
  });
  assert.ok(
    counted(work, 'acceptedSourceAdmissionWaits') >
      counted(sequential, 'acceptedSourceAdmissionWaits') + 2,
    `queued ${counted(work, 'acceptedSourceAdmissionWaits')} vs uncontended ${counted(sequential, 'acceptedSourceAdmissionWaits')}`,
  );
});

test('an uncontended accepted source admission counts no wait', async (t) => {
  const f = fixture(t),
    sequential = createRecordVersionWorkCounters();
  await withRecordVersionWork(sequential, async () => {
    await f.read(() => 'one');
    await f.read(() => 'two');
  });
  assert.equal(counted(sequential, 'acceptedSourceAdmissionWaits'), 0);
});

test('a queued accepted source proof is canceled while waiting without running its consumer', async (t) => {
  const f = fixture(t),
    first = gate(),
    entered = gate();
  let canceled = false,
    consumed = 0;
  const a = f.read(async () => {
    entered.open();
    await first.opened;
  });
  await entered.opened;
  const b = f.read(
    () => void consumed++,
    () => {
      if (canceled) throw Error('fictional waiter canceled');
    },
  );
  const c = f.read(() => 'after');
  canceled = true;
  await assert.rejects(b, /fictional waiter canceled/);
  first.open();
  await a;
  assert.equal(await c, 'after', 'a canceled waiter does not wedge the queue');
  assert.equal(consumed, 0);
});

test('a nested accepted source read in the held proof context does not queue behind itself', async (t) => {
  const f = fixture(t),
    work = createRecordVersionWorkCounters(),
    inner = createRecordVersionWorkCounters();
  let nested: unknown;
  // The nested read skips the queue (no self-deadlock) and completes. It is
  // read-only: its committed-reader opening is a node:sqlite snapshot that
  // moves no peer counter, so the outer proof stays current and completes.
  // (Its former refusal was the system-SQLite opening's WAL-index reset.)
  const outer = await withRecordVersionWork(work, () =>
    f.read(async () => {
      nested = await withRecordVersionWork(inner, () => f.read(() => 'nested'));
      return 'outer';
    }),
  );
  assert.equal(nested, 'nested');
  assert.equal(outer, 'outer');
  assert.equal(counted(inner, 'acceptedSourceAdmissionWaits'), 0, 'nested read never queued');
  assert.equal(counted(inner, 'acceptedSourceProofRetries'), 0);
  assert.equal(counted(work, 'acceptedSourceProofRetries'), 0, 'the outer proof is not retried');
});

test('an unchanged accepted source refusal stands after one attempt', async (t) => {
  const f = fixture(t),
    unchanged = createRecordVersionWorkCounters();
  let attempts = 0;
  await withRecordVersionWork(unchanged, async () => {
    await assert.rejects(
      f.read(
        () => {
          attempts++;
          throw Error('fictional unchanged refusal');
        },
        undefined,
        { idempotent: true },
      ),
      /fictional unchanged refusal/,
    );
  });
  assert.equal(attempts, 1);
  assert.equal(counted(unchanged, 'acceptedSourceProofRetries'), 0);
});

test('accepted source current runs one retained proof and refuses a same-byte HEAD rewrite', async (t) => {
  const f = fixture(t),
    work = createRecordVersionWorkCounters();
  let currentChecks = 0;
  await withRecordVersionWork(work, () =>
    f.read((scope) => {
      const before = counted(work, 'contributorReadOwnerCurrentChecks');
      scope.assertCurrent();
      currentChecks = counted(work, 'contributorReadOwnerCurrentChecks') - before;
    }),
  );
  assert.equal(
    currentChecks,
    6,
    'one retained current includes the bridge and owner closure checks',
  );
  const bytes = readFileSync(f.head);
  let consumed = 0;
  await assert.rejects(
    f.read((scope) => {
      consumed++;
      writeFileSync(f.head, bytes);
      assert.throws(() => scope.assertCurrent(), /original|source|authority|interval/i);
    }),
    /original|source|authority|interval/i,
  );
  assert.equal(consumed, 1, 'a refused consumer is never replayed');
});

test('referenced pair and borrowed head reuse their own complete current proofs', async (t) => {
  const f = await referencedFixture(t),
    work = createRecordVersionWorkCounters();
  let pairChecks = 0,
    borrowChecks = 0;
  await withRecordVersionWork(work, () =>
    withAcceptedNativeIntakeSourceFormat(
      f.db,
      f.profileId,
      f.sourceId,
      () => {},
      (scope) => {
        assert.equal(scope.format, 'referenced');
        const beforePair = counted(work, 'contributorReadOwnerCurrentChecks');
        const pair = scope.acceptedPair();
        pairChecks = counted(work, 'contributorReadOwnerCurrentChecks') - beforePair;
        const beforeBorrow = counted(work, 'contributorReadOwnerCurrentChecks');
        const borrowed = scope.borrowHead();
        try {
          borrowChecks = counted(work, 'contributorReadOwnerCurrentChecks') - beforeBorrow;
          assert.equal(borrowed.identity.sourceHash, f.sourceHash);
          assert.equal(borrowed.sourceVersionId, pair.sourceVersionId);
          assert.equal(
            pair.sourceVersionId,
            f.db
              .prepare(
                "SELECT version_id FROM __record_current WHERE entity='source_files' AND record_id=?",
              )
              .get(JSON.stringify([f.sourceId]))!.version_id,
          );
        } finally {
          closeRecordAcceptedIntakeHeadRead(borrowed.accepted);
        }
      },
      true,
    ),
  );
  assert.equal(pairChecks, 20, 'pair access uses only the retained owner and backend checks');
  assert.equal(borrowChecks, 48, 'borrow uses the pair, selected head and backend checks');
  let canceled = false,
    entered = 0;
  await assert.rejects(
    withAcceptedNativeIntakeSourceFormat(
      f.db,
      f.profileId,
      f.sourceId,
      () => {
        if (canceled) throw Error('fictional referenced read canceled');
      },
      (scope) => {
        entered++;
        scope.acceptedPair();
        canceled = true;
        assert.throws(() => scope.borrowHead(), /fictional referenced read canceled/);
      },
      true,
    ),
  );
  assert.equal(entered, 1, 'cancellation after consumer entry does not replay it');
  const bytes = readFileSync(f.head);
  entered = 0;
  await assert.rejects(
    withAcceptedNativeIntakeSourceFormat(
      f.db,
      f.profileId,
      f.sourceId,
      () => {},
      (scope) => {
        entered++;
        scope.acceptedPair();
        writeFileSync(f.head, bytes);
        assert.throws(() => scope.borrowHead(), /original|source|authority|interval/i);
      },
      true,
    ),
  );
  assert.equal(entered, 1, 'a changed original HEAD does not replay the consumer');
});

test('referenced envelope capture borrows one authenticated source version', async (t) => {
  const f = await referencedFixture(t),
    work = createRecordVersionWorkCounters();
  let captureChecks = 0;
  await withRecordVersionWork(work, () =>
    withAcceptedNativeIntakeSourceFormat(
      f.db,
      f.profileId,
      f.sourceId,
      () => {},
      async (scope) => {
        assert.equal(scope.format, 'referenced');
        const noDuplicatePair = Object.freeze({
          ...scope,
          acceptedPair: () => {
            throw Error('redundant accepted pair lookup');
          },
        });
        const before = counted(work, 'contributorReadOwnerCurrentChecks');
        const read = await captureReferencedEnvelopeReadFromFormat(
          f.db,
          noDuplicatePair,
          () => {},
          'current',
        );
        try {
          captureChecks = counted(work, 'contributorReadOwnerCurrentChecks') - before;
          assert.equal(
            referencedEnvelopeCurrentSelection(read).sourceVersionId,
            f.db
              .prepare(
                "SELECT version_id FROM __record_current WHERE entity='source_files' AND record_id=?",
              )
              .get(JSON.stringify([f.sourceId]))!.version_id,
          );
        } finally {
          closeReferencedEnvelopeRead(read);
        }
        await assert.rejects(
          captureReferencedEnvelopeReadFromFormat(
            f.db,
            Object.freeze({
              ...scope,
              borrowHead: () =>
                Object.freeze({ ...scope.borrowHead(), sourceVersionId: randomUUID() }),
            }),
            () => {},
            'current',
          ),
          /pair|version|source/i,
        );
      },
      true,
    ),
  );
  assert.equal(captureChecks, 196, 'the combined capture avoids a duplicate pair lookup');
  const bytes = readFileSync(f.head);
  let entered = 0;
  await assert.rejects(
    withAcceptedNativeIntakeSourceFormat(
      f.db,
      f.profileId,
      f.sourceId,
      () => {},
      (scope) => {
        entered++;
        return captureReferencedEnvelopeReadFromFormat(
          f.db,
          Object.freeze({
            ...scope,
            borrowHead: () => {
              const borrowed = scope.borrowHead();
              writeFileSync(f.head, bytes);
              return borrowed;
            },
          }),
          () => {},
          'current',
        );
      },
      true,
    ),
    /original|source|authority|interval/i,
  );
  assert.equal(entered, 1, 'a rewrite after borrow never replays the consumer');
});

test('same-file SHM timestamp movement restarts a cold proof before consumer entry', async (t) => {
  const f = fixture(t);
  assert.equal(await f.read(() => 'primed'), 'primed');
  const time = new Date(Date.now() + 60_000);
  nodeFs.utimesSync(f.path + '-shm', time, time);
  const touch = touchShmDuring(f.path, 'committed-reader', 1),
    work = createRecordVersionWorkCounters();
  let consumed = 0;
  try {
    assert.equal(await withRecordVersionWork(work, () => f.read(() => ++consumed)), 1);
  } finally {
    touch.restore();
  }
  assert.equal(touch.touches(), 1);
  assert.equal(consumed, 1);
  assert.equal(counted(work, 'acceptedSourceProofRetries'), 1);
  assert.equal(counted(work, 'acceptedSourceConcurrentWriteRetries'), 0);
  assert.equal(counted(work, 'acceptedSourceFormatColdReads'), 1);
  assert.equal(counted(work, 'acceptedSourceFormatHotHits'), 0);
  assert.ok(counted(work, 'acceptedSourceFormatVerifiedPreimageBytes') > 0);
  assert.equal(counted(work, 'acceptedSourceFormatCertificatePoints'), 1);
});

test('opening SHM timestamp drift discards a hot format without a proof retry', async (t) => {
  const f = fixture(t);
  assert.equal(await f.read(() => 'first'), 'first');
  const time = new Date(Date.now() + 60_000);
  nodeFs.utimesSync(f.path + '-shm', time, time);
  const work = createRecordVersionWorkCounters();
  assert.equal(await withRecordVersionWork(work, () => f.read(() => 'second')), 'second');
  assert.equal(counted(work, 'acceptedSourceProofRetries'), 0);
  assert.equal(counted(work, 'acceptedSourceFormatHotHits'), 0);
  assert.equal(counted(work, 'acceptedSourceFormatColdReads'), 1);
  assert.ok(counted(work, 'acceptedSourceFormatVerifiedPreimageBytes') > 0);
  assert.equal(counted(work, 'acceptedSourceFormatCertificatePoints'), 1);
});

for (const primed of [false, true])
  test(`a completed ${primed ? 'retained' : 'cold'} backend survives a refused SHM source proof without retaining its preimage`, async (t) => {
    const f = fixture(t);
    if (primed) {
      assert.equal(await f.read(() => 'primed'), 'primed');
      const time = new Date(Date.now() + 60_000);
      nodeFs.utimesSync(f.path + '-shm', time, time);
    }
    const work = createRecordVersionWorkCounters(),
      touch = touchShmDuring(
        f.path,
        'committed-reader',
        1,
        undefined,
        () => counted(work, 'acceptedSourceFormatColdReads') > 0,
      );
    let consumed = 0;
    try {
      const read = () =>
        withRecordVersionWork(work, () =>
          f.read((scope) => {
            scope.assertCurrent();
            return ++consumed;
          }),
        );
      if (primed) assert.equal(await read(), 1);
      else {
        // Initial preparation also moves the method epoch, so the existing
        // timestamp-only retry predicate refuses this attempt outright.
        await assert.rejects(read(), /Committed column file identity changed/);
        touch.restore();
        assert.equal(consumed, 0);
        assert.equal(await read(), 1);
      }
    } finally {
      touch.restore();
    }
    assert.equal(touch.touches(), 1);
    assert.equal(consumed, 1);
    assert.equal(counted(work, 'acceptedSourceProofRetries'), primed ? 1 : 0);
    assert.equal(counted(work, 'acceptedSourceConcurrentWriteRetries'), 0);
    assert.equal(counted(work, 'contributorBackingColdReplays'), primed ? 0 : 1);
    assert.equal(counted(work, 'acceptedSourceFormatColdReads'), 2);
    assert.equal(counted(work, 'acceptedSourceFormatHotHits'), 0);
    assert.ok(counted(work, 'acceptedSourceFormatVerifiedPreimageBytes') > 0);
    assert.equal(counted(work, 'acceptedSourceFormatCertificatePoints'), 1);
  });

for (const mutation of ['head', 'temp', 'method', 'source'] as const)
  test(`a refused cold SHM source proof does not retain across ${mutation} mutation`, async (t) => {
    const f = fixture(t);
    assert.equal(await f.read(() => 'primed'), 'primed');
    const time = new Date(Date.now() + 60_000);
    nodeFs.utimesSync(f.path + '-shm', time, time);
    const work = createRecordVersionWorkCounters(),
      head = readFileSync(f.head),
      touch = touchShmDuring(
        f.path,
        'committed-reader',
        1,
        () => {
          if (mutation === 'head') writeFileSync(f.head, head);
          else if (mutation === 'temp') f.db.exec('CREATE TEMP TABLE fictional_refused_source(id)');
          else if (mutation === 'method') f.db.function('fictional_refused_source_method', () => 1);
          else
            transaction(f.db, () => {
              f.db
                .prepare('UPDATE source_files SET coverage_status=? WHERE id=?')
                .run('fictional changed source', f.sourceId);
            });
        },
        () => counted(work, 'acceptedSourceFormatColdReads') > 0,
      );
    let consumed = 0;
    try {
      const reading = withRecordVersionWork(work, () => f.read(() => ++consumed));
      if (mutation === 'method') assert.equal(await reading, 1);
      else await assert.rejects(reading);
    } finally {
      touch.restore();
    }
    assert.equal(touch.touches(), 1);
    assert.equal(consumed, mutation === 'method' ? 1 : 0);
    assert.equal(counted(work, 'acceptedSourceProofRetries'), mutation === 'method' ? 1 : 0);
    if (mutation === 'method') {
      assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
      assert.equal(counted(work, 'acceptedSourceFormatColdReads'), 2);
      assert.ok(counted(work, 'acceptedSourceFormatVerifiedPreimageBytes') > 0);
      return;
    }
    const recovery = createRecordVersionWorkCounters();
    assert.equal(
      await withRecordVersionWork(recovery, () => f.read(() => 'recovered')),
      'recovered',
    );
    assert.equal(counted(recovery, 'contributorBackingColdReplays'), 1);
    assert.equal(counted(recovery, 'acceptedSourceFormatHotHits'), 0);
    assert.equal(counted(recovery, 'acceptedSourceFormatColdReads'), 1);
    assert.ok(counted(recovery, 'acceptedSourceFormatVerifiedPreimageBytes') > 0);
  });

test('an incomplete backend SHM refusal is discarded before cold recovery', async (t) => {
  const f = fixture(t);
  assert.equal(await f.read(() => 'primed'), 'primed');
  transaction(f.db, () => {
    f.db
      .prepare('UPDATE source_files SET coverage_status=? WHERE id=?')
      .run('fictional pending publication', f.sourceId);
  });
  for (let at = 0; at < 40; at++)
    transaction(f.db, () => {
      f.db
        .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
        .run(`fictional incomplete backend ${at}`, String(at));
    });
  const time = new Date(Date.now() + 60_000);
  nodeFs.utimesSync(f.path + '-shm', time, time);
  const emit = Worker.prototype.emit,
    work = createRecordVersionWorkCounters();
  let incomplete = false,
    consumed = 0;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { checkpoint?: boolean; baselineReady?: boolean } | undefined;
    if (event === 'message' && message?.checkpoint && message.baselineReady) incomplete = true;
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    await assert.rejects(
      withRecordVersionWork(work, () =>
        f.read(
          () => ++consumed,
          () => {
            if (incomplete)
              throw committedColumnShmTimestampRefusal('fictional incomplete backend');
          },
        ),
      ),
      /fictional incomplete backend/,
    );
  } finally {
    Worker.prototype.emit = emit;
  }
  assert.equal(incomplete, true, 'a genuine backing worker reached its checkpoint');
  assert.equal(consumed, 0);
  assert.equal(counted(work, 'acceptedSourceProofRetries'), 0);
  assert.equal(counted(work, 'acceptedSourceFormatColdReads'), 0);
  const recovery = createRecordVersionWorkCounters();
  assert.equal(await withRecordVersionWork(recovery, () => f.read(() => 'recovered')), 'recovered');
  assert.equal(counted(recovery, 'contributorBackingColdReplays'), 1);
  assert.ok(counted(recovery, 'acceptedSourceFormatVerifiedPreimageBytes') > 0);
});

test('SHM timestamp drift during a hot capture restarts from a cold proof', async (t) => {
  const f = fixture(t);
  assert.equal(await f.read(() => 'primed'), 'primed');
  const touch = touchShmDuring(f.path, 'retained-format', 1),
    work = createRecordVersionWorkCounters();
  let consumed = 0;
  try {
    assert.equal(await withRecordVersionWork(work, () => f.read(() => ++consumed)), 1);
  } finally {
    touch.restore();
  }
  assert.equal(touch.touches(), 1);
  assert.equal(consumed, 1);
  assert.equal(counted(work, 'acceptedSourceProofRetries'), 1);
  assert.equal(counted(work, 'acceptedSourceFormatColdReads'), 1);
  assert.equal(counted(work, 'acceptedSourceFormatHotHits'), 0);
  assert.ok(counted(work, 'acceptedSourceFormatVerifiedPreimageBytes') > 0);
  assert.equal(counted(work, 'acceptedSourceFormatCertificatePoints'), 1);
});

test('persistent SHM timestamp drift exhausts the existing four-proof budget', async (t) => {
  const f = fixture(t);
  assert.equal(await f.read(() => 'primed'), 'primed');
  const time = new Date(Date.now() + 60_000);
  nodeFs.utimesSync(f.path + '-shm', time, time);
  const touch = touchShmDuring(f.path, 'committed-reader', 4),
    work = createRecordVersionWorkCounters();
  let consumed = 0;
  try {
    await assert.rejects(
      withRecordVersionWork(work, () => f.read(() => ++consumed, undefined, { idempotent: true })),
      /Committed column file identity changed \(shared-memory index: mtimeNs,ctimeNs\)/,
    );
  } finally {
    touch.restore();
  }
  assert.equal(touch.touches(), 4);
  assert.equal(consumed, 0);
  assert.equal(counted(work, 'acceptedSourceFormatColdReads'), 0);
  assert.equal(counted(work, 'acceptedSourceProofRetries'), 3);
  assert.equal(counted(work, 'acceptedSourceConcurrentWriteRetries'), 0);
  assert.equal(counted(work, 'acceptedSourceFormatCertificatePoints'), 0);
});

test('SHM timestamp drift combined with TEMP schema mutation does not qualify for retry', async (t) => {
  const f = fixture(t);
  assert.equal(await f.read(() => 'primed'), 'primed');
  const time = new Date(Date.now() + 60_000);
  nodeFs.utimesSync(f.path + '-shm', time, time);
  const touch = touchShmDuring(f.path, 'committed-reader', 1, () => {
      f.db.exec('CREATE TEMP TABLE fictional_changed_interval(id INTEGER)');
    }),
    work = createRecordVersionWorkCounters();
  let consumed = 0;
  try {
    await assert.rejects(withRecordVersionWork(work, () => f.read(() => ++consumed)));
  } finally {
    touch.restore();
  }
  assert.equal(touch.touches(), 1);
  assert.equal(consumed, 0);
  assert.equal(counted(work, 'acceptedSourceProofRetries'), 0);
});

test('cancellation during SHM timestamp drift stops before a new proof', async (t) => {
  const f = fixture(t);
  assert.equal(await f.read(() => 'primed'), 'primed');
  const time = new Date(Date.now() + 60_000);
  nodeFs.utimesSync(f.path + '-shm', time, time);
  let canceled = false,
    consumed = 0;
  const touch = touchShmDuring(f.path, 'committed-reader', 1, () => {
      canceled = true;
    }),
    work = createRecordVersionWorkCounters();
  try {
    await assert.rejects(
      withRecordVersionWork(work, () =>
        f.read(
          () => ++consumed,
          () => {
            if (canceled) throw Error('fictional canceled SHM proof');
          },
        ),
      ),
      /fictional canceled SHM proof/,
    );
  } finally {
    touch.restore();
  }
  assert.equal(touch.touches(), 1);
  assert.equal(consumed, 0);
  assert.equal(counted(work, 'acceptedSourceProofRetries'), 0);
});

test('an idempotent consumer is not replayed after a same-file SHM timestamp refusal', async (t) => {
  const f = fixture(t),
    work = createRecordVersionWorkCounters();
  let consumed = 0;
  await withRecordVersionWork(work, async () => {
    await assert.rejects(
      f.read(
        () => {
          consumed++;
          const later = new Date(Date.now() + 60_000);
          nodeFs.utimesSync(f.path + '-shm', later, later);
          throw committedColumnShmTimestampRefusal('fictional post-consumer SHM refusal');
        },
        undefined,
        { idempotent: true },
      ),
      /fictional post-consumer SHM refusal/,
    );
  });
  assert.equal(consumed, 1);
  assert.equal(counted(work, 'acceptedSourceProofRetries'), 0);
});

test('an accepted source proof is retried after its interval moved, never after a non-idempotent consume', async (t) => {
  const f = fixture(t);
  let attempts = 0;
  // Moved interval (an open transaction), idempotent consumer: one complete
  // new proof after the transaction ends.
  const moved = createRecordVersionWorkCounters();
  await withRecordVersionWork(moved, async () => {
    const value = await f.read(
      () => {
        if (++attempts === 1) {
          f.db.exec('BEGIN');
          setTimeout(() => f.db.exec('COMMIT'), 20);
          throw Error('fictional moved refusal');
        }
        return 'accepted';
      },
      undefined,
      { idempotent: true },
    );
    assert.equal(value, 'accepted');
  });
  assert.equal(attempts, 2);
  assert.equal(counted(moved, 'acceptedSourceProofRetries'), 1);
  assert.ok(counted(moved, 'acceptedSourceTransactionWaits') >= 1);

  // Moved interval after a non-idempotent consumer ran: never repeated.
  const consumedOnce = createRecordVersionWorkCounters();
  attempts = 0;
  await withRecordVersionWork(consumedOnce, async () => {
    await assert.rejects(
      f.read(() => {
        attempts++;
        f.db.exec('BEGIN');
        setTimeout(() => f.db.exec('COMMIT'), 20);
        throw Error('fictional consumed refusal');
      }),
      // Closing the scope inside the open transaction may also refuse; the
      // consumer's own refusal is always the reported cause.
      (error: unknown) =>
        /fictional consumed refusal/.test(
          String(error instanceof AggregateError ? error.errors[0] : error),
        ),
    );
    while (f.db.isTransaction) await new Promise((resolve) => setTimeout(resolve, 5));
  });
  assert.equal(attempts, 1);
  assert.equal(counted(consumedOnce, 'acceptedSourceProofRetries'), 0);
});

test('an accepted source proof waits for an open transaction instead of refusing', async (t) => {
  const f = fixture(t),
    work = createRecordVersionWorkCounters();
  f.db.exec('BEGIN');
  setTimeout(() => f.db.exec('COMMIT'), 20);
  const value = await withRecordVersionWork(work, () => f.read(() => 'after transaction'));
  assert.equal(value, 'after transaction');
  assert.ok(counted(work, 'acceptedSourceTransactionWaits') >= 1);
  assert.equal(counted(work, 'acceptedSourceProofRetries'), 0);
});

test('a refusal after a concurrent same-connection write is retried and counted; the proof own writes are not', async (t) => {
  const f = fixture(t);
  let attempts = 0;
  // A write from outside the held proof (another request's maintenance on the
  // same connection) during the first attempt: one complete new proof.
  const concurrent = createRecordVersionWorkCounters(),
    started = gate(),
    written = gate();
  const writer = (async () => {
    await started.opened;
    transaction(f.db, () => {
      f.db
        .prepare('INSERT INTO people(id,display_name) VALUES(?,?)')
        .run('fictional-concurrent-person', 'Fictional Concurrent');
    });
    written.open();
  })();
  await withRecordVersionWork(concurrent, async () => {
    const value = await f.read(
      async () => {
        if (++attempts === 1) {
          started.open();
          await written.opened;
          throw Error('fictional concurrent refusal');
        }
        return 'accepted';
      },
      undefined,
      { idempotent: true },
    );
    assert.equal(value, 'accepted');
  });
  await writer;
  assert.equal(attempts, 2);
  assert.equal(counted(concurrent, 'acceptedSourceProofRetries'), 1);
  assert.equal(counted(concurrent, 'acceptedSourceConcurrentWriteRetries'), 1);

  // The same write made by the held proof itself explains nothing: the
  // refusal stands after one attempt.
  const own = createRecordVersionWorkCounters();
  attempts = 0;
  await withRecordVersionWork(own, async () => {
    await assert.rejects(
      f.read(
        () => {
          attempts++;
          transaction(f.db, () => {
            f.db
              .prepare('UPDATE people SET display_name=? WHERE id=?')
              .run(`Fictional Own ${attempts}`, 'fictional-concurrent-person');
          });
          throw Error('fictional own-write refusal');
        },
        undefined,
        { idempotent: true },
      ),
      (error: unknown) =>
        /fictional own-write refusal/.test(
          String(error instanceof AggregateError ? error.errors[0] : error),
        ),
    );
  });
  assert.equal(attempts, 1);
  assert.equal(counted(own, 'acceptedSourceProofRetries'), 0);
});
