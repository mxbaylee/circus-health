import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { IntakePackageFailure } from '../../shared/intake';
import { PackageProcessingFailures } from '../../app/features/intake/PackageProcessingFailures';
import { replaceProfiles, selectProfile } from '../../app/data/profile';

const failure: IntakePackageFailure = {
  sourceFileId: 'fictional-package',
  sourceHash: 'a'.repeat(64),
  operationKey: 'extract:member:fictional',
  originalFilename: 'fictional-delivery.zip',
  contentUrl: '/api/sources/fictional-package/content',
  memberId: 'member:fictional',
  ordinal: 17,
  filename: 'reports/fictional.pdf',
  locator: 'ZIP member reports/fictional.pdf',
  reasonCode: 'PACKAGE_CRC',
  detail: 'This member could not be read. The original remains retained.',
  status: 'pending',
  scope: 'incomplete',
  retryAction: 'read_member',
};

it('shows durable exact member scope and downloadable original without inventing a page; retries that scope', async () => {
  const retry = vi.fn();
  render(
    <PackageProcessingFailures failures={{ fictional: failure }} busy={false} onRetry={retry} />,
  );
  expect(screen.getByRole('region', { name: 'Unfinished package processing' })).toBeVisible();
  expect(screen.getByText('reports/fictional.pdf')).toBeVisible();
  expect(screen.getByText('ZIP member reports/fictional.pdf')).toBeVisible();
  expect(screen.getByText(/scope is incomplete/)).toBeVisible();
  const original = screen.getByRole('link', { name: 'Open original: fictional-delivery.zip' });
  expect(original).toHaveAttribute('href', failure.contentUrl);
  expect(original.getAttribute('href')).not.toContain('#page=');
  expect(screen.queryByText(/page 1/i)).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry member' }));
  expect(retry).toHaveBeenCalledWith(failure);
});

it('keeps an unknown inventory scope at the retained original and prevents retry while busy', () => {
  const inventory: IntakePackageFailure = {
    sourceFileId: failure.sourceFileId,
    sourceHash: failure.sourceHash,
    operationKey: 'inventory',
    originalFilename: failure.originalFilename,
    contentUrl: failure.contentUrl,
    reasonCode: 'PACKAGE_TRUNCATED',
    detail: 'The inventory could not finish; remaining members are unknown.',
    status: 'pending',
    scope: 'incomplete',
    retryAction: 'inventory',
  };
  render(<PackageProcessingFailures failures={{ inventory }} busy={true} onRetry={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Retry inventory' })).toBeDisabled();
  expect(screen.getByText(/remaining members are unknown/)).toBeVisible();
  expect(screen.queryByText(/Member ordinal/)).not.toBeInTheDocument();
});

it('uses the checked total for a selected page and keeps exact retry targets while more issues remain', async () => {
  const next = vi.fn(),
    retry = vi.fn();
  render(
    <PackageProcessingFailures
      busy={false}
      onRetry={retry}
      onNext={next}
      page={{
        format: 'health-intake-package-failure-page-v1',
        intakeId: failure.sourceFileId,
        pins: {
          sourceHash: failure.sourceHash,
          logicalRoot: 'fictional-root',
          domainVersion: 1,
          version: 1,
        },
        total: 10001,
        entries: [{ key: 'selected', failure }],
        complete: false,
        nextCursor: 'selected-next',
      }}
    />,
  );
  expect(screen.getByText(/10001 unfinished operations/)).toBeVisible();
  expect(screen.getByText('Showing 1 of 10001')).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Next unfinished operations' }));
  expect(next).toHaveBeenCalledOnce();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry member' }));
  expect(retry).toHaveBeenCalledWith(failure);
});

it('opens an exact long member location without putting it in the failure page', async () => {
  const profile = { id: 'fictional-package-profile', name: 'Fictional', placebo: true };
  replaceProfiles([profile]);
  selectProfile(profile);
  const reference = {
    format: 'health-intake-package-failure-field-reference-v1' as const,
    intakeId: failure.sourceFileId,
    key: 'fictional-key',
    field: 'filename' as const,
    pins: {
      sourceHash: failure.sourceHash,
      logicalRoot: 'fictional-root',
      domainVersion: 1,
      version: 1,
    },
    bytes: 20000,
  };
  const request = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
    const input = JSON.parse(String(options?.body));
    expect(input.reference).toEqual(reference);
    expect(input.limit).toBe(32768);
    const last = input.cursor === 'fictional-next';
    return new Response(
      JSON.stringify({
        data: {
          format: 'health-intake-package-failure-field-fragment-v1',
          reference,
          encoding: 'json-string',
          text: last ? 'long-member.txt"' : '"fictional-',
          complete: last,
          nextCursor: last ? null : 'fictional-next',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', request);
  const retry = vi.fn();
  try {
    render(
      <PackageProcessingFailures
        busy={false}
        onRetry={retry}
        page={{
          format: 'health-intake-package-failure-page-v1',
          intakeId: failure.sourceFileId,
          pins: reference.pins,
          total: 1,
          entries: [
            {
              key: reference.key,
              failure: {
                ...failure,
                originalFilename: 'fictional-delivery.zip',
                filename: undefined,
                locator: undefined,
              },
              fieldReferences: { filename: reference },
            },
          ],
          complete: true,
          nextCursor: null,
        }}
      />,
    );
    expect(screen.getByText('Retained member filename')).toBeVisible();
    expect(screen.queryByText('fictional-long-member.txt')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByText('Full member filename'));
    expect(await screen.findByText('"fictional-')).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('long-member.txt"')).toBeVisible();
    expect(screen.queryByText('"fictional-')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'First' }));
    expect(await screen.findByText('"fictional-')).toBeVisible();
    expect(request).toHaveBeenCalledTimes(3);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry member' }));
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ memberId: failure.memberId }));
  } finally {
    vi.unstubAllGlobals();
    replaceProfiles([]);
  }
});

it('discards a long-location response after its selected failure changes', async () => {
  const profile = { id: 'fictional-package-profile', name: 'Fictional', placebo: true };
  replaceProfiles([profile]);
  selectProfile(profile);
  const first = {
    format: 'health-intake-package-failure-field-reference-v1' as const,
    intakeId: failure.sourceFileId,
    key: 'fictional-key',
    field: 'locator' as const,
    pins: {
      sourceHash: failure.sourceHash,
      logicalRoot: 'first-root',
      domainVersion: 1,
      version: 1,
    },
    bytes: 20000,
  };
  const second = { ...first, pins: { ...first.pins, logicalRoot: 'second-root', version: 2 } };
  let releaseFirst: ((value: Response) => void) | undefined;
  const response = (reference: typeof first, text: string) =>
    new Response(
      JSON.stringify({
        data: {
          format: 'health-intake-package-failure-field-fragment-v1',
          reference,
          encoding: 'json-string',
          text,
          complete: true,
          nextCursor: null,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  const request = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
    const input = JSON.parse(String(options?.body));
    if (input.reference.pins.logicalRoot === 'first-root')
      return new Promise<Response>((resolve) => {
        releaseFirst = resolve;
      });
    return response(second, '"Current selected location"');
  });
  vi.stubGlobal('fetch', request);
  const page = (reference: typeof first) => ({
    format: 'health-intake-package-failure-page-v1' as const,
    intakeId: failure.sourceFileId,
    pins: reference.pins,
    total: 1,
    entries: [
      {
        key: reference.key,
        failure: { ...failure, locator: undefined },
        fieldReferences: { locator: reference },
      },
    ],
    complete: true,
    nextCursor: null,
  });
  try {
    const mounted = render(
      <PackageProcessingFailures page={page(first)} busy={false} onRetry={vi.fn()} />,
    );
    await userEvent.setup().click(screen.getByText('Full member location'));
    expect(request).toHaveBeenCalledOnce();
    mounted.rerender(
      <PackageProcessingFailures page={page(second)} busy={false} onRetry={vi.fn()} />,
    );
    expect(await screen.findByText('"Current selected location"')).toBeVisible();
    await act(async () => {
      releaseFirst?.(response(first, '"Stale previous location"'));
    });
    expect(screen.queryByText('"Stale previous location"')).not.toBeInTheDocument();
    expect(screen.getByText('"Current selected location"')).toBeVisible();
  } finally {
    vi.unstubAllGlobals();
    replaceProfiles([]);
  }
});
