import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DraftSummary } from '../../app/features/import/ImportDetailReview';
it('distinguishes a referenced decision collection from an empty saved history in conflict comparisons', () => {
  render(
    <DraftSummary
      draft={{
        decision: {
          recordId: 'fictional-record',
          action: 'accept',
          mapping: { kind: 'document', documentTitle: 'Fictional report' },
        },
        disposition: 'pending',
        answers: {},
        resolutions: [],
        resolutionsReference: { format: 'health-intake-review-draft-resolutions-v1', count: 4000 },
        history: {
          format: 'health-intake-review-draft-history-v1',
          intakeId: 'fictional-intake',
          sourceHash: 'fictional-source',
          snapshotId: 'retained-history',
          resolutions: 9000,
          corrections: 4,
        },
      }}
    />,
  );
  expect(screen.getByText(/4,000 saved question decisions remain referenced/)).toBeVisible();
  expect(screen.getByText(/9,000 saved question decisions/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'View review history' })).toBeEnabled();
  expect(screen.queryByText(/Issue resolutions: None/)).not.toBeInTheDocument();
});
