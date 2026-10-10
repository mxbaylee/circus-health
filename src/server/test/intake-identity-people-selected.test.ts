import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, transaction } from '../database.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { createIntakeFamilyPersonInTransaction } from '../notes.ts';
import {
  selectedIdentityPeopleSnapshots,
  identityPeopleSnapshots,
} from '../intake-identity-people.ts';
import { assessIdentityPolicy } from '../intake-identity-policy.ts';
import { selectedSequence } from '../intake-selected-sequence.ts';

test('complete saved-Person policy sees an owner and same-name conflict beyond the choice page', () => {
  const db = openDatabase(':memory:', 'fictional-selected-people');
  memoryRecordAuthority(db);
  try {
    transaction(db, () => {
      for (let n = 0; n < 105; n++)
        createIntakeFamilyPersonInTransaction(
          db,
          n === 104 ? 'Fictional Iris Meadow' : `Fictional Filler ${n}`,
          'relative',
          {
            noteId: `note:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
            personId: `person:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
            icon: 'user-round',
          },
        );
    });
    const people = selectedIdentityPeopleSnapshots(db);
    assert.equal(Array.isArray(people), false);
    assert.equal(people.length, 105);
    assert.deepEqual([...people], identityPeopleSnapshots(db));
    const expected = people.at(104)!;
    const input = {
      self: {
        noteId: 'person-note:self' as const,
        version: 1,
        fullName: 'Fictional Cedar Vale',
        birthDate: null,
      },
      people,
      evidence: { fullName: 'Fictional Iris Meadow' },
      group: null,
      groupVersionId: null,
      originalFingerprint: null,
    };
    const result = assessIdentityPolicy(input);
    assert.equal(result.status, 'evidenced_match');
    assert.equal(result.blocking, false);
    assert.deepEqual(result.attribution!.assignedPerson, {
      noteId: expected.noteId,
      personId: expected.personId,
      version: expected.version,
      fullName: expected.fullName,
    });
    const ambiguous = assessIdentityPolicy({
      ...input,
      people: selectedSequence(function* () {
        yield* people;
        yield { ...expected, noteId: 'fictional-late-note', personId: 'fictional-late-person' };
      }),
    });
    assert.equal(ambiguous.status, 'confirmation_required');
    assert.equal(ambiguous.blocking, true);
    assert.equal(ambiguous.attribution, undefined);
    assert.equal(people.at(104)!.personId, expected.personId);
  } finally {
    db.close();
  }
});
