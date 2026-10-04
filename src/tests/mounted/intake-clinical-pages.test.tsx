import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import {
  ClinicalReviewReference,
  ClinicalReviewSection,
} from '../../app/features/intake/ClinicalReviewPages';
import { ReferencedClinicalRecord } from '../../app/features/intake/ReferencedClinicalRecord';
import { CollectionImportReview } from '../../app/features/import/CollectionImportReview';
import { readSelectedClinicalReview } from '../../app/data/intake-clinical-review';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type {
  IntakeClinicalRecordRead,
  IntakeClinicalReviewContext,
  IntakeClinicalReviewPage,
} from '../../shared/intake-clinical-review';
import type { CollectionImportFeed } from '../../shared/intake-clinical-pages';

vi.mock('../../app/features/import/ImportSourceTextBrowser', () => ({
  ImportSourceTextBrowser: () => <p>Retained original browser</p>,
}));
const profile = { id: 'fictional-clinical-page', name: 'Fictional Reader', placebo: true };
const context: IntakeClinicalReviewContext = {
  intakeId: 'fictional-intake',
  proposalId: 'fictional-proposal',
  version: 7,
  reviewToken: 'review-7',
  summary: { additions: 1, duplicates: 0, unsupported: 0, uncertain: 0 },
  sourceTextStale: false,
};
const text = 'first evidence page '.repeat(1600) + ' '.repeat(768) + 'second evidence page';
const bytes = new TextEncoder().encode(text);
const reference = {
  format: 'health-intake-clinical-review-reference-v2' as const,
  reviewToken: context.reviewToken,
  section: 'records' as const,
  ordinal: 0,
  bytes: bytes.length,
};
const record: Extract<IntakeClinicalRecordRead['record'], { kind: 'reference' }> = {
  kind: 'reference',
  reference,
  selection: {
    recordId: 'record',
    candidateId: 'candidate',
    candidateVersionId: 'version',
    selectionReviewToken: 'selection-7',
  },
  policy: {
    canAcceptUnchanged: true,
    blockingIssueCount: 0,
    unreviewedPairChoices: false,
    classification: 'addition',
    kind: 'document',
  },
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const fragment = (offset: number) => {
  const end = Math.min(bytes.length, offset + 32768);
  return {
    encoding: 'base64',
    data: Buffer.from(bytes.subarray(offset, end)).toString('base64'),
    complete: end === bytes.length,
    nextOffset: end === bytes.length ? null : end,
  };
};
beforeEach(() => {
  sessionStorage.clear();
  replaceProfiles([profile]);
  selectProfile(profile);
});

it('opens exact selected authority and refuses display-page substitution', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL) =>
    json({ format: 'health-intake-clinical-record-v2', context, record }),
  );
  vi.stubGlobal('fetch', fetch);
  expect(
    (await readSelectedClinicalReview(context.intakeId, context.proposalId, 'record', 'version'))
      .record,
  ).toEqual(record);
  const url = String(fetch.mock.calls[0]?.[0]);
  expect(url).toContain('/review-record?');
  expect(url).toContain('candidateVersionId=version');
  fetch.mockImplementation(async () => json({ format: 'health-intake-clinical-review-page-v2' }));
  await expect(
    readSelectedClinicalReview(context.intakeId, context.proposalId, 'record'),
  ).rejects.toThrow('display page');
});

it('holds only one 32 KiB evidence window and requires every sequential page before unchanged approval', async () => {
  const writes: unknown[] = [];
  const offsets: number[] = [];
  const changed = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/review-fragment')) {
        const body = JSON.parse(String(init?.body));
        expect(body.bytes).toBe(32768);
        offsets.push(body.offset);
        return json(fragment(body.offset));
      }
      if (url.includes('/review-record?'))
        return json({ format: 'health-intake-clinical-record-v2', context, record });
      if (url.endsWith('/report-acceptance')) {
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        return json({
          receipt: {
            operationId: body.operationId,
            status: 'accepted',
            atomic: true,
            at: '2026-10-03T12:00:00Z',
            selectedCount: 1,
            acceptedCount: 1,
            receipts: [
              {
                intakeId: context.intakeId,
                proposalId: context.proposalId,
                intakeVersionBefore: 7,
                intakeVersionAfter: 8,
                reviewToken: context.reviewToken,
                records: [
                  {
                    recordId: 'record',
                    candidateId: 'candidate',
                    candidateVersionId: 'version',
                    entityId: 'fictional-document',
                    kind: 'document',
                    title: 'Fictional report',
                    optical: false,
                    outcome: 'added',
                  },
                ],
              },
            ],
          },
          replayed: false,
          durability: { pending: false, mutationRevision: 8, persistedRevision: 8, error: null },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  const view = render(
    <ReferencedClinicalRecord
      context={context}
      record={record}
      onRefresh={vi.fn()}
      onChanged={changed}
      onBack={vi.fn()}
    />,
  );
  const save = screen.getByRole('button', { name: 'Save reviewed clinical record' });
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Open evidence' }));
  await screen.findByRole('button', { name: 'Next evidence page' });
  expect(save).toBeDisabled();
  expect(view.container.querySelector('pre')!.textContent!.length).toBeLessThanOrEqual(32768);
  fireEvent.click(screen.getByRole('button', { name: 'Next evidence page' }));
  await screen.findByText('All pages of this exact item have been opened.');
  expect(view.container.querySelector('pre')).toHaveTextContent('second evidence page');
  expect(view.container.querySelector('pre')).not.toHaveTextContent('first evidence page');
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(offsets).toEqual([0, 32768]);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    mode: 'partial-v1',
    blocks: [
      {
        intakeId: context.intakeId,
        proposalId: context.proposalId,
        intakeVersion: 7,
        reviewToken: 'review-7',
        selections: [
          {
            recordId: 'record',
            candidateId: 'candidate',
            candidateVersionId: 'version',
            selectionReviewToken: 'selection-7',
            mapping: {},
            useRetainedDecision: true,
          },
        ],
      },
    ],
  });
});

it('refuses a stale reference at final approval without posting a clinical mutation', async () => {
  const small = { ...record, reference: { ...reference, bytes: 1 } };
  let posts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/review-fragment'))
        return json({ encoding: 'base64', data: 'eA==', complete: true, nextOffset: null });
      if (url.includes('/review-record?'))
        return json({
          format: 'health-intake-clinical-record-v2',
          context,
          record: { ...small, selection: { ...small.selection, selectionReviewToken: 'changed' } },
        });
      posts++;
      return json({});
    }),
  );
  render(
    <ReferencedClinicalRecord
      context={context}
      record={small}
      onRefresh={vi.fn()}
      onChanged={vi.fn()}
      onBack={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open evidence' }));
  await screen.findByText('All pages of this exact item have been opened.');
  fireEvent.click(screen.getByRole('button', { name: 'Save reviewed clinical record' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('This exact evidence changed');
  expect(posts).toBe(0);
});

it('refuses a nonadvancing page and never marks incomplete evidence as inspected', async () => {
  const inspected = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ encoding: 'base64', data: '', complete: false, nextOffset: 0 })),
  );
  render(
    <ClinicalReviewReference
      intakeId={context.intakeId}
      proposalId={context.proposalId}
      reference={reference}
      onRefresh={vi.fn()}
      onInspected={inspected}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open evidence' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('evidence fragment changed');
  expect(inspected).not.toHaveBeenCalledWith(true);
});

it('discards a late fragment when its exact selected scope changes', async () => {
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
  const view = render(
    <ClinicalReviewReference
      intakeId={context.intakeId}
      proposalId={context.proposalId}
      reference={reference}
      onRefresh={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open evidence' }));
  view.rerender(
    <ClinicalReviewReference
      intakeId={context.intakeId}
      proposalId={context.proposalId}
      reference={{ ...reference, reviewToken: 'new-scope' }}
      onRefresh={vi.fn()}
    />,
  );
  await act(async () => release(json(fragment(0))));
  expect(view.container.querySelector('pre')).toBeNull();
  expect(screen.getByRole('button', { name: 'Open evidence' })).toBeEnabled();
});

it('opens independent source-context pages without accumulating previous values', async () => {
  const page: IntakeClinicalReviewPage = {
    format: 'health-intake-clinical-review-page-v2',
    ...context,
    sourceTextStale: false,
    section: 'coverageGaps',
    total: 101,
    items: [
      {
        kind: 'value',
        ordinal: 0,
        value: { label: 'First fictional gap', detail: 'First missing date' },
      },
    ],
    nextCursor: 'next',
  };
  const fetch = vi.fn(async (input) =>
    json(
      String(input).includes('cursor=next')
        ? {
            ...page,
            items: [
              {
                kind: 'value',
                ordinal: 40,
                value: { label: 'Second fictional gap', detail: 'Second missing date' },
              },
            ],
            nextCursor: null,
          }
        : page,
    ),
  );
  vi.stubGlobal('fetch', fetch);
  render(
    <ClinicalReviewSection
      intakeId={context.intakeId}
      proposalId={context.proposalId}
      section="coverageGaps"
    />,
  );
  await screen.findByText('First fictional gap');
  expect(screen.getByText('101 coverage gaps in this complete review.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Next coverage gaps' }));
  await screen.findByText('Second fictional gap');
  expect(screen.queryByText('First fictional gap')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('keeps native feed totals complete while replacing the single displayed window', async () => {
  const base: CollectionImportFeed = {
    format: 'health-intake-import-feed-v2',
    view: 'active',
    records: [],
    totalRecords: 10001,
    totalGroups: 5001,
    nextCursor: 'next',
    counts: {
      pending: 10001,
      deferred: 0,
      blocked: 0,
      accepted: 0,
      keptOriginal: 0,
      superseded: 0,
      questions: 0,
    },
    kindCounts: {
      test: 0,
      procedure: 0,
      history: 10001,
      prescription: 0,
      vision: 0,
      person: 0,
      unsupported: 0,
    },
    groups: [],
    people: {
      groups: [],
      totalGroups: 0,
      counts: { pending: 0, later: 0, excluded: 0, saved: 0 },
      nextCursor: null,
    },
    activity: {
      format: 'activity',
      binding: 'pinned',
      runningFiles: 1,
      pausedFiles: 0,
      queuedFiles: 0,
      filesAwaitingConversion: 0,
      remainingUnits: { state: 'pending', value: null },
      extractionUnknownFiles: 1,
      extractionComplete: false,
      allCurrentReportsReviewed: false,
      readingAccounting: { state: 'referenced', scope: 'full', binding: 'pinned' },
    },
  };
  const row = (id: string) => ({
    intakeId: context.intakeId,
    groupId: 'group',
    groupOrdinal: 0,
    proposalId: context.proposalId,
    intakeVersion: 7,
    reviewToken: context.reviewToken,
    feedKind: 'history' as const,
    feedKey: id,
    feedOrder: id,
    manuallyEdited: false,
    detail: {
      kind: 'reference' as const,
      reference,
      selection: { recordId: id, candidateVersionId: 'version' },
    },
  });
  const first = { ...base, records: [row('first')] };
  const fetch = vi.fn(async (input) =>
    json(
      String(input).includes('cursor=next')
        ? { ...base, records: [row('second')], nextCursor: null }
        : first,
    ),
  );
  vi.stubGlobal('fetch', fetch);
  render(
    <MemoryRouter>
      <CollectionImportReview
        initial={first}
        path="/intakes/import-feed?view=active"
        onChanged={vi.fn()}
        sourceProps={{ onChanged: vi.fn() }}
        onUpload={vi.fn()}
        busy={false}
        status=""
        error=""
      />
    </MemoryRouter>,
  );
  expect(await screen.findByText(/10,001 clinical records/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Next records' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Next records' })).toBeNull());
  expect(await screen.findByRole('link', { name: 'Review exact record' })).toHaveAttribute(
    'href',
    expect.stringContaining('record=second'),
  );
  expect(screen.getAllByRole('link', { name: 'Review exact record' })).toHaveLength(1);
  expect(screen.getByText(/Remaining reading work is still being checked/)).toBeVisible();
  expect(
    fetch.mock.calls.filter(([input]) => String(input).includes('/import-feed?')),
  ).toHaveLength(2);
});

it('accepts a referenced named person only after evidence pages and sends exact authority without copying person text', async () => {
  const { CollectionPeople } = await import('../../app/features/import/CollectionImportReview');
  const changed = vi.fn();
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input),
        body = JSON.parse(String(init?.body));
      requests.push({ url, body });
      if (url.endsWith('/people-fragment'))
        return json({ encoding: 'base64', data: 'eA==', nextOffset: null, complete: true });
      if (url.endsWith('/people-apply')) return json({ status: 'saved' });
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  render(
    <CollectionPeople
      groupId="group"
      page={{
        format: 'health-intake-people-page-v2',
        selectedPersonId: null,
        intakeId: context.intakeId,
        groupId: 'group',
        people: [
          {
            kind: 'reference',
            reference: {
              format: 'health-intake-person-reference-v2',
              intakeId: context.intakeId,
              id: 'fictional-person',
              binding: 'bound-person',
              bytes: 1,
              selection: {
                id: 'fictional-person',
                version: 'person-v7',
                intakeVersion: 7,
                state: 'pending',
              },
              policy: { selfMatch: false, canAdd: true },
              matches: {
                items: [{ noteId: 'retained-note', version: 4, title: 'Fictional match' }],
                total: 1,
                truncated: false,
              },
            },
          },
        ],
        totalPeople: 10001,
        counts: { pending: 10001, later: 0, excluded: 0, saved: 0 },
        nextCursor: 'next',
      }}
      onRefresh={changed}
      onNext={vi.fn()}
    />,
  );
  const add = screen.getByRole('button', { name: 'Add named person' });
  expect(add).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Update Fictional match' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Open evidence' }));
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(requests[1]!.body).toEqual({
    operationId: expect.any(String),
    intakeId: context.intakeId,
    proposalId: 'fictional-person',
    proposalVersion: 'person-v7',
    action: 'add',
  });
  expect(JSON.stringify(requests[1]!.body).length).toBeLessThan(300);
});

for (const changedAuthority of [false, true])
  it(`approves a native feed selection through fresh exact authority (changed=${changedAuthority})`, async () => {
    const currentRecord = {
      id: 'record',
      kind: 'document' as const,
      title: 'Fictional summary',
      provider: 'Fictional Clinic',
      date: null,
      classification: 'addition' as const,
      confidence: 1,
      uncertainties: [],
      evidence: [],
      mapping: { kind: 'document' as const, documentTitle: 'Fictional summary' },
      supportedFields: [],
      candidateId: 'candidate',
      candidateVersionId: 'version',
      selectionReviewToken: 'selected-v7',
      reviewState: 'pending' as const,
      queueState: 'pending' as const,
      selectable: true,
      feedKey: 'key',
      feedOrder: 'key',
      feedKind: 'history' as const,
      manuallyEdited: false,
    };
    const feed: CollectionImportFeed = {
      format: 'health-intake-import-feed-v2',
      view: 'active',
      records: [
        {
          intakeId: context.intakeId,
          groupId: 'group',
          groupOrdinal: 0,
          proposalId: context.proposalId,
          intakeVersion: 7,
          reviewToken: context.reviewToken,
          feedKind: 'history',
          feedKey: 'key',
          feedOrder: 'key',
          manuallyEdited: false,
          detail: { kind: 'record', record: currentRecord },
        },
      ],
      totalRecords: 1,
      totalGroups: 1,
      nextCursor: null,
      counts: {
        pending: 1,
        deferred: 0,
        blocked: 0,
        accepted: 0,
        keptOriginal: 0,
        superseded: 0,
        questions: 0,
      },
      kindCounts: {
        test: 0,
        procedure: 0,
        history: 1,
        prescription: 0,
        vision: 0,
        person: 0,
        unsupported: 0,
      },
      groups: [],
      people: {
        groups: [],
        totalGroups: 0,
        counts: { pending: 0, later: 0, excluded: 0, saved: 0 },
        nextCursor: null,
      },
      activity: {
        format: 'activity',
        binding: 'pinned',
        runningFiles: 0,
        pausedFiles: 0,
        queuedFiles: 0,
        filesAwaitingConversion: 0,
        remainingUnits: { state: 'exact', value: 0 },
        extractionUnknownFiles: 0,
        extractionComplete: true,
        allCurrentReportsReviewed: false,
        readingAccounting: { state: 'referenced', scope: 'full', binding: 'pinned' },
      },
    };
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const url = String(input);
        if (url.includes('/import-feed?')) return json(feed);
        if (url.includes('/review-record?'))
          return json({
            format: 'health-intake-clinical-record-v2',
            context,
            record: {
              kind: 'record',
              record: {
                ...currentRecord,
                selectionReviewToken: changedAuthority
                  ? 'foreign-token'
                  : currentRecord.selectionReviewToken,
              },
            },
          });
        if (url.endsWith('/report-acceptance')) {
          const body = JSON.parse(String(init?.body));
          writes.push(body);
          return json({
            receipt: {
              operationId: body.operationId,
              status: 'accepted',
              atomic: true,
              at: '2026-10-03T12:00:00Z',
              selectedCount: 1,
              acceptedCount: 1,
              receipts: [],
            },
            replayed: false,
            durability: { pending: false, mutationRevision: 8, persistedRevision: 8, error: null },
          });
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    render(
      <MemoryRouter>
        <CollectionImportReview
          initial={feed}
          path="/intakes/import-feed?view=active"
          onChanged={vi.fn()}
          sourceProps={{ onChanged: vi.fn() }}
          onUpload={vi.fn()}
          busy={false}
          status=""
          error=""
        />
      </MemoryRouter>,
    );
    await screen.findByRole('checkbox', { name: 'Select Fictional summary' });
    // Wait for the first pinned server page before selecting it.
    await act(async () => {});
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Fictional summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 record' }));
    if (changedAuthority) {
      expect(
        await screen.findByText(
          'A selected record changed. Refresh the page and review it before saving.',
        ),
      ).toBeVisible();
      expect(writes).toHaveLength(0);
    } else {
      expect(
        await screen.findByText('1 records saved. Any remaining records still need review.'),
      ).toBeVisible();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        mode: 'partial-v1',
        blocks: [
          {
            intakeVersion: 7,
            reviewToken: context.reviewToken,
            selections: [
              {
                recordId: 'record',
                selectionReviewToken: 'selected-v7',
                mapping: currentRecord.mapping,
              },
            ],
          },
        ],
      });
    }
  });

it('confirms the complete paged report source scope and retains the exact operation after an uncertain result', async () => {
  const { CollectionReportSource } =
    await import('../../app/features/import/CollectionReportSource');
  const sourceReview = {
    format: 'health-intake-report-source-review-v2',
    profileId: profile.id,
    intakeId: context.intakeId,
    intakeVersion: 7,
    groupId: 'group',
    groupVersionId: 'group-v7',
    view: 'all',
    scopeToken: 'complete-10001-members',
    targets: { items: [], total: 10001, nextCursor: 'next-targets' },
    coverage: {
      covered: 1,
      uncovered: 10000,
      total: 10001,
      status: 'mixed',
      sourceCount: 1,
      bySource: { items: [{ source: 'Fictional Clinic', count: 1 }], total: 1, nextCursor: null },
    },
    sourceEvidence: { items: [], total: 0, nextCursor: null },
    conflictingSourceEvidence: false,
  };
  const writes: Record<string, unknown>[] = [];
  const changed = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/report-source-review?')) return json(sourceReview);
      if (url.endsWith('/report-source')) {
        writes.push(JSON.parse(String(init?.body)));
        if (writes.length === 1)
          return json(
            { code: 'UNCERTAIN', message: 'Fictional connection lost after publication.' },
            503,
          );
        return json({});
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  render(
    <CollectionReportSource intakeId={context.intakeId} groupId="group" onChanged={changed} />,
  );
  fireEvent.click(screen.getByText('Source label for this report'));
  await screen.findByText(/10001 records in this complete scope/);
  fireEvent.change(screen.getByLabelText('Source', { exact: true }), {
    target: { value: 'Fictional Clinic' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Use source for 10001 records' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Fictional connection lost');
  fireEvent.click(screen.getByRole('button', { name: 'Use source for 10001 records' }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]).toMatchObject({
    version: 7,
    groupId: 'group',
    groupVersionId: 'group-v7',
    scopeToken: 'complete-10001-members',
    source: 'Fictional Clinic',
  });
  expect(writes[0]).not.toHaveProperty('targets');
});

it('pins a generic field fragment total and refuses an inconsistent later response', async () => {
  const { CollectionEvidenceWindow } =
    await import('../../app/features/import/CollectionImportReview');
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json(
        ++reads === 1
          ? {
              encoding: 'base64',
              data: Buffer.from('x'.repeat(32768)).toString('base64'),
              complete: false,
              nextOffset: 32768,
              totalBytes: 32769,
            }
          : {
              encoding: 'base64',
              data: 'eQ==',
              complete: false,
              nextOffset: 32769,
              totalBytes: 32770,
            },
      ),
    ),
  );
  render(
    <CollectionEvidenceWindow
      scope="fictional-field"
      label="Original filename"
      path="/intakes/fictional-intake/collection-fragment"
      body={{ reference: { format: 'fictional-reference' } }}
      onRefresh={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open evidence' }));
  await screen.findByRole('button', { name: 'Next evidence page' });
  fireEvent.click(screen.getByRole('button', { name: 'Next evidence page' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('This evidence page changed');
  expect(reads).toBe(2);
});
