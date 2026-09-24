import test from 'node:test';
import assert from 'node:assert/strict';
import { assessIdentityPolicy } from '../intake-identity-policy.ts';
import { knownNamesError, validOnboardingBirthDate } from '../../shared/self-identity.ts';

const self = {
  noteId: 'person-note:self' as const,
  version: 1,
  fullName: 'Iris Rowan Meadow',
  knownNames: ['Iris Rowan Brook'],
  birthDate: '1982-04-17',
};
const assess = (evidence: { fullName?: string; birthDate?: string }, extra = {}) =>
  assessIdentityPolicy({
    self,
    evidence,
    group: null,
    groupVersionId: null,
    originalFingerprint: null,
    ...extra,
  });

test('explicit saved names match exact normalized aliases without changing Self or accepting records', () => {
  const snapshot = structuredClone(self);
  const result = assess({ fullName: '  IRIS   ROWAN BROOK ', birthDate: self.birthDate });
  assert.equal(result.status, 'evidenced_match');
  assert.equal(result.confidence, 'strong');
  assert.deepEqual(self, snapshot);
  assert.deepEqual(result.offeredSelfFields, {});
  assert.equal(assess({ fullName: self.knownNames[0] }).confidence, 'limited');
});

test('initials and missing middle names require confirmation, even with matching DOB', () => {
  for (const fullName of ['I. R. Meadow', 'Iris Meadow']) {
    const result = assess({ fullName, birthDate: self.birthDate });
    assert.equal(result.confidence, 'possible');
    assert.equal(result.status, 'confirmation_required');
    assert.equal(result.blocking, true);
    assert.equal(result.attribution, undefined);
  }
});

test('aliases and DOB do not override different names, conflicting DOB, questions or refusal', () => {
  assert.equal(
    assess({ fullName: 'Iris Different', birthDate: self.birthDate }).status,
    'conflict',
  );
  assert.equal(
    assess({ fullName: self.knownNames[0], birthDate: '1983-04-17' }).status,
    'conflict',
  );
  for (const currentRefusal of ['unknown', 'other_person'])
    assert.equal(
      assess({ fullName: self.knownNames[0], birthDate: self.birthDate }, { currentRefusal })
        .blocking,
      true,
    );
  assert.equal(
    assess({ fullName: self.knownNames[0] }, { hasUnstructuredIdentityQuestion: true }).blocking,
    true,
  );
  assert.equal(
    assess({ fullName: self.knownNames[0] }, { self: { ...self, knownNames: [] } }).status,
    'conflict',
  );
});

test('new-profile DOB requires real complete nonfuture dates and aliases are bounded unique human inputs', () => {
  for (const value of ['', '1982', '1982-04', '1900-02-29', '1982-04-31', '9999-01-01', 'unknown'])
    assert.equal(validOnboardingBirthDate(value), false, value);
  assert.equal(validOnboardingBirthDate('2000-02-29'), true);
  assert.equal(validOnboardingBirthDate('0004-02-29'), true);
  assert.equal(knownNamesError(['Iris Brook']), null);
  for (const names of [
    'Iris Brook',
    [''],
    ['Iris Brook', ' IRIS BROOK '],
    Array(33).fill('Name'),
    ['Name\nOther'],
  ])
    assert.ok(knownNamesError(names));
});
