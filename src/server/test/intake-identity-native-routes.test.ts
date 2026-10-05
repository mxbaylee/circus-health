import { intakeSourceVersion } from '../intake-state-access.ts';
import { canonicalLiteral } from '../intake-format.ts';
import { setImmediate } from 'node:timers/promises';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { getNativeIntakeIdentityReview } from '../intake-identity-native.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { profileOriginal, ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability, rebuildProfile } from '../portable.ts';
import { createBackup } from '../recovery.ts';
import { getRetainedIntakeOriginalReference, intakeTransaction } from '../intake.ts';
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
import { readQualificationReview } from '../../scripts/qualification-intake-read.ts';
import type { IntakeReportGroup } from '../../shared/intake.ts';
import type { IntakeReportGroupVersionV2 } from '../../shared/intake-report-version.ts';
import type {
  IntakeIdentityConfirmation,
  IntakeIdentityScope,
} from '../../shared/intake-identity.ts';
import {
  fixture,
  envelope,
  heading,
  subject,
  birthDate,
} from './intake-identity-native-fixture.ts';

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
      report: {
        ...original.report!,
        subject: { ...original.report!.subject!, text },
      },
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
      {
        operationId: prepared.publicationId,
        fingerprint: prepared.fingerprint,
      },
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
      assert.deepEqual(review.offeredSelfFields, {
        fullName: 'Fictional Iris Meadow',
        birthDate,
      });
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
        selfUpdate: {
          expectedVersion: review.self.version,
          fields: review.offeredSelfFields,
        },
      };
      await f.request(
        'identity-scope',
        {
          ...input,
          selfUpdate: {
            ...input.selfUpdate,
            expectedVersion: review.self.version + 1,
          },
        },
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
    const valid = {
      ...input,
      version: freshScope.intakeVersion,
      scope: freshScope,
    };
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
        newPerson: {
          fullName: 'Fictional Iris Meadow',
          relationship: 'relative',
        },
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
            selfSuggestion: {
              fullName: 'Fictional Iris Meadow',
              birthDate: date,
            },
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
    assert.deepEqual(reviewIssueScratchCounts(f.db), {
      databases: 0,
      scopes: 0,
      rows: 0,
    });
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
    assert.deepEqual(reviewIssueScratchCounts(f.db), {
      databases: 0,
      scopes: 0,
      rows: 0,
    });
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
    assert.deepEqual(reviewIssueScratchCounts(f.db), {
      databases: 0,
      scopes: 0,
      rows: 0,
    });
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

// This is a real server-generated old/fresh native protocol comparison, rather
// than a mocked review with a constant snapshot ID. No provider request is made.
test(
  'actual native version-only progress preserves complete evidence and retries one unchanged identity action',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    const hostDisplayed = await getNativeIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.original.id,
      f.groupId,
    );
    const displayed = await f.review(),
      old = displayed.scopeReference!;
    assert.ok(old);
    assert.ok(displayed.evidenceCommitment);
    const before = { ...intakeWorkCounters(f.db).warm };
    const catalog = createReportSnapshotCatalog(
      f.db,
      { id: f.original.id },
      {
        catalog: 'report.snapshots',
        catalogArea: 'builds',
      },
    );
    const snapshot = catalog.open(old.collection.snapshotId)!;
    const oldScopeBytes = [...snapshot.chunks('$scope')].join('');
    // HTTP profile routing rewrites presentation URLs; persisted bytes retain
    // the complete host reference. Compare it exactly, without dropping fields.
    assert.equal(oldScopeBytes, JSON.stringify(hostDisplayed.scopeReference));
    const hostScope = hostDisplayed.scopeReference!;
    assert.deepEqual(old, {
      ...hostScope,
      original: {
        ...hostScope.original,
        contentUrl:
          '/api/profiles/' + f.profileId + hostScope.original.contentUrl.slice('/api'.length),
      },
    });
    assert.deepEqual(displayed.evidenceCommitment, hostDisplayed.evidenceCommitment);
    assert.equal(
      oldScopeBytes.includes('evidenceCommitment'),
      false,
      'a historical snapshot remains byte-identical and needs no proof-field migration',
    );
    clearNativeIdentityPreviews(f.db);
    const reused = await f.review();
    assert.deepEqual(reused.scopeReference, old);
    assert.deepEqual(reused.evidenceCommitment, displayed.evidenceCommitment);
    assert.equal([...snapshot.chunks('$scope')].join(''), oldScopeBytes);
    assert.equal(
      intakeWorkCounters(f.db).warm.identitySnapshotWarningHashBytes -
        before.identitySnapshotWarningHashBytes,
      0,
      'inline current warnings do not reread the legacy warning snapshot',
    );
    assert.equal(
      intakeWorkCounters(f.db).warm.identitySnapshotWarningReadBytes -
        before.identitySnapshotWarningReadBytes,
      0,
    );

    const prepared = await prepareIntakeWorkflowCommand(
      f.db,
      { id: f.original.id },
      {
        version: old.intakeVersion,
        operationId: 'fictional-unrelated-progress',
        request: { progress: 'independently fictional unrelated progress' },
        createdAt: '2026-01-01T00:00:00Z',
        *changes() {},
      },
    );
    if (prepared.replayed) throw Error('Unexpected fixture replay');
    intakeTransaction(
      f.db,
      () => selectedEnvelopeStore(f.db, { id: f.original.id }).collections.stage(prepared.prepared),
      {
        operationId: prepared.publicationId,
        fingerprint: prepared.fingerprint,
      },
    );
    clearNativeIdentityPreviews(f.db);
    const versionOnlyBefore = { ...intakeWorkCounters(f.db).warm };
    const fresh = await f.review(),
      next = fresh.scopeReference!;
    t.diagnostic(
      JSON.stringify({
        versionOnlyScopeWork: {
          scopeMembers: next.collection.membership,
          desiredRows:
            intakeWorkCounters(f.db).warm.identitySnapshotDeltaDesiredRows -
            versionOnlyBefore.identitySnapshotDeltaDesiredRows,
          aliasHits:
            intakeWorkCounters(f.db).warm.identitySnapshotAliasHits -
            versionOnlyBefore.identitySnapshotAliasHits,
          checkpointChanges:
            intakeWorkCounters(f.db).warm.reportSnapshotCheckpointChanges -
            versionOnlyBefore.reportSnapshotCheckpointChanges,
          treeNodesWritten:
            intakeWorkCounters(f.db).warm.collectionNodesWritten -
            versionOnlyBefore.collectionNodesWritten,
          logicalTreeBytesWritten:
            intakeWorkCounters(f.db).warm.collectionWrittenBytes -
            versionOnlyBefore.collectionWrittenBytes,
        },
      }),
    );
    assert.equal(
      intakeWorkCounters(f.db).warm.identitySnapshotDeltaDesiredRows -
        versionOnlyBefore.identitySnapshotDeltaDesiredRows,
      0,
      'unchanged complete scope does not repopulate desired rows',
    );
    assert.equal(
      intakeWorkCounters(f.db).warm.identitySnapshotAliasHits -
        versionOnlyBefore.identitySnapshotAliasHits,
      1,
    );
    assert.equal(next.intakeVersion, old.intakeVersion + 1);
    assert.notEqual(next.scopeToken, old.scopeToken);
    assert.notEqual(next.collection.snapshotId, old.collection.snapshotId);
    assert.deepEqual(fresh.evidenceCommitment, displayed.evidenceCommitment);
    const { confirmIdentityWithFreshness, sameDisplayedIdentityReview } =
      await import('../../app/data/identity-confirmation-freshness.ts');
    assert.equal(sameDisplayedIdentityReview(displayed, fresh), true);
    assert.equal(
      sameDisplayedIdentityReview({ ...displayed, evidenceCommitment: undefined }, fresh),
      false,
    );
    const {
      intakeVersion: _oldVersion,
      scopeToken: _oldToken,
      collection: oldCollection,
      ...oldBoundary
    } = old;
    const {
      intakeVersion: _nextVersion,
      scopeToken: _nextToken,
      collection: nextCollection,
      ...nextBoundary
    } = next;
    assert.deepEqual(nextBoundary, oldBoundary);
    const { snapshotId: _oldSnapshot, ...oldCounts } = oldCollection;
    const { snapshotId: _nextSnapshot, ...nextCounts } = nextCollection;
    assert.deepEqual(nextCounts, oldCounts);
    const command: IntakeIdentityConfirmation = {
      version: old.intakeVersion,
      operationId: 'fictional-native-freshness-confirm',
      scope: old,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_identity_questions',
      selfUpdate: {
        expectedVersion: displayed.self.version,
        fields: displayed.offeredSelfFields,
      },
    };
    const sent: IntakeIdentityConfirmation[] = [],
      statuses: number[] = [];
    let reads = 0;
    const outcome = await confirmIdentityWithFreshness({
      displayed,
      request: command,
      send: async (input) => {
        sent.push(structuredClone(input));
        const response = await fetch(f.base + 'identity-scope', {
          method: 'POST',
          headers: {
            origin: 'http://127.0.0.1:5173',
            'content-type': 'application/json',
          },
          body: JSON.stringify(input),
        });
        statuses.push(response.status);
        const body = await response.json();
        if (!response.ok)
          throw Object.assign(new Error(body.error?.message || 'Fictional identity failure'), {
            status: response.status,
            code: body.error?.code || body.code,
          });
        return body.data;
      },
      loadFresh: async () => {
        reads++;
        return f.review();
      },
      isContextCurrent: () => true,
      retainRequest: () => {},
    });
    assert.equal(outcome.status, 'confirmed');
    assert.deepEqual(statuses, [409, 200]);
    assert.equal(reads, 1);
    assert.deepEqual(sent, [command, { ...command, version: next.intakeVersion, scope: next }]);
    assert.equal((await f.review()).confirmationCount, 1);
    const self = getNote(f.db, 'person-note:self');
    assert.equal(self.person.fullName, 'Fictional Iris Meadow');
    assert.equal(self.person.birthDate, birthDate);
    const selfVersion = self.version;
    await f.request('identity-scope', sent[1]);
    assert.equal((await f.review()).confirmationCount, 1);
    assert.equal(getNote(f.db, 'person-note:self').version, selfVersion);
  },
);

// Current overflow warnings get their own content-bound snapshot while the
// base scope stays byte-identical across an unrelated non-Self profile edit.
test(
  'actual native same-token warning changes preserve current pages, old references and bounded content reuse',
  { timeout: 240000 },
  async (t) => {
    const warningCount = 101;
    const f = await fixture(
      t,
      true,
      1,
      false,
      () => {
        const record = envelope('fictional-overflow-warning');
        const issues = Array.from({ length: warningCount }, (_, n) => {
          const date = String(1800 + n) + '-01-01';
          return {
            id: 'fictional-model-birth-date-' + n,
            kind: 'identity' as const,
            field: 'subject',
            prompt: 'Does this report belong to you?',
            textAnchor: subject + ' DOB: ' + date,
            selfSuggestion: {
              fullName: 'Fictional Iris Meadow',
              birthDate: date,
            },
          };
        });
        // Each model-only hint must be grounded in its own model transcription
        // anchor. The separately retained original deliberately has no DOB.
        record.reviewIssues = issues;
        record.payload = {
          text: issues.map((issue) => issue.textAnchor).join('\n'),
        };
        return record;
      },
      `${heading}\n${subject}\nFictional result`,
      true,
    );
    const { createNote } = await import('../notes.ts');
    const person = createNote(f.db, {
      kind: 'person',
      title: 'Fictional Iris Meadow',
      person: { fullName: 'Fictional Iris Meadow', birthDate: '1990-03-08' },
    });
    const hostBaseReview = await getNativeIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.original.id,
      f.groupId,
    );
    const old = await f.review(),
      baseScope = old.scopeReference!,
      oldWarning = old.warningsReference!;
    assert.ok(baseScope);
    assert.equal(hostBaseReview.warningsReference?.count, warningCount);
    assert.equal(oldWarning.format, 'health-intake-identity-warnings-v2');
    assert.equal(oldWarning.count, warningCount);
    const page = (snapshotId: string, cursor?: string) =>
      f.request(
        `identity-scope-page?${new URLSearchParams({
          groupId: f.groupId,
          scopeToken: baseScope.scopeToken,
          section: 'warnings',
          snapshotId,
          limit: '1',
          ...(cursor ? { cursor } : {}),
        })}`,
      );
    const oldPage = await page(oldWarning.snapshotId);
    assert.equal(oldPage.snapshotId, oldWarning.snapshotId);
    assert.equal(oldPage.items[0].value.savedBirthDate, '1990-03-08');
    assert.ok(oldPage.nextCursor);
    const baseline = { ...intakeWorkCounters(f.db).warm };
    clearNativeIdentityPreviews(f.db);
    assert.deepEqual((await f.review()).warningsReference, oldWarning);
    assert.equal(
      intakeWorkCounters(f.db).warm.identityWarningContentWrittenRows -
        baseline.identityWarningContentWrittenRows,
      0,
    );
    assert.equal(
      intakeWorkCounters(f.db).warm.identityWarningBindingsWritten -
        baseline.identityWarningBindingsWritten,
      0,
    );
    assert.ok(
      intakeWorkCounters(f.db).warm.identitySnapshotWarningReadBytes >
        baseline.identitySnapshotWarningReadBytes,
      'reuse verifies actual retained content before emitting a complete proof',
    );

    saveNote(f.db, person.id, {
      version: person.version,
      person: { ...person.person, birthDate: '1991-03-08' },
    });
    clearNativeIdentityPreviews(f.db);
    const fresh = await f.review(),
      nextWarning = fresh.warningsReference!;
    assert.deepEqual(
      fresh.scopeReference,
      baseScope,
      'profile-only warning drift does not rewrite scope/receipt authority',
    );
    assert.equal(nextWarning.count, oldWarning.count);
    assert.notEqual(nextWarning.snapshotId, oldWarning.snapshotId);
    assert.notDeepEqual(fresh.evidenceCommitment, old.evidenceCommitment);
    const freshPage = await page(nextWarning.snapshotId);
    assert.equal(freshPage.items[0].value.savedBirthDate, '1991-03-08');
    assert.equal((await page(oldWarning.snapshotId)).items[0].value.savedBirthDate, '1990-03-08');
    await f.request(
      `identity-scope-page?${new URLSearchParams({
        groupId: f.groupId,
        scopeToken: baseScope.scopeToken,
        section: 'warnings',
        snapshotId: nextWarning.snapshotId,
        limit: '1',
        cursor: oldPage.nextCursor,
      })}`,
      undefined,
      409,
    );
    await f.request(
      `identity-scope-page?${new URLSearchParams({
        groupId: f.groupId,
        scopeToken: baseScope.scopeToken,
        section: 'targets',
        snapshotId: nextWarning.snapshotId,
      })}`,
      undefined,
      400,
    );
    await f.request(
      `identity-scope-page?${new URLSearchParams({
        groupId: f.groupId,
        scopeToken: baseScope.scopeToken,
        section: 'warnings',
        snapshotId: nextWarning.snapshotId.replace(baseScope.scopeToken, 'f'.repeat(64)),
      })}`,
      undefined,
      409,
    );
    const fragment = await f.request(
      `identity-scope-fragment?${new URLSearchParams({
        groupId: f.groupId,
        scopeToken: baseScope.scopeToken,
        section: 'warnings',
        snapshotId: nextWarning.snapshotId,
        ordinal: '0',
      })}`,
    );
    assert.equal(
      JSON.parse(Buffer.from(fragment.data, 'base64').toString()).savedBirthDate,
      '1991-03-08',
    );
    const { sameDisplayedIdentityReview } =
      await import('../../app/data/identity-confirmation-freshness.ts');
    assert.equal(
      sameDisplayedIdentityReview(old, fresh),
      false,
      'same counts and scope cannot conceal changed warnings',
    );

    const backup = await createBackup(f.db, f.root, f.profileId),
      recoveryRoot = join(f.root, 'warning-recovery');
    const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, recoveryRoot);
    const recovered = openDatabase(rebuilt.database, f.profileId);
    attachPersonalDurability(recovered, {
      root: recoveryRoot,
      profileId: f.profileId,
      initialize: false,
    });
    try {
      const { getNativeIntakeIdentityReview, readNativeIdentityScopePage } =
        await import('../intake-identity-native.ts');
      const recoveredReview = await getNativeIntakeIdentityReview(
        recovered,
        recoveryRoot,
        f.profileId,
        f.original.id,
        f.groupId,
      );
      assert.deepEqual(recoveredReview.scopeReference, hostBaseReview.scopeReference);
      assert.deepEqual(recoveredReview.warningsReference, nextWarning);
      assert.deepEqual(recoveredReview.evidenceCommitment, fresh.evidenceCommitment);
      const recoveredCurrent = await readNativeIdentityScopePage(
        recovered,
        recoveryRoot,
        f.profileId,
        f.original.id,
        f.groupId,
        {
          scopeToken: baseScope.scopeToken,
          section: 'warnings',
          snapshotId: nextWarning.snapshotId,
          limit: 1,
        },
      );
      const recoveredOld = await readNativeIdentityScopePage(
        recovered,
        recoveryRoot,
        f.profileId,
        f.original.id,
        f.groupId,
        {
          scopeToken: baseScope.scopeToken,
          section: 'warnings',
          snapshotId: oldWarning.snapshotId,
          limit: 1,
        },
      );
      assert.equal(
        (
          recoveredCurrent.items[0] as {
            kind: 'value';
            value: { savedBirthDate: string };
          }
        ).value.savedBirthDate,
        '1991-03-08',
      );
      assert.equal(
        (
          recoveredOld.items[0] as {
            kind: 'value';
            value: { savedBirthDate: string };
          }
        ).value.savedBirthDate,
        '1990-03-08',
      );
    } finally {
      recovered.close();
    }

    const beforeProgress = { ...intakeWorkCounters(f.db).warm };
    const prepared = await prepareIntakeWorkflowCommand(
      f.db,
      { id: f.original.id },
      {
        version: baseScope.intakeVersion,
        operationId: 'fictional-warning-only-progress',
        request: { progress: 'unrelated' },
        createdAt: '2026-01-01T00:00:00Z',
        *changes() {},
      },
    );
    if (prepared.replayed) throw Error('Unexpected fixture replay');
    intakeTransaction(
      f.db,
      () => selectedEnvelopeStore(f.db, { id: f.original.id }).collections.stage(prepared.prepared),
      {
        operationId: prepared.publicationId,
        fingerprint: prepared.fingerprint,
      },
    );
    clearNativeIdentityPreviews(f.db);
    const progressed = await f.review();
    assert.notEqual(progressed.scopeReference!.scopeToken, baseScope.scopeToken);
    assert.deepEqual(progressed.evidenceCommitment, fresh.evidenceCommitment);
    assert.equal(sameDisplayedIdentityReview(fresh, progressed), true);
    assert.equal(
      intakeWorkCounters(f.db).warm.identityWarningContentWrittenRows -
        beforeProgress.identityWarningContentWrittenRows,
      0,
      'global version progress shares unchanged warning payload',
    );
    assert.equal(
      intakeWorkCounters(f.db).warm.identityWarningBindingsWritten -
        beforeProgress.identityWarningBindingsWritten,
      1,
      'only one small scope/content binding is published',
    );
    t.diagnostic(
      JSON.stringify({
        versionOnlyWarningWork: {
          scopeCollection: progressed.scopeReference!.collection,
          desiredRows:
            intakeWorkCounters(f.db).warm.identitySnapshotDeltaDesiredRows -
            beforeProgress.identitySnapshotDeltaDesiredRows,
          aliasHits:
            intakeWorkCounters(f.db).warm.identitySnapshotAliasHits -
            beforeProgress.identitySnapshotAliasHits,
          warningRowsPublished:
            intakeWorkCounters(f.db).warm.identityWarningContentWrittenRows -
            beforeProgress.identityWarningContentWrittenRows,
          warningPayloadBytesPublished:
            intakeWorkCounters(f.db).warm.identityWarningContentWrittenBytes -
            beforeProgress.identityWarningContentWrittenBytes,
          checkpointChanges:
            intakeWorkCounters(f.db).warm.reportSnapshotCheckpointChanges -
            beforeProgress.reportSnapshotCheckpointChanges,
          bindingPublications:
            intakeWorkCounters(f.db).warm.identityWarningBindingsWritten -
            beforeProgress.identityWarningBindingsWritten,
          treeNodesWritten:
            intakeWorkCounters(f.db).warm.collectionNodesWritten -
            beforeProgress.collectionNodesWritten,
          logicalTreeBytesWritten:
            intakeWorkCounters(f.db).warm.collectionWrittenBytes -
            beforeProgress.collectionWrittenBytes,
        },
      }),
    );
    assert.equal(
      intakeWorkCounters(f.db).warm.identitySnapshotDeltaDesiredRows -
        beforeProgress.identitySnapshotDeltaDesiredRows,
      0,
      'complete unchanged hidden issue scope is not rebuilt',
    );
    assert.equal(
      intakeWorkCounters(f.db).warm.identitySnapshotAliasHits -
        beforeProgress.identitySnapshotAliasHits,
      1,
    );
    const input: IntakeIdentityConfirmation = {
      version: progressed.scopeReference!.intakeVersion,
      operationId: 'fictional-warning-ordinary-correction',
      scope: progressed.scopeReference!,
      outcome: 'this_is_person',
      attestation: 'confirmed_displayed_identity_questions',
      personSelection: {
        noteId: person.id,
        expectedVersion: getNote(f.db, person.id).version,
      },
    };
    t.diagnostic(JSON.stringify({ phase: 'ordinary-correction-post-start' }));
    await f.request('identity-scope', input);
    t.diagnostic(JSON.stringify({ phase: 'ordinary-correction-post-complete' }));
    t.diagnostic(JSON.stringify({ phase: 'ordinary-correction-follow-up-start' }));
    const correctedReview = await f.review();
    t.diagnostic(JSON.stringify({ phase: 'ordinary-correction-follow-up-complete' }));
    assert.equal(
      correctedReview.confirmationCount,
      1,
      'ordinary correction remains usable after current warning drift',
    );
  },
);

test(
  'actual native non-Self DOB edit changes warning evidence without changing the scope token',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(
      t,
      true,
      1,
      false,
      () => {
        const record = envelope('fictional-non-self-warning');
        const date = '1971-01-01',
          textAnchor = subject + ' DOB: ' + date;
        record.payload = { text: textAnchor };
        record.reviewIssues = [
          {
            kind: 'identity',
            field: 'subject',
            prompt: 'Does this report belong to you?',
            textAnchor,
            selfSuggestion: {
              fullName: 'Fictional Iris Meadow',
              birthDate: date,
            },
          },
        ];
        return record;
      },
      `${heading}\n${subject}\nFictional result`,
      true,
    );
    const { createNote } = await import('../notes.ts');
    const person = createNote(f.db, {
      kind: 'person',
      title: 'Fictional Iris Meadow',
      person: { fullName: 'Fictional Iris Meadow', birthDate: '1990-03-08' },
    });
    const old = await f.review();
    assert.equal(old.warnings?.length, 1);
    assert.equal(old.warnings![0]!.savedBirthDate, '1990-03-08');
    const baseScope = old.scopeReference!;
    saveNote(f.db, person.id, {
      version: person.version,
      person: { ...person.person, birthDate: '1991-03-08' },
    });
    clearNativeIdentityPreviews(f.db);
    const fresh = await f.review();
    assert.ok(fresh.scopeReference, 'ordinary identity review remains usable');
    assert.equal(fresh.scopeReference.scopeToken, baseScope.scopeToken);
    assert.deepEqual(fresh.scopeReference, baseScope, 'base scope/receipt bytes remain identical');
    assert.equal(fresh.warnings?.length, 1);
    assert.equal(
      fresh.warnings![0]!.savedBirthDate,
      '1991-03-08',
      'inline warning is current selected evidence',
    );
    const legacy = await f.request(
      `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${baseScope.scopeToken}&section=warnings&limit=1`,
    );
    assert.equal(
      legacy.items[0].value.savedBirthDate,
      '1990-03-08',
      'legacy no-selector immutable snapshot stays readable',
    );
    t.diagnostic(
      JSON.stringify({
        sameScopeToken: fresh.scopeReference.scopeToken === baseScope.scopeToken,
        oldWarningDate: old.warnings![0]!.savedBirthDate,
        freshWarningDate: fresh.warnings![0]!.savedBirthDate,
        retainedLegacyWarningDate: legacy.items[0].value.savedBirthDate,
      }),
    );
  },
);

// Actual retained catalog and HTTP fragment routing qualify arbitrary bounded
// warning chunk boundaries, including a long item beyond both inline budgets.
test(
  'actual identity warning sidecar reconstructs oversized fragments and refuses missing or changed content',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t, true, 1, false, undefined, undefined, true);
    const review = await f.review(),
      scope = review.scopeReference!;
    const warnings = [
      {
        kind: 'model_birth_date_mismatch',
        modelBirthDate: '1971-01-01',
        savedBirthDate: '1990-03-08',
        personName: 'Fictional ' + '🌿\\'.repeat(20000),
      },
      {
        kind: 'model_birth_date_mismatch',
        modelBirthDate: '1972-01-01',
        savedBirthDate: '1990-03-08',
        personName: 'Fictional Short Person',
      },
    ];
    const { createHash, randomUUID } = await import('node:crypto');
    const digest = createHash('sha256').update(canonicalLiteral(warnings)).digest('hex');
    const { retainIdentityWarningsSnapshot } =
      await import('../intake-identity-warnings-snapshot.ts');
    const reference = await runExclusiveClinicalOperation(f.db, async () => {
      const catalog = createReportSnapshotCatalog(
        f.db,
        { id: f.original.id },
        { catalog: 'report.snapshots', catalogArea: 'builds' },
      );
      const rows = warnings.map((value) => ({
        chunks: function* () {
          const text = canonicalLiteral(value);
          // Surrogate pairs and JSON escapes cross the prepared chunk boundaries.
          for (let at = 0; at < text.length; at += 19) yield text.slice(at, at + 19);
        },
      }));
      const result = await retainIdentityWarningsSnapshot({
        db: f.db,
        catalog,
        scope,
        digest,
        count: 2,
        rows,
        run: async (work) => {
          let result = work.next();
          while (!result.done) result = work.next();
          return result.value;
        },
      });
      const changes = await catalog.finalChanges(),
        collections = selectedEnvelopeStore(f.db, {
          id: f.original.id,
        }).collections;
      collections.commitMaintenance(
        collections.prepare(collections.openView(), {
          operationId: randomUUID(),
          requestDigest: digest,
          domainVersion: intakeSourceVersion(f.db, f.original.id).rawVersion,
          changes,
        }),
      );
      return result;
    });
    const pageByteReads = intakeWorkCounters(f.db).warm.collectionByteChunkReads;
    const page = await f.request(
      `identity-scope-page?${new URLSearchParams({
        groupId: f.groupId,
        scopeToken: scope.scopeToken,
        section: 'warnings',
        snapshotId: reference.snapshotId,
        limit: '1',
      })}`,
    );
    assert.equal(
      intakeWorkCounters(f.db).warm.collectionByteChunkReads - pageByteReads,
      0,
      'reference sizing does not drain warning byte leaves',
    );
    assert.equal(page.total, 2);
    assert.equal(page.items[0].kind, 'reference');
    assert.equal(page.items[0].reference.snapshotId, reference.snapshotId);
    assert.ok(page.nextCursor);
    const pieces: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const fragment = await f.request(
        `identity-scope-fragment?${new URLSearchParams({
          groupId: f.groupId,
          scopeToken: scope.scopeToken,
          section: 'warnings',
          snapshotId: reference.snapshotId,
          ordinal: '0',
          offset: String(offset),
        })}`,
      );
      const bytes = Buffer.from(fragment.data, 'base64');
      assert.ok(bytes.length <= 32768);
      pieces.push(bytes);
      if (fragment.complete) {
        assert.equal(fragment.nextOffset, null);
        break;
      }
      assert.ok(fragment.nextOffset > offset);
      offset = fragment.nextOffset;
    }
    assert.deepEqual(JSON.parse(Buffer.concat(pieces).toString()), warnings[0]);
    const expectedBytes = Buffer.from(canonicalLiteral(warnings[0]));
    const requestFragment = (parameters: Record<string, string>, status = 200) =>
      f.request(
        'identity-scope-fragment?' +
          new URLSearchParams({
            groupId: f.groupId,
            scopeToken: scope.scopeToken,
            section: 'warnings',
            snapshotId: reference.snapshotId,
            ordinal: '0',
            ...parameters,
          }),
        undefined,
        status,
      );
    const boundCatalog = createReportSnapshotCatalog(
      f.db,
      { id: f.original.id },
      { catalogArea: 'builds' },
    );
    const warningBytes = boundCatalog
      .open(reference.snapshotId)!
      .reference('$warnings')!
      .get('warnings:0000000000000000');
    assert.ok(warningBytes && typeof warningBytes !== 'string');
    const beforeSequentialReads = intakeWorkCounters(f.db).warm.collectionByteChunkReads;
    const sequential: Buffer[] = [];
    let cursor = 'start',
      cursorOffset = 0,
      firstCursor = '',
      firstOffset = 0;
    for (;;) {
      const fragment = await requestFragment({
        offset: String(cursorOffset),
        cursor,
      });
      const bytes = Buffer.from(fragment.data, 'base64');
      sequential.push(bytes);
      assert.deepEqual(bytes, expectedBytes.subarray(cursorOffset, cursorOffset + bytes.length));
      if (fragment.complete) {
        assert.equal(fragment.nextOffset, null);
        assert.equal(fragment.nextCursor, null);
        break;
      }
      assert.equal(fragment.nextOffset, cursorOffset + bytes.length);
      assert.ok(typeof fragment.nextCursor === 'string' && fragment.nextCursor.length > 0);
      cursorOffset = fragment.nextOffset;
      cursor = fragment.nextCursor;
      if (!firstCursor) {
        firstCursor = cursor;
        firstOffset = cursorOffset;
      }
    }
    assert.deepEqual(Buffer.concat(sequential), expectedBytes);
    const sequentialLeafReads =
      intakeWorkCounters(f.db).warm.collectionByteChunkReads - beforeSequentialReads;
    assert.ok(
      sequentialLeafReads <= warningBytes.chunks + sequential.length * 8,
      JSON.stringify({
        sequentialLeafReads,
        leaves: warningBytes.chunks,
        pages: sequential.length,
      }),
    );
    // Numeric compatibility still slices exact bytes, including within UTF-8.
    const leaf = expectedBytes.indexOf(Buffer.from('🌿'));
    for (const at of [1, leaf + 1, 32767, expectedBytes.length - 1, expectedBytes.length]) {
      const fragment = await requestFragment({ offset: String(at) });
      assert.deepEqual(
        Buffer.from(fragment.data, 'base64'),
        expectedBytes.subarray(at, at + 32768),
      );
      assert.equal(
        fragment.complete,
        at + Buffer.from(fragment.data, 'base64').length === expectedBytes.length,
      );
    }
    await requestFragment(
      {
        offset: String(firstOffset),
        cursor: firstCursor.slice(0, -1) + (firstCursor.endsWith('0') ? '1' : '0'),
      },
      409,
    );
    await requestFragment({ offset: String(firstOffset + 1), cursor: firstCursor }, 409);
    await requestFragment({ offset: String(firstOffset), cursor: firstCursor, ordinal: '1' }, 409);
    await requestFragment({ offset: String(firstOffset), cursor: 'start' }, 409);
    await requestFragment({ offset: '0', cursor: '' }, 409);
    clearNativeIdentityPreviews(f.db);
    await requestFragment({ offset: String(firstOffset), cursor: firstCursor }, 409);
    const restarted = await requestFragment({ offset: '0', cursor: 'start' });
    assert.deepEqual(Buffer.from(restarted.data, 'base64'), expectedBytes.subarray(0, 32768));

    const next = await f.request(
      `identity-scope-page?${new URLSearchParams({
        groupId: f.groupId,
        scopeToken: scope.scopeToken,
        section: 'warnings',
        snapshotId: reference.snapshotId,
        limit: '1',
        cursor: page.nextCursor,
      })}`,
    );
    assert.deepEqual(next.items[0].value, warnings[1]);
    await f.request(
      `identity-scope-fragment?${new URLSearchParams({
        groupId: f.groupId,
        scopeToken: scope.scopeToken,
        section: 'warnings',
        snapshotId: reference.snapshotId.replace(scope.scopeToken, 'e'.repeat(64)),
        ordinal: '0',
      })}`,
      undefined,
      409,
    );
    await f.request(
      `identity-scope-fragment?${new URLSearchParams({
        groupId: f.groupId,
        scopeToken: scope.scopeToken,
        section: 'warnings',
        snapshotId: reference.snapshotId,
        ordinal: '2',
      })}`,
      undefined,
      400,
    );
    const reused = await runExclusiveClinicalOperation(f.db, async () => {
      const catalog = createReportSnapshotCatalog(
        f.db,
        { id: f.original.id },
        { catalog: 'report.snapshots', catalogArea: 'builds' },
      );
      return retainIdentityWarningsSnapshot({
        db: f.db,
        catalog,
        scope,
        digest,
        count: 2,
        rows: {
          [Symbol.iterator]() {
            throw Error('Unchanged retained warnings must not be recopied');
          },
        },
        run: async (work) => {
          let result = work.next();
          while (!result.done) result = work.next();
          return result.value;
        },
      });
    });
    assert.deepEqual(reused, reference);
    const { openIdentityWarningsSnapshot } =
      await import('../intake-identity-warnings-snapshot.ts');
    const catalog = createReportSnapshotCatalog(
      f.db,
      { id: f.original.id },
      { catalog: 'report.snapshots', catalogArea: 'builds' },
    );
    const valid = openIdentityWarningsSnapshot(catalog, scope, reference.snapshotId);
    // Keep a real reader/captured authority, but inject a malformed/changed
    // selected value at the host boundary to prove it cannot become a new proof.
    for (const mode of ['missing', 'changed'] as const) {
      const corrupt = {
        ...valid.reader,
        chunks(key: string) {
          if (key === 'warnings:' + '0'.repeat(16)) {
            if (mode === 'missing') throw Error('Missing retained warning row');
            return ['{"changed":true}'];
          }
          return valid.reader.chunks(key);
        },
      };
      const binding = {
        ...catalog.open(reference.snapshotId)!,
        reference: () => corrupt,
      };
      const corruptCatalog = { ...catalog, open: () => binding };
      await assert.rejects(
        () =>
          retainIdentityWarningsSnapshot({
            db: f.db,
            catalog: corruptCatalog,
            scope,
            digest,
            count: 2,
            rows: [],
            run: async (work) => {
              let result = work.next();
              while (!result.done) result = work.next();
              return result.value;
            },
          }),
        mode === 'missing' ? /Missing retained warning row/ : /warning content changed/,
      );
    }

    const { readNativeIdentityScopeFragment } = await import('../intake-identity-native.ts');
    const legacyInput = {
      scopeToken: scope.scopeToken,
      snapshotId: reference.snapshotId,
      section: 'warnings',
      ordinal: 0,
      offset: expectedBytes.length - 1,
    };
    async function interruptLegacy(change: () => void, signal?: AbortSignal, http = false) {
      const before = intakeWorkCounters(f.db).warm.identityFragmentLegacyReadBytes;
      let changed = false,
        settled = false,
        immediate: NodeJS.Immediate | undefined;
      const poll = () => {
        if (settled) return;
        if (intakeWorkCounters(f.db).warm.identityFragmentLegacyReadBytes > before) {
          changed = true;
          change();
          return;
        }
        immediate = globalThis.setImmediate(poll);
      };
      immediate = globalThis.setImmediate(poll);
      try {
        const work = http
          ? fetch(
              f.base +
                'identity-scope-fragment?' +
                new URLSearchParams({
                  groupId: f.groupId,
                  scopeToken: scope.scopeToken,
                  snapshotId: reference.snapshotId,
                  section: 'warnings',
                  ordinal: '0',
                  offset: String(expectedBytes.length - 1),
                }),
              { signal },
            )
          : readNativeIdentityScopeFragment(
              f.db,
              f.root,
              f.profileId,
              f.original.id,
              f.groupId,
              legacyInput,
              { signal },
            );
        await assert.rejects(work, /changed|abort/i);
      } finally {
        settled = true;
        if (immediate) clearImmediate(immediate);
      }
      assert.equal(changed, true, 'interruption occurs inside the actual legacy byte scan');
      const read = intakeWorkCounters(f.db).warm.identityFragmentLegacyReadBytes - before;
      assert.ok(read > 0 && read < expectedBytes.length);
      let entered = false;
      await runExclusiveClinicalOperation(f.db, async () => {
        entered = true;
      });
      assert.equal(entered, true, 'a new operation acquires the released lane');
      const stopped = intakeWorkCounters(f.db).warm.identityFragmentLegacyReadBytes;
      assert.ok(
        stopped - before < expectedBytes.length,
        'server stops the interior scan before releasing its lane',
      );
      await setImmediate();
      assert.equal(intakeWorkCounters(f.db).warm.identityFragmentLegacyReadBytes, stopped);
    }
    const controller = new AbortController();
    await interruptLegacy(() => controller.abort(), controller.signal);
    const httpController = new AbortController();
    await interruptLegacy(() => httpController.abort(), httpController.signal, true);
    const { getRetainedIntakeOriginalReference, intakeTransaction } = await import('../intake.ts');
    const { readFileSync, writeFileSync, renameSync } = await import('node:fs');
    const originalPath = getRetainedIntakeOriginalReference(
      f.db,
      f.root,
      f.profileId,
      f.original.id,
    ).path;
    const originalBytes = readFileSync(originalPath);
    await interruptLegacy(() => {
      const replacement = originalPath + '.fictional-replacement';
      writeFileSync(replacement, originalBytes);
      renameSync(replacement, originalPath);
    });
    const afterReplacement = await requestFragment({ offset: '0', cursor: 'start' });
    // A real rolled-back authority operation clears the existing preview owner,
    // so its old transport MAC cannot survive even when data rolls back exactly.
    assert.throws(
      () =>
        intakeTransaction(
          f.db,
          () => {
            throw Error('Fictional rollback');
          },
          {},
        ),
      /Fictional rollback/,
    );
    await requestFragment(
      { offset: String(afterReplacement.nextOffset), cursor: afterReplacement.nextCursor },
      409,
    );
    const alternateWarnings = [{ ...warnings[0], savedBirthDate: '1991-03-08' }, warnings[1]];
    const alternateDigest = createHash('sha256')
      .update(canonicalLiteral(alternateWarnings))
      .digest('hex');
    const alternate = await runExclusiveClinicalOperation(f.db, async () => {
      const catalog = createReportSnapshotCatalog(
        f.db,
        { id: f.original.id },
        { catalogArea: 'builds' },
      );
      const ref = await retainIdentityWarningsSnapshot({
        db: f.db,
        catalog,
        scope,
        digest: alternateDigest,
        count: 2,
        rows: alternateWarnings.map((value) => ({ chunks: () => [canonicalLiteral(value)] })),
        run: async (work) => {
          let next = work.next();
          while (!next.done) next = work.next();
          return next.value;
        },
      });
      const collections = selectedEnvelopeStore(f.db, { id: f.original.id }).collections;
      collections.commitMaintenance(
        collections.prepare(collections.openView(), {
          operationId: randomUUID(),
          requestDigest: alternateDigest,
          domainVersion: intakeSourceVersion(f.db, f.original.id).rawVersion,
          changes: await catalog.finalChanges(),
        }),
      );
      return ref;
    });
    assert.equal(Buffer.byteLength(canonicalLiteral(alternateWarnings[0])), expectedBytes.length);
    const currentCursor = await requestFragment({ offset: '0', cursor: 'start' });
    const alternateStart = await requestFragment({
      offset: '0',
      cursor: 'start',
      snapshotId: alternate.snapshotId,
    });
    assert.equal(Buffer.from(alternateStart.data, 'base64').length, 32768);
    const originalStillCurrent = await requestFragment({
      offset: String(currentCursor.nextOffset),
      cursor: currentCursor.nextCursor,
    });
    assert.deepEqual(
      Buffer.from(originalStillCurrent.data, 'base64'),
      expectedBytes.subarray(32768, 65536),
    );

    await requestFragment(
      {
        offset: String(currentCursor.nextOffset),
        cursor: currentCursor.nextCursor,
        snapshotId: alternate.snapshotId,
      },
      409,
    );

    await requestFragment(
      {
        offset: String(currentCursor.nextOffset),
        cursor: currentCursor.nextCursor,
        snapshotId: reference.snapshotId.replace(scope.scopeToken, 'e'.repeat(64)),
      },
      409,
    );
    await requestFragment(
      {
        offset: String(currentCursor.nextOffset),
        cursor: currentCursor.nextCursor,
        section: 'questions',
      },
      400,
    );
  },
);

// Supported native competing-claim policy creates the fragmented question;
// only the accepted same-length claim revision is prepared by this fixture.
test(
  'actual native changed competing claim preserves unchanged fragmented question leaves',
  { timeout: 120000 },
  async (t) => {
    const { intakeReviewChildren } = await import('../intake-review-collection.ts');
    const { schemaOrdinal } = await import('../intake-envelope-schema.ts');
    const alternatives = Array.from(
      { length: 6 },
      (_, n) => `Patient: Fictional alternative ${n} ` + 'z'.repeat(3900),
    );
    const f = await fixture(
      t,
      true,
      alternatives.length + 1,
      false,
      (n) => {
        const record = envelope('fictional-byte-claim-' + n);
        if (n)
          record.report = {
            ...record.report!,
            key: 'claim-' + n,
            subject: { locator: 'page 1 patient', text: alternatives[n - 1]! },
          };
        return record;
      },
      undefined,
      true,
    );
    const old = await f.review(),
      oldScope = old.scopeReference!;
    assert.equal(oldScope.collection.competingSubjects, alternatives.length);
    assert.equal(oldScope.collection.questions, 2);
    assert.equal(old.confirmationCount, 0);
    const view = openIntakeCollectionEnvelope(f.db, { id: f.original.id }),
      workflow = view.child(view.child(view.root(), 'intake')!, 'workflow')!;
    let changedGroupId = '';
    for (const group of intakeReviewChildren(view, workflow, 'reportGroups')) {
      const report = view.child(group, 'report'),
        subjectRecord = report && view.child(report, 'subject');
      if (!subjectRecord) continue;
      const text = view.field(subjectRecord, 'text');
      if (text.kind === 'value' && text.value === alternatives[3]) {
        const id = view.field(group, 'id');
        assert.equal(id.kind, 'value');
        changedGroupId = String((id as { kind: 'value'; value: unknown }).value);
      }
    }
    assert.ok(changedGroupId);
    const changed = alternatives[3]!.replace('zzzz', 'zyzz');
    assert.equal(changed.length, alternatives[3]!.length);
    const prepared = await prepareIntakeWorkflowCommand(
      f.db,
      { id: f.original.id },
      {
        version: oldScope.intakeVersion,
        operationId: 'fictional-one-claim-byte-edit',
        request: { groupId: changedGroupId, subject: changed },
        createdAt: '2026-01-01T00:00:00Z',
        *changes({ reader, workflow }) {
          const group = reader.find('reportGroup', workflow, changedGroupId)!;
          yield {
            op: 'set',
            record: reader.child(reader.child(group, 'report')!, 'subject')!,
            field: 'text',
            jsonText: JSON.stringify(changed),
          };
        },
      },
    );
    if (prepared.replayed) throw Error('Unexpected fixture replay');
    intakeTransaction(
      f.db,
      () => selectedEnvelopeStore(f.db, { id: f.original.id }).collections.stage(prepared.prepared),
      {
        operationId: prepared.publicationId,
        fingerprint: prepared.fingerprint,
      },
    );
    clearNativeIdentityPreviews(f.db);
    const before = { ...intakeWorkCounters(f.db).warm },
      fresh = await f.review(),
      next = fresh.scopeReference!;
    assert.equal(fresh.confirmationCount, old.confirmationCount);
    assert.equal(next.collection.assignmentTargets, oldScope.collection.assignmentTargets);
    assert.equal(next.collection.membership, oldScope.collection.membership);
    assert.equal(next.collection.competingSubjects, oldScope.collection.competingSubjects);
    assert.equal(next.collection.questions, oldScope.collection.questions);
    assert.notDeepEqual(fresh.evidenceCommitment, old.evidenceCommitment);
    const { sameDisplayedIdentityReview } =
      await import('../../app/data/identity-confirmation-freshness.ts');
    assert.equal(sameDisplayedIdentityReview(old, fresh), false);
    const catalog = createReportSnapshotCatalog(
        f.db,
        { id: f.original.id },
        { catalogArea: 'builds' },
      ),
      collections = selectedEnvelopeStore(f.db, {
        id: f.original.id,
      }).collections,
      key = 'questions:' + schemaOrdinal(1);
    const read = (snapshotId: string) => {
      const reader = catalog.open(snapshotId)!,
        value = reader.get(key);
      assert.ok(value && typeof value !== 'string');
      assert.ok(value.bytes > 16384 && value.bytes < 32768);
      const buffers: Buffer[] = [];
      let after: string | undefined;
      for (;;) {
        const page = collections.readBytes(value, {
          after,
          items: 16,
          bytes: 64 * 1024,
        });
        buffers.push(...page.chunks);
        if (page.complete) break;
        assert.ok(page.after && page.after !== after);
        after = page.after;
      }
      assert.equal(buffers.length, value.chunks);
      return { reader, buffers, text: Buffer.concat(buffers).toString('utf8') };
    };
    const previous = read(oldScope.collection.snapshotId),
      current = read(next.collection.snapshotId);
    assert.equal(previous.buffers.length, current.buffers.length);
    const differing = current.buffers.filter((buffer, n) => !buffer.equals(previous.buffers[n]!));
    assert.equal(differing.length, 1, 'same-length claim changes one retained question leaf');
    const previousQuestion = JSON.parse(previous.text) as {
        textAnchor: string;
      },
      currentQuestion = JSON.parse(current.text) as { textAnchor: string };
    assert.ok(previousQuestion.textAnchor.includes(alternatives[3]!));
    assert.ok(currentQuestion.textAnchor.includes(changed));
    assert.equal(
      currentQuestion.textAnchor,
      previousQuestion.textAnchor.replace(alternatives[3]!, changed),
    );
    assert.equal(
      read(oldScope.collection.snapshotId).text,
      previous.text,
      'prior immutable question remains exact',
    );
    const page = await f.request(
      `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${next.scopeToken}&section=questions&limit=2`,
    );
    assert.equal(page.items[1].kind, 'value');
    assert.deepEqual(page.items[1].value, JSON.parse(current.text));
    assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
    assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
    assert.equal(
      intakeWorkCounters(f.db).warm.reportSnapshotTextChangedChunks -
        before.reportSnapshotTextChangedChunks,
      1,
      'only the fragmented question changes one aligned leaf; competing rows remain inline',
    );
    assert.equal(
      intakeWorkCounters(f.db).warm.reportSnapshotTextWrittenBytes -
        before.reportSnapshotTextWrittenBytes,
      differing[0]!.byteLength,
    );
    t.diagnostic(
      JSON.stringify({
        actualNativeFragmentedClaimWork: {
          claims: alternatives.length,
          questionBytes: Buffer.byteLength(current.text),
          differingRetainedQuestionLeaves: differing.length,
          wholeFreshReviewChangedTextChunks:
            intakeWorkCounters(f.db).warm.reportSnapshotTextChangedChunks -
            before.reportSnapshotTextChangedChunks,
          wholeFreshReviewTextBytesWritten:
            intakeWorkCounters(f.db).warm.reportSnapshotTextWrittenBytes -
            before.reportSnapshotTextWrittenBytes,
          wholeFreshReviewCheckpointChanges:
            intakeWorkCounters(f.db).warm.reportSnapshotCheckpointChanges -
            before.reportSnapshotCheckpointChanges,
        },
      }),
    );
  },
);
