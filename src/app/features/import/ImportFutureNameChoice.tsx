import type {
  IntakeIdentityConfirmation,
  IntakeIdentityPerson,
} from '../../../shared/intake-identity';

export type FutureNameChoice = NonNullable<IntakeIdentityConfirmation['futureNameOwner']>;

/** The report assignment and the rule for later same-name reports are separate choices. */
export function ImportFutureNameChoice({
  name,
  people,
  value,
  onChange,
  disabled,
}: {
  name: string;
  people?: IntakeIdentityPerson[];
  value: FutureNameChoice;
  onChange: (value: FutureNameChoice) => void;
  disabled?: boolean;
}) {
  const selected = value.outcome === 'person' ? `person:${value.noteId}` : value.outcome;
  return (
    <label>
      Later reports printed “{name}”
      <select
        value={selected}
        disabled={disabled}
        onChange={(event) => {
          const choice = event.target.value;
          if (choice === 'self' || choice === 'ask') onChange({ outcome: choice });
          else {
            const person = people?.find((item) => `person:${item.noteId}` === choice);
            if (person)
              onChange({
                outcome: 'person',
                noteId: person.noteId,
                expectedVersion: person.version,
              });
          }
        }}
      >
        <option value="ask">Ask each time</option>
        <option value="self">Always me</option>
        {people
          ?.filter((person) => person.personId !== 'patient')
          .map((person) => (
            <option key={person.noteId} value={`person:${person.noteId}`}>
              Always {person.fullName}
            </option>
          ))}
      </select>
      <small>
        Choose who later reports with this exact printed name should suggest. The current report is
        confirmed separately.
      </small>
    </label>
  );
}
