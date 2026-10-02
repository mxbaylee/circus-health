import test from 'node:test';
import assert from 'node:assert/strict';
import { createLargeImportOracle } from './large-import-fixture.ts';
import {
  gradeLargeImportAccepted,
  type LargeImportAcceptedInput,
  type LargeImportAcceptedEntity,
} from './large-import-accepted-grader.ts';
import type { Observation, Medication, Procedure } from '../shared/api.ts';
import type { IntakeReviewRecord, IntakeAtomicAcceptanceReceipt } from '../shared/intake.ts';

/** Full synthetic snapshots cover the grader's completeness dimension. The separate
 * independently authored HTTP fixture establishes actual acceptance/rebuild behavior. */
function snapshots(): LargeImportAcceptedInput {
  const oracle = createLargeImportOracle();
  const people = Object.fromEntries(
    oracle.people.map((person, index) => [
      person.key,
      {
        personId: index ? 'runtime-willow' : 'patient',
        noteId: index ? `runtime-note-${index}` : 'person-note:self',
        version: 1,
        fullName: person.name,
        birthDate: person.birthDate,
      },
    ]),
  );
  const records: LargeImportAcceptedEntity[] = oracle.assertions.map((assertion, index) => {
    const mapping = assertion.mapping;
    const common = {
      id: `runtime-entity-${index}`,
      personId: people[assertion.personKey]!.personId,
      label: mapping.testLabel ?? mapping.medicationName ?? mapping.procedureLabel!,
      sourceRecordId: `runtime-record-${index}`,
      extra: { import: { acceptedMapping: { ...mapping } } },
      evidence: assertion.pages.map((page) => ({
        id: `runtime-evidence-${index}-${page}`,
        sourceRecordId: `runtime-record-${index}`,
        role: 'primary',
        locator: { originalSourceFileId: 'runtime-original', locator: `page ${page}` },
      })),
    };
    if (mapping.kind === 'observation')
      return {
        kind: 'observation',
        record: {
          ...common,
          testTypeId: `runtime-type-${index}`,
          date: mapping.date!,
          datePrecision: 'day',
          valueText: mapping.valueText!,
          value: mapping.testLabel === 'FX-CROSS-001' ? 0.003 : 0.07,
          comparator: '<',
          unit: mapping.unit!,
          reference: { text: mapping.referenceText },
          status: mapping.status!,
          providerId: null,
          provider: null,
          reportId: null,
        } satisfies Observation,
      };
    if (mapping.kind === 'medication')
      return {
        kind: 'medication',
        record: {
          ...common,
          kind: 'order',
          status: null,
          currentStatus: 'unknown',
          currentStatusVersion: 0,
          visibilityVersion: 0,
          currentStatusUpdatedAt: null,
          currentStatusAssertion: null,
          sourceRecordedDate: mapping.date!,
          doseText: mapping.doseText!,
          route: mapping.route!,
          frequency: mapping.frequency!,
          startAt: null,
          endAt: null,
          provider: null,
        } satisfies Medication,
      };
    return {
      kind: 'procedure',
      record: {
        ...common,
        category: 'imaging',
        date: mapping.date!,
        status: 'completed',
        provider: null,
      } satisfies Procedure,
    };
  });
  const reviewed: IntakeReviewRecord[] = oracle.assertions.map((assertion, index) => ({
    id: `runtime-record-${index}`,
    candidateId: `runtime-candidate-${index}`,
    candidateVersionId: `runtime-version-${index}`,
    kind: assertion.mapping.kind,
    classification: 'addition',
    title: 'Fictional assertion',
    date: assertion.mapping.date!,
    provider: null,
    confidence: null,
    uncertainties: [],
    supportedFields: [],
    mapping: { ...assertion.mapping },
    evidence: assertion.pages.map((page) => ({
      label: 'Original',
      locator: `page ${page}`,
      contentUrl: '/api/sources/runtime-original/content',
    })),
  }));
  const request = {
    operationId: 'a26a936e-eef0-436b-a261-c6306d0dbdc2',
    blocks: [
      {
        intakeId: 'runtime-original',
        proposalId: 'runtime-proposal',
        intakeVersion: 3,
        reviewToken: 'runtime-token',
        selections: reviewed.map((record) => ({
          recordId: record.id,
          candidateId: record.candidateId!,
          candidateVersionId: record.candidateVersionId!,
          mapping: {},
        })),
      },
    ],
  };
  const receipt: IntakeAtomicAcceptanceReceipt = {
    operationId: request.operationId,
    status: 'accepted',
    atomic: true,
    at: '2026-01-01T00:00:00.000Z',
    selectedCount: 901,
    acceptedCount: 901,
    receipts: [
      {
        intakeId: 'runtime-original',
        proposalId: 'runtime-proposal',
        intakeVersionBefore: 3,
        intakeVersionAfter: 4,
        reviewToken: 'runtime-token',
        records: reviewed.map((record, index) => ({
          recordId: record.id,
          candidateId: record.candidateId!,
          candidateVersionId: record.candidateVersionId!,
          entityId: records[index]!.record.id,
          kind: records[index]!.kind,
          title: 'Fictional assertion',
          optical: false,
          outcome: 'added',
        })),
      },
    ],
  };
  return {
    oracle,
    originalId: 'runtime-original',
    people,
    records,
    transactions: [
      {
        request,
        receipt,
        reviews: [
          {
            intakeId: 'runtime-original',
            proposalId: 'runtime-proposal',
            version: 3,
            reviewToken: 'runtime-token',
            records: reviewed,
            summary: { additions: 901, duplicates: 0, unsupported: 0, uncertain: 0 },
            coverageGaps: [],
          },
        ],
      },
    ],
  };
}
const grade = gradeLargeImportAccepted;
const receipt = (input: LargeImportAcceptedInput) => input.transactions[0]!.receipt.receipts[0]!;
const mapping = (entity: LargeImportAcceptedEntity) =>
  (entity.record.extra as { import: { acceptedMapping: Record<string, unknown> } }).import
    .acceptedMapping;

test('complete accepted synthetic oracle is pure; bounded results stay incomplete', () => {
  const input = snapshots();
  const before = structuredClone(input);
  assert.equal(grade(input).passed, true, JSON.stringify(grade(input)));
  assert.equal(grade(input).exactRecords, 901);
  assert.deepEqual(input, before);
  input.records = input.records.slice(0, 5);
  input.transactions[0]!.request.blocks[0]!.selections =
    input.transactions[0]!.request.blocks[0]!.selections.slice(0, 5);
  receipt(input).records = receipt(input).records.slice(0, 5);
  input.transactions[0]!.receipt.acceptedCount = input.transactions[0]!.receipt.selectedCount = 5;
  const result = grade(input);
  assert.equal(result.exactRecords, 5);
  assert.equal(result.missing.length, 896);
  assert.equal(result.observedRecordsPassed, true);
  assert.equal(result.receiptsPassed, true);
  assert.equal(result.passed, false);
});

const mutations: Array<[string, (input: LargeImportAcceptedInput) => void, string]> = [
  [
    'public numeric value',
    (input) => {
      (input.records[0]!.record as Observation).value = 7;
    },
    'numericValue',
  ],
  [
    'public comparator',
    (input) => {
      (input.records[0]!.record as Observation).comparator = '>';
    },
    'comparator',
  ],
  [
    'public date precision',
    (input) => {
      (input.records[0]!.record as Observation).datePrecision = 'month';
    },
    'datePrecision',
  ],
  [
    'literal precision',
    (input) => {
      mapping(input.records[0]!).valueText = '<0.07';
    },
    'valueText',
  ],
  [
    'public value text masked by retained mapping',
    (input) => {
      (input.records[0]!.record as Observation).valueText = '<7.000';
    },
    'valueText',
  ],
  [
    'public medication dose masked by retained mapping',
    (input) => {
      (input.records[1]!.record as Medication).doseText = '25 mg';
    },
    'doseText',
  ],
  [
    'public procedure category masked by retained mapping',
    (input) => {
      (input.records[2]!.record as Procedure).category = 'surgery';
    },
    'procedureCategory',
  ],
  [
    'wrong owner',
    (input) => {
      input.records[0]!.record.personId = 'runtime-willow';
    },
    'publicOwner',
  ],
  [
    'missing public owner',
    (input) => {
      delete input.records[0]!.record.personId;
    },
    'publicOwner',
  ],
  [
    'contradictory retained person',
    (input) => {
      mapping(input.records[0]!).personId = 'runtime-willow';
    },
    'retainedOwner',
  ],
  [
    'contradictory retained subject',
    (input) => {
      mapping(input.records[0]!).subject = 'other';
    },
    'retainedOwner',
  ],
  [
    'split page missing',
    (input) => {
      input.records.at(-1)!.record.evidence!.pop();
    },
    'originalPages',
  ],
  [
    'wrong original',
    (input) => {
      (
        input.records[0]!.record.evidence![0]!.locator as { originalSourceFileId: string }
      ).originalSourceFileId = 'unrelated';
    },
    'originalEvidence',
  ],
  [
    'wrong source occurrence',
    (input) => {
      input.records[0]!.record.evidence![0]!.sourceRecordId = 'unrelated';
    },
    'sourceLinkage',
  ],
  [
    'duplicate evidence',
    (input) => {
      input.records[0]!.record.evidence!.push(
        structuredClone(input.records[0]!.record.evidence![0]!),
      );
    },
    'duplicateEvidence',
  ],
  [
    'missing retained mapping',
    (input) => {
      input.records[0]!.record.extra = {};
    },
    'eventKind',
  ],
];
for (const [name, mutate, category] of mutations)
  test(`accepted grader rejects ${name}`, () => {
    const input = snapshots();
    mutate(input);
    const result = grade(input);
    assert.equal(result.passed, false);
    assert.ok(
      result.mismatches.some((item) =>
        [...item.retained, ...item.public, ...item.provenance, ...item.ownership].includes(
          category,
        ),
      ),
      JSON.stringify(result),
    );
  });
const receiptMutations: Array<[string, (input: LargeImportAcceptedInput) => void, string]> = [
  [
    'unrelated source occurrence with internally consistent evidence',
    (input) => {
      const record = input.records[0]!.record;
      record.sourceRecordId = 'unrelated-source-occurrence';
      for (const evidence of record.evidence!)
        evidence.sourceRecordId = 'unrelated-source-occurrence';
    },
    'entityBinding',
  ],
  [
    'candidate version',
    (input) => {
      receipt(input).records[0]!.candidateVersionId = 'stale';
    },
    'receiptSelection',
  ],
  [
    'entity binding',
    (input) => {
      receipt(input).records[0]!.entityId = input.records[3]!.record.id;
    },
    'entityBinding',
  ],
  [
    'kind',
    (input) => {
      receipt(input).records[0]!.kind = 'medication';
    },
    'entityBinding',
  ],
  [
    'absent entity',
    (input) => {
      receipt(input).records[0]!.entityId = 'missing';
    },
    'missingEntity',
  ],
  [
    'counts',
    (input) => {
      input.transactions[0]!.receipt.acceptedCount--;
    },
    'count',
  ],
  [
    'missing entry',
    (input) => {
      receipt(input).records.pop();
    },
    'missingSelection',
  ],
  [
    'additional entry',
    (input) => {
      receipt(input).records.push(structuredClone(receipt(input).records[0]!));
    },
    'receiptSelection',
  ],
  [
    'stale review token',
    (input) => {
      input.transactions[0]!.reviews[0]!.reviewToken = 'stale';
    },
    'selectionScope',
  ],
  [
    'stale intake version',
    (input) => {
      receipt(input).intakeVersionBefore++;
    },
    'receiptScope',
  ],
  [
    'proposal',
    (input) => {
      receipt(input).proposalId = 'different';
    },
    'receiptScope',
  ],
  [
    'merge outcome',
    (input) => {
      receipt(input).records[0]!.outcome = 'matched';
    },
    'outcome',
  ],
  [
    'duplicate selection',
    (input) => {
      input.transactions[0]!.request.blocks[0]!.selections.push(
        structuredClone(input.transactions[0]!.request.blocks[0]!.selections[0]!),
      );
    },
    'duplicateSelection',
  ],
  [
    'unreviewed mapping repair',
    (input) => {
      input.transactions[0]!.request.blocks[0]!.selections[0]!.mapping = { valueText: '7' };
    },
    'selectionScope',
  ],
];
for (const [name, mutate, category] of receiptMutations)
  test(`accepted receipt rejects ${name}`, () => {
    const input = snapshots();
    mutate(input);
    const result = grade(input);
    assert.equal(result.passed, false);
    assert.ok(result.receiptIssues.includes(category), JSON.stringify(result));
  });
test('duplicates, unrelated records and missing assertions cannot substitute for the oracle', () => {
  const input = snapshots();
  input.records = [...input.records.slice(1), structuredClone(input.records[1]!)];
  let result = grade(input);
  assert.equal(result.passed, false);
  assert.equal(result.missing.length, 1);
  assert.equal(result.duplicate.length, 1);
  assert.equal(result.duplicateEntities, 1);
  input.records.at(-1)!.record.label = 'PRIVATE UNRELATED LABEL';
  input.records.at(-1)!.record.id = 'PRIVATE UNRELATED ID';
  result = grade(input);
  assert.equal(result.unexpectedRecords, 1);
  assert.equal(result.passed, false);
  const exported = JSON.stringify(result);
  assert.equal(exported.includes('PRIVATE'), false);
  assert.equal(exported.includes('runtime-'), false);
  assert.equal(exported.includes('Cedar'), false);
  assert.equal(exported.includes('<0.070'), false);
});
test('ambiguous/stale People bindings and unsupported oracle versions fail explicitly', () => {
  const input = snapshots();
  input.people['fictional-willow']!.personId = 'patient';
  assert.ok(grade(input).authorityIssues.includes('peopleBinding'));
  input.people['fictional-cedar']!.version = 0;
  assert.equal(grade(input).passed, false);
  assert.throws(
    () =>
      grade({
        ...snapshots(),
        oracle: { ...input.oracle, format: 'old-oracle' as typeof input.oracle.format },
      }),
    /Unsupported/,
  );
});
