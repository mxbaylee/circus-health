import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { captureOwnershipReportOriginalProof } from '../ownership-report-plan.ts';
import { recordMutationStatement } from '../record-mutation-recipe.ts';
import {
  authenticateRecordTransactionPreparation,
  captureRecordPublicationOriginals,
  closeRecordPublicationOriginals,
  commitRecordTransactionPreparation,
  discardRecordTransactionPreparation,
  prepareRecordTransactionWithOriginals,
  stageRecordTransactionPreparation,
  withRecordPublicationOriginals,
} from '../record-versions.ts';
import { recordPreparedPublicationFixture } from './helpers/record-prepared-publication-fixture.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';

for (const publish of [false, true])
  test(
    publish
      ? 'actual vault prepared intent commits its frozen replay and indexed value'
      : 'actual vault preparatory intent stages only frozen changed rows without accepting a HEAD',
    async (t) => {
      const {
        db,
        profileId,
        storage,
        plan,
        personId,
        beforeHead,
        beforePerson,
        versions,
        beforeObjects,
      } = await recordPreparedPublicationFixture(t);
      await runExclusiveClinicalOperation(db, async () => {
        t.diagnostic('phase: capture original parent union');
        const original = captureOwnershipReportOriginalProof(plan, db, profileId),
          originals = await captureRecordPublicationOriginals(db, profileId, original);
        try {
          t.diagnostic('phase: original backing and T1 preparation');
          const preparation = await prepareRecordTransactionWithOriginals(
            db,
            () => {
              recordMutationStatement(db, 'UPDATE people SET display_name=? WHERE id=?').run(
                'Fictional changed recipient',
                personId,
              );
              return { changed: true };
            },
            { operationId: randomUUID(), fingerprint: 'fictional-prepared-intent' },
            originals,
          );
          try {
            t.diagnostic('phase: authenticate changed priors');
            await authenticateRecordTransactionPreparation(db, preparation);
            t.diagnostic('phase: stage immutable objects and index arguments');
            const work = createRecordVersionWorkCounters();
            try {
              await withRecordVersionWork(work, () =>
                stageRecordTransactionPreparation(db, preparation),
              );
            } finally {
              t.diagnostic(JSON.stringify({ stageWork: work }));
            }
            await assert.rejects(
              stageRecordTransactionPreparation(db, preparation),
              /preparation unavailable/,
            );
            t.diagnostic('phase: final original union closure');
            await withRecordPublicationOriginals(db, originals, (current) => current());
            assert.equal(db.isTransaction, false);
            assert.deepEqual(storage.read('head'), beforeHead);
            assert.deepEqual(
              { ...db.prepare('SELECT * FROM people WHERE id=?').get(personId)! },
              beforePerson,
            );
            assert.ok(
              readdirSync(versions).length > beforeObjects,
              'private changed objects were actually staged',
            );
            if (publish) {
              t.diagnostic('phase: final original closure and fresh replay commit');
              assert.deepEqual(await commitRecordTransactionPreparation(db, preparation), {
                changed: true,
              });
              assert.equal(db.isTransaction, false);
              assert.notDeepEqual(storage.read('head'), beforeHead);
              assert.equal(
                db.prepare('SELECT display_name FROM main.people WHERE id=?').get(personId)!
                  .display_name,
                'Fictional changed recipient',
              );
              const indexed = db
                .prepare(
                  'SELECT v.contents_json FROM main.__record_current c JOIN main.__record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
                )
                .get('people', JSON.stringify([personId]));
              assert.equal(
                JSON.parse(String(indexed!.contents_json)).display_name,
                'Fictional changed recipient',
              );
              const acceptedHead = Buffer.from(storage.read('head')!);
              await assert.rejects(commitRecordTransactionPreparation(db, preparation), {
                message: 'Record replay requires its genuine released preparation',
              });
              assert.deepEqual(storage.read('head'), acceptedHead);
              assert.deepEqual(
                db
                  .prepare(
                    'SELECT v.contents_json FROM main.__record_current c JOIN main.__record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
                  )
                  .get('people', JSON.stringify([personId])),
                indexed,
              );
            }
          } finally {
            discardRecordTransactionPreparation(db, preparation);
          }
        } finally {
          closeRecordPublicationOriginals(originals);
        }
      });
      if (publish) assert.notDeepEqual(storage.read('head'), beforeHead);
      else assert.deepEqual(storage.read('head'), beforeHead);
    },
  );
