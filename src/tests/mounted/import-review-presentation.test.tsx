import { useEffect } from 'react';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import {
  ImportReviewPresentation,
  type ImportReviewModel,
} from '../../app/features/import/ImportReviewPresentation';
import {
  appendSavedPersonDestination,
  SavedPersonDestinations,
} from '../../app/features/import/SavedRecordDestinations';
import type { IntakeReportSourceReview } from '../../shared/intake';

function model(activeFiles = 0): ImportReviewModel {
  return {
    reports: [],
    records: [],
    activity: {
      activeFiles,
      label: activeFiles ? 'Moxie is reading 1 file' : 'All caught up',
      detail: activeFiles ? 'One fictional report is being read.' : 'No files are being read.',
    },
  };
}

function sourceModel(contextKey = 'fictional-profile:active'): ImportReviewModel {
  return {
    contextKey,
    reports: [
      {
        id: 'fictional-source-scope',
        source: 'Fictional Imaging Center',
        sourceSuggested: true,
        sourceLabelAvailable: true,
        sourceNeedsLabel: false,
        sourceConfirmed: false,
        reportType: 'Fictional imaging report',
        date: '2026-09-01',
        subject: { label: 'Self', evidence: 'named', confirmed: true },
      },
    ],
    records: [
      {
        id: 'fictional-result',
        reportId: 'fictional-source-scope',
        kind: 'Vision',
        label: 'Fictional eyewear prescription',
        originalLabel: 'Fictional eyewear prescription',
        value: 'OD SPH +1.00',
        status: 'review',
        eligible: false,
      },
    ],
    filters: { view: 'review', kind: 'All', query: '', editedOnly: false },
  };
}

function sourceReview(view: 'active' | 'deferred' | 'all' = 'active'): IntakeReportSourceReview {
  const sourceRef = (suffix: string) => ({
    groupId: 'fictional-source-scope',
    groupVersionId: `fictional-group-version-${suffix}`,
    contributionId: `fictional-contribution-${suffix}`,
    contextId: `fictional-context-${suffix}`,
    fingerprint: `fictional-fingerprint-${suffix}`,
    extensionScope: {
      kind: 'anchored_report' as const,
      reportFingerprint: 'fictional-report-fingerprint',
      contextFingerprint: `fictional-context-fingerprint-${suffix}`,
    },
  });
  return {
    profileId: 'fictional-profile',
    intakeId: 'fictional-intake',
    intakeVersion: 9,
    groupId: 'fictional-source-scope',
    groupVersionId: 'fictional-group-version-current',
    view,
    scopeToken: `fictional-scope-token-${view}`,
    coverage: {
      total: 2,
      covered: 1,
      uncovered: 1,
      status: 'partial',
      bySource: [{ source: 'Previously reviewed source', count: 1 }],
    },
    sourceEvidence: ['Fictional Imaging Center'],
    targets: [
      {
        id: 'fictional-target-first',
        candidateId: 'fictional-candidate',
        candidateVersionId: 'fictional-candidate-version',
        occurrence: {
          proposalId: 'fictional-proposal-first',
          recordId: 'fictional-record-first',
          batchId: 'fictional-batch',
          locator: 'page 1 · row 4',
        },
        sourceRef: sourceRef('first'),
        title: 'Fictional right eye result',
        date: '2026-09-01',
        kind: 'observation',
        effectiveSource: 'Previously reviewed source',
      },
      {
        id: 'fictional-target-second',
        candidateId: 'fictional-candidate',
        candidateVersionId: 'fictional-candidate-version',
        occurrence: {
          proposalId: 'fictional-proposal-second',
          recordId: 'fictional-record-second',
          batchId: 'fictional-batch',
          locator: 'page 9 · row 2',
        },
        sourceRef: sourceRef('second'),
        title: 'Fictional left eye result',
        date: '2026-09-01',
        kind: 'observation',
        effectiveSource: null,
      },
    ],
  };
}

function controlledPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

it('keeps Moxie still when no files are being read', () => {
  const { container, rerender } = render(<ImportReviewPresentation model={model()} />);
  expect(container.querySelector('.import-reading-jester')).toHaveClass('is-idle');

  rerender(<ImportReviewPresentation model={model(1)} />);
  expect(container.querySelector('.import-reading-jester')).not.toHaveClass('is-idle');
});

it.each([undefined, 'conflict', 'missing_warning', 'evidenced_match'] as const)(
  'does not show Self identity controls over a People-only section (%s)',
  (identityStatus) => {
    const onSave = vi.fn();
    render(
      <ImportReviewPresentation
        model={{
          reports: [
            {
              id: 'fictional-signature',
              source: 'Juniper Eye Clinic',
              sourceConfirmed: false,
              reportType: 'Eye prescription',
              date: '2026-04-12',
              subject: {
                label: 'Rowan',
                evidence: 'missing',
                confirmed: identityStatus === 'evidenced_match',
                identityStatus,
                scopeReady: false,
                hidden: true,
                offeredSelfFields: { fullName: 'Rowan Ellis' },
              },
            },
          ],
          records: [
            {
              id: 'fictional-person',
              reportId: 'fictional-signature',
              kind: 'People',
              label: 'Avery Maple',
              originalLabel: 'Signing clinician',
              value: 'Professional',
              status: 'review',
              eligible: true,
            },
          ],
        }}
        actions={{ onSave }}
      />,
    );
    expect(screen.queryByText(/Checking who this report identifies/)).toBeNull();
    expect(screen.queryByText(/Identity is not printed clearly/)).toBeNull();
    expect(screen.queryByText(/conflicts with Self/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Self details|Checking|This is me/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & save' }));
    expect(onSave).toHaveBeenCalledWith(['fictional-person']);
  },
);

it('opens a saved Person only from its retained destination receipt', () => {
  render(
    <ImportReviewPresentation
      model={{
        reports: [
          {
            id: 'fictional-people-report',
            source: 'Fictional source',
            sourceConfirmed: false,
            reportType: 'People',
            date: '',
            subject: { label: 'Self', evidence: 'missing', confirmed: false, hidden: true },
          },
        ],
        records: [
          {
            id: 'person:fictional-proposal',
            reportId: 'fictional-people-report',
            kind: 'People',
            label: 'Dr. Ellis Meadow',
            originalLabel: 'Signing clinician',
            value: 'Professional',
            status: 'saved',
            eligible: false,
            savedPersonDestination: {
              proposalId: 'fictional-proposal',
              noteId: 'note:fictional-destination',
              personId: 'person:fictional-destination',
              resultUrl: '#/people?id=note%3Afictional-destination',
              title: 'Dr. Ellis Meadow',
            },
          },
        ],
        filters: { view: 'saved', kind: 'People', query: '', editedOnly: false },
      }}
    />,
  );

  expect(
    screen.getByRole('link', { name: /Dr\. Ellis Meadow.*Person.*Saved in People/ }),
  ).toHaveAttribute('href', '#/people?id=note%3Afictional-destination');
  expect(screen.getByRole('link', { name: /Dr\. Ellis Meadow/ })).toHaveAttribute(
    'data-saved-person-id',
    'person:fictional-destination',
  );
});

it('labels provider documents honestly and keeps their saved links in Sources', () => {
  render(
    <MemoryRouter>
      <ImportReviewPresentation
        model={{
          filters: { view: 'saved', kind: 'All', query: '', editedOnly: false },
          kindCounts: { All: 2, Documents: 2 },
          reports: [
            {
              id: 'fictional-provider-documents',
              source: 'Fictional Provider',
              sourceConfirmed: true,
              reportType: 'Fictional provider records',
              date: '2026-05-14',
              subject: { label: 'Rowan', evidence: 'named', confirmed: true },
            },
          ],
          records: [
            {
              id: 'fictional-imaging-document',
              reportId: 'fictional-provider-documents',
              kind: 'Documents',
              label: 'Fictional imaging report',
              originalLabel: 'Imaging report',
              value: 'Retained provider document',
              status: 'saved',
              eligible: false,
              savedDestination: {
                recordId: 'fictional-imaging-document',
                entityId: 'fictional-imaging-entity',
                kind: 'document',
                title: 'Fictional imaging report',
                outcome: 'added',
                optical: false,
              },
            },
            {
              id: 'fictional-clinician-note',
              reportId: 'fictional-provider-documents',
              kind: 'Documents',
              label: 'Fictional clinician note',
              originalLabel: 'Visit note',
              value: 'Retained clinician note',
              status: 'saved',
              eligible: false,
              savedDestination: {
                recordId: 'fictional-clinician-note',
                entityId: 'fictional-note-entity',
                kind: 'document',
                title: 'Fictional clinician note',
                outcome: 'added',
                optical: false,
              },
            },
          ],
        }}
      />
    </MemoryRouter>,
  );

  expect(screen.getByRole('tab', { name: 'Documents2' })).toBeVisible();
  expect(screen.queryByRole('tab', { name: /Historical notes/ })).toBeNull();
  expect(screen.getByRole('link', { name: 'Sources' })).toHaveAttribute('href', '#/sources');
  expect(screen.getByText(/Unsupported items stay with the original/)).toBeVisible();
  expect(screen.getByRole('link', { name: /Fictional imaging report/ })).toHaveAttribute(
    'href',
    '/sources?document=fictional-imaging-entity',
  );
  expect(screen.getByRole('link', { name: /Fictional clinician note/ })).toHaveAttribute(
    'href',
    '/sources?document=fictional-note-entity',
  );
});

it('keeps an earlier confirmed Person destination when a later save has no receipt', () => {
  const first = {
    proposalId: 'fictional-first-proposal',
    noteId: 'note:fictional-first',
    personId: 'person:fictional-first',
    resultUrl: '#/people?id=note%3Afictional-first',
    title: 'Fictional First Person',
  };
  const destinations = appendSavedPersonDestination([], first);

  render(<SavedPersonDestinations destinations={destinations} />);

  expect(screen.getByRole('region', { name: 'Just saved People' })).toBeVisible();
  expect(screen.getByRole('link', { name: /Fictional First Person/ })).toHaveAttribute(
    'href',
    first.resultUrl,
  );
});

it('highlights file drags and sends dropped files to the upload action', () => {
  const onFiles = vi.fn();
  render(<ImportReviewPresentation model={model()} actions={{ onFiles }} />);
  const dropzone = screen.getByText('Drop reports here').closest('.import-upload-card');
  expect(dropzone).not.toBeNull();

  const file = new File(['fictional report'], 'fictional-report.pdf', {
    type: 'application/pdf',
  });
  const dataTransfer = { files: [file], types: ['Files'], dropEffect: 'none' };

  fireEvent.dragEnter(dropzone!, { dataTransfer });
  expect(dropzone).toHaveClass('is-dragging');

  fireEvent.dragOver(dropzone!, { dataTransfer });
  expect(dataTransfer.dropEffect).toBe('copy');

  fireEvent.drop(dropzone!, { dataTransfer });
  expect(dropzone).not.toHaveClass('is-dragging');
  expect(onFiles).toHaveBeenCalledOnce();
  expect(onFiles).toHaveBeenCalledWith([file]);
});

it('shows possible same-file overlap before saving without merging or blocking the result', () => {
  const onSave = vi.fn();
  const displayed: ImportReviewModel = {
    reports: [
      {
        id: 'fictional-repeat-report',
        source: 'Juniper Clinic',
        sourceConfirmed: true,
        reportType: 'Fictional panel',
        date: '2026-02-04',
        subject: {
          label: 'Rowan',
          evidence: 'named',
          confirmed: true,
          identityStatus: 'evidenced_match',
        },
      },
    ],
    records: [
      {
        id: 'fictional-repeat-row',
        reportId: 'fictional-repeat-report',
        kind: 'Test results',
        label: 'Fictional analyte',
        originalLabel: 'Original analyte wording',
        value: '17.50',
        unit: 'mg/L',
        date: '2026-02-04',
        status: 'review',
        eligible: true,
        possibleOverlap: true,
        detailUrl: '/import?group=fictional-repeat-report&record=fictional-repeat-row',
      },
    ],
  };
  const { rerender } = render(<ImportReviewPresentation model={displayed} actions={{ onSave }} />);
  expect(
    screen.getByText(/Matching numbers alone do not mean it is the same measurement/),
  ).toBeVisible();
  expect(screen.getByText(/test name, date, and body region before excluding/)).toBeVisible();
  expect(screen.getByRole('link', { name: 'Check possible overlap' })).toHaveAttribute(
    'href',
    '#/import?group=fictional-repeat-report&record=fictional-repeat-row',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Confirm & save' }));
  expect(onSave).toHaveBeenCalledWith(['fictional-repeat-row']);
  rerender(
    <ImportReviewPresentation
      model={{
        ...displayed,
        records: displayed.records.map((record) => ({ ...record, possibleOverlap: false })),
      }}
      actions={{ onSave }}
    />,
  );
  expect(screen.queryByRole('link', { name: 'Check possible overlap' })).toBeNull();
});

it.each([
  ['17.50 fictional-unit/mL', 'fictional-unit/mL', '17.50 fictional-unit/mL'],
  ['17.50mg', 'mg', '17.50mg'],
  ['17.50%', '%', '17.50%'],
  ['17.50–19.50 fictional-unit/mL', 'fictional-unit/mL', '17.50–19.50 fictional-unit/mL'],
  ['17.50', 'fictional-unit/mL', '17.50 fictional-unit/mL'],
  ['17.50 fictional-unit/mL', 'other-unit', '17.50 fictional-unit/mL other-unit'],
] as const)('renders exact measurement units once (%s / %s)', (value, unit, expected) => {
  const view = render(
    <ImportReviewPresentation
      model={{
        reports: [
          {
            id: 'fictional-unit-report',
            source: 'Fictional Clinic',
            sourceConfirmed: true,
            reportType: 'Fictional measurements',
            date: '2026-02-04',
            subject: { label: 'Rowan', evidence: 'named', confirmed: true },
          },
        ],
        records: [
          {
            id: 'fictional-unit-row',
            reportId: 'fictional-unit-report',
            kind: 'Test results',
            label: 'Fictional measurement',
            originalLabel: 'Fictional measurement',
            value,
            unit,
            status: 'review',
            eligible: true,
          },
        ],
      }}
    />,
  );
  expect(view.container.querySelector('.import-record-value')).toHaveTextContent(expected);
});

it.each(['review', 'later', 'saved'] as const)(
  'shows a comparison task only for unfinished records, not an already-saved destination (%s)',
  (view) => {
    render(
      <ImportReviewPresentation
        model={{
          filters: { view, kind: 'All', query: '', editedOnly: false },
          reports: [
            {
              id: 'fictional-accepted-report',
              source: 'Juniper Clinic',
              sourceConfirmed: true,
              reportType: 'Fictional laboratory report',
              date: '2026-04-12',
              subject: { label: 'Rowan', evidence: 'named', confirmed: true },
            },
          ],
          records: [
            {
              id: 'fictional-accepted-row',
              reportId: 'fictional-accepted-report',
              kind: 'Test results',
              label: 'Ferritin',
              originalLabel: 'Ferritin',
              value: '42',
              unit: 'ng/mL',
              status: view,
              eligible: view === 'review',
              relatedMatch: {
                value: 'Previously accepted assertion',
                source: 'saved record',
                date: '2026-04-12',
              },
              savedDestination: {
                recordId: 'fictional-accepted-row',
                entityId: 'fictional-accepted-entity',
                kind: 'observation',
                title: 'Saved fictional ferritin',
                outcome: 'added',
                optical: false,
              },
            },
          ],
        }}
      />,
      { wrapper: MemoryRouter },
    );
    if (view === 'saved') {
      expect(screen.queryByText(/Possible match:/)).toBeNull();
      expect(screen.queryByRole('button', { name: /^Compare/ })).toBeNull();
      expect(screen.getByRole('link', { name: /Saved fictional ferritin/ })).toHaveAttribute(
        'href',
        '/tests?result=fictional-accepted-entity&visibility=all',
      );
    } else {
      expect(screen.getByText(/Possible match:/)).toBeVisible();
      expect(screen.getByRole('button', { name: /^Compare/ })).toBeVisible();
    }
  },
);

it.each([
  [0, 'Discovered 0 records.'],
  [1, 'Discovered 1 record.'],
  [2, 'Discovered 2 records.'],
] as const)('labels %i retained candidates as %s', (readyRecords, expected) => {
  const active = model(1);
  active.activity!.progress = {
    accounted: 0,
    total: 0,
    readyRecords,
    readWindows: 1,
    activeMs: 0,
    sliceStartedAt: null,
    lastProgressAt: null,
  };
  render(<ImportReviewPresentation model={active} />);
  expect(screen.getByText(expected)).toBeVisible();
});

it('keeps one source entry distinct from its clinical and People review items', () => {
  const active = model(1);
  // One retained source envelope can expose both a clinical item and a Person.
  active.counts = { review: 2, later: 0, saved: 0, excluded: 0 };
  active.kindCounts = { All: 2, Vision: 1, People: 1 };
  active.activity!.progress = {
    accounted: 1,
    total: 1,
    readyRecords: 1,
    readWindows: 1,
    activeMs: 0,
    sliceStartedAt: null,
    lastProgressAt: null,
  };
  render(<ImportReviewPresentation model={active} />);
  expect(screen.getByText('Discovered 1 record.')).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Vision1' })).toBeVisible();
  expect(screen.getByRole('tab', { name: 'People1' })).toBeVisible();
  expect(screen.queryByText(/Discovered 2 records/)).toBeNull();
});

it('keeps real progress and Stop beside Moxie without a redundant Reading details sheet', () => {
  const onStopReading = vi.fn();
  const active = model(1);
  active.activity!.progress = {
    accounted: 2,
    total: 7,
    readyRecords: 30,
    readWindows: 3,
    activeMs: 120_000,
    sliceStartedAt: null,
    lastProgressAt: null,
  };
  render(<ImportReviewPresentation model={active} actions={{ onStopReading }} />);
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByText(/source sections accounted/)).toBeNull();
  expect(screen.getByText('Discovered 30 records.')).toBeVisible();
  expect(screen.getByText(/Rough estimate, narrows as files are read:/)).toBeVisible();
  expect(screen.queryByRole('button', { name: /Reading details/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Stop imports' }));
  expect(onStopReading).toHaveBeenCalledOnce();
});

it('offers explicit recovery next to still Moxie only when a resume action is available', () => {
  const onResumeReading = vi.fn();
  const paused = model();
  paused.activity!.paused = true;
  const { container } = render(
    <ImportReviewPresentation model={paused} actions={{ onResumeReading }} />,
  );
  expect(container.querySelector('.import-reading-jester')).toHaveClass('is-idle');
  fireEvent.click(screen.getByRole('button', { name: 'Resume imports' }));
  expect(onResumeReading).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Stop imports' })).toBeNull();
});

it('shows a failed reading action and leaves its control retryable', async () => {
  const onResumeReading = vi.fn().mockRejectedValue(new Error('Connection lost. Try again.'));
  render(<ImportReviewPresentation model={model()} actions={{ onResumeReading }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Resume imports' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost. Try again.');
  expect(screen.getByRole('button', { name: 'Resume imports' })).not.toBeDisabled();
});

it('confirms identity and optional birth date without a separate primary-name choice', () => {
  const onConfirmIdentity = vi.fn();
  render(
    <ImportReviewPresentation
      model={{
        reports: [
          {
            id: 'fictional-report',
            source: 'Juniper Clinic',
            sourceConfirmed: true,
            reportType: 'Lab report',
            date: 'Apr 12, 2026',
            subject: {
              label: 'Rowan',
              evidence: 'named',
              confirmed: false,
              identityStatus: 'confirmation_required',
              identityMessage: 'Confirm the retained subject evidence.',
              evidenceText: 'Rowan Ellis · 1988-04-12',
              scopeReady: true,
              targetCount: 2,
              offeredSelfFields: { fullName: 'Rowan Ellis', birthDate: '1988-04-12' },
              selfDisplayName: 'Rowan',
            },
          },
        ],
        records: [
          {
            id: 'fictional-result',
            reportId: 'fictional-report',
            kind: 'Test results',
            label: 'Ferritin',
            originalLabel: 'Ferritin',
            value: '42',
            unit: 'ng/mL',
            status: 'review',
            eligible: false,
          },
        ],
      }}
      actions={{ onConfirmIdentity }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  expect(screen.queryByRole('checkbox', { name: /Full name/ })).toBeNull();
  expect(screen.getByText('Date of birth:')).toBeVisible();
  expect(screen.getByText('1988-04-12')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'This is me' }));
  expect(onConfirmIdentity).toHaveBeenCalledWith('fictional-report', {
    birthDate: '1988-04-12',
  });
});

it('preserves a declined birthday through refreshed name evidence and resets it on reopening', async () => {
  const onConfirmIdentity = vi.fn();
  const initial: ImportReviewModel = {
    reports: [
      {
        id: 'fictional-late-identity',
        source: 'Juniper Clinic',
        sourceConfirmed: true,
        reportType: 'Fictional optical report',
        date: 'Sep 1, 2026',
        subject: {
          label: 'Rowan',
          evidence: 'named',
          confirmed: false,
          identityStatus: 'confirmation_required',
          identityMessage: 'Confirm the retained subject evidence.',
          evidenceText: 'Rowan Ellis',
          scopeReady: true,
          targetCount: 1,
          offeredSelfFields: { birthDate: '1988-04-12' },
        },
      },
    ],
    records: [
      {
        id: 'fictional-late-result',
        reportId: 'fictional-late-identity',
        kind: 'Vision',
        label: 'Eyewear prescription',
        originalLabel: 'Eyewear prescription',
        value: 'OD SPH +1.00',
        status: 'review',
        eligible: false,
      },
    ],
  };
  const { rerender } = render(
    <ImportReviewPresentation model={initial} actions={{ onConfirmIdentity }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  const fullName = screen.getByRole('checkbox', { name: /Date of birth/ });
  expect(fullName).toBeChecked();
  fireEvent.click(fullName);
  expect(fullName).not.toBeChecked();

  const withBirthDate: ImportReviewModel = {
    ...initial,
    reports: [
      {
        ...initial.reports[0],
        subject: {
          ...initial.reports[0]!.subject,
          offeredSelfFields: { fullName: 'Rowan Ellis', birthDate: '1988-04-12' },
        },
      },
    ],
  };
  rerender(<ImportReviewPresentation model={withBirthDate} actions={{ onConfirmIdentity }} />);

  expect(screen.getByRole('checkbox', { name: /Date of birth/ })).not.toBeChecked();
  expect(screen.queryByRole('checkbox', { name: /Full name/ })).toBeNull();
  rerender(
    <ImportReviewPresentation
      model={{
        ...withBirthDate,
        reports: withBirthDate.reports.map((report) => ({
          ...report,
          subject: {
            ...report.subject,
            offeredSelfFields: { ...report.subject.offeredSelfFields },
          },
        })),
      }}
      actions={{ onConfirmIdentity }}
    />,
  );
  expect(screen.getByRole('checkbox', { name: /Date of birth/ })).not.toBeChecked();

  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  expect(screen.getByRole('checkbox', { name: /Date of birth/ })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'This is me' }));
  expect(onConfirmIdentity).toHaveBeenCalledWith('fictional-late-identity', {
    birthDate: '1988-04-12',
  });
  rerender(
    <ImportReviewPresentation
      model={{
        ...initial,
        reports: initial.reports.map((report) => ({
          ...report,
          subject: {
            ...report.subject,
            confirmed: true,
            identityStatus: 'prior_confirmation',
            identityMessage: 'The retained confirmation still applies.',
            targetCount: 0,
          },
        })),
        records: initial.records.map((record) => ({
          ...record,
          status: 'saved' as const,
        })),
        filters: { view: 'saved', kind: 'All', query: '', editedOnly: false },
      }}
      actions={{ onConfirmIdentity }}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Change person for/ }));
  expect(screen.getByRole('dialog')).toHaveTextContent(
    'Review who this report belongs to. Accepted records keep their existing attribution.',
  );
  expect(screen.queryByText(/This applies to 0 records/)).toBeNull();
});

it('shows missing identity as a warning and conflicts as blocking without confirmation actions', () => {
  render(
    <ImportReviewPresentation
      model={{
        reports: [
          {
            id: 'missing',
            source: 'Juniper Clinic',
            sourceConfirmed: true,
            reportType: 'Unsigned result',
            date: 'Date not given',
            subject: {
              label: 'Rowan',
              evidence: 'missing',
              confirmed: false,
              identityStatus: 'missing_warning',
              identityMessage: 'No supported name or birthday was found. You can still review it.',
              reviewUrl: '/import?group=missing',
            },
          },
          {
            id: 'conflict',
            source: 'Mesa Lab',
            sourceConfirmed: true,
            reportType: 'Conflicting result',
            date: 'May 2, 2026',
            subject: {
              label: 'Different Person',
              evidence: 'named',
              confirmed: false,
              identityStatus: 'conflict',
              scopeReady: false,
              scopeError: 'Review the conflicting report evidence.',
              identityMessage: 'The evidenced birthday differs from Self.',
              blocking: true,
              conflicts: [
                {
                  field: 'birthDate',
                  selfValue: '1988-04-12',
                  evidencedValue: '1991-09-03',
                  reason: 'self_mismatch',
                },
              ],
              reviewUrl: '/import?group=conflict',
            },
          },
        ],
        records: [
          {
            id: 'missing-result',
            reportId: 'missing',
            kind: 'Test results',
            label: 'Ferritin',
            originalLabel: 'Ferritin',
            value: '42',
            status: 'review',
            eligible: true,
          },
          {
            id: 'conflict-result',
            reportId: 'conflict',
            kind: 'Test results',
            label: 'Glucose',
            originalLabel: 'Glucose',
            value: '90',
            status: 'review',
            eligible: false,
          },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review person for Unsigned result' }));
  expect(screen.getByText('Identity is not printed clearly in this report.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'This is me' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review person for Conflicting result' }));
  expect(screen.getByText('Report identity could not be established.')).toBeVisible();
  expect(screen.getByText(/Self has 1988-04-12; report evidence has 1991-09-03/)).toBeVisible();
  expect(screen.getByRole('link', { name: 'Review retained report evidence' })).toHaveAttribute(
    'href',
    '#/import?group=conflict',
  );
  expect(screen.getByRole('button', { name: 'This is me' })).toBeDisabled();
});

it('keeps an evidenced match saveable while offering a separate optional Self fill', () => {
  const onConfirmIdentity = vi.fn();
  render(
    <ImportReviewPresentation
      model={{
        reports: [
          {
            id: 'matched',
            source: 'Mesa Lab',
            sourceConfirmed: true,
            reportType: 'Matched result',
            date: 'May 2, 2026',
            subject: {
              label: 'Rowan',
              evidence: 'named',
              confirmed: true,
              identityStatus: 'evidenced_match',
              identityMessage: 'The retained birthday matches Self.',
              offeredSelfFields: { birthDate: '1988-04-12' },
              selfDisplayName: 'Rowan',
            },
          },
        ],
        records: [
          {
            id: 'matched-result',
            reportId: 'matched',
            kind: 'Test results',
            label: 'Ferritin',
            originalLabel: 'Ferritin',
            value: '42',
            status: 'review',
            eligible: true,
          },
        ],
      }}
      actions={{ onConfirmIdentity }}
    />,
  );
  expect(screen.getByRole('button', { name: 'Confirm & save' })).not.toBeDisabled();
  expect(screen.queryByRole('button', { name: 'This is me' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Change person for/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(onConfirmIdentity).toHaveBeenCalledWith('matched', { birthDate: '1988-04-12' });
});

it('explains the real review blocker beside a disabled save action', () => {
  render(
    <MemoryRouter>
      <ImportReviewPresentation
        model={{
          reports: [
            {
              id: 'fictional-blocked-report',
              source: 'Fictional source already reviewed',
              sourceConfirmed: true,
              reportType: 'Fictional report',
              date: '2026-06-03',
              subject: { label: 'Self', evidence: 'named', confirmed: true },
            },
          ],
          records: [
            {
              id: 'fictional-blocked-result',
              reportId: 'fictional-blocked-report',
              kind: 'Test results',
              label: 'Fictional cloudy reading',
              originalLabel: 'Cloudy reading',
              value: 'Needs review',
              status: 'review',
              eligible: false,
              saveBlockReason: 'Resolve the uncertain reading before saving this record.',
              detailUrl: '/import?group=fictional-blocked-report&intake=fictional-intake',
            },
          ],
        }}
      />
    </MemoryRouter>,
  );

  const save = screen.getByRole('button', { name: 'Confirm & save' });
  const reason = screen.getByText('Resolve the uncertain reading before saving this record.');
  expect(save).toBeDisabled();
  expect(save).toHaveAttribute('aria-describedby', reason.closest('.import-save-blocker')!.id);
  expect(screen.getByRole('button', { name: /Open review/ })).toBeEnabled();
  expect(screen.queryByRole('link', { name: /Open review/ })).toBeNull();
  expect(screen.queryByText(/source.*required|required.*source/i)).toBeNull();
});

it('previews a scoped selected-field correction and keeps the source-linked editor usable after failure', async () => {
  const onCorrectDrafts = vi.fn().mockResolvedValue('The selected drafts changed.');
  const onAskDraftRepair = vi.fn();
  const draft = (id: string, date: string) => ({
    id,
    reportId: 'fictional-correction-report',
    kind: 'Test results' as const,
    label: `Fictional ${id}`,
    originalLabel: `Original ${id}`,
    value: '7',
    status: 'review' as const,
    eligible: true,
    originalUrl: `/api/sources/${id}/content`,
    draftRepair: {
      intakeId: 'fictional-intake',
      proposalId: null,
      recordId: id,
      candidateVersionId: `candidate-${id}`,
      fields: { date, method: `Method ${id}`, observationCategory: 'Fictional panel' },
    },
  });
  render(
    <ImportReviewPresentation
      model={{
        reports: [
          {
            id: 'fictional-correction-report',
            source: 'Fictional source',
            sourceConfirmed: true,
            reportType: 'Fictional results',
            date: 'Multiple dates',
            subject: { label: 'Self', evidence: 'named', confirmed: true },
          },
        ],
        records: [draft('row-one', '2025-01-01'), draft('row-two', '2024-02-02')],
      }}
      actions={{ onCorrectDrafts, onAskDraftRepair }}
    />,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Fictional row-one' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Fictional row-two' }));
  fireEvent.click(screen.getByRole('button', { name: 'Correct selected fields' }));
  const dialog = screen.getByRole('dialog', { name: 'Correct selected drafts' });
  expect(within(dialog).getAllByRole('link', { name: /Open source/ })).toHaveLength(2);
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'New date' }), {
    target: { value: '2025-03-03' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview changes' }));
  expect(within(dialog).getByText(/2025-01-01 → 2025-03-03/)).toBeVisible();
  expect(within(dialog).getByText(/2024-02-02 → 2025-03-03/)).toBeVisible();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply to 2 drafts' }));
  await waitFor(() => expect(onCorrectDrafts).toHaveBeenCalledTimes(1));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('selected drafts changed');
  expect(within(dialog).getByRole('textbox', { name: 'New date' })).toHaveValue('2025-03-03');

  fireEvent.change(
    within(dialog).getByRole('textbox', { name: 'Ask Moxie to check these source sections' }),
    { target: { value: 'Check whether each printed date belongs to its own row.' } },
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Ask for a source-linked preview' }));
  expect(onAskDraftRepair).toHaveBeenCalledWith(
    expect.objectContaining({
      format: 'intake-draft-repair-selection-v1',
      intakeId: 'fictional-intake',
      groupId: 'fictional-correction-report',
    }),
    'Check whether each printed date belongs to its own row.',
  );
});

it('labels detail actions as record review and keeps their exact full-review destination', () => {
  render(
    <MemoryRouter>
      <ImportReviewPresentation
        model={{
          reports: [
            {
              id: 'fictional-review-actions-report',
              source: 'Fictional source',
              sourceConfirmed: true,
              reportType: 'Fictional vision report',
              date: '2031-04-05',
              subject: { label: 'Self', evidence: 'named', confirmed: true },
            },
          ],
          records: [
            {
              id: 'fictional-review-actions-record',
              reportId: 'fictional-review-actions-report',
              kind: 'Vision',
              label: 'Fictional starlight eyewear record',
              originalLabel: 'Fictional starlight eyewear record',
              value: 'Review retained fields',
              status: 'review',
              eligible: false,
              detailUrl:
                '/import?group=fictional-review-actions-report&record=fictional-review-actions-record',
            },
          ],
        }}
      />
    </MemoryRouter>,
  );

  fireEvent.click(
    screen.getByRole('button', {
      name: 'More actions for Fictional starlight eyewear record',
    }),
  );
  const dialog = screen.getByRole('dialog', { name: 'Review record' });
  expect(within(dialog).getByRole('link', { name: 'Open full review' })).toHaveAttribute(
    'href',
    '#/import?group=fictional-review-actions-report&record=fictional-review-actions-record',
  );
  expect(within(dialog).getByRole('button', { name: 'Exclude from results' })).toBeVisible();
  expect(within(dialog).queryByRole('textbox', { name: 'Value' })).toBeNull();
  expect(within(dialog).queryByRole('textbox', { name: 'Unit' })).toBeNull();
});

it('retains the manual-edit title for a record with the inline editor', () => {
  render(
    <ImportReviewPresentation
      model={{
        reports: [
          {
            id: 'fictional-inline-edit-report',
            source: 'Fictional source',
            sourceConfirmed: true,
            reportType: 'Fictional measurements',
            date: '2031-04-05',
            subject: { label: 'Self', evidence: 'named', confirmed: true },
          },
        ],
        records: [
          {
            id: 'fictional-inline-edit-record',
            reportId: 'fictional-inline-edit-report',
            kind: 'Test results',
            label: 'Fictional moonbeam reading',
            originalLabel: 'Fictional moonbeam reading',
            value: '4.5',
            unit: 'fictional units',
            status: 'review',
            eligible: true,
          },
        ],
      }}
    />,
  );

  fireEvent.click(
    screen.getByRole('button', { name: 'More actions for Fictional moonbeam reading' }),
  );
  const dialog = screen.getByRole('dialog', { name: 'Manually edit record' });
  expect(within(dialog).getByRole('textbox', { name: 'Value' })).toBeVisible();
  expect(within(dialog).getByRole('textbox', { name: 'Unit' })).toBeVisible();
  expect(within(dialog).queryByRole('link', { name: 'Open full review' })).toBeNull();
});

it('closes a cached identity sheet when refreshed state says confirmation is already retained', async () => {
  const onConfirmIdentity = vi.fn();
  const pending: ImportReviewModel = {
    reports: [
      {
        id: 'fictional-retained-confirmation',
        source: 'Mesa Lab',
        sourceConfirmed: true,
        reportType: 'Fictional result',
        date: 'May 2, 2026',
        subject: {
          label: 'Rowan',
          evidence: 'named',
          confirmed: false,
          identityStatus: 'confirmation_required',
          evidenceText: 'Rowan Ellis · 1988-04-12',
          scopeReady: true,
          offeredSelfFields: { fullName: 'Rowan Ellis', birthDate: '1988-04-12' },
        },
      },
    ],
    records: [
      {
        id: 'fictional-retained-result',
        reportId: 'fictional-retained-confirmation',
        kind: 'Test results',
        label: 'Ferritin',
        originalLabel: 'Ferritin',
        value: '42',
        status: 'review',
        eligible: false,
      },
    ],
  };
  const { rerender } = render(
    <ImportReviewPresentation model={pending} actions={{ onConfirmIdentity }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  expect(screen.getByRole('dialog')).toBeVisible();

  rerender(
    <ImportReviewPresentation
      model={{
        ...pending,
        reports: [
          {
            ...pending.reports[0],
            subject: {
              ...pending.reports[0].subject,
              confirmed: true,
              identityStatus: 'prior_confirmation',
              offeredSelfFields: {},
            },
          },
        ],
      }}
      actions={{ onConfirmIdentity }}
    />,
  );

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryByRole('button', { name: /This is me|Self details/ })).toBeNull();
  expect(onConfirmIdentity).not.toHaveBeenCalled();
});

it('keeps an entered fictional source label and explains a refreshed scope that needs review', async () => {
  const onUseSource = vi.fn(async () =>
    Promise.resolve(
      'This report gained or changed source evidence, people, or records while you were labeling it. Your label is still entered; review the updated scope, then use it again.',
    ),
  );
  render(
    <ImportReviewPresentation
      model={{
        reports: [
          {
            id: 'fictional-source-scope',
            source: 'Source not labeled',
            sourceLabelAvailable: true,
            sourceNeedsLabel: true,
            sourceConfirmed: false,
            reportType: 'Fictional optical report',
            date: 'September 1, 2026',
            subject: { label: 'Self', evidence: 'missing', confirmed: false },
          },
        ],
        records: [
          {
            id: 'fictional-result',
            reportId: 'fictional-source-scope',
            kind: 'Vision',
            label: 'Fictional eyewear prescription',
            originalLabel: 'Fictional eyewear prescription',
            value: 'OD SPH +1.00',
            status: 'review',
            eligible: false,
          },
        ],
      }}
      actions={{ onUseSource }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
  expect(screen.getByRole('dialog')).toHaveTextContent(
    /eligible results you save.*Original issuer and upload history stay unchanged/,
  );
  expect(screen.getByText(/This source is used when you save records/)).toBeVisible();
  const input = screen.getByRole('textbox', { name: 'Source' });
  fireEvent.change(input, { target: { value: 'Fictional Vision Center' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use source' }));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(/Your label is still entered/),
  );
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(input).toHaveValue('Fictional Vision Center');
  expect(onUseSource).toHaveBeenCalledOnce();
});

it('presents the default source as one editable pill without an unapplied warning', async () => {
  render(
    <ImportReviewPresentation
      model={{
        reports: [
          {
            id: 'fictional-source-suggestion',
            source: 'Fictional Imaging Center',
            sourceSuggested: true,
            sourceLabelAvailable: true,
            sourceNeedsLabel: false,
            sourceConfirmed: false,
            reportType: 'Fictional imaging report',
            date: '2026-05-14',
            subject: { label: 'Rowan', evidence: 'named', confirmed: true },
          },
        ],
        records: [
          {
            id: 'fictional-suggested-document',
            reportId: 'fictional-source-suggestion',
            kind: 'Documents',
            label: 'Fictional provider document',
            originalLabel: 'Provider document',
            value: 'Retained report',
            status: 'review',
            eligible: false,
          },
        ],
      }}
    />,
  );

  expect(screen.queryByText('Suggested · not applied')).toBeNull();
  expect(
    screen.getAllByRole('button', { name: 'Change source: Fictional Imaging Center' }),
  ).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Change source: Fictional Imaging Center' }));
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(
    screen.getByText(/Use this label for the report and eligible results you save/),
  ).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Use source' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(
    screen.getByText('Source changed to “Fictional Imaging Center”. Nothing has been saved yet.'),
  ).toBeVisible();
  expect(screen.queryByText('Suggested · not applied')).toBeNull();
});

it('shows the exact source scope and submits it through one confirmation while the action is pending', async () => {
  const review = sourceReview('active');
  const action = controlledPromise<void | string | null>();
  const onReviewSource = vi.fn(async () => review);
  const onUseSource = vi.fn(() => action.promise);
  render(
    <ImportReviewPresentation model={sourceModel()} actions={{ onReviewSource, onUseSource }} />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Change source: Fictional Imaging Center' }));
  expect(screen.getByRole('button', { name: 'Use source' })).toBeDisabled();
  await waitFor(() => expect(screen.getByText(/2 records will use/)).toBeVisible());
  expect(screen.getByText(/1 already have a reviewed source; 1 do not/)).toBeVisible();
  expect(screen.getByText(/Fictional right eye result.*page 1 · row 4/)).toBeVisible();
  expect(screen.getByText(/Fictional left eye result.*page 9 · row 2/)).toBeVisible();
  expect(screen.getByText(/Retained source evidence: Fictional Imaging Center/)).toBeVisible();

  fireEvent.change(screen.getByRole('textbox', { name: 'Source' }), {
    target: { value: 'Fictional BodySpec Annex' },
  });
  expect(screen.getByRole('alert')).toHaveTextContent(
    /Fictional BodySpec Annex.*differs from retained source evidence/,
  );
  const confirm = screen.getByRole('button', {
    name: 'Use Fictional BodySpec Annex for 2 records',
  });
  fireEvent.click(confirm);
  expect(onUseSource).toHaveBeenCalledOnce();
  expect(onUseSource).toHaveBeenCalledWith(
    'fictional-source-scope',
    'Fictional BodySpec Annex',
    review,
  );
  expect(screen.getByRole('button', { name: 'Using source…' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Using source…' }));
  expect(onUseSource).toHaveBeenCalledOnce();

  action.resolve(null);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('retries a failed initial source preflight without losing the entered label or submitting it', async () => {
  const refreshed = {
    ...sourceReview('active'),
    intakeVersion: 10,
    scopeToken: 'fictional-scope-token-active-refreshed',
    targets: sourceReview('active').targets.slice(0, 1),
    coverage: {
      total: 1,
      covered: 0,
      uncovered: 1,
      status: 'empty' as const,
      bySource: [],
    },
  };
  const onReviewSource = vi
    .fn<(reportId: string) => Promise<IntakeReportSourceReview>>()
    .mockRejectedValueOnce(new Error('The fictional affected records did not load.'))
    .mockResolvedValueOnce(refreshed);
  const onUseSource = vi.fn(async () => null);
  render(
    <ImportReviewPresentation model={sourceModel()} actions={{ onReviewSource, onUseSource }} />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Change source: Fictional Imaging Center' }));
  const input = screen.getByRole('textbox', { name: 'Source' });
  fireEvent.change(input, { target: { value: 'Fictional Entered Source' } });
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(/affected records did not load/),
  );
  const retry = screen.getByRole('button', { name: 'Retry affected records' });
  expect(retry).toBeEnabled();
  fireEvent.click(retry);

  expect(onUseSource).not.toHaveBeenCalled();
  expect(onReviewSource).toHaveBeenCalledTimes(2);
  expect(input).toHaveValue('Fictional Entered Source');
  const confirm = await screen.findByRole('button', {
    name: 'Use Fictional Entered Source for 1 record',
  });
  expect(screen.queryByText(/affected records did not load/)).toBeNull();
  fireEvent.click(confirm);

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(onUseSource).toHaveBeenCalledOnce();
  expect(onUseSource).toHaveBeenCalledWith(
    'fictional-source-scope',
    'Fictional Entered Source',
    refreshed,
  );
});

it('keeps an uncertain source action visible when its refresh fails and retries only the preflight', async () => {
  const review = sourceReview('all');
  const refreshed = {
    ...review,
    intakeVersion: 10,
    scopeToken: 'fictional-scope-token-all-refreshed-after-uncertainty',
    targets: review.targets.slice(0, 1),
    coverage: {
      total: 1,
      covered: 1,
      uncovered: 0,
      status: 'single' as const,
      bySource: [{ source: 'Previously reviewed source', count: 1 }],
    },
  };
  const onReviewSource = vi
    .fn<(reportId: string) => Promise<IntakeReportSourceReview>>()
    .mockResolvedValueOnce(review)
    .mockRejectedValueOnce(new Error('The refreshed fictional scope did not load.'))
    .mockResolvedValueOnce(refreshed);
  const onUseSource = vi
    .fn<
      (
        reportId: string,
        source: string,
        displayedReview?: IntakeReportSourceReview,
      ) => Promise<string | null>
    >()
    .mockRejectedValueOnce(
      new Error('The fictional source write outcome is uncertain; review before trying again.'),
    );
  render(
    <ImportReviewPresentation
      model={sourceModel('fictional-profile:all')}
      actions={{ onReviewSource, onUseSource }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Change source: Fictional Imaging Center' }));
  const confirm = await screen.findByRole('button', {
    name: 'Use Fictional Imaging Center for 2 records',
  });
  fireEvent.click(confirm);

  await waitFor(() => {
    const alerts = screen.getAllByRole('alert').map((entry) => entry.textContent);
    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/write outcome is uncertain/),
        expect.stringMatching(/refreshed fictional scope did not load/),
      ]),
    );
  });
  expect(screen.getByRole('textbox', { name: 'Source' })).toHaveValue('Fictional Imaging Center');
  const retry = screen.getByRole('button', { name: 'Retry affected records' });
  expect(retry).toBeEnabled();
  fireEvent.click(retry);

  expect(onUseSource).toHaveBeenCalledOnce();
  expect(onReviewSource).toHaveBeenCalledTimes(3);
  expect(
    await screen.findByRole('button', { name: 'Use Fictional Imaging Center for 1 record' }),
  ).toBeEnabled();
  expect(screen.getByRole('alert')).toHaveTextContent(/write outcome is uncertain/);
  expect(screen.queryByText(/refreshed fictional scope did not load/)).toBeNull();
  expect(onUseSource).toHaveBeenCalledOnce();
});

it('keeps a failed source action reviewable and allows a deliberate retry', async () => {
  const review = sourceReview('all');
  const refreshed = {
    ...review,
    intakeVersion: 10,
    scopeToken: 'fictional-scope-token-all-refreshed',
    targets: review.targets.slice(0, 1),
    coverage: {
      total: 1,
      covered: 1,
      uncovered: 0,
      status: 'single' as const,
      bySource: [{ source: 'Previously reviewed source', count: 1 }],
    },
  };
  const onReviewSource = vi
    .fn<(reportId: string) => Promise<IntakeReportSourceReview>>()
    .mockResolvedValueOnce(review)
    .mockResolvedValueOnce(refreshed);
  const onUseSource = vi
    .fn<
      (
        reportId: string,
        source: string,
        displayedReview?: IntakeReportSourceReview,
      ) => Promise<string | null>
    >()
    .mockResolvedValueOnce('The exact source scope changed. Review it again.')
    .mockResolvedValueOnce(null);
  render(
    <ImportReviewPresentation
      model={sourceModel('fictional-profile:all')}
      actions={{ onReviewSource, onUseSource }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Change source: Fictional Imaging Center' }));
  const confirm = await screen.findByRole('button', {
    name: 'Use Fictional Imaging Center for 2 records',
  });
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(/exact source scope changed/),
  );
  expect(
    await screen.findByRole('button', { name: 'Use Fictional Imaging Center for 1 record' }),
  ).toBeEnabled();
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Source' })).toHaveValue('Fictional Imaging Center');

  fireEvent.click(
    screen.getByRole('button', { name: 'Use Fictional Imaging Center for 1 record' }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(onUseSource).toHaveBeenCalledTimes(2);
  expect(onUseSource).toHaveBeenLastCalledWith(
    'fictional-source-scope',
    'Fictional Imaging Center',
    refreshed,
  );
});

it('discards source preflights after close and after profile or view context changes', async () => {
  const first = controlledPromise<IntakeReportSourceReview>();
  const second = controlledPromise<IntakeReportSourceReview>();
  const onReviewSource = vi
    .fn<(reportId: string) => Promise<IntakeReportSourceReview>>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const { rerender } = render(
    <ImportReviewPresentation
      model={sourceModel('fictional-profile:active')}
      actions={{ onReviewSource }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Change source: Fictional Imaging Center' }));
  expect(screen.getByText('Loading affected records…')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  first.resolve(sourceReview('active'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  fireEvent.click(screen.getByRole('button', { name: 'Change source: Fictional Imaging Center' }));
  expect(onReviewSource).toHaveBeenCalledTimes(2);
  rerender(
    <ImportReviewPresentation
      model={sourceModel('fictional-profile:deferred')}
      actions={{ onReviewSource }}
    />,
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  second.resolve(sourceReview('active'));
  await waitFor(() => expect(screen.queryByText(/2 records will use/)).toBeNull());
});

it('shows compatible future source coverage without asking for another confirmation', () => {
  const initial = sourceModel();
  const confirmed = {
    ...initial,
    reports: [
      {
        ...initial.reports[0],
        sourceSuggested: false,
        sourceConfirmed: true,
        sourceCoverage: {
          current: {
            total: 2,
            covered: 2,
            uncovered: 0,
            status: 'single' as const,
            bySource: [{ source: 'Fictional Imaging Center', count: 2 }],
          },
          saved: { total: 0, covered: 0, uncovered: 0, status: 'empty' as const, bySource: [] },
        },
      },
    ],
  };
  const { rerender } = render(<ImportReviewPresentation model={confirmed} />);
  fireEvent.click(screen.getByRole('button', { name: /Change source for/ }));
  expect(screen.getByText(/Current 2\/2 source-labeled/)).toBeVisible();

  rerender(
    <ImportReviewPresentation
      model={{
        ...confirmed,
        reports: [
          {
            ...confirmed.reports[0],
            sourceCoverage: {
              ...confirmed.reports[0].sourceCoverage!,
              current: {
                total: 3,
                covered: 3,
                uncovered: 0,
                status: 'single',
                bySource: [{ source: 'Fictional Imaging Center', count: 3 }],
              },
            },
          },
        ],
      }}
    />,
  );
  expect(screen.getByText(/Current 3\/3 source-labeled/)).toBeVisible();
  expect(
    screen.queryByRole('button', { name: /Change source: Fictional Imaging Center/ }),
  ).toBeNull();
});

it('keeps technical page timing and model passes out of simple progress', () => {
  const active = model(1);
  active.activity!.progress = {
    accounted: 2,
    total: 100,
    readyRecords: 1,
    readWindows: 3,
    activeMs: 1000,
    sliceStartedAt: null,
    lastProgressAt: null,
    pageTiming: {
      turn: 1,
      recentIntervalMs: 12000,
      intervalSamples: 2,
      lastReadMs: 3000,
      lastCompletedAt: '2026-09-23T00:00:00.000Z',
    },
  };
  const view = render(<ImportReviewPresentation model={active} />);
  expect(screen.getByText('Estimating…')).toBeVisible();
  expect(screen.queryByText(/Recent interval between page reads/)).toBeNull();
  expect(screen.queryByText(/Last page prepared/)).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
  active.activity!.progress!.pageTiming = {
    turn: 2,
    recentIntervalMs: null,
    intervalSamples: 0,
    lastReadMs: null,
    lastCompletedAt: null,
  };
  view.rerender(<ImportReviewPresentation model={{ ...active }} />);
  expect(screen.queryByText(/Model context restarted/)).toBeNull();
  expect(screen.queryByText(/Recent interval between page reads/)).toBeNull();
  expect(screen.queryByText(/Last page prepared/)).toBeNull();
});

function personChoiceModel(): ImportReviewModel {
  const current = sourceModel();
  current.reports[0].subject = {
    label: 'Jordan Example',
    evidence: 'named',
    confirmed: false,
    identityStatus: 'confirmation_required',
    scopeReady: true,
    printedName: 'Jordan Example',
    evidenceText: 'Jordan Example',
    offeredSelfFields: { fullName: 'Jordan Example' },
    people: [
      {
        noteId: 'person-note:fictional-parent',
        personId: 'fictional-parent',
        version: 3,
        fullName: 'Avery Example',
      },
    ],
  };
  return current;
}

it('assigns a mismatched report to a new family person without selecting Self fields or accepting results', () => {
  const onConfirmIdentity = vi.fn();
  const onSave = vi.fn();
  render(
    <ImportReviewPresentation
      model={personChoiceModel()}
      actions={{ onConfirmIdentity, onSave }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Person for this report' }), {
    target: { value: 'new' },
  });
  expect(screen.getByRole('textbox', { name: 'New person name' })).toHaveValue('Jordan Example');
  fireEvent.change(screen.getByRole('textbox', { name: 'New person name' }), {
    target: { value: ' ' },
  });
  expect(screen.getByRole('button', { name: 'Confirm person' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'New person name' }), {
    target: { value: 'Jordan Example' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'New person relationship' }), {
    target: { value: 'Sibling' },
  });
  expect(screen.queryByRole('checkbox', { name: /Full name/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm person' }));
  expect(onConfirmIdentity).toHaveBeenCalledWith(
    'fictional-source-scope',
    {},
    { newPerson: { fullName: 'Jordan Example', relationship: 'Sibling' } },
  );
  expect(onSave).not.toHaveBeenCalled();
});

it('pins the selected existing person version and leaves results in review', () => {
  const onConfirmIdentity = vi.fn();
  const onSave = vi.fn();
  render(
    <ImportReviewPresentation
      model={personChoiceModel()}
      actions={{ onConfirmIdentity, onSave }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Person for this report' }), {
    target: { value: 'person-note:fictional-parent' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm person' }));
  expect(onConfirmIdentity).toHaveBeenCalledWith(
    'fictional-source-scope',
    {},
    { noteId: 'person-note:fictional-parent', expectedVersion: 3 },
  );
  expect(onSave).not.toHaveBeenCalled();
});

it('explains that Self confirmation retains the printed name without replacing primary identity', () => {
  const current = personChoiceModel();
  current.reports[0].subject.offeredSelfFields = {};
  const onConfirmIdentity = vi.fn();
  render(<ImportReviewPresentation model={current} actions={{ onConfirmIdentity }} />);
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  expect(screen.getByText(/Confirming retains “Jordan Example” in your Names/)).toBeVisible();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'This is me' }));
  expect(onConfirmIdentity).toHaveBeenCalledWith('fictional-source-scope', {});
});

it('requires an explicit printed name when report identity lacks a separated name field', () => {
  const current = personChoiceModel();
  current.reports[0].subject.printedName = undefined;
  current.reports[0].subject.printedNameRequired = true;
  current.reports[0].subject.evidenceText = 'Patient: Fictional Jordan Example; member 42';
  current.reports[0].subject.offeredSelfFields = {};
  const onConfirmIdentity = vi.fn();
  render(<ImportReviewPresentation model={current} actions={{ onConfirmIdentity }} />);
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'This is me' });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: /Name printed on this report/ }), {
    target: { value: 'Name absent from the source' },
  });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: /Name printed on this report/ }), {
    target: { value: 'Fictional Jordan Example' },
  });
  fireEvent.click(confirm);
  expect(onConfirmIdentity).toHaveBeenCalledWith(
    'fictional-source-scope',
    {},
    undefined,
    'Fictional Jordan Example',
  );
});

it('keeps the current family assignment visible when the bounded People list omits it', () => {
  const current = personChoiceModel();
  current.reports[0].subject.confirmed = true;
  current.reports[0].subject.identityStatus = 'prior_confirmation';
  current.reports[0].subject.assignedPerson = {
    noteId: 'person-note:fictional-assigned',
    personId: 'fictional-assigned',
    version: 8,
    fullName: 'Jordan Example',
  };
  current.reports[0].subject.peopleTruncated = true;
  render(<ImportReviewPresentation model={current} actions={{ onConfirmIdentity: vi.fn() }} />);
  expect(screen.queryByRole('button', { name: /Review person for/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Change person for/ }));
  expect(screen.getByRole('combobox', { name: 'Person for this report' })).toHaveValue(
    'person-note:fictional-assigned',
  );
  expect(screen.getByText(/The first 100 people are listed/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Done' })).toBeVisible();
});

it('uses one header source review control and keeps retained source evidence in its sheet', () => {
  const current = sourceModel();
  current.reports[0].sourceEvidence = {
    label: 'Cookie Doe retained report',
    contentUrl: '/fictional-cookie-doe-report',
  };
  const { container } = render(<ImportReviewPresentation model={current} />);
  const header = container.querySelector('.import-report-header')!;
  expect(
    within(header as HTMLElement).getAllByRole('button', {
      name: 'Change source: Fictional Imaging Center',
    }),
  ).toHaveLength(1);
  expect(container.querySelector('.import-source-question')).toBeNull();
  expect(screen.queryByRole('link', { name: /Cookie Doe retained report/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Change source: Fictional Imaging Center' }));
  expect(
    within(screen.getByRole('dialog')).getByRole('link', { name: /Cookie Doe retained report/ }),
  ).toHaveAttribute('href', '/fictional-cookie-doe-report');
});

it('keeps pending and confirmed person actions in the same compact header', () => {
  const current = personChoiceModel();
  current.reports[0].subject.label = 'Cookie Doe';
  current.reports[0].subject.printedName = 'Cookie Doe';
  const { container, rerender } = render(<ImportReviewPresentation model={current} />);
  const pending = screen.getByRole('button', { name: /Review person for/ });
  expect(container.querySelector('.import-report-header')).toContainElement(pending);
  expect(container.querySelector('.import-person-choice-pending')).toBeNull();
  current.reports[0].subject.confirmed = true;
  current.reports[0].subject.identityStatus = 'prior_confirmation';
  rerender(<ImportReviewPresentation model={{ ...current }} />);
  expect(screen.queryByRole('button', { name: /Review person for/ })).toBeNull();
  const change = screen.getByRole('button', { name: /Change person for/ });
  expect(change).toHaveTextContent('Cookie Doe');
  expect(container.querySelector('.import-report-header')).toContainElement(change);
  fireEvent.click(change);
  expect(screen.getByRole('dialog')).toBeVisible();
});

it('uses one source/person sidebar, keeps a draft label while switching tabs, and closes unchanged identity without another confirmation', () => {
  const current = personChoiceModel();
  current.reports[0].filename = 'cookie-doe-report.pdf';
  current.reports[0].subject.printedName = 'Cookie Doe';
  current.reports[0].subject.confirmed = true;
  current.reports[0].subject.identityStatus = 'prior_confirmation';
  current.reports[0].subject.offeredSelfFields = {};
  const onConfirmIdentity = vi.fn();
  const onUseSource = vi.fn();
  const { container } = render(
    <ImportReviewPresentation model={current} actions={{ onConfirmIdentity, onUseSource }} />,
  );
  expect(screen.getByText('New Import Source: cookie-doe-report.pdf')).toBeVisible();
  expect(screen.getByRole('button', { name: /Change person for/ })).toHaveTextContent(
    'Cookie Doe (you)',
  );
  expect(container.querySelector('.import-identity-question')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Change source: Fictional Imaging Center' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Source' }), {
    target: { value: 'Cookie Clinic' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Person' }));
  expect(screen.queryByRole('button', { name: 'Confirm as me' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  expect(screen.getByRole('textbox', { name: 'Source' })).toHaveValue('Cookie Clinic');
  expect(onUseSource).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Person' }));
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(onConfirmIdentity).not.toHaveBeenCalled();
});

it('opens the record editor directly beneath its row and preserves it when draft flush fails', async () => {
  const value = sourceModel();
  const beforeReviewChange = vi.fn().mockResolvedValue(true);
  const onFiltersChange = vi.fn();
  render(
    <ImportReviewPresentation
      model={value}
      beforeReviewChange={beforeReviewChange}
      actions={{ onFiltersChange }}
      renderRecordReview={(record, close) => (
        <section aria-label={`Inline editor for ${record.label}`}>
          <label>
            Reviewed value
            <input defaultValue="Cookie Doe's fictional result" />
          </label>
          <button onClick={close}>Finish inline review</button>
        </section>
      )}
    />,
  );
  const trigger = screen.getByRole('button', { name: 'Review' });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(trigger);
  const editor = await screen.findByRole('region', { name: /Inline editor/ });
  expect(editor.closest('.import-record')).toBe(trigger.closest('.import-record'));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.change(screen.getByLabelText('Reviewed value'), {
    target: { value: 'Human correction' },
  });
  beforeReviewChange.mockResolvedValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'Close review' }));
  await waitFor(() => expect(beforeReviewChange).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('Reviewed value')).toHaveValue('Human correction');
  fireEvent.change(screen.getByRole('combobox', { name: 'Review status' }), {
    target: { value: 'later' },
  });
  await waitFor(() => expect(beforeReviewChange).toHaveBeenCalledTimes(3));
  expect(onFiltersChange).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Reviewed value')).toHaveValue('Human correction');
  beforeReviewChange.mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Close review' }));
  await waitFor(() => expect(screen.queryByLabelText('Reviewed value')).toBeNull());
});

it('keeps the open draft mounted when a background feed removes its record version', async () => {
  const original = sourceModel();
  const props = {
    beforeReviewChange: async () => true,
    renderRecordReview: () => (
      <label>
        Unfinished record
        <input defaultValue="Draft" />
      </label>
    ),
  };
  const view = render(<ImportReviewPresentation model={original} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  fireEvent.change(await screen.findByLabelText('Unfinished record'), {
    target: { value: 'Keep this correction' },
  });
  view.rerender(
    <ImportReviewPresentation model={{ ...original, reports: [], records: [] }} {...props} />,
  );
  expect(screen.getByLabelText('Unfinished record')).toHaveValue('Keep this correction');
  fireEvent.click(screen.getByRole('button', { name: 'Close review' }));
  await waitFor(() => expect(screen.queryByLabelText('Unfinished record')).toBeNull());
  await waitFor(() => expect(screen.queryByText('Fictional eyewear prescription')).toBeNull());
});

it('retains a newer open correction when background refresh says the record was saved', async () => {
  const original = sourceModel();
  const props = {
    renderRecordReview: () => <input aria-label="Pinned correction" defaultValue="Draft" />,
  };
  const view = render(<ImportReviewPresentation model={original} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  fireEvent.change(await screen.findByLabelText('Pinned correction'), {
    target: { value: 'Cookie Doe correction' },
  });
  view.rerender(
    <ImportReviewPresentation
      {...props}
      model={{
        ...original,
        records: original.records.map((record) => ({
          ...record,
          status: 'saved',
          kind: 'Documents',
          manuallyEdited: true,
        })),
      }}
    />,
  );

  // A background status is not acknowledgement of this local edit.
  // See docs/import/review-reliability.md. Keep it for explicit reconciliation.
  expect(screen.getByLabelText('Pinned correction')).toHaveValue('Cookie Doe correction');
  expect(screen.getByText('Fictional eyewear prescription')).toBeVisible();
});

it('retains a dirty report source editor across feed replacement but not profile changes', () => {
  const original = { ...sourceModel(), contextKey: 'cookie-profile' };
  const props = {
    preserveSourceReview: true,
    renderReportSourceReview: () => <input aria-label="Source correction" defaultValue="Draft" />,
  };
  const view = render(<ImportReviewPresentation {...props} model={original} />);
  fireEvent.change(screen.getByLabelText('Source correction'), { target: { value: 'Keep text' } });
  const empty = { ...original, reports: [], records: [] };
  view.rerender(<ImportReviewPresentation {...props} model={empty} />);
  expect(screen.getByLabelText('Source correction')).toHaveValue('Keep text');
  view.rerender(
    <ImportReviewPresentation {...props} model={{ ...empty, contextKey: 'other-profile' }} />,
  );
  expect(screen.queryByLabelText('Source correction')).toBeNull();
});

it('defaults a conflicting DOB to a new person and makes Self unavailable in the report pill sidebar', () => {
  const current = personChoiceModel();
  Object.assign(current.reports[0].subject, {
    printedName: 'Cookie Doe',
    label: 'Cookie Doe',
    defaultPerson: 'new',
    selfBirthDateConflict: true,
  });
  const confirm = vi.fn();
  render(<ImportReviewPresentation model={current} actions={{ onConfirmIdentity: confirm }} />);
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  expect(screen.getByRole('combobox', { name: 'Person for this report' })).toHaveValue('new');
  expect(screen.getByRole('option', { name: 'Me (Self)' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'New person name' })).toHaveValue('Cookie Doe');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm person' }));
  expect(confirm).toHaveBeenCalledWith(
    current.reports[0].id,
    {},
    { newPerson: { fullName: 'Cookie Doe' } },
  );
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('opens the same accordion from the blocker and row edit action without a navigation link', async () => {
  const current = sourceModel();
  Object.assign(current.records[0], {
    detailUrl: '/import?group=cookie&record=result',
    saveBlockReason: 'Check value',
  });
  render(
    <ImportReviewPresentation
      model={current}
      renderRecordReview={(_, close) => (
        <section aria-label="Cookie correction">
          <button onClick={close}>Close correction</button>
        </section>
      )}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open review' }));
  await screen.findByRole('region', { name: 'Cookie correction' });
  fireEvent.click(screen.getByRole('button', { name: 'Close correction' }));
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Cookie correction' })).toBeNull(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  await screen.findByRole('region', { name: 'Cookie correction' });
  expect(screen.queryByRole('link', { name: 'Open review' })).toBeNull();
});

for (const scopeReady of [true, false])
  it(`routes an identity blocker to the person sidebar (scope ready: ${scopeReady})`, async () => {
    const current = sourceModel();
    Object.assign(current.reports[0]!.subject, {
      confirmed: false,
      blocking: true,
      scopeReady,
      identityStatus: scopeReady ? 'confirmation_required' : 'conflict',
      identityMessage: scopeReady ? 'Choose the report person.' : 'Conflicting extracted subjects.',
    });
    Object.assign(current.records[0]!, {
      detailUrl: '/import?group=cookie&record=result',
      saveBlockReason: 'Review report identity',
      saveBlockReview: 'identity',
    });
    const renderCorrection = vi.fn(() => <div>Value correction</div>);
    render(<ImportReviewPresentation model={current} renderRecordReview={renderCorrection} />);
    const save = screen.getByRole('button', { name: 'Confirm & save' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Review person' }));
    const dialog = await screen.findByRole('dialog');
    expect(renderCorrection).not.toHaveBeenCalled();
    expect(screen.queryByText('Value correction')).toBeNull();
    if (!scopeReady)
      expect(
        within(dialog).getByText(/Editing a result cannot resolve this issue/),
      ).toBeInTheDocument();
    expect(save).toBeDisabled();
  });

for (const succeeds of [true, false])
  it(`only removes an expanded row after an acknowledged save: ${succeeds}`, async () => {
    const value = sourceModel();
    value.records[0]!.eligible = true;
    const save = controlledPromise<boolean>();
    const props = {
      model: value,
      actions: { onSave: () => save.promise },
      renderRecordReview: () => <input aria-label="Open correction" />,
    };
    const rendered = render(<ImportReviewPresentation {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByLabelText('Open correction');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & save' }));
    expect(screen.getByLabelText('Open correction')).toBeVisible();
    save.resolve(succeeds);
    if (succeeds) {
      await waitFor(() => expect(screen.queryByLabelText('Open correction')).toBeNull());
      rendered.rerender(<ImportReviewPresentation {...props} model={{ ...value }} />);
      expect(screen.queryByText('Fictional eyewear prescription')).toBeNull();
    } else await waitFor(() => expect(screen.getByLabelText('Open correction')).toBeVisible());
  });

for (const newerDraft of [false, true])
  it(`closes acknowledged review after its save settles without losing a newer draft: ${newerDraft}`, async () => {
    const value = sourceModel();
    value.records[0]!.eligible = true;
    const save = controlledPromise<boolean>();
    const onSave = vi.fn(() => save.promise);
    let busy = false;
    let dirty = false;
    const guard = vi.fn(async () => !busy && !dirty);
    const props = () => ({
      model: value,
      actions: { onSave, busy },
      // The parent supplies the current editor guard on each render.
      beforeReviewChange: () => guard(),
      renderRecordReview: () => <input aria-label="Open correction" defaultValue="4.1" />,
    });
    const rendered = render(<ImportReviewPresentation {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByLabelText('Open correction');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    busy = true;
    dirty = newerDraft;
    if (newerDraft)
      fireEvent.change(screen.getByLabelText('Open correction'), { target: { value: '4.2' } });
    rendered.rerender(<ImportReviewPresentation {...props()} />);
    save.resolve(true);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeDisabled(),
    );
    expect(screen.getByLabelText('Open correction')).toBeVisible();
    busy = false;
    rendered.rerender(<ImportReviewPresentation {...props()} />);
    if (newerDraft) {
      await waitFor(() => expect(guard).toHaveBeenCalledTimes(3));
      expect(screen.getByLabelText('Open correction')).toHaveValue('4.2');
      dirty = false;
      rendered.rerender(<ImportReviewPresentation {...props()} />);
    }
    await waitFor(() => expect(screen.queryByLabelText('Open correction')).toBeNull());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Fictional eyewear prescription')).toBeNull();
  });

for (const replaceContext of [false, true])
  it(`does not close a replacement editor with an earlier save guard (new context: ${replaceContext})`, async () => {
    const value = sourceModel();
    value.records[0]!.eligible = true;
    const save = controlledPromise<boolean>();
    const closeCheck = controlledPromise<boolean>();
    let deferClose = false;
    const guard = vi.fn(() => (deferClose ? closeCheck.promise : Promise.resolve(true)));
    const onSave = vi.fn(() => save.promise);
    const props = {
      model: value,
      actions: { onSave },
      beforeReviewChange: guard,
      renderRecordReview: () => <input aria-label="Open correction" />,
    };
    const rendered = render(<ImportReviewPresentation {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByLabelText('Open correction');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    deferClose = true;
    save.resolve(true);
    await waitFor(() => expect(guard).toHaveBeenCalledTimes(3));
    if (replaceContext)
      rendered.rerender(
        <ImportReviewPresentation
          {...props}
          model={sourceModel('another-fictional-profile:active')}
          beforeReviewChange={async () => true}
        />,
      );
    else {
      deferClose = false;
      fireEvent.click(screen.getByRole('button', { name: 'Close review' }));
    }
    await waitFor(() => expect(screen.queryByLabelText('Open correction')).toBeNull());
    if (!replaceContext)
      rendered.rerender(
        <ImportReviewPresentation
          {...props}
          model={{
            ...value,
            records: value.records.map((record) => ({ ...record, status: 'saved' })),
            filters: { ...value.filters!, view: 'saved' },
          }}
        />,
      );
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByLabelText('Open correction');
    closeCheck.resolve(true);
    await closeCheck.promise;
    await waitFor(() => expect(screen.getByLabelText('Open correction')).toBeVisible());
  });

function AttentionMock({
  onCount,
  count = 2,
}: {
  onCount: (count: number) => void;
  count?: number;
}) {
  useEffect(() => onCount(count), [count, onCount]);
  return count ? <button>Add record from this section</button> : null;
}

it('shows source attention on Import even with zero proposals and guards a dirty review before leaving', async () => {
  const guard = vi.fn().mockResolvedValue(true);
  render(
    <ImportReviewPresentation
      model={model()}
      beforeReviewChange={guard}
      renderSourceAttention={(onCount) => <AttentionMock onCount={onCount} />}
    />,
  );
  await userEvent.click(screen.getByRole('tab', { name: /^Needs attention/ }));
  expect(screen.getByRole('button', { name: 'Add record from this section' })).toBeVisible();
  expect(screen.queryByRole('searchbox', { name: 'Search records' })).toBeNull();
  guard.mockResolvedValue(false);
  await userEvent.click(screen.getByRole('tab', { name: /^All/ }));
  expect(screen.getByRole('tab', { name: /^Needs attention/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  guard.mockResolvedValue(true);
  await userEvent.click(screen.getByRole('tab', { name: /^All/ }));
  expect(screen.getByRole('button', { name: 'Add record from this section' })).toBeVisible();
});

it('counts source sections in All and returns to All when attention becomes empty', async () => {
  const value = sourceModel();
  const view = render(
    <ImportReviewPresentation
      model={value}
      renderSourceAttention={(onCount) => <AttentionMock onCount={onCount} count={3} />}
    />,
  );
  await screen.findByRole('tab', { name: 'Needs attention 3' });
  expect(screen.getByRole('tab', { name: 'All' + (value.records.length + 3) })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(screen.getByRole('button', { name: 'Add record from this section' })).toBeVisible();
  await userEvent.click(screen.getByRole('tab', { name: 'Needs attention 3' }));
  view.rerender(
    <ImportReviewPresentation
      model={value}
      renderSourceAttention={(onCount) => <AttentionMock onCount={onCount} count={0} />}
    />,
  );
  await waitFor(() => expect(screen.queryByRole('tab', { name: /Needs attention/ })).toBeNull());
  expect(screen.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
});

it('returns from an emptied Documents tab to All without changing the status view', async () => {
  const value = sourceModel();
  value.records = [
    { ...value.records[0], id: 'cookie-document', kind: 'Documents' },
    ...value.records,
  ];
  const filters = vi.fn();
  const view = render(
    <ImportReviewPresentation model={value} actions={{ onFiltersChange: filters }} />,
  );
  await userEvent.click(screen.getByRole('tab', { name: /^Documents/ }));
  expect(screen.getByRole('tab', { name: /^Documents/ })).toHaveAttribute('aria-selected', 'true');
  view.rerender(
    <ImportReviewPresentation
      model={{
        ...value,
        records: value.records.filter((record) => record.id !== 'cookie-document'),
        filters: { ...value.filters!, kind: 'Documents' },
      }}
      actions={{ onFiltersChange: filters }}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true'),
  );
  expect(screen.queryByRole('tab', { name: /^Documents/ })).toBeNull();
  expect(filters).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: 'All', view: 'review' }),
  );
});

it.each(['Documents', 'Test results'] as const)(
  'keeps %s selected while its server-filtered feed loads, then returns to All only when settled empty',
  async (kind) => {
    const initial = sourceModel();
    const target = { ...initial.records[0], id: 'target', kind };
    const value = {
      ...initial,
      records: [...initial.records, target],
      kindCounts: { All: 2, Vision: 1, [kind]: 1 },
    };
    const filters = vi.fn();
    const view = render(
      <ImportReviewPresentation model={value} actions={{ onFiltersChange: filters }} />,
    );
    await userEvent.click(screen.getByRole('tab', { name: new RegExp('^' + kind) }));
    const requested = { ...value.filters!, kind };
    const loading = {
      ...value,
      contextKey: 'fictional-profile:requested-' + kind,
      filters: requested,
      loading: true,
      records: [],
      kindCounts: undefined,
    };
    view.rerender(
      <ImportReviewPresentation model={loading} actions={{ onFiltersChange: filters }} />,
    );
    expect(screen.getByText('Loading records…')).toBeVisible();
    expect(screen.getByRole('tab', { name: new RegExp('^' + kind) })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(filters).toHaveBeenCalledTimes(1);
    const loaded = { ...loading, loading: false, records: [target], kindCounts: value.kindCounts };
    view.rerender(
      <ImportReviewPresentation model={loaded} actions={{ onFiltersChange: filters }} />,
    );
    expect(screen.getByRole('tab', { name: new RegExp('^' + kind) })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(filters).toHaveBeenCalledTimes(1);
    view.rerender(
      <ImportReviewPresentation
        model={{ ...loaded, records: [], kindCounts: { All: 1, Vision: 1, [kind]: 0 } }}
        actions={{ onFiltersChange: filters }}
      />,
    );
    await waitFor(() => expect(filters).toHaveBeenLastCalledWith({ ...requested, kind: 'All' }));
  },
);

it.each([false, true])(
  'marks a name-only match for review without removing its automatic assignment (family=%s)',
  (family) => {
    const current = personChoiceModel();
    const subject = current.reports[0].subject;
    subject.confirmed = true;
    subject.identityStatus = 'evidenced_match';
    subject.nameOnlyMatch = true;
    subject.offeredSelfFields = {};
    if (family) subject.assignedPerson = subject.people![0];
    const onConfirmIdentity = vi.fn();
    render(<ImportReviewPresentation model={current} actions={{ onConfirmIdentity }} />);
    const control = screen.getByRole('button', { name: /Review person for/ });
    expect(control).toHaveTextContent(family ? '(?)' : '(you?)');
    fireEvent.click(control);
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: family ? 'Confirm person' : 'Save changes' }),
    );
    expect(onConfirmIdentity).toHaveBeenCalledOnce();
  },
);

it('shows an unverified model birth-date mismatch while the matched report remains saveable', () => {
  const current = personChoiceModel();
  current.reports[0].subject = {
    ...current.reports[0].subject,
    confirmed: true,
    identityStatus: 'evidenced_match',
    nameOnlyMatch: false,
    offeredSelfFields: {},
    warnings: [
      {
        kind: 'model_birth_date_mismatch',
        modelBirthDate: '1988-04-12',
        savedBirthDate: '1989-04-12',
        personName: 'Jordan Example',
      },
    ],
  };
  current.records[0].eligible = true;
  render(<ImportReviewPresentation model={current} />);
  const warning = screen.getByRole('status');
  expect(warning).toHaveTextContent('1988-04-12');
  expect(warning).toHaveTextContent('Jordan Example');
  expect(warning).toHaveTextContent('1989-04-12');
  expect(warning).toHaveTextContent('has not been verified in the original');
  expect(screen.getByRole('button', { name: /^Confirm & save$/ })).toBeEnabled();
  fireEvent.click(within(warning).getByRole('button', { name: 'Change person' }));
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(within(screen.getByRole('dialog')).getByText(/1988-04-12/)).toBeVisible();
});

it('prefills a suggested birth date and sends the human correction with the report confirmation', () => {
  const current = personChoiceModel();
  current.reports[0].subject.birthDateReview = {
    choices: ['1985-03-04', '1985-04-03'],
    suggested: '1985-03-04',
  };
  current.reports[0].subject.offeredSelfFields = {};
  const onConfirmIdentity = vi.fn();
  render(<ImportReviewPresentation model={current} actions={{ onConfirmIdentity }} />);
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  const date = screen.getByLabelText('Reviewed report birth date');
  expect(date).toHaveValue('1985-03-04');
  fireEvent.change(date, { target: { value: '1985-04-03' } });
  fireEvent.click(screen.getByRole('button', { name: 'This is me' }));
  expect(onConfirmIdentity).toHaveBeenCalledWith(
    'fictional-source-scope',
    {},
    undefined,
    undefined,
    { birthDate: '1985-04-03' },
  );
});

it('prefills a year-only suggestion without inventing a month or day', () => {
  const current = personChoiceModel();
  current.reports[0].subject.birthDateReview = {
    choices: ['1988'],
    suggested: '1988',
  };
  current.reports[0].subject.offeredSelfFields = {};
  const onConfirmIdentity = vi.fn();
  render(<ImportReviewPresentation model={current} actions={{ onConfirmIdentity }} />);
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  const year = screen.getByLabelText('Reviewed report birth year');
  expect(year).toHaveValue('1988');
  expect(year).toHaveAttribute('maxLength', '4');
  fireEvent.click(screen.getByRole('button', { name: 'This is me' }));
  expect(onConfirmIdentity).toHaveBeenCalledWith(
    'fictional-source-scope',
    {},
    undefined,
    undefined,
    { birthDate: '1988' },
  );
});

it('disambiguates duplicate people and disables an existing person whose DOB differs', () => {
  const current = personChoiceModel();
  current.reports[0].subject.birthDate = '1986-02-14';
  current.reports[0].subject.people = [
    {
      noteId: 'person-note:one',
      personId: 'one',
      fullName: 'Rowan Meadow',
      version: 1,
      birthDate: '1986-02-14',
      relationship: 'Sibling',
    },
    {
      noteId: 'person-note:two',
      personId: 'two',
      fullName: 'Rowan Meadow',
      version: 1,
      birthDate: '1950-01-05',
      relationship: 'Parent',
    },
  ];
  render(<ImportReviewPresentation model={current} />);
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  expect(screen.getByRole('option', { name: /Rowan Meadow.*1986-02-14.*Sibling/ })).toBeEnabled();
  expect(screen.getByRole('option', { name: /Rowan Meadow.*1950-01-05.*Parent/ })).toBeDisabled();
});

it('clears a failed approval so the current record can be approved again', async () => {
  const original = sourceModel();
  original.records = original.records.flatMap((row) => [
    { ...row, id: 'saved-row', eligible: true },
    { ...row, id: 'retained-row', label: 'Retained fictional record', eligible: true },
  ]);
  const save = vi
    .fn()
    .mockResolvedValue({ savedIds: ['saved-row'], rejectedIds: ['retained-row'] });
  render(<ImportReviewPresentation model={original} actions={{ onSave: save }} />);
  await userEvent.click(screen.getByRole('checkbox', { name: /Select all shown/ }));
  await userEvent.click(screen.getByRole('button', { name: /Save 2 records/ }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(['saved-row', 'retained-row']));
  expect(screen.getByRole('checkbox', { name: /Retained fictional record/ })).not.toBeChecked();
  expect(screen.getByText('Review again, then approve.')).toBeVisible();
});

it('keeps selection through an unrelated block refresh but revokes it when its exact token changes', async () => {
  const current = sourceModel();
  current.records = [
    {
      ...current.records[0]!,
      eligible: true,
      approval: {
        intakeId: 'fictional-intake',
        proposalId: null,
        intakeVersion: 1,
        reviewToken: 'block-1',
        selections: [
          {
            recordId: 'fictional-result',
            candidateId: 'fictional-candidate',
            candidateVersionId: 'fictional-version',
            selectionReviewToken: 'exact-1',
            mapping: { kind: 'observation' },
          },
        ],
      },
    },
  ];
  const view = render(<ImportReviewPresentation model={current} actions={{ onSave: vi.fn() }} />);
  await userEvent.click(
    screen.getByRole('checkbox', { name: /Select Fictional eyewear prescription/ }),
  );
  const unrelated = structuredClone(current);
  unrelated.records[0]!.approval!.reviewToken = 'block-2';
  unrelated.records[0]!.approval!.intakeVersion = 2;
  view.rerender(<ImportReviewPresentation model={unrelated} actions={{ onSave: vi.fn() }} />);
  expect(
    screen.getByRole('checkbox', { name: /Select Fictional eyewear prescription/ }),
  ).toBeChecked();
  const changed = structuredClone(unrelated);
  changed.records[0]!.approval!.selections[0]!.selectionReviewToken = 'exact-2';
  view.rerender(<ImportReviewPresentation model={changed} actions={{ onSave: vi.fn() }} />);
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: /Select Fictional eyewear prescription/ }),
    ).not.toBeChecked(),
  );
  expect(screen.getByText('Review again, then approve.')).toBeVisible();
  expect(screen.getByText(/1 selected item changed while you were reviewing/)).toBeVisible();
});

it('selects newly paginated rows only after they are shown and scopes approval to the current filter', async () => {
  const first = sourceModel();
  first.records = [{ ...first.records[0]!, id: 'fictional-page-one', eligible: true }];
  const save = vi.fn().mockResolvedValue({ savedIds: ['fictional-page-one'] });
  const view = render(<ImportReviewPresentation model={first} actions={{ onSave: save }} />);
  await userEvent.click(screen.getByRole('checkbox', { name: /Select all shown/ }));
  expect(screen.getByRole('checkbox', { name: /fictional eyewear prescription/i })).toBeChecked();
  const second = structuredClone(first);
  second.records.push({
    ...first.records[0]!,
    id: 'fictional-page-two',
    label: 'Fictional second result',
  });
  view.rerender(<ImportReviewPresentation model={second} actions={{ onSave: save }} />);
  expect(screen.getByRole('checkbox', { name: /Fictional second result/ })).not.toBeChecked();
  await userEvent.click(screen.getByRole('checkbox', { name: '1 selected' }));
  expect(screen.getByRole('checkbox', { name: /Fictional second result/ })).toBeChecked();
  const filtered = {
    ...second,
    contextKey: 'fictional-profile:filtered',
    filters: { ...second.filters!, query: 'second' },
    records: [second.records[1]!],
  };
  view.rerender(<ImportReviewPresentation model={filtered} actions={{ onSave: save }} />);
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /Fictional second result/ })).not.toBeChecked(),
  );
});
