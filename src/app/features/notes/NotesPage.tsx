import { usePersonScope } from '../../components/PersonScope';
import {
  ClinicalRedirect,
  isReclassifiedRecord,
  currentClinicalRecord,
} from '../../components/ClinicalRedirect';
import type { ReclassifiedRecord } from '../../../shared/api';
import { notifySuccess } from '../../components/Toasts';
import { PersonIcon } from '../../components/PersonIcon';
import { CollectionTabs, CollectionToolbar } from '../../components/CollectionLayout';
import { useAssistantSelection } from '../assistant/pageContext';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  BookOpen,
  CalendarDays,
  CircleUserRound,
  FilePenLine,
  History,
  Pin,
  Plus,
} from 'lucide-react';
import type { HistoricalNote, HistoricalNoteOptions, Note, NoteKind } from '../../../shared/api';
import { useResource } from '../../data/api';
import { formatDate as formatRecordDate } from '../../data/format';
import { ProviderNoteDetail } from './ProviderNoteDetail';
import { NoteEditor } from './NoteEditor';
import { PersonTagChips } from './PeopleTags';
import { CompactFilters } from './CompactFilters';
import { PeopleFilters } from './PeopleFilters';
import { CollectionFilters, visibilityFilter } from '../../components/CollectionFilters';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import {
  filtersFromRoute,
  writeFiltersToRoute,
  type FilterOptions,
} from '../../../shared/collection-filters';
import './notes.css';

const KINDS = [
  {
    value: 'note' as const,
    label: 'Notes',
    singular: 'note',
    subtitle: 'Your words, alongside your records.',
    icon: FilePenLine,
  },
  {
    value: 'historical' as const,
    label: 'Historical notes',
    singular: 'historical draft',
    subtitle: 'Your appointment notes and records from your providers.',
    icon: History,
  },
  {
    value: 'person' as const,
    label: 'People',
    singular: 'person',
    subtitle: 'Your family and the people involved in your care.',
    icon: CircleUserRound,
  },
];
const formatDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : new Date(value).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

export function NotesPage({ initialKind = 'note' }: { initialKind?: NoteKind }) {
  const [params, setParams] = useSearchParams();
  const personScope = usePersonScope();
  const ownerPersonId = personScope?.personId || params.get('personId') || 'patient';
  const kind: NoteKind =
    initialKind === 'person'
      ? 'person'
      : params.get('kind') === 'historical'
        ? 'historical'
        : 'note';
  const historical = kind === 'historical';
  const selectedId = params.get('id');
  const creating = params.get('new') === '1';
  const [search, setSearch] = useState(params.get('q') || '');
  const [savedInEditor, setSavedInEditor] = useState<Note | null>(null);
  const newIdentity = useRef(`note:${crypto.randomUUID()}`);
  const wasCreatingWithoutId = useRef(false);
  if (creating && !selectedId && !wasCreatingWithoutId.current)
    newIdentity.current = `note:${crypto.randomUUID()}`;
  wasCreatingWithoutId.current = creating && !selectedId;
  const editorId = selectedId || newIdentity.current;
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const limit = 40;
  const listQuery = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (!historical) listQuery.set('kind', kind);
  if (kind === 'person') listQuery.set('excludeSelf', '1');
  else listQuery.set('personId', ownerPersonId);
  for (const key of [
    'visibility',
    'q',
    'filters',
    'typeLabel',
    'status',
    ...(historical ? ['source', 'personId'] : kind === 'person' ? ['tag'] : []),
  ])
    if (params.get(key)) listQuery.set(key, params.get(key)!);
  const notes = useResource<Note[]>(historical ? null : `/notes?${listQuery}`);
  const historicalNotes = useResource<HistoricalNote[]>(
    historical ? `/historical-notes?${listQuery}` : null,
  );
  const selectedNote = useResource<Note>(
    !historical && selectedId && !creating ? `/notes/${encodeURIComponent(selectedId)}` : null,
  );
  const selectedHistorical = useResource<HistoricalNote | ReclassifiedRecord>(
    historical && selectedId && !creating
      ? `/historical-notes/${encodeURIComponent(selectedId)}`
      : null,
  );
  const noteTypes = useResource<string[]>('/note-types');
  const personFilters = useResource<FilterOptions>(
    kind === 'person' ? '/person-filter-options' : null,
  );
  const historicalOptions = useResource<HistoricalNoteOptions>(
    historical
      ? `/historical-note-options?${new URLSearchParams({ personId: params.get('personId') || 'patient' })}`
      : null,
  );
  const list = historical ? historicalNotes : notes;
  const selected = historical ? selectedHistorical : selectedNote;
  const currentHistorical = currentClinicalRecord(selectedHistorical.data);
  const loadedPersonal = historical
    ? currentHistorical?.origin === 'personal'
      ? currentHistorical.note
      : null
    : selectedNote.data;
  const personalNote =
    selectedId || creating
      ? savedInEditor?.id === editorId
        ? loadedPersonal?.id === savedInEditor.id && loadedPersonal.version > savedInEditor.version
          ? loadedPersonal
          : savedInEditor
        : loadedPersonal
      : null;
  useEffect(() => {
    if (
      savedInEditor &&
      ((!selectedId && !creating) ||
        (savedInEditor.id !== editorId && savedInEditor.personId !== selectedId))
    )
      setSavedInEditor(null);
  }, [selectedId, creating, editorId, savedInEditor]);
  const providerNote =
    historical && currentHistorical?.origin === 'provider' ? currentHistorical : null;
  useAssistantSelection(
    selectedId
      ? {
          collection: providerNote ? 'documents' : kind === 'person' ? 'people' : 'notes',
          id: selectedId,
        }
      : undefined,
    providerNote?.title || personalNote?.title,
  );
  let filterRows: ReturnType<typeof filtersFromRoute> = [],
    filterError = '';
  try {
    filterRows = filtersFromRoute(params, historical ? 'historical' : 'person');
  } catch {
    filterError = 'These saved filters could not be read. Clear them to continue.';
  }
  const filterOptions: FilterOptions = historical
    ? {
        source:
          historicalOptions.data?.sources
            .filter((source) => source.id !== 'all')
            .map((source) => ({ value: source.id, label: source.label })) || [],
        acquisitionSource: historicalOptions.data?.acquisitionSources || [],
        type: (historicalOptions.data?.types || []).map((value) => ({ value, label: value })),
        status: [
          { value: 'draft', label: 'Personal draft' },
          { value: 'finished', label: 'Personal finished' },
          { value: 'provider', label: 'Provider record' },
        ],
      }
    : personFilters.data || {};
  const searchParamsRef = useRef(params);
  searchParamsRef.current = params;
  useEffect(() => {
    setSearch(params.get('q') || '');
  }, [params.get('q')]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (search === (searchParamsRef.current.get('q') || '')) return;
      const next = new URLSearchParams(searchParamsRef.current);
      search ? next.set('q', search) : next.delete('q');
      next.delete('offset');
      setParams(next, { replace: true });
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [search, setParams]);

  function navigate(values: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    Object.entries(values).forEach(([key, value]) =>
      value === null ? next.delete(key) : next.set(key, value),
    );
    setParams(next);
  }
  function createNew() {
    setSearch('');
    const nextId = `note:${crypto.randomUUID()}`;
    navigate({
      new: '1',
      personId: kind === 'person' ? null : ownerPersonId,
      id: nextId,
      targetType: null,
      targetId: null,
      kind,
      source: null,
      status: null,
      typeLabel: null,
      q: null,
      offset: null,
      tag: null,
      filters: null,
    });
  }
  function afterSaved(note: Note, message: string) {
    setSavedInEditor(note);
    if (note.kind === 'person') personScope?.reload();
    if (message) notifySuccess(message);
    notes.reload();
    historicalNotes.reload();
    noteTypes.reload();
    historicalOptions.reload();
    personFilters.reload();
    const next = new URLSearchParams(searchParamsRef.current);
    next.set('id', note.id);
    next.set('kind', note.kind);
    next.delete('new');
    if (note.kind === 'historical') {
      for (const key of ['source', 'status', 'typeLabel', 'q', 'offset', 'filters'])
        next.delete(key);
      setSearch('');
    }
    if (next.toString() !== searchParamsRef.current.toString()) setParams(next, { replace: true });
  }
  const handleNoteRefresh = () => {
    notes.reload();
    historicalNotes.reload();
    noteTypes.reload();
    historicalOptions.reload();
    personFilters.reload();
  };
  const kindInfo = KINDS.find((item) => item.value === kind)!;
  const total = typeof list.meta?.total === 'number' ? list.meta.total : undefined;
  const hasFilters = [
    'filters',
    'q',
    'typeLabel',
    'status',
    'source',
    ...(kind === 'person' ? ['tag', 'visibility'] : []),
  ].some((key) => params.get(key) && params.get(key) !== 'all');
  if (
    selectedNote.data &&
    selectedId &&
    !creating &&
    (selectedNote.data.kind === 'person') !== (kind === 'person')
  ) {
    const entry = selectedNote.data;
    return (
      <Navigate
        replace
        to={`${entry.kind === 'person' ? '/people' : '/notes'}?id=${encodeURIComponent(entry.id)}&kind=${entry.kind}`}
      />
    );
  }
  return (
    <div className={`page notes-page ${selectedId || creating ? 'has-note-selection' : ''}`}>
      <div className="notes-header">
        <div className="page-heading">
          <div>
            <p className="eyebrow">
              {historical ? 'VISITS & PERSONAL CONTEXT' : 'PERSONAL CONTEXT'}
            </p>
            <h1>
              {kindInfo.label}
              <span className="heading-star" aria-hidden="true">
                ✧
              </span>
            </h1>
            <p className="page-subtitle">{kindInfo.subtitle}</p>
          </div>
          <button type="button" className="button primary" onClick={createNew}>
            <Plus size={18} /> New {kindInfo.singular}
          </button>
        </div>
        {kind !== 'person' && (
          <CollectionTabs label="Note collections">
            {KINDS.filter((item) => item.value !== 'person').map(({ value, label, icon: Icon }) => (
              <Link
                key={value}
                to={`?kind=${value}&personId=${encodeURIComponent(ownerPersonId)}`}
                aria-current={kind === value ? 'page' : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  navigate({
                    kind: value,
                    id: null,
                    new: null,
                    source: null,
                    typeLabel: null,
                    status: null,
                    offset: null,
                    q: null,
                    tag: null,
                    filters: null,
                  });
                }}
              >
                <Icon size={18} aria-hidden="true" />
                {label}
              </Link>
            ))}
          </CollectionTabs>
        )}
        <CollectionToolbar>
          <div className="notes-filters">
            {historical || kind === 'person' ? (
              <>
                {kind === 'person' ? (
                  <PeopleFilters
                    rows={filterRows}
                    visibility={params.get('visibility') || 'visible'}
                    options={filterOptions}
                    search={search}
                    onSearch={setSearch}
                    error={filterError}
                    onChange={(rows, visibility) => {
                      const next = writeFiltersToRoute(params, rows);
                      next.set('visibility', visibility);
                      setParams(next);
                    }}
                  />
                ) : (
                  <CompactFilters
                    key={kind}
                    rows={filterRows}
                    options={filterOptions}
                    visibility={params.get('visibility') || 'visible'}
                    search={search}
                    onSearch={setSearch}
                    error={filterError}
                    onChange={(rows, visibility) => {
                      const next = writeFiltersToRoute(params, rows);
                      next.set('visibility', visibility);
                      setParams(next);
                    }}
                  />
                )}
                {(historical ? historicalOptions.error : personFilters.error) && (
                  <p className="notes-filter-warning" role="status">
                    Filter options could not be loaded.{' '}
                    <button
                      type="button"
                      className="text-link"
                      onClick={historical ? historicalOptions.reload : personFilters.reload}
                    >
                      Try again
                    </button>
                  </p>
                )}
              </>
            ) : (
              <CollectionFilters
                search={search}
                onSearch={setSearch}
                searchLabel="notes"
                definitions={[visibilityFilter(params.get('visibility') || 'visible')]}
                onApply={(key, value) => navigate({ [key]: value, offset: null })}
              />
            )}
          </div>
        </CollectionToolbar>
      </div>
      <div className="notes-workspace">
        <aside className="panel notes-sidebar" aria-label={`${kindInfo.label} list`}>
          <div className="notes-count">
            <span>
              {total === undefined
                ? kindInfo.label
                : `${total} ${total === 1 ? 'entry' : 'entries'}`}
            </span>
            <span>{historical ? 'Newest date first' : 'Most recently updated'}</span>
          </div>
          {list.loading && (
            <LoadingIndicator
              className="notes-loading"
              label={`Loading ${kindInfo.label.toLowerCase()}…`}
              layout="panel"
            />
          )}
          {list.error && (
            <div className="note-warning" role="alert">
              {list.error.message}
              <button type="button" className="text-link" onClick={list.reload}>
                Try again
              </button>
            </div>
          )}
          {!list.loading && !list.error && list.data?.length === 0 && (
            <div className="notes-empty">
              <BookOpen size={27} />
              <p>
                {hasFilters
                  ? 'No entries match these filters.'
                  : `No ${kindInfo.label.toLowerCase()} yet. Create your first ${kindInfo.singular} when you’re ready.`}
              </p>
            </div>
          )}
          <div className="notes-results">
            {historical
              ? historicalNotes.data?.map((entry) => (
                  <button
                    type="button"
                    className="notes-row"
                    key={entry.id}
                    aria-label={`${entry.title} · ${formatRecordDate(entry.date)} · ${entry.sourceLabel}`}
                    aria-current={selectedId === entry.id ? 'true' : undefined}
                    onClick={() => navigate({ id: entry.id, new: null })}
                  >
                    {entry.origin === 'personal' && entry.note.pinned ? (
                      <Pin size={17} aria-label="Pinned" />
                    ) : (
                      <CalendarDays size={17} />
                    )}
                    <span className="notes-row-copy">
                      <strong>{entry.title}</strong>
                      {entry.archived && <span className="soft-badge">Inactive</span>}
                      <span className="notes-snippet">
                        {entry.content
                          ? `${entry.content.slice(0, 180)}${entry.content.length > 180 ? '…' : ''}`
                          : 'No text recorded'}
                      </span>
                      <span className="notes-row-tags">
                        <span className={`note-status ${entry.status}`}>
                          {entry.origin === 'provider'
                            ? 'Provider'
                            : entry.status === 'draft'
                              ? 'Draft'
                              : 'Finished'}
                        </span>
                        {entry.typeLabel && <span>{entry.typeLabel}</span>}
                        <span>{formatRecordDate(entry.date)}</span>
                      </span>
                      <span className="notes-source-label">{entry.sourceLabel}</span>
                    </span>
                  </button>
                ))
              : notes.data
                  ?.filter(
                    (note) => kind !== 'person' || (!note.isSelf && note.personId !== 'patient'),
                  )
                  .map((note) => (
                    <button
                      type="button"
                      className="notes-row"
                      key={note.id}
                      aria-current={selectedId === note.id ? 'true' : undefined}
                      onClick={() => navigate({ id: note.id, new: null })}
                    >
                      {note.kind === 'person' ? (
                        <PersonIcon value={note.person.icon} size={20} />
                      ) : note.pinned ? (
                        <Pin size={17} aria-label="Pinned" />
                      ) : (
                        <FilePenLine size={17} />
                      )}
                      <span className="notes-row-copy">
                        <span className="notes-row-heading">
                          <strong>{note.title}</strong>
                          {note.kind === 'person' && note.pinned && (
                            <Pin size={13} aria-label="Pinned" />
                          )}
                          {note.archived && <span className="soft-badge">Inactive</span>}
                          {note.isSelf && <span className="quiet-badge self-tag">Self</span>}
                          {note.kind === 'person' && !note.isSelf && (
                            <PersonTagChips tags={note.person.tags} badges />
                          )}
                        </span>
                        {note.kind === 'person' && note.person.fullName && (
                          <span className="notes-person-name">{note.person.fullName}</span>
                        )}
                        <span className="notes-snippet">
                          {note.content ||
                            (note.kind === 'person' ? note.person.relationship : '') ||
                            'No content yet'}
                        </span>
                        <span className="notes-row-tags">
                          {note.typeLabel && <span>{note.typeLabel} · </span>}
                          <span>{formatDate(note.eventDate || note.updatedAt)}</span>
                        </span>
                      </span>
                    </button>
                  ))}
          </div>
          {(offset > 0 || (list.data?.length || 0) === limit) && (
            <div className="notes-pager">
              <button
                type="button"
                className="button secondary"
                disabled={!offset}
                onClick={() => navigate({ offset: String(Math.max(0, offset - limit)) })}
              >
                Previous
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={
                  total !== undefined ? offset + limit >= total : (list.data?.length || 0) < limit
                }
                onClick={() => navigate({ offset: String(offset + limit) })}
              >
                Next
              </button>
            </div>
          )}
        </aside>
        <div>
          {(selectedId || creating) && (
            <button
              type="button"
              className="text-link notes-mobile-back"
              onClick={() => navigate({ id: null, new: null })}
            >
              <ArrowLeft size={18} /> Back to {kindInfo.label.toLowerCase()}
            </button>
          )}
          {isReclassifiedRecord(selectedHistorical.data) ? (
            <ClinicalRedirect record={selectedHistorical.data} />
          ) : selected.loading && !personalNote ? (
            <div className="panel note-detail">
              <LoadingIndicator label="Opening entry…" layout="centered" />
            </div>
          ) : selected.error && !personalNote ? (
            <div className="panel note-detail">
              <p className="note-warning" role="alert">
                {selected.error.message}
              </p>
              <button type="button" className="button secondary" onClick={selected.reload}>
                Try again
              </button>
            </div>
          ) : providerNote ? (
            <ProviderNoteDetail
              key={providerNote.id}
              note={providerNote}
              onChanged={() => {
                handleNoteRefresh();
                selectedHistorical.reload();
              }}
            />
          ) : personalNote || (creating && !personScope?.pending && !personScope?.error) ? (
            <>
              <NoteEditor
                key={`${personalNote?.id || editorId}:${personalNote?.ownerPersonId || ownerPersonId}`}
                creationId={personalNote?.id || editorId}
                prelinkType={params.get('targetType')}
                prelinkId={params.get('targetId')}
                initial={personalNote}
                initialOwnerPersonId={ownerPersonId}
                initialKind={kind}
                types={noteTypes.data || ['Therapy', 'Primary care', 'Specialist']}
                personOptions={personFilters.data || undefined}
                onSaved={afterSaved}
                onRefresh={handleNoteRefresh}
              />
            </>
          ) : (
            <div className="panel note-detail notes-empty">
              <BookOpen size={32} />
              <h2>A place for the context</h2>
              <p>
                {historical
                  ? 'Read a provider record, or prepare a personal draft for your next appointment and finish it when you’re done.'
                  : kind === 'person'
                    ? 'Keep the people, relationships and family information that matter to you in one place.'
                    : 'Keep living notes such as Annual Planning, questions, and reminders. Pin the ones you return to.'}
              </p>
              <button className="button secondary" type="button" onClick={createNew}>
                <Plus size={17} /> New {kindInfo.singular}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default NotesPage;
