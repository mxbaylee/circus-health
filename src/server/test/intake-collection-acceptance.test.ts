import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, HttpError } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import { prepareClinicalSourceFingerprintIndex } from '../intake-clinical-source-index.ts';
import {
  openIntakeCollectionEnvelope,
  iterateIntakeEnvelopeText,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { saveWorkflowDecisions, workflowHash } from '../intake-workflow.ts';
import {
  nativeAcceptanceDecisions,
  nativeAcceptanceDecisionChanges,
  nativeAcceptanceReceiptChanges,
  createNativeAcceptanceEffects,
} from '../intake-collection-acceptance.ts';
import type { IntakeReview, IntakeReviewDecision } from '../../shared/intake.ts';
function fixture(t: test.TestContext, value: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-acceptance-')),
    identity = {
      profileId: 'fictional-acceptance',
      intakeId: 'fictional-original',
      sourceHash: 'a'.repeat(64),
    },
    db = openDatabase(join(root, 'cache.sqlite'), identity.profileId);
  const authority = memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const initial = prepareInitialIntakeEnvelope(value);
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      'fictional.jsonl',
      identity.sourceHash,
      0,
      'intake_original',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  return { db, identity, authority, file: { id: identity.intakeId, sha256: identity.sourceHash } };
}

test(
  'acceptance archives the prior receipt with bounded changed journal bytes across history sizes',
  { timeout: 300000 },
  async (t) => {
    const measurements: Array<{ history: number; durableBytes: number; durableObjects: number }> =
      [];
    for (const history of [8, 128]) {
      const previous = {
          records: 1,
          repeatedRows: 0,
          matchingEarlierRows: 0,
          at: '2026-10-01T00:00:00.000Z',
          fileId: 'fictional-old',
          unknown: 'Fictional🌿'.repeat(900),
        },
        imported = {
          records: 1,
          repeatedRows: 0,
          matchingEarlierRows: 0,
          at: '2026-10-03T00:00:00.000Z',
          fileId: 'fictional-new',
        },
        oldHistory = Array.from({ length: history }, (_, index) => ({
          acceptedProposalId: 'fictional-' + index,
          reviewToken: null,
          imported: { records: index, at: previous.at },
        })),
        f = fixture(t, {
          intake: {
            version: 1,
            imported: previous,
            importHistory: oldHistory,
            acceptedProposalId: 'fictional-old-proposal',
            lastReviewToken: 'fictional-old-review',
          },
        });
      await buildIntakeCollectionEnvelope(f.db, f.file);
      const view = openIntakeCollectionEnvelope(f.db, f.file),
        originalImported = view.child(view.child(view.root(), 'intake')!, 'imported')!,
        originalAddress = view.address(originalImported),
        retained = new Set(f.authority.objects.keys()),
        operationId = randomUUID(),
        effects = createNativeAcceptanceEffects();
      const prepared = await prepareIntakeEnvelopeMutation(f.db, f.file, {
        reader: view,
        operationId,
        requestDigest: workflowHash(operationId),
        domainVersion: 2,
        changes: (staged) =>
          nativeAcceptanceReceiptChanges({
            staged,
            file: f.file,
            review: review(),
            reviewed: false,
            decisions: [],
            at: imported.at,
            effects,
            proposalId: null,
            imported,
            decisionFingerprint: workflowHash('fictional decisions'),
            fingerprint: workflowHash(operationId),
          }),
      });
      transaction(f.db, () =>
        createIntakeStateStorage(f.db, f.identity).collections.stage(prepared.prepared!),
      );
      const appended = [...f.authority.objects].filter(([key]) => !retained.has(key));
      measurements.push({
        history,
        durableBytes: appended.reduce((sum, [, bytes]) => sum + bytes.length, 0),
        durableObjects: appended.length,
      });
      assert.equal(effects.archivedImportAddress, originalAddress);
      clearIntakeStateCache(f.db);
      const actual = JSON.parse([...iterateIntakeEnvelopeText(f.db, f.file)].join('')).intake;
      assert.deepEqual(actual.imported, imported);
      assert.deepEqual(actual.importHistory.slice(0, history), oldHistory);
      assert.deepEqual(actual.importHistory.at(-1), {
        ...previous,
        acceptedProposalId: 'fictional-old-proposal',
        reviewToken: 'fictional-old-review',
      });
    }
    // A sixteenfold retained history increase adds only changed search paths;
    // unchanged receipt records and their giant unknown evidence are not copied.
    assert.ok(measurements[1]!.durableBytes < measurements[0]!.durableBytes * 2);
    assert.ok(measurements[1]!.durableObjects <= measurements[0]!.durableObjects * 2);
    t.diagnostic(JSON.stringify(measurements));
  },
);
function review(): IntakeReview {
  return {
    reviewToken: 'fictional-complete-review',
    proposalId: 'fictional-proposal',
    version: 1,
    records: [
      {
        id: 'record-one',
        candidateId: 'candidate-one',
        candidateVersionId: 'version-one',
        mapping: { kind: 'observation', testLabel: 'Fictional' },
        draft: { mapping: { testLabel: 'Reviewed fictional' } },
        evidence: [{ locator: 'page 2' }],
        questions: [{ id: 'question-one', status: 'answered', field: 'testLabel' }],
        issues: [
          {
            id: 'issue-one',
            questionId: 'question-one',
            status: 'resolved',
            resolution: { outcome: 'corrected' },
          },
        ],
        comparisons: [],
        reviewState: 'pending',
      },
      {
        id: 'record-two',
        candidateId: 'candidate-two',
        candidateVersionId: 'version-two',
        mapping: { kind: 'document' },
        evidence: [],
        questions: [],
        issues: [],
        reviewState: 'pending',
      },
    ],
  } as unknown as IntakeReview;
}
test('native addressed acceptance decisions match complete legacy oracle including off-page comparison answers', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-03T10:00:00Z') });
  const at = new Date().toISOString(),
    details = {
      version: 1,
      originalName: 'fictional.jsonl',
      workflow: {
        format: 'health-intake-workflow-v1',
        plans: [],
        candidates: [
          {
            id: 'candidate-one',
            versions: [{ id: 'version-one', status: 'pending', occurrences: [] }],
          },
          {
            id: 'candidate-two',
            versions: [{ id: 'version-two', status: 'pending', occurrences: [] }],
          },
        ],
        questions: [{ id: 'question-one', status: 'answered', field: 'testLabel', answers: [] }],
        decisions: [],
        operations: [],
        reviewDrafts: [{ id: 'retained-draft', unknown: 'kept' }],
        identityConfirmations: [{ operationId: 'retained-identity', unknown: 'kept' }],
      },
    };
  const f = fixture(t, { intake: details }),
    complete = review(),
    decisions = nativeAcceptanceDecisions(complete, [
      {
        recordId: 'record-one',
        action: 'accept',
        mapping: {},
        comparisons: [
          {
            otherRecordId: 'off-page-target',
            outcome: 'distinct',
            reason: 'Distinct fictional visit',
            scope: { saved: { identity: 'saved-identity', version: 'saved-version' } },
          },
        ],
      },
      { recordId: 'record-two', action: 'skip' },
    ] as IntakeReviewDecision[]);
  const expected = structuredClone(details);
  saveWorkflowDecisions(
    f.file,
    expected as unknown as Parameters<typeof saveWorkflowDecisions>[1],
    complete,
    decisions,
  );
  await buildIntakeCollectionEnvelope(f.db, f.file);
  const view = openIntakeCollectionEnvelope(f.db, f.file),
    effects = createNativeAcceptanceEffects(),
    operationId = randomUUID();
  const prepared = await prepareIntakeEnvelopeMutation(f.db, f.file, {
    reader: view,
    operationId,
    requestDigest: workflowHash(operationId),
    domainVersion: 2,
    changes: (staged) =>
      nativeAcceptanceDecisionChanges({
        view: staged,
        file: f.file,
        review: complete,
        decisions,
        at,
        effects,
      }),
  });
  transaction(f.db, () =>
    createIntakeStateStorage(f.db, f.identity).collections.stage(prepared.prepared!),
  );
  const actual = JSON.parse([...iterateIntakeEnvelopeText(f.db, f.file)].join('')).intake;
  assert.deepEqual(actual.workflow, expected.workflow);
  assert.equal(actual.version, 2);
  assert.equal(effects.candidateChanges.length, 1);
  assert.equal(effects.decisionAddresses.length, 1);
  assert.equal(effects.questionAddresses.length, 2);
  clearIntakeStateCache(f.db);
  assert.deepEqual(
    JSON.parse([...iterateIntakeEnvelopeText(f.db, f.file)].join('')).intake.workflow,
    expected.workflow,
  );
});
test('native acceptance preserves saved-answer and identity/source blockers', () => {
  const request: IntakeReviewDecision[] = [
    { recordId: 'record-one', action: 'accept', mapping: { testLabel: 'Fictional' } },
  ];
  const stale = review();
  stale.sourceTextStale = true;
  assert.throws(
    () => nativeAcceptanceDecisions(stale, request),
    (error: unknown) => error instanceof HttpError && error.code === 'SOURCE_TEXT_CHANGED',
  );
  const blocked = review();
  blocked.records[0]!.issues = [
    { id: 'identity', kind: 'identity', blocking: true, status: 'unresolved' },
  ] as IntakeReview['records'][number]['issues'];
  assert.throws(
    () => nativeAcceptanceDecisions(blocked, request),
    (error: unknown) => error instanceof HttpError && error.code === 'REVIEW_ISSUES_PENDING',
  );
  const suggested = review();
  suggested.records[0]!.suggestedMapping = { testLabel: 'Saved answer' };
  assert.throws(
    () => nativeAcceptanceDecisions(suggested, request),
    (error: unknown) => error instanceof HttpError && error.code === 'ANSWER_REVIEW_REQUIRED',
  );
  assert.throws(
    () => nativeAcceptanceDecisions(review(), [...request, ...request]),
    (error: unknown) => error instanceof HttpError && error.code === 'IMPORT_REVIEW',
  );
});

for (const extra of ['none', 'write', 'restored'] as const) {
  test(`native acceptance composes actual clinical SQL and certifies only its owned writes: ${extra}`, async (t) => {
    const { ensureProfileDirectories } = await import('../profile-storage.ts'),
      { attachPersonalDurability } = await import('../portable.ts'),
      { uploadIntake, proposeConversion } = await import('../intake.ts'),
      { prepareCollectionClinicalReview } = await import('../intake-review-collection-host.ts'),
      { prepareNativeIntakeAcceptance } = await import('../intake-collection-acceptance.ts'),
      { buildReportContextLookup } = await import('../intake-report-context.ts'),
      { collectionClinicalProjectionContext } =
        await import('../intake-review-collection-session.ts'),
      root = mkdtempSync(join(tmpdir(), 'fictional-native-acceptance-host-')),
      profileId = 'fictional-acceptance-host',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    const cleanup: Array<() => void> = [];
    t.after(() => {
      for (const close of cleanup.reverse()) close();
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const intake = uploadIntake(db, root, profileId, {
      filename: 'fictional.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        JSON.stringify({
          format: 'health-record-v1',
          id: 'one',
          kind: 'document',
          payload: { text: 'Fictional note' },
          provenance: {
            capturedVia: 'Fictional export',
            sourceSystem: 'Fictional clinic',
            sourceRecordId: 'one',
            evidenceClass: 'provider_export',
            locator: 'page 1',
          },
          coverage: { status: 'complete_response', notes: [] },
          clinical: {
            kind: 'document',
            subject: 'self',
            documentTitle: 'Fictional note',
            date: '2026-01-01',
          },
        }),
      ),
    });
    const { profileOriginal } = await import('../profile-storage.ts'),
      { readFileSync } = await import('node:fs'),
      original = db.prepare('SELECT path FROM source_files WHERE id=?').get(intake.id)!,
      proposed = proposeConversion(db, root, profileId, intake.id, {
        version: intake.version,
        jsonlText: readFileSync(profileOriginal(root, String(original.path), profileId), 'utf8'),
        summary: 'Fictional reviewed proposal',
      }),
      proposalId = proposed.proposals.at(-1)!.id;
    await buildIntakeCollectionEnvelope(db, { id: intake.id, sha256: intake.sha256 });
    await prepareCollectionReviewMembership(db, { id: intake.id });
    await prepareClinicalSourceFingerprintIndex(db);
    const result = prepareCollectionClinicalReview(db, root, profileId, intake.id, proposalId);
    if (result.status !== 'ready') throw Error('Expected complete review');
    const { session } = result,
      context = collectionClinicalProjectionContext(session),
      decisions = session.review.records.map((record) => ({
        recordId: record.id,
        action: 'accept' as const,
        mapping: record.mapping,
      }));
    let derivations = 0;
    const {
        captureNativeBatchRevalidationBasis,
        disposeNativeBatchRevalidationBasis,
        proveNativeAcceptanceOnlyTransition,
        assertNativeAcceptanceOnlyTransition,
      } = await import('../intake-collection-acceptance.ts'),
      basis = captureNativeBatchRevalidationBasis(db, { id: intake.id });
    cleanup.push(() => disposeNativeBatchRevalidationBasis(basis));
    const input: Parameters<typeof prepareNativeIntakeAcceptance>[3] = {
      session,
      expectedVersion: session.review.version,
      reviewToken: session.review.reviewToken,
      decisions,
      operationId: randomUUID(),
      fingerprint: 'f'.repeat(64),
      reportReceipt({ imported, intakeVersionBefore, intakeVersionAfter, review }) {
        const records = imported.clinical!.records!.map((record) => {
          const selected = review.records.find((r) => r.id === record.recordId)!;
          return {
            ...record,
            candidateId: selected.candidateId!,
            candidateVersionId: selected.candidateVersionId!,
          };
        });
        return {
          operationId: input.operationId,
          status: 'accepted',
          atomic: true,
          at: imported.at,
          selectedCount: records.length,
          acceptedCount: records.length,
          receipts: [
            {
              intakeId: intake.id,
              proposalId,
              intakeVersionBefore,
              intakeVersionAfter,
              reviewToken: review.reviewToken,
              records,
            },
          ],
        };
      },
      reportEvidence: {
        packageEvidence: false,
        hasMember: () => false,
        contextLookup: buildReportContextLookup(context.proposal.entries),
      },
      nextDiscoveryOrder: () => 1,
      async prepareDerived({ reader, acceptance }) {
        derivations++;
        assert.equal(acceptance.candidateChanges.length, 1);
        const version = reader.resolve(acceptance.candidateChanges[0]!.versionAddress);
        assert.deepEqual(reader.field(version, 'status'), { kind: 'value', value: 'accepted' });
        assert.equal(acceptance.acceptedRecordAddresses.length, 1);
        return { changes: [], needsReview: false };
      },
    };
    let prepared = await prepareNativeIntakeAcceptance(db, root, profileId, input);
    if (!prepared.prepared) throw Error('Unexpected replay');
    cleanup.push(() => prepared.dispose?.());
    assert.equal(derivations, 2, 'state-only second preparation rebinds exact derived roots');
    assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 0);
    assert.throws(
      () =>
        transaction(db, () => {
          prepared.apply!();
          throw Error('Fictional final failure');
        }),
      /Fictional final failure/,
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 0);
    assert.equal(
      openIntakeCollectionEnvelope(db, { id: intake.id, sha256: intake.sha256 }).logical
        .domainVersion,
      session.review.version,
    );
    prepared.dispose();
    prepared = await prepareNativeIntakeAcceptance(db, root, profileId, input);
    if (!prepared.prepared) throw Error('Unexpected replay after rollback');
    transaction(
      db,
      () => {
        prepared.apply!();
        if (extra !== 'none') {
          db.prepare(
            "INSERT INTO providers(id,name) VALUES('unowned-fictional','Unowned fictional')",
          ).run();
          if (extra === 'restored')
            db.prepare("DELETE FROM providers WHERE id='unowned-fictional'").run();
        }
        return prepared.reportReceipt;
      },
      { operationId: input.operationId, fingerprint: input.fingerprint },
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 1);
    const actual = JSON.parse(
      [...iterateIntakeEnvelopeText(db, { id: intake.id, sha256: intake.sha256 })].join(''),
    );
    assert.deepEqual(actual.intake.imported, prepared.imported);
    assert.equal(actual.intake.state, 'imported');
    assert.equal(actual.intake.workflow.candidates[0].versions[0].status, 'accepted');
    assert.equal(actual.intake.workflow.decisions.length, 1);
    assert.equal(actual.intake.lastDecisionFingerprint, prepared.decisionFingerprint);
    const independent = structuredClone(context.proposal.entries[0]!);
    independent.value.id = 'disjoint';
    independent.value.provenance.sourceRecordId = 'disjoint';
    const proof = proveNativeAcceptanceOnlyTransition(db, basis, { entries: [independent] });
    if (extra !== 'none') {
      assert.equal(proof, undefined, 'unowned SQL touches cannot certify acceptance-only repair');
      return;
    }
    assert.ok(proof, 'only the actual owned committed receipt permits disjoint repair');
    assertNativeAcceptanceOnlyTransition(proof);
    assert.equal(
      proveNativeAcceptanceOnlyTransition(db, basis, { entries: context.proposal.entries }),
      undefined,
    );
    transaction(db, () =>
      db
        .prepare("INSERT INTO providers(id,name) VALUES('other-fictional','Other fictional')")
        .run(),
    );
    assert.throws(() => assertNativeAcceptanceOnlyTransition(proof), /changed again/);
  });
}

test('native nonclinical import retains repeated rows without inventing a clinical review token', async (t) => {
  const { ensureProfileDirectories } = await import('../profile-storage.ts'),
    { attachPersonalDurability } = await import('../portable.ts'),
    { uploadIntake } = await import('../intake.ts'),
    { prepareCollectionClinicalReview } = await import('../intake-review-collection-host.ts'),
    { prepareNativeIntakeAcceptance } = await import('../intake-collection-acceptance.ts'),
    { buildReportContextLookup } = await import('../intake-report-context.ts'),
    { collectionClinicalProjectionContext } =
      await import('../intake-review-collection-session.ts'),
    root = mkdtempSync(join(tmpdir(), 'fictional-unreviewed-retention-')),
    profileId = 'fictional-unreviewed',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId),
    cleanup: Array<() => void> = [];
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    for (const close of cleanup.reverse()) close();
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const line = JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-raw',
      kind: 'unrecognized',
      payload: { text: 'Fictional retained assertion' },
      provenance: {
        capturedVia: 'Fictional export',
        sourceSystem: 'Fictional clinic',
        sourceRecordId: 'fictional-raw',
        evidenceClass: 'provider_export',
        locator: 'row 1',
      },
      coverage: { status: 'complete_response', notes: [] },
    }),
    intake = uploadIntake(db, root, profileId, {
      filename: 'fictional.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(line + '\n' + line),
    });
  await buildIntakeCollectionEnvelope(db, { id: intake.id, sha256: intake.sha256 });
  await prepareCollectionReviewMembership(db, { id: intake.id });
  await prepareClinicalSourceFingerprintIndex(db);
  const review = prepareCollectionClinicalReview(db, root, profileId, intake.id);
  if (review.status !== 'ready') throw Error('Expected complete source validation');
  const context = collectionClinicalProjectionContext(review.session),
    prepared = await prepareNativeIntakeAcceptance(db, root, profileId, {
      session: review.session,
      expectedVersion: review.session.review.version,
      decisions: [],
      operationId: randomUUID(),
      fingerprint: 'e'.repeat(64),
      reportEvidence: {
        packageEvidence: false,
        hasMember: () => false,
        contextLookup: buildReportContextLookup(context.proposal.entries),
      },
      nextDiscoveryOrder: () => 1,
      async prepareDerived({ acceptance }) {
        assert.equal(acceptance.decisionAddresses.length, 0);
        return { changes: [], needsReview: true };
      },
    });
  if (!prepared.prepared) throw Error('Unexpected replay');
  cleanup.push(() => prepared.dispose());
  transaction(db, () => prepared.apply());
  const selected = JSON.parse(
    [...iterateIntakeEnvelopeText(db, { id: intake.id })].join(''),
  ).intake;
  assert.equal(selected.lastReviewToken, null);
  assert.equal(selected.imported.records, 2);
  assert.equal(selected.imported.repeatedRows, 1);
  assert.equal(Object.hasOwn(selected.imported, 'clinical'), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 0);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM source_records WHERE source_file_id=?').get(intake.id)!.n,
    2,
  );
});
