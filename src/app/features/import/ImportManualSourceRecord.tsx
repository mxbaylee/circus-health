import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Note } from '../../../shared/api';
import type { Intake } from '../../../shared/intake';
import type { SourceTextIssueList } from '../../../shared/intake-source-text';
import type {
  ManualSourceRecordRequest,
  ManualSourceRecordResult,
} from '../../../shared/intake-manual-source-record';
import { api, ApiError } from '../../data/api';
import { currentProfile, useProfile } from '../../data/profile';
import { registerProfileTransitionEditor } from '../../data/profile-transition';
import { ReviewNavigationGuard } from '../intake/ReviewWorkspace';
import './import-manual-source-record.css';

interface Props {
  intakeId: string;
  page: number;
  onCreated?: (result: ManualSourceRecordResult) => void;
  onPendingChange?: (pending: boolean) => void;
}
/** An explicit human draft, independent of model output and clinical acceptance. */
export function ImportManualSourceRecord(props: Props) {
  const profile = useProfile();
  return profile ? (
    <ManualSourceRecordForm
      key={`${profile.id}:${props.intakeId}`}
      {...props}
      profileId={profile.id}
    />
  ) : null;
}

function ManualSourceRecordForm({
  intakeId,
  page,
  profileId,
  onCreated,
  onPendingChange,
}: Props & { profileId: string }) {
  const [open, setOpen] = useState(false);
  const [sourcePage, setSourcePage] = useState(page);
  const [snapshot, setSnapshot] = useState<{
    intake: Intake;
    revisionId: string;
    self: Note;
  } | null>(null);
  const [people, setPeople] = useState<Note[]>([]);
  const [query, setQuery] = useState('');
  const [morePeople, setMorePeople] = useState(false);
  const [person, setPerson] = useState<Note | null>(null);
  const [kind, setKind] = useState<'observation' | 'medication' | 'procedure' | 'document'>(
    'observation',
  );
  const [label, setLabel] = useState('');
  const [date, setDate] = useState('');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('');
  const [literal, setLiteral] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [created, setCreated] = useState<ManualSourceRecordResult | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const request = useRef<ManualSourceRecordRequest | null>(null);
  const alive = useRef(true);
  const paused = useRef(false);
  const loadGeneration = useRef(0);
  const pending =
    open &&
    !created &&
    !!(
      loading ||
      busy ||
      uncertain ||
      label ||
      literal ||
      value ||
      unit ||
      date ||
      person ||
      query ||
      kind !== 'observation' ||
      request.current
    );
  const pendingCallback = useRef(onPendingChange);
  pendingCallback.current = onPendingChange;
  const latest = useRef({ pending, save: async () => false });
  const active = () => alive.current && currentProfile()?.id === profileId && !paused.current;
  const endpoint = `/api/profiles/${encodeURIComponent(profileId)}`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    pendingCallback.current?.(pending);
  }, [pending]);
  useEffect(() => () => pendingCallback.current?.(false), []);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (latest.current.pending) event.preventDefault();
    };
    window.addEventListener('beforeunload', unload);
    const unregister = registerProfileTransitionEditor({
      profileId,
      pending: () => latest.current.pending,
      checkReady: (choice) => {
        if (
          choice === 'save' &&
          latest.current.pending &&
          (busy || !snapshot || !person || !label.trim() || !literal.trim())
        )
          throw new Error('Complete the manual record draft before saving.');
      },
      save: async () => {
        if (!(await latest.current.save()))
          throw new Error('The manual record draft could not save.');
      },
      pause: () => {
        paused.current = true;
        return () => {
          paused.current = false;
        };
      },
    });
    return () => {
      window.removeEventListener('beforeunload', unload);
      unregister();
    };
  }, [profileId, busy, snapshot, person, label, literal]);

  async function load() {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError('');
    try {
      const [intake, source, self, choices] = await Promise.all([
        api<Intake>(`${endpoint}/intakes/${encodeURIComponent(intakeId)}`),
        api<SourceTextIssueList>(
          `${endpoint}/intakes/${encodeURIComponent(intakeId)}/source-issues?limit=1`,
        ),
        api<Note>(`${endpoint}/notes/patient`),
        api<Note[]>(`${endpoint}/notes?kind=person&excludeSelf=1&limit=100`),
      ]);
      if (!active() || generation !== loadGeneration.current) return;
      if (!source.data.revisionId)
        throw new Error('Extract this source first so the record can reference its retained page.');
      setSnapshot({ intake: intake.data, revisionId: source.data.revisionId, self: self.data });
      setPeople(choices.data);
      setMorePeople(Number(choices.meta?.total || 0) > choices.data.length);
      // Refreshing never silently reuses a changed person choice.
      setPerson(null);
      request.current = null;
      setUncertain(false);
      setNeedsRefresh(false);
    } catch (cause) {
      if (active() && generation === loadGeneration.current)
        setError(cause instanceof Error ? cause.message : 'Source details could not load.');
    } finally {
      if (active() && generation === loadGeneration.current) setLoading(false);
    }
  }
  async function searchPeople() {
    setLoading(true);
    const generation = ++loadGeneration.current;
    try {
      const choices = await api<Note[]>(
        `${endpoint}/notes?kind=person&excludeSelf=1&limit=100&q=${encodeURIComponent(query)}`,
      );
      if (!active() || generation !== loadGeneration.current) return;
      setPeople(choices.data);
      setMorePeople(Number(choices.meta?.total || 0) > choices.data.length);
    } catch (cause) {
      if (active()) setError(cause instanceof Error ? cause.message : 'People could not load.');
    } finally {
      if (active() && generation === loadGeneration.current) setLoading(false);
    }
  }
  async function save(): Promise<boolean> {
    if (
      busy ||
      loading ||
      needsRefresh ||
      !active() ||
      !snapshot ||
      !person ||
      !label.trim() ||
      !literal.trim()
    )
      return false;
    if (!request.current) {
      request.current = {
        version: snapshot.intake.version,
        operationId: crypto.randomUUID(),
        sourceHash: snapshot.intake.sha256,
        sourceTextRevisionId: snapshot.revisionId,
        scope: { page: sourcePage },
        person: person.isSelf
          ? { kind: 'self', expectedVersion: person.version }
          : { kind: 'person', noteId: person.id, expectedVersion: person.version },
        literalText: literal,
        clinical: {
          kind,
          date,
          ...(kind === 'observation'
            ? { testLabel: label, valueText: value, unit }
            : kind === 'medication'
              ? { medicationName: label, doseText: value }
              : kind === 'procedure'
                ? { procedureLabel: label }
                : { documentTitle: label, text: literal }),
        },
      };
    }
    setBusy(true);
    setError('');
    try {
      const response = await api<ManualSourceRecordResult>(
        `${endpoint}/intakes/${encodeURIComponent(intakeId)}/source-records`,
        { method: 'POST', body: JSON.stringify(request.current) },
      );
      if (!active()) return false;
      request.current = null;
      setUncertain(false);
      setCreated(response.data);
      latest.current.pending = false;
      onCreated?.(response.data);
      return true;
    } catch (cause) {
      if (!active()) return false;
      setError(cause instanceof Error ? cause.message : 'The review draft could not be created.');
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
        request.current = null;
        setUncertain(false);
        if (cause.status === 409) setNeedsRefresh(true);
      } else setUncertain(true);
      return false;
    } finally {
      if (active()) setBusy(false);
    }
  }
  latest.current = { pending, save };
  const selectedChoices =
    person && !person.isSelf && !people.some((item) => item.id === person.id)
      ? [person, ...people]
      : people;
  if (!open)
    return (
      <button
        type="button"
        className="button secondary"
        onClick={() => {
          setSourcePage(page);
          setOpen(true);
          void load();
        }}
      >
        Add record from this section
      </button>
    );
  if (created)
    return (
      <div role="status">
        <p>Review draft created. No clinical record has been saved.</p>
        <Link to={created.reviewUrl}>Review the new record</Link>
        <button
          type="button"
          className="text-link"
          onClick={() => {
            setOpen(false);
            setCreated(null);
            setLabel('');
            setLiteral('');
            setValue('');
            setUnit('');
            setDate('');
          }}
        >
          Add another record
        </button>
      </div>
    );
  return (
    <section className="import-manual-source-record" aria-label="Add record from source">
      <ReviewNavigationGuard pending={() => latest.current.pending} flush={save} />
      <h3>Add record from page {sourcePage}</h3>
      <p>This creates a review draft authored by you. Clinical acceptance is separate.</p>
      {loading && <p role="status">Loading current source and People…</p>}
      {error && <p role="alert">{error}</p>}
      {(needsRefresh || (!snapshot && !loading)) && (
        <button type="button" className="button secondary" onClick={() => void load()}>
          Reload source and person choices
        </button>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy || loading || uncertain || needsRefresh}>
          <label>
            Find a person
            <input value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button type="button" className="text-link" onClick={() => void searchPeople()}>
            Search People
          </button>
          {morePeople && (
            <small>More People are available. Search by name to narrow the list.</small>
          )}
          <label>
            Person
            <select
              required
              value={person?.id || ''}
              onChange={(event) =>
                setPerson(
                  event.target.value === snapshot?.self.id
                    ? snapshot.self
                    : selectedChoices.find((item) => item.id === event.target.value) || null,
                )
              }
            >
              <option value="">Choose person</option>
              {snapshot && <option value={snapshot.self.id}>Me (Self)</option>}
              {selectedChoices.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.person.fullName || item.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Record type
            <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
              <option value="observation">Test result</option>
              <option value="medication">Medication</option>
              <option value="procedure">Procedure</option>
              <option value="document">Document</option>
            </select>
          </label>
          <label>
            Label
            <input
              required
              maxLength={1000}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label>
            Date (leave blank if unknown)
            <input
              placeholder="YYYY-MM-DD"
              maxLength={100}
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          {(kind === 'observation' || kind === 'medication') && (
            <label>
              {kind === 'observation' ? 'Value as printed' : 'Dose as printed'}
              <input
                required={kind === 'observation'}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
          )}
          {kind === 'observation' && (
            <label>
              Unit (leave blank if unknown)
              <input value={unit} onChange={(event) => setUnit(event.target.value)} />
            </label>
          )}
          <label>
            Literal source wording
            <textarea
              required
              maxLength={64000}
              rows={4}
              value={literal}
              onChange={(event) => setLiteral(event.target.value)}
            />
          </label>
        </fieldset>
        {uncertain && (
          <p>
            The response was interrupted. Retry the same request to check the retained draft before
            editing.
          </p>
        )}
        <button
          className="button primary"
          disabled={
            busy ||
            loading ||
            needsRefresh ||
            !snapshot ||
            !person ||
            !label.trim() ||
            !literal.trim()
          }
        >
          {busy
            ? 'Creating review draft…'
            : uncertain
              ? 'Retry draft creation'
              : 'Create review draft'}
        </button>
      </form>
    </section>
  );
}
