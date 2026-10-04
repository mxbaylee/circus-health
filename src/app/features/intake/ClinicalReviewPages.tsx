import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { IntakeCoverageGap, IntakeSourceContext } from '../../../shared/intake';
import {
  isClinicalReviewPage,
  type IntakeClinicalReviewFragment,
  type IntakeClinicalReviewPage,
  type IntakeClinicalReviewRead,
  type IntakeClinicalReviewReference,
  type IntakeClinicalReviewSection,
} from '../../../shared/intake-clinical-review';
import { api, useResource } from '../../data/api';
import { useProfile } from '../../data/profile';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import { SourceContextNotes } from './SourceContextNotes';

const fragmentBytes = 32768;
/** One decoded window remains mounted. A giant item never becomes an accumulated JSON value. */
export function ClinicalReviewReference({
  intakeId,
  proposalId,
  reference,
  onRefresh,
  onInspected,
}: {
  intakeId: string;
  proposalId: string | null;
  reference: IntakeClinicalReviewReference;
  onRefresh: () => void;
  onInspected?: (complete: boolean) => void;
}) {
  return (
    <ClinicalEvidenceWindow
      endpoint={`/intakes/${encodeURIComponent(intakeId)}/review-fragment`}
      reference={reference}
      requestFields={{ proposalId }}
      onRefresh={onRefresh}
      onInspected={onInspected}
    />
  );
}

/** Shared transport for exact evidence references, retaining only one decoded byte window. */
export function ClinicalEvidenceWindow({
  endpoint,
  reference,
  requestFields,
  onRefresh,
  onInspected,
}: {
  endpoint: string;
  reference: { bytes: number };
  requestFields?: Record<string, unknown>;
  onRefresh: () => void;
  onInspected?: (complete: boolean) => void;
}) {
  const profile = useProfile();
  const scope = JSON.stringify([profile?.id, endpoint, requestFields, reference]);
  const active = useRef(scope);
  active.current = scope;
  const decoder = useRef(new TextDecoder('utf-8', { fatal: true }));
  const [window, setWindow] = useState<{
    scope: string;
    text: string;
    offset: number;
    next: number | null;
    complete: boolean;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const inspected = useRef(onInspected);
  inspected.current = onInspected;
  useLayoutEffect(() => {
    request.current?.abort();
    decoder.current = new TextDecoder('utf-8', { fatal: true });
    setWindow(undefined);
    setBusy(false);
    setError('');
    inspected.current?.(false);
    return () => request.current?.abort();
  }, [scope]);
  async function read(offset: number) {
    if (busy) return;
    const captured = scope;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    if (offset === 0) {
      decoder.current = new TextDecoder('utf-8', { fatal: true });
      inspected.current?.(false);
    }
    try {
      const { data } = await api<IntakeClinicalReviewFragment>(endpoint, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ ...requestFields, reference, offset, bytes: fragmentBytes }),
      });
      if (active.current !== captured || controller.signal.aborted) return;
      const bytes = Uint8Array.from(atob(data.data), (char) => char.charCodeAt(0));
      const end = offset + bytes.length;
      if (
        data.encoding !== 'base64' ||
        bytes.length > fragmentBytes ||
        end > reference.bytes ||
        data.complete !== (end === reference.bytes) ||
        (data.complete ? data.nextOffset !== null : data.nextOffset !== end || end <= offset)
      )
        throw new Error('This evidence fragment changed. Refresh the exact review.');
      const text = decoder.current.decode(bytes, { stream: !data.complete });
      setWindow({ scope: captured, text, offset, next: data.nextOffset, complete: data.complete });
      inspected.current?.(data.complete);
    } catch (cause) {
      if (active.current === captured && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Unable to open this evidence fragment.');
        inspected.current?.(false);
      }
    } finally {
      if (active.current === captured && !controller.signal.aborted) setBusy(false);
    }
  }
  const current = window?.scope === scope ? window : undefined;
  return (
    <section aria-label="Selected evidence pages" className="intake-processing-details">
      <p>
        This exact item contains {reference.bytes.toLocaleString()} bytes. Read its evidence one
        page at a time.
      </p>
      {error && <p role="alert">{error}</p>}
      {current && (
        <>
          <p role="status">
            Bytes {current.offset + 1}–{Math.min(reference.bytes, current.offset + fragmentBytes)}{' '}
            of {reference.bytes}
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{current.text}</pre>
        </>
      )}
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() => void read(current?.next ?? 0)}
      >
        {busy
          ? 'Opening evidence…'
          : current?.next
            ? 'Next evidence page'
            : current?.complete
              ? 'Read evidence again'
              : 'Open evidence'}
      </button>
      {current?.complete && <p role="status">All pages of this exact item have been opened.</p>}
      {error && (
        <button type="button" className="button secondary" onClick={onRefresh}>
          Refresh exact review
        </button>
      )}
    </section>
  );
}

export function ClinicalReviewSection({
  intakeId,
  proposalId,
  section,
}: {
  intakeId: string;
  proposalId: string | null;
  section: IntakeClinicalReviewSection;
}) {
  const [cursor, setCursor] = useState<string>();
  const query = new URLSearchParams({ section, limit: '40', bytes: '65536' });
  if (proposalId) query.set('proposalId', proposalId);
  if (cursor) query.set('cursor', cursor);
  const resource = useResource<IntakeClinicalReviewRead>(
    `/intakes/${encodeURIComponent(intakeId)}/review?${query}`,
  );
  useEffect(() => setCursor(undefined), [intakeId, proposalId, section]);
  if (resource.loading && !resource.data)
    return <LoadingIndicator label="Opening review evidence…" />;
  if (resource.error)
    return (
      <div role="alert">
        {resource.error.message}
        <button
          onClick={() => {
            setCursor(undefined);
            resource.reload();
          }}
        >
          Refresh review evidence
        </button>
      </div>
    );
  if (!resource.data) return null;
  const data = resource.data;
  const page: IntakeClinicalReviewPage | undefined = isClinicalReviewPage(data) ? data : undefined;
  if ('format' in data && !page)
    return <p role="alert">The server returned an unexpected review section.</p>;
  const items = page
    ? page.items
    : 'records' in data
      ? (data[section] || []).map((value, ordinal) => ({ kind: 'value' as const, ordinal, value }))
      : [];
  return (
    <section
      aria-label={section === 'sourceContext' ? 'Source context pages' : 'Coverage gap pages'}
    >
      {page && (
        <p>
          {page.total.toLocaleString()}{' '}
          {section === 'sourceContext' ? 'source notes' : 'coverage gaps'} in this complete review.
        </p>
      )}
      {items.map((item) =>
        item.kind === 'reference' ? (
          <ClinicalReviewReference
            key={`${page?.reviewToken}:${item.reference.ordinal}`}
            intakeId={intakeId}
            proposalId={proposalId}
            reference={item.reference}
            onRefresh={() => {
              setCursor(undefined);
              resource.reload();
            }}
          />
        ) : section === 'sourceContext' ? (
          <SourceContextNotes key={item.ordinal} items={[item.value as IntakeSourceContext]} />
        ) : (
          <p key={item.ordinal}>
            <strong>{(item.value as IntakeCoverageGap).label}</strong>:{' '}
            {(item.value as IntakeCoverageGap).detail}
          </p>
        ),
      )}
      {page?.nextCursor && (
        <button
          type="button"
          className="button secondary"
          disabled={resource.loading || resource.refreshing}
          onClick={() => setCursor(page.nextCursor!)}
        >
          Next {section === 'sourceContext' ? 'source notes' : 'coverage gaps'}
        </button>
      )}
      {cursor && (
        <button type="button" className="text-link" onClick={() => setCursor(undefined)}>
          First page
        </button>
      )}
    </section>
  );
}
export function ClinicalReviewSections(props: { intakeId: string; proposalId: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="intake-processing-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Transcription notes and coverage</summary>
      <p>Whole-file reading progress is tracked separately from these review notes.</p>
      {open && (
        <>
          <ClinicalReviewSection {...props} section="sourceContext" />
          <ClinicalReviewSection {...props} section="coverageGaps" />
        </>
      )}
    </details>
  );
}
