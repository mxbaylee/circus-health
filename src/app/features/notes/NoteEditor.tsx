import { PersonClinicalRecords } from './PersonClinicalRecords';
import { SaveStatus } from '../../components/SaveStatus';
import { DetailHeader, EntryActions } from '../../components/DetailHeader';
import { PersonIconPicker } from '../../components/PersonIcon';
import { ArchiveControl } from '../../components/ArchiveControl';
import { NoteExportDialog } from './NoteExportDialog';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useBlocker } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  FilePenLine,
  History,
  LockKeyhole,
  Pin,
  Plus,
  Save,
} from 'lucide-react';
import type {
  LinkTarget,
  Note,
  NoteKind,
  NoteLink,
  NoteTextField,
  NoteTextFormat,
} from '../../../shared/api';
import { api, apiUrl, ApiError } from '../../data/api';
import { currentProfile } from '../../data/profile';
import { registerProfileTransitionEditor } from '../../data/profile-transition';
import { subscribeNoteUpdates } from '../../data/note-updates';
import { useDurability } from '../../data/durability';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import { formFor, inputFor, keyFor, type FormState } from './note-form';
import { formatDate } from '../../data/format';
import { RelatedNotes } from '../../components/RelatedNotes';
import { AttachmentPanel } from './AttachmentPanel';
import { NoteDialog } from './NoteDialog';
import { NoteLinks } from './NoteLinks';
import { PersonSourceEvidence } from './PersonSourceEvidence';
import { DraftWriter } from './draft-writer';
import { validPartialDate } from './person-fields';
import { DeathDateField, PartialDateField } from './PartialDateField';
import { canonicalizesEditor, leavesNoteEditor } from './navigation';
import { personContactError } from '../../../shared/person-care';
import { PeopleTags } from './PeopleTags';
import { PersonContacts } from './PersonContacts';
import { PersonNames } from './PersonNames';
import { NoteHistoryPanel } from './NoteHistoryPanel';
import { NoteText } from './NoteText';
import { NoteTypeCombobox } from './NoteTypeCombobox';
import { CreatableCombobox } from '../../components/CreatableCombobox';
import type { FilterOptions } from '../../../shared/collection-filters';

const messageFor = (error: unknown) =>
  error instanceof Error ? error.message : 'The note could not be saved.';
const text = (value: unknown) => (typeof value === 'string' ? value : '');
function validForm(form: FormState, kind: NoteKind) {
  const contactError = kind === 'person' ? personContactError(form.person) : '';
  if (contactError) throw new ApiError(contactError, 'INVALID_INPUT', 400);
  if (form.isSelf && !form.title.trim())
    throw new ApiError(
      'Enter a display name. Your saved name stays unchanged until this is filled in.',
      'INVALID_INPUT',
      400,
    );
  if (
    kind === 'person' &&
    (!validPartialDate(text(form.person.birthDate)) ||
      !validPartialDate(text(form.person.deathDate)))
  )
    throw new ApiError(
      'Use YYYY, YYYY-MM or YYYY-MM-DD for personal dates, or leave them blank when unknown.',
      'INVALID_INPUT',
      400,
    );
}

export function NoteEditor({
  initial,
  initialKind,
  initialOwnerPersonId = 'patient',
  types,
  personOptions,
  onSaved,
  onRefresh,
  creationId,
  prelinkType,
  prelinkId,
}: {
  initial: Note | null;
  initialKind: NoteKind;
  initialOwnerPersonId?: string;
  types: string[];
  personOptions?: FilterOptions;
  onSaved: (note: Note, message: string) => void;
  onRefresh: () => void;
  creationId: string;
  prelinkType: string | null;
  prelinkId: string | null;
}) {
  const formId = useId();
  const ownerPersonId = useRef(initial?.ownerPersonId || initialOwnerPersonId).current;
  const [note, setNote] = useState(initial);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [savedBy, setSavedBy] = useState<'manual' | 'auto'>('auto');
  const manualSave = useRef(false);
  const [editingSessionId] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState(() => formFor(initial));
  const [baseline, setBaseline] = useState(() =>
    keyFor(formFor(initial), initial?.kind || initialKind),
  );
  const [saveState, setSaveState] = useState<'saving' | 'saved' | 'error' | 'idle'>(
    initial ? 'saved' : 'idle',
  );
  const [busy, setBusy] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflicted, setConflicted] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [historyOpenSignal, setHistoryOpenSignal] = useState(0);
  const [conversion, setConversion] = useState({ typeLabel: '', eventDate: '' });
  const [prelinkError, setPrelinkError] = useState('');
  const [prelinkLoading, setPrelinkLoading] = useState(
    Boolean(!initial && prelinkType && prelinkId),
  );
  const [prelinkRetry, setPrelinkRetry] = useState(0);
  const durability = useDurability();
  const portablePending = Boolean(durability?.configured && durability.dirty);
  const apiBase = useRef(apiUrl('/')).current;
  const endpoint = (path: string) => `${apiBase.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  const correctionId = useRef(`note:${crypto.randomUUID()}`).current;
  const editorProfileId = useRef(currentProfile()?.id).current;
  const mounted = useRef(true);
  const formRef = useRef(form);
  formRef.current = form;
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  const refreshCallback = useRef(onRefresh);
  refreshCallback.current = onRefresh;
  const kindRef = useRef(initial?.kind || initialKind);
  const kind = note?.kind || initialKind;
  kindRef.current = kind;
  const finished = note?.status === 'finished';
  const isSelf = Boolean((note as (Note & { isSelf?: boolean }) | null)?.isSelf);
  const dirty = baseline !== keyFor(form, kind);
  const nameValid = !isSelf || Boolean(form.title.trim());
  const contactsValid = kind !== 'person' || !personContactError(form.person);
  const datesValid =
    kind !== 'person' ||
    (validPartialDate(text(form.person.birthDate)) &&
      validPartialDate(text(form.person.deathDate)));
  const hasUnsavedWork =
    dirty ||
    saveState === 'saving' ||
    saveState === 'error' ||
    attachmentBusy ||
    historyBusy ||
    prelinkLoading ||
    Boolean(prelinkError);
  const unsavedRef = useRef(hasUnsavedWork);
  unsavedRef.current = hasUnsavedWork;
  const transitionState = useRef({
    busy,
    attachmentBusy,
    historyBusy,
    prelinkLoading,
    prelinkError,
    saveState,
  });
  transitionState.current = {
    busy,
    attachmentBusy,
    historyBusy,
    prelinkLoading,
    prelinkError,
    saveState,
  };
  const transitionPaused = useRef(false);
  const autosaveAllowed = useRef(false);
  const allowOwnNavigation = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (allowOwnNavigation.current) return false;
    return (
      !canonicalizesEditor(currentLocation, nextLocation, creationId, initial?.personId) &&
      unsavedRef.current &&
      currentProfile()?.id === editorProfileId &&
      leavesNoteEditor(currentLocation, nextLocation)
    );
  });
  const writerRef = useRef<DraftWriter<FormState, Note> | null>(null);
  if (!writerRef.current)
    writerRef.current = new DraftWriter({
      draft: form,
      saved: initial,
      key: (draft) => keyFor(draft, kindRef.current),
      keepFailedSnapshot: (reason) =>
        !(
          reason instanceof ApiError && [400, 403, 404, 409, 413, 415, 422].includes(reason.status)
        ),
      write: async (snapshot, base, retry) => {
        validForm(snapshot, kindRef.current);
        const id = base?.id || creationId;
        if (retry) {
          // A lost response may still have committed. Read it before sending the exact request again.
          try {
            const existing = (await api<Note>(endpoint(`/notes/${encodeURIComponent(id)}`))).data;
            if (keyFor(formFor(existing), existing.kind) === keyFor(snapshot, kindRef.current))
              return existing;
            if (!base || existing.version !== base.version)
              throw new ApiError(
                'This entry changed on the server. Your unsaved text is preserved here; reload only after copying anything you need.',
                base ? 'VERSION_CONFLICT' : 'ID_CONFLICT',
                409,
              );
          } catch (reason) {
            if (!(reason instanceof ApiError && reason.status === 404)) throw reason;
          }
        }
        const response = await api<Note>(
          endpoint(base ? `/notes/${encodeURIComponent(base.id)}` : '/notes'),
          {
            method: base ? 'PUT' : 'POST',
            body: JSON.stringify({
              ...inputFor(snapshot, kindRef.current, base?.version),
              editingSessionId,
              ...(kindRef.current === 'person' ? {} : { ownerPersonId }),
              ...(base ? {} : { id: creationId }),
            }),
          },
        );
        return response.data;
      },
      accepted: (saved, snapshot) => {
        if (!mounted.current) return;
        setNote(saved);
        setSavedAt(saved.updatedAt);
        setSavedBy(manualSave.current ? 'manual' : 'auto');
        setBaseline(keyFor(snapshot, saved.kind));
        // Preserve keystrokes, links and unknown profile fields added during the request.
        if (keyFor(formRef.current, saved.kind) === keyFor(snapshot, saved.kind)) {
          const normalized = formFor(saved);
          formRef.current = normalized;
          setForm(normalized);
          setBaseline(keyFor(normalized, saved.kind));
        }
        savedCallback.current(saved, '');
      },
      state: (state, reason) => {
        if (!mounted.current) return;
        setSaveState(state);
        if (state === 'error') {
          setError(messageFor(reason));
          setConflicted(
            reason instanceof ApiError &&
              ['VERSION_CONFLICT', 'ID_CONFLICT', 'NOTE_FINISHED'].includes(reason.code),
          );
        } else setError('');
      },
    });
  const writer = writerRef.current;
  writer.update(form);
  // A failed write still needs reconciliation even if the user has reverted
  // the form: the server may have accepted the request before the response failed.
  const hasSaveWork = dirty || Boolean(writer.error);
  const saveDisabled =
    busy ||
    finished ||
    saveState === 'saving' ||
    prelinkLoading ||
    Boolean(prelinkError) ||
    !hasSaveWork ||
    !datesValid ||
    !nameValid ||
    !contactsValid;
  useEffect(() => {
    mounted.current = true;
    writer.activate();
    return () => {
      mounted.current = false;
      writer.dispose();
    };
  }, [writer]);
  useEffect(
    () =>
      registerProfileTransitionEditor({
        profileId: editorProfileId,
        pending: () => unsavedRef.current || transitionState.current.busy,
        checkReady: (choice) => {
          const state = transitionState.current;
          if (state.attachmentBusy)
            throw new Error(
              'Finish or remove pending attachment links in the entry before continuing. Use Back to return to your work.',
            );
          if (state.historyBusy || state.busy)
            throw new Error(
              'An entry operation is still running. Wait for it to finish before continuing.',
            );
          if (state.prelinkLoading || state.prelinkError)
            throw new Error(
              'Resolve the original-record link in the entry before continuing. Use Back to return to your work.',
            );
          if (choice === 'discard' && state.saveState === 'saving')
            throw new Error(
              'An entry is still saving. Wait for it to finish, or choose Save and continue.',
            );
        },
        save: async () => {
          autosaveAllowed.current = true;
          await writer.flush(true);
          if (!mounted.current || currentProfile()?.id !== editorProfileId)
            throw new Error('This editor is no longer active.');
          setConflicted(false);
        },
        pause: () => {
          transitionPaused.current = true;
          writer.dispose();
          return () => {
            if (mounted.current && currentProfile()?.id === editorProfileId) {
              transitionPaused.current = false;
              writer.activate();
            }
          };
        },
      }),
    [writer, editorProfileId],
  );
  const adoptNote = useCallback(
    (saved: Note) => {
      const current = writer.current;
      if (
        !mounted.current ||
        currentProfile()?.id !== editorProfileId ||
        !current ||
        saved.id !== current.id ||
        saved.version <= current.version ||
        unsavedRef.current
      )
        return;
      const next = formFor(saved);
      if (!writer.adoptClean(saved, next)) return;
      kindRef.current = saved.kind;
      formRef.current = next;
      setForm(next);
      setNote(saved);
      setBaseline(keyFor(next, saved.kind));
      setConflicted(false);
    },
    [writer, editorProfileId],
  );
  useEffect(
    () =>
      subscribeNoteUpdates(({ profileId, note: saved }) => {
        if (profileId === editorProfileId) adoptNote(saved);
      }),
    [adoptNote, editorProfileId],
  );
  useEffect(() => {
    if (initial) adoptNote(initial);
  }, [initial, adoptNote]);

  useEffect(() => {
    if (!hasUnsavedWork) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (transitionPaused.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedWork]);
  useEffect(() => {
    const correctedInput =
      datesValid &&
      nameValid &&
      contactsValid &&
      writer.error instanceof ApiError &&
      writer.error.code === 'INVALID_INPUT';
    if (
      finished ||
      busy ||
      prelinkLoading ||
      prelinkError ||
      !autosaveAllowed.current ||
      (!note && !dirty) ||
      !datesValid ||
      !nameValid ||
      !contactsValid ||
      (writer.error && !correctedInput) ||
      !writer.dirty
    )
      return;
    const timer = window.setTimeout(() => {
      if (!transitionPaused.current) void writer.flush(correctedInput).catch(() => {});
    }, 650);
    return () => window.clearTimeout(timer);
  }, [
    form,
    note,
    dirty,
    finished,
    busy,
    prelinkLoading,
    prelinkError,
    writer,
    attachmentBusy,
    datesValid,
    nameValid,
    contactsValid,
  ]);
  useEffect(() => {
    if (initial || !prelinkType || !prelinkId) {
      setPrelinkLoading(false);
      return;
    }
    let canceled = false;
    setPrelinkLoading(true);
    setPrelinkError('');
    api<LinkTarget>(
      endpoint(
        `/link-target?type=${encodeURIComponent(prelinkType)}&id=${encodeURIComponent(prelinkId)}`,
      ),
    )
      .then(({ data: target }) => {
        if (canceled) return;
        const link: NoteLink = {
          ...target,
          id: `unsaved-${crypto.randomUUID()}`,
          relation: 'references',
          missing: false,
          current: true,
        };
        setForm((current) => ({
          ...current,
          links: current.links.some(
            (item) => item.targetType === target.targetType && item.targetId === target.targetId,
          )
            ? current.links
            : [...current.links, link],
        }));
        autosaveAllowed.current = true;
        setPrelinkLoading(false);
      })
      .catch((reason) => {
        if (!canceled) {
          setPrelinkLoading(false);
          setPrelinkError(messageFor(reason));
        }
      });
    return () => {
      canceled = true;
    };
  }, [prelinkType, prelinkId, prelinkRetry]);
  function change<K extends keyof FormState>(key: K, value: FormState[K]) {
    autosaveAllowed.current = true;
    setForm((current) => ({ ...current, [key]: value }));
  }
  function textChange(field: NoteTextField, value: string, format: NoteTextFormat) {
    autosaveAllowed.current = true;
    setForm((current) => ({
      ...current,
      ...(field === 'medicalHistory'
        ? { person: { ...current.person, medicalHistory: value } }
        : { [field]: value }),
      textFormats: { ...current.textFormats, [field]: format },
    }));
  }
  function personChange(key: string, value: string | string[]) {
    autosaveAllowed.current = true;
    setForm((current) => ({ ...current, person: { ...current.person, [key]: value } }));
  }
  function fail(reason: unknown) {
    if (mounted.current) {
      setError(messageFor(reason));
      setSaveState('error');
      setConflicted(
        reason instanceof ApiError &&
          ['VERSION_CONFLICT', 'ID_CONFLICT', 'NOTE_FINISHED'].includes(reason.code),
      );
    }
  }
  function moveTo(saved: Note, message: string) {
    allowOwnNavigation.current = true;
    savedCallback.current(saved, message);
    queueMicrotask(() => {
      allowOwnNavigation.current = false;
    });
  }
  function replaceForm(saved: Note) {
    kindRef.current = saved.kind;
    const next = formFor(saved);
    formRef.current = next;
    setForm(next);
    writer.reset(saved, next);
    setNote(saved);
    setBaseline(keyFor(next, saved.kind));
  }
  async function save() {
    if (saveDisabled) return;
    manualSave.current = true;
    autosaveAllowed.current = true;
    try {
      await writer.flush(true);
      setConflicted(false);
    } catch {
      /* Writer retains the failed snapshot and local edits. */
    } finally {
      manualSave.current = false;
    }
  }
  async function reloadSaved() {
    if (
      busy ||
      attachmentBusy ||
      !window.confirm(
        'Reload the latest saved entry and discard your unsaved form changes? Copy any text you want to keep first.',
      )
    )
      return;
    setBusy(true);
    try {
      const response = await api<Note>(
        endpoint(`/notes/${encodeURIComponent(note?.id || creationId)}`),
      );
      if (!mounted.current) return;
      replaceForm(response.data);
      setConflicted(false);
      setError('');
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function finish() {
    if (busy || attachmentBusy || prelinkLoading || prelinkError || finished) return;
    setBusy(true);
    try {
      await writer.exclusive(async (saved) => {
        const result = await api<Note>(endpoint(`/notes/${encodeURIComponent(saved.id)}/finish`), {
          method: 'POST',
          body: JSON.stringify(inputFor(formRef.current, 'historical', saved.version)),
        });
        if (!mounted.current) return;
        replaceForm(result.data);
        setFinishOpen(false);
        moveTo(result.data, 'Note finished. Its recorded content is now locked.');
      });
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function convert() {
    if (busy || attachmentBusy || kind !== 'note') return;
    setBusy(true);
    try {
      await writer.exclusive(async (saved) => {
        const result = await api<Note>(endpoint(`/notes/${encodeURIComponent(saved.id)}/convert`), {
          method: 'POST',
          body: JSON.stringify({
            version: saved.version,
            typeLabel: conversion.typeLabel.trim() || null,
            eventDate: conversion.eventDate || null,
          }),
        });
        if (!mounted.current) return;
        replaceForm(result.data);
        setConvertOpen(false);
        moveTo(
          result.data,
          'Converted to a historical draft. Content, links and attachments are preserved.',
        );
      });
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function correction() {
    if (!note || busy) return;
    setBusy(true);
    try {
      const result = await api<Note>(endpoint(`/notes/${encodeURIComponent(note.id)}/correction`), {
        method: 'POST',
        body: JSON.stringify({ id: correctionId, title: `Correction: ${note.title}`, content: '' }),
      });
      if (mounted.current)
        moveTo(result.data, 'Correction draft created and linked to the original.');
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const onAttachmentNoteChanged = useCallback(
    (next: Note) => {
      writer.acceptExternal(next);
      setNote(next);
      refreshCallback.current();
    },
    [writer],
  );
  const prepareOwner = useCallback(async () => {
    if (prelinkLoading || prelinkError)
      throw new Error('Resolve the original-record link before adding files.');
    autosaveAllowed.current = true;
    return writer.flush(true);
  }, [writer, prelinkLoading, prelinkError]);
  const mutateOwner = useCallback(
    async (mutation: (saved: Note) => Promise<void>) => {
      await writer.exclusive(mutation);
      // Changes typed during the attachment mutation still need a save at the new version.
      if (writer.dirty) void writer.flush().catch(() => {});
    },
    [writer],
  );
  const changePending = busy || attachmentBusy || prelinkLoading || Boolean(prelinkError);
  const bloodType = text(form.person.bloodType);
  const lifeStatus = text(form.person.lifeStatus) || 'unknown';
  const canPrint = kind !== 'person' || isSelf || Boolean(note?.personId);
  const canOverflow = Boolean(note);
  return (
    <article className="panel note-detail">
      <DetailHeader
        eyebrow={
          kind === 'person'
            ? isSelf
              ? 'YOUR PROFILE'
              : 'PERSON'
            : kind === 'historical'
              ? 'HISTORICAL NOTE'
              : 'NOTE'
        }
        title={
          note?.title ||
          `New ${kind === 'historical' ? 'historical note' : kind === 'person' ? 'person' : 'note'}`
        }
        badges={
          <>
            {isSelf && <span className="quiet-badge self-tag">Self</span>}
            {note?.archived && <span className="soft-badge">Inactive</span>}
            {kind === 'historical' && (
              <span className={`note-status ${finished ? 'finished' : 'draft'}`}>
                {finished ? <LockKeyhole size={12} /> : <FilePenLine size={12} />}
                {finished ? 'Finished' : 'Draft'}
              </span>
            )}
          </>
        }
        metadata={
          note && (
            <>
              <span>Created {formatDate(note.createdAt)}</span>
              <span>Updated {formatDate(note.updatedAt)}</span>
              {note.finishedAt && <span>Finished {formatDate(note.finishedAt)}</span>}
            </>
          )
        }
        actions={
          <>
            {canPrint && (
              <NoteExportDialog
                type={kind === 'person' ? 'person' : 'note'}
                id={kind === 'person' ? note?.personId || 'patient' : note?.id || creationId}
                prepare={finished ? undefined : prepareOwner}
                disabled={changePending}
                label="Print"
              />
            )}
            {kind === 'historical' && !finished && (
              <button
                type="button"
                className="button primary"
                disabled={changePending || saveState === 'error'}
                onClick={() => setFinishOpen(true)}
              >
                <Check size={16} /> Finish note
              </button>
            )}
            {canOverflow && (
              <EntryActions>
                {note && !isSelf && (
                  <ArchiveControl
                    targetType={kind === 'person' ? 'person' : 'note'}
                    targetId={note.personId || note.id}
                    disabled={hasUnsavedWork || busy}
                    onChanged={onRefresh}
                  />
                )}
                {note && (
                  <button
                    type="button"
                    disabled={hasUnsavedWork || busy}
                    aria-haspopup="dialog"
                    onClick={() => setHistoryOpenSignal((value) => value + 1)}
                  >
                    <History size={16} />
                    History
                  </button>
                )}
                {kind === 'note' && (
                  <button
                    type="button"
                    disabled={changePending || saveState === 'error'}
                    aria-haspopup="dialog"
                    onClick={() => setConvertOpen(true)}
                  >
                    <History size={16} />
                    Convert to historical draft
                  </button>
                )}
              </EntryActions>
            )}
          </>
        }
      />
      {finished && (
        <div className="note-finished-banner">
          <LockKeyhole size={17} />
          <p>
            This note is finished. Its words, recorded details, links and attachments stay fixed.
            Linked entries show their current version.
          </p>
        </div>
      )}
      {error && (
        <div className="note-warning" role="alert">
          <p>Couldn’t save: {error}</p>
          <p>Your edits remain here. Copy text before reloading if you want to keep it.</p>
          <button
            type="button"
            className="text-link"
            disabled={saveDisabled}
            onClick={() => void save()}
          >
            Retry save
          </button>
          {(conflicted || note) && (
            <>
              {' '}
              ·{' '}
              <button
                type="button"
                className="text-link"
                disabled={busy || attachmentBusy}
                onClick={() => void reloadSaved()}
              >
                Reload saved entry and discard my edits
              </button>
            </>
          )}
        </div>
      )}
      {prelinkLoading && <LoadingIndicator label="Linking the original record…" layout="panel" />}
      {prelinkError && (
        <div className="note-warning" role="alert">
          The original record could not be linked: {prelinkError}{' '}
          <button
            type="button"
            className="text-link"
            onClick={() => setPrelinkRetry((value) => value + 1)}
          >
            Retry original link
          </button>
        </div>
      )}
      {finished ? (
        <div>
          <div className="note-reading-block">
            <h3>
              {note?.typeLabel || 'Unclassified'}
              {note?.eventDate ? ` · ${formatDate(note.eventDate)}` : ''}
            </h3>
            <NoteText label="Content" value={note?.content || ''} format="markdown-v1" readOnly />
          </div>
          {note?.topics && (
            <div className="note-reading-block">
              <h3>Topics & questions</h3>
              <NoteText
                label="Topics & questions"
                value={note.topics}
                format="markdown-v1"
                readOnly
              />
            </div>
          )}
          {note?.rawThoughts && (
            <div className="note-reading-block">
              <h3>Raw thoughts</h3>
              <NoteText
                label="Raw thoughts"
                value={note.rawThoughts}
                format="markdown-v1"
                readOnly
              />
            </div>
          )}
        </div>
      ) : (
        <form
          id={formId}
          className="note-form"
          data-unsaved-changes={hasUnsavedWork ? 'true' : 'false'}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="note-field">
            {kind === 'person'
              ? isSelf
                ? 'Display name'
                : 'Display name or familiar label'
              : 'Title'}
            <input
              maxLength={500}
              value={form.title}
              disabled={busy}
              onChange={(event) => change('title', event.target.value)}
              placeholder={
                kind === 'person'
                  ? isSelf
                    ? 'Name shown throughout the app'
                    : 'For example, Dad'
                  : 'Give this note a title'
              }
            />
          </label>
          {kind === 'historical' && (
            <div className="note-fields-pair">
              <NoteTypeCombobox
                value={form.typeLabel}
                options={types}
                disabled={busy}
                onChange={(value) => change('typeLabel', value)}
              />
              <label className="note-field">
                Appointment / event date
                <input
                  type="date"
                  value={form.eventDate}
                  disabled={busy}
                  onChange={(event) => change('eventDate', event.target.value)}
                />
                <small>Optional; separate from when you create or finish the note.</small>
              </label>
            </div>
          )}
          {kind === 'person' && (
            <>
              <PersonIconPicker
                value={text(form.person.icon)}
                disabled={busy}
                onChange={(value) => personChange('icon', value)}
              />
              {!isSelf && (
                <PeopleTags
                  tags={form.person.tags}
                  options={(personOptions?.tags || []).map((option) => option.label)}
                  disabled={busy}
                  onChange={(tags) => personChange('tags', tags)}
                />
              )}
              <PersonNames
                person={form.person}
                disabled={busy}
                onChange={(person) => {
                  autosaveAllowed.current = true;
                  setForm((current) => ({ ...current, person }));
                }}
              />
              <label className="note-field">
                Pronouns
                <input
                  value={text(form.person.pronouns)}
                  disabled={busy}
                  onChange={(event) => personChange('pronouns', event.target.value)}
                  placeholder="Optional, in their own words"
                />
              </label>
              {!isSelf && (
                <CreatableCombobox
                  label="Relationship / context"
                  values={text(form.person.relationship) ? [text(form.person.relationship)] : []}
                  options={(personOptions?.relationship || []).map((option) => option.label)}
                  disabled={busy}
                  placeholder="Choose or add a relationship"
                  listLabel="Relationships"
                  createNoun="relationship"
                  onChange={(values) => personChange('relationship', values[0] || '')}
                />
              )}
              <PersonContacts
                isSelf={isSelf}
                person={form.person}
                disabled={busy}
                onChange={personChange}
              />
              <div className="note-fields-pair">
                <PartialDateField
                  label="Date of birth"
                  value={text(form.person.birthDate)}
                  disabled={busy}
                  onChange={(value) => personChange('birthDate', value)}
                />
                <label className="note-field">
                  Life status
                  <select
                    value={lifeStatus}
                    disabled={busy}
                    onChange={(event) => personChange('lifeStatus', event.target.value)}
                  >
                    <option value="unknown">Unknown</option>
                    <option value="alive">Alive</option>
                    <option value="deceased">Deceased</option>
                  </select>
                </label>
              </div>
              <DeathDateField
                label="Date of death"
                lifeStatus={lifeStatus}
                value={text(form.person.deathDate)}
                disabled={busy}
                onChange={(value) => personChange('deathDate', value)}
              />
              <NoteText
                label="Medical / family history"
                value={text(form.person.medicalHistory)}
                format="markdown-v1"
                disabled={busy}
                onChange={(value, format) => textChange('medicalHistory', value, format)}
                placeholder="History about this person, including anything uncertain"
              />
              <div className="note-fields-pair">
                <label className="note-field">
                  Blood type
                  <select
                    value={bloodType}
                    disabled={busy}
                    onChange={(event) => personChange('bloodType', event.target.value)}
                  >
                    <option value="">Unknown</option>
                    {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                    {bloodType &&
                      !['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].includes(bloodType) && (
                        <option value={bloodType}>{bloodType} (recorded)</option>
                      )}
                  </select>
                  <small>A remembered value is not a verified test.</small>
                </label>
                <label className="note-field">
                  Blood type uncertainty
                  <input
                    value={text(form.person.bloodTypeUncertainty)}
                    disabled={busy}
                    onChange={(event) => personChange('bloodTypeUncertainty', event.target.value)}
                    placeholder="For example, family recollection"
                  />
                </label>
              </div>
            </>
          )}
          <NoteText
            label={kind === 'person' ? 'Notes' : 'Content'}
            value={form.content}
            format="markdown-v1"
            disabled={busy}
            onChange={(value, format) => textChange('content', value, format)}
            placeholder={
              kind === 'historical'
                ? 'Prepare here, then keep taking notes during your appointment…'
                : 'Write freely…'
            }
          />
          {kind === 'historical' && (
            <>
              <NoteText
                label="Topics & questions"
                value={form.topics}
                format="markdown-v1"
                disabled={busy}
                onChange={(value, format) => textChange('topics', value, format)}
              />
              <NoteText
                label="Raw thoughts"
                value={form.rawThoughts}
                format="markdown-v1"
                disabled={busy}
                onChange={(value, format) => textChange('rawThoughts', value, format)}
              />
            </>
          )}
          <label className="note-check">
            <input
              type="checkbox"
              checked={form.pinned}
              disabled={busy}
              onChange={(event) => change('pinned', event.target.checked)}
            />
            <Pin size={15} /> Pin this {kind === 'person' ? 'person' : 'note'}
          </label>
        </form>
      )}
      {!isSelf && (
        <NoteLinks
          links={form.links}
          onChange={(links) => change('links', links)}
          currentNoteId={note?.id || creationId}
          readOnly={finished || busy}
          backlinks={finished || kind === 'person' ? [] : note?.backlinks || []}
          personContext={kind === 'person'}
        />
      )}
      {kind === 'person' && note?.personId && (
        <PersonClinicalRecords key={note.personId} person={note} />
      )}
      {kind === 'person' && note?.personId && (
        <PersonSourceEvidence noteId={note.id} noteVersion={note.version} />
      )}
      <AttachmentPanel
        ownerType="note"
        ownerId={note?.id || creationId}
        additionalOwner={
          note?.personId ? { ownerType: 'person', ownerId: note.personId } : undefined
        }
        version={note?.version}
        readOnly={finished}
        disabled={busy}
        prepareOwner={finished ? undefined : prepareOwner}
        mutateOwner={finished ? undefined : mutateOwner}
        onNoteChanged={onAttachmentNoteChanged}
        onBusyChange={setAttachmentBusy}
      />
      {note && (
        <NoteHistoryPanel
          note={note}
          disabled={hasUnsavedWork || busy}
          openSignal={historyOpenSignal}
          hideTrigger
          onBusyChange={(next) => {
            setBusy(next);
            setHistoryBusy(next);
          }}
          onRestored={(saved) => {
            if (!mounted.current) return;
            replaceForm(saved);
            savedCallback.current(saved, 'Selected fields restored as a new saved version.');
          }}
        />
      )}
      {note?.sourceRecordId && (
        <section className="note-section">
          <Link
            className="text-link"
            to={`/sources?record=${encodeURIComponent(note.sourceRecordId)}`}
          >
            View original source attribution <ArrowRight size={16} />
          </Link>
          <p className="helper-text">This entry does not replace the original source.</p>
        </section>
      )}
      {note && (finished || kind === 'person') && (
        <RelatedNotes
          targetType={kind === 'person' ? 'person' : 'note'}
          targetId={kind === 'person' ? note.personId || note.id : note.id}
        />
      )}
      <div className="note-actions">
        {finished ? (
          <>
            <span className="quiet-badge">Finished {formatDate(note?.finishedAt)}</span>
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void correction()}
            >
              <Plus size={16} /> New correction draft
            </button>
          </>
        ) : (
          <>
            <SaveStatus
              exists={!!note}
              dirty={dirty}
              state={saveState}
              savedAt={savedAt}
              savedBy={savedBy}
              attachmentPending={attachmentBusy || !!prelinkLoading || !!prelinkError}
              portablePending={portablePending}
              validation={
                !nameValid
                  ? 'Display name is required'
                  : !contactsValid
                    ? 'Contact details need correction'
                    : !datesValid
                      ? 'Date needs correction'
                      : undefined
              }
            />
            <div>
              <button
                type="submit"
                form={formId}
                className="button primary"
                disabled={saveDisabled}
              >
                <Save size={16} />
                {saveState === 'error' && !conflicted
                  ? 'Retry'
                  : kind === 'historical'
                    ? 'Save draft'
                    : 'Save now'}
              </button>
            </div>
          </>
        )}
      </div>
      {!finished && attachmentBusy && (
        <p className="helper-text">
          Finish becomes available when every upload and attachment link is resolved. You can keep
          writing.
        </p>
      )}
      <NoteDialog
        open={finishOpen}
        onOpenChange={(open) => {
          if (!busy) setFinishOpen(open);
        }}
        title="Finish this note?"
        description="This saves the current draft and locks its content, details, links and attachments. Future corrections become a new linked note."
      >
        <div className="note-dialog-actions">
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => setFinishOpen(false)}
          >
            Keep as draft
          </button>
          <button
            className="button primary"
            type="button"
            disabled={changePending || saveState === 'error'}
            onClick={() => void finish()}
          >
            <LockKeyhole size={16} />
            {busy ? 'Finishing…' : 'Finish note'}
          </button>
        </div>
        {error && (
          <p className="note-warning" role="alert">
            {error}
          </p>
        )}
      </NoteDialog>
      <NoteDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.state === 'blocked') blocker.reset();
        }}
        title="Leave this entry?"
        description="Some changes or attachment links are not saved yet. Keep editing to save or retry. Leaving discards only unsaved changes; completed autosaves remain stored."
      >
        <div className="note-dialog-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              if (blocker.state === 'blocked') blocker.reset();
            }}
          >
            Keep editing
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              if (blocker.state === 'blocked') {
                mounted.current = false;
                writer.dispose();
                unsavedRef.current = false;
                blocker.proceed();
              }
            }}
          >
            Leave without unsaved changes
          </button>
        </div>
      </NoteDialog>
      <NoteDialog
        open={convertOpen}
        onOpenChange={(open) => {
          if (!busy) setConvertOpen(open);
        }}
        title="Convert to historical draft"
        description="Keep the same entry, contents, pin, links and attachments. You can edit it until you explicitly finish it."
      >
        <form
          className="note-form"
          onSubmit={(event) => {
            event.preventDefault();
            void convert();
          }}
        >
          <NoteTypeCombobox
            value={conversion.typeLabel}
            options={types}
            disabled={busy}
            onChange={(typeLabel) => setConversion({ ...conversion, typeLabel })}
          />
          <label className="note-field">
            Appointment / event date
            <input
              type="date"
              value={conversion.eventDate}
              onChange={(event) => setConversion({ ...conversion, eventDate: event.target.value })}
            />
          </label>
          {error && (
            <p className="note-warning" role="alert">
              {error}
            </p>
          )}
          <div className="note-dialog-actions">
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => setConvertOpen(false)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={changePending || saveState === 'error'}
            >
              {busy ? 'Converting…' : 'Convert to draft'}
            </button>
          </div>
        </form>
      </NoteDialog>
    </article>
  );
}
