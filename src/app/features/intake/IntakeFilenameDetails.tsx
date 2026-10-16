import { useEffect, useState } from 'react';
import type {
  IntakeFilenameFragment,
  IntakeFilenameReference,
} from '../../../shared/intake-summary';
import { api } from '../../data/api';

/** Keep only the requested fragment, never an accumulated long name. */
export function IntakeFilenameDetails({ reference }: { reference: IntakeFilenameReference }) {
  const [open, setOpen] = useState(false),
    [cursor, setCursor] = useState<string | undefined>();
  const [page, setPage] = useState<IntakeFilenameFragment | null>(null),
    [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setCursor(undefined);
    setPage(null);
  }, [reference.scalarHash, reference.pins.logicalRoot]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setPage(null);
    void api<IntakeFilenameFragment>(
      `/intakes/${encodeURIComponent(reference.intakeId)}/filename-fragment`,
      {
        method: 'POST',
        body: JSON.stringify({ reference, cursor, limit: 32768 }),
      },
    )
      .then((result) => {
        if (cancelled) return;
        if (JSON.stringify(result.data.reference) !== JSON.stringify(reference))
          throw Error('The retained filename changed. Refresh this file.');
        setPage(result.data);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : 'The filename could not load.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cursor, reference]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Full retained filename</summary>
      {loading && <p role="status">Loading filename…</p>}
      {error && <p role="alert">{error}</p>}
      {page && (
        <>
          <p>
            {page.complete && !cursor
              ? 'Complete retained filename'
              : 'Part of the retained filename'}
          </p>
          <pre>{page.text}</pre>
          <button type="button" disabled={!cursor} onClick={() => setCursor(undefined)}>
            First
          </button>
          <button
            type="button"
            disabled={!page.nextCursor}
            onClick={() => setCursor(page.nextCursor ?? undefined)}
          >
            Next
          </button>
        </>
      )}
    </details>
  );
}
