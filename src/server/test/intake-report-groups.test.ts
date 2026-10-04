import { selectedReportGroups } from '../intake-selected-report-groups.ts';
import { attachPersonalDurability } from '../portable.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTAKE_SCHEMA_INSTRUCTIONS, validateJSONL } from '../intake-format.ts';
import { intakeWorkflow, recordCandidateVersions, workflowSummary } from '../intake-workflow.ts';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import { createBackup } from '../recovery.ts';
import { rebuildProfile } from '../portable.ts';
import { listIntakeReportQueue } from '../intake-report-queue.ts';
import { observations } from '../queries.ts';
import { getNote, saveNote } from '../notes.ts';
import { getIntakeIdentityReview, confirmIntakeIdentityScope } from '../intake-identity.ts';
import type { HealthRecordEnvelope, Intake, IntakeReportReference } from '../../shared/intake.ts';

const report = (
  text = 'DEXA report FICT-72',
  locator = 'page 1 heading',
): IntakeReportReference => ({
  key: 'printed-report',
  title: 'Fictional bone density report',
  anchor: { locator, text },
  subject: { locator: 'page 1 patient', text: 'Fictional Fern Example' },
});
function setFictionalSelf(db: ReturnType<typeof openDatabase>) {
  const self = getNote(db, 'person-note:self');
  saveNote(db, self.id, {
    version: self.version,
    person: { ...self.person, fullName: 'Fictional Fern Example' },
  });
}
function withMatchedSelfEvidence(value: HealthRecordEnvelope): HealthRecordEnvelope {
  const subject = value.report!.subject!.text;
  value.payload = {
    ...(typeof value.payload === 'object' && value.payload !== null ? value.payload : {}),
    literal: typeof value.payload === 'string' ? value.payload : undefined,
    identityText: subject,
  };
  value.reviewIssues = [
    ...(Array.isArray(value.reviewIssues) ? value.reviewIssues : []),
    {
      kind: 'identity',
      field: 'subject',
      prompt: 'Does the printed fictional patient identity belong to you?',
      textAnchor: subject,
      selfSuggestion: { fullName: 'Fictional Fern Example' },
    },
  ];
  return value;
}
const envelope = (
  id: string,
  reference: IntakeReportReference | undefined = report(),
): HealthRecordEnvelope => ({
  format: 'health-record-v1',
  id,
  kind: 'record',
  payload: { literal: '12.00' },
  provenance: {
    capturedVia: 'Fictional delivery',
    sourceSystem: 'Fictional issuer',
    sourceRecordId: id,
    evidenceClass: 'provider_export',
    locator: 'page 1 result ' + id,
  },
  coverage: { status: 'complete_response', notes: [] },
  clinical: {
    kind: 'observation',
    subject: 'self',
    testLabel: 'Fictional measurement ' + id,
    valueText: '12.00',
    unit: 'mg',
    date: '2026-09',
  },
  ...(reference ? { report: reference } : {}),
});
function entries(values: HealthRecordEnvelope[]) {
  const result = validateJSONL(
    Buffer.from(values.map((value) => JSON.stringify(value)).join('\n')),
  );
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.ok(result.valid);
  return result.entries;
}
const file = { id: 'source:fictional', sha256: 'fictional-original-hash' };
function groups(item: Intake) {
  assert.ok(item.workflow?.reportGroups);
  return item.workflow.reportGroups;
}
async function confirmFictionalGroup(
  db: ReturnType<typeof openDatabase>,
  root: string,
  profileId: string,
  intakeId: string,
  groupId: string,
) {
  const review = await getIntakeIdentityReview(db, root, profileId, intakeId, groupId);
  assert.ok(review.scope?.original);
  assert.match(
    intake.getIntakeOriginal(db, root, profileId, intakeId).bytes.toString('utf8'),
    /Fictional Fern Example/,
  );
  if (review.blocking)
    await confirmIntakeIdentityScope(db, root, profileId, intakeId, {
      version: review.scope.intakeVersion,
      operationId: `confirm-fictional-${groupId}`,
      scope: review.scope,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_identity_questions',
    });
}

test('one anchored DEXA report keeps 28 independent candidates, sections and retry-stable references', () => {
  const details = { workflow: intakeWorkflow({}) };
  const rows = Array.from({ length: 28 }, (_, i) =>
    envelope('result-' + i, {
      ...report(),
      section: {
        key: i < 14 ? 'spine' : 'hip',
        title: i < 14 ? 'Spine' : 'Hip',
        anchor: {
          locator: i < 14 ? 'page 1 section' : 'page 2 section',
          text: i < 14 ? 'Lumbar spine' : 'Left hip',
        },
      },
    }),
  );
  recordCandidateVersions(file, details, entries(rows), 'proposal:dexa', 'batch:dexa');
  const workflow = details.workflow;
  assert.equal(workflow.candidates.length, 28);
  assert.equal(workflow.reportGroups!.length, 1);
  const group = workflow.reportGroups![0]!;
  assert.equal(group.basis, 'report_anchor');
  assert.equal(group.versions.length, 1);
  assert.equal(group.versions[0]!.members.length, 28);
  assert.equal(new Set(group.versions[0]!.members.map((member) => member.candidateId)).size, 28);
  assert.equal(new Set(group.versions[0]!.members.map((member) => member.section?.key)).size, 2);
  const retained = structuredClone(workflow);
  recordCandidateVersions(file, details, entries(rows), 'proposal:dexa', 'batch:dexa');
  assert.deepEqual(workflow, retained);
  assert.equal(workflow.decisions.length, 0);
  assert.equal(workflowSummary(details).pendingCount, 28);
});

test('shared dates, model keys, source record IDs and outer ZIP cannot collapse reports or subjects', () => {
  const details = { workflow: intakeWorkflow({}) };
  const rows = [
    envelope('same-id'),
    envelope('different-id', report('Different printed report', 'page 2 heading')),
    envelope('same-id', {
      ...report(),
      subject: { locator: 'page 1 patient', text: 'Fictional Rowan Example' },
    }),
    {
      ...envelope('issuer'),
      provenance: { ...envelope('issuer').provenance, sourceSystem: 'Other fictional issuer' },
    },
    { ...envelope('other-subject'), clinical: { kind: 'observation', subject: 'other' } },
  ];
  recordCandidateVersions(file, details, entries(rows), 'proposal:multi');
  assert.equal(details.workflow.reportGroups!.length, 5);
  assert.equal(details.workflow.candidates.length, 5);
  const packageDetails = { workflow: intakeWorkflow({}) };
  const packageRows = [
    envelope('a'),
    envelope('b'),
    envelope('same-id', { ...report(), memberId: 'unknown-A' }),
    envelope('same-id', { ...report(), memberId: 'unknown-B' }),
  ];
  recordCandidateVersions(
    { ...file, mime_type: 'application/zip' },
    packageDetails,
    entries(packageRows),
    'proposal:package',
  );
  assert.equal(packageDetails.workflow.reportGroups!.length, 4);
  assert.ok(
    packageDetails.workflow.reportGroups!.every((group) => group.basis === 'candidate_fallback'),
  );
});

test('host-known package occurrences scope shared anchors and result IDs independently', () => {
  const details = { workflow: intakeWorkflow({}) };
  details.workflow.plans.push({
    id: 'plan:fictional',
    createdAt: '2026-09-01',
    status: 'active',
    pins: {
      sourceHash: file.sha256,
      backend: 'fictional',
      model: null,
      reasoningEffort: null,
      instructionVersion: 'fictional',
      mappingVersion: 'fictional',
    },
    index: {
      kind: 'package',
      coverage: 'inventory_only',
      missingAssets: [],
      members: ['member:a', 'member:b'].map((memberId, ordinal) => ({
        memberId,
        ordinal,
        filename: 'duplicate-name.pdf',
        locator: memberId,
        bytes: 10,
        compressedBytes: 10,
        sourceHash: 'identical-bytes',
        duplicateOf: ordinal ? 'member:a' : null,
      })),
    },
    units: [],
    batches: [],
  });
  recordCandidateVersions(
    { ...file, mime_type: 'application/zip' },
    details,
    entries(
      ['member:a', 'member:b'].flatMap((memberId) => [
        envelope('result-a', { ...report(), memberId }),
        envelope('result-b', { ...report(), memberId }),
      ]),
    ),
    'proposal:package',
  );
  assert.equal(details.workflow.candidates.length, 4);
  assert.equal(details.workflow.reportGroups!.length, 2);
  assert.ok(
    details.workflow.reportGroups!.every(
      (group) => group.basis === 'report_anchor' && group.versions[0]!.members.length === 2,
    ),
  );
});

test('later contributions append history without erasing accepted versions or rolling back on retries', () => {
  const details = { workflow: intakeWorkflow({}) };
  const first = envelope('first');
  recordCandidateVersions(file, details, entries([first]), 'proposal:first');
  details.workflow.candidates[0]!.versions[0]!.status = 'accepted';
  const accepted = structuredClone(details.workflow.candidates[0]!.versions[0]);
  const oldGroup = structuredClone(details.workflow.reportGroups![0]!.versions[0]);
  const changed = { ...first, payload: { literal: '13.00' } };
  recordCandidateVersions(file, details, entries([changed, envelope('second')]), 'proposal:second');
  const group = details.workflow.reportGroups![0]!;
  assert.equal(group.versions.length, 2);
  assert.deepEqual(group.versions[0], oldGroup);
  assert.deepEqual(details.workflow.candidates[0]!.versions[0], accepted);
  assert.equal(details.workflow.candidates[0]!.versions[1]!.status, 'pending');
  assert.equal(group.versions[1]!.members.length, 3);
  const stable = structuredClone(group);
  recordCandidateVersions(file, details, entries([first]), 'proposal:first');
  assert.deepEqual(group, stable);
  recordCandidateVersions(file, details, entries([first]), 'proposal:third');
  assert.equal(group.versions.length, 3);
  assert.equal(group.versions[2]!.members[0]!.occurrences.length, 2);
  assert.deepEqual(group.versions.slice(0, 2), stable.versions);
});

test('legacy workflows derive stable independent fallback groups without rewriting durable history', () => {
  const details = { workflow: intakeWorkflow({}) };
  const values = [envelope('legacy-a'), envelope('legacy-b')];
  for (const value of values) delete value.report;
  recordCandidateVersions(file, details, entries(values), null);
  delete details.workflow.reportGroups;
  const original = structuredClone(details);
  const first = workflowSummary(details),
    second = workflowSummary(details);
  assert.equal(first.workflow.reportGroups.length, 2);
  assert.ok(
    first.workflow.reportGroups.every(
      (group) => group.basis === 'candidate_fallback' && group.sourceFileId === null,
    ),
  );
  assert.deepEqual(first, second);
  assert.deepEqual(details, original);
});

test('malformed or oversized report claims fail schema validation; absent claims remain valid', () => {
  for (const invalid of [
    null,
    {},
    { ...report(), subject: undefined },
    { ...report(), anchor: { locator: '', text: 'x' } },
    { ...report(), memberId: 1 },
    { ...report(), section: { key: 'x' } },
    { ...report(), title: 'x'.repeat(1001) },
  ]) {
    const result = validateJSONL(
      Buffer.from(JSON.stringify({ ...envelope('invalid'), report: invalid })),
    );
    assert.equal(result.valid, false);
    assert.match(result.issues[0]!.message, /Report reference/);
  }
  const legacy = envelope('legacy');
  delete legacy.report;
  assert.equal(entries([legacy]).length, 1);
});

test('durable grouped acceptance, changed identity drafts, proposal replay and rebuild remain independent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-report-groups-'));
  const profileId = 'cookie-dough';
  let db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId: profileId });
  setFictionalSelf(db);
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const values = Array.from({ length: 28 }, (_, i) =>
    withMatchedSelfEvidence(envelope('measurement-' + i)),
  );
  const bytes = Buffer.from(values.map((value) => JSON.stringify(value)).join('\n'));
  let item: Intake = intake.uploadIntake(db, root, profileId, {
    filename: 'fictional-report.jsonl',
    bytes,
    newProviderName: 'Fictional clinic',
  });
  await confirmFictionalGroup(db, root, profileId, item.id, groups(item)[0]!.id);
  let review = intake.reviewIntake(db, root, profileId, item.id);
  assert.equal(review.records.length, 28);
  assert.ok(
    review.records.every((record) => selectedReportGroups(record.reportGroups).length === 1),
  );
  assert.equal(
    new Set(
      review.records.map((record) => selectedReportGroups(record.reportGroups).at(0)!.groupId),
    ).size,
    1,
  );
  item = intake.importIntake(db, root, profileId, item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  assert.equal(item.pendingCount, 27);
  assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  const acceptedDecisions = structuredClone(item.workflow!.decisions);
  const originalGroup = structuredClone(groups(item)[0]!.versions[0]);
  const changed = {
    ...values[0]!,
    payload: { literal: '13.00' },
    clinical: {
      ...(values[0]!.clinical as object),
      valueText: '13.00',
    },
    reviewIssues: [
      {
        id: 'identity',
        kind: 'identity',
        prompt: 'Does this finding belong to you?',
        field: 'subject',
        textAnchor: 'Fictional Fern Example',
      },
    ],
  };
  const proposalText = JSON.stringify(changed);
  item = intake.proposeConversion(db, root, profileId, item.id, {
    version: item.version,
    jsonlText: proposalText,
    summary: 'Fictional changed result',
  });
  const proposalId = item.proposals[0]!.id;
  review = intake.reviewIntake(db, root, profileId, item.id, proposalId);
  const pending = review.records[0]!;
  assert.equal(pending.reviewState, 'pending');
  assert.equal(pending.draft, null);
  assert.ok(
    pending.issues!.some((issue) => issue.kind === 'identity' && issue.status === 'unresolved'),
  );
  const identity = pending.issues!.find((issue) => issue.kind === 'identity')!;
  item = intake.saveIntakeReviewDraft(db, root, profileId, item.id, {
    version: review.version,
    operationId: 'fictional-confirm-one',
    proposalId,
    recordId: pending.id,
    candidateVersionId: pending.candidateVersionId!,
    resolutions: [{ issueId: identity.id, outcome: 'this_is_me' }],
  });
  const newer = { ...changed, payload: { literal: '14.00' } };
  item = intake.proposeConversion(db, root, profileId, item.id, {
    version: item.version,
    jsonlText: JSON.stringify(newer),
    summary: 'Fictional later evidence',
  });
  const newerId = item.proposals.at(-1)!.id;
  const newerReview = intake.reviewIntake(db, root, profileId, item.id, newerId);
  assert.equal(newerReview.records[0]!.draft, null);
  assert.equal(newerReview.records[0]!.reviewState, 'pending');
  assert.ok(
    newerReview.records[0]!.issues!.some(
      (issue) => issue.kind === 'identity' && issue.status === 'unresolved',
    ),
  );
  assert.deepEqual(item.workflow!.decisions, acceptedDecisions);
  assert.deepEqual(groups(item)[0]!.versions[0], originalGroup);
  const stable = structuredClone(item.workflow);
  item = intake.proposeConversion(db, root, profileId, item.id, {
    version: item.version,
    jsonlText: proposalText,
    summary: 'Retry',
  });
  assert.deepEqual(item.workflow, stable);
  assert.equal(
    intake.reviewIntake(db, root, profileId, item.id).records[0]!.reviewState,
    'accepted',
  );
  const backup = await createBackup(db, root, profileId);
  const target = join(root, 'rebuilt');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), profileId, target);
  db.close();
  db = openDatabase(rebuilt.database, profileId);
  attachPersonalDurability(db, { root: target, profileId: profileId });
  const restored = intake.getIntake(db, target, profileId, item.id);
  assert.deepEqual(restored.workflow, item.workflow);
  assert.deepEqual(intake.getIntakeOriginal(db, target, profileId, item.id).bytes, bytes);
  assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.deepEqual(
    intake.reviewIntake(db, target, profileId, item.id, newerId).records[0]!.reportGroups,
    newerReview.records[0]!.reportGroups,
  );
});

test('an optical report remains one Vision document with independently retained right and left fields', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-optical-report-group-'));
  const profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId: profileId });
  setFictionalSelf(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const prescription = {
    type: 'spectacle',
    eyes: [
      {
        side: 'right',
        sideText: 'OD',
        sph: { valueText: '+02.25' },
        cyl: { valueText: '-0.75' },
        axis: { valueText: '090' },
      },
      { side: 'left', sideText: 'OS', sph: { valueText: '+01.50' }, add: { valueText: '+1.25' } },
    ],
  };
  const value: HealthRecordEnvelope = withMatchedSelfEvidence({
    ...envelope('fictional-optical', report('Optical prescription FICT-83')),
    kind: 'document',
    payload: { literal: 'Fictional optical evidence', prescription },
    clinical: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional optical prescription',
      opticalPrescription: prescription,
    },
  });
  let item: Intake = intake.uploadIntake(db, root, profileId, {
    filename: 'fictional-optical.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
  });
  await confirmFictionalGroup(db, root, profileId, item.id, groups(item)[0]!.id);
  const review = intake.reviewIntake(db, root, profileId, item.id);
  assert.equal(review.records.length, 1);
  assert.equal(review.records[0]!.kind, 'document');
  assert.deepEqual(review.records[0]!.mapping.opticalPrescription, prescription);
  assert.equal(groups(item).length, 1);
  assert.equal(groups(item)[0]!.versions[0]!.members.length, 1);
  item = intake.importIntake(db, root, profileId, item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  assert.equal(item.imported!.clinical!.records!.length, 1);
  assert.equal(item.imported!.clinical!.records![0]!.optical, true);
  assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM documents').get()!.n, 1);
});

test('source-context envelopes never create clinical candidates or report group members', () => {
  const details = { workflow: intakeWorkflow({}) };
  const context: HealthRecordEnvelope = {
    ...envelope('cover-sheet'),
    kind: 'context',
    payload: 'Fictional package reading notes',
  };
  delete context.clinical;
  recordCandidateVersions(file, details, entries([context]), 'proposal:context');
  assert.equal(details.workflow.candidates.length, 0);
  assert.deepEqual(workflowSummary(details).workflow.reportGroups, []);
  recordCandidateVersions(
    file,
    details,
    entries([context, envelope('actual-result')]),
    'proposal:mixed',
  );
  assert.equal(details.workflow.candidates.length, 1);
  assert.equal(details.workflow.reportGroups!.length, 1);
  assert.equal(details.workflow.reportGroups![0]!.versions[0]!.members.length, 1);
  assert.equal(workflowSummary(details).pendingCount, 1);
});

test('legacy literal context links create one provisional report and one source suggestion', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-linked-report-context-'));
  const profileId = 'cookie-dough';
  let db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId: profileId });
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const context: HealthRecordEnvelope = {
    format: 'health-record-v1',
    id: 'context:fictional-composition-77',
    kind: 'context',
    payload: {
      contextId: 'fictional-composition-77',
      branding: 'Fictional Composition Studio',
      text: 'Fictional Composition Studio\nComposition report FC-77\nPrinted for Fictional Rowan Example\nScan date 2026-08-17',
    },
    provenance: {
      capturedVia: 'Fictional transcribed PDF',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: 'fictional report page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
  };
  const measurement = (id: string, label: string, valueText: string): HealthRecordEnvelope => ({
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { contextId: 'fictional-composition-77', literal: `${label}: ${valueText} %` },
    provenance: {
      capturedVia: 'Fictional transcribed PDF',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: `fictional report page 1 ${label}`,
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'observation',
      subject: 'unknown',
      testLabel: label,
      valueText,
      unit: '%',
      date: '2026-08-17',
      uncertainties: [],
    },
  });
  const values = [
    context,
    measurement('fictional-result-a', 'Fictional lean proportion', '20.0'),
    measurement('fictional-result-b', 'Fictional fat proportion', '30.0'),
    {
      ...measurement('fictional-unlinked', 'Fictional independent proportion', '40.0'),
      payload: { literal: 'Fictional independent proportion: 40.0 %' },
    },
  ];
  const original = Buffer.from(values.map((value) => JSON.stringify(value)).join('\n'));
  let item: Intake = intake.uploadIntake(db, root, profileId, {
    filename: 'fictional-composition-report.jsonl',
    bytes: original,
  });
  assert.equal(item.workflow!.candidates.length, 3);
  assert.equal(item.workflow!.reportGroups!.length, 2);
  const group = item.workflow!.reportGroups!.find(
    (candidate) => candidate.versions[0]!.context?.status === 'linked',
  )!;
  assert.equal(group.basis, 'report_anchor');
  assert.equal(group.report!.subject, null);
  assert.equal(group.versions[0]!.members.length, 2);
  assert.deepEqual(group.versions[0]!.context?.sourceSuggestion, {
    value: 'Fictional Composition Studio',
    textAnchor: 'Fictional Composition Studio',
    locator: 'fictional report page 1',
  });
  let review = intake.reviewIntake(db, root, profileId, item.id);
  assert.equal(review.records.length, 3);
  assert.ok(review.records.every((record) => record.mapping.subject === 'self'));
  assert.ok(
    review.records.every(
      (record) =>
        record.identityReview?.status === 'missing_warning' &&
        record.identityAttribution?.basis === 'reviewed_active_profile_missing_identity',
    ),
  );
  assert.equal(review.sourceContext?.[0]?.reportContext?.status, 'linked');
  let queue = listIntakeReportQueue(db, root, profileId);
  let queued = queue.groups.find((candidate) => candidate.groupId === group.id)!;
  assert.equal(queued.groupId, group.id);
  assert.deepEqual(queued.sourceSuggestion, {
    value: 'Fictional Composition Studio',
    contextId: 'fictional-composition-77',
    evidence: {
      label: 'Shared report context',
      locator: 'fictional report page 1',
      contentUrl: item.contentUrl,
    },
  });
  assert.equal(queued.source, null);
  assert.equal(queued.sourceScope, null);
  assert.ok(
    queue.groups.some(
      (candidate) => candidate.groupId !== group.id && candidate.sourceScope === null,
    ),
  );
  assert.deepEqual(intake.getIntakeOriginal(db, root, profileId, item.id).bytes, original);

  const sourceRequest = {
    version: item.version,
    operationId: 'fictional-report-source-one',
    groupId: group.id,
    groupVersionId: group.versions[0]!.id,
    contextId: 'fictional-composition-77',
    source: 'Fictional Composition Studio',
  };
  let sourceResult = intake.confirmIntakeReportSource(db, root, profileId, item.id, sourceRequest);
  item = sourceResult.intake;
  assert.equal(sourceResult.confirmation.members.length, 2);
  assert.equal(
    intake.confirmIntakeReportSource(db, root, profileId, item.id, sourceRequest).intake.version,
    item.version,
  );
  assert.throws(
    () =>
      intake.confirmIntakeReportSource(db, root, profileId, item.id, {
        ...sourceRequest,
        source: 'Different fictional studio',
      }),
    { code: 'OPERATION_CONFLICT' },
  );
  queue = listIntakeReportQueue(db, root, profileId);
  queued = queue.groups.find((candidate) => candidate.groupId === group.id)!;
  assert.equal(queued.source, 'Fictional Composition Studio');
  assert.equal(queued.sourceScope, 'report');
  assert.equal(queued.sourceConfirmation?.memberCount, 2);
  assert.equal(queued.sourceSuggestion, undefined);
  assert.ok(
    queue.groups.some(
      (candidate) =>
        candidate.groupId !== group.id &&
        candidate.source === null &&
        candidate.sourceScope === null,
    ),
  );
  assert.equal(item.metadata!.source, null);
  assert.equal(item.acquisition!.provider, 'Unknown source');

  review = intake.reviewIntake(db, root, profileId, item.id);
  const linkedRecords = review.records.filter((record) =>
    selectedReportGroups(record.reportGroups).some((reference) => reference.groupId === group.id),
  );
  assert.equal(linkedRecords.length, 2);
  assert.ok(linkedRecords.every((record) => record.provider === 'Fictional Composition Studio'));
  for (const [index, record] of linkedRecords.entries()) {
    const identity = record.issues!.find((issue) => issue.kind === 'identity')!;
    item = intake.saveIntakeReviewDraft(db, root, profileId, item.id, {
      version: item.version,
      operationId: `fictional-context-identity-${index}`,
      proposalId: null,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId!,
      resolutions: [{ issueId: identity.id, outcome: 'this_is_me' }],
    });
  }
  review = intake.reviewIntake(db, root, profileId, item.id);
  assert.ok(
    review.records
      .filter((record) =>
        selectedReportGroups(record.reportGroups).some(
          (reference) => reference.groupId === group.id,
        ),
      )
      .every((record) => record.mapping.subject === 'self'),
  );
  item = intake.importIntake(db, root, profileId, item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: review.records
      .filter((record) =>
        selectedReportGroups(record.reportGroups).some(
          (reference) => reference.groupId === group.id,
        ),
      )
      .map((record) => ({
        recordId: record.id,
        action: 'accept',
        mapping: {},
      })),
  });
  assert.equal(item.workflow!.decisions.length, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
  assert.deepEqual(
    db
      .prepare(
        'SELECT DISTINCT p.name FROM observations o JOIN providers p ON p.id=o.provider_id ORDER BY p.name',
      )
      .all()
      .map((row) => String(row.name)),
    ['Fictional Composition Studio'],
  );
  assert.deepEqual(
    observations(db, new URLSearchParams(), true).data.map((record) => record.provider),
    ['Fictional Composition Studio', 'Fictional Composition Studio'],
  );
  assert.equal(
    JSON.parse(
      String(
        db.prepare('SELECT extra_json FROM observations ORDER BY id LIMIT 1').get()!.extra_json,
      ),
    ).import.reviewedReportSource.groupVersionId,
    group.versions[0]!.id,
  );
  const changedMeasurement = measurement('fictional-result-a', 'Fictional lean proportion', '21.0');
  item = intake.proposeConversion(db, root, profileId, item.id, {
    version: item.version,
    summary: 'Fictional changed measurement from the same report',
    jsonlText: [context, changedMeasurement].map((value) => JSON.stringify(value)).join('\n'),
  });
  const changedProposalId = item.proposals.at(-1)!.id;
  const currentGroup = item.workflow!.reportGroups!.find((candidate) => candidate.id === group.id)!;
  const changedSource = intake.confirmIntakeReportSource(db, root, profileId, item.id, {
    version: item.version,
    operationId: 'fictional-changed-report-source',
    groupId: currentGroup.id,
    groupVersionId: currentGroup.versions.at(-1)!.id,
    contextId: 'fictional-composition-77',
    source: 'Fictional Updated Studio',
  });
  item = changedSource.intake;
  assert.equal(changedSource.confirmation.members.length, 1);
  assert.deepEqual(
    observations(db, new URLSearchParams(), true).data.map((record) => record.provider),
    ['Fictional Composition Studio', 'Fictional Composition Studio'],
  );
  const retainedWorkflow = structuredClone(item.workflow);
  const backup = await createBackup(db, root, profileId);
  const target = join(root, 'rebuilt-context');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), profileId, target);
  db.close();
  db = openDatabase(rebuilt.database, profileId);
  attachPersonalDurability(db, { root: target, profileId: profileId });
  const restored = intake.getIntake(db, target, profileId, item.id);
  assert.deepEqual(restored.workflow, retainedWorkflow);
  assert.deepEqual(intake.getIntakeOriginal(db, target, profileId, item.id).bytes, original);
  assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
  assert.deepEqual(
    observations(db, new URLSearchParams(), true).data.map((record) => record.provider),
    ['Fictional Composition Studio', 'Fictional Composition Studio'],
  );
  assert.equal(
    intake.reviewIntake(db, target, profileId, item.id, changedProposalId).records[0]!.provider,
    'Fictional Updated Studio',
  );
});

test('ambiguous, cross-source and unverified package context links remain separate with guidance', () => {
  const linked = (id: string, sourceSystem: string | null = null): HealthRecordEnvelope => {
    const value = envelope(id);
    delete value.report;
    return {
      ...value,
      payload: { contextId: 'shared-context', literal: `Fictional result ${id}` },
      provenance: { ...value.provenance, sourceSystem },
      clinical: {
        kind: 'observation',
        subject: 'unknown',
        testLabel: `Fictional result ${id}`,
        valueText: '20.0',
        unit: '%',
      },
    };
  };
  const context = (id: string, sourceSystem: string | null = null): HealthRecordEnvelope => {
    const value = envelope(id);
    delete value.report;
    delete value.clinical;
    return {
      ...value,
      kind: 'context',
      payload: {
        contextId: 'shared-context',
        branding: 'Fictional Shared Studio',
        literal: 'Fictional Shared Studio report FC-88',
      },
      provenance: { ...value.provenance, sourceSystem },
    };
  };

  const ambiguous = { workflow: intakeWorkflow({}) };
  recordCandidateVersions(
    file,
    ambiguous,
    entries([context('context-a'), context('context-b'), linked('a'), linked('b')]),
    'proposal:ambiguous',
  );
  assert.equal(ambiguous.workflow.reportGroups!.length, 2);
  assert.ok(
    ambiguous.workflow.reportGroups!.every((group) => group.basis === 'candidate_fallback'),
  );
  assert.match(ambiguous.workflow.reportGroups![0]!.versions[0]!.context!.detail, /ambiguous/);

  const crossSource = { workflow: intakeWorkflow({}) };
  recordCandidateVersions(
    file,
    crossSource,
    entries([context('context-source', 'Fictional issuer A'), linked('source-a', 'Issuer B')]),
    'proposal:cross-source',
  );
  assert.equal(crossSource.workflow.reportGroups![0]!.basis, 'candidate_fallback');
  assert.match(
    crossSource.workflow.reportGroups![0]!.versions[0]!.context!.detail,
    /source systems/,
  );

  const packageDetails = { workflow: intakeWorkflow({}) };
  recordCandidateVersions(
    { ...file, mime_type: 'application/zip' },
    packageDetails,
    entries([context('context-package'), linked('package-a'), linked('package-b')]),
    'proposal:package',
  );
  assert.equal(packageDetails.workflow.reportGroups!.length, 2);
  assert.ok(
    packageDetails.workflow.reportGroups!.every(
      (group) =>
        group.basis === 'candidate_fallback' &&
        group.versions[0]!.context?.detail.includes('host-verified package member'),
    ),
  );

  const brandingOnly = { workflow: intakeWorkflow({}) };
  const brandingContext = context('context-branding-only');
  brandingContext.payload = {
    contextId: 'shared-context',
    branding: 'Fictional Unsupported Branding',
  };
  recordCandidateVersions(
    file,
    brandingOnly,
    entries([brandingContext, linked('branding-only-record')]),
    'proposal:branding-only',
  );
  assert.equal(brandingOnly.workflow.reportGroups![0]!.basis, 'candidate_fallback');
  assert.equal(
    brandingOnly.workflow.reportGroups![0]!.versions[0]!.context?.sourceSuggestion,
    undefined,
  );
  assert.match(
    brandingOnly.workflow.reportGroups![0]!.versions[0]!.context!.detail,
    /bounded literal report anchor/,
  );

  const conflictingIds = { workflow: intakeWorkflow({}) };
  const conflicting = linked('conflicting-context-id');
  conflicting.contextId = 'different-top-level-context';
  recordCandidateVersions(
    file,
    conflictingIds,
    entries([context('context-conflicting'), conflicting]),
    'proposal:conflicting-context-id',
  );
  assert.equal(conflictingIds.workflow.reportGroups![0]!.basis, 'candidate_fallback');
  assert.match(
    conflictingIds.workflow.reportGroups![0]!.versions[0]!.context!.detail,
    /context IDs conflict/,
  );
});

test('published report schema and runtime agree on required fields and bounded references', () => {
  const schema = JSON.parse(
    readFileSync(
      new URL('../../shared/schemas/health-record-v1.schema.json', import.meta.url),
      'utf8',
    ),
  ) as {
    properties: {
      contextId: { maxLength: number; description: string };
      report: {
        required: string[];
        properties: Record<string, { maxLength?: number; required?: string[] }>;
      };
    };
    $defs: {
      reportAnchor: { required: string[]; properties: Record<string, { maxLength: number }> };
    };
  };
  const validate = (claim: unknown) =>
    validateJSONL(Buffer.from(JSON.stringify({ ...envelope('schema'), report: claim }))).valid;
  assert.equal(validate(report()), true);
  assert.equal(validate({ ...report(), subject: null }), true);
  for (const key of schema.properties.report.required) {
    const incomplete: Record<string, unknown> = { ...report() };
    delete incomplete[key];
    assert.equal(validate(incomplete), false, 'Missing required report ' + key);
  }
  for (const [key, field] of Object.entries(schema.properties.report.properties)) {
    if (field.maxLength === undefined) continue;
    assert.equal(
      validate({ ...report(), [key]: 'x'.repeat(field.maxLength) }),
      true,
      key + ' maximum',
    );
    assert.equal(
      validate({ ...report(), [key]: 'x'.repeat(field.maxLength + 1) }),
      false,
      key + ' overflow',
    );
    assert.equal(validate({ ...report(), [key]: '  ' }), false, key + ' blank');
  }
  for (const key of schema.$defs.reportAnchor.required) {
    const incomplete: Record<string, unknown> = { ...report().anchor };
    delete incomplete[key];
    for (const field of ['anchor', 'subject'])
      assert.equal(validate({ ...report(), [field]: incomplete }), false);
  }
  for (const [key, field] of Object.entries(schema.$defs.reportAnchor.properties)) {
    for (const target of ['anchor', 'subject']) {
      assert.equal(
        validate({
          ...report(),
          [target]: { ...report().anchor, [key]: 'x'.repeat(field.maxLength) },
        }),
        true,
      );
      assert.equal(
        validate({
          ...report(),
          [target]: { ...report().anchor, [key]: 'x'.repeat(field.maxLength + 1) },
        }),
        false,
      );
    }
  }
  const section = {
    key: 'spine',
    title: 'Fictional spine section',
    anchor: { locator: 'page 1 section', text: 'Spine' },
  };
  assert.equal(validate({ ...report(), section }), true);
  for (const key of schema.properties.report.properties.section!.required!) {
    const incomplete: Record<string, unknown> = { ...section };
    delete incomplete[key];
    assert.equal(validate({ ...report(), section: incomplete }), false);
  }
  assert.equal(schema.properties.contextId.maxLength, 2000);
  assert.match(schema.properties.contextId.description, /same proposal and original/);
  assert.equal(
    validateJSONL(Buffer.from(JSON.stringify({ ...envelope('context-id'), contextId: '  ' })))
      .valid,
    false,
  );
  assert.match(INTAKE_SCHEMA_INSTRUCTIONS, /top-level contextId:string/);
  assert.match(INTAKE_SCHEMA_INSTRUCTIONS, /SAME proposal and original/);
  assert.match(INTAKE_SCHEMA_INSTRUCTIONS, /same host-supplied report\.memberId/);
  assert.match(INTAKE_SCHEMA_INSTRUCTIONS, /never proves patient identity, clinical equivalence/);
});

test('manual report labels work without a model suggestion and stay exact-version scoped', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'health-manual-report-label-'));
  const profileId = 'fictional-manual-source';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId: profileId });
  setFictionalSelf(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const first = withMatchedSelfEvidence(envelope('manual-a'));
  first.provenance.sourceSystem = null;
  const second = withMatchedSelfEvidence(
    envelope('manual-b', { ...report('Different fictional report'), key: 'second' }),
  );
  second.provenance.sourceSystem = null;
  const original = Buffer.from([first, second].map((value) => JSON.stringify(value)).join('\n'));
  let item: Intake = intake.uploadIntake(db, root, profileId, {
    filename: 'fictional-labels.jsonl',
    bytes: original,
  });
  const before = listIntakeReportQueue(db, root, profileId).groups;
  const group = before.find((g) => g.anchor?.text === first.report!.anchor.text)!;
  assert.equal(group.sourceSuggestion, undefined);
  assert.ok(group.sourceLabelScope);
  const input = {
    version: item.version,
    operationId: 'manual-source-1',
    groupId: group.groupId,
    groupVersionId: group.groupVersionId,
    contextId: group.sourceLabelScope.contextId,
    source: 'Fictional River Clinic',
    basis: 'manual_report_label' as const,
  };
  assert.throws(
    () =>
      intake.confirmIntakeReportSource(db, root, profileId, item.id, {
        ...input,
        contextId: 'wrong',
      }),
    { code: 'REPORT_SOURCE_SCOPE' },
  );
  const result = intake.confirmIntakeReportSource(db, root, profileId, item.id, input);
  item = result.intake;
  assert.equal(result.confirmation.basis, 'manual_report_label');
  assert.equal(result.confirmation.members.length, 1);
  assert.deepEqual(
    intake.confirmIntakeReportSource(db, root, profileId, item.id, input).confirmation,
    result.confirmation,
  );
  assert.throws(
    () =>
      intake.confirmIntakeReportSource(db, root, profileId, item.id, {
        ...input,
        source: 'Different personal label',
      }),
    { code: 'OPERATION_CONFLICT' },
  );
  const after = listIntakeReportQueue(db, root, profileId).groups;
  assert.equal(after.find((g) => g.groupId === group.groupId)!.source, input.source);
  assert.equal(after.find((g) => g.groupId !== group.groupId)!.source, null);
  assert.equal(item.metadata!.source, null);
  assert.deepEqual(intake.getIntakeOriginal(db, root, profileId, item.id).bytes, original);
  await confirmFictionalGroup(db, root, profileId, item.id, group.groupId);
  const reviewed = intake.reviewIntake(db, root, profileId, item.id);
  const selected = reviewed.records.find((r) =>
    selectedReportGroups(r.reportGroups).some((g) => g.groupId === group.groupId),
  )!;
  item = intake.importIntake(db, root, profileId, item.id, {
    version: reviewed.version,
    reviewToken: reviewed.reviewToken,
    decisions: [{ recordId: selected.id, action: 'accept', mapping: {} }],
  });
  assert.equal(observations(db, new URLSearchParams(), true).data[0]!.provider, input.source);
  assert.equal(
    listIntakeReportQueue(db, root, profileId, { view: 'all' }).groups.find(
      (g) => g.groupId === group.groupId,
    )!.sourceLabelScope,
    undefined,
  );
  assert.throws(
    () =>
      intake.confirmIntakeReportSource(db, root, profileId, item.id, {
        ...input,
        version: item.version,
        operationId: 'accepted-source-edit',
      }),
    { code: 'REPORT_SOURCE_SCOPE' },
  );
  const changed = structuredClone(first);
  (changed.clinical as { valueText: string }).valueText = '13.00';
  item = intake.proposeConversion(db, root, profileId, item.id, {
    version: item.version,
    summary: 'Fictional changed measurement',
    jsonlText: JSON.stringify(changed),
  });
  assert.throws(
    () =>
      intake.confirmIntakeReportSource(db, root, profileId, item.id, {
        ...input,
        version: item.version,
        operationId: 'stale-report-label',
      }),
    { code: 'REPORT_SOURCE_SCOPE' },
  );
  assert.equal(observations(db, new URLSearchParams(), true).data[0]!.provider, input.source);
});
