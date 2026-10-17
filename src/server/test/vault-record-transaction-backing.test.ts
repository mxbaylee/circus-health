import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase, transaction } from '../database.ts';
import { attachRecordDurability } from '../record-versions.ts';
import {
  runExclusiveClinicalOperation,
  assertClinicalOperation,
  currentClinicalOperation,
} from '../clinical-operation.ts';
import {
  captureManagedPhysicalEpoch,
  withManagedPhysicalMutation,
} from '../clinical-review-physical-epoch.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { freshKey } from '../vault-crypto.ts';
import {
  openVault,
  captureVaultRecordStaging,
  prepareVaultRecordTransactionBacking,
  assertVaultRecordTransactionPrior,
  finishVaultRecordStagingPreparation,
  discardVaultRecordStaging,
  captureVaultRecordReadOwner,
  captureVaultRecordAcceptedSourceRead,
  closeVaultRecordAcceptedSourceRead,
} from '../vault-store.ts';

for (const registration of [
  'before capture',
  'after capture',
  'after capture then another capture',
  'with physical drift',
] as const)
  test(`fresh vault staging retires only an idle methods-only cache: ${registration}`, async (t) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-backing-methods-'))),
      profileId = 'fictional-backing-methods',
      key = freshKey(),
      db = openDatabase(':memory:', profileId),
      vault = openVault({ directory: root, profileId, key, initialize: true }),
      storage = vault.recordStorage();
    t.after(() => {
      vault.close();
      db.close();
      key.fill(0);
      rmSync(root, { recursive: true, force: true });
    });
    attachRecordDurability(db, { profileId, storage });
    transaction(db, () =>
      db
        .prepare('INSERT INTO people(id,display_name) VALUES(?,?)')
        .run('fictional-person', 'Fictional Person'),
    );
    const selectedHead = storage.read('head')!.toString('utf8');
    await runExclusiveClinicalOperation(db, async () => {
      const operation = currentClinicalOperation(db)!,
        current = () => assertClinicalOperation(db, operation),
        original = captureVaultRecordReadOwner(storage)!;
      const read = await captureVaultRecordAcceptedSourceRead(
        db,
        storage,
        original,
        selectedHead,
        current,
      );
      closeVaultRecordAcceptedSourceRead(read);
      const register = () => db.function('fictional_late_function', () => 1),
        late = registration.startsWith('after capture');
      if (!late) register();
      if (registration === 'with physical drift') withManagedPhysicalMutation(() => undefined);
      const work = createRecordVersionWorkCounters();
      await withRecordVersionWork(work, async () => {
        const witness = captureVaultRecordStaging(db, storage, captureManagedPhysicalEpoch()!);
        assert.ok(witness);
        if (late) register();
        if (registration === 'after capture then another capture') {
          const another = captureVaultRecordStaging(db, storage, captureManagedPhysicalEpoch()!);
          assert.ok(another);
          discardVaultRecordStaging(another);
        }
        try {
          if (registration === 'before capture') {
            await prepareVaultRecordTransactionBacking(witness, selectedHead, current);
            await finishVaultRecordStagingPreparation(witness);
            assert.equal(
              work.operation.vaultBackingColdReplays,
              1,
              'fresh admission proves all backing',
            );
          } else {
            await assert.rejects(
              prepareVaultRecordTransactionBacking(witness, selectedHead, current),
              /original frontier changed/,
            );
            await assert.rejects(
              prepareVaultRecordTransactionBacking(witness, selectedHead, current),
              /recovery required/,
            );
            assert.equal(
              work.operation.vaultBackingColdReplays,
              0,
              'a refused operation cannot renew',
            );
          }
          assert.equal(work.operation.vaultBackingRejectedMethods, 1);
          assert.equal(storage.read('head')!.toString('utf8'), selectedHead);
          assert.equal(db.isTransaction, false);
        } finally {
          discardVaultRecordStaging(witness);
        }
      });
    });
  });

for (const fault of [undefined, 'version', 'preimage', 'absence', 'deleted'] as const)
  test(`record-only vault backing authenticates nonmetadata priors and absence without a dummy source${fault ? `: ${fault} disagreement` : ''}`, async (t) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-record-backing-'))),
      profileId = 'fictional-record-backing',
      key = freshKey(),
      db = openDatabase(':memory:', profileId),
      vault = openVault({ directory: root, profileId, key, initialize: true }),
      storage = vault.recordStorage();
    t.after(() => {
      vault.close();
      db.close();
      key.fill(0);
      rmSync(root, { recursive: true, force: true });
    });
    attachRecordDurability(db, { profileId, storage });
    transaction(db, () => {
      db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)').run(
        'fictional-person',
        'Fictional Person',
      );
      db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)').run(
        'fictional-deleted',
        'Fictional Removed',
      );
    });
    transaction(db, () => db.prepare('DELETE FROM people WHERE id=?').run('fictional-deleted'));
    const read = db.prepare(
      'SELECT v.* FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
    );
    const original = read.get('people', JSON.stringify(['fictional-person']))!,
      deleted = read.get('people', JSON.stringify(['fictional-deleted']))!,
      digest = (raw: string) => {
        const encoded = JSON.stringify(raw);
        return {
          hash: createHash('sha256').update(encoded).digest('hex'),
          bytes: Buffer.byteLength(encoded),
        };
      };
    const selectedHead = storage.read('head')!.toString('utf8');
    await runExclusiveClinicalOperation(db, async () => {
      const operation = currentClinicalOperation(db)!,
        current = () => assertClinicalOperation(db, operation);
      const witness = captureVaultRecordStaging(db, storage, captureManagedPhysicalEpoch()!);
      assert.ok(witness);
      try {
        await prepareVaultRecordTransactionBacking(witness, selectedHead, current);
        const prior = { deleted: false, preimage: digest(String(original.contents_json)) };
        assertVaultRecordTransactionPrior(
          witness,
          'people',
          JSON.stringify(['fictional-person']),
          String(original.version_id),
          prior,
        );
        assertVaultRecordTransactionPrior(
          witness,
          'people',
          JSON.stringify(['fictional-new']),
          null,
          null,
        );
        assertVaultRecordTransactionPrior(
          witness,
          'people',
          JSON.stringify(['fictional-deleted']),
          String(deleted.version_id),
          { deleted: true, preimage: digest(String(deleted.contents_json)) },
        );
        if (fault) {
          assert.throws(() => {
            if (fault === 'absence')
              assertVaultRecordTransactionPrior(
                witness,
                'people',
                JSON.stringify(['fictional-person']),
                null,
                null,
              );
            else
              assertVaultRecordTransactionPrior(
                witness,
                'people',
                JSON.stringify(['fictional-person']),
                fault === 'version' ? String(deleted.version_id) : String(original.version_id),
                {
                  deleted: fault === 'deleted',
                  preimage:
                    fault === 'preimage' ? digest('concealed fictional preimage') : prior.preimage,
                },
              );
          }, /predecessor differs/);
          assert.throws(
            () =>
              assertVaultRecordTransactionPrior(
                witness,
                'people',
                JSON.stringify(['fictional-new']),
                null,
                null,
              ),
            /unavailable/,
          );
        } else await finishVaultRecordStagingPreparation(witness);
        assert.equal(storage.read('head')!.toString('utf8'), selectedHead);
        assert.equal(db.isTransaction, false);
      } finally {
        discardVaultRecordStaging(witness);
      }
      const retry = captureVaultRecordStaging(db, storage, captureManagedPhysicalEpoch()!);
      assert.ok(retry);
      try {
        if (fault)
          await assert.rejects(
            prepareVaultRecordTransactionBacking(retry, selectedHead, current),
            /recovery required/,
          );
        else {
          await prepareVaultRecordTransactionBacking(retry, selectedHead, current);
          await finishVaultRecordStagingPreparation(retry);
        }
        assert.equal(storage.read('head')!.toString('utf8'), selectedHead);
        assert.equal(db.isTransaction, false);
      } finally {
        discardVaultRecordStaging(retry);
      }
    });
  });
