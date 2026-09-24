import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { ClinicalReviewPreview } from '../../app/features/assistant/ClinicalReviewPreview';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
const profile = {
  id: 'fictional-review',
  name: 'Fictional Person',
  placebo: true,
  nameVersion: 1,
  version: 1,
};
const base = {
  id: 'proposal',
  title: 'Clinical review',
  summary: 'Evidence review',
  status: 'pending' as const,
  changes: {},
};
beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});
it('renders only changed individual fields beside the scoped original evidence', () => {
  render(
    <ClinicalReviewPreview
      proposal={{
        ...base,
        kind: 'clinical_correction',
        preview: {
          before: { doseText: '5 mg', status: 'active' },
          after: { doseText: '10 mg', status: 'active' },
          evidence: [
            {
              acquiringSource: 'Acquiring clinic',
              locator: 'page 2',
              contentUrl: '/api/sources/original/content',
            },
          ],
        },
      }}
    />,
  );
  const preview = screen.getByRole('region', { name: 'Individual correction preview' });
  expect(within(preview).getByText(/5 mg → 10 mg/)).toBeVisible();
  expect(within(preview).queryByText('Status')).not.toBeInTheDocument();
  expect(within(preview).getByRole('link', { name: 'Open original' })).toHaveAttribute(
    'href',
    '/api/profiles/fictional-review/sources/original/content',
  );
});
it('shows conflicting values from both originals without selecting a clinical winner', () => {
  const side = (title: string, valueText: string) => ({
    title,
    date: '2025-01',
    mapping: { valueText, unit: 'mg/L' },
    evidence: [
      {
        label: 'Original ' + title,
        locator: 'section 1',
        contentUrl: '/api/sources/' + title + '/content',
      },
    ],
  });
  render(
    <ClinicalReviewPreview
      proposal={{
        ...base,
        kind: 'duplicate_decision',
        preview: {
          left: side('First', '1.00'),
          right: side('Second', '2.00'),
          outcome: 'same_event',
          reason: 'The explicit accession is shared.',
        },
      }}
    />,
  );
  const preview = screen.getByRole('region', { name: 'Paired evidence preview' });
  expect(within(preview).getByText('1.00')).toBeVisible();
  expect(within(preview).getByText('2.00')).toBeVisible();
  expect(within(preview).getAllByRole('link', { name: 'Open original' })).toHaveLength(2);
  expect(
    within(preview).getByText(/does not choose between conflicting clinical values/),
  ).toBeVisible();
});
it('shows selected draft changes, unresolved notes and source links without claiming verification', () => {
  render(
    <ClinicalReviewPreview
      proposal={{
        ...base,
        kind: 'intake_draft_repair',
        preview: {
          format: 'intake-draft-repair-preview-v2',
          scopeToken: 'fictional-scope',
          rows: [
            {
              recordId: 'fictional-row',
              title: 'Fictional result',
              field: 'date',
              before: '2025-01',
              after: '2025-02',
              evidence: [
                {
                  label: 'Retained report',
                  locator: 'page 3 row 2',
                  contentUrl: '/api/sources/fictional/content',
                },
              ],
              originalReads: [],
            },
          ],
          unresolvedNotes: ['A second printed date remains ambiguous.'],
          sourceUnchanged: true,
          acceptanceUnchanged: true,
        },
      }}
    />,
  );
  const preview = screen.getByRole('region', {
    name: 'Selected import draft correction preview',
  });
  expect(within(preview).getByText(/2025-01 → 2025-02/)).toBeVisible();
  expect(within(preview).getByText(/second printed date remains ambiguous/)).toBeVisible();
  expect(within(preview).getByText(/do not verify the proposed interpretation/)).toBeVisible();
  expect(within(preview).getByRole('link', { name: 'Open original' })).toHaveAttribute(
    'href',
    '/api/profiles/fictional-review/sources/fictional/content',
  );
});
it('explains the accepted procedure to lab change separately from future rules', () => {
  render(
    <ClinicalReviewPreview
      proposal={{
        ...base,
        kind: 'clinical_correction',
        preview: {
          reclassification: true,
          before: { kind: 'procedure', procedureLabel: 'Creatinine', valueText: '1.20' },
          after: {
            kind: 'observation',
            procedureLabel: 'Creatinine',
            testLabel: 'Creatinine',
            valueText: '1.20',
          },
          evidence: [
            {
              acquiringSource: 'Fictional clinic',
              locator: 'row 1',
              contentUrl: '/api/sources/creatinine/content',
            },
          ],
        },
      }}
    />,
  );
  const preview = screen.getByRole('region', { name: 'Individual correction preview' });
  expect(within(preview).getByText(/procedure → observation/)).toBeVisible();
  expect(
    within(preview).getByText(/earlier classification remains in searchable history/),
  ).toBeVisible();
  expect(within(preview).getByText(/No future-import rule is created/)).toBeVisible();
  expect(within(preview).getByRole('link', { name: 'Open original' })).toHaveAttribute(
    'href',
    '/api/profiles/fictional-review/sources/creatinine/content',
  );
});
it('shows the exact future rule scope, existing effect and individual exceptions', () => {
  render(
    <ClinicalReviewPreview
      proposal={{
        ...base,
        kind: 'mapping',
        preview: {
          scope: 'future_imports',
          count: 0,
          matchingExistingCount: 2,
          exceptionCount: 1,
          complete: true,
          match: {
            providerId: 'Fictional clinic',
            sourceSystem: 'Fictional issuing hospital',
            kind: 'procedure',
            label: 'Creatinine',
          },
          set: { kind: 'observation', testLabel: 'Creatinine' },
          examples: [
            {
              id: 'exception',
              before: { kind: 'procedure', procedureLabel: 'Creatinine' },
              after: { kind: 'procedure' },
              individualException: true,
              problem: null,
            },
            {
              id: 'missing',
              before: { kind: 'procedure', procedureLabel: 'Creatinine' },
              after: { kind: 'observation' },
              individualException: false,
              problem: 'Result value is missing',
            },
          ],
        },
      }}
    />,
  );
  const preview = screen.getByRole('region', { name: 'Future classification rule preview' });
  expect(within(preview).getByText(/Existing accepted records changed: 0/)).toBeVisible();
  expect(within(preview).getByText(/Fictional issuing hospital/)).toBeVisible();
  expect(
    within(preview).getByText(/2 existing records match this scope; 1 have individual exceptions/),
  ).toBeVisible();
  expect(within(preview).getByText(/Individual exception retained/)).toBeVisible();
  expect(within(preview).getByText(/Result value is missing/)).toBeVisible();
  expect(
    within(preview).getByText(/Each future candidate still requires import review/),
  ).toBeVisible();
});
