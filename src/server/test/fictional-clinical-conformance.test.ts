import { attachPersonalDurability } from '../portable.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import type { Intake } from '../../shared/intake.ts';
import { CLINICAL_INSTRUCTIONS } from '../clinical-instructions.ts';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { createIntakePlan, submitIntakeBatch, uploadIntake } from '../intake.ts';
import { accountedUnitKind } from '../intake-unit-accounting.ts';
import { intakeReadingAccounting } from '../intake-reading-accounting.ts';
import { fictionalModel } from './fictional-model.ts';
import {
  evaluateFictionalClinicalConformanceProposal,
  type FictionalClinicalConformanceEnvelope as ProposedEnvelope,
} from '../../tests/fixtures/fictional-clinical-conformance-evaluator.ts';
import {
  CLINICAL_CONFORMANCE_BARE_DATE_LINE,
  CLINICAL_CONFORMANCE_CONTROL_LINE,
  CLINICAL_CONFORMANCE_MODALITY_LINE,
  CLINICAL_CONFORMANCE_TITLE_LINE,
  buildFictionalClinicalConformanceSource,
  fictionalClinicalConformancePages,
} from '../../tests/fixtures/fictional-clinical-conformance-source-generator.ts';
import { fictionalClinicalConformanceEnvelopes } from '../../tests/fixtures/fictional-clinical-conformance-proposals.ts';

function temporary(t: TestContext, prefix: string) {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function unsupportedProcedure(support: string, locator: string): ProposedEnvelope {
  const current = structuredClone(
    fictionalClinicalConformanceEnvelopes().find(
      (envelope) => envelope.provenance.sourceRecordId === 'fx-procedure-current',
    )!,
  ) as ProposedEnvelope;
  current.id = `unsupported:${createHash('sha256').update(locator).digest('hex').slice(0, 10)}`;
  current.provenance.sourceRecordId = null;
  current.provenance.locator = locator;
  current.payload = { citedSupport: support };
  return current;
}

test('fictional four-page clinical source and exact 8 + 8 proposal oracle are deterministic', (t) => {
  const first = buildFictionalClinicalConformanceSource(join(temporary(t, 'clinical-a-'), 'out'));
  const second = buildFictionalClinicalConformanceSource(join(temporary(t, 'clinical-b-'), 'out'));
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.manifest.pages, 4);
  assert.equal(createHash('sha256').update(first.pdf).digest('hex'), first.manifest.sha256);
  assert.equal(statSync(first.directory).mode & 0o777, 0o700);
  assert.equal(statSync(first.pdfPath).mode & 0o777, 0o600);
  assert.equal(statSync(first.manifestPath).mode & 0o777, 0o600);
  assert.equal(fictionalClinicalConformancePages().length, 4);

  const ideal = fictionalClinicalConformanceEnvelopes();
  const report = evaluateFictionalClinicalConformanceProposal(ideal);
  assert.equal(report.passed, true, JSON.stringify(report.failures, null, 2));
  assert.deepEqual(
    {
      stable: report.stableCount,
      repeated: report.repeatedCount,
      clinical: report.clinicalCount,
    },
    { stable: 8, repeated: 8, clinical: 16 },
  );

  const runtimeAsset = 'source-file:fictional-profile:clinical-conformance-original';
  const runtimeBound = structuredClone(ideal) as ProposedEnvelope[];
  for (const envelope of runtimeBound)
    if (envelope.clinical) envelope.clinical.assets = [runtimeAsset];
  assert.equal(
    evaluateFictionalClinicalConformanceProposal(runtimeBound, {
      originalSourceFileId: runtimeAsset,
    }).passed,
    true,
  );
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(runtimeBound, {
      originalSourceFileId: 'source-file:another-profile:clinical-conformance-original',
    }).failures.some(
      (failure) => failure.includes('source_occurrence') && failure.includes('matching supplied'),
    ),
  );
});

test('proposal oracle rejects date, domain, occurrence and source identity mutations', () => {
  const mutation = () =>
    structuredClone(fictionalClinicalConformanceEnvelopes()) as ProposedEnvelope[];

  const swapped = mutation();
  swapped.find((row) => row.provenance.sourceRecordId === 'fx-stack-a1')!.clinical!.date =
    '2040-04-06';
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(swapped).failures.some((failure) =>
      failure.includes('fx-stack-a1'),
    ),
  );

  const omittedDate = mutation();
  delete omittedDate.find((row) => row.provenance.sourceRecordId === 'fx-stack-a2')!.clinical!.date;
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(omittedDate).failures.some(
      (failure) => failure.includes('fx-stack-a2') && failure.includes('date'),
    ),
  );

  const borrowed = mutation();
  borrowed.find((row) => row.provenance.sourceRecordId === 'fx-appendix-a')!.clinical!.date =
    '2041-04-05';
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(borrowed).failures.some((failure) =>
      failure.includes('borrowed'),
    ),
  );

  const wrongDomain = mutation();
  wrongDomain.find(
    (row) => row.provenance.sourceRecordId === 'fx-stack-b1',
  )!.clinical!.observationCategory = 'Fictional prism absorptiometry';
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(wrongDomain).failures.some(
      (failure) => failure.includes('fx-stack-b1') && failure.includes('observationCategory'),
    ),
  );

  const omitted = mutation();
  omitted.splice(
    omitted.findIndex((row) =>
      row.provenance.locator.includes('page 4 measured result Fictional measured reach'),
    ),
    1,
  );
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(omitted).failures.some((failure) =>
      failure.includes('expected 4 occurrences'),
    ),
  );

  const collapsed = mutation().filter(
    (row) =>
      row.clinical?.testLabel !== 'Fictional measured balance' ||
      row.provenance.locator.includes('page 1 measured result'),
  );
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(collapsed).failures.some(
      (failure) => failure.includes('Fictional measured balance') && failure.includes('expected 4'),
    ),
  );

  const inventedId = mutation();
  inventedId.find((row) =>
    row.provenance.locator.includes('page 2 measured result Fictional measured reach'),
  )!.provenance.sourceRecordId = 'invented-repeated-id';
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(inventedId).failures.some((failure) =>
      failure.includes('invented-repeated-id'),
    ),
  );

  const offeredChoice = mutation();
  offeredChoice.find(
    (row) => row.provenance.sourceRecordId === 'fx-appendix-b',
  )!.reviewIssues![0]!.choices = [{ label: 'Unsupported current date', value: '2041-04-05' }];
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(offeredChoice).failures.some(
      (failure) => failure.includes('fx-appendix-b') && failure.includes('zero actual choices'),
    ),
  );

  const missingIssue = mutation();
  missingIssue.find((row) => row.provenance.sourceRecordId === 'fx-appendix-a')!.reviewIssues = [];
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(missingIssue).failures.some(
      (failure) => failure.includes('fx-appendix-a') && failure.includes('exactly one date issue'),
    ),
  );
});

test('repeated occurrence locators accept equivalent exact-page forms and reject ambiguous scope', () => {
  const mutation = () =>
    structuredClone(fictionalClinicalConformanceEnvelopes()) as ProposedEnvelope[];
  const rows = (value: ProposedEnvelope[], label = 'Fictional measured reach') =>
    value.filter((row) => row.clinical?.testLabel === label);
  const failsLocator = (value: ProposedEnvelope[], label = 'Fictional measured reach') =>
    evaluateFictionalClinicalConformanceProposal(value).failures.some(
      (failure) => failure.includes(`repeated ${label}`) && failure.includes('locator'),
    );

  const equivalent = mutation();
  const equivalentRows = rows(equivalent);
  equivalentRows[0]!.provenance.locator =
    'upper measured panel — Fictional measured reach — PAGE: 1';
  equivalentRows[1]!.provenance.locator = 'Fictional measured reach | region upper-right | p. #2';
  equivalentRows[2]!.provenance.locator = 'page-3 / measured row / Fictional measured reach';
  equivalentRows[3]!.provenance.locator = 'Fictional measured reach; measured panel; page 4 of 4';
  assert.equal(
    evaluateFictionalClinicalConformanceProposal(equivalent).passed,
    true,
    JSON.stringify(evaluateFictionalClinicalConformanceProposal(equivalent).failures, null, 2),
  );

  const supportedPunctuation = ['p.1', 'p. 1', 'p.#1', 'p.:1', 'p..1', 'p._1', 'p.=1', 'p.-1'];
  for (const notation of supportedPunctuation) {
    const positive = mutation();
    rows(positive)[0]!.provenance.locator =
      `Fictional measured reach | measured panel | ${notation}`;
    assert.equal(
      evaluateFictionalClinicalConformanceProposal(positive).passed,
      true,
      `positive ${notation}`,
    );

    for (const phrase of ['not on', 'is not at']) {
      const negated = mutation();
      rows(negated)[0]!.provenance.locator = `Fictional measured reach ${phrase} ${notation}`;
      assert.equal(failsLocator(negated), true, `negative ${phrase} ${notation}`);
    }
  }

  const pageEleven = mutation();
  rows(pageEleven)[0]!.provenance.locator = 'Fictional measured reach | measured panel | page 11';
  assert.equal(failsLocator(pageEleven), true);

  const comparedPages = mutation();
  rows(comparedPages)[0]!.provenance.locator =
    'Fictional measured reach | measured panel | page 1 vs 11';
  assert.equal(failsLocator(comparedPages), true);

  const ambiguous = mutation();
  rows(ambiguous)[0]!.provenance.locator =
    'Fictional measured reach | measured panel | page 1 and page 2';
  assert.equal(failsLocator(ambiguous), true);

  const range = mutation();
  rows(range)[0]!.provenance.locator = 'Fictional measured reach | measured panel | page 1-4';
  assert.equal(failsLocator(range), true);

  const negatedPage = mutation();
  rows(negatedPage)[0]!.provenance.locator = 'Fictional measured reach not on page 1';
  assert.equal(failsLocator(negatedPage), true);

  const negatedLabel = mutation();
  rows(negatedLabel)[0]!.provenance.locator = 'not Fictional measured reach — page 1';
  assert.equal(failsLocator(negatedLabel), true);

  const wrongLabel = mutation();
  rows(wrongLabel)[0]!.provenance.locator = 'Fictional measured balance | measured panel | page 1';
  assert.equal(failsLocator(wrongLabel), true);

  const foreignAsset = mutation();
  rows(foreignAsset)[0]!.clinical!.assets = ['source-file:foreign-original'];
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(foreignAsset).failures.some(
      (failure) =>
        failure.includes('Fictional measured reach') && failure.includes('mapping differs'),
    ),
  );

  const duplicatePage = mutation();
  duplicatePage.push(structuredClone(rows(duplicatePage)[0]!));
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(duplicatePage).failures.some((failure) =>
      failure.includes('expected one page 1 occurrence, received 2'),
    ),
  );

  const contextPromotion = mutation();
  const context = contextPromotion.find((row) => row.kind === 'context')!;
  context.clinical = structuredClone(rows(contextPromotion)[0]!.clinical);
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(contextPromotion).failures.some((failure) =>
      failure.includes(`context ${context.id} has a clinical mapping`),
    ),
  );
});

test('proposal oracle independently rejects title, modality, date and procedure-role invention', () => {
  const controls = [
    {
      name: 'title-only performed event',
      support: CLINICAL_CONFORMANCE_TITLE_LINE,
      locator: 'fictional-clinical-conformance-report.pdf page 1 report heading',
    },
    {
      name: 'modality-only performed event',
      support: CLINICAL_CONFORMANCE_MODALITY_LINE,
      locator: 'fictional-clinical-conformance-report.pdf page 1 acquisition modality',
    },
    {
      name: 'named scan plus date without event assertion',
      support: CLINICAL_CONFORMANCE_CONTROL_LINE,
      locator: 'fictional-clinical-conformance-report.pdf page 1 reference control',
    },
    {
      name: 'bare historical measurement date',
      support: CLINICAL_CONFORMANCE_BARE_DATE_LINE,
      locator: 'fictional-clinical-conformance-report.pdf page 4 bare date',
    },
  ];
  for (const control of controls) {
    const mutated = structuredClone(fictionalClinicalConformanceEnvelopes());
    mutated.push(unsupportedProcedure(control.support, control.locator));
    assert.ok(
      evaluateFictionalClinicalConformanceProposal(mutated).failures.some(
        (failure) =>
          failure.includes('unsupported null-ID procedure role') &&
          failure.includes(control.locator),
      ),
      control.name,
    );
  }

  const historyAsPerformed = structuredClone(
    fictionalClinicalConformanceEnvelopes(),
  ) as ProposedEnvelope[];
  historyAsPerformed.find(
    (row) => row.provenance.sourceRecordId === 'fx-procedure-history',
  )!.clinical!.eventKind = 'performed';
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(historyAsPerformed).failures.some(
      (failure) =>
        failure.includes('fx-procedure-history') && failure.includes('eventKind must equal'),
    ),
  );

  const performedAsHistory = structuredClone(
    fictionalClinicalConformanceEnvelopes(),
  ) as ProposedEnvelope[];
  performedAsHistory.find(
    (row) => row.provenance.sourceRecordId === 'fx-procedure-current',
  )!.clinical!.eventKind = 'historical_mention';
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(performedAsHistory).failures.some(
      (failure) =>
        failure.includes('fx-procedure-current') && failure.includes('eventKind must equal'),
    ),
  );

  const missingPerformed = structuredClone(
    fictionalClinicalConformanceEnvelopes(),
  ) as ProposedEnvelope[];
  missingPerformed.splice(
    missingPerformed.findIndex((row) => row.provenance.sourceRecordId === 'fx-procedure-current'),
    1,
  );
  assert.ok(
    evaluateFictionalClinicalConformanceProposal(missingPerformed).failures.some(
      (failure) => failure.includes('fx-procedure-current') && failure.includes('recall'),
    ),
  );
});

test('one exact four-page plan and extracted batch retain complete fixture-local coverage', async (t) => {
  fictionalModel(t);
  const root = temporary(t, 'clinical-coverage-');
  const profileId = 'saffron-cookie';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId: profileId });
  t.after(() => db.close());
  const source = buildFictionalClinicalConformanceSource(join(root, 'generated'));
  let item: Intake = uploadIntake(db, root, profileId, {
    filename: source.manifest.filename,
    bytes: source.pdf,
    newProviderName: 'Northstar Fictional Metrics',
  });
  item = await createIntakePlan(db, root, profileId, item.id, {
    version: item.version,
    unitSize: 4,
    overlap: 0,
  });
  let plan = item.workflow!.plans.find((candidate) => candidate.status === 'active')!;
  assert.equal(plan.index.kind, 'pdf');
  assert.equal((plan.index as typeof plan.index & { pages?: number }).pages, 4);
  assert.equal(plan.units.length, 1);
  assert.deepEqual(plan.units[0]!.pages, [1, 2, 3, 4]);
  const operationId = randomUUID();
  item = submitIntakeBatch(db, root, profileId, item.id, {
    version: item.version,
    operationId,
    planId: plan.id,
    summary: 'Independently fictional four-page clinical conformance proposal',
    jsonlText: fictionalClinicalConformanceEnvelopes()
      .map((envelope) => JSON.stringify(envelope))
      .join('\n'),
    coverage: [
      {
        unitId: plan.units[0]!.id,
        kind: 'extracted',
        notes: 'All four fictional pages read in one exact unit.',
      },
    ],
  });
  plan = item.workflow!.plans.find((candidate) => candidate.status === 'active')!;
  assert.equal(item.workflow?.reportGroups?.length, 1);
  assert.equal(item.workflow?.reportGroups?.[0]?.basis, 'report_anchor');
  assert.equal(item.workflow?.reportGroups?.[0]?.versions[0]?.members.length, 16);
  const unit = plan.units[0]!;
  assert.deepEqual(unit.pages, [1, 2, 3, 4]);
  assert.equal(accountedUnitKind(plan, unit), 'extracted');
  assert.deepEqual(unit.attempts, [operationId]);
  assert.ok(
    plan.batches.some(
      (batch) =>
        batch.id === operationId &&
        batch.coverage.length === 1 &&
        batch.coverage[0]!.unitId === unit.id &&
        batch.coverage[0]!.kind === 'extracted',
    ),
  );
  const accountedPages = new Set(plan.units.flatMap((candidate) => candidate.pages || []));
  assert.deepEqual([...accountedPages].sort(), [1, 2, 3, 4]);
  const accounting = intakeReadingAccounting(db, root, profileId, [item], []);
  assert.equal(accounting.state, 'accounted');
  assert.equal(accounting.allSourceOccurrencesAccounted, true);
  assert.deepEqual(accounting.units, {
    total: 1,
    pending: 0,
    extractedClaims: 1,
    contextOnly: 0,
    unreadable: 0,
  });
  const proposalPages = new Set(
    fictionalClinicalConformanceEnvelopes().flatMap((envelope) =>
      [1, 2, 3, 4].filter((page) => envelope.provenance.locator.includes(`page ${page}`)),
    ),
  );
  assert.deepEqual([...proposalPages].sort(), [1, 2, 3, 4]);
  assert.ok(
    fictionalClinicalConformanceEnvelopes().some((envelope) => envelope.kind === 'context'),
  );
});

test('durable generic instructions keep repeated assertions and performed procedures bounded', () => {
  for (const phrase of [
    'otherwise-supported patient-specific clinical assertion',
    'Repeated identifiers, demographics, report keys, generic headers, reference material, and supporting context',
    'performed for the evidenced report subject',
    'named scan plus date without an event assertion',
  ])
    assert.ok(CLINICAL_INSTRUCTIONS.includes(phrase), phrase);
});
