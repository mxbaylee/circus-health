import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { OwnershipOutcomeEvidence } from '../../app/features/clinical-review/OwnershipOutcomeEvidence';
import type {
  OwnershipReceiptReference,
  OwnershipOutcomeEvidenceItem,
} from '../../shared/ownership-report-reference';
const calls = vi.hoisted(() => ({ api: vi.fn(), profileId: 'fictional-profile' }));
vi.mock('../../app/data/api', () => ({ api: calls.api }));
vi.mock('../../app/data/profile', () => ({ useProfile: () => ({ id: calls.profileId }) }));
const receipt: OwnershipReceiptReference = {
  operationId: 'fictional-correction',
  at: '2026-01-01',
  destinationPersonId: 'fictional-person',
  moved: 2,
  unchanged: 0,
  pending: 0,
  replayed: false,
  groupId: 'fictional-correction',
  outcomesIncluded: false,
  outcomeTotal: 2,
  outcomeDigest: 'a'.repeat(64),
  outcomesUrl: '/api/profiles/fictional-profile/record-ownership/outcomes/fictional-correction',
};
const first: OwnershipOutcomeEvidenceItem = {
    kind: 'document',
    recordId: 'fictional-first',
    destinationRecordId: 'fictional-first',
    action: 'move',
    previousOwnerNoteId: 'fictional-self',
  },
  second: OwnershipOutcomeEvidenceItem = {
    kind: 'procedure',
    recordId: 'fictional-second',
    destinationRecordId: 'fictional-second',
    action: 'move',
    previousOwnerNoteId: 'fictional-self',
  };
const firstPage = {
  items: [first],
  total: 2,
  digest: receipt.outcomeDigest,
  complete: false,
  after: 'parent-v1.fictional-cursor',
};
const mountedReader = (onUndo = vi.fn(), selected = receipt) => (
  <MemoryRouter>
    <OwnershipOutcomeEvidence receipt={selected} onUndo={onUndo} />
  </MemoryRouter>
);
beforeEach(() => {
  calls.api.mockReset();
  calls.profileId = 'fictional-profile';
});

it('replaces exact receipt pages and passes only checked outcomes to reviewed undo', async () => {
  const user = userEvent.setup(),
    undo = vi.fn();
  calls.api.mockImplementation(async (url: string) => ({
    data: url.includes('after=parent-v1.')
      ? { items: [second], total: 2, digest: receipt.outcomeDigest, complete: true, after: null }
      : firstPage,
  }));
  render(mountedReader(undo));
  expect(
    await screen.findByRole('link', { name: 'View corrected document and its history' }),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Review undo' }));
  expect(undo).toHaveBeenCalledWith(first);
  await user.click(screen.getByRole('button', { name: 'Next outcome page' }));
  expect(
    await screen.findByRole('link', { name: 'View corrected procedure and its history' }),
  ).toBeVisible();
  expect(
    screen.queryByRole('link', { name: 'View corrected document and its history' }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Next outcome page' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'First outcome page' }));
  expect(
    await screen.findByRole('link', { name: 'View corrected document and its history' }),
  ).toBeVisible();
});

it.each([
  ['different digest', { ...firstPage, digest: 'b'.repeat(64) }],
  ['different count', { ...firstPage, total: 3 }],
  ['premature completion', { ...firstPage, complete: true, after: null }],
  ['missing previous owner', { ...firstPage, items: [{ ...first, previousOwnerNoteId: '' }] }],
  [
    'oversized page',
    {
      ...firstPage,
      items: Array.from({ length: 17 }, (_, i) => ({ ...first, recordId: 'fictional-' + i })),
    },
  ],
])('refuses %s before exposing history or undo', async (_name, page) => {
  calls.api.mockResolvedValue({ data: page });
  render(mountedReader());
  expect(await screen.findByRole('alert')).toHaveTextContent('complete correction receipt');
  expect(screen.queryByRole('button', { name: 'Review undo' })).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
});

it('resets pages and aborts prior requests when the receipt or profile changes', async () => {
  calls.api.mockResolvedValue({ data: firstPage });
  const mounted = render(mountedReader());
  expect(
    await screen.findByRole('link', { name: 'View corrected document and its history' }),
  ).toBeVisible();
  const signal = calls.api.mock.calls[0]![1].signal as AbortSignal;
  calls.api.mockImplementation(() => new Promise(() => {}));
  const changed = { ...receipt, outcomeDigest: 'b'.repeat(64) };
  mounted.rerender(mountedReader(vi.fn(), changed));
  expect(signal.aborted).toBe(true);
  expect(screen.queryByRole('link')).toBeNull();
  expect(calls.api.mock.lastCall![0]).toContain('?after=&limit=16');
  const changedSignal = calls.api.mock.lastCall![1].signal as AbortSignal;
  calls.profileId = 'other-fictional-profile';
  mounted.rerender(mountedReader(vi.fn(), changed));
  expect(changedSignal.aborted).toBe(true);
  expect(screen.queryByRole('button', { name: 'Review undo' })).toBeNull();
});
