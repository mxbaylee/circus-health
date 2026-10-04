import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ReviewDraftHistory } from '../../app/features/intake/ReviewDraftHistory';
import type { IntakeReviewDraftHistory } from '../../shared/intake';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
const profile = { id: 'fictional-review-history', name: 'Fictional Reader', placebo: true };
const history: IntakeReviewDraftHistory = {
  format: 'health-intake-review-draft-history-v1',
  intakeId: 'fictional-intake',
  sourceHash: 'fictional-source-hash',
  snapshotId: 'fictional-snapshot',
  resolutions: 21,
  corrections: 2,
};
const legacyHistory: IntakeReviewDraftHistory = {
  format: 'health-intake-review-draft-legacy-history-v1',
  intakeId: 'fictional-intake',
  sourceHash: 'fictional-source-hash',
  draftId: 'fictional-legacy-draft',
  ordinal: 7,
  resolutions: 1,
  corrections: 0,
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});
it('reports complete retained counts and replaces one history page independently of policy witnesses', async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const offset = body.offset || 0;
      return json({
        format: 'health-intake-review-history-page-v1',
        reference: history,
        section: body.section,
        total: history[body.section as 'resolutions' | 'corrections'],
        items:
          body.section === 'corrections'
            ? [
                {
                  ordinal: 0,
                  value: {
                    operationId: 'fictional-operation',
                    at: '2026-10-03',
                    reason: 'Corrected fictional value',
                    before: { valueText: '4' },
                    after: { valueText: '5' },
                  },
                },
                {
                  ordinal: 1,
                  value: {
                    operationId: 'fictional-operation2',
                    at: '2026-10-03',
                    reason: 'Corrected fictional unit',
                    before: { unit: 'x' },
                    after: { unit: 'y' },
                  },
                },
              ]
            : Array.from({ length: offset ? 1 : 20 }, (_, index) => ({
                ordinal: offset + index,
                value: { issueId: `question-${offset + index}`, outcome: 'acknowledged' },
              })),
        complete: body.section === 'corrections' || offset === 20,
        nextOffset: body.section === 'corrections' || offset === 20 ? null : 20,
      });
    }),
  );
  render(<ReviewDraftHistory history={history} />);
  expect(
    screen.getByText('21 saved question decisions · 2 saved mapping corrections'),
  ).toBeVisible();
  expect(bodies).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'View review history' }));
  await screen.findByText('Question: question-0 · Decision: acknowledged');
  expect(bodies[0]).toMatchObject({
    reference: history,
    section: 'resolutions',
    offset: 0,
    limit: 20,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Next history page' }));
  await screen.findByText('Question: question-20 · Decision: acknowledged');
  expect(screen.queryByText('Question: question-0 · Decision: acknowledged')).toBeNull();
  fireEvent.change(screen.getByLabelText('History type'), { target: { value: 'corrections' } });
  await screen.findByText('2026-10-03 · Corrected fictional value');
  expect(bodies[2]).toMatchObject({ section: 'corrections', offset: 0, limit: 20 });
  expect(screen.queryByText('Question: question-20 · Decision: acknowledged')).toBeNull();
});
it('streams an oversized history entry one byte window at a time and rejects a repeated cursor', async () => {
  let fragments = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith('/review-history'))
        return json({
          format: 'health-intake-review-history-page-v1',
          reference: { ...history, resolutions: 1 },
          section: 'resolutions',
          items: [
            { ordinal: 0, reference: { ...history, resolutions: 1 }, section: 'resolutions' },
          ],
          total: 1,
          complete: true,
          nextOffset: null,
        });
      fragments++;
      expect(body.ordinal).toBe(0);
      return json(
        fragments === 1
          ? {
              encoding: 'base64',
              data: Buffer.from('first-window '.repeat(2000)).toString('base64'),
              complete: false,
              nextCursor: 'next-fragment',
            }
          : {
              encoding: 'base64',
              data: Buffer.from('second-window').toString('base64'),
              complete: false,
              nextCursor: 'next-fragment',
            },
      );
    }),
  );
  const view = render(<ReviewDraftHistory history={{ ...history, resolutions: 1 }} />);
  fireEvent.click(screen.getByRole('button', { name: 'View review history' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open history evidence' }));
  await screen.findByRole('button', { name: 'Next history evidence page' });
  expect(view.container.querySelector('pre')!.textContent!.length).toBeLessThanOrEqual(32768);
  fireEvent.click(screen.getByRole('button', { name: 'Next history evidence page' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('did not advance');
  expect(view.container.querySelector('pre')).not.toHaveTextContent('second-window');
});
it('does not present an incomplete prefix or another snapshot as complete saved history', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json({
        format: 'health-intake-review-history-page-v1',
        reference: { ...history, snapshotId: 'different' },
        section: 'resolutions',
        items: [],
        total: 21,
        complete: true,
        nextOffset: null,
      }),
    ),
  );
  render(<ReviewDraftHistory history={history} />);
  fireEvent.click(screen.getByRole('button', { name: 'View review history' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('does not match');
  expect(screen.queryByRole('button', { name: 'Next history page' })).toBeNull();
});
it('discards an in-flight history page on profile change', async () => {
  let release!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ),
  );
  render(<ReviewDraftHistory history={history} />);
  fireEvent.click(screen.getByRole('button', { name: 'View review history' }));
  await waitFor(() => expect(release).toBeDefined());
  const oldRelease = release;
  act(() => selectProfile({ id: 'other-fictional-history', name: 'Other Reader', placebo: true }));
  await act(async () =>
    oldRelease(
      json({
        format: 'health-intake-review-history-page-v1',
        reference: history,
        section: 'resolutions',
        items: Array.from({ length: 20 }, (_, ordinal) => ({
          ordinal,
          value: { issueId: 'private-old-profile', outcome: 'acknowledged' },
        })),
        total: 21,
        complete: false,
        nextOffset: 20,
      }),
    ),
  );
  expect(screen.queryByText(/private-old-profile/)).toBeNull();
});
it('reads legacy history references and binds their exact draft and ordinal without a snapshot', async () => {
  let stale = false;
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (String(input).endsWith('/review-history-fragment'))
        return json({
          encoding: 'base64',
          data: Buffer.from('legacy evidence').toString('base64'),
          complete: true,
          nextCursor: null,
        });
      return json({
        format: 'health-intake-review-history-page-v1',
        reference: stale ? { ...legacyHistory, ordinal: 8 } : legacyHistory,
        section: 'resolutions',
        items: [{ ordinal: 0, reference: legacyHistory, section: 'resolutions' }],
        total: 1,
        complete: true,
        nextOffset: null,
      });
    }),
  );
  render(<ReviewDraftHistory history={legacyHistory} />);
  fireEvent.click(screen.getByRole('button', { name: 'View review history' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open history evidence' }));
  expect(await screen.findByText('legacy evidence')).toBeVisible();
  expect(bodies[1]).toMatchObject({ reference: legacyHistory, ordinal: 0 });
  fireEvent.click(screen.getByRole('button', { name: 'Hide review history' }));
  stale = true;
  fireEvent.click(screen.getByRole('button', { name: 'View review history' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('does not match');
  expect(screen.queryByText('legacy evidence')).toBeNull();
});
