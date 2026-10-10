import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { openDatabase, type Database } from '../../database.ts';
import { buildIntakeCollectionEnvelope } from '../../intake-envelope-build.ts';
import { importIntake, reviewIntake, uploadIntake } from '../../intake.ts';
import { createNote } from '../../notes.ts';
import { ensureProfileDirectories, profileOriginal } from '../../profile-storage.ts';
import { attachRecordDurability } from '../../record-versions.ts';
import {
  clearNativeOwnershipPlans,
  nativeOwnershipReportPlan,
  previewNativeRecordOwnership,
} from '../../record-ownership-native.ts';
import { freshKey } from '../../vault-crypto.ts';
import { openVault } from '../../vault-store.ts';

export async function recordPreparedPublicationFixture(
  t: TestContext,
  initialize?: (db: Database) => void,
) {
  t.diagnostic('phase: imported setup');
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-prepared-publication-'))),
    profileId = 'fictional-prepared-publication',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    key = freshKey(),
    vault = openVault({ directory: paths.root, profileId, key, initialize: true }),
    storage = vault.recordStorage();
  t.after(() => {
    clearNativeOwnershipPlans(db);
    db.close();
    vault.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  });
  initialize?.(db);
  attachRecordDurability(db, { profileId, storage });
  const recipient = createNote(db, {
    kind: 'person',
    title: 'Fictional Recipient',
    person: { fullName: 'Fictional Recipient' },
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional.jsonl',
    newProviderName: 'Fictional Clinic',
    bytes: Buffer.from(
      JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-record',
        kind: 'record',
        payload: { literal: 'Independently fictional evidence' },
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
          sourceRecordId: 'fictional-record',
          capturedVia: null,
          evidenceClass: 'provider_export',
          locator: 'Fictional row 1',
        },
        coverage: { status: 'complete_response', notes: [] },
      }),
    ),
  });
  const sourcePath = String(
    db.prepare('SELECT path FROM source_files WHERE id=?').get(source.id)!.path,
  );
  vault.storeFile(sourcePath, readFileSync(profileOriginal(root, sourcePath, profileId)));
  vault.publish();
  const review = reviewIntake(db, root, profileId, source.id);
  importIntake(db, root, profileId, source.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  t.diagnostic('phase: build envelope');
  await buildIntakeCollectionEnvelope(db, source);
  const observation = db.prepare('SELECT id FROM observations').get()!;
  t.diagnostic('phase: prepare report plan');
  const preview = await previewNativeRecordOwnership(db, root, profileId, {
    selection: {
      type: 'records',
      records: [{ kind: 'observation', recordId: String(observation.id) }],
    },
    destination: { noteId: recipient.id, expectedVersion: recipient.version },
  });
  assert.ok('reportEvidence' in preview);
  const plan = nativeOwnershipReportPlan(db, profileId, preview.reportEvidence.token),
    personId = String(
      db.prepare('SELECT person_id FROM notes WHERE id=?').get(recipient.id)!.person_id,
    ),
    beforeHead = Buffer.from(storage.read('head')!),
    beforePerson = { ...db.prepare('SELECT * FROM people WHERE id=?').get(personId)! },
    versions = join(paths.root, 'vault', 'versions'),
    beforeObjects = readdirSync(versions).length;
  return {
    root,
    profileId,
    paths,
    db,
    vault,
    storage,
    source,
    sourcePath,
    plan,
    personId,
    beforeHead,
    beforePerson,
    versions,
    beforeObjects,
  };
}
