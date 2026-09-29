import { ClinicalOwner } from '../../components/ClinicalOwner';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Link2, Plus, Search, X } from 'lucide-react';
import type { LinkTarget, LinkTargetType, Note, NoteLink } from '../../../shared/api';
import { useResource } from '../../data/api';
import { NoteDialog } from './NoteDialog';
import { LoadingIndicator } from '../../components/LoadingIndicator';

export function linkHref(
  link: Pick<NoteLink, 'targetType' | 'targetId'> & {
    sourceRecordId?: string;
    resolvedTargetType?: LinkTargetType;
    appUrl?: string;
  },
) {
  if (link.appUrl) return link.appUrl;
  const id = encodeURIComponent(link.targetId);
  switch (link.resolvedTargetType || link.targetType) {
    case 'note':
      return `/notes?id=${id}`;
    case 'person':
      return `/notes?kind=person&id=${id}`;
    case 'test_type':
      return `/tests?view=by-test&type=${id}&detail=1`;
    case 'observation':
      return `/tests?result=${id}&detail=1`;
    case 'medication':
      return `/medications?id=${id}`;
    case 'procedure':
      return `/procedures?id=${id}`;
    case 'source':
      return link.sourceRecordId
        ? `/sources?record=${encodeURIComponent(link.sourceRecordId)}`
        : `/sources?file=${id}`;
    case 'document':
      return `/sources?document=${id}`;
  }
}

function CurrentLinkedNote({ link }: { link: NoteLink }) {
  const [expanded, setExpanded] = useState(false);
  const resource = useResource<Note>(
    expanded ? `/notes/${encodeURIComponent(link.targetId)}` : null,
  );
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>Read current linked content</summary>
      {resource.loading && <LoadingIndicator label="Loading current content…" size="small" />}
      {resource.error && (
        <p role="alert">
          {resource.error.message}{' '}
          <button type="button" className="text-link" onClick={resource.reload}>
            Retry
          </button>
        </p>
      )}
      {resource.data && (
        <>
          <ClinicalOwner personId={resource.data.ownerPersonId || 'patient'} />
          <p>
            <strong>{resource.data.title}</strong>
            <br />
            {resource.data.content || 'No freeform content recorded.'}
          </p>
          {resource.data.kind === 'person' && (
            <p>
              {resource.data.person.relationship && (
                <>
                  Relationship: {resource.data.person.relationship}
                  <br />
                </>
              )}
              {resource.data.person.medicalHistory && (
                <>
                  Medical / family history: {resource.data.person.medicalHistory}
                  <br />
                </>
              )}
              {resource.data.person.bloodType && (
                <>
                  Blood type: {resource.data.person.bloodType}
                  <br />
                  Uncertainty: {resource.data.person.bloodTypeUncertainty || 'Not recorded'}
                </>
              )}
            </p>
          )}
          <p>
            Current as of this view · Updated {new Date(resource.data.updatedAt).toLocaleString()}
            {resource.data.attachments.length
              ? ` · ${resource.data.attachments.length} attachments in linked entry`
              : ''}
          </p>
        </>
      )}
    </details>
  );
}

const TARGET_LABELS: Record<string, string> = {
  note: 'Notes',
  person: 'People',
  test_type: 'Test series',
  observation: 'Individual results',
  medication: 'Medications',
  procedure: 'Procedures',
  document: 'Provider documents',
  source: 'Source files',
};

export function NoteLinks({
  links,
  onChange,
  readOnly = false,
  currentNoteId,
  backlinks = [],
  hideOutgoing = false,
  personContext = false,
}: {
  links: NoteLink[];
  onChange: (links: NoteLink[]) => void;
  readOnly?: boolean;
  currentNoteId?: string;
  backlinks?: NoteLink[];
  hideOutgoing?: boolean;
  personContext?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [targetType, setTargetType] = useState<LinkTargetType | ''>('');
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search), 180);
    return () => window.clearTimeout(timer);
  }, [search]);
  const targets = useResource<LinkTarget[]>(
    pickerOpen
      ? `/link-targets?q=${encodeURIComponent(query)}&limit=50${targetType ? `&type=${encodeURIComponent(targetType)}` : ''}`
      : null,
  );
  const available = (targets.data || []).filter(
    (target) =>
      target.targetId !== currentNoteId &&
      !links.some(
        (link) => link.targetType === target.targetType && link.targetId === target.targetId,
      ),
  );
  function add(target: LinkTarget) {
    onChange([
      ...links,
      {
        ...target,
        id: `unsaved-${crypto.randomUUID()}`,
        relation: 'references',
        archived: target.archived,
        missing: false,
        current: true,
      },
    ]);
    setPickerOpen(false);
    setSearch('');
  }
  function rows(items: NoteLink[], removable: boolean) {
    return (
      <ul className="note-linked-list">
        {items.map((link) => (
          <li className="note-linked-item" key={link.id}>
            <div className="note-linked-heading">
              <Link2 size={16} className="pink-icon" />
              <div className="note-linked-title">
                {link.missing ? (
                  <span>{link.title || 'Unavailable linked record'}</span>
                ) : (
                  <Link to={linkHref(link)}>
                    {link.title}
                    <ExternalLink size={12} style={{ marginLeft: 6 }} />
                  </Link>
                )}
                <small>
                  {TARGET_LABELS[link.resolvedTargetType || link.targetType] || 'Linked record'} ·{' '}
                  {link.relation === 'corrects' ? 'Corrects earlier note · ' : ''}
                  {link.missing
                    ? 'Target unavailable; reference preserved'
                    : link.archived
                      ? 'Inactive target · current version'
                      : 'Current linked version'}
                </small>
              </div>
              {removable && !readOnly && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove link to ${link.title}`}
                  onClick={() => onChange(links.filter((item) => item.id !== link.id))}
                >
                  <X size={16} />
                </button>
              )}
            </div>
            {!link.missing && (link.targetType === 'note' || link.targetType === 'person') && (
              <CurrentLinkedNote link={link} />
            )}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <>
      {!hideOutgoing && (
        <section className="note-section">
          <div className="section-heading">
            <h3>
              <Link2 size={17} /> {personContext ? 'Manually linked entries' : 'Linked entries'}
            </h3>
            {!readOnly && (
              <button type="button" className="text-link" onClick={() => setPickerOpen(true)}>
                <Plus size={16} /> {personContext ? 'Add manual link' : 'Add link'}
              </button>
            )}
          </div>
          {links.length ? (
            rows(links, true)
          ) : (
            <p>
              {personContext
                ? 'No manually linked entries. Manual links are separate from imported source evidence.'
                : 'No linked entries.'}
            </p>
          )}
          {links.length > 0 && (
            <p className="helper-text">
              {personContext
                ? 'These are links you added. Imported source evidence is separate and read-only when available.'
                : 'Linked entries show their current version, including inside a finished note.'}
            </p>
          )}
        </section>
      )}
      {backlinks.length > 0 && (
        <section className="note-section">
          <div className="section-heading">
            <h3>Referenced by</h3>
            <span className="quiet-badge">{backlinks.length}</span>
          </div>
          {rows(backlinks, false)}
        </section>
      )}
      <NoteDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title="Link an entry"
        description="Find a note, person or medical record. Links keep pointing to its current version."
      >
        <label className="note-field note-link-filter">
          Record type
          <select
            value={targetType}
            onChange={(event) => setTargetType(event.target.value as LinkTargetType | '')}
          >
            <option value="">All types</option>
            {Object.entries(TARGET_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="search-field" style={{ marginTop: 20 }}>
          <Search size={17} />
          <input
            autoFocus
            aria-label="Search notes, people and clinical records"
            placeholder="Search notes, people, results…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="note-picker-results">
          {targets.loading && (
            <LoadingIndicator className="notes-loading" label="Searching…" layout="panel" />
          )}
          {targets.error && (
            <p className="note-warning" role="alert">
              {targets.error.message}
              <button type="button" className="text-link" onClick={targets.reload}>
                Try again
              </button>
            </p>
          )}
          {!targets.loading && !targets.error && available.length === 0 && (
            <p className="notes-loading">No matching entries to link.</p>
          )}
          {available.map((target) => (
            <button
              type="button"
              className="note-picker-row"
              key={`${target.targetType}:${target.targetId}`}
              onClick={() => add(target)}
            >
              <Link2 size={18} />
              <span>
                <strong>{target.title}</strong>
                <small>
                  {TARGET_LABELS[target.targetType] || target.targetType}
                  {target.subtitle ? ` · ${target.subtitle}` : ''}
                  {target.archived ? ' · inactive' : ''}
                </small>
              </span>
              <Plus size={17} />
            </button>
          ))}
        </div>
        {(targets.meta?.complete === false ||
          Number(targets.meta?.total) > (targets.data?.length || 0)) && (
          <p className="helper-text">
            Showing up to {targets.data?.length || 0} matches. Refine your search to find a specific
            entry.
          </p>
        )}
      </NoteDialog>
    </>
  );
}
