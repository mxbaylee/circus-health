import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../database.ts';
import type { Database, SqliteRow } from '../database.ts';
import type { Intake } from '../../shared/intake.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  getIntakeOriginal,
  getIntake,
  importIntake,
  proposeConversion,
  reviewIntake,
  saveIntakeReviewDraft,
  uploadIntake,
} from '../intake.ts';
import { indexIntakePackage, readIntakePackageMember } from '../intake-package.ts';
import { readIntakeEvidence } from '../intake-evidence.ts';
import { attachments } from '../notes.ts';
import { rebuildProfile } from '../portable.ts';
import { clinicalList, evidenceFor, observations } from '../queries.ts';
import {
  buildGroundTruthSources,
  groundTruthEnvelopes,
  IMPORT_GROUND_TRUTH,
  FIXTURE_PROVIDER,
} from '../../tests/fixtures/import-ground-truth.ts';
import {
  evaluateImportGroundTruth,
  parseProviderOutput,
} from '../../tests/fixtures/import-ground-truth-evaluator.ts';

interface OpticalPrescription {
  eyes: Array<{
    sph: { valueText: string; unit?: string };
    prism?: { valueText: string };
  }>;
}
interface GroundTruthEnvelope {
  format: string;
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  clinical: Record<string, unknown> & {
    kind: string;
    assets: string[];
    opticalPrescription?: OpticalPrescription;
    valueText?: string;
    eventKind?: string;
  };
  provenance: { sourceSystem: string; sourceRecordId: string; locator: string };
  reviewIssues?: unknown[];
}

function temporary(t: TestContext, prefix: string) {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function acceptProposal(
  db: Database,
  root: string,
  profileId: string,
  intake: Intake,
  envelopes: GroundTruthEnvelope[],
  summary: string,
  options: { forceAccept?: boolean; beforeImport?: () => void } = {},
) {
  const proposed = proposeConversion(db, root, profileId, intake.id, {
    version: intake.version,
    jsonlText: envelopes.map((value) => JSON.stringify(value)).join('\n'),
    summary,
  });
  const proposalId = proposed.proposals.at(-1)?.id;
  assert.ok(proposalId);
  let current = proposed;
  let review = reviewIntake(db, root, profileId, intake.id, proposalId);
  for (const record of review.records) {
    const identity = record.issues?.find(
      (issue) => issue.kind === 'identity' && issue.status !== 'resolved',
    );
    if (!identity) continue;
    assert.ok(record.candidateVersionId);
    current = saveIntakeReviewDraft(db, root, profileId, intake.id, {
      version: current.version,
      operationId: `confirm-ground-truth-self-${record.id}`,
      proposalId,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId,
      resolutions: [{ issueId: identity.id, outcome: 'this_is_me', mapping: { subject: 'self' } }],
    });
  }
  review = reviewIntake(db, root, profileId, intake.id, proposalId);
  options.beforeImport?.();
  return importIntake(db, root, profileId, intake.id, {
    version: review.version,
    proposalId,
    reviewToken: review.reviewToken,
    decisions: review.records.map((record) => ({
      recordId: record.id,
      action: !options.forceAccept && record.classification === 'unsupported' ? 'skip' : 'accept',
      mapping: record.mapping,
    })),
  });
}

function acceptedQueries(db: Database) {
  const withEvidence = <T extends { id: string }>(kind: string, value: T) => ({
    ...value,
    evidence: evidenceFor(db, kind, value.id),
    attachments: attachments(db, kind, value.id),
  });
  return {
    observations: observations(db, new URLSearchParams({ visibility: 'all' }), true).data.map(
      (value) => withEvidence('observation', value),
    ),
    medications: clinicalList(db, 'medications', new URLSearchParams({ status: 'all' })).data.map(
      (value) => withEvidence('medication', value),
    ),
    procedures: clinicalList(
      db,
      'procedures',
      new URLSearchParams({ category: 'all', visibility: 'all' }),
    ).data.map((value) => withEvidence('procedure', value)),
    documents: db
      .prepare(
        'SELECT d.*,p.name provider_name FROM documents d LEFT JOIN providers p ON p.id=d.provider_id ORDER BY d.id',
      )
      .all()
      .map((row: SqliteRow) => ({
        id: String(row.id),
        title: row.title,
        date: row.effective_at,
        provider: row.provider_name,
        sourceRecordId: row.source_record_id,
        extra: JSON.parse(String(row.extra_json)) as Record<string, unknown>,
        evidence: evidenceFor(db, 'document', String(row.id)),
        attachments: attachments(db, 'document', String(row.id)),
      })),
  };
}

test('fictional PDF/ZIP artifacts are reproducible and the evaluator rejects plausible partial output', (t) => {
  const first = buildGroundTruthSources(join(temporary(t, 'circus-ground-truth-a-'), 'out'));
  const second = buildGroundTruthSources(join(temporary(t, 'circus-ground-truth-b-'), 'out'));
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(first.pdf, readFileSync(first.pdfPath));
  assert.equal(first.manifest.zipMembers[2].sha256, first.manifest.files[0].sha256);

  const ideal = groundTruthEnvelopes() as unknown as GroundTruthEnvelope[];
  const retainedUnsupported = {
    format: 'health-record-v1',
    id: 'retained-untrusted-text',
    kind: 'record',
    payload: { text: 'Instruction was retained as inert evidence' },
    provenance: {
      sourceSystem: IMPORT_GROUND_TRUTH.sourceSystem,
      sourceRecordId: 'gt-unsupported-instruction',
      locator: 'ZIP member untrusted/instructions.txt',
    },
  };
  const report = evaluateImportGroundTruth(
    parseProviderOutput(
      [...ideal, retainedUnsupported].map((value) => JSON.stringify(value)).join('\n'),
    ),
  );
  assert.equal(report.passed, true, JSON.stringify(report.failures, null, 2));
  assert.equal(report.score, 1);
  assert.deepEqual(report.summary.unmatchedRecords, []);

  const reviewDto = {
    records: ideal.map((value) => ({
      mapping: {
        ...value.clinical,
        sourceSystem: value.provenance.sourceSystem,
        sourceRecordId: value.provenance.sourceRecordId,
      },
      payload: value.payload,
      evidence: [
        {
          locator: value.provenance.locator,
          contentUrl: `/api/sources/${encodeURIComponent(value.clinical.assets[0])}/content`,
        },
      ],
      issues: value.reviewIssues || [],
    })),
  };
  assert.equal(evaluateImportGroundTruth(reviewDto).passed, true);

  const semanticTiming = structuredClone(ideal);
  for (const value of semanticTiming.filter((item) => item.clinical.kind === 'observation')) {
    value.clinical.date = '2026-04-09T08:05';
    value.payload = {
      retainedLiteralEvidence: [
        'Panel gt-panel-bmp — Basic Metabolic Panel',
        'order 2026-04-08',
        'collected 2026-04-09 08:05',
        'final 2026-04-09 10:15',
      ],
    };
  }
  assert.equal(
    evaluateImportGroundTruth(semanticTiming).passed,
    true,
    'collection time is a supported clinical date when both timestamp roles remain explicit in arbitrarily shaped payload evidence',
  );

  const swappedTimingRoles = structuredClone(semanticTiming);
  for (const value of swappedTimingRoles.filter((item) => item.clinical.kind === 'observation'))
    value.payload.retainedLiteralEvidence = [
      'Panel gt-panel-bmp — Basic Metabolic Panel',
      'order 2026-04-08',
      'collected 2026-04-09 10:15',
      'final 2026-04-09 08:05',
    ];
  assert.ok(
    evaluateImportGroundTruth(swappedTimingRoles).failures.some(
      (failure) =>
        failure.category === 'field_accuracy' && failure.detail.includes('timestamp role'),
    ),
    'supported timestamps still fail when collection and result roles are reversed',
  );

  const literalStatusVariant = structuredClone(ideal);
  for (const value of literalStatusVariant) {
    if (value.provenance.sourceRecordId.startsWith('gt-lab-')) {
      value.clinical.status = 'FINAL';
      value.clinical.observationCategory = 'laboratory';
    } else if (value.provenance.sourceRecordId === 'gt-procedure-performed')
      value.clinical.status = 'PERFORMED';
    else if (value.provenance.sourceRecordId === 'gt-procedure-planned')
      value.clinical.status = 'NOT PERFORMED';
    else if (value.provenance.sourceRecordId === 'gt-medication-historical-order')
      value.clinical.status = 'STOPPED';
    else if (value.provenance.sourceRecordId === 'gt-visit-document')
      delete value.clinical.eventKind;
  }
  assert.equal(
    evaluateImportGroundTruth(literalStatusVariant).passed,
    true,
    'literal source statuses and an unstated visit event kind preserve the required classifications',
  );

  const badDuplicate = structuredClone(ideal);
  const duplicate = badDuplicate.find(
    (value) =>
      value.provenance.sourceRecordId === 'gt-lab-sodium' &&
      value.provenance.locator.startsWith('ZIP member'),
  );
  assert.ok(duplicate);
  duplicate.clinical.valueText = '999';
  assert.ok(
    evaluateImportGroundTruth(badDuplicate).failures.some(
      (failure) => failure.category === 'literal_fidelity',
    ),
    'every retained occurrence is graded, including the second exact-byte source copy',
  );

  const wrongAssets = structuredClone(ideal);
  for (const value of wrongAssets) value.clinical.assets = ['wrong-retained-file'];
  assert.ok(
    evaluateImportGroundTruth(wrongAssets).failures.some(
      (failure) => failure.category === 'source_occurrence',
    ),
    'a locator cannot make an unrelated asset count as its supplied original',
  );

  const nestedClaim = structuredClone(ideal);
  const opticalClaim = nestedClaim.find(
    (value) => value.provenance.sourceRecordId === 'gt-optical-prescription',
  );
  assert.ok(opticalClaim?.clinical.opticalPrescription?.eyes[0]);
  opticalClaim.clinical.opticalPrescription.eyes[0].prism = { valueText: '+01.00' };
  assert.ok(
    evaluateImportGroundTruth(nestedClaim).failures.some(
      (failure) =>
        failure.category === 'unsupported_fields' && failure.detail.includes('prism.valueText'),
    ),
    'unsupported nested clinical claims are rejected',
  );

  const extraOccurrence = structuredClone(ideal);
  extraOccurrence.push({ ...structuredClone(ideal[0]), id: 'third-occurrence' });
  assert.ok(
    evaluateImportGroundTruth(extraOccurrence).failures.some(
      (failure) =>
        failure.category === 'source_occurrence' && failure.detail.includes('received 3'),
    ),
    'a repeated source record identity cannot hide an extra proposal occurrence',
  );

  const flawed = structuredClone(ideal).filter(
    (value) => value.provenance.sourceRecordId !== 'gt-procedure-planned',
  );
  const optical = flawed.find(
    (value) => value.provenance.sourceRecordId === 'gt-optical-prescription',
  );
  assert.ok(optical?.clinical.opticalPrescription?.eyes[0]);
  optical.clinical.documentDate = '2026-07-12';
  optical.clinical.date = '2026-07-12';
  optical.clinical.opticalPrescription.eyes[0].sph.valueText = '1.25';
  optical.clinical.opticalPrescription.eyes[0].sph.unit = 'D';
  optical.clinical.assets = optical.clinical.assets.slice(0, 1);
  const flawedSource = flawed[0];
  assert.ok(flawedSource);
  flawed.push({
    ...structuredClone(flawedSource),
    id: 'invented-from-instruction',
    clinical: { kind: 'document', subject: 'self', documentTitle: 'Invented diagnosis' },
    provenance: {
      ...flawedSource.provenance,
      sourceRecordId: 'gt-unsupported-instruction',
      locator: 'ZIP member untrusted/instructions.txt',
    },
  } as unknown as GroundTruthEnvelope);
  const rejected = evaluateImportGroundTruth(flawed);
  assert.equal(rejected.passed, false);
  assert.ok(rejected.categories.recall.passed < rejected.categories.recall.total);
  assert.ok(rejected.failures.some((failure) => failure.category === 'literal_fidelity'));
  assert.ok(rejected.failures.some((failure) => failure.category === 'unsupported_fields'));
  assert.ok(rejected.failures.some((failure) => failure.category === 'unsupported_projection'));
  assert.ok(rejected.failures.some((failure) => failure.category === 'source_occurrence'));
});

test(
  'representative accepted records survive cache loss while unscoped package copies remain pending',
  { timeout: 15000 },
  async (t) => {
    const root = temporary(t, 'circus-ground-truth-accept-');
    const profileId = 'cookie-dough';
    const paths = ensureProfileDirectories(root, profileId);
    let db = openDatabase(paths.database, profileId);
    t.after(() => {
      try {
        db.close();
      } catch {}
    });
    const sources = buildGroundTruthSources(join(root, 'generated-fixtures'));
    const pdfIntake = uploadIntake(db, root, profileId, {
      filename: 'ground-truth-clinical.pdf',
      newProviderName: FIXTURE_PROVIDER,
      bytes: sources.pdf,
    });
    const zipIntake = uploadIntake(db, root, profileId, {
      filename: 'ground-truth-package.zip',
      providerId: pdfIntake.providerId,
      bytes: sources.zip,
    });
    const inventory = await indexIntakePackage({ db, root, profileId, id: zipIntake.id });
    const copyMember = inventory.members.find(
      (member) => member.filename === 'copies/ground-truth-clinical.pdf',
    );
    assert.ok(copyMember);
    const retainedCopy = await readIntakePackageMember({
      db,
      root,
      profileId,
      id: zipIntake.id,
      memberId: copyMember.memberId,
    });
    const retainedCopyId = retainedCopy.sourceFileId || retainedCopy.metadata?.sourceFileId;
    assert.ok(retainedCopyId);
    assert.deepEqual(getIntakeOriginal(db, root, profileId, retainedCopyId).bytes, sources.pdf);
    const continuedPanel = await readIntakeEvidence({
      db,
      root,
      profileId,
      id: retainedCopyId,
      page: 2,
    });
    const panel = continuedPanel as unknown as { metadata: { original: { text: string } } };
    assert.match(panel.metadata.original.text, /gt-lab-creatinine/);
    assert.match(panel.metadata.original.text, /FINAL result time 2026-04-09 10:15/);
    assert.deepEqual(getIntakeOriginal(db, root, profileId, pdfIntake.id).bytes, sources.pdf);
    assert.deepEqual(getIntakeOriginal(db, root, profileId, zipIntake.id).bytes, sources.zip);

    const all = groundTruthEnvelopes({
      pdf: pdfIntake.id,
      zipCopy: retainedCopyId,
      optical: 'unused-optical',
      scan: 'unused-scan',
    }) as unknown as GroundTruthEnvelope[];
    const originalEvents = all.filter((value) =>
      value.provenance.locator.startsWith('ground-truth-clinical.pdf'),
    );
    const repeatedEvents = all.filter((value) =>
      value.provenance.locator.startsWith('ZIP member copies/ground-truth-clinical.pdf'),
    );
    acceptProposal(db, root, profileId, pdfIntake, originalEvents, 'Fictional PDF ground truth');
    const firstAccepted = acceptedQueries(db);
    let pendingBefore: unknown;
    assert.throws(
      () =>
        acceptProposal(
          db,
          root,
          profileId,
          zipIntake,
          repeatedEvents,
          'Fictional ZIP copy ground truth',
          {
            forceAccept: true,
            beforeImport: () => {
              pendingBefore = db
                .prepare('SELECT details_json FROM source_files WHERE id=?')
                .get(zipIntake.id);
            },
          },
        ),
      { code: 'CLINICAL_SOURCE_SCOPE_COLLISION' },
    );
    assert.deepEqual(acceptedQueries(db), firstAccepted);
    assert.deepEqual(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(zipIntake.id),
      pendingBefore,
    );
    const pending = getIntake(db, root, profileId, zipIntake.id);
    const pendingProposalId = pending.proposals.at(-1)!.id;
    const pendingReview = reviewIntake(db, root, profileId, zipIntake.id, pendingProposalId);
    assert.equal(pendingReview.records.length, repeatedEvents.length);
    assert.equal(
      pendingReview.records.filter((record) => record.reviewState === 'accepted').length,
      0,
    );

    assert.equal(db.prepare('SELECT count(*) n FROM observations').get()?.n, 3);
    assert.equal(db.prepare('SELECT count(*) n FROM procedures').get()?.n, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM medications').get()?.n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM documents').get()?.n, 1);
    assert.equal(
      db.prepare('SELECT count(*) n FROM evidence').get()?.n,
      7,
      'The unscoped package proposal does not attach a second clinical occurrence',
    );

    const acceptedTruth = {
      ...IMPORT_GROUND_TRUTH,
      records: IMPORT_GROUND_TRUTH.records.filter(
        (record) => record.sourceRecordId !== 'gt-optical-prescription',
      ),
    };
    const before = acceptedQueries(db);
    const acceptedReport = evaluateImportGroundTruth(
      { queries: before },
      {
        stage: 'accepted',
        truth: acceptedTruth,
      },
    );
    assert.equal(
      acceptedReport.passed,
      false,
      'The unchanged multi-occurrence oracle remains an open migration gate',
    );
    assert.ok(
      acceptedReport.failures.length > 0 &&
        acceptedReport.failures.every((failure) => failure.category === 'source_occurrence'),
      JSON.stringify(acceptedReport.failures, null, 2),
    );
    const historicalMedication = before.medications.find((value) => {
      const extra = value.extra as {
        import?: { acceptedMapping?: { sourceRecordId?: string } };
      };
      return extra.import?.acceptedMapping?.sourceRecordId === 'gt-medication-historical-order';
    });
    assert.equal(historicalMedication?.currentStatus, 'not_current');

    db.close();
    rmSync(paths.database, { force: true });
    rmSync(paths.database + '-wal', { force: true });
    rmSync(paths.database + '-shm', { force: true });
    assert.equal(existsSync(paths.database), false);
    const rebuilt = rebuildProfile(root, profileId, resolve(root, 'rebuilt'));
    db = openDatabase(rebuilt.database, profileId);
    const after = acceptedQueries(db);
    assert.deepEqual(after, before);
    const rebuiltReport = evaluateImportGroundTruth(
      { queries: after },
      {
        stage: 'accepted',
        truth: acceptedTruth,
      },
    );
    assert.equal(rebuiltReport.passed, false);
    assert.deepEqual(rebuiltReport.failures, acceptedReport.failures);
    const rebuiltRoot = resolve(root, 'rebuilt');
    const rebuiltReview = reviewIntake(db, rebuiltRoot, profileId, zipIntake.id, pendingProposalId);
    assert.equal(rebuiltReview.records.length, pendingReview.records.length);
    assert.equal(
      rebuiltReview.records.filter((record) => record.reviewState === 'accepted').length,
      0,
    );
    for (const [id, bytes] of [
      [pdfIntake.id, sources.pdf],
      [zipIntake.id, sources.zip],
      [retainedCopyId, sources.pdf],
    ] as const)
      assert.deepEqual(getIntakeOriginal(db, rebuiltRoot, profileId, id).bytes, bytes);
  },
);
