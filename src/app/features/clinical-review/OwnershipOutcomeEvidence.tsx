import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../data/api';
import { useProfile } from '../../data/profile';
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
  const profile = useProfile();
  return (
    <OutcomeReader
      key={JSON.stringify([profile?.id, profile?.locked, receipt])}
      receipt={receipt}
      onUndo={onUndo}
    />
  );
}
function OutcomeReader({
  receipt,
  onUndo,
}: {
  receipt: OwnershipReceiptReference;
  onUndo: (outcome: OwnershipOutcomeEvidenceItem) => void;
}) {
  const [{ after, before }, setPosition] = useState({ after: '', before: 0 }),
    [page, setPage] = useState<{
      items: OwnershipOutcomeEvidenceItem[];
      total: number;
      digest: string;
      complete: boolean;
      after: string | null;
    } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const request = new AbortController();
    setPage(null);
    setError('');
    api<NonNullable<typeof page>>(
      `${receipt.outcomesUrl}?after=${encodeURIComponent(after)}&limit=16`,
      { signal: request.signal },
    )
      .then(({ data }) => {
        if (request.signal.aborted) return;
        const nonempty = (value: unknown) => typeof value === 'string' && !!value;
        if (
          !data ||
          data.total !== receipt.outcomeTotal ||
          data.digest !== receipt.outcomeDigest ||
          !Array.isArray(data.items) ||
          data.items.length > 16 ||
          data.items.length > receipt.outcomeTotal - before ||
          typeof data.complete !== 'boolean' ||
          data.complete !== (before + data.items.length === receipt.outcomeTotal) ||
          (data.complete
            ? data.after !== null
            : !nonempty(data.after) || data.after === after || !data.items.length) ||
          data.items.some(
            (item) =>
              !item ||
              !['observation', 'medication', 'procedure', 'document'].includes(item.kind) ||
              !['move', 'split', 'link'].includes(item.action) ||
              !nonempty(item.recordId) ||
              !nonempty(item.destinationRecordId) ||
              !nonempty(item.previousOwnerNoteId) ||
              (item.sourceReport !== undefined &&
                (!item.sourceReport ||
                  !nonempty(item.sourceReport.intakeId) ||
                  !nonempty(item.sourceReport.groupId) ||
                  !nonempty(item.sourceReport.groupVersionId))),
          ) ||
          new Set(data.items.map((item) => JSON.stringify([item.kind, item.recordId]))).size !==
            data.items.length
        )
          throw Error('Accepted outcomes did not match this complete correction receipt');
        setPage(data);
      })
      .catch(
        (error) =>
          !request.signal.aborted &&
          setError(error instanceof Error ? error.message : 'Accepted outcomes could not be read'),
      );
    return () => {
      request.abort();
    };
  }, [receipt.outcomesUrl, receipt.outcomeTotal, receipt.outcomeDigest, after, before]);
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
          <button
            type="button"
            disabled={!after}
            onClick={() => setPosition({ after: '', before: 0 })}
          >
            First outcome page
          </button>
          {!page.complete && (
            <button
              type="button"
              onClick={() =>
                setPosition({ after: page.after!, before: before + page.items.length })
              }
            >
              Next outcome page
            </button>
          )}
        </>
      )}
    </section>
  );
}
