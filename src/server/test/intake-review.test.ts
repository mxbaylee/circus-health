import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import { createEncryptedProfiles } from '../encrypted-profiles.ts';
import * as intake from '../intake.ts';
import { setVisibility } from '../visibility.ts';
import { handleIntakeRoute } from '../intake-routes.ts';
import { mappingFrom, clinicalSourceVersion } from '../clinical-import.ts';
import { canonicalLiteral, INTAKE_SCHEMA_INSTRUCTIONS } from '../intake-format.ts';
import { issueKind, resolutionFields, reviewIssues } from '../intake-review.ts';
import { intakeCandidateId, workflowHash } from '../intake-workflow.ts';
import type {
  HealthRecordEnvelope,
  IntakeClinicalMapping,
  IntakeQuestion,
  IntakeReview,
  IntakeReviewDraft,
  IntakeReviewIssue,
  IntakeReviewRecord,
} from '../../shared/intake.ts';
import type { IntakeWithWorkflow } from '../intake-continuation.ts';

type TestIssue = Partial<IntakeReviewIssue> & Pick<IntakeReviewIssue, 'kind' | 'prompt'>;
interface TestEnvelope extends HealthRecordEnvelope {
  clinical?: IntakeClinicalMapping;
  reviewIssues?: TestIssue[];
  subject?: string;
  uncertainties?: string[];
  mappingReview?: { subject?: string; date?: string | null };
}
const document = (extra: Partial<TestEnvelope> = {}): TestEnvelope => ({
  format: 'health-record-v1',
  id: 'fictional-document',
  kind: 'document',
  payload: { transcript: 'Fictional source transcript', literal: '12.00', date: null },
  subject: 'unknown',
  uncertainties: [
    'The date is unknown',
    'One word is illegible',
    'Source coverage remains partial',
  ],
  mappingReview: { subject: 'Needs patient confirmation', date: null },
  provenance: {
    capturedVia: 'Fictional export',
    sourceSystem: null,
    sourceRecordId: null,
    evidenceClass: 'transcription',
    locator: 'original.pdf page 1',
  },
  coverage: { status: 'partial', notes: ['Source coverage remains partial'] },
  ...extra,
});
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'circus-import-review-'));
  const profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db };
}
type Fixture = ReturnType<typeof fixture>;
type TestIntake = IntakeWithWorkflow & {
  acquisition: NonNullable<IntakeWithWorkflow['acquisition']>;
  metadataHistory: NonNullable<IntakeWithWorkflow['metadataHistory']>;
  workflow: IntakeWithWorkflow['workflow'] & {
    reviewDrafts: NonNullable<IntakeWithWorkflow['workflow']['reviewDrafts']>;
  };
  imported: NonNullable<IntakeWithWorkflow['imported']> & {
    clinical: NonNullable<NonNullable<IntakeWithWorkflow['imported']>['clinical']>;
  };
  importHistory: NonNullable<IntakeWithWorkflow['importHistory']>;
};
type TestReviewRecord = IntakeReviewRecord & {
  issues: IntakeReviewIssue[];
  questions: IntakeQuestion[];
  draft: IntakeReviewDraft;
  recordException: Record<string, unknown>;
};
type TestReview = Omit<IntakeReview, 'records' | 'sourceContext'> & {
  records: TestReviewRecord[];
  sourceContext: NonNullable<IntakeReview['sourceContext']>;
};
type ReviewIssuesFixture = {
  candidateVersionId: string;
  mapping: IntakeClinicalMapping;
  undraftedMapping: IntakeClinicalMapping;
  uncertainties: string[];
};
const fixtureReviewIssues = reviewIssues as unknown as (
  record: ReviewIssuesFixture,
  entry: { value: TestEnvelope },
  questions?: IntakeQuestion[],
  metadataScope?: {
    packageEvidence: boolean;
    reportScoped: boolean;
    memberId: string | null;
    reportSubject?: string | null;
  },
) => IntakeReviewIssue[];
function call(f: Fixture, name: 'reviewIntake', ...args: unknown[]): TestReview;
function call(
  f: Fixture,
  name: 'getIntakeOriginal',
  ...args: unknown[]
): ReturnType<typeof intake.getIntakeOriginal>;
function call(
  f: Fixture,
  name:
    | 'answerIntakeQuestion'
    | 'askIntakeQuestion'
    | 'getIntake'
    | 'importIntake'
    | 'proposeConversion'
    | 'saveIntakeReviewDraft'
    | 'updateIntakeMetadata'
    | 'uploadIntake',
  ...args: unknown[]
): TestIntake;
function call(f: Fixture, name: keyof typeof intake, ...args: unknown[]): unknown {
  const fn = intake[name] as unknown as (...values: unknown[]) => unknown;
  return fn(f.db, f.root, f.profileId, ...args);
}
function propose(f: Fixture, item: TestIntake, value: TestEnvelope) {
  return call(f, 'proposeConversion', item.id, {
    version: item.version,
    summary: 'Fictional extraction',
    jsonlText: JSON.stringify(value),
  });
}
function draft(
  f: Fixture,
  item: TestIntake,
  record: TestReviewRecord,
  input: Record<string, unknown> = {},
) {
  return call(f, 'saveIntakeReviewDraft', item.id, {
    version: item.version,
    operationId: 'draft-one',
    proposalId: item.proposals.at(-1)!?.id || null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId,
    ...input,
  });
}
function accept(f: Fixture, item: TestIntake) {
  const proposalId = item.proposals.at(-1)!?.id || null;
  const review = call(f, 'reviewIntake', item.id, proposalId);
  return call(f, 'importIntake', item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    proposalId,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
}

test('upload before attribution keeps immutable acquisition, independent identity and reviewed metadata history', (t) => {
  const f = fixture(t),
    bytes = Buffer.from('%PDF-1.4\nFictional retained original');
  const input = { filename: 'original.pdf', bytes };
  let item = call(f, 'uploadIntake', input);
  const id = item.id,
    source = f.db.prepare('SELECT path,provider_id FROM source_files WHERE id=?').get(id)!;
  assert.equal(item.provider, 'Unknown source');
  assert.deepEqual(item.metadata, { source: null, careArea: null, documentType: null, topics: [] });
  const request = {
    version: item.version,
    operationId: 'metadata-one',
    metadata: {
      source: 'Fictional Clinic',
      careArea: 'Eye care',
      documentType: 'Visit report',
      topics: ['Follow-up'],
    },
  };
  item = call(f, 'updateIntakeMetadata', id, request);
  assert.equal(item.provider, 'Fictional Clinic');
  assert.equal(item.acquisition.provider, 'Unknown source');
  assert.equal(item.metadataHistory.length, 1);
  assert.equal(call(f, 'updateIntakeMetadata', id, request).version, item.version);
  assert.throws(
    () => call(f, 'updateIntakeMetadata', id, { ...request, metadata: { source: 'Different' } }),
    { code: 'OPERATION_CONFLICT' },
  );
  assert.throws(() => call(f, 'updateIntakeMetadata', id, { ...request, operationId: 'stale' }), {
    code: 'VERSION_CONFLICT',
  });
  assert.equal(call(f, 'uploadIntake', input).id, id);
  assert.notEqual(
    call(f, 'uploadIntake', { ...input, newProviderName: 'Another acquisition source' }).id,
    id,
  );
  assert.deepEqual(
    f.db.prepare('SELECT path,provider_id FROM source_files WHERE id=?').get(id)!,
    source,
  );
  assert.deepEqual(call(f, 'getIntakeOriginal', id).bytes, bytes);
});

test('legacy document gets a missing-identity warning, optional date and retained uncertain reading without prose or autoacceptance', (t) => {
  const f = fixture(t),
    bytes = Buffer.from('%PDF-1.4\nFictional retained original'),
    value = document();
  let item = propose(f, call(f, 'uploadIntake', { filename: 'original.pdf', bytes }), value);
  const proposalId = item.proposals[0]!.id;
  let record = call(f, 'reviewIntake', item.id, proposalId).records[0]!;
  assert.equal(record.kind, 'document');
  assert.equal(record.classification, 'addition');
  assert.equal(record.identityReview?.status, 'missing_warning');
  assert.equal(record.questions.length, 0);
  assert.throws(() => accept(f, item), { code: 'REVIEW_ISSUES_PENDING' });
  const identity = record.issues.find((i) => i.kind === 'identity')!;
  const unknowns = record.issues.filter((i) => ['date', 'uncertain_reading'].includes(i.kind));
  item = draft(f, item, record, {
    mapping: { documentTitle: 'Reviewed fictional report' },
    resolutions: [...unknowns.map((i) => ({ issueId: i.id, outcome: 'unknown' }))],
    disposition: 'review_later',
  });
  assert.equal(item.reviewLaterCount, 1);
  assert.equal(item.pendingCount, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get()!.n, 0);
  record = call(f, 'reviewIntake', item.id, proposalId).records[0]!;
  assert.equal(record.mapping.subject, 'self');
  assert.equal(record.mapping.kind, 'document');
  assert.equal(record.classification, 'addition');
  assert.equal(record.issues.find((i) => i.id === identity.id)!.blocking, false);
  assert(
    record.issues
      .filter((i) => unknowns.some((u) => u.id === i.id))
      .every((i) => i.status === 'unresolved' && !i.blocking),
  );
  assert.equal(record.mapping.documentDate, '');
  item = accept(f, item);
  assert.equal(item.state, 'imported');
  assert.equal(item.pendingCount, 0);
  const saved = f.db.prepare('SELECT * FROM documents').get()!,
    extra = JSON.parse(String(saved.extra_json));
  assert.equal(saved.title, 'Reviewed fictional report');
  assert.equal(saved.effective_at, null);
  assert.equal(extra.import.originalMapping.subject, 'unknown');
  assert.equal(extra.import.acceptedMapping.subject, 'self');
  assert.equal(extra.import.recordException.set.subject, undefined);
  assert.equal(extra.import.identityAttribution.basis, 'reviewed_active_profile_missing_identity');
  assert(extra.import.acceptedMapping.uncertainties.includes('One word is illegible'));
  assert.equal(
    f.db.prepare('SELECT raw_json FROM source_records').get()!.raw_json,
    JSON.stringify(value),
  );
  assert.deepEqual(call(f, 'getIntakeOriginal', item.id).bytes, bytes);
});

test('derived Self proposals with no identity evidence warn without blocking or reopening accepted history', (t) => {
  const f = fixture(t);
  const value = document({
    id: 'fictional-derived-self',
    subject: 'self',
    uncertainties: [],
    mappingReview: undefined,
    clinical: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional derived Self document',
      date: '2026-09-13',
      documentDate: '2026-09-13',
      uncertainties: [],
    },
    coverage: { status: 'complete_response', notes: [] },
  });
  let item = call(f, 'uploadIntake', {
    filename: 'fictional-derived-self.pdf',
    bytes: Buffer.from('%PDF-1.4\nFictional derived Self source'),
  });
  item = propose(f, item, value);
  const proposalId = item.proposals.at(-1)!.id;
  let review = call(f, 'reviewIntake', item.id, proposalId);
  let record = review.records[0]!;
  const identity = record.issues.find((issue) => issue.kind === 'identity')!;
  assert.equal(record.mapping.subject, 'self');
  assert.equal(identity.blocking, false);
  assert.equal(identity.status, 'unresolved');
  assert.equal(record.identityReview?.status, 'missing_warning');
  item = call(f, 'importIntake', item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    proposalId,
    decisions: [{ recordId: record.id, action: 'accept', mapping: {} }],
  });
  review = call(f, 'reviewIntake', item.id, proposalId);
  assert.equal(review.records[0]!.reviewState, 'accepted');
  assert.equal(
    review.records[0]!.issues.some((issue) => issue.kind === 'identity'),
    false,
  );

  const prepared = call(f, 'uploadIntake', {
    filename: 'fictional-prepared-self.jsonl',
    bytes: Buffer.from(JSON.stringify({ ...value, id: 'fictional-prepared-self' })),
  });
  const preparedReview = call(f, 'reviewIntake', prepared.id);
  assert.equal(preparedReview.proposalId, null);
  assert.equal(
    preparedReview.records[0]!.issues.some((issue) => issue.kind === 'identity'),
    false,
  );
  assert.doesNotThrow(() =>
    call(f, 'importIntake', prepared.id, {
      version: preparedReview.version,
      reviewToken: preparedReview.reviewToken,
      proposalId: null,
      decisions: [{ recordId: preparedReview.records[0]!.id, action: 'accept', mapping: {} }],
    }),
  );
});

test('context-only envelopes remain inspectable evidence without becoming clinical review decisions', (t) => {
  const f = fixture(t);
  const context = {
    format: 'health-record-v1',
    id: 'fictional-page-context',
    kind: 'context',
    payload: {
      page1: 'Fictional page text retained exactly',
      panel: 'Fictional panel heading',
      preciseToken: JSON.rawJSON('900719925474099312345'),
    },
    provenance: {
      capturedVia: 'Fictional extraction',
      sourceSystem: 'Fictional EHR',
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: 'fictional-original.pdf pages 1-2',
    },
    coverage: { status: 'partial', notes: ['Page context retained for the mapped rows'] },
    uncertainties: ['No other pages were supplied'],
    reviewIssues: [
      {
        id: 'fictional-information',
        kind: 'information',
        prompt: 'This is fictional source context.',
        textAnchor: 'Fictional page text',
      },
    ],
  };
  const clinical = document({
    id: 'fictional-clinical-document',
    uncertainties: [],
    mappingReview: undefined,
    clinical: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional clinical document',
      date: '2026-04-10',
      documentDate: '2026-04-10',
      eventKind: 'performed',
      uncertainties: [],
    },
    coverage: { status: 'complete_response', notes: [] },
  });
  const malformedContext = {
    ...context,
    id: 'fictional-context-with-malformed-clinical',
    clinical: { kind: 'unsupported', subject: 'self' },
    coverage: { status: 'complete_response', notes: [] },
    uncertainties: [],
  };
  const unsupportedDocument = document({
    id: 'fictional-unsupported-document',
    uncertainties: [],
    mappingReview: undefined,
    coverage: { status: 'complete_response', notes: [] },
  });
  const proposalBytes = Buffer.from(
    [context, clinical, malformedContext, unsupportedDocument]
      .map((value) => JSON.stringify(value))
      .join('\n'),
  );
  const originalBytes = Buffer.from('%PDF-1.4\nFictional retained original for context review');
  let item = call(f, 'uploadIntake', {
    filename: 'fictional-original.pdf',
    bytes: originalBytes,
  });
  item = call(f, 'proposeConversion', item.id, {
    version: item.version,
    summary: 'Fictional context and clinical rows',
    jsonlText: proposalBytes.toString(),
  });
  const proposalId = item.proposals.at(-1)!.id;
  let review = call(f, 'reviewIntake', item.id, proposalId);
  assert.equal(item.pendingCount, 3);
  assert.deepEqual(review.summary, {
    additions: 2,
    duplicates: 0,
    unsupported: 1,
    uncertain: 0,
  });
  assert.equal(review.records.length, 3);
  assert(
    review.records.some((record) => record.title === 'fictional-context-with-malformed-clinical'),
  );
  assert(review.records.some((record) => record.title === 'fictional-unsupported-document'));
  assert.deepEqual(review.sourceContext, [
    {
      id: `${proposalId}:line:1`,
      envelopeId: context.id,
      kind: 'context',
      title: 'Source context',
      payload: context.payload,
      text: JSON.stringify(context.payload, null, 2),
      provenance: context.provenance,
      coverage: context.coverage,
      notes: [
        'Page context retained for the mapped rows',
        'No other pages were supplied',
        'This is fictional source context.',
      ],
      evidence: [
        {
          label: 'Original source',
          locator: context.provenance.locator,
          contentUrl: `/api/sources/${encodeURIComponent(item.id)}/content`,
        },
      ],
    },
  ]);
  assert.match(review.sourceContext[0]!.text, /900719925474099312345/);

  for (const [index, record] of review.records
    .filter((candidate) => candidate.classification === 'unsupported')
    .entries())
    item = call(f, 'saveIntakeReviewDraft', item.id, {
      version: item.version,
      operationId: `keep-unsupported-context-fixture-${index}`,
      proposalId,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId,
      disposition: 'keep_original_only',
    });

  const sourceFile = f.db.prepare('SELECT * FROM source_files WHERE id=?').get(item.id)!;
  const contextCandidateId = intakeCandidateId(
    sourceFile as unknown as Parameters<typeof intakeCandidateId>[0],
    { value: context as unknown as HealthRecordEnvelope },
  );
  const contextVersionId = 'candidate-version:' + workflowHash(canonicalLiteral(context));
  const stored = JSON.parse(String(sourceFile.details_json));
  stored.intake.workflow.candidates.push({
    id: contextCandidateId,
    envelopeId: context.id,
    sourceSystem: context.provenance.sourceSystem,
    sourceRecordId: null,
    versions: [
      {
        id: contextVersionId,
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
        occurrences: [],
      },
    ],
  });
  stored.intake.workflow.questions.push(
    {
      id: 'legacy-context-identity-question',
      key: 'legacy-context-identity',
      candidateId: contextCandidateId,
      candidateVersionId: contextVersionId,
      prompt: 'Does this source context belong to you?',
      locator: context.provenance.locator,
      field: 'subject',
      status: 'unanswered',
      createdAt: '2026-01-01T00:00:00.000Z',
      answers: [],
    },
    {
      id: 'legacy-context-date-question',
      key: 'legacy-context-date',
      candidateId: contextCandidateId,
      candidateVersionId: contextVersionId,
      prompt: 'What is the source context date?',
      locator: context.provenance.locator,
      field: 'date',
      status: 'unanswered',
      createdAt: '2026-01-01T00:00:00.000Z',
      answers: [],
    },
  );
  f.db
    .prepare('UPDATE source_files SET details_json=? WHERE id=?')
    .run(JSON.stringify(stored), item.id);
  assert.equal(
    call(f, 'getIntake', item.id).pendingCount,
    2,
    'legacy context is projected out while the two clinical records remain pending',
  );

  review = call(f, 'reviewIntake', item.id, proposalId);
  const clinicalRecord = review.records.find((record) => record.classification === 'addition')!;
  const clinicalIdentity = clinicalRecord.issues.find((issue) => issue.kind === 'identity')!;
  item = call(f, 'saveIntakeReviewDraft', item.id, {
    version: review.version,
    operationId: 'confirm-context-fixture-clinical-self',
    proposalId,
    recordId: clinicalRecord.id,
    candidateVersionId: clinicalRecord.candidateVersionId,
    resolutions: [
      { issueId: clinicalIdentity.id, outcome: 'this_is_me', mapping: { subject: 'self' } },
    ],
  });
  review = call(f, 'reviewIntake', item.id, proposalId);
  item = call(f, 'importIntake', item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    proposalId,
    decisions: review.records.map((record) => ({
      recordId: record.id,
      action: record.classification === 'addition' ? 'accept' : 'skip',
      mapping: {},
    })),
  });
  assert.equal(item.state, 'imported');
  assert.equal(item.pendingCount, 0);
  assert.equal(
    item.workflow.candidates
      .flatMap((candidate) => candidate.versions)
      .find((version) => version.id === contextVersionId)!.sourceContext,
    true,
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get()!.n, 2);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM source_records WHERE kind LIKE 'intake_%'").get()!.n,
    4,
  );
  assert.equal(
    f.db.prepare("SELECT raw_json FROM source_records WHERE kind='intake_context'").get()!.raw_json,
    JSON.stringify(context),
  );
  const proposalFile = f.db.prepare('SELECT path FROM source_files WHERE id=?').get(proposalId)!;
  assert.deepEqual(
    readFileSync(profileOriginal(f.root, String(proposalFile.path), f.profileId)),
    proposalBytes,
  );
  assert.deepEqual(call(f, 'getIntakeOriginal', item.id).bytes, originalBytes);

  const afterImport = f.db
    .prepare('SELECT details_json FROM source_files WHERE id=?')
    .get(item.id)!;
  const retainedDetails = JSON.parse(String(afterImport.details_json));
  retainedDetails.intake.workflow.reviewDrafts.push({
    id: 'legacy-reviewed-context-draft',
    proposalId,
    recordId: `${proposalId}:line:1`,
    candidateId: contextCandidateId,
    candidateVersionId: contextVersionId,
    mapping: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Previously reviewed context document',
      date: '2026-04-10',
      documentDate: '2026-04-10',
    },
    resolutions: [],
    disposition: 'pending',
    at: '2026-01-01T00:00:00.000Z',
  });
  f.db
    .prepare('UPDATE source_files SET details_json=? WHERE id=?')
    .run(JSON.stringify(retainedDetails), item.id);
  const mappedContext = call(f, 'reviewIntake', item.id, proposalId);
  assert.equal(mappedContext.sourceContext.length, 0);
  assert.equal(mappedContext.records.length, 4);
  assert.equal(call(f, 'getIntake', item.id).pendingCount, 1);
  assert.equal(
    mappedContext.records.find((record) => record.id === `${proposalId}:line:1`)!.mapping
      .documentTitle,
    'Previously reviewed context document',
  );
  assert.equal(
    mappedContext.records.find((record) => record.id === `${proposalId}:line:1`)!
      .candidateVersionId,
    contextVersionId,
  );
});

test('unsupported date issue targets become informational while document dates remain actionable', () => {
  const value = document({
    subject: 'self',
    uncertainties: [],
    mappingReview: undefined,
    clinical: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional optical prescription',
      date: '2026-07-12',
      documentDate: '2026-07-12',
      opticalPrescription: {
        type: 'spectacle',
        expiresDateText: '07/12/2028',
        eyes: [],
      },
    },
    reviewIssues: [
      {
        id: 'expiry-date',
        kind: 'date',
        field: 'opticalPrescription.expiresDateText',
        prompt: 'Is the fictional expiry 7 December or July 12?',
        textAnchor: 'Expires: 07/12/2028',
        choices: [
          { label: '7 December 2028', value: '2028-12-07' },
          { label: 'July 12, 2028', value: '2028-07-12' },
        ],
      },
      {
        id: 'document-date',
        kind: 'date',
        field: 'documentDate',
        prompt: 'Confirm the fictional document date.',
        textAnchor: 'Prescribed: 07/12/2026',
        choices: [{ label: 'July 12, 2026', value: '2026-07-12' }],
      },
    ],
  });
  const issues = fixtureReviewIssues(
    {
      candidateVersionId: 'fictional-version',
      mapping: value.clinical!,
      undraftedMapping: value.clinical!,
      uncertainties: [],
    },
    { value },
  );
  const expiry = issues.find((issue) => issue.textAnchor === 'Expires: 07/12/2028')!;
  const documentDate = issues.find((issue) => issue.textAnchor === 'Prescribed: 07/12/2026')!;
  assert.equal(expiry.kind, 'information');
  assert.equal(expiry.field, null);
  assert.equal(expiry.blocking, false);
  assert.equal(expiry.choices, undefined);
  assert.equal(expiry.textAnchor, 'Expires: 07/12/2028');
  assert.deepEqual(resolutionFields(expiry), []);
  assert.equal(documentDate.kind, 'date');
  assert.equal(documentDate.field, 'documentDate');
  assert.deepEqual(resolutionFields(documentDate), ['date', 'documentDate']);
  assert.equal(value.clinical!.opticalPrescription!.expiresDateText, '07/12/2028');
});

test('one scoped document date review replaces the fallback while unscoped date notes stay informational', () => {
  const dateOrderNote =
    'The date order for 07/12/2026 and 07/12/2028 is not stated; no ISO date was inferred.';
  const value = document({
    subject: 'self',
    uncertainties: [],
    mappingReview: undefined,
    clinical: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional optical prescription',
      date: '',
      documentDate: '',
      uncertainties: [dateOrderNote],
      opticalPrescription: {
        type: 'spectacle',
        prescribedDateText: '07/12/2026',
        expiresDateText: '07/12/2028',
        eyes: [],
      },
    },
    reviewIssues: [
      {
        id: 'document-date-choice',
        kind: 'date',
        field: 'documentDate',
        prompt: 'Which supported interpretation should be used for the prescription date?',
        textAnchor: 'Prescribed: 07/12/2026',
        choices: [
          { label: '12 July 2026', value: '2026-07-12' },
          { label: '7 December 2026', value: '2026-12-07' },
        ],
      },
      {
        id: 'unscoped-date-choice',
        kind: 'date',
        prompt: 'Which date should be used?',
        textAnchor: 'Prescribed: 07/12/2026',
      },
    ],
  });
  const issues = fixtureReviewIssues(
    {
      candidateVersionId: 'fictional-optical-version',
      mapping: value.clinical!,
      undraftedMapping: value.clinical!,
      uncertainties: [],
    },
    { value },
  );
  assert.equal(
    issues.some((issue) => issue.prompt.startsWith('The document date is unknown.')),
    false,
  );
  assert.equal(
    issues.filter((issue) => issue.kind === 'date' && issue.field === 'documentDate').length,
    1,
  );
  for (const prompt of ['Which date should be used?', dateOrderNote]) {
    const issue = issues.find((candidate) => candidate.prompt === prompt)!;
    assert.equal(issue.kind, 'information');
    assert.equal(issue.field, null);
    assert.deepEqual(resolutionFields(issue), []);
  }
  assert.equal(value.clinical!.opticalPrescription!.prescribedDateText, '07/12/2026');
  assert.equal(value.clinical!.opticalPrescription!.expiresDateText, '07/12/2028');

  const independentStartDate = structuredClone(value);
  independentStartDate.reviewIssues = [
    {
      id: 'start-date-choice',
      kind: 'date',
      field: 'startDate',
      prompt: 'Choose the supported start date.',
    },
    {
      id: 'unscoped-independent-date',
      kind: 'date',
      prompt: 'Which other date should be used?',
    },
  ];
  const independentIssues = fixtureReviewIssues(
    {
      candidateVersionId: 'fictional-start-date-version',
      mapping: independentStartDate.clinical!,
      undraftedMapping: independentStartDate.clinical!,
      uncertainties: [],
    },
    { value: independentStartDate },
  );
  assert.equal(
    independentIssues.filter((issue) => issue.prompt.startsWith('The document date is unknown.'))
      .length,
    1,
  );
  assert.equal(independentIssues.find((issue) => issue.field === 'startDate')!.kind, 'date');
  assert.equal(
    independentIssues.find((issue) => issue.prompt === 'Which other date should be used?')!.kind,
    'information',
  );
});

test('legacy context candidates are projected out of pending counts without rewriting mapped history', (t) => {
  const f = fixture(t);
  const context = {
    format: 'health-record-v1',
    id: 'fictional-legacy-context',
    kind: 'context',
    subject: 'self',
    payload: 'Fictional retained source context',
    uncertainties: [],
    provenance: {
      capturedVia: 'Fictional extraction',
      sourceSystem: 'Fictional EHR',
      sourceRecordId: 'fictional-context-1',
      evidenceClass: 'transcription',
      locator: 'fictional-original.pdf page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
  };
  const item = call(f, 'uploadIntake', {
    filename: 'legacy-context.jsonl',
    bytes: Buffer.from(JSON.stringify(context)),
  });
  const sourceFile = f.db.prepare('SELECT * FROM source_files WHERE id=?').get(item.id)!;
  const candidateId = intakeCandidateId(
    sourceFile as unknown as Parameters<typeof intakeCandidateId>[0],
    { value: context as unknown as HealthRecordEnvelope },
  );
  const versionId = 'candidate-version:' + workflowHash(canonicalLiteral(context));
  const recordId = `${item.id}:line:1`;
  const stored = JSON.parse(String(sourceFile.details_json));
  stored.intake.workflow.candidates.push({
    id: candidateId,
    envelopeId: context.id,
    sourceSystem: context.provenance.sourceSystem,
    sourceRecordId: context.provenance.sourceRecordId,
    versions: [
      {
        id: versionId,
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
        occurrences: [
          {
            proposalId: null,
            recordId,
            batchId: null,
            locator: context.provenance.locator,
          },
        ],
      },
    ],
  });
  const retained = JSON.stringify(stored);
  f.db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(retained, item.id);

  let projected = call(f, 'getIntake', item.id);
  let review = call(f, 'reviewIntake', item.id);
  assert.equal(projected.pendingCount, 0);
  assert.equal(intake.listIntakes(f.db, f.profileId, {}, f.root).data[0]!.pendingCount, 0);
  assert.equal(projected.needsReview, false);
  assert.equal(projected.workflow.candidates[0]!.versions[0]!.sourceContext, true);
  assert.equal(review.records.length, 0);
  assert.equal(review.sourceContext.length, 1);
  assert.equal(
    f.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(item.id)!.details_json,
    retained,
    'read projection does not rewrite the retained workflow',
  );

  stored.intake.workflow.reviewDrafts.push({
    id: 'mapped-context-draft',
    proposalId: null,
    recordId,
    candidateId,
    candidateVersionId: versionId,
    mapping: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Reviewed fictional context',
    },
    resolutions: [],
    disposition: 'review_later',
    at: '2026-01-02T00:00:00.000Z',
  });
  f.db
    .prepare('UPDATE source_files SET details_json=? WHERE id=?')
    .run(JSON.stringify(stored), item.id);
  projected = call(f, 'getIntake', item.id);
  review = call(f, 'reviewIntake', item.id);
  assert.equal(projected.pendingCount, 1);
  assert.equal(projected.reviewLaterCount, 1);
  assert.equal(review.sourceContext.length, 0);
  assert.equal(review.records[0]!.mapping.documentTitle, 'Reviewed fictional context');

  stored.intake.workflow.reviewDrafts = [];
  stored.intake.workflow.candidates[0]!.versions[0]!.status = 'accepted';
  stored.intake.workflow.decisions.push({
    id: 'accepted-context-decision',
    candidateId,
    candidateVersionId: versionId,
    recordId,
    action: 'accept',
    mapping: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Accepted fictional context',
    },
    scope: 'record',
    evidence: [],
    at: '2026-01-03T00:00:00.000Z',
  });
  f.db
    .prepare('UPDATE source_files SET details_json=? WHERE id=?')
    .run(JSON.stringify(stored), item.id);
  projected = call(f, 'getIntake', item.id);
  review = call(f, 'reviewIntake', item.id);
  assert.equal(projected.pendingCount, 0);
  assert.equal(review.sourceContext.length, 0);
  assert.equal(review.records[0]!.reviewState, 'accepted');
  assert.equal(review.records[0]!.mapping.documentTitle, 'Accepted fictional context');
});

test('unsupported nested date questions remain informational in workflow counts', (t) => {
  const f = fixture(t);
  const value = document({
    subject: 'self',
    uncertainties: [],
    clinical: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional optical prescription',
      date: '2026-07-12',
      documentDate: '2026-07-12',
      opticalPrescription: {
        type: 'spectacle',
        expiresDateText: '07/12/2028',
        eyes: [],
      },
    },
  });
  let item = call(f, 'uploadIntake', {
    filename: 'nested-date.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  const record = call(f, 'reviewIntake', item.id).records[0]!;
  item = call(f, 'askIntakeQuestion', item.id, {
    version: item.version,
    operationId: 'nested-date-question',
    key: 'nested-date-question',
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    field: 'opticalPrescription.expiresDateText',
    prompt: 'Is the fictional expiry date 7 December or July 12?',
    locator: value.provenance.locator,
  });
  const reloaded = call(f, 'reviewIntake', item.id).records[0]!;
  const issue = reloaded.issues.find((candidate) => candidate.questionId)!;
  assert.equal(issue.kind, 'information');
  assert.equal(issue.field, null);
  assert.deepEqual(resolutionFields(issue), []);
  assert.equal(item.workflow.questions[0]!.status, 'unanswered');
  assert.equal(item.unansweredCount, 0);
  assert.equal(item.pendingCount, 1);
});

test('draft CAS and candidate versions preserve pending earlier work; Keep original is terminal with question history', (t) => {
  const f = fixture(t);
  const value = document({
    clinical: {
      kind: 'document',
      subject: 'unknown',
      documentTitle: 'Fictional report',
      uncertainties: ['Confirm the patient identity'],
    },
  });
  let item = call(f, 'uploadIntake', {
    filename: 'records.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  const review = call(f, 'reviewIntake', item.id),
    record = review.records[0]!;
  const input = {
    version: item.version,
    operationId: 'defer',
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId,
    disposition: 'review_later',
    mapping: { documentTitle: 'Draft title' },
  };
  item = call(f, 'saveIntakeReviewDraft', item.id, input);
  assert.equal(call(f, 'saveIntakeReviewDraft', item.id, input).version, item.version);
  assert.throws(
    () => call(f, 'saveIntakeReviewDraft', item.id, { ...input, operationId: 'stale' }),
    { code: 'VERSION_CONFLICT' },
  );
  assert.throws(
    () =>
      call(f, 'saveIntakeReviewDraft', item.id, {
        ...input,
        version: item.version,
        operationId: 'wrong-candidate',
        candidateVersionId: 'foreign',
      }),
    { code: 'CANDIDATE_VERSION_CONFLICT' },
  );
  item = propose(f, item, { ...value, payload: 'A newly supplied literal assertion' });
  assert.equal(
    item.workflow.candidates[0]!.versions.filter((v) => v.status === 'pending').length,
    2,
  );
  assert.equal(call(f, 'reviewIntake', item.id).records[0]!.mapping.documentTitle, 'Draft title');
  let fresh = call(f, 'reviewIntake', item.id, item.proposals[0]!.id).records[0]!;
  assert.equal(fresh.draft, null);
  item = draft(f, item, fresh, { operationId: 'keep-new', disposition: 'keep_original_only' });
  assert.equal(item.pendingCount, 1);
  item = call(f, 'saveIntakeReviewDraft', item.id, {
    ...input,
    version: item.version,
    operationId: 'keep-old',
    disposition: 'keep_original_only',
  });
  assert.equal(item.pendingCount, 0);
  assert.equal(item.unansweredCount, 0);
  assert.equal(item.state, 'kept_original');
  assert.equal(item.workflow.questions[0]!.status, 'unanswered');
  assert.equal(item.workflow.reviewDrafts[0]!.disposition, 'review_later');
  assert.equal(item.workflow.decisions.filter((d) => d.action === 'keep_original_only').length, 2);
  assert.throws(() => draft(f, item, fresh, { operationId: 'reopen', disposition: 'pending' }), {
    code: 'REVIEW_DISPOSITION',
  });
  assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get()!.n, 0);
});

test('typed resolution preserves legacy answers and resolves only explicit review decisions', (t) => {
  const f = fixture(t),
    value = document({
      subject: 'self',
      uncertainties: [],
      clinical: {
        kind: 'document',
        subject: 'self',
        documentTitle: 'Fictional report',
        uncertainties: ['Confirm the printed unit'],
      },
    });
  let item = call(f, 'uploadIntake', {
    filename: 'legacy.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  const question = item.workflow.questions[0]!;
  item = call(f, 'answerIntakeQuestion', item.id, {
    version: item.version,
    questionId: question.id,
    operationId: 'old-answer',
    answer: 'Earlier retained answer',
  });
  let record = call(f, 'reviewIntake', item.id).records[0]!;
  item = draft(f, item, record, { resolutions: [{ issueId: question.id, outcome: 'confirmed' }] });
  assert.equal(item.workflow.questions[0]!.answers.length, 2);
  assert.equal(item.workflow.questions[0]!.answers[0]!.answer, 'Earlier retained answer');
  assert.equal(item.workflow.questions[0]!.status, 'answered');
  item = accept(f, item);
  assert.equal(item.workflow.questions[0]!.status, 'resolved');
  assert.equal(item.workflow.questions[0]!.answers.length, 2);
});

test('draft decision and answer text survive review reload without submitting answers or accepting', (t) => {
  const f = fixture(t),
    value = document({
      subject: 'self',
      uncertainties: [],
      clinical: {
        kind: 'document',
        subject: 'self',
        documentTitle: 'Fictional report',
        uncertainties: ['Confirm the printed unit'],
      },
    });
  let item = call(f, 'uploadIntake', {
    filename: 'draft.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  const record = call(f, 'reviewIntake', item.id).records[0]!,
    question = record.questions[0]!;
  const decision = {
    recordId: record.id,
    action: 'skip',
    mapping: { documentTitle: 'Tentative title' },
    rememberRule: {
      match: { kind: 'document', label: 'Fictional report' },
      set: { documentTitle: 'Tentative title' },
    },
    comparisons: [],
  };
  item = draft(f, item, record, {
    mapping: record.mapping,
    decision,
    answers: { [question.id]: 'An unfinished answer' },
    disposition: 'review_later',
  });
  const saved = call(f, 'reviewIntake', item.id).records[0]!.draft;
  assert.deepEqual(saved.decision, decision);
  assert.deepEqual(saved.answers, { [question.id]: 'An unfinished answer' });
  assert.equal(item.workflow.questions[0]!.status, 'unanswered');
  assert.equal(item.workflow.questions[0]!.answers.length, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get()!.n, 0);
});

test('leaving an earlier answered uncertainty marked unknown preserves the answer without silently adopting or resolving it', (t) => {
  const f = fixture(t),
    value = document({
      subject: 'self',
      uncertainties: [],
      clinical: {
        kind: 'document',
        subject: 'self',
        documentTitle: 'Literal title',
        uncertainties: ['Confirm the unclear title'],
      },
    });
  let item = call(f, 'uploadIntake', {
    filename: 'uncertain.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  const question = item.workflow.questions[0]!;
  item = call(f, 'answerIntakeQuestion', item.id, {
    version: item.version,
    operationId: 'prior-title-answer',
    questionId: question.id,
    answer: 'An earlier possibility',
    mapping: { documentTitle: 'Possible different title' },
  });
  let record = call(f, 'reviewIntake', item.id).records[0]!;
  item = draft(f, item, record, { resolutions: [{ issueId: question.id, outcome: 'unknown' }] });
  assert.deepEqual(call(f, 'reviewIntake', item.id).records[0]!.suggestedMapping, {});
  item = accept(f, item);
  assert.equal(item.state, 'imported');
  assert.equal(item.workflow.questions[0]!.status, 'answered');
  assert.equal(item.workflow.questions[0]!.answers[0]!.answer, 'An earlier possibility');
  assert.equal(f.db.prepare('SELECT title FROM documents').get()!.title, 'Literal title');
});

test('typed evidence anchors and identity suggestions are copied only from explicit evidence metadata', (t) => {
  const f = fixture(t),
    value = document({
      payload: {
        transcript:
          'Fictional clinic. Patient: Fictional Rowan Example. DOB: 1990-03. Vision prescription. Printed visit date: 2026-08.',
        literal: '12.00',
        date: null,
      },
      reviewIssues: [
        {
          id: 'identity-evidence',
          kind: 'identity',
          prompt: 'Check the printed patient name',
          field: 'subject',
          textAnchor: 'Fictional clinic. Patient: Fictional Rowan Example. DOB: 1990-03',
          page: 1,
          sourceSuggestion: 'Fictional clinic',
          selfSuggestion: { fullName: 'Fictional Rowan Example', birthDate: '1990-03' },
        },
        {
          id: 'date-choice',
          kind: 'date',
          field: 'date',
          prompt: 'Choose the supported date or leave it unknown',
          textAnchor: 'Printed visit date: 2026-08',
          choices: [{ label: 'Printed visit date', value: '2026-08' }],
          metadataSuggestion: {
            careArea: ' Vision ',
            documentType: 'Eyewear prescription',
            topics: ['Corrective lenses', 'Corrective lenses', 'Refraction'],
          },
        },
      ],
    });
  const item = call(f, 'uploadIntake', {
    filename: 'anchored.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  const review = call(f, 'reviewIntake', item.id),
    issue = review.records[0]!.issues.find((i) => i.selfSuggestion)!;
  assert.equal(
    issue.textAnchor,
    'Fictional clinic. Patient: Fictional Rowan Example. DOB: 1990-03',
  );
  assert.equal(issue.page, 1);
  assert.equal(issue.sourceSuggestion, 'Fictional clinic');
  assert.deepEqual(
    review.records[0]!.issues.find((i) => i.metadataSuggestion)!.metadataSuggestion,
    {
      careArea: 'Vision',
      documentType: 'Eyewear prescription',
      topics: ['Corrective lenses', 'Refraction'],
    },
  );
  assert.deepEqual(issue.selfSuggestion, {
    fullName: 'Fictional Rowan Example',
    birthDate: '1990-03',
  });
  assert.deepEqual(review.records[0]!.issues.find((i) => i.choices)!.choices, [
    { label: 'Printed visit date', value: '2026-08' },
  ]);
  assert(
    !review.records[0]!.issues.find((i) => i.prompt === 'Does this record belong to you?')!
      .selfSuggestion,
  );
  assert.deepEqual(item.metadata, {
    source: null,
    careArea: null,
    documentType: null,
    topics: [],
  });
  assert.match(call(f, 'getIntakeOriginal', item.id).bytes.toString(), /Printed visit date/);
  assert.equal(item.workflow.questions.length, 0);
});

test('metadata suggestions require exact evidence scope and reject malformed structures', () => {
  const value = document({
    subject: 'self',
    uncertainties: [],
    payload: { transcript: 'Vision prescription for Fictional Rowan Example' },
    report: {
      key: 'fictional-report',
      title: 'Fictional report',
      anchor: { locator: 'member A page 1', text: 'Fictional report heading' },
      subject: { locator: 'member A page 1', text: 'Fictional Rowan Example' },
      memberId: 'member:A',
    },
    reviewIssues: [
      {
        id: 'scoped',
        kind: 'information',
        prompt: 'The report type is explicit in the heading.',
        textAnchor: 'Vision prescription',
        memberId: 'member:A',
        metadataSuggestion: { careArea: 'Vision', topics: ['Corrective lenses'] },
      },
      {
        id: 'no-anchor',
        kind: 'information',
        prompt: 'No exact supporting quote.',
        metadataSuggestion: { careArea: 'Vision' },
      },
      {
        id: 'other-member',
        kind: 'information',
        prompt: 'This came from a different package member.',
        textAnchor: 'Vision prescription',
        memberId: 'member:B',
        metadataSuggestion: { documentType: 'Visit summary' },
      },
      {
        id: 'fake-anchor',
        kind: 'information',
        prompt: 'The claimed quote is absent from retained payload text.',
        textAnchor: 'Invented report heading',
        memberId: 'member:A',
        metadataSuggestion: { documentType: 'Visit summary' },
      },
      {
        id: 'nested-instruction',
        kind: 'information',
        prompt: 'Nested structures are not labels.',
        textAnchor: 'Vision prescription',
        memberId: 'member:A',
        metadataSuggestion: { careArea: { instruction: 'Use every record' } },
      },
      {
        id: 'unknown-key',
        kind: 'information',
        prompt: 'Unsupported keys reject the whole suggestion.',
        textAnchor: 'Vision prescription',
        memberId: 'member:A',
        metadataSuggestion: { careArea: 'Vision', source: 'Unrelated clinic' },
      },
      {
        id: 'too-many-topics',
        kind: 'information',
        prompt: 'Suggestion topic count is bounded.',
        textAnchor: 'Vision prescription',
        memberId: 'member:A',
        metadataSuggestion: { topics: Array.from({ length: 13 }, (_, index) => `Topic ${index}`) },
      },
    ] as unknown as TestIssue[],
  });
  const issues = fixtureReviewIssues(
    {
      candidateVersionId: 'fictional-metadata-suggestions',
      mapping: value.clinical || { kind: 'document', subject: 'self' },
      undraftedMapping: value.clinical || { kind: 'document', subject: 'self' },
      uncertainties: [],
    },
    { value },
    [],
    { packageEvidence: true, reportScoped: true, memberId: 'member:A' },
  );
  assert.deepEqual(issues.find((issue) => issue.metadataSuggestion)!.metadataSuggestion, {
    careArea: 'Vision',
    topics: ['Corrective lenses'],
  });
  assert.equal(issues.filter((issue) => issue.metadataSuggestion).length, 1);

  const absentReport = document({
    subject: 'self',
    uncertainties: [],
    payload: { transcript: 'Vision prescription' },
    reviewIssues: [
      {
        id: 'unverified-member',
        kind: 'information',
        prompt: 'A model member ID is not a host scope.',
        textAnchor: 'Vision prescription',
        memberId: 'member:unrelated',
        metadataSuggestion: { careArea: 'Vision' },
      },
    ],
  });
  const absentReportIssues = fixtureReviewIssues(
    {
      candidateVersionId: 'fictional-unscoped-member',
      mapping: { kind: 'document', subject: 'self' },
      undraftedMapping: { kind: 'document', subject: 'self' },
      uncertainties: [],
    },
    { value: absentReport },
  );
  assert.equal(
    absentReportIssues.find((issue) => issue.prompt === 'A model member ID is not a host scope.')!
      .metadataSuggestion,
    undefined,
  );
});

test('source, date and Self suggestions require their exact evidence and proper report scope', () => {
  const value = document({
    subject: 'unknown',
    uncertainties: [],
    payload: {
      transcript:
        'Fictional Harbor Clinic. Patient: Fictional Rowan Example. DOB: 1990-03. Report date: 07/12/2026. Collected: 2021-03-06T14:56:00Z. Alternate identity line: Patient: Fictional Rowan Example. DOB: 03/08/1990. Invalid date: 2026-02-30. Reference code x2020y.',
    },
    report: {
      key: 'fictional-report',
      title: 'Fictional report',
      anchor: { locator: 'member A page 1', text: 'Fictional Harbor Clinic' },
      subject: { locator: 'member A page 1', text: 'Patient: Fictional Rowan Example' },
      memberId: 'member:A',
    },
    reviewIssues: [
      {
        id: 'valid-source',
        kind: 'information',
        prompt: 'The printed organization can be used as a personal source label.',
        textAnchor: 'Fictional Harbor Clinic',
        memberId: 'member:A',
        sourceSuggestion: 'Fictional Harbor Clinic',
      },
      {
        id: 'valid-date',
        kind: 'date',
        field: 'documentDate',
        prompt: 'Choose the printed report date interpretation.',
        textAnchor: 'Report date: 07/12/2026',
        memberId: 'member:A',
        choices: [
          { label: 'July 12, 2026', value: '2026-07-12' },
          { label: 'Keep unknown', value: 'unknown' },
          { label: 'December 7, 2026', value: '2026-12-07' },
        ],
      },
      {
        id: 'valid-self',
        kind: 'identity',
        field: 'subject',
        prompt: 'Does the printed patient identity belong to you?',
        textAnchor: 'Patient: Fictional Rowan Example. DOB: 1990-03',
        memberId: 'member:A',
        selfSuggestion: { fullName: 'Fictional Rowan Example', birthDate: '1990-03' },
      },
      {
        id: 'fieldwise-self',
        kind: 'identity',
        field: 'subject',
        prompt: 'A grounded Self name survives an ambiguous birth date suggestion.',
        textAnchor: 'Patient: Fictional Rowan Example. DOB: 1990-03. Report date: 07/12/2026',
        memberId: 'member:A',
        selfSuggestion: { fullName: 'Fictional Rowan Example', birthDate: '2026-07-12' },
      },
      {
        id: 'valid-timestamp',
        kind: 'date',
        field: 'startDate',
        prompt: 'Use the exact printed collection timestamp.',
        textAnchor: 'Collected: 2021-03-06T14:56:00Z',
        memberId: 'member:A',
        choices: [{ label: 'March 6, 2021 at 14:56 UTC', value: '2021-03-06T14:56:00Z' }],
      },
      {
        id: 'cross-member-source',
        kind: 'information',
        prompt: 'A source suggestion from another member stays unavailable.',
        textAnchor: 'Fictional Harbor Clinic',
        memberId: 'member:B',
        sourceSuggestion: 'Fictional Harbor Clinic',
      },
      {
        id: 'cross-member-date',
        kind: 'date',
        field: 'date',
        prompt: 'A date suggestion from another member stays unavailable.',
        textAnchor: 'Report date: 07/12/2026',
        memberId: 'member:B',
        choices: [{ label: 'July 12, 2026', value: '2026-07-12' }],
      },
      {
        id: 'cross-member-self',
        kind: 'identity',
        field: 'subject',
        prompt: 'A Self suggestion from another member stays unavailable.',
        textAnchor: 'Patient: Fictional Rowan Example. DOB: 1990-03',
        memberId: 'member:B',
        selfSuggestion: { fullName: 'Fictional Rowan Example' },
      },
      {
        id: 'absent-source',
        kind: 'information',
        prompt: 'An absent source label stays unavailable.',
        textAnchor: 'Fictional Harbor Clinic',
        memberId: 'member:A',
        sourceSuggestion: 'Fictional Absent Clinic',
      },
      {
        id: 'source-elsewhere',
        kind: 'information',
        prompt: 'A source label elsewhere in the payload stays unavailable.',
        textAnchor: 'Fictional Harbor Clinic',
        memberId: 'member:A',
        sourceSuggestion: 'Fictional Rowan Example',
      },
      {
        id: 'absent-date',
        kind: 'date',
        field: 'date',
        prompt: 'An unsupported date interpretation stays unavailable.',
        textAnchor: 'Report date: 07/12/2026',
        memberId: 'member:A',
        choices: [{ label: 'September 1, 2026', value: '2026-09-01' }],
      },
      {
        id: 'partial-date',
        kind: 'date',
        field: 'date',
        prompt: 'A year substring does not reduce the printed date precision.',
        textAnchor: 'Report date: 07/12/2026',
        memberId: 'member:A',
        choices: [{ label: 'Year 2026', value: '2026' }],
      },
      {
        id: 'truncated-timestamp',
        kind: 'date',
        field: 'startDate',
        prompt: 'A timestamp cannot be reduced to its day.',
        textAnchor: 'Collected: 2021-03-06T14:56:00Z',
        memberId: 'member:A',
        choices: [{ label: 'March 6, 2021', value: '2021-03-06' }],
      },
      {
        id: 'embedded-year-token',
        kind: 'date',
        field: 'date',
        prompt: 'A year inside another token is not date evidence.',
        textAnchor: 'Reference code x2020y',
        memberId: 'member:A',
        choices: [{ label: 'Year 2020', value: '2020' }],
      },
      {
        id: 'invalid-date-year',
        kind: 'date',
        field: 'date',
        prompt: 'An invalid structured date cannot degrade to its year.',
        textAnchor: 'Invalid date: 2026-02-30',
        memberId: 'member:A',
        choices: [{ label: 'Year 2026', value: '2026' }],
      },
      {
        id: 'absent-self',
        kind: 'identity',
        field: 'subject',
        prompt: 'An absent Self name stays unavailable.',
        textAnchor: 'Patient: Fictional Rowan Example. DOB: 1990-03',
        memberId: 'member:A',
        selfSuggestion: { fullName: 'Fictional Absent Name' },
      },
      {
        id: 'ambiguous-self-date',
        kind: 'identity',
        field: 'subject',
        prompt: 'An ambiguous numeric birth date cannot select one interpretation.',
        textAnchor: 'Patient: Fictional Rowan Example. DOB: 03/08/1990',
        memberId: 'member:A',
        selfSuggestion: { fullName: 'Fictional Rowan Example', birthDate: '1990-03-08' },
      },
      {
        id: 'wrong-date-kind',
        kind: 'information',
        field: 'date',
        prompt: 'An informational note cannot offer a clinical date choice.',
        textAnchor: 'Report date: 07/12/2026',
        memberId: 'member:A',
        choices: [{ label: 'July 12, 2026', value: '2026-07-12' }],
      },
      {
        id: 'wrong-date-field',
        kind: 'date',
        field: 'opticalPrescription.expiresDateText',
        prompt: 'A nested literal date cannot become a clinical date choice.',
        textAnchor: 'Report date: 07/12/2026',
        memberId: 'member:A',
        choices: [{ label: 'July 12, 2026', value: '2026-07-12' }],
      },
      {
        id: 'wrong-self-kind',
        kind: 'information',
        field: 'subject',
        prompt: 'An informational note cannot offer a Self update.',
        textAnchor: 'Patient: Fictional Rowan Example. DOB: 1990-03',
        memberId: 'member:A',
        selfSuggestion: { fullName: 'Fictional Rowan Example' },
      },
      {
        id: 'wrong-self-field',
        kind: 'identity',
        field: null,
        prompt: 'An unscoped identity note cannot offer a Self update.',
        textAnchor: 'Patient: Fictional Rowan Example. DOB: 1990-03',
        memberId: 'member:A',
        selfSuggestion: { fullName: 'Fictional Rowan Example' },
      },
    ] as TestIssue[],
  });
  const issues = fixtureReviewIssues(
    {
      candidateVersionId: 'fictional-scoped-suggestions',
      mapping: { kind: 'document', subject: 'unknown' },
      undraftedMapping: { kind: 'document', subject: 'unknown' },
      uncertainties: [],
    },
    { value },
    [],
    {
      packageEvidence: true,
      reportScoped: true,
      memberId: 'member:A',
      reportSubject: 'Patient: Fictional Rowan Example. DOB: 1990-03',
    },
  );
  const byPrompt = (prompt: string) => issues.find((issue) => issue.prompt === prompt)!;
  assert.equal(
    byPrompt('The printed organization can be used as a personal source label.').sourceSuggestion,
    'Fictional Harbor Clinic',
  );
  assert.deepEqual(byPrompt('Choose the printed report date interpretation.').choices, [
    { label: 'July 12, 2026', value: '2026-07-12' },
    { label: 'December 7, 2026', value: '2026-12-07' },
  ]);
  assert.deepEqual(byPrompt('Does the printed patient identity belong to you?').selfSuggestion, {
    fullName: 'Fictional Rowan Example',
    birthDate: '1990-03',
  });
  assert.deepEqual(
    byPrompt('A grounded Self name survives an ambiguous birth date suggestion.').selfSuggestion,
    { fullName: 'Fictional Rowan Example' },
  );
  assert.deepEqual(byPrompt('Use the exact printed collection timestamp.').choices, [
    { label: 'March 6, 2021 at 14:56 UTC', value: '2021-03-06T14:56:00Z' },
  ]);
  for (const prompt of [
    'A source suggestion from another member stays unavailable.',
    'An absent source label stays unavailable.',
    'A source label elsewhere in the payload stays unavailable.',
  ]) {
    assert(byPrompt(prompt));
    assert.equal(byPrompt(prompt).sourceSuggestion, undefined);
  }
  for (const prompt of [
    'A date suggestion from another member stays unavailable.',
    'An unsupported date interpretation stays unavailable.',
    'A year substring does not reduce the printed date precision.',
    'A timestamp cannot be reduced to its day.',
    'A year inside another token is not date evidence.',
    'An invalid structured date cannot degrade to its year.',
    'An informational note cannot offer a clinical date choice.',
    'A nested literal date cannot become a clinical date choice.',
  ]) {
    assert(byPrompt(prompt));
    assert.equal(byPrompt(prompt).choices, undefined);
  }
  for (const prompt of [
    'A Self suggestion from another member stays unavailable.',
    'An absent Self name stays unavailable.',
    'An ambiguous numeric birth date cannot select one interpretation.',
    'An informational note cannot offer a Self update.',
    'An unscoped identity note cannot offer a Self update.',
  ]) {
    assert(byPrompt(prompt));
    assert.equal(byPrompt(prompt).selfSuggestion, undefined);
  }

  const otherPerson = fixtureReviewIssues(
    {
      candidateVersionId: 'fictional-other-person-suggestion',
      mapping: { kind: 'document', subject: 'other' },
      undraftedMapping: { kind: 'document', subject: 'other' },
      uncertainties: [],
    },
    { value },
    [],
    {
      packageEvidence: true,
      reportScoped: true,
      memberId: 'member:A',
      reportSubject: 'Patient: Fictional Rowan Example. DOB: 1990-03',
    },
  );
  assert.equal(
    otherPerson.find(
      (issue) => issue.prompt === 'Does the printed patient identity belong to you?',
    )!.selfSuggestion,
    undefined,
  );

  const directReportConflict = structuredClone(value);
  (directReportConflict.payload as { transcript: string }).transcript +=
    ' Host-resolved subject: Fictional Different Patient.';
  const conflictingHostScope = fixtureReviewIssues(
    {
      candidateVersionId: 'fictional-host-subject-conflict',
      mapping: { kind: 'document', subject: 'unknown' },
      undraftedMapping: { kind: 'document', subject: 'unknown' },
      uncertainties: [],
    },
    { value: directReportConflict },
    [],
    {
      packageEvidence: true,
      reportScoped: true,
      memberId: 'member:A',
      reportSubject: 'Host-resolved subject: Fictional Different Patient',
    },
  );
  assert.equal(
    conflictingHostScope.find(
      (issue) => issue.prompt === 'Does the printed patient identity belong to you?',
    )!.selfSuggestion,
    undefined,
  );

  const ambiguousSubject = 'Patient: Fictional Rowan Example. DOB: 03/08/1990';
  const ambiguousHostScope = fixtureReviewIssues(
    {
      candidateVersionId: 'fictional-ambiguous-host-subject',
      mapping: { kind: 'document', subject: 'unknown' },
      undraftedMapping: { kind: 'document', subject: 'unknown' },
      uncertainties: [],
    },
    { value },
    [],
    {
      packageEvidence: true,
      reportScoped: true,
      memberId: 'member:A',
      reportSubject: ambiguousSubject,
    },
  );
  assert.deepEqual(
    ambiguousHostScope.find(
      (issue) =>
        issue.prompt === 'An ambiguous numeric birth date cannot select one interpretation.',
    )!.selfSuggestion,
    { fullName: 'Fictional Rowan Example' },
  );
});

test('model and published envelope contracts bound evidence suggestions', () => {
  assert.match(
    INTAKE_SCHEMA_INSTRUCTIONS,
    /metadataSuggestion\?:\{careArea\?:string,documentType\?:string,topics\?:string\[\]\}/,
  );
  assert.match(INTAKE_SCHEMA_INSTRUCTIONS, /exact textAnchor occurs verbatim.*envelope payload/);
  assert.match(INTAKE_SCHEMA_INSTRUCTIONS, /host-validated report\/member scope/);
  assert.match(INTAKE_SCHEMA_INSTRUCTIONS, /label itself and its textAnchor.*verbatim/);
  assert.match(
    INTAKE_SCHEMA_INSTRUCTIONS,
    /Ambiguous numeric dates may offer each valid interpretation/,
  );
  assert.match(INTAKE_SCHEMA_INSTRUCTIONS, /never select or normalize one automatically/);
  assert.match(
    INTAKE_SCHEMA_INSTRUCTIONS,
    /one unambiguous interpretation.*same supplied textAnchor/,
  );
  assert.match(
    INTAKE_SCHEMA_INSTRUCTIONS,
    /report\.subject\.text as one exact retained substring.*same payload.*contain that exact report\.subject\.text without reformatting, joining or paraphrasing/s,
  );
  assert.match(
    INTAKE_SCHEMA_INSTRUCTIONS,
    /suggested full name must occur literally in report\.subject\.text/,
  );
  assert.match(
    INTAKE_SCHEMA_INSTRUCTIONS,
    /app always supplies its own keep-unknown\/manual controls/,
  );
  assert.match(INTAKE_SCHEMA_INSTRUCTIONS, /does not certify a model transcription of a photo/);
  assert.match(INTAKE_SCHEMA_INSTRUCTIONS, /at most 12 unique topics/);
  assert.match(INTAKE_SCHEMA_INSTRUCTIONS, /another patient/);
  assert.match(INTAKE_SCHEMA_INSTRUCTIONS, /never change clinical mappings/i);
  assert.match(INTAKE_SCHEMA_INSTRUCTIONS, /explicit selection/);
  assert.match(
    INTAKE_SCHEMA_INSTRUCTIONS,
    /optional typeText:string and statusText:string.*preserving capitalization, punctuation and spacing/,
  );
  assert.match(
    INTAKE_SCHEMA_INSTRUCTIONS,
    /complete same-person signature passage.*license and signature date\/time details remain visible/,
  );

  const schema = JSON.parse(
    readFileSync(
      new URL('../../shared/schemas/health-record-v1.schema.json', import.meta.url),
      'utf8',
    ),
  ) as {
    properties: {
      reviewIssues: { $ref: string };
      clinical: { properties: { reviewIssues: { $ref: string } } };
    };
    $defs: {
      reviewIssues: {
        items: {
          properties: {
            sourceSuggestion: { $ref: string };
            metadataSuggestion: { $ref: string };
            selfSuggestion: { $ref: string };
            choices: { $ref: string };
          };
        };
      };
      metadataSuggestion: {
        additionalProperties: boolean;
        properties: { topics: { maxItems: number } };
      };
      selfSuggestion: { additionalProperties: boolean };
      dateChoices: {
        description: string;
        maxItems: number;
        items: { additionalProperties: boolean };
      };
      metadataLabel: { maxLength: number };
    };
  };
  assert.equal(schema.properties.reviewIssues.$ref, '#/$defs/reviewIssues');
  assert.equal(schema.properties.clinical.properties.reviewIssues.$ref, '#/$defs/reviewIssues');
  assert.equal(
    schema.$defs.reviewIssues.items.properties.metadataSuggestion.$ref,
    '#/$defs/metadataSuggestion',
  );
  assert.equal(
    schema.$defs.reviewIssues.items.properties.sourceSuggestion.$ref,
    '#/$defs/metadataLabel',
  );
  assert.equal(
    schema.$defs.reviewIssues.items.properties.selfSuggestion.$ref,
    '#/$defs/selfSuggestion',
  );
  assert.equal(schema.$defs.reviewIssues.items.properties.choices.$ref, '#/$defs/dateChoices');
  assert.equal(schema.$defs.metadataSuggestion.additionalProperties, false);
  assert.equal(schema.$defs.metadataSuggestion.properties.topics.maxItems, 12);
  assert.equal(schema.$defs.selfSuggestion.additionalProperties, false);
  assert.equal(schema.$defs.dateChoices.maxItems, 20);
  assert.equal(schema.$defs.dateChoices.items.additionalProperties, false);
  assert.match(schema.$defs.dateChoices.description, /New converter output contract/);
  assert.equal(schema.$defs.metadataLabel.maxLength, 200);
});

test('reviewed source labels affect new accepted attribution, while repeated identity keeps prior clinical history', (t) => {
  const f = fixture(t),
    value = document({ subject: 'self', uncertainties: [] });
  let item = call(f, 'uploadIntake', {
    filename: 'source.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  const acquisitionId = item.providerId;
  item = call(f, 'updateIntakeMetadata', item.id, {
    version: item.version,
    operationId: 'source-one',
    metadata: { source: 'First Reviewed Clinic' },
  });
  const firstProvider = item.providerId;
  assert.notEqual(firstProvider, acquisitionId);
  item = accept(f, item);
  assert.equal(f.db.prepare('SELECT provider_id FROM documents').get()!.provider_id, firstProvider);
  assert.equal(
    f.db.prepare('SELECT provider_id FROM source_records').get()!.provider_id,
    acquisitionId,
  );
  const before = f.db.prepare('SELECT * FROM documents').get()!;
  item = call(f, 'updateIntakeMetadata', item.id, {
    version: item.version,
    operationId: 'source-two',
    metadata: { source: 'Second Reviewed Clinic' },
  });
  item = accept(f, item);
  assert.equal(item.imported.clinical.duplicates, 1);
  assert.deepEqual(f.db.prepare('SELECT * FROM documents').get()!, before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get()!.n, 1);
  assert.equal(item.importHistory.length, 1);
  assert.equal(item.importHistory[0].acceptedProposalId, null);
  assert.ok('reviewToken' in item.importHistory[0]);
  assert.ok(!('proposalId' in item.importHistory[0]));
});

test('Remove from review uses reversible visibility and preserves the original', (t) => {
  const f = fixture(t),
    bytes = Buffer.from('Fictional retained upload');
  let item = call(f, 'uploadIntake', { filename: 'original.txt', bytes });
  assert.equal(item.archived, false);
  setVisibility(f.db, 'source_file', item.id, { archived: true, version: item.visibilityVersion });
  item = call(f, 'getIntake', item.id);
  assert.equal(item.archived, true);
  assert.equal(intake.listIntakes(f.db, f.profileId).total, 0);
  assert.equal(intake.listIntakes(f.db, f.profileId, { visibility: 'archived' }).total, 1);
  assert.deepEqual(call(f, 'getIntakeOriginal', item.id).bytes, bytes);
  setVisibility(f.db, 'source_file', item.id, { archived: false, version: item.visibilityVersion });
  assert.equal(intake.listIntakes(f.db, f.profileId).total, 1);
});

test('earlier top-level document exceptions remain applicable without rewriting their original fingerprints', (t) => {
  const f = fixture(t),
    value = document({ uncertainties: [] });
  let item = call(f, 'uploadIntake', {
    filename: 'old-document.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  let record = call(f, 'reviewIntake', item.id).records[0]!;
  item = draft(f, item, record, {
    mapping: { documentTitle: 'Fictional legacy reviewed title' },
    resolutions: record.issues
      .filter((i) => i.kind === 'identity')
      .map((i) => ({ issueId: i.id, outcome: 'this_is_me' })),
  });
  item = accept(f, item);
  const batch = f.db
    .prepare("SELECT id,coverage_json FROM manual_batches WHERE title='Import record exception'")
    .get()!;
  const saved = JSON.parse(String(batch.coverage_json));
  const original = mappingFrom({ value });
  const legacyVersion = clinicalSourceVersion({
    ...original,
    kind: 'unsupported',
    subject: 'unknown',
    uncertainties: [],
  });
  saved.recordException.sourceVersion = legacyVersion;
  f.db
    .prepare('UPDATE manual_batches SET coverage_json=? WHERE id=?')
    .run(JSON.stringify(saved), batch.id);
  record = call(f, 'reviewIntake', item.id).records[0]!;
  assert.equal(record.recordException.sourceVersion, legacyVersion);
  assert.equal(record.mapping.subject, 'self');
  assert.equal(record.classification, 'duplicate');
  assert.equal(
    JSON.parse(
      String(
        f.db.prepare('SELECT coverage_json FROM manual_batches WHERE id=?').get(batch.id)!
          .coverage_json,
      ),
    ).recordException.sourceVersion,
    legacyVersion,
  );
});

test('Keep date unconfirmed clears both reviewed date fields and preserves the original literal assertion', (t) => {
  const f = fixture(t),
    value = document({
      subject: 'self',
      uncertainties: [],
      clinical: {
        kind: 'document',
        subject: 'self',
        documentTitle: 'Fictional dated report',
        date: '2026-08-10',
        documentDate: 'invalid original date',
        uncertainties: ['Confirm which date belongs to this document'],
      },
      reviewIssues: [
        { kind: 'date', field: 'date', prompt: 'Confirm which date belongs to this document' },
      ],
    });
  let item = call(f, 'uploadIntake', {
    filename: 'date.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  const record = call(f, 'reviewIntake', item.id).records[0]!;
  item = draft(f, item, record, {
    resolutions: record.issues
      .filter((i) => i.kind === 'date')
      .map((i) => ({ issueId: i.id, outcome: 'unknown' })),
  });
  const reviewed = call(f, 'reviewIntake', item.id).records[0]!;
  assert.equal(reviewed.mapping.date, '');
  assert.equal(reviewed.mapping.documentDate, '');
  item = accept(f, item);
  const saved = f.db.prepare('SELECT effective_at,extra_json FROM documents').get()!;
  assert.equal(saved.effective_at, null);
  assert.equal(
    JSON.parse(String(saved.extra_json)).import.originalMapping.documentDate,
    'invalid original date',
  );
  assert.equal(
    f.db.prepare('SELECT raw_json FROM source_records').get()!.raw_json,
    JSON.stringify(value),
  );
  assert.equal(item.workflow.questions.length, 0);
  assert.equal(item.state, 'imported');
});

test('conversion awaits failed capability preflight before creating or linking a chat', async (t) => {
  const f = fixture(t),
    item = call(f, 'uploadIntake', {
      filename: 'original.pdf',
      bytes: Buffer.from('%PDF-1.4\nFictional'),
    });
  const expected = new Error('Fictional capability unavailable');
  let checked = false,
    created = false;
  await assert.rejects(
    handleIntakeRoute({
      resource: 'intakes',
      id: item.id,
      action: 'convert',
      method: 'POST',
      params: new URLSearchParams(),
      req: { headers: { 'content-type': 'application/json' } } as IncomingMessage,
      body: async () => Buffer.from(JSON.stringify({ version: item.version })),
      respond: () => undefined,
      list: () => undefined,
      ...f,
      assistant: {
        isBusy: () => false,
        ensureConnection: async (options: Record<string, unknown>, id: string) => {
          assert.deepEqual(options, { image: false, pdf: true });
          assert.equal(id, f.profileId);
          checked = true;
          throw expected;
        },
        create: () => {
          created = true;
          throw new Error('Unexpected assistant creation');
        },
      } as unknown as Parameters<typeof handleIntakeRoute>[0]['assistant'],
    }),
    expected,
  );
  assert.equal(checked, true);
  assert.equal(created, false);
  assert.equal(call(f, 'getIntake', item.id).conversionChatId, null);
  assert.equal(call(f, 'getIntake', item.id).version, item.version);
});

test('encrypted cache loss reconstructs source metadata, pending draft resolutions and original bytes', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'circus-encrypted-review-')),
    dataDirectory = join(base, 'data'),
    runtimeDirectory = join(base, 'runtime');
  mkdirSync(dataDirectory);
  const manager = createEncryptedProfiles({ dataDirectory, runtimeDirectory });
  t.after(() => {
    manager.close();
    rmSync(base, { recursive: true, force: true });
  });
  const setup = manager.begin({
    fullName: 'Fictional Review Person',
    birthDate: '1982-04-17',
    name: 'Fictional Review Person',
  });
  const profile = await manager.verify(setup.setupId, {
    acknowledged: true,
    recovery: setup.recoveryKit,
  });
  let state = manager.opened.get(profile.id)!,
    f = { db: state.db, root: state.root, profileId: profile.id };
  const bytes = Buffer.from('%PDF-1.4\nFictional encrypted source bytes');
  let item = propose(f, call(f, 'uploadIntake', { filename: 'encrypted.pdf', bytes }), document());
  item = call(f, 'updateIntakeMetadata', item.id, {
    version: item.version,
    operationId: 'encrypted-metadata',
    metadata: { source: 'Fictional Private Clinic', topics: ['Fictional private topic'] },
  });
  let record = call(f, 'reviewIntake', item.id, item.proposals[0]!.id).records[0]!;
  item = draft(f, item, record, {
    disposition: 'review_later',
    mapping: { documentTitle: 'Encrypted pending title' },
    resolutions: [
      { issueId: record.issues.find((i) => i.kind === 'identity')!.id, outcome: 'this_is_me' },
    ],
  });
  const retained = structuredClone(item);
  manager.lock(profile.id);
  const durableRoot = join(dataDirectory, 'profiles', profile.id);
  function files(path: string): string[] {
    return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)],
    );
  }
  assert(
    files(durableRoot).every(
      (path) => !readFileSync(path).includes(Buffer.from('Encrypted pending title')),
    ),
  );
  rmSync(join(durableRoot, 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, setup.recoveryKit);
  state = manager.opened.get(profile.id)!;
  assert.equal(state.metrics.cacheHit, false);
  f = { db: state.db, root: state.root, profileId: profile.id };
  item = call(f, 'getIntake', item.id);
  assert.deepEqual(item.workflow, retained.workflow);
  assert.deepEqual(item.metadataHistory, retained.metadataHistory);
  assert.deepEqual(item.acquisition, retained.acquisition);
  assert.deepEqual(call(f, 'getIntakeOriginal', item.id).bytes, bytes);
  record = call(f, 'reviewIntake', item.id, item.proposals[0]!.id).records[0]!;
  assert.equal(record.mapping.documentTitle, 'Encrypted pending title');
  assert.equal(record.mapping.subject, 'self');
  assert.equal(record.draft.disposition, 'review_later');
  assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get()!.n, 0);
  item = draft(f, item, record, {
    operationId: 'encrypted-keep',
    disposition: 'keep_original_only',
  });
  manager.lock(profile.id);
  rmSync(join(durableRoot, 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, setup.recoveryKit);
  state = manager.opened.get(profile.id)!;
  const recovered = intake.getIntake(state.db, state.root, profile.id, item.id);
  assert.deepEqual(recovered.workflow, item.workflow);
  assert.equal(recovered.state, 'kept_original');
});

test('legacy accepted envelopes with invalid optional hints rebuild with the same receipt', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'circus-legacy-suggestion-rebuild-')),
    dataDirectory = join(base, 'data'),
    runtimeDirectory = join(base, 'runtime');
  mkdirSync(dataDirectory);
  const manager = createEncryptedProfiles({ dataDirectory, runtimeDirectory });
  t.after(() => {
    manager.close();
    rmSync(base, { recursive: true, force: true });
  });
  const setup = manager.begin({
    fullName: 'Fictional Legacy Person',
    birthDate: '1982-04-17',
    name: 'Fictional Legacy Person',
  });
  const profile = await manager.verify(setup.setupId, {
    acknowledged: true,
    recovery: setup.recoveryKit,
  });
  let state = manager.opened.get(profile.id)!,
    f = { db: state.db, root: state.root, profileId: profile.id };
  const bytes = Buffer.from('%PDF-1.4\nFictional legacy suggestion source');
  const value = document({
    subject: 'self',
    uncertainties: [],
    mappingReview: undefined,
    reviewIssues: [
      {
        id: 'legacy-unanchored-hints',
        kind: 'information',
        prompt: 'A retained legacy note remains readable.',
        sourceSuggestion: 'x'.repeat(201),
        selfSuggestion: { fullName: 'Unanchored Legacy Name' },
        choices: [{ label: 'Keep unknown', value: '' }],
      },
    ],
  });
  let item = propose(
    f,
    call(f, 'uploadIntake', { filename: 'legacy-suggestion.pdf', bytes }),
    value,
  );
  const legacyReview = call(f, 'reviewIntake', item.id, item.proposals[0]!.id);
  const legacyRecord = legacyReview.records[0]!;
  const issue = legacyRecord.issues.find(
    (candidate) => candidate.prompt === 'A retained legacy note remains readable.',
  )!;
  assert.equal(issue.sourceSuggestion, undefined);
  assert.equal(issue.selfSuggestion, undefined);
  assert.equal(issue.choices, undefined);
  item = draft(f, item, legacyRecord, {
    mapping: legacyRecord.mapping,
    resolutions: [
      {
        issueId: legacyRecord.issues.find((candidate) => candidate.kind === 'identity')!.id,
        outcome: 'this_is_me',
      },
    ],
    disposition: 'review_later',
  });
  item = accept(f, item);
  const imported = structuredClone(item.imported);
  const importHistory = structuredClone(item.importHistory);
  const durableRoot = join(dataDirectory, 'profiles', profile.id);
  manager.lock(profile.id);
  rmSync(join(durableRoot, 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, setup.recoveryKit);
  state = manager.opened.get(profile.id)!;
  f = { db: state.db, root: state.root, profileId: profile.id };
  const recovered = call(f, 'getIntake', item.id);
  assert.deepEqual(recovered.imported, imported);
  assert.deepEqual(recovered.importHistory, importHistory);
  assert.deepEqual(call(f, 'getIntakeOriginal', item.id).bytes, bytes);
  assert.equal(
    call(f, 'reviewIntake', item.id, recovered.proposals[0]!.id).records[0]!.reviewState,
    'accepted',
  );
});

test('explicit unknown date clearing accepts the browser payload but rejects corrections to uncertain fields', (t) => {
  const f = fixture(t);
  const value = document({
    subject: 'self',
    uncertainties: [],
    clinical: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional dated record',
      date: '2026-08-10',
      documentDate: '2026-08-10',
    },
    reviewIssues: [
      { id: 'date', kind: 'date', field: 'date', prompt: 'Choose the supported date' },
      { id: 'reading', kind: 'uncertain_reading', field: 'text', prompt: 'Check this reading' },
    ],
  });
  let item = call(f, 'uploadIntake', {
    filename: 'browser-date.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  const record = call(f, 'reviewIntake', item.id).records[0]!;
  const dateIssue = record.issues.find((issue) => issue.kind === 'date')!;
  const readingIssue = record.issues.find((issue) => issue.kind === 'uncertain_reading')!;
  for (const [issueId, mapping] of [
    [dateIssue.id, { date: '2026-08-11', documentDate: '' }],
    [dateIssue.id, { date: '', documentDate: '', text: 'Replacement assertion' }],
    [readingIssue.id, { text: '' }],
    [readingIssue.id, { date: '', documentDate: '' }],
  ]) {
    assert.throws(
      () =>
        draft(f, item, record, {
          resolutions: [{ issueId, outcome: 'unknown', mapping }],
        }),
      { code: 'REVIEW_RESOLUTION' },
    );
    assert.equal(call(f, 'getIntake', item.id).version, item.version);
  }
  const mapping = { ...record.mapping, date: '', documentDate: '' };
  item = draft(f, item, record, {
    mapping,
    decision: { recordId: record.id, action: 'accept', mapping },
    answers: {},
    resolutions: [
      { issueId: dateIssue.id, outcome: 'unknown', mapping: { date: '', documentDate: '' } },
    ],
  });
  let reloaded = call(f, 'reviewIntake', item.id).records[0]!;
  assert.equal(reloaded.mapping.date, '');
  assert.equal(reloaded.mapping.documentDate, '');
  assert.equal(reloaded.issues.find((issue) => issue.id === dateIssue.id)!.blocking, false);
  assert.deepEqual(reloaded.draft.resolutions[0]!.mapping, { date: '', documentDate: '' });
  item = draft(f, item, reloaded, {
    operationId: 'hydrated-date-replay',
    mapping: reloaded.mapping,
    resolutions: reloaded.draft.resolutions,
    disposition: 'review_later',
  });
  reloaded = call(f, 'reviewIntake', item.id).records[0]!;
  assert.equal(reloaded.draft.resolutions.length, 1);
  assert.equal(reloaded.draft.disposition, 'review_later');
  assert.deepEqual(call(f, 'getIntakeOriginal', item.id).bytes, Buffer.from(JSON.stringify(value)));
});

test('explanatory source-date notes remain informational and retained old questions cannot clear a valid date', (t) => {
  const f = fixture(t);
  const prompt = 'Source date field is effective; original date role retained in payload.';
  assert.equal(issueKind(prompt), 'information');
  assert.equal(issueKind('Patient identity is retained in the original payload.'), 'information');
  assert.equal(issueKind('Confirm which date is supported by the source'), 'date');
  assert.equal(issueKind('The printed date is ambiguous'), 'information');
  assert.equal(issueKind('The date order is not stated; no ISO date was inferred.'), 'information');
  assert.equal(issueKind('A date needs review', 'documentDate'), 'date');
  const value = document({
    subject: 'self',
    uncertainties: [],
    clinical: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional dated export',
      date: '2026-06-21',
      documentDate: '2026-06-21',
      uncertainties: [prompt],
    },
  });
  let item = call(f, 'uploadIntake', {
    filename: 'fictional-date-provenance.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  let record = call(f, 'reviewIntake', item.id).records[0]!;
  assert.equal(item.workflow.questions.length, 0, 'explanatory prose creates no new question');
  assert.equal(record.issues.find((issue) => issue.prompt === prompt)!.kind, 'information');
  assert.equal(
    record.issues.some((issue) => issue.kind === 'date'),
    false,
  );
  // Retain the exact question shape produced by older converters. Reading the
  // new classification must not delete or silently answer its saved history.
  item = call(f, 'askIntakeQuestion', item.id, {
    version: item.version,
    key: 'legacy-date-provenance',
    prompt,
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    locator: record.evidence[0]!.locator,
  });
  const retainedQuestions = structuredClone(item.workflow.questions);
  record = call(f, 'reviewIntake', item.id).records[0]!;
  const issue = record.issues.find((entry) => entry.questionId)!;
  assert.equal(issue.kind, 'information');
  assert.equal(issue.field, null);
  assert.throws(
    () =>
      call(f, 'answerIntakeQuestion', item.id, {
        version: item.version,
        operationId: 'unsafe-informational-date-answer',
        questionId: issue.questionId,
        answer: 'Keep unconfirmed',
        mapping: { date: '', documentDate: '' },
      }),
    { code: 'QUESTION_MAPPING' },
  );
  for (const outcome of ['unknown', 'corrected', 'confirmed']) {
    assert.throws(
      () =>
        draft(f, item, record, {
          resolutions: [{ issueId: issue.id, outcome, mapping: { date: '', documentDate: '' } }],
        }),
      { code: 'REVIEW_RESOLUTION' },
    );
  }
  assert.equal(call(f, 'getIntake', item.id).version, item.version);
  item = draft(f, item, record, { resolutions: [{ issueId: issue.id, outcome: 'unknown' }] });
  assert.equal(call(f, 'reviewIntake', item.id).records[0]!.mapping.documentDate, '2026-06-21');
  item = accept(f, item);
  assert.equal(
    f.db.prepare('SELECT effective_at FROM documents').get()!.effective_at,
    '2026-06-21',
  );
  assert.deepEqual(item.workflow.questions, retainedQuestions);
  assert.equal(item.unansweredCount, 0);
  assert.equal(item.needsReview, false);
  assert.equal(
    f.db.prepare('SELECT raw_json FROM source_records').get()!.raw_json,
    JSON.stringify(value),
  );
});

test('unscoped legacy date questions retain dates until an explicitly scoped date review corrects them', (t) => {
  const f = fixture(t);
  const value = document({
    subject: 'self',
    uncertainties: [],
    clinical: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional date interpretation',
      date: '2026-04-03',
      documentDate: '2026-04-03',
      uncertainties: ['Confirm the printed date'],
    },
  });
  let item = call(f, 'uploadIntake', {
    filename: 'fictional-unscoped-date.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  let record = call(f, 'reviewIntake', item.id).records[0]!;
  const issue = record.issues.find((entry) => entry.questionId)!;
  assert.equal(issue.kind, 'information');
  assert.equal(issue.field, null);
  assert.deepEqual(resolutionFields(issue), []);
  assert.equal(item.unansweredCount, 0);
  assert.throws(
    () =>
      draft(f, item, record, {
        resolutions: [{ issueId: issue.id, outcome: 'corrected', mapping: { date: '2026-03-04' } }],
      }),
    { code: 'REVIEW_RESOLUTION' },
  );
  item = draft(f, item, record, {
    disposition: 'review_later',
    resolutions: [{ issueId: issue.id, outcome: 'unknown' }],
  });
  record = call(f, 'reviewIntake', item.id).records[0]!;
  assert.equal(record.mapping.date, '2026-04-03');
  assert.equal(record.mapping.documentDate, '2026-04-03');
  item = call(f, 'askIntakeQuestion', item.id, {
    version: item.version,
    key: 'explicit-date-interpretation',
    field: 'date',
    prompt: 'Choose the source-supported date',
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    locator: record.evidence[0]!.locator,
  });
  record = call(f, 'reviewIntake', item.id).records[0]!;
  const scoped = record.issues.find((entry) => entry.field === 'date')!;
  item = draft(f, item, record, {
    operationId: 'explicit-date-choice',
    resolutions: [
      {
        issueId: scoped.id,
        outcome: 'corrected',
        mapping: { date: '2026-03-04', documentDate: '2026-03-04' },
      },
    ],
  });
  item = accept(f, item);
  assert.equal(
    f.db.prepare('SELECT effective_at FROM documents').get()!.effective_at,
    '2026-03-04',
  );
});
