import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import { attachPersonalDurability, rebuildProfile } from '../portable.ts';
import { createBackup } from '../recovery.ts';
import { contributorCopyWorkerIntakeValidations } from '../contributor-durability.ts';
import {
  productionIntakeAuthorityWork,
  validateProductionIntakeAuthority,
} from '../intake-state-bootstrap.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { isIntakeSummary } from '../../shared/intake-summary.ts';

test('backup then rebuild replays retained legacy intake once and still refuses a changed row', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-backup-rebuild-validation-')),
    profileId = 'fictional-validation-owner';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const original = Buffer.from('%PDF-1.4\nFictional validation reuse document\n');
  const upload = Object.assign(Readable.from([original]), {
    headers: { 'x-content-sha256': createHash('sha256').update(original).digest('hex') },
  }) as unknown as IncomingMessage;
  const item = await intake.uploadIntakeStream(
    db,
    root,
    profileId,
    { filename: 'fictional.pdf', newProviderName: 'Fictional clinic', mimeType: 'application/pdf' },
    upload,
  );
  await intake.proposeConversionRead(db, root, profileId, item.id, {
    version: item.version,
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'fixture',
      kind: 'document',
      payload: 'Fictional page 1',
      provenance: {
        capturedVia: null,
        sourceSystem: null,
        sourceRecordId: null,
        evidenceClass: 'transcription',
        locator: 'page 1',
      },
      coverage: { status: 'partial', notes: ['Remaining pages pending'] },
    }),
    summary: 'Only page 1 inspected',
  });

  const start = productionIntakeAuthorityWork(),
    workerStart = contributorCopyWorkerIntakeValidations(db);
  const backup = await createBackup(db, root, profileId),
    target = join(root, 'rebuilt'),
    rebuilt = rebuildProfile(join(backup.path, 'files'), profileId, target);
  const workerReplays = contributorCopyWorkerIntakeValidations(db) - workerStart,
    afterRebuild = productionIntakeAuthorityWork(),
    hostReplays = afterRebuild.validations - start.validations;
  // The backup worker's complete validation covers the exact rows the rebuild
  // consumes, so the backup-plus-rebuild operation replays retained intake once.
  assert.equal(workerReplays, 1, 'backup certification validates once');
  assert.equal(hostReplays, 0, 'rebuild reuses the identical validated input');
  assert.ok(afterRebuild.reuses > start.reuses);

  const restored = openDatabase(rebuilt.database, profileId);
  t.after(() => {
    clearIntakeStateCache(restored);
    if (restored.isOpen) restored.close();
  });
  attachPersonalDurability(restored, { root: target, profileId });
  assert.equal(productionIntakeAuthorityWork().validations, afterRebuild.validations);
  const restoredIntake = intake.getIntakeRead(restored, target, profileId, item.id);
  assert.ok(isIntakeSummary(restoredIntake));
  assert.equal(restoredIntake.collections.proposals.total, 1);

  // A changed row is never served the worker's result: complete validation runs and refuses it.
  const head = restored
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:head'")
    .get()!;
  const changed = String(head.value).replace(
    /"storageSequence":(\d+)/,
    (_, n: string) => `"storageSequence":${Number(n) + 1}`,
  );
  assert.notEqual(changed, head.value);
  restored.prepare('UPDATE app_meta SET value=? WHERE key=?').run(changed, head.key!);
  const beforeChanged = productionIntakeAuthorityWork();
  assert.throws(() => validateProductionIntakeAuthority(restored, profileId));
  assert.equal(productionIntakeAuthorityWork().reuses, beforeChanged.reuses);
});
