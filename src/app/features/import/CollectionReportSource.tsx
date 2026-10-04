import { useEffect, useRef, useState } from 'react';
import type {
  IntakeReportSourceReviewV2,
  IntakeReportSourceScopeFragment,
} from '../../../shared/intake-report-source-review';
import type { IntakeReportSourceUpdate } from '../../../shared/intake';
import { api, useResource, ApiError } from '../../data/api';
import { useProfile } from '../../data/profile';

/** The report-wide action binds the complete displayed scope; pages are evidence windows. */
export function CollectionReportSource({
  intakeId,
  groupId,
  onChanged,
  initiallyOpen = false,
  onPending,
}: {
  intakeId: string;
  groupId: string;
  onChanged: () => void;
  initiallyOpen?: boolean;
  onPending?: (pending: boolean) => void;
}) {
  const profile = useProfile();
  const [open, setOpen] = useState(initiallyOpen),
    [source, setSource] = useState('');
  const [cursor, setCursor] = useState<string>(),
    [evidenceCursor, setEvidenceCursor] = useState<string>(),
    [sourceCursor, setSourceCursor] = useState<string>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const query = new URLSearchParams({ groupId, view: 'all', limit: '30' });
  if (cursor) query.set('cursor', cursor);
  if (evidenceCursor) query.set('evidenceCursor', evidenceCursor);
  if (sourceCursor) query.set('sourceCursor', sourceCursor);
  const path = `/intakes/${encodeURIComponent(intakeId)}/report-source-review?${query}`;
  const resource = useResource<IntakeReportSourceReviewV2>(open ? path : null);
  const request = useRef<{ key: string; body: IntakeReportSourceUpdate } | undefined>(undefined);
  const scope = JSON.stringify([profile?.id, intakeId, groupId]);
  const current = useRef(scope);
  current.current = scope;
  useEffect(() => {
    request.current = undefined;
    setSource('');
    setError('');
    setNotice('');
    setCursor(undefined);
    setSourceCursor(undefined);
    setEvidenceCursor(undefined);
    return () => {
      current.current = '';
    };
  }, [scope]);
  const refresh = () => {
    setCursor(undefined);
    setSourceCursor(undefined);
    setEvidenceCursor(undefined);
    resource.reload();
  };
  const pendingListener = useRef(onPending);
  pendingListener.current = onPending;
  useEffect(() => {
    pendingListener.current?.(busy || !!request.current);
  }, [busy, error, scope]);
  useEffect(() => () => pendingListener.current?.(false), []);
  const data = resource.data;
  async function save() {
    if (busy || !data || resource.refreshing || !source.trim()) return;
    const key = JSON.stringify([data.scopeToken, source.trim()]);
    const body = request.current
      ? request.current.body
      : {
          version: data.intakeVersion,
          operationId: crypto.randomUUID(),
          groupId: data.groupId,
          groupVersionId: data.groupVersionId,
          contextId: data.groupVersionId,
          source: source.trim(),
          scopeToken: data.scopeToken,
          view: data.view,
        };
    request.current = { key, body };
    setBusy(true);
    setError('');
    try {
      await api(`/intakes/${encodeURIComponent(intakeId)}/report-source`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (current.current !== scope) return;
      request.current = undefined;
      setNotice(`Source label saved for ${data.targets.total} records.`);
      refresh();
      onChanged();
    } catch (cause) {
      if (current.current !== scope) return;
      if (
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        ![408, 429].includes(cause.status)
      ) {
        request.current = undefined;
        refresh();
      }
      setError(
        cause instanceof Error
          ? cause.message
          : 'The source label could not be confirmed. Retry this exact action.',
      );
    } finally {
      if (current.current === scope) setBusy(false);
    }
  }
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Source label for this report</summary>
      {open && (
        <>
          <p>
            Review the affected records and retained evidence before applying one source label to
            this report.
          </p>
          {(error || resource.error) && (
            <p role="alert">
              {error || resource.error?.message}
              <button className="button secondary" type="button" onClick={refresh}>
                Refresh affected records
              </button>
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {resource.loading && <p role="status">Opening affected source records…</p>}
          {data?.format === 'health-intake-report-source-review-v2' && (
            <>
              <p>
                {data.targets.total} records in this complete scope; {data.coverage.covered} already
                source-labeled and {data.coverage.uncovered} without a reviewed label.
              </p>
              {data.conflictingSourceEvidence && (
                <p role="alert">
                  Retained evidence names different sources. Check the originals before choosing one
                  label.
                </p>
              )}
              <ul>
                {data.targets.items.map((target) => (
                  <li key={`${target.candidateId}:${target.candidateVersionId}`}>
                    <strong>
                      {target.detail.state === 'available'
                        ? target.detail.title
                        : 'Record with paged evidence'}
                    </strong>
                    <SourceScopeEvidence reference={target.evidence} onRefresh={refresh} />
                  </li>
                ))}
              </ul>
              {data.targets.nextCursor && (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setCursor(data.targets.nextCursor!)}
                >
                  Next affected records
                </button>
              )}
              <ul>
                {data.sourceEvidence.items.map((item) => (
                  <li key={`${item.evidence.ordinal}`}>
                    <p>
                      {item.preview}
                      {item.truncated ? '…' : ''}
                    </p>
                    <SourceScopeEvidence reference={item.evidence} onRefresh={refresh} />
                  </li>
                ))}
              </ul>
              {data.sourceEvidence.nextCursor && (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setEvidenceCursor(data.sourceEvidence.nextCursor!)}
                >
                  Next source evidence
                </button>
              )}
              <ul>
                {data.coverage.bySource.items.map((item) => (
                  <li key={item.source}>
                    {item.source}: {item.count} records
                  </li>
                ))}
              </ul>
              {data.coverage.bySource.nextCursor && (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setSourceCursor(data.coverage.bySource.nextCursor!)}
                >
                  Next current source labels
                </button>
              )}
              {(cursor || sourceCursor || evidenceCursor) && (
                <button className="button secondary" type="button" onClick={refresh}>
                  First source pages
                </button>
              )}
              <label>
                Source
                <input
                  value={source}
                  maxLength={200}
                  disabled={busy || !!request.current}
                  onChange={(event) => setSource(event.target.value)}
                />
              </label>
              <button
                className="button secondary"
                type="button"
                disabled={busy || resource.refreshing || !data.targets.total || !source.trim()}
                onClick={() => void save()}
              >
                {busy ? 'Saving source…' : `Use source for ${data.targets.total} records`}
              </button>
            </>
          )}
        </>
      )}
    </details>
  );
}
function SourceScopeEvidence({
  reference,
  onRefresh,
}: {
  reference: IntakeReportSourceScopeFragment;
  onRefresh: () => void;
}) {
  const profile = useProfile();
  const [state, setState] = useState<{ text: string; next: number | null; total: number }>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const scope = JSON.stringify([profile?.id, reference]),
    current = useRef(scope);
  current.current = scope;
  useEffect(() => {
    setState(undefined);
    setError('');
    setBusy(false);
    return () => {
      current.current = '';
    };
  }, [scope]);
  async function read() {
    if (busy) return;
    setBusy(true);
    setError('');
    const offset = state?.next ?? 0;
    try {
      const { data } = await api<{
        text: string;
        offset: number;
        totalBytes: number;
        nextOffset: number | null;
        complete: boolean;
      }>(`/intakes/${encodeURIComponent(reference.intakeId)}/report-source-fragment`, {
        method: 'POST',
        body: JSON.stringify({ ...reference, offset, limit: 32768 }),
      });
      if (current.current !== scope) return;
      const bytes = new TextEncoder().encode(data.text).length,
        end = offset + bytes;
      if (
        data.offset !== offset ||
        bytes > 32768 ||
        end > data.totalBytes ||
        data.complete !== (end === data.totalBytes) ||
        (data.complete ? data.nextOffset !== null : data.nextOffset !== end || end <= offset)
      )
        throw new Error('Source evidence changed. Refresh this review.');
      setState({ text: data.text, next: data.nextOffset, total: data.totalBytes });
    } catch (cause) {
      if (current.current === scope)
        setError(cause instanceof Error ? cause.message : 'Unable to open source evidence.');
    } finally {
      if (current.current === scope) setBusy(false);
    }
  }
  return (
    <section>
      {state && (
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{state.text}</pre>
      )}
      {error && (
        <p role="alert">
          {error}
          <button className="button secondary" type="button" onClick={onRefresh}>
            Refresh source review
          </button>
        </p>
      )}
      <button
        className="button secondary"
        type="button"
        disabled={busy}
        onClick={() => void read()}
      >
        {busy
          ? 'Opening source evidence…'
          : state?.next
            ? 'Next source evidence page'
            : state
              ? 'Read source evidence again'
              : 'Open source evidence'}
      </button>
    </section>
  );
}
