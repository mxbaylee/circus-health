import { useEffect, useRef, useState } from 'react';
import type {
  IntakeSourceFieldFragmentV1,
  IntakeSourceFieldReferenceV1,
} from '../../../shared/intake-summary';
import { api } from '../../data/api';

function releaseCursor(reference: IntakeSourceFieldReferenceV1, cursor: string): void {
  void api(`/intakes/${encodeURIComponent(reference.intakeId)}/source-field-fragment`, {
    method: 'POST',
    body: JSON.stringify({ reference, cursor, release: true }),
  }).catch(() => {
    // Server idle expiry remains the fallback when the browser is leaving.
  });
}

/** Only one bounded page is retained by the browser. */
export function IntakeSourceFieldDetails({
  reference,
  label,
}: {
  reference: IntakeSourceFieldReferenceV1;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [page, setPage] = useState<IntakeSourceFieldFragmentV1 | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const held = useRef<{ reference: IntakeSourceFieldReferenceV1; cursor: string } | null>(null);
  const releaseHeld = () => {
    if (!held.current) return;
    const previous = held.current;
    held.current = null;
    releaseCursor(previous.reference, previous.cursor);
  };
  useEffect(() => {
    setCursor(undefined);
    setPage(null);
    return () => releaseHeld();
  }, [reference.intakeId, reference.sourceVersionId, reference.field, reference.scalarHash]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setPage(null);
    void api<IntakeSourceFieldFragmentV1>(
      `/intakes/${encodeURIComponent(reference.intakeId)}/source-field-fragment`,
      {
        method: 'POST',
        body: JSON.stringify({ reference, cursor, bytes: 8192 }),
      },
    )
      .then((result) => {
        if (cancelled) {
          if (result.data.nextCursor) releaseCursor(reference, result.data.nextCursor);
          return;
        }
        if (
          result.data.format !== 'health-intake-source-field-fragment-v1' ||
          result.data.reference.intakeId !== reference.intakeId ||
          result.data.reference.sourceHash !== reference.sourceHash ||
          result.data.reference.sourceVersionId !== reference.sourceVersionId ||
          result.data.reference.field !== reference.field ||
          result.data.reference.bytes !== reference.bytes ||
          result.data.reference.scalarHash !== reference.scalarHash
        )
          throw Error('The selected source field changed. Refresh this file.');
        held.current = result.data.nextCursor
          ? { reference, cursor: result.data.nextCursor }
          : null;
        setPage(result.data);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : 'The source field could not load.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cursor, reference]);
  return (
    <details
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (!event.currentTarget.open) {
          releaseHeld();
          setCursor(undefined);
          setPage(null);
        }
      }}
    >
      <summary>{label}</summary>
      {loading && <p role="status">Loading…</p>}
      {error && <p role="alert">{error}</p>}
      {page && (
        <>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{page.text}</pre>
          <button
            type="button"
            disabled={!page.nextCursor || loading}
            onClick={() => setCursor(page.nextCursor ?? undefined)}
          >
            Next
          </button>
        </>
      )}
    </details>
  );
}
