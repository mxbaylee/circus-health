import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { RecordCorrectionHistory } from '../../app/components/RecordCorrectionHistory';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { IntakeReviewDraftHistory } from '../../shared/intake';
const profile = { id: 'fictional-accepted-history', name: 'Fictional Reader', placebo: true };
const extra = {
  import: { correctionHistorySource: { format: 'health-accepted-contribution-corrections-v1' } },
};
const history: IntakeReviewDraftHistory = {
  format: 'health-intake-review-draft-history-v1',
  intakeId: 'fictional-intake',
  sourceHash: 'fictional-source-hash',
  snapshotId: 'snapshot-first',
  resolutions: 3,
  corrections: 1,
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const header = (id: string, snapshotId: string) => ({
  id,
  sourceRecordId: `source-${id}`,
  intakeId: history.intakeId,
  candidateId: 'candidate',
  candidateVersionId: 'version',
  proposalId: 'proposal',
  draftId: 'draft',
  at: '2026-10-03T12:00:00Z',
  history: { ...history, snapshotId },
});
beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});
it('loads one accepted-contribution window then opens its complete immutable corrections', async () => {
  const requests: { url: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, body });
      if (url.includes('/record-import-corrections?'))
        return json({
          format: 'health-clinical-import-corrections-v1',
          kind: 'observation',
          recordId: 'fictional-observation',
          entries: [
            url.includes('after=next')
              ? header('second', 'snapshot-second')
              : header('first', 'snapshot-first'),
          ],
          complete: url.includes('after=next'),
          nextCursor: url.includes('after=next') ? null : 'next',
        });
      if (url.endsWith('/review-history'))
        return json({
          format: 'health-intake-review-history-page-v1',
          reference: body.reference,
          section: 'corrections',
          items: [
            {
              ordinal: 0,
              value: {
                operationId: 'correction',
                at: '2026-10-03',
                reason: 'Read fictional value from original',
                before: { valueText: '8' },
                after: { valueText: '9' },
              },
            },
          ],
          total: 1,
          complete: true,
          nextOffset: null,
        });
      throw new Error(`Unexpected ${url}`);
    }),
  );
  render(
    <RecordCorrectionHistory
      extra={extra}
      kind="observation"
      recordId="fictional-observation"
      open
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'View review history' }));
  expect(await screen.findByText('2026-10-03 · Read fictional value from original')).toBeVisible();
  expect(requests[1]!.body).toMatchObject({
    reference: history,
    section: 'corrections',
    offset: 0,
    limit: 20,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Next accepted source histories' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Next accepted source histories' })).toBeNull(),
  );
  expect(screen.queryByText('2026-10-03 · Read fictional value from original')).toBeNull();
  expect(screen.getAllByRole('button', { name: 'View review history' })).toHaveLength(1);
  expect(requests[2]!.url).toContain('after=next');
});
it('keeps history visibly pending on request failure and rejects another record authority', async () => {
  let fail = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      fail
        ? json({ code: 'OFFLINE', message: 'Fictional history unavailable' }, 503)
        : json({
            format: 'health-clinical-import-corrections-v1',
            kind: 'observation',
            recordId: 'other-record',
            entries: [header('first', 'snapshot-first')],
            complete: true,
            nextCursor: null,
          }),
    ),
  );
  render(
    <RecordCorrectionHistory
      extra={extra}
      kind="observation"
      recordId="fictional-observation"
      open
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Fictional history unavailable');
  expect(screen.queryByText('Correction history (0)')).toBeNull();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Reload import correction history' }));
  expect(
    await screen.findByText('This correction page changed. Reload the saved record history.'),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: 'View review history' })).toBeNull();
});
it('opens retained accepted legacy history without requiring a native snapshot id', async () => {
  const legacyHistory: IntakeReviewDraftHistory = {
    format: 'health-intake-review-draft-legacy-history-v1',
    intakeId: history.intakeId,
    sourceHash: history.sourceHash,
    draftId: 'legacy-draft',
    ordinal: 4,
    resolutions: 0,
    corrections: 1,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).includes('/record-import-corrections?'))
        return json({
          format: 'health-clinical-import-corrections-v1',
          kind: 'observation',
          recordId: 'fictional-observation',
          entries: [{ ...header('legacy', ''), history: legacyHistory }],
          complete: true,
          nextCursor: null,
        });
      expect(JSON.parse(String(init?.body)).reference).toEqual(legacyHistory);
      return json({
        format: 'health-intake-review-history-page-v1',
        reference: legacyHistory,
        section: 'corrections',
        items: [
          {
            ordinal: 0,
            value: {
              operationId: 'legacy-correction',
              at: '2026-10-03',
              reason: 'Retained original correction',
              before: { unit: 'x' },
              after: { unit: 'y' },
            },
          },
        ],
        total: 1,
        complete: true,
        nextOffset: null,
      });
    }),
  );
  render(
    <RecordCorrectionHistory
      extra={extra}
      kind="observation"
      recordId="fictional-observation"
      open
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'View review history' }));
  expect(await screen.findByText('2026-10-03 · Retained original correction')).toBeVisible();
});
