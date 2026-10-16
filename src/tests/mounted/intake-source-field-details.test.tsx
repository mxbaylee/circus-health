import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { IntakeSourceFieldDetails } from '../../app/features/intake/IntakeSourceFieldDetails';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { IntakeSourceFieldReferenceV1 } from '../../shared/intake-summary';

const profile = { id: 'fictional-field-viewer', name: 'Fictional Field Viewer', placebo: true };
const reference = (version: string): IntakeSourceFieldReferenceV1 => ({
  format: 'health-intake-source-field-reference-v1',
  intakeId: 'fictional-source',
  sourceHash: 'a'.repeat(64),
  sourceVersionId: version,
  field: 'mimeType',
  bytes: 14,
  scalarHash: createHash('sha256').update('fictional/type').digest('hex'),
});
const response = (ref: IntakeSourceFieldReferenceV1, text: string, nextCursor: string | null) =>
  new Response(
    JSON.stringify({
      data: {
        format: 'health-intake-source-field-fragment-v1',
        reference: ref,
        text,
        complete: nextCursor === null,
        nextCursor,
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
const open = () => {
  const details = screen.getByText('View media type').parentElement!;
  details.setAttribute('open', '');
  fireEvent(details, new Event('toggle'));
};

beforeEach(() => {
  vi.unstubAllGlobals();
  replaceProfiles([profile]);
  selectProfile(profile);
});

it('retains one bounded page and reaches the final source-field fragment', async () => {
  const ref = reference('fictional-version-1');
  const fetch = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
    const input = JSON.parse(String(options?.body));
    expect(input.reference).toEqual(ref);
    expect(input.bytes).toBe(8192);
    return input.cursor
      ? response(ref, 'type', null)
      : response(ref, 'fictional/', 'fictional-next');
  });
  vi.stubGlobal('fetch', fetch);
  render(<IntakeSourceFieldDetails reference={ref} label="View media type" />);
  open();
  await screen.findByText('fictional/');
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('type');
  expect(screen.queryByText('fictional/')).toBeNull();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});

it('reports a refused later page without displaying the earlier page as current', async () => {
  const ref = reference('fictional-version-2');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
      const input = JSON.parse(String(options?.body));
      return input.cursor
        ? new Response(
            JSON.stringify({ error: { code: 'INTAKE_SOURCE_FIELD_CHANGED', message: 'Changed' } }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          )
        : response(ref, 'fictional/', 'fictional-next');
    }),
  );
  render(<IntakeSourceFieldDetails reference={ref} label="View media type" />);
  open();
  await screen.findByText('fictional/');
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('Changed');
  expect(screen.queryByText('fictional/')).toBeNull();
});

it('releases an unfinished source-field cursor when its details close', async () => {
  const ref = reference('fictional-version-close');
  const fetch = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
    const input = JSON.parse(String(options?.body));
    return response(
      ref,
      input.release ? '' : 'fictional/',
      input.release ? null : 'fictional-next',
    );
  });
  vi.stubGlobal('fetch', fetch);
  render(<IntakeSourceFieldDetails reference={ref} label="View media type" />);
  open();
  await screen.findByText('fictional/');
  const details = screen.getByText('View media type').parentElement!;
  details.removeAttribute('open');
  fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const release = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
  expect(release).toMatchObject({ reference: ref, cursor: 'fictional-next', release: true });
  expect(screen.queryByText('fictional/')).toBeNull();
});

it('ignores an old response after the selected source version changes', async () => {
  const old = reference('fictional-version-old');
  const current = reference('fictional-version-current');
  let finishOld: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
      const input = JSON.parse(String(options?.body));
      return input.reference.sourceVersionId === old.sourceVersionId
        ? new Promise<Response>((resolve) => {
            finishOld = resolve;
          })
        : response(current, 'current-value', null);
    }),
  );
  const view = render(<IntakeSourceFieldDetails reference={old} label="View media type" />);
  open();
  await waitFor(() => expect(finishOld).toBeDefined());
  view.rerender(<IntakeSourceFieldDetails reference={current} label="View media type" />);
  await screen.findByText('current-value');
  await act(async () => finishOld!(response(old, 'old-value', null)));
  expect(screen.queryByText('old-value')).toBeNull();
  expect(screen.getByText('current-value')).toBeTruthy();
});
