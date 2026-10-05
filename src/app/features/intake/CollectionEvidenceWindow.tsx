import { useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../data/api';
import { useProfile } from '../../data/profile';
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'This evidence could not load.';

/** Generic byte-fragment view keeps one page and validates forward progress. */
export function CollectionEvidenceWindow({
  scope: referenceScope,
  bytes,
  label: heading,
  path,
  body,
  method = 'POST',
  continuation = false,
  onRefresh,
  onInspected,
}: {
  scope: string;
  bytes?: number;
  label: string;
  path: string;
  body: Record<string, unknown>;
  method?: 'GET' | 'POST';
  continuation?: boolean;
  onRefresh: () => void;
  onInspected?: (value: boolean) => void;
}) {
  const profile = useProfile();
  const scope = JSON.stringify([profile?.id, referenceScope, continuation]);
  const [window, setWindow] = useState<{
    text: string;
    next: number | null;
    offset: number;
    total: number;
    cursor?: string | null;
  }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const decoder = useRef(new TextDecoder('utf-8', { fatal: true }));
  const active = useRef(scope);
  const request = useRef<AbortController | null>(null);
  const inspected = useRef(onInspected);
  inspected.current = onInspected;
  active.current = scope;
  useLayoutEffect(() => {
    request.current?.abort();
    active.current = scope;
    setWindow(undefined);
    setError('');
    setBusy(false);
    decoder.current = new TextDecoder('utf-8', { fatal: true });
    inspected.current?.(false);
    return () => {
      request.current?.abort();
      active.current = '';
    };
  }, [scope]);
  async function read() {
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    const offset = window?.next ?? 0;
    const cursor = continuation ? (offset ? window?.cursor : 'start') : undefined;
    if (!offset) {
      decoder.current = new TextDecoder('utf-8', { fatal: true });
      inspected.current?.(false);
    }
    setBusy(true);
    setError('');
    try {
      const { data } = await api<{
        encoding: 'base64' | 'base64-json';
        data: string;
        complete: boolean;
        nextOffset: number | null;
        totalBytes?: number;
        nextCursor?: string | null;
      }>(
        method === 'GET'
          ? `${path}${path.includes('?') ? '&' : '?'}offset=${offset}&bytes=32768${continuation ? `&cursor=${encodeURIComponent(cursor!)}` : ''}`
          : path,
        {
          method,
          signal: controller.signal,
          ...(method === 'POST'
            ? {
                body: JSON.stringify({
                  ...body,
                  offset,
                  bytes: 32768,
                  ...(continuation ? { cursor } : {}),
                }),
              }
            : {}),
        },
      );
      if (controller.signal.aborted || active.current !== scope) return;
      const chunk = Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0)),
        end = offset + chunk.length;
      const total = bytes ?? window?.total ?? data.totalBytes;
      if (
        !['base64', 'base64-json'].includes(data.encoding) ||
        total === undefined ||
        !Number.isSafeInteger(total) ||
        total < 0 ||
        (data.totalBytes !== undefined && data.totalBytes !== total) ||
        chunk.length > 32768 ||
        end > total ||
        data.complete !== (end === total) ||
        (data.complete ? data.nextOffset !== null : data.nextOffset !== end || end <= offset) ||
        (continuation &&
          (data.complete
            ? data.nextCursor !== null
            : typeof data.nextCursor !== 'string' ||
              !data.nextCursor.length ||
              data.nextCursor.length > 2048 ||
              data.nextCursor === 'start' ||
              data.nextCursor === cursor))
      )
        throw new Error('This evidence page changed. Refresh the report.');
      setWindow({
        offset,
        total: total!,
        text: decoder.current.decode(chunk, { stream: !data.complete }),
        next: data.nextOffset,
        ...(continuation ? { cursor: data.nextCursor } : {}),
      });
      inspected.current?.(data.complete);
    } catch (cause) {
      if (!controller.signal.aborted && active.current === scope) {
        setError(message(cause));
        inspected.current?.(false);
      }
    } finally {
      if (!controller.signal.aborted && active.current === scope) setBusy(false);
    }
  }
  return (
    <section aria-label={heading}>
      <h4>{heading}</h4>
      <p>
        {(bytes ?? window?.total)?.toLocaleString() || 'Referenced'} bytes; one evidence page is
        shown at a time.
      </p>
      {window && (
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{window.text}</pre>
      )}
      {error && (
        <p role="alert">
          {error}
          <button className="button secondary" type="button" onClick={onRefresh}>
            Refresh evidence
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
          ? 'Opening evidence…'
          : window?.next
            ? 'Next evidence page'
            : window
              ? 'Read evidence again'
              : 'Open evidence'}
      </button>
    </section>
  );
}
