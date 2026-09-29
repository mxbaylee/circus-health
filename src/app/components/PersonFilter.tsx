import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useResource } from '../data/api';
import { useProfile } from '../data/profile';
import { personSelectionQuery } from '../../shared/person-scope';
import { usePersonScope } from './PersonScope';
import { SelectionChip } from './SelectionChip';
import { LoadingIndicator } from './LoadingIndicator';
import type { ClinicalPersonOption } from '../../shared/api';
import {
  canonicalPersonDisplayName,
  canonicalPersonDisplayIcon,
} from '../../shared/person-display';

export function PersonFilter({ disabled = false }: { disabled?: boolean }) {
  const scope = usePersonScope();
  const profile = useProfile();
  return scope?.filterable ? (
    <PersonFilterControl
      key={`${profile?.id}:${scope.personId}`}
      scope={scope}
      disabled={disabled}
    />
  ) : null;
}
function PersonFilterControl({
  scope,
  disabled,
}: {
  scope: NonNullable<ReturnType<typeof usePersonScope>>;
  disabled: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(scope.personId);
  const editButton = useRef<HTMLButtonElement>(null);
  const people = useResource<ClinicalPersonOption[]>(editing ? '/clinical-people' : null);
  const canApply =
    !disabled &&
    !scope.pending &&
    !people.loading &&
    !people.error &&
    !!people.data &&
    draft !== scope.personId &&
    (draft === 'patient' || people.data.some((person) => person.personId === draft));
  const optionKey = (person: ClinicalPersonOption) =>
    JSON.stringify([canonicalPersonDisplayName(person.name), person.birthDate]);
  const duplicateCounts = new Map<string, number>();
  for (const person of people.data || []) {
    const key = optionKey(person);
    duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1);
  }
  function close() {
    setEditing(false);
    editButton.current?.focus();
  }
  return (
    <li
      className={`person-filter${scope.personId === 'patient' ? ' is-self' : ''}${editing ? ' is-editing' : ''}`}
    >
      <SelectionChip
        label={scope.name}
        editButtonRef={editButton}
        disabled={disabled || scope.pending}
        editLabel={`Edit person: ${scope.name}`}
        onEdit={() => {
          setDraft(scope.personId);
          setEditing(true);
        }}
      />
      {editing && (
        <section className="filter-panel" aria-label="Person filter">
          <form
            className="filter-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canApply) return;
              setParams(personSelectionQuery(params, draft));
              close();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
          >
            <label>
              Show records for
              <select
                autoFocus
                value={draft}
                disabled={disabled || scope.pending || people.loading || !!people.error}
                onChange={(event) => setDraft(event.target.value)}
              >
                <option value="patient">Self</option>
                {scope.personId !== 'patient' &&
                  !people.data?.some((person) => person.personId === scope.personId) && (
                    <option value={scope.personId}>{scope.name}</option>
                  )}
                {people.data?.map((person) => (
                  <option key={person.personId} value={person.personId}>
                    {person.name}
                    {person.birthDate ? ` · ${person.birthDate}` : ''}
                    {(duplicateCounts.get(optionKey(person)) || 0) > 1
                      ? ` · ${canonicalPersonDisplayIcon(person.icon).replaceAll('-', ' ')} icon`
                      : ''}
                  </option>
                ))}
              </select>
            </label>
            {people.loading && <LoadingIndicator label="Loading people…" size="small" />}
            {people.error && (
              <p role="alert">
                {people.error.message}{' '}
                <button type="button" className="text-link" onClick={people.reload}>
                  Retry
                </button>
              </p>
            )}
            <div className="people-filter-actions">
              <button className="button primary" type="submit" disabled={!canApply}>
                Save filter
              </button>
              <button className="button secondary" type="button" onClick={close}>
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}
    </li>
  );
}
