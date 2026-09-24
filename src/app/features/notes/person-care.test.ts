import type { Note } from '../../../shared/api.ts';
import { fictionalNote } from '../../../tests/fixtures/note.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalPersonTag,
  normalizePersonTags,
  normalizedPersonCare,
  personContactError,
} from '../../../shared/person-care.ts';
import { formFor, inputFor, keyFor } from './note-form.ts';

test('People tags have stable case/whitespace identity and retain independent roles', () => {
  assert.equal(canonicalPersonTag('  EMERGENCY \n CONTACT '), 'Emergency Contact');
  assert.deepEqual(normalizePersonTags([' FAMILY ', 'family', 'support TEAM', ' support  team ']), [
    'Family',
    'support team',
  ]);
  assert.deepEqual(normalizePersonTags(['Primary care provider', 'PROFESSIONAL']), [
    'Primary Care Provider',
    'Professional',
  ]);
  assert.throws(() => normalizePersonTags(['x'.repeat(81)]), /80/);
  assert.throws(() => normalizePersonTags([{}]), /text/);
});

test('autosave canonicalization keeps contact fields, unknown fields, Self and full name distinct', () => {
  const note = fictionalNote({
    kind: 'person',
    isSelf: true,
    title: 'Display name',
    personId: 'patient',
    person: {
      name: 'Display name',
      fullName: 'Legal name',
      relationship: 'Self',
      pronouns: 'they/them',
      sourceRelative: { preserved: 'original' },
      futureField: 42,
    },
    content: '',
  });
  const form = formFor(note);
  form.person = {
    ...form.person,
    tags: [' PROFESSIONAL ', 'Family'],
    phone: ' (555) 010-1111 ',
    email: ' Local.Part+tag@example.com ',
    schedulingUrl: ' https://example.com/schedule?topic=visit ',
  };
  const payload = inputFor(form, 'person', 3);
  assert.equal(
    payload.person!.tags,
    undefined,
    'Self identity must not carry role tags in ordinary autosaves',
  );
  assert.equal(payload.person!.email, 'Local.Part+tag@example.com');
  assert.equal(payload.person!.phone, '(555) 010-1111');
  assert.equal(payload.person!.schedulingUrl, 'https://example.com/schedule?topic=visit');
  assert.equal(payload.person!.relationship, 'Self');
  assert.equal(payload.person!.fullName, 'Legal name');
  assert.equal(payload.person!.futureField, 42);
  assert.deepEqual(payload.person!.sourceRelative, { preserved: 'original' });
  assert.equal(
    keyFor(form, 'person'),
    keyFor(formFor({ ...note, ...payload } as Note), 'person'),
    'server normalization must not create an endless dirty autosave loop',
  );
  assert.equal(
    form.person.phone,
    ' (555) 010-1111 ',
    'preparing the payload does not mutate a newer local draft',
  );
});

test('contact validation pauses incomplete input and rejects executable local scheduling schemes', () => {
  for (const email of ['', 'name@example.com', 'name+visits@example.co.uk'])
    assert.equal(personContactError({ email }), '');
  assert.match(personContactError({ email: 'name@' }), /email/);
  for (const schedulingUrl of [
    'javascript:alert(1)',
    'file:///tmp/file',
    'data:text/html,a',
    'clinic.example.com',
    'https://example.com/white space',
  ])
    assert.match(personContactError({ schedulingUrl }), /https/);
  assert.equal(
    personContactError({
      schedulingUrl: 'https://example.com/book?a=1&b=2',
      phone: '+44 (0)20 1234 5678 ext. 2',
    }),
    '',
  );
  assert.deepEqual(
    normalizedPersonCare({ unrelated: { keep: true } }),
    { unrelated: { keep: true } },
    'optional care fields are not invented',
  );
});
