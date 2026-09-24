import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ClinicalRelationshipDialog } from '../../app/features/clinical-review/ClinicalRelationshipDialog';
import { ClinicalRelationshipPanel } from '../../app/features/clinical-review/ClinicalRelationshipPanel';
import { selectProfile } from '../../app/data/profile';
import type {
  ClinicalRelationshipApplyResult,
  ClinicalRelationshipPreview,
  ClinicalRelationshipRequest,
  ClinicalRelationshipSide,
} from '../../shared/clinical-relationships';

const side = (
  recordId: string,
  title: string,
  sourceFileId: string,
  locator: string,
  valueText: string,
): ClinicalRelationshipSide => ({
  record: { kind: 'observation', recordId },
  title,
  date: '2026-08-24',
  mapping: { kind: 'observation', testLabel: 'Fictional ferritin', valueText, unit: 'ng/mL' },
  evidence: [
    {
      sourceRecordId: `${recordId}-source-record`,
      sourceFileId,
      sha256: `${recordId}-sha256`,
      bytes: 1200,
      label: `${title} original`,
      locator,
      contentUrl: `/api/sources/${sourceFileId}/content#page=1`,
    },
  ],
  navigation: {
    kind: 'observation',
    recordId,
    appUrl: `/tests?result=${recordId}`,
    apiUrl: `/api/test-results/${recordId}`,
  },
});

it.each([[], {}, { display: {} }])(
  'isolates an invalid relationship response without claiming no relationships',
  async (value) => {
    selectProfile({ id: 'fictional-profile', name: 'Fictional profile', placebo: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: value }), {
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    render(
      <MemoryRouter>
        <h1>Existing saved record</h1>
        <ClinicalRelationshipPanel
          kind="observation"
          recordId="fictional-result"
          onApplied={() => {}}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Reviewed relationships could not load',
    );
    expect(screen.getByRole('heading', { name: 'Existing saved record' })).toBeVisible();
    expect(
      screen.queryByText('No reviewed relationship decisions for this record.'),
    ).not.toBeInTheDocument();
  },
);

const left = side(
  'fictional-earlier',
  'Earlier fictional result',
  'earlier-file',
  'page 1 row 2',
  '17',
);
const right = side(
  'fictional-amendment',
  'Later fictional result',
  'amendment-file',
  'page 2 amended result',
  '18',
);

const pairReference = (selected: ClinicalRelationshipSide) => ({
  ...selected.record,
  sourceRecordId: selected.evidence[0]!.sourceRecordId,
  identity: `${selected.record.recordId}-identity`,
  version: `${selected.record.recordId}-version`,
  stateHash: `${selected.record.recordId}-state`,
  evidenceHash: `${selected.record.recordId}-evidence`,
});

function previewFor(request: ClinicalRelationshipRequest): ClinicalRelationshipPreview {
  const supersedes =
    request.action === 'provider_amendment' && request.mode === 'confirm'
      ? request.direction === 'left_to_right'
        ? { fromRecordId: left.record.recordId, toRecordId: right.record.recordId }
        : { fromRecordId: right.record.recordId, toRecordId: left.record.recordId }
      : null;
  return {
    request,
    scope: {
      format: 'clinical-relationship-scope-v1',
      profileId: 'fictional-profile',
      left: pairReference(left),
      right: pairReference(right),
      previousDecisionId: null,
    },
    version: 12,
    previewToken: 'a'.repeat(64),
    left,
    right,
    effect: {
      supersedes,
      preferredRecordId:
        request.mode === 'prefer_left'
          ? left.record.recordId
          : request.mode === 'prefer_right'
            ? right.record.recordId
            : null,
      showBoth: !['prefer_left', 'prefer_right'].includes(request.mode),
      oneReviewedEvent:
        request.action === 'display_preference' &&
        ['prefer_left', 'prefer_right', 'show_both'].includes(request.mode),
    },
    originalsRetained: true,
  };
}

function applied(
  preview: ClinicalRelationshipPreview,
  operationId: string,
): ClinicalRelationshipApplyResult {
  return {
    receipt: {
      operationId,
      decisionId: 'fictional-decision',
      at: '2026-09-13T20:00:00.000Z',
      action: preview.request.action,
      mode: preview.request.mode,
      scope: preview.scope,
    },
    replayed: true,
    projections: [],
    durability: { pending: false, error: null },
  };
}

const renderDialog = (
  previewRelationship: (
    request: ClinicalRelationshipRequest,
  ) => Promise<ClinicalRelationshipPreview>,
  applyRelationship = vi.fn(async (request) =>
    applied(previewFor(request.request), request.operationId),
  ),
  initialAction: ClinicalRelationshipRequest['action'] = 'display_preference',
) => {
  const onApplied = vi.fn();
  render(
    <MemoryRouter>
      <ClinicalRelationshipDialog
        open
        onOpenChange={vi.fn()}
        left={left}
        right={right}
        previewRelationship={previewRelationship}
        applyRelationship={applyRelationship}
        onApplied={onApplied}
        initialAction={initialAction}
      />
    </MemoryRouter>,
  );
  return { applyRelationship, onApplied };
};

describe('ClinicalRelationshipDialog', () => {
  it('reviews both originals and retries an exact scoped same-event display decision', async () => {
    const previewRelationship = vi.fn(async (request) => previewFor(request));
    let attempt = 0;
    const applyRelationship = vi.fn(async (request) => {
      if (++attempt === 1) throw new Error('Connection interrupted after saving');
      return applied(previewFor(request.request), request.operationId);
    });
    const { onApplied } = renderDialog(previewRelationship, applyRelationship);
    const user = userEvent.setup();

    expect(screen.getAllByRole('link', { name: 'Open original' })).toHaveLength(2);
    await user.type(
      screen.getByLabelText('Review reason'),
      'Both retained originals have the same fictional accession and collection time.',
    );
    await user.click(
      screen.getByLabelText(/confirm that these records describe the same recorded event/i),
    );
    await user.click(screen.getByRole('button', { name: 'Review decision' }));

    const expectedRequest: ClinicalRelationshipRequest = {
      left: left.record,
      right: right.record,
      reason: 'Both retained originals have the same fictional accession and collection time.',
      action: 'display_preference',
      mode: 'show_both',
      attestation: 'same_recorded_event',
    };
    expect(previewRelationship).toHaveBeenCalledWith(expectedRequest);
    const reviewed = await screen.findByRole('region', { name: 'Reviewed record pair' });
    expect(within(reviewed).getByText('17')).toBeVisible();
    expect(within(reviewed).getByText('18')).toBeVisible();
    expect(
      screen.getByText(/Both records will appear and count as one reviewed event/),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Apply reviewed decision' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection interrupted');
    await user.click(screen.getByRole('button', { name: 'Retry decision' }));

    expect(applyRelationship).toHaveBeenCalledTimes(2);
    const first = applyRelationship.mock.calls[0]![0];
    const second = applyRelationship.mock.calls[1]![0];
    expect(second).toEqual(first);
    expect(first).toEqual({
      request: expectedRequest,
      scope: previewFor(expectedRequest).scope,
      version: 12,
      previewToken: 'a'.repeat(64),
      operationId: expect.any(String),
    });
    expect(onApplied).toHaveBeenCalledOnce();
    expect(await screen.findByRole('region', { name: 'Saved relationship' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Earlier fictional result' })).toHaveAttribute(
      'href',
      '/tests?result=fictional-earlier',
    );
  });

  it('requires and submits the exact amended assertion original and excerpt', async () => {
    const previewRelationship = vi.fn(async (request) => previewFor(request));
    renderDialog(previewRelationship, undefined, 'provider_amendment');
    const user = userEvent.setup();

    const review = screen.getByRole('button', { name: 'Review decision' });
    expect(review).toBeDisabled();
    await user.selectOptions(
      screen.getByLabelText('Original containing the provider amendment'),
      `amendment-file\u0000page 2 amended result`,
    );
    expect(screen.getByRole('link', { name: 'Open the selected original' })).toHaveAttribute(
      'href',
      '/api/sources/amendment-file/content#page=1',
    );
    await user.type(
      screen.getByLabelText('Exact excerpt showing the amendment'),
      'Amended fictional result: 18 ng/mL.',
    );
    await user.type(
      screen.getByLabelText('Review reason'),
      'The later retained original explicitly identifies the amended result.',
    );
    await user.click(
      screen.getByLabelText(/confirm that it explicitly presents a provider amendment/i),
    );
    await user.click(review);

    expect(previewRelationship).toHaveBeenCalledWith({
      left: left.record,
      right: right.record,
      reason: 'The later retained original explicitly identifies the amended result.',
      action: 'provider_amendment',
      mode: 'confirm',
      direction: 'left_to_right',
      attestation: 'reviewed_provider_amendment',
      evidence: {
        sourceFileId: 'amendment-file',
        locator: 'page 2 amended result',
        quote: 'Amended fictional result: 18 ng/mL.',
      },
    });
    expect(
      await screen.findByText(/does not choose how the two records are displayed/),
    ).toBeVisible();
  });

  it('marks a relationship as needing review without claiming same-event equivalence', async () => {
    const previewRelationship = vi.fn(async (request) => previewFor(request));
    renderDialog(previewRelationship);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText('Display decision'), 'undecided');
    expect(
      screen.queryByLabelText(/confirm that these records describe the same recorded event/i),
    ).not.toBeInTheDocument();
    await user.type(
      screen.getByLabelText('Review reason'),
      'The originals do not establish whether these are the same event.',
    );
    await user.click(screen.getByRole('button', { name: 'Review decision' }));

    expect(previewRelationship).toHaveBeenCalledWith({
      left: left.record,
      right: right.record,
      reason: 'The originals do not establish whether these are the same event.',
      action: 'display_preference',
      mode: 'undecided',
    });
    expect(
      await screen.findByText(/Both records remain visible and count separately/),
    ).toBeVisible();
  });

  it('loads a bounded individual-record panel and keeps legacy changed-version context generic', async () => {
    selectProfile({ id: 'fictional-profile', name: 'Cookie Dough', placebo: true });
    const request: ClinicalRelationshipRequest = {
      left: left.record,
      right: right.record,
      reason: 'The provider original explicitly labels the later result as amended.',
      action: 'provider_amendment',
      mode: 'confirm',
      direction: 'left_to_right',
      attestation: 'reviewed_provider_amendment',
      evidence: {
        sourceFileId: 'amendment-file',
        locator: 'page 2 amended result',
        quote: 'Amended fictional result: 18 ng/mL.',
      },
    };
    const preview = previewFor(request);
    const currentRight: ClinicalRelationshipSide = {
      ...right,
      title: 'Current later fictional result',
      mapping: { ...right.mapping, valueText: '19' },
    };
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://health.test');
      const endpoint = url.pathname.replace('/api/profiles/fictional-profile', '');
      let data: unknown;
      if (endpoint === '/clinical-relationships/pair') data = { left, right: currentRight };
      else if (endpoint === '/link-targets')
        data = [
          {
            targetType: 'observation',
            targetId: 'fictional-third',
            title: 'Third accepted fictional result',
            subtitle: '2026-08-25 · 20 ng/mL',
            archived: false,
          },
        ];
      else
        data = {
          record: left.record,
          relationships: [
            {
              decisionId: 'fictional-amendment-decision',
              previousDecisionId: null,
              at: '2026-09-13T20:00:00.000Z',
              request,
              scope: preview.scope,
              reviewed: { left, right },
              status: 'stale',
              currentDecision: true,
              leftNavigation: left.navigation,
              rightNavigation: right.navigation,
            },
          ],
          legacyPairs: [
            {
              decisionId: 'fictional-legacy-choice',
              outcome: 'changed_version',
              reason: 'Earlier bounded review choice.',
              otherRecordId: right.record.recordId,
              status: 'historical',
            },
          ],
          display: {
            visibleByDefault: true,
            preferredRecordId: null,
            countGroupId: `record:${left.record.recordId}`,
            oneReviewedEvent: false,
            requiresReview: true,
          },
          truncated: false,
        };
      return new Response(JSON.stringify({ data }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ClinicalRelationshipPanel
          kind="observation"
          recordId={left.record.recordId}
          onApplied={vi.fn()}
        />
      </MemoryRouter>,
    );

    const panel = await screen.findByRole('region', { name: 'Record relationships' });
    expect(
      within(panel).getByText(/Needs review because a record or original changed/),
    ).toBeVisible();
    expect(within(panel).getByText(/Earlier relationship choice: changed version/i)).toBeVisible();
    expect(within(panel).getByText(/not a provider amendment/i)).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        '/api/profiles/fictional-profile/clinical-relationships?kind=observation&recordId=fictional-earlier',
      ),
      expect.anything(),
    );

    await user.click(within(panel).getByRole('button', { name: 'Review amendment decision' }));
    expect(
      await screen.findByRole('radio', { name: /Provider issued an amendment/i }),
    ).toBeChecked();
    expect(screen.getByText('Current later fictional result')).toBeVisible();
    expect(screen.getByText('19')).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        '/clinical-relationships/pair?leftKind=observation&leftRecordId=fictional-earlier&rightKind=observation&rightRecordId=fictional-amendment',
      ),
      expect.anything(),
    );

    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    await user.click(within(panel).getByRole('button', { name: 'Review this pair' }));
    expect(
      await screen.findByRole('radio', { name: /Same recorded event display/i }),
    ).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));

    await user.click(within(panel).getByRole('button', { name: 'Review another accepted record' }));
    expect(
      await screen.findByRole('textbox', { name: 'Search accepted measurement records' }),
    ).toBeVisible();
    await user.click(
      await screen.findByRole('button', { name: /Third accepted fictional result/ }),
    );
    expect(await screen.findByRole('dialog', { name: 'Review record relationship' })).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        '/clinical-relationships/pair?leftKind=observation&leftRecordId=fictional-earlier&rightKind=observation&rightRecordId=fictional-third',
      ),
      expect.anything(),
    );
  });
});
