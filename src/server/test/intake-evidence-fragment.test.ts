import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake } from '../intake.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import {
  readIntakeCollectionEvidenceFragment,
  clearIntakeCollectionEvidenceFragments,
} from '../intake-evidence-fragment.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
test('selected collection evidence byte windows seek without repeated traversal and refuse stale or foreign references', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-evidence-fragment-')),
    profileId = 'fictional-profile',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeCollectionEvidenceFragments(db);
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    newProviderName: 'Fictional source',
    bytes: Buffer.from('Fictional original'),
  });
  const envelope = JSON.parse(readIntakeEnvelopeText(db, { id: intake.id })!);
  envelope.intake.fictionalEvidence = {
    text: 'Fictional 🩺 '.repeat(20000),
    unknown: [1, null, true],
  };
  writeIntakeFixtureEnvelope(db, intake.id, envelope);
  await buildIntakeCollectionEnvelope(db, { id: intake.id, sha256: intake.sha256 });
  const source = db.prepare('SELECT * FROM source_files WHERE id=?').get(intake.id) as unknown as {
      id: string;
      sha256: string;
      details_json: string;
    },
    view = openIntakeCollectionEnvelope(db, source),
    record = view.child(view.root(), 'intake')!,
    reference = {
      format: 'health-intake-review-fragment-v1' as const,
      logical: view.logical,
      address: view.address(record),
      field: 'fictionalEvidence',
    };
  const first = await readIntakeCollectionEvidenceFragment(db, root, profileId, intake.id, {
      reference,
      bytes: 1001,
    }),
    cold = intakeWorkCounters(db).reconstruction.collectionEvidenceFragmentInputBytes;
  assert.ok(first.totalBytes > 256 * 1024);
  const chunks = [Buffer.from(first.data, 'base64')];
  let offset = first.nextOffset!;
  while (offset !== null) {
    const part = await readIntakeCollectionEvidenceFragment(db, root, profileId, intake.id, {
      reference,
      offset,
      bytes: 32768,
    });
    chunks.push(Buffer.from(part.data, 'base64'));
    if (part.complete) break;
    offset = part.nextOffset!;
  }
  assert.deepEqual(
    JSON.parse(Buffer.concat(chunks).toString('utf8')),
    envelope.intake.fictionalEvidence,
  );
  assert.equal(intakeWorkCounters(db).reconstruction.collectionEvidenceFragmentInputBytes, cold);
  assert.ok(
    intakeWorkCounters(db).reconstruction.collectionEvidenceFragmentPeakBufferBytes <= 16384,
  );
  await assert.rejects(
    readIntakeCollectionEvidenceFragment(db, root, 'foreign-profile', intake.id, { reference }),
    /profile|owner/i,
  );
  clearIntakeCollectionEvidenceFragments(db);
  let checks = 0;
  await assert.rejects(
    readIntakeCollectionEvidenceFragment(db, root, profileId, intake.id, {
      reference,
      assertRunning: () => {
        if (++checks === 3) throw Error('Fictional cancellation');
      },
    }),
    /Fictional cancellation/,
  );
  assert.deepEqual(
    await readIntakeCollectionEvidenceFragment(db, root, profileId, intake.id, {
      reference,
      bytes: 1001,
    }),
    first,
  );
  const mutation = await prepareIntakeEnvelopeMutation(db, source, {
    reader: view,
    operationId: randomUUID(),
    requestDigest: 'a'.repeat(64),
    domainVersion: view.logical.domainVersion + 1,
    changes: [{ op: 'set', record, field: 'state', jsonText: '"needs_review"' }],
  });
  transaction(db, () => selectedEnvelopeStore(db, source).collections.stage(mutation.prepared!));
  await assert.rejects(
    readIntakeCollectionEvidenceFragment(db, root, profileId, intake.id, { reference }),
    /Refresh/,
  );
});
