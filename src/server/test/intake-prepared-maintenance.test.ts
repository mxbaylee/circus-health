import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import {
  clinicalReviewRevision,
  currentTransactionToken,
  observeTransactionBeforePublication,
  observeTransactionOutcome,
  revision,
  transaction,
  type TransactionOutcome,
} from '../database.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import {
  assertIntakeMaintenancePreparation,
  captureIntakeMaintenancePreparation,
  clearIntakeMaintenancePublications,
  prepareIntakeMaintenancePublication,
  type IntakeMaintenancePreparation,
  type IntakeMaintenanceWrite,
} from '../intake-state-maintenance.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import {
  captureOwnershipReportOriginalProof,
  prepareOwnershipReportPlan,
} from '../ownership-report-plan.ts';
import { recordMutationStatement } from '../record-mutation-recipe.ts';
import {
  authenticateRecordTransactionPreparation,
  captureRecordPublicationOriginals,
  closeRecordPublicationOriginals,
  commitRecordTransactionPreparation,
  discardRecordTransactionPreparation,
  prepareRecordTransactionWithOriginals,
  recordDurabilityStatus,
  stageRecordTransactionPreparation,
} from '../record-versions.ts';
import { recordPreparedPublicationFixture } from './helpers/record-prepared-publication-fixture.ts';

type Fixture = Awaited<ReturnType<typeof recordPreparedPublicationFixture>>;

for (const invalidation of ['explicit', 'foreign-token'] as const)
  test(`prepared maintenance remains revoked after ${invalidation} invalidation`, async (t) => {
    const f = await recordPreparedPublicationFixture(t),
      c = candidate(f),
      plan = await freshPlan(f),
      beforeHead = Buffer.from(f.storage.read('head')!);
    t.after(() => plan.close());
    await runExclusiveClinicalOperation(f.db, async () => {
      const original = captureOwnershipReportOriginalProof(plan, f.db, f.profileId),
        originals = await captureRecordPublicationOriginals(f.db, f.profileId, original),
        maintenance = prepareIntakeMaintenancePublication(f.db, c);
      try {
        const preparation = await prepareRecordTransactionWithOriginals(
          f.db,
          () => stage(f, c),
          {
            operationId: c.operationId,
            fingerprint: c.fingerprint,
            actor: 'intake-state',
            intakeMaintenance: maintenance,
          },
          originals,
        );
        try {
          await authenticateRecordTransactionPreparation(f.db, preparation);
          await stageRecordTransactionPreparation(f.db, preparation);
          clearIntakeMaintenancePublications(
            f.db,
            invalidation === 'foreign-token' ? Object.freeze({}) : undefined,
          );
          await assert.rejects(commitRecordTransactionPreparation(f.db, preparation), {
            message:
              'Intake maintenance publication: foreign, expired or unreleased maintenance preparation',
          });
          assert.equal(f.db.isTransaction, false);
          assert.deepEqual(f.storage.read('head'), beforeHead);
          assert.equal(
            f.db
              .prepare('SELECT value FROM app_meta WHERE key=?')
              .get(`${intakeNamespace(c.identity)}head`)?.value,
            c.beforeHead,
          );
        } finally {
          discardRecordTransactionPreparation(f.db, preparation);
        }
      } finally {
        closeRecordPublicationOriginals(originals);
      }
    });
  });

function candidate(f: Fixture) {
  const identity = {
      profileId: f.profileId,
      intakeId: f.source.id,
      sourceHash: String(
        f.db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(f.source.id)!.sha256,
      ),
    },
    collections = createIntakeStateStorage(f.db, identity).collections,
    view = collections.openView(),
    operationId = randomUUID(),
    requestDigest = createHash('sha256').update(operationId).digest('hex'),
    prepared = collections.prepare(view, {
      operationId,
      requestDigest,
      domainVersion: collections.binding(view)!.logical.domainVersion,
      changes: [
        {
          area: 'builds',
          collection: 'fictional-checkpoint',
          op: 'append',
          value: 'Fictional checkpoint',
        },
      ],
    }),
    description = collections.inspectPrepared(prepared),
    writes: IntakeMaintenanceWrite[] = [],
    rollback = new Error('fictional maintenance staging probe');
  assert.throws(
    () =>
      transaction(f.db, () => {
        collections.stage(prepared);
        for (const row of f.db.prepare('SELECT entity,record_id FROM __record_changed').iterate()) {
          assert.equal(row.entity, 'app_meta');
          const [key] = JSON.parse(String(row.record_id)) as [string],
            value = f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)!.value;
          assert.equal(typeof value, 'string');
          writes.push({ key, value: value as string });
        }
        throw rollback;
      }),
    (error) => error === rollback,
  );
  assert.ok(description.beforeHead);
  return {
    identity,
    beforeHead: description.beforeHead,
    afterHead: description.afterHead,
    writes,
    result: description.result,
    operationId,
    fingerprint: intakeNamespace(identity) + requestDigest,
  };
}

function stage(f: Fixture, prepared: ReturnType<typeof candidate>) {
  for (const { key, value } of prepared.writes)
    recordMutationStatement(
      f.db,
      'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(key, value);
  return structuredClone(prepared.result);
}

async function freshPlan(f: Fixture) {
  const observation = f.db.prepare('SELECT id FROM observations').get()!,
    recipient = f.db.prepare('SELECT id,version FROM notes WHERE person_id=?').get(f.personId)!;
  return prepareOwnershipReportPlan(f.db, f.root, f.profileId, {
    selection: {
      type: 'records',
      records: [{ kind: 'observation', recordId: String(observation.id) }],
    },
    destination: { noteId: String(recipient.id), expectedVersion: Number(recipient.version) },
  });
}

for (const backend of ['vault', 'contributor'] as const) {
  test(`prepared ${backend} maintenance publishes once with unchanged clinical revision`, async (t) => {
    const f = await recordPreparedPublicationFixture(t, undefined, backend),
      c = candidate(f),
      plan = await freshPlan(f),
      beforeHead = Buffer.from(f.storage.read('head')!),
      outcomes: TransactionOutcome[] = [],
      stop = observeTransactionOutcome(f.db, (outcome) => outcomes.push(outcome));
    t.after(stop);
    t.after(() => plan.close());
    await runExclusiveClinicalOperation(f.db, async () => {
      const original = captureOwnershipReportOriginalProof(plan, f.db, f.profileId),
        originals = await captureRecordPublicationOriginals(f.db, f.profileId, original),
        maintenance = prepareIntakeMaintenancePublication(f.db, c),
        clinical = clinicalReviewRevision(f.db),
        general = revision(f.db),
        sequence = recordDurabilityStatus(f.db)!.sequence;
      let calls = 0;
      try {
        const preparation = await prepareRecordTransactionWithOriginals(
          f.db,
          () => {
            calls++;
            return stage(f, c);
          },
          {
            operationId: c.operationId,
            fingerprint: c.fingerprint,
            actor: 'intake-state',
            intakeMaintenance: maintenance,
          },
          originals,
        );
        try {
          const tentative = outcomes.at(-1)!;
          assert.equal(tentative.prepared, true);
          assert.equal(tentative.committed, false);
          assert.equal(tentative.intakeMaintenance, undefined);
          assert.equal(calls, 1);
          assert.deepEqual(f.storage.read('head'), beforeHead);
          assert.equal(revision(f.db), general);
          assert.equal(clinicalReviewRevision(f.db), clinical);
          await authenticateRecordTransactionPreparation(f.db, preparation);
          await stageRecordTransactionPreparation(f.db, preparation);
          assert.deepEqual(await commitRecordTransactionPreparation(f.db, preparation), c.result);
          assert.equal(calls, 1);
          assert.equal(revision(f.db), general + 1);
          assert.equal(clinicalReviewRevision(f.db), clinical);
          assert.equal(recordDurabilityStatus(f.db)!.sequence, sequence + 1);
          assert.notDeepEqual(f.storage.read('head'), beforeHead);
          for (const { key, value } of c.writes)
            assert.equal(
              f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)!.value,
              value,
            );
          const accepted = outcomes.at(-1)!;
          assert.equal(accepted.committed, true);
          assert.equal(accepted.succeeded, true);
          assert.equal(accepted.intakeMaintenance, true);
          assert.notEqual(accepted.token, tentative.token);
          await assert.rejects(
            prepareRecordTransactionWithOriginals(
              f.db,
              () => stage(f, c),
              {
                operationId: c.operationId,
                fingerprint: c.fingerprint,
                intakeMaintenance: maintenance,
              },
              originals,
            ),
          );
        } finally {
          discardRecordTransactionPreparation(f.db, preparation);
        }
      } finally {
        closeRecordPublicationOriginals(originals);
      }
    });
  });
}

test('ordinary verified maintenance cannot mint a prepared publication proof', async (t) => {
  const f = await recordPreparedPublicationFixture(t),
    c = candidate(f),
    maintenance = prepareIntakeMaintenancePublication(f.db, c),
    operation = {
      operationId: c.operationId,
      fingerprint: c.fingerprint,
      intakeMaintenance: maintenance,
    };
  let observed = false;
  let refusal: unknown;
  const stop = observeTransactionBeforePublication(f.db, (token) => {
    observed = true;
    if (currentTransactionToken(f.db) !== token) return;
    try {
      captureIntakeMaintenancePreparation(f.db, maintenance, token, operation);
    } catch (error) {
      refusal = error;
    }
  });
  t.after(stop);
  transaction(f.db, () => stage(f, c), operation);
  assert.equal(observed, true);
  assert.ok(refusal instanceof Error);
  assert.match(refusal.message, /genuine verified record token/);
  assert.throws(
    () =>
      assertIntakeMaintenancePreparation(f.db, Object.freeze({}) as IntakeMaintenancePreparation),
    /foreign, expired or unreleased/,
  );
});

test('prepared maintenance refuses an unowned publication callback SQL write before bookkeeping', async (t) => {
  const f = await recordPreparedPublicationFixture(t),
    c = candidate(f);
  f.db.exec('CREATE TEMP TABLE fictional_maintenance_callback(value TEXT)');
  const plan = await freshPlan(f);
  const beforeHead = Buffer.from(f.storage.read('head')!);
  let callbackCalls = 0;
  t.after(() => plan.close());
  await runExclusiveClinicalOperation(f.db, async () => {
    const original = captureOwnershipReportOriginalProof(plan, f.db, f.profileId),
      originals = await captureRecordPublicationOriginals(f.db, f.profileId, original),
      maintenance = prepareIntakeMaintenancePublication(f.db, c),
      general = revision(f.db),
      clinical = clinicalReviewRevision(f.db),
      stop = observeTransactionBeforePublication(f.db, () => {
        callbackCalls++;
        f.db
          .prepare('INSERT INTO fictional_maintenance_callback VALUES(?)')
          .run('Fictional extra write');
      });
    try {
      await assert.rejects(
        prepareRecordTransactionWithOriginals(
          f.db,
          () => stage(f, c),
          {
            operationId: c.operationId,
            fingerprint: c.fingerprint,
            intakeMaintenance: maintenance,
          },
          originals,
        ),
        /unowned prepublication write/,
      );
      assert.equal(callbackCalls, 1);
      assert.equal(revision(f.db), general);
      assert.equal(clinicalReviewRevision(f.db), clinical);
      assert.deepEqual(f.storage.read('head'), beforeHead);
      assert.equal(
        f.db.prepare('SELECT count(*) AS n FROM fictional_maintenance_callback').get()!.n,
        0,
      );
    } finally {
      stop();
      closeRecordPublicationOriginals(originals);
    }
  });
});
