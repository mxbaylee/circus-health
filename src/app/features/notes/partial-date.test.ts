import { fictionalNote } from '../../../tests/fixtures/note.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { dateAtPrecision, datePrecision, pickerValue } from './date-precision.ts';
import { formFor, inputFor } from './note-form.ts';

test('native picker modes never fill missing components of existing partial dates', () => {
  for (const value of ['1977', '1977-05']) {
    assert.equal(dateAtPrecision(value, 'day'), value);
    assert.equal(pickerValue(value, 'day'), '');
  }
  assert.equal(dateAtPrecision('1977', 'month'), '1977');
  assert.equal(pickerValue('1977', 'month'), '');
  assert.equal(datePrecision(''), 'unknown');
  assert.equal(datePrecision('1977'), 'year');
  assert.equal(datePrecision('1977-05'), 'month');
  assert.equal(datePrecision('1977-05-14'), 'day');
});

test('explicit lower precision and Unknown do only the requested truncation', () => {
  assert.equal(dateAtPrecision('1977-05-14', 'month'), '1977-05');
  assert.equal(dateAtPrecision('1977-05-14', 'year'), '1977');
  assert.equal(dateAtPrecision('1977-05', 'unknown'), '');
});

test('hiding death date by changing life status preserves its stored partial value', () => {
  const form = formFor(
    fictionalNote({
      kind: 'person',
      isSelf: false,
      title: 'Example person',
      person: { lifeStatus: 'deceased', deathDate: '2004-09' },
    }),
  );
  form.person.lifeStatus = 'unknown';
  assert.equal(inputFor(form, 'person').person!.deathDate, '2004-09');
  form.person.lifeStatus = 'alive';
  assert.equal(inputFor(form, 'person').person!.deathDate, '2004-09');
  form.person.lifeStatus = 'deceased';
  assert.equal(inputFor(form, 'person').person!.deathDate, '2004-09');
});

test('date fields render native date/month pickers, numeric years and conditional death field', async (t) => {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: fileURLToPath(new URL('../../../', import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  t.after(() => server.close());
  const { PartialDateField, DeathDateField } = await server.ssrLoadModule(
    '/app/features/notes/PartialDateField.tsx',
  );
  const changes: string[] = [];
  type DateProps = {
    label: string;
    value: string;
    onChange: (value: string) => void;
    lifeStatus?: string;
  };
  const render = (
    Component: ComponentType<DateProps>,
    props: Partial<DateProps> & { value: string },
  ) =>
    renderToStaticMarkup(
      createElement(Component, {
        label: 'Date of birth',
        onChange: (value: string) => changes.push(value),
        ...props,
      }),
    );
  assert.match(render(PartialDateField, { value: '1992-04-15' }), /type="date"/);
  assert.match(render(PartialDateField, { value: '1990-03' }), /type="month"/);
  const year = render(PartialDateField, { value: '1990' });
  assert.match(year, /inputMode="numeric"/);
  assert.match(year, /value="1990"/);
  assert.match(year, /aria-label="Date of birth precision"/);
  assert.match(render(PartialDateField, { value: '' }), /type="date"/);
  for (const lifeStatus of ['alive', 'unknown'])
    assert.equal(
      render(DeathDateField, { label: 'Date of death', lifeStatus, value: '2004-09' }),
      '',
    );
  const death = render(DeathDateField, {
    label: 'Date of death',
    lifeStatus: 'deceased',
    value: '2004-09',
  });
  assert.match(death, /Date of death/);
  assert.match(death, /type="month"/);
  assert.match(death, /value="2004-09"/);
  assert.deepEqual(changes, [], 'rendering/opening a field never rewrites its recorded value');
});

test('precision reductions restore known detail across repeated changes and an autosaved prefix', async () => {
  const { changeDatePrecision } = await import('./date-precision.ts');
  let result = changeDatePrecision('1977-05-14', 'year');
  assert.deepEqual(result, { value: '1977', remembered: '1977-05-14' });
  // An autosave returns the same prefix; restoration does not depend on a DB history.
  result = changeDatePrecision(result.value, 'month', result.remembered);
  assert.deepEqual(result, { value: '1977-05', remembered: '1977-05-14' });
  result = changeDatePrecision(result.value, 'year', result.remembered);
  assert.deepEqual(result, { value: '1977', remembered: '1977-05-14' });
  result = changeDatePrecision(result.value, 'day', result.remembered);
  assert.deepEqual(result, { value: '1977-05-14', remembered: '' });
  assert.equal(changeDatePrecision('1977-05', 'year').remembered, '1977-05');
  assert.equal(
    changeDatePrecision('1977', 'day', '1977-05').value,
    '1977-05',
    'a remembered month never supplies a guessed day',
  );
});

test('date edits invalidate incompatible remembered detail permanently, including clearing and Unknown', async () => {
  const { changeDatePrecision, compatibleDateDetail } = await import('./date-precision.ts');
  for (const edited of ['1978', '1977-06', '1977-05-20', '197', '']) {
    const memory = compatibleDateDetail('1977-05-14', edited);
    assert.equal(memory, '');
    assert.equal(
      changeDatePrecision('1977', 'day', memory).value,
      '1977',
      'returning to the old year cannot resurrect invalidated month/day',
    );
  }
  assert.equal(compatibleDateDetail('1977-05-14', '1977'), '1977-05-14');
  assert.equal(compatibleDateDetail('1977-05-14', '1977-05'), '1977-05-14');
  assert.deepEqual(changeDatePrecision('1977', 'unknown', '1977-05-14'), {
    value: '',
    remembered: '',
  });
  assert.deepEqual(
    changeDatePrecision('1981-06-02', 'year', '1977-05-14'),
    { value: '1981', remembered: '1981-06-02' },
    'a new exact date becomes the only source of restorable detail',
  );
  assert.equal(changeDatePrecision('1977', 'day').value, '1977');
  assert.equal(changeDatePrecision('1977-05', 'day').value, '1977-05');
});
