import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { openDatabase } from '../database.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { importIntake, reviewIntake, uploadIntake } from '../intake.ts';
import { createNote } from '../notes.ts';
import { childOwnershipOperation, ownershipPlans } from '../ownership-groups.ts';
import {
  clearNativeOwnershipPlans,
  commitNativeRecordOwnership,
  nativeOwnershipReportPlan,
  previewNativeRecordOwnership,
} from '../record-ownership-native.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';

async function fixture(t: TestContext, originalCount: number, newPerson = false) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-prepared-ownership-')),
    profileId = 'fictional',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
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
  const originals: string[] = [];
  for (let index = 0; index < originalCount; index++) {
    const id = `fictional-${index}`,
      original = uploadIntake(db, root, profileId, {
        filename: `${id}.jsonl`,
        newProviderName: 'Fictional Clinic',
        bytes: Buffer.from(
          JSON.stringify({
            format: 'health-record-v1',
            id,
            kind: 'record',
            payload: { literal: `Fictional retained evidence ${index}` },
            clinical: {
              kind: 'observation',
              subject: 'self',
              date: '2026-01-12',
              testLabel: index === 0 ? 'Fictional reach' : 'Jade rhythm',
              valueText: '12.00',
              unit: 'cm',
            },
            provenance: {
              sourceSystem: 'Fictional Clinic',
              sourceRecordId: id,
              capturedVia: null,
              evidenceClass: 'provider_export',
              locator: `Fictional row ${index}`,
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
    originals.push(original.id);
  }
  for (const id of originals) await buildIntakeCollectionEnvelope(db, { id });
  const records = db.prepare('SELECT id FROM observations ORDER BY id').all(),
    preview = await previewNativeRecordOwnership(db, root, profileId, {
      selection: {
        type: 'records',
        records: records.map((row) => ({ kind: 'observation' as const, recordId: String(row.id) })),
      },
      destination: newPerson
        ? { newPerson: { fullName: 'Fictional New Recipient' } }
        : { noteId: destination.id, expectedVersion: destination.version },
    });
  assert.ok('reportEvidence' in preview);
  return { root, profileId, db, destination, preview };
}

test('one ownership unit invokes its business intent once and accepts one receipt', async (t) => {
  const f = await fixture(t, 1),
    operationId = randomUUID(),
    plan = nativeOwnershipReportPlan(f.db, f.profileId, f.preview.reportEvidence.token),
    previewUnit = plan.preview.bind(plan);
  assert.equal(f.preview.commitGroups.length, 1);
  let businessCalls = 0;
  plan.preview = () => {
    businessCalls++;
    return previewUnit();
  };
  const command = {
    operationId,
    request: f.preview.request,
    scopeToken: f.preview.scopeToken,
    version: f.preview.version,
  };
  await assert.rejects(
    commitNativeRecordOwnership(f.db, f.root, f.profileId, {
      ...command,
      scopeToken: 'not-the-reviewed-scope',
    }),
    /Review the current ownership evidence/,
  );
  assert.equal(businessCalls, 0);
  assert.equal(
    f.db.prepare('SELECT 1 FROM manual_batches WHERE id=?').get('ownership:' + operationId),
    undefined,
  );
  const receipt = await commitNativeRecordOwnership(f.db, f.root, f.profileId, command);
  assert.equal(businessCalls, 1);
  assert.equal(receipt.operationId, operationId);
  assert.equal(receipt.destinationPersonId, f.destination.personId);
  assert.equal(receipt.moved, 1);
  assert.ok(
    f.db.prepare('SELECT 1 FROM manual_batches WHERE id=?').get('ownership:' + operationId),
  );
});

test('approved ownership groups publish distinct children under the retained parent', async (t) => {
  const f = await fixture(t, 2),
    operationId = randomUUID(),
    groups = f.preview.commitGroups;
  assert.equal(groups.length, 2);
  const beforeSequence = Number(
    f.db.prepare('SELECT sequence FROM __record_state WHERE singleton=1').get()!.sequence,
  );
  const receipt = await commitNativeRecordOwnership(f.db, f.root, f.profileId, {
    operationId,
    request: f.preview.request,
    scopeToken: f.preview.scopeToken,
    version: f.preview.version,
  });
  assert.equal(receipt.operationId, operationId);
  assert.equal(receipt.destinationPersonId, f.destination.personId);
  assert.equal(receipt.moved, 2);
  assert.equal(ownershipPlans(f.db, operationId).length, 2);
  for (const group of groups)
    assert.ok(
      f.db
        .prepare('SELECT 1 FROM manual_batches WHERE id=?')
        .get('ownership:' + childOwnershipOperation(operationId, group.id)),
    );
  const afterSequence = Number(
    f.db.prepare('SELECT sequence FROM __record_state WHERE singleton=1').get()!.sequence,
  );
  assert.ok(afterSequence - beforeSequence > groups.length);
});

test('approved groups create one new destination and reuse its accepted version', async (t) => {
  const f = await fixture(t, 2, true),
    operationId = randomUUID(),
    groups = f.preview.commitGroups;
  assert.equal(groups.length, 2);
  const receipt = await commitNativeRecordOwnership(f.db, f.root, f.profileId, {
    operationId,
    request: f.preview.request,
    scopeToken: f.preview.scopeToken,
    version: f.preview.version,
  });
  assert.equal(receipt.moved, 2);
  assert.notEqual(receipt.destinationPersonId, f.destination.personId);
  const rows = f.db
    .prepare("SELECT id,person_id,version FROM notes WHERE kind='person' AND person_id=?")
    .all(receipt.destinationPersonId);
  assert.equal(rows.length, 1);
  assert.ok(Number(rows[0]!.version) >= 1);
  for (const group of groups) {
    const row = f.db
      .prepare('SELECT coverage_json FROM manual_batches WHERE id=?')
      .get('ownership:' + childOwnershipOperation(operationId, group.id));
    assert.ok(row);
    assert.equal(
      (JSON.parse(String(row.coverage_json)) as { receipt: { destinationPersonId: string } })
        .receipt.destinationPersonId,
      receipt.destinationPersonId,
    );
  }
});
