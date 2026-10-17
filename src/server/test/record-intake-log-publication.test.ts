import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  registerRecordIntakeLogPublication,
  consumeAcceptedRecordIntakeLogPublication,
  authenticateRecordTransactionPreparation,
  captureRecordPublicationOriginals,
  closeRecordPublicationOriginals,
  commitRecordTransactionPreparation,
  discardRecordTransactionPreparation,
  prepareRecordTransactionWithOriginals,
  stageRecordTransactionPreparation,
  type RecordIntakeLogPublication,
  type RecordIntakeLogPublicationBinding,
} from '../record-versions.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { captureOwnershipReportOriginalProof } from '../ownership-report-plan.ts';
import { recordMutationStatement } from '../record-mutation-recipe.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';

function publicationBinding(profileId: string) {
  const identity = { profileId, intakeId: 'fictional-source', sourceHash: 'a'.repeat(64) };
  const namespace = intakeNamespace(identity);
  const empty = {
    format: 'health-intake-state-v5',
    identity,
    base: null,
    baseSequence: 0,
    storageSequence: 0,
    count: 0,
    logical: { root: null, domainVersion: 0 },
    builds: null,
    peaks: null,
  };
  const operationId = randomUUID();
  const receipt = {
    format: 'health-intake-state-receipt-v4',
    requestDigest: 'b'.repeat(64),
    result: {
      format: 'health-intake-state-result-v4',
      intakeId: identity.intakeId,
      operationId,
      storageSequence: 1,
      logical: empty.logical,
      changed: false,
    },
  };
  const leaf = JSON.stringify({
    format: 'health-intake-state-log-node-v1',
    identity,
    kind: 'leaf',
    event: {
      receipt,
      transition: {
        format: 'health-intake-state-log-transition-v1',
        operationId,
        previous: empty,
        logical: empty.logical,
        builds: null,
      },
    },
  });
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const peak = JSON.stringify({
    format: 'health-intake-state-log-node-v1',
    identity,
    kind: 'peak',
    tree: { hash: hash(leaf), first: 1, count: 1 },
    older: null,
  });
  const afterHead = JSON.stringify({ ...empty, storageSequence: 1, count: 1, peaks: hash(peak) });
  const binding: RecordIntakeLogPublicationBinding = {
    identity,
    beforeHead: undefined,
    afterHead,
    receipt,
    writes: [
      { key: namespace + 'node:' + hash(leaf), value: leaf },
      { key: namespace + 'node:' + hash(peak), value: peak },
      { key: namespace + 'head', value: afterHead },
    ],
  };
  return { binding, empty, namespace };
}

function fixture(t: test.TestContext, profileId = 'fictional-owned-log') {
  const root = mkdtempSync(join(tmpdir(), 'fictional-owned-log-'));
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const authority = memoryRecordAuthority(db);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { binding, empty, namespace } = publicationBinding(profileId);
  function write(rows = binding.writes) {
    for (const row of rows)
      db.prepare(
        'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(row.key, row.value);
  }
  function publish(edit?: () => void) {
    let candidate: RecordIntakeLogPublication | undefined;
    transaction(
      db,
      () => {
        write();
        candidate = registerRecordIntakeLogPublication(db, binding);
        edit?.();
      },
      { operationId: randomUUID(), fingerprint: 'fictional-log-publication' },
    );
    assert.ok(candidate);
    return candidate;
  }
  return { db, authority, binding, empty, namespace, write, publish };
}

test('only the actual accepted row roster creates a one-use log publication closure', (t) => {
  const f = fixture(t),
    candidate = f.publish();
  assert.equal(
    consumeAcceptedRecordIntakeLogPublication(f.db, {} as RecordIntakeLogPublication, f.binding),
    false,
  );
  assert.equal(consumeAcceptedRecordIntakeLogPublication(f.db, candidate, f.binding), true);
  assert.equal(consumeAcceptedRecordIntakeLogPublication(f.db, candidate, f.binding), false);
});

for (const fault of ['missing', 'substituted', 'unexpected', 'rollback'] as const)
  test(`log closure refuses ${fault} publication without inventing an accepted outcome`, (t) => {
    const f = fixture(t);
    let candidate: RecordIntakeLogPublication | undefined;
    const run = () =>
      transaction(
        f.db,
        () => {
          f.write();
          candidate = registerRecordIntakeLogPublication(f.db, f.binding);
          const key = f.binding.writes[0]!.key;
          if (fault === 'missing') f.db.prepare('DELETE FROM app_meta WHERE key=?').run(key);
          if (fault === 'substituted')
            f.db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', key);
          if (fault === 'unexpected')
            f.db
              .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
              .run(f.namespace + 'node:' + 'c'.repeat(64), '{}');
          if (fault === 'rollback') throw Error('fictional rollback');
        },
        { operationId: randomUUID(), fingerprint: 'fictional-log-fault' },
      );
    if (fault === 'rollback') assert.throws(run, /fictional rollback/);
    else run();
    assert.ok(candidate);
    assert.equal(consumeAcceptedRecordIntakeLogPublication(f.db, candidate, f.binding), false);
  });

test('log closure binds prior accepted HEAD, not only the proposed new HEAD', (t) => {
  const f = fixture(t);
  transaction(f.db, () =>
    f.db
      .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
      .run(f.namespace + 'head', JSON.stringify(f.empty)),
  );
  const candidate = f.publish();
  assert.equal(consumeAcceptedRecordIntakeLogPublication(f.db, candidate, f.binding), false);
});

for (const fault of ['database', 'receipt', 'head', 'subset'] as const)
  test(`log closure terminally refuses a mismatched ${fault} consumer`, (t) => {
    const f = fixture(t),
      other = fixture(t),
      candidate = f.publish();
    const input = structuredClone(f.binding);
    if (fault === 'receipt') input.receipt = { fictional: 'different' };
    if (fault === 'head') input.afterHead = JSON.stringify(f.empty);
    if (fault === 'subset') input.writes[0]!.value = '{}';
    assert.equal(
      consumeAcceptedRecordIntakeLogPublication(
        fault === 'database' ? other.db : f.db,
        candidate,
        input,
      ),
      false,
    );
    assert.equal(consumeAcceptedRecordIntakeLogPublication(f.db, candidate, f.binding), false);
  });

test('an unrelated later accepted transaction cannot certify a rolled back log intent', (t) => {
  const f = fixture(t);
  let candidate: RecordIntakeLogPublication | undefined;
  assert.throws(
    () =>
      transaction(f.db, () => {
        f.write();
        candidate = registerRecordIntakeLogPublication(f.db, f.binding);
        throw Error('fictional rollback');
      }),
    /fictional rollback/,
  );
  transaction(f.db, () => f.write());
  assert.ok(candidate);
  assert.equal(consumeAcceptedRecordIntakeLogPublication(f.db, candidate, f.binding), false);
});

for (const omitted of ['leaf', 'peak', 'all'] as const)
  test(`log closure refuses omitted ${omitted} pending evidence`, (t) => {
    const f = fixture(t),
      candidate = f.publish();
    const input = {
      ...f.binding,
      writes: f.binding.writes.filter((_, index) =>
        omitted === 'all' ? false : index !== (omitted === 'leaf' ? 0 : 1),
      ),
    };
    assert.equal(consumeAcceptedRecordIntakeLogPublication(f.db, candidate, input), false);
    assert.equal(consumeAcceptedRecordIntakeLogPublication(f.db, candidate, f.binding), false);
  });

test('log-only consumption omits independently bound HEAD and unrelated tree rows', (t) => {
  const f = fixture(t);
  const raw = JSON.stringify({ format: 'fictional-external-tree', value: 'fictional' });
  const key = f.namespace + 'node:' + createHash('sha256').update(raw).digest('hex');
  f.binding.writes = [...f.binding.writes, { key, value: raw }];
  const candidate = f.publish();
  assert.equal(
    consumeAcceptedRecordIntakeLogPublication(f.db, candidate, {
      ...f.binding,
      writes: f.binding.writes.slice(0, 2),
    }),
    true,
  );
});

test('extra registered carry evidence must also be supplied by the pending codec', (t) => {
  const f = fixture(t);
  const raw = JSON.stringify({
    format: 'health-intake-state-log-node-v1',
    kind: 'merge',
    identity: f.binding.identity,
    left: { hash: 'a'.repeat(64), first: 1, count: 1 },
    right: { hash: 'b'.repeat(64), first: 2, count: 1 },
  });
  const key = f.namespace + 'node:' + createHash('sha256').update(raw).digest('hex');
  const original = [...f.binding.writes];
  f.binding.writes = [...original, { key, value: raw }];
  const candidate = f.publish();
  assert.equal(
    consumeAcceptedRecordIntakeLogPublication(f.db, candidate, { ...f.binding, writes: original }),
    false,
  );
});

test('consumer accessors cannot execute after the initial live-owner check', (t) => {
  const f = fixture(t),
    candidate = f.publish();
  let calls = 0;
  const input = {
    ...f.binding,
    get writes() {
      calls++;
      f.db.close();
      return f.binding.writes;
    },
  };
  assert.equal(consumeAcceptedRecordIntakeLogPublication(f.db, candidate, input), false);
  assert.equal(calls, 0);
  assert.equal(f.db.isOpen, true);
  assert.equal(consumeAcceptedRecordIntakeLogPublication(f.db, candidate, f.binding), false);
});

test('registration bounds the roster before inspecting payload rows or ignored fields', (t) => {
  const f = fixture(t);
  let calls = 0;
  const rows = Array.from({ length: 100001 }, () => ({
    get key(): string {
      calls++;
      throw Error('must not inspect');
    },
    value: '',
  }));
  transaction(f.db, () => {
    const input = {
      ...f.binding,
      writes: rows,
      get ignored() {
        calls++;
        throw Error('must not clone');
      },
    };
    assert.equal(registerRecordIntakeLogPublication(f.db, input), undefined);
  });
  assert.equal(calls, 0);
});

for (const index of [2, 65])
  test(`receipt sparse arrays are refused before reading index ${index}`, (t) => {
    const f = fixture(t);
    let calls = 0;
    const sparse: unknown[] = [];
    Object.defineProperty(sparse, String(index), {
      enumerable: true,
      get() {
        calls++;
        throw Error('must not traverse sparse receipt');
      },
    });
    const input = { ...f.binding, receipt: { sparse } };
    transaction(f.db, () => {
      assert.throws(
        () => registerRecordIntakeLogPublication(f.db, input),
        /log publication receipt array/,
      );
    });
    const candidate = f.publish();
    assert.equal(consumeAcceptedRecordIntakeLogPublication(f.db, candidate, input), false);
    assert.equal(calls, 0);
    assert.equal(consumeAcceptedRecordIntakeLogPublication(f.db, candidate, f.binding), false);
  });

for (const outcome of ['accepted', 'missing-row', 'discarded'] as const)
  test(`actual vault prepared log row closure: ${outcome}`, async (t) => {
    const { recordPreparedPublicationFixture } =
      await import('./helpers/record-prepared-publication-fixture.ts');
    const f = await recordPreparedPublicationFixture(t);
    // This independently fictional metadata graph tests the record owner's row
    // closure only. It grants no selected-source or complete-graph admission.
    const { binding } = publicationBinding(f.profileId);
    let candidate: RecordIntakeLogPublication | undefined;
    const work = createRecordVersionWorkCounters();
    t.after(() => {
      const refused = Object.fromEntries(
        Object.entries(work.operation).filter(
          ([name, count]) => name.startsWith('vaultBackingRejected') && count > 0,
        ),
      );
      if (Object.keys(refused).length) t.diagnostic(JSON.stringify(refused));
    });
    await withRecordVersionWork(work, () =>
      runExclusiveClinicalOperation(f.db, async () => {
        const original = captureOwnershipReportOriginalProof(f.plan, f.db, f.profileId);
        const originals = await captureRecordPublicationOriginals(f.db, f.profileId, original);
        try {
          const preparation = await prepareRecordTransactionWithOriginals(
            f.db,
            () => {
              for (const [index, row] of binding.writes.entries()) {
                if (outcome === 'missing-row' && index === 0) continue;
                recordMutationStatement(f.db, 'INSERT INTO app_meta(key,value) VALUES(?,?)').run(
                  row.key,
                  row.value,
                );
              }
              candidate = registerRecordIntakeLogPublication(f.db, binding);
              return { fictionalLog: true };
            },
            { operationId: randomUUID(), fingerprint: 'fictional-owned-log-preparation' },
            originals,
          );
          try {
            assert.ok(candidate);
            assert.equal(
              f.db
                .prepare('SELECT value FROM app_meta WHERE key=?')
                .get(binding.writes.at(-1)!.key),
              undefined,
              'T1 rollback retains no selected new HEAD',
            );
            await authenticateRecordTransactionPreparation(f.db, preparation);
            await stageRecordTransactionPreparation(f.db, preparation);
            if (outcome !== 'discarded')
              assert.deepEqual(await commitRecordTransactionPreparation(f.db, preparation), {
                fictionalLog: true,
              });
          } finally {
            discardRecordTransactionPreparation(f.db, preparation);
          }
        } finally {
          closeRecordPublicationOriginals(originals);
        }
      }),
    );
    assert.ok(candidate);
    assert.equal(
      consumeAcceptedRecordIntakeLogPublication(f.db, candidate, binding),
      outcome === 'accepted',
    );
    assert.equal(consumeAcceptedRecordIntakeLogPublication(f.db, candidate, binding), false);
  });
