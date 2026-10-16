import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ReferencedClinicalControls } from '../../app/features/intake/ReferencedClinicalControls';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { IntakeClinicalReviewContext } from '../../shared/intake-clinical-review';
import type { IntakeEvidenceComparison } from '../../shared/intake';
import type {
  ClinicalRecordAction,
  ClinicalRecordSection,
  ClinicalRecordSectionPage,
} from '../../shared/intake-clinical-record-sections';
const profile = { id: 'fictional-section-editor', name: 'Fictional Reader', placebo: true };
const context: IntakeClinicalReviewContext = {
  intakeId: 'fictional-intake',
  proposalId: 'fictional-proposal',
  version: 7,
  reviewToken: 'review-7',
  summary: { additions: 1, duplicates: 0, unsupported: 0, uncertain: 1 },
  sourceTextStale: false,
};
const selection = {
  recordId: 'fictional-record',
  candidateVersionId: 'version-1',
  selectionReviewToken: 'selection-7',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const page = (
  section: ClinicalRecordSection,
  items: ClinicalRecordSectionPage['items'],
  extra: Partial<ClinicalRecordSectionPage> = {},
): ClinicalRecordSectionPage => ({
  format: 'health-clinical-record-section-page-v1',
  context,
  selection: { ...selection, proposalId: context.proposalId },
  section,
  total: items.length,
  items,
  nextCursor: null,
  ...extra,
});
const issue: ClinicalRecordSectionPage['items'][number] = {
  ordinal: 0,
  control: {
    kind: 'issue',
    id: 'question-1',
    issueKind: 'date',
    field: 'documentDate',
    blocking: true,
    status: 'unresolved',
    mappingKind: 'document',
    resolutionFields: ['date', 'documentDate'],
    fieldValue: '2026-01-02',
    fieldValueReferenced: false,
  },
  detail: {
    kind: 'value',
    value: { prompt: 'Which date is shown in this fictional source?', locator: 'Page 1' },
  },
};
const pair: ClinicalRecordSectionPage['items'][number] = {
  ordinal: 0,
  control: {
    kind: 'pair',
    otherRecordId: 'saved-record',
    scopeToken: 'exact-fresh-scope',
    targetAvailable: true,
    draftScopeStatus: 'stale',
    outcome: 'distinct',
    reason: 'Older reviewed evidence',
    reasonReferenced: false,
  },
  detail: {
    kind: 'value',
    value: {
      comparison: { id: 'saved-record', title: 'Fictional saved value' },
      decision: { reason: 'Older reviewed evidence' },
    },
  },
};
beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Resolve questions or correct this record' }));
}
it('presents the selected native pair with original links and the exact saved correction target', async () => {
  const comparison: IntakeEvidenceComparison = {
    id: 'saved-record',
    kind: 'observation',
    title: 'Fictional saved beta',
    date: '2026-02-04',
    identity: 'fictional-person',
    version: 'saved-version',
    mapping: { kind: 'observation', valueText: '17.50', unit: 'mg/L', date: '2026-02-04' },
    evidence: [
      {
        label: 'Saved page',
        locator: 'Page 2',
        contentUrl: '/api/sources/fictional-saved/content',
      },
    ],
    previousDecision: null,
  };
  const corrected = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json(page('comparisons', [{ ...pair, detail: { kind: 'value', value: { comparison } } }])),
    ),
  );
  const mounted = render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      initialSection="comparisons"
      initiallyOpen
      incoming={{
        title: 'Fictional incoming alpha',
        date: '2026-02-04',
        mapping: comparison.mapping,
        evidence: [
          {
            label: 'Incoming page',
            locator: 'Page 1',
            contentUrl: '/api/sources/fictional-incoming/content',
          },
        ],
      }}
      onRefresh={() => {}}
      onPending={() => {}}
      onCorrectSaved={corrected}
    />,
  );
  fireEvent.click(await screen.findByText('Fictional saved beta · 2026-02-04'));
  expect(screen.getByRole('heading', { name: 'Incoming record' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Previously accepted record' })).toBeVisible();
  expect(screen.getByText('Fictional incoming alpha')).toBeVisible();
  expect(screen.getAllByText(/17.50 · mg\/L/)).toHaveLength(2);
  expect(mounted.container.querySelectorAll('.clinical-evidence-pair')).toHaveLength(1);
  expect(mounted.container.querySelector('pre')).toBeNull();
  const originals = screen.getAllByRole('link', { name: 'Open original' });
  expect(originals).toHaveLength(2);
  expect(originals.every((link) => link.getAttribute('target') === '_blank')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Correct this saved record' }));
  expect(corrected).toHaveBeenCalledWith(comparison);
  expect(screen.getByRole('button', { name: 'Save this relationship' })).toBeEnabled();
});
it('requires every giant issue evidence window before submitting its exact sparse decision', async () => {
  const bytes = new TextEncoder().encode('x'.repeat(32768) + 'last fictional window');
  const reference = {
    format: 'health-clinical-record-section-reference-v1' as const,
    recordId: selection.recordId,
    candidateVersionId: selection.candidateVersionId,
    proposalId: context.proposalId,
    reviewToken: context.reviewToken,
    section: 'issues' as const,
    ordinal: 0,
    bytes: bytes.length,
  };
  const writes: ClinicalRecordAction[] = [],
    offsets: number[] = [];
  const refreshed = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith('/review-record-section'))
        return json(page('issues', [{ ...issue, detail: { kind: 'reference', reference } }]));
      if (String(input).endsWith('/review-record-section-fragment')) {
        offsets.push(body.offset);
        const end = Math.min(bytes.length, body.offset + 32768);
        return json({
          encoding: 'base64',
          data: Buffer.from(bytes.subarray(body.offset, end)).toString('base64'),
          complete: end === bytes.length,
          nextOffset: end === bytes.length ? null : end,
        });
      }
      writes.push(body);
      return json({ version: 8 });
    }),
  );
  const view = render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      onRefresh={refreshed}
      onPending={() => {}}
    />,
  );
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Question 1 · required' }));
  expect(screen.getByRole('button', { name: 'Confirm current reading' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Open evidence' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Next evidence page' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm current reading' })).toBeEnabled(),
  );
  expect(view.container.querySelector('pre')).toHaveTextContent('last fictional window');
  expect(view.container.querySelector('pre')!.textContent!.length).toBeLessThanOrEqual(32768);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm current reading' }));
  await waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
  expect(offsets).toEqual([0, 32768]);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    recordId: selection.recordId,
    candidateVersionId: selection.candidateVersionId,
    proposalId: context.proposalId,
    version: 7,
    reviewToken: 'review-7',
    patch: { resolutions: [{ issueId: 'question-1', outcome: 'confirmed' }] },
  });
  expect(writes[0]!.patch).not.toHaveProperty('mapping');
});
it('keeps a referenced pair in the shared evidence layout and requires all saved detail windows', async () => {
  const bytes = new TextEncoder().encode(
    'earlier fictional pair evidence '.repeat(1200) + 'last pair window',
  );
  const reference = {
    format: 'health-clinical-record-section-reference-v1' as const,
    recordId: selection.recordId,
    candidateVersionId: selection.candidateVersionId,
    proposalId: context.proposalId,
    reviewToken: context.reviewToken,
    section: 'comparisons' as const,
    ordinal: 0,
    bytes: bytes.length,
  };
  const offsets: number[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/review-record-section'))
        return json(page('comparisons', [{ ...pair, detail: { kind: 'reference', reference } }]));
      const { offset } = JSON.parse(String(init?.body));
      offsets.push(offset);
      const end = Math.min(offset + 32768, bytes.length);
      return json({
        encoding: 'base64',
        data: Buffer.from(bytes.subarray(offset, end)).toString('base64'),
        complete: end === bytes.length,
        nextOffset: end === bytes.length ? null : end,
      });
    }),
  );
  const mounted = render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      initialSection="comparisons"
      initiallyOpen
      incomingContent={<p>Exact incoming fragment viewer</p>}
      onRefresh={() => {}}
      onPending={() => {}}
      onCorrectSaved={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByText('Saved record with paged evidence'));
  expect(screen.getByRole('heading', { name: 'Incoming record' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Previously accepted record' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Correct this saved record' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Save this relationship' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Open evidence' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Next evidence page' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save this relationship' })).toBeEnabled(),
  );
  expect(offsets).toEqual([0, 32768]);
  expect(mounted.container.querySelector('.clinical-evidence-pair pre')).toHaveTextContent(
    'last pair window',
  );
  expect(
    mounted.container.querySelector('.clinical-evidence-pair pre')!.textContent!.length,
  ).toBeLessThanOrEqual(32768);
});
it('keeps an uncertain targeted date correction and retries the identical operation without losing aliases', async () => {
  const writes: ClinicalRecordAction[] = [];
  const held = vi.fn(),
    refreshed = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/review-record-section')) return json(page('issues', [issue]));
      writes.push(JSON.parse(String(init?.body)));
      if (writes.length === 1) throw new TypeError('Fictional network disconnected');
      return json({ version: 8 });
    }),
  );
  const view = render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      onRefresh={refreshed}
      onPending={held}
    />,
  );
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Question 1 · required' }));
  fireEvent.change(screen.getByLabelText('Corrected reading'), { target: { value: '2026-02-03' } });
  fireEvent.change(screen.getByLabelText('Reason for correction'), {
    target: { value: 'Date printed beside fictional result' },
  });
  expect(screen.getByLabelText('Review section')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Confirm current reading' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save corrected reading' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('save outcome is not confirmed');
  expect(screen.queryByRole('button', { name: 'Discard unsaved edit' })).toBeNull();
  expect(refreshed).not.toHaveBeenCalled();
  view.rerender(
    <ReferencedClinicalControls
      context={{ ...context, version: 8, reviewToken: 'review-8' }}
      selection={selection}
      onRefresh={refreshed}
      onPending={held}
    />,
  );
  expect(screen.getByLabelText('Corrected reading')).toHaveValue('2026-02-03');
  fireEvent.click(screen.getByRole('button', { name: 'Retry exact review choice' }));
  await waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]!.patch).toEqual({
    mapping: { date: '2026-02-03', documentDate: '2026-02-03' },
    correctionPatch: { date: '2026-02-03', documentDate: '2026-02-03' },
    correctionReason: 'Date printed beside fictional result',
    resolutions: [
      {
        issueId: 'question-1',
        outcome: 'corrected',
        mapping: { date: '2026-02-03', documentDate: '2026-02-03' },
      },
    ],
  });
  expect(held).toHaveBeenCalledWith(true);
});
it('writes one fresh pair choice without replacing unseen decisions and exposes explicit missing-target removal', async () => {
  const writes: ClinicalRecordAction[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith('/review-record-section'))
        return json(
          page(
            body.section,
            body.section === 'comparisonDrafts'
              ? [
                  {
                    ...pair,
                    control: {
                      ...(pair.control as Extract<typeof pair.control, { kind: 'pair' }>),
                      targetAvailable: false,
                      scopeToken: undefined,
                    },
                  },
                ]
              : [pair],
          ),
        );
      writes.push(body);
      return json({ version: 8 });
    }),
  );
  const view = render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      initialSection="comparisons"
      onRefresh={() => {}}
      onPending={() => {}}
    />,
  );
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Related record 1' }));
  fireEvent.change(screen.getByLabelText('Relationship'), { target: { value: 'same_event' } });
  fireEvent.change(screen.getByLabelText('Reason for this relationship'), {
    target: { value: 'Same fictional event and original date' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save this relationship' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.pair).toEqual({
    otherRecordId: 'saved-record',
    scopeToken: 'exact-fresh-scope',
    outcome: 'same_event',
    reason: 'Same fictional event and original date',
    occurrenceEvidence: 'attach',
  });
  expect(writes[0]).not.toHaveProperty('patch');
  view.unmount();
  render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      initialSection="comparisonDrafts"
      onRefresh={() => {}}
      onPending={() => {}}
    />,
  );
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Related record 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable pending choice' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]!.clearMissingPair).toBe('saved-record');
});
it('rejects foreign review authority and never offers its controls', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json(page('issues', [issue], { context: { ...context, reviewToken: 'other-review' } })),
    ),
  );
  render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      onRefresh={() => {}}
      onPending={() => {}}
    />,
  );
  await open();
  expect(await screen.findByRole('alert')).toHaveTextContent('no longer match the exact record');
  expect(screen.queryByRole('button', { name: 'Question 1 · required' })).toBeNull();
});
it('writes a complete text field replacement beyond the evidence-window size without other mapping fields', async () => {
  let saved: ClinicalRecordAction | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/review-record-section'))
        return json(
          page('mapping', [
            {
              ordinal: 0,
              control: { kind: 'mapping', field: 'text', editable: true, present: true },
              detail: { kind: 'value', value: 'Short fictional original' },
            },
          ]),
        );
      saved = JSON.parse(String(init?.body));
      return json({ version: 8 });
    }),
  );
  render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      initialSection="mapping"
      onRefresh={() => {}}
      onPending={() => {}}
    />,
  );
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Document text' }));
  const replacement = 'Independent fictional replacement '.repeat(3000);
  fireEvent.change(screen.getByLabelText('Corrected field value'), {
    target: { value: replacement },
  });
  fireEvent.change(screen.getByLabelText('Reason for field correction'), {
    target: { value: 'Complete literal transcription correction' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save this field correction' }));
  await waitFor(() => expect(saved).toBeDefined());
  expect(saved!.patch!.mapping).toEqual({ text: replacement });
  expect(saved!.patch!.correctionPatch).toEqual({ text: replacement });
});
it('replaces each discovery window and reports refinement rather than treating a search prefix as complete', async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const second = body.comparisonSearch.cursor === 'next-results';
      return json(
        page(
          'comparisons',
          [
            {
              ...pair,
              detail: {
                kind: 'value',
                value: second ? 'second saved evidence' : 'first saved evidence',
              },
            },
          ],
          {
            discoveryPage: {
              query: '',
              limit: 20,
              returned: 1,
              hasMore: !second,
              nextCursor: second ? null : 'next-results',
              truncated: true,
              maximumResults: 200,
            },
          },
        ),
      );
    }),
  );
  render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      initialSection="comparisons"
      onRefresh={() => {}}
      onPending={() => {}}
    />,
  );
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Related record 1' }));
  expect(screen.getByText(/first saved evidence/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Next related search results' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Related record 1' }));
  expect(screen.queryByText(/first saved evidence/)).toBeNull();
  expect(screen.getByText(/second saved evidence/)).toBeVisible();
  expect(screen.getByText(/Refine the search/)).toBeVisible();
  expect(bodies[1]).toMatchObject({ comparisonSearch: { cursor: 'next-results', limit: 20 } });
});
it('drops a late section response after switching profiles', async () => {
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
  render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      onRefresh={() => {}}
      onPending={() => {}}
    />,
  );
  await open();
  await waitFor(() => expect(release).toBeDefined());
  const old = release;
  act(() => selectProfile({ id: 'other-fictional-reader', name: 'Other Reader', placebo: true }));
  await act(async () => old(json(page('issues', [issue]))));
  expect(screen.queryByRole('button', { name: 'Question 1 · required' })).toBeNull();
});
it('holds an unsent correction when review authority changes and requires explicit discard before refreshed controls', async () => {
  let current = context;
  const writes: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/review-record-section'))
        return json(page('issues', [issue], { context: current }));
      writes.push(JSON.parse(String(init?.body)));
      return json({});
    }),
  );
  const props = { selection, onRefresh: () => {}, onPending: () => {} };
  const view = render(<ReferencedClinicalControls {...props} context={context} />);
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Question 1 · required' }));
  fireEvent.change(screen.getByLabelText('Corrected reading'), { target: { value: '2026-06-07' } });
  current = { ...context, version: 8, reviewToken: 'review-8' };
  view.rerender(<ReferencedClinicalControls {...props} context={current} />);
  expect(screen.getByLabelText('Corrected reading')).toHaveValue('2026-06-07');
  expect(screen.getByRole('button', { name: 'Save corrected reading' })).toBeDisabled();
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved edit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Question 1 · required' }));
  expect(screen.getByLabelText('Corrected reading')).toHaveValue('2026-01-02');
});
it('opens the saved-original evidence reference even when the pair detail itself is fragmented', async () => {
  const savedEvidence = {
    format: 'health-saved-evidence-v1' as const,
    kind: 'observation' as const,
    recordId: 'saved-record',
    count: 1,
    digest: 'fictional-digest',
    scopeDigest: 'fictional-scope',
    stateHash: 'fictional-state',
    url: '/api/clinical-review/saved-evidence?reference=fictional',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      if (String(input).includes('/saved-evidence?'))
        return json({
          reference: savedEvidence,
          items: [
            {
              kind: 'value',
              id: 'saved-evidence-1',
              value: {
                label: 'Fictional retained original',
                locator: 'Fictional page 2',
                sourceRecordId: 'saved-record',
                contentUrl:
                  '/api/profiles/fictional-section-editor/sources/fictional-saved-original/content',
              },
            },
          ],
          complete: true,
          after: null,
        });
      return json(
        page('comparisons', [
          {
            ...pair,
            control: {
              ...(pair.control as Extract<typeof pair.control, { kind: 'pair' }>),
              savedEvidence,
            },
            detail: {
              kind: 'reference',
              reference: {
                format: 'health-clinical-record-section-reference-v1',
                proposalId: context.proposalId,
                recordId: selection.recordId,
                candidateVersionId: selection.candidateVersionId,
                reviewToken: context.reviewToken,
                section: 'comparisons',
                ordinal: 0,
                bytes: 80000,
              },
            },
          },
        ]),
      );
    }),
  );
  render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      initialSection="comparisons"
      onRefresh={() => {}}
      onPending={() => {}}
    />,
  );
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Related record 1' }));
  expect(await screen.findByRole('link', { name: 'Fictional retained original' })).toHaveAttribute(
    'href',
    '/api/profiles/fictional-section-editor/sources/fictional-saved-original/content',
  );
  expect(screen.getByRole('button', { name: 'Save this relationship' })).toBeDisabled();
});
it('opens complete earlier question answers from a giant issue control without reconstructing the issue', async () => {
  const reference = {
    format: 'health-intake-review-fragment-v1' as const,
    logical: { root: null, domainVersion: 7 },
    address: 'question/fictional-question',
    field: 'answers',
  };
  const fragmentRequests: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/collection-fragment')) {
        fragmentRequests.push(JSON.parse(String(init?.body)));
        const text = '[{"answer":"Older retained fictional answer"}]';
        return json({
          encoding: 'base64',
          data: Buffer.from(text).toString('base64'),
          totalBytes: Buffer.byteLength(text),
          complete: true,
          nextOffset: null,
        });
      }
      return json(
        page('issues', [
          {
            ...issue,
            control: {
              ...(issue.control as Extract<typeof issue.control, { kind: 'issue' }>),
              questionAnswerHistory: { count: 2, reference },
            },
            detail: {
              kind: 'reference',
              reference: {
                format: 'health-clinical-record-section-reference-v1',
                proposalId: context.proposalId,
                recordId: selection.recordId,
                candidateVersionId: selection.candidateVersionId,
                reviewToken: context.reviewToken,
                section: 'issues',
                ordinal: 0,
                bytes: 80000,
              },
            },
          },
        ]),
      );
    }),
  );
  render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      onRefresh={() => {}}
      onPending={() => {}}
    />,
  );
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Question 1 · required' }));
  expect(screen.getByText(/2 saved answers/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'View answer history' }));
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Complete saved answer history' })).getByRole(
      'button',
      { name: 'Open evidence' },
    ),
  );
  expect(await screen.findByText(/Older retained fictional answer/)).toBeVisible();
  expect(fragmentRequests).toEqual([{ reference, offset: 0, bytes: 32768 }]);
  expect(screen.getByRole('button', { name: 'Confirm current reading' })).toBeDisabled();
});
it('inspects the complete linked-report sequence one bounded page at a time without constructing clinical edits', async () => {
  const requests: unknown[] = [];
  const group = (ordinal: number): ClinicalRecordSectionPage['items'][number] => ({
    ordinal,
    control: {
      kind: 'reportGroup',
      groupId: `fictional-group-${ordinal}`,
      groupVersionId: `group-version-${ordinal}`,
    },
    detail: {
      kind: 'value',
      value: { groupId: `fictional-group-${ordinal}`, groupVersionId: `group-version-${ordinal}` },
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      expect(String(input)).toContain('/review-record-section');
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      expect(body.section).toBe('reportGroups');
      return json(
        page('reportGroups', [group(body.cursor ? 1 : 0)], {
          total: 2,
          nextCursor: body.cursor ? null : 'second-report-link',
        }),
      );
    }),
  );
  render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      initialSection="reportGroups"
      sections={['reportGroups']}
      triggerLabel="Inspect linked reports"
      onRefresh={() => {}}
      onPending={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Inspect linked reports' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Linked report 1' }));
  expect(screen.getByText(/2 linked reports in this complete record/)).toBeInTheDocument();
  expect(screen.getByText(/Group: fictional-group-0/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm current reading' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next record section page' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Linked report 2' }));
  expect(screen.getByText(/Group: fictional-group-1/)).toBeInTheDocument();
  expect(screen.queryByText(/Group: fictional-group-0/)).not.toBeInTheDocument();
  expect(requests).toHaveLength(2);
});
it('answers an exact referenced source question without reconstructing the unloaded question collection', async () => {
  const bytes = new TextEncoder().encode(
    'fictional prompt '.repeat(2200) + 'last question evidence',
  );
  const reference = {
    format: 'health-clinical-record-section-reference-v1' as const,
    recordId: selection.recordId,
    candidateVersionId: selection.candidateVersionId,
    proposalId: context.proposalId,
    reviewToken: context.reviewToken,
    section: 'questions' as const,
    ordinal: 0,
    bytes: bytes.length,
  };
  const writes: ClinicalRecordAction[] = [];
  const refresh = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith('/review-record-section'))
        return json(
          page(
            'questions',
            [
              {
                ordinal: 0,
                control: {
                  kind: 'question',
                  id: 'fictional-unanswered-question',
                  status: 'unanswered',
                  field: null,
                  answerReferenced: false,
                },
                detail: { kind: 'reference', reference },
              },
            ],
            { total: 2000, nextCursor: 'more-retained-questions' },
          ),
        );
      if (String(input).endsWith('/review-record-section-fragment')) {
        const end = Math.min(bytes.length, body.offset + 32768);
        return json({
          encoding: 'base64',
          data: Buffer.from(bytes.subarray(body.offset, end)).toString('base64'),
          complete: end === bytes.length,
          nextOffset: end === bytes.length ? null : end,
        });
      }
      writes.push(body);
      if (writes.length === 1) throw new TypeError('Fictional answer result uncertain');
      return json({ version: 8 });
    }),
  );
  render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      initialSection="questions"
      onRefresh={refresh}
      onPending={() => {}}
    />,
  );
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Source question 1' }));
  expect(screen.getByText(/2,000 saved source questions in this complete record/)).toBeVisible();
  expect(screen.getByLabelText('Answer')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Open evidence' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Next evidence page' }));
  await waitFor(() => expect(screen.getByLabelText('Answer')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Answer'), {
    target: { value: 'Fictional human observation' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save answer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry exact review choice' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(writes).toHaveLength(2);
  expect(writes[0]).toEqual(writes[1]);
  expect(writes[0]!.patch).toEqual({
    answers: { 'fictional-unanswered-question': 'Fictional human observation' },
  });
});
it('exposes all person-assignment requirements as read-only evidence rather than treating a short summary as complete', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      requests.push(url);
      expect(url).toContain('/review-record-section');
      const body = JSON.parse(String(init?.body));
      expect(body.section).toBe('ownershipBlockers');
      return json(
        page(
          'ownershipBlockers',
          [
            {
              ordinal: 0,
              control: { kind: 'ownershipBlocker' },
              detail: {
                kind: 'value',
                value: 'Fictional printed names disagree at this source boundary.',
              },
            },
          ],
          { total: 5000, nextCursor: 'next-requirement-window' },
        ),
      );
    }),
  );
  render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      initialSection="ownershipBlockers"
      sections={['ownershipBlockers']}
      triggerLabel="Inspect person assignment requirements"
      onRefresh={() => {}}
      onPending={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Inspect person assignment requirements' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Person requirement 1' }));
  expect(
    screen.getByText(/5,000 person assignment requirements in this complete record/),
  ).toBeVisible();
  expect(screen.getByText(/Fictional printed names disagree/)).toBeVisible();
  expect(
    screen.getByText(/Reading it does not confirm a person or accept clinical records/),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Confirm current reading' })).not.toBeInTheDocument();
  expect(requests).toHaveLength(1);
});

it('exposes complete record-specific advisory identity warnings without a false inline completeness claim', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      requests.push(url);
      expect(url).toContain('/review-record-section');
      const body = JSON.parse(String(init?.body));
      expect(body.section).toBe('identityWarnings');
      return json(
        page(
          'identityWarnings',
          [
            {
              ordinal: 0,
              control: { kind: 'identityWarning' },
              detail: {
                kind: 'value',
                value: 'Fictional identity warning retained outside the inline page.',
              },
            },
          ],
          { total: 5000, nextCursor: 'next-requirement-window' },
        ),
      );
    }),
  );
  render(
    <ReferencedClinicalControls
      context={context}
      selection={selection}
      initialSection="identityWarnings"
      sections={['identityWarnings']}
      triggerLabel="Inspect record identity warnings"
      onRefresh={() => {}}
      onPending={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Inspect record identity warnings' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Identity warning 1' }));
  expect(screen.getByText(/5,000 record identity warnings in this complete record/)).toBeVisible();
  expect(screen.getByText(/Fictional identity warning retained/)).toBeVisible();
  expect(
    screen.getByText(/Reading it does not change person assignment or accept the record/),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Confirm current reading' })).not.toBeInTheDocument();
  expect(requests).toHaveLength(1);
});
