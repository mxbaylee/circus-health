import {
  selectedReportGroups,
  canonicalReportGroupContextChunks,
} from '../intake-selected-report-groups.ts';
import { selectionAuthority } from '../intake-selection-authority.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import {
  prepareCollectionReviewMembership,
  readCollectionReviewMembership,
} from '../intake-review-membership-index.ts';
import {
  collectionWorkflowReviewScope,
  IntakeReviewFragmentRequired,
} from '../intake-review-collection.ts';
import {
  recordCandidateVersions,
  workflowReview,
  workflowReviewSelected,
  intakeCandidateId,
  intakeCandidateVersionId,
} from '../intake-workflow.ts';
import { validateJSONL, canonicalLiteral } from '../intake-format.ts';
import { identityOriginalFingerprintForMember } from '../intake-identity-policy.ts';
import type { IntakeReview, IntakeReviewRecord, IntakeReviewDraft } from '../../shared/intake.ts';

const file = { id: 'fictional-review', sha256: 'c'.repeat(64), mime_type: 'application/pdf' };
const proposalId = 'fictional-proposal';
function input(id: string, subject = 'Iris Meadow') {
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { text: 'Report F27\n' + subject },
    provenance: {
      sourceSystem: 'Fictional issuer',
      sourceRecordId: id,
      capturedVia: null,
      evidenceClass: 'provider_export',
      locator: 'page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: { kind: 'document', title: id, subject: 'unknown' },
    report: {
      key: 'report',
      title: 'Fictional report',
      anchor: { locator: 'page 1', text: 'Report F27' },
      subject: { locator: 'page 1', text: subject },
    },
  };
}
const entries = validateJSONL(
  Buffer.from([input('one'), input('two')].map((item) => JSON.stringify(item)).join('\n')),
).entries!;
function review(): IntakeReview {
  return {
    intakeId: file.id,
    proposalId,
    version: 1,
    reviewToken: 'fictional',
    summary: { additions: 2, duplicates: 0, unsupported: 0, uncertain: 0 },
    coverageGaps: [],
    records: entries.map(
      (entry) =>
        ({
          id: `${proposalId}:line:${entry.line}`,
          classification: 'addition',
          kind: 'document',
          title: entry.value.id,
          date: null,
          provider: 'Fictional issuer',
          confidence: null,
          uncertainties: [],
          evidence: [{ label: 'Original', locator: 'page 1' }],
          mapping: { kind: 'document', subject: 'unknown', documentTitle: entry.value.id },
          supportedFields: [],
          comparisons: [],
        }) satisfies IntakeReviewRecord,
    ),
  };
}
async function fixture(
  t: test.TestContext,
  mutate?: (details: ReturnType<typeof detailsFor>) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-review-scope-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional-profile');
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const details = detailsFor();
  mutate?.(details);
  const initial = prepareInitialIntakeEnvelope({
    intake: { version: 1, originalName: 'fictional.pdf', ...details },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(file.id, 'fictional.pdf', file.sha256, 0, 'intake_original', initial.detailsJson);
    createIntakeStateStorage(db, {
      profileId: 'fictional-profile',
      intakeId: file.id,
      sourceHash: file.sha256,
    }).stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(db, file);
  await buildVerifiedWorkflowSummary(db, file, {
    mappingVersion: 'fictional-review-mapping',
    isSourceContextVersion: () => false,
  });
  await prepareCollectionReviewMembership(db, file);
  const open = (metadataBytes = 128 * 1024) => {
    const view = openIntakeCollectionEnvelope(db, file);
    return collectionWorkflowReviewScope({
      view,
      membershipIndex: readCollectionReviewMembership(db, file, view),
      catalog: createReportSnapshotCatalog(db, file),
      metadataBytes,
      packageEvidence: false,
      activeReceipt: () => true,
      originalFingerprint: (group) =>
        identityOriginalFingerprintForMember(file.id, file.sha256, group.memberId, undefined),
      reportSource: () => undefined,
    });
  };
  return { db, details, open };
}
function detailsFor() {
  const details: {
    proposals: { id: string }[];
    workflow?: ReturnType<typeof import('../intake-workflow.ts').intakeWorkflow>;
  } = { proposals: [{ id: proposalId }] };
  recordCandidateVersions(file, details, entries, proposalId);
  return details;
}
const self = {
  noteId: 'person-note:self' as const,
  version: 1,
  fullName: 'Iris Meadow',
  birthDate: null,
  knownNames: [],
};
const identity = {
  profileId: 'fictional-profile',
  people: [],
  grounded: () => false,
  subjectGrounded: () => true,
  originalBirthDateEvidence: () => ({ dates: [], unreadable: false }),
};

test('selected clinical engine matches legacy full proposal while joins remain off-page and historical', async (t) => {
  const { details, open } = await fixture(t, (details) => {
    const candidateId = intakeCandidateId(file, entries[0]!);
    const versionId = intakeCandidateVersionId(details, proposalId, entries[0]!);
    const draft = {
      id: 'old',
      proposalId,
      recordId: `${proposalId}:line:1`,
      candidateId,
      candidateVersionId: versionId,
      disposition: 'review_later',
      mapping: { documentTitle: 'Older' },
      resolutions: [],
      at: '2026-01-01',
    } as IntakeReviewDraft;
    details.workflow!.reviewDrafts.push(draft, {
      ...draft,
      id: 'latest',
      mapping: { documentTitle: 'Latest' },
    });
    const other = validateJSONL(
      Buffer.from(JSON.stringify(input('off-page', 'Rowan River'))),
    ).entries!;
    recordCandidateVersions(file, details, other, 'historical-proposal');
  });
  const expected = workflowReview(file, details, review(), entries, self, identity);
  const actual = workflowReviewSelected(file, open(), review(), entries, self, identity);
  assert.deepEqual(actual, expected);
  assert.equal(actual.records[0]!.draft?.id, 'latest');
  assert.equal(actual.records[0]!.identityReview?.blocking, true);
  assert.match(actual.records[0]!.identityReview!.message, /conflicting subject claims/);
});

test('selected source joins retain first introduction and duplicate candidate/version semantics after cache loss', async (t) => {
  const { db, details, open } = await fixture(t, (details) => {
    recordCandidateVersions(file, details, entries, 'later-proposal');
    const first = details.workflow!.candidates[0]!;
    const clone = structuredClone(first);
    clone.versions[0]!.status = 'kept_original';
    details.workflow!.candidates.push(clone);
    first.versions.push({ ...structuredClone(first.versions[0]!), status: 'kept_original' });
  });
  clearIntakeStateCache(db);
  const scope = open(),
    record = entries[0]!;
  const candidateId = intakeCandidateId(file, record),
    versionId = intakeCandidateVersionId(details, proposalId, record);
  assert.equal(scope.keptOriginal(candidateId, versionId), true);
  const expected = workflowReview(file, details, review(), entries, self, identity);
  assert.deepEqual(
    workflowReviewSelected(file, scope, review(), entries, self, identity),
    expected,
  );
  assert.equal(
    selectedReportGroups(
      scope.references(candidateId, versionId, `${proposalId}:line:1`, proposalId),
    ).find(() => true)?.groupVersionId,
    details.workflow!.reportGroups![0]!.versions[0]!.id,
  );
});

test('oversized selected evidence yields exact fragment address without treating it as absent', async (t) => {
  const { open } = await fixture(t, (details) => {
    details.workflow!.reportGroups![0]!.report!.anchor.text = 'Fictional ' + 'x'.repeat(200_000);
  });
  const scope = open(4096);
  assert.throws(
    () => workflowReviewSelected(file, scope, review(), entries, self, identity),
    (error) =>
      error instanceof IntakeReviewFragmentRequired &&
      error.reference.field === 'report' &&
      !!error.reference.logical &&
      !!error.reference.address,
  );
});

test('prepared membership retains duplicate occurrence union and warm joins never walk retained members', async (t) => {
  const { db, details } = await fixture(t, (details) => {
    const group = details.workflow!.reportGroups![0]!,
      first = group.versions[0]!,
      member = structuredClone(first.members[0]!);
    member.occurrences = [{ ...member.occurrences[0]!, recordId: 'fictional-duplicate-only' }];
    (member as unknown as Record<string, unknown>).retainedUnknown = {
      text: 'Fictional ' + 'e'.repeat(300_000),
    };
    first.members.push(member);
    const later = structuredClone(first);
    later.id = 'fictional-later-version';
    group.versions.push(later);
    details.workflow!.reportGroups!.push({ ...structuredClone(group), versions: [later] });
  });
  clearIntakeStateCache(db);
  const selected = openIntakeCollectionEnvelope(db, file),
    guarded = {
      ...selected,
      children() {
        throw Error('Warm membership must not walk any child collection');
      },
    },
    index = readCollectionReviewMembership(db, file, guarded);
  const group = details.workflow!.reportGroups![0]!,
    member = group.versions[0]!.members[0]!;
  assert.equal(index.covered(member.candidateId, member.candidateVersionId), true);
  assert.deepEqual(
    [
      ...index.references(
        member.candidateId,
        member.candidateVersionId,
        'fictional-duplicate-only',
        proposalId,
      ),
    ],
    [
      { groupId: group.id, groupVersionId: group.versions[0]!.id },
      { groupId: group.id, groupVersionId: 'fictional-later-version' },
    ],
  );
  const flow = selected.child(selected.child(selected.root(), 'intake')!, 'workflow')!,
    groupRecord = selected.childAt(flow, 'reportGroups', 0)!,
    version = selected.childAt(groupRecord, 'versions', 0)!;
  assert.equal(
    index.contains(
      version,
      member.candidateId,
      member.candidateVersionId,
      'fictional-duplicate-only',
      proposalId,
    ),
    true,
  );
  assert.equal(
    selected.address(index.member(version, member.candidateId, member.candidateVersionId)!),
    selected.address(selected.childAt(version, 'members', 0)!),
  );
  assert.deepEqual(
    [
      ...index.references(
        member.candidateId,
        member.candidateVersionId,
        'fictional-absent',
        proposalId,
      ),
    ],
    [],
  );
});

test('legacy ungrouped candidates keep exact virtual fallback versions and historical occurrences', async (t) => {
  const { details, open } = await fixture(t, (details) => {
    details.workflow!.reportGroups = [];
    recordCandidateVersions(file, details, entries, 'later-proposal');
    details.workflow!.reportGroups = [];
    const duplicate = structuredClone(details.workflow!.candidates[0]!);
    duplicate.versions[0]!.occurrences.push({
      proposalId: 'historical',
      recordId: 'historical:line:1',
      batchId: null,
      locator: 'page 7',
    });
    details.workflow!.candidates.push(duplicate);
  });
  const expected = workflowReview(file, details, review(), entries, self, identity);
  assert.deepEqual(
    workflowReviewSelected(file, open(), review(), entries, self, identity),
    expected,
  );
  assert.ok(expected.records.every((record) => selectedReportGroups(record.reportGroups).length));
});

test('large natural identity receipts retain complete lazy target and historical membership joins', async (t) => {
  const { details, open } = await fixture(t, (details) => {
    const group = details.workflow!.reportGroups![0]!,
      version = group.versions[0]!;
    const candidateId = intakeCandidateId(file, entries[0]!),
      candidateVersionId = intakeCandidateVersionId(details, proposalId, entries[0]!);
    const targets = Array.from({ length: 320 }, (_, index) => ({
      candidateId,
      candidateVersionId,
      proposalId,
      recordId: `unrelated:${index}`,
      title: 'Fictional title ' + 'x'.repeat(480),
      issueId: 'unrelated',
    }));
    targets.push({
      candidateId,
      candidateVersionId,
      proposalId,
      recordId: `${proposalId}:line:1`,
      title: 'Exact selected occurrence',
      issueId: 'selected',
    });
    details.workflow!.identityConfirmations = [
      {
        operationId: 'fictional-large-receipt',
        at: '2026-01-01',
        outcome: 'this_is_me',
        attestation: 'confirmed_displayed_identity_questions',
        draftIds: targets.map((_, i) => 'draft:' + i),
        scope: {
          profileId: 'fictional-profile',
          intakeId: file.id,
          intakeVersion: 1,
          groupId: group.id,
          groupVersionId: version.id,
          sourceHash: file.sha256,
          memberId: null,
          original: { filename: 'fictional.pdf', contentUrl: '/fictional', page: 1 },
          report: group.report!.anchor,
          subject: group.report!.subject!,
          verificationMode: 'human_reviewed_original',
          evidencedIdentity: { fullName: 'Iris Meadow' },
          evidenceOriginalFingerprint: identityOriginalFingerprintForMember(
            file.id,
            file.sha256,
            null,
            undefined,
          ),
          membership: version.members,
          targets,
          assignmentTargets: targets,
          scopeToken: 'fictional-scope',
        },
      },
    ];
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(details.workflow!.identityConfirmations![0])) > 256 * 1024,
  );
  const scope = open(32 * 1024),
    receipt = scope.receipts.find(() => true)!;
  assert.equal(receipt.scope.targets.length, 321);
  assert.equal(Array.isArray(receipt.scope.targets), false);
  assert.equal(
    receipt.scope.targets.find((target) => target.issueId === 'selected')?.recordId,
    `${proposalId}:line:1`,
  );
  assert.deepEqual(
    workflowReviewSelected(file, scope, review(), entries, self, identity),
    workflowReview(file, details, review(), entries, self, identity),
  );
});

test('selected report links exceed display budget without losing off-page identity or legacy commitments', async (t) => {
  const { details, open } = await fixture(t, (details) => {
    const group = details.workflow!.reportGroups![0]!;
    for (let index = 0; index < 12; index++) {
      const copy = structuredClone(group);
      copy.id = 'report-group:fictional-additional-' + index;
      if (index === 11) copy.report!.subject!.text = 'Noah Harbor';
      details.workflow!.reportGroups!.push(copy);
    }
  });
  const scope = open(1024),
    entry = entries[0]!,
    candidateId = intakeCandidateId(file, entry),
    versionId = intakeCandidateVersionId(details, proposalId, entry),
    links = scope.references(candidateId, versionId, proposalId + ':line:1', proposalId);
  assert.equal(Array.isArray(links), false);
  if (Array.isArray(links)) throw Error('Expected explicitly referenced report links');
  assert.equal(links.count, 13);
  assert.equal([...selectedReportGroups(links)].length, 13);
  assert.equal(
    [...selectedReportGroups(links)].at(-1)!.groupId,
    'report-group:fictional-additional-11',
  );
  const expected = workflowReview(file, details, review(), entries, self, identity),
    actual = workflowReviewSelected(file, scope, review(), entries, self, identity);
  assert.equal(actual.records[0]!.identityReview?.blocking, true);
  assert.deepEqual(actual.records[0]!.identityReview, expected.records[0]!.identityReview);
  assert.equal(
    [...scope.canonicalReviewRecords(actual.records)].join(''),
    canonicalLiteral(expected.records),
  );
  assert.equal(selectionAuthority(actual.records[0]), selectionAuthority(expected.records[0]));
  assert.equal(
    [
      ...canonicalReportGroupContextChunks({
        groups: links,
        ignored: undefined,
        raw: JSON.rawJSON('1.0'),
      }),
    ].join(''),
    JSON.stringify({ groups: [...selectedReportGroups(links)], raw: { rawJSON: '1.0' } }),
  );
});
