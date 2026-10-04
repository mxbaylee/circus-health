import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  IntakeImportCorrection,
  IntakeIssueResolution,
  IntakeReviewDraftHistory,
} from '../../../shared/intake';
import { api } from '../../data/api';
import { useProfile } from '../../data/profile';

type Section = 'resolutions' | 'corrections';
type HistoryItem =
  | { ordinal: number; value: IntakeIssueResolution | IntakeImportCorrection }
  | { ordinal: number; reference: IntakeReviewDraftHistory; section: Section };
interface HistoryPage {
  format: 'health-intake-review-history-page-v1';
  reference: IntakeReviewDraftHistory;
  section: Section;
  items: HistoryItem[];
  total: number;
  complete: boolean;
  nextOffset: number | null;
}
const referenceKey = (history: IntakeReviewDraftHistory) =>
  JSON.stringify(Object.entries(history).sort(([a], [b]) => a.localeCompare(b)));
const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : 'Review history could not load. Refresh the record and try again.';

/** History is independent of the bounded policy witnesses used by the current editor. */
export function ReviewDraftHistory({
  history,
  initialSection = 'resolutions',
}: {
  history: IntakeReviewDraftHistory | undefined;
  initialSection?: Section;
}) {
  const [open, setOpen] = useState(false);
  if (!history) return null;
  return (
    <section aria-label="Saved review history" className="intake-processing-details">
      <p>
        {history.resolutions.toLocaleString()} saved question decisions ·{' '}
        {history.corrections.toLocaleString()} saved mapping corrections
      </p>
      <button className="button secondary" type="button" onClick={() => setOpen((value) => !value)}>
        {open ? 'Hide review history' : 'View review history'}
      </button>
      {open && (
        <HistoryPages
          key={referenceKey(history)}
          history={history}
          initialSection={initialSection}
        />
      )}
    </section>
  );
}
function HistoryPages({
  history,
  initialSection,
}: {
  history: IntakeReviewDraftHistory;
  initialSection: Section;
}) {
  const profile = useProfile();
  const [section, setSection] = useState<Section>(initialSection);
  const [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const scope = JSON.stringify([profile?.id, referenceKey(history), section, offset]);
  const [state, setState] = useState<{ scope: string; data?: HistoryPage; error?: string }>({
    scope,
  });
  useEffect(() => {
    const controller = new AbortController();
    setState({ scope });
    void api<HistoryPage>(`/intakes/${encodeURIComponent(history.intakeId)}/review-history`, {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ reference: history, section, offset, limit: 20 }),
    })
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        const end = offset + data.items.length;
        if (
          data.format !== 'health-intake-review-history-page-v1' ||
          referenceKey(data.reference) !== referenceKey(history) ||
          data.section !== section ||
          data.total !== history[section] ||
          data.items.length > 20 ||
          end > data.total ||
          data.complete !== (end === data.total) ||
          (data.complete ? data.nextOffset !== null : data.nextOffset !== end || end <= offset) ||
          data.items.some(
            (item, index) =>
              item.ordinal !== offset + index ||
              ('reference' in item &&
                (referenceKey(item.reference) !== referenceKey(history) ||
                  item.section !== section)),
          )
        )
          throw new Error(
            'This history page does not match the selected review. Refresh the record.',
          );
        setState({ scope, data });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setState({ scope, error: message(cause) });
      });
    return () => controller.abort();
  }, [scope, history, section, offset, revision]);
  const current = state.scope === scope ? state : undefined;
  return (
    <section aria-label="Review history pages">
      <label>
        History type
        <select
          value={section}
          onChange={(event) => {
            setSection(event.target.value as Section);
            setOffset(0);
          }}
        >
          <option value="resolutions">Question decisions</option>
          <option value="corrections">Mapping corrections</option>
        </select>
      </label>
      {current?.error ? (
        <p role="alert">
          {current.error}
          <button
            className="button secondary"
            type="button"
            onClick={() => {
              setOffset(0);
              setRevision((value) => value + 1);
            }}
          >
            Reload history
          </button>
        </p>
      ) : !current?.data ? (
        <p role="status">Opening review history…</p>
      ) : (
        <>
          <p>
            {current.data.total.toLocaleString()} entries in this complete history. Showing{' '}
            {current.data.items.length ? offset + 1 : 0}–{offset + current.data.items.length}.
          </p>
          {current.data.items.map((item) => (
            <article key={item.ordinal}>
              <h4>
                {section === 'resolutions' ? 'Question decision' : 'Mapping correction'}{' '}
                {item.ordinal + 1}
              </h4>
              {'value' in item ? (
                <HistoryValue value={item.value} />
              ) : (
                <HistoryFragment history={history} section={section} ordinal={item.ordinal} />
              )}
            </article>
          ))}
          {current.data.nextOffset !== null && (
            <button
              className="button secondary"
              type="button"
              onClick={() => setOffset(current.data!.nextOffset!)}
            >
              Next history page
            </button>
          )}
          {offset > 0 && (
            <button className="button secondary" type="button" onClick={() => setOffset(0)}>
              First history page
            </button>
          )}
        </>
      )}
    </section>
  );
}
function HistoryValue({ value }: { value: IntakeIssueResolution | IntakeImportCorrection }) {
  if ('issueId' in value)
    return (
      <>
        <p>
          Question: {value.issueId} · Decision: {value.outcome.replaceAll('_', ' ')}
        </p>
        {value.mapping && (
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {JSON.stringify(value.mapping, null, 2)}
          </pre>
        )}
      </>
    );
  return (
    <>
      <p>
        {value.at} · {value.reason}
      </p>
      <h5>Before</h5>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {JSON.stringify(value.before, null, 2)}
      </pre>
      <h5>After</h5>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {JSON.stringify(value.after, null, 2)}
      </pre>
    </>
  );
}
function HistoryFragment({
  history,
  section,
  ordinal,
}: {
  history: IntakeReviewDraftHistory;
  section: Section;
  ordinal: number;
}) {
  const profile = useProfile();
  const scope = JSON.stringify([profile?.id, referenceKey(history), section, ordinal]);
  const active = useRef(scope);
  active.current = scope;
  const controller = useRef<AbortController | undefined>(undefined);
  const decoder = useRef(new TextDecoder('utf-8', { fatal: true }));
  const [state, setState] = useState<{
    scope: string;
    text: string;
    complete: boolean;
    next: string | null;
  }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useLayoutEffect(() => {
    controller.current?.abort();
    decoder.current = new TextDecoder('utf-8', { fatal: true });
    setState(undefined);
    setError('');
    setBusy(false);
    return () => controller.current?.abort();
  }, [scope]);
  const window = state?.scope === scope ? state : undefined;
  async function read() {
    if (busy) return;
    const cursor = window?.next || undefined;
    if (!cursor) decoder.current = new TextDecoder('utf-8', { fatal: true });
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    try {
      const { data } = await api<{
        encoding: 'base64';
        data: string;
        complete: boolean;
        nextCursor: string | null;
      }>(`/intakes/${encodeURIComponent(history.intakeId)}/review-history-fragment`, {
        method: 'POST',
        signal: request.signal,
        body: JSON.stringify({
          reference: history,
          section,
          ordinal,
          ...(cursor ? { cursor } : {}),
        }),
      });
      if (active.current !== scope || request.signal.aborted) return;
      const bytes = Uint8Array.from(atob(data.data), (value) => value.charCodeAt(0));
      if (
        data.encoding !== 'base64' ||
        typeof data.complete !== 'boolean' ||
        bytes.length > 32768 ||
        (data.complete
          ? data.nextCursor !== null
          : !bytes.length ||
            typeof data.nextCursor !== 'string' ||
            data.nextCursor.length > 2048 ||
            !data.nextCursor ||
            data.nextCursor === cursor)
      )
        throw new Error('This history fragment did not advance. Reload the selected history.');
      setState({
        scope,
        text: decoder.current.decode(bytes, { stream: !data.complete }),
        complete: data.complete,
        next: data.nextCursor,
      });
    } catch (cause) {
      if (active.current === scope && !request.signal.aborted) setError(message(cause));
    } finally {
      if (active.current === scope && !request.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label={`History entry ${ordinal + 1} evidence`}>
      <p>This entry has additional evidence. One page is shown at a time.</p>
      {window && (
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{window.text}</pre>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        className="button secondary"
        type="button"
        disabled={busy}
        onClick={() => void read()}
      >
        {busy
          ? 'Opening history evidence…'
          : window?.next
            ? 'Next history evidence page'
            : window?.complete
              ? 'Read history evidence again'
              : 'Open history evidence'}
      </button>
    </section>
  );
}
