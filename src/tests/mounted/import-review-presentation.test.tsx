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
  const dropzone = screen.getByText('Drop reports here').closest('label');
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
  [0, '0 source entries found'],
  [1, '1 source entry found'],
  [2, '2 source entries found'],
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
  expect(screen.getByText(`${expected} · 1 source window read`)).toBeVisible();
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
  expect(screen.getByText('1 source entry found · 1 source window read')).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Vision1' })).toBeVisible();
  expect(screen.getByRole('tab', { name: 'People1' })).toBeVisible();
  expect(screen.queryByText(/2 source entries found/)).toBeNull();
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
  expect(screen.getByText('2 of 7 source sections accounted for')).toBeVisible();
  expect(screen.getByText('30 source entries found · 3 source windows read')).toBeVisible();
  expect(screen.getByText(/Active reading 2m 0s/)).toBeVisible();
  expect(screen.queryByRole('button', { name: /Reading details/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Stop reading' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Resume reading' }));
  expect(onResumeReading).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Stop reading' })).toBeNull();
});

it('shows a failed reading action and leaves its control retryable', async () => {
  const onResumeReading = vi.fn().mockRejectedValue(new Error('Connection lost. Try again.'));
  render(<ImportReviewPresentation model={model()} actions={{ onResumeReading }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Resume reading' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost. Try again.');
  expect(screen.getByRole('button', { name: 'Resume reading' })).not.toBeDisabled();
});

it('confirms identity and both selected blank Self fields in one action', () => {
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
  fireEvent.click(screen.getByRole('button', { name: 'Review blank Self details' }));
  expect(screen.getByText('Full name:')).toBeVisible();
  expect(screen.getByText('Rowan Ellis')).toBeVisible();
  expect(screen.getByText('Date of birth:')).toBeVisible();
  expect(screen.getByText('1988-04-12')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'This is me' }));
  expect(onConfirmIdentity).toHaveBeenCalledWith('fictional-report', {
    fullName: 'Rowan Ellis',
    birthDate: '1988-04-12',
  });
});

it('preserves declined Self fields while selecting newly offered fields in an open identity sheet', async () => {
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
          offeredSelfFields: { fullName: 'Rowan Ellis' },
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
  fireEvent.click(screen.getByRole('button', { name: 'Review blank Self details' }));
  const fullName = screen.getByRole('checkbox', { name: /Full name/ });
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

  expect(screen.getByRole('checkbox', { name: /Full name/ })).not.toBeChecked();
  expect(await screen.findByRole('checkbox', { name: /Date of birth/ })).toBeChecked();
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
  expect(screen.getByRole('checkbox', { name: /Full name/ })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Date of birth/ })).toBeChecked();

  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review blank Self details' }));
  expect(screen.getByRole('checkbox', { name: /Full name/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Date of birth/ })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: /Full name/ }));
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
  fireEvent.click(await screen.findByRole('button', { name: 'Review optional Self details' }));
  expect(screen.getByRole('dialog')).toHaveTextContent(
    'This report is already allowed by retained identity evidence.',
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
  expect(screen.getByText('Identity is not printed clearly in this report.')).toBeVisible();
  expect(screen.getByText('This report conflicts with Self.')).toBeVisible();
  expect(screen.getByText(/Self has 1988-04-12; report evidence has 1991-09-03/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'This is me' })).toBeNull();
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
              offeredSelfFields: { fullName: 'Rowan Ellis' },
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
  fireEvent.click(screen.getByRole('button', { name: 'Review optional Self details' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add selected details to Self' }));
  expect(onConfirmIdentity).toHaveBeenCalledWith('matched', { fullName: 'Rowan Ellis' });
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
  expect(screen.getByRole('link', { name: /Open review/ })).toHaveAttribute(
    'href',
    '#/import?group=fictional-blocked-report&intake=fictional-intake',
  );
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
  fireEvent.click(screen.getByRole('button', { name: 'Review identity' }));
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
  expect(screen.getByText(/Suggestions are not applied until you choose Use source/)).toBeVisible();
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

it('distinguishes a source suggestion from a reviewed label before applying it', async () => {
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

  expect(screen.getByText(/Suggested source—not applied yet/)).toBeVisible();
  expect(screen.getByText(/Use it for this report and eligible results you save/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Review Fictional Imaging Center' }));
  expect(screen.getByRole('dialog')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Use source' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(
    screen.getByText('Source changed to “Fictional Imaging Center”. Nothing has been saved yet.'),
  ).toBeVisible();
  expect(screen.queryByText(/Suggested source—not applied yet/)).toBeNull();
});

it('shows the exact source scope and submits it through one confirmation while the action is pending', async () => {
  const review = sourceReview('active');
  const action = controlledPromise<void | string | null>();
  const onReviewSource = vi.fn(async () => review);
  const onUseSource = vi.fn(() => action.promise);
  render(
    <ImportReviewPresentation model={sourceModel()} actions={{ onReviewSource, onUseSource }} />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Review Fictional Imaging Center' }));
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

  fireEvent.click(screen.getByRole('button', { name: 'Review Fictional Imaging Center' }));
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

  fireEvent.click(screen.getByRole('button', { name: 'Review Fictional Imaging Center' }));
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

  fireEvent.click(screen.getByRole('button', { name: 'Review Fictional Imaging Center' }));
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

  fireEvent.click(screen.getByRole('button', { name: 'Review Fictional Imaging Center' }));
  expect(screen.getByText('Loading affected records…')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  first.resolve(sourceReview('active'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  fireEvent.click(screen.getByRole('button', { name: 'Review Fictional Imaging Center' }));
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
  expect(screen.queryByRole('button', { name: /Review Fictional Imaging Center/ })).toBeNull();
});

it('shows recent observed page timing and resets it on a new model context without an ETA', () => {
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
  expect(
    screen.getByText(/Recent interval between page reads 12s on average across 2 intervals/),
  ).toBeVisible();
  expect(
    screen.getByText(/Includes repeat reads, model and tool work; not a completion estimate/),
  ).toBeVisible();
  expect(screen.getByText('Last page prepared in 3s.')).toBeVisible();
  expect(screen.queryByRole('progressbar')).toBeNull();
  active.activity!.progress!.pageTiming = {
    turn: 2,
    recentIntervalMs: null,
    intervalSamples: 0,
    lastReadMs: null,
    lastCompletedAt: null,
  };
  view.rerender(<ImportReviewPresentation model={{ ...active }} />);
  expect(screen.getByText(/Model context restarted · Pass 2/)).toBeVisible();
  expect(screen.queryByText(/Recent interval between page reads/)).toBeNull();
  expect(screen.queryByText(/Last page prepared/)).toBeNull();
});
