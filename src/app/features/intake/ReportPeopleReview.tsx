import { apiUrl } from '../../data/api';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, UserRound, UsersRound } from 'lucide-react';
import type {
  IntakePeopleQueue,
  IntakePersonProposal,
  IntakePersonProposalState,
} from '../../../shared/intake-people';
import type { CollectionPersonProposal } from '../../../shared/intake-clinical-pages';

export type { IntakePeopleQueue, IntakePersonProposal } from '../../../shared/intake-people';

const statusLabel: Record<IntakePersonProposalState, string> = {
  pending: 'To review',
  later: 'Review later',
  excluded: 'Excluded',
  saved: 'Saved',
};

function contactSummary(proposal: IntakePersonProposal | CollectionPersonProposal) {
  return (
    proposal.person.relationship ||
    proposal.person.email ||
    proposal.person.phone ||
    proposal.person.tags.join(' · ') ||
    'Named person'
  );
}

export function ReportPeopleReview<
  Proposal extends IntakePersonProposal | CollectionPersonProposal,
>({
  queue,
  preferredState,
  preferredPersonId,
  busy,
  loadingMore,
  onLoadMore,
  onDisposition,
  onApply,
}: {
  queue: Omit<IntakePeopleQueue, 'people'> & { people: Proposal[] };
  preferredState?: Extract<IntakePersonProposalState, 'pending' | 'later'>;
  preferredPersonId?: string;
  busy: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onDisposition: (proposal: Proposal, state: 'pending' | 'later' | 'excluded') => void;
  onApply: (
    proposal: Proposal,
    choice: { action: 'add' } | { action: 'update'; noteId: string; version: number },
  ) => void;
}) {
  const availableStates = useMemo(
    () => [...new Set(queue.people.map((proposal) => proposal.state))],
    [queue.people],
  );
  const defaultState = () =>
    (preferredState && availableStates.includes(preferredState) ? preferredState : undefined) ||
    (availableStates.includes('pending') ? 'pending' : availableStates[0] || 'pending');
  const [state, setState] = useState<IntakePersonProposalState>(defaultState());
  const [focusedId, setFocusedId] = useState<string | null>(() => preferredPersonId || null);
  const returnFocus = useRef<string | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setState(defaultState());
    setFocusedId(
      preferredPersonId && queue.people.some((proposal) => proposal.id === preferredPersonId)
        ? preferredPersonId
        : null,
    );
  }, [queue.groupId, preferredState, preferredPersonId]);
  useEffect(() => {
    if (!availableStates.includes(state))
      setState(availableStates.includes('pending') ? 'pending' : availableStates[0] || 'pending');
  }, [availableStates, state]);
  useEffect(() => {
    if (focusedId) detailHeading.current?.focus();
  }, [focusedId]);

  const visible = queue.people.filter((proposal) => proposal.state === state);
  const focused = queue.people.find((proposal) => proposal.id === focusedId) || null;
  const back = () => {
    const id = returnFocus.current;
    setFocusedId(null);
    requestAnimationFrame(() => {
      if (id) document.getElementById(id)?.focus();
    });
  };

  if (focused) {
    const fields = [
      ['Relationship', focused.person.relationship],
      ['Phone', focused.person.phone],
      ['Email', focused.person.email],
      ['Scheduling link', focused.person.schedulingUrl],
    ].filter((field): field is [string, string] => !!field[1]);
    return (
      <section className="report-people-detail" aria-label={`Review ${focused.person.fullName}`}>
        <button type="button" className="text-link" onClick={back}>
          <ArrowLeft size={15} aria-hidden="true" /> Back to People
        </button>
        <header>
          <div>
            <p className="eyebrow">NAMED PERSON</p>
            <h3 ref={detailHeading} tabIndex={-1}>
              {focused.person.fullName}
            </h3>
            <p>{contactSummary(focused)}</p>
          </div>
          <span className={`soft-badge ${focused.state}`}>{statusLabel[focused.state]}</span>
        </header>
        {!!fields.length && (
          <dl className="report-person-fields">
            {fields.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {focused.person.medicalHistory && (
          <section className="report-person-history" aria-label="Shared history">
            <h4>Shared history</h4>
            <p>{focused.person.medicalHistory}</p>
          </section>
        )}
        {!!focused.uncertainties.length && (
          <section className="report-person-uncertainties" aria-label="Details to check">
            <h4>Details to check</h4>
            <ul>
              {focused.uncertainties.map((uncertainty) => (
                <li key={uncertainty}>{uncertainty}</li>
              ))}
            </ul>
          </section>
        )}
        <section className="report-person-evidence" aria-label="Original evidence">
          <div>
            <h4>Original evidence</h4>
            <a
              href={apiUrl(focused.evidence[0]?.contentUrl || focused.source.contentUrl)}
              target="_blank"
              rel="noreferrer"
            >
              Open original <ExternalLink size={14} aria-hidden="true" />
            </a>
          </div>
          {focused.evidence.map((evidence, index) => (
            <blockquote key={`${evidence.locator}:${index}`}>
              <p>{evidence.textAnchor}</p>
              <footer>
                {evidence.locator}
                {evidence.page ? ` · page ${evidence.page}` : ''}
                {evidence.supports.length
                  ? ` · supports ${evidence.supports
                      .join(', ')
                      .replaceAll(/([A-Z])/g, ' $1')
                      .toLowerCase()}`
                  : ''}
              </footer>
            </blockquote>
          ))}
        </section>
        {focused.state === 'pending' && (
          <section className="report-person-choices" aria-label="Save person choice">
            {focused.selfMatch ? (
              <div className="report-person-self-match" role="status">
                <strong>This looks like Self</strong>
                <p>{focused.selfMatch.reason}</p>
                <p className="helper-text">
                  Self belongs in clinical records, so this proposal cannot be added to People.
                </p>
              </div>
            ) : !!focused.matches.length ? (
              <div className="report-person-matches">
                <h4>Possible existing People</h4>
                {focused.matches.map((match) => (
                  <article key={match.noteId}>
                    <div>
                      <strong>{match.fullName}</strong>
                      <small>
                        {match.relationship ? `${match.relationship} · ` : ''}
                        {match.reason}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        onApply(focused, {
                          action: 'update',
                          noteId: match.noteId,
                          version: match.version,
                        })
                      }
                    >
                      Update {match.fullName}
                    </button>
                  </article>
                ))}
                <p className="helper-text">
                  A possible match never combines people automatically. Choose one current person or
                  add a new person.
                </p>
                {focused.matchesTruncated && (
                  <p className="helper-text">
                    Showing {focused.matches.length} of {focused.matchCount} possible matches.
                  </p>
                )}
              </div>
            ) : null}
            <div className="report-person-primary-actions">
              {!focused.selfMatch && (
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() => onApply(focused, { action: 'add' })}
                >
                  <UserRound size={16} aria-hidden="true" /> Add as new person
                </button>
              )}
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => onDisposition(focused, 'later')}
              >
                Review later
              </button>
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() => onDisposition(focused, 'excluded')}
              >
                Exclude from results
              </button>
            </div>
          </section>
        )}
        {(focused.state === 'later' || focused.state === 'excluded') && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => onDisposition(focused, 'pending')}
          >
            Return to review
          </button>
        )}
        {focused.state === 'saved' && focused.saved && (
          <a className="button secondary" href={focused.saved.resultUrl}>
            Open saved person
          </a>
        )}
      </section>
    );
  }

  return (
    <section className="report-people" aria-label="People from this report">
      <div className="report-status-tabs" role="tablist" aria-label="People status">
        {availableStates.map((value) => (
          <button
            type="button"
            role="tab"
            key={value}
            aria-selected={state === value}
            onClick={() => setState(value)}
          >
            {statusLabel[value]}{' '}
            <span>{queue.people.filter((proposal) => proposal.state === value).length}</span>
          </button>
        ))}
      </div>
      <div className="report-people-list">
        {visible.map((proposal) => {
          const id = `report-person-${encodeURIComponent(proposal.id)}`;
          return (
            <article className="report-person-row" key={proposal.id}>
              <button
                id={id}
                type="button"
                className="report-person-open"
                onClick={() => {
                  returnFocus.current = id;
                  setFocusedId(proposal.id);
                }}
              >
                <UsersRound size={18} aria-hidden="true" />
                <span>
                  <strong>{proposal.person.fullName}</strong>
                  <small>{contactSummary(proposal)}</small>
                </span>
              </button>
              <div className="report-person-row-actions">
                {proposal.state === 'pending' && (
                  <button
                    type="button"
                    className="text-link"
                    disabled={busy}
                    onClick={() => onDisposition(proposal, 'later')}
                  >
                    Review later
                  </button>
                )}
                {(proposal.state === 'later' || proposal.state === 'excluded') && (
                  <button
                    type="button"
                    className="text-link"
                    disabled={busy}
                    onClick={() => onDisposition(proposal, 'pending')}
                  >
                    Return to review
                  </button>
                )}
                <span className={`soft-badge ${proposal.state}`}>
                  {statusLabel[proposal.state]}
                </span>
              </div>
            </article>
          );
        })}
      </div>
      {!visible.length && <p className="resource-state">No named People in this view.</p>}
      {queue.people.length < queue.totalPeople && (
        <p className="helper-text">
          Showing {queue.people.length} of {queue.totalPeople} named People from this report.
        </p>
      )}
      {queue.peopleNextCursor && (
        <button
          type="button"
          className="button secondary report-load-more"
          disabled={busy || loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? 'Loading People…' : 'Load more People'}
        </button>
      )}
    </section>
  );
}
