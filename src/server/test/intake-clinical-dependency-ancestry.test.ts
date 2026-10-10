import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { StatementSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { registerIntakeFile } from '../intake-state-access.ts';
import { hasIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { prepareIntakeSourceDependencyHeaders } from '../intake-source-text-dependencies.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

const parentId = (n: number) => `fictional-parent-${String(n).padStart(3, '0')}`;
function fixture(t: test.TestContext, ancestors: number) {
  const profileId = 'fictional-clinical-ancestry',
    db = openDatabase(':memory:', profileId),
    authority = memoryRecordAuthority(db),
    id = 'fictional-selected';
  t.after(() => db.close());
  transaction(db, () => {
    for (let n = -1; n < ancestors; n++)
      registerIntakeFile(db, {
        id: n === -1 ? id : parentId(n),
        path: `fictional-${n + 1}.txt`,
        sha256: 'a'.repeat(64),
        size: 0,
        mimeType: 'text/plain',
        kind: 'intake_original',
        coverage: 'unknown',
        details: {
          intake: {
            originalName: 'Fictional original.txt',
            version: 1,
            proposals: [],
            ...(n + 1 < ancestors ? { parentSourceFileId: parentId(n + 1) } : {}),
          },
        },
      });
  });
  return { db, authority, id };
}

test('clinical dependency preparation checks every ancestor without building their workflows', async (t) => {
  const measurements: { operations: number; writes: number; bytes: number }[] = [];
  for (const ancestors of [3, 130]) {
    const f = fixture(t, ancestors),
      originalGet = StatementSync.prototype.get,
      originalWrite = f.authority.storage.writeImmutable,
      originalPublish = f.authority.storage.publishHead;
    let edges = 0,
      heads = 0,
      writes = 0,
      bytes = 0;
    const originalRead = f.authority.storage.read;
    t.mock.method(
      StatementSync.prototype,
      'get',
      function (this: StatementSync, ...args: unknown[]) {
        if (
          this.sourceSQL ===
            "SELECT id,kind,sha256 FROM main.source_files WHERE id=? AND kind='intake_original'" &&
          typeof args[0] === 'string' &&
          args[0].startsWith('fictional-parent-')
        )
          edges++;
        return Reflect.apply(originalGet, this, args);
      },
    );
    t.mock.method(f.authority.storage, 'read', function (name: string) {
      if (name === 'head') heads++;
      return Reflect.apply(originalRead, f.authority.storage, [name]);
    });
    t.mock.method(
      f.authority.storage,
      'writeImmutable',
      function (name: string, value: Uint8Array) {
        writes++;
        bytes += value.byteLength;
        return Reflect.apply(originalWrite, f.authority.storage, [name, value]);
      },
    );
    t.mock.method(f.authority.storage, 'publishHead', function (value: Uint8Array) {
      writes++;
      bytes += value.byteLength;
      return Reflect.apply(originalPublish, f.authority.storage, [value]);
    });
    const before = intakeWorkCounters(f.db).warm.schemaBuildOperations;
    await prepareIntakeSourceDependencyHeaders(f.db, f.id, { nativeSchema: 'selected' });
    assert.equal(edges, ancestors * 2, 'every ancestor edge is checked and rechecked');
    assert.ok(heads >= ancestors * 2, 'ancestor checks retain genuine accepted HEAD reads');
    measurements.push({
      operations: intakeWorkCounters(f.db).warm.schemaBuildOperations - before,
      writes,
      bytes,
    });
    assert.ok(hasIntakeCollectionEnvelope(f.db, { id: f.id }));
    for (let n = 0; n < ancestors; n++)
      assert.equal(hasIntakeCollectionEnvelope(f.db, { id: parentId(n) }), false);
    writes = 0;
    bytes = 0;
    await prepareIntakeSourceDependencyHeaders(f.db, f.id, { nativeSchema: 'selected' });
    assert.equal(writes, 0, 'warm checked ancestry publishes no durable writes');
    assert.equal(bytes, 0);
    t.mock.restoreAll();
  }
  const [small, large] = measurements;
  assert.ok(small!.operations > 0 && small!.writes > 0 && small!.bytes > 0);
  assert.equal(
    large!.operations,
    small!.operations,
    'native schema work covers only selected source',
  );
  assert.ok(large!.writes <= small!.writes * 2, 'durable writes do not grow with ancestors');
  assert.ok(large!.bytes <= small!.bytes * 2, 'durable bytes do not grow with ancestors');
  t.diagnostic(JSON.stringify({ small, large }));
});

test('clinical dependency preparation cancels across the complete legacy ancestry without writes', async (t) => {
  const f = fixture(t, 130);
  await prepareIntakeSourceDependencyHeaders(f.db, f.id, { nativeSchema: 'selected' });
  const before = f.authority.objects.size;
  let cancelled = false;
  setImmediate(() => {
    cancelled = true;
  });
  await assert.rejects(
    prepareIntakeSourceDependencyHeaders(f.db, f.id, {
      nativeSchema: 'selected',
      assertRunning() {
        if (cancelled) throw Error('fictional cancellation');
      },
    }),
    /fictional cancellation/,
  );
  assert.equal(f.authority.objects.size, before);
});

test('default dependency preparation still builds every retained ancestor schema', async (t) => {
  const f = fixture(t, 3);
  await prepareIntakeSourceDependencyHeaders(f.db, f.id);
  assert.ok(hasIntakeCollectionEnvelope(f.db, { id: f.id }));
  for (let n = 0; n < 3; n++) assert.ok(hasIntakeCollectionEnvelope(f.db, { id: parentId(n) }));
});

test('clinical dependency ancestry refuses a changed accepted HEAD after its checked prefix', async (t) => {
  const f = fixture(t, 130);
  await prepareIntakeSourceDependencyHeaders(f.db, f.id, { nativeSchema: 'selected' });
  const before = f.authority.objects.size;
  let changed = false;
  setImmediate(() => {
    changed = true;
    f.authority.objects.set('head', Buffer.from('Fictional invalid accepted HEAD'));
  });
  await assert.rejects(
    prepareIntakeSourceDependencyHeaders(f.db, f.id, { nativeSchema: 'selected' }),
  );
  assert.equal(changed, true, 'the complete checked prefix yielded before authority changed');
  assert.equal(f.authority.objects.size, before, 'refused ancestry publishes no immutable objects');
});
