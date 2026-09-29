import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  comparisonDecisionsNeedReview,
  RelatedRecordReview,
} from '../../app/features/clinical-review/RelatedRecordReview';
import { initialDraft, reconcileReviewDraft } from '../../app/features/intake/useReviewDrafts';
import type { IntakePairScope, IntakeRelatedRecordsResult } from '../../shared/clinical-review';
import type {
  IntakeEvidenceComparison,
  IntakeReviewDecision,
  IntakeReviewRecord,
} from '../../shared/intake';

const pairScope = (savedVersion = 'saved-version-1'): IntakePairScope => ({
  format: 'intake-pair-scope-v2',
  profileId: 'fictional-profile',
  requestRevision: 14,
  intakeVersion: 6,
  contextHash: 'fictional-current-candidate-person-report-source-context',
  activeAttachment: null,
  token: `fictional-pair-${savedVersion}`,
  incoming: {
    kind: 'observation',
    sourceRecordId: 'incoming-record',
    identity: 'incoming-identity',
    version: 'incoming-version-1',
    stateHash: 'incoming-state-hash',
    evidenceHash: 'incoming-evidence-hash',
  },
  saved: {
    kind: 'observation',
    recordId: 'saved-record',
    sourceRecordId: 'saved-source-record',
    identity: 'saved-identity',
    version: savedVersion,
    stateHash: `saved-state-${savedVersion}`,
    evidenceHash: `saved-evidence-${savedVersion}`,
  },
});

const comparison = (
  scope = pairScope(),
  extra: Partial<IntakeEvidenceComparison> = {},
): IntakeEvidenceComparison => ({
  id: 'saved-record',
  kind: 'observation',
  title: 'Fictional ferritin result',
  date: '2026-08-24',
  identity: 'saved-identity',
  version: scope.saved.version,
  mapping: { kind: 'observation', valueText: '17', unit: 'ng/mL' },
  evidence: [
    {
      label: 'Saved report',
      locator: 'page 2, row 5',
      contentUrl: '/fictional-saved-original#page=2',
    },
  ],
  previousDecision: null,
  scope,
  discoveryReasons: ['same_code', 'same_date'],
  draftScopeStatus: 'none',
  ...extra,
});

const record = (
  other = comparison(),
  extra: Partial<IntakeReviewRecord> = {},
): IntakeReviewRecord => ({
  id: 'incoming-record',
  candidateId: 'incoming-candidate',
  candidateVersionId: 'incoming-version-1',
  classification: 'addition',
  kind: 'observation',
  title: 'Incoming fictional ferritin',
  date: '2026-08-24',
  provider: 'Fictional Harbor Clinic',
  confidence: 0.91,
  uncertainties: [],
  evidence: [
    {
      label: 'Incoming report',
      locator: 'page 1, row 3',
      contentUrl: '/fictional-incoming-original#page=1',
    },
  ],
  mapping: { kind: 'observation', valueText: '18', unit: 'ng/mL' },
  supportedFields: ['valueText', 'unit'],
  comparisons: [other],
  comparisonReference: other.scope?.incoming,
  comparisonPage: {
    query: '',
    limit: 1,
    returned: 1,
    hasMore: false,
    nextCursor: null,
    truncated: false,
    maximumResults: 100,
  },
  ...extra,
});

const decision = (comparisons?: IntakeReviewDecision['comparisons']): IntakeReviewDecision => ({
  recordId: 'incoming-record',
  action: 'accept',
  mapping: { kind: 'observation', valueText: '18', unit: 'ng/mL' },
  comparisons,
});

function Harness({
  initialRecord,
  initialDecision,
  onDiscover,
}: {
  initialRecord: IntakeReviewRecord;
  initialDecision: IntakeReviewDecision;
  onDiscover?: () => Promise<IntakeRelatedRecordsResult>;
}) {
  const [value, setValue] = useState(initialDecision);
  return (
    <>
      <RelatedRecordReview
        record={initialRecord}
        decision={value}
        onChange={setValue}
        onDiscover={onDiscover}
      />
      <output aria-label="Current decision">{JSON.stringify(value)}</output>
    </>
  );
}

describe('RelatedRecordReview', () => {
  it('blocks related-record writes and discovery while a field correction is pending', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onDiscover = vi.fn();
    const onCorrectSaved = vi.fn();
    render(
      <RelatedRecordReview
        record={record()}
        decision={decision()}
        onChange={onChange}
        onDiscover={onDiscover}
        onCorrectSaved={onCorrectSaved}
        disabled
      />,
    );
    await user.click(screen.getByText(/Fictional ferritin result · 2026-08-24/));
    const search = screen.getByRole('button', { name: 'Search saved records' });
    const correct = screen.getByRole('button', { name: 'Correct this saved record' });
    expect(search).toBeDisabled();
    expect(correct).toBeDisabled();
    expect(screen.getByLabelText('Relationship to Fictional ferritin result')).toBeDisabled();
    await user.click(search);
    await user.click(correct);
    expect(onDiscover).not.toHaveBeenCalled();
    expect(onCorrectSaved).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getAllByRole('link', { name: 'Open original' })).toHaveLength(2);
  });

  it('preserves a stale exact choice during draft refresh without adopting the displayed scope', () => {
    const oldScope = pairScope('saved-version-1');
    const changed = comparison(pairScope('saved-version-2'), { draftScopeStatus: 'stale' });
    const refreshedRecord = record(changed, {
      mapping: { kind: 'observation', valueText: '19', unit: 'ng/mL' },
      comparisonDrafts: [{ otherRecordId: changed.id, status: 'stale' }],
    });
    const prior = initialDraft(record());
    prior.decision.mapping.valueText = '18.2';
    prior.decision.comparisons = [
      {
        otherRecordId: changed.id,
        scope: oldScope,
        outcome: 'distinct',
        reason: 'Earlier versions had different collection times.',
      },
    ];

    const reconciled = reconcileReviewDraft(prior, refreshedRecord, record().mapping);
    expect(reconciled.decision.mapping.valueText).toBe('18.2');
    expect(reconciled.decision.comparisons).toEqual(prior.decision.comparisons);
    expect(reconciled.decision.comparisons![0]!.scope).toBe(oldScope);
    expect(reconciled.decision.comparisons![0]!.scope).not.toEqual(changed.scope);
    expect(comparisonDecisionsNeedReview(refreshedRecord, reconciled.decision)).toBe(true);
  });

  it('shows both originals and echoes the displayed exact scope in a deliberate choice', async () => {
    const currentRecord = record();
    const user = userEvent.setup();
    render(<Harness initialRecord={currentRecord} initialDecision={decision()} />);

    await user.click(screen.getByText(/Fictional ferritin result · 2026-08-24/));
    const review = screen.getByRole('region', { name: 'Paired evidence review' });
    expect(within(review).getByText(/Same clinical code · Same date/)).toBeVisible();
    expect(within(review).getByText('Incoming record')).toBeVisible();
    expect(within(review).getByText('Previously accepted record')).toBeVisible();
    expect(
      within(review)
        .getAllByRole('link', { name: 'Open original' })
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/fictional-incoming-original#page=1', '/fictional-saved-original#page=2']);

    await user.selectOptions(
      within(review).getByLabelText('Relationship to Fictional ferritin result'),
      'same_event',
    );
    await user.type(
      within(review).getByLabelText('What the originals establish'),
      'Both originals show the same accession.',
    );

    const saved = JSON.parse(screen.getByLabelText('Current decision').textContent || '{}');
    expect(saved.comparisons).toEqual([
      {
        otherRecordId: 'saved-record',
        scope: currentRecord.comparisons![0]!.scope,
        outcome: 'same_event',
        reason: 'Both originals show the same accession.',
        occurrenceEvidence: 'attach',
      },
    ]);
  });

  it('never upgrades a hydrated legacy same-event choice during an ordinary reason edit', async () => {
    const currentRecord = record();
    const legacy = decision([
      {
        otherRecordId: 'saved-record',
        scope: currentRecord.comparisons![0]!.scope,
        outcome: 'same_event',
        reason: 'Earlier relationship-only review.',
      },
    ]);
    const user = userEvent.setup();
    render(<Harness initialRecord={currentRecord} initialDecision={legacy} />);
    await user.click(screen.getByText(/Fictional ferritin result · 2026-08-24/));
    await user.type(
      screen.getByLabelText('What the originals establish'),
      ' Still relationship-only.',
    );
    const saved = JSON.parse(screen.getByLabelText('Current decision').textContent || '{}');
    expect(saved.comparisons[0].outcome).toBe('same_event');
    expect(saved.comparisons[0].occurrenceEvidence).toBeUndefined();
  });

  it('does not hydrate a stale choice onto a changed saved version', async () => {
    const oldScope = pairScope('saved-version-1');
    const currentComparison = comparison(pairScope('saved-version-2'), {
      draftScopeStatus: 'stale',
    });
    const currentRecord = record(currentComparison, {
      comparisonDrafts: [{ otherRecordId: currentComparison.id, status: 'stale' }],
    });
    const staleDecision = decision([
      {
        otherRecordId: currentComparison.id,
        scope: oldScope,
        outcome: 'distinct',
        reason: 'Earlier review of another version.',
      },
    ]);
    expect(comparisonDecisionsNeedReview(currentRecord, staleDecision)).toBe(true);

    const user = userEvent.setup();
    render(<Harness initialRecord={currentRecord} initialDecision={staleDecision} />);
    await user.click(screen.getByText(/needs review/));
    const select = screen.getByLabelText('Relationship to Fictional ferritin result');
    expect(select).toHaveValue('');
    expect(screen.getByText(/does not match both versions shown now/)).toBeVisible();

    await user.selectOptions(select, 'unresolved');
    const saved = JSON.parse(screen.getByLabelText('Current decision').textContent || '{}');
    expect(saved.comparisons[0]).toEqual({
      otherRecordId: 'saved-record',
      scope: currentComparison.scope,
      outcome: 'unresolved',
      reason: '',
    });
  });

  it('keeps the incoming edit and decision while replacing a bounded search page', async () => {
    const searched = comparison(pairScope('saved-version-3'), {
      title: 'Fictional searched result',
      discoveryReasons: ['search_match'],
    });
    const response: IntakeRelatedRecordsResult = {
      intakeId: 'fictional-intake',
      proposalId: 'fictional-proposal',
      recordId: 'incoming-record',
      candidateVersionId: 'incoming-version-1',
      intakeVersion: 8,
      reviewToken: 'fictional-review-token',
      comparisons: [searched],
      page: {
        query: 'alternate code',
        limit: 1,
        returned: 1,
        hasMore: false,
        nextCursor: null,
        truncated: true,
        maximumResults: 100,
      },
    };
    const onDiscover = vi.fn(async () => response);
    const initial = decision([
      {
        otherRecordId: 'saved-record',
        scope: pairScope(),
        outcome: 'distinct',
        reason: 'The collection times differ.',
      },
    ]);
    initial.mapping.valueText = '18.2';
    const user = userEvent.setup();
    render(<Harness initialRecord={record()} initialDecision={initial} onDiscover={onDiscover} />);

    const search = screen.getByLabelText('Find related saved records');
    await user.type(search, 'alternate code');
    await user.click(screen.getByRole('button', { name: 'Search saved records' }));
    expect(await screen.findByText(/Fictional searched result · 2026-08-24/)).toBeVisible();
    expect(screen.getByText(/More saved records match/)).toBeVisible();
    expect(onDiscover).toHaveBeenCalledWith({ query: 'alternate code', limit: 1 });
    const saved = JSON.parse(screen.getByLabelText('Current decision').textContent || '{}');
    expect(saved.mapping.valueText).toBe('18.2');
    expect(saved.comparisons[0].reason).toBe('The collection times differ.');
  });
});
