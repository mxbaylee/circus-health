import { replaceProfiles, selectProfile } from '../../app/data/profile';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ReportPeopleReview,
  type IntakePeopleQueue,
  type IntakePersonProposal,
} from '../../app/features/intake/ReportPeopleReview';

const profile = { id: 'fictional-people-review', name: 'Fictional Reader', placebo: true };
beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});
const person = (overrides: Partial<IntakePersonProposal> = {}): IntakePersonProposal => ({
  id: 'person-proposal-1',
  version: 'person-proposal-v3',
  state: 'pending',
  intakeId: 'intake-fictional-people',
  intakeVersion: 8,
  proposalId: 'clinical-proposal-2',
  envelopeRecordId: 'fictional-envelope-record',
  envelopeId: 'fictional-envelope',
  groupId: 'fictional-report',
  groupVersionId: 'fictional-report-v2',
  title: 'Dr. Rowan Finch',
  person: {
    fullName: 'Dr. Rowan Finch',
    relationship: 'Fictional endocrinologist',
    phone: '555-0104',
    email: 'rowan@example.invalid',
    medicalHistory: 'Discussed fictional follow-up testing.',
    tags: ['Professional'],
  },
  uncertainties: ['Confirm the fictional office phone number.'],
  evidence: [
    {
      label: 'Page 2',
      locator: 'page 2, care team',
      contentUrl: '/api/sources/fictional-people/content#page=2',
      textAnchor: 'Follow up with Dr. Rowan Finch.',
      supports: ['fullName', 'relationship'],
      page: 2,
    },
  ],
  source: {
    sourceRecordId: 'fictional-source-record',
    filename: 'fictional-care-plan.pdf',
    contentUrl: '/api/sources/fictional-people/content#page=2',
    originalSourceFileId: 'fictional-source-file',
    originalSha256: 'fictional-sha256',
    member: null,
  },
  matches: [
    {
      noteId: 'note-existing-rowan',
      personId: 'person-existing-rowan',
      title: 'Dr. Rowan Finch',
      fullName: 'Dr. Rowan Finch',
      relationship: 'Endocrinologist',
      version: 12,
      reason: 'Exact normalized name',
    },
  ],
  matchCount: 1,
  matchesTruncated: false,
  ...overrides,
});

function queue(...people: IntakePersonProposal[]): IntakePeopleQueue {
  return {
    groupId: 'fictional-report',
    people,
    totalPeople: people.length,
    peopleNextCursor: null,
  };
}

function mount(people: IntakePersonProposal[]) {
  const onDisposition = vi.fn();
  const onApply = vi.fn();
  render(
    <ReportPeopleReview
      queue={queue(...people)}
      busy={false}
      loadingMore={false}
      onLoadMore={() => {}}
      onDisposition={onDisposition}
      onApply={onApply}
    />,
  );
  return { onDisposition, onApply };
}

describe('report People review', () => {
  it('opens the exact Person requested by an Import deep link', () => {
    render(
      <ReportPeopleReview
        queue={queue(person())}
        preferredPersonId="person-proposal-1"
        busy={false}
        loadingMore={false}
        onLoadMore={() => {}}
        onDisposition={() => {}}
        onApply={() => {}}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Dr. Rowan Finch' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Update Dr. Rowan Finch' })).toBeVisible();
  });

  it('opens the durable later state when the report queue is showing Review later', () => {
    render(
      <ReportPeopleReview
        queue={queue(
          person(),
          person({
            id: 'person-later',
            state: 'later',
            person: { fullName: 'Juniper Vale', tags: [] },
          }),
        )}
        preferredState="later"
        busy={false}
        loadingMore={false}
        onLoadMore={() => {}}
        onDisposition={() => {}}
        onApply={() => {}}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Review later 1' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('button', { name: /Juniper Vale/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Dr\. Rowan Finch/ })).not.toBeInTheDocument();
  });

  it('keeps original evidence visible and requires an explicit current add or update choice', async () => {
    const user = userEvent.setup();
    const proposal = person();
    const { onApply, onDisposition } = mount([proposal]);

    const row = screen.getByRole('button', { name: /Dr\. Rowan Finch/ });
    await user.click(row);

    expect(screen.getByRole('heading', { name: 'Dr. Rowan Finch' })).toHaveFocus();
    expect(screen.getByText('Follow up with Dr. Rowan Finch.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open original' })).toHaveAttribute(
      'href',
      '/api/profiles/fictional-people-review/sources/fictional-people/content#page=2',
    );

    await user.click(screen.getByRole('button', { name: 'Update Dr. Rowan Finch' }));
    expect(onApply).toHaveBeenCalledWith(proposal, {
      action: 'update',
      noteId: 'note-existing-rowan',
      version: 12,
    });

    await user.click(screen.getByRole('button', { name: 'Add as new person' }));
    expect(onApply).toHaveBeenLastCalledWith(proposal, { action: 'add' });

    await user.click(screen.getByRole('button', { name: 'Review later' }));
    expect(onDisposition).toHaveBeenCalledWith(proposal, 'later');

    await user.click(screen.getByRole('button', { name: 'Back to People' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Dr\. Rowan Finch/ })).toHaveFocus(),
    );
  });

  it('does not offer add or update when the named proposal matches Self', async () => {
    const user = userEvent.setup();
    const proposal = person({
      id: 'person-proposal-self',
      person: { fullName: 'Cookie Dough', tags: [] },
      selfMatch: { reason: 'The name exactly matches this profile.' },
    });
    const { onApply, onDisposition } = mount([proposal]);

    await user.click(screen.getByRole('button', { name: /Cookie Dough/ }));

    expect(screen.getByText('This looks like Self')).toBeVisible();
    expect(screen.getByText('The name exactly matches this profile.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Add as new person/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Update / })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Review later' }));
    expect(onDisposition).toHaveBeenCalledWith(proposal, 'later');
    expect(onApply).not.toHaveBeenCalled();
  });
});
