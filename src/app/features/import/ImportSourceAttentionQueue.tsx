import { intakeFilenameDisplay } from '../../../shared/intake-summary';
import { IntakeFilenameDetails } from '../intake/IntakeFilenameDetails';
import { useEffect, useRef, useState } from 'react';
import type { IntakeHeader } from '../../../shared/intake-summary';
import type { SourceAttentionQueue } from '../../../shared/intake-source-text';
import { api, useResource } from '../../data/api';
import { SourceAttentionReview } from './SourceAttentionReview';
import type { SourceBrowserProps } from './ImportSourceTextBrowser';
import './import-source-issues.css';

export function ImportSourceAttentionQueue({
  onChanged,
  guardNavigation = true,
  onPendingChange,
  onAttentionCount,
  attentionRefreshKey,
  onRead,
  readingBlocked,
  onManualCreated,
}: SourceBrowserProps) {
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const resource = useResource<SourceAttentionQueue>('/intakes/source-attention?offset=' + offset);
  const retained = useRef(resource.data);
  if (!pending.size) retained.current = resource.data;
  const queue = pending.size ? retained.current : resource.data;
  const countListener = useRef(onAttentionCount);
  countListener.current = onAttentionCount;
  useEffect(() => {
    if (queue) countListener.current?.(queue.sections);
  }, [queue]);
  const pendingListener = useRef(onPendingChange);
  pendingListener.current = onPendingChange;
  useEffect(() => {
    pendingListener.current?.(pending.size > 0);
  }, [pending]);
  useEffect(() => () => pendingListener.current?.(false), []);
  const refreshKey = useRef(attentionRefreshKey);
  useEffect(() => {
    if (refreshKey.current !== attentionRefreshKey) {
      refreshKey.current = attentionRefreshKey;
      resource.reload();
    }
  }, [attentionRefreshKey, resource.reload]);
  useEffect(() => {
    if (resource.data && offset > 0 && !resource.data.items.length) setOffset(0);
  }, [resource.data, offset]);
  const refresh = () => {
    resource.reload();
    onChanged();
  };
  async function readSource(id: string) {
    if (!onRead || readingBlocked || pending.size) return;
    const seen = new Set<string>();
    while (true) {
      if (seen.has(id) || seen.size >= 100)
        throw new Error('Refresh the source package before reading.');
      seen.add(id);
      const result = await api<IntakeHeader>('/intakes/' + encodeURIComponent(id));
      if (!result.data.parentSourceFileId) {
        await onRead(id);
        return;
      }
      id = result.data.parentSourceFileId;
    }
  }
  return (
    <section className="import-source-sections" aria-label="Source sections needing attention">
      {resource.error && (
        <p role="alert">
          {resource.error.message}{' '}
          <button className="text-link" onClick={resource.reload}>
            Retry source sections
          </button>
        </p>
      )}
      {resource.loading && !resource.data && <p role="status">Loading source sections…</p>}
      {queue?.items.map((item) => (
        <AttentionFile
          guardNavigation={guardNavigation}
          key={item.intakeId}
          id={item.intakeId}
          onChanged={refresh}
          onPendingChange={(value) =>
            setPending((current) => {
              if (current.has(item.intakeId) === value) return current;
              const next = new Set(current);
              if (value) next.add(item.intakeId);
              else next.delete(item.intakeId);
              return next;
            })
          }
          onRead={onRead ? () => readSource(item.intakeId) : undefined}
          readingBlocked={readingBlocked}
          onManualCreated={onManualCreated}
        />
      ))}
      {(offset > 0 || resource.data?.nextOffset != null) && (
        <div className="source-review-toolbar">
          <button
            className="button secondary"
            disabled={!offset || !!pending.size || resource.loading}
            onClick={() => setOffset(Math.max(0, offset - 30))}
          >
            Previous source files
          </button>
          <button
            className="button secondary"
            disabled={resource.data?.nextOffset == null || !!pending.size || resource.loading}
            onClick={() => setOffset(resource.data!.nextOffset!)}
          >
            More source files
          </button>
        </div>
      )}
    </section>
  );
}
function AttentionFile({
  id,
  ...props
}: Omit<React.ComponentProps<typeof SourceAttentionReview>, 'intake'> & { id: string }) {
  const resource = useResource<IntakeHeader>('/intakes/' + encodeURIComponent(id));
  const [remaining, setRemaining] = useState<number | null>(null);
  return (
    <article className="import-report import-source-report" hidden={remaining === 0}>
      {resource.error && <p role="alert">{resource.error.message}</p>}
      {resource.data && (
        <>
          <header className="import-report-title">
            <h3>{intakeFilenameDisplay(resource.data)}</h3>
            {resource.data.filenameReference && (
              <IntakeFilenameDetails reference={resource.data.filenameReference} />
            )}
          </header>
          <SourceAttentionReview
            {...props}
            intake={resource.data}
            onRemainingChange={setRemaining}
          />
        </>
      )}
    </article>
  );
}
