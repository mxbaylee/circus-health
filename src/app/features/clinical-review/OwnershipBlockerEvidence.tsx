import { useEffect, useRef, useState } from 'react';
import type { OwnershipBlockerReference } from '../../../shared/ownership-report-reference';
import { api } from '../../data/api';
import { useProfile } from '../../data/profile';
import { CollectionEvidenceWindow } from '../intake/CollectionEvidenceWindow';
type Blockers = string[] | OwnershipBlockerReference;
type Fragment = { type: 'contribution-fragment'; ordinal: number; bytes: number; url: string };
type Page = {
  items: (string | Fragment)[];
  total: number;
  complete: boolean;
  after: string | null;
};
export const ownershipBlockerCount = (value: Blockers) =>
  Array.isArray(value) ? value.length : value.count;
export function OwnershipBlockerEvidence({
  blockers,
  disabled,
  onRefresh,
}: {
  blockers: Blockers;
  disabled: boolean;
  onRefresh: () => void;
}) {
  return Array.isArray(blockers) ? (
    <>
      {blockers.map((value, index) => (
        <p role="alert" key={index}>
          {value}
        </p>
      ))}
    </>
  ) : (
    <ReferencedBlockers
      key={JSON.stringify(blockers)}
      reference={blockers}
      disabled={disabled}
      onRefresh={onRefresh}
    />
  );
}
function ReferencedBlockers({
  reference,
  disabled,
  onRefresh,
}: {
  reference: OwnershipBlockerReference;
  disabled: boolean;
  onRefresh: () => void;
}) {
  const profile = useProfile();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ after: '-1', offset: 0 });
  const [state, setState] = useState<{ key: string; data?: Page; error?: string }>();
  const scope = JSON.stringify([profile?.id, reference]);
  const key = JSON.stringify([scope, position]);
  const active = useRef(scope);
  active.current = scope;
  useEffect(() => {
    active.current = scope;
    setOpen(false);
    setPosition({ after: '-1', offset: 0 });
    return () => {
      active.current = '';
    };
  }, [scope]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState({ key });
    void api<Page>(
      reference.url + '&after=' + encodeURIComponent(position.after) + '&limit=16&bytes=65536',
      { signal: controller.signal },
    )
      .then(({ data }) => {
        if (controller.signal.aborted || active.current !== scope) return;
        const end = position.offset + data.items.length;
        if (
          data.total !== reference.count ||
          data.items.length > 16 ||
          end > reference.count ||
          data.complete !== (end === reference.count) ||
          (data.complete
            ? data.after !== null
            : !data.after || data.after === position.after || !data.items.length) ||
          data.items.some(
            (item, index) =>
              typeof item !== 'string' &&
              (item.type !== 'contribution-fragment' ||
                item.ordinal !== position.offset + index ||
                !Number.isSafeInteger(item.bytes) ||
                item.bytes < 0 ||
                !item.url),
          )
        )
          throw new Error(
            'The person assignment requirements changed. Update the correction preview.',
          );
        setState({ key, data });
      })
      .catch((cause) => {
        if (!controller.signal.aborted && active.current === scope)
          setState({
            key,
            error:
              cause instanceof Error
                ? cause.message
                : 'These person assignment requirements could not load.',
          });
      });
    return () => controller.abort();
  }, [key, open]);
  const page = state?.key === key ? state : undefined;
  return (
    <section aria-label="Complete person correction requirements">
      <p role="alert">
        {reference.count.toLocaleString()} person assignment requirements must be resolved before
        this correction can be saved.
      </p>
      <button
        type="button"
        className="button secondary"
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide correction requirements' : 'Inspect correction requirements'}
      </button>
      {open && (
        <>
          {page?.error ? (
            <p role="alert">
              {page.error}
              <button type="button" disabled={disabled} onClick={onRefresh}>
                Update correction evidence
              </button>
            </p>
          ) : !page?.data ? (
            <p role="status">Opening correction requirements…</p>
          ) : (
            <>
              <p>
                {position.offset + 1}–{position.offset + page.data.items.length} of{' '}
                {reference.count.toLocaleString()} requirements; one page is shown at a time.
              </p>
              {page.data.items.map((item, index) =>
                typeof item === 'string' ? (
                  <p key={index}>{item}</p>
                ) : (
                  <CollectionEvidenceWindow
                    key={JSON.stringify([scope, item])}
                    scope={JSON.stringify([scope, item])}
                    bytes={item.bytes}
                    label={`Person correction requirement ${item.ordinal + 1}`}
                    path={item.url + '&ordinal=' + item.ordinal}
                    method="GET"
                    body={{}}
                    onRefresh={() => {
                      if (!disabled) onRefresh();
                    }}
                  />
                ),
              )}
              {!page.data.complete && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={disabled}
                  onClick={() =>
                    setPosition({
                      after: page.data!.after!,
                      offset: position.offset + page.data!.items.length,
                    })
                  }
                >
                  Next correction requirements
                </button>
              )}
              {position.offset > 0 && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={disabled}
                  onClick={() => setPosition({ after: '-1', offset: 0 })}
                >
                  First correction requirements
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
