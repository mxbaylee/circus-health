import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import { listIntakeImportFeed, listIntakeReportQueue } from '../intake-report-queue.ts';
import { acceptIntakeReportSelection } from '../intake-report-acceptance.ts';
import { getObservation, getSourceRecord, observations, sourceRecords } from '../queries.ts';
import { createBackup } from '../recovery.ts';
import { rebuildProfile } from '../portable.ts';
import { fictionalModel } from './fictional-model.ts';
import { getNote, saveNote } from '../notes.ts';
import { getIntakeIdentityReview, confirmIntakeIdentityScope } from '../intake-identity.ts';
import type {
  HealthRecordEnvelope,
  Intake,
  IntakeReportAcceptanceBlock,
  IntakeReportReference,
} from '../../shared/intake.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-source-carryover-')),
    profileId = 'fictional-source-carryover';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const self = getNote(db, 'person-note:self');
  saveNote(db, self.id, {
    version: self.version,
    person: { ...self.person, fullName: 'Fictional Rowan Example' },
  });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db };
}
type Fixture = ReturnType<typeof fixture>;

const report = (
  text = 'Fictional composition report FC-77',
  subject = 'Fictional Rowan Example',
): IntakeReportReference => ({
  key: text,
  title: 'Fictional composition report',
  anchor: { locator: 'page 1 report heading', text },
  subject: { locator: 'page 1 patient heading', text: subject },
});

function measurement(
  id: string,
  options: {
    report?: IntakeReportReference;
    sourceSystem?: string | null;
    sourceRecordId?: string | null;
    contextId?: string;
    page?: number;
  } = {},
): HealthRecordEnvelope {
  const page = options.page || 1;
  const reference = options.report || report();
  const supportedSelfName = ['Fictional Rowan Example', 'Fictional Fern Example'].find((name) =>
    reference.subject?.text.includes(name),
  );
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: {
      ...(options.contextId ? { contextId: options.contextId } : {}),
      literal: `${id}: +${page}.00 fictional units`,
      identityText: reference.subject?.text,
    },
    provenance: {
      capturedVia: 'Fictional delivery',
      sourceSystem: options.sourceSystem === undefined ? null : options.sourceSystem,
      sourceRecordId: options.sourceRecordId === undefined ? id : options.sourceRecordId,
      evidenceClass: 'transcription',
      locator: `page ${page} row ${id}`,
    },
    coverage: { status: 'partial', notes: [] },
    ...(options.report ? { report: options.report } : {}),
    ...(options.contextId ? { contextId: options.contextId } : {}),
    ...(supportedSelfName
      ? {
          reviewIssues: [
            {
              kind: 'identity' as const,
              field: 'subject',
              prompt: 'Does the printed fictional patient identity belong to you?',
              textAnchor: reference.subject!.text,
              selfSuggestion: { fullName: supportedSelfName },
            },
          ],
        }
      : {}),
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: `Fictional result ${id}`,
      valueText: `+${page}.00`,
      date: '2026-09',
      unit: 'fictional units',
    },
  };
}

function context(source: string): HealthRecordEnvelope {
  const reference = report();
  return {
    format: 'health-record-v1',
    id: 'fictional-context-envelope',
    kind: 'context',
    contextId: 'fictional-context',
    payload: {
      contextId: 'fictional-context',
      branding: source,
      text: `${source}\n${reference.anchor.text}\n${reference.subject!.text}`,
    },
    provenance: {
      capturedVia: 'Fictional delivery',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: 'page 1 shared report heading',
    },
    coverage: { status: 'partial', notes: [] },
    report: reference,
  };
}

function versionedContext(id: string, source: string): HealthRecordEnvelope {
  const value = context(source);
  value.id = `fictional-context-envelope-${id}`;
  value.contextId = `fictional-context-${id}`;
  value.payload = {
    ...(value.payload as Record<string, unknown>),
    contextId: value.contextId,
    paginationNote: `Fictional page context ${id}`,
  };
  value.provenance.locator = `page ${id} shared report heading`;
  return value;
}

function upload(
  f: Fixture,
  values: HealthRecordEnvelope[],
  filename = 'fictional-source.jsonl',
  newProviderName?: string,
): Intake {
  return intake.uploadIntake(f.db, f.root, f.profileId, {
    filename,
    bytes: Buffer.from(values.map((value) => JSON.stringify(value)).join('\n')),
    ...(newProviderName ? { newProviderName } : {}),
  });
}

function propose(f: Fixture, item: Intake, values: HealthRecordEnvelope[]): Intake {
  return intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    summary: 'Fictional later report pages',
    jsonlText: values.map((value) => JSON.stringify(value)).join('\n'),
  });
}

function confirmManualSource(f: Fixture, item: Intake, source = 'Fictional Body Studio'): Intake {
  const group = listIntakeReportQueue(f.db, f.root, f.profileId).groups.find(
    (candidate) => candidate.intakeId === item.id,
  )!;
  return confirmGroupSource(f, item, group.groupId, source);
}

function confirmGroupSource(f: Fixture, item: Intake, groupId: string, source: string): Intake {
  const group = listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'all' }).groups.find(
    (candidate) => candidate.intakeId === item.id && candidate.groupId === groupId,
  )!;
  assert.ok(group.sourceLabelScope);
  return intake.confirmIntakeReportSource(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    operationId: randomUUID(),
    groupId: group.groupId,
    groupVersionId: group.groupVersionId,
    contextId: group.sourceLabelScope.contextId,
    source,
    basis: 'manual_report_label',
  }).intake;
}

function confirmSuggestedSource(f: Fixture, item: Intake, source: string): Intake {
  const group = listIntakeReportQueue(f.db, f.root, f.profileId).groups.find(
    (candidate) => candidate.intakeId === item.id,
  )!;
  assert.equal(group.sourceSuggestion?.value, source);
  return intake.confirmIntakeReportSource(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    operationId: randomUUID(),
    groupId: group.groupId,
    groupVersionId: group.groupVersionId,
    contextId: group.sourceSuggestion!.contextId,
    source,
  }).intake;
}

function explicitSourceReview(f: Fixture, item: Intake) {
  const group = listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'all' }).groups.find(
    (candidate) => candidate.intakeId === item.id,
  )!;
  return intake.getIntakeReportSourceReview(
    f.db,
    f.root,
    f.profileId,
    item.id,
    group.groupId,
    'all',
  );
}

function confirmExplicitSource(f: Fixture, item: Intake, source = 'Fictional Body Studio') {
  const review = explicitSourceReview(f, item);
  return intake.confirmIntakeReportSource(f.db, f.root, f.profileId, item.id, {
    basis: 'explicit_current_members',
    version: review.intakeVersion,
    operationId: randomUUID(),
    groupId: review.groupId,
    groupVersionId: review.groupVersionId,
    contextId: review.groupVersionId,
    source,
    view: review.view,
    scopeToken: review.scopeToken,
  });
}

function block(
  f: Fixture,
  intakeId: string,
  proposalId: string | null,
  selectedIds?: Set<string>,
): IntakeReportAcceptanceBlock {
  const review = intake.reviewIntake(f.db, f.root, f.profileId, intakeId, proposalId);
  return {
    intakeId,
    proposalId,
    intakeVersion: review.version,
    reviewToken: review.reviewToken,
    selections: review.records
      .filter((record) => !selectedIds || selectedIds.has(record.candidateId!))
      .map((record) => ({
        recordId: record.id,
        candidateId: record.candidateId!,
        candidateVersionId: record.candidateVersionId!,
        mapping: {},
      })),
  };
}

async function confirmFictionalIdentity(f: Fixture, intakeId: string, groupId: string) {
  const review = await getIntakeIdentityReview(f.db, f.root, f.profileId, intakeId, groupId);
  if (review.status === 'conflict' || !review.scope) return;
  if (!review.scope.subject.text.includes('Fictional Rowan Example')) return;
  // These originals are JSONL fixtures, not printed patient headers. An exact
  // scoped confirmation follows inspection of the retained fictional original.
  assert.match(
    intake.getIntakeOriginal(f.db, f.root, f.profileId, intakeId).bytes.toString('utf8'),
    /Fictional Rowan Example/,
  );
  if (!review.scope.targets.length) return;
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, intakeId, {
    version: review.scope.intakeVersion,
    operationId: randomUUID(),
    scope: review.scope,
    outcome: 'this_is_me',
    attestation: 'confirmed_displayed_identity_questions',
  });
}

async function accept(f: Fixture, blocks: IntakeReportAcceptanceBlock[]) {
  const groupKeys = new Set<string>();
  for (const block of blocks) {
    const review = intake.reviewIntake(f.db, f.root, f.profileId, block.intakeId, block.proposalId);
    for (const selection of block.selections) {
      const record = review.records.find((candidate) => candidate.id === selection.recordId);
      assert.ok(record, 'selection belongs to its exact fictional proposal');
      for (const group of record.reportGroups || [])
        groupKeys.add(JSON.stringify([block.intakeId, group.groupId]));
    }
  }
  for (const key of groupKeys) {
    const [intakeId, groupId] = JSON.parse(key) as [string, string];
    await confirmFictionalIdentity(f, intakeId, groupId);
  }
  const freshBlocks = blocks.map((block) => {
    const current = intake.reviewIntake(
      f.db,
      f.root,
      f.profileId,
      block.intakeId,
      block.proposalId,
    );
    return { ...block, intakeVersion: current.version, reviewToken: current.reviewToken };
  });
  return acceptIntakeReportSelection(f.db, f.root, f.profileId, {
    operationId: randomUUID(),
    blocks: freshBlocks,
  });
}

function evidenceProviders(f: Fixture, entityId: string): string[] {
  return f.db
    .prepare(
      "SELECT p.name FROM evidence e JOIN source_records r ON r.id=e.source_record_id LEFT JOIN providers p ON p.id=r.provider_id WHERE e.entity_type='observation' AND e.entity_id=? ORDER BY e.id",
    )
    .all(entityId)
    .map((row) => String(row.name))
    .sort();
}

function assertEveryReviewedResult(
  db: Fixture['db'],
  expectedCount: number,
  expectedProvider = 'Fictional Body Studio',
) {
  const saved = observations(db, new URLSearchParams(), true).data;
  assert.equal(saved.length, expectedCount);
  const providerIds = new Set(saved.map((row) => row.providerId));
  assert.equal(providerIds.size, 1);
  const providerId = saved[0]!.providerId!;
  assert.ok(providerId);
  for (const row of saved) {
    assert.equal(row.provider, expectedProvider, `saved list source for ${row.label}`);
    const detail = getObservation(db, row.id);
    assert.ok('provider' in detail);
    assert.equal(detail.provider, expectedProvider, `saved detail source for ${row.label}`);
    const source = getSourceRecord(db, row.sourceRecordId);
    assert.equal(source.provider, expectedProvider, `source evidence for ${row.label}`);
    assert.equal(source.originalFile!.provider, 'Unknown source');
  }
  const filtered = observations(db, new URLSearchParams({ providerId }), true);
  assert.equal(filtered.total, expectedCount);
  assert.deepEqual(filtered.data.map((row) => row.id).sort(), saved.map((row) => row.id).sort());
  const filteredSourceIds = new Set<string>();
  for (let offset = 0; offset < expectedCount; offset += 37) {
    const page = sourceRecords(
      db,
      new URLSearchParams({ providerId, limit: '37', offset: String(offset) }),
    );
    assert.equal(page.total, expectedCount);
    for (const row of page.data) {
      assert.equal(row.provider, expectedProvider);
      filteredSourceIds.add(row.id);
    }
  }
  assert.deepEqual(filteredSourceIds, new Set(saved.map((row) => row.sourceRecordId)));
  const unknownProvider = db.prepare("SELECT id FROM providers WHERE name='Unknown source'").get();
  assert.ok(unknownProvider);
  assert.equal(
    observations(db, new URLSearchParams({ providerId: String(unknownProvider.id) }), true).total,
    0,
  );
}

async function resolveProposalIdentity(
  f: Fixture,
  item: Intake,
  proposalId: string | null,
): Promise<Intake> {
  for (const group of item.workflow?.reportGroups || []) {
    if (
      group.versions
        .at(-1)
        ?.members.some((member) =>
          member.occurrences.some((occurrence) => occurrence.proposalId === proposalId),
        )
    )
      await confirmFictionalIdentity(f, item.id, group.id);
  }
  const review = intake.reviewIntake(f.db, f.root, f.profileId, item.id, proposalId);
  assert.ok(
    review.records.every((record) => record.identityReview?.blocking !== true),
    'source-only fixtures establish Self identity through original review and exact scoped confirmation',
  );
  return intake.getIntake(f.db, f.root, f.profileId, item.id);
}

test('fresh counted acceptance applies a reviewed report source to every selected result', async (t) => {
  const f = fixture(t);
  let item = upload(f, [
    measurement('fresh-a', { report: report(), page: 1 }),
    measurement('fresh-b', { report: report(), page: 1 }),
  ]);
  item = confirmManualSource(f, item);
  const result = await accept(f, [block(f, item.id, null)]);
  assert.equal(result.receipt.acceptedCount, 2);
  assert.ok(
    result.receipt.receipts[0]!.records.every(
      (record) =>
        record.reviewedSource?.source === 'Fictional Body Studio' &&
        record.reviewedSource.outcome === 'assigned',
    ),
  );
  const saved = observations(f.db, new URLSearchParams(), true).data;
  assert.deepEqual(
    saved.map((row) => row.provider),
    ['Fictional Body Studio', 'Fictional Body Studio'],
  );
  const reviewed = sourceRecords(f.db, new URLSearchParams({ providerId: saved[0]!.providerId! }));
  assert.equal(reviewed.total, 2);
  assert.ok(reviewed.data.every((record) => record.provider === 'Fictional Body Studio'));
  const detail = getSourceRecord(f.db, saved[0]!.sourceRecordId);
  assert.equal(detail.provider, 'Fictional Body Studio');
  assert.equal(detail.originalFile!.provider, 'Unknown source');
});

test('counted report acceptance carries a reviewed source to unchanged later report pages', async (t) => {
  const f = fixture(t);
  const firstBytes = Buffer.from(
    JSON.stringify(measurement('page-one', { report: report(), page: 1 })),
  );
  let item: Intake = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-late-pages.jsonl',
    bytes: firstBytes,
  });
  item = confirmManualSource(f, item);
  const originalConfirmation = structuredClone(item.workflow!.reportSourceConfirmations![0]!);
  const originalGroupVersion = structuredClone(item.workflow!.reportGroups![0]!.versions[0]!);
  const later = measurement('page-two', { report: report(), page: 2 });
  item = propose(f, item, [later]);
  const stable = structuredClone(item.workflow);
  item = propose(f, item, [later]);
  assert.deepEqual(item.workflow, stable);
  item = await resolveProposalIdentity(f, item, item.proposals.at(-1)!.id);
  const currentGroup = listIntakeReportQueue(f.db, f.root, f.profileId).groups.find(
    (group) => group.intakeId === item.id,
  )!;
  assert.equal(currentGroup.source, 'Fictional Body Studio');
  assert.equal(currentGroup.sourceScope, 'report');
  const proposalId = item.proposals.at(-1)!.id;
  const result = await accept(f, [block(f, item.id, null), block(f, item.id, proposalId)]);
  assert.equal(result.receipt.acceptedCount, 2);
  assert.ok(
    result.receipt.receipts
      .flatMap((receipt) => receipt.records)
      .every((record) => record.reviewedSource?.source === 'Fictional Body Studio'),
  );
  const restored = intake.getIntake(f.db, f.root, f.profileId, item.id);
  assert.deepEqual(restored.workflow!.reportGroups![0]!.versions[0], originalGroupVersion);
  const confirmation = restored.workflow!.reportSourceConfirmations![0]!;
  assert.deepEqual(
    { ...confirmation, extensions: undefined },
    { ...originalConfirmation, extensions: undefined },
  );
  assert.equal(confirmation.extensions?.length, 1);
  assert.equal(confirmation.extensions![0]!.members.length, 2);
  assert.deepEqual(
    observations(f.db, new URLSearchParams(), true).data.map((row) => row.provider),
    ['Fictional Body Studio', 'Fictional Body Studio'],
  );
  assert.deepEqual(intake.getIntakeOriginal(f.db, f.root, f.profileId, item.id).bytes, firstBytes);
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'rebuilt-late-pages'),
    rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    rebuiltDb = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.deepEqual(
      intake.getIntake(rebuiltDb, target, f.profileId, item.id).workflow,
      restored.workflow,
    );
    assert.deepEqual(
      observations(rebuiltDb, new URLSearchParams(), true).data.map((row) => row.provider),
      ['Fictional Body Studio', 'Fictional Body Studio'],
    );
    const rebuiltSources = sourceRecords(rebuiltDb, new URLSearchParams());
    assert.ok(rebuiltSources.data.every((record) => record.provider === 'Fictional Body Studio'));
    assert.equal(
      getSourceRecord(rebuiltDb, rebuiltSources.data[0]!.id).originalFile!.provider,
      'Unknown source',
    );
    assert.deepEqual(
      intake.getIntakeOriginal(rebuiltDb, target, f.profileId, item.id).bytes,
      firstBytes,
    );
  } finally {
    rebuiltDb.close();
  }
});

test('a changed linked source context does not inherit or later backfill an earlier reviewed source', async (t) => {
  const f = fixture(t);
  let item = upload(f, [
    context('Fictional Body Studio'),
    measurement('first', { contextId: 'fictional-context' }),
  ]);
  item = confirmSuggestedSource(f, item, 'Fictional Body Studio');
  item = propose(f, item, [
    context('Different Fictional Clinic'),
    measurement('second', { contextId: 'fictional-context', page: 2 }),
  ]);
  const changedProposalId = item.proposals.at(-1)!.id;
  item = await resolveProposalIdentity(f, item, changedProposalId);
  const group = listIntakeReportQueue(f.db, f.root, f.profileId).groups.find(
    (candidate) => candidate.intakeId === item.id,
  )!;
  assert.notEqual(group.sourceScope, 'report');
  assert.equal(group.sourceSuggestion?.value, 'Different Fictional Clinic');
  item = propose(f, item, [
    context('Fictional Body Studio'),
    measurement('third', { contextId: 'fictional-context', page: 3 }),
  ]);
  const returnedProposalId = item.proposals.at(-1)!.id;
  item = await resolveProposalIdentity(f, item, returnedProposalId);
  const mixed = listIntakeReportQueue(f.db, f.root, f.profileId).groups.find(
    (candidate) => candidate.intakeId === item.id,
  )!;
  assert.notEqual(mixed.sourceScope, 'report');
  const confirmation = item.workflow!.reportSourceConfirmations![0]!;
  assert.equal(confirmation.extensions?.length, 1);
  assert.ok(
    confirmation.extensions![0]!.members.some(
      (member) =>
        member.candidateId ===
        intake.reviewIntake(f.db, f.root, f.profileId, item.id, returnedProposalId).records[0]!
          .candidateId,
    ),
  );
  assert.ok(
    !confirmation.extensions![0]!.members.some(
      (member) =>
        member.candidateId ===
        intake.reviewIntake(f.db, f.root, f.profileId, item.id, changedProposalId).records[0]!
          .candidateId,
    ),
  );
  await accept(f, [block(f, item.id, changedProposalId), block(f, item.id, returnedProposalId)]);
  const finished = listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'all' }).groups.find(
    (candidate) => candidate.intakeId === item.id,
  )!;
  assert.equal(finished.sourceCoverage?.current.total, 1);
  assert.deepEqual(
    {
      total: finished.sourceCoverage?.saved.total,
      covered: finished.sourceCoverage?.saved.covered,
      uncovered: finished.sourceCoverage?.saved.uncovered,
    },
    { total: 2, covered: 2, uncovered: 0 },
  );
  assert.deepEqual(
    Object.fromEntries(
      observations(f.db, new URLSearchParams(), true).data.map((row) => [row.label, row.provider]),
    ),
    {
      'Fictional result second': 'Different Fictional Clinic',
      'Fictional result third': 'Fictional Body Studio',
    },
  );
});

test('a repeated candidate version is attributed by its exact occurrence context', async (t) => {
  const f = fixture(t),
    repeated = measurement('repeated', { contextId: 'fictional-context' });
  let item = upload(f, [context('Fictional Body Studio'), repeated]);
  item = confirmSuggestedSource(f, item, 'Fictional Body Studio');
  item = propose(f, item, [context('Different Fictional Clinic'), repeated]);
  const proposalId = item.proposals.at(-1)!.id;
  item = await resolveProposalIdentity(f, item, proposalId);
  const current = intake.reviewIntake(f.db, f.root, f.profileId, item.id, proposalId);
  assert.equal(current.records[0]!.provider, 'Unknown source'); // Original acquisition remains unchanged.
  await accept(f, [block(f, item.id, proposalId)]);
  assert.equal(
    observations(f.db, new URLSearchParams(), true).data[0]!.provider,
    'Different Fictional Clinic',
  );
});

test('explicit review retains every occurrence of one candidate version and its first context', (t) => {
  const f = fixture(t),
    repeated = measurement('explicit-repeated', { contextId: 'fictional-context' });
  let item = upload(f, [context('Fictional First Branding'), repeated]);
  item = propose(f, item, [context('Fictional Second Branding'), repeated]);
  const proposalId = item.proposals.at(-1)!.id;
  const proposalReview = intake.reviewIntake(f.db, f.root, f.profileId, item.id, proposalId);
  const proposalRecord = proposalReview.records[0]!;
  item = intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
    version: proposalReview.version,
    operationId: randomUUID(),
    proposalId,
    recordId: proposalRecord.id,
    candidateVersionId: proposalRecord.candidateVersionId!,
    mapping: proposalRecord.mapping,
    disposition: 'review_later',
    decision: { recordId: proposalRecord.id, action: 'skip', mapping: proposalRecord.mapping },
  });
  const active = intake.getIntakeReportSourceReview(
    f.db,
    f.root,
    f.profileId,
    item.id,
    item.workflow!.reportGroups![0]!.id,
    'active',
  );
  const deferred = intake.getIntakeReportSourceReview(
    f.db,
    f.root,
    f.profileId,
    item.id,
    item.workflow!.reportGroups![0]!.id,
    'deferred',
  );
  assert.deepEqual(
    active.targets.map((target) => target.occurrence.proposalId),
    [null],
  );
  assert.deepEqual(
    deferred.targets.map((target) => target.occurrence.proposalId),
    [proposalId],
  );
  const review = explicitSourceReview(f, item);
  assert.equal(review.targets.length, 2);
  assert.equal(new Set(review.targets.map((target) => target.candidateVersionId)).size, 1);
  assert.equal(new Set(review.targets.map((target) => target.occurrence.proposalId)).size, 2);
  assert.equal(new Set(review.targets.map((target) => target.sourceRef.groupVersionId)).size, 2);
  assert.equal(new Set(review.targets.map((target) => target.sourceRef.fingerprint)).size, 2);
  const applied = intake.confirmIntakeReportSource(f.db, f.root, f.profileId, item.id, {
    basis: 'explicit_current_members',
    version: review.intakeVersion,
    operationId: randomUUID(),
    groupId: review.groupId,
    groupVersionId: review.groupVersionId,
    contextId: review.groupVersionId,
    source: 'Fictional Body Studio',
    view: review.view,
    scopeToken: review.scopeToken,
  });
  assert.equal(applied.confirmation.members.length, 1);
  assert.equal(applied.confirmation.coverageEntries?.length, 2);
  assert.equal(
    intake.reviewIntake(f.db, f.root, f.profileId, item.id, null).records[0]!.provider,
    'Fictional Body Studio',
  );
  assert.equal(
    intake.reviewIntake(f.db, f.root, f.profileId, item.id, proposalId).records[0]!.provider,
    'Fictional Body Studio',
  );
});

test('one proposal with mixed report contexts cannot receive a shared manual source label', (t) => {
  const f = fixture(t),
    item = upload(f, [
      context('Fictional Body Studio'),
      measurement('unlinked', { report: report() }),
      measurement('linked', { contextId: 'fictional-context' }),
    ]),
    group = item.workflow!.reportGroups![0]!;
  assert.equal(group.versions.at(-1)!.contextState, 'mixed');
  assert.throws(() => confirmManualSource(f, item), { code: 'REPORT_SOURCE_SCOPE' });
  assert.equal(
    Number(
      f.db.prepare("SELECT count(*) AS n FROM providers WHERE name='Fictional Body Studio'").get()!
        .n,
    ),
    0,
  );
});

test('source carryover never crosses a changed report anchor, subject or source system', async (t) => {
  const f = fixture(t);
  const differentAnchor = report('Different fictional report FC-88');
  const differentPatient = report('Fictional composition report FC-77', 'Fictional Fern Example');
  const alternateSubjectHeader = report(
    'Fictional composition report FC-77',
    'Patient: Fictional Rowan Example',
  );
  const original = measurement('original', { report: report() });
  original.payload = {
    ...(original.payload as object),
    laterPrintedHeaders: [
      differentAnchor.anchor.text,
      differentPatient.subject!.text,
      alternateSubjectHeader.subject!.text,
    ],
  };
  let item = upload(f, [original]);
  item = confirmManualSource(f, item);
  item = propose(f, item, [
    measurement('different-anchor', { report: differentAnchor, page: 2 }),
    measurement('different-patient', { report: differentPatient, page: 2 }),
    measurement('different-subject-header', { report: alternateSubjectHeader, page: 2 }),
    measurement('different-source', {
      report: report(),
      sourceSystem: 'Different fictional issuing system',
      page: 2,
    }),
  ]);
  const proposalId = item.proposals.at(-1)!.id;
  for (const group of item.workflow!.reportGroups!)
    await getIntakeIdentityReview(f.db, f.root, f.profileId, item.id, group.id);
  const independentGroup = item.workflow!.reportGroups!.find(
    (group) => group.report?.anchor.text === differentAnchor.anchor.text,
  )!;
  await confirmFictionalIdentity(f, item.id, independentGroup.id);
  const proposalRecords = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    item.id,
    proposalId,
  ).records;
  const conflictingPatient = proposalRecords.find(
    (record) => record.mapping.testLabel === 'Fictional result different-patient',
  )!;
  assert.equal(conflictingPatient.identityReview?.status, 'conflict');
  assert.equal(conflictingPatient.identityReview?.blocking, true);
  assert.equal(conflictingPatient.provider, 'Unknown source');
  // Competing patient claims at one report boundary cannot be silently accepted,
  // even when one of those claims matches Self. The distinct report remains readable.
  const ready = proposalRecords.filter((record) => record.identityReview?.blocking === false);
  assert.deepEqual(
    ready.map((record) => record.mapping.testLabel),
    ['Fictional result different-anchor'],
  );
  assert.ok(
    proposalRecords
      .filter((record) => record !== ready[0])
      .every((record) => record.identityReview?.blocking === true),
  );
  assert.ok(proposalRecords.every((record) => record.provider !== 'Fictional Body Studio'));
  await accept(f, [
    block(f, item.id, proposalId, new Set(ready.map((record) => record.candidateId!))),
  ]);
  assert.equal(
    listIntakeImportFeed(f.db, f.root, f.profileId, { view: 'all' })
      .blocks.flatMap((groupBlock) => groupBlock.records)
      .find((record) => record.candidateId === conflictingPatient.candidateId)?.selectable,
    false,
  );
  assert.ok(
    observations(f.db, new URLSearchParams(), true).data.every(
      (row) => row.provider === 'Unknown source',
    ),
  );
  assert.ok(
    !observations(f.db, new URLSearchParams(), true).data.some(
      (row) => row.label === 'Fictional result different-patient',
    ),
  );
});

test('two same-label report groups retain separate confirmations and exact member coverage', async (t) => {
  const f = fixture(t);
  const firstReport = report('Fictional report anchor A'),
    secondReport = report('Fictional report anchor B');
  secondReport.title = firstReport.title;
  let item = upload(f, [
    measurement('group-a', { report: firstReport }),
    measurement('group-b', { report: secondReport }),
  ]);
  const groups = listIntakeReportQueue(f.db, f.root, f.profileId).groups.filter(
    (group) => group.intakeId === item.id,
  );
  assert.equal(groups.length, 2);
  assert.equal(new Set(groups.map((group) => group.title)).size, 1);
  for (const group of groups)
    item = confirmGroupSource(f, item, group.groupId, 'Fictional Body Studio');
  const result = await accept(f, [block(f, item.id, null)]);
  assert.equal(result.receipt.acceptedCount, 2);
  assert.equal(
    new Set(result.receipt.receipts[0]!.records.map((record) => record.reviewedSource?.groupId))
      .size,
    2,
  );
  assert.ok(
    observations(f.db, new URLSearchParams(), true).data.every(
      (row) => row.provider === 'Fictional Body Studio',
    ),
  );
});

test('partial then bulk counted acceptance attributes all 190 fictional rows', async (t) => {
  const f = fixture(t),
    values = Array.from({ length: 190 }, (_, index) =>
      measurement(`bulk-${String(index).padStart(3, '0')}`, { report: report(), page: 1 }),
    );
  let item = confirmManualSource(f, upload(f, values, 'fictional-190-rows.jsonl'));
  const review = intake.reviewIntake(f.db, f.root, f.profileId, item.id),
    firstTen = new Set(review.records.slice(0, 10).map((record) => record.candidateId!)),
    remaining = new Set(review.records.slice(10).map((record) => record.candidateId!));
  const partial = await accept(f, [block(f, item.id, null, firstTen)]);
  assert.equal(partial.receipt.acceptedCount, 10);
  item = intake.getIntake(f.db, f.root, f.profileId, item.id);
  const bulk = await accept(f, [block(f, item.id, null, remaining)]);
  assert.equal(bulk.receipt.acceptedCount, 180);
  const saved = observations(f.db, new URLSearchParams(), true).data;
  assert.equal(saved.length, 190);
  assert.ok(saved.every((row) => row.provider === 'Fictional Body Studio'));
  assertEveryReviewedResult(f.db, 190);
});

test(
  'one explicit current choice covers a sparse nine-version 190-row report and rebuilds exactly',
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t),
      increments = [12, 30, 10, 30, 12, 24, 24, 24, 24],
      proposalIds: (string | null)[] = [null];
    let offset = 0;
    const page = (version: number, count: number) => {
      const contextId = `fictional-context-${version}`;
      const values = [
        versionedContext(String(version), 'Fictional Body Studio'),
        ...Array.from({ length: count }, (_, index) =>
          measurement(`sparse-${String(offset + index).padStart(3, '0')}`, {
            contextId,
            page: version,
          }),
        ),
      ];
      offset += count;
      return values;
    };
    let item = upload(f, page(1, increments[0]!), 'fictional-sparse-190.jsonl');
    item = confirmManualSource(f, item);
    for (let version = 2; version <= increments.length; version++) {
      item = propose(f, item, page(version, increments[version - 1]!));
      proposalIds.push(item.proposals.at(-1)!.id);
      if (version === 2 || version === 9) item = confirmManualSource(f, item);
    }
    const before = explicitSourceReview(f, item);
    assert.equal(before.targets.length, 190);
    assert.deepEqual(
      {
        total: before.coverage.total,
        covered: before.coverage.covered,
        uncovered: before.coverage.uncovered,
      },
      { total: 190, covered: 66, uncovered: 124 },
    );
    assert.equal(new Set(before.targets.map((target) => target.sourceRef.groupVersionId)).size, 9);
    const explicit = confirmExplicitSource(f, item);
    item = explicit.intake;
    assert.equal(explicit.confirmation.coverageEntries?.length, 190);
    assert.equal(
      new Set(explicit.confirmation.coverageEntries?.map((entry) => entry.sourceRef.fingerprint))
        .size,
      9,
    );
    const current = listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'all' }).groups.find(
      (group) => group.intakeId === item.id,
    )!;
    assert.deepEqual(
      {
        total: current.sourceCoverage?.current.total,
        covered: current.sourceCoverage?.current.covered,
        source: current.sourceCoverage?.current.bySource[0]?.source,
      },
      { total: 190, covered: 190, source: 'Fictional Body Studio' },
    );
    // accept() confirms each report once across all proposals. Repeating that
    // report-wide operation for every version duplicates the entire review.
    const accepted = await accept(
      f,
      proposalIds.map((proposalId) => block(f, item.id, proposalId)),
    );
    assert.equal(accepted.receipt.acceptedCount, 190);
    assert.ok(
      accepted.receipt.receipts
        .flatMap((receipt) => receipt.records)
        .every(
          (record) =>
            record.reviewedSource?.source === 'Fictional Body Studio' &&
            !!record.reviewedSource.coverageEntryId,
        ),
    );
    const finished = listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'all' }).groups.find(
      (group) => group.intakeId === item.id,
    )!;
    assert.equal(finished.sourceCoverage?.current.total, 0);
    assert.equal(finished.sourceCoverage?.current.status, 'empty');
    assert.deepEqual(
      {
        total: finished.sourceCoverage?.saved.total,
        covered: finished.sourceCoverage?.saved.covered,
      },
      { total: 190, covered: 190 },
    );
    assert.equal(finished.source, 'Fictional Body Studio');
    assert.equal(finished.sourceScope, 'report');
    assertEveryReviewedResult(f.db, 190);
    const backup = await createBackup(f.db, f.root, f.profileId),
      target = join(f.root, 'rebuilt-explicit-sparse-source'),
      rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
      rebuiltDb = openDatabase(rebuilt.database, f.profileId);
    try {
      assertEveryReviewedResult(rebuiltDb, 190);
      assert.deepEqual(
        observations(rebuiltDb, new URLSearchParams(), true).data.map((row) => row.provider),
        Array.from({ length: 190 }, () => 'Fictional Body Studio'),
      );
      const rebuiltItem = intake.getIntake(rebuiltDb, target, f.profileId, item.id);
      assert.deepEqual(
        rebuiltItem.workflow!.reportSourceConfirmations,
        intake.getIntake(f.db, f.root, f.profileId, item.id).workflow!.reportSourceConfirmations,
      );
    } finally {
      rebuiltDb.close();
    }
  },
);

test('explicit authority extends a same-context future occurrence but not a changed context', (t) => {
  const f = fixture(t);
  let item = upload(f, [measurement('explicit-first', { report: report() })]);
  item = confirmExplicitSource(f, item).intake;
  const authority = item.workflow!.reportSourceConfirmations!.at(-1)!.coverageEntries![0]!.id;
  item = propose(f, item, [measurement('explicit-same', { report: report(), page: 2 })]);
  let queue = listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'all' }).groups.find(
    (group) => group.intakeId === item.id,
  )!;
  assert.equal(queue.sourceCoverage?.current.covered, 2);
  const extension = item.workflow!.reportSourceConfirmations!.at(-1)!.extensions!.at(-1)!;
  assert.equal(extension.authorityEntryId, authority);
  assert.equal(extension.coverageEntries?.length, 1);

  item = propose(f, item, [
    versionedContext('changed', 'Different Fictional Clinic'),
    measurement('explicit-changed', { contextId: 'fictional-context-changed', page: 3 }),
  ]);
  queue = listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'all' }).groups.find(
    (group) => group.intakeId === item.id,
  )!;
  assert.deepEqual(
    {
      total: queue.sourceCoverage?.current.total,
      covered: queue.sourceCoverage?.current.covered,
      uncovered: queue.sourceCoverage?.current.uncovered,
    },
    { total: 3, covered: 2, uncovered: 1 },
  );
});

test('same-context extension does not sweep in an older deferred occurrence', (t) => {
  const f = fixture(t),
    repeated = measurement('explicit-deferred-repeat', { contextId: 'fictional-context' });
  let item = upload(f, [context('Fictional Body Studio'), repeated]);
  const repeatedVersionId = intake.reviewIntake(f.db, f.root, f.profileId, item.id, null)
    .records[0]!.candidateVersionId!;
  item = propose(f, item, [
    context('Fictional Body Studio'),
    repeated,
    measurement('proposal-nonce-a'),
  ]);
  const deferredProposalId = item.proposals.at(-1)!.id;
  const deferredReview = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    item.id,
    deferredProposalId,
  );
  const deferredRecord = deferredReview.records.find(
    (record) => record.candidateVersionId === repeatedVersionId,
  )!;
  item = intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
    version: deferredReview.version,
    operationId: randomUUID(),
    proposalId: deferredProposalId,
    recordId: deferredRecord.id,
    candidateVersionId: deferredRecord.candidateVersionId!,
    mapping: deferredRecord.mapping,
    disposition: 'review_later',
    decision: { recordId: deferredRecord.id, action: 'skip', mapping: deferredRecord.mapping },
  });
  const groupId = item.workflow!.reportGroups![0]!.id;
  const active = intake.getIntakeReportSourceReview(
    f.db,
    f.root,
    f.profileId,
    item.id,
    groupId,
    'active',
  );
  assert.deepEqual(
    active.targets.map((target) => target.occurrence.proposalId),
    [null],
  );
  item = intake.confirmIntakeReportSource(f.db, f.root, f.profileId, item.id, {
    basis: 'explicit_current_members',
    version: active.intakeVersion,
    operationId: randomUUID(),
    groupId: active.groupId,
    groupVersionId: active.groupVersionId,
    contextId: active.groupVersionId,
    source: 'Fictional Body Studio',
    view: active.view,
    scopeToken: active.scopeToken,
  }).intake;

  item = propose(f, item, [
    context('Fictional Body Studio'),
    repeated,
    measurement('proposal-nonce-b'),
  ]);
  const futureProposalId = item.proposals.at(-1)!.id;
  const confirmation = item.workflow!.reportSourceConfirmations!.at(-1)!;
  const extensionEntries = confirmation
    .extensions!.flatMap((extension) => extension.coverageEntries || [])
    .filter((entry) => entry.candidateVersionId === repeatedVersionId);
  assert.deepEqual(
    extensionEntries.map((entry) => entry.occurrence.proposalId),
    [futureProposalId],
  );
  const all = intake.getIntakeReportSourceReview(
    f.db,
    f.root,
    f.profileId,
    item.id,
    groupId,
    'all',
  );
  assert.deepEqual(
    {
      total: all.coverage.total,
      covered: all.coverage.covered,
      uncovered: all.coverage.uncovered,
    },
    { total: 3, covered: 2, uncovered: 1 },
  );
  assert.equal(
    intake
      .reviewIntake(f.db, f.root, f.profileId, item.id, deferredProposalId)
      .records.find((record) => record.candidateVersionId === repeatedVersionId)!.provider,
    'Unknown source',
  );
  assert.equal(
    intake
      .reviewIntake(f.db, f.root, f.profileId, item.id, futureProposalId)
      .records.find((record) => record.candidateVersionId === repeatedVersionId)!.provider,
    'Fictional Body Studio',
  );
});

test('saved source fallback does not label uncovered current or mixed saved report scope', async (t) => {
  const f = fixture(t);
  let item = upload(f, [
    context('Fictional Body Studio'),
    measurement('saved-scope-first', { contextId: 'fictional-context' }),
  ]);
  item = confirmSuggestedSource(f, item, 'Fictional Body Studio');
  await accept(f, [block(f, item.id, null)]);
  item = intake.getIntake(f.db, f.root, f.profileId, item.id);
  item = propose(f, item, [
    context('Different Fictional Clinic'),
    measurement('saved-scope-second', { contextId: 'fictional-context', page: 2 }),
  ]);
  let group = listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'all' }).groups.find(
    (candidate) => candidate.intakeId === item.id,
  )!;
  assert.equal(group.sourceCoverage?.current.status, 'uncovered');
  assert.equal(group.sourceCoverage?.saved.status, 'single');
  assert.equal(group.source, null);
  assert.notEqual(group.sourceScope, 'report');

  item = confirmSuggestedSource(f, item, 'Different Fictional Clinic');
  item = await resolveProposalIdentity(f, item, item.proposals.at(-1)!.id);
  await accept(f, [block(f, item.id, item.proposals.at(-1)!.id)]);
  group = listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'all' }).groups.find(
    (candidate) => candidate.intakeId === item.id,
  )!;
  assert.equal(group.sourceCoverage?.current.status, 'empty');
  assert.equal(group.sourceCoverage?.saved.status, 'mixed');
  assert.equal(group.source, null);
  assert.notEqual(group.sourceScope, 'report');
});

test('one effective source remains a report scalar across multiple exact confirmation receipts', (t) => {
  const f = fixture(t);
  let item = upload(f, [
    versionedContext('scalar-one', 'Fictional Body Studio'),
    measurement('scalar-one', { contextId: 'fictional-context-scalar-one' }),
  ]);
  item = confirmManualSource(f, item);
  item = propose(f, item, [
    versionedContext('scalar-two', 'Fictional Body Studio'),
    measurement('scalar-two', { contextId: 'fictional-context-scalar-two', page: 2 }),
  ]);
  item = confirmManualSource(f, item);
  assert.equal(item.workflow!.reportSourceConfirmations?.length, 2);
  const group = listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'all' }).groups.find(
    (candidate) => candidate.intakeId === item.id,
  )!;
  assert.equal(group.sourceCoverage?.current.status, 'single');
  assert.equal(group.sourceCoverage?.current.covered, 2);
  assert.equal(group.source, 'Fictional Body Studio');
  assert.equal(group.sourceScope, 'report');
  assert.equal(group.sourceConfirmation, undefined);
});

test('explicit source scope rejects drift and replays the exact durable occurrence receipt', (t) => {
  const f = fixture(t);
  let item = upload(f, [measurement('scope-first', { report: report() })]);
  const review = explicitSourceReview(f, item);
  const operationId = randomUUID();
  const request = {
    basis: 'explicit_current_members' as const,
    version: review.intakeVersion,
    operationId,
    groupId: review.groupId,
    groupVersionId: review.groupVersionId,
    contextId: review.groupVersionId,
    source: 'Fictional Body Studio',
    view: review.view,
    scopeToken: review.scopeToken,
  };
  item = propose(f, item, [measurement('scope-second', { report: report(), page: 2 })]);
  assert.throws(
    () => intake.confirmIntakeReportSource(f.db, f.root, f.profileId, item.id, request),
    { code: 'VERSION_CONFLICT' },
  );
  assert.throws(
    () =>
      intake.confirmIntakeReportSource(f.db, f.root, f.profileId, item.id, {
        ...request,
        version: item.version,
      }),
    { code: 'REPORT_SOURCE_SCOPE' },
  );
  const fresh = explicitSourceReview(f, item);
  const exact = {
    ...request,
    version: fresh.intakeVersion,
    groupVersionId: fresh.groupVersionId,
    contextId: fresh.groupVersionId,
    scopeToken: fresh.scopeToken,
  };
  const applied = intake.confirmIntakeReportSource(f.db, f.root, f.profileId, item.id, exact);
  const replayed = intake.confirmIntakeReportSource(f.db, f.root, f.profileId, item.id, exact);
  assert.deepEqual(replayed.confirmation, applied.confirmation);
  assert.equal(replayed.confirmation.coverageEntries?.length, 2);
});

test(
  'confirmation after a batchless acceptance covers pending members from the compatible batch version',
  { timeout: 20000 },
  async (t) => {
    fictionalModel(t);
    const f = fixture(t);
    let item: Intake = intake.uploadIntake(f.db, f.root, f.profileId, {
      filename: 'fictional-batched-report.txt',
      bytes: Buffer.from(
        'Fictional report evidence retained independently of these test rows.\nFictional composition report FC-77\nFictional Rowan Example',
      ),
    });
    item = await intake.createIntakePlan(f.db, f.root, f.profileId, item.id, {
      version: item.version,
    });
    const plan = item.workflow!.plans.find((candidate) => candidate.status === 'active')!;
    const submit = (current: Intake, operationId: string, values: HealthRecordEnvelope[]) =>
      intake.submitIntakeBatch(f.db, f.root, f.profileId, current.id, {
        version: current.version,
        operationId,
        planId: plan.id,
        summary: 'Fictional bounded report extraction',
        jsonlText: values.map((value) => JSON.stringify(value)).join('\n'),
        coverage: plan.units.map((unit) => ({
          unitId: unit.id,
          kind: 'extracted' as const,
          notes: 'Fictional source unit inspected for this bounded extraction.',
        })),
      });

    item = submit(item, 'fictional-first-batch', [
      context('Fictional First Studio'),
      measurement('initial', { contextId: 'fictional-context' }),
    ]);
    item = confirmSuggestedSource(f, item, 'Fictional First Studio');
    const initialProposalId = item.proposals.at(-1)!.id;
    item = await resolveProposalIdentity(f, item, initialProposalId);
    await accept(f, [block(f, item.id, initialProposalId)]);

    item = intake.getIntake(f.db, f.root, f.profileId, item.id);
    item = submit(item, 'fictional-later-batch', [
      context('Fictional Later Studio'),
      ...Array.from({ length: 4 }, (_, index) =>
        measurement(`later-${index}`, { contextId: 'fictional-context', page: 2 }),
      ),
    ]);
    const laterProposalId = item.proposals.at(-1)!.id;
    item = await resolveProposalIdentity(f, item, laterProposalId);
    const laterReview = intake.reviewIntake(f.db, f.root, f.profileId, item.id, laterProposalId);
    const beforeConfirmation = new Set([laterReview.records[0]!.candidateId!]);
    const unconfirmed = await accept(f, [block(f, item.id, laterProposalId, beforeConfirmation)]);
    assert.equal(
      unconfirmed.receipt.receipts[0]!.records[0]!.reviewedSource?.source,
      'Fictional Later Studio',
    );
    assert.equal(
      unconfirmed.receipt.receipts[0]!.records[0]!.reviewedSource?.basis,
      'suggested_report_label',
    );

    item = intake.getIntake(f.db, f.root, f.profileId, item.id);
    item = confirmSuggestedSource(f, item, 'Fictional Later Studio');
    item = await resolveProposalIdentity(f, item, laterProposalId);
    const pending = intake
      .reviewIntake(f.db, f.root, f.profileId, item.id, laterProposalId)
      .records.filter((record) => record.reviewState === 'pending');
    const individual = await accept(f, [
      block(f, item.id, laterProposalId, new Set([pending[0]!.candidateId!])),
    ]);
    assert.equal(
      individual.receipt.receipts[0]!.records[0]!.reviewedSource?.source,
      'Fictional Later Studio',
    );

    item = intake.getIntake(f.db, f.root, f.profileId, item.id);
    const bulkRequest = {
        operationId: randomUUID(),
        blocks: [
          block(
            f,
            item.id,
            laterProposalId,
            new Set(pending.slice(1).map((record) => record.candidateId!)),
          ),
        ],
      },
      bulk = acceptIntakeReportSelection(f.db, f.root, f.profileId, bulkRequest);
    assert.ok(
      bulk.receipt.receipts[0]!.records.every(
        (record) => record.reviewedSource?.source === 'Fictional Later Studio',
      ),
    );
    assert.deepEqual(
      acceptIntakeReportSelection(f.db, f.root, f.profileId, bulkRequest).receipt,
      bulk.receipt,
    );
    assert.deepEqual(
      Object.fromEntries(
        observations(f.db, new URLSearchParams(), true).data.map((row) => [
          row.label,
          row.provider,
        ]),
      ),
      {
        'Fictional result initial': 'Fictional First Studio',
        'Fictional result later-0': 'Fictional Later Studio',
        'Fictional result later-1': 'Fictional Later Studio',
        'Fictional result later-2': 'Fictional Later Studio',
        'Fictional result later-3': 'Fictional Later Studio',
      },
    );

    const backup = await createBackup(f.db, f.root, f.profileId),
      target = join(f.root, 'rebuilt-batch-version-source'),
      rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
      rebuiltDb = openDatabase(rebuilt.database, f.profileId);
    try {
      assert.deepEqual(
        observations(rebuiltDb, new URLSearchParams(), true).data.map((row) => [
          row.label,
          row.provider,
        ]),
        observations(f.db, new URLSearchParams(), true).data.map((row) => [
          row.label,
          row.provider,
        ]),
      );
      assert.deepEqual(
        acceptIntakeReportSelection(rebuiltDb, target, f.profileId, bulkRequest).receipt,
        bulk.receipt,
      );
    } finally {
      rebuiltDb.close();
    }
  },
);

test('exact reuse enriches only a canonical Unknown source and retains both evidence occurrences', async (t) => {
  const f = fixture(t);
  const exact = measurement('same-assertion', {
    report: report(),
    sourceSystem: 'Fictional issuing system',
    sourceRecordId: 'FICT-EXACT-1',
  });
  const first = upload(f, [exact], 'fictional-unknown.jsonl');
  await accept(f, [block(f, first.id, null)]);
  assert.equal(observations(f.db, new URLSearchParams(), true).data[0]!.provider, 'Unknown source');

  let second = upload(f, [exact], 'fictional-reviewed.jsonl');
  second = confirmManualSource(f, second);
  await confirmFictionalIdentity(f, second.id, second.workflow!.reportGroups![0]!.id);
  const request = {
      operationId: randomUUID(),
      blocks: [block(f, second.id, null)],
    },
    result = acceptIntakeReportSelection(f.db, f.root, f.profileId, request);
  assert.equal(result.receipt.receipts[0]!.records[0]!.outcome, 'matched');
  assert.equal(result.receipt.receipts[0]!.records[0]!.reviewedSource?.outcome, 'enriched_unknown');
  const saved = observations(f.db, new URLSearchParams(), true).data[0]!;
  assert.equal(saved.provider, 'Fictional Body Studio');
  assert.equal(
    observations(f.db, new URLSearchParams({ providerId: saved.providerId! }), true).total,
    1,
  );
  const unknownProviderId = String(
    f.db.prepare("SELECT id FROM providers WHERE name='Unknown source'").get()!.id,
  );
  assert.equal(
    observations(f.db, new URLSearchParams({ providerId: unknownProviderId }), true).total,
    0,
  );
  assert.deepEqual(evidenceProviders(f, saved.id), ['Fictional Body Studio', 'Unknown source']);
  const imported = JSON.parse(
    String(
      f.db.prepare('SELECT extra_json FROM observations WHERE id=?').get(saved.id)!.extra_json,
    ),
  ).import;
  assert.equal(imported.reviewedReportSource.source, 'Fictional Body Studio');
  assert.equal(imported.reviewedReportSources.length, 1);
  assert.equal(
    Number(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM evidence WHERE entity_type='observation' AND entity_id=?",
        )
        .get(saved.id)!.n,
    ),
    2,
  );
  const version = intake.getIntake(f.db, f.root, f.profileId, second.id).version;
  assert.deepEqual(
    acceptIntakeReportSelection(f.db, f.root, f.profileId, request).receipt,
    result.receipt,
  );
  assert.equal(intake.getIntake(f.db, f.root, f.profileId, second.id).version, version);
  assert.equal(evidenceProviders(f, saved.id).length, 2);
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'rebuilt-exact-source'),
    rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    rebuiltDb = openDatabase(rebuilt.database, f.profileId);
  try {
    const rebuiltObservation = observations(rebuiltDb, new URLSearchParams(), true).data[0]!;
    assert.equal(rebuiltObservation.provider, 'Fictional Body Studio');
    assert.equal(
      Number(
        rebuiltDb
          .prepare(
            "SELECT count(*) AS n FROM evidence WHERE entity_type='observation' AND entity_id=?",
          )
          .get(rebuiltObservation.id)!.n,
      ),
      2,
    );
    assert.deepEqual(
      acceptIntakeReportSelection(rebuiltDb, target, f.profileId, request).receipt,
      result.receipt,
    );
  } finally {
    rebuiltDb.close();
  }
});

test('exact reuse never replaces a known source while retaining reviewed source evidence', async (t) => {
  const f = fixture(t);
  const exact = measurement('known-assertion', {
    report: report(),
    sourceSystem: 'Fictional known issuing system',
    sourceRecordId: 'FICT-KNOWN-1',
  });
  const first = upload(f, [exact], 'fictional-known.jsonl', 'Fictional Known Provider');
  await accept(f, [block(f, first.id, null)]);
  let second = upload(f, [exact], 'fictional-second-source.jsonl');
  second = confirmManualSource(f, second);
  const result = await accept(f, [block(f, second.id, null)]);
  assert.equal(result.receipt.receipts[0]!.records[0]!.reviewedSource?.outcome, 'preserved_known');
  const saved = observations(f.db, new URLSearchParams(), true).data[0]!;
  assert.equal(saved.provider, 'Fictional Known Provider');
  assert.deepEqual(evidenceProviders(f, saved.id), [
    'Fictional Body Studio',
    'Fictional Known Provider',
  ]);
  const imported = JSON.parse(
    String(
      f.db.prepare('SELECT extra_json FROM observations WHERE id=?').get(saved.id)!.extra_json,
    ),
  ).import;
  assert.equal(imported.reviewedReportSources.length, 1);
  assert.equal(
    Number(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM evidence WHERE entity_type='observation' AND entity_id=?",
        )
        .get(saved.id)!.n,
    ),
    2,
  );
});

test('linked report source is a default on acceptance, without fabricating a human label receipt', async (t) => {
  const f = fixture(t);
  const item = upload(f, [
    context('Meadowglass Laboratory'),
    measurement('cookie-potassium', { contextId: 'fictional-context' }),
  ]);
  const result = await accept(f, [block(f, item.id, null)]);
  const receipt = result.receipt.receipts[0]!.records[0]!;
  assert.equal(receipt.reviewedSource?.source, 'Meadowglass Laboratory');
  assert.equal(receipt.reviewedSource?.basis, 'suggested_report_label');
  assert.equal(
    observations(f.db, new URLSearchParams(), true).data[0]!.provider,
    'Meadowglass Laboratory',
  );
  const savedExtra = JSON.parse(
    String(f.db.prepare('SELECT extra_json FROM observations').get()!.extra_json),
  );
  assert.equal(savedExtra.import.manuallyEdited, false);
  assert.equal(
    intake.getIntake(f.db, f.root, f.profileId, item.id).workflow?.reportSourceConfirmations
      ?.length || 0,
    0,
  );
});

test('a historical import feed link scopes the exact profile-local intake, report and record', (t) => {
  const f = fixture(t);
  const first = upload(f, [measurement('cookie-first', { report: report() })]);
  upload(
    f,
    [measurement('cookie-second', { report: report('Cookie Doe second report') })],
    'cookie-second.jsonl',
  );
  const all = listIntakeImportFeed(f.db, f.root, f.profileId, { view: 'all' });
  const selected = all.blocks.find((entry) => entry.intakeId === first.id)!;
  const scoped = listIntakeImportFeed(f.db, f.root, f.profileId, {
    view: 'all',
    intakeId: first.id,
    groupId: selected.groupId,
    recordId: selected.records[0]!.id,
  });
  assert.equal(scoped.totalRecords, 1);
  assert.equal(scoped.blocks[0]!.records[0]!.id, selected.records[0]!.id);
  assert.equal(
    listIntakeImportFeed(f.db, f.root, f.profileId, {
      view: 'all',
      intakeId: 'unavailable-intake',
      groupId: selected.groupId,
    }).totalRecords,
    0,
  );
});
