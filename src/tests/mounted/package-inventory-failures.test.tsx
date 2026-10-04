import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Intake, IntakePackageFailure, IntakePackageMember } from '../../shared/intake';
import type { IntakeSummaryV2 } from '../../shared/intake-summary';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import { PackageInventory } from '../../app/features/intake/PackageInventory';

const profile = { id: 'fictional-package-profile', name: 'Fictional Reader', placebo: true };
const intake = {
  id: 'fictional-package',
  filename: 'fictional-delivery.zip',
  contentUrl: '/api/sources/fictional-package/content',
  version: 1,
  mimeType: 'application/zip',
} as Intake;
const member: IntakePackageMember = {
  memberId: 'member:fictional-report',
  ordinal: 17,
  filename: 'reports/fictional-report.json',
  locator: 'ZIP member reports/fictional-report.json',
  bytes: 2,
  compressedBytes: 2,
  sourceHash: 'a'.repeat(64),
  duplicateOf: null,
};
const failure = (
  operationKey: string,
  retryAction: IntakePackageFailure['retryAction'],
): IntakePackageFailure => ({
  sourceFileId: intake.id,
  sourceHash: 'b'.repeat(64),
  operationKey,
  originalFilename: intake.filename,
  contentUrl: intake.contentUrl,
  memberId: member.memberId,
  ordinal: member.ordinal,
  filename: member.filename,
  locator: member.locator,
  reasonCode: retryAction === 'inventory' ? 'PACKAGE_CRC' : 'JSON_STRUCTURE',
  detail:
    retryAction === 'inventory'
      ? 'Inventory could not finish. The remaining package scope is unknown.'
      : retryAction === 'read_structure'
        ? 'This member could not be indexed as structured data.'
        : 'This member could not be read. Its original location remains retained.',
  status: 'pending',
  scope: 'incomplete',
  retryAction,
});
const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
const inventory = (members = [member]) =>
  json({
    intakeId: intake.id,
    version: 1,
    planId: null,
    sourceHash: 'b'.repeat(64),
    totalMembers: members.length,
    totalExpandedBytes: members.reduce((sum, item) => sum + item.bytes, 0),
    uniqueByteContents: members.length,
    members,
    offset: 0,
    nextOffset: null,
    coverage: 'inventory_only',
    complete: false,
  });

beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});

it('loads native processing issues as selected pages without fetching a complete intake', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      if (path.includes('/package?')) return inventory();
      if (path.includes('/package-failures?'))
        return json({
          format: 'health-intake-package-failure-page-v1',
          intakeId: intake.id,
          pins: {
            sourceHash: 'b'.repeat(64),
            logicalRoot: 'fictional-root',
            domainVersion: 1,
            version: 1,
          },
          entries: [{ key: 'exact', failure: failure('exact', 'read_member') }],
          total: 10001,
          complete: false,
          nextCursor: 'fictional-next',
        });
      throw Error('Unexpected complete intake request: ' + path);
    }),
  );
  render(
    <PackageInventory
      intake={{ ...intake, format: 'health-intake-summary-v2' } as unknown as IntakeSummaryV2}
    />,
  );
  expect(await screen.findByText(/10001 unfinished operations/)).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Next unfinished operations' }));
  await waitFor(() =>
    expect(requests.some((path) => path.includes('cursor=fictional-next'))).toBe(true),
  );
  expect(requests.some((path) => path.endsWith('/intakes/' + intake.id))).toBe(false);
});

it('keeps oversized member details in selected fragments and never uses the shortened name as identity', async () => {
  const reference = {
    format: 'health-intake-metadata-reference-v1',
    kind: 'package_member',
    intakeId: intake.id,
    inventoryId: 'fictional-inventory',
    memberId: member.memberId,
    ordinal: member.ordinal,
    sourceHash: 'b'.repeat(64),
    version: 1,
    metadataHash: 'c'.repeat(64),
    bytes: 100,
  };
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, options: RequestInit = {}) => {
      const path = String(input);
      if (path.includes('/package?'))
        return json({
          format: 'health-intake-package-inventory-v2',
          inventoryId: reference.inventoryId,
          totalMembers: 1,
          totalExpandedBytes: 2,
          uniqueByteContents: 1,
          members: [
            {
              format: 'health-intake-package-member-reference-v1',
              memberId: member.memberId,
              ordinal: 17,
              filenamePreview: 'fictional-long-name',
              filenameTruncated: true,
              metadata: reference,
            },
          ],
          offset: 0,
          nextOffset: null,
        });
      if (path.includes('/package-failures?'))
        return json({ entries: [], total: 0, complete: true, nextCursor: null });
      if (path.endsWith('/package-metadata')) {
        const body = JSON.parse(String(options.body));
        requests.push(body);
        return json({
          format: 'health-intake-metadata-fragment-v1',
          reference,
          text: body.offset === 0 ? 'first retained section' : 'second retained section',
          offset: body.offset,
          nextOffset: body.offset === 0 ? 50 : null,
          totalBytes: 100,
          complete: body.offset !== 0,
        });
      }
      if (path.endsWith('/package-member')) {
        requests.push(JSON.parse(String(options.body)));
        return json({ member });
      }
      throw Error('Unexpected request ' + path);
    }),
  );
  render(
    <PackageInventory
      intake={{ ...intake, format: 'health-intake-summary-v2' } as unknown as IntakeSummaryV2}
    />,
  );
  expect(await screen.findByText('File name shortened for display')).toBeVisible();
  await userEvent.setup().click(screen.getByText('Full retained file details'));
  expect(await screen.findByText('first retained section')).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Next part of file details' }));
  expect(await screen.findByText('second retained section')).toBeVisible();
  expect(screen.queryByText('first retained section')).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'fictional-long-name…' }));
  await waitFor(() =>
    expect(requests.some((body) => body.memberId === member.memberId)).toBe(true),
  );
  expect(requests.some((body) => body.memberId === 'fictional-long-name')).toBe(false);
});

it.each(['read_member', 'read_structure'] as const)(
  'clears a prior selected member and navigation when a different %s retry fails',
  async (retryAction) => {
    const other: IntakePackageMember = {
      ...member,
      memberId: 'member:fictional-other',
      ordinal: 18,
      filename: 'reports/fictional-other.json',
      locator: 'ZIP member reports/fictional-other.json',
    };
    const otherFailure = {
      ...failure('extract:' + other.memberId, retryAction),
      memberId: other.memberId,
      ordinal: other.ordinal,
      filename: other.filename,
      locator: other.locator,
    };
    const failures: Record<string, IntakePackageFailure> = { other: otherFailure };
    const requests: Record<string, unknown>[] = [];
    let otherAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, options: RequestInit = {}) => {
        const path = String(input);
        if (path.endsWith(`/intakes/${intake.id}`))
          return json({ ...intake, packageFailures: { ...failures } });
        if (path.includes(`/intakes/${intake.id}/package?`)) return inventory([member, other]);
        if (path.endsWith(`/intakes/${intake.id}/package-member`) && options.method === 'POST') {
          const body = JSON.parse(String(options.body)) as Record<string, unknown>;
          requests.push(body);
          if (body.memberId === member.memberId)
            return json({
              member,
              structure: {
                jsonPointer: body.jsonPointer || '',
                type: 'object',
                totalChildren: body.jsonPointer ? 0 : 1,
                children: body.jsonPointer
                  ? []
                  : [
                      {
                        key: 'Earlier member section',
                        jsonPointer: '/section',
                        type: 'string',
                        totalChildren: 0,
                      },
                    ],
                literal: body.jsonPointer ? 'Earlier selected member content' : null,
                offset: 0,
                nextOffset: null,
                nextJSONOffset: null,
              },
            });
          if (body.memberId === other.memberId && ++otherAttempts === 1)
            return new Response(
              JSON.stringify({
                error: {
                  code: 'PACKAGE_CRC',
                  message: 'The other member could not be read; original retained.',
                },
              }),
              { status: 413 },
            );
          if (body.memberId === other.memberId) {
            delete failures.other;
            return json({
              member: other,
              structure: {
                jsonPointer: '',
                type: 'object',
                totalChildren: 0,
                children: [],
                literal: 'Other member content',
                offset: 0,
                nextOffset: null,
                nextJSONOffset: null,
              },
            });
          }
        }
        throw new Error(`Unmocked request: ${options.method || 'GET'} ${path}`);
      }),
    );
    render(<PackageInventory intake={intake} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: member.filename }));
    await user.click(await screen.findByRole('button', { name: 'Earlier member section' }));
    expect(await screen.findByText('Earlier selected member content')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Back to parent section' })).toBeVisible();
    const retryName = retryAction === 'read_structure' ? 'Retry structure' : 'Retry member';
    await user.click(screen.getByRole('button', { name: retryName }));
    expect(
      await screen.findByText('The other member could not be read; original retained.'),
    ).toBeVisible();
    expect(
      screen.queryByRole('region', { name: 'Selected package member' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Earlier selected member content')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Back to parent section' }),
    ).not.toBeInTheDocument();
    for (const alert of screen.getAllByRole('alert'))
      expect(within(alert).queryByRole('button', { name: 'Retry member' })).not.toBeInTheDocument();
    const pending = screen.getByRole('region', { name: 'Unfinished package processing' });
    expect(within(pending).getByText(other.filename)).toBeVisible();
    expect(within(pending).getByRole('button', { name: retryName })).toBeVisible();
    expect(requests.at(-1)).toEqual({
      memberId: other.memberId,
      limit: 50,
      ...(retryAction === 'read_structure' ? { jsonPointer: '' } : {}),
    });
    await user.click(within(pending).getByRole('button', { name: retryName }));
    expect(await screen.findByText('Other member content')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Back to parent section' }),
    ).not.toBeInTheDocument();
    expect(requests.slice(-2).every((request) => request.memberId === other.memberId)).toBe(true);
  },
);

it('reloads durable failures after inventory fails, retains the exact original link, and retries inventory without clearing another pending scope', async () => {
  let releaseInventory!: () => void;
  const heldInventory = new Promise<void>((resolve) => {
    releaseInventory = resolve;
  });
  let failInventory = true;
  let failures: Record<string, IntakePackageFailure> = {};
  const detailReads: string[][] = [];
  let inventoryRequests = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const path = String(input);
    if (path.endsWith(`/intakes/${intake.id}`)) {
      detailReads.push(Object.keys(failures));
      return json({ ...intake, packageFailures: { ...failures } });
    }
    if (path.includes(`/intakes/${intake.id}/package?`)) {
      inventoryRequests++;
      if (failInventory) {
        await heldInventory;
        if (options.signal?.aborted) throw new DOMException('Read cancelled.', 'AbortError');
        failures = {
          inventory: failure('inventory', 'inventory'),
          structure: failure('structure:' + member.memberId, 'read_structure'),
        };
        return new Response(
          JSON.stringify({
            error: {
              code: 'PACKAGE_CRC',
              message: 'Package inventory could not finish. Original retained.',
            },
          }),
          { status: 413 },
        );
      }
      delete failures.inventory;
      return inventory();
    }
    throw new Error(`Unmocked request: ${options.method || 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<PackageInventory intake={intake} />);
  await waitFor(() => expect(detailReads).toContainEqual([]));
  expect(
    screen.getByRole('link', { name: 'Open original: fictional-delivery.zip' }),
  ).toHaveAttribute('href', intake.contentUrl);
  await act(async () => {
    releaseInventory();
  });
  expect(
    await screen.findByText('Inventory could not finish. The remaining package scope is unknown.'),
  ).toBeVisible();
  const pending = screen.getByRole('region', { name: 'Unfinished package processing' });
  expect(within(pending).getAllByText(member.filename)).toHaveLength(2);
  expect(within(pending).getAllByText(member.locator)).toHaveLength(2);
  expect(within(pending).getByText(/scope is incomplete/)).toBeVisible();
  expect(detailReads).toContainEqual(['inventory', 'structure']);
  for (const original of screen.getAllByRole('link', {
    name: 'Open original: fictional-delivery.zip',
  })) {
    expect(original).toHaveAttribute('href', intake.contentUrl);
    expect(original.getAttribute('href')).not.toContain('#page=');
  }
  const beforeRetry = inventoryRequests;
  failInventory = false;
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry inventory' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Retry inventory' })).not.toBeInTheDocument(),
  );
  expect(inventoryRequests).toBeGreaterThan(beforeRetry);
  expect(screen.getByRole('button', { name: 'Retry structure' })).toBeVisible();
  expect(screen.getByText('This member could not be indexed as structured data.')).toBeVisible();
  expect(detailReads).toContainEqual(['structure']);
  expect(fetcher.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
  expect(
    screen.queryByText(/^(Import complete|Extraction complete|Accepted)$/i),
  ).not.toBeInTheDocument();
});

it('posts the exact member retry, refreshes only that receipt, and posts a root pointer for a separate structure retry', async () => {
  let failures: Record<string, IntakePackageFailure> = {
    extract: failure('extract:' + member.memberId, 'read_member'),
    structure: failure('structure:' + member.memberId, 'read_structure'),
  };
  const requests: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const path = String(input);
    if (path.endsWith(`/intakes/${intake.id}`))
      return json({ ...intake, packageFailures: { ...failures } });
    if (path.includes(`/intakes/${intake.id}/package?`)) return inventory();
    if (path.endsWith(`/intakes/${intake.id}/package-member`) && options.method === 'POST') {
      const body = JSON.parse(String(options.body)) as Record<string, unknown>;
      requests.push(body);
      if (body.jsonPointer === '') {
        delete failures.structure;
        return json({
          member,
          structure: {
            jsonPointer: '',
            type: 'object',
            totalChildren: 0,
            children: [],
            literal: '{}',
            offset: 0,
            nextOffset: null,
            nextJSONOffset: null,
          },
        });
      }
      delete failures.extract;
      return json({ member, literal: '' });
    }
    throw new Error(`Unmocked request: ${options.method || 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<PackageInventory intake={intake} />);
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry member' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Retry member' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Retry member' })).not.toBeInTheDocument(),
  );
  expect(requests).toEqual([{ memberId: member.memberId, limit: 50 }]);
  expect(screen.getByRole('button', { name: 'Retry structure' })).toBeVisible();
  expect(screen.getByText('This member could not be indexed as structured data.')).toBeVisible();
  expect(screen.getByRole('region', { name: 'Selected package member' })).toBeVisible();
  expect(screen.getByRole('region', { name: 'Unfinished package processing' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Retry structure' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('region', { name: 'Unfinished package processing' }),
    ).not.toBeInTheDocument(),
  );
  expect(requests).toEqual([
    { memberId: member.memberId, limit: 50 },
    { memberId: member.memberId, limit: 50, jsonPointer: '' },
  ]);
  expect(screen.getByText('{}')).toBeVisible();
  expect(
    screen.getByRole('link', { name: 'Open original: fictional-delivery.zip' }),
  ).toHaveAttribute('href', intake.contentUrl);
  expect(
    screen.queryByText(/^(Import complete|Extraction complete|Accepted)$/i),
  ).not.toBeInTheDocument();
});
