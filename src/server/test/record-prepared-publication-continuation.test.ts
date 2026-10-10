import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  currentClinicalOperationReadonly,
  runExclusiveClinicalOperation,
} from '../clinical-operation.ts';
import {
  captureOwnershipReportOriginalProof,
  prepareOwnershipReportPlan,
} from '../ownership-report-plan.ts';
import { recordMutationStatement } from '../record-mutation-recipe.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import {
  authenticateRecordTransactionPreparation,
  captureRecordPublicationOriginals,
  closeRecordPublicationOriginals,
  commitRecordTransactionPreparation,
  discardRecordTransactionOriginalBacking,
  discardRecordTransactionPreparation,
  prepareRecordTransactionFromOriginalBacking,
  prepareRecordTransactionOriginalBacking,
  prepareRecordTransactionWithOriginals,
  stageRecordTransactionPreparation,
  type RecordTransactionOriginalBacking,
} from '../record-versions.ts';
import { recordPreparedPublicationFixture } from './helpers/record-prepared-publication-fixture.ts';

function changeRecipient(
  f: Awaited<ReturnType<typeof recordPreparedPublicationFixture>>,
  name: string,
) {
  recordMutationStatement(f.db, 'UPDATE people SET display_name=? WHERE id=?').run(
    name,
    f.personId,
  );
  return { displayName: name };
}
function assertIndexedRecipient(
  f: Awaited<ReturnType<typeof recordPreparedPublicationFixture>>,
  name: string,
) {
  assert.equal(
    f.db.prepare('SELECT display_name FROM main.people WHERE id=?').get(f.personId)!.display_name,
    name,
  );
  const indexed = f.db
    .prepare(
      'SELECT v.contents_json FROM main.__record_current c JOIN main.__record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
    )
    .get('people', JSON.stringify([f.personId]));
  assert.equal(JSON.parse(String(indexed!.contents_json)).display_name, name);
}

test('genuine contributor two prepared writes retain the accepted backing without replaying history', async (t) => {
  const f = await recordPreparedPublicationFixture(t, undefined, 'contributor');
  await runExclusiveClinicalOperation(f.db, async () => {
    const original = captureOwnershipReportOriginalProof(f.plan, f.db, f.profileId),
      originals = await captureRecordPublicationOriginals(f.db, f.profileId, original);
    try {
      let previousHead = f.beforeHead;
      for (let index = 0; index < 2; index++) {
        const name = `Fictional warm recipient ${index + 1}`,
          counters = createRecordVersionWorkCounters();
        await withRecordVersionWork(counters, async () => {
          const preparation = await prepareRecordTransactionWithOriginals(
            f.db,
            () => changeRecipient(f, name),
            { operationId: randomUUID(), fingerprint: `fictional-contributor-warm-${index}` },
            originals,
          );
          try {
            await authenticateRecordTransactionPreparation(f.db, preparation);
            await stageRecordTransactionPreparation(f.db, preparation);
            assert.deepEqual(await commitRecordTransactionPreparation(f.db, preparation), {
              displayName: name,
            });
          } finally {
            discardRecordTransactionPreparation(f.db, preparation);
          }
        });
        assert.equal(f.db.isTransaction, false);
        assertIndexedRecipient(f, name);
        const head = Buffer.from(f.storage.read('head')!);
        assert.notDeepEqual(head, previousHead);
        previousHead = head;
        assert.ok(counters.operation.contributorBackingPhysicalMemberVisits > 0);
        if (index === 0) assert.ok(counters.operation.contributorBackingColdDecodedVersions > 0);
        else assert.equal(counters.operation.contributorBackingColdDecodedVersions, 0);
        t.diagnostic(JSON.stringify({ write: index + 1, contributorBacking: counters.operation }));
      }
    } finally {
      closeRecordPublicationOriginals(originals);
    }
  });
});

test('same genuine report plan admits synchronous child T1 and final publication under original parent', async (t) => {
  const f = await recordPreparedPublicationFixture(t);
  await runExclusiveClinicalOperation(f.db, async () => {
    const parent = currentClinicalOperationReadonly(f.db),
      original = captureOwnershipReportOriginalProof(f.plan, f.db, f.profileId),
      originals = await captureRecordPublicationOriginals(f.db, f.profileId, original);
    try {
      const backing = await prepareRecordTransactionOriginalBacking(f.db, originals);
      let calls = 0;
      try {
        const preparation = await f.plan.withVerifiedPublication(() => {
          assert.notEqual(currentClinicalOperationReadonly(f.db), parent);
          return prepareRecordTransactionFromOriginalBacking(
            f.db,
            backing,
            () => {
              calls++;
              return changeRecipient(f, 'Fictional same-plan recipient');
            },
            { operationId: randomUUID(), fingerprint: 'fictional-same-plan-split' },
          );
        });
        try {
          assert.equal(calls, 1);
          assert.equal(currentClinicalOperationReadonly(f.db), parent);
          assert.deepEqual(f.storage.read('head'), f.beforeHead);
          await authenticateRecordTransactionPreparation(f.db, preparation);
          await stageRecordTransactionPreparation(f.db, preparation);
          assert.deepEqual(await commitRecordTransactionPreparation(f.db, preparation), {
            displayName: 'Fictional same-plan recipient',
          });
          assert.equal(calls, 1, 'final publication must not rerun business decisions');
          assertIndexedRecipient(f, 'Fictional same-plan recipient');
          const accepted = Buffer.from(f.storage.read('head')!);
          assert.notDeepEqual(accepted, f.beforeHead);
          let repeated = false;
          assert.throws(
            () =>
              prepareRecordTransactionFromOriginalBacking(
                f.db,
                backing,
                () => {
                  repeated = true;
                },
                { operationId: randomUUID() },
              ),
            /record original backing expired/,
          );
          assert.equal(repeated, false);
          assert.deepEqual(f.storage.read('head'), accepted);
        } finally {
          discardRecordTransactionPreparation(f.db, preparation);
        }
      } finally {
        discardRecordTransactionOriginalBacking(backing);
      }
    } finally {
      closeRecordPublicationOriginals(originals);
    }
  });
});

test('original backing refuses unissued discarded wrong-plan and expired-owner tokens before business', async (t) => {
  const f = await recordPreparedPublicationFixture(t),
    selected = f.db.prepare('SELECT id FROM main.observations').get()!,
    recipient = f.db
      .prepare('SELECT id,version FROM main.notes WHERE person_id=?')
      .get(f.personId)!,
    other = await prepareOwnershipReportPlan(f.db, f.root, f.profileId, {
      selection: {
        type: 'records',
        records: [{ kind: 'observation', recordId: String(selected.id) }],
      },
      destination: { noteId: String(recipient.id), expectedVersion: Number(recipient.version) },
    });
  t.after(() => other.close());
  assert.notEqual(other, f.plan);
  let calls = 0;
  const business = () => {
      calls++;
      return { changed: false };
    },
    operation = () => ({ operationId: randomUUID(), fingerprint: 'fictional-token-refusal' }),
    expired = await runExclusiveClinicalOperation(f.db, async () => {
      const original = captureOwnershipReportOriginalProof(f.plan, f.db, f.profileId),
        originals = await captureRecordPublicationOriginals(f.db, f.profileId, original);
      try {
        assert.throws(
          () =>
            prepareRecordTransactionFromOriginalBacking(
              f.db,
              Object.freeze({}) as RecordTransactionOriginalBacking,
              business,
              operation(),
            ),
          /record original backing expired/,
        );
        const discarded = await prepareRecordTransactionOriginalBacking(f.db, originals);
        discardRecordTransactionOriginalBacking(discarded);
        assert.throws(
          () => prepareRecordTransactionFromOriginalBacking(f.db, discarded, business, operation()),
          /record original backing expired/,
        );
        const wrongPlan = await prepareRecordTransactionOriginalBacking(f.db, originals);
        try {
          await assert.rejects(
            other.withVerifiedPublication(() =>
              prepareRecordTransactionFromOriginalBacking(f.db, wrongPlan, business, operation()),
            ),
            /record original backing admission owner differs/,
          );
        } finally {
          discardRecordTransactionOriginalBacking(wrongPlan);
        }
        const backing = await prepareRecordTransactionOriginalBacking(f.db, originals);
        return { backing, originals };
      } catch (error) {
        closeRecordPublicationOriginals(originals);
        throw error;
      }
    });
  try {
    await runExclusiveClinicalOperation(f.db, async () => {
      assert.throws(
        () =>
          prepareRecordTransactionFromOriginalBacking(f.db, expired.backing, business, operation()),
        /Clinical operation is no longer active/,
      );
    });
    assert.equal(calls, 0);
    assert.equal(f.db.isTransaction, false);
    assert.deepEqual(f.storage.read('head'), f.beforeHead);
    assert.deepEqual(
      { ...f.db.prepare('SELECT * FROM main.people WHERE id=?').get(f.personId)! },
      f.beforePerson,
    );
  } finally {
    discardRecordTransactionOriginalBacking(expired.backing);
    closeRecordPublicationOriginals(expired.originals);
  }
});
