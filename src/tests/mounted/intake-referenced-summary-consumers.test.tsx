import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { IntakeSummaryV3, IntakeFilenameReferenceV2 } from '../../shared/intake-summary';
import type { IntakeSourceText, SourceTextRevision } from '../../shared/intake-source-text';

vi.mock('../../app/components/SourceDialog', () => ({
  SourcePreview: ({
    file,
    initialPage,
  }: {
    file: { id: string; mimeType: string; path: string; contentUrl: string; bytes: number };
    initialPage?: number;
  }) => <div data-testid="source-preview">{JSON.stringify({ ...file, initialPage })}</div>,
}));

const profile = { id: 'fictional', name: 'Fictional reviewer', placebo: true, locked: false };
const giantName = '﻿fictional-\u0000-' + '🌿'.repeat(6000) + '\u0000.pdf';
// A scalar-bounded preview, as the server produces: never a lone surrogate.
const preview = Array.from(giantName).slice(0, 60).join('');
// Testing Library's default normalizer trims and collapses U+FEFF, so BOM-bearing
// text is matched on the element's exact textContent instead.
const exactText = (text: string) => (_content: string, element: Element | null) =>
  element?.textContent === text &&
  !Array.from(element.children).some((child) => child.textContent === text);
const exactButton = (label: string) =>
  screen
    .getAllByRole('button')
    .find((button) => (button.getAttribute('aria-label') ?? button.textContent) === label);

const reference = (intakeId: string): IntakeFilenameReferenceV2 => ({
  format: 'health-intake-filename-reference-v2',
  intakeId,
  field: 'originalName',
  pins: {
    sourceHash: 'a'.repeat(64),
    logicalRoot: 'b'.repeat(64),
    storageSequence: 3,
    sourceVersionId: 'fictional-version',
    fieldBinding: 'c'.repeat(64),
  },
  scalarHash: 'd'.repeat(64),
  bytes: Buffer.byteLength(JSON.stringify(giantName)),
});
function referenced(
  id: string,
  options: {
    mimeType?: IntakeSummaryV3['source']['mimeType'];
    predicates?: Partial<IntakeSummaryV3['source']['mimePredicates']>;
    parent?: string | null;
    retainOnly?: boolean;
  } = {},
): IntakeSummaryV3 {
  const path = `/intakes/${encodeURIComponent(id)}`;
  return {
    format: 'health-intake-summary-v3',
    id,
    parentSourceFileId: options.parent ?? null,
    archived: false,
    visibilityVersion: 0,
    filenamePreview: preview,
    filenameTruncated: true,
    filenameReference: reference(id),
    retainOnly: options.retainOnly ?? false,
    packageSource: false,
    bytes: 52,
    sha256: 'a'.repeat(64),
    createdAt: '2026-01-02T03:04:05.000Z',
    state: 'ready',
    version: 4,
    contentUrl: `/api/sources/${encodeURIComponent(id)}/content`,
    durability: undefined as unknown as IntakeSummaryV3['durability'],
    pins: { sourceHash: 'a'.repeat(64), logicalRoot: 'b'.repeat(64), domainVersion: 3, version: 4 },
    review: { state: 'pending', counts: null },
    activePlan: { state: 'pending', plan: null },
    collections: {
      proposals: { total: 0 },
      importHistory: { total: 0 },
      reportGroups: { total: 0 },
      candidates: { total: 0 },
      questions: { total: 0 },
      plans: { total: 0 },
      packageFailures: { total: 0, href: path + '/package-failures' },
    },
    links: {
      original: `/api/sources/${encodeURIComponent(id)}/content`,
      review: path + '/review',
      reports: `/intakes/import-feed?intakeId=${encodeURIComponent(id)}`,
      sourceText: path + '/source-text',
      package: path + '/package',
      plan: path + '/plan',
    },
    source: {
      providerId: { kind: 'value', value: 'Fictional Provider' },
      mimeType: options.mimeType ?? { kind: 'value', value: 'application/pdf' },
      mimePredicates: {
        pdf: true,
        image: false,
        previewableImage: false,
        packageMime: false,
        ...options.predicates,
      },
      providerName: { state: 'unloaded' },
    },
    acquisition: { state: 'unloaded' },
    metadata: undefined,
    metadataState: 'unloaded',
  };
}
const revision = (intakeId: string): SourceTextRevision => ({
  protectedPages: [],
  format: 'intake-source-text-v1',
  id: 'fictional-revision',
  parentRevisionId: null,
  profileId: 'fictional',
  intakeId,
  sourceHash: 'a'.repeat(64),
  createdAt: '2026-09-26T00:00:00Z',
  review: null,
  adapter: { name: 'fictional', version: '1' },
  pages: [{ page: 2, disposition: 'partial', inspected: false }],
  spans: [{ id: 'span', text: 'Fictional passage', region: { page: 2 }, provenance: 'native' }],
  relations: [],
  issues: [{ id: 'issue', region: { page: 2 }, kind: 'coverage', detail: 'Check', status: 'open' }],
});
const sourceText = (intakeId: string): IntakeSourceText => ({
  status: 'available',
  revision: revision(intakeId),
  summary: {
    pages: 1,
    spans: 1,
    unresolved: 1,
    exceptions: 0,
    inspectedPages: 0,
    status: 'needs-review',
  },
});

beforeEach(() => {
  vi.unstubAllGlobals();
  replaceProfiles([profile]);
  selectProfile(profile);
});

it('previews a referenced PDF page in place from accepted predicates, never a giant name', async () => {
  const intake = referenced('fictional-v3-pdf', {
    mimeType: {
      kind: 'reference',
      reference: {
        format: 'health-intake-source-field-reference-v1',
        intakeId: 'fictional-v3-pdf',
        sourceHash: 'a'.repeat(64),
        sourceVersionId: 'fictional-version',
        field: 'mimeType',
        bytes: 15,
        scalarHash: 'e'.repeat(64),
      },
    },
  });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/source-text')) return Response.json({ data: sourceText(intake.id) });
    throw Error('unexpected ' + url);
  });
  vi.stubGlobal('fetch', fetcher);
  const { SourceAttentionReview } = await import('../../app/features/import/SourceAttentionReview');
  render(<SourceAttentionReview intake={intake} onChanged={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
  const shown = JSON.parse(screen.getByTestId('source-preview').textContent!);
  expect(shown).toMatchObject({
    id: intake.id,
    mimeType: 'application/pdf',
    contentUrl: intake.contentUrl,
    bytes: 52,
    initialPage: 2,
  });
  // The truncated name is never assembled into a preview path or label.
  expect(shown.path).toBe(intake.contentUrl);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/source-preview'))).toBe(false);
});

it('reads a bounded literal section for a referenced non-PDF, non-image original', async () => {
  const intake = referenced('fictional-v3-text', {
    mimeType: { kind: 'value', value: 'text/plain' },
    predicates: { pdf: false },
  });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/source-text')) return Response.json({ data: sourceText(intake.id) });
    if (url.includes('/source-preview?page=2&revisionId=fictional-revision'))
      return Response.json({ data: { text: '﻿Fictional\u0000literal' } });
    throw Error('unexpected ' + url);
  });
  vi.stubGlobal('fetch', fetcher);
  const { SourceAttentionReview } = await import('../../app/features/import/SourceAttentionReview');
  render(<SourceAttentionReview intake={intake} onChanged={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
  expect((await screen.findByLabelText('Original section 2')).textContent).toBe(
    '﻿Fictional\u0000literal',
  );
  expect(JSON.parse(screen.getByTestId('source-preview').textContent!).mimeType).toBe('text/plain');
});

it('presents a referenced attention file compactly and reads its exact source-bound filename', async () => {
  const intake = referenced('fictional-v3-queue');
  const lexical = JSON.stringify(giantName);
  const posted: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/intakes/source-attention'))
        return Response.json({
          data: { items: [{ intakeId: intake.id }], sections: 1, offset: 0, nextOffset: null },
        });
      if (url.endsWith('/filename-fragment')) {
        posted.push(JSON.parse(String(options?.body)));
        return Response.json({
          data: {
            format: 'health-intake-filename-fragment-v1',
            reference: intake.filenameReference,
            encoding: 'json-string',
            text: lexical.slice(0, 40),
            complete: false,
            nextCursor: 'fictional-cursor',
          },
        });
      }
      if (url.includes('/source-text')) return Response.json({ data: sourceText(intake.id) });
      if (url.endsWith('/intakes/' + intake.id)) return Response.json({ data: intake });
      throw Error('unexpected ' + url);
    }),
  );
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  render(<ImportSourceTextBrowser attentionRows onChanged={() => {}} />);
  const heading = await screen.findByRole('heading', { level: 3 });
  expect(heading.textContent).toBe(preview + '… (shortened)');
  const details = screen.getByText('Full retained filename').parentElement!;
  details.setAttribute('open', '');
  fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]).toEqual({ reference: intake.filenameReference, limit: 32768 });
  expect(await screen.findByText(exactText(lexical.slice(0, 40)))).toBeVisible();
});

it('queues the referenced package root after walking V3 ancestry from a legacy child', async () => {
  const root = referenced('fictional-v3-root');
  const child = {
    id: 'fictional-child',
    filename: 'Fictional child.pdf',
    mimeType: 'application/pdf',
    parentSourceFileId: root.id,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('rootOnly='))
        return Response.json({ data: [child], meta: { complete: true } });
      if (url.endsWith('/intakes/' + child.id)) return Response.json({ data: child });
      if (url.endsWith('/intakes/' + root.id)) return Response.json({ data: root });
      if (url.includes('/source-issues'))
        return Response.json({ data: { status: 'unavailable', issues: [], nextOffset: null } });
      return Response.json({ data: { status: 'unavailable', revision: null, summary: null } });
    }),
  );
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  const onRead = vi.fn(async () => {});
  render(<ImportSourceTextBrowser onChanged={() => {}} onRead={onRead} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Fictional child.pdf' }));
  await userEvent.click(screen.getByRole('button', { name: 'Read source for clinical review' }));
  await screen.findByText(
    exactText(
      'Clinical reading queued for ' +
        preview +
        '… (shortened). Review the resulting proposals before saving records.',
    ),
  );
  expect(onRead).toHaveBeenCalledExactlyOnceWith(root.id);
});

it('refuses clinical reading for a referenced retain-only original', async () => {
  const intake = referenced('fictional-v3-audio', {
    mimeType: { kind: 'value', value: 'audio/mpeg' },
    predicates: { pdf: false },
    retainOnly: true,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/intakes/' + intake.id)) return Response.json({ data: intake });
      if (url.includes('/source-issues'))
        return Response.json({ data: { status: 'unavailable', issues: [], nextOffset: null } });
      return Response.json({ data: { status: 'unavailable', revision: null, summary: null } });
    }),
  );
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  const onRead = vi.fn(async () => {});
  render(<ImportSourceTextBrowser intakeId={intake.id} onChanged={() => {}} onRead={onRead} />);
  await waitFor(() => expect(exactButton(preview + '… (shortened)')).toBeDefined());
  await userEvent.click(exactButton(preview + '… (shortened)')!);
  expect(screen.getByRole('button', { name: 'Read source for clinical review' })).toBeDisabled();
  expect(screen.getByText(/This format is kept as an original only/)).toBeVisible();
  expect(onRead).not.toHaveBeenCalled();
});
