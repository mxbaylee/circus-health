import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { HttpError, openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  uploadIntake,
  reviewIntake,
  importIntake,
  saveIntakeReviewDraft,
  getIntake,
  proposeConversion,
} from '../intake.ts';
import { createNote, getNote, saveNote } from '../notes.ts';
import { rebuildProfile } from '../portable.ts';
import { randomUUID } from 'node:crypto';
import {
  acceptIntakeReportSelection,
  getIntakeReportAcceptance,
} from '../intake-report-acceptance.ts';
import { getIntakeIdentityReview, confirmIntakeIdentityScope } from '../intake-identity.ts';
import { clinicalSourceScopeCheck } from '../clinical-source-scope.ts';
import { validateJSONL } from '../intake-format.ts';
import { retainIntakeChildren } from '../intake.ts';
import { clinicalSourceVersion, mappingFrom } from '../clinical-import.ts';
import { clinicalSourceIdentityV1 } from '../intake-source-identity.ts';
import { duplicateRecord, intakePairScope } from '../duplicate-review.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'fictional-clinical-scope-'));
  const profile = 'orchid';
  const db = openDatabase(ensureProfileDirectories(root, profile).database, profile);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profile, db };
}
function envelope(subject = 'Fictional Avery Orchid', member = '', value = '12', page = 1) {
  return {
    format: 'health-record-v1',
    id: 'result-a',
    kind: 'record',
    payload: `Fictional laboratory report. Patient: ${subject}. Recorded reach: ${value}.`,
    report: {
      key: 'fictional-report',
      title: 'Fictional laboratory report',
      anchor: { locator: `page ${page}`, text: 'Fictional laboratory report' },
      subject: { locator: `page ${page}`, text: subject },
      ...(member ? { memberId: member } : {}),
    },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: 'Recorded reach',
      date: '2026-09-01',
      valueText: value,
      unit: 'fictional units',
    },
    provenance: {
      capturedVia: 'Fictional export',
      sourceSystem: 'Fictional shared issuer',
      sourceRecordId: 'issuer-result-1',
      evidenceClass: 'provider_export',
      locator: `page ${page} result`,
    },
    coverage: { status: 'complete_response', notes: [] },
  };
}
type Fixture = ReturnType<typeof fixture>;
function upload(f: Fixture, rows: unknown[], name = 'fictional.jsonl') {
  return uploadIntake(f.db, f.root, f.profile, {
    filename: name,
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n')),
  });
}
async function accept(f: Fixture, id: string, mapping: Record<string, string> = {}) {
  const review = await prepare(f, id);
  return importIntake(f.db, f.root, f.profile, id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: review.records.map((record) => ({ recordId: record.id, action: 'accept', mapping })),
  });
}
async function prepare(f: Fixture, id: string) {
  let review = reviewIntake(f.db, f.root, f.profile, id);
  for (const group of review.records.flatMap((record) => record.reportGroups || [])) {
    const state = await getIntakeIdentityReview(f.db, f.root, f.profile, id, group.groupId);
    if (state.blocking && state.scope) {
      await confirmIntakeIdentityScope(f.db, f.root, f.profile, id, {
        version: state.scope.intakeVersion,
        operationId: randomUUID(),
        scope: state.scope,
        outcome: 'this_is_me',
        attestation: state.scope.questions?.length
          ? 'confirmed_displayed_identity_questions'
          : 'confirmed_displayed_report_subject',
      });
      review = reviewIntake(f.db, f.root, f.profile, id);
    }
  }
  for (const record of review.records) {
    const issues =
      record.issues?.filter((issue) => issue.kind === 'identity' && issue.status !== 'resolved') ||
      [];
    if (!issues.length) continue;
    saveIntakeReviewDraft(f.db, f.root, f.profile, id, {
      version: review.version,
      operationId: randomUUID(),
      proposalId: null,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId!,
      resolutions: issues.map((issue) => ({ issueId: issue.id, outcome: 'this_is_me' })),
    });
    review = reviewIntake(f.db, f.root, f.profile, id);
  }
  return review;
}
function snapshot(f: Fixture) {
  return Object.fromEntries(
    [
      'observations',
      'medications',
      'procedures',
      'documents',
      'evidence',
      'record_relationships',
      'manual_batches',
      'source_records',
      'source_files',
      'providers',
    ].map((table) => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]),
  );
}
async function refuses(f: Fixture, id: string) {
  await prepare(f, id);
  const before = snapshot(f);
  const review = reviewIntake(f.db, f.root, f.profile, id);
  assert.ok(review.records.length, 'The conflicting incoming original remains reviewable');
  await assert.rejects(
    () => accept(f, id),
    (error: unknown) =>
      error instanceof HttpError && error.code === 'CLINICAL_SOURCE_SCOPE_COLLISION',
  );
  assert.deepEqual(
    snapshot(f),
    before,
    'Refusal must not mutate clinical history, evidence, exceptions, or retained rows',
  );
  assert.ok(reviewIntake(f.db, f.root, f.profile, id).records.length);
}

for (const [name, second] of [
  ['different printed subjects', envelope('Fictional Morgan Fern')],
  ['different package members', envelope('Fictional Avery Orchid', 'member-b')],
  [
    'changed assertions belonging to another subject',
    envelope('Fictional Morgan Fern', 'member-a', '19'),
  ],
] as const)
  test(`same issuer key refuses ${name}`, async (t) => {
    const f = fixture(t);
    await accept(f, upload(f, [envelope()]).id);
    await refuses(f, upload(f, [second], 'second.jsonl').id);
  });

test('same-request collision refuses all selected rows before any projection', async (t) => {
  const f = fixture(t);
  const item = upload(f, [envelope(), envelope('Fictional Morgan Fern')]);
  const review = reviewIntake(f.db, f.root, f.profile, item.id);
  const before = snapshot(f);
  // Do not manufacture two Self answers for competing patient claims just to
  // reach the source-collision check; acceptance must reject the request itself.
  assert.throws(
    () =>
      importIntake(f.db, f.root, f.profile, item.id, {
        version: review.version,
        reviewToken: review.reviewToken,
        decisions: review.records.map((record) => ({
          recordId: record.id,
          action: 'accept' as const,
          mapping: {},
        })),
      }),
    { code: 'CLINICAL_SOURCE_SCOPE_COLLISION' },
  );
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
});

test('evidenced same-subject/member copies and changed versions survive locator changes and rebuild', async (t) => {
  const f = fixture(t);
  await accept(f, upload(f, [envelope()]).id);
  await accept(f, upload(f, [envelope('Fictional Avery Orchid', '', '12', 2)], 'copy.jsonl').id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  await accept(
    f,
    upload(f, [envelope('Fictional Avery Orchid', '', '19', 3)], 'revision.jsonl').id,
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
  const rebuilt = rebuildProfile(f.root, f.profile, resolve(f.root, 'rebuilt'));
  const db = openDatabase(rebuilt.database, f.profile);
  try {
    const restored = { ...f, db, root: resolve(f.root, 'rebuilt') };
    await refuses(
      restored,
      upload(restored, [envelope('Fictional Morgan Fern')], 'post-rebuild.jsonl').id,
    );
  } finally {
    db.close();
  }
});

test('individual corrections never leak across a colliding subject', async (t) => {
  const f = fixture(t);
  await accept(f, upload(f, [envelope()]).id, { testLabel: 'Explicitly reviewed fictional label' });
  const second = upload(f, [envelope('Fictional Morgan Fern')], 'second.jsonl');
  const review = reviewIntake(f.db, f.root, f.profile, second.id);
  assert.equal(review.records[0]!.mapping.testLabel, 'Recorded reach');
  await refuses(f, second.id);
});

test('legacy missing report scope does not prove equality with a scoped delivery', async (t) => {
  const f = fixture(t);
  const { report: _report, ...legacy } = envelope();
  await accept(f, upload(f, [legacy]).id);
  await refuses(f, upload(f, [envelope()], 'scoped.jsonl').id);
});

test('byte-identical unscoped legacy originals can be redelivered, changed originals cannot', async (t) => {
  const f = fixture(t);
  const { report: _report, ...legacy } = envelope();
  await accept(f, upload(f, [legacy]).id);
  await accept(f, upload(f, [legacy], 'renamed.jsonl').id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  await refuses(
    f,
    upload(f, [{ ...legacy, clinical: { ...legacy.clinical, valueText: '19' } }], 'changed.jsonl')
      .id,
  );
});

test('a compound report acceptance rolls back earlier blocks and publishes no successful receipt', async (t) => {
  const f = fixture(t);
  const a = upload(f, [envelope()], 'a.jsonl');
  const b = upload(f, [envelope('Fictional Morgan Fern')], 'b.jsonl');
  await prepare(f, a.id);
  await prepare(f, b.id);
  const blocks = [a, b].map((item) => {
    const review = reviewIntake(f.db, f.root, f.profile, item.id);
    return {
      intakeId: item.id,
      proposalId: null,
      intakeVersion: review.version,
      reviewToken: review.reviewToken,
      selections: review.records.map((record) => ({
        recordId: record.id,
        candidateId: record.candidateId!,
        candidateVersionId: record.candidateVersionId!,
        mapping: {},
      })),
    };
  });
  const operationId = randomUUID();
  const before = snapshot(f);
  assert.throws(
    () => acceptIntakeReportSelection(f.db, f.root, f.profile, { operationId, blocks }),
    { code: 'CLINICAL_SOURCE_SCOPE_COLLISION' },
  );
  assert.deepEqual(snapshot(f), before);
  assert.throws(() => getIntakeReportAcceptance(f.db, f.root, f.profile, operationId), {
    code: 'REPORT_ACCEPTANCE_NOT_FOUND',
  });
});

for (const clinical of [
  {
    kind: 'medication',
    subject: 'self',
    medicationName: 'Fictional medicine',
    doseText: '5 fictional units',
    medicationKind: 'order',
    date: '2026-09-01',
  },
  {
    kind: 'procedure',
    subject: 'self',
    procedureLabel: 'Fictional scan',
    procedureCategory: 'imaging',
    date: '2026-09-01',
  },
  {
    kind: 'document',
    subject: 'self',
    documentTitle: 'Fictional summary',
    text: 'Fictional summary text',
    date: '2026-09-01',
  },
])
  test(`a prior ${clinical.kind} refuses cross-kind reuse from a different subject`, async (t) => {
    const f = fixture(t);
    await accept(f, upload(f, [{ ...envelope(), clinical }]).id);
    await refuses(f, upload(f, [envelope('Fictional Morgan Fern')], 'observation.jsonl').id);
  });

test('missing retained authority and orphan corrections fail closed without hiding the review', async (t) => {
  const f = fixture(t);
  await accept(f, upload(f, [envelope()]).id, { testLabel: 'Fictional reviewed label' });
  f.db.prepare("UPDATE source_records SET raw_json='{}'").run();
  await refuses(f, upload(f, [envelope()], 'copy.jsonl').id);
  f.db.prepare('DELETE FROM observations').run();
  await refuses(f, upload(f, [envelope()], 'orphan-copy.jsonl').id);
});

test('all attached source occurrences are checked, including an older contaminated merge', async (t) => {
  const f = fixture(t);
  await accept(f, upload(f, [envelope()]).id);
  const different = {
    ...envelope('Fictional Morgan Fern'),
    provenance: { ...envelope().provenance, sourceRecordId: 'separate-safe-id' },
  };
  await accept(f, upload(f, [different], 'separate.jsonl').id);
  const rows = f.db.prepare('SELECT id,source_record_id FROM observations ORDER BY id').all();
  f.db
    .prepare(
      "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role,locator_json) VALUES('fictional-legacy-contamination','observation',?,?,'source','{}')",
    )
    .run(String(rows[0]!.id), String(rows[1]!.source_record_id));
  const primary = JSON.parse(
    String(
      f.db
        .prepare('SELECT raw_json FROM source_records WHERE id=?')
        .get(String(rows[0]!.source_record_id))!.raw_json,
    ),
  );
  await refuses(f, upload(f, [primary], 'contaminated-copy.jsonl').id);
});

test('an indirect context claim cannot use the unscoped exact-envelope fallback', async (t) => {
  const f = fixture(t);
  const { report: _report, ...unscoped } = envelope();
  const linked = { ...unscoped, contextId: 'fictional-context' };
  const first = upload(f, [linked]);
  await accept(f, first.id);
  await refuses(f, upload(f, [linked], 'context-copy.jsonl').id);
});

test('an original JSONL report header supplies source scope without copying it into each clinical payload', async (t) => {
  const f = fixture(t);
  const value = { ...envelope(), payload: 'Fictional report with no patient evidence' };
  await accept(f, upload(f, [value]).id);
  const second = upload(
    f,
    [{ ...value, clinical: { ...value.clinical, valueText: '99' } }],
    'nonliteral.jsonl',
  );
  assert.equal(
    reviewIntake(f.db, f.root, f.profile, second.id).records[0]!.classification,
    'addition',
  );
  await accept(f, second.id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
});

test('the scope snapshot rejects a colliding context-only correction before it can promote context', async (t) => {
  const f = fixture(t);
  await accept(f, upload(f, [envelope()]).id, { testLabel: 'Fictional reviewed label' });
  const entry = validateJSONL(
    Buffer.from(
      JSON.stringify({
        ...envelope('Fictional Morgan Fern'),
        kind: 'context',
        clinical: undefined,
      }),
    ),
  ).entries![0]!;
  const check = clinicalSourceScopeCheck(f.db, { sha256: 'fictional-new-original' }, [entry]);
  assert.match(check(entry)!, /different or unverified report subject or member/);
});

test('context-only classification does not inherit a colliding correction that would promote it', async (t) => {
  const f = fixture(t);
  const value = {
    ...envelope(),
    kind: 'context',
    payload: 'Fictional shared context',
    clinical: undefined,
  };
  const first = upload(f, [value]);
  await accept(f, first.id);
  const entry = validateJSONL(Buffer.from(JSON.stringify(value))).entries![0]!;
  const file = f.db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(first.id) as {
    sha256: string;
  };
  f.db
    .prepare(
      "INSERT INTO manual_batches(id,title,status,created_at,coverage_json) VALUES('fictional-context-exception','Import record exception','verified','2026-09-23',?)",
    )
    .run(
      JSON.stringify({
        recordException: {
          identityKey: clinicalSourceIdentityV1(entry, file),
          sourceVersion: clinicalSourceVersion(mappingFrom(entry)),
          recordId: `${first.id}:line:1`,
          set: { ...envelope().clinical },
        },
      }),
    );
  const second = upload(
    f,
    [{ ...value, report: envelope('Fictional Morgan Fern').report }],
    'context-other.jsonl',
  );
  const review = reviewIntake(f.db, f.root, f.profile, second.id);
  assert.equal(
    review.records.length,
    0,
    'Unsafe exception must not promote context into a clinical record',
  );
  assert.equal(review.sourceContext?.length, 1, 'Original context remains accessible');
});

test('skip cannot publish a relationship for a colliding clinical key', async (t) => {
  const f = fixture(t);
  await accept(f, upload(f, [envelope()]).id);
  const second = upload(f, [envelope('Fictional Morgan Fern')], 'other-subject.jsonl');
  const review = await prepare(f, second.id);
  const record = review.records[0]!;
  const target = duplicateRecord(
    f.db,
    'observation',
    String(f.db.prepare('SELECT id FROM observations').get()!.id),
  );
  assert.ok(record.comparisonReference);
  const scope = intakePairScope(
    f.db,
    { ...record.comparisonReference, id: record.id, evidence: record.evidence },
    target,
  );
  const before = snapshot(f);
  assert.throws(
    () =>
      importIntake(f.db, f.root, f.profile, second.id, {
        version: review.version,
        reviewToken: review.reviewToken,
        decisions: [
          {
            recordId: record.id,
            action: 'skip',
            mapping: {},
            comparisons: [
              {
                otherRecordId: target.id,
                scope,
                outcome: 'same_event',
                reason: 'Fictional attempted attachment',
              },
            ],
          },
        ],
      }),
    { code: 'CLINICAL_SOURCE_SCOPE_COLLISION' },
  );
  assert.deepEqual(snapshot(f), before);
  importIntake(f.db, f.root, f.profile, second.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: record.id, action: 'skip', mapping: {} }],
  });
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
});

test('identical retained child bytes do not erase distinct host package occurrences', async (t) => {
  const f = fixture(t);
  const parent = upload(f, [{ fictional: 'archive inventory authority fixture' }], 'archive.txt');
  const { report: _report, ...value } = envelope();
  const bytes = Buffer.from(JSON.stringify(value));
  retainIntakeChildren(f.db, f.root, f.profile, parent.id, [
    { filename: 'a.jsonl', locator: 'member:a', bytes },
    { filename: 'b.jsonl', locator: 'member:b', bytes },
  ]);
  const rows = f.db
    .prepare(
      "SELECT id FROM source_files WHERE json_extract(details_json,'$.intake.parentSourceFileId')=? ORDER BY id",
    )
    .all(parent.id);
  assert.equal(rows.length, 2);
  await accept(f, String(rows[0]!.id));
  const firstReview = reviewIntake(f.db, f.root, f.profile, String(rows[0]!.id));
  assert.equal(
    firstReview.records[0]!.classification,
    'duplicate',
    'The same retained child occurrence is a supported retry',
  );
  await refuses(f, String(rows[1]!.id));
});

test('exact unscoped retries preserve original JSON numeric spellings', async (t) => {
  const f = fixture(t);
  const { report: _report, ...value } = envelope();
  const bytes = Buffer.from(
    JSON.stringify({ ...value, payload: 'RAW_NUMERIC_PAYLOAD' }).replace(
      '"RAW_NUMERIC_PAYLOAD"',
      '{"decimal":1.00,"negativeZero":-0,"exponent":1e2,"large":900719925474099312345}',
    ),
  );
  const first = uploadIntake(f.db, f.root, f.profile, { filename: 'literal-numbers.jsonl', bytes });
  await accept(f, first.id);
  const second = uploadIntake(f.db, f.root, f.profile, {
    filename: 'same-literal-numbers.jsonl',
    bytes,
  });
  const review = reviewIntake(f.db, f.root, f.profile, second.id);
  assert.equal(review.records[0]!.classification, 'duplicate');
  await accept(f, second.id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM evidence WHERE entity_type<>'person'").get()!.n,
    2,
  );
  for (const row of f.db.prepare('SELECT raw_json FROM source_records').all())
    assert.match(
      String(row.raw_json),
      /"decimal":1\.00,"negativeZero":-0,"exponent":1e2,"large":900719925474099312345/,
    );
});

test('raw numeric token wrappers cannot supply literal report or patient text', (t) => {
  const f = fixture(t);
  const values = ['12', '19'].map((value) => {
    const row = envelope('1.00', '', value);
    row.report.anchor.text = '100';
    return JSON.stringify({ ...row, payload: 'RAW_NUMERIC_PAYLOAD' }).replace(
      '"RAW_NUMERIC_PAYLOAD"',
      '{"subject":1.00,"report":100}',
    );
  });
  const entries = validateJSONL(Buffer.from(values.join('\n'))).entries!;
  const check = clinicalSourceScopeCheck(f.db, { sha256: 'fictional-numeric-source' }, entries);
  assert.ok(
    entries.every((entry) => check(entry)),
    'Numeric wrappers are preserved tokens, never printed text grounding',
  );
});

for (const family of [false, true])
  test(`host-grounded ${family ? 'Person' : 'Self'} source authority survives a cold rebuild without another identity confirmation`, async (t) => {
    const f = fixture(t);
    const name = 'Fictional Avery Orchid';
    let personId = 'patient';
    if (family)
      personId = createNote(f.db, {
        kind: 'person',
        title: 'Fictional family display',
        person: { fullName: name },
      }).personId!;
    else {
      const self = getNote(f.db, 'person-note:self');
      saveNote(f.db, self.id, { version: self.version, person: { fullName: name } });
    }
    const value = {
      ...envelope(name),
      payload: 'Fictional measurement only; header retained elsewhere on original.',
    };
    const proposedOriginal = (target: Fixture, label: string, row: unknown) => {
      const item = uploadIntake(target.db, target.root, target.profile, {
        filename: label + '.txt',
        newProviderName: 'Fictional clinic',
        bytes: Buffer.from(
          'Fictional laboratory report\n' + name + '\nFictional original ' + label,
        ),
      });
      return proposeConversion(target.db, target.root, target.profile, item.id, {
        version: item.version,
        summary: 'Fictional bounded conversion',
        jsonlText: JSON.stringify(row),
      });
    };
    const first = proposedOriginal(f, 'first-original', value);
    const firstProposal = first.proposals[0]!.id;
    const firstIdentity = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profile,
      first.id,
      first.workflow!.reportGroups![0]!.id,
    );
    assert.equal(firstIdentity.status, 'evidenced_match');
    const firstReview = reviewIntake(f.db, f.root, f.profile, first.id, firstProposal);
    assert.ok(firstReview.records[0]!.identityAttribution?.originalSubjectFingerprint);
    assert.equal(
      firstReview.records[0]!.identityAttribution?.basis,
      family ? 'matched_saved_person' : 'matched_saved_self',
    );
    importIntake(f.db, f.root, f.profile, first.id, {
      version: firstReview.version,
      proposalId: firstProposal,
      reviewToken: firstReview.reviewToken,
      decisions: [{ recordId: firstReview.records[0]!.id, action: 'accept', mapping: {} }],
    });
    assert.equal(
      getIntake(f.db, f.root, f.profile, first.id).workflow!.identityConfirmations?.length || 0,
      0,
    );
    const destination = resolve(f.root, 'cold-auto-owner');
    const rebuilt = rebuildProfile(f.root, f.profile, destination);
    const db = openDatabase(rebuilt.database, f.profile);
    try {
      const restored = { ...f, db, root: destination };
      const laterValue = {
        ...value,
        clinical: { ...value.clinical, valueText: '99' },
        identityAttribution: {
          basis: 'matched_saved_self',
          originalSubjectFingerprint:
            firstReview.records[0]!.identityAttribution!.originalSubjectFingerprint,
        },
      };
      const second = proposedOriginal(restored, 'second-original', laterValue);
      const secondProposal = second.proposals[0]!.id;
      const row = () =>
        db.prepare('SELECT * FROM source_files WHERE id=?').get(second.id) as {
          id: string;
          sha256: string;
          mime_type: string;
          details_json: string;
        };
      const entry = validateJSONL(Buffer.from(JSON.stringify(laterValue))).entries![0]!;
      assert.ok(
        clinicalSourceScopeCheck(db, row(), [entry], secondProposal)(entry),
        'a model-supplied marker cannot substitute for the new original preview',
      );
      assert.equal(
        reviewIntake(db, destination, f.profile, second.id, secondProposal).records[0]!
          .identityAttribution,
        undefined,
      );
      const state = await getIntakeIdentityReview(
        db,
        destination,
        f.profile,
        second.id,
        second.workflow!.reportGroups![0]!.id,
      );
      assert.equal(state.status, 'evidenced_match');
      assert.equal(
        clinicalSourceScopeCheck(db, row(), [entry], secondProposal)(entry),
        null,
        'accepted historical proof and current original proof work after cache loss',
      );
      const prior = String(
        db.prepare('SELECT details_json FROM source_files WHERE id=?').get(first.id)!.details_json,
      );
      for (const marker of [undefined, 'different-original-fingerprint']) {
        const altered = JSON.parse(prior);
        for (const batch of [altered.intake.imported, ...(altered.intake.importHistory || [])])
          for (const record of batch?.clinical?.records || [])
            if (record.identityAttribution)
              record.identityAttribution.originalSubjectFingerprint = marker;
        db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
          JSON.stringify(altered),
          first.id,
        );
        assert.ok(
          clinicalSourceScopeCheck(db, row(), [entry], secondProposal)(entry),
          'legacy or different-original marker is not accepted authority',
        );
      }
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(prior, first.id);
      const ready = reviewIntake(db, destination, f.profile, second.id, secondProposal);
      importIntake(db, destination, f.profile, second.id, {
        version: ready.version,
        proposalId: secondProposal,
        reviewToken: ready.reviewToken,
        decisions: [{ recordId: ready.records[0]!.id, action: 'accept', mapping: {} }],
      });
      assert.deepEqual(
        db
          .prepare('SELECT DISTINCT person_id FROM observations')
          .all()
          .map((row) => row.person_id),
        [personId],
      );
      assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
      assert.equal(
        getIntake(db, destination, f.profile, second.id).workflow!.identityConfirmations?.length ||
          0,
        0,
      );
    } finally {
      db.close();
    }
  });
