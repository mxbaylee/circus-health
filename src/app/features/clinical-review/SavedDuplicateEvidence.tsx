import { useEffect, useRef, useState } from 'react';
import { api } from '../../data/api';
import { useProfile } from '../../data/profile';
import type {
  SavedDuplicateEvidenceReference,
  SavedDuplicateEvidencePage,
} from '../../../shared/saved-duplicate-evidence';

export function SavedDuplicateEvidence({
  reference,
}: {
  reference: SavedDuplicateEvidenceReference;
}) {
  const profile = useProfile();
  return (
    <SavedEvidenceReader key={JSON.stringify([profile?.id, reference])} reference={reference} />
  );
}
const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function SavedEvidenceReader({ reference }: { reference: SavedDuplicateEvidenceReference }) {
  const [{ after, before }, setPosition] = useState({ after: '', before: 0 }),
    [page, setPage] = useState<SavedDuplicateEvidencePage | null>(null),
    [fragment, setFragment] = useState<string | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const request = new AbortController();
    setPage(null);
    setFragment(null);
    setError('');
    api<SavedDuplicateEvidencePage>(reference.url + '&after=' + encodeURIComponent(after), {
      signal: request.signal,
    })
      .then(({ data }) => {
        if (request.signal.aborted) return;
        if (
          !data.reference ||
          Object.keys(reference).some(
            (key) =>
              data.reference[key as keyof SavedDuplicateEvidenceReference] !==
              reference[key as keyof SavedDuplicateEvidenceReference],
          ) ||
          !Array.isArray(data.items) ||
          data.items.length > 16 ||
          data.items.length > reference.count - before ||
          data.complete !== (before + data.items.length === reference.count) ||
          encodedBytes(data) > 73728 ||
          typeof data.complete !== 'boolean' ||
          (data.complete
            ? data.after !== null
            : !data.after || data.after === after || data.after !== data.items.at(-1)?.id) ||
          new Set(data.items.map((item) => item.id)).size !== data.items.length ||
          data.items.some(
            (item) =>
              !item.id ||
              typeof item.id !== 'string' ||
              item.id.length > 2000 ||
              (item.kind === 'value'
                ? !item.value ||
                  encodedBytes(item.value) > 32768 ||
                  typeof item.value.label !== 'string' ||
                  typeof item.value.locator !== 'string' ||
                  !/^\/api\/sources\/[^/?#]+\/content$/.test(item.value.contentUrl)
                : item.kind !== 'fragment' ||
                  !Number.isSafeInteger(item.bytes) ||
                  item.bytes <= 32768 ||
                  item.url !== reference.url + '&item=' + encodeURIComponent(item.id)),
          )
        )
          throw Error('Saved evidence did not match this exact bounded review');
        setPage(data);
      })
      .catch((error) => {
        if (!request.signal.aborted)
          setError(error instanceof Error ? error.message : 'Saved evidence is unavailable');
      });
    return () => {
      request.abort();
    };
  }, [reference.url, after, before]);
  return (
    <section aria-label="Saved original evidence">
      <p>{reference.count} retained evidence items, shown one page at a time.</p>
      {error && <p role="alert">{error}</p>}
      {!page && !error && <p>Loading saved evidence…</p>}
      {page && (
        <>
          <ul>
            {page.items.map((item) => (
              <li key={item.id}>
                {item.kind === 'fragment' ? (
                  fragment === item.id ? (
                    <SavedEvidenceFragment key={item.url} url={item.url} bytes={item.bytes} />
                  ) : (
                    <button type="button" onClick={() => setFragment(item.id)}>
                      Open saved evidence detail ({item.bytes} bytes)
                    </button>
                  )
                ) : (
                  <>
                    <a href={item.value.contentUrl} target="_blank" rel="noreferrer">
                      {item.value.label}
                    </a>{' '}
                    — {item.value.locator}
                    {item.value.original !== undefined && (
                      <pre>{JSON.stringify(item.value.original, null, 2)}</pre>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
          {after && (
            <button type="button" onClick={() => setPosition({ after: '', before: 0 })}>
              First saved evidence page
            </button>
          )}
          {!page.complete && (
            <button
              type="button"
              onClick={() =>
                setPosition({ after: page.after!, before: before + page.items.length })
              }
            >
              Next saved evidence page
            </button>
          )}
        </>
      )}
    </section>
  );
}
function SavedEvidenceFragment({ url, bytes }: { url: string; bytes: number }) {
  const [offset, setOffset] = useState(0),
    [next, setNext] = useState<number | null>(null),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    decoder = useRef(new TextDecoder('utf-8', { fatal: true }));
  useEffect(() => {
    const request = new AbortController();
    setText('');
    setError('');
    setNext(null);
    if (!offset) decoder.current = new TextDecoder('utf-8', { fatal: true });
    api<{ encoding: string; data: string; complete: boolean; nextOffset: number | null }>(
      url + '&offset=' + offset,
      { signal: request.signal },
    )
      .then(({ data }) => {
        if (request.signal.aborted) return;
        const decoded = Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0)),
          end = offset + decoded.byteLength;
        if (
          data.encoding !== 'base64' ||
          decoded.byteLength > 32768 ||
          decoded.byteLength === 0 ||
          end > bytes ||
          data.complete !== (end === bytes) ||
          data.nextOffset !== (end === bytes ? null : end)
        )
          throw Error('Saved evidence fragment did not match this bounded window');
        if (!request.signal.aborted) {
          setText(decoder.current.decode(decoded, { stream: !data.complete }));
          setNext(data.complete ? null : data.nextOffset);
        }
      })
      .catch((error) => {
        if (!request.signal.aborted)
          setError(error instanceof Error ? error.message : 'Saved detail is unavailable');
      });
    return () => {
      request.abort();
    };
  }, [url, offset, bytes]);
  return (
    <section>
      <p>Retained detail ({bytes} bytes), shown one fragment at a time.</p>
      {error && <p role="alert">{error}</p>}
      <pre>{text}</pre>
      {offset > 0 && (
        <button type="button" onClick={() => setOffset(0)}>
          First saved evidence fragment
        </button>
      )}
      {next !== null && (
        <button type="button" onClick={() => setOffset(next)}>
          Next saved evidence fragment
        </button>
      )}
    </section>
  );
}
