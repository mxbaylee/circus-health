import test from 'node:test';
import assert from 'node:assert/strict';
import {
  labelledBirthDateEvidence,
  originalSubjectBirthDateEvidence,
  originalSubjectBirthDates,
} from '../intake-evidence-dates.ts';

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

const subject = 'Patient: Cookie Doe';
const read = (line: string) => originalSubjectBirthDateEvidence(`${subject}\n${line}`, subject);

test('birth-date labels are recognized regardless of case, dots and spacing', () => {
  for (const label of [
    'DOB',
    'DOB:',
    'DOB.',
    'dob -',
    'D.O.B.',
    'D.O.B:',
    'Date of birth:',
    'DATE OF BIRTH',
    'Birth Date:',
    'Birthdate',
    'birth-date:',
    'Born',
    'Born:',
    'born on',
  ])
    assert.deepEqual(
      read(`${label} 1986-02-14`),
      { dates: ['1986-02-14'], unreadable: false },
      label,
    );
  // Prose, longer words and structured keys that are not a birth-date label.
  for (const text of ['Newborn screening 1986-02-14', 'Dobson Clinic', 'born prematurely'])
    assert.deepEqual(read(text), { dates: [], unreadable: false }, text);
  assert.deepEqual(labelledBirthDateEvidence('"dob": "1986-02-14"'), {
    dates: ['1986-02-14'],
    unreadable: false,
  });
});

test('complete day, month-name and year layouts parse to one date', () => {
  for (const value of [
    '14-Feb-1986',
    '14-FEB-1986',
    '14 Feb 1986',
    '14 February 1986',
    '14th February, 1986',
    '14/Feb/1986',
    '14.Feb.1986',
    '14FEB1986',
    'Feb 14, 1986',
    'Feb. 14 1986',
    'February 14th, 1986',
    'FEB-14-1986',
    '1986-Feb-14',
    '1986-02-14',
    '1986/2/14',
    '1986.02.14',
    '1986-02-14T00:00:00Z',
  ])
    assert.deepEqual(read(`DOB: ${value}`), { dates: ['1986-02-14'], unreadable: false }, value);
  assert.deepEqual(read('DOB: 4-Sept-1985').dates, ['1985-09-04']);
  assert.deepEqual(read('DOB: 4 May 1985').dates, ['1985-05-04']);
  // Existing four-digit full-month layouts are unchanged.
  for (const value of ['February 14, 1986', '14 February 1986', '1986-02-14'])
    assert.deepEqual(originalSubjectBirthDates(`${subject}\nDate of birth: ${value}`, subject), [
      '1986-02-14',
    ]);
});

test('ambiguous numeric birth dates keep both readings', () => {
  assert.deepEqual(read('DOB: 03/04/1985'), {
    dates: ['1985-03-04', '1985-04-03'],
    unreadable: false,
  });
  assert.deepEqual(read('DOB: 14/02/1986'), { dates: ['1986-02-14'], unreadable: false });
});

test('a present birth-date label without one complete date is unreadable, never absent', () => {
  for (const line of [
    'DOB: ██/██/19██',
    'DOB: XX/XX/1986',
    'DOB: see attached',
    'DOB:',
    'DOB: 03/1985',
    'DOB: 1985-03',
    'Date of birth: March 1985',
    'Born in 1985',
    'Born: unknown',
    'DOB: 1986-02-30',
    'DOB: 30-Feb-1986',
    // Two-digit years are partial: the century is not inferred.
    'DOB: 04-MAR-85',
    'D.O.B. 03/04/85',
    'Birthdate: Mar 4, 85',
  ])
    assert.deepEqual(read(line), { dates: [], unreadable: true }, line);
  // One readable label does not hide another unreadable one.
  assert.deepEqual(read('DOB: 1986-02-14\nBirth date: 02/14/86'), {
    dates: ['1986-02-14'],
    unreadable: true,
  });
  // A relative's unreadable DOB stays outside the patient header.
  assert.deepEqual(read('Mother DOB: unknown'), { dates: [], unreadable: false });
});

test('a label at the end of the header window still reads its whole value', () => {
  const header = `${subject}${' '.repeat(295)}DOB: 14-Feb-1986`;
  assert.deepEqual(originalSubjectBirthDateEvidence(header, subject), {
    dates: ['1986-02-14'],
    unreadable: false,
  });
});

test('a patient banner above the report heading keeps its DOB', () => {
  const heading = 'Fictional Chemistry Panel';
  const banner = `${subject}   DOB: 1986-02-14`;
  // One page of a report whose banner is repeated at the top of every page.
  assert.deepEqual(
    originalSubjectBirthDateEvidence(
      `${banner}\n${heading}\nFictional count 12.00`,
      subject,
      heading,
    ),
    { dates: ['1986-02-14'], unreadable: false },
  );
  // A repeated name footer after the heading does not hide the banner.
  assert.deepEqual(
    originalSubjectBirthDates(
      `${banner}\n${heading}\nFictional count\n${subject}`,
      subject,
      heading,
    ),
    ['1986-02-14'],
  );
  assert.deepEqual(
    originalSubjectBirthDateEvidence(`${subject} DOB: see chart\n${heading}`, subject, heading),
    { dates: [], unreadable: true },
  );
  // The report's own header after the heading still decides when it prints a DOB.
  assert.deepEqual(
    originalSubjectBirthDates(
      `${subject}\nDOB: 1960-01-01\n${heading}\n${subject}\nDOB: 1986-02-14`,
      subject,
      heading,
    ),
    ['1986-02-14'],
  );
  // An earlier report far above the heading is not a banner.
  assert.deepEqual(
    originalSubjectBirthDates(
      `${subject}\nDOB: 1960-01-01\n${'Fictional earlier result\n'.repeat(20)}${heading}`,
      subject,
      heading,
    ),
    [],
  );
});
