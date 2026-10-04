import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../data/api';
import { linkHref } from '../notes/NoteLinks';
import type {
  OwnershipReceiptReference,
  OwnershipOutcomeEvidenceItem,
} from '../../../shared/ownership-report-reference';
export function OwnershipOutcomeEvidence({
  receipt,
  onUndo,
}: {
  receipt: OwnershipReceiptReference;
  onUndo: (outcome: OwnershipOutcomeEvidenceItem) => void;
}) {
  const [after, setAfter] = useState(''),
    [page, setPage] = useState<{
      items: OwnershipOutcomeEvidenceItem[];
      total: number;
      complete: boolean;
      after: string | null;
    } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPage(null);
    setError('');
    api<NonNullable<typeof page>>(
      `${receipt.outcomesUrl}?after=${encodeURIComponent(after)}&limit=16`,
    )
      .then(({ data }) => active && setPage(data))
      .catch(
        (error) =>
          active &&
          setError(error instanceof Error ? error.message : 'Accepted outcomes could not be read'),
      );
    return () => {
      active = false;
    };
  }, [receipt.outcomesUrl, after]);
  return (
    <section aria-label="Accepted ownership outcomes">
      <p>{receipt.outcomeTotal} accepted record outcomes remain in history.</p>
      {error && <p role="alert">{error}</p>}
      {page && (
        <>
          <p>
            {page.items.length} shown of {page.total}
          </p>
          <ul>
            {page.items.map((outcome) => (
              <li key={outcome.kind + outcome.recordId}>
                <Link
                  to={linkHref({ targetType: outcome.kind, targetId: outcome.destinationRecordId })}
                >
                  View corrected {outcome.kind} and its history
                </Link>
                <button type="button" onClick={() => onUndo(outcome)}>
                  Review undo
                </button>
                {outcome.kind === 'medication' && (
                  <p>
                    A moved prescription starts inactive. Activate it separately if appropriate.
                  </p>
                )}
              </li>
            ))}
          </ul>
          <button type="button" disabled={!after} onClick={() => setAfter('')}>
            First outcome page
          </button>
          {!page.complete && (
            <button type="button" onClick={() => setAfter(page.after!)}>
              Next outcome page
            </button>
          )}
        </>
      )}
    </section>
  );
}
