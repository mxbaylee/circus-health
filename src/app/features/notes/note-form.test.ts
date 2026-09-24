import { fictionalNote } from '../../../tests/fixtures/note.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { formFor, inputFor } from './note-form.ts';

const self = fictionalNote({
  id: 'person-note:self',
  isSelf: true,
  kind: 'person',
  title: 'Self',
  content: 'A note',
  personId: 'patient',
  person: {
    name: 'Cookie Dough',
    fullName: 'Cookie Dough',
    relationship: 'Self',
    pronouns: 'they/them',
    futureField: { keep: true },
  },
  links: [],
});

test('Self form projects the canonical display name and keeps full name independent', () => {
  const form = formFor(self);
  form.person.pronouns = 'she/they';
  const payload = inputFor(form, 'person', 8);
  assert.equal(form.title, 'Cookie Dough');
  assert.equal(payload.title, 'Cookie Dough');
  assert.equal(payload.person!.name, 'Cookie Dough');
  assert.equal(payload.person!.fullName, 'Cookie Dough');
  assert.equal(payload.person!.pronouns, 'she/they');
  assert.deepEqual(payload.person!.futureField, { keep: true });
  assert.equal(payload.version, 8);
  assert.equal(
    Object.hasOwn(payload, 'isSelf'),
    false,
    'UI-only identity flag must not be persisted as an editable input',
  );
});

test('a Person familiar label remains editable and distinct from their full name', () => {
  const form = formFor({
    ...self,
    isSelf: false,
    id: 'person-note:relative',
    personId: 'person:relative',
    title: 'Dad',
    person: { name: 'Dad', fullName: 'Alex Morgan Jr.', relationship: 'parent' },
  });
  form.title = 'Papa';
  const payload = inputFor(form, 'person', 2);
  assert.equal(payload.title, 'Papa');
  assert.equal(payload.person!.name, 'Papa');
  assert.equal(payload.person!.fullName, 'Alex Morgan Jr.');
});

test('Self protection is based on the explicit server flag, never a relationship label', () => {
  const form = formFor({ ...self, isSelf: false, personId: 'person:other', title: 'Other person' });
  assert.equal(inputFor(form, 'person').person!.name, 'Other person');
});

test('Self display name edits update the person name without changing legal name or identity', () => {
  const form = formFor(self);
  form.title = '  Starlight Cookie  ';
  const payload = inputFor(form, 'person', 9);
  assert.equal(payload.title, 'Starlight Cookie');
  assert.equal(payload.person!.name, 'Starlight Cookie');
  assert.equal(payload.person!.fullName, 'Cookie Dough');
  assert.equal(payload.person!.relationship, 'Self');
  assert.equal(Object.hasOwn(payload, 'isSelf'), false);
  form.title = '   ';
  assert.equal(
    inputFor(form, 'person').person!.name,
    '',
    'clearing the field must not silently save a placeholder as the name',
  );
});
