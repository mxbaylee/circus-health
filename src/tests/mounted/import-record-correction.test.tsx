import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Intake, IntakeReviewRecord } from '../../shared/intake';
import { ImportRecordCorrection } from '../../app/features/import/ImportRecordCorrection';
import { intakeEvidencePage } from '../../app/features/intake/ReviewWorkspace';
import { selectProfile } from '../../app/data/profile';
vi.mock('../../app/components/SourceDialog', () => ({
  SourcePreview: ({ initialPage, compact }: { initialPage?: number; compact?: boolean }) => (
    <div>
      Original page {initialPage} {compact && 'compact'}
    </div>
  ),
}));
const intake = {
  id: 'cookie-source',
  contentUrl: '/api/sources/cookie-source/content',
  mimeType: 'application/pdf',
} as Intake;
const record = {
  id: 'cookie-potassium',
  title: 'Potassium',
  kind: 'observation',
  evidence: [
    {
      label: 'Original',
      locator: 'original page 2 supplemental table Potassium result',
      contentUrl: intake.contentUrl,
    },
  ],
  issues: [],
} as unknown as IntakeReviewRecord;
it('opens the indicated page and only submits a valid explicit update; close does not save', async () => {
  const onUpdate = vi.fn().mockResolvedValue(true),
    onClose = vi.fn();
  render(
    <ImportRecordCorrection
      intake={intake}
      record={record}
      mapping={{ valueText: '', unit: 'mmol/L' }}
      fields={[{ key: 'valueText', label: 'Result' }]}
      disabled={false}
      onUpdate={onUpdate}
      onClose={onClose}
      onDirtyChange={() => {}}
    />,
  );
  expect(screen.getByText('Original page 2 compact')).toBeVisible();
  const update = screen.getByRole('button', { name: 'Update' });
  expect(update).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Result' }), { target: { value: '4.' } });
  expect(update).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Result' }), { target: { value: '4.2' } });
  expect(onUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close review' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onUpdate).not.toHaveBeenCalled();
  fireEvent.click(update);
  await waitFor(() =>
    expect(onUpdate).toHaveBeenCalledWith({ valueText: '4.2' }, 'Correction of imported data'),
  );
});
it('keeps the correction visible after an unsuccessful update', async () => {
  const onUpdate = vi.fn().mockResolvedValue(false),
    onClose = vi.fn();
  render(
    <ImportRecordCorrection
      intake={intake}
      record={record}
      mapping={{ valueText: '1' }}
      fields={[{ key: 'valueText', label: 'Result' }]}
      disabled={false}
      onUpdate={onUpdate}
      onClose={onClose}
      onDirtyChange={() => {}}
    />,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Result' }), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Result' })).toHaveValue('2');
});
it('uses only an unambiguous same-original page hint, including profile-qualified URLs', () => {
  selectProfile({ id: 'cookie-profile', name: 'Cookie Doe', placebo: true });
  const scoped = {
    ...intake,
    contentUrl: '/api/profiles/cookie-profile/sources/cookie-source/content',
  };
  expect(intakeEvidencePage(scoped, record.evidence)).toBe(2);
  expect(
    intakeEvidencePage(intake, [{ ...record.evidence[0], locator: 'page 2 and page 3' }]),
  ).toBeUndefined();
  expect(
    intakeEvidencePage(intake, [
      { ...record.evidence[0], contentUrl: '/api/sources/other/content' },
    ]),
  ).toBeUndefined();
  expect(
    intakeEvidencePage(scoped, [
      {
        ...record.evidence[0],
        contentUrl: '/api/profiles/another-profile/sources/cookie-source/content',
      },
    ]),
  ).toBeUndefined();
});

const uncertainFields = [
  { key: 'testLabel' as const, label: 'Test name', value: 'Potassium' },
  { key: 'valueText' as const, label: 'Result', value: '4.2' },
  { key: 'unit' as const, label: 'Unit', value: 'mmol/L' },
  { key: 'date' as const, label: 'Date', value: '2026-09-21' },
];
for (let mask = 1; mask < 16; mask++) {
  const fields = uncertainFields.filter((_, index) => mask & (1 << index));
  it(`allows a partial update without submitting blank uncertainties: ${fields.map((field) => field.label).join(' + ')}`, async () => {
    const onUpdate = vi.fn().mockResolvedValue(true);
    render(
      <ImportRecordCorrection
        intake={intake}
        record={record}
        mapping={{ testLabel: '', valueText: '', unit: '' }}
        fields={fields}
        disabled={false}
        onUpdate={onUpdate}
        onClose={() => {}}
        onDirtyChange={() => {}}
      />,
    );
    for (const field of fields)
      expect(screen.getByLabelText(field.label, { exact: true })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
    const first = fields[0];
    fireEvent.change(screen.getByLabelText(first.label, { exact: true }), {
      target: { value: first.value },
    });
    expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        { [first.key]: first.value },
        'Correction of imported data',
      ),
    );
  });
}

it('does not confirm untouched suggested values when another uncertain field is corrected', async () => {
  const onUpdate = vi.fn().mockResolvedValue(true);
  render(
    <ImportRecordCorrection
      intake={intake}
      record={record}
      mapping={{ testLabel: 'Suggested name', valueText: '4.2', unit: 'mmol/L' }}
      fields={uncertainFields}
      disabled={false}
      onUpdate={onUpdate}
      onClose={() => {}}
      onDirtyChange={() => {}}
    />,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Test name' }), {
    target: { value: 'Potassium' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await waitFor(() =>
    expect(onUpdate).toHaveBeenCalledWith(
      { testLabel: 'Potassium' },
      'Correction of imported data',
    ),
  );
});

it('uses a date picker, requires a correction reason, and keeps untouched result uncertainty unresolved', async () => {
  const onUpdate = vi.fn().mockResolvedValue(true);
  render(
    <ImportRecordCorrection
      intake={intake}
      record={{
        ...record,
        issues: [
          {
            id: 'date',
            kind: 'date',
            field: 'date',
            status: 'unresolved',
            blocking: false,
            prompt: 'Date unknown',
            locator: '',
            questionId: null,
          },
          {
            id: 'result',
            kind: 'uncertain_reading',
            field: 'valueText',
            status: 'unresolved',
            blocking: true,
            prompt: 'Verify result',
            locator: '',
            questionId: null,
          },
        ],
      }}
      mapping={{ testLabel: 'Potassium', date: '', valueText: '', unit: 'mmol/L' }}
      fields={uncertainFields}
      disabled={false}
      onUpdate={onUpdate}
      onClose={() => {}}
      onDirtyChange={() => {}}
    />,
  );
  const date = screen.getByLabelText('Date', { exact: true });
  expect(date).toHaveAttribute('type', 'date');
  fireEvent.change(date, { target: { value: 'not-a-date' } });
  expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
  fireEvent.change(date, { target: { value: '2026-09-21' } });
  const reason = screen.getByRole('textbox', { name: 'Correction reason' });
  expect(reason).toHaveValue('Correction of imported data');
  fireEvent.change(reason, { target: { value: '   ' } });
  expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
  fireEvent.change(reason, { target: { value: 'Date verified against the report heading' } });
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await waitFor(() =>
    expect(onUpdate).toHaveBeenCalledWith(
      { date: '2026-09-21' },
      'Date verified against the report heading',
    ),
  );
});

it('verifies an unchanged reading explicitly without confirming another field or inventing a correction reason', async () => {
  const onUpdate = vi.fn().mockResolvedValue(true);
  render(
    <ImportRecordCorrection
      intake={intake}
      record={{
        ...record,
        issues: ['valueText', 'unit'].map((field) => ({
          id: field,
          field,
          kind: 'uncertain_reading' as const,
          status: 'unresolved' as const,
          blocking: true,
          prompt: 'Verify reading',
          locator: '',
          questionId: null,
        })),
      }}
      mapping={{ valueText: '4.1', unit: 'mmol/L' }}
      fields={[
        { key: 'valueText', label: 'Result' },
        { key: 'unit', label: 'Unit' },
      ]}
      disabled={false}
      onUpdate={onUpdate}
      onClose={() => {}}
      onDirtyChange={() => {}}
    />,
  );
  expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Verify result' }));
  expect(screen.queryByRole('textbox', { name: 'Correction reason' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Verify unit' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ valueText: '4.1' }));
});

it('a date warning cannot hide an unclassified record, and type correction reveals all result fields', async () => {
  const { recordCorrectionFields } =
    await import('../../app/features/import/import-correction-fields');
  const onUpdate = vi.fn().mockResolvedValue(true);
  const unknown = {
    ...record,
    kind: 'unsupported' as const,
    issues: [
      {
        id: 'date',
        kind: 'date' as const,
        field: 'date',
        status: 'unresolved' as const,
        blocking: false,
        prompt: 'Unknown date',
        locator: '',
        questionId: null,
      },
    ],
  };
  const fields = recordCorrectionFields('unsupported', unknown.issues);
  expect(fields.map((field) => field.key)).toEqual(['documentTitle', 'text', 'date']);
  render(
    <ImportRecordCorrection
      intake={intake}
      record={unknown}
      mapping={{
        kind: 'unsupported',
        documentTitle: 'Potassium',
        text: 'Potassium result unclear',
        date: '',
      }}
      fields={fields}
      disabled={false}
      onUpdate={onUpdate}
      onClose={() => {}}
      onDirtyChange={() => {}}
    />,
  );
  expect(screen.getByLabelText('Document text', { exact: true })).toBeVisible();
  fireEvent.change(screen.getByLabelText('Record type', { exact: true }), {
    target: { value: 'observation' },
  });
  for (const label of ['Test name', 'Result', 'Unit', 'Date'])
    expect(screen.getByLabelText(label, { exact: true })).toBeVisible();
  fireEvent.change(screen.getByLabelText('Test name', { exact: true }), {
    target: { value: 'Potassium' },
  });
  fireEvent.change(screen.getByLabelText('Result', { exact: true }), { target: { value: '4.1' } });
  fireEvent.change(screen.getByLabelText('Unit', { exact: true }), { target: { value: 'mmol/L' } });
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await waitFor(() =>
    expect(onUpdate).toHaveBeenCalledWith(
      { kind: 'observation', testLabel: 'Potassium', valueText: '4.1', unit: 'mmol/L' },
      'Correction of imported data',
    ),
  );
});

it('editor diagnostics retain field/type metadata without record contents or prompts', async () => {
  const { recordReviewEditorDiagnostic, reviewEditorDiagnostics, clearBrowserImportDiagnostics } =
    await import('../../app/data/import-diagnostics');
  clearBrowserImportDiagnostics();
  recordReviewEditorDiagnostic(
    {
      ...record,
      title: 'PRIVATE TITLE',
      issues: [
        {
          id: 'private-id',
          kind: 'date',
          field: 'PRIVATE FIELD',
          blocking: false,
          status: 'unresolved',
          prompt: 'PRIVATE PROMPT',
          locator: 'PRIVATE LOCATOR',
          questionId: null,
        },
      ],
    },
    { kind: 'observation', testLabel: 'PRIVATE TEST', valueText: 'PRIVATE VALUE' },
    ['date', 'PRIVATE FIELD'],
  );
  const snapshot = reviewEditorDiagnostics();
  expect(snapshot[0]).toMatchObject({
    mappingKind: 'observation',
    fields: ['date'],
    missingResult: false,
  });
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
});
