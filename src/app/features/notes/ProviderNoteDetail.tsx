import { ClinicalOwner } from '../../components/ClinicalOwner';
import { DetailHeader, EntryActions } from '../../components/DetailHeader';
import { ArchiveControl } from '../../components/ArchiveControl';
import { NoteExportDialog } from './NoteExportDialog';
import { BookOpen, LockKeyhole } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { HistoricalNote } from '../../../shared/api';
import { SourceDialog } from '../../components/SourceDialog';
import { formatDate, sourceLink } from '../../data/format';
import { AttachmentPanel } from './AttachmentPanel';
import { RelatedNotes } from '../../components/RelatedNotes';
import { NoteText } from './NoteText';
import { RecordCorrectionAction } from '../clinical-review/RecordCorrectionAction';
import { RecordOwnershipAction } from '../clinical-review/RecordOwnershipAction';
import { documentCorrectionTarget } from '../clinical-review/recordCorrectionTargets';
import { ClinicalRelationshipPanel } from '../clinical-review/ClinicalRelationshipPanel';

export function ProviderNoteDetail({
  note,
  onChanged,
}: {
  note: Extract<HistoricalNote, { origin: 'provider' }>;
  onChanged?: () => void;
}) {
  return (
    <article className="panel note-detail provider-note-detail">
      <ClinicalOwner personId={note.personId} />
      <DetailHeader
        eyebrow="PROVIDER NOTE"
        title={note.title}
        badges={
          <>
            <span className="note-status provider">
              <BookOpen size={12} />
              Provider
            </span>
            {note.archived && <span className="soft-badge">Inactive</span>}
          </>
        }
        metadata={
          <>
            <span>{formatDate(note.date)}</span>
            <span>{note.typeLabel || 'Type not recorded'}</span>
          </>
        }
        actions={
          <>
            {!note.personId || note.personId === 'patient' ? (
              <NoteExportDialog type="document" id={note.id} label="Print" />
            ) : (
              <span className="helper-text">
                Family records are available from their retained originals; clinical print packets
                currently support Self.
              </span>
            )}
            <EntryActions>
              <RecordOwnershipAction
                selection={{ type: 'records', records: [{ kind: 'document', recordId: note.id }] }}
                onApplied={onChanged}
              />
              <RecordCorrectionAction
                target={documentCorrectionTarget(note)}
                onApplied={() => onChanged?.()}
              />
              <ArchiveControl
                showHistory
                targetType="document"
                targetId={note.id}
                onChanged={onChanged}
              />
            </EntryActions>
          </>
        }
      />
      <p className="provider-note-banner">
        <LockKeyhole size={17} />
        <span>
          Read-only record from {note.sourceLabel}. Its original wording and source status are
          preserved.
        </span>
      </p>
      <dl className="provider-note-metadata">
        <div>
          <dt>Source provider</dt>
          <dd>{note.sourceLabel}</dd>
        </div>
        <div>
          <dt>Author</dt>
          <dd>{note.authors.length ? note.authors.join('; ') : 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Source status</dt>
          <dd>{note.sourceStatus || 'Not recorded'}</dd>
        </div>
        {note.sourceType && (
          <div>
            <dt>Source document type</dt>
            <dd>{note.sourceType}</dd>
          </div>
        )}
        <div>
          <dt>{note.eventDate ? 'Event date' : 'Source date'}</dt>
          <dd>{formatDate(note.date)}</dd>
        </div>
        {note.eventDate && (
          <div>
            <dt>Source date</dt>
            <dd>{formatDate(note.recordDate)}</dd>
          </div>
        )}
        <div>
          <dt>Date basis</dt>
          <dd>{note.dateBasis}</dd>
        </div>
      </dl>
      {note.presentationNote && <p className="provider-note-context">{note.presentationNote}</p>}
      {note.classificationBasis && (
        <div className="provider-note-classification">
          <h3>Classification basis</h3>
          <p>{note.classificationBasis}</p>
        </div>
      )}
      <section className="note-section" aria-label="Provider note text">
        <h3>Note text</h3>
        <NoteText
          label="Provider note text"
          value={
            note.content ||
            'No note text is available in this record. Review the source evidence below.'
          }
          format="plain-v1"
          readOnly
        />
      </section>
      <section className="note-section" aria-label="Provider note source evidence">
        <h3>Source evidence</h3>
        {note.sourceRecordId ? (
          <div className="provider-note-source">
            <SourceDialog sourceRecordId={note.sourceRecordId} label="View original source" />
            <Link className="text-link" to={sourceLink(note.sourceRecordId)}>
              Open in Sources
            </Link>
          </div>
        ) : (
          <p>Original source link not recorded.</p>
        )}
        {!!note.evidence.length && (
          <ul className="provider-note-evidence">
            {note.evidence.map((evidence) => (
              <li key={evidence.id}>
                <div>
                  <strong>{evidence.role || 'Supporting evidence'}</strong>
                  <SourceDialog sourceRecordId={evidence.sourceRecordId} label="View evidence" />
                </div>
                {evidence.locator != null && (
                  <details>
                    <summary>Source location</summary>
                    <pre>
                      {typeof evidence.locator === 'string'
                        ? evidence.locator
                        : JSON.stringify(evidence.locator, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <ClinicalRelationshipPanel
        kind="document"
        recordId={note.id}
        onApplied={() => onChanged?.()}
      />
      <AttachmentPanel ownerType="document" ownerId={note.id} readOnly />
      <RelatedNotes targetType="document" targetId={note.id} />
    </article>
  );
}
