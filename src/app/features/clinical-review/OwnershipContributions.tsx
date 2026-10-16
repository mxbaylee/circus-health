import { useEffect, useRef, useState } from 'react';
import { api } from '../../data/api';
import type {
  OwnershipContributionEvidence,
  OwnershipContributionReference,
  OwnershipMatchEvidenceReference,
} from '../../../shared/ownership-report-reference';
import type { OwnershipPreviewRecord } from '../../../shared/record-ownership';

type Fragment = { type: 'contribution-fragment'; ordinal: number; bytes: number; url: string };
type Page = {
  items: (
    | OwnershipContributionEvidence
    | OwnershipPreviewRecord['matches'][number]['evidence'][number]
    | Fragment
  )[];
  total: number;
  complete: boolean;
  after: string | null;
};
export function OwnershipContributions({
  reference,
  ownerName,
  disabled,
}: {
  reference: OwnershipContributionReference | OwnershipMatchEvidenceReference;
  ownerName: string;
  disabled: boolean;
}) {
  const [after, setAfter] = useState('-1'),
    [page, setPage] = useState<Page | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPage(null);
    setError('');
    api<Page>(reference.url + '&after=' + after + '&limit=16&bytes=65536')
      .then(({ data }) => {
        if (active) setPage(data);
      })
      .catch((error) => {
        if (active)
          setError(error instanceof Error ? error.message : 'Source evidence is unavailable');
      });
    return () => {
      active = false;
    };
  }, [reference.url, reference.digest, after]);
  return (
    <section aria-label="Record source contributions">
      <p>
        {reference.total} retained sources
        {'selectedTotal' in reference
          ? '; ' + reference.selectedTotal + ' selected for this correction.'
          : '.'}
      </p>
      {error && <p role="alert">{error}</p>}
      {!page && !error && <p>Loading source evidence…</p>}
      {page && (
        <>
          <ul>
            {page.items.map((item, index) =>
              'type' in item ? (
                <li key={item.ordinal}>
                  <ContributionFragment reference={item} disabled={disabled} />
                </li>
              ) : (
                <li key={item.sourceRecordId || index}>
                  <a href={item.contentUrl} target="_blank" rel="noreferrer">
                    {'label' in item
                      ? item.label
                      : item.selected
                        ? 'Selected source'
                        : 'Source staying with ' + ownerName}
                  </a>{' '}
                  — {typeof item.locator === 'string' ? item.locator : JSON.stringify(item.locator)}
                  {'reportScopes' in item && item.reportScopes.total > 0 && (
                    <span> · {item.reportScopes.total} report memberships</span>
                  )}
                </li>
              ),
            )}
          </ul>
          <button
            type="button"
            disabled={disabled || after === '-1'}
            onClick={() => setAfter('-1')}
          >
            First sources page
          </button>
          {!page.complete && (
            <button
              type="button"
              disabled={disabled || !page.after}
              onClick={() => setAfter(page.after!)}
            >
              Next sources page
            </button>
          )}
        </>
      )}
    </section>
  );
}
function ContributionFragment({ reference, disabled }: { reference: Fragment; disabled: boolean }) {
  const [offset, setOffset] = useState(0),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [next, setNext] = useState<number | null>(null),
    decoder = useRef(new TextDecoder());
  useEffect(() => {
    let active = true;
    setText('');
    setError('');
    setNext(null);
    if (offset === 0) decoder.current = new TextDecoder();
    api<{ data: string; complete: boolean; nextOffset: number }>(
      reference.url + '&ordinal=' + reference.ordinal + '&offset=' + offset + '&bytes=32768',
    )
      .then(({ data }) => {
        if (active) {
          if (!data.complete && data.nextOffset <= offset)
            throw Error('Source evidence did not advance');
          setText(
            decoder.current.decode(
              Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0)),
              { stream: !data.complete },
            ),
          );
          setNext(data.complete ? null : data.nextOffset);
        }
      })
      .catch((error) => {
        if (active)
          setError(error instanceof Error ? error.message : 'Source detail is unavailable');
      });
    return () => {
      active = false;
    };
  }, [reference.url, reference.ordinal, offset]);
  return (
    <section>
      <p>Source detail ({reference.bytes} bytes), shown one fragment at a time.</p>
      {error && <p role="alert">{error}</p>}
      <pre>{text}</pre>
      <button type="button" disabled={disabled || offset === 0} onClick={() => setOffset(0)}>
        First source fragment
      </button>
      {next !== null && (
        <button type="button" disabled={disabled} onClick={() => setOffset(next)}>
          Next source fragment
        </button>
      )}
    </section>
  );
}
