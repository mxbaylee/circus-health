import type { IntakeIdentityPerson } from '../../../shared/intake-identity';

/** Match the import chooser's identity details, including stable IDs for alike names. */
export function importPersonLabel(person: IntakeIdentityPerson, people: IntakeIdentityPerson[]) {
  const alike =
    people.filter((item) => item.fullName.toLowerCase() === person.fullName.toLowerCase()).length >
    1;
  return [
    person.fullName,
    person.birthDate ? 'DOB ' + person.birthDate : alike ? 'DOB not saved' : null,
    person.relationship,
    alike ? person.personId : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
