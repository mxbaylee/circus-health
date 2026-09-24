import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { SourceDialog, SourceRecordView } from '../../app/components/SourceDialog';
import { selectProfile } from '../../app/data/profile';
import type {
  SourceFile,
  SourceFileReference,
  SourceRecord,
  SourceRecordReference,
} from '../../shared/api';

function file(id: string, provider: string | null, coverageStatus = 'retained'): SourceFile {
  return {
    id,
    providerId: provider ? `${id}-provider` : null,
    provider,
    path: `fictional/${id}.txt`,
    sha256: `${id}-hash`,
    bytes: 42,
    mimeType: 'text/plain',
    kind: 'intake_original',
    coverageStatus,
    details: {},
    contentUrl: `/fictional/${id}`,
  };
}

function field(label: string) {
  return screen.getByText(label, { selector: 'dt' }).parentElement!;
}

function reference(id: string, provider: string | null): SourceFileReference {
  return {
    id,
    providerId: provider ? `${id}-provider` : null,
    provider,
    reviewedSourceProviderId: null,
    reviewedSource: null,
    path: `fictional/${id}.txt`,
    sha256: `${id}-hash`,
    bytes: 42,
    mimeType: 'text/plain',
    kind: 'intake_original',
    coverageStatus: 'retained',
    contentUrl: `/fictional/${id}/content`,
    detailsUrl: `/fictional/${id}`,
    detailsIncluded: false,
  };
}

it('separates a reviewed record source from original and extraction file acquisition', async () => {
  const original = {
    ...file('original', 'Fictional Acquisition Service'),
    reviewedSourceProviderId: 'fictional-reviewed-file-provider',
    reviewedSource: 'Fictional Reviewed File Label',
  };
  const extraction = file(
    'extraction',
    'Fictional Extraction Service',
    'derived_proposal; unreviewed',
  );
  const record: SourceRecord = {
    id: 'fictional-reviewed-record',
    sourceFileId: extraction.id,
    providerId: 'fictional-reviewed-provider',
    provider: 'Fictional Reviewed Vision',
    sourceKey: 'line:1',
    kind: 'intake_document',
    label: 'Fictional optical report',
    date: '2026-09-01',
    raw: {},
    locator: { originalSourceFileId: original.id },
    extractionStatus: 'projected_reviewed',
    file: extraction,
    extractionFile: extraction,
    originalFile: original,
  };

  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <SourceRecordView record={record} />
    </MemoryRouter>,
  );

  expect(within(field('Record source')).getByText('Fictional Reviewed Vision')).toBeVisible();
  expect(within(field('Source record date')).getByText('Sep 1, 2026')).toBeVisible();
  expect(
    within(field('Original file acquisition source')).getByText('Fictional Acquisition Service'),
  ).toBeVisible();
  expect(
    within(field('Original reviewed source label')).getByText('Fictional Reviewed File Label'),
  ).toBeVisible();
  expect(
    within(field('Extraction file acquisition source')).getByText('Fictional Extraction Service'),
  ).toBeVisible();
  expect(
    within(field('Saved health record link')).getByText('Linked to a saved health record'),
  ).toBeVisible();
  expect(within(field('Retained file')).getByText(/Proposal snapshot retained/)).toBeVisible();
  const historical = screen.getByText('Historical extraction details').closest('details')!;
  expect(historical).not.toHaveAttribute('open');
  await user.click(within(historical).getByText('Historical extraction details'));
  expect(
    within(field('Historical coverage snapshot')).getByText(
      'Unreviewed when this snapshot was created',
    ),
  ).toBeVisible();
  expect(screen.queryByText('Historical record snapshot')).toBeNull();
  expect(
    screen.getByText(/historical extraction snapshot.*not its current Import review/i),
  ).toBeVisible();
  expect(screen.getByRole('link', { name: 'Open current Import review' })).toHaveAttribute(
    'href',
    '/import',
  );
  expect(screen.queryByText('derived_proposal; unreviewed')).toBeNull();
  expect(screen.getByText(/Record source describes this retained occurrence/)).toBeVisible();
  expect(screen.getByText(/source record date is an optional summary/i)).toBeVisible();
});

it('does not invent a record source when no reviewed label exists', () => {
  const original = file('unattributed-original', null);
  const record: SourceRecord = {
    id: 'fictional-unconfirmed-record',
    sourceFileId: original.id,
    providerId: null,
    provider: null,
    sourceKey: null,
    kind: 'intake_document',
    label: 'Fictional unconfirmed report',
    date: null,
    raw: {},
    locator: {},
    extractionStatus: 'retained',
    file: original,
    extractionFile: original,
    originalFile: original,
  };

  render(
    <MemoryRouter>
      <SourceRecordView record={record} />
    </MemoryRouter>,
  );

  expect(within(field('Record source')).getByText('Not recorded')).toBeVisible();
  expect(screen.queryByText('Source record date', { selector: 'dt' })).toBeNull();
  expect(
    within(field('Original file acquisition source')).getByText('Acquisition source not recorded'),
  ).toBeVisible();
  expect(screen.queryByText('Fictional Reviewed Vision')).toBeNull();
  expect(screen.queryByText('Original reviewed source label')).toBeNull();
  expect(screen.queryByText('Extraction file acquisition source')).toBeNull();
  expect(screen.getByText(/dates may still be present in the retained evidence/i)).toBeVisible();
});

it('describes missing upload attribution without obscuring a reviewed record label', () => {
  const original = {
    ...file('unknown-original', 'Unknown source'),
    reviewedSourceProviderId: 'fictional-reviewed-original-provider',
    reviewedSource: 'Fictional Reviewed Report Label',
  };
  const extraction = file('unknown-extraction', 'Unknown source', 'derived_proposal; unreviewed');
  const record: SourceRecord = {
    id: 'fictional-reviewed-unknown-acquisition',
    sourceFileId: extraction.id,
    providerId: 'fictional-reviewed-record-provider',
    provider: 'Fictional Reviewed Record Source',
    sourceKey: 'line:7',
    kind: 'intake_document',
    label: 'Fictional retained report',
    date: '2026-09-02',
    raw: {},
    locator: { originalSourceFileId: original.id },
    extractionStatus: 'projected_reviewed',
    file: extraction,
    extractionFile: extraction,
    originalFile: original,
  };

  render(
    <MemoryRouter>
      <SourceRecordView record={record} />
    </MemoryRouter>,
  );

  expect(
    within(field('Record source')).getByText('Fictional Reviewed Record Source'),
  ).toBeVisible();
  expect(
    within(field('Original file acquisition source')).getByText('Acquisition source not recorded'),
  ).toBeVisible();
  expect(
    within(field('Extraction file acquisition source')).getByText(
      'Acquisition source not recorded',
    ),
  ).toBeVisible();
  expect(
    within(field('Original reviewed source label')).getByText('Fictional Reviewed Report Label'),
  ).toBeVisible();
  expect(screen.queryByText('Unknown source')).toBeNull();
});

it('uses compact file references without losing distinct extraction semantics or resolved text', async () => {
  selectProfile({ id: 'fictional-reference-profile', name: 'Fictional Rowan', placebo: true });
  const original = reference('compact-original', 'Fictional Original Acquisition');
  const extraction = reference('compact-extraction', 'Fictional Extraction Service');
  const record: SourceRecordReference = {
    fileView: 'reference',
    id: 'fictional-compact-record',
    sourceFileId: extraction.id,
    providerId: 'fictional-reviewed-provider',
    provider: 'Fictional Reviewed Source',
    sourceKey: 'line:9',
    kind: 'source_capture',
    label: 'Fictional compact source',
    date: null,
    raw: { content: 'Fictional retained text' },
    rawText: '{"content":"Fictional retained text"}',
    locator: { originalSourceFileId: original.id },
    extractionStatus: 'projected_reviewed',
    file: extraction,
    extractionFile: extraction,
    originalFile: original,
    originalMissing: false,
    ancestorFiles: [],
    relationships: [],
  };
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      requests.push(url);
      const data = url.includes('/resolved?fileView=reference')
        ? {
            source: record,
            resolvedText: '{\n  "content": "Fictional retained text"\n}',
            referenceCount: 0,
            preservation: 'Fictional preservation explanation',
          }
        : record;
      return new Response(JSON.stringify({ data, meta: { revision: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <SourceDialog sourceRecordId={record.id} />
    </MemoryRouter>,
  );

  await user.click(screen.getByRole('button', { name: 'View source' }));
  expect(await screen.findByText('fictional-compact-record')).toBeVisible();
  expect(screen.getByRole('link', { name: /Open retained extraction/ })).toHaveAttribute(
    'href',
    extraction.contentUrl,
  );
  expect(screen.getByRole('link', { name: /Open original file/ })).toHaveAttribute(
    'href',
    original.contentUrl,
  );
  expect(
    within(field('Extraction file acquisition source')).getByText('Fictional Extraction Service'),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Expand referenced source text' }));
  expect(await screen.findByText(/0 retained references expanded/)).toBeVisible();
  await waitFor(() => {
    expect(
      requests.some((url) =>
        url.includes('/source-records/fictional-compact-record?fileView=reference'),
      ),
    ).toBe(true);
    expect(
      requests.some((url) =>
        url.includes('/source-records/fictional-compact-record/resolved?fileView=reference'),
      ),
    ).toBe(true);
  });
});
