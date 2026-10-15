import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { OwnershipBlockerEvidence } from '../../app/features/clinical-review/OwnershipBlockerEvidence';
import type { OwnershipBlockerReference } from '../../shared/ownership-report-reference';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
const profile = { id: 'fictional-ownership-reader', name: 'Fictional Reader', placebo: true };
const reference: OwnershipBlockerReference = {
  format: 'ownership-blockers-v1',
  key: 'blockers',
  count: 2,
  digest: 'all-requirements',
  url: '/record-ownership/report-evidence/fictional?contribution=blockers',
};
const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});
it('keeps one blocker page and one giant requirement window while retaining the complete count', async () => {
  const bytes = new TextEncoder().encode(
    'fictional requirement '.repeat(1800) + 'LAST REQUIREMENT DETAIL',
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.searchParams.has('ordinal')) {
        const offset = Number(url.searchParams.get('offset'));
        const end = Math.min(bytes.length, offset + 32768);
        return json({
          encoding: 'base64',
          data: Buffer.from(bytes.subarray(offset, end)).toString('base64'),
          complete: end === bytes.length,
          nextOffset: end === bytes.length ? null : end,
        });
      }
      return json(
        url.searchParams.get('after') === '0'
          ? {
              items: [
                {
                  type: 'contribution-fragment',
                  ordinal: 1,
                  bytes: bytes.length,
                  url: reference.url,
                },
              ],
              total: 2,
              complete: true,
              after: null,
            }
          : { items: ['FIRST ASSIGNMENT REQUIREMENT'], total: 2, complete: false, after: '0' },
      );
    }),
  );
  render(<OwnershipBlockerEvidence blockers={reference} disabled={false} onRefresh={() => {}} />);
  expect(screen.getByRole('alert')).toHaveTextContent('2 person assignment requirements');
  fireEvent.click(screen.getByRole('button', { name: 'Inspect correction requirements' }));
  expect(await screen.findByText('FIRST ASSIGNMENT REQUIREMENT')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Next correction requirements' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open evidence' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Next evidence page' }));
  const evidence = await screen.findByText(/LAST REQUIREMENT DETAIL/);
  expect(evidence.textContent!.length).toBeLessThanOrEqual(32768);
  expect(screen.queryByText('FIRST ASSIGNMENT REQUIREMENT')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('2 person assignment requirements');
});
it('refuses incomplete blocker pages that claim completion', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ items: ['One requirement'], total: 2, complete: true, after: null })),
  );
  render(<OwnershipBlockerEvidence blockers={reference} disabled={false} onRefresh={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Inspect correction requirements' }));
  expect(await screen.findByText(/The person assignment requirements changed/)).toBeVisible();
  expect(screen.queryByText('One requirement')).not.toBeInTheDocument();
});
it('discards late blocker evidence when the profile changes', async () => {
  let resolve: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  render(<OwnershipBlockerEvidence blockers={reference} disabled={false} onRefresh={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Inspect correction requirements' }));
  await waitFor(() => expect(resolve).toBeDefined());
  await act(async () => selectProfile({ ...profile, id: 'fictional-other-reader' }));
  await act(async () =>
    resolve!(
      json({
        items: ['PRIVATE OLD PROFILE REQUIREMENT', 'second'],
        total: 2,
        complete: true,
        after: null,
      }),
    ),
  );
  expect(screen.queryByText('PRIVATE OLD PROFILE REQUIREMENT')).not.toBeInTheDocument();
});
