import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeOriginalIdentityText,
  labelledBirthDateEvidence,
  originalSubjectBirthDateEvidence,
  originalSubjectBirthDates,
  originalSubjectNameGrounded,
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
  ])
    assert.deepEqual(read(line), { dates: [], unreadable: true }, line);
  // One readable label does not hide another unreadable one.
  assert.deepEqual(read('DOB: 1986-02-14\nBirth date: 02/14/86'), {
    dates: ['1986-02-14'],
    unreadable: true,
    suggestions: ['1986-02-14'],
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

test('two-digit birth years suggest the latest century before the report date without becoming evidence', () => {
  for (const [line, reference, suggestions] of [
    ['DOB: 04-MAR-85', '2026-09-29', ['1985-03-04']],
    ['DOB: Mar 4, 85', '1985-03-03', ['1885-03-04']],
    ['DOB: 03/04/85', '1985-03-15', ['1985-03-04', '1885-04-03']],
    ['DOB: 29-Feb-00', '2000-02-28', ['1600-02-29']],
  ] as const) {
    assert.deepEqual(labelledBirthDateEvidence(line, line.length, reference), {
      dates: [],
      unreadable: true,
      suggestions: [...suggestions],
    });
  }
  const subject = 'Patient: Cookie Doe';
  const heading = 'Fictional report';
  assert.deepEqual(
    originalSubjectBirthDateEvidence(
      `${heading}\nReport date: 1926-01-02\n${subject}\nDOB: 14-Feb-86`,
      subject,
      heading,
    ),
    {
      dates: [],
      unreadable: true,
      suggestions: ['1886-02-14'],
    },
  );
});

test('insurance, guardian and contact roles bound patient DOB discovery on either side', () => {
  for (const role of [
    'Policyholder',
    'Subscriber',
    'Insured',
    'Guardian',
    'Parent',
    'Responsible party',
    'Guarantor',
    'Contact',
  ]) {
    const subject = 'Cookie Doe';
    assert.equal(
      originalSubjectNameGrounded(`${role}: ${subject}\nDOB: 1950-01-05`, subject),
      false,
      role,
    );
    assert.deepEqual(
      originalSubjectBirthDateEvidence(
        `Patient: ${subject}\n${role}: Rowan Meadow DOB: 1950-01-05`,
        subject,
      ),
      { dates: [], unreadable: false },
      role,
    );
    assert.deepEqual(
      originalSubjectBirthDateEvidence(`${role}: ${subject}\nDOB: 1950-01-05`, subject),
      { dates: [], unreadable: false },
      role,
    );
  }
});

test('nested JSON preserves patient and caregiver roles for both name and DOB evidence', () => {
  const original = decodeOriginalIdentityText(
    JSON.stringify({
      reportTitle: 'Fictional audit report',
      patient: { name: 'Rowan River', dob: '2010-01-05' },
      guardian: { name: 'Iris Meadow', dob: '1982-04-17' },
    }),
    'fictional-audit.json',
  );
  assert.equal(
    originalSubjectNameGrounded(original, 'Rowan River', 'Fictional audit report'),
    true,
  );
  assert.deepEqual(
    originalSubjectBirthDateEvidence(original, 'Rowan River', 'Fictional audit report'),
    {
      dates: ['2010-01-05'],
      unreadable: false,
    },
  );
  assert.equal(
    originalSubjectNameGrounded(original, 'Iris Meadow', 'Fictional audit report'),
    false,
  );
  assert.deepEqual(
    originalSubjectBirthDateEvidence(
      original + '\nDOB: 1982-04-17',
      'Iris Meadow',
      'Fictional audit report',
    ),
    { dates: [], unreadable: false },
  );
  assert.deepEqual(
    originalSubjectBirthDateEvidence(original, 'Iris Meadow', 'Fictional audit report'),
    {
      dates: [],
      unreadable: false,
    },
  );
});

test('JSON role keys stay bound through camel case, underscores and nested child objects', () => {
  for (const guardian of [
    { guardianName: 'Iris Meadow', guardianDOB: '1982-04-17' },
    { guardian_name: 'Iris Meadow', guardian_dob: '1982-04-17' },
    { guardian: { address: { city: 'Fictional Bay' }, name: 'Iris Meadow', dob: '1982-04-17' } },
    {
      patient: {
        name: 'Rowan River',
        dob: '2010-01-05',
        guardian: { name: 'Iris Meadow', dob: '1982-04-17' },
      },
    },
  ]) {
    const original = decodeOriginalIdentityText(
      JSON.stringify({
        reportTitle: 'Fictional audit report',
        patient: { name: 'Rowan River', dob: '2010-01-05' },
        ...guardian,
      }),
      'fictional-audit.json',
    );
    assert.equal(
      originalSubjectNameGrounded(original, 'Iris Meadow', 'Fictional audit report'),
      false,
    );
    assert.deepEqual(
      originalSubjectBirthDateEvidence(original, 'Iris Meadow', 'Fictional audit report'),
      {
        dates: [],
        unreadable: false,
      },
    );
  }
});

test('common structured patient birth-date keys remain labelled facts', () => {
  for (const key of ['birthDate', 'birth_date', 'dateOfBirth', 'date_of_birth']) {
    const original = decodeOriginalIdentityText(
      JSON.stringify({
        reportTitle: 'Fictional audit report',
        patient: { name: 'Iris Meadow', [key]: '1950-01-05' },
      }),
      'fictional-audit.json',
    );
    assert.deepEqual(
      originalSubjectBirthDateEvidence(original, 'Iris Meadow', 'Fictional audit report'),
      {
        dates: ['1950-01-05'],
        unreadable: false,
      },
      key,
    );
  }
});

test('a subject in a later report is outside the anchored first patient block', () => {
  const original =
    'Fictional audit report\nPatient: Rowan River\nDOB: 2010-01-05\nFictional second report\nPatient: Iris Meadow\nDOB: 1982-04-17';
  assert.equal(
    originalSubjectNameGrounded(original, 'Iris Meadow', 'Fictional audit report'),
    false,
  );
  assert.deepEqual(
    originalSubjectBirthDateEvidence(original, 'Iris Meadow', 'Fictional audit report'),
    {
      dates: [],
      unreadable: false,
    },
  );
});

test('an adjacent date following a different report title cannot set this report century', () => {
  const original =
    'Fictional earlier report\nReport date: 1926-01-02\nFictional audit report\nPatient: Iris Meadow\nDOB: 14-Feb-86';
  assert.deepEqual(
    originalSubjectBirthDateEvidence(original, 'Iris Meadow', 'Fictional audit report'),
    {
      dates: [],
      unreadable: true,
      suggestions: ['1986-02-14'],
    },
  );
});

test('a previous report patient banner cannot supply this report DOB', () => {
  const original =
    'Patient: Iris Meadow\nDOB: 1982-04-17\nFictional earlier result\nFictional second report\nPatient: Rowan River';
  assert.deepEqual(
    originalSubjectBirthDateEvidence(original, 'Patient: Iris Meadow', 'Fictional second report'),
    { dates: [], unreadable: false },
  );
});

test('a prior report in one JSON transcript cannot supply the later report DOB', () => {
  const original = decodeOriginalIdentityText(
    JSON.stringify({
      transcript:
        'Patient: Iris Meadow\nDOB: 1982-04-17\nFictional Alder report\nFictional result\nFictional Birch report\nPatient: Rowan River\nFinding Iris Meadow family context',
    }),
    'fictional.json',
  );
  assert.deepEqual(
    originalSubjectBirthDateEvidence(original, 'Patient: Iris Meadow', 'Fictional Birch report'),
    { dates: [], unreadable: false },
  );
});

test('numeric and null JSON DOB fields remain visible birth-date questions', () => {
  for (const [value, expected] of [
    [88, ['1988']],
    [null, []],
  ] as const) {
    const original = decodeOriginalIdentityText(
      JSON.stringify({
        reportTitle: 'Fictional audit report',
        patient: { name: 'Iris Meadow', dob: value },
      }),
      'fictional.json',
    );
    assert.deepEqual(
      originalSubjectBirthDateEvidence(original, 'Iris Meadow', 'Fictional audit report'),
      {
        dates: [],
        unreadable: true,
        ...(expected.length ? { suggestions: expected } : {}),
      },
    );
  }
});

test('multiline caregiver headers do not ground a later name or date', () => {
  const original =
    'Fictional audit report\nPatient: Rowan River\nGuardian:\nIris Meadow\nDOB: 1982-04-17';
  assert.equal(
    originalSubjectNameGrounded(original, 'Iris Meadow', 'Fictional audit report'),
    false,
  );
  assert.deepEqual(
    originalSubjectBirthDateEvidence(original, 'Iris Meadow', 'Fictional audit report'),
    {
      dates: [],
      unreadable: false,
    },
  );
});

test('clinician and caregiver labels stop patient DOB discovery', () => {
  for (const role of [
    'Physician',
    'Doctor',
    'Clinician',
    'Caregiver',
    'Next of kin',
    'Family member',
  ]) {
    const original = `Fictional audit report\nPatient: Iris Meadow\n${role}: Rowan River\nDOB: 1950-01-05`;
    assert.deepEqual(
      originalSubjectBirthDateEvidence(original, 'Iris Meadow', 'Fictional audit report'),
      { dates: [], unreadable: false },
      role,
    );
    assert.equal(
      originalSubjectNameGrounded(original, 'Rowan River', 'Fictional audit report'),
      false,
      role,
    );
  }
});

test('an unqualified name later in a patient narrative is not a patient header', () => {
  const original =
    'Fictional audit report\nPatient: Rowan River\nDOB: 2010-01-05\nFictional result mentions Iris Meadow';
  assert.equal(
    originalSubjectNameGrounded(original, 'Iris Meadow', 'Fictional audit report'),
    false,
  );
  assert.equal(
    originalSubjectNameGrounded(
      'Fictional audit report\nIris Meadow\nDOB: 1982-04-17',
      'Iris Meadow',
      'Fictional audit report',
    ),
    true,
  );
});

test('year-only dates suggest a century but remain unreadable original facts', () => {
  assert.deepEqual(labelledBirthDateEvidence('Born in 88', undefined, '2026-09-29'), {
    dates: [],
    unreadable: true,
    suggestions: ['1988'],
  });
  assert.deepEqual(labelledBirthDateEvidence('DOB: 88', undefined, '1926-01-02'), {
    dates: [],
    unreadable: true,
    suggestions: ['1888'],
  });
  assert.deepEqual(labelledBirthDateEvidence('DOB: 03/1985'), {
    dates: [],
    unreadable: true,
  });
  assert.deepEqual(labelledBirthDateEvidence('DOB: 14 Feb 86'), {
    dates: [],
    unreadable: true,
    suggestions: ['1986-02-14'],
  });
  assert.deepEqual(labelledBirthDateEvidence('Born in88'), {
    dates: [],
    unreadable: true,
    suggestions: ['1988'],
  });
});
