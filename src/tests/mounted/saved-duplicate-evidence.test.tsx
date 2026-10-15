import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { SavedDuplicateEvidence } from '../../app/features/clinical-review/SavedDuplicateEvidence';
import type { SavedDuplicateEvidenceReference } from '../../shared/saved-duplicate-evidence';
const calls = vi.hoisted(() => ({ api: vi.fn(), profileId: 'fictional-profile' }));
vi.mock('../../app/data/api', () => ({ api: calls.api }));
vi.mock('../../app/data/profile', () => ({ useProfile: () => ({ id: calls.profileId }) }));
const reference: SavedDuplicateEvidenceReference = {
  format: 'health-saved-evidence-v1',
  kind: 'document',
  recordId: 'fictional',
  count: 10001,
  digest: 'a'.repeat(64),
  scopeDigest: 'b'.repeat(64),
  stateHash: 'c'.repeat(64),
  url: '/api/clinical-review/saved-evidence?selected=fictional',
};
const value = {
  kind: 'value' as const,
  id: 'first',
  value: {
    label: 'Fictional original',
    locator: 'First retained locator',
    sourceRecordId: 'fictional',
    contentUrl: '/api/sources/fictional/content',
  },
};
beforeEach(() => {
  calls.api.mockReset();
  calls.profileId = 'fictional-profile';
});
it('replaces source pages and byte-exact fragments instead of accumulating high-degree evidence', async () => {
  const user = userEvent.setup(),
    bytes = new TextEncoder().encode('First detail ' + 'x'.repeat(32755) + '😀 Last detail');
  calls.api.mockImplementation(async (url: string) => {
    if (url.includes('&item=')) {
      const offset = Number(new URL(url, 'http://fictional').searchParams.get('offset')),
        end = Math.min(offset + 32768, bytes.length);
      return {
        data: {
          encoding: 'base64',
          data: btoa(String.fromCharCode(...bytes.subarray(offset, end))),
          complete: end === bytes.length,
          nextOffset: end === bytes.length ? null : end,
        },
      };
    }
    return {
      data: url.includes('after=first')
        ? {
            reference,
            items: [
              {
                kind: 'fragment',
                id: 'detail',
                bytes: bytes.length,
                url: reference.url + '&item=detail',
              },
            ],
            complete: false,
            after: 'detail',
          }
        : { reference, items: [value], complete: false, after: 'first' },
    };
  });
  render(<SavedDuplicateEvidence reference={reference} />);
  expect(await screen.findByText('First retained locator', { exact: false })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Next saved evidence page' }));
  await user.click(await screen.findByRole('button', { name: /Open saved evidence detail/ }));
  expect(await screen.findByText(/^First detail/)).toBeVisible();
  expect(screen.queryByText('First retained locator', { exact: false })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Next saved evidence fragment' }));
  expect(await screen.findByText(/😀 Last detail/)).toBeVisible();
  expect(screen.queryByText(/^First detail/)).toBeNull();
});
it('refuses mixed saved evidence and invalid fragment windows', async () => {
  calls.api.mockResolvedValue({
    data: {
      reference: { ...reference, digest: 'wrong' },
      items: [value],
      complete: true,
      after: null,
    },
  });
  const mounted = render(<SavedDuplicateEvidence reference={reference} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('exact bounded review');
  mounted.unmount();
  calls.api.mockImplementation(async (url: string) => ({
    data: url.includes('&item=')
      ? { encoding: 'base64', data: btoa('short'), complete: false, nextOffset: 32768 }
      : {
          reference,
          items: [
            { kind: 'fragment', id: 'detail', bytes: 40000, url: reference.url + '&item=detail' },
          ],
          complete: false,
          after: 'detail',
        },
  }));
  render(<SavedDuplicateEvidence reference={reference} />);
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: /Open saved evidence detail/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('bounded window');
});
it('clears loaded evidence and aborts old requests on profile change', async () => {
  calls.api.mockResolvedValue({
    data: { reference, items: [value], complete: false, after: 'first' },
  });
  const mounted = render(<SavedDuplicateEvidence reference={reference} />);
  expect(await screen.findByText('First retained locator', { exact: false })).toBeVisible();
  const signal = calls.api.mock.calls[0]![1].signal as AbortSignal;
  calls.profileId = 'other-fictional';
  calls.api.mockImplementation(() => new Promise(() => {}));
  mounted.rerender(<SavedDuplicateEvidence reference={reference} />);
  expect(screen.queryByText('First retained locator', { exact: false })).toBeNull();
  expect(signal.aborted).toBe(true);
});

it('refuses a premature complete page even when its evidence reference matches', async () => {
  calls.api.mockResolvedValue({ data: { reference, items: [value], complete: true, after: null } });
  render(<SavedDuplicateEvidence reference={reference} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('exact bounded review');
  expect(screen.queryByText('First retained locator', { exact: false })).toBeNull();
});

it.each([
  '/api/sources/fictional/content',
  '/api/profiles/fictional-profile/sources/fictional/content',
])('opens current-profile original evidence returned as %s', async (contentUrl) => {
  calls.api.mockResolvedValue({
    data: {
      reference,
      items: [{ ...value, value: { ...value.value, contentUrl } }],
      complete: false,
      after: 'first',
    },
  });
  render(<SavedDuplicateEvidence reference={reference} />);
  expect(await screen.findByRole('link', { name: 'Fictional original' })).toHaveAttribute(
    'href',
    '/api/profiles/fictional-profile/sources/fictional/content',
  );
});

it.each([
  '/api/profiles/foreign/sources/fictional/content',
  '/api/profiles/fictional-profile-extra/sources/fictional/content',
  '/api/profiles/fictional-profile/sources/fictional/content?download=1',
  'https://fictional.invalid/api/sources/fictional/content',
])('refuses an original URL outside the exact current-profile route: %s', async (contentUrl) => {
  calls.api.mockResolvedValue({
    data: {
      reference,
      items: [{ ...value, value: { ...value.value, contentUrl } }],
      complete: false,
      after: 'first',
    },
  });
  render(<SavedDuplicateEvidence reference={reference} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('exact bounded review');
  expect(screen.queryByRole('link', { name: 'Fictional original' })).toBeNull();
});
