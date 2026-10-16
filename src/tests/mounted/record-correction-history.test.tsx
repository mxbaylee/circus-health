import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  RecordCorrectionBadges,
  RecordCorrectionHistory,
} from '../../app/components/RecordCorrectionHistory';
import { recordCorrectionStages } from '../../app/data/record-corrections';

it('keeps import and later corrections distinct with both reasons and literal before/after values', () => {
  const extra = {
    import: {
      manuallyEdited: true,
      corrections: [
        {
          at: '2032-03-04T12:00:00Z',
          reason: 'Read from Cookie Doe original',
          before: { valueText: '' },
          after: { valueText: '4.1' },
        },
      ],
    },
    recordCorrections: [
      {
        at: '2032-03-05T12:00:00Z',
        reason: 'Rechecked the original value',
        before: { valueText: '4.1', unit: 'mmol/L' },
        after: { valueText: '4.2', unit: 'mmol/L' },
      },
    ],
  };
  render(
    <>
      <RecordCorrectionBadges extra={extra} />
      <RecordCorrectionHistory extra={extra} open />
    </>,
  );
  expect(screen.getByText('Corrections')).toBeVisible();
  expect(screen.queryByText('Modified during import')).toBeNull();
  expect(screen.queryByText('Corrected after import')).toBeNull();
  const entries = screen.getAllByRole('listitem');
  expect(entries).toHaveLength(2);
  expect(entries[0]).toHaveTextContent('Not recorded → 4.1');
  expect(entries[0]).toHaveTextContent('Read from Cookie Doe original');
  expect(entries[1]).toHaveTextContent('4.1 → 4.2');
  expect(entries[1]).toHaveTextContent('Rechecked the original value');
  expect(within(entries[1]!).queryByText('Unit')).toBeNull();
});

it('shows a correction made only after import without inventing an import edit', () => {
  const extra = {
    import: { manuallyEdited: false },
    recordCorrections: [
      {
        before: { valueText: '13.6' },
        after: { valueText: '13.7' },
        reason: 'Checked the printed hemoglobin',
      },
    ],
  };
  render(
    <>
      <RecordCorrectionBadges extra={extra} />
      <RecordCorrectionHistory extra={extra} open />
    </>,
  );
  expect(screen.queryByText('Modified during import')).toBeNull();
  expect(screen.getByText('Corrected after import')).toBeVisible();
  expect(screen.getByRole('listitem')).toHaveTextContent('13.6 → 13.7');
});

it('tolerates legacy metadata without fabricating values or mislabeling later exceptions', () => {
  expect(
    recordCorrectionStages({ import: { recordException: { set: { valueText: '4.1' } } } }).imported,
  ).toBe(true);
  expect(
    recordCorrectionStages({
      import: { recordException: { set: { valueText: '4.2' } } },
      recordCorrections: [{ before: { valueText: '4.1' }, after: { valueText: '4.2' } }],
    }),
  ).toEqual({ imported: false, later: true });
  const view = render(<RecordCorrectionHistory extra={{ import: { manuallyEdited: true } }} />);
  expect(view.container).toBeEmptyDOMElement();
});

it('treats referenced corrections as real import edits without claiming inline arrays are complete', () => {
  const extra = {
    import: { correctionHistorySource: { format: 'health-accepted-contribution-corrections-v1' } },
  };
  expect(recordCorrectionStages(extra)).toEqual({ imported: true, later: false });
  render(
    <>
      <RecordCorrectionBadges extra={extra} />
      <RecordCorrectionHistory extra={extra} open />
    </>,
  );
  expect(screen.getByText('Modified during import')).toBeVisible();
  expect(screen.getByText('Correction history')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent(
    'Open this record to load its complete import correction history',
  );
});
