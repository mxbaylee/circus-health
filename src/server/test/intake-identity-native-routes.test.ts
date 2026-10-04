import { readIntakeEnvelopeText } from '../intake-authority.ts';
import {
  registerIntakeFile,
  intakeSourceVersion,
  type IntakeDetails,
} from '../intake-state-access.ts';
import {
  intakeCandidateId,
  intakeCandidateVersionIdForRevision,
  workflowHash,
} from '../intake-workflow.ts';
import { canonicalLiteral, validateJSONL, validationSummary } from '../intake-format.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
import { intakeFileIdentity } from '../intake-files.ts';
import { setImmediate } from 'node:timers/promises';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { getNativeIntakeIdentityReview } from '../intake-identity-native.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDatabase } from '../database.ts';
import { profileOriginal, ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability, rebuildProfile } from '../portable.ts';
import { createBackup } from '../recovery.ts';
import {
  uploadIntake,
  proposeConversion,
  proposeConversionRead,
  getIntake,
  getRetainedIntakeOriginalReference,
  intakeTransaction,
} from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { prepareIntakeWorkflowCommand } from '../intake-workflow-command.ts';
import {
  collectionWorkflowReviewScope,
  readIntakeReviewValue,
} from '../intake-review-collection.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { readCollectionReviewMembership } from '../intake-review-membership-index.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  clearNativeIdentityPreviews,
  nativeIdentityPreviewCounts,
} from '../intake-identity-preview-cache.ts';
import { getNote, saveNote } from '../notes.ts';
import { createApp } from '../index.ts';
import { fictionalModel } from './fictional-model.ts';
import { readQualificationReview } from '../../scripts/qualification-intake-read.ts';
import type { HealthRecordEnvelope, IntakeReportGroup } from '../../shared/intake.ts';
import type { IntakeReportGroupVersionV2 } from '../../shared/intake-report-version.ts';
import type {
  IntakeIdentityConfirmation,
  IntakeIdentityReview,
  IntakeIdentityScope,
} from '../../shared/intake-identity.ts';

const heading = 'Fictional report IVY-61',
  subject = 'Patient: Fictional Iris Meadow',
  birthDate = '1990-03-08';
const envelope = (id: string, explicit = false): HealthRecordEnvelope => ({
  format: 'health-record-v1',
  id,
  kind: 'record',
  payload: { literal: '12.00' },
  provenance: {
    capturedVia: null,
    sourceSystem: 'Invented Clinic',
    sourceRecordId: id,
    evidenceClass: 'provider_export',
    locator: 'page 1 result ' + id,
  },
  coverage: { status: 'complete_response', notes: [] },
  clinical: {
    kind: 'observation',
    subject: 'unknown',
    testLabel: 'Fictional test ' + id,
    valueText: '12.00',
    unit: 'mg',
    date: '2026-03-02',
  },
  report: {
    key: 'claim',
    title: 'Fictional report',
    anchor: { locator: 'page 1 heading', text: heading },
    subject: { locator: 'page 1 patient', text: subject },
  },
  ...(explicit
    ? {
        reviewIssues: [
          {
            kind: 'identity' as const,
            field: 'subject',
            prompt: 'Confirm the original identifies its patient rather than a guardian',
            textAnchor: subject,
          },
        ],
      }
    : {}),
});
async function fixture(
  t: test.TestContext,
  native = true,
  count = 3,
  explicit = false,
  recordAt = (n: number) => envelope('fictional-' + n, explicit && n === count - 1),
  originalText = `${heading}\n${subject}\nDOB: ${birthDate}\nFictional result`,
  nativeProposal = false,
) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-identity-http-')),
    profileId = 'fictional-identity-http';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const original = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    bytes: Buffer.from(originalText),
    newProviderName: 'Invented Clinic',
  });
  if (nativeProposal) await buildIntakeCollectionEnvelope(db, { id: original.id });
  // Native ordinary-import qualification starts the verified contributor app
  // before publishing the proposal. Separate recovery fixtures retain cold
  // startup after publication and qualify reconstruction explicitly.
  const startApp = async () => {
    const app = createApp({
      root,
      databases: new Map([[profileId, db]]),
      intakeBatchOptions: { authorized: () => false },
    });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api/profiles/${profileId}/intakes/${encodeURIComponent(original.id)}/`;
    t.after(() => {
      app.close();
      if (db.isOpen) db.close();
      rmSync(root, { recursive: true, force: true });
    });
    return { app, base };
  };
  const started = nativeProposal ? await startApp() : undefined;
  const proposed = await (nativeProposal ? proposeConversionRead : proposeConversion)(
    db,
    root,
    profileId,
    original.id,
    {
      version: original.version,
      summary: 'Independently fictional proposal',
      jsonlText: Array.from({ length: count }, (_, n) => JSON.stringify(recordAt(n))).join('\n'),
    },
  );
  const groupId = nativeProposal
    ? (() => {
        const view = openIntakeCollectionEnvelope(db, { id: original.id }),
          intake = view.child(view.root(), 'intake')!,
          workflow = view.child(intake, 'workflow')!,
          group = view.childAt(workflow, 'reportGroups', 0)!,
          field = view.field(group, 'id');
        assert.equal(field.kind, 'value');
        return (field as { kind: 'value'; value: string }).value;
      })()
    : getIntake(db, root, profileId, original.id).workflow!.reportGroups![0]!.id;
  if (native && !nativeProposal) await buildIntakeCollectionEnvelope(db, { id: original.id });
  const { app, base } = started || (await startApp());
  const request = async (action: string, input?: unknown, status = 200) => {
    const response = await fetch(
      base + action,
      input === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
            body: JSON.stringify(input),
          },
    );
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value.data || value;
  };
  const review = () =>
    request(
      'identity-review?groupId=' + encodeURIComponent(groupId),
    ) as Promise<IntakeIdentityReview>;
  return { root, profileId, db, original, proposed, groupId, app, base, request, review };
}

// One native ordinary proposal, two retained duplicate occurrences, complete
// public scope/confirmation/replay and downstream policy. Host-only hang guard.
test(
  'actual native identity retains both duplicate competing group occurrences and repairs them once',
  { timeout: 120000 },
  async (t) => {
    const other = ['Patient: Fictional Rowan River', 'Patient: Fictional Willow Brook'];
    const f = await fixture(
      t,
      true,
      1,
      false,
      (n) => envelope('duplicate-' + n),
      `${heading}\n${subject}\n${other.join('\n')}\nDOB: ${birthDate}\nFictional result`,
      true,
    );
    type NativeGroup = Omit<IntakeReportGroup, 'versions'> & {
      versions: IntakeReportGroupVersionV2[];
    };
    const view = openIntakeCollectionEnvelope(f.db, { id: f.original.id }),
      intake = view.child(view.root(), 'intake')!,
      workflow = view.child(intake, 'workflow')!,
      original = readIntakeReviewValue<NativeGroup>(
        view,
        view.find('reportGroup', workflow, f.groupId)!,
        256 * 1024,
      );
    const groups = other.map((text, n): NativeGroup => ({
      ...original,
      id: 'duplicate-B',
      report: { ...original.report!, subject: { ...original.report!.subject!, text } },
      versions: [{ ...original.versions.at(-1)!, id: 'duplicate-version-' + n }],
    }));
    const prepared = await prepareIntakeWorkflowCommand(
      f.db,
      { id: f.original.id },
      {
        version: f.proposed.version,
        operationId: 'fictional-duplicate-competing-groups',
        request: { groups },
        createdAt: '2026-01-01T00:00:00Z',
        changes: function* ({ workflow }) {
          for (const group of groups)
            yield {
              op: 'append' as const,
              record: workflow,
              field: 'reportGroups',
              jsonText: JSON.stringify(group),
            };
        },
      },
    );
    if (prepared.replayed) throw Error('Unexpected fixture replay');
    intakeTransaction(
      f.db,
      () => selectedEnvelopeStore(f.db, { id: f.original.id }).collections.stage(prepared.prepared),
      { operationId: prepared.publicationId, fingerprint: prepared.fingerprint },
    );
    const before = intakeWorkCounters(f.db).warm,
      review = await f.review(),
      scope = review.scopeReference!;
    assert.equal(scope.collection.competingSubjects, 2);
    const page = await f.request(
        `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=competingSubjects&limit=1`,
      ),
      second = await f.request(
        `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=competingSubjects&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
      );
    assert.ok(page.nextCursor);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(
      [page.items[0].value, second.items[0].value],
      groups.map((group) => ({
        groupId: group.id,
        groupVersionId: group.versions[0]!.id,
        subject: group.report!.subject!,
      })),
    );
    const targets = await f.request(
      `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=assignmentTargets&limit=1`,
    );
    const command: IntakeIdentityConfirmation = {
      version: scope.intakeVersion,
      operationId: 'fictional-duplicate-competing-confirm',
      scope,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_identity_questions',
    };
    await f.request('identity-scope', command);
    const after = await f.review();
    assert.equal(after.status, 'prior_confirmation');
    assert.equal(after.blocking, false);
    await f.request('identity-scope', command);
    assert.equal((await f.review()).confirmationCount, 1);
    const current = openIntakeCollectionEnvelope(f.db, { id: f.original.id });
    const policy = collectionWorkflowReviewScope({
      view: current,
      catalog: createReportSnapshotCatalog(f.db, { id: f.original.id }),
      metadataBytes: 256 * 1024,
      membershipIndex: readCollectionReviewMembership(f.db, { id: f.original.id }, current),
      readCacheState: () => reviewReadStamp(f.db),
      packageEvidence: false,
      activeReceipt: () => true,
      originalFingerprint: () => '',
      reportSource: () => undefined,
    });
    try {
      assert.equal(
        policy.competingBoundaryUnrepaired(
          policy.identityGroup(f.groupId)!,
          command.operationId,
          targets.items[0].value as IntakeIdentityScope['targets'][number],
        ),
        false,
        'both actual current occurrences consume their own confirmed witnesses',
      );
    } finally {
      policy.close!();
    }
    assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
  },
);
for (const native of [false, true])
  // Real accepted authority selection, source review and checkpoint preparation
  // need a host-fixture hang budget; scaling is checked by work counts below.
  test(
    `actual HTTP common identity preserves ${native ? 'native reference' : 'legacy'} membership and atomic Self updates`,
    { timeout: 120000 },
    async (t) => {
      const f = await fixture(t, native),
        before = { ...intakeWorkCounters(f.db).warm };
      const previews = await Promise.all(
        native ? [f.review(), f.review(), f.review()] : [f.review()],
      );
      const review = previews[0]!,
        scope = review.scopeReference || review.scope;
      if (native) {
        assert.ok(
          previews.every(
            (value) => value.scopeReference!.scopeToken === review.scopeReference!.scopeToken,
          ),
        );
      }
      assert.ok(scope);
      assert.equal(review.status, 'confirmation_required');
      assert.deepEqual(review.offeredSelfFields, { fullName: 'Fictional Iris Meadow', birthDate });
      if (native) {
        assert.equal(review.scope, null);
        assert.ok(review.scopeReference);
        assert.equal(review.scopeReference.collection.membership, 3);
        assert.equal(review.scopeReference.collection.assignmentTargets, 3);
        assert.equal('targets' in scope, false);
        const temporaryCounts = () => reviewIssueScratchCounts(f.db);
        const baseline = temporaryCounts();
        const sourceReview = await f.request(
          `report-source-review?groupId=${encodeURIComponent(f.groupId)}&view=all&limit=2`,
        );
        assert.equal(sourceReview.targets.total, 3);
        assert.equal(sourceReview.targets.items.length, 2);
        assert.ok(sourceReview.targets.nextCursor);
        await f.request(
          `report-source-review?groupId=${encodeURIComponent(f.groupId)}&view=all&limit=2&cursor=invalid`,
          undefined,
          409,
        );
        assert.deepEqual(temporaryCounts(), baseline);
        const page = await f.request(
          `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=assignmentTargets&limit=2`,
        );
        assert.equal(page.items.length, 2);
        assert.equal(page.total, 3);
        assert.ok(page.nextCursor);
        const last = await f.request(
          `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=assignmentTargets&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
        );
        assert.equal(last.items.length, 1);
        assert.equal(last.nextCursor, null);
        assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
        assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
      } else assert.equal(review.scope!.assignmentTargets!.length, 3);
      const input: IntakeIdentityConfirmation = {
        version: scope.intakeVersion,
        operationId: 'fictional-native-identity-confirm',
        scope,
        outcome: 'this_is_me',
        attestation: 'confirmed_displayed_report_subject',
        selfUpdate: { expectedVersion: review.self.version, fields: review.offeredSelfFields },
      };
      await f.request(
        'identity-scope',
        { ...input, selfUpdate: { ...input.selfUpdate, expectedVersion: review.self.version + 1 } },
        409,
      );
      assert.equal(getNote(f.db, 'person-note:self').version, review.self.version);
      await f.request(
        'identity-scope',
        { ...input, scope: { ...scope, profileId: 'fictional-other-profile' } },
        409,
      );
      const saved = await f.request('identity-scope', input);
      assert.equal(saved.version, input.version + 1);
      assert.equal(getNote(f.db, 'person-note:self').person.fullName, 'Fictional Iris Meadow');
      assert.equal(getNote(f.db, 'person-note:self').person.birthDate, birthDate);
      const selfVersion = getNote(f.db, 'person-note:self').version;
      const replayed = await f.request('identity-scope', input);
      assert.equal(replayed.version, saved.version);
      assert.equal(getNote(f.db, 'person-note:self').version, selfVersion);
      await f.request('identity-scope', { ...input, printedName: 'Fictional altered' }, 409);
      const after = await f.review();
      assert.equal(after.status, 'prior_confirmation');
      assert.equal(after.blocking, false);
      if (native) {
        const view = openIntakeCollectionEnvelope(f.db, { id: f.original.id }),
          intake = view.child(view.root(), 'intake')!,
          workflow = view.child(intake, 'workflow')!;
        assert.equal(view.childCount(workflow, 'identityConfirmations'), 1);
        assert.equal(view.childCount(workflow, 'reviewDrafts'), 3);
        assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
      }
    },
  );
// This fixture exports real contributor authority and reconstructs a fresh cache;
// encrypted-profile recovery is qualified by the separate runtime/archive fixtures.
test(
  'native identity pages include off-page explicit questions and preserve stale and recovery checks',
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t, true, 3, true),
      beforeWork = intakeWorkCounters(f.db),
      review = await f.review(),
      scope = review.scopeReference!;
    assert.ok(scope);
    assert.equal(scope.collection.assignmentTargets, 3);
    assert.equal(scope.collection.questions, 1);
    const questions = await f.request(
      `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=questions&limit=1`,
    );
    assert.match(questions.items[0].value.prompt, /guardian/);
    const input: IntakeIdentityConfirmation = {
      version: scope.intakeVersion,
      operationId: 'fictional-offpage-confirm',
      scope,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_identity_questions',
    };
    await f.request(
      'identity-scope',
      { ...input, attestation: 'confirmed_displayed_report_subject' },
      400,
    );
    const currentSelf = getNote(f.db, 'person-note:self');
    saveNote(f.db, currentSelf.id, {
      version: currentSelf.version,
      person: { ...currentSelf.person, birthDate: '1980-01-01' },
    });
    await f.request('identity-scope', input, 409);
    const conflicting = await f.review();
    assert.equal(conflicting.selfBirthDateConflict, true);
    assert.equal(conflicting.blocking, true);
    const restoredSelf = getNote(f.db, currentSelf.id);
    saveNote(f.db, restoredSelf.id, {
      version: restoredSelf.version,
      person: { ...restoredSelf.person, birthDate: '' },
    });
    const fresh = await f.review(),
      freshScope = fresh.scopeReference!;
    const valid = { ...input, version: freshScope.intakeVersion, scope: freshScope };
    await f.request('identity-scope', valid);
    const backup = await createBackup(f.db, f.root, f.profileId),
      target = join(f.root, 'recovered');
    const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
      recovered = openDatabase(rebuilt.database, f.profileId);
    attachPersonalDurability(recovered, {
      root: target,
      profileId: f.profileId,
      initialize: false,
    });
    try {
      const { getIntakeIdentityReview, confirmIntakeIdentityScope } =
        await import('../intake-identity.ts');
      const result = await getIntakeIdentityReview(
        recovered,
        target,
        f.profileId,
        f.original.id,
        f.groupId,
      );
      assert.equal(result.status, 'prior_confirmation');
      assert.equal(result.blocking, false);
      assert.equal(result.scopeReference!.collection.assignmentTargets, 3);
      const replayed = await confirmIntakeIdentityScope(
        recovered,
        target,
        f.profileId,
        f.original.id,
        valid,
      );
      assert.equal(replayed.version, freshScope.intakeVersion + 1);
      assert.equal(intakeWorkCounters(recovered).warm.envelopeHydrations, 0);
      assert.equal(
        intakeWorkCounters(f.db).warm.envelopeHydrations,
        beforeWork.warm.envelopeHydrations,
      );
      t.diagnostic(
        JSON.stringify({
          original: intakeWorkCounters(f.db),
          recovered: intakeWorkCounters(recovered),
        }),
      );
    } finally {
      recovered.close();
    }
  },
);

test(
  'native public identity creates one Family Person atomically and replays the assignment',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t, true, 1);
    const review = await f.review(),
      scope = review.scopeReference!;
    const before = Number(
      f.db.prepare("SELECT count(*) n FROM notes WHERE kind='person'").get()!.n,
    );
    const input: IntakeIdentityConfirmation = {
      version: scope.intakeVersion,
      operationId: 'fictional-family-create-confirm',
      scope,
      outcome: 'this_is_person',
      attestation: 'confirmed_displayed_report_subject',
      personSelection: {
        newPerson: { fullName: 'Fictional Iris Meadow', relationship: 'relative' },
      },
    };
    await f.request('identity-scope', input);
    assert.equal(
      Number(f.db.prepare("SELECT count(*) n FROM notes WHERE kind='person'").get()!.n),
      before + 1,
    );
    const after = await f.review();
    assert.equal(after.status, 'prior_confirmation');
    assert.equal(after.blocking, false);
    assert.notEqual(after.assignedPerson!.personId, 'patient');
    assert.equal(after.assignedPerson!.fullName, 'Fictional Iris Meadow');
    const assignedNote = getNote(f.db, after.assignedPerson!.noteId);
    assert.deepEqual(after.assignedPerson, {
      noteId: assignedNote.id,
      personId: assignedNote.personId!,
      version: assignedNote.version,
      fullName: 'Fictional Iris Meadow',
    });
    const { getIntakeIdentityReview } = await import('../intake-identity.ts');
    const direct = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.original.id,
      f.groupId,
    );
    assert.deepEqual(direct.assignedPerson, after.assignedPerson);
    await f.request('identity-scope', input);
    assert.equal(
      Number(f.db.prepare("SELECT count(*) n FROM notes WHERE kind='person'").get()!.n),
      before + 1,
    );
  },
);

// This host-only fixture builds 71 native records, reconstructs every competing
// claim and >256 KiB question, then confirms, rereviews and retries the operation.
// Allow slow CI setup margin; complete evidence/count/cleanup assertions are the oracle.
test(
  'native common identity preserves a complete giant competing-subject question through confirmation',
  { timeout: 1200000 },
  async (t) => {
    const otherSubjects = Array.from(
      { length: 70 },
      (_, n) => `Patient: Fictional alternative ${n} ` + 'z'.repeat(3900),
    );
    const f = await fixture(
      t,
      true,
      otherSubjects.length + 1,
      false,
      (n) => {
        const record = envelope('fictional-competing-' + n);
        if (n)
          record.report = {
            ...record.report!,
            key: 'claim-' + n,
            subject: { locator: 'page 1 patient', text: otherSubjects[n - 1]! },
          };
        return record;
      },
      undefined,
      true,
    );
    // This fixture opens only identity/snapshot endpoints; no public clinical
    // read session is intentionally retained. These counts track identity-owned cleanup.
    const beforeWork = intakeWorkCounters(f.db).warm,
      beforeScratch = reviewIssueScratchCounts(f.db);
    const review = await f.review(),
      scope = review.scopeReference!;
    assert.deepEqual(reviewIssueScratchCounts(f.db), beforeScratch);
    assert.equal(review.confirmationCount, 0);
    assert.ok(scope);
    assert.equal(scope.collection.assignmentTargets, 1);
    assert.equal(scope.collection.competingSubjects, otherSubjects.length);
    const page = await f.request(
      `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=questions&limit=2`,
    );
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 2);
    assert.deepEqual(page.items[0], {
      kind: 'value',
      value: {
        prompt:
          'This report boundary has conflicting subject claims; resolve identity individually',
      },
    });
    const completeQuestion = page.items[1];
    assert.equal(completeQuestion.kind, 'reference');
    assert.equal(completeQuestion.reference.format, 'health-intake-identity-item-v2');
    assert.equal(completeQuestion.reference.section, 'questions');
    assert.equal(completeQuestion.reference.ordinal, 1);
    assert.ok(completeQuestion.reference.bytes > 256 * 1024);
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const fragment = await f.request(
        `identity-scope-fragment?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=questions&ordinal=${completeQuestion.reference.ordinal}&offset=${offset}`,
      );
      const bytes = Buffer.from(fragment.data, 'base64');
      assert.ok(bytes.length <= 32768);
      parts.push(bytes);
      if (fragment.complete) break;
      assert.ok(fragment.nextOffset > offset);
      offset = fragment.nextOffset;
    }
    assert.equal(Buffer.concat(parts).byteLength, completeQuestion.reference.bytes);
    const question = JSON.parse(Buffer.concat(parts).toString());
    assert.equal(
      question.prompt,
      'Other extraction claims name a different subject at this same report boundary. Review the original and confirm the displayed subject and person for only the listed records.',
    );
    const claims: { subject: { text: string } }[] = [];
    let cursor: string | null = null;
    do {
      const page = await f.request(
        `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=competingSubjects&limit=10${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      );
      claims.push(
        ...page.items.map((item: { kind: string; value: { subject: { text: string } } }) => {
          assert.equal(item.kind, 'value');
          return item.value;
        }),
      );
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(claims.length, otherSubjects.length);
    assert.deepEqual(claims.map((claim) => claim.subject.text).sort(), [...otherSubjects].sort());
    assert.equal(question.textAnchor, claims.map((claim) => claim.subject.text).join(' / '));
    const input: IntakeIdentityConfirmation = {
      version: scope.intakeVersion,
      operationId: 'fictional-complete-competing-confirm',
      scope,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_identity_questions',
    };
    await f.request('identity-scope', input);
    const after = await f.review();
    assert.equal(after.status, 'prior_confirmation');
    assert.equal(after.blocking, false);
    assert.equal(after.confirmationCount, 1);
    await f.request('identity-scope', input);
    const afterWork = intakeWorkCounters(f.db).warm;
    assert.equal(afterWork.sourceDTOHydrations, beforeWork.sourceDTOHydrations);
    assert.equal(afterWork.envelopeHydrations, beforeWork.envelopeHydrations);
    assert.equal(afterWork.envelopeTextReads, beforeWork.envelopeTextReads);
    assert.deepEqual(reviewIssueScratchCounts(f.db), beforeScratch);
  },
);

// This durable fixture confirms >256 KiB of independent witnesses, reconstructs
// current policy and retries the exact durable operation. The hang guard covers
// those host writes; complete counts and zero whole hydrations qualify behavior.
test(
  'native identity confirmations retain all per-record issue witnesses beyond the inline metadata budget',
  { timeout: 180000 },
  async (t) => {
    const issueCount = 70;
    const f = await fixture(t, true, 1, false, () => {
      const record = envelope('fictional-many-questions');
      record.reviewIssues = Array.from({ length: issueCount }, (_, n) => ({
        kind: 'identity' as const,
        field: 'subject',
        prompt: `Confirm patient uncertainty ${n}: ` + 'x'.repeat(3900),
        textAnchor: subject,
      }));
      return record;
    });
    const before = { ...intakeWorkCounters(f.db).warm };
    const review = await f.review(),
      scope = review.scopeReference!;
    assert.equal(scope.collection.questions, issueCount);
    const targets = await f.request(
      `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=assignmentTargets&limit=1`,
    );
    assert.equal(targets.items[0].kind, 'value');
    assert.equal(targets.items[0].value.issueIds.length, issueCount + 1);
    let cursor: string | null = null,
      seen = 0;
    do {
      const page = await f.request(
        `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=questions&limit=50${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      );
      seen += page.items.length;
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(seen, issueCount);
    const input: IntakeIdentityConfirmation = {
      version: scope.intakeVersion,
      operationId: 'fictional-many-witnesses-confirm',
      scope,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_identity_questions',
    };
    await f.request('identity-scope', input);
    const after = await f.review();
    assert.equal(after.status, 'prior_confirmation');
    assert.equal(after.blocking, false);
    assert.equal(after.scopeReference!.collection.targets, 0);
    await f.request('identity-scope', input);
    assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
    assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
  },
);

test(
  'public absent-subject identity preserves all name claims behind a bounded conflict summary',
  { timeout: 180000 },
  async (t) => {
    const count = 48;
    const claimedName = (n: number) =>
      'Fictional X' +
      String.fromCharCode(65 + Math.floor(n / 26)) +
      String.fromCharCode(97 + (n % 26)) +
      ' ' +
      'Meadow'.repeat(28);
    const f = await fixture(
      t,
      true,
      1,
      false,
      (n) => {
        const record = envelope('fictional-unbounded-names-' + n);
        delete record.report;
        record.payload = {
          literal: '12.00',
          nameReadings: Array.from({ length: count }, (_, offset) => claimedName(offset)),
        };
        // The complete claims, not the record count, trigger this boundary:
        // 48 individually small name claims exceed the inline conflict budget.
        record.reviewIssues = Array.from({ length: count }, (_, offset) => ({
          kind: 'identity',
          field: 'subject',
          prompt: `Who does this record belong to? Reading ${offset}`,
          textAnchor: claimedName(offset),
          selfSuggestion: { fullName: claimedName(offset) },
        }));
        return record;
      },
      heading +
        '\nFictional records without a printed patient boundary.\n' +
        Array.from({ length: count }, (_, n) => claimedName(n)).join('\n'),
      true,
    );
    const before = { ...intakeWorkCounters(f.db).warm };
    const result = await f.review();
    assert.equal(result.scope, null);
    assert.equal(result.scopeReference, undefined);
    assert.equal(result.blocking, true);
    assert.equal(result.evidencedIdentity.fullName, undefined);
    const conflict = result.conflicts.find((value) => value.field === 'fullName');
    assert.equal(conflict?.evidencedValueReference?.names, count);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8192);
    const detail = await f.request(
      `../report-queue/${encodeURIComponent(f.groupId)}?intakeId=${encodeURIComponent(f.original.id)}&view=all`,
    );
    assert.ok(detail.records.records[0]?.proposalId);
    const full = await readQualificationReview(
      f.request,
      'review?proposalId=' + encodeURIComponent(detail.records.records[0].proposalId),
    );
    const inspected = new Set<string>();
    for (const record of full.records) {
      let cursor: string | null = null;
      do {
        const page = await f.request('review-record-section', {
          proposalId: full.proposalId,
          recordId: record.id,
          candidateVersionId: record.candidateVersionId,
          section: 'issues',
          limit: 17,
          bytes: 65536,
          cursor,
        });
        for (const item of page.items) {
          let value = item.detail.value;
          if (item.detail.kind === 'reference') {
            assert.ok(item.detail.reference.bytes < 128 * 1024);
            const parts: Buffer[] = [];
            let offset = 0;
            for (;;) {
              const fragment = await f.request('review-record-section-fragment', {
                reference: item.detail.reference,
                offset,
                bytes: 32768,
              });
              parts.push(Buffer.from(fragment.data, 'base64'));
              if (fragment.complete) break;
              assert.ok(fragment.nextOffset > offset);
              offset = fragment.nextOffset;
            }
            value = JSON.parse(Buffer.concat(parts).toString('utf8'));
          }
          if (value.selfSuggestion?.fullName) inspected.add(value.selfSuggestion.fullName);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    assert.deepEqual(inspected, new Set(Array.from({ length: count }, (_, n) => claimedName(n))));
    assert.equal(getNote(f.db, 'person-note:self').person.fullName || '', '');
    assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
    assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
  },
);

test(
  'native identity exposes complete deduplicated advisory warnings',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(
      t,
      true,
      3,
      false,
      (n) => {
        const record = envelope('fictional-warning-' + n),
          date = n === 2 ? '1972-01-01' : '1971-01-01';
        const textAnchor = subject + ' DOB: ' + date;
        record.payload = { text: textAnchor };
        record.reviewIssues = [
          {
            kind: 'identity',
            field: 'subject',
            prompt: 'Does this report belong to you?',
            textAnchor,
            selfSuggestion: { fullName: 'Fictional Iris Meadow', birthDate: date },
          },
        ];
        return record;
      },
      `${heading}\n${subject}\nFictional result`,
    );
    const self = getNote(f.db, 'person-note:self');
    saveNote(f.db, self.id, {
      version: self.version,
      person: { ...self.person, fullName: 'Fictional Iris Meadow', birthDate },
    });
    const review = await f.review();
    assert.equal(review.status, 'evidenced_match');
    assert.equal(review.blocking, false);
    assert.equal(review.assignedPerson, undefined);
    assert.deepEqual(review.warnings!.map((warning) => warning.modelBirthDate).sort(), [
      '1971-01-01',
      '1972-01-01',
    ]);
    const page = await f.request(
      `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${review.scopeReference!.scopeToken}&section=warnings&limit=1`,
    );
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
  },
);

// Actual contributor HTTP proof. This is durable plaintext fixture storage;
// encrypted-runtime qualification remains in its separate owning fixtures.
test(
  'native identity repeated preview verifies artifacts without full preparation and refuses changed originals',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    const cold = await f.review();
    assert.ok(cold.scopeReference);
    assert.equal(
      nativeIdentityPreviewCounts(f.db).entries,
      0,
      'cold snapshot publication cannot certify earlier output',
    );
    const stable = await f.review();
    assert.equal(
      nativeIdentityPreviewCounts(f.db).entries,
      1,
      'unchanged full reconstruction seeds bounded wire',
    );
    const before = { ...intakeWorkCounters(f.db).warm };
    const [warm, concurrent] = await Promise.all([f.review(), f.review()]);
    assert.deepEqual(warm, stable);
    assert.deepEqual(concurrent, stable);
    assert.equal(
      intakeWorkCounters(f.db).warm.identityPreviewFullPreparations,
      before.identityPreviewFullPreparations,
    );
    assert.ok(
      intakeWorkCounters(f.db).warm.identityPreviewArtifactChecks >
        before.identityPreviewArtifactChecks,
    );
    t.diagnostic(
      JSON.stringify({
        warmFullPreparations:
          intakeWorkCounters(f.db).warm.identityPreviewFullPreparations -
          before.identityPreviewFullPreparations,
        warmArtifactChecks:
          intakeWorkCounters(f.db).warm.identityPreviewArtifactChecks -
          before.identityPreviewArtifactChecks,
      }),
    );
    warm.self.fullName = 'Caller-only mutation';
    assert.equal((await f.review()).self.fullName, stable.self.fullName);
    f.db.prepare("UPDATE notes SET title=title WHERE id='person-note:self'").run();
    const changedBefore = intakeWorkCounters(f.db).warm.identityPreviewFullPreparations;
    await f.review();
    assert.ok(
      intakeWorkCounters(f.db).warm.identityPreviewFullPreparations > changedBefore,
      'exact SQL change invalidates preview',
    );
    assert.equal(
      nativeIdentityPreviewCounts(f.db).entries,
      1,
      'peer mutation starts from a retained preview',
    );
    const peerBefore = intakeWorkCounters(f.db).warm.identityPreviewFullPreparations;
    using peer = new DatabaseSync(ensureProfileDirectories(f.root, f.profileId).database);
    peer
      .prepare(
        "UPDATE notes SET title=title || ' fictional peer mutation' WHERE id='person-note:self'",
      )
      .run();
    await f.review();
    assert.ok(
      intakeWorkCounters(f.db).warm.identityPreviewFullPreparations > peerBefore,
      'peer SQL data_version invalidates preview',
    );
    const original = getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, f.original.id),
      bytes = readFileSync(original.path);
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    writeFileSync(original.path, changed);
    try {
      const refused = await f.request(
        'identity-review?groupId=' + encodeURIComponent(f.groupId),
        undefined,
        409,
      );
      assert.equal(refused.error.code, 'SOURCE_CHANGED');
      assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
    } finally {
      writeFileSync(original.path, bytes);
    }
    await f.review();
    assert.equal(nativeIdentityPreviewCounts(f.db).entries, 1);
    const proposalRow = f.db
      .prepare("SELECT path FROM source_files WHERE kind='intake_proposal'")
      .get();
    assert.ok(proposalRow);
    const proposalPath = profileOriginal(f.root, String(proposalRow.path), f.profileId),
      proposalBytes = readFileSync(proposalPath),
      changedProposal = Buffer.from(proposalBytes);
    changedProposal[changedProposal.length - 1] ^= 1;
    writeFileSync(proposalPath, changedProposal);
    try {
      const refused = await f.request(
        'identity-review?groupId=' + encodeURIComponent(f.groupId),
        undefined,
        409,
      );
      assert.equal(refused.error.code, 'SOURCE_CHANGED');
      assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
    } finally {
      writeFileSync(proposalPath, proposalBytes);
    }
    // Clear while an asynchronous actual preparation is in flight: its old
    // lifecycle witness must never populate the new memo generation.
    const { getNativeIntakeIdentityReview } = await import('../intake-identity-native.ts');
    const pending = getNativeIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.original.id,
      f.groupId,
    );
    await Promise.resolve();
    clearNativeIdentityPreviews(f.db);
    await pending;
    assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
  },
);

// Real native publication + public read/confirmation/replay with an entirely
// superseded retained prefix; no model work. The complete 71-receipt fixture
// measured 235s for publication, full public history scans, fresh confirmation
// and exact replay. This host hang guard covers all those operations.
test(
  'actual native identity handles superseded-only receipt history before fresh confirmation',
  { timeout: 300000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    const hydrationBaseline = intakeWorkCounters(f.db).warm.envelopeHydrations;
    const initial = await f.review();
    const reference = initial.scopeReference!;
    assert.ok(reference);
    // A receipt must reference accepted logical authority, rather than the
    // disposable preview snapshot created by GET.
    const accepted = await f.request('identity-scope', {
      version: reference.intakeVersion,
      operationId: 'fictional-before-superseded',
      scope: reference,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_identity_questions',
    } satisfies IntakeIdentityConfirmation);
    const current = openIntakeCollectionEnvelope(f.db, { id: f.original.id });
    const workflow = current.child(current.child(current.root(), 'intake')!, 'workflow')!;
    const receipt = readIntakeReviewValue<Record<string, unknown>>(
      current,
      current.childAt(workflow, 'identityConfirmations', 0)!,
      256 * 1024,
    );
    const operationIds = Array.from({ length: 70 }, (_, n) => 'fictional-superseded-' + n);
    const prepared = await prepareIntakeWorkflowCommand(
      f.db,
      { id: f.original.id },
      {
        version: accepted.version,
        operationId: 'fictional-superseded-receipt-history',
        request: { operationIds },
        createdAt: '2026-01-01T00:00:00Z',
        *changes({ workflow }) {
          for (const operationId of operationIds)
            yield {
              op: 'append' as const,
              record: workflow,
              field: 'identityConfirmations',
              jsonText: JSON.stringify({ ...receipt, operationId }),
            };
        },
      },
    );
    if (prepared.replayed) throw Error('Unexpected fixture replay');
    intakeTransaction(
      f.db,
      () => {
        selectedEnvelopeStore(f.db, { id: f.original.id }).collections.stage(prepared.prepared);
        for (const supportOperationId of ['fictional-before-superseded', ...operationIds])
          f.db
            .prepare(
              "INSERT INTO manual_batches(id,title,status,created_at,coverage_json) VALUES(?,'Identity receipt supersession','verified',?,?)",
            )
            .run(
              'supersession:' + supportOperationId,
              '2026-01-01T00:00:00Z',
              JSON.stringify({ supportOperationId }),
            );
      },
      { operationId: prepared.publicationId, fingerprint: prepared.fingerprint },
    );
    clearNativeIdentityPreviews(f.db);
    const fresh = await f.review();
    assert.equal(fresh.confirmationCount, 0);
    assert.ok(fresh.scopeReference);
    const scope = fresh.scopeReference!;
    const command: IntakeIdentityConfirmation = {
      version: scope.intakeVersion,
      operationId: 'fictional-after-superseded-confirm',
      scope,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_identity_questions',
    };
    await f.request('identity-scope', command);
    const after = await f.review();
    assert.equal(after.confirmationCount, 1);
    assert.equal(after.status, 'prior_confirmation');
    assert.equal(after.blocking, false);
    await f.request('identity-scope', command);
    assert.equal((await f.review()).confirmationCount, 1);
    assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, hydrationBaseline);
  },
);

// Real native preparation and HTTP disconnect; no fabricated policy or timer threshold.
test(
  'native preview cancellation preserves a live coalesced subscriber',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    const before = intakeWorkCounters(f.db).warm.identityPreviewFullPreparations;
    const controller = new AbortController();
    const cancelled = getNativeIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.original.id,
      f.groupId,
      { signal: controller.signal },
    );
    const refused = assert.rejects(cancelled, { name: 'AbortError' });
    const live = getNativeIntakeIdentityReview(f.db, f.root, f.profileId, f.original.id, f.groupId);
    while (intakeWorkCounters(f.db).warm.identityPreviewFullPreparations === before) {
      t.signal.throwIfAborted();
      await setImmediate();
    }
    controller.abort();
    await refused;
    const value = await live;
    assert.ok(value.scopeReference);
    assert.equal(
      intakeWorkCounters(f.db).warm.identityPreviewFullPreparations - before,
      2,
      'one shared cold preparation, including its required post-grounding rebuild',
    );
    value.scopeReference!.report.text = 'Caller mutation';
    const next = await f.review();
    assert.notEqual(next.scopeReference!.report.text, 'Caller mutation');
    assert.deepEqual(reviewIssueScratchCounts(f.db), { databases: 0, scopes: 0, rows: 0 });
  },
);

test(
  'HTTP last-subscriber cancellation stops native staging before the next database reader',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    const before = structuredClone(intakeWorkCounters(f.db).warm);
    const controller = new AbortController();
    const cancelled = fetch(f.base + 'identity-review?groupId=' + encodeURIComponent(f.groupId), {
      signal: controller.signal,
    });
    const refused = assert.rejects(cancelled, { name: 'AbortError' });
    while (
      intakeWorkCounters(f.db).warm.identityPreviewFullPreparations -
        before.identityPreviewFullPreparations <
        2 ||
      intakeWorkCounters(f.db).warm.reportSnapshotCheckpointChanges ===
        before.reportSnapshotCheckpointChanges
    ) {
      t.signal.throwIfAborted();
      await setImmediate();
    }
    controller.abort();
    await refused;
    // The queued owner enters only after abandoned preparation closes all its scopes.
    await runExclusiveClinicalOperation(f.db, async () => undefined);
    const stopped = intakeWorkCounters(f.db).warm.reportSnapshotCheckpointChanges;
    for (let n = 0; n < 4; n++) await setImmediate();
    assert.equal(intakeWorkCounters(f.db).warm.reportSnapshotCheckpointChanges, stopped);
    assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
    assert.deepEqual(reviewIssueScratchCounts(f.db), { databases: 0, scopes: 0, rows: 0 });
    const live = await f.review();
    assert.ok(live.scopeReference, 'a later live request builds from retained authority');
  },
);

test(
  'native held operation bypasses a foreign queued preview flight',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = runExclusiveClinicalOperation(f.db, async (operation) => {
      enter();
      await released;
      return getNativeIntakeIdentityReview(f.db, f.root, f.profileId, f.original.id, f.groupId, {
        operation,
      });
    });
    await entered;
    // This caller is outside the held owner's async context and must queue behind it.
    const foreign = getNativeIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.original.id,
      f.groupId,
    );
    release();
    const first = await held,
      second = await foreign;
    assert.ok(first.scopeReference);
    assert.deepEqual(first.scopeReference, second.scopeReference);
    assert.deepEqual(reviewIssueScratchCounts(f.db), { databases: 0, scopes: 0, rows: 0 });
  },
);

test(
  'HTTP coalesced identity abort leaves its live response intact',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    const before = intakeWorkCounters(f.db).warm.identityPreviewFullPreparations;
    const controller = new AbortController();
    const cancelled = fetch(f.base + 'identity-review?groupId=' + encodeURIComponent(f.groupId), {
      signal: controller.signal,
    });
    const refused = assert.rejects(cancelled, { name: 'AbortError' });
    let identityCompleted = false;
    const live = fetch(f.base + 'identity-review?groupId=' + encodeURIComponent(f.groupId)).finally(
      () => {
        identityCompleted = true;
      },
    );
    while (intakeWorkCounters(f.db).warm.identityPreviewFullPreparations === before) {
      t.signal.throwIfAborted();
      await setImmediate();
    }
    const notes = await fetch(
      new URL(`/api/profiles/${encodeURIComponent(f.profileId)}/notes`, f.base),
    );
    assert.equal(notes.status, 200);
    assert.ok(Array.isArray((await notes.json()).data));
    assert.equal(
      identityCompleted,
      false,
      'an unrelated same-database HTTP read completes while clinical preparation remains active',
    );
    controller.abort();
    await refused;
    const response = await live;
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.ok(value.data.scopeReference);
    assert.equal(intakeWorkCounters(f.db).warm.identityPreviewFullPreparations - before, 2);
  },
);

// This fixture converts its small seed, then publishes genuine retained JSONL
// history through one supported native workflow command.
// Its historical member is intentionally not the candidate's latest version:
// identity clinical preparation may skip it, but artifact verification may not.
async function artifactHistoryFixture(t: test.TestContext) {
  const f = await fixture(t, false, 1),
    raw = JSON.parse(readIntakeEnvelopeText(f.db, { id: f.original.id })),
    details = raw.intake as IntakeDetails,
    seedCandidate = details.workflow!.candidates[0]!,
    group = details.workflow!.reportGroups!.find((value) => value.id === f.groupId)!,
    seedGroupVersion = group.versions.at(-1)!,
    seedVersion = seedCandidate.versions.at(-1)!,
    oldRecord = envelope('fictional-history');
  oldRecord.payload = { literal: '11.00' };
  oldRecord.clinical = { ...(oldRecord.clinical as Record<string, unknown>), valueText: '11.00' };
  const latestRecord = structuredClone(oldRecord);
  latestRecord.payload = { literal: '12.00' };
  latestRecord.clinical = {
    ...(latestRecord.clinical as Record<string, unknown>),
    valueText: '12.00',
  };
  const oldVersionId = intakeCandidateVersionIdForRevision({ value: oldRecord }),
    latestVersionId = intakeCandidateVersionIdForRevision({ value: latestRecord }),
    originalFile = f.db
      .prepare('SELECT id,sha256,provider_id FROM source_files WHERE id=?')
      .get(f.original.id)!,
    historyCandidateId = intakeCandidateId(
      { id: String(originalFile.id), sha256: String(originalFile.sha256) },
      { value: oldRecord },
    ),
    proposal = details.proposals[0]!,
    firstPath = String(
      f.db.prepare('SELECT path FROM source_files WHERE id=?').get(proposal.id)!.path,
    ),
    proposalDirectory = dirname(profileOriginal(f.root, firstPath, f.profileId)),
    artifacts: { id: string; path: string; bytes: number }[] = [],
    occurrences: typeof seedVersion.occurrences = [];
  let latestOccurrence: (typeof occurrences)[number] | undefined;
  assert.notEqual(oldVersionId, latestVersionId);
  assert.notEqual(historyCandidateId, seedCandidate.id);
  assert.equal(proposal.sourceTextRevisionId ?? null, null);
  assert.equal(proposal.sourceTextDependencyToken ?? null, null);
  assert.equal(seedGroupVersion.members.length, 1);
  await buildIntakeCollectionEnvelope(f.db, { id: f.original.id });
  intakeTransaction(
    f.db,
    () => {
      for (let n = 0; n < 256; n++) {
        const id = 'proposal:fictional-artifact-' + n,
          path = firstPath.slice(0, firstPath.lastIndexOf('/') + 1) + 'artifact-' + n + '.jsonl',
          value = n === 255 ? latestRecord : oldRecord,
          bytes = Buffer.from(
            JSON.stringify(value) +
              '\n' +
              (n === 0 ? (' '.repeat(1024 * 1024) + '\n').repeat(8) : ' '.repeat(1024 + n) + '\n'),
          ),
          validation = validationSummary(validateJSONL(bytes));
        assert.equal(validation.valid, true, JSON.stringify(validation.issues));
        writeFileSync(join(proposalDirectory, 'artifact-' + n + '.jsonl'), bytes);
        registerIntakeFile(f.db, {
          id,
          providerId: String(originalFile.provider_id),
          path,
          bytes,
          kind: 'intake_proposal',
          mimeType: 'application/x-ndjson',
          coverage: 'derived_proposal; unreviewed',
          details: { originalSourceFileId: f.original.id, validation },
        });
        // Preserve every required descriptor and its complete real validation;
        // absent optional model/source-pin fields need no copied null entries.
        details.proposals.push({
          id,
          fileId: id,
          summary: 'Fictional retained history',
          createdAt: proposal.createdAt,
          runId: null,
          validation,
          contentUrl: '/api/sources/' + encodeURIComponent(id) + '/content',
        });
        const occurrence = {
          proposalId: id,
          recordId: id + ':line:1',
          batchId: null,
          locator: value.provenance.locator,
        };
        if (n === 255) latestOccurrence = occurrence;
        else occurrences.push(occurrence);
        artifacts.push({
          id,
          path: profileOriginal(f.root, path, f.profileId),
          bytes: bytes.length,
        });
      }
    },
    {},
  );
  assert.ok(latestOccurrence);
  for (let n = 0; n < 192; n++) occurrences.push({ ...occurrences[0]! });
  const historicalVersion = {
      ...seedVersion,
      id: oldVersionId,
      contentDigest: workflowHash(canonicalLiteral(oldRecord)),
      status: 'superseded' as const,
      occurrences,
    },
    latestVersion = {
      ...seedVersion,
      id: latestVersionId,
      contentDigest: workflowHash(canonicalLiteral(latestRecord)),
      status: 'pending' as const,
      occurrences: [latestOccurrence],
    },
    historyCandidate = {
      id: historyCandidateId,
      envelopeId: oldRecord.id,
      sourceSystem: oldRecord.provenance.sourceSystem,
      sourceRecordId: oldRecord.provenance.sourceRecordId,
      versions: [historicalVersion, latestVersion],
    },
    nextMembers = [
      { candidateId: historyCandidateId, candidateVersionId: oldVersionId, occurrences },
      {
        candidateId: historyCandidateId,
        candidateVersionId: latestVersionId,
        occurrences: [latestOccurrence],
      },
      ...seedGroupVersion.members,
    ],
    contributionId = 'fictional-artifact-history-contribution',
    nextGroupVersion = {
      ...seedGroupVersion,
      contributionId,
      id: 'report-group-version:' + workflowHash([group.id, contributionId, nextMembers]),
      members: nextMembers,
    };
  assert.equal(
    f.db.prepare("SELECT count(*) AS count FROM source_files WHERE kind='intake_proposal'").get()!
      .count,
    257,
  );
  assert.equal(new Set(details.proposals.map((value) => value.id)).size, 257);
  const prepared = await prepareIntakeWorkflowCommand(
    f.db,
    { id: f.original.id },
    {
      version: intakeSourceVersion(f.db, f.original.id).version,
      operationId: 'fictional-artifact-history',
      request: {
        proposalIds: details.proposals.slice(1).map((value) => value.id),
        groupVersionId: nextGroupVersion.id,
      },
      createdAt: '2026-01-01T00:00:00Z',
      changes: function* ({ reader, intake, workflow }) {
        const groupRecord = reader.find('reportGroup', workflow, group.id);
        assert.ok(groupRecord);
        for (const descriptor of details.proposals.slice(1))
          yield {
            op: 'append' as const,
            record: intake,
            field: 'proposals',
            jsonText: JSON.stringify(descriptor),
          };
        yield {
          op: 'append' as const,
          record: workflow,
          field: 'candidates',
          jsonText: JSON.stringify(historyCandidate),
        };
        yield {
          op: 'append' as const,
          record: groupRecord,
          field: 'versions',
          jsonText: JSON.stringify(nextGroupVersion),
        };
      },
    },
  );
  if (prepared.replayed) throw Error('Unexpected artifact fixture replay');
  intakeTransaction(
    f.db,
    () => {
      prepared.assertCurrent();
      return selectedEnvelopeStore(f.db, { id: f.original.id }).collections.stage(
        prepared.prepared,
      );
    },
    { operationId: prepared.publicationId, fingerprint: prepared.fingerprint },
  );
  const cold = await f.review();
  assert.ok(cold.scopeReference);
  const stable = await f.review();
  assert.ok(stable.scopeReference);
  assert.equal(nativeIdentityPreviewCounts(f.db).entries, 1);
  assert.equal(stable.scopeReference.collection.membership, 3);
  const membership = await f.request(
    `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${stable.scopeReference.scopeToken}&section=membership&limit=3`,
  );
  assert.equal(membership.total, 3);
  const members: IntakeIdentityScope['membership'] = [];
  for (const [ordinal, item] of membership.items.entries()) {
    if (item.kind === 'value') members.push(item.value);
    else {
      const chunks: Buffer[] = [];
      let offset = 0;
      for (;;) {
        const fragment = await f.request(
          `identity-scope-fragment?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${stable.scopeReference.scopeToken}&section=membership&ordinal=${ordinal}&offset=${offset}`,
        );
        chunks.push(Buffer.from(fragment.data, 'base64'));
        if (fragment.complete) break;
        assert.ok(fragment.nextOffset > offset);
        offset = fragment.nextOffset;
      }
      members.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }
  }
  assert.equal(members.length, 3);
  assert.equal(members[0]!.candidateVersionId, oldVersionId);
  // Count complete native membership by its public retained occurrence pages;
  // do not infer reachability from the setup's in-memory envelope alone.
  assert.equal(members[0]!.occurrences.length, occurrences.length);
  assert.equal(
    members.reduce((total, member) => total + member.occurrences.length, 0),
    449,
  );
  assert.equal(members[1]!.candidateVersionId, latestVersionId);
  assert.equal(members[2]!.candidateVersionId, seedVersion.id);
  assert.deepEqual(
    new Set(members.flatMap((member) => member.occurrences.map((value) => value.proposalId))),
    new Set(details.proposals.map((value) => value.id)),
  );
  const totalBytes = Number(
    f.db
      .prepare(
        "SELECT sum(bytes) AS bytes FROM source_files WHERE kind IN ('intake_original','intake_proposal')",
      )
      .get()!.bytes,
  );
  return {
    ...f,
    artifacts,
    stable,
    totalBytes,
    duplicateEnd: occurrences.length,
    occurrences: occurrences.length + 2,
  };
}

// Genuine 257-file native publication, public warming, cancellation and replacement phases.
// This is a host hang guard, not an interactive latency or model-time target.
test(
  'native warm identity cooperates across 257 retained proposal artifacts and duplicate occurrences',
  { timeout: 450000 },
  async (t) => {
    const f = await artifactHistoryFixture(t),
      scratch = () =>
        readdirSync(tmpdir())
          .filter((name) => name.startsWith('fictional-identity-scope-'))
          .sort(),
      baselineScratch = scratch(),
      before = { ...intakeWorkCounters(f.db).warm },
      fileWork = createIntakeFileWorkCounters();
    let complete = false;
    const warm = withIntakeFileWork(fileWork, () =>
      getNativeIntakeIdentityReview(f.db, f.root, f.profileId, f.original.id, f.groupId),
    );
    void warm.then(
      () => {
        complete = true;
      },
      () => {
        complete = true;
      },
    );
    const waitFor = async (
      ready: () => boolean,
      pending: Promise<unknown>,
      finished: () => boolean,
    ) => {
      while (!ready()) {
        t.signal.throwIfAborted();
        if (finished()) {
          await pending;
          assert.fail('verification completed before the required nested checkpoint');
        }
        await setImmediate();
      }
    };
    try {
      await waitFor(
        () => fileWork.streamHashBytes > 256 * 1024,
        warm,
        () => complete,
      );
      assert.ok(
        fileWork.streamHashBytes < f.artifacts[0]!.bytes,
        'a host turn occurs inside the first retained artifact hash, before its payload completes',
      );
      await waitFor(
        () =>
          intakeWorkCounters(f.db).warm.identityPreviewArtifactOccurrences -
            before.identityPreviewArtifactOccurrences >
          256,
        warm,
        () => complete,
      );
      const notes = await fetch(
        new URL(`/api/profiles/${encodeURIComponent(f.profileId)}/notes`, f.base),
      );
      assert.equal(notes.status, 200);
      assert.ok(Array.isArray((await notes.json()).data));
      assert.equal(
        complete,
        false,
        'same-database HTTP completes during duplicate-skipped verification',
      );
      assert.ok(
        intakeWorkCounters(f.db).warm.identityPreviewArtifactOccurrences -
          before.identityPreviewArtifactOccurrences <
          f.duplicateEnd,
      );
      // HTTP presentation adds the profile prefix; the internal verifier keeps
      // its domain URL. Assert both exact routes and compare every other field.
      const expectedWarm = structuredClone(f.stable);
      assert.ok(expectedWarm.scopeReference);
      assert.equal(
        expectedWarm.scopeReference.original.contentUrl,
        `/api/profiles/${encodeURIComponent(f.profileId)}/sources/${encodeURIComponent(f.original.id)}/content`,
      );
      expectedWarm.scopeReference.original.contentUrl = `/api/sources/${encodeURIComponent(f.original.id)}/content`;
      assert.deepEqual(await warm, expectedWarm);
    } finally {
      await warm.catch(() => undefined);
    }
    const after = intakeWorkCounters(f.db).warm;
    assert.equal(after.identityPreviewFullPreparations, before.identityPreviewFullPreparations);
    assert.equal(
      after.identityPreviewArtifactOccurrences - before.identityPreviewArtifactOccurrences,
      f.occurrences,
    );
    assert.equal(after.identityPreviewArtifactChecks - before.identityPreviewArtifactChecks, 258);
    assert.ok(
      fileWork.streamHashBytes > 0,
      '257 distinct proposals exceed the shared 256-file verification cache',
    );
    assert.equal(fileWork.streamReadBytes, fileWork.streamHashBytes);
    assert.ok(
      fileWork.streamHashBytes <= f.totalBytes,
      'final physical proof never rehashes the already verified payloads',
    );
    assert.deepEqual(scratch(), baselineScratch);
    assert.deepEqual(reviewIssueScratchCounts(f.db), { databases: 0, scopes: 0, rows: 0 });
    t.diagnostic(JSON.stringify({ artifacts: 257, occurrences: f.occurrences, fileWork }));

    // Abort the sole HTTP subscriber inside actual verification, then wait for
    // the next owner to prove abandoned scratch and work are completely drained.
    const controller = new AbortController(),
      cancelBefore = { ...intakeWorkCounters(f.db).warm };
    let cancelComplete = false;
    const cancelled = fetch(f.base + 'identity-review?groupId=' + encodeURIComponent(f.groupId), {
      signal: controller.signal,
    });
    void cancelled.then(
      () => {
        cancelComplete = true;
      },
      () => {
        cancelComplete = true;
      },
    );
    const refused = assert.rejects(cancelled, { name: 'AbortError' });
    await waitFor(
      () =>
        intakeWorkCounters(f.db).warm.identityPreviewArtifactOccurrences -
          cancelBefore.identityPreviewArtifactOccurrences >=
        32,
      cancelled,
      () => cancelComplete,
    );
    controller.abort();
    await refused;
    await runExclusiveClinicalOperation(f.db, async () => undefined);
    const stopped = { ...intakeWorkCounters(f.db).warm };
    for (let n = 0; n < 4; n++) await setImmediate();
    assert.equal(
      intakeWorkCounters(f.db).warm.identityPreviewArtifactOccurrences,
      stopped.identityPreviewArtifactOccurrences,
    );
    assert.ok(
      stopped.identityPreviewArtifactOccurrences - cancelBefore.identityPreviewArtifactOccurrences <
        f.occurrences,
      'last-subscriber cancellation interrupts unfinished verification',
    );
    assert.equal(
      stopped.identityPreviewFullPreparations,
      cancelBefore.identityPreviewFullPreparations,
    );
    assert.equal(
      stopped.reportSnapshotCheckpointChanges,
      cancelBefore.reportSnapshotCheckpointChanges,
    );
    assert.deepEqual(scratch(), baselineScratch);
    assert.deepEqual(reviewIssueScratchCounts(f.db), { databases: 0, scopes: 0, rows: 0 });

    // Replace a verified earlier artifact with identical bytes while later
    // artifacts yield. A forbidden rehash/new baseline would accept its digest;
    // only the original physical identity proves this replacement must refuse.
    assert.equal(nativeIdentityPreviewCounts(f.db).entries, 1);
    const physicalBefore = { ...intakeWorkCounters(f.db).warm },
      stamp = reviewReadStamp(f.db),
      originalBytes = readFileSync(f.artifacts[0]!.path),
      originalIdentity = intakeFileIdentity(f.artifacts[0]!.path),
      displacedPath = f.artifacts[0]!.path + '.before-replacement',
      replacementPath = f.artifacts[0]!.path + '.replacement';
    let displaced = false;
    let physicalComplete = false;
    const changed = f.request(
      'identity-review?groupId=' + encodeURIComponent(f.groupId),
      undefined,
      409,
    );
    void changed.then(
      () => {
        physicalComplete = true;
      },
      () => {
        physicalComplete = true;
      },
    );
    try {
      await waitFor(
        () =>
          intakeWorkCounters(f.db).warm.identityPreviewArtifactChecks -
            physicalBefore.identityPreviewArtifactChecks >=
          32,
        changed,
        () => physicalComplete,
      );
      writeFileSync(replacementPath, originalBytes);
      renameSync(f.artifacts[0]!.path, displacedPath);
      displaced = true;
      renameSync(replacementPath, f.artifacts[0]!.path);
      assert.notEqual(intakeFileIdentity(f.artifacts[0]!.path), originalIdentity);
      assert.deepEqual(readFileSync(f.artifacts[0]!.path), originalBytes);
      assert.equal(reviewReadStamp(f.db), stamp);
      assert.equal((await changed).error.code, 'SOURCE_CHANGED');
      assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
      assert.deepEqual(scratch(), baselineScratch);
      assert.deepEqual(reviewIssueScratchCounts(f.db), { databases: 0, scopes: 0, rows: 0 });
    } finally {
      await changed.catch(() => undefined);
      if (displaced) renameSync(displacedPath, f.artifacts[0]!.path);
    }
  },
);
