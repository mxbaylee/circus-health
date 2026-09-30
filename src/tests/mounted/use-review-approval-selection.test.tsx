import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useReviewApprovalSelection } from '../../app/features/import/useReviewApprovalSelection';
import type { ImportReviewRecord } from '../../app/features/import/ImportReviewPresentation';

function record(id: string, token = 'original'): ImportReviewRecord {
  return {
    id,
    reportId: 'fictional-report',
    kind: 'Test results',
    label: id,
    originalLabel: id,
    value: '42',
    status: 'review',
    eligible: true,
    approval: {
      intakeId: 'fictional-intake',
      proposalId: null,
      intakeVersion: 1,
      reviewToken: 'fictional-block',
      selections: [
        {
          recordId: id,
          candidateId: id,
          candidateVersionId: id,
          selectionReviewToken: token,
          mapping: { kind: 'observation', valueText: '42' },
        },
      ],
    },
  };
}

it('preserves pinned approvals when Select all includes an already selected row', () => {
  const rows = [record('fictional-a'), record('fictional-b')];
  const view = renderHook(() => useReviewApprovalSelection());
  act(() => view.result.current.toggle(rows[0]!.id, rows));
  act(() => view.result.current.selectShown(rows, true));
  expect(view.result.current.approvals(rows.map((row) => row.id))).toEqual(
    rows.map((row) => row.approval),
  );
  // Changed input must revoke the original approval, never silently substitute it.
  act(() => {
    view.result.current.revokeChanged([record('fictional-a', 'changed'), rows[1]!]);
  });
  expect([...view.result.current.selected]).toEqual(['fictional-b']);
  expect(view.result.current.needsApproval.has('fictional-a')).toBe(true);
});

it('deselects every shown snapshot before reapproving the current exact values', () => {
  const original = record('fictional-a');
  const view = renderHook(() => useReviewApprovalSelection());
  act(() => view.result.current.selectShown([original], true));
  act(() => view.result.current.selectShown([original], false));
  expect(view.result.current.approvals([original.id])).toEqual([]);
  const current = record(original.id, 'fresh');
  act(() => view.result.current.selectShown([current], true));
  expect(view.result.current.approvals([original.id])).toEqual([current.approval]);
});
