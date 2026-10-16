import { fixtureTransaction } from './helpers/accepted-record-fixture.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { attachPersonalDurability } from '../portable.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getIntakeIdentityReview, confirmIntakeIdentityScope } from '../intake-identity.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { HttpError, openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import {
  uploadIntake,
  reviewIntake,
  importIntake,
  proposeConversion,
  saveIntakeReviewDraft,
} from '../intake.ts';
import { rebuildProfile } from '../portable.ts';
import { previewMappingChange } from '../clinical-import.ts';
import {
  applyMappingChange,
  applyClinicalDecision,
  mappingAssistantExtensions,
} from '../mapping-actions.ts';
import { previewRecordCorrection } from '../record-corrections.ts';
import { previewDuplicateDecision } from '../duplicate-review.ts';
import { getSourceRecord } from '../queries.ts';
import { getNote, saveNote } from '../notes.ts';
import type {
  Intake as IntakeDto,
  IntakeClinicalMapping,
  IntakeReviewDecision,
  IntakeReviewDraftUpdate,
  IntakeReviewRecord,
} from '../../shared/intake.ts';
const kinds = {
  observation: { testLabel: 'Fictional panel component', valueText: '< 1.20', unit: 'mg/L' },
  medication: {
    medicationName: 'Fictional medicine',
    medicationKind: 'order',
    doseText: '5 mg',
    status: 'active',
  },
  procedure: { procedureLabel: 'Fictional scan', procedureCategory: 'imaging' },
  document: { documentTitle: 'Fictional visit', text: 'Office visit with a fictional specialist' },
} as const;
type ClinicalKind = keyof typeof kinds;
function fixture(t: TestContext, scoped = false) {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-decisions-')),
    profileId = 'orchid',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId);
  attachPersonalDurability(db, { root, profileId: profileId });
  if (scoped) {
    const self = getNote(db, 'person-note:self');
    saveNote(db, self.id, {
      version: self.version,
      person: { ...self.person, fullName: 'Fictional Avery Orchid' },
    });
  }
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db, scoped };
}
type Fixture = Omit<ReturnType<typeof fixture>, 'scoped'> & { scoped?: boolean };
type Intake = ReturnType<typeof uploadIntake>;
type ReviewRecord = IntakeReviewRecord & {
  comparisons: NonNullable<IntakeReviewRecord['comparisons']>;
  questions: NonNullable<IntakeReviewRecord['questions']>;
};
type TestReview = Omit<ReturnType<typeof reviewIntake>, 'records'> & { records: ReviewRecord[] };
type TestImportedIntake = ReturnType<typeof importIntake> & {
  workflow: NonNullable<ReturnType<typeof importIntake>['workflow']>;
};
type ImportDecision = NonNullable<Parameters<typeof importIntake>[4]['decisions']>[number];
interface TestRow extends Record<string, unknown> {
  id: string;
  source_record_id: string;
  provider_id: string;
  assertion_json: string;
  details_json: string;
  extra_json: string;
  coverage_json: string;
  version: number;
}
interface TestCorrectionPreview {
  token: string;
  version: number;
  evidence: Array<{
    acquiringSource: string | null;
    original: { provenance: { sourceSystem: string | null } };
  }>;
  before: Record<string, unknown> & { kind: string };
  after: Record<string, unknown> & { kind: string };
  reclassification: boolean;
}
interface TestDecisionInput extends Record<string, unknown> {
  kind: string;
  recordId: unknown;
  previewToken: string;
  version: number;
  operationId: string;
}
interface TestDecisionResult extends Record<string, unknown> {
  kind: string;
  recordId: string;
}
interface TestProposal extends Record<string, unknown> {
  preview: Record<string, unknown> & {
    left: { evidence: unknown[] };
    right: { evidence: unknown[] };
    scope: string;
    count: number;
    matchingExistingCount: number;
    exceptionCount: number;
    examples: Array<{ id: string; after: { kind: string } }>;
  };
}
interface TestExtensions {
  call(
    name: string,
    input: Record<string, unknown>,
    context: { db: Fixture['db']; chat: { proposals: TestProposal[] } },
  ): Promise<TestProposal>;
  apply(
    proposal: TestProposal,
    context: Fixture,
  ): { applied: boolean; result: Record<string, unknown> & { changed: number } };
  reconcile(proposal: TestProposal, context: Fixture): unknown;
}
const typedReviewIntake = reviewIntake as unknown as (
  ...args: Parameters<typeof reviewIntake>
) => TestReview;
const typedImportIntake = importIntake as unknown as (
  ...args: Parameters<typeof importIntake>
) => TestImportedIntake;
const previewCorrection = previewRecordCorrection as unknown as (
  db: Fixture['db'],
  input: Parameters<typeof previewRecordCorrection>[1],
) => TestCorrectionPreview;
const applyDecision = applyClinicalDecision as unknown as (
  db: Fixture['db'],
  root: string,
  profileId: string,
  kind: 'clinical_correction' | 'duplicate_decision',
  input: TestDecisionInput,
) => TestDecisionResult;
const testRow = (value: unknown): TestRow => value as TestRow;
const testExtensions = (): TestExtensions =>
  mappingAssistantExtensions() as unknown as TestExtensions;
const isErrorCode = (error: unknown, code: string): boolean =>
  error instanceof HttpError && error.code === code;
function upload(
  f: Fixture,
  kind: ClinicalKind,
  id = 'one',
  changes: Record<string, unknown> = {},
  provider = 'Acquiring clinic',
  sourceSystem = 'Issuing hospital',
) {
  const envelope = {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: {
      verbatim: 'Fictional evidence ' + id,
      ...(f.scoped ? { patient: 'Fictional Avery Orchid' } : {}),
    },
    ...(f.scoped
      ? {
          report: {
            key: 'fictional-report-' + id,
            title: 'Fictional evidence ' + id,
            anchor: { locator: 'section ' + id, text: 'Fictional evidence ' + id },
            subject: { locator: 'section ' + id, text: 'Fictional Avery Orchid' },
          },
          reviewIssues: [
            {
              kind: 'identity',
              field: 'subject',
              prompt: 'Confirm the printed patient.',
              textAnchor: 'Fictional Avery Orchid',
              selfSuggestion: { fullName: 'Fictional Avery Orchid' },
            },
          ],
        }
      : {}),
    clinical: { kind, subject: 'self', date: '2025-01', ...kinds[kind], ...changes },
    provenance: {
      capturedVia: 'Export copy',
      sourceSystem,
      sourceRecordId: kind + id,
      evidenceClass: 'provider_export',
      locator: 'section ' + id,
    },
    coverage: { status: 'complete_response', notes: [] },
  };
  return uploadIntake(f.db, f.root, f.profileId, {
    filename: kind + id + '.jsonl',
    newProviderName: provider,
    bytes: Buffer.from(JSON.stringify(envelope)),
  });
}
function accept(
  f: Fixture,
  intake: Intake,
  amend: (record: ReviewRecord) => Partial<ImportDecision> = () => ({}),
) {
  const r = typedReviewIntake(f.db, f.root, f.profileId, intake.id);
  return typedImportIntake(f.db, f.root, f.profileId, intake.id, {
    version: r.version,
    reviewToken: r.reviewToken,
    decisions: r.records.map((record) => ({
      recordId: record.id,
      action: 'accept',
      mapping: {},
      ...amend(record),
    })),
  });
}
async function reviewScopedIdentity(f: Fixture, original: Intake) {
  // This clinical-version fixture explicitly reviews its retained fictional patient.
  const identityOriginal = original;
  for (const group of identityOriginal.workflow?.reportGroups || []) {
    const identity = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      identityOriginal.id,
      group.id,
    );
    assert.ok(identity.scope);
    assert.equal(identity.scope.subject.text, 'Fictional Avery Orchid');
    if (identity.blocking)
      await confirmIntakeIdentityScope(f.db, f.root, f.profileId, identityOriginal.id, {
        version: identity.scope.intakeVersion,
        operationId: randomUUID(),
        scope: identity.scope,
        outcome: 'this_is_me',
        attestation: 'confirmed_displayed_identity_questions',
      });
  }
}
function correction(
  f: Fixture,
  input: Parameters<typeof previewRecordCorrection>[1],
  operationId: string,
) {
  const p = previewCorrection(f.db, input);
  return applyDecision(f.db, f.root, f.profileId, 'clinical_correction', {
    ...input,
    previewToken: p.token,
    version: p.version,
    operationId,
  } as TestDecisionInput);
}
const correctionSets = {
  observation: {
    valueText: '> 2.00',
    testLabel: 'Reviewed individual component',
    observationCategory: 'Laboratory',
  },
  medication: {
    doseText: '10 mg',
    startDate: '2025-02',
    medicationName: 'Reviewed individual medicine',
  },
  procedure: {
    procedureCategory: 'pathology',
    procedureLabel: 'Reviewed individual procedure',
    eventKind: 'historical_mention',
  },
  document: {
    documentTitle: 'Reviewed individual visit',
    visitSpecialty: 'Dermatology',
    documentCategory: 'Visit',
    text: 'Corrected fictional transcription',
  },
} satisfies Record<ClinicalKind, Record<string, string>>;
for (const [kind, set] of Object.entries(correctionSets) as [
  ClinicalKind,
  Record<string, string>,
][]) {
  test(`${kind}: individual correction survives later rules, repeated delivery and rebuild`, (t) => {
    const f = fixture(t),
      intake = upload(f, kind);
    accept(f, intake);
    const table = {
        observation: 'observations',
        medication: 'medications',
        procedure: 'procedures',
        document: 'documents',
      }[kind],
      row = testRow(f.db.prepare(`SELECT * FROM ${table}`).get()!),
      raw = f.db
        .prepare('SELECT raw_json FROM source_records WHERE id=?')
        .get(row.source_record_id)!.raw_json;
    const p = previewCorrection(f.db, {
      kind,
      recordId: row.id,
      set,
      reason: 'Evidence review',
    });
    assert.equal(p.evidence[0].acquiringSource, 'Acquiring clinic');
    assert.equal(p.evidence[0].original.provenance.sourceSystem, 'Issuing hospital');
    const result = correction(
      f,
      { kind, recordId: row.id, set, reason: 'Evidence review' },
      'correct-' + kind,
    );
    assert.equal(result.recordId, row.id);
    assert.equal(
      f.db.prepare('SELECT raw_json FROM source_records WHERE id=?').get(row.source_record_id)!
        .raw_json,
      raw,
    );
    const labelField: string = {
        observation: 'testLabel',
        medication: 'medicationName',
        procedure: 'procedureLabel',
        document: 'documentTitle',
      }[kind],
      rule: Parameters<typeof previewMappingChange>[2] = {
        match: {
          kind,
          label: (kinds[kind] as unknown as Record<string, string>)[labelField]!,
        },
        set: { [labelField]: 'General replacement' },
      };
    const preview = previewMappingChange(f.db, intake.providerId, rule);
    assert.equal(preview.count, 0);
    applyMappingChange(f.db, f.root, f.profileId, {
      providerId: intake.providerId,
      rule,
      version: preview.version,
      previewToken: preview.token,
      operationId: 'general-' + kind,
    });
    const copy = upload(f, kind, 'one', {}, 'Other acquiring clinic'),
      review = typedReviewIntake(f.db, f.root, f.profileId, copy.id);
    assert.equal(review.records[0].classification, 'duplicate');
    for (const [key, value] of Object.entries(set))
      assert.equal(review.records[0].mapping[key as keyof IntakeClinicalMapping], value);
    accept(f, copy);
    assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 1);
    if (kind === 'medication')
      assert.equal(
        f.db.prepare('SELECT status FROM medication_preferences').get()!.status,
        'not_current',
      );
    const after = f.db.prepare(`SELECT * FROM ${table}`).all(),
      rebuilt = rebuildProfile(f.root, f.profileId, resolve(f.root, 'rebuilt')),
      db = openDatabase(rebuilt.database, f.profileId);
    attachPersonalDurability(db, { root: resolve(f.root, 'rebuilt'), profileId: f.profileId });
    try {
      assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), after);
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM evidence WHERE entity_type<>'person'").get()!.n,
        2,
      );
    } finally {
      db.close();
    }
  });
}
test('correction stale review, invalid fields, profile boundary, retries and A to B to A retain decisions', (t) => {
  const f = fixture(t);
  accept(f, upload(f, 'observation'));
  const row = f.db.prepare('SELECT * FROM observations').get()!,
    input = {
      kind: 'observation',
      recordId: row.id,
      set: { valueText: '2.00' },
      reason: 'Fictional correction',
    },
    p = previewCorrection(f.db, input),
    request = { ...input, previewToken: p.token, version: p.version, operationId: 'retry' };
  assert.throws(
    () => applyDecision(f.db, f.root, 'other', 'clinical_correction', request),
    (error) => isErrorCode(error, 'PROFILE_BOUNDARY'),
  );
  const first = applyDecision(f.db, f.root, f.profileId, 'clinical_correction', request);
  assert.deepEqual(applyDecision(f.db, f.root, f.profileId, 'clinical_correction', request), first);
  assert.throws(
    () =>
      applyDecision(f.db, f.root, f.profileId, 'clinical_correction', {
        ...request,
        operationId: 'stale',
      }),
    (error) => isErrorCode(error, 'CLINICAL_REVIEW_CHANGED'),
  );
  assert.throws(
    () =>
      applyDecision(f.db, f.root, f.profileId, 'clinical_correction', {
        ...request,
        set: { valueText: '3' },
      }),
    (error) => isErrorCode(error, 'OPERATION_CONFLICT'),
  );
  assert.throws(
    () => previewCorrection(f.db, { ...input, set: { sourceRecordId: 'forged' } }),
    (error) => isErrorCode(error, 'CORRECTION_FIELDS'),
  );
  assert.throws(
    () => previewCorrection(f.db, { ...input, set: { date: '2025-02-31' } }),
    (error) => isErrorCode(error, 'CORRECTION_MAPPING'),
  );
  correction(f, { ...input, set: { valueText: '< 1.20' } }, 'restore');
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM manual_batches WHERE title='Import record exception'")
      .get()!.n,
    2,
  );
  assert.equal(f.db.prepare('SELECT value_text FROM observations').get()!.value_text, '< 1.20');
});
test('assistant previews both originals, preserves conflicting assertions for all four duplicate outcomes and rebuilds', async (t) => {
  const f = fixture(t);
  accept(f, upload(f, 'observation', 'one'));
  accept(f, upload(f, 'observation', 'two', { valueText: '999.00' }, 'Copying clinic'));
  const rows = f.db.prepare('SELECT * FROM observations ORDER BY id').all(),
    extension = testExtensions(),
    chat: { proposals: TestProposal[] } = { proposals: [] };
  for (const outcome of ['same_event', 'changed_version', 'distinct', 'unresolved']) {
    const proposal = await extension.call(
      'health_duplicate_review',
      {
        kind: 'observation',
        recordId: rows[0].id,
        otherRecordId: rows[1].id,
        outcome,
        reason: 'Reviewed the two supplied fictional reports',
        propose: true,
      },
      { db: f.db, chat },
    );
    assert.equal(proposal.preview.left.evidence.length, 1);
    assert.equal(proposal.preview.right.evidence.length, 1);
    assert.equal(extension.apply(proposal, { ...f }).applied, true);
    assert.ok(extension.reconcile(proposal, { ...f }));
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM observations').get()!.n, 2);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM manual_batches WHERE title='Duplicate evidence decision'")
      .get()!.n,
    4,
  );
  const relationships = f.db.prepare('SELECT * FROM record_relationships').all();
  assert.equal(relationships[0].status, 'proposed');
  const rebuilt = rebuildProfile(f.root, f.profileId, resolve(f.root, 'rebuilt')),
    db = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(db, { root: resolve(f.root, 'rebuilt'), profileId: f.profileId });
  try {
    assert.deepEqual(db.prepare('SELECT * FROM record_relationships').all(), relationships);
    assert.deepEqual(db.prepare('SELECT * FROM observations ORDER BY id').all(), rows);
  } finally {
    db.close();
  }
});

test('intake paired evidence remains unresolved on its delivery, survives rebuild and resolves with retained decisions', (t) => {
  const f = fixture(t);
  accept(f, upload(f, 'procedure', 'one'));
  const intake = upload(f, 'procedure', 'two', {}, 'Another delivery source');
  const review = typedReviewIntake(f.db, f.root, f.profileId, intake.id),
    record = review.records[0],
    other = record.comparisons[0];
  assert.equal(record.classification, 'addition', 'same date and label do not merge events');
  assert.ok(Array.isArray(other.evidence));
  assert.equal(other.evidence[0].label, 'Acquiring clinic');
  const request: Parameters<typeof importIntake>[4] = {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [
      {
        recordId: record.id,
        action: 'skip',
        mapping: {},
        comparisons: [
          {
            otherRecordId: other.id,
            scope: other.scope,
            outcome: 'unresolved',
            reason: 'The copied report lacks an accession reference.',
          },
        ],
      },
    ],
  };
  const pending = typedImportIntake(f.db, f.root, f.profileId, intake.id, request);
  assert.equal(pending.needsReview, true);
  assert.equal(pending.unansweredCount, 1);
  assert.equal(pending.workflow.questions[0].otherRecordId, other.id);
  assert.equal(
    typedImportIntake(f.db, f.root, f.profileId, intake.id, request).version,
    pending.version,
    'retry retains one decision',
  );
  assert.throws(
    () => typedImportIntake(f.db, f.root, f.profileId, intake.id, { ...request, decisions: [] }),
    (error) => isErrorCode(error, 'OPERATION_CONFLICT'),
  );
  const rebuilt = rebuildProfile(f.root, f.profileId, resolve(f.root, 'rebuilt')),
    db = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(db, { root: resolve(f.root, 'rebuilt'), profileId: f.profileId });
  try {
    const again = typedReviewIntake(db, f.root, f.profileId, intake.id);
    assert.equal(again.records[0].comparisons[0].previousDecision!.outcome, 'unresolved');
    assert.equal(again.records[0].questions[0].status, 'unanswered');
  } finally {
    db.close();
  }
  const current = typedReviewIntake(f.db, f.root, f.profileId, intake.id);
  typedImportIntake(f.db, f.root, f.profileId, intake.id, {
    version: current.version,
    reviewToken: current.reviewToken,
    decisions: [
      {
        recordId: record.id,
        action: 'accept',
        mapping: {},
        comparisons: [
          {
            otherRecordId: other.id,
            scope: current.records[0].comparisons[0].scope,
            outcome: 'distinct',
            reason: 'Review establishes two separate procedure identifiers.',
          },
        ],
      },
    ],
  });
  const resolved = typedReviewIntake(f.db, f.root, f.profileId, intake.id);
  assert.equal(resolved.records[0].questions[0].status, 'resolved');
  assert.equal(resolved.records[0].comparisons[0].previousDecision!.outcome, 'distinct');
  accept(f, intake);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM procedures').get()!.n, 2);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM manual_batches WHERE title='Duplicate evidence decision'")
      .get()!.n,
    2,
  );
});

test('repeated locators require a reviewed pair, retain one clinical entity, rebuild, and revoke without rewriting it', (t) => {
  const f = fixture(t);
  let item: IntakeDto = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-repeated-locators.txt',
    newProviderName: 'Fictional acquiring source',
    bytes: Buffer.from(
      'Fictional retained original\nFirst occurrence: 4.20 fictional units\nSecond occurrence: 4.20 fictional units',
    ),
  });
  const envelope = (id: string, locator: string, contextId?: string) => ({
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: {
      literal: 'Fictional repeated result: 4.20 fictional units',
      additionalEvidenceLocators: ['not indexed row 1', 'not indexed row 2'],
    },
    ...(contextId ? { contextId } : {}),
    clinical: {
      kind: 'observation',
      subject: 'self',
      date: '2031-04-02',
      testLabel: 'Fictional repeated measurement',
      valueText: '4.20',
      unit: 'fictional units',
    },
    provenance: {
      capturedVia: 'Fictional transcription',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator,
    },
    coverage: { status: 'partial', notes: [] },
  });
  const context = {
    format: 'health-record-v1',
    id: 'fictional-repeat-context',
    kind: 'context',
    contextId: 'fictional-repeat-context',
    payload: {
      heading: 'Fictional shared context',
      additionalEvidenceLocators: ['not indexed context row 1', 'not indexed context row 2'],
    },
    provenance: {
      capturedVia: 'Fictional transcription',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: 'fictional shared heading',
    },
    coverage: { status: 'partial', notes: [] },
  };
  const proposal = (rows: unknown[], summary: string) => {
    item = proposeConversion(f.db, f.root, f.profileId, item.id, {
      version: item.version,
      jsonlText: rows.map((row) => JSON.stringify(row)).join('\n'),
      summary,
    });
    return item.proposals.at(-1)!.id;
  };
  const confirmedReview = (proposalId: string) => {
    let review = typedReviewIntake(f.db, f.root, f.profileId, item.id, proposalId);
    const record = review.records[0]!;
    const issue = record.issues?.find(
      (candidate) => candidate.kind === 'identity' && candidate.status === 'unresolved',
    );
    if (issue) {
      item = saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
        version: review.version,
        operationId: `fictional-confirm-${proposalId}`,
        proposalId,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId!,
        resolutions: [{ issueId: issue.id, outcome: 'this_is_me' }],
      });
      review = typedReviewIntake(f.db, f.root, f.profileId, item.id, proposalId);
    }
    return review;
  };

  const firstProposalId = proposal(
    [envelope('fictional-first-occurrence', 'fictional row 1')],
    'First fictional occurrence',
  );
  let review = confirmedReview(firstProposalId);
  item = typedImportIntake(f.db, f.root, f.profileId, item.id, {
    version: review.version,
    proposalId: firstProposalId,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  const accepted = testRow(f.db.prepare('SELECT * FROM observations').get()!);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM evidence WHERE entity_type<>'person'").get()!.n,
    1,
  );

  const repeatProposalId = proposal(
    [context, envelope('fictional-second-occurrence', 'fictional row 2', context.contextId)],
    'Second fictional occurrence with shared presentation context',
  );
  review = confirmedReview(repeatProposalId);
  const repeat = review.records[0]!;
  assert.equal(repeat.classification, 'addition', 'different locators must not imply exact reuse');
  const comparison = repeat.comparisons.find((candidate) => candidate.id === accepted.id);
  assert.ok(comparison?.scope, 'the repeated occurrence needs an exact saved-target scope');
  const sameEvent = {
    otherRecordId: comparison.id,
    scope: comparison.scope,
    outcome: 'same_event' as const,
    reason: 'The fictional originals were explicitly reviewed as two occurrences of one event.',
  };
  item = typedImportIntake(f.db, f.root, f.profileId, item.id, {
    version: review.version,
    proposalId: repeatProposalId,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: repeat.id, action: 'skip', mapping: {}, comparisons: [sameEvent] }],
  });
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM evidence WHERE entity_type<>'person'").get()!.n,
    1,
  );
  const sourceRecords = f.db
    .prepare("SELECT id,raw_json FROM source_records WHERE kind LIKE 'intake_%' ORDER BY id")
    .all() as Array<{ id: string; raw_json: string }>;
  assert.equal(sourceRecords.length, 3, 'both occurrences and presentation context stay retained');
  assert.equal(
    sourceRecords.filter((row) => JSON.parse(row.raw_json).payload.additionalEvidenceLocators)
      .length,
    3,
    'unindexed locator arrays remain lossless payload evidence',
  );
  const relationship = f.db
    .prepare("SELECT * FROM record_relationships WHERE relation='reviewed_pair'")
    .get()!;
  assert.equal(relationship.status, 'accepted');
  assert.equal(JSON.parse(String(relationship.rationale)).outcome, 'same_event');
  const repeatSourceId = repeat.id;
  assert.equal(getSourceRecord(f.db, repeatSourceId).relationships?.length, 1);
  assert.ok(
    [relationship.from_record_id, relationship.to_record_id].includes(accepted.source_record_id),
  );

  const rebuiltRoot = resolve(f.root, 'repeat-rebuilt');
  const rebuilt = rebuildProfile(f.root, f.profileId, rebuiltRoot);
  const rebuiltDb = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(rebuiltDb, { root: rebuiltRoot, profileId: f.profileId });
  try {
    assert.equal(rebuiltDb.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
    assert.equal(
      rebuiltDb.prepare("SELECT count(*) n FROM evidence WHERE entity_type<>'person'").get()!.n,
      1,
    );
    assert.deepEqual(
      rebuiltDb.prepare("SELECT * FROM record_relationships WHERE relation='reviewed_pair'").get(),
      relationship,
    );
    const rebuiltReview = typedReviewIntake(
      rebuiltDb,
      rebuiltRoot,
      f.profileId,
      item.id,
      repeatProposalId,
    );
    assert.equal(rebuiltReview.records[0]!.comparisons[0]!.previousDecision!.outcome, 'same_event');
    assert.equal(
      rebuiltReview.records[0]!.comparisons[0]!.previousDecision!.scopeStatus,
      'current',
    );
  } finally {
    rebuiltDb.close();
  }

  review = typedReviewIntake(f.db, f.root, f.profileId, item.id, repeatProposalId);
  const refreshed = review.records[0]!;
  const currentComparison = refreshed.comparisons.find(
    (candidate) => candidate.id === accepted.id,
  )!;
  item = typedImportIntake(f.db, f.root, f.profileId, item.id, {
    version: review.version,
    proposalId: repeatProposalId,
    reviewToken: review.reviewToken,
    decisions: [
      {
        recordId: refreshed.id,
        action: 'skip',
        mapping: {},
        comparisons: [
          {
            otherRecordId: currentComparison.id,
            scope: currentComparison.scope,
            outcome: 'distinct',
            reason: 'A later explicit fictional review establishes distinct events.',
          },
        ],
      },
    ],
  });
  const rejected = f.db
    .prepare("SELECT * FROM record_relationships WHERE relation='reviewed_pair'")
    .get()!;
  assert.equal(rejected.status, 'rejected');
  assert.equal(JSON.parse(String(rejected.rationale)).outcome, 'distinct');
  assert.deepEqual(f.db.prepare('SELECT * FROM observations').get(), accepted);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM evidence WHERE entity_type<>'person'").get()!.n,
    1,
  );

  review = typedReviewIntake(f.db, f.root, f.profileId, item.id, repeatProposalId);
  const terminal = review.records[0]!;
  item = saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
    version: review.version,
    operationId: 'fictional-keep-repeat-original',
    proposalId: repeatProposalId,
    recordId: terminal.id,
    candidateVersionId: terminal.candidateVersionId!,
    disposition: 'keep_original_only',
    decision: {
      recordId: terminal.id,
      action: 'skip',
      mapping: {},
      comparisons: [
        {
          otherRecordId: terminal.comparisons[0]!.id,
          scope: terminal.comparisons[0]!.scope,
          outcome: 'distinct',
          reason: 'A later explicit fictional review establishes distinct events.',
        },
      ],
    },
  });
  assert.equal(item.workflow!.decisions.at(-1)!.action, 'keep_original_only');
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM evidence WHERE entity_type<>'person'").get()!.n,
    1,
  );
});

test('terminal keep original retains an exact reviewed same-event occurrence through rebuild', (t) => {
  const f = fixture(t);
  let item: IntakeDto = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-terminal-repeat.txt',
    newProviderName: 'Fictional terminal source',
    bytes: Buffer.from(
      'Fictional retained terminal original\nOccurrence alpha: 8.40 invented units\nOccurrence beta: 8.40 invented units',
    ),
  });
  const envelope = (id: string, locator: string) => ({
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { literal: `Fictional retained ${id}` },
    clinical: {
      kind: 'observation',
      subject: 'self',
      date: '2032-05-03',
      testLabel: 'Fictional terminal repeated measurement',
      valueText: '8.40',
      unit: 'invented units',
    },
    provenance: {
      capturedVia: 'Fictional transcription',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator,
    },
    coverage: { status: 'partial', notes: [] },
  });
  const propose = (row: unknown, summary: string) => {
    item = proposeConversion(f.db, f.root, f.profileId, item.id, {
      version: item.version,
      jsonlText: JSON.stringify(row),
      summary,
    });
    return item.proposals.at(-1)!.id;
  };
  const confirmedReview = (proposalId: string) => {
    let review = typedReviewIntake(f.db, f.root, f.profileId, item.id, proposalId);
    const record = review.records[0]!;
    const issue = record.issues?.find(
      (candidate) => candidate.kind === 'identity' && candidate.status === 'unresolved',
    );
    if (issue) {
      item = saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
        version: review.version,
        operationId: `fictional-terminal-confirm-${proposalId}`,
        proposalId,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId!,
        resolutions: [{ issueId: issue.id, outcome: 'this_is_me' }],
      });
      review = typedReviewIntake(f.db, f.root, f.profileId, item.id, proposalId);
    }
    return review;
  };

  const acceptedProposalId = propose(
    envelope('fictional-terminal-alpha', 'fictional terminal row alpha'),
    'Fictional terminal first occurrence',
  );
  let review = confirmedReview(acceptedProposalId);
  item = typedImportIntake(f.db, f.root, f.profileId, item.id, {
    version: review.version,
    proposalId: acceptedProposalId,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  const acceptedObservation = f.db.prepare('SELECT * FROM observations').get()!;
  const acceptedEvidence = f.db.prepare('SELECT * FROM evidence ORDER BY id').all();

  const repeatProposalId = propose(
    envelope('fictional-terminal-beta', 'fictional terminal row beta'),
    'Fictional terminal repeated occurrence',
  );
  review = confirmedReview(repeatProposalId);
  const repeat = review.records[0]!;
  const comparison = repeat.comparisons.find(
    (candidate) => candidate.id === testRow(acceptedObservation).id,
  );
  assert.ok(comparison?.scope, 'terminal same-event review needs an exact saved-target scope');
  const pairDecision = {
    recordId: repeat.id,
    action: 'skip' as const,
    mapping: {},
    comparisons: [
      {
        otherRecordId: comparison.id,
        scope: comparison.scope,
        outcome: 'same_event' as const,
        reason: 'Explicit fictional review retains two source occurrences for one saved event.',
        occurrenceEvidence: 'attach' as const,
      },
    ],
  };
  assert.throws(
    () =>
      saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
        version: review.version,
        operationId: 'fictional-terminal-cannot-accept',
        proposalId: repeatProposalId,
        recordId: repeat.id,
        candidateVersionId: repeat.candidateVersionId!,
        disposition: 'keep_original_only',
        decision: { ...pairDecision, action: 'accept' },
      }),
    { code: 'IMPORT_REVIEW' },
  );
  assert.deepEqual(f.db.prepare('SELECT * FROM observations').get(), acceptedObservation);
  assert.equal(f.db.prepare('SELECT 1 FROM source_records WHERE id=?').get(repeat.id), undefined);
  assert.equal(f.db.prepare('SELECT count(*) n FROM record_relationships').get()!.n, 0);
  item = saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
    version: review.version,
    operationId: 'fictional-pending-same-event-draft',
    proposalId: repeatProposalId,
    recordId: repeat.id,
    candidateVersionId: repeat.candidateVersionId!,
    disposition: 'pending',
    decision: pairDecision,
  });
  assert.equal(f.db.prepare('SELECT 1 FROM source_records WHERE id=?').get(repeat.id), undefined);
  assert.equal(f.db.prepare('SELECT count(*) n FROM record_relationships').get()!.n, 0);
  review = typedReviewIntake(f.db, f.root, f.profileId, item.id, repeatProposalId);
  item = saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
    version: review.version,
    operationId: 'fictional-review-later-same-event-draft',
    proposalId: repeatProposalId,
    recordId: repeat.id,
    candidateVersionId: repeat.candidateVersionId!,
    disposition: 'review_later',
    decision: pairDecision,
  });
  assert.equal(f.db.prepare('SELECT 1 FROM source_records WHERE id=?').get(repeat.id), undefined);
  assert.equal(f.db.prepare('SELECT count(*) n FROM record_relationships').get()!.n, 0);
  review = typedReviewIntake(f.db, f.root, f.profileId, item.id, repeatProposalId);
  const currentComparison = review.records[0]!.comparisons.find(
    (candidate) => candidate.id === testRow(acceptedObservation).id,
  )!;
  const terminalDecision: IntakeReviewDecision = {
    ...pairDecision,
    comparisons: [{ ...pairDecision.comparisons[0], scope: currentComparison.scope }],
  };
  const terminalInput: IntakeReviewDraftUpdate = {
    version: review.version,
    operationId: 'fictional-terminal-keep-same-event',
    proposalId: repeatProposalId,
    recordId: repeat.id,
    candidateVersionId: repeat.candidateVersionId!,
    disposition: 'keep_original_only',
    decision: terminalDecision,
  };
  assert.throws(
    () =>
      saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
        ...terminalInput,
        version: terminalInput.version - 1,
        operationId: 'fictional-terminal-stale',
      }),
    { code: 'VERSION_CONFLICT' },
  );
  const missingTarget = {
    ...terminalInput,
    operationId: 'fictional-terminal-missing-target',
    decision: {
      ...terminalDecision,
      comparisons: [
        {
          ...terminalDecision.comparisons![0],
          otherRecordId: 'fictional-missing-target',
          scope: {
            ...terminalDecision.comparisons![0]!.scope!,
            saved: {
              ...terminalDecision.comparisons![0]!.scope!.saved,
              recordId: 'fictional-missing-target',
            },
          },
        },
      ],
    },
  };
  assert.throws(() => saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, missingTarget), {
    code: 'RECORD_NOT_FOUND',
  });
  const targetFile = f.db
    .prepare(
      'SELECT f.path FROM observations o JOIN source_records r ON r.id=o.source_record_id JOIN source_files f ON f.id=r.source_file_id WHERE o.id=?',
    )
    .get(testRow(acceptedObservation).id) as { path: string };
  const targetPath = profileOriginal(f.root, targetFile.path, f.profileId);
  const targetBytes = readFileSync(targetPath);
  writeFileSync(targetPath, Buffer.from('fictional corrupted target'));
  try {
    assert.throws(
      () =>
        saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
          ...terminalInput,
          operationId: 'fictional-terminal-corrupt-target',
        }),
      { code: 'SOURCE_CHANGED' },
    );
  } finally {
    writeFileSync(targetPath, targetBytes);
  }
  const incomingFile = f.db
    .prepare('SELECT path FROM source_files WHERE id=?')
    .get(repeatProposalId) as { path: string };
  const incomingPath = profileOriginal(f.root, incomingFile.path, f.profileId);
  const incomingBytes = readFileSync(incomingPath);
  writeFileSync(incomingPath, Buffer.from('fictional corrupted incoming proposal'));
  try {
    assert.throws(
      () =>
        saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
          ...terminalInput,
          operationId: 'fictional-terminal-corrupt-incoming',
        }),
      { code: 'SOURCE_CHANGED' },
    );
  } finally {
    writeFileSync(incomingPath, incomingBytes);
  }
  assert.equal(f.db.prepare('SELECT 1 FROM source_records WHERE id=?').get(repeat.id), undefined);
  assert.equal(
    f.db.prepare("SELECT 1 FROM record_relationships WHERE relation='reviewed_pair'").get(),
    undefined,
  );
  assert.equal(
    typedReviewIntake(f.db, f.root, f.profileId, item.id, repeatProposalId).records[0]!.reviewState,
    'pending',
  );

  item = saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, terminalInput);
  assert.equal(item.workflow!.decisions.at(-1)!.action, 'keep_original_only');
  const attachedEvidence = f.db.prepare('SELECT * FROM evidence ORDER BY id').all();
  assert.equal(attachedEvidence.length, acceptedEvidence.length + 1);
  assert.equal(attachedEvidence.filter((row) => row.role === 'same_event_occurrence').length, 1);
  const sourceRecords = f.db.prepare('SELECT * FROM source_records ORDER BY id').all();
  const relationship = f.db
    .prepare("SELECT * FROM record_relationships WHERE relation='reviewed_pair'")
    .get()!;
  assert.equal(relationship.status, 'accepted');
  assert.equal(JSON.parse(String(relationship.rationale)).outcome, 'same_event');
  review = typedReviewIntake(f.db, f.root, f.profileId, item.id, repeatProposalId);
  const retainedDecision = review.records[0]!.comparisons.find(
    (candidate) => candidate.id === comparison.id,
  )!.previousDecision!;
  assert.equal(retainedDecision.outcome, 'same_event');
  assert.equal(retainedDecision.scopeStatus, 'current');
  const replay = saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, terminalInput);
  assert.equal(replay.version, item.version);
  assert.deepEqual(f.db.prepare('SELECT * FROM observations').get(), acceptedObservation);
  assert.deepEqual(f.db.prepare('SELECT * FROM evidence ORDER BY id').all(), attachedEvidence);
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM record_relationships WHERE relation='reviewed_pair'")
      .get()!.n,
    1,
  );

  const rebuiltRoot = resolve(f.root, 'terminal-repeat-rebuilt');
  const rebuilt = rebuildProfile(f.root, f.profileId, rebuiltRoot);
  const rebuiltDb = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(rebuiltDb, { root: rebuiltRoot, profileId: f.profileId });
  try {
    assert.deepEqual(rebuiltDb.prepare('SELECT * FROM observations').get(), acceptedObservation);
    assert.deepEqual(
      rebuiltDb.prepare('SELECT * FROM evidence ORDER BY id').all(),
      attachedEvidence,
    );
    assert.deepEqual(
      rebuiltDb.prepare('SELECT * FROM source_records ORDER BY id').all(),
      sourceRecords,
      'raw envelopes and exact locator JSON must rebuild without normalization',
    );
    assert.deepEqual(
      rebuiltDb.prepare("SELECT * FROM record_relationships WHERE relation='reviewed_pair'").get(),
      relationship,
    );
    const rebuiltReview = typedReviewIntake(
      rebuiltDb,
      rebuiltRoot,
      f.profileId,
      item.id,
      repeatProposalId,
    );
    assert.equal(rebuiltReview.records[0]!.draft?.disposition, 'keep_original_only');
    const rebuiltDecision = rebuiltReview.records[0]!.comparisons.find(
      (candidate) => candidate.id === comparison.id,
    )!.previousDecision!;
    assert.equal(rebuiltDecision.outcome, 'same_event');
    assert.equal(rebuiltDecision.scopeStatus, 'current');
  } finally {
    rebuiltDb.close();
  }
});

test('terminal keep without a pair remains retained evidence without a relationship', (t) => {
  const f = fixture(t);
  const item = upload(f, 'observation', 'terminal-no-pair');
  const review = typedReviewIntake(f.db, f.root, f.profileId, item.id);
  const record = review.records[0]!;
  const kept = saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
    version: review.version,
    operationId: 'fictional-terminal-no-pair',
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    disposition: 'keep_original_only',
    decision: { recordId: record.id, action: 'skip', mapping: {} },
  });
  assert.equal(kept.workflow!.decisions.at(-1)!.action, 'keep_original_only');
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM record_relationships').get()!.n, 0);
});

test('actual encrypted profile stores correction and pair histories and rebuilds after complete cache loss', async (t) => {
  const { vaultFixture, newProfile } = await import('./helpers/vault-fixture.ts');
  const { queryRecordHistory } = await import('../record-versions.ts');
  const { manager, dataDirectory } = vaultFixture(t),
    { profile, recoveryKit } = await newProfile(manager, 'Fictional Reconciliation');
  let state = manager.opened.get(profile.id)!,
    f = { root: state.root, db: state.db, profileId: profile.id };
  accept(f, upload(f, 'observation', 'one'));
  accept(f, upload(f, 'observation', 'two', { valueText: '77.00' }));
  const rows = f.db.prepare('SELECT * FROM observations ORDER BY id').all();
  correction(
    f,
    {
      kind: 'observation',
      recordId: rows[0].id,
      set: { valueText: '88.00' },
      reason: 'Fictional retained evidence correction',
    },
    'encrypted-correction',
  );
  const pair: Parameters<typeof previewDuplicateDecision>[1] = {
      kind: 'observation',
      recordId: String(rows[0].id),
      otherRecordId: String(rows[1].id),
      outcome: 'unresolved',
      reason: 'Both originals are retained but identity is uncertain.',
    },
    preview = previewDuplicateDecision(f.db, pair);
  applyDecision(f.db, f.root, f.profileId, 'duplicate_decision', {
    ...pair,
    previewToken: preview.token,
    version: preview.version,
    operationId: 'encrypted-pair',
  });
  const before = f.db.prepare('SELECT * FROM observations ORDER BY id').all(),
    history = queryRecordHistory(f.db, {
      profileId: profile.id,
      entity: 'observations',
      recordId: rows[0].id,
      field: 'value_text',
    }).entries;
  assert.ok(history.length >= 2);
  assert.equal(history[0].contents.value_text, '88.00');
  manager.lock(profile.id);
  rmSync(resolve(dataDirectory, 'profiles', profile.id, 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, recoveryKit);
  state = manager.opened.get(profile.id)!;
  assert.equal(state.metrics.cacheHit, false);
  assert.deepEqual(state.db.prepare('SELECT * FROM observations ORDER BY id').all(), before);
  assert.deepEqual(
    queryRecordHistory(state.db, {
      profileId: profile.id,
      entity: 'observations',
      recordId: rows[0].id,
      field: 'value_text',
    }).entries,
    history,
  );
  assert.equal(
    state.db
      .prepare("SELECT COUNT(*) n FROM manual_batches WHERE title='Duplicate evidence decision'")
      .get()!.n,
    1,
  );
  const deliveries = state.db
    .prepare("SELECT id FROM source_files WHERE kind='intake_original'")
    .all();
  assert.ok(
    deliveries.every((row) =>
      JSON.parse(
        readIntakeEnvelopeText(state.db, { id: String(row.id) })!,
      ).intake.workflow.questions.some(
        (question: { field?: string; status?: string }) =>
          question.field === 'duplicate' && question.status === 'unanswered',
      ),
    ),
  );
});

test('accepted procedure becomes a lab with stable identity, original references and repeat-delivery exception', async (t) => {
  // This positive version/correction case provides actual fictional subject
  // scope; changed unscoped assertions are covered by collision-refusal tests.
  const f = fixture(t, true);
  const firstOriginal = upload(f, 'procedure', 'creatinine', {
    procedureLabel: 'Creatinine',
    valueText: '1.20',
    unit: 'mg/dL',
  });
  await reviewScopedIdentity(f, firstOriginal);
  accept(f, firstOriginal);
  const row = f.db.prepare('SELECT * FROM procedures').get()!,
    input = {
      kind: 'procedure',
      recordId: row.id,
      set: {
        kind: 'observation',
        testLabel: 'Creatinine',
        valueText: '1.20',
        unit: 'mg/dL',
        observationCategory: 'Laboratory',
      },
      reason: 'The retained report identifies a creatinine result.',
    };
  const source = f.db.prepare('SELECT * FROM source_records WHERE id=?').get(row.source_record_id)!;
  fixtureTransaction(f.db, () =>
    f.db
      .prepare(
        "INSERT INTO notes(id,kind,status,title,created_at,updated_at) VALUES('finished','historical','draft','Fictional history','2025-01','2025-01')",
      )
      .run(),
  );
  fixtureTransaction(f.db, () =>
    f.db
      .prepare(
        "INSERT INTO note_links(id,note_id,target_type,target_id) VALUES('retained-link','finished','procedure',?)",
      )
      .run(row.id),
  );
  fixtureTransaction(f.db, () =>
    f.db
      .prepare("UPDATE notes SET status='finished',finished_at='2025-01' WHERE id='finished'")
      .run(),
  );
  fixtureTransaction(f.db, () =>
    f.db
      .prepare(
        "INSERT INTO visibility_events VALUES('prior-visibility','procedure',?,1,1,'2025-01','Profile owner')",
      )
      .run(row.id),
  );
  const p = previewCorrection(f.db, input),
    request = { ...input, previewToken: p.token, version: p.version, operationId: 'kind-change' };
  assert.equal(p.before.kind, 'procedure');
  assert.equal(p.after.kind, 'observation');
  assert.equal(p.reclassification, true);
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM observations').get()!.n,
    0,
    'preview cannot apply',
  );
  const first = applyDecision(f.db, f.root, f.profileId, 'clinical_correction', request);
  assert.equal(first.kind, 'observation');
  assert.equal(first.recordId, row.id);
  assert.throws(
    () =>
      applyDecision(f.db, f.root, f.profileId, 'clinical_correction', {
        ...request,
        operationId: 'stale-reclassification',
      }),
    (error) => isErrorCode(error, 'CLINICAL_REVIEW_CHANGED'),
  );
  assert.deepEqual(applyDecision(f.db, f.root, f.profileId, 'clinical_correction', request), first);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM procedures').get()!.n, 0);
  assert.equal(
    f.db.prepare('SELECT value_text FROM observations WHERE id=?').get(row.id)!.value_text,
    '1.20',
  );
  assert.equal(
    f.db.prepare('SELECT target_type FROM note_links').get()!.target_type,
    'procedure',
    'finished link is unchanged',
  );
  assert.equal(
    f.db.prepare("SELECT archived FROM visibility_events WHERE target_type='observation'").get()!
      .archived,
    1,
  );
  assert.deepEqual(f.db.prepare('SELECT * FROM source_records WHERE id=?').get(source.id)!, source);
  const repeated = upload(
    f,
    'procedure',
    'creatinine',
    { procedureLabel: 'Creatinine', valueText: '1.20', unit: 'mg/dL' },
    'Copying clinic',
  );
  await reviewScopedIdentity(f, repeated);
  const review = typedReviewIntake(f.db, f.root, f.profileId, repeated.id);
  assert.equal(review.records[0].kind, 'observation');
  assert.equal(review.records[0].classification, 'duplicate');
  accept(f, repeated);
  const changedOriginal = upload(f, 'procedure', 'creatinine', {
      procedureLabel: 'Creatinine',
      valueText: '2.90',
      unit: 'mg/dL',
    }),
    changedReview = typedReviewIntake(f.db, f.root, f.profileId, changedOriginal.id);
  assert.equal(
    changedReview.records[0].mapping.valueText,
    '2.90',
    'changed original values never inherit the previous source-version exception',
  );
  assert.equal(changedReview.records[0].classification, 'addition');
  const rebuilt = rebuildProfile(f.root, f.profileId, resolve(f.root, 'reclassified-rebuild')),
    db = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(db, {
    root: resolve(f.root, 'reclassified-rebuild'),
    profileId: f.profileId,
  });
  try {
    assert.deepEqual(
      db.prepare('SELECT * FROM observations').all(),
      f.db.prepare('SELECT * FROM observations').all(),
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM evidence WHERE entity_type<>'person'").get()!.n,
      2,
    );
  } finally {
    db.close();
  }
});

test('kind transition rejects invalid target fields, stale review, missing result and unsupported medication transition', (t) => {
  const f = fixture(t);
  accept(f, upload(f, 'procedure', 'creatinine', { procedureLabel: 'Creatinine' }));
  const row = f.db.prepare('SELECT * FROM procedures').get()!,
    input = {
      kind: 'procedure',
      recordId: row.id,
      set: { kind: 'observation', testLabel: 'Creatinine' },
      reason: 'Fictional report review',
    };
  assert.throws(
    () => previewCorrection(f.db, input),
    (error) => isErrorCode(error, 'CORRECTION_MAPPING'),
  );
  assert.throws(
    () => previewCorrection(f.db, { ...input, set: { kind: 'person' } }),
    (error) => isErrorCode(error, 'CORRECTION_KIND'),
  );
  assert.throws(
    () =>
      previewCorrection(f.db, {
        ...input,
        set: { ...input.set, subject: 'other', valueText: '1' },
      }),
    (error) => isErrorCode(error, 'CORRECTION_FIELDS'),
  );
  assert.throws(
    () =>
      previewCorrection(f.db, {
        ...input,
        set: { kind: 'medication', medicationName: 'Fictional' },
      }),
    (error) => isErrorCode(error, 'CORRECTION_KIND'),
  );
  const valid = { ...input, set: { ...input.set, valueText: '1.20' } },
    p = previewCorrection(f.db, valid);
  correction(
    f,
    {
      kind: 'procedure',
      recordId: row.id,
      set: { procedureLabel: 'Creatinine result' },
      reason: 'Label review',
    },
    'intervening',
  );
  assert.throws(
    () =>
      applyDecision(f.db, f.root, f.profileId, 'clinical_correction', {
        ...valid,
        previewToken: p.token,
        version: p.version,
        operationId: 'stale-kind',
      }),
    (error) => isErrorCode(error, 'CLINICAL_REVIEW_CHANGED'),
  );
});

test('future classification rule explicitly scopes provider/system/kind/label, preserves exceptions and never reuses values', async (t) => {
  const f = fixture(t),
    intake = upload(f, 'procedure', 'creatinine', {
      procedureLabel: 'Creatinine',
      valueText: '1.20',
      unit: 'mg/dL',
    });
  accept(f, intake);
  accept(
    f,
    upload(f, 'procedure', 'exception', {
      procedureLabel: 'Creatinine',
      valueText: '9.00',
      unit: 'mg/dL',
    }),
  );
  const excepted = f.db
    .prepare(
      "SELECT * FROM procedures WHERE json_extract(extra_json,'$.import.sourceRecordId')='procedureexception'",
    )
    .get()!;
  correction(
    f,
    {
      kind: 'procedure',
      recordId: excepted.id,
      set: { procedureCategory: 'laboratory' },
      reason: 'This fictional entry remains a procedure order.',
    },
    'keep-procedure',
  );
  const ext = testExtensions(),
    chat: { proposals: TestProposal[] } = { proposals: [] },
    args = {
      providerId: intake.providerId,
      sourceSystem: 'Issuing hospital',
      kind: 'procedure',
      label: 'Creatinine',
      set: { kind: 'observation', testLabel: 'Creatinine', observationCategory: 'Laboratory' },
      reason: 'Use this exact source classification for future reviewed imports.',
      propose: true,
    };
  const proposal = await ext.call('health_classification_rule_review', args, { db: f.db, chat });
  assert.equal(proposal.preview.scope, 'future_imports');
  assert.equal(proposal.preview.count, 0);
  assert.equal(proposal.preview.matchingExistingCount, 2);
  assert.equal(proposal.preview.exceptionCount, 1);
  assert.equal(
    proposal.preview.examples.find((item) => item.id === excepted.id)!.after.kind,
    'procedure',
  );
  assert.throws(
    () =>
      previewMappingChange(f.db, intake.providerId, {
        scope: 'future_imports',
        match: { kind: 'procedure', label: 'Creatinine', sourceSystem: 'Issuing hospital' },
        set: { ...args.set, valueText: '1.20' },
      } as unknown as Parameters<typeof previewMappingChange>[2]),
    (error) => isErrorCode(error, 'MAPPING_RULE'),
  );
  assert.equal(ext.apply(proposal, f).result.changed, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM procedures').get()!.n, 2);
  const future = upload(f, 'procedure', 'new', {
      procedureLabel: 'Creatinine',
      valueText: '7.40',
      unit: 'mg/dL',
    }),
    review = typedReviewIntake(f.db, f.root, f.profileId, future.id);
  assert.equal(review.records[0].mapping.kind, 'observation');
  assert.equal(review.records[0].mapping.valueText, '7.40');
  assert.equal(review.records[0].classification, 'addition');
  accept(f, future);
  assert.equal(f.db.prepare('SELECT value_text FROM observations').get()!.value_text, '7.40');
  const exceptionCopy = upload(f, 'procedure', 'exception', {
      procedureLabel: 'Creatinine',
      valueText: '9.00',
      unit: 'mg/dL',
    }),
    exceptionReview = typedReviewIntake(f.db, f.root, f.profileId, exceptionCopy.id);
  assert.equal(exceptionReview.records[0].kind, 'procedure');
  assert.equal(exceptionReview.records[0].classification, 'duplicate');
  const otherSystem = upload(
    f,
    'procedure',
    'other-system',
    { procedureLabel: 'Creatinine', valueText: '7.40' },
    'Acquiring clinic',
    'Different issuing hospital',
  );
  assert.equal(
    typedReviewIntake(f.db, f.root, f.profileId, otherSystem.id).records[0].kind,
    'procedure',
  );
  const otherProvider = upload(
    f,
    'procedure',
    'other',
    { procedureLabel: 'Creatinine', valueText: '7.40' },
    'Unmatched clinic',
  );
  assert.equal(
    typedReviewIntake(f.db, f.root, f.profileId, otherProvider.id).records[0].kind,
    'procedure',
  );
  const missing = upload(f, 'procedure', 'missing', { procedureLabel: 'Creatinine' });
  assert.equal(
    typedReviewIntake(f.db, f.root, f.profileId, missing.id).records[0].classification,
    'unsupported',
  );
  const rebuilt = rebuildProfile(f.root, f.profileId, resolve(f.root, 'rule-rebuild')),
    db = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(db, { root: resolve(f.root, 'rule-rebuild'), profileId: f.profileId });
  try {
    const repeat = typedReviewIntake(db, f.root, f.profileId, future.id);
    assert.equal(repeat.records[0].classification, 'duplicate');
    assert.equal(repeat.records[0].kind, 'observation');
  } finally {
    db.close();
  }
});

test('encrypted reclassification A to B to A preserves cross-kind versions and references after complete cache loss', async (t) => {
  const { vaultFixture, newProfile } = await import('./helpers/vault-fixture.ts');
  const { queryRecordHistory } = await import('../record-versions.ts');
  const { resolveClinicalReference } = await import('../clinical-references.ts');
  const { manager, dataDirectory } = vaultFixture(t),
    { profile, recoveryKit } = await newProfile(manager, 'Fictional Reclassification');
  let state = manager.opened.get(profile.id)!,
    f = { root: state.root, db: state.db, profileId: profile.id };
  accept(
    f,
    upload(f, 'procedure', 'creatinine', {
      procedureLabel: 'Creatinine',
      valueText: '1.20',
      unit: 'mg/dL',
    }),
  );
  const row = testRow(f.db.prepare('SELECT * FROM procedures').get()!);
  const b = {
    kind: 'procedure',
    recordId: row.id,
    set: { kind: 'observation', testLabel: 'Creatinine', valueText: '1.20', unit: 'mg/dL' },
    reason: 'Fictional result interpretation',
  };
  correction(f, b, 'encrypted-kind-b');
  assert.equal(resolveClinicalReference(f.db, 'procedure', row.id)!.kind, 'observation');
  correction(
    f,
    {
      kind: 'observation',
      recordId: row.id,
      set: { kind: 'procedure', procedureLabel: 'Creatinine', procedureCategory: 'laboratory' },
      reason: 'Fictional original establishes a laboratory order.',
    },
    'encrypted-kind-a',
  );
  assert.equal(resolveClinicalReference(f.db, 'observation', row.id)!.kind, 'procedure');
  const histories = Object.fromEntries(
    ['procedures', 'observations'].map((entity) => [
      entity,
      queryRecordHistory(f.db, { profileId: profile.id, entity, recordId: row.id }).entries,
    ]),
  );
  assert.ok(histories.procedures.length >= 3);
  assert.equal(histories.observations.length, 2);
  assert.equal(histories.observations[0].deleted, true);
  assert.equal(histories.observations[1].contents.value_text, '1.20');
  const futureRule: Parameters<typeof previewMappingChange>[2] = {
    scope: 'future_imports',
    match: { kind: 'procedure', label: 'Creatinine', sourceSystem: 'Issuing hospital' },
    set: { kind: 'observation', testLabel: 'Creatinine' },
  };
  const rp = previewMappingChange(f.db, row.provider_id, futureRule);
  applyMappingChange(f.db, f.root, f.profileId, {
    providerId: row.provider_id,
    rule: futureRule,
    previewToken: rp.token,
    version: rp.version,
    operationId: 'encrypted-future-rule',
  });
  const before = f.db.prepare('SELECT * FROM procedures').all();
  manager.lock(profile.id);
  rmSync(resolve(dataDirectory, 'profiles', profile.id, 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, recoveryKit);
  state = manager.opened.get(profile.id)!;
  assert.equal(state.metrics.cacheHit, false);
  assert.deepEqual(state.db.prepare('SELECT * FROM procedures').all(), before);
  for (const entity of ['procedures', 'observations'])
    assert.deepEqual(
      queryRecordHistory(state.db, { profileId: profile.id, entity, recordId: row.id }).entries,
      histories[entity],
    );
  assert.equal(resolveClinicalReference(state.db, 'observation', row.id)!.kind, 'procedure');
  f = { root: state.root, db: state.db, profileId: profile.id };
  const repeat = upload(f, 'procedure', 'creatinine', {
    procedureLabel: 'Creatinine',
    valueText: '1.20',
    unit: 'mg/dL',
  });
  assert.equal(
    typedReviewIntake(f.db, f.root, f.profileId, repeat.id).records[0].classification,
    'duplicate',
  );
  const future = upload(f, 'procedure', 'next-creatinine', {
    procedureLabel: 'Creatinine',
    valueText: '2.70',
    unit: 'mg/dL',
  });
  const futureReview = typedReviewIntake(f.db, f.root, f.profileId, future.id);
  assert.equal(futureReview.records[0].kind, 'observation');
  assert.equal(futureReview.records[0].mapping.valueText, '2.70');
});

test('actual reviewed medication import saves Inactive system default and repeated imports retain the personal selection', async (t) => {
  const { appendMedicationPreference } = await import('../medication-preferences.ts');
  const f = fixture(t);
  accept(f, upload(f, 'medication', 'new-medication'));
  const row = testRow(f.db.prepare('SELECT * FROM medications').get()!),
    initial = testRow(
      f.db.prepare('SELECT * FROM medication_preferences WHERE medication_id=?').get(row.id)!,
    );
  assert.equal(initial.status, 'not_current');
  assert.equal(JSON.parse(initial.assertion_json).source, 'system_default');
  transaction(f.db, () =>
    appendMedicationPreference(f.db, row.id, { status: 'current', version: initial.version }),
  );
  const selected = f.db
    .prepare('SELECT * FROM medication_preferences WHERE medication_id=?')
    .get(row.id)!;
  accept(f, upload(f, 'medication', 'new-medication', {}, 'Another acquiring source'));
  assert.deepEqual(
    f.db.prepare('SELECT * FROM medication_preferences WHERE medication_id=?').get(row.id)!,
    selected,
  );
  const rebuilt = rebuildProfile(
      f.root,
      f.profileId,
      resolve(f.root, 'medication-default-rebuild'),
    ),
    db = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(db, {
    root: resolve(f.root, 'medication-default-rebuild'),
    profileId: f.profileId,
  });
  try {
    assert.deepEqual(
      db.prepare('SELECT * FROM medication_preferences WHERE medication_id=?').get(row.id)!,
      selected,
    );
  } finally {
    db.close();
  }
});
