import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase } from '../database.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareRetainedPlanAccess, readRetainedPlanScope } from '../intake-retained-plan.ts';
import { prepareLegacyCheckpointTargets } from '../intake-legacy-checkpoint-targets.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import {
  legacyReadingSessionName,
  legacyReadingUnitKey,
  LEGACY_READING_POLICY,
  openLegacyReadingSession,
  prepareLegacyReadingTargets,
} from '../intake-reading-legacy.ts';
import type { IntakeCollectionChange } from '../intake-state-storage.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';

async function fixture(t: test.TestContext, plans: unknown[]) {
  const db = openDatabase(':memory:', 'fictional-skipped-work');
  memoryRecordAuthority(db);
  t.after(() => db.close());
  const id = 'fictional-skipped-original';
  registerRawIntakeFixture(db, id, JSON.stringify({ intake: { version: 0, workflow: { plans } } }));
  await buildIntakeCollectionEnvelope(db, { id });
  return { db, id };
}

const coveragePlan = () => ({
  id: 'fictional-plan',
  status: 'active',
  units: [{ id: 'fictional-unit', kind: 'text', status: 'pending', attempts: [] }],
  batches: [
    {
      id: 'fictional-batch',
      coverage: Array.from({ length: 65 }, (_, n) => ({
        unitId: 'fictional-unselected-' + n,
        kind: 'inspected',
        notes: 'Independently fictional retained receipt.',
      })),
    },
  ],
});

test(
  'retained skipped coverage admits a host turn before examining every receipt',
  { timeout: 30000 },
  async (t) => {
    const { db, id } = await fixture(t, [coveragePlan()]);
    const initial = intakeWorkCounters(db).reconstruction.retainedPlanCoverageReceipts;
    let beforeHostTurn = -1;
    const host = setImmediate().then(() => {
      beforeHostTurn = intakeWorkCounters(db).reconstruction.retainedPlanCoverageReceipts - initial;
    });
    await prepareRetainedPlanAccess(db, 'fictional-skipped-work', id);
    await host;
    const visited = intakeWorkCounters(db).reconstruction.retainedPlanCoverageReceipts - initial;
    t.diagnostic(JSON.stringify({ beforeHostTurn, visited }));
    assert.ok(beforeHostTurn >= 0 && beforeHostTurn < 65);
    assert.equal(visited, 65);
    assert.equal(
      readRetainedPlanScope(db, 'fictional-skipped-work', id)?.unitById('fictional-unit')?.id,
      'fictional-unit',
    );
  },
);

test(
  'legacy reading extension yields and cancels while skipping already indexed targets',
  { timeout: 30000 },
  async (t) => {
    const { db, id } = await fixture(t, [
      {
        id: 'fictional-active-plan',
        status: 'active',
        units: Array.from({ length: 66 }, (_, n) => ({
          id: 'fictional-unit-' + n,
          kind: 'text',
          status: 'pending',
        })),
      },
    ]);
    await prepareRetainedPlanAccess(db, 'fictional-skipped-work', id);
    const view = openIntakeCollectionEnvelope(db, { id });
    const intake = view.child(view.root(), 'intake')!;
    const flow = view.child(intake, 'workflow')!;
    const plan = view.children(flow, 'plans', { items: 1, bytes: 8192 }).records[0]!;
    const planAddress = view.address(plan);
    const sourceHash = 'a'.repeat(64);
    const name = legacyReadingSessionName('fictional-session', id, sourceHash);
    const { collections } = selectedEnvelopeStore(db, { id });
    const commit = (changes: IntakeCollectionChange[]) => {
      const operationId = randomUUID();
      collections.commitMaintenance(
        collections.prepare(collections.openView(), {
          operationId,
          requestDigest: createHash('sha256').update(operationId).digest('hex'),
          domainVersion: intakeSourceVersion(db, id).rawVersion,
          changes,
        }),
      );
    };
    const known: IntakeCollectionChange[] = Array.from({ length: 65 }, (_, n) => ({
      area: 'builds',
      collection: name,
      op: 'put',
      key: 'legacy.unit:' + legacyReadingUnitKey(planAddress, 'fictional-unit-' + n),
      value: '1',
    }));
    for (let offset = 0; offset < known.length; offset += 64)
      commit(known.slice(offset, offset + 64));
    commit([
      {
        area: 'builds',
        collection: name,
        op: 'put',
        key: 'legacy.complete',
        value: JSON.stringify({ format: LEGACY_READING_POLICY, sourceHash }),
      },
    ]);
    const context = {
      db,
      root: '/private/tmp',
      profileId: 'fictional-skipped-work',
      intakeId: id,
      sourceHash,
      sessionId: 'fictional-session',
      unitKey: legacyReadingUnitKey(planAddress, 'fictional-unit-65'),
      assertCurrent() {
        view.field(intake, 'version', { bytes: 8192 });
      },
    };
    const original = collections.get;
    let reads = 0;
    let atTurn = -1;
    let cancelled = false;
    let host: Promise<void> | undefined;
    collections.get = function (...args: Parameters<typeof original>) {
      if (
        args[1] === 'builds' &&
        args[2].startsWith('reading.reindex.') &&
        args[3].startsWith('legacy.unit:')
      ) {
        reads++;
        host ??= setImmediate().then(() => {
          atTurn = reads;
          cancelled = true;
        });
      }
      return original.apply(this, args);
    };
    try {
      await assert.rejects(
        prepareLegacyReadingTargets(context, {
          assertRunning() {
            if (cancelled) throw Error('Fictional cancelled reading extension');
          },
        }),
        /Fictional cancelled reading extension/,
      );
      assert.ok(host);
      await host;
      t.diagnostic(JSON.stringify({ atTurn, reads }));
      assert.ok(atTurn > 0 && atTurn < 65);
      assert.equal(reads, atTurn);
      assert.equal(
        openLegacyReadingSession(context, undefined, { allowUnindexedUnit: true })?.text(
          'legacy.unit:' + context.unitKey,
        ),
        undefined,
      );
    } finally {
      collections.get = original;
    }
    assert.deepEqual(await prepareLegacyReadingTargets(context), { changed: true });
    assert.equal(openLegacyReadingSession(context)?.text('legacy.unit:' + context.unitKey), '1');
  },
);

test(
  'retained skipped coverage cancellation refuses a complete marker and can retry',
  { timeout: 30000 },
  async (t) => {
    const { db, id } = await fixture(t, [coveragePlan()]);
    const initial = intakeWorkCounters(db).reconstruction.retainedPlanCoverageReceipts;
    let cancelled = false;
    const host = setImmediate().then(() => {
      cancelled = true;
    });
    await assert.rejects(
      prepareRetainedPlanAccess(db, 'fictional-skipped-work', id, {
        assertRunning() {
          if (cancelled) throw Error('Fictional cancelled retained scan');
        },
      }),
      /Fictional cancelled retained scan/,
    );
    await host;
    assert.ok(intakeWorkCounters(db).reconstruction.retainedPlanCoverageReceipts - initial < 65);
    assert.throws(() => readRetainedPlanScope(db, 'fictional-skipped-work', id), {
      code: 'PLAN_PREPARATION_REQUIRED',
    });
    await prepareRetainedPlanAccess(db, 'fictional-skipped-work', id);
    assert.equal(
      readRetainedPlanScope(db, 'fictional-skipped-work', id)?.unitById('fictional-unit')?.id,
      'fictional-unit',
    );
  },
);

test(
  'legacy target preparation cooperates while skipping inactive plan history',
  { timeout: 30000 },
  async (t) => {
    const { db, id } = await fixture(
      t,
      Array.from({ length: 129 }, () => ({
        id: 'fictional-inactive',
        status: 'superseded',
      })),
    );
    await prepareRetainedPlanAccess(db, 'fictional-skipped-work', id);
    let checks = 0;
    let beforeHostTurn = -1;
    const host = setImmediate().then(() => {
      beforeHostTurn = checks;
    });
    const targets = await prepareLegacyCheckpointTargets(
      db,
      '/private/tmp',
      'fictional-skipped-work',
      id,
      {
        profileId: 'fictional-skipped-work',
        intakeId: id,
        sourceHash: 'a'.repeat(64),
        seen: [],
      },
      {
        assertRunning() {
          checks++;
        },
      },
    );
    try {
      await host;
      t.diagnostic(JSON.stringify({ beforeHostTurn, checks }));
      assert.ok(beforeHostTurn >= 0 && beforeHostTurn < checks);
      assert.deepEqual([...targets.units()], []);
      assert.deepEqual([...targets.pages()], []);
    } finally {
      targets.dispose();
    }
    assert.throws(() => [...targets.units()], /closed/);
  },
);
