import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { attachPersonalDurability } from '../portable.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import type { Database } from '../database.ts';
import type { Intake } from '../../shared/intake.ts';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  createIntakePlan,
  getIntake,
  getIntakeOriginal,
  importIntake,
  proposeConversion,
  reviewIntake,
  saveIntakePackagePlan,
  submitIntakeBatch,
  uploadIntake,
} from '../intake.ts';
import { getIntakeIdentityReview, confirmIntakeIdentityScope } from '../intake-identity.ts';
import { readIntakeEvidence } from '../intake-evidence.ts';
import { indexIntakePackage, readIntakePackageMember } from '../intake-package.ts';
import { intakeReadingAccounting } from '../intake-reading-accounting.ts';
import { rebuildProfile } from '../portable.ts';
import { evidenceFor, observations } from '../queries.ts';
import { fictionalModel } from './fictional-model.ts';
import { evaluateImportGroundTruth } from '../../tests/fixtures/import-ground-truth-evaluator.ts';
import {
  EXPECTED_DEXA_RESULTS,
  FICTIONAL_DEXA_ACCEPTED_GROUND_TRUTH,
  FICTIONAL_REPORT_GROUND_TRUTH,
} from '../../tests/fixtures/fictional-dexa-ground-truth.ts';
import { buildFictionalDexaSources } from '../../tests/fixtures/fictional-dexa-source-generator.ts';
import { evaluateFictionalDexaCoverage } from '../../tests/fixtures/fictional-dexa-coverage-ground-truth.ts';
import {
  fictionalAllReportEnvelopes,
  fictionalMixedZipEnvelopes,
  fictionalStandaloneDexaEnvelopes,
  type FictionalReportAssets,
} from '../../tests/fixtures/fictional-dexa-proposals.ts';

function temporary(t: TestContext, prefix: string) {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const jsonl = (values: unknown[]) => values.map((value) => JSON.stringify(value)).join('\n');

const coverageContext = (id: string) =>
  JSON.stringify({
    format: 'health-record-v1',
    id,
    kind: 'context',
    payload: { text: 'Host source accounting receipt for the independently fictional fixture.' },
    provenance: {
      capturedVia: 'Controlled coverage fixture',
      sourceSystem: 'Juniper Ridge Imaging Sandbox',
      sourceRecordId: null,
      evidenceClass: 'unknown',
      locator: 'Host-enumerated fixture scope',
    },
    coverage: {
      status: 'partial',
      notes: ['Host dispositions remain separate from clinical extraction completeness.'],
    },
  });

async function acceptDexaAndSkipOtherSubject(
  db: Database,
  root: string,
  profileId: string,
  intake: Intake,
  envelopes: unknown[],
  beforeImport?: () => void,
) {
  let current = proposeConversion(db, root, profileId, intake.id, {
    version: intake.version,
    jsonlText: jsonl(envelopes),
    summary: 'Controlled independently fictional DEXA benchmark proposal',
  });
  const proposalId = current.proposals.at(-1)?.id;
  assert.ok(proposalId);
  for (const group of current.workflow!.reportGroups!.filter(
    (candidate) => candidate.report?.subject?.text === 'Subject: Fern Example',
  )) {
    const identity = await getIntakeIdentityReview(db, root, profileId, intake.id, group.id);
    if (!identity.blocking) {
      assert.equal(identity.status, 'evidenced_match');
      assert.equal(identity.evidencedIdentity.fullName, 'Fern Example');
      continue;
    }
    assert.equal(identity.status, 'confirmation_required');
    assert.ok(identity.scope && identity.scope.targets.length > 0);
    const confirmed = await confirmIntakeIdentityScope(db, root, profileId, intake.id, {
      version: identity.scope.intakeVersion,
      operationId: `confirm-fictional-dexa-${group.id}`,
      scope: identity.scope,
      outcome: 'this_is_me',
      attestation: identity.scope.questions?.length
        ? 'confirmed_displayed_identity_questions'
        : 'reviewed_original_and_membership',
    });
    assert.ok(
      'validation' in confirmed,
      'The direct legacy fixture retains its full intake contract',
    );
    current = confirmed;
  }
  const review = reviewIntake(db, root, profileId, intake.id, proposalId);
  beforeImport?.();
  return importIntake(db, root, profileId, intake.id, {
    version: review.version,
    proposalId,
    reviewToken: review.reviewToken,
    decisions: review.records.map((record) => ({
      recordId: record.id,
      action: String(record.mapping.sourceRecordId || '').startsWith('dexa-')
        ? ('accept' as const)
        : ('skip' as const),
      mapping: record.mapping,
    })),
  });
}

function acceptedDexaQueries(db: Database) {
  return {
    observations: observations(db, new URLSearchParams({ visibility: 'all' }), true).data.map(
      (value) => ({
        ...value,
        evidence: evidenceFor(db, 'observation', value.id),
      }),
    ),
  };
}

test('fictional DEXA and redundant mixed-person ZIP are deterministic and independently graded', (t) => {
  const first = buildFictionalDexaSources(join(temporary(t, 'circus-dexa-a-'), 'generated'));
  const second = buildFictionalDexaSources(join(temporary(t, 'circus-dexa-b-'), 'generated'));
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(EXPECTED_DEXA_RESULTS.length, 28);
  assert.equal(new Set(EXPECTED_DEXA_RESULTS.map((result) => result.sourceRecordId)).size, 28);
  assert.equal(first.manifest.zipMembers.length, 3);
  assert.equal(first.manifest.zipMembers[0]!.sha256, first.manifest.zipMembers[1]!.sha256);
  assert.notEqual(first.manifest.zipMembers[1]!.sha256, first.manifest.zipMembers[2]!.sha256);

  const ideal = fictionalAllReportEnvelopes();
  assert.equal(ideal.length, 86, '28 standalone + 56 redundant ZIP DEXA + 2 surgery cues');
  const report = evaluateImportGroundTruth(ideal, { truth: FICTIONAL_REPORT_GROUND_TRUTH });
  assert.equal(report.passed, true, JSON.stringify(report.failures, null, 2));

  const dexa = ideal.filter((value) => String(value.provenance.sourceRecordId).startsWith('dexa-'));
  assert.equal(dexa.length, 84);
  assert.ok(
    dexa.every(
      (value) =>
        value.report?.key === 'DEXA-FX-2048' &&
        value.report.subject?.text === 'Subject: Fern Example' &&
        value.report.section,
    ),
  );
  const surgery = ideal.filter((value) =>
    String(value.provenance.sourceRecordId).startsWith('surgery-'),
  );
  assert.equal(surgery.length, 2);
  assert.ok(
    surgery.every(
      (value) =>
        value.report?.key === 'SURG-FX-883' &&
        value.report.subject?.text === 'Subject: Rowan Ember',
    ),
  );

  const missing = structuredClone(ideal).filter(
    (value) => value.provenance.sourceRecordId !== 'dexa-visceral-area',
  );
  assert.ok(
    evaluateImportGroundTruth(missing, { truth: FICTIONAL_REPORT_GROUND_TRUTH }).failures.some(
      (failure) => failure.category === 'recall',
    ),
  );

  const flawed = structuredClone(ideal);
  const wrongKind = flawed.find((value) => value.provenance.sourceRecordId === 'dexa-l1-bmd')!;
  wrongKind.clinical = {
    ...(wrongKind.clinical as Record<string, unknown>),
    kind: 'document',
  };
  assert.ok(
    evaluateImportGroundTruth(flawed, { truth: FICTIONAL_REPORT_GROUND_TRUTH }).failures.some(
      (failure) => failure.recordId === 'dexa-l1-bmd' && failure.detail.startsWith('kind '),
    ),
  );
  const wrongUnit = flawed.find((value) => value.provenance.sourceRecordId === 'dexa-lean-mass')!;
  wrongUnit.clinical = { ...(wrongUnit.clinical as Record<string, unknown>), unit: 'lb' };
  assert.ok(
    evaluateImportGroundTruth(flawed, { truth: FICTIONAL_REPORT_GROUND_TRUTH }).failures.some(
      (failure) => failure.recordId === 'dexa-lean-mass' && failure.detail.startsWith('unit '),
    ),
  );
  const wrongDate = flawed.find((value) => value.provenance.sourceRecordId === 'dexa-body-fat')!;
  wrongDate.clinical = {
    ...(wrongDate.clinical as Record<string, unknown>),
    date: '2026-08-01',
  };
  assert.ok(
    evaluateImportGroundTruth(flawed, { truth: FICTIONAL_REPORT_GROUND_TRUTH }).failures.some(
      (failure) => failure.recordId === 'dexa-body-fat' && failure.detail.startsWith('date '),
    ),
  );
  const wrongSource = flawed.find(
    (value) =>
      value.provenance.sourceRecordId === 'dexa-fat-mass' &&
      value.provenance.locator.startsWith('fictional-dexa-report.pdf'),
  )!;
  wrongSource.clinical = {
    ...(wrongSource.clinical as Record<string, unknown>),
    assets: ['unrelated-source'],
  };
  assert.ok(
    evaluateImportGroundTruth(flawed, { truth: FICTIONAL_REPORT_GROUND_TRUTH }).failures.some(
      (failure) => failure.recordId === 'dexa-fat-mass' && failure.category === 'source_occurrence',
    ),
  );
  const performed = flawed.find(
    (value) => value.provenance.sourceRecordId === 'surgery-left-ankle-performed',
  )!;
  performed.clinical = {
    ...(performed.clinical as Record<string, unknown>),
    status: 'planned',
    eventKind: 'order',
  };
  assert.ok(
    evaluateImportGroundTruth(flawed, { truth: FICTIONAL_REPORT_GROUND_TRUTH }).failures.some(
      (failure) =>
        failure.recordId === 'surgery-left-ankle-performed' &&
        (failure.detail.startsWith('status ') || failure.detail.startsWith('eventKind ')),
    ),
  );
  const rejected = evaluateImportGroundTruth(flawed, { truth: FICTIONAL_REPORT_GROUND_TRUTH });
  assert.equal(rejected.passed, false);
  for (const category of ['classification', 'literal_fidelity', 'source_occurrence'])
    assert.ok(
      rejected.failures.some((failure) => failure.category === category),
      category,
    );

  const extra = structuredClone(ideal);
  extra.push({
    ...structuredClone(ideal[0]!),
    id: 'invented-extra-dexa-result',
    provenance: {
      ...ideal[0]!.provenance,
      sourceRecordId: 'invented-extra-dexa-result',
    },
  });
  assert.ok(
    evaluateImportGroundTruth(extra, { truth: FICTIONAL_REPORT_GROUND_TRUTH }).failures.some(
      (failure) => failure.category === 'extra_record',
    ),
  );
});

test(
  '28 accepted DEXA results survive rebuild while cross-member copies remain retained pending safe identity migration',
  // Ten page renders across separate originals precede acceptance and rebuild.
  // This bounds a hang; renderer speed is not this correctness test's contract.
  { timeout: 60000 },
  async (t) => {
    fictionalModel(t);
    const root = temporary(t, 'circus-dexa-accept-');
    const profileId = 'cookie-dough';
    const paths = ensureProfileDirectories(root, profileId);
    let db = openDatabase(paths.database, profileId);
    attachPersonalDurability(db, { root, profileId: profileId });
    t.after(() => {
      try {
        db.close();
      } catch {}
    });
    const sources = buildFictionalDexaSources(join(root, 'generated-fixtures'));
    let standalone: Intake = uploadIntake(db, root, profileId, {
      filename: 'fictional-dexa-report.pdf',
      bytes: sources.dexa,
      newProviderName: 'Juniper Ridge Imaging',
    });
    let mixedZip: Intake = uploadIntake(db, root, profileId, {
      filename: 'fictional-mixed-person-redundant.zip',
      bytes: sources.zip,
      providerId: standalone.providerId,
    });
    standalone = await createIntakePlan(db, root, profileId, standalone.id, {
      version: standalone.version,
    });
    for (const page of [1, 2, 3]) {
      const evidence = await readIntakeEvidence({
        db,
        root,
        profileId,
        id: standalone.id,
        page,
      });
      assert.ok('imageContent' in evidence && evidence.imageContent);
      const original = evidence.metadata.original;
      assert.ok('page' in original);
      assert.equal(original.page, page);
    }
    mixedZip = await createIntakePlan(db, root, profileId, mixedZip.id, {
      version: mixedZip.version,
    });
    const inventory = await indexIntakePackage({ db, root, profileId, id: mixedZip.id });
    const retain = async (filename: string, pages: number) => {
      const member = inventory.members.find((candidate) => candidate.filename === filename);
      assert.ok(member, filename);
      let retained: Awaited<ReturnType<typeof readIntakePackageMember>> | undefined;
      for (let page = 1; page <= pages; page++) {
        retained = await readIntakePackageMember({
          db,
          root,
          profileId,
          id: mixedZip.id,
          memberId: member.memberId,
          page,
        });
        assert.ok('imageContent' in retained && retained.imageContent);
        const original = retained.metadata.original;
        assert.ok('page' in original);
        assert.equal(original.page, page);
      }
      assert.ok(retained);
      const sourceFileId = retained.sourceFileId || retained.metadata?.sourceFileId;
      assert.ok(sourceFileId);
      return { memberId: member.memberId, sourceFileId };
    };
    const zipDexaPrimary = await retain('person-a/dexa-report.pdf', 3);
    const zipDexaRedundant = await retain('redundant/person-a/dexa-report-copy.pdf', 3);
    const zipSurgery = await retain('person-b/surgery-summary.pdf', 1);
    const assets: FictionalReportAssets = {
      standaloneDexa: standalone.id,
      zipDexaPrimary: zipDexaPrimary.sourceFileId,
      zipDexaPrimaryMemberId: zipDexaPrimary.memberId,
      zipDexaRedundant: zipDexaRedundant.sourceFileId,
      zipDexaRedundantMemberId: zipDexaRedundant.memberId,
      zipSurgery: zipSurgery.sourceFileId,
      zipSurgeryMemberId: zipSurgery.memberId,
    };

    const zipPlan = mixedZip.workflow!.plans.find((plan) => plan.status === 'active')!;
    mixedZip = await saveIntakePackagePlan(db, root, profileId, mixedZip.id, {
      version: mixedZip.version,
      operationId: 'fictional-dexa-package-roles',
      planId: zipPlan.id,
      roles: [
        {
          memberId: zipDexaPrimary.memberId,
          role: 'clinical',
          reason: 'The member is the primary fictional DEXA occurrence.',
          coverage: 'pending',
          references: [],
        },
        {
          memberId: zipDexaRedundant.memberId,
          role: 'clinical',
          reason: 'The member is a separate redundant fictional DEXA occurrence.',
          coverage: 'pending',
          references: [],
        },
        {
          memberId: zipSurgery.memberId,
          role: 'context',
          reason: 'The member belongs to the independently fictional other subject.',
          coverage: 'context',
          references: [],
        },
      ],
    });
    const standalonePlan = standalone.workflow!.plans.find((plan) => plan.status === 'active')!;
    standalone = submitIntakeBatch(db, root, profileId, standalone.id, {
      version: standalone.version,
      operationId: 'fictional-dexa-standalone-coverage',
      planId: standalonePlan.id,
      jsonlText: coverageContext('fictional-dexa-standalone-coverage-context'),
      summary: 'Host-accounted all three rendered DEXA pages in two non-overlapping units.',
      coverage: standalonePlan.units.map((unit) => ({
        unitId: unit.id,
        kind: 'extracted' as const,
        notes: `Rendered and inspected ${unit.locator}.`,
      })),
    });
    const currentZipPlan = mixedZip.workflow!.plans.find((plan) => plan.status === 'active')!;
    mixedZip = submitIntakeBatch(db, root, profileId, mixedZip.id, {
      version: mixedZip.version,
      operationId: 'fictional-dexa-mixed-coverage',
      planId: currentZipPlan.id,
      jsonlText: coverageContext('fictional-dexa-mixed-coverage-context'),
      summary:
        'Host-accounted each ZIP occurrence, including the duplicate bytes and other subject.',
      coverage: currentZipPlan.units.map((unit) => ({
        unitId: unit.id,
        kind: unit.memberId === zipSurgery.memberId ? ('context' as const) : ('extracted' as const),
        notes:
          unit.memberId === zipSurgery.memberId
            ? 'Read and retained as other-subject supporting context.'
            : 'Rendered and inspected this distinct DEXA occurrence.',
      })),
    });

    assert.deepEqual(getIntakeOriginal(db, root, profileId, standalone.id).bytes, sources.dexa);
    assert.deepEqual(
      getIntakeOriginal(db, root, profileId, zipDexaPrimary.sourceFileId).bytes,
      sources.dexa,
    );
    assert.deepEqual(
      getIntakeOriginal(db, root, profileId, zipDexaRedundant.sourceFileId).bytes,
      sources.dexa,
    );
    assert.deepEqual(
      getIntakeOriginal(db, root, profileId, zipSurgery.sourceFileId).bytes,
      sources.surgery,
    );
    assert.deepEqual(getIntakeOriginal(db, root, profileId, mixedZip.id).bytes, sources.zip);
    assert.equal(
      createHash('sha256')
        .update(getIntakeOriginal(db, root, profileId, standalone.id).bytes)
        .digest('hex'),
      sources.manifest.files[0]!.sha256,
    );

    const standaloneEnvelopes = fictionalStandaloneDexaEnvelopes(assets);
    const zipEnvelopes = fictionalMixedZipEnvelopes(assets);
    const acceptedStandalone = await acceptDexaAndSkipOtherSubject(
      db,
      root,
      profileId,
      standalone,
      standaloneEnvelopes,
    );
    assert.equal(acceptedStandalone.workflow?.reportGroups?.length, 1);
    assert.equal(acceptedStandalone.workflow?.reportGroups?.[0]?.versions[0]?.members.length, 28);
    const acceptedRows = db.prepare('SELECT * FROM observations ORDER BY id').all();
    const acceptedEvidence = db.prepare('SELECT * FROM evidence ORDER BY id').all();
    let pendingBefore: unknown;
    await assert.rejects(
      () =>
        acceptDexaAndSkipOtherSubject(db, root, profileId, mixedZip, zipEnvelopes, () => {
          pendingBefore = readIntakeEnvelopeText(db, { id: mixedZip.id });
        }),
      { code: 'CLINICAL_SOURCE_SCOPE_COLLISION' },
    );
    assert.deepEqual(db.prepare('SELECT * FROM observations ORDER BY id').all(), acceptedRows);
    assert.deepEqual(db.prepare('SELECT * FROM evidence ORDER BY id').all(), acceptedEvidence);
    assert.deepEqual(readIntakeEnvelopeText(db, { id: mixedZip.id }), pendingBefore);
    const accepted = getIntake(db, root, profileId, mixedZip.id);
    const pendingProposalId = accepted.proposals.at(-1)!.id;
    const pendingReview = reviewIntake(db, root, profileId, mixedZip.id, pendingProposalId);
    assert.equal(
      pendingReview.records.filter((record) => record.reviewState === 'accepted').length,
      0,
    );
    const groups = accepted.workflow?.reportGroups || [];
    assert.deepEqual(
      groups.map((group) => group.versions[0]?.members.length).sort((a, b) => (a || 0) - (b || 0)),
      [2, 28, 28],
    );
    assert.equal(new Set(groups.map((group) => group.report?.subject?.text)).size, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get()?.n, 28);
    assert.equal(db.prepare('SELECT count(*) n FROM procedures').get()?.n, 0);
    assert.equal(accepted.imported?.clinical?.records?.length || 0, 0);

    const before = acceptedDexaQueries(db);
    const acceptedStandalonePlan = acceptedStandalone.workflow!.plans.find(
      (plan) => plan.status === 'active',
    )!;
    const acceptedMixedPlan = accepted.workflow!.plans.find((plan) => plan.status === 'active')!;
    const readingAccounting = intakeReadingAccounting(
      db,
      root,
      profileId,
      [acceptedStandalone, accepted],
      [],
    );
    const coverageReport = evaluateFictionalDexaCoverage({
      standalonePlan: acceptedStandalonePlan,
      mixedZipPlan: acceptedMixedPlan,
      readingAccounting,
      acceptedUniqueDexaResults: before.observations.length,
    });
    assert.equal(coverageReport.passed, true, JSON.stringify(coverageReport.failures, null, 2));
    assert.equal(readingAccounting.clinicalExtraction, 'unknown');
    assert.equal(readingAccounting.state, 'accounted_with_gaps');

    assert.ok(
      [...standaloneEnvelopes, ...zipEnvelopes].every(
        (envelope) => envelope.coverage.status === 'complete_response',
      ),
    );
    const deferredPagePlan = structuredClone(acceptedStandalonePlan);
    const deferredPageUnit = deferredPagePlan.units.find((unit) => unit.pages?.includes(3))!;
    delete deferredPageUnit.coverage;
    deferredPageUnit.attempts = [];
    deferredPageUnit.status = 'pending';
    const acceptedButIncomplete = evaluateFictionalDexaCoverage({
      standalonePlan: deferredPagePlan,
      mixedZipPlan: acceptedMixedPlan,
      acceptedUniqueDexaResults: before.observations.length,
    });
    assert.equal(acceptedButIncomplete.clinicalCountPassed, true);
    assert.equal(acceptedButIncomplete.coveragePassed, false);
    assert.ok(
      acceptedButIncomplete.failures.some(
        (failure) => failure.category === 'deferred_scope' && failure.scope === 'standalone page 3',
      ),
      'accepted records and complete_response claims never account for an omitted host page',
    );

    const missingMemberPlan = structuredClone(acceptedMixedPlan);
    missingMemberPlan.index.members = missingMemberPlan.index.members!.filter(
      (member) => member.filename !== 'person-b/surgery-summary.pdf',
    );
    assert.ok(
      evaluateFictionalDexaCoverage({
        standalonePlan: acceptedStandalonePlan,
        mixedZipPlan: missingMemberPlan,
      }).failures.some(
        (failure) =>
          failure.category === 'missing_scope' &&
          failure.scope === 'ZIP member person-b/surgery-summary.pdf',
      ),
    );

    const extraMemberPlan = structuredClone(acceptedMixedPlan);
    extraMemberPlan.index.members!.push({
      ...extraMemberPlan.index.members![0]!,
      memberId: 'fictional-unexpected-member',
      filename: 'unexpected/extra.pdf',
      locator: 'ZIP member unexpected/extra.pdf',
      duplicateOf: null,
    });
    assert.ok(
      evaluateFictionalDexaCoverage({
        standalonePlan: acceptedStandalonePlan,
        mixedZipPlan: extraMemberPlan,
      }).failures.some(
        (failure) =>
          failure.category === 'extra_scope' && failure.scope === 'ZIP member unexpected/extra.pdf',
      ),
    );

    const unreadableMemberPlan = structuredClone(acceptedMixedPlan);
    const unreadableUnit = unreadableMemberPlan.units.find(
      (unit) => unit.memberId === zipDexaPrimary.memberId,
    )!;
    assert.ok(unreadableUnit.coverage);
    unreadableUnit.coverage.kind = 'unreadable';
    const unreadableReceipt = unreadableMemberPlan.batches.find((batch) =>
      batch.coverage.some((coverage) => coverage.unitId === unreadableUnit.id),
    )!;
    unreadableReceipt.coverage.find((coverage) => coverage.unitId === unreadableUnit.id)!.kind =
      'unreadable';
    assert.ok(
      evaluateFictionalDexaCoverage({
        standalonePlan: acceptedStandalonePlan,
        mixedZipPlan: unreadableMemberPlan,
      }).failures.some(
        (failure) =>
          failure.category === 'unreadable_scope' &&
          failure.scope === 'ZIP member person-a/dexa-report.pdf',
      ),
    );

    assert.ok(before.observations.every((value) => value.evidence.length === 1));
    const bindings = {
      standaloneDexa: standalone.id,
      zipDexaPrimary: zipDexaPrimary.sourceFileId,
      zipDexaRedundant: zipDexaRedundant.sourceFileId,
    };
    const acceptedReport = evaluateImportGroundTruth(
      { queries: before },
      {
        stage: 'accepted',
        truth: FICTIONAL_DEXA_ACCEPTED_GROUND_TRUTH,
        assetBindings: bindings,
      },
    );
    assert.equal(
      acceptedReport.passed,
      false,
      'The unchanged three-occurrence oracle remains an open migration gate',
    );
    assert.ok(
      acceptedReport.failures.length > 0 &&
        acceptedReport.failures.every((failure) => failure.category === 'source_occurrence'),
      JSON.stringify(acceptedReport.failures, null, 2),
    );

    db.close();
    rmSync(paths.database, { force: true });
    rmSync(paths.database + '-wal', { force: true });
    rmSync(paths.database + '-shm', { force: true });
    assert.equal(existsSync(paths.database), false);
    const rebuilt = rebuildProfile(root, profileId, resolve(root, 'rebuilt'));
    db = openDatabase(rebuilt.database, profileId);
    attachPersonalDurability(db, { root: resolve(root, 'rebuilt'), profileId: profileId });
    const after = acceptedDexaQueries(db);
    assert.deepEqual(after, before);
    const rebuiltStandalone = getIntake(db, resolve(root, 'rebuilt'), profileId, standalone.id);
    const rebuiltMixed = getIntake(db, resolve(root, 'rebuilt'), profileId, mixedZip.id);
    const rebuiltAccounting = intakeReadingAccounting(
      db,
      resolve(root, 'rebuilt'),
      profileId,
      [rebuiltStandalone, rebuiltMixed],
      [],
    );
    const rebuiltCoverage = evaluateFictionalDexaCoverage({
      standalonePlan: rebuiltStandalone.workflow!.plans.find((plan) => plan.status === 'active')!,
      mixedZipPlan: rebuiltMixed.workflow!.plans.find((plan) => plan.status === 'active')!,
      readingAccounting: rebuiltAccounting,
      acceptedUniqueDexaResults: after.observations.length,
    });
    assert.equal(rebuiltCoverage.passed, true, JSON.stringify(rebuiltCoverage.failures, null, 2));
    assert.equal(
      evaluateImportGroundTruth(
        { queries: after },
        {
          stage: 'accepted',
          truth: FICTIONAL_DEXA_ACCEPTED_GROUND_TRUTH,
          assetBindings: bindings,
        },
      ).passed,
      false,
    );
    const rebuiltPending = reviewIntake(
      db,
      resolve(root, 'rebuilt'),
      profileId,
      mixedZip.id,
      pendingProposalId,
    );
    assert.equal(rebuiltPending.records.length, pendingReview.records.length);
    assert.equal(
      rebuiltPending.records.filter((record) => record.reviewState === 'accepted').length,
      0,
    );
    for (const [sourceFileId, expectedHash] of [
      [standalone.id, sources.manifest.files[0]!.sha256],
      [mixedZip.id, sources.manifest.files[1]!.sha256],
      [zipDexaPrimary.sourceFileId, sources.manifest.zipMembers[0]!.sha256],
      [zipDexaRedundant.sourceFileId, sources.manifest.zipMembers[1]!.sha256],
      [zipSurgery.sourceFileId, sources.manifest.zipMembers[2]!.sha256],
    ]) {
      const retained = getIntakeOriginal(
        db,
        resolve(root, 'rebuilt'),
        profileId,
        sourceFileId,
      ).bytes;
      assert.equal(createHash('sha256').update(retained).digest('hex'), expectedHash);
    }
  },
);
