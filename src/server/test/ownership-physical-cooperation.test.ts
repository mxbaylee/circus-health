import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { withManagedPhysicalMutation } from '../clinical-review-physical-epoch.ts';
import { openDatabase, observeTransactionBeforePublication } from '../database.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { importIntake, reviewIntake, uploadIntake } from '../intake.ts';
import { createNote } from '../notes.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import {
  clearNativeOwnershipPlans,
  commitNativeRecordOwnership,
  nativeOwnershipReportPlan,
  previewNativeRecordOwnership,
  withNativeOwnershipNamePlan,
  withNativeOwnershipReportPlan,
} from '../record-ownership-native.ts';

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-ownership-physical-')),
    profileId = 'fictional';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearNativeOwnershipPlans(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const destination = createNote(db, {
    kind: 'person',
    title: 'Fictional Recipient',
    person: { fullName: 'Fictional Recipient' },
  });
  const original = uploadIntake(db, root, profileId, {
    filename: 'fictional.jsonl',
    newProviderName: 'Fictional Clinic',
    bytes: Buffer.from(
      JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional',
        kind: 'record',
        payload: { literal: 'Fictional retained evidence' },
        clinical: {
          kind: 'observation',
          subject: 'self',
          date: '2026-01-12',
          testLabel: 'Fictional reach',
          valueText: '12.00',
          unit: 'cm',
        },
        provenance: {
          sourceSystem: 'Fictional Clinic',
          sourceRecordId: 'fictional',
          capturedVia: null,
          evidenceClass: 'provider_export',
          locator: 'Fictional row 1',
        },
        coverage: { status: 'complete_response', notes: [] },
      }),
    ),
  });
  const review = reviewIntake(db, root, profileId, original.id);
  importIntake(db, root, profileId, original.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  await buildIntakeCollectionEnvelope(db, { id: original.id });
  const record = db.prepare('SELECT id FROM observations').get()!;
  const preview = await previewNativeRecordOwnership(db, root, profileId, {
    selection: { type: 'records', records: [{ kind: 'observation', recordId: String(record.id) }] },
    destination: { noteId: destination.id, expectedVersion: destination.version },
  });
  assert.ok('reportEvidence' in preview);
  return {
    root,
    db,
    profileId,
    preview,
    path: profileOriginal(
      root,
      db.prepare('SELECT path FROM source_files WHERE id=?').get(original.id)!.path,
      profileId,
    ),
  };
}

test('ownership physical read closures cooperate and reject writes to the selected preview', async (t) => {
  const f = await fixture(t);
  let unrelated = false;
  const read = withNativeOwnershipReportPlan(
    f.db,
    f.profileId,
    f.preview.reportEvidence.token,
    (plan) => plan.page('records'),
  );
  setImmediate(() => {
    unrelated = true;
  });
  const page = await read;
  assert.equal(unrelated, true);
  assert.equal(page.total, 1);
  const report = nativeOwnershipReportPlan(f.db, f.profileId, f.preview.reportEvidence.token);
  await assert.rejects(
    report.withVerifiedRead(() => report.finalize()),
    /preview changed during verification/,
  );
  assert.equal((await report.finalizeVerified()).scopeToken, f.preview.scopeToken);
});

test('ownership name and report evidence retain the original physical baseline across a host turn', async (t) => {
  const f = await fixture(t);
  const read = withNativeOwnershipNamePlan(
    f.db,
    f.profileId,
    f.preview.nameEvidence.token,
    (plan) => plan.effects(),
  );
  setImmediate(() =>
    withManagedPhysicalMutation(() => writeFileSync(f.path, 'Changed fictional source')),
  );
  await assert.rejects(read, /physical evidence changed|Retained clinical evidence changed/);
  await assert.rejects(
    withNativeOwnershipReportPlan(f.db, f.profileId, f.preview.reportEvidence.token, (plan) =>
      plan.page('records'),
    ),
    /physical evidence changed/,
  );
});

test('ownership publication rejects a source change at the pre-durability terminal guard', async (t) => {
  const f = await fixture(t),
    operationId = randomUUID();
  await nativeOwnershipReportPlan(
    f.db,
    f.profileId,
    f.preview.reportEvidence.token,
  ).prepareSourceSnapshots();
  let reachedTerminal = false;
  const stop = observeTransactionBeforePublication(f.db, () => {
    reachedTerminal = true;
    withManagedPhysicalMutation(() => writeFileSync(f.path, 'Changed fictional source'));
  });
  t.after(stop);
  await assert.rejects(
    commitNativeRecordOwnership(f.db, f.root, f.profileId, {
      operationId,
      request: f.preview.request,
      scopeToken: f.preview.scopeToken,
      version: f.preview.version,
    }),
    /Retained clinical evidence changed/,
  );
  assert.equal(reachedTerminal, true);
  assert.equal(
    f.db.prepare('SELECT 1 FROM manual_batches WHERE id=?').get('ownership:' + operationId),
    undefined,
  );
  assert.equal(f.db.prepare('SELECT person_id FROM observations').get()!.person_id, 'patient');
});

test('profile lock interrupts cooperative ownership evidence and disposes its retained plan', async (t) => {
  const f = await fixture(t);
  const read = withNativeOwnershipReportPlan(
    f.db,
    f.profileId,
    f.preview.reportEvidence.token,
    (plan) => plan.page('records'),
  );
  setImmediate(() => clearNativeOwnershipPlans(f.db));
  await assert.rejects(read, /PROFILE_LOCKED|Unlock this profile|Closed ownership|Closed.*plan/);
  await assert.rejects(
    withNativeOwnershipReportPlan(f.db, f.profileId, f.preview.reportEvidence.token, (plan) =>
      plan.page('records'),
    ),
    /current report evidence/,
  );
});
