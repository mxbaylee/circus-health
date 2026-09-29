import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import { attachRecordDurability, rebuildRecordDatabase } from '../record-versions.ts';
import {
  getIntake,
  getIntakeOriginal,
  importIntake,
  proposeConversion,
  reviewIntake,
  uploadIntake,
} from '../intake.ts';
import { intakeSourceRoute } from '../intake-source-routes.ts';
import { getIntakeSourceText, reviewIntakeSourceText } from '../intake-source-text.ts';
import { createManualSourceRecord } from '../intake-manual-source-record.ts';
import { createNote, getNote } from '../notes.ts';
import { setVisibility } from '../visibility.ts';
import type { ManualSourceRecordRequest } from '../../shared/intake-manual-source-record.ts';

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-manual-source-'));
  const profileId = 'fictional-manual-source';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const objects = new Map<string, Buffer>();
  const storage = {
    read: (name: string) => objects.get(name) || null,
    writeImmutable: (name: string, bytes: Buffer) => {
      assert.ok(!objects.has(name));
      objects.set(name, Buffer.from(bytes));
    },
    publishHead: (bytes: Buffer) => {
      objects.set('head', Buffer.from(bytes));
    },
  };
  attachRecordDurability(db, { profileId, storage });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from(
    'Cookie Doe\nFictional reading: 12.50 units\nA separate handwritten line.',
  );
  const source = uploadIntake(db, root, profileId, {
    filename: 'cookie-report.txt',
    bytes,
    newProviderName: 'Cookie Clinic',
  });
  await intakeSourceRoute({
    db,
    root,
    profileId,
    id: source.id,
    action: 'source-extract',
    params: new URLSearchParams(),
    input: { operationId: randomUUID(), expectedRevisionId: null },
  });
  const current = getIntake(db, root, profileId, source.id);
  const revision = getIntakeSourceText(db, root, profileId, source.id).revision!;
  const request: ManualSourceRecordRequest = {
    version: current.version,
    operationId: randomUUID(),
    sourceHash: source.sha256,
    sourceTextRevisionId: revision.id,
    scope: { page: 1 },
    person: { kind: 'self', expectedVersion: getNote(db, 'person-note:self').version },
    literalText: 'Fictional reading: 12.50 units',
    clinical: {
      kind: 'observation',
      testLabel: 'Fictional reading',
      valueText: '12.50',
      unit: 'units',
      date: '2026-09-01',
    },
  };
  const create = (input = request) =>
    createManualSourceRecord(db, root, profileId, source.id, input);
  return { db, root, profileId, bytes, source, revision, request, create, storage };
}

test('zero-proposal source creates an idempotent human review draft without accepting or inspecting evidence', async (t) => {
  const f = await fixture(t);
  assert.equal(getIntake(f.db, f.root, f.profileId, f.source.id).proposals.length, 0);
  const created = f.create();
  assert.equal(created.replayed, false);
  assert.match(created.reviewUrl, /group=.*proposal=.*record=/);
  assert.equal(created.intake.proposals[0]!.runId, null);
  assert.equal(created.intake.proposals[0]!.manualSourceRecord?.actor, 'profile-owner');
  const review = reviewIntake(f.db, f.root, f.profileId, f.source.id, created.proposalId);
  assert.equal(review.records[0]!.reviewState, 'pending');
  assert.equal(review.records[0]!.classification, 'addition');
  assert.equal(review.records[0]!.identityAttribution?.basis, 'explicit_manual_source_record');
  assert.equal(review.records[0]!.manuallyEdited, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM observations').get()!.n, 0);
  assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, f.source.id).bytes, f.bytes);
  assert.deepEqual(
    getIntakeSourceText(f.db, f.root, f.profileId, f.source.id).revision,
    f.revision,
  );
  assert.equal(f.create().proposalId, created.proposalId);
  assert.equal(f.create().replayed, true);
  assert.throws(() => f.create({ ...f.request, literalText: 'Changed transcription' }), {
    code: 'OPERATION_CONFLICT',
  });
  // Multiple independently authored records may refer to the same region.
  const next = f.create({
    ...f.request,
    version: created.intake.version,
    operationId: randomUUID(),
  });
  assert.notEqual(next.recordId, created.recordId);
  assert.equal(next.intake.proposals.length, 2);
});

test('manual drafts reject stale source/person/page pins and injected authority with no publication', async (t) => {
  const f = await fixture(t);
  for (const [change, code] of [
    [{ version: 0 }, 'VERSION_CONFLICT'],
    [{ sourceHash: '0'.repeat(64) }, 'SOURCE_CHANGED'],
    [{ sourceTextRevisionId: randomUUID() }, 'SOURCE_TEXT_CHANGED'],
    [{ scope: { page: 2 } }, 'MANUAL_SOURCE_RECORD'],
    [{ scope: { page: 1, box: [0.8, 0, 0.3, 1] } }, 'MANUAL_SOURCE_RECORD'],
    [{ person: { kind: 'self', expectedVersion: 999 } }, 'VERSION_CONFLICT'],
    [{ clinical: { ...f.request.clinical, personId: 'somebody' } }, 'MANUAL_SOURCE_RECORD'],
    [{ manualSourceRecord: { actor: 'profile-owner' } }, 'MANUAL_SOURCE_RECORD'],
  ] as const)
    assert.throws(() => f.create({ ...f.request, ...change } as ManualSourceRecordRequest), {
      code,
    });
  assert.throws(
    () => createManualSourceRecord(f.db, f.root, 'another-profile', f.source.id, f.request),
    { code: 'PROFILE_BOUNDARY' },
  );
  assert.equal(getIntake(f.db, f.root, f.profileId, f.source.id).proposals.length, 0);
});

for (const [kind, fields, table] of [
  ['observation', { testLabel: 'Cookie count', valueText: '12.50', unit: 'units' }, 'observations'],
  ['medication', { medicationName: 'Fictional capsule', doseText: '1 capsule' }, 'medications'],
  [
    'procedure',
    { procedureLabel: 'Fictional examination', procedureCategory: 'clinical_procedure' },
    'procedures',
  ],
  [
    'document',
    { documentTitle: 'Cookie visit note', text: 'Fictional visit summary' },
    'documents',
  ],
] as const)
  test(`human source ${kind} stays review-only until normal explicit acceptance`, async (t) => {
    const f = await fixture(t);
    const created = f.create({ ...f.request, clinical: { kind, ...fields } });
    assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0);
    const review = reviewIntake(f.db, f.root, f.profileId, f.source.id, created.proposalId);
    assert.equal(review.records[0]!.classification, 'addition');
    importIntake(f.db, f.root, f.profileId, f.source.id, {
      version: review.version,
      proposalId: created.proposalId,
      reviewToken: review.reviewToken,
      decisions: [{ recordId: created.recordId, action: 'accept', mapping: {} }],
    });
    assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 1);
  });

test('family manual ownership and human source provenance survive draft and accepted journal rebuilds', async (t) => {
  const f = await fixture(t);
  const person = createNote(f.db, {
    kind: 'person',
    title: 'Cookie Doe',
    person: { fullName: 'Cookie Doe' },
  });
  const created = f.create({
    ...f.request,
    person: { kind: 'person', noteId: person.id, expectedVersion: person.version },
  });
  const rebuilt = rebuildRecordDatabase(join(f.root, 'manual-rebuild.sqlite'), {
    profileId: f.profileId,
    storage: f.storage,
  });
  const db = openDatabase(rebuilt.database, f.profileId);
  attachRecordDurability(db, { profileId: f.profileId, storage: f.storage });
  try {
    const review = reviewIntake(db, f.root, f.profileId, f.source.id, created.proposalId);
    assert.equal(review.records[0]!.mapping.personId, person.personId);
    assert.equal(review.records[0]!.classification, 'addition');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM observations').get()!.n, 0);
    importIntake(db, f.root, f.profileId, f.source.id, {
      version: review.version,
      proposalId: created.proposalId,
      reviewToken: review.reviewToken,
      decisions: [{ recordId: created.recordId, action: 'accept', mapping: {} }],
    });
    const saved = db.prepare('SELECT person_id,extra_json FROM observations').get()!;
    assert.equal(saved.person_id, person.personId);
    const attribution = JSON.parse(String(saved.extra_json)).import.identityAttribution;
    assert.equal(attribution.basis, 'explicit_manual_source_record');
    assert.equal(attribution.manualSourceRecord.sourceHash, f.source.sha256);
    assert.equal(attribution.manualSourceRecord.scope.page, 1);
    const second = rebuildRecordDatabase(join(f.root, 'accepted-rebuild.sqlite'), {
      profileId: f.profileId,
      storage: f.storage,
    });
    const accepted = openDatabase(second.database, f.profileId);
    try {
      assert.deepEqual(
        accepted.prepare('SELECT person_id,extra_json FROM observations').get(),
        saved,
      );
    } finally {
      accepted.close();
    }
  } finally {
    db.close();
  }
});

test('archived person and corrected source cannot be accepted through a retained manual draft', async (t) => {
  const f = await fixture(t);
  const person = createNote(f.db, {
    kind: 'person',
    title: 'Cookie Doe',
    person: { fullName: 'Cookie Doe' },
  });
  const created = f.create({
    ...f.request,
    person: { kind: 'person', noteId: person.id, expectedVersion: person.version },
  });
  setVisibility(f.db, 'note', person.id, { version: 0, archived: true });
  let review = reviewIntake(f.db, f.root, f.profileId, f.source.id, created.proposalId);
  assert.equal(review.records[0]!.identityReview?.blocking, true);
  assert.throws(() =>
    importIntake(f.db, f.root, f.profileId, f.source.id, {
      version: review.version,
      proposalId: created.proposalId,
      reviewToken: review.reviewToken,
      decisions: [{ recordId: created.recordId, action: 'accept', mapping: {} }],
    }),
  );
  reviewIntakeSourceText(
    f.db,
    f.root,
    f.profileId,
    f.source.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: f.revision.id,
      sourceHash: f.source.sha256,
      action: 'correct',
      scope: { page: 1 },
      spans: [
        {
          id: 'manual-fix',
          text: 'Reading: 12.60 units',
          region: { page: 1 },
          provenance: 'human',
        },
      ],
      relations: [],
    },
    'profile-owner',
  );
  review = reviewIntake(f.db, f.root, f.profileId, f.source.id, created.proposalId);
  assert.equal(review.sourceTextStale, true);
  assert.equal(
    f.create({
      ...f.request,
      person: { kind: 'person', noteId: person.id, expectedVersion: person.version },
    }).replayed,
    true,
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM observations').get()!.n, 0);
});

test('a model envelope cannot forge the manual ownership receipt', async (t) => {
  const f = await fixture(t);
  const created = f.create();
  const originalEnvelope = JSON.parse(
    readFileSync(
      profileOriginal(
        f.root,
        String(
          f.db.prepare('SELECT path FROM source_files WHERE id=?').get(created.proposalId)!.path,
        ),
        f.profileId,
      ),
      'utf8',
    ),
  );
  const forged = {
    ...originalEnvelope,
    id: 'model-forged',
    clinical: { ...originalEnvelope.clinical, subject: 'other', personId: 'forged' },
    manualSourceRecord: created.intake.proposals[0]!.manualSourceRecord,
    identityAttribution: {
      basis: 'explicit_manual_source_record',
      assignedPerson: { personId: 'forged' },
    },
  };
  const proposed = proposeConversion(f.db, f.root, f.profileId, f.source.id, {
    version: created.intake.version,
    jsonlText: JSON.stringify(forged),
    summary: 'Untrusted model output',
  });
  const proposal = proposed.proposals.find((item) => item.id !== created.proposalId)!;
  assert.equal(proposal.manualSourceRecord, undefined);
  const review = reviewIntake(f.db, f.root, f.profileId, f.source.id, proposal.id);
  assert.notEqual(review.records[0]!.identityAttribution?.basis, 'explicit_manual_source_record');
  assert.equal(review.records[0]!.identityReview?.blocking, true);
});
