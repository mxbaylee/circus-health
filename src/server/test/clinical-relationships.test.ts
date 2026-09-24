import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import { duplicateRecord, saveDuplicateDecision } from '../duplicate-review.ts';
import {
  applyDirectRecordCorrection,
  previewDirectRecordCorrection,
} from '../clinical-review-routes.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  type RecordStorage,
} from '../record-versions.ts';
import {
  applyClinicalRelationship,
  clinicalRelationshipHistory,
  clinicalRelationshipProjection,
  getClinicalRelationshipReceipt,
  previewClinicalRelationship,
} from '../clinical-relationships.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';
import { getNote, saveNote } from '../notes.ts';
import type {
  ClinicalRelationshipApplyInput,
  ClinicalRelationshipRecord,
  ClinicalRelationshipRequest,
} from '../../shared/clinical-relationships.ts';

function assertion(id: string, value: string, scoped = false): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: {
      specimen: 'Fictional draw 61',
      literal: value,
      ...(scoped ? { patient: 'Fictional Avery Larch' } : {}),
    },
    ...(scoped
      ? {
          report: {
            key: 'fictional-draw-61',
            title: 'Fictional draw 61',
            anchor: { locator: 'Fictional result section ' + id, text: 'Fictional draw 61' },
            subject: { locator: 'Fictional result section ' + id, text: 'Fictional Avery Larch' },
          },
          reviewIssues: [
            {
              kind: 'identity' as const,
              field: 'subject',
              prompt: 'Confirm the printed patient.',
              textAnchor: 'Fictional Avery Larch',
              selfSuggestion: { fullName: 'Fictional Avery Larch' },
            },
          ],
        }
      : {}),
    provenance: {
      capturedVia: 'Fictional courier',
      sourceSystem: 'Invented Larch laboratory',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'Fictional result section ' + id,
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'observation',
      subject: 'self',
      date: '2025-08-12',
      testLabel: 'Invented amber measure',
      valueText: value,
      unit: 'mg/L',
    },
  };
}
function fixture(t: TestContext, scoped = false) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-relationships-')),
    profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId),
    opened = [db];
  if (scoped) {
    const self = getNote(db, 'person-note:self');
    saveNote(db, self.id, {
      version: self.version,
      person: { ...self.person, fullName: 'Fictional Avery Larch' },
    });
  }
  t.after(() => {
    for (const connection of opened) connection.close();
    rmSync(root, { recursive: true, force: true });
  });
  const add = (id: string, value: string) => {
    const source = intake.uploadIntake(db, root, profileId, {
      filename: 'fictional-' + id + '.jsonl',
      bytes: Buffer.from(JSON.stringify(assertion(id, value, scoped))),
      newProviderName: 'Fictional Larch clinic',
    });
    const review = intake.reviewIntake(db, root, profileId, source.id),
      record = review.records[0]!;
    const before = new Set(
      db
        .prepare('SELECT id FROM observations')
        .all()
        .map((row) => String(row.id)),
    );
    intake.importIntake(db, root, profileId, source.id, {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: [
        {
          recordId: record.id,
          action: 'accept',
          mapping: {},
          comparisons: (record.comparisons || []).map((other) => ({
            otherRecordId: other.id,
            scope: other.scope,
            outcome: 'distinct',
            reason: 'Fictional initial review retains each independently recorded assertion.',
          })),
        },
      ],
    });
    const saved = db
      .prepare('SELECT id FROM observations')
      .all()
      .find((row) => !before.has(String(row.id)))!;
    return {
      record: { kind: 'observation', recordId: String(saved.id) } as ClinicalRelationshipRecord,
      source,
    };
  };
  const a = add('a', '< 0.040'),
    b = add('b', '+004.500'),
    c = add('c', '4.500');
  const preview = (request: ClinicalRelationshipRequest) =>
    previewClinicalRelationship(db, root, profileId, request);
  const input = (request: ClinicalRelationshipRequest): ClinicalRelationshipApplyInput => {
    const { scope, version, previewToken } = preview(request);
    return { operationId: randomUUID(), request, scope, version, previewToken };
  };
  const apply = (request: ClinicalRelationshipRequest) =>
    applyClinicalRelationship(db, root, profileId, input(request));
  const display = (
    left = a.record,
    right = b.record,
    mode: 'prefer_left' | 'prefer_right' | 'show_both' | 'undecided' | 'withdraw' = 'prefer_right',
  ): ClinicalRelationshipRequest => ({
    action: 'display_preference',
    left,
    right,
    mode,
    attestation: 'same_recorded_event',
    reason: 'The reviewed fictional originals explicitly identify the same draw 61.',
  });
  const amend = (left = a, right = b): ClinicalRelationshipRequest => ({
    action: 'provider_amendment',
    mode: 'confirm',
    left: left.record,
    right: right.record,
    direction: 'left_to_right',
    attestation: 'reviewed_provider_amendment',
    reason: 'Reviewed fictional provider notice states that assertion b replaces a.',
    evidence: {
      sourceFileId: right.source.id,
      locator: 'Fictional amendment notice, section 2',
      quote: 'Corrected assertion for fictional draw 61.',
    },
  });
  const projection = (record = a.record) => clinicalRelationshipProjection(db, profileId, record);
  const correct = (record: ClinicalRelationshipRecord, valueText: string) => {
    const request = {
      ...record,
      set: { valueText },
      reason: 'The original supports this fictional app transcription correction.',
    };
    const current = previewDirectRecordCorrection(db, root, profileId, request);
    return applyDirectRecordCorrection(db, root, profileId, {
      ...request,
      operationId: randomUUID(),
      version: current.version,
      previewToken: current.previewToken,
    });
  };
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable(name, bytes) {
      assert.equal(objects.has(name), false, 'accepted immutable object was overwritten');
      objects.set(name, Buffer.from(bytes));
    },
    publishHead(bytes) {
      objects.set('head', Buffer.from(bytes));
    },
  };
  const rebuild = () => {
    const path = join(root, randomUUID() + '.sqlite');
    rebuildRecordDatabase(path, { profileId, storage });
    const recovered = openDatabase(path, profileId);
    opened.push(recovered);
    attachRecordDurability(recovered, { profileId, storage });
    return recovered;
  };
  return {
    db,
    root,
    profileId,
    a,
    b,
    c,
    add,
    preview,
    input,
    apply,
    display,
    amend,
    projection,
    correct,
    storage,
    objects,
    rebuild,
  };
}

test('provider amendment is directed evidence history and never implicitly prefers, averages or rewrites either assertion', (t) => {
  const f = fixture(t),
    before = f.db.prepare('SELECT * FROM observations ORDER BY id').all();
  const original = intake.getIntakeOriginal(f.db, f.root, f.profileId, f.b.source.id).bytes;
  const preview = f.preview(f.amend());
  assert.deepEqual(preview.effect.supersedes, {
    fromRecordId: f.a.record.recordId,
    toRecordId: f.b.record.recordId,
  });
  assert.equal(preview.effect.oneReviewedEvent, false);
  const result = f.apply(f.amend());
  assert.equal(result.receipt.action, 'provider_amendment');
  assert.ok(
    result.projections.every(
      (row) => row.display.visibleByDefault && !row.display.oneReviewedEvent,
    ),
  );
  assert.deepEqual(f.db.prepare('SELECT * FROM observations ORDER BY id').all(), before);
  assert.deepEqual(
    intake.getIntakeOriginal(f.db, f.root, f.profileId, f.b.source.id).bytes,
    original,
  );
  const wrongEvidence = f.amend();
  if (wrongEvidence.action === 'provider_amendment')
    wrongEvidence.evidence!.sourceFileId = f.c.source.id;
  assert.throws(() => f.preview(wrongEvidence), { code: 'AMENDMENT_EVIDENCE' });
  assert.throws(() => f.preview({ ...f.amend(), attestation: undefined }), {
    code: 'AMENDMENT_EVIDENCE',
  });
});

test('explicit same-event preference groups only its pair; show both and immutable withdrawal preserve literal visibility', (t) => {
  const f = fixture(t);
  assert.throws(() => f.preview({ ...f.display(), attestation: undefined }), {
    code: 'DISPLAY_ATTESTATION',
  });
  const first = f.apply(f.display());
  assert.equal(f.projection().display.visibleByDefault, false);
  assert.equal(f.projection(f.b.record).display.visibleByDefault, true);
  assert.equal(f.projection().display.countGroupId, f.projection(f.b.record).display.countGroupId);
  assert.notEqual(
    f.projection(f.c.record).display.countGroupId,
    f.projection().display.countGroupId,
  );
  assert.equal(f.projection(f.c.record).display.visibleByDefault, true);
  const show = f.apply(f.display(f.a.record, f.b.record, 'show_both'));
  assert.equal(show.receipt.scope.previousDecisionId, first.receipt.decisionId);
  assert.ok(
    show.projections.every((row) => row.display.visibleByDefault && row.display.oneReviewedEvent),
  );
  f.apply(f.display(f.a.record, f.b.record, 'withdraw'));
  assert.ok(
    [f.a, f.b].every(
      (item) =>
        f.projection(item.record).display.visibleByDefault &&
        !f.projection(item.record).display.oneReviewedEvent,
    ),
  );
  const history = clinicalRelationshipHistory(f.db, f.profileId, f.a.record, { limit: 2 });
  assert.equal(history.entries.length, 2);
  assert.equal(history.entries[0]!.status, 'withdrawn');
  assert.equal(history.entries[1]!.currentDecision, false);
  const older = clinicalRelationshipHistory(f.db, f.profileId, f.a.record, {
    beforeSequence: history.nextBeforeSequence!,
    limit: 2,
  });
  assert.equal(older.entries[0]!.decisionId, first.receipt.decisionId);
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM manual_batches WHERE title='Clinical relationship review'")
      .get()!.n,
    3,
  );
});

test('overlapping preference and directed amendment cycles require explicit resolution rather than transitive equivalence', (t) => {
  const f = fixture(t);
  f.apply(f.display());
  assert.throws(() => f.preview(f.display(f.b.record, f.c.record)), {
    code: 'DISPLAY_RELATIONSHIP_CONFLICT',
  });
  f.apply(f.display(f.a.record, f.b.record, 'withdraw'));
  f.apply(f.display(f.b.record, f.c.record));
  assert.notEqual(
    f.projection().display.countGroupId,
    f.projection(f.b.record).display.countGroupId,
  );
  f.apply(f.amend(f.a, f.b));
  f.apply(f.amend(f.b, f.c));
  assert.throws(() => f.preview(f.amend(f.c, f.a)), { code: 'AMENDMENT_CYCLE' });
  assert.throws(() => f.preview(f.amend(f.b, f.a)), { code: 'AMENDMENT_DIRECTION_CONFLICT' });
  const reversed = f.amend(f.a, f.b);
  reversed.mode = 'withdraw';
  f.apply(reversed);
  f.apply(f.amend(f.b, f.a));
  assert.equal(
    f.projection().relationships.filter((row) => row.request.action === 'provider_amendment')[0]!
      .request.left.recordId,
    f.b.record.recordId,
  );
});

test('app correction invalidates exact reviewed scope even if literal later returns, and never becomes a provider amendment', (t) => {
  const f = fixture(t);
  f.apply(f.display());
  const pinned = f.input(f.display(f.a.record, f.b.record, 'show_both'));
  f.correct(f.a.record, '< 0.050');
  assert.equal(f.projection().relationships[0]!.reviewed.left.mapping.valueText, '< 0.040');
  assert.equal(
    f.projection().relationships[0]!.reviewed.left.evidence[0]!.sourceFileId,
    f.a.source.id,
  );
  f.correct(f.a.record, '< 0.040');
  assert.throws(() => applyClinicalRelationship(f.db, f.root, f.profileId, pinned), {
    code: 'RELATIONSHIP_REVIEW_CHANGED',
  });
  assert.ok(
    [f.a, f.b].every(
      (item) =>
        f.projection(item.record).display.visibleByDefault &&
        f.projection(item.record).display.requiresReview,
    ),
  );
  assert.equal(f.projection().relationships[0]!.status, 'stale');
  assert.ok(
    f.projection().relationships.every((row) => row.request.action !== 'provider_amendment'),
  );
  f.apply(f.display());
  assert.equal(f.projection().relationships[0]!.status, 'current');
});

test('new accepted source version and old changed-version journals cannot inherit preference or provider amendment authority', (t) => {
  // Preserve the version/preference oracle with evidenced same-subject scope.
  const f = fixture(t, true);
  f.apply(f.display());
  transaction(f.db, () =>
    saveDuplicateDecision(
      f.db,
      duplicateRecord(f.db, 'observation', f.a.record.recordId),
      duplicateRecord(f.db, 'observation', f.b.record.recordId),
      {
        outcome: 'changed_version',
        reason: 'Historical fictional pair review does not assert provider amendment.',
      },
      randomUUID(),
    ),
  );
  const later = f.add('b', '9.000');
  assert.notEqual(later.record.recordId, f.b.record.recordId);
  assert.equal(f.projection(later.record).display.visibleByDefault, true);
  assert.equal(f.projection(later.record).display.oneReviewedEvent, false);
  assert.equal(f.projection(later.record).relationships.length, 0);
  assert.ok(f.projection().legacyPairs.some((row) => row.outcome === 'changed_version'));
  assert.ok(
    f.projection().relationships.every((row) => row.request.action !== 'provider_amendment'),
  );
});

test('uncertainty on a connected reviewed side restores both pair literals without choosing a substitute', (t) => {
  const f = fixture(t);
  f.apply(f.display());
  f.apply(f.display(f.b.record, f.c.record, 'undecided'));
  for (const item of [f.a, f.b, f.c]) {
    assert.equal(f.projection(item.record).display.visibleByDefault, true);
    assert.equal(f.projection(item.record).display.requiresReview, true);
    assert.equal(f.projection(item.record).display.oneReviewedEvent, false);
  }
});

test('profile, person, preview version and retained-original tampering reject a new relationship', (t) => {
  const f = fixture(t),
    input = f.input(f.display());
  assert.throws(() => previewClinicalRelationship(f.db, f.root, 'strawberry', f.display()), {
    code: 'PROFILE_BOUNDARY',
  });
  assert.throws(
    () =>
      applyClinicalRelationship(f.db, f.root, f.profileId, {
        ...input,
        scope: { ...input.scope, profileId: 'strawberry' },
      }),
    { code: 'RELATIONSHIP_REVIEW_CHANGED' },
  );
  const row = f.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.b.source.id)!;
  const path = profileOriginal(f.root, String(row.path), f.profileId),
    bytes = readFileSync(path);
  writeFileSync(path, Buffer.alloc(bytes.length, 65));
  assert.throws(() => applyClinicalRelationship(f.db, f.root, f.profileId, input));
  writeFileSync(path, bytes);
  transaction(f.db, () => {
    f.db
      .prepare('INSERT INTO people(id,display_name) VALUES(?,?)')
      .run('fictional-other', 'Invented second person');
    f.db
      .prepare('UPDATE observations SET person_id=? WHERE id=?')
      .run('fictional-other', f.b.record.recordId);
  });
  assert.throws(() => f.preview(f.display()), { code: 'RELATIONSHIP_PERSON' });
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM manual_batches WHERE title='Clinical relationship review'")
      .get()!.n,
    0,
  );
});

test('stable operation receipt is immutable across later reversal, rejects changed content and survives cache rebuild with every original', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId: f.profileId, storage: f.storage });
  const originals = [f.a, f.b, f.c].map(
    (item) => intake.getIntakeOriginal(f.db, f.root, f.profileId, item.source.id).bytes,
  );
  const input = f.input(f.display()),
    saved = applyClinicalRelationship(f.db, f.root, f.profileId, input);
  const retained = new Map(
    [...f.objects]
      .filter(([name]) => name !== 'head')
      .map(([name, bytes]) => [name, Buffer.from(bytes)]),
  );
  f.apply(f.amend());
  f.apply(f.display(f.a.record, f.b.record, 'withdraw'));
  for (const [name, bytes] of retained) assert.deepEqual(f.objects.get(name), bytes);
  const replay = applyClinicalRelationship(f.db, f.root, f.profileId, input);
  assert.deepEqual(replay.receipt, saved.receipt);
  assert.equal(replay.replayed, true);
  assert.ok(replay.projections.every((row) => row.display.visibleByDefault));
  assert.throws(
    () =>
      applyClinicalRelationship(f.db, f.root, f.profileId, {
        ...input,
        request: { ...input.request, reason: 'Changed review content.' },
      }),
    { code: 'OPERATION_CONFLICT' },
  );
  const recovered = f.rebuild();
  assert.deepEqual(
    getClinicalRelationshipReceipt(recovered, f.profileId, input.operationId).receipt,
    saved.receipt,
  );
  assert.equal(clinicalRelationshipHistory(recovered, f.profileId, f.a.record).entries.length, 3);
  assert.equal(
    clinicalRelationshipHistory(recovered, f.profileId, f.a.record).entries.at(-1)!.reviewed.right
      .mapping.valueText,
    '+004.500',
  );
  for (const [i, item] of [f.a, f.b, f.c].entries())
    assert.deepEqual(
      intake.getIntakeOriginal(recovered, f.root, f.profileId, item.source.id).bytes,
      originals[i],
    );
});

for (const boundary of ['before_head', 'after_head'] as const)
  test(`relationship ${boundary} failure has truthful receipts after accepted-history recovery`, (t) => {
    const f = fixture(t);
    attachRecordDurability(f.db, { profileId: f.profileId, storage: f.storage });
    const input = f.input(f.display()),
      publish = f.storage.publishHead;
    f.storage.publishHead = (bytes) => {
      if (boundary === 'after_head') publish(bytes);
      throw new Error('fictional relationship publication failure');
    };
    assert.throws(
      () => applyClinicalRelationship(f.db, f.root, f.profileId, input),
      /fictional relationship publication failure/,
    );
    assert.equal(
      f.db
        .prepare("SELECT count(*) n FROM manual_batches WHERE title='Clinical relationship review'")
        .get()!.n,
      0,
    );
    f.storage.publishHead = publish;
    const recovered = f.rebuild();
    if (boundary === 'before_head')
      assert.throws(
        () => getClinicalRelationshipReceipt(recovered, f.profileId, input.operationId),
        { code: 'RELATIONSHIP_NOT_FOUND' },
      );
    const result = applyClinicalRelationship(recovered, f.root, f.profileId, input);
    assert.equal(result.replayed, boundary === 'after_head');
    assert.equal(result.durability.pending, false);
    assert.equal(clinicalRelationshipHistory(recovered, f.profileId, f.a.record).entries.length, 1);
  });
