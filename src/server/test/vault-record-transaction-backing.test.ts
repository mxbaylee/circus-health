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
import { captureManagedPhysicalEpoch } from '../clinical-review-physical-epoch.ts';
import { freshKey } from '../vault-crypto.ts';
import {
  openVault,
  captureVaultRecordStaging,
  prepareVaultRecordTransactionBacking,
  assertVaultRecordTransactionPrior,
  finishVaultRecordStagingPreparation,
  discardVaultRecordStaging,
} from '../vault-store.ts';

test('record-only vault backing authenticates nonmetadata priors and absence without a dummy source', async (t) => {
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
    for (const fault of [undefined, 'version', 'preimage', 'absence', 'deleted'] as const) {
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
    }
  });
});
