import test from 'node:test';
import assert from 'node:assert/strict';
import { originalSubjectBirthDates } from '../intake-evidence-dates.ts';

test('patient header DOB is separate from report dates and relatives', () => {
  const subject = 'Patient: Cookie Doe';
  assert.deepEqual(
    originalSubjectBirthDates(
      `${subject}\nDate of birth: 1986-02-14\nCollected: 2026-09-20`,
      subject,
    ),
    ['1986-02-14'],
  );
  assert.deepEqual(
    originalSubjectBirthDates(
      `${subject}\nCollected: 2026-09-20\nMother: Other Doe DOB: 1960-01-01`,
      subject,
    ),
    [],
  );
  assert.deepEqual(
    originalSubjectBirthDates(`${subject}\nSubject: Another Doe DOB: 1960-01-01`, subject),
    [],
  );
  assert.deepEqual(originalSubjectBirthDates(`${subject}\nDOB: 02/03/1986`, subject), [
    '1986-02-03',
    '1986-03-02',
  ]);
  assert.deepEqual(originalSubjectBirthDates(`${subject}\nDOB: 1986-02-30`, subject), []);
  assert.deepEqual(
    originalSubjectBirthDates(`${subject}\nDOB: 1986-02-14\n${subject}\nDOB: 1990-01-01`, subject),
    ['1986-02-14', '1990-01-01'],
  );
});

test('a model quoting the entire multi-person header cannot turn a relative DOB into the patient DOB', () => {
  const header = 'Patient: Cookie Doe\nMother DOB: 1960-01-01';
  assert.deepEqual(originalSubjectBirthDates(header, header), []);
});
