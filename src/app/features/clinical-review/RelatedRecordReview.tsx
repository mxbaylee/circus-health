import { useEffect, useState, type FormEvent } from 'react';
import type {
  ClinicalPairReference,
  IntakePairScope,
  IntakeRelatedRecordsResult,
  RelatedRecordReason,
  RelatedRecordSearch,
} from '../../../shared/clinical-review';
import type {
  IntakeEvidenceComparison,
  IntakePairDecision,
  IntakeReviewDecision,
  IntakeReviewRecord,
} from '../../../shared/intake';
import './clinical-review.css';
import { ClinicalEvidencePair } from './ClinicalEvidencePair';

const reasonLabels: Record<RelatedRecordReason, string> = {
  same_code: 'Same clinical code',
  same_label: 'Same measurement name',
  label_terms: 'Similar measurement words',
  search_match: 'Matches your search',
  same_date: 'Same date',
  same_issuer: 'Same issuing source',
};

const outcomeLabels: Record<IntakePairDecision['outcome'], string> = {
  distinct: 'Separate measurement',
  same_event: 'Another source for the same measurement',
  changed_version: 'Different version — keep both records',
  unresolved: 'I’m not sure yet',
};

function sameReference(left: ClinicalPairReference, right: ClinicalPairReference) {
  return (
    left.kind === right.kind &&
    left.sourceRecordId === right.sourceRecordId &&
    left.identity === right.identity &&
    left.version === right.version &&
    left.stateHash === right.stateHash &&
    left.evidenceHash === right.evidenceHash
  );
}

export function sameIntakePairScope(left?: IntakePairScope, right?: IntakePairScope) {
  return !!(
    left &&
    right &&
    left.format === right.format &&
    left.profileId === right.profileId &&
    left.token === right.token &&
    left.saved.recordId === right.saved.recordId &&
    sameReference(left.incoming, right.incoming) &&
    sameReference(left.saved, right.saved)
  );
}

function currentChoice(decision: IntakeReviewDecision, comparison: IntakeEvidenceComparison) {
  const choice = decision.comparisons?.find((item) => item.otherRecordId === comparison.id);
  return sameIntakePairScope(choice?.scope, comparison.scope) ? choice : undefined;
}

function storedStatus(record: IntakeReviewRecord, comparison: IntakeEvidenceComparison) {
  return (
    record.comparisonDrafts?.find((item) => item.otherRecordId === comparison.id)?.status ||
    comparison.draftScopeStatus ||
    'none'
  );
}

export function comparisonDecisionsNeedReview(
  record: IntakeReviewRecord,
  decision: IntakeReviewDecision,
) {
  const displayed = new Map((record.comparisons || []).map((item) => [item.id, item]));
  const local = new Map((decision.comparisons || []).map((item) => [item.otherRecordId, item]));
  const statusById = new Map(
    (record.comparisonDrafts || []).map((item) => [item.otherRecordId, item.status]),
  );

  for (const comparison of record.comparisons || []) {
    const choice = local.get(comparison.id);
    if (sameIntakePairScope(choice?.scope, comparison.scope)) continue;
    const status = statusById.get(comparison.id) || comparison.draftScopeStatus || 'none';
    if (
      status === 'missing' ||
      status === 'stale' ||
      comparison.previousDecision?.scopeStatus === 'legacy' ||
      comparison.previousDecision?.scopeStatus === 'stale'
    )
      return true;
  }

  for (const [id, status] of statusById) {
    if (status !== 'missing' && status !== 'stale') continue;
    const comparison = displayed.get(id);
    if (!comparison || !sameIntakePairScope(local.get(id)?.scope, comparison.scope)) return true;
  }
  return false;
}

export function RelatedRecordReview({
  record,
  decision,
  onChange,
  onDiscover,
  onCorrectSaved,
  disabled = false,
}: {
  record: IntakeReviewRecord;
  decision: IntakeReviewDecision;
  onChange: (next: IntakeReviewDecision) => void;
  onDiscover?: (search: RelatedRecordSearch) => Promise<IntakeRelatedRecordsResult>;
  onCorrectSaved?: (record: IntakeEvidenceComparison) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState(record.comparisonPage?.query || '');
  const [comparisons, setComparisons] = useState(record.comparisons || []);
  const [page, setPage] = useState(record.comparisonPage);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const comparisonVersionKey = (record.comparisons || [])
    .map((item) => `${item.id}:${item.scope?.token || item.version}`)
    .join('|');

  useEffect(() => {
    setQuery(record.comparisonPage?.query || '');
    setComparisons(record.comparisons || []);
    setPage(record.comparisonPage);
    setError('');
  }, [
    record.id,
    record.candidateVersionId,
    record.comparisonReference?.stateHash,
    comparisonVersionKey,
  ]);

  const discover = async (search: RelatedRecordSearch, append: boolean) => {
    if (!onDiscover || loading || disabled) return;
    setLoading(true);
    setError('');
    try {
      const result = await onDiscover(search);
      if (result.recordId !== record.id || result.candidateVersionId !== record.candidateVersionId)
        throw new Error(
          'This incoming record changed. Review its current version before comparing.',
        );
      setComparisons((current) => {
        if (!append) return result.comparisons;
        const byId = new Map(current.map((item) => [item.id, item]));
        for (const item of result.comparisons) byId.set(item.id, item);
        return [...byId.values()];
      });
      setPage(result.page);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Related records could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    void discover({ query: query.trim(), limit: page?.limit }, false);
  };

  const update = (
    comparison: IntakeEvidenceComparison,
    patch: Pick<IntakePairDecision, 'outcome'> | Pick<IntakePairDecision, 'reason'>,
  ) => {
    if (!comparison.scope || disabled) return;
    const saved = currentChoice(decision, comparison);
    const next: IntakePairDecision = {
      otherRecordId: comparison.id,
      scope: comparison.scope,
      outcome: saved?.outcome || 'unresolved',
      reason: saved?.reason || '',
      ...(saved?.occurrenceEvidence ? { occurrenceEvidence: saved.occurrenceEvidence } : {}),
      ...patch,
    };
    // The visible fresh choice is the only attachment authority. Hydration and
    // reason edits never manufacture the discriminator for legacy decisions.
    if ('outcome' in patch) {
      if (patch.outcome === 'same_event') next.occurrenceEvidence = 'attach';
      else delete next.occurrenceEvidence;
    }
    onChange({
      ...decision,
      comparisons: [
        ...(decision.comparisons || []).filter((item) => item.otherRecordId !== comparison.id),
        next,
      ],
    });
  };

  if (!comparisons.length && !onDiscover) return null;
  return (
    <section className="clinical-related-review" aria-label="Paired evidence review">
      <h4>Compare possible related records</h4>
      <p className="helper-text">
        Similar codes, names, dates, values, or sources only help find records to inspect. They do
        not establish that two records describe the same measurement.
      </p>
      {onDiscover && (
        <form className="clinical-related-search" onSubmit={submitSearch}>
          <label>
            Find related saved records
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Measurement, code, date, or source"
              disabled={disabled || loading}
            />
          </label>
          <button type="submit" className="button secondary" disabled={disabled || loading}>
            {loading ? 'Searching…' : 'Search saved records'}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {page?.truncated && (
        <p className="clinical-related-notice">
          More saved records match than can be shown here. Refine the search to inspect a smaller
          set.
        </p>
      )}
      {!comparisons.length && <p>No saved records match this search.</p>}
      {comparisons.map((other) => {
        const selected = currentChoice(decision, other);
        const status = storedStatus(record, other);
        const stale =
          !selected &&
          (status === 'missing' ||
            status === 'stale' ||
            other.previousDecision?.scopeStatus === 'legacy' ||
            other.previousDecision?.scopeStatus === 'stale');
        return (
          <details key={other.id}>
            <summary>
              {other.title} · {other.date || 'Unknown date'}
              {stale
                ? ' · needs review'
                : other.previousDecision
                  ? ` · ${outcomeLabels[other.previousDecision.outcome]}`
                  : ''}
            </summary>
            {!!other.discoveryReasons?.length && (
              <p className="clinical-related-reasons">
                Possibly related because:{' '}
                {other.discoveryReasons.map((reason) => reasonLabels[reason]).join(' · ')}
              </p>
            )}
            <ClinicalEvidencePair
              incoming={{
                title: record.title,
                date: record.date,
                mapping: decision.mapping,
                evidence: record.evidence,
              }}
              saved={other}
              onCorrectSaved={onCorrectSaved}
              disabled={disabled}
            />
            {other.previousDecision && (
              <p>
                Saved decision: {outcomeLabels[other.previousDecision.outcome]}.{' '}
                {other.previousDecision.reason}
                {other.previousDecision.scopeStatus !== 'current' &&
                  ' The displayed record version has changed, so review this pair again.'}
              </p>
            )}
            {stale && (
              <p role="status" className="clinical-related-notice">
                Your earlier choice is kept in review history, but it does not match both versions
                shown now. Inspect both originals and choose again.
              </p>
            )}
            {!other.scope && (
              <p role="status" className="clinical-related-notice">
                Refresh this comparison before choosing; its exact version scope is unavailable.
              </p>
            )}
            <label>
              Relationship to {other.title}
              <select
                value={selected?.outcome || ''}
                disabled={disabled || !other.scope}
                onChange={(event) =>
                  update(other, {
                    outcome: event.target.value as IntakePairDecision['outcome'],
                  })
                }
              >
                <option value="" disabled>
                  {stale ? 'Review these versions and choose…' : 'Keep saved decision or choose…'}
                </option>
                <option value="distinct">Separate measurement</option>
                <option value="same_event">Another source for the same measurement</option>
                <option value="changed_version">Different version — keep both records</option>
                <option value="unresolved">I’m not sure yet</option>
              </select>
            </label>
            {selected && (
              <label>
                What the originals establish
                <textarea
                  rows={2}
                  value={selected.reason}
                  disabled={disabled}
                  onChange={(event) => update(other, { reason: event.target.value })}
                  placeholder="Describe the evidence for this choice"
                />
              </label>
            )}
          </details>
        );
      })}
      {onDiscover && page?.hasMore && page.nextCursor && (
        <button
          type="button"
          className="button secondary"
          disabled={disabled || loading}
          onClick={() =>
            void discover({ query: page.query, cursor: page.nextCursor, limit: page.limit }, true)
          }
        >
          {loading ? 'Loading…' : 'Show more possible matches'}
        </button>
      )}
    </section>
  );
}
