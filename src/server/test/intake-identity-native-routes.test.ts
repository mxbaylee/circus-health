import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
} from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  clearNativeIdentityPreviews,
  nativeIdentityPreviewCounts,
} from '../intake-identity-preview-cache.ts';
import { getNote, saveNote } from '../notes.ts';
import { createApp } from '../index.ts';
import { fictionalModel } from './fictional-model.ts';
import { readQualificationReview } from '../../scripts/qualification-intake-read.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';
import type {
  IntakeIdentityConfirmation,
  IntakeIdentityReview,
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
  return { root, profileId, db, original, proposed, groupId, app, request, review };
}
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

test('native common identity preserves a complete giant competing-subject question through confirmation', async (t) => {
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
  assert.equal(page.total, 1);
  assert.equal(page.items[0].kind, 'reference');
  assert.ok(page.items[0].reference.bytes > 256 * 1024);
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const fragment = await f.request(
      `identity-scope-fragment?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${scope.scopeToken}&section=questions&ordinal=0&offset=${offset}`,
    );
    const bytes = Buffer.from(fragment.data, 'base64');
    assert.ok(bytes.length <= 32768);
    parts.push(bytes);
    if (fragment.complete) break;
    assert.ok(fragment.nextOffset > offset);
    offset = fragment.nextOffset;
  }
  const question = JSON.parse(Buffer.concat(parts).toString());
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
});

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
