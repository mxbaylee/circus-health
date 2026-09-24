import { expect, it } from 'vitest';
import type {
  IntakeEvidenceComparison,
  IntakeReviewDraft,
  IntakeReviewRecord,
} from '../../shared/intake';
import { possibleSavedOverlapCount } from '../../app/features/import/possible-overlaps';

const mapping = { date: '2026-02-04', valueText: '17.50', unit: 'mg/L' };
const original = '/api/sources/fictional-original/content';
function record(patch: Partial<IntakeEvidenceComparison> = {}) {
  return {
    kind: 'observation',
    evidence: [{ label: 'Page 4', locator: 'page:4', contentUrl: original }],
    comparisons: [
      {
        id: 'fictional-saved',
        kind: 'observation',
        title: 'Alternate fictional analyte label',
        date: mapping.date,
        identity: 'fictional-identity',
        version: 'fictional-v1',
        mapping,
        evidence: [{ label: 'Page 1', locator: 'page:1', contentUrl: original }],
        previousDecision: null,
        ...patch,
      },
    ],
  } satisfies Pick<IntakeReviewRecord, 'kind' | 'evidence' | 'comparisons'>;
}

it('surfaces same-file literal/date/unit overlaps even when source labels differ', () => {
  const incoming = record();
  const before = structuredClone(incoming);
  expect(possibleSavedOverlapCount(incoming, mapping)).toBe(1);
  expect(incoming).toEqual(before);
});

it.each([
  ['unknown date', { date: '' }],
  ['unknown unit', { unit: '' }],
  ['different date', { date: '2026-02-05' }],
  ['different unit', { unit: 'g/L' }],
  ['different literal', { valueText: '17.5' }],
] as const)('does not presume overlap from %s', (_name, change) => {
  expect(possibleSavedOverlapCount(record(), { ...mapping, ...change })).toBe(0);
});

it('requires the same retained original and observation kind on both sides', () => {
  expect(possibleSavedOverlapCount(record({ evidence: [] }), mapping)).toBe(0);
  expect(
    possibleSavedOverlapCount(
      record({
        evidence: [{ label: 'Another file', locator: 'page:1', contentUrl: original + '-other' }],
      }),
      mapping,
    ),
  ).toBe(0);
  expect(possibleSavedOverlapCount(record({ kind: 'procedure' }), mapping)).toBe(0);
  expect(possibleSavedOverlapCount({ ...record(), kind: 'document' }, mapping)).toBe(0);
});

it('respects current reviewed pair decisions but retains stale and unresolved cues', () => {
  for (const outcome of ['same_event', 'changed_version', 'distinct'] as const) {
    const previousDecision = { id: 'fictional-review', reason: 'Reviewed originals', outcome };
    expect(
      possibleSavedOverlapCount(
        record({ previousDecision: { ...previousDecision, scopeStatus: 'current' } }),
        mapping,
      ),
    ).toBe(0);
    expect(
      possibleSavedOverlapCount(
        record({ previousDecision: { ...previousDecision, scopeStatus: 'stale' } }),
        mapping,
      ),
    ).toBe(1);
  }
  expect(
    possibleSavedOverlapCount(
      record({
        previousDecision: {
          id: 'fictional-review',
          reason: 'Not sure',
          outcome: 'unresolved',
          scopeStatus: 'current',
        },
      }),
      mapping,
    ),
  ).toBe(1);
});

it('suppresses current complete draft choices, not stale, missing-scope or unresolved drafts', () => {
  const draft: IntakeReviewDraft = {
    id: 'fictional-draft',
    proposalId: 'fictional-proposal',
    recordId: 'fictional-incoming',
    candidateId: 'fictional-candidate',
    candidateVersionId: 'fictional-version',
    mapping: {},
    resolutions: [],
    disposition: 'pending',
    at: '2026-02-04',
    decision: {
      recordId: 'fictional-incoming',
      action: 'accept',
      mapping,
      comparisons: [
        {
          otherRecordId: 'fictional-saved',
          outcome: 'distinct',
          reason: 'Originals show separate specimens',
        },
      ],
    },
  };
  for (const status of ['current', 'stale', 'missing', 'none'] as const) {
    const incoming = {
      ...record(),
      draft,
      comparisonDrafts: [{ otherRecordId: 'fictional-saved', status }],
    };
    expect(possibleSavedOverlapCount(incoming, mapping)).toBe(status === 'current' ? 0 : 1);
  }
  const changed = structuredClone(draft);
  changed.decision!.comparisons![0]!.outcome = 'unresolved';
  expect(
    possibleSavedOverlapCount(
      {
        ...record(),
        draft: changed,
        comparisonDrafts: [{ otherRecordId: 'fictional-saved', status: 'current' }],
      },
      mapping,
    ),
  ).toBe(1);
  changed.decision!.comparisons![0]!.outcome = 'distinct';
  changed.decision!.comparisons![0]!.reason = ' ';
  expect(
    possibleSavedOverlapCount(
      {
        ...record(),
        draft: changed,
        comparisonDrafts: [{ otherRecordId: 'fictional-saved', status: 'current' }],
      },
      mapping,
    ),
  ).toBe(1);
});
