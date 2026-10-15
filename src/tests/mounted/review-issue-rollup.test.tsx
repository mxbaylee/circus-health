import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  groupReviewIssues,
  ReviewIssue,
  reviewRecordTitle,
} from '../../app/features/intake/ReviewWorkspace';
import type {
  IntakeIssueResolution,
  IntakeReviewIssue,
  IntakeReviewRecord,
} from '../../shared/intake';

vi.mock('../../app/components/PdfPreview', () => ({
  PdfPreview: () => <div>Fictional PDF preview</div>,
}));

const issue = (id: string, extra: Partial<IntakeReviewIssue> = {}): IntakeReviewIssue => ({
  id,
  kind: 'date',
  field: 'date',
  prompt: `Fictional date question ${id}`,
  blocking: false,
  status: 'unresolved',
  locator: 'Fictional document',
  questionId: null,
  ...extra,
});
const record: IntakeReviewRecord = {
  id: 'fictional-document',
  kind: 'document',
  title: 'a'.repeat(64),
  date: null,
  provider: 'Fictional Clinic',
  classification: 'addition',
  confidence: null,
  uncertainties: [],
  evidence: [],
  mapping: { documentTitle: 'Fictional visit summary' },
  supportedFields: ['date', 'documentDate'],
  issues: [
    issue('generated', { prompt: 'The document date is unknown.' }),
    issue('legacy', {
      questionId: 'legacy',
      prompt: 'Does 07/12/2026 mean December 7 or July 12?',
    }),
    issue('typed', {
      page: 1,
      field: 'documentDate',
      prompt: 'Which date is on this document?',
      choices: [
        { label: 'December 7, 2026', value: '2026-12-07' },
        { label: 'July 12, 2026', value: '2026-07-12' },
      ],
    }),
  ],
};

function Harness({
  onSave,
  candidate = record,
}: {
  onSave: (items: IntakeIssueResolution[]) => void;
  candidate?: IntakeReviewRecord;
}) {
  const [resolutions, setResolutions] = useState<IntakeIssueResolution[]>([]);
  return (
    <>
      {groupReviewIssues(candidate, resolutions).map(({ issue, issues }) => (
        <ReviewIssue
          key={issue.id}
          issue={issue}
          relatedIssues={issues}
          mapping={record.mapping}
          busy={false}
          onLater={() => {}}
          onResolve={(resolution) => {
            const next = issues.map((item) => ({ ...resolution, issueId: item.id }));
            setResolutions(next);
            onSave(next);
          }}
        />
      ))}
    </>
  );
}

it('shows every proposed identity name even when the question text does not name anyone', async () => {
  const first = issue('first-name', {
    kind: 'identity',
    prompt: 'Who does this record belong to?',
    selfSuggestion: { fullName: 'Fictional Fern Meadow' },
  });
  const second = issue('late-name', {
    kind: 'identity',
    prompt: 'Who does this record belong to?',
    selfSuggestion: { fullName: 'Fictional Willow Brook' },
  });
  render(
    <ReviewIssue
      issue={first}
      relatedIssues={[first, second]}
      mapping={{}}
      busy={false}
      onLater={() => {}}
      onResolve={() => {}}
    />,
  );
  expect(screen.getByText('Suggested name: Fictional Fern Meadow')).toBeVisible();
  await userEvent.setup().click(screen.getByText('2 related questions'));
  expect(screen.getByText('· Suggested name: Fictional Willow Brook')).toBeVisible();
});

describe('document date question rollup', () => {
  it('reaches the native retained-question history control by keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness onSave={() => {}} />);
    const history = screen.getByText('3 related questions');
    for (let step = 0; step < 20 && document.activeElement !== history; step++) await user.tab();
    expect(history).toHaveFocus();
    expect(history.tagName).toBe('SUMMARY');
    await user.click(history);
    expect(history.parentElement).toHaveAttribute('open');
    expect(within(history.parentElement!).getAllByRole('listitem')).toHaveLength(3);
  });
  it.each([
    ['July 12, 2026', 'corrected', '2026-07-12'],
    ['Keep unconfirmed', 'unknown', ''],
  ])(
    'shows choices on the single open prompt and saves %s for all issue IDs',
    async (label, outcome, value) => {
      const save = vi.fn();
      const user = userEvent.setup();
      const { container } = render(<Harness onSave={save} />);
      expect(container.querySelectorAll('details.intake-issue')).toHaveLength(1);
      expect(
        screen.getByText('Which date is on this document?', {
          selector: '.intake-issue > summary',
        }),
      ).toBeVisible();
      expect(screen.getByRole('button', { name: 'December 7, 2026' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'July 12, 2026' })).toBeVisible();
      const history = screen.getByText('3 related questions').parentElement!;
      expect(history).not.toHaveAttribute('open');
      await user.click(screen.getByRole('button', { name: label }));
      expect(save).toHaveBeenCalledWith(
        ['generated', 'legacy', 'typed'].map((issueId) => ({
          issueId,
          outcome,
          mapping: { date: value, documentDate: value },
        })),
      );
      expect(container.querySelectorAll('details.intake-issue.is-resolved')).toHaveLength(1);
      expect(container.querySelector('details.intake-issue')).not.toHaveAttribute('open');
      await user.click(container.querySelector('.intake-issue > summary')!);
      await user.click(screen.getByText('3 related questions'));
      expect(within(history).getAllByRole('listitem')).toHaveLength(3);
      for (const id of ['generated', 'legacy', 'typed'])
        expect(document.getElementById(`issue-${id}`)).not.toBeNull();
    },
  );

  it('does not merge different pages, fields, members, fieldless questions or records', () => {
    const separate = {
      ...record,
      issues: [
        issue('page1', { page: 1 }),
        issue('page2', { page: 2 }),
        issue('no-page'),
        issue('member-a', { memberId: 'a', page: 1 }),
        issue('member-b', { memberId: 'b', page: 1 }),
        issue('other-field', { field: 'expirationDate', page: 1 }),
        issue('fieldless', { field: null }),
        issue('fieldless-2', { field: null }),
      ],
    };
    expect(groupReviewIssues(separate)).toHaveLength(8);
    expect(groupReviewIssues(record)[0].issues.map((item) => item.id)).toEqual([
      'generated',
      'legacy',
      'typed',
    ]);
    expect(
      groupReviewIssues({
        ...record,
        id: 'another-document',
        issues: [issue('another')],
      })[0].issues.map((item) => item.id),
    ).toEqual(['another']);
  });

  it('keeps the rich prompt actionable while any related question remains unresolved', () => {
    const [group] = groupReviewIssues(record, [{ issueId: 'typed', outcome: 'unknown' }]);
    expect(group.issue.prompt).toBe('Which date is on this document?');
    expect(group.issue.status).toBe('unresolved');
    expect(group.issue.resolution).toBeUndefined();
    expect(group.issues[2].resolution?.outcome).toBe('unknown');
  });

  it('uses meaningful document labels and hides opaque hash titles', () => {
    expect(reviewRecordTitle(record)).toBe('Fictional visit summary');
    expect(reviewRecordTitle({ ...record, mapping: {} })).toBe('Document');
    expect(reviewRecordTitle({ ...record, mapping: { label: 'Visit notes' } })).toBe('Visit notes');
  });
});

it('confirms repeated ownership prompts once while retaining every underlying resolution', async () => {
  const save = vi.fn();
  const candidate = {
    ...record,
    issues: [
      issue('automatic', {
        kind: 'identity',
        field: 'subject',
        prompt: 'Does this record belong to you?',
      }),
      issue('model', {
        kind: 'identity',
        field: 'subject',
        page: 1,
        prompt: 'Does the prescription naming Fictional Rowan Example belong to you?',
      }),
      issue('legacy', { kind: 'identity', field: null, questionId: 'legacy' }),
    ],
  };
  const user = userEvent.setup();
  render(<Harness candidate={candidate} onSave={save} />);
  expect(screen.getAllByRole('button', { name: 'This is me' })).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'This is me' }));
  expect(save).toHaveBeenCalledWith(
    candidate.issues.map((item) => ({
      issueId: item.id,
      outcome: 'this_is_me',
      mapping: { subject: 'self' },
    })),
  );
  expect(
    groupReviewIssues({
      ...candidate,
      issues: [candidate.issues[0], { ...candidate.issues[1], memberId: 'other-member' }],
    }),
  ).toHaveLength(2);
});
