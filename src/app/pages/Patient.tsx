import { useEffect, useState } from 'react';
import { notifySuccess } from '../components/Toasts';
import type { Note } from '../../shared/api';
import { useResource } from '../data/api';
import { useProfile } from '../data/profile';
import { PersonIcon } from '../components/PersonIcon';
import { NoteEditor } from '../features/notes/NoteEditor';
import { useAssistantSelection } from '../features/assistant/pageContext';
import { LoadingIndicator } from '../components/LoadingIndicator';

/** The home page edits the canonical Self entry; it does not copy patient fields. */
export function Patient() {
  const profile = useProfile();
  const resource = useResource<Note>('/notes/person-note%3Aself');
  const [saved, setSaved] = useState<Note | null>(null);
  const note =
    saved && (!resource.data || saved.version >= resource.data.version) ? saved : resource.data;
  useAssistantSelection({ collection: 'people', id: 'patient' }, profile?.name);
  useEffect(() => {
    document.title = `Circus Health · ${profile?.name || 'Patient'}`;
  }, [profile?.name]);
  return (
    <div className="page patient-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR HEALTH</p>
          <h1 className="patient-heading">
            <PersonIcon value={profile?.icon} size={32} />
            {profile?.name}
          </h1>
          <p className="page-subtitle">
            Your information, care contacts, and the context you want to share.
          </p>
        </div>
      </div>
      {resource.loading && !note && (
        <LoadingIndicator label="Opening your profile…" layout="centered" />
      )}
      {resource.error && !note && (
        <div role="alert">
          <p>{resource.error.message}</p>
          <button className="button secondary" onClick={resource.reload}>
            Try again
          </button>
        </div>
      )}
      {note && (
        <NoteEditor
          key={note.id}
          initial={note}
          initialKind="person"
          types={[]}
          creationId={note.id}
          prelinkId={null}
          prelinkType={null}
          onSaved={(value, message) => {
            setSaved(value);
            if (message) notifySuccess(message);
          }}
          onRefresh={resource.reload}
        />
      )}
    </div>
  );
}
