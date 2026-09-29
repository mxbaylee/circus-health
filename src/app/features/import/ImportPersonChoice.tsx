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
        Copy only the person's name from “{subjectText}”. Confirmation retains this name on their
        profile.
      </small>
    </label>
  );
}

export const printedNameReady = (name: string, subjectText: string): boolean =>
  !!name.trim() && name.trim().length <= 200 && subjectText.includes(name.trim());

/** A person choice is explicit; a printed name never silently creates or selects People. */
export function ImportPersonChoice({
  selfDisabled = false,
  people = [],
  peopleTruncated,
  assignedPerson,
  selection,
  onChange,
  printedName,
  disabled,
}: {
  selfDisabled?: boolean;
  people?: IntakeIdentityReview['people'];
  peopleTruncated?: boolean;
  assignedPerson?: IntakeIdentityReview['assignedPerson'];
  selection: ImportPersonSelection;
  onChange: (selection: ImportPersonSelection) => void;
  printedName?: string;
  disabled?: boolean;
}) {
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
            <option key={person.noteId} value={person.noteId}>
              {person.fullName}
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
          <small>This adds a person to People. Results stay in review until you save them.</small>
        </>
      )}
      {!selection && printedName && (
        <small>
          Confirming retains “{printedName}” in your Names with this report as evidence. Display
          name and existing date of birth stay unchanged; selected blank details can be filled.
        </small>
      )}
      {selection && !('newPerson' in selection) && (
        <small>
          This report will belong to the selected person. Its confirmed name is retained in their
          Names. Results stay in review until you save them.
        </small>
      )}
    </fieldset>
  );
}

export const personSelectionReady = (selection: ImportPersonSelection): boolean =>
  !selection || !('newPerson' in selection) || !!selection.newPerson.fullName.trim();
