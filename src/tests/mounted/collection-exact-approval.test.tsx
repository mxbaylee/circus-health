import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { CollectionImportReview } from '../../app/features/import/CollectionImportReview';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
const editorMode = vi.hoisted(() => ({ full: false, revision: 0 }));
vi.mock('../../app/features/import/ImportSourceTextBrowser', () => ({
  ImportSourceTextBrowser: () => null,
}));
vi.mock('../../app/components/SourceDialog', () => ({
  SourcePreview: () => <p>Fictional original</p>,
}));
vi.mock('../../app/features/import/ImportDetailReview', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../app/features/import/ImportDetailReview')>();
  return {
    ...actual,
    ImportDetailReview: (
      props: import('react').ComponentProps<typeof actual.ImportDetailReview>,
    ) => (
      <actual.ImportRecordDetail
        embedded={!editorMode.full}
        guardNavigation={false}
        beforeCloseRef={props.beforeCloseRef}
        reviewApprovalRef={props.reviewApprovalRef}
        groupId={props.selection.groupId}
        block={{ intakeId: props.selection.intakeId!, proposalId: props.selection.proposalId! }}
        recordId={props.selection.recordId!}
        identityPanel={null}
        identityRevision={editorMode.revision}
        sourcePanel={null}
        commonIdentityIssueIds={new Set()}
        sourceError=""
        onBack={props.onBack}
        onChanged={props.onChanged}
        onUseSource={() => {}}
      />
    ),
  };
});
const json = (data: unknown, revision?: number) =>
  new Response(JSON.stringify({ data, meta: { revision } }), {
    headers: { 'Content-Type': 'application/json' },
  });
it.each([
  'individual',
  'selected',
  'editor-refresh',
  'flush',
  'updated',
  'order-only',
  'order-inline',
  'order-changed',
  'order-changed-inline',
] as const)(
  'uses the displayed exact mapping through the real selected editor (%s)',
  async (mode) => {
    sessionStorage.clear();
    editorMode.full = mode === 'flush';
    editorMode.revision = 0;
    const profile = { id: 'fictional-s19-stale', name: 'Fictional Reader', placebo: true };
    replaceProfiles([profile]);
    selectProfile(profile);
    const row = (valueText: string, selectionReviewToken: string) => ({
      intakeId: 'fictional-intake',
      groupId: 'fictional-group',
      groupOrdinal: 0,
      proposalId: 'fictional-proposal',
      intakeVersion: 7,
      reviewToken: 'review-' + valueText,
      feedKind: 'test',
      feedKey: 'fictional-feed-key',
      feedOrder: '1',
      manuallyEdited: false,
      detail: {
        kind: 'record',
        record: {
          id: 'fictional-record',
          title: 'Fictional marker',
          provider: 'Fictional Clinic',
          date: '2026-08-10',
          kind: 'observation',
          classification: 'addition',
          confidence: 1,
          uncertainties: [],
          evidence: [],
          mapping: {
            kind: 'observation',
            testLabel: 'Fictional marker',
            valueText,
            unit: 'mg/dL',
            date: '2026-08-10',
          },
          supportedFields: [],
          candidateId: 'fictional-candidate',
          candidateVersionId: 'fictional-version',
          selectionReviewToken,
          queueState: 'pending',
          selectable: true,
          feedKey: 'fictional-feed-key',
          feedOrder: '1',
          feedKind: 'test',
          manuallyEdited: false,
        },
      },
    });
    const old = row('87', 'token-old'),
      latest = row('99', 'token-new');
    latest.intakeVersion = 8;
    latest.detail.record.mapping.valueText = '87';
    (latest.detail.record as any).draft = {
      mapping: { valueText: '99' },
      disposition: 'pending',
      resolutions: [],
    };
    const reordered = structuredClone(old);
    old.detail.record.mapping = Object.fromEntries(
      Object.entries(old.detail.record.mapping).sort(([a], [b]) => a.localeCompare(b)),
    ) as typeof old.detail.record.mapping;
    if (mode.includes('changed')) reordered.detail.record.mapping.valueText = '99';
    const counts = {
      pending: 1,
      deferred: 0,
      blocked: 0,
      accepted: 0,
      keptOriginal: 0,
      superseded: 0,
      questions: 0,
    };
    const feed = (record: ReturnType<typeof row>) => ({
      format: 'health-intake-import-feed-v2',
      view: 'active',
      records: [record],
      totalRecords: 1,
      totalGroups: 1,
      nextCursor: null,
      counts,
      kindCounts: {
        test: 1,
        procedure: 0,
        history: 0,
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
        binding: 'fictional',
        runningFiles: 0,
        pausedFiles: 0,
        queuedFiles: 0,
        filesAwaitingConversion: 0,
        remainingUnits: { state: 'exact', value: 0 },
        extractionUnknownFiles: 0,
        extractionComplete: true,
        allCurrentReportsReviewed: false,
        readingAccounting: { state: 'referenced', scope: 'all', binding: 'fictional' },
      },
    });
    let current = old;
    let selectedReads = 0;
    const draftWrites: any[] = [];
    const writes: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const url = new URL(String(input), 'https://fictional.invalid');
        if (url.pathname.endsWith('/review-draft')) {
          const body = JSON.parse(String(init?.body));
          draftWrites.push(body);
          latest.detail.record.mapping.valueText = body.mapping.valueText;
          (latest.detail.record as any).draft = {
            ...body,
            id: body.operationId,
            candidateId: latest.detail.record.candidateId,
          };
          current = latest;
          return json({ id: 'fictional-intake', version: 8 }, 13);
        }
        if (url.pathname.includes('/report-queue/'))
          return json({
            format: 'health-intake-report-detail-v2',
            group: {
              intakeId: 'fictional-intake',
              groupId: 'fictional-group',
              groupVersionId: 'fictional-group-v1',
              source: 'Fictional Clinic',
              title: 'Fictional report',
              date: '2026-08-10',
              original: {
                filename: 'fictional.pdf',
                contentUrl: '/sources/fictional-intake/content',
              },
              sourceCoverage: { current: { total: 1, covered: 1, uncovered: 0 } },
            },
          });
        if (url.pathname.endsWith('/identity-review'))
          return json({
            status: 'missing_warning',
            blocking: false,
            message: 'Fictional identity',
            scope: null,
            evidencedIdentity: {},
            self: { noteId: 'self', version: 1, fullName: 'Fictional Reader' },
            offeredSelfFields: {},
            conflicts: [],
          });
        if (url.pathname.endsWith('/fictional-intake'))
          return json({
            id: 'fictional-intake',
            version: current.intakeVersion,
            filename: 'fictional.pdf',
            mimeType: 'application/pdf',
            contentUrl: '/fictional-original',
          });
        if (url.pathname.endsWith('/review-record')) {
          selectedReads++;
          return json(
            {
              format: 'health-intake-clinical-record-v2',
              context: {
                intakeId: 'fictional-intake',
                proposalId: 'fictional-proposal',
                version: current.intakeVersion,
                reviewToken: current.reviewToken,
                sourceTextStale: false,
              },
              record: current.detail,
            },
            current === old ? 12 : 13,
          );
        }
        if (url.pathname.endsWith('/report-acceptance-plan')) {
          const body = JSON.parse(String(init?.body));
          return json({
            planId: 'fictional-exact-approval-plan',
            chunks: [body.blocks],
            unsent: [],
          });
        }
        if (url.pathname.endsWith('/report-acceptance')) {
          const body = JSON.parse(String(init?.body));
          writes.push(body);
          return json({
            receipt: {
              operationId: body.operationId,
              atomic: true,
              acceptedCount: 1,
              receipts: [],
              items: [],
            },
          });
        }
        throw Error('Unexpected ' + url);
      }),
    );
    const firstPage = { reload: vi.fn(), error: null };
    const props = {
      firstPage,
      path: '/intakes/import-feed?view=active&state=pending&limit=40&bytes=65536',
      onChanged: vi.fn(),
      sourceProps: { onChanged: vi.fn() },
      onUpload: vi.fn(),
      busy: false,
      status: '',
      error: '',
    };
    const view = (record: ReturnType<typeof row>) => (
      <MemoryRouter>
        <CollectionImportReview {...props} initial={feed(record) as any} />
      </MemoryRouter>
    );
    const mounted = render(view(old));
    await screen.findByText('87');
    if (mode.startsWith('order-')) {
      if (mode.endsWith('inline')) {
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        await screen.findByRole('textbox', { name: 'Result' });
      }
      current = reordered;
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Fictional marker' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save 1 record' }));
      if (mode.includes('changed')) {
        await screen.findByText(
          'A selected record changed. Refresh the page and review it before saving.',
        );
        expect(writes).toHaveLength(0);
      } else {
        await waitFor(() => expect(writes).toHaveLength(1));
        expect(writes[0].blocks[0].selections[0]).toMatchObject({
          selectionReviewToken: 'token-old',
          mapping: old.detail.record.mapping,
        });
      }
      return;
    }
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByRole('textbox', { name: 'Result' });
    if (mode === 'flush' || mode === 'updated') {
      fireEvent.change(screen.getByRole('textbox', { name: 'Result' }), {
        target: { value: '99' },
      });
      if (mode === 'updated') {
        fireEvent.click(screen.getByRole('button', { name: 'Update' }));
        await waitFor(() => expect(draftWrites).toHaveLength(1));
        await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Result' })).toBeNull());
        mounted.rerender(view(latest));
        await screen.findByText('99');
      }
      fireEvent.click(screen.getByRole('button', { name: 'Confirm & save' }));
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(draftWrites).toHaveLength(1);
      expect(writes[0].blocks[0].selections[0]).toMatchObject({
        selectionReviewToken: 'token-new',
        mapping: { valueText: '99' },
      });
      return;
    }
    if (mode === 'selected')
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Fictional marker' }));
    current = latest;
    if (mode === 'editor-refresh') {
      latest.detail.record.mapping.valueText = '99';
      editorMode.revision = 1;
    }
    if (mode !== 'selected') mounted.rerender(view(latest));
    if (mode === 'editor-refresh') await waitFor(() => expect(selectedReads).toBeGreaterThan(1));
    await act(async () => {});
    expect(screen.getByText('87')).toBeVisible();
    expect(screen.queryByText('99')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: mode !== 'selected' ? 'Confirm & save' : 'Save 1 record',
      }),
    );
    await screen.findByText(
      'A selected record changed. Refresh the page and review it before saving.',
    );
    expect(writes).toHaveLength(0);
    mounted.rerender(view(latest));
    await screen.findByText('99');
    expect(screen.queryByRole('textbox', { name: 'Result' })).toBeNull();
    if (mode === 'selected')
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Fictional marker' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: mode !== 'selected' ? 'Confirm & save' : 'Save 1 record',
      }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].blocks[0].selections[0]).toMatchObject({
      selectionReviewToken: 'token-new',
      mapping: { valueText: '99' },
    });
  },
);
