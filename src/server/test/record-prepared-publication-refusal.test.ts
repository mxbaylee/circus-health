import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants } from 'node:sqlite';
import test from 'node:test';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { captureOwnershipReportOriginalProof } from '../ownership-report-plan.ts';
import { profileOriginal } from '../profile-storage.ts';
import { recordMutationStatement } from '../record-mutation-recipe.ts';
import {
  authenticateRecordTransactionPreparation,
  captureRecordPublicationOriginals,
  closeRecordPublicationOriginals,
  commitRecordTransactionPreparation,
  discardRecordTransactionPreparation,
  prepareRecordTransactionWithOriginals,
  stageRecordTransactionPreparation,
  type RecordTransactionPreparation,
} from '../record-versions.ts';
import { recordPreparedPublicationFixture } from './helpers/record-prepared-publication-fixture.ts';

function replaceSameBytes(path: string) {
  const bytes = readFileSync(path),
    before = lstatSync(path, { bigint: true }),
    replacement = path + '.fictional-replacement-' + randomUUID();
  writeFileSync(replacement, bytes, { flag: 'wx', mode: 0o600 });
  renameSync(replacement, path);
  assert.notEqual(lstatSync(path, { bigint: true }).ino, before.ino);
  assert.deepEqual(readFileSync(path), bytes);
}

for (const fault of ['original-after-staging', 'encrypted-object-in-policy'] as const)
  test(`actual vault ${fault === 'original-after-staging' ? 'final publication' : 'preparation policy'} refuses same-byte replacement: ${fault}`, async (t) => {
    let armed = false,
      fired = false,
      encryptedPath = '',
      phase = 'fixture',
      firedPhase = '';
    const mark = (next: string) => {
      t.signal.throwIfAborted();
      phase = next;
      t.diagnostic('phase: ' + phase);
    };
    t.after(() =>
      t.diagnostic(JSON.stringify({ refusalPhase: phase, replacementFired: fired, firedPhase })),
    );
    const f = await recordPreparedPublicationFixture(t, (db) => {
      if (fault !== 'encrypted-object-in-policy') return;
      db.setAuthorizer((action, table) => {
        if (
          armed &&
          !fired &&
          action === constants.SQLITE_INSERT &&
          table === '__record_versions'
        ) {
          fired = true;
          firedPhase = phase;
          replaceSameBytes(encryptedPath);
        }
        return constants.SQLITE_OK;
      });
    });
    const indexed = () =>
      f.db
        .prepare(
          'SELECT v.* FROM main.__record_current c JOIN main.__record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
        )
        .get('people', JSON.stringify([f.personId]));
    const beforeIndexed = { ...indexed()! };
    encryptedPath = join(f.versions, readdirSync(f.versions)[0]!);
    assert.ok(lstatSync(encryptedPath).isFile());
    await runExclusiveClinicalOperation(f.db, async () => {
      mark('capture original parent union');
      const original = captureOwnershipReportOriginalProof(f.plan, f.db, f.profileId),
        originals = await captureRecordPublicationOriginals(f.db, f.profileId, original);
      let preparation: RecordTransactionPreparation | undefined;
      try {
        armed = true;
        await assert.rejects(async () => {
          mark('prepare tentative transaction');
          preparation = await prepareRecordTransactionWithOriginals(
            f.db,
            () => {
              recordMutationStatement(f.db, 'UPDATE people SET display_name=? WHERE id=?').run(
                'Fictional refused change',
                f.personId,
              );
              return { changed: true };
            },
            { operationId: randomUUID(), fingerprint: 'fictional-refused-publication' },
            originals,
          );
          mark('authenticate changed priors');
          await authenticateRecordTransactionPreparation(f.db, preparation);
          mark('stage frozen transaction');
          await stageRecordTransactionPreparation(f.db, preparation);
          mark('attempt final publication');
          if (fault === 'original-after-staging') {
            replaceSameBytes(profileOriginal(f.root, f.sourcePath, f.profileId));
            fired = true;
            firedPhase = phase;
          }
          await commitRecordTransactionPreparation(f.db, preparation);
        }, /changed|mismatch|physical|unavailable|differs|revoked/i);
      } finally {
        armed = false;
        if (preparation) discardRecordTransactionPreparation(f.db, preparation);
        closeRecordPublicationOriginals(originals);
      }
    });
    assert.ok(fired, 'the requested preparation or publication phase must reach the replacement');
    assert.equal(
      firedPhase,
      fault === 'original-after-staging'
        ? 'attempt final publication'
        : 'prepare tentative transaction',
      'the SQL-policy refusal covers preparation; the staged-original refusal covers final commit',
    );
    assert.equal(f.db.isTransaction, false);
    assert.deepEqual(f.storage.read('head'), f.beforeHead);
    assert.deepEqual(
      { ...f.db.prepare('SELECT * FROM people WHERE id=?').get(f.personId)! },
      f.beforePerson,
    );
    assert.deepEqual({ ...indexed()! }, beforeIndexed);
  });
