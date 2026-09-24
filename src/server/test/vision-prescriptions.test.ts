import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';
import {
  uploadIntake,
  proposeConversion,
  reviewIntake,
  importIntake,
  saveIntakeReviewDraft,
  getIntake,
} from '../intake.ts';
import { profileOriginal } from '../profile-storage.ts';
import { opticalPrescriptionProblem } from '../optical-prescription.ts';
import { validateDraftMapping, reviewIssues as issuesFor } from '../intake-review.ts';
import { visionPrescriptions } from '../vision.ts';
import { previewRecordCorrection } from '../record-corrections.ts';
import { applyClinicalDecision } from '../mapping-actions.ts';
import { clinicalRecordHistory } from '../clinical-history.ts';
import { checkClinicalMapping, mappingFrom, projectClinicalReview } from '../clinical-import.ts';
import { validateJSONL } from '../intake-format.ts';
import { saveWorkflowDecisions } from '../intake-workflow.ts';
import { transaction } from '../database.ts';
import { readIntakeEvidence } from '../intake-evidence.ts';
import {
  EXPECTED_OPTICAL_RECORDS,
  evaluateOpticalGroundTruth,
} from '../../tests/fixtures/fictional-optical-ground-truth.ts';
import { controlledOpticalProposal } from '../../tests/fixtures/fictional-optical-proposals.ts';
import { buildFictionalOpticalSources } from '../../tests/fixtures/fictional-optical-source-generator.ts';
import type {
  HealthRecordEnvelope,
  IntakeClinicalMapping,
  IntakeReview,
  IntakeReviewIssue,
  IntakeReviewRecord,
} from '../../shared/intake.ts';
import type { OpticalPrescription } from '../../shared/vision.ts';
import { getIntakeIdentityScope, confirmIntakeIdentityScope } from '../intake-identity.ts';

const optical: OpticalPrescription = {
  type: 'spectacle',
  typeText: 'Distance eyewear',
  statusText: 'Released copy',
  prescribedDateText: '03/04/??',
  eyes: [
    {
      side: 'right',
      sideText: 'OD',
      sph: { valueText: '+01.00' },
      cyl: { valueText: '-0.50', unit: 'D' },
      axis: { valueText: '005' },
      prism: { valueText: '0.5 BI' },
    },
    { side: 'left', sideText: 'OS', sph: { valueText: 'plano' }, add: { valueText: '+1.00' } },
  ],
  pd: { valueText: '063', unit: 'mm' },
};
type TestIssue = Partial<IntakeReviewIssue> & Pick<IntakeReviewIssue, 'kind' | 'prompt'>;
interface TestEnvelope extends HealthRecordEnvelope {
  clinical?: IntakeClinicalMapping;
  subject?: string;
  opticalPrescription?: OpticalPrescription;
  reviewIssues?: TestIssue[];
  proposedClinicalMapping?: IntakeClinicalMapping & { reviewIssues?: TestIssue[] };
}
type TestReviewRecord = IntakeReviewRecord & { issues: IntakeReviewIssue[] };
type TestReview = Omit<IntakeReview, 'records'> & { records: TestReviewRecord[] };
type TestIntake = ReturnType<typeof getIntake> & {
  imported: NonNullable<ReturnType<typeof getIntake>['imported']> & {
    clinical: NonNullable<NonNullable<ReturnType<typeof getIntake>['imported']>['clinical']> & {
      records: NonNullable<
        NonNullable<NonNullable<ReturnType<typeof getIntake>['imported']>['clinical']>['records']
      >;
    };
  };
  importHistory: NonNullable<ReturnType<typeof getIntake>['importHistory']>;
  workflow: NonNullable<ReturnType<typeof getIntake>['workflow']>;
};
type ProfileState = { db: Parameters<typeof uploadIntake>[0]; root: string };
function profileCall(
  state: ProfileState,
  profileId: string,
  method: typeof reviewIntake,
  ...args: unknown[]
): TestReview;
function profileCall(
  state: ProfileState,
  profileId: string,
  method:
    | typeof uploadIntake
    | typeof proposeConversion
    | typeof importIntake
    | typeof saveIntakeReviewDraft
    | typeof getIntake,
  ...args: unknown[]
): TestIntake;
function profileCall(
  state: ProfileState,
  profileId: string,
  method: unknown,
  ...args: unknown[]
): unknown {
  return (method as (...values: unknown[]) => unknown)(state.db, state.root, profileId, ...args);
}
const fixtureIssuesFor = issuesFor as unknown as (
  record: { mapping: ReturnType<typeof mappingFrom>; uncertainties: string[] },
  entry: { value: HealthRecordEnvelope },
) => IntakeReviewIssue[];

const envelope = (id: string, prescription: OpticalPrescription = optical): TestEnvelope => ({
  format: 'health-record-v1',
  id,
  kind: 'document',
  payload: { literal: 'Fictional optical evidence', prescription },
  clinical: {
    kind: 'document',
    subject: 'self',
    documentTitle: 'Fictional eyewear ' + id,
    opticalPrescription: prescription,
  },
  provenance: {
    capturedVia: 'Fictional export',
    sourceSystem: 'Fictional optician',
    sourceRecordId: id,
    evidenceClass: 'provider_export',
    locator: 'row ' + id,
  },
  coverage: { status: 'complete_response', notes: [] },
});

const topLevelEnvelope = (): TestEnvelope => {
  const { clinical, ...value } = envelope('fictional-literal-optical');
  return {
    ...value,
    subject: 'unknown',
    payload: 'Fictional optical prescription. OD +01.00 -0.50 axis 005; OS plano; PD 063 mm.',
    opticalPrescription: optical,
    reviewIssues: [
      { kind: 'identity', field: 'subject', prompt: 'Confirm this fictional patient is you.' },
      {
        kind: 'date',
        field: 'date',
        prompt: 'Confirm the fictional document date.',
        choices: [{ label: 'March 4, 2026', value: '2026-03-04' }],
      },
    ],
  };
};

test('top-level literal optical proposals warn on missing identity and source-only imports can gain a reviewed Vision projection after cache loss', async (t) => {
  const f = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(f.manager, 'Fictional envelope optics');
  let state = f.manager.opened.get(profile.id)!;
  const sourceBytes = buildFictionalOpticalSources(join(f.base, 'optical-envelope-source')).image
    .bytes;
  let item = profileCall(state, profile.id, uploadIntake, {
    filename: 'fictional-optical.jpg',
    mimeType: 'image/jpeg',
    bytes: sourceBytes,
  });
  const literal = topLevelEnvelope();
  item = profileCall(state, profile.id, proposeConversion, item.id, {
    version: item.version,
    jsonlText: JSON.stringify(literal),
    summary: 'Fictional optical proposal',
  });
  const proposalId = item.proposals[0].id;
  let review = profileCall(state, profile.id, reviewIntake, item.id, proposalId);
  assert.deepEqual(review.records[0].mapping.opticalPrescription, optical);
  assert.equal(review.records[0].mapping.text, literal.payload);
  assert.equal(review.records[0].mapping.subject, 'self');
  assert.equal(review.records[0].identityReview?.status, 'missing_warning');
  assert.equal(visionPrescriptions(state.db, new URLSearchParams()).total, 0);

  // The older source-only acceptance route retained exactly these bytes without
  // producing a clinical assertion. A fresh reviewed pass must remain possible.
  item = profileCall(state, profile.id, importIntake, item.id, {
    version: item.version,
    proposalId,
  });
  const sourceOnly = structuredClone(item.imported);
  const rawRows = state.db.prepare('SELECT id,raw_json FROM source_records ORDER BY id').all();
  assert.equal(state.db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 0);
  review = profileCall(state, profile.id, reviewIntake, item.id, proposalId);
  const record = review.records[0];
  item = profileCall(state, profile.id, saveIntakeReviewDraft, item.id, {
    version: item.version,
    operationId: 'fictional-confirm-optics',
    proposalId,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId,
    resolutions: record.issues
      .filter((issue) => issue.kind === 'date')
      .map((issue) => ({
        issueId: issue.id,
        outcome: 'confirmed' as const,
        mapping: { date: '2026-03-04', documentDate: '2026-03-04' },
      })),
  });
  review = profileCall(state, profile.id, reviewIntake, item.id, proposalId);
  const request = {
    version: review.version,
    proposalId,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: record.id, action: 'accept', mapping: {} }],
  };
  item = profileCall(state, profile.id, importIntake, item.id, request);
  assert.equal(item.imported.clinical.added, 1);
  assert.equal(item.imported.matchingEarlierRows, 1);
  assert.deepEqual(item.importHistory[0], {
    ...sourceOnly,
    acceptedProposalId: proposalId,
    reviewToken: null,
  });
  let vision = visionPrescriptions(state.db, new URLSearchParams());
  assert.equal(vision.total, 1);
  assert.deepEqual(vision.data[0].opticalPrescription, optical);
  assert.equal(vision.data[0].date, '2026-03-04');
  const [acceptedRecord] = item.imported.clinical.records;
  assert.equal(
    acceptedRecord.identityAttribution!.basis,
    'reviewed_active_profile_missing_identity',
  );
  const { identityAttribution: _identityAttribution, ...acceptedRecordWithoutIdentity } =
    acceptedRecord;
  assert.deepEqual(
    [acceptedRecordWithoutIdentity],
    [
      {
        recordId: record.id,
        entityId: vision.data[0].id,
        kind: 'document',
        title: literal.id,
        optical: true,
        outcome: 'added',
      },
    ],
  );
  assert.equal(
    visionPrescriptions(state.db, new URLSearchParams({ documentId: vision.data[0].id })).total,
    1,
  );
  assert.equal(
    visionPrescriptions(state.db, new URLSearchParams({ documentId: 'missing' })).total,
    0,
  );
  assert.equal(
    state.db
      .prepare('SELECT count(*) AS n FROM attachments WHERE owner_id=?')
      .get(vision.data[0].id)!.n,
    1,
  );
  assert.deepEqual(
    profileCall(state, profile.id, importIntake, item.id, request).imported,
    item.imported,
    'accepted token retry is idempotent',
  );
  review = profileCall(state, profile.id, reviewIntake, item.id, proposalId);
  item = profileCall(state, profile.id, importIntake, item.id, {
    version: review.version,
    proposalId,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: record.id, action: 'accept', mapping: {} }],
  });
  assert.equal(item.imported.clinical.duplicates, 1);
  assert.equal(item.imported.clinical.added, 0);
  assert.equal(item.imported.clinical.records[0].outcome, 'matched');
  assert.equal(item.imported.clinical.records[0].entityId, vision.data[0].id);
  const originalFiles = state.db
    .prepare('SELECT id,path FROM source_files ORDER BY id')
    .all()
    .map((file) => ({
      id: file.id,
      bytes: readFileSync(profileOriginal(state.root, file.path, profile.id)),
    }));
  f.manager.lock(profile.id);
  rmSync(resolve(f.dataDirectory, 'profiles', profile.id, 'cache'), {
    recursive: true,
    force: true,
  });
  f.manager.unlock(profile.id, recoveryKit);
  state = f.manager.opened.get(profile.id)!;
  assert.equal(state.metrics.cacheHit, false);
  assert.deepEqual(visionPrescriptions(state.db, new URLSearchParams()), vision);
  assert.deepEqual(
    profileCall(state, profile.id, getIntake, item.id).importHistory,
    item.importHistory,
  );
  assert.deepEqual(
    state.db.prepare('SELECT id,raw_json FROM source_records ORDER BY id').all(),
    rawRows,
  );
  for (const file of originalFiles) {
    const retained = state.db.prepare('SELECT path FROM source_files WHERE id=?').get(file.id)!;
    assert.deepEqual(
      readFileSync(profileOriginal(state.root, retained.path, profile.id)),
      file.bytes,
    );
  }
});

test(
  'representative fictional optical image and PDF pass real evidence rendering, reviewed acceptance and cache rebuild',
  { timeout: 15000 },
  async (t) => {
    const f = vaultFixture(t);
    const firstBuild = buildFictionalOpticalSources(join(f.base, 'optical-ground-truth-a'));
    const secondBuild = buildFictionalOpticalSources(join(f.base, 'optical-ground-truth-b'));
    assert.equal(firstBuild.image.sha256, secondBuild.image.sha256);
    assert.equal(firstBuild.pdf.sha256, secondBuild.pdf.sha256);
    assert.ok(
      firstBuild.image.bytes.length > 30_000,
      'fixture is a readable raster, not header bytes',
    );
    assert.ok(firstBuild.pdf.bytes.length > 2_000, 'fixture is a complete laid-out PDF');

    const { profile, recoveryKit } = await newProfile(
      f.manager,
      'Fictional optical ground-truth profile',
    );
    let state = f.manager.opened.get(profile.id)!;
    const uploaded: Array<{
      id: string;
      bytes: Buffer;
      sha256: string;
      filename: string;
    }> = [];

    for (const expected of EXPECTED_OPTICAL_RECORDS) {
      const source = firstBuild[expected.source];
      let item = profileCall(state, profile.id, uploadIntake, {
        filename: source.filename,
        mimeType: source.mimeType,
        bytes: source.bytes,
        newProviderName: expected.sourceSystem,
      });
      uploaded.push({
        id: item.id,
        bytes: source.bytes,
        sha256: source.sha256,
        filename: source.filename,
      });

      const evidence = (await readIntakeEvidence({
        db: state.db,
        root: state.root,
        profileId: profile.id,
        id: item.id,
        page: 1,
      })) as unknown as {
        imageContent: string;
        metadata: {
          caution: string;
          original: { text: string; totalPages?: number };
        };
      };
      const previewMimeType = source.mimeType === 'application/pdf' ? 'image/png' : source.mimeType;
      assert.ok(evidence.imageContent.startsWith(`data:${previewMimeType};base64,`));
      if (expected.source === 'image') {
        const { loadImage } = await import('@napi-rs/canvas');
        const rendered = await loadImage(
          Buffer.from(
            evidence.imageContent.slice(evidence.imageContent.indexOf(',') + 1),
            'base64',
          ),
        );
        assert.deepEqual([rendered.width, rendered.height], [1200, 800]);
        assert.match(evidence.metadata.caution, /original image retained/i);
      } else {
        assert.match(evidence.metadata.original.text, /Elian Frost/);
        assert.match(evidence.metadata.original.text, /-2\.25/);
        assert.match(evidence.metadata.original.text, /003/);
        assert.match(evidence.metadata.original.text, /SPH\/CYL units are not printed/);
        assert.equal(evidence.metadata.original.totalPages, 1);
      }

      const controlled = controlledOpticalProposal({
        source: expected.source,
        sourceFileId: item.id,
        filename: source.filename,
      });
      item = profileCall(state, profile.id, proposeConversion, item.id, {
        version: item.version,
        jsonlText: JSON.stringify(controlled),
        summary:
          'Controlled image-capable provider fixture inspected the actual rendered source and prepared one reviewable optical proposal; no real-model inference is claimed.',
      });
      const proposalId = item.proposals[0]!.id;
      let review = profileCall(state, profile.id, reviewIntake, item.id, proposalId);
      const record = review.records[0]!;
      assert.equal(record.mapping.subject, 'self');
      assert.equal(record.identityReview?.status, 'missing_warning');
      assert.deepEqual(record.mapping.opticalPrescription, expected.prescription);
      const identityIssue = record.issues.find((issue) => issue.kind === 'identity');
      const dateIssue = record.issues.find((issue) => issue.kind === 'date');
      assert.ok(identityIssue);
      assert.ok(dateIssue);
      assert.equal(dateIssue.choices?.length, expected.source === 'image' ? undefined : 1);
      item = profileCall(state, profile.id, saveIntakeReviewDraft, item.id, {
        version: item.version,
        operationId: `review-${expected.sourceRecordId}`,
        proposalId,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId,
        resolutions: [
          {
            issueId: dateIssue.id,
            outcome: 'confirmed',
            mapping: { date: expected.reviewedDate, documentDate: expected.reviewedDate },
          },
        ],
      });
      review = profileCall(state, profile.id, reviewIntake, item.id, proposalId);
      assert.equal(
        review.records[0]!.issues.filter((issue) => issue.blocking).every(
          (issue) => issue.status === 'resolved',
        ),
        true,
        JSON.stringify(review.records[0]!.issues, null, 2),
      );
      item = profileCall(state, profile.id, importIntake, item.id, {
        version: review.version,
        proposalId,
        reviewToken: review.reviewToken,
        decisions: [{ recordId: record.id, action: 'accept', mapping: {} }],
      });
      assert.equal(item.imported.clinical.added, 1);
      const [acceptedRecord] = item.imported.clinical.records;
      assert.equal(
        acceptedRecord.identityAttribution!.basis,
        'reviewed_active_profile_missing_identity',
      );
      const { identityAttribution: _identityAttribution, ...acceptedRecordWithoutIdentity } =
        acceptedRecord;
      assert.deepEqual(
        [acceptedRecordWithoutIdentity],
        [
          {
            recordId: record.id,
            entityId: item.imported.clinical.records[0]!.entityId,
            kind: 'document',
            title: expected.documentTitle,
            optical: true,
            outcome: 'added',
          },
        ],
      );
    }

    const before = visionPrescriptions(state.db, new URLSearchParams());
    assert.equal(before.total, 2);
    assert.deepEqual(evaluateOpticalGroundTruth(before.data), { ok: true, failures: [] });
    for (const expected of EXPECTED_OPTICAL_RECORDS) {
      const record = before.data.find((entry) => entry.title === expected.documentTitle)!;
      const raw = JSON.parse(
        String(
          state.db
            .prepare('SELECT raw_json FROM source_records WHERE id=?')
            .get(record.sourceRecordId)!.raw_json,
        ),
      );
      assert.equal(raw.provenance.sourceRecordId, expected.sourceRecordId);
      assert.equal(raw.provenance.sourceSystem, expected.sourceSystem);
      assert.equal(
        state.db.prepare('SELECT count(*) AS n FROM attachments WHERE owner_id=?').get(record.id)!
          .n,
        1,
      );
      assert.equal(
        visionPrescriptions(state.db, new URLSearchParams({ documentId: record.id })).total,
        1,
        'the accepted receipt entity ID resolves to its exact Vision DTO',
      );
      for (const eye of record.opticalPrescription.eyes) {
        assert.equal(eye.sph?.unit, undefined);
        assert.equal(eye.cyl?.unit, undefined);
        assert.equal(eye.axis?.unit, undefined);
      }
    }

    for (const original of uploaded) {
      const row = state.db.prepare('SELECT path FROM source_files WHERE id=?').get(original.id)!;
      const retained = readFileSync(profileOriginal(state.root, row.path, profile.id));
      assert.deepEqual(retained, original.bytes);
      assert.equal(createHash('sha256').update(retained).digest('hex'), original.sha256);
    }

    f.manager.lock(profile.id);
    rmSync(resolve(f.dataDirectory, 'profiles', profile.id, 'cache'), {
      recursive: true,
      force: true,
    });
    f.manager.unlock(profile.id, recoveryKit);
    state = f.manager.opened.get(profile.id)!;
    assert.equal(state.metrics.cacheHit, false);
    const rebuilt = visionPrescriptions(state.db, new URLSearchParams());
    assert.deepEqual(rebuilt, before);
    assert.deepEqual(evaluateOpticalGroundTruth(rebuilt.data), { ok: true, failures: [] });
    for (const original of uploaded) {
      const row = state.db.prepare('SELECT path FROM source_files WHERE id=?').get(original.id)!;
      const retained = readFileSync(profileOriginal(state.root, row.path, profile.id));
      assert.equal(createHash('sha256').update(retained).digest('hex'), original.sha256);
      assert.deepEqual(
        retained,
        original.bytes,
        `${original.filename} survives rebuild byte-for-byte`,
      );
    }
  },
);

test('optical schema rejects numeric coercion, unknown fields and nonliteral units; drafts preserve nested values', () => {
  assert.equal(opticalPrescriptionProblem(optical), null);
  const topLevel = topLevelEnvelope();
  assert.deepEqual(mappingFrom({ value: topLevel }).opticalPrescription, optical);
  assert.equal(
    mappingFrom({ value: { ...topLevel, clinical: { opticalPrescription: null } } })
      .opticalPrescription,
    null,
  );
  assert.equal(
    mappingFrom({
      value: { ...topLevel, kind: 'medication' } as unknown as HealthRecordEnvelope,
    }).opticalPrescription,
    undefined,
  );
  assert.match(
    checkClinicalMapping(
      mappingFrom({ value: { ...topLevel, opticalPrescription: { type: 'bad' } } }),
    )!,
    /requires a supported type/,
  );
  for (const kind of ['observation', 'medication', 'procedure'] as const) {
    const entry = envelope('wrong-kind');
    entry.clinical!.kind = kind;
    assert.match(
      checkClinicalMapping(mappingFrom({ value: entry }))!,
      /separate from medications and examination findings/,
    );
  }
  assert.deepEqual(validateDraftMapping({ opticalPrescription: optical }), {
    opticalPrescription: optical,
  });
  for (const invalid of [
    { ...optical, inferredEquivalent: true },
    { ...optical, typeText: '' },
    { ...optical, statusText: '   ' },
    { ...optical, statusText: 1 },
    { ...optical, eyes: [{ side: 'OD', sph: { valueText: '1.0' } }] },
    { ...optical, eyes: [{ side: 'right', sph: { valueText: 1 } }] },
    { ...optical, pd: { valueText: '063', unit: 1 } },
  ]) {
    assert.ok(opticalPrescriptionProblem(invalid));
    assert.throws(() => validateDraftMapping({ opticalPrescription: invalid }), {
      code: 'IMPORT_MAPPING',
    });
  }
});

test('an older accepted plain document can append its missing optical projection after explicit review', async (t) => {
  const f = vaultFixture(t);
  const { profile } = await newProfile(f.manager, 'Fictional legacy optical acceptance');
  const state = f.manager.opened.get(profile.id)!;
  const bytes = Buffer.from(JSON.stringify(topLevelEnvelope()));
  let item = profileCall(state, profile.id, uploadIntake, {
    filename: 'fictional-legacy.jsonl',
    bytes,
  });
  item = profileCall(state, profile.id, importIntake, item.id, { version: item.version });
  let review = profileCall(state, profile.id, reviewIntake, item.id);
  const record = review.records[0];
  item = profileCall(state, profile.id, saveIntakeReviewDraft, item.id, {
    version: item.version,
    operationId: 'legacy-self-review',
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId,
    resolutions: record.issues
      .filter((issue) => issue.kind === 'identity')
      .map((issue) => ({ issueId: issue.id, outcome: 'this_is_me' })),
  });
  review = profileCall(state, profile.id, reviewIntake, item.id);
  // Reconstruct an older software acceptance: that projector received the
  // reviewed document mapping with top-level optical data silently omitted.
  // Use the real projector/decision journal to retain a fictional legacy state,
  // then exercise the current public draft and acceptance path for the repair.
  const legacyReview = structuredClone(review);
  delete legacyReview.records[0].mapping.opticalPrescription;
  const decisions: NonNullable<Parameters<typeof importIntake>[4]['decisions']> = [
    { recordId: record.id, action: 'accept', mapping: {} },
  ];
  transaction(state.db, () => {
    const file = state.db.prepare('SELECT * FROM source_files WHERE id=?').get(item.id)!;
    const all = JSON.parse(String(file.details_json));
    const clinical = projectClinicalReview(state.db, {
      file,
      inputFile: file,
      entries: validateJSONL(bytes).entries!,
      review: legacyReview,
      decisions,
      root: state.root,
      profileId: profile.id,
    } as unknown as Parameters<typeof projectClinicalReview>[1]);
    saveWorkflowDecisions(
      file as unknown as Parameters<typeof saveWorkflowDecisions>[0],
      all.intake,
      legacyReview,
      decisions,
    );
    all.intake.imported.clinical = clinical;
    all.intake.lastReviewToken = legacyReview.reviewToken;
    state.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(JSON.stringify(all), item.id);
  });
  const legacyDocument = state.db.prepare('SELECT * FROM documents').get()!;
  const legacyIntake = profileCall(state, profile.id, getIntake, item.id);
  const legacyDecisions = structuredClone(legacyIntake.workflow.decisions);
  const rawRows = state.db.prepare('SELECT id,raw_json FROM source_records ORDER BY id').all();
  assert.equal(visionPrescriptions(state.db, new URLSearchParams()).total, 0);
  review = profileCall(state, profile.id, reviewIntake, item.id);
  assert.equal(review.records[0].reviewState, 'pending');
  assert.equal(review.records[0].projectionUpgrade, true);
  assert.equal(review.records[0].classification, 'addition');
  assert.equal(
    state.db.prepare('SELECT count(*) AS n FROM documents').get()!.n,
    1,
    'reading the review never upgrades accepted data',
  );
  item = profileCall(state, profile.id, saveIntakeReviewDraft, item.id, {
    version: review.version,
    operationId: 'explicit-optical-upgrade',
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId,
    mapping: { opticalPrescription: optical },
  });
  review = profileCall(state, profile.id, reviewIntake, item.id);
  item = profileCall(state, profile.id, importIntake, item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions,
  });
  assert.equal(item.imported.clinical.added, 1);
  assert.equal(item.imported.clinical.versions, 1);
  assert.equal(item.imported.clinical.records[0].outcome, 'updated');
  assert.equal(visionPrescriptions(state.db, new URLSearchParams()).total, 1);
  assert.deepEqual(
    state.db.prepare('SELECT * FROM documents WHERE id=?').get(legacyDocument.id)!,
    legacyDocument,
  );
  assert.deepEqual(item.importHistory.at(-1)!.clinical, legacyIntake.imported.clinical);
  assert.deepEqual(item.workflow.decisions.slice(0, legacyDecisions.length), legacyDecisions);
  assert.deepEqual(
    state.db.prepare('SELECT id,raw_json FROM source_records ORDER BY id').all(),
    rawRows,
  );
  assert.equal(
    profileCall(state, profile.id, reviewIntake, item.id).records[0].reviewState,
    'accepted',
  );
});

test('retained proposedClinicalMapping dates and payload optical data survive a missing-identity warning and encrypted rebuild', async (t) => {
  const f = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(f.manager, 'Fictional proposed mapping');
  let state = f.manager.opened.get(profile.id)!;
  const { opticalPrescription, reviewIssues, ...topLevel } = topLevelEnvelope();
  const literal = {
    ...topLevel,
    payload: {
      transcription: 'Fictional optical order.',
      patient: { name: 'Robin Example', birthDateText: 'fictional unknown' },
      opticalPrescription,
    },
    proposedClinicalMapping: {
      kind: 'document',
      subject: 'unknown',
      label: 'Fictional spectacle order',
      documentTitle: 'Fictional spectacle order',
      date: '2026-05-17',
      documentDate: '2026-05-17',
      eventKind: 'order',
      reviewIssues: [{ kind: 'information', prompt: 'Fictional supplied optical note' }],
      uncertainties: ['Fictional optical coverage is partial'],
    },
  };
  const bytes = Buffer.from(JSON.stringify(literal));
  let item = profileCall(state, profile.id, uploadIntake, {
    filename: 'fictional-proposed-mapping.jsonl',
    bytes,
  });
  let review = profileCall(state, profile.id, reviewIntake, item.id);
  assert.equal(review.records[0].mapping.subject, 'self');
  assert.equal(review.records[0].identityReview?.status, 'missing_warning');
  assert.equal(review.records[0].mapping.date, '2026-05-17');
  assert.equal(review.records[0].mapping.documentDate, '2026-05-17');
  assert.equal(review.records[0].mapping.eventKind, 'order');
  assert.equal(review.records[0].mapping.documentTitle, 'Fictional spectacle order');
  assert.deepEqual(review.records[0].mapping.opticalPrescription, optical);
  assert.equal(
    review.records[0].issues.some((issue) => issue.kind === 'date'),
    false,
  );
  assert.ok(
    review.records[0].issues.some((issue) => issue.prompt === 'Fictional supplied optical note'),
  );
  assert.ok(
    review.records[0].issues.some(
      (issue) => issue.prompt === 'Fictional optical coverage is partial',
    ),
  );
  assert.equal(state.db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 0);
  const rebuild = () => {
    f.manager.lock(profile.id);
    rmSync(resolve(f.dataDirectory, 'profiles', profile.id, 'cache'), {
      recursive: true,
      force: true,
    });
    f.manager.unlock(profile.id, recoveryKit);
    state = f.manager.opened.get(profile.id)!;
    assert.equal(state.metrics.cacheHit, false);
  };
  rebuild();
  assert.equal(state.db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 0);
  review = profileCall(state, profile.id, reviewIntake, item.id);
  assert.equal(review.records[0].mapping.subject, 'self');
  assert.equal(review.records[0].mapping.documentDate, '2026-05-17');
  item = profileCall(state, profile.id, importIntake, item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0].id, action: 'accept', mapping: {} }],
  });
  const vision = visionPrescriptions(state.db, new URLSearchParams());
  assert.equal(vision.total, 1);
  assert.equal(vision.data[0].date, '2026-05-17');
  assert.equal(vision.data[0].title, 'Fictional spectacle order');
  assert.deepEqual(vision.data[0].opticalPrescription, optical);
  assert.equal(
    state.db.prepare('SELECT text_content FROM documents').get()!.text_content,
    JSON.stringify(literal.payload),
  );
  assert.equal(
    state.db.prepare('SELECT raw_json FROM source_records').get()!.raw_json,
    bytes.toString(),
  );
  rebuild();
  assert.deepEqual(visionPrescriptions(state.db, new URLSearchParams()), vision);
  assert.deepEqual(profileCall(state, profile.id, getIntake, item.id).imported, item.imported);
});

test('canonical clinical fields override proposed mappings and malformed optical/date fields remain unsupported', () => {
  const literal = topLevelEnvelope();
  literal.proposedClinicalMapping = {
    kind: 'document',
    subject: 'unknown',
    documentTitle: 'Proposed title',
    documentDate: '2026-05-17',
    opticalPrescription: optical,
    reviewIssues: [{ kind: 'uncertain_reading', prompt: 'Confirm the obsolete proposal note' }],
    uncertainties: ['Confirm the obsolete proposal reading'],
  };
  let mapping = mappingFrom({ value: literal });
  assert.equal(mapping.documentDate, '2026-05-17');
  assert.deepEqual(mapping.opticalPrescription, optical);
  literal.clinical = {
    kind: 'document',
    subject: 'unknown',
    documentTitle: 'Canonical title',
    documentDate: '2026-06-18',
    opticalPrescription: null,
  };
  mapping = mappingFrom({ value: literal });
  assert.equal(mapping.documentTitle, 'Canonical title');
  assert.equal(mapping.documentDate, '2026-06-18');
  assert.equal(mapping.opticalPrescription, null);
  assert.equal(
    fixtureIssuesFor({ mapping, uncertainties: [] }, { value: literal }).some((issue) =>
      issue.prompt.includes('obsolete'),
    ),
    false,
  );
  delete literal.clinical;
  literal.proposedClinicalMapping!.opticalPrescription = {
    ...optical,
    eyes: [{ side: 'right', sph: { valueText: 1 as unknown as string } }],
  };
  assert.match(checkClinicalMapping(mappingFrom({ value: literal }))!, /literal value text/);
  literal.proposedClinicalMapping = {
    kind: 'document',
    subject: 'self',
    documentDate: 'not-a-date',
    opticalPrescription: optical,
  };
  assert.match(checkClinicalMapping(mappingFrom({ value: literal }))!, /date is invalid/);
});

test('explicitly clearing an optical projection remains accepted and does not reopen as a legacy omission', async (t) => {
  const f = vaultFixture(t);
  const { profile } = await newProfile(f.manager, 'Fictional explicitly cleared optics');
  const state = f.manager.opened.get(profile.id)!;
  const literal = { ...topLevelEnvelope(), subject: 'self', reviewIssues: [] };
  const item = uploadIntake(state.db, state.root, profile.id, {
    filename: 'fictional-cleared-optical.jsonl',
    bytes: Buffer.from(JSON.stringify(literal)),
  });
  let review = reviewIntake(state.db, state.root, profile.id, item.id);
  const accepted = profileCall(state, profile.id, importIntake, item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [
      { recordId: review.records[0].id, action: 'accept', mapping: { opticalPrescription: null } },
    ],
  });
  review = reviewIntake(state.db, state.root, profile.id, item.id);
  assert.equal(review.records[0].reviewState, 'accepted');
  assert.equal(review.records[0].projectionUpgrade, false);
  assert.equal(review.records[0].mapping.opticalPrescription, null);
  assert.equal(accepted.imported.clinical.records[0].optical, false);
  assert.equal(visionPrescriptions(state.db, new URLSearchParams()).total, 0);
});

test('reviewed literal optical occurrences, corrections and indexed history survive encrypted cache loss', async (t) => {
  const f = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(f.manager, 'Fictional vision history');
  let state = f.manager.opened.get(profile.id)!;
  const accept = async (rows: TestEnvelope[], filename: string) => {
    const scopedRows = rows.map((row) => ({
      ...row,
      payload: {
        ...(row.payload as Record<string, unknown>),
        header: 'Fictional optical history report',
        patient: 'Patient: Fictional Iris Cedar',
      },
      report: {
        key: 'fictional-optical-history',
        title: 'Fictional optical history report',
        anchor: { locator: 'row 1 report heading', text: 'Fictional optical history report' },
        subject: { locator: 'row 1 patient', text: 'Patient: Fictional Iris Cedar' },
      },
    }));
    const intake = uploadIntake(state.db, state.root, profile.id, {
      filename,
      newProviderName: 'Fictional optician',
      bytes: Buffer.from(scopedRows.map((row) => JSON.stringify(row)).join('\n')),
    });
    const scope = await getIntakeIdentityScope(
      state.db,
      state.root,
      profile.id,
      intake.id,
      intake.workflow!.reportGroups![0]!.id,
    );
    await confirmIntakeIdentityScope(state.db, state.root, profile.id, intake.id, {
      version: scope.intakeVersion,
      operationId: `fictional-optical-scope-${intake.id}`,
      scope,
      outcome: 'this_is_me',
      attestation: 'reviewed_original_and_membership',
    });
    const review = reviewIntake(state.db, state.root, profile.id, intake.id);
    const before = visionPrescriptions(state.db, new URLSearchParams()).total;
    importIntake(state.db, state.root, profile.id, intake.id, {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: review.records.map((record) => ({
        recordId: record.id,
        action: 'accept',
        mapping: {},
      })),
    });
    return before;
  };
  assert.equal(await accept([envelope('one'), envelope('two')], 'fictional-first.jsonl'), 0);
  assert.equal(
    visionPrescriptions(state.db, new URLSearchParams()).total,
    2,
    'equal date/value entries remain distinct',
  );
  await accept([envelope('one')], 'fictional-copy.jsonl');
  let result = visionPrescriptions(state.db, new URLSearchParams());
  assert.equal(result.total, 3, 'a separate source occurrence remains visible');
  assert.equal(new Set(result.data.map((row) => row.sourceRecordId)).size, 3);
  assert.equal(result.data[0].date, null);
  assert.deepEqual(result.data[0].opticalPrescription, optical);
  assert.equal(visionPrescriptions(state.db, new URLSearchParams({ q: '+01.00' })).total, 3);
  assert.equal(visionPrescriptions(state.db, new URLSearchParams({ q: 'Released copy' })).total, 3);
  assert.equal(visionPrescriptions(state.db, new URLSearchParams({ q: 'no match' })).total, 0);
  assert.equal(visionPrescriptions(state.db, new URLSearchParams({ from: '2026' })).total, 0);
  assert.equal(state.db.prepare('SELECT count(*) AS n FROM medications').get()!.n, 0);
  assert.equal(state.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 0);
  const recordId = result.data[0].id;
  const originalRows = state.db.prepare('SELECT id,raw_json FROM source_records ORDER BY id').all();
  const changed = {
    ...optical,
    eyes: [{ ...optical.eyes[0], sph: { valueText: '+01.25' } }, optical.eyes[1]],
  };
  const input = {
    kind: 'document',
    recordId,
    set: { opticalPrescription: changed },
    reason: 'Reviewed fictional transcription correction',
  };
  const preview = previewRecordCorrection(state.db, input);
  applyClinicalDecision(state.db, state.root, profile.id, 'clinical_correction', {
    ...input,
    previewToken: preview.token,
    version: preview.version,
    operationId: 'fictional-optical-correction',
  } as Parameters<typeof applyClinicalDecision>[4]);
  result = visionPrescriptions(state.db, new URLSearchParams());
  const history = clinicalRecordHistory(state.db, {
    profileId: profile.id,
    kind: 'document',
    recordId,
  });
  assert.ok(history.entries.length >= 2);
  assert.ok(JSON.stringify(history).includes('+01.00'));
  assert.ok(JSON.stringify(history).includes('+01.25'));
  assert.deepEqual(
    state.db.prepare('SELECT id,raw_json FROM source_records ORDER BY id').all(),
    originalRows,
  );
  f.manager.lock(profile.id);
  rmSync(resolve(f.dataDirectory, 'profiles', profile.id, 'cache'), {
    recursive: true,
    force: true,
  });
  f.manager.unlock(profile.id, recoveryKit);
  state = f.manager.opened.get(profile.id)!;
  assert.equal(state.metrics.cacheHit, false);
  assert.deepEqual(visionPrescriptions(state.db, new URLSearchParams()), result);
  assert.deepEqual(
    clinicalRecordHistory(state.db, { profileId: profile.id, kind: 'document', recordId }),
    history,
  );
  assert.deepEqual(
    state.db.prepare('SELECT id,raw_json FROM source_records ORDER BY id').all(),
    originalRows,
  );
});
