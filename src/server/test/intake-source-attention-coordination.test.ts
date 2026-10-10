import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { uploadIntake } from '../intake.ts';
import { registerIntakeFile } from '../intake-state-access.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { hasIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { readPreparedSourceAttention } from '../intake-source-attention.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(t: test.TestContext, extra = 0) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-attention-coordination-')),
    profileId = 'fictional-attention-coordination',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-attention.txt',
    bytes: Buffer.from('Independently fictional original for attention coordination.'),
  });
  if (extra)
    transaction(db, () => {
      for (let n = 0; n < extra; n++)
        registerIntakeFile(db, {
          id: 'fictional-attention-' + String(n).padStart(3, '0'),
          path: 'fictional-' + n + '.txt',
          sha256: 'a'.repeat(64),
          size: 1,
          mimeType: 'text/plain',
          kind: 'intake_original',
          coverage: 'unknown',
          details: {
            intake: {
              createdAt: '2026-01-01T00:00:00Z',
              version: 1,
              proposals: [],
            },
          },
        });
    });
  return { db, root, profileId, source };
}
async function pausedBuilder(t: test.TestContext, f: ReturnType<typeof fixture>) {
  const reached = gate(),
    release = gate();
  let paused = false;
  const abort = () => release.resolve();
  t.signal.addEventListener('abort', abort, { once: true });
  const building = buildIntakeCollectionEnvelope(
    f.db,
    { id: f.source.id },
    {
      onCheckpoint: async () => {
        if (paused) return;
        paused = true;
        reached.resolve();
        await release.promise;
      },
    },
  );
  void building.catch(() => reached.resolve());
  await reached.promise;
  assert.equal(paused, true, 'real accepted builder checkpoint reached');
  return {
    building,
    release: () => {
      release.resolve();
      t.signal.removeEventListener('abort', abort);
    },
  };
}

test('actual builder excludes independent dirty attention maintenance until its original witness completes', async (t) => {
  const f = fixture(t);
  let callbacks = 0;
  const read = () =>
    readPreparedSourceAttention(f.db, f.profileId, 0, () => {
      callbacks++;
      return 1;
    });
  const expected = await read();
  f.db.prepare('INSERT INTO temp.source_attention_dirty_v1 VALUES(?)').run(f.source.id);
  const held = await pausedBuilder(t, f),
    before = reviewReadStamp(f.db),
    beforeCallbacks = callbacks;
  let completed = false;
  const attention = read().then((value) => {
    completed = true;
    return value;
  });
  const settled = Promise.allSettled([held.building, attention]);
  try {
    await setImmediate();
    assert.equal(completed, false);
    assert.equal(callbacks, beforeCallbacks);
    assert.equal(reviewReadStamp(f.db), before, 'waiting attention performs zero SQL maintenance');
    held.release();
    assert.ok(await held.building);
    assert.deepEqual(await attention, expected);
    assert.equal(callbacks, beforeCallbacks + 1);
    assert.ok(hasIntakeCollectionEnvelope(f.db, { id: f.source.id }));
  } finally {
    held.release();
    await settled;
  }
});

test('attention retains exact result when admitted as an awaited nested clinical owner', async (t) => {
  const f = fixture(t);
  let callbacks = 0;
  const read = () =>
    readPreparedSourceAttention(f.db, f.profileId, 0, () => {
      callbacks++;
      return 2;
    });
  const expected = await read();
  f.db.prepare('INSERT INTO temp.source_attention_dirty_v1 VALUES(?)').run(f.source.id);
  const result = await runExclusiveClinicalOperation(f.db, async () => read());
  assert.deepEqual(result, expected);
  assert.equal(callbacks, 2);
});

test('inherited cancellation at the existing attention yield stops later cache writes and permits fresh recovery', async (t) => {
  const f = fixture(t, 64),
    controller = new AbortController(),
    reason = Error('Fictional attention cancellation');
  let calls = 0;
  const work = runExclusiveClinicalOperation(
    f.db,
    async () =>
      readPreparedSourceAttention(f.db, f.profileId, 0, () => {
        if (++calls === 32) queueMicrotask(() => controller.abort(reason));
        return 1;
      }),
    { signal: controller.signal },
  );
  await assert.rejects(work, (e) => e === reason);
  assert.equal(calls, 32);
  const raw = reviewReadStamp(f.db);
  await setImmediate();
  assert.equal(calls, 32);
  assert.equal(reviewReadStamp(f.db), raw, 'no abandoned attention continuation writes');
  const recovered = await readPreparedSourceAttention(f.db, f.profileId, 0, () => {
    calls++;
    return 1;
  });
  assert.equal(recovered.total, 65);
  assert.equal(recovered.sections, 65);
  assert.equal(calls, 65);
});

test('database close refuses queued attention before any section callback or TEMP admission', async (t) => {
  const f = fixture(t),
    held = await pausedBuilder(t, f);
  let calls = 0;
  const attention = readPreparedSourceAttention(f.db, f.profileId, 0, () => {
    calls++;
    return 1;
  });
  const settled = Promise.allSettled([held.building, attention]);
  try {
    await setImmediate();
    assert.equal(calls, 0);
    f.db.close();
    held.release();
    const results = await settled;
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected')
        assert.match(String(result.reason), /no longer active|database|not open/i);
    }
    assert.equal(calls, 0);
  } finally {
    held.release();
    await settled;
  }
});

for (const rolledBack of [false, true])
  test(
    'attention admission does not credit genuine ' +
      (rolledBack ? 'rolled-back' : 'committed') +
      ' foreign SQL during conversion',
    async (t) => {
      const f = fixture(t),
        held = await pausedBuilder(t, f);
      const attention = readPreparedSourceAttention(f.db, f.profileId, 0, () => 1),
        settled = Promise.allSettled([held.building, attention]);
      try {
        if (rolledBack) f.db.exec('SAVEPOINT fictional_foreign');
        f.db
          .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
          .run('fictional_attention_foreign', 'changed');
        if (rolledBack) f.db.exec('ROLLBACK TO fictional_foreign; RELEASE fictional_foreign');
        held.release();
        await assert.rejects(
          held.building,
          /Intake envelope build resume: authority changed during preparation/,
        );
        assert.equal((await attention).total, 1);
        assert.equal(hasIntakeCollectionEnvelope(f.db, { id: f.source.id }), false);
        assert.equal(
          f.db.prepare('SELECT value FROM app_meta WHERE key=?').get('fictional_attention_foreign')
            ?.value,
          rolledBack ? undefined : 'changed',
        );
      } finally {
        held.release();
        await settled;
      }
    },
  );
