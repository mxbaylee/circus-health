import { expect, it } from 'vitest';
import {
  combinePartialReceipts,
  planPartialSave,
} from '../../app/features/import/partial-save-plan';
import type {
  IntakeImportFeed,
  IntakePartialAcceptanceReceipt,
  IntakeReportAcceptanceBlock,
} from '../../shared/intake';

const block = (count: number): IntakeReportAcceptanceBlock => ({
  intakeId: 'fictional-intake',
  proposalId: null,
  intakeVersion: 1,
  reviewToken: 'fictional-review',
  selections: Array.from({ length: count }, (_, index) => ({
    recordId: `fictional-record-${index}`,
    candidateId: `fictional-candidate-${index}`,
    candidateVersionId: `fictional-version-${index}`,
    selectionReviewToken: `fictional-token-${index}`,
    mapping: {
      kind: 'observation' as const,
      testLabel: `Fictional result ${index}`,
      valueText: '7',
    },
  })),
});
const id = (index: number) =>
  JSON.stringify([
    'fictional-intake',
    `fictional-candidate-${index}`,
    `fictional-version-${index}`,
  ]);

it('plans over-cap approvals as ordered operations of at most 200 selections', () => {
  const selected = Array.from({ length: 1001 }, (_, index) => id(index));
  const plan = planPartialSave(selected, null, [block(1001)]);
  expect(plan.unsent).toEqual([]);
  expect(plan.chunks.map((chunk) => chunk.flatMap((part) => part.selections).length)).toEqual([
    200, 200, 200, 200, 200, 1,
  ]);
  expect(
    plan.chunks.flatMap((chunk) =>
      chunk.flatMap((part) => part.selections.map((selection) => selection.recordId)),
    )[1000],
  ).toBe('fictional-record-1000');
});

it('explains every selected ID absent from exact approvals without submitting an empty request', () => {
  const shown = {
    blocks: [{ records: [{ feedKey: id(0), title: 'Fictional result', selectable: false }] }],
  } as IntakeImportFeed;
  const plan = planPartialSave([id(0), id(1)], shown, [block(0)]);
  expect(plan.chunks).toEqual([]);
  expect(plan.unsent).toHaveLength(2);
  expect(plan.unsent[0]?.reason).toMatch(/needs review/);
  expect(plan.unsent[1]?.reason).toMatch(/no longer on the displayed page/);
});

it('combines confirmed child receipts without counting selected items that were never sent', () => {
  const receipt = (
    operationId: string,
    statuses: Array<'saved' | 'needs_review'>,
  ): IntakePartialAcceptanceReceipt => ({
    version: 1,
    operationId,
    status: 'completed',
    atomic: false,
    at: '2026-09-30T00:00:00Z',
    selectedCount: statuses.length,
    acceptedCount: statuses.filter((status) => status === 'saved').length,
    receipts: [],
    items: statuses.map((status, index) => ({
      status,
      operationId: `${operationId}-${index}`,
      intakeId: 'fictional-intake',
      proposalId: null,
      recordId: `record-${index}`,
      candidateId: `candidate-${index}`,
      candidateVersionId: `version-${index}`,
      selectionReviewToken: `token-${index}`,
      reviewedSelectionHash: `hash-${index}`,
    })),
  });
  const combined = combinePartialReceipts([
    receipt('first', ['saved', 'needs_review']),
    receipt('second', ['saved']),
  ]);
  expect(combined?.selectedCount).toBe(3);
  expect(combined?.acceptedCount).toBe(2);
  expect(combined?.items.map((item) => item.status)).toEqual(['saved', 'needs_review', 'saved']);
});
