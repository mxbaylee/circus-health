import { Link } from 'react-router-dom';
import { MessageSquarePlus, Paperclip } from 'lucide-react';
import { NoteText } from '../features/notes/NoteText';
import type { LinkTargetType, NoteTextFormats } from '../../shared/api';
import { queryString, useResource } from '../data/api';
import { formatDate } from '../data/format';
import { LoadingIndicator } from './LoadingIndicator';

type Comment = {
  id: string;
  title: string;
  content: string;
  status: string;
  archived: boolean;
  updatedAt: string;
  attachmentCount: number;
  textFormats?: NoteTextFormats;
};
export function RelatedNotes({
  targetType,
  targetId,
  title = 'Notes & comments',
}: {
  targetType: LinkTargetType;
  targetId: string;
  title?: string;
}) {
  const notes = useResource<Comment[]>(`/related-notes?${queryString({ targetType, targetId })}`);
  const create = `/notes?${queryString({ new: 1, kind: 'note', targetType, targetId })}`;
  return (
    <section className="related-notes" aria-label={title}>
      <div className="section-heading">
        <h3>{title}</h3>
        <Link className="text-link" to={create}>
          <MessageSquarePlus size={16} />
          Add comment
        </Link>
      </div>
      {notes.loading && (
        <LoadingIndicator className="helper-text" label="Loading notes…" size="small" />
      )}
      {notes.error && (
        <p role="alert">
          Notes could not be loaded.{' '}
          <button className="text-link" onClick={notes.reload}>
            Retry
          </button>
        </p>
      )}
      {notes.data?.length === 0 && (
        <p className="helper-text">Add a note, PDF, or photo about this entry.</p>
      )}
      {notes.data?.map((note) => (
        <article className="related-note" key={note.id}>
          <Link to={`/notes?id=${encodeURIComponent(note.id)}`}>
            <strong>{note.title}</strong>
          </Link>
          <span className="helper-text">
            {note.archived ? 'Archived · ' : ''}
            {note.status === 'draft' ? 'Draft · ' : ''}
            {formatDate(note.updatedAt)}
            {note.attachmentCount > 0 && (
              <>
                {' '}
                · <Paperclip size={12} /> {note.attachmentCount}
              </>
            )}
          </span>
          {note.content && (
            <NoteText label="Content" value={note.content} format="markdown-v1" readOnly />
          )}
        </article>
      ))}
    </section>
  );
}
