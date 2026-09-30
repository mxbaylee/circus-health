import { Link } from 'react-router-dom';
import { useId, useState } from 'react';
import type { PersonProfile } from '../../../shared/api';
import { canonicalIdentityName } from '../../../shared/self-identity';
import { CreatableCombobox } from '../../components/CreatableCombobox';
import { SelectionChip } from '../../components/SelectionChip';
import { useResource } from '../../data/api';
import { linkHref } from './NoteLinks';
import type { OwnershipReceipt } from '../../../shared/record-ownership';
import './person-names.css';

/** One names list in the UI; legacy fullName remains compatible with retained profiles. */
export function PersonNames({
  person,
  disabled,
  onChange,
}: {
  person: PersonProfile;
  disabled: boolean;
  onChange: (person: PersonProfile) => void;
}) {
  const retainedDescriptionId = useId();
  const retained = person.sourceKnownNames || [];
  const protectedNames = new Set(retained.map((item) => canonicalIdentityName(item.name)));
  const names = [
    ...new Set(
      [person.fullName, ...(person.knownNames || [])].filter(
        (name): name is string => typeof name === 'string' && !!name.trim(),
      ),
    ),
  ].filter(
    (name, index, all) =>
      !protectedNames.has(canonicalIdentityName(name)) &&
      all.findIndex((other) => canonicalIdentityName(other) === canonicalIdentityName(name)) ===
        index,
  );
  const evidence = retained.filter(
    (item, index) => retained.findIndex((other) => other.name === item.name) === index,
  );
  return (
    <div className="note-field">
      <CreatableCombobox
        label="Names"
        values={names}
        options={[]}
        multiple
        maxLength={200}
        disabled={disabled}
        placeholder="Add a name this person uses"
        createNoun="name"
        listLabel="Names"
        onChange={(values) => {
          const keys = new Set(values.map(canonicalIdentityName));
          const fullName =
            person.fullName &&
            (keys.has(canonicalIdentityName(person.fullName)) ||
              protectedNames.has(canonicalIdentityName(person.fullName)))
              ? person.fullName
              : '';
          const combined = [...values, ...retained.map((item) => item.name)];
          onChange({
            ...person,
            fullName,
            knownNames: combined.filter(
              (name, index) =>
                combined.findIndex(
                  (other) => canonicalIdentityName(other) === canonicalIdentityName(name),
                ) === index,
            ),
          });
        }}
      />
      <small>
        Names entered here or during signup help match reports. Display name is separate.
      </small>
      {evidence.length > 0 && (
        <ul
          className="person-confirmed-names creatable-selection-chips"
          aria-label="Names retained from confirmed reports"
          aria-describedby={retainedDescriptionId}
        >
          {evidence.map((item) => (
            <li key={item.name}>
              {(() => {
                const association = person.nameAssociations?.find(
                  (candidate) =>
                    canonicalIdentityName(candidate.name) === canonicalIdentityName(item.name),
                );
                const confirmationDate = item.confirmedAt?.slice(0, 10);
                const correctionKind = association?.origin === 'ownership';
                return (
                  <>
                    <Link
                      to={`/import?${new URLSearchParams({ intake: item.intakeId, group: item.groupId })}`}
                      aria-label={`View report confirming ${item.name}`}
                    >
                      <SelectionChip label={item.name} />
                      {association?.status === 'superseded'
                        ? ' — historical, corrected'
                        : association?.status === 'unresolved'
                          ? ' — needs identity review'
                          : ' — active'}
                    </Link>
                    <small>
                      {' '}
                      Confirmed in the linked report
                      {confirmationDate ? ` on ${confirmationDate}` : ''}.
                      {association
                        ? ` ${association.status === 'active' ? 'Active' : association.status === 'superseded' ? 'Historical' : 'Needs review'} after ${correctionKind ? 'person correction' : association.origin === 'future' ? 'future-name choice' : 'report reconfirmation'} on ${association.at.slice(0, 10)}.`
                        : ''}
                    </small>
                    {correctionKind && association && (
                      <NameCorrectionDetails
                        operationId={association.operationId}
                        name={item.name}
                      />
                    )}
                    {association?.status === 'unresolved' && (
                      <p>
                        <Link
                          to={`/import?${new URLSearchParams({ intake: item.intakeId, group: item.groupId })}`}
                        >
                          Resolve this name in report identity review
                        </Link>
                      </p>
                    )}
                  </>
                );
              })()}
            </li>
          ))}
        </ul>
      )}
      {evidence.length > 0 && (
        <small id={retainedDescriptionId}>
          Historical report evidence stays retained. Select a name to view its report and use Change
          person to review the current association.
        </small>
      )}
    </div>
  );
}

function NameCorrectionDetails({ operationId, name }: { operationId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const correction = useResource<OwnershipReceipt>(
    open ? `/record-ownership/${encodeURIComponent(operationId)}` : null,
  );
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>View correction for {name}</summary>
      {correction.error && (
        <p role="alert">
          The correction receipt is unavailable. The historical report remains linked above.
        </p>
      )}
      {correction.data && (
        <>
          <p>Accepted person correction on {correction.data.at.slice(0, 10)}.</p>
          <ul>
            {correction.data.outcomes.map((outcome) => (
              <li key={outcome.recordId}>
                <Link
                  to={linkHref({ targetType: outcome.kind, targetId: outcome.destinationRecordId })}
                >
                  Open corrected {outcome.kind} and accepted history
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
