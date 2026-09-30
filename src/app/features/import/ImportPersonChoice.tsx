import { useRef } from 'react';
import { matchesSelfIdentityName } from '../../../shared/self-identity';
import {
  compatibleIdentityBirthDates,
  safeSourceIdentityName,
} from '../../../shared/self-identity';
import type {
  IntakeIdentityConfirmation,
  IntakeIdentityReview,
} from '../../../shared/intake-identity';

export type ImportPersonSelection = IntakeIdentityConfirmation['personSelection'];

export function ImportPrintedName({
  value,
  subjectText,
  onChange,
  disabled,
}: {
  value: string;
  subjectText: string;
  onChange: (name: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="note-field">
      Name printed on this report
      <input
        value={value}
        maxLength={200}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <small>
        Copy only the person's name from “{subjectText}”. A single name stays in this report’s
        confirmation; it does not become a reusable alias.
      </small>
    </label>
  );
}

export const printedNameReady = (name: string, subjectText: string): boolean =>
  !!name.trim() && name.trim().length <= 200 && subjectText.includes(name.trim());

/** A person choice is explicit; a printed name never silently creates or selects People. */
export function ImportPersonChoice({
  selfDisabled = false,
  selfNames = [],
  birthDate,
  people = [],
  peopleTruncated,
  assignedPerson,
  selection,
  onChange,
  printedName,
  disabled,
}: {
  selfDisabled?: boolean;
  selfNames?: string[];
  birthDate?: string;
  people?: IntakeIdentityReview['people'];
  peopleTruncated?: boolean;
  assignedPerson?: IntakeIdentityReview['assignedPerson'];
  selection: ImportPersonSelection;
  onChange: (selection: ImportPersonSelection) => void;
  printedName?: string;
  disabled?: boolean;
}) {
  const retainedPeople = useRef(
    new Map<string, NonNullable<IntakeIdentityReview['people']>[number]>(),
  );
  for (const person of people) retainedPeople.current.set(person.noteId, person);
  const priorSelection =
    selection && 'noteId' in selection ? retainedPeople.current.get(selection.noteId) : undefined;
  if (priorSelection && !people.some((person) => person.noteId === priorSelection.noteId))
    people = [...people, priorSelection];
  const selfNameConflict =
    selection &&
    'newPerson' in selection &&
    matchesSelfIdentityName(selection.newPerson.fullName, selfNames);
  const choices =
    assignedPerson &&
    assignedPerson.personId !== 'patient' &&
    !people.some((person) => person.noteId === assignedPerson.noteId)
      ? [...people, assignedPerson]
      : people;
  const value = !selection ? 'self' : 'newPerson' in selection ? 'new' : selection.noteId;
  return (
    <fieldset className="import-person-choice" disabled={disabled}>
      <legend>Who is this report for?</legend>
      <label>
        Person
        <select
          aria-label="Person for this report"
          value={value}
          onChange={(event) => {
            const selected = event.target.value;
            if (selected === 'self') onChange(undefined);
            else if (selected === 'new') onChange({ newPerson: { fullName: printedName || '' } });
            else {
              const person = choices.find((item) => item.noteId === selected);
              if (person) onChange({ noteId: person.noteId, expectedVersion: person.version });
            }
          }}
        >
          <option value="self" disabled={selfDisabled}>
            Me (Self)
          </option>
          {choices.map((person) => (
            <option
              key={person.noteId}
              value={person.noteId}
              disabled={
                !!(
                  birthDate &&
                  person.birthDate &&
                  !compatibleIdentityBirthDates(birthDate, person.birthDate)
                )
              }
            >
              {person.fullName}
              {choices.filter(
                (item) => item.fullName.toLowerCase() === person.fullName.toLowerCase(),
              ).length > 1
                ? ' · ' +
                  [
                    person.birthDate ? 'DOB ' + person.birthDate : 'DOB not saved',
                    person.relationship,
                    person.personId,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : person.birthDate
                  ? ' · DOB ' + person.birthDate
                  : ''}
            </option>
          ))}
          <option value="new">Add a new person</option>
        </select>
      </label>
      {selfDisabled && (
        <small>
          The report birth date differs from yours. Choose another person or add a new person.
        </small>
      )}
      {peopleTruncated && (
        <small>
          The first 100 people are listed. Check People before creating another entry for someone
          already in your archive.
        </small>
      )}
      {selection && 'newPerson' in selection && (
        <>
          <label>
            Person’s name
            <input
              aria-label="New person name"
              aria-invalid={!!selfNameConflict}
              aria-describedby={selfNameConflict ? 'new-person-self-conflict' : undefined}
              value={selection.newPerson.fullName}
              onChange={(event) =>
                onChange({ newPerson: { ...selection.newPerson, fullName: event.target.value } })
              }
            />
          </label>
          <label>
            Relationship (optional)
            <input
              aria-label="New person relationship"
              placeholder="For example, sister or father"
              value={selection.newPerson.relationship || ''}
              onChange={(event) =>
                onChange({
                  newPerson: { ...selection.newPerson, relationship: event.target.value },
                })
              }
            />
          </label>
          {selfNameConflict && (
            <p role="alert" id="new-person-self-conflict">
              This name belongs to Self. Choose Me (Self).
            </p>
          )}
          <small>This adds a person to People. Results stay in review until you save them.</small>
        </>
      )}
      {!selection && printedName && safeSourceIdentityName(printedName) && (
        <small>
          Confirming retains “{printedName}” in your Names with this report as evidence. Display
          name and existing date of birth stay unchanged; selected blank details can be filled.
        </small>
      )}
      {selection && !('newPerson' in selection) && (
        <small>
          This report will belong to the selected person. Supported names are retained in their
          Names; a single name is kept only in this report’s confirmation. Results stay in review
          until you save them.
        </small>
      )}
    </fieldset>
  );
}

export const personSelectionReady = (
  selection: ImportPersonSelection,
  selfNames: string[] = [],
): boolean =>
  !selection ||
  !('newPerson' in selection) ||
  (!!selection.newPerson.fullName.trim() &&
    !matchesSelfIdentityName(selection.newPerson.fullName, selfNames));

export function ImportBirthDateReview({
  review,
  value,
  onChange,
  disabled,
}: {
  review: NonNullable<NonNullable<IntakeIdentityReview['scope']>['birthDateReview']>;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  const yearOnly = review.choices.some((choice) => /^\d{4}$/.test(choice));
  return (
    <fieldset disabled={disabled} className="import-identity-self-fields">
      <legend>Review the birth date on this report</legend>
      <p>
        A date reading needs your confirmation. An inferred century is only a suggestion. This
        answer stays with this report and does not change anyone’s saved birth date.
      </p>
      {!!review.choices.length && <p>Possible readings: {review.choices.join(' or ')}.</p>}
      <label>
        {yearOnly ? 'Birth year read from the original' : 'Birth date read from the original'}
        <input
          type={yearOnly ? 'text' : 'date'}
          inputMode={yearOnly ? 'numeric' : undefined}
          maxLength={yearOnly ? 4 : undefined}
          aria-label={yearOnly ? 'Reviewed report birth year' : 'Reviewed report birth date'}
          value={value || ''}
          onChange={(event) => onChange(event.target.value || null)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={value === null}
          onChange={(event) => onChange(event.target.checked ? null : review.suggested || '')}
        />
        I cannot determine the birth date; keep it unknown.
      </label>
    </fieldset>
  );
}
