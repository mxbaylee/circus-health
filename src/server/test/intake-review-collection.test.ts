import { collectSelectedEvidencedIdentity } from '../intake-identity-name-evidence.ts';
import { collectEvidencedIdentity } from '../intake-identity-policy.ts';
import { canonicalReviewValueChunks } from '../intake-review-question-state.ts';
import { retainedEnvelopeReader } from './helpers/retained-envelope-reader.ts';
import {
  selectedReportGroups,
  canonicalReportGroupContextChunks,
} from '../intake-selected-report-groups.ts';
import { selectionAuthority } from '../intake-selection-authority.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { schemaOrdinal } from '../intake-envelope-schema.ts';
import { IDENTITY_SNAPSHOT_FORMAT } from '../intake-identity-snapshot.ts';
import { createReportMemberSnapshot } from '../intake-report-member-state.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import { withIntakeWork, intakeWorkCounters, recordIntakeWork } from '../intake-work-accounting.ts';
import type { IntakeIdentityScopeReference } from '../../shared/intake-identity.ts';
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
  intakeCandidateVersionIdForRevision,
} from '../intake-workflow.ts';
import { validateJSONL, canonicalLiteral, parseLiteralJSON } from '../intake-format.ts';
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
  nativeReceipts?: unknown[],
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
    intake: {
      version: 1,
      originalName: 'fictional.pdf',
      ...details,
      ...(nativeReceipts
        ? { workflow: { ...details.workflow, identityConfirmations: nativeReceipts } }
        : {}),
    },
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
  const open = (
    metadataBytes = 128 * 1024,
    observe?: (view: ReturnType<typeof openIntakeCollectionEnvelope>) => void,
    readCacheState?: () => string | undefined,
    policySql?: DatabaseSync,
  ) => {
    const view = openIntakeCollectionEnvelope(db, file);
    observe?.(view);
    const scope = collectionWorkflowReviewScope({
      view,
      membershipIndex: readCollectionReviewMembership(db, file, view),
      catalog: createReportSnapshotCatalog(db, file),
      metadataBytes,
      readCacheState,
      policySql,
      packageEvidence: false,
      activeReceipt: () => true,
      originalFingerprint: (group) =>
        identityOriginalFingerprintForMember(file.id, file.sha256, group.memberId, undefined),
      reportSource: () => undefined,
    });
    t.after(() => scope.close?.());
    return scope;
  };
  return { db, details, open, root };
}
function detailsFor() {
  const details: {
    proposals: {
      id: string;
      sourceTextDependencyToken?: string | null;
      sourceTextRevisionId?: string | null;
    }[];
    workflow?: ReturnType<typeof import('../intake-workflow.ts').intakeWorkflow>;
  } = { proposals: [{ id: proposalId }] };
  recordCandidateVersions(file, details, entries, proposalId);
  return details;
}

test('proposal revision memo retains exact first selected metadata and invalidates peer, transaction, failure and close', async (t) => {
  const f = await fixture(t, (details) => {
    details.proposals = [
      {
        id: proposalId,
        sourceTextDependencyToken: 'dependency-first',
        sourceTextRevisionId: 'unused',
      },
      { id: proposalId, sourceTextDependencyToken: 'later-duplicate' },
      { id: 'fallback', sourceTextDependencyToken: '', sourceTextRevisionId: 'fallback-revision' },
      { id: 'null-pins', sourceTextDependencyToken: null, sourceTextRevisionId: null },
    ];
  });
  f.db.exec('CREATE TABLE fictional_revision_witness(value TEXT)');
  let fail = false,
    drift = false;
  using peer = new DatabaseSync(join(f.root, 'cache.sqlite'));
  const scope = f.open(
    undefined,
    (view) => {
      const find = view.find.bind(view);
      view.find = (...args) => {
        if (args[0] === 'proposal') {
          if (fail) throw Error('Fictional refused proposal metadata');
          if (drift) {
            drift = false;
            peer.prepare('INSERT INTO fictional_revision_witness VALUES(?)').run('cold drift');
          }
        }
        return find(...args);
      };
    },
    () => reviewReadStamp(f.db),
  );
  const read = (id: string | null = proposalId) =>
    withIntakeWork(f.db, 'warm', () => scope.versionId(id, entries[0]!));
  assert.equal(read(), intakeCandidateVersionIdForRevision(entries[0]!, 'dependency-first'));
  const before = intakeWorkCounters(f.db).warm;
  for (let n = 0; n < 70; n++)
    assert.equal(read(), intakeCandidateVersionIdForRevision(entries[0]!, 'dependency-first'));
  assert.equal(
    intakeWorkCounters(f.db).warm.reviewProposalRevisionReads - before.reviewProposalRevisionReads,
    0,
  );
  assert.equal(
    intakeWorkCounters(f.db).warm.reviewProposalRevisionHits - before.reviewProposalRevisionHits,
    70,
  );
  const changed = { ...entries[0]!, value: { ...entries[0]!.value, id: 'different-body' } };
  assert.equal(
    withIntakeWork(f.db, 'warm', () => scope.versionId(proposalId, changed)),
    intakeCandidateVersionIdForRevision(changed, 'dependency-first'),
    'warm metadata never substitutes a retained candidate body or version hash',
  );
  assert.notEqual(scope.versionId(proposalId, changed), scope.versionId(proposalId, entries[0]!));
  assert.equal(
    read('fallback'),
    intakeCandidateVersionIdForRevision(entries[0]!, 'fallback-revision'),
  );
  assert.equal(read('absent'), intakeCandidateVersionIdForRevision(entries[0]!, undefined));
  const nullPins = intakeWorkCounters(f.db).warm;
  assert.equal(read('null-pins'), intakeCandidateVersionIdForRevision(entries[0]!, null));
  assert.equal(read('null-pins'), intakeCandidateVersionIdForRevision(entries[0]!, null));
  assert.equal(
    intakeWorkCounters(f.db).warm.reviewProposalRevisionReads -
      nullPins.reviewProposalRevisionReads,
    1,
  );
  assert.equal(
    intakeWorkCounters(f.db).warm.reviewProposalRevisionHits - nullPins.reviewProposalRevisionHits,
    1,
    'native absent source pins retain literal null rather than being excluded',
  );
  assert.equal(read(null), intakeCandidateVersionIdForRevision(entries[0]!, undefined));
  peer.prepare('INSERT INTO fictional_revision_witness VALUES(?)').run('peer');
  const peerBefore = intakeWorkCounters(f.db).warm;
  read();
  assert.equal(
    intakeWorkCounters(f.db).warm.reviewProposalRevisionReads -
      peerBefore.reviewProposalRevisionReads,
    1,
  );
  f.db.exec('BEGIN');
  read();
  read();
  f.db.exec('ROLLBACK');
  const rollback = intakeWorkCounters(f.db).warm;
  read();
  assert.equal(
    intakeWorkCounters(f.db).warm.reviewProposalRevisionReads -
      rollback.reviewProposalRevisionReads,
    1,
  );
  fail = true;
  assert.throws(() => read('never-cached'), /refused proposal metadata/);
  fail = false;
  const refused = intakeWorkCounters(f.db).warm;
  read();
  assert.equal(
    intakeWorkCounters(f.db).warm.reviewProposalRevisionReads - refused.reviewProposalRevisionReads,
    1,
  );
  drift = true;
  read('cold');
  const cold = intakeWorkCounters(f.db).warm;
  read('cold');
  assert.equal(
    intakeWorkCounters(f.db).warm.reviewProposalRevisionReads - cold.reviewProposalRevisionReads,
    1,
    'drift during construction cannot seed',
  );
  scope.close!();
  assert.throws(() => read(), /scope closed/);
});

test('proposal revision memo falls back beyond count and aggregate bytes without changing version recipes', async (t) => {
  for (const [count, bytes] of [
    [33, 0],
    [32, 9000],
  ] as const) {
    const f = await fixture(t, (details) => {
      details.proposals = Array.from({ length: count }, (_, n) => ({
        id: 'revision-' + n,
        sourceTextDependencyToken: ('revision-' + n).padEnd(bytes, 'x'),
      }));
    });
    const scope = f.open(undefined, undefined, () => reviewReadStamp(f.db));
    const scan = () =>
      withIntakeWork(f.db, 'warm', () =>
        f.details.proposals.forEach((proposal) =>
          assert.equal(
            scope.versionId(proposal.id, entries[0]!),
            intakeCandidateVersionIdForRevision(entries[0]!, proposal.sourceTextDependencyToken),
          ),
        ),
      );
    scan();
    const before = intakeWorkCounters(f.db).warm;
    scan();
    assert.equal(
      intakeWorkCounters(f.db).warm.reviewProposalRevisionReads -
        before.reviewProposalRevisionReads,
      count,
      'complete scan falls back after bounded eviction',
    );
    scope.close!();
  }
});
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

test('selected report headers reuse authenticated fields only within the supplied current state', async (t) => {
  const { db, open } = await fixture(t);
  const statement = db.prepare('SELECT total_changes() AS changes');
  let reads = 0,
    pages = 0;
  const scope = open(
    128 * 1024,
    (view) => {
      const field = view.field.bind(view);
      view.field = (...args) => {
        reads++;
        return field(...args);
      };
      const children = view.children.bind(view);
      view.children = (...args) => {
        pages++;
        return children(...args);
      };
    },
    () => String(statement.get()!.changes),
  );
  const group = scope.groupRecords()[Symbol.iterator]().next().value!;
  const before = reads,
    first = scope.groupHeader(group),
    hydrated = reads - before;
  assert.ok(hydrated > 0);
  for (let index = 0; index < 32; index++) assert.deepEqual(scope.groupHeader(group), first);
  assert.equal(reads - before, hydrated);
  db.prepare(
    "INSERT INTO providers(id,name) VALUES('fictional-header-cache','Fictional header cache')",
  ).run();
  assert.deepEqual(scope.groupHeader(group), first);
  assert.equal(reads - before, 2 * hydrated);
  const target = {
    candidateId: 'fictional-candidate',
    candidateVersionId: 'fictional-version',
    proposalId,
    recordId: 'fictional-record',
    title: 'Fictional',
    issueId: 'identity',
  };
  const reference = { groupId: first.id, groupVersionId: scope.currentVersion(first)! };
  const beforeReference = pages;
  assert.deepEqual(scope.group(reference), first);
  const referencePages = pages - beforeReference;
  assert.ok(referencePages > 0);
  for (let index = 0; index < 32; index++) assert.deepEqual(scope.group(reference), first);
  assert.equal(pages - beforeReference, referencePages);
  const beforeBoundary = pages;
  assert.equal(scope.competingBoundaryUnrepaired(first, undefined, target), false);
  const boundaryPages = pages - beforeBoundary;
  assert.ok(boundaryPages > 0);
  for (let index = 0; index < 32; index++)
    assert.equal(scope.competingBoundaryUnrepaired(first, undefined, target), false);
  assert.equal(pages - beforeBoundary, boundaryPages);
  db.prepare(
    "UPDATE providers SET name='Fictional changed header cache' WHERE id='fictional-header-cache'",
  ).run();
  assert.equal(scope.competingBoundaryUnrepaired(first, undefined, target), false);
  assert.equal(pages - beforeBoundary, 2 * boundaryPages);
  const changedReference = pages;
  assert.deepEqual(scope.group(reference), first);
  assert.equal(pages - changedReference, referencePages);
});

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

test('selected draft handoff falls back after peer writes, transaction observation and scope close', async (t) => {
  const { db, root, open } = await fixture(t, (details) => {
    details.workflow!.reviewDrafts.push({
      id: 'fictional-proof-draft',
      proposalId,
      recordId: `${proposalId}:line:1`,
      candidateId: intakeCandidateId(file, entries[0]!),
      candidateVersionId: intakeCandidateVersionId(details, proposalId, entries[0]!),
      mapping: { documentTitle: 'Fictional reviewed title' },
      resolutions: [],
      disposition: 'pending',
      at: '2026-01-01',
    });
  });
  db.exec('CREATE TABLE fictional_draft_proof(value TEXT)');
  using peer = new DatabaseSync(join(root, 'cache.sqlite'));
  const scope = open(128 * 1024, undefined, () => reviewReadStamp(db));
  const record = review().records[0]!,
    version = scope.versionId(proposalId, entries[0]!);
  const bind = () => {
    const selected = scope.draft(proposalId, record.id, version);
    scope.bindPreparedDraft!(record, selected);
    return selected;
  };
  const consume = () => scope.preparedDraft!(proposalId, record, version);
  const first = bind();
  assert.equal(consume(), first);
  assert.equal(consume(), undefined);
  bind();
  peer.prepare('INSERT INTO fictional_draft_proof VALUES(?)').run('peer mutation');
  assert.equal(consume(), undefined, 'peer data_version invalidates handoff');
  assert.equal(
    scope.draft(proposalId, record.id, version)?.id,
    first?.id,
    'fresh indexed fallback',
  );
  bind();
  db.exec('BEGIN');
  try {
    assert.equal(consume(), undefined, 'transaction state cannot consume previous proof');
  } finally {
    db.exec('ROLLBACK');
  }
  assert.equal(consume(), undefined, 'rollback cannot revive one-use capture');
  bind();
  scope.close!();
  assert.equal(consume(), undefined, 'close releases all associations');
  assert.throws(() => bind(), /closed/);
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

test('ownership scope preserves bound group and version methods and dispatches cooperative fallback policy', async (t) => {
  const { db, details, open } = await fixture(t, (details) => {
    details.workflow!.reportGroups = [];
  });
  const { ownershipIdentityBlockersWork } = await import('../record-ownership-authority.ts');
  const expected = workflowReview(file, details, review(), entries, self, identity);
  const record = expected.records[0]!;
  const reference = [...selectedReportGroups(record.reportGroups)][0]!;
  const scope = open().ownershipScope(() => undefined, 1);
  const group = scope.group(reference.groupId)!;
  assert.equal(group.basis, 'candidate_fallback');
  assert.equal(scope.currentVersion(group), reference.groupVersionId);

  const drain = <T>(work: Generator<void, T, void>) => {
    let checkpoints = 0;
    for (;;) {
      const step = work.next();
      if (step.done) return { value: step.value, checkpoints };
      checkpoints++;
    }
  };
  const cooperative = open().ownershipScope(() => undefined, 1);
  const groupResult = drain(cooperative.groupWork!(reference.groupId));
  assert.deepEqual(groupResult.value, group);
  assert.ok(groupResult.checkpoints > 0, 'cold fallback group preparation exposes checkpoints');
  const versionResult = drain(open().ownershipScope(() => undefined, 1).currentVersionWork!(group));
  assert.equal(versionResult.value, reference.groupVersionId);
  assert.ok(versionResult.checkpoints > 0, 'cold fallback version preparation exposes checkpoints');

  const expectedBlockers = [
    ...ownershipIdentityBlockersWork(db, file.id, record, null, scope),
  ].filter((value) => value !== undefined);
  let groupCalls = 0;
  const actualBlockers = [
    ...ownershipIdentityBlockersWork(db, file.id, record, null, {
      ...cooperative,
      group() {
        throw Error('Native ownership must use the cooperative group method');
      },
      *groupWork(id) {
        groupCalls++;
        return yield* cooperative.groupWork!(id);
      },
    }),
  ].filter((value) => value !== undefined);
  assert.deepEqual(actualBlockers, expectedBlockers);
  assert.equal(groupCalls, 1);
});

// Publish 96 unrelated candidates and 96 historical occurrences before checking
// full synchronous/cooperative parity, host progress and cancellation cleanup.
test(
  'native fallback reference work yields during nonmatching history and preserves exact virtual hashes and tokens',
  { timeout: 300000 },
  async (t) => {
    const { details, open } = await fixture(t, (details) => {
      details.workflow!.reportGroups = [];
      const duplicate = structuredClone(details.workflow!.candidates[0]!);
      for (let index = 0; index < 96; index++)
        duplicate.versions[0]!.occurrences.push({
          proposalId: 'fictional-historical',
          recordId: 'fictional-absent:' + index,
          batchId: null,
          locator: 'page ' + (index + 2),
        });
      details.workflow!.candidates.push(duplicate);
      for (let index = 0; index < 96; index++) {
        const unrelated = structuredClone(details.workflow!.candidates[1]!);
        unrelated.id = 'fictional-unrelated:' + index;
        details.workflow!.candidates.push(unrelated);
      }
    });
    const { runClinicalReviewWork } = await import('../clinical-review-work.ts');
    const { workflowReviewSelectedWork } = await import('../intake-workflow.ts');
    const expected = workflowReview(file, details, review(), entries, self, identity);
    const policySql = new DatabaseSync(':memory:');
    t.after(() => policySql.isOpen && policySql.close());
    const scope = open(128 * 1024, undefined, undefined, policySql);
    let steps = 0,
      observed = 0,
      complete = false;
    const wrapped = function* <T>(work: Generator<void, T, void>) {
      try {
        for (;;) {
          const next = work.next();
          if (next.done) return next.value;
          steps++;
          yield;
        }
      } finally {
        work.return(undefined as never);
      }
    };
    setImmediate(() => {
      if (!complete) observed = steps;
    });
    const actual = await runClinicalReviewWork(
      wrapped(workflowReviewSelectedWork(file, scope, review(), entries, self, identity)),
      {
        capture() {
          return () => {};
        },
      },
    );
    complete = true;
    assert.ok(
      observed > 0 && observed < 96,
      'host turn ran before the unmatched candidate scan finished',
    );
    assert.deepEqual(actual, expected);
    for (let index = 0; index < actual.records.length; index++)
      assert.equal(
        selectionAuthority(actual.records[index]),
        selectionAuthority(expected.records[index]),
      );
    scope.close?.();
    assert.ok(policySql.isOpen, 'closing one scope preserves the host-owned policy store');
    const cancelled = open(128 * 1024, undefined, undefined, policySql);
    const controller = new AbortController();
    setImmediate(() => controller.abort(Error('fictional fallback cancellation')));
    await assert.rejects(
      runClinicalReviewWork(
        workflowReviewSelectedWork(file, cancelled, review(), entries, self, identity),
        {
          signal: controller.signal,
          capture() {
            return () => {};
          },
        },
      ),
      (error) =>
        error === controller.signal.reason ||
        (error instanceof Error &&
          error.name === 'AbortError' &&
          error.cause === controller.signal.reason),
    );
    cancelled.close?.();
    assert.ok(policySql.isOpen, 'cancelled scope cleanup preserves the owner lifetime');
    policySql.close();
    scope.close?.();
    cancelled.close?.();
  },
);

// A retained receipt larger than 256 KiB has 321 exact targets and complete historical policy parity; its work is not a display-page read.
// This is a host-integration hang guard; correctness remains count/evidence based.
test(
  'large natural identity receipts retain complete lazy target and historical membership joins',
  { timeout: 300000 },
  async (t) => {
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
  },
);

// Thirteen retained report links exercise off-page identity and complete canonical/token parity.
// This is a host-integration hang guard; correctness remains count/evidence based.
test(
  'selected report links exceed display budget without losing off-page identity or legacy commitments',
  { timeout: 60000 },
  async (t) => {
    const { db, details, open } = await fixture(t, (details) => {
      const group = details.workflow!.reportGroups![0]!;
      for (let index = 0; index < 12; index++) {
        const copy = structuredClone(group);
        copy.id = 'report-group:fictional-additional-' + index;
        if (index === 11) copy.report!.subject!.text = 'Noah Harbor';
        details.workflow!.reportGroups!.push(copy);
      }
    });
    const state = db.prepare('SELECT total_changes() AS changes');
    const scope = open(1024, undefined, () => String(state.get()!.changes)),
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
  },
);

// Sixty-four unrelated groups surround the selected group while actual policy mutations test reuse and refusal.
// This is a host-integration hang guard; correctness remains count/evidence based.
test(
  'native ownership policy skips membership work only with complete current empty authority and preserves off-page holds',
  { timeout: 90000 },
  async (t) => {
    const { prepareOwnershipDecisionIndex, ownershipPolicyIndexWork } =
      await import('../ownership-decision-index.ts');
    const { requireCorrectedOwnershipReview } = await import('../record-ownership-authority.ts');
    const { db, details, open } = await fixture(t, (details) => {
      const selected = details.workflow!.reportGroups![0]!;
      details.workflow!.reportGroups = [
        ...Array.from({ length: 64 }, (_, i) => ({
          ...structuredClone(selected),
          id: 'unrelated-' + i,
          versions: [],
        })),
        selected,
      ];
    });
    let idReads = 0;
    const scope = open(undefined, (view) => {
      const field = view.field;
      view.field = (record, name, options) => {
        if (record.kind === 'reportGroup' && name === 'id') idReads++;
        return field(record, name, options);
      };
    });
    const ownership = scope.ownershipScope!(() => undefined, 1),
      entry = entries[0]!,
      references = scope.references(
        intakeCandidateId(file, entry),
        intakeCandidateVersionId(details, proposalId, entry),
        `${proposalId}:line:1`,
        proposalId,
      );
    const record = { ...review().records[0]!, reportGroups: references },
      identity = 'fictional-native-identity';
    const compare = () => {
      const legacy = structuredClone(record),
        actual = structuredClone(record);
      requireCorrectedOwnershipReview(db, legacy, identity, file, details.workflow);
      requireCorrectedOwnershipReview(db, actual, identity, file, undefined, ownership);
      assert.deepEqual(actual, legacy);
      return actual;
    };
    compare();
    assert.equal(idReads, 2, 'unprepared index retains the complete authoritative policy path');
    await prepareOwnershipDecisionIndex(db);
    idReads = 0;
    for (let i = 0; i < 12; i++) compare();
    assert.equal(
      idReads,
      0,
      'complete current empty policy does not read any group header or membership',
    );
    assert.deepEqual(ownershipPolicyIndexWork(db), { checks: 12, empty: 12 });
    const selected = details.workflow!.reportGroups!.at(-1)!;
    const insert = db.prepare(
      "INSERT INTO manual_batches(id,title,status,created_at,coverage_json) VALUES(?,?,'verified','2026-01-01',?)",
    );
    db.exec('BEGIN');
    insert.run(
      'held-report',
      'Report ownership default hold',
      JSON.stringify({
        groupId: selected.id,
        intakeId: file.id,
        defaultOperationId: 'former',
        operationId: 'hold',
        intakeVersion: 1,
        revision: 1,
      }),
    );
    const held = compare();
    assert.equal(held.identityReview?.blocking, true);
    assert.match(held.identityReview!.message, /earlier report assignment/);
    assert.equal(
      idReads,
      2,
      'off-page relevant group validates one point identity and reads one header instead of scanning 65 group IDs',
    );
    db.exec('ROLLBACK');
    idReads = 0;
    compare();
    assert.equal(idReads, 0, 'rollback restores the exact empty authority proof');
    insert.run(
      'source-correction',
      'Record ownership source',
      JSON.stringify({ identity, sourceHash: 'wrong', revision: 2 }),
    );
    assert.match(compare().identityReview!.message, /boundary changed/);
    db.prepare(
      "UPDATE manual_batches SET title='Record ownership event' WHERE id='source-correction'",
    ).run();
    idReads = 0;
    compare();
    assert.equal(idReads, 0);
    insert.run(
      'report-default',
      'Report ownership default',
      JSON.stringify({ groupId: selected.id, intakeId: file.id, boundary: 'wrong', revision: 3 }),
    );
    assert.match(compare().identityReview!.message, /boundary changed/);
    db.prepare("DELETE FROM manual_batches WHERE id='report-default'").run();
    idReads = 0;
    compare();
    assert.equal(idReads, 0);
    db.exec('DROP TRIGGER temp.__ownership_decision_index_update');
    assert.throws(() => compare(), /Prepare complete accepted ownership evidence/);
    await prepareOwnershipDecisionIndex(db);
    idReads = 0;
    compare();
    assert.equal(idReads, 0);
  },
);

// Retained group ordering and duplicate identifiers are checked against the complete ownership policy.
// This is a host-integration hang guard; correctness remains count/evidence based.
test(
  'ownership first-group point lookup preserves retained collection order and duplicate IDs',
  { timeout: 60000 },
  async (t) => {
    const { open, details } = await fixture(t, (details) => {
      const original = details.workflow!.reportGroups![0]!;
      details.workflow!.reportGroups = [
        {
          ...structuredClone(original),
          id: 'duplicate',
          report: { ...original.report!, title: 'First duplicate' },
        },
        { ...structuredClone(original), id: 'middle' },
        ...Array.from({ length: 32 }, (_, i) => ({
          ...structuredClone(original),
          id: 'unrelated-' + i,
          versions: [],
        })),
        {
          ...structuredClone(original),
          id: 'duplicate',
          report: { ...original.report!, title: 'Last duplicate' },
        },
      ];
    });
    let reads = 0;
    const scope = open(undefined, (view) => {
        const field = view.field;
        view.field = (record, name, options) => {
          if (record.kind === 'reportGroup' && name === 'id') reads++;
          return field(record, name, options);
        };
      }),
      ownership = scope.ownershipScope!(() => undefined, 1),
      references = [
        { groupId: 'missing', groupVersionId: 'missing' },
        { groupId: 'middle', groupVersionId: 'version' },
        { groupId: 'duplicate', groupVersionId: 'version' },
      ];
    const expected = details.workflow!.reportGroups!.find((group) =>
      references.some((ref) => ref.groupId === group.id),
    )!;
    const selected = ownership.firstGroup(references);
    assert.equal(selected?.id, expected.id);
    assert.equal(selected?.report?.title, expected.report?.title);
    assert.equal(reads, 3);
    const { selectedReportGroupLinks } = await import('../intake-selected-report-groups.ts');
    const linked = selectedReportGroupLinks(
      () => references,
      {
        candidateId: 'fictional',
        candidateVersionId: 'fictional-version',
        recordId: 'fictional-record',
        proposalId: null,
      },
      1,
    );
    assert.equal(Array.isArray(linked), false);
    assert.equal(ownership.firstGroup(linked)?.report?.title, expected.report?.title);
    assert.equal(
      ownership.firstGroup([{ groupId: 'synthetic-fallback', groupVersionId: 'version' }]),
      undefined,
    );
  },
);

test('complete group resolution uses indexed work beyond the private cache and retains later duplicate versions', () => {
  const count = 71,
    details = detailsFor(),
    original = details.workflow!.reportGroups![0]!;
  details.workflow!.reportGroups = Array.from({ length: count }, (_, n) => ({
    ...structuredClone(original),
    id: 'fictional-counted-group-' + n,
    report: { ...original.report!, title: 'Fictional counted group ' + n },
    versions: [
      { ...structuredClone(original.versions[0]!), id: 'fictional-version-' + n, members: [] },
    ],
  }));
  details.workflow!.reportGroups.push({
    ...structuredClone(details.workflow!.reportGroups[0]!),
    report: { ...original.report!, title: 'Fictional later duplicate' },
    versions: [
      { ...structuredClone(original.versions[0]!), id: 'fictional-later-version', members: [] },
    ],
  });
  const view = retainedEnvelopeReader({ intake: { version: 1, ...details } });
  // Resolution must never consult report snapshots: this fixture tests the native
  // schema index and complete duplicate fallback independently of snapshot builds.
  const catalog = new Proxy({} as ReturnType<typeof createReportSnapshotCatalog>, {
    get() {
      throw Error('Group resolution unexpectedly read a report snapshot');
    },
  });
  let idReads = 0,
    groupPages = 0,
    pointReads = 0;
  const field = view.field,
    children = view.children,
    find = view.find;
  view.field = (record, name, options) => {
    if (record.kind === 'reportGroup' && name === 'id') idReads++;
    return field(record, name, options);
  };
  view.children = (record, name, options) => {
    if (name === 'reportGroups') groupPages++;
    return children(record, name, options);
  };
  view.find = (kind, record, id) => {
    if (kind === 'reportGroup') pointReads++;
    return find(kind, record, id);
  };
  const scope = collectionWorkflowReviewScope({
    view,
    catalog,
    metadataBytes: 128 * 1024,
    readCacheState: () => 'fictional-stable-selected-state',
    packageEvidence: false,
    activeReceipt: () => true,
    originalFingerprint: () => 'fictional-original-fingerprint',
    reportSource: () => undefined,
  });
  for (let pass = 0; pass < 3; pass++)
    for (let n = 0; n < count; n++) {
      const selected = scope.group({
        groupId: 'fictional-counted-group-' + n,
        groupVersionId: 'fictional-version-' + n,
      });
      assert.equal(selected?.report?.title, 'Fictional counted group ' + n);
    }
  assert.equal(pointReads, count * 3, 'every cache miss addresses the complete retained index');
  assert.equal(groupPages, 0, 'unique exact-version groups never enumerate the namespace');
  assert.ok(
    idReads <= count * 3 * 2,
    'group header work stays linear despite exceeding the 32-entry cache',
  );
  idReads = 0;
  const later = scope.group({
    groupId: 'fictional-counted-group-0',
    groupVersionId: 'fictional-later-version',
  });
  assert.equal(later?.report?.title, details.workflow!.reportGroups!.at(-1)!.report!.title);
  assert.ok(groupPages > 0, 'a first-group version mismatch traverses complete later duplicates');
  assert.ok(
    idReads >= count,
    'the late duplicate remains visible beyond the cache and first group',
  );
});

async function nativeReceiptMemoFixture(
  t: test.TestContext,
  count = 3,
  nameBytes = 0,
  groupCount = 3,
  idBytes = 0,
  activeOverride?: (receipt: { operationId: string }) => boolean,
  actualReceiptSchema = false,
) {
  const token = 'd'.repeat(64);
  const reference: IntakeIdentityScopeReference = {
    format: 'health-intake-identity-scope-v2',
    profileId: 'fictional-profile',
    intakeId: file.id,
    intakeVersion: 1,
    groupId: 'fictional-policy-group',
    groupVersionId: 'fictional-policy-version',
    sourceHash: file.sha256,
    memberId: null,
    original: { filename: 'fictional.pdf', contentUrl: '/fictional-original', page: 1 },
    report: { locator: 'page 1', text: 'Report F27' },
    subject: { locator: 'page 1', text: 'Iris Meadow' },
    evidencedIdentity: { fullName: 'Iris Meadow' },
    verificationMode: 'human_reviewed_original',
    scopeToken: token,
    collection: {
      snapshotId: 'identity:' + token,
      membership: 1,
      targets: 1,
      assignmentTargets: 1,
      questions: 1,
      competingSubjects: 1,
    },
  };
  const receipts = Array.from({ length: count }, (_, n) => ({
    operationId: 'fictional-receipt-' + n,
    outcome: 'this_is_me',
    at: '2026-10-04',
    identityAnswers: { birthDate: '1990-01-01', fictionalLexical: JSON.rawJSON('12.00') },
    scope: reference,
    ...(nameBytes
      ? {
          assignedPerson: {
            noteId: 'fictional-person-note',
            personId: 'fictional-family',
            version: 1,
            fullName: 'x'.repeat(nameBytes),
          },
        }
      : {}),
  }));
  const f = await fixture(t, undefined, actualReceiptSchema ? receipts : undefined);
  const catalog = createReportSnapshotCatalog(f.db, file),
    writer = await catalog.fork();
  const ordinal = schemaOrdinal(0),
    question = { prompt: 'Read the fictional original', textAnchor: 'Iris Meadow' };
  const target = {
    candidateId: 'fictional-candidate',
    candidateVersionId: 'fictional-version',
    proposalId,
    recordId: 'fictional-record',
    title: 'Fictional record',
    issueId: 'fictional-issue',
    hasIssueIds: true,
    issueCount: 1,
    hasIssueLookup: true,
  };
  const occurrence = { proposalId, recordId: 'fictional-record', batchId: null, locator: 'page 1' };
  const rows = [
    { key: '$format', value: IDENTITY_SNAPSHOT_FORMAT },
    { key: '$scope', value: JSON.stringify(reference) },
    {
      key: 'member:' + ordinal,
      value: JSON.stringify({
        candidateId: target.candidateId,
        candidateVersionId: target.candidateVersionId,
        occurrenceCount: 1,
      }),
    },
    { key: 'occurrence:' + ordinal + ':' + ordinal, value: JSON.stringify(occurrence) },
    {
      key: 'questionHash:' + ordinal,
      value: createHash('sha256').update(canonicalLiteral(question)).digest('hex'),
    },
    {
      key: 'competingSubjects:' + ordinal,
      value: JSON.stringify({
        groupId: 'fictional-alternative',
        groupVersionId: 'fictional-alternative-version',
        subject: { locator: 'page 1', text: 'Fictional Alternative' },
      }),
    },
  ];
  for (const section of ['targets', 'assignmentTargets'])
    rows.push(
      { key: 'targetHeader:' + section + ':' + ordinal, value: JSON.stringify(target) },
      {
        key: 'targetIssue:' + section + ':' + ordinal + ':' + ordinal,
        value: JSON.stringify(target.issueId),
      },
      {
        key:
          'targetLookup:' +
          section +
          ':' +
          ordinal +
          ':' +
          createHash('sha256').update(target.issueId).digest('hex'),
        value: '1',
      },
    );
  await writer.putMany(rows);
  await catalog.publish(reference.collection.snapshotId, writer);
  const memberWriter = await createReportMemberSnapshot(catalog, 'fictional-policy-members');
  const member = await memberWriter.include({
    candidateId: target.candidateId,
    candidateVersionId: target.candidateVersionId,
  });
  await memberWriter.occurrence(member, occurrence);
  const members = await memberWriter.finish();
  const collections = selectedEnvelopeStore(f.db, file).collections,
    operationId = randomUUID();
  const prepared = collections.prepare(collections.openView(), {
    operationId,
    requestDigest: createHash('sha256').update(operationId).digest('hex'),
    domainVersion: collections.binding(collections.openView())!.logical.domainVersion,
    changes: await catalog.finalChanges(),
  });
  transaction(f.db, () => collections.stage(prepared));
  f.db.exec('CREATE TABLE fictional_receipt_witness(value TEXT)');

  const groups = Array.from({ length: groupCount }, (_, n) => ({
    id: (n ? 'fictional-policy-group-' + n : reference.groupId) + 'x'.repeat(idBytes),
    basis: 'report_anchor' as const,
    sourceFileId: file.id,
    sourceHash: file.sha256,
    memberId: null,
    report: {
      key: 'fictional-policy-report',
      title: 'Fictional report',
      anchor: reference.report,
      subject: reference.subject,
    },
    versions: [
      { id: reference.groupVersionId, format: 'health-intake-report-group-version-v2', members },
    ],
  }));
  let superseded = false;
  const open = (
    transform?: (
      catalog: ReturnType<typeof createReportSnapshotCatalog>,
    ) => ReturnType<typeof createReportSnapshotCatalog>,
    observe?: (view: ReturnType<typeof retainedEnvelopeReader>) => void,
    nativeOuter = false,
    proofState?: () => string | undefined,
  ) => {
    const view = actualReceiptSchema
      ? openIntakeCollectionEnvelope(f.db, file)
      : retainedEnvelopeReader({
          intake: { workflow: { identityConfirmations: receipts, reportGroups: groups } },
        });
    observe?.(view);
    return collectionWorkflowReviewScope({
      view,
      catalog: transform
        ? transform(createReportSnapshotCatalog(f.db, file))
        : createReportSnapshotCatalog(f.db, file),
      metadataBytes: 256 * 1024,
      readCacheState: nativeOuter ? undefined : () => reviewReadStamp(f.db),
      readIdentityReceiptScopeState: nativeOuter ? () => reviewReadStamp(f.db) : undefined,
      readProofState: proofState,
      readIdentityReceiptScopeProofState: nativeOuter ? proofState : undefined,
      identityReceiptWork: (metric) => withIntakeWork(f.db, 'warm', () => recordIntakeWork(metric)),
      packageEvidence: false,
      activeReceipt: (receipt) =>
        activeOverride
          ? activeOverride(receipt)
          : !(superseded && receipt.operationId === receipts.at(-1)!.operationId),
      originalFingerprint: () => 'fictional-original-proof',
      reportSource: () => undefined,
    });
  };
  const scan = (scope: ReturnType<typeof open>) =>
    withIntakeWork(f.db, 'warm', () => Array.from(scope.receipts || []));
  return {
    ...f,
    open,
    receipts,
    reference,
    async publishScopes(selected: IntakeIdentityScopeReference[]) {
      const current = createReportSnapshotCatalog(f.db, file);
      for (const referenceValue of selected) {
        const writer = await current.fork(reference.collection.snapshotId);
        await writer.putText(
          '$scope',
          (function* () {
            yield JSON.stringify(referenceValue);
          })(),
        );
        await current.publish(referenceValue.collection.snapshotId, writer);
      }
      const operationId = randomUUID();
      const prepared = collections.prepare(collections.openView(), {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: collections.binding(collections.openView())!.logical.domainVersion,
        changes: await current.finalChanges(),
      });
      transaction(f.db, () => collections.stage(prepared));
    },
    scan,
    question,
    target,
    groups,
    priorMembership: [
      {
        candidateId: target.candidateId,
        candidateVersionId: target.candidateVersionId,
        occurrences: [occurrence],
      },
    ],
    setSuperseded: () => {
      superseded = true;
    },
  };
}

test('native policy receipt memo reconstructs once, detaches headers and guards nested providers', async (t) => {
  const f = await nativeReceiptMemoFixture(t),
    scope = f.open();
  const first = f.scan(scope),
    before = intakeWorkCounters(f.db).warm;
  assert.ok(JSON.stringify(first[0]!.identityAnswers).includes('12.00'));
  assert.ok(JSON.stringify(f.scan(scope)[0]!.identityAnswers).includes('12.00'));
  for (let n = 0; n < 64; n++)
    assert.equal(f.scan(scope).at(-1)!.operationId, 'fictional-receipt-2');
  const after = intakeWorkCounters(f.db).warm;
  assert.equal(before.identityPolicyReceiptReconstructions, 3);
  assert.equal(
    after.identityPolicyReceiptReconstructions,
    before.identityPolicyReceiptReconstructions,
  );
  assert.equal(after.identityPolicyReceiptCacheHits - before.identityPolicyReceiptCacheHits, 195);
  assert.equal(after.identityPolicyReceiptNamespaceReads, 1);
  assert.equal(
    after.identityPolicyReceiptNamespaceHits - before.identityPolicyReceiptNamespaceHits,
    65,
  );
  first[0]!.scope.original.filename = 'caller mutation';
  first[0]!.scope.subject.text = 'caller mutation';
  assert.equal(f.scan(scope)[0]!.scope.original.filename, 'fictional.pdf');
  assert.equal(f.scan(scope)[0]!.scope.subject.text, 'Iris Meadow');
  const providers = first[0]!.scope;
  assert.throws(() => {
    Object.assign(providers.targets, { length: 99 });
  }, TypeError);
  assert.throws(() => {
    Object.assign(providers.targets, { some: () => false });
  }, TypeError);
  const target = Array.from(providers.assignmentTargets!)[0]!,
    member = Array.from(providers.membership)[0]!,
    question = Array.from(providers.questions!)[0]!;
  assert.equal(target.hasIssueId!('fictional-issue'), true);
  assert.equal(Array.from(target.issueIds!)[0], 'fictional-issue');
  assert.equal(Array.from(member.occurrences)[0]!.recordId, 'fictional-record');
  assert.equal('matches' in question && question.matches(f.question), true);
  f.setSuperseded();
  assert.equal(
    f.scan(scope).at(-1)!.operationId,
    'fictional-receipt-1',
    'active receipt filtering remains live',
  );
  scope.close!();
  assert.throws(() => Array.from(providers.membership), /proof changed/);
  assert.throws(() => Array.from(target.issueIds!), /proof changed/);
  assert.throws(() => target.hasIssueId!('fictional-issue'), /proof changed/);
  assert.throws(() => Array.from(member.occurrences), /proof changed/);
  assert.throws(() => 'matches' in question && question.matches(f.question), /proof changed/);
});

test('native policy receipt memo visits beyond 32 receipts and invalidates peer SQL and rollback', async (t) => {
  const f = await nativeReceiptMemoFixture(t, 33),
    scope = f.open();
  assert.equal(f.scan(scope).at(-1)!.operationId, 'fictional-receipt-32');
  const before = intakeWorkCounters(f.db).warm;
  assert.equal(f.scan(scope).length, 33);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyReceiptReconstructions -
      before.identityPolicyReceiptReconstructions,
    33,
    'bounded LRU falls back rather than skipping offpage receipts',
  );
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyReceiptNamespaceReads -
      before.identityPolicyReceiptNamespaceReads,
    1,
  );
  assert.equal(intakeWorkCounters(f.db).warm.identityPolicyReceiptNamespaceHits, 0);
  scope.close!();
  const small = await nativeReceiptMemoFixture(t),
    selected = small.open();
  const old = small.scan(selected)[0]!,
    warm = intakeWorkCounters(small.db).warm;
  using peer = new DatabaseSync(join(small.root, 'cache.sqlite'));
  peer.prepare('INSERT INTO fictional_receipt_witness VALUES(?)').run('peer policy change');
  assert.throws(() => Array.from(old.scope.targets), /proof changed/);
  small.scan(selected);
  assert.equal(
    intakeWorkCounters(small.db).warm.identityPolicyReceiptReconstructions -
      warm.identityPolicyReceiptReconstructions,
    3,
  );
  const beforeTransaction = small.scan(selected)[0]!;
  small.db.exec('BEGIN');
  assert.throws(() => Array.from(beforeTransaction.scope.membership), /proof changed/);
  small.scan(selected);
  small.db.exec('ROLLBACK');
  assert.throws(() => Array.from(beforeTransaction.scope.membership), /proof changed/);
  const rollback = intakeWorkCounters(small.db).warm;
  small.scan(selected);
  assert.equal(
    intakeWorkCounters(small.db).warm.identityPolicyReceiptReconstructions -
      rollback.identityPolicyReceiptReconstructions,
    3,
  );
  selected.close!();
  assert.equal(
    small.scan(small.open()).length,
    3,
    'new scope reopens and verifies retained snapshot authority',
  );
});

test('native policy receipt memo enforces aggregate and oversized header budgets without omitting receipts', async (t) => {
  const f = await nativeReceiptMemoFixture(t, 32, 6000),
    scope = f.open();
  assert.equal(f.scan(scope).length, 32);
  const before = intakeWorkCounters(f.db).warm;
  assert.equal(f.scan(scope).at(-1)!.assignedPerson!.fullName.length, 6000);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyReceiptReconstructions -
      before.identityPolicyReceiptReconstructions,
    32,
    'aggregate byte budget evicts before the 32-entry count limit',
  );
  scope.close!();
  const giant = await nativeReceiptMemoFixture(t, 1, 256 * 1024 - 1000),
    selected = giant.open();
  assert.equal(giant.scan(selected).length, 1);
  const oversized = intakeWorkCounters(giant.db).warm;
  assert.equal(giant.scan(selected).length, 1);
  assert.equal(
    intakeWorkCounters(giant.db).warm.identityPolicyReceiptReconstructions -
      oversized.identityPolicyReceiptReconstructions,
    1,
    'oversized complete header is not admitted',
  );
  selected.close!();
});

test('native policy receipt memo does not seed a changed cold proof and refuses changed catalog source', async (t) => {
  const f = await nativeReceiptMemoFixture(t);
  using peer = new DatabaseSync(join(f.root, 'cache.sqlite'));
  let drifted = false;
  const scope = f.open((catalog) => ({
    ...catalog,
    open(id) {
      const reader = catalog.open(id);
      if (!drifted) {
        drifted = true;
        peer
          .prepare('INSERT INTO fictional_receipt_witness VALUES(?)')
          .run('during snapshot construction');
      }
      return reader;
    },
  }));
  assert.throws(() => f.scan(scope), /proof changed/);
  const before = intakeWorkCounters(f.db).warm;
  f.scan(scope);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyReceiptReconstructions -
      before.identityPolicyReceiptReconstructions,
    3,
    'refused cold construction retained neither the first header nor a common provider',
  );
  f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('e'.repeat(64), file.id);
  try {
    assert.throws(
      () => f.scan(scope),
      /source|Stale|binding|identity|missing selected intake head/i,
    );
  } finally {
    f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run(file.sha256, file.id);
  }
  scope.close!();
  const fresh = f.open(),
    unwrappedBefore = intakeWorkCounters(f.db).warm;
  Array.from(fresh.receipts || []);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyReceiptReconstructions -
      unwrappedBefore.identityPolicyReceiptReconstructions,
    3,
    'host callback attributes actual opens outside global work scope',
  );
  Array.from(fresh.receipts || []);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyReceiptCacheHits -
      unwrappedBefore.identityPolicyReceiptCacheHits,
    3,
  );
  fresh.close!();
});

test('selected identity membership resolution memo preserves complete checks and frozen providers', async (t) => {
  const f = await nativeReceiptMemoFixture(t),
    scope = f.open();
  const first = f.groups.map((group) => scope.membership(group));
  for (const provider of first) assert.equal(provider.retains(f.priorMembership), true);
  // Initial membership construction precedes receipt traversal; both caches use
  // the same proof epoch, so first receipt decoding cannot invalidate it.
  f.scan(scope);
  for (let n = 0; n < 64; n++)
    for (const group of f.groups)
      assert.equal(scope.membership(group).retains(f.priorMembership), true);
  const counts = intakeWorkCounters(f.db).warm;
  assert.equal(counts.identityPolicyMembershipResolutions, 3);
  assert.equal(counts.identityPolicyMembershipResolutionHits, 192);
  const changed = structuredClone(f.priorMembership);
  changed[0]!.occurrences[0]!.recordId = 'offpage-changed-record';
  assert.equal(first[0]!.retains(changed), false, 'membership answers remain freshly checked');
  assert.equal(first[0]!.retains(f.priorMembership), true);
  assert.throws(() => Object.assign(first[0]!, { retains: () => false }), TypeError);
  f.groups[0]!.report!.anchor.text = 'caller changed header';
  assert.equal(scope.membership(f.groups[0]!).retains(f.priorMembership), true);
  scope.close!();
  assert.throws(() => first[0]!.retains(f.priorMembership), /proof changed/);
});

test('selected identity structural caches invalidate peer SQL rollback clear and closed proofs', async (t) => {
  const f = await nativeReceiptMemoFixture(t),
    scope = f.open();
  let provider = scope.membership(f.groups[0]!);
  f.scan(scope);
  const before = intakeWorkCounters(f.db).warm;
  using peer = new DatabaseSync(join(f.root, 'cache.sqlite'));
  peer.prepare('INSERT INTO fictional_receipt_witness VALUES(?)').run('new current policy');
  assert.throws(() => provider.retains(f.priorMembership), /proof changed/);
  provider = scope.membership(f.groups[0]!);
  assert.equal(provider.retains(f.priorMembership), true);
  f.scan(scope);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyMembershipResolutions -
      before.identityPolicyMembershipResolutions,
    1,
  );
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyReceiptNamespaceReads -
      before.identityPolicyReceiptNamespaceReads,
    1,
  );
  f.db.exec('BEGIN');
  assert.throws(() => provider.retains(f.priorMembership), /proof changed/);
  f.db.exec('ROLLBACK');
  assert.throws(
    () => provider.retains(f.priorMembership),
    /proof changed/,
    'rollback must not revive observed invalidation',
  );
  provider = scope.membership(f.groups[0]!);
  clearIntakeStateCache(f.db);
  assert.throws(() => provider.retains(f.priorMembership), /proof changed|Stale|selected/i);
  scope.close!();
  assert.throws(() => scope.membership(f.groups[0]!), /closed/);
});

test('selected identity membership resolution memo falls back beyond count and byte budgets', async (t) => {
  for (const [count, bytes] of [
    [33, 0],
    [32, 7800],
  ] as const) {
    const f = await nativeReceiptMemoFixture(t, 1, 0, count, bytes),
      scope = f.open();
    for (const group of f.groups)
      assert.equal(scope.membership(group).retains(f.priorMembership), true);
    const before = intakeWorkCounters(f.db).warm;
    for (const group of f.groups)
      assert.equal(scope.membership(group).retains(f.priorMembership), true);
    assert.equal(
      intakeWorkCounters(f.db).warm.identityPolicyMembershipResolutions -
        before.identityPolicyMembershipResolutions,
      count,
      'no incomplete policy when bounded resolutions cannot be retained',
    );
    scope.close!();
  }
  const unsupported = await nativeReceiptMemoFixture(t, 1, 0, 1, 256 * 1024),
    refused = unsupported.open();
  assert.throws(
    () => refused.membership(unsupported.groups[0]!),
    /public identity index target/,
    'an oversized public identity remains an authority refusal',
  );
  refused.close!();
});

test('selected identity receipt locators admit only completed bounded authenticated traversals', async (t) => {
  const f = await nativeReceiptMemoFixture(t),
    scope = f.open();
  const iterator = scope.receipts![Symbol.iterator]();
  iterator.next();
  iterator.return?.();
  f.scan(scope);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyReceiptNamespaceReads,
    2,
    'cancelled prefix cannot seed complete locator cache',
  );
  scope.close!();
  let refused = false;
  const guarded = f.open(undefined, (view) => {
    const address = view.address.bind(view);
    view.address = (record) => {
      if (refused) throw Error('Fictional authenticated address refused');
      return address(record);
    };
  });
  const provider = guarded.membership(f.groups[0]!);
  f.scan(guarded);
  refused = true;
  assert.throws(() => f.scan(guarded), /authenticated address refused/);
  refused = false;
  assert.throws(
    () => provider.retains(f.priorMembership),
    /proof changed/,
    'refused address cannot revive prior provider',
  );
  const before = intakeWorkCounters(f.db).warm;
  f.scan(guarded);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyReceiptNamespaceReads -
      before.identityPolicyReceiptNamespaceReads,
    1,
  );
  guarded.close!();
});

test('selected identity membership cold drift cannot seed and duplicate headers preserve first membership', async (t) => {
  const f = await nativeReceiptMemoFixture(t);
  const firstGroup = f.groups[0]!;
  f.groups.push({
    ...firstGroup,
    report: {
      ...firstGroup.report,
      anchor: { locator: 'later duplicate', text: 'Later duplicate' },
    },
    versions: [{ ...firstGroup.versions[0]!, id: 'later-version' }],
  });
  using peer = new DatabaseSync(join(f.root, 'cache.sqlite'));
  let changed = false;
  const scope = f.open((catalog) => ({
    ...catalog,
    open(id) {
      const result = catalog.open(id);
      if (!changed) {
        changed = true;
        peer
          .prepare('INSERT INTO fictional_receipt_witness VALUES(?)')
          .run('during membership open');
      }
      return result;
    },
  }));
  const old = scope.membership(firstGroup);
  assert.throws(() => old.retains(f.priorMembership), /proof changed/);
  const before = intakeWorkCounters(f.db).warm;
  const fresh = scope.membership(firstGroup);
  assert.equal(fresh.retains(f.priorMembership), true);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyMembershipResolutions -
      before.identityPolicyMembershipResolutions,
    1,
  );
  const later = scope.group({ groupId: firstGroup.id, groupVersionId: 'later-version' })!;
  assert.equal(
    later.report!.anchor.text,
    'Later duplicate',
    'later duplicate version lookup remains complete',
  );
  assert.equal(
    scope.currentVersion(later),
    firstGroup.versions[0]!.id,
    'current membership still belongs to first retained group',
  );
  assert.equal(scope.membership(later).retains(f.priorMembership), true);
  scope.close!();
});

test('selected workflow preserves the full legacy name-conflict canonical field after policy cloning', async (t) => {
  const { open } = await fixture(t);
  let last = 'Fictional Final Reading';
  function* claims() {
    for (let n = 0; n < 1000; n++)
      yield {
        selfSuggestion: {
          fullName:
            n === 999
              ? last
              : 'Fictional X' +
                String.fromCharCode(65 + Math.floor(n / 676)) +
                String.fromCharCode(97 + (Math.floor(n / 26) % 26)) +
                String.fromCharCode(97 + (n % 26)) +
                ' Meadow',
        },
      };
  }
  const recordHashes = new WeakMap<IntakeReview, string>();
  function selected(literal: boolean) {
    const scope = open();
    const evidence = () => ({
      collected: literal
        ? collectEvidencedIdentity(claims())
        : collectSelectedEvidencedIdentity(claims),
      structured: {},
    });
    scope.evidence = evidence;
    scope.evidenceWork = function* () {
      yield;
      return evidence();
    };
    try {
      const result = workflowReviewSelected(file, scope, review(), entries, self, identity);
      const hash = createHash('sha256').update('[' + canonicalLiteral(result.reviewToken) + ',');
      for (const piece of scope.canonicalReviewRecords(result.records)) hash.update(piece);
      recordHashes.set(result, hash.update(']').digest('hex'));
      return result;
    } finally {
      scope.close!();
    }
  }
  const actual = selected(false),
    expected = selected(true);
  const chunks = (value: unknown) => [...canonicalReviewValueChunks(value)].join('');
  assert.ok(
    actual.records[0]!.identityReview!.conflicts.some(
      (conflict) => conflict.evidencedValueReference?.names === 1000,
    ),
  );
  assert.equal(
    chunks(actual.records[0]),
    chunks(expected.records[0]),
    'actual selected policy clone retains complete legacy field bytes',
  );
  assert.equal(selectionAuthority(actual.records[0]), selectionAuthority(expected.records[0]));
  assert.match(recordHashes.get(actual)!, /^[a-f0-9]{64}$/);
  assert.equal(
    recordHashes.get(actual),
    recordHashes.get(expected),
    'the session canonical-record hash recipe retains the same legacy bytes',
  );
  const before = selectionAuthority(actual.records[0]);
  last = 'Fictional Changed Reading';
  const changed = selected(false);
  assert.notEqual(
    selectionAuthority(changed.records[0]),
    before,
    'late same-count conflict remains committed through workflow cloning',
  );
});

// Complete retained receipt inspection yields even when none of the history is active.
test('cooperative native receipt selection inspects superseded-only history and preserves a late active receipt', async (t) => {
  const { runClinicalReviewWork } = await import('../clinical-review-work.ts');
  let inspections = 0,
    lateActive = false;
  const f = await nativeReceiptMemoFixture(t, 70, 0, 1, 0, (receipt) => {
    inspections++;
    return lateActive && receipt.operationId === 'fictional-receipt-69';
  });
  const scope = f.open();
  t.after(() => scope.close?.());
  let firstTurnInspections: number | undefined;
  const run = () =>
    runClinicalReviewWork(scope.receiptsWork!(), {
      capture() {
        firstTurnInspections ??= inspections;
        const before = reviewReadStamp(f.db);
        return () => assert.equal(reviewReadStamp(f.db), before);
      },
    });
  const inactive = await run();
  assert.equal(inspections, 70);
  assert.ok(firstTurnInspections! > 0 && firstTurnInspections! < 70);
  assert.deepEqual(Array.from(inactive), []);
  lateActive = true;
  const active = await run();
  assert.equal(inspections, 140);
  assert.equal(
    Array.from(active)
      .map((receipt) => receipt.operationId)
      .join(','),
    'fictional-receipt-69',
  );
  assert.deepEqual(
    Array.from(scope.receipts).map((receipt) => receipt.operationId),
    Array.from(active).map((receipt) => receipt.operationId),
  );
  scope.close?.();
  assert.throws(() => Array.from(active), /closed/);
});

// Real immutable catalog cells, 71 independently decoded headers, one complete
// common snapshot; the native outer scope keeps membership/draft caches disabled.
test('native common receipt references retain one complete provider beyond 32 headers', async (t) => {
  let visits = 0;
  const f = await nativeReceiptMemoFixture(t, 71, 0, 1, 0, () => {
    visits++;
    return true;
  });
  f.receipts[35]!.outcome = 'unknown';
  const scope = f.open(undefined, undefined, true);
  t.after(() => scope.close?.());
  const before = intakeWorkCounters(f.db).warm;
  const first = f.scan(scope),
    cold = intakeWorkCounters(f.db).warm;
  assert.equal(first.length, 71);
  assert.equal(
    cold.identityPolicyReceiptReconstructions - before.identityPolicyReceiptReconstructions,
    71,
  );
  assert.equal(
    cold.identityPolicyScopeReconstructions - before.identityPolicyScopeReconstructions,
    1,
  );
  assert.equal(cold.identityPolicyScopeCacheHits - before.identityPolicyScopeCacheHits, 70);
  assert.equal(visits, 71);
  assert.equal(first[35]!.outcome, 'unknown');
  assert.equal(first[70]!.operationId, 'fictional-receipt-70');
  first[0]!.scope.subject!.text = 'caller mutation';
  assert.equal(Reflect.set(first[0]!.scope.targets, 'length', 999), false);
  const repeated = f.scan(scope),
    warm = intakeWorkCounters(f.db).warm;
  assert.equal(visits, 142);
  assert.equal(repeated[0]!.scope.subject!.text, f.reference.subject.text);
  assert.equal(repeated[35]!.outcome, 'unknown');
  assert.equal(
    warm.identityPolicyReceiptReconstructions - cold.identityPolicyReceiptReconstructions,
    71,
  );
  assert.equal(warm.identityPolicyScopeReconstructions, cold.identityPolicyScopeReconstructions);
  assert.equal(warm.identityPolicyScopeCacheHits - cold.identityPolicyScopeCacheHits, 71);
  assert.ok(
    warm.collectionReadBytes - cold.collectionReadBytes <
      cold.collectionReadBytes - before.collectionReadBytes,
  );
  const target = Array.from(first[0]!.scope.targets)[0]!;
  scope.close?.();
  assert.throws(() => Array.from(first[0]!.scope.targets), /changed|closed/);
  assert.throws(() => Array.from(target.issueIds!), /changed|closed/);
});

test('receipt borrowed proof survives certified raw drift but rejects real rollback and transaction observation', async (t) => {
  const { reviewPreparationStamp, execClinicalReviewMaintenance, runClinicalReviewMaintenance } =
    await import('../clinical-review-maintenance.ts');
  const f = await nativeReceiptMemoFixture(t);
  const scope = f.open(undefined, undefined, false, () => reviewPreparationStamp(f.db));
  t.after(() => scope.close?.());
  const first = f.scan(scope)[0]!,
    target = Array.from(first.scope.targets)[0]!,
    member = Array.from(first.scope.membership)[0]!;
  const selectedMembership = scope.membership({ ...f.groups[0]!, report: f.groups[0]!.report });
  const work = scope.receiptsWork!();
  let selected;
  for (;;) {
    const next = work.next();
    if (next.done) {
      selected = next.value;
      break;
    }
  }
  const authority = reviewPreparationStamp(f.db),
    raw = reviewReadStamp(f.db),
    before = intakeWorkCounters(f.db).warm;
  execClinicalReviewMaintenance(
    f.db,
    'reader',
    'CREATE TEMP TABLE IF NOT EXISTS __intake_reader_path(source TEXT,run TEXT,after TEXT,PRIMARY KEY(source,run,after))',
  );
  runClinicalReviewMaintenance(
    f.db,
    'reader',
    'INSERT INTO __intake_reader_path VALUES(?,?,?)',
    'fictional-neutral',
    'run',
    'one',
  );
  assert.notEqual(reviewReadStamp(f.db), raw);
  assert.equal(reviewPreparationStamp(f.db), authority);
  assert.equal(Array.from(target.issueIds!)[0], 'fictional-issue');
  assert.equal(target.hasIssueId!('fictional-issue'), true);
  assert.equal(Array.from(member.occurrences).length, 1);
  assert.equal(Array.from(selected!).length, 3);
  assert.equal(selectedMembership.retains(f.priorMembership), true);
  f.scan(scope);
  assert.ok(
    intakeWorkCounters(f.db).warm.identityPolicyScopeReconstructions >
      before.identityPolicyScopeReconstructions,
  );
  f.db.exec('SAVEPOINT fictional_common_scope');
  f.db.prepare("INSERT INTO fictional_receipt_witness VALUES('foreign')").run();
  f.db.exec('ROLLBACK TO fictional_common_scope; RELEASE fictional_common_scope');
  runClinicalReviewMaintenance(
    f.db,
    'reader',
    'UPDATE __intake_reader_path SET after=? WHERE source=?',
    'two',
    'fictional-neutral',
  );
  assert.notEqual(reviewPreparationStamp(f.db), authority);
  assert.throws(() => Array.from(target.issueIds!), /changed/);
  assert.throws(() => selectedMembership.retains(f.priorMembership), /changed/);
  assert.throws(() => Array.from(selected!), /changed/);
  const fresh = f.scan(scope)[0]!,
    nextTarget = Array.from(fresh.scope.targets)[0]!;
  f.db.exec('SAVEPOINT observe_common_transaction');
  assert.equal(f.scan(scope).length, 3, 'transaction uses complete uncached readers');
  f.db.exec('ROLLBACK TO observe_common_transaction; RELEASE observe_common_transaction');
  assert.throws(() => nextTarget.hasIssueId!('fictional-issue'), /changed/);
});

test('native common receipt scope memo evicts complete distinct references at count and byte limits', async (t) => {
  const f = await nativeReceiptMemoFixture(t, 33);
  const references = Array.from({ length: 33 }, (_, n) => {
    const scopeToken = createHash('sha256')
      .update('fictional-distinct-' + n)
      .digest('hex');
    return {
      ...structuredClone(f.reference),
      scopeToken,
      collection: { ...f.reference.collection, snapshotId: 'identity:' + scopeToken },
    };
  });
  await f.publishScopes(references);
  for (let n = 0; n < f.receipts.length; n++) f.receipts[n]!.scope = references[n]!;
  const scope = f.open(undefined, undefined, true);
  t.after(() => scope.close?.());
  const first = f.scan(scope),
    before = intakeWorkCounters(f.db).warm;
  assert.equal(first.length, 33);
  assert.equal(before.identityPolicyScopeReconstructions, 33);
  assert.equal(f.scan(scope).length, 33);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyScopeReconstructions -
      before.identityPolicyScopeReconstructions,
    33,
  );
  assert.equal(
    Array.from(first[0]!.scope.targets)[0]!.candidateId,
    f.target.candidateId,
    'ordinary LRU eviction does not revoke an unchanged borrowed provider',
  );
  scope.close?.();

  const large = references.slice(0, 18).map((reference, n) => {
    const scopeToken = createHash('sha256')
      .update('fictional-large-reference-' + n)
      .digest('hex');
    return {
      ...reference,
      scopeToken,
      subject: { ...reference.subject, text: 'x'.repeat(7800) },
      collection: { ...reference.collection, snapshotId: 'identity:' + scopeToken },
    };
  });
  const oversizedToken = createHash('sha256').update('fictional-oversized-reference').digest('hex');
  const oversized = {
    ...large[0]!,
    scopeToken: oversizedToken,
    subject: { ...large[0]!.subject, text: 'y'.repeat(140000) },
    collection: { ...large[0]!.collection, snapshotId: 'identity:' + oversizedToken },
  };
  await f.publishScopes([...large, oversized]);
  f.receipts.splice(18);
  for (let n = 0; n < f.receipts.length; n++) f.receipts[n]!.scope = large[n]!;
  const bytes = f.open(undefined, undefined, true);
  t.after(() => bytes.close?.());
  assert.equal(f.scan(bytes).length, 18);
  const afterLarge = intakeWorkCounters(f.db).warm;
  assert.equal(f.scan(bytes).length, 18);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyScopeReconstructions -
      afterLarge.identityPolicyScopeReconstructions,
    18,
    'encoded references exceed the combined byte budget below 32 entries',
  );
  bytes.close?.();
  f.receipts.splice(1);
  f.receipts[0]!.scope = oversized;
  const giant = f.open(undefined, undefined, true);
  t.after(() => giant.close?.());
  assert.equal(f.scan(giant).length, 1);
  const afterGiant = intakeWorkCounters(f.db).warm;
  assert.equal(f.scan(giant).length, 1);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyScopeReconstructions -
      afterGiant.identityPolicyScopeReconstructions,
    1,
    'oversized reference is inspected completely and never retained',
  );
});

test('native common receipt scope memo rejects changed references inactive corruption and cold drift', async (t) => {
  const f = await nativeReceiptMemoFixture(t, 3);
  const scope = f.open(undefined, undefined, true);
  t.after(() => scope.close?.());
  const borrowed = f.scan(scope)[0]!.scope;
  scope.close?.();
  f.receipts[1]!.scope = { ...structuredClone(f.reference), groupId: 'foreign-group' };
  const changedReference = f.open(undefined, undefined, true);
  t.after(() => changedReference.close?.());
  assert.throws(
    () => f.scan(changedReference),
    /The retained identity scope is unavailable or changed/,
    'same snapshot and token cannot bless a changed full reference',
  );
  changedReference.close?.();
  f.receipts[1]!.scope = f.reference;
  let changed = false;
  using peer = new DatabaseSync(join(f.root, 'cache.sqlite'));
  const drifting = f.open(
    (catalog) => ({
      ...catalog,
      open(id) {
        const reader = catalog.open(id);
        if (!changed) {
          changed = true;
          peer
            .prepare('INSERT INTO fictional_receipt_witness VALUES(?)')
            .run('during common construction');
        }
        return reader;
      },
    }),
    undefined,
    true,
  );
  t.after(() => drifting.close?.());
  assert.throws(() => f.scan(drifting), /proof changed/);
  const failed = intakeWorkCounters(f.db).warm;
  assert.equal(f.scan(drifting).length, 3);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyScopeReconstructions -
      failed.identityPolicyScopeReconstructions,
    1,
    'failed cold construction cannot seed a subsequent hit',
  );
  assert.throws(() => Array.from(borrowed.targets), /changed|closed/);
  drifting.close?.();
  const inactive = await nativeReceiptMemoFixture(t, 1, 0, 1, 0, () => false);
  inactive.receipts[0]!.scope = {
    ...inactive.reference,
    groupVersionId: 'changed-inactive-version',
  };
  const refused = inactive.open(undefined, undefined, true);
  t.after(() => refused.close?.());
  assert.throws(
    () => inactive.scan(refused),
    /The retained identity scope is unavailable or changed/,
    'inactive malformed scopes remain validated before supersession filtering',
  );
});

test('native common receipt provider rejects peer transaction callback refusal and changed source', async (t) => {
  const { reviewPreparationStamp, execClinicalReviewMaintenance, runClinicalReviewMaintenance } =
    await import('../clinical-review-maintenance.ts');
  const f = await nativeReceiptMemoFixture(t);
  let refused = false;
  const scope = f.open(undefined, undefined, true, () => {
    if (refused) throw Error('fictional authority callback refused');
    return reviewPreparationStamp(f.db);
  });
  t.after(() => scope.close?.());
  const first = f.scan(scope)[0]!,
    target = Array.from(first.scope.targets)[0]!,
    member = Array.from(first.scope.membership)[0]!,
    question = Array.from(first.scope.questions!)[0]!;
  const proof = reviewPreparationStamp(f.db);
  execClinicalReviewMaintenance(
    f.db,
    'reader',
    'CREATE TEMP TABLE IF NOT EXISTS __intake_reader_path(source TEXT,run TEXT,after TEXT,PRIMARY KEY(source,run,after))',
  );
  runClinicalReviewMaintenance(
    f.db,
    'reader',
    'INSERT INTO __intake_reader_path VALUES(?,?,?)',
    'fictional-native-neutral',
    'run',
    'one',
  );
  assert.equal(reviewPreparationStamp(f.db), proof);
  assert.equal(Array.from(target.issueIds!)[0], 'fictional-issue');
  assert.equal(Array.from(member.occurrences).length, 1);
  assert.equal('matches' in question && question.matches(f.question), true);
  const before = intakeWorkCounters(f.db).warm;
  assert.equal(f.scan(scope).length, 3);
  assert.equal(
    intakeWorkCounters(f.db).warm.identityPolicyScopeReconstructions -
      before.identityPolicyScopeReconstructions,
    1,
  );
  f.db.exec('BEGIN');
  assert.throws(() => target.hasIssueId!('fictional-issue'), /proof changed/);
  assert.equal(f.scan(scope).length, 3, 'native transaction uses complete uncached providers');
  f.db.exec('ROLLBACK');
  assert.throws(() => Array.from(member.occurrences), /proof changed/);
  let current = Array.from(f.scan(scope)[0]!.scope.targets)[0]!;
  using peer = new DatabaseSync(join(f.root, 'cache.sqlite'));
  peer.prepare('INSERT INTO fictional_receipt_witness VALUES(?)').run('peer authority change');
  assert.throws(() => current.hasIssueId!('fictional-issue'), /proof changed/);
  current = Array.from(f.scan(scope)[0]!.scope.targets)[0]!;
  refused = true;
  assert.throws(() => Array.from(current.issueIds!), /fictional authority callback refused/);
  refused = false;
  assert.throws(
    () => Array.from(current.issueIds!),
    /proof changed/,
    'refused callback cannot revive a captured provider',
  );
  current = Array.from(f.scan(scope)[0]!.scope.targets)[0]!;
  f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('e'.repeat(64), file.id);
  assert.throws(
    () => Array.from(current.issueIds!),
    /missing selected intake head|Stale|binding|source|proof changed/i,
  );
  assert.throws(
    () => f.scan(scope),
    /missing selected intake head|Stale|binding|source|proof changed/i,
  );
});

// Actual accepted selected-schema cells/indexes, rather than the isolated lexical
// map fixture, measure ancestry and field resolution for 71 complete receipts.
// Publish 71 accepted schema receipts, then compare complete old and new reads.
// The local measured setup+both passes takes52seconds before CI overhead.
// Count all authenticated tree visits, including certified hits. Raw misses
// depend on the page cache; this asserts no SQL, byte or latency improvement.
test(
  'native receipt subtree preserves actual schema headers with fewer logical tree node visits',
  { timeout: 120000 },
  async (t) => {
    const { readIntakeReviewValue, intakeReviewChildren } =
      await import('../intake-review-collection.ts');
    const f = await nativeReceiptMemoFixture(t, 71, 0, 1, 0, undefined, true);
    const view = openIntakeCollectionEnvelope(f.db, file),
      intake = view.child(view.root(), 'intake')!,
      workflow = view.child(intake, 'workflow')!;
    const names = [
      'operationId',
      'at',
      'outcome',
      'attestation',
      'identityAnswers',
      'assignedPerson',
      'knownNameAdded',
      'confirmedPrintedName',
      'selfUpdate',
    ];
    const read = (
      record: import('../intake-collection-envelope.ts').IntakeEnvelopeRecord,
      name: string,
    ) => {
      const child = view.child(record, name);
      if (child) return readIntakeReviewValue(view, child, 256 * 1024);
      if (!view.has(record, name)) return undefined;
      return parseLiteralJSON(Array.from(view.fieldChunks(record, name)).join(''));
    };
    const before = intakeWorkCounters(f.db).warm;
    const baseline = withIntakeWork(f.db, 'warm', () =>
      Array.from(intakeReviewChildren(view, workflow, 'identityConfirmations'), (record) => {
        const header: Record<string, unknown> = {};
        for (const name of names) {
          const value = read(record, name);
          if (value !== undefined) header[name] = value;
        }
        const reference = readIntakeReviewValue(view, view.child(record, 'scope')!, 256 * 1024);
        return { header, reference };
      }),
    );
    const afterBaseline = intakeWorkCounters(f.db).warm;
    const scope = f.open(undefined, undefined, true);
    t.after(() => scope.close?.());
    const actual = f.scan(scope),
      after = intakeWorkCounters(f.db).warm;
    assert.equal(actual.length, 71);
    assert.deepEqual(
      actual.map((receipt) => {
        const { scope: _scope, ...header } = receipt;
        return header;
      }),
      baseline.map((receipt) => receipt.header),
    );
    for (const receipt of actual) {
      assert.equal(receipt.scope.scopeToken, f.reference.scopeToken);
      assert.equal(receipt.scope.subject.text, f.reference.subject.text);
      assert.equal(Array.from(receipt.scope.targets)[0]!.candidateId, f.target.candidateId);
    }
    const oldReads = afterBaseline.collectionReadBytes - before.collectionReadBytes,
      newReads = after.collectionReadBytes - afterBaseline.collectionReadBytes,
      oldNodeVisits =
        afterBaseline.collectionNodeReads -
        before.collectionNodeReads +
        afterBaseline.collectionNodeCacheHits -
        before.collectionNodeCacheHits,
      newNodeVisits =
        after.collectionNodeReads -
        afterBaseline.collectionNodeReads +
        after.collectionNodeCacheHits -
        afterBaseline.collectionNodeCacheHits,
      oldWitnessQueries =
        afterBaseline.collectionReadWitnessQueries - before.collectionReadWitnessQueries,
      newWitnessQueries =
        after.collectionReadWitnessQueries - afterBaseline.collectionReadWitnessQueries;
    t.diagnostic(
      JSON.stringify({
        oldReads,
        newReads,
        oldNodeVisits,
        newNodeVisits,
        oldWitnessQueries,
        newWitnessQueries,
        headers: 71,
        scopeOpens:
          after.identityPolicyScopeReconstructions -
          afterBaseline.identityPolicyScopeReconstructions,
        scopeHits: after.identityPolicyScopeCacheHits - afterBaseline.identityPolicyScopeCacheHits,
      }),
    );
    assert.ok(
      newNodeVisits < oldNodeVisits,
      'per-receipt subtree uses fewer logical tree node visits for complete header decoding',
    );
    assert.equal(
      after.identityPolicyScopeReconstructions - afterBaseline.identityPolicyScopeReconstructions,
      1,
    );
    assert.equal(
      after.identityPolicyScopeCacheHits - afterBaseline.identityPolicyScopeCacheHits,
      70,
    );
    assert.equal(
      after.identityPolicyReceiptReconstructions -
        afterBaseline.identityPolicyReceiptReconstructions,
      71,
    );
  },
);

test('native receipt subtree preserves scalar structured fragment addresses and missing null lexical fields', async (t) => {
  const structured = await nativeReceiptMemoFixture(t, 1, 256 * 1024 + 100);
  let expected: import('../intake-review-collection.ts').IntakeReviewFragmentReference | undefined;
  const selected = structured.open(
    undefined,
    (view) => {
      const intake = view.child(view.root(), 'intake')!,
        workflow = view.child(intake, 'workflow')!;
      const receipt = view.children(workflow, 'identityConfirmations', {
        items: 1,
        bytes: 128 * 1024,
      }).records[0]!;
      const child = view.child(receipt, 'assignedPerson')!;
      expected = {
        format: 'health-intake-review-fragment-v1',
        logical: view.logical,
        address: view.address(child),
      };
    },
    true,
  );
  t.after(() => selected.close?.());
  assert.throws(
    () => structured.scan(selected),
    (error: unknown) => {
      assert.ok(error instanceof IntakeReviewFragmentRequired);
      assert.deepEqual(error.reference, expected);
      return true;
    },
  );
  const scalar = await nativeReceiptMemoFixture(t, 1);
  Object.assign(scalar.receipts[0]!.identityAnswers, {
    fictionalScalar: 'x'.repeat(256 * 1024 + 100),
  });
  const scalarSelected = scalar.open(
    undefined,
    (view) => {
      const intake = view.child(view.root(), 'intake')!,
        workflow = view.child(intake, 'workflow')!;
      const receipt = view.children(workflow, 'identityConfirmations', {
        items: 1,
        bytes: 128 * 1024,
      }).records[0]!;
      assert.equal(view.child(receipt, 'identityAnswers'), undefined);
      expected = {
        format: 'health-intake-review-fragment-v1',
        logical: view.logical,
        address: view.address(receipt),
        field: 'identityAnswers',
      };
    },
    true,
  );
  t.after(() => scalarSelected.close?.());
  assert.throws(
    () => scalar.scan(scalarSelected),
    (error: unknown) => {
      assert.ok(error instanceof IntakeReviewFragmentRequired);
      assert.deepEqual(error.reference, expected);
      return true;
    },
  );
  const ordinary = await nativeReceiptMemoFixture(t, 1);
  Object.assign(ordinary.receipts[0]!, { attestation: null, knownNameAdded: '' });
  const ordinarySelected = ordinary.open(undefined, undefined, true);
  t.after(() => ordinarySelected.close?.());
  const receipt = ordinary.scan(ordinarySelected)[0]!;
  assert.equal(receipt.attestation, null);
  assert.equal(receipt.knownNameAdded, '');
  assert.equal(Object.hasOwn(receipt, 'selfUpdate'), false);
  assert.ok(JSON.stringify(receipt.identityAnswers).includes('12.00'));
});
