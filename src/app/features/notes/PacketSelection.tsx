import { useMemo, useState } from 'react';
import type {
  PacketCandidate,
  PacketSelection as Selection,
  PacketReview,
  PacketRecordRef,
} from '../../../shared/packet-selection';

export type PacketOptions = {
  personId: string;
  candidates: PacketCandidate[];
  kinds: string[];
  tags: string[];
};
const matches = (a: PacketRecordRef, b: PacketRecordRef) =>
  a.kind === b.kind && a.recordId === b.recordId;
const categoryLabels: Record<string, string> = {
  observation: 'Results',
  medication: 'Medications',
  procedure: 'Procedures',
  note: 'Notes',
  document: 'Documents',
  source: 'Source assertions',
  source_file: 'Originals',
};
const categoryLabel = (kind: string) =>
  categoryLabels[kind] || kind.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
const pageSize = 50;
const boundedPage = (page: number, total: number) =>
  Math.min(page, Math.max(0, Math.ceil(total / pageSize) - 1));

function PageControls({
  label,
  total,
  page,
  onPage,
  busy,
}: {
  label: string;
  total: number;
  page: number;
  onPage: (page: number) => void;
  busy: boolean;
}) {
  return (
    <nav className="packet-pages" aria-label={`${label} pages`}>
      <span role="status">
        {total ? page * pageSize + 1 : 0}–{Math.min((page + 1) * pageSize, total)} of {total}{' '}
        {label.toLowerCase()}
      </span>
      {total > pageSize && (
        <>
          <button
            type="button"
            className="button secondary"
            disabled={busy || !page}
            onClick={() => onPage(page - 1)}
            aria-label={`Previous ${label.toLowerCase()}`}
          >
            Previous
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || (page + 1) * pageSize >= total}
            onClick={() => onPage(page + 1)}
            aria-label={`Next ${label.toLowerCase()}`}
          >
            Next
          </button>
        </>
      )}
    </nav>
  );
}

export function PacketSelection({
  packet,
  selection,
  onChange,
  onPreference,
  busy,
}: {
  packet: PacketOptions;
  selection: Selection;
  onChange: (selection: Selection) => void;
  onPreference: (candidate: PacketCandidate, alwaysWithhold: boolean, tags?: string[]) => void;
  busy: boolean;
}) {
  const [tagEdits, setTagEdits] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const visibleCandidates = useMemo(() => {
    const query = search.toLowerCase();
    return query
      ? packet.candidates.filter((candidate) =>
          [candidate.title, categoryLabel(candidate.kind), candidate.kind, ...candidate.tags]
            .join(' ')
            .toLowerCase()
            .includes(query),
        )
      : packet.candidates;
  }, [packet.candidates, search]);
  const currentPage = boundedPage(page, visibleCandidates.length);
  const pageCandidates = visibleCandidates.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  function choose(candidate: PacketCandidate, value: string) {
    const include = (selection.include || []).filter(
      (record) => !matches(record, candidate.record),
    );
    const exclude = (selection.exclude || []).filter(
      (record) => !matches(record, candidate.record),
    );
    if (value === 'include') include.push(candidate.record);
    if (value === 'exclude') exclude.push(candidate.record);
    onChange({ ...selection, include, exclude, approvals: [] });
  }
  function toggleCategory(category: 'kinds' | 'tags', value: string) {
    const values = selection[category] || (category === 'kinds' ? packet.kinds : []);
    onChange({
      ...selection,
      [category]: values.includes(value)
        ? values.filter((item) => item !== value)
        : [...values, value],
      approvals: [],
    });
  }
  return (
    <fieldset className="export-inclusions packet-selection" disabled={busy}>
      <legend>Choose records for this packet</legend>
      <p>These choices apply to this packet. Your complete history stays in the app.</p>
      <div className="export-filters">
        <fieldset>
          <legend>Record categories</legend>
          <p className="text-muted">Choose which categories to include.</p>
          {packet.kinds.map((kind) => (
            <label className="export-check" key={kind}>
              <input
                type="checkbox"
                checked={(selection.kinds || packet.kinds).includes(kind)}
                onChange={() => toggleCategory('kinds', kind)}
              />
              {categoryLabel(kind)}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Your record tags</legend>
          <p className="text-muted">Use tags you manually assign to this person's records.</p>
          <p className="text-muted">No tag filter includes all tags and untagged records.</p>
          {packet.tags.map((tag) => (
            <label className="export-check" key={tag}>
              <input
                type="checkbox"
                checked={(selection.tags || []).includes(tag)}
                onChange={() => toggleCategory('tags', tag)}
              />
              {tag}
            </label>
          ))}
          {!packet.tags.length && <p>No record tags saved.</p>}
        </fieldset>
        <label>
          From date
          <input
            type="date"
            value={selection.from || ''}
            onChange={(event) =>
              onChange({ ...selection, from: event.target.value || null, approvals: [] })
            }
          />
        </label>
        <label>
          Through date
          <input
            type="date"
            value={selection.to || ''}
            onChange={(event) =>
              onChange({ ...selection, to: event.target.value || null, approvals: [] })
            }
          />
        </label>
      </div>
      <p className="text-muted">
        Individual choices override category filters. Always leave out overrides every inclusion;
        clear that preference separately to make a record eligible again.
      </p>
      <p className="text-muted">
        Saved tags and always leave out preferences apply to future packets for this person. Tags
        are your own categories, not an assessment of sensitivity.
      </p>
      {!!packet.candidates.length && (
        <label className="note-field">
          Find a record
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            placeholder="Search titles, categories or tags"
          />
        </label>
      )}
      <p className="text-muted">
        {packet.candidates.length} records available. Search and paging only change this list; your
        packet choices stay selected.
      </p>
      <PageControls
        label="Records"
        total={visibleCandidates.length}
        page={currentPage}
        onPage={setPage}
        busy={busy}
      />
      <div className="export-choices packet-records">
        {pageCandidates.map((candidate) => {
          const value = (selection.exclude || []).some((record) =>
            matches(record, candidate.record),
          )
            ? 'exclude'
            : (selection.include || []).some((record) => matches(record, candidate.record))
              ? 'include'
              : 'default';
          return (
            <div className="packet-record" key={candidate.key}>
              <div>
                <strong>{candidate.title}</strong>
                <small>
                  {[categoryLabel(candidate.kind), candidate.date, ...candidate.tags]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </div>
              <label>
                <span className="sr-only">Packet choice for {candidate.title}</span>
                <select
                  value={value}
                  disabled={candidate.alwaysWithhold}
                  onChange={(event) => choose(candidate, event.target.value)}
                >
                  <option value="default">Use packet defaults</option>
                  <option value="include">Include this record</option>
                  <option value="exclude">Leave out this time</option>
                </select>
              </label>
              {candidate.alwaysWithhold ? (
                <div>
                  <small>Always left out of packets</small>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => onPreference(candidate, false)}
                    aria-label={`Clear always leave out for ${candidate.title}`}
                  >
                    Clear preference
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => onPreference(candidate, true)}
                  aria-label={`Always leave out ${candidate.title}`}
                >
                  Always leave out
                </button>
              )}
              <div className="packet-tag-editor">
                <label>
                  Tags for {candidate.title}
                  <input
                    maxLength={2622}
                    value={tagEdits[candidate.key] ?? candidate.tags.join(', ')}
                    placeholder="Separate tags with commas"
                    onChange={(event) =>
                      setTagEdits({ ...tagEdits, [candidate.key]: event.target.value })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="button secondary"
                  aria-label={`Save tags for ${candidate.title}`}
                  disabled={tagEdits[candidate.key] === undefined}
                  onClick={() => {
                    const tags = (tagEdits[candidate.key] || '')
                      .split(',')
                      .map((tag) => tag.trim())
                      .filter(Boolean);
                    onPreference(candidate, candidate.alwaysWithhold, [...new Set(tags)]);
                  }}
                >
                  Save tags
                </button>
              </div>
            </div>
          );
        })}
        {!packet.candidates.length && <p>No records available for this person.</p>}
        {!!packet.candidates.length && !visibleCandidates.length && <p>No matching records.</p>}
      </div>
    </fieldset>
  );
}

export function PacketPrivateReview({
  review,
  selection,
  onChange,
  busy,
}: {
  review: PacketReview;
  selection: Selection;
  onChange: (selection: Selection) => void;
  busy: boolean;
}) {
  const [withheldPage, setWithheldPage] = useState(0);
  const [opaquePage, setOpaquePage] = useState(0);
  const currentWithheldPage = boundedPage(withheldPage, review.withheld.length);
  const currentOpaquePage = boundedPage(opaquePage, review.opaqueItems.length);
  return (
    <section className="packet-private-review" aria-label="Private packet review">
      <h3>Private packet review</h3>
      <p>This review stays outside the printable packet.</p>
      <p>
        {review.includedCount} records included; {review.withheld.length} records left out.
      </p>
      {!!review.withheld.length && (
        <>
          {review.withheld.length > pageSize && (
            <PageControls
              label="Withheld records"
              total={review.withheld.length}
              page={currentWithheldPage}
              onPage={setWithheldPage}
              busy={busy}
            />
          )}
          <ul>
            {review.withheld
              .slice(currentWithheldPage * pageSize, (currentWithheldPage + 1) * pageSize)
              .map((item) => (
                <li key={item.key}>
                  {item.title}: {item.reason}
                </li>
              ))}
          </ul>
        </>
      )}
      {!!review.emptyKinds.length && (
        <p className="note-warning">
          No selected records in these categories: {review.emptyKinds.map(categoryLabel).join(', ')}
          .
        </p>
      )}
      {!!review.notice && <p>Shared notice: {review.notice}</p>}
      {!!review.opaqueItems.length && (
        <fieldset disabled={busy}>
          <legend>Review unredacted text and originals</legend>
          <p>
            Leaving out a record does not remove sensitive information repeated in note text, source
            assertions or original files. Review each item before explicitly allowing it. Approved
            items are shared unredacted and may disclose information from records you left out.
          </p>
          <PageControls
            label="Review items"
            total={review.opaqueItems.length}
            page={currentOpaquePage}
            onPage={setOpaquePage}
            busy={busy}
          />
          {review.opaqueItems
            .slice(currentOpaquePage * pageSize, (currentOpaquePage + 1) * pageSize)
            .map((item) => (
              <div className="export-check" key={item.key}>
                <input
                  type="checkbox"
                  id={`packet-approval-${item.key}`}
                  disabled={item.blocked}
                  checked={(selection.approvals || []).some(
                    (approval) =>
                      approval.key === item.key && approval.fingerprint === item.fingerprint,
                  )}
                  onChange={(event) => {
                    const approvals = (selection.approvals || []).filter(
                      (approval) => approval.key !== item.key,
                    );
                    if (event.target.checked)
                      approvals.push({ key: item.key, fingerprint: item.fingerprint });
                    onChange({ ...selection, approvals });
                  }}
                />
                <span>
                  <label htmlFor={`packet-approval-${item.key}`}>{item.title}</label>
                  <small>{item.reason}</small>
                  <small>
                    {item.blocked
                      ? 'Blocked by a persistent withholding preference.'
                      : item.included
                        ? 'Included unredacted in this frozen preview.'
                        : 'Left out of this frozen preview.'}
                  </small>
                  {item.contentUrl &&
                    (busy ? (
                      <span>
                        Private original review unavailable while preparing or changing profiles.
                      </span>
                    ) : (
                      <a href={item.contentUrl} target="_blank" rel="noreferrer">
                        Review private original (not a packet download)
                      </a>
                    ))}
                  {item.text && (
                    <details>
                      <summary>Review private text</summary>
                      <pre className="packet-private-text">{item.text}</pre>
                      {item.truncated && (
                        <small>Text is shortened here. Review the full record in the app.</small>
                      )}
                    </details>
                  )}
                </span>
              </div>
            ))}
          <p>
            After changing approval choices, refresh the preview before printing or downloading.
          </p>
        </fieldset>
      )}
    </section>
  );
}
