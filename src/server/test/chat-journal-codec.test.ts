import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyChatChanges,
  chatChanges,
  chatDecodeBudget,
  ChatDecodeLimitError,
  cloneChatJson,
} from '../chat-journal-codec.ts';

test('nested fictional conversation mutations round-trip without sharing input objects', () => {
  const before = {
    title: 'Fictional consultation',
    messages: [{ text: 'hello', metadata: { draft: true } }, { text: 'obsolete' }],
    removed: 'unused',
    '': { value: 1 },
  };
  const after = {
    title: 'Fictional consultation revised',
    messages: [{ text: 'hello fictional reader', metadata: { draft: false, count: 2 } }],
    '': { value: 2 },
    added: [null, true, 3],
  };
  const initial = cloneChatJson(before);
  const changes = chatChanges(initial, after);
  assert.ok(changes.some((change) => change.op === 'remove'));
  assert.ok(changes.some((change) => change.op === 'truncate'));
  assert.deepEqual(applyChatChanges(initial, changes), after);
  assert.equal(before.messages[0]!.text, 'hello');
  assert.deepEqual(chatChanges(cloneChatJson(after), after), []);
  assert.deepEqual(applyChatChanges(cloneChatJson(after), []), after);
});

test('empty-string leaf keys support text splicing and array truncation', () => {
  for (const [before, after] of [
    [{ '': 'abc' }, { '': 'abcd' }],
    [{ '': [1, 2] }, { '': [1] }],
  ] as const) {
    const changes = chatChanges(cloneChatJson(before), after);
    assert.ok(changes.some((change) => change.path.length === 1 && change.path[0] === ''));
    assert.deepEqual(applyChatChanges(cloneChatJson(before), changes), after);
  }
});

test('appended text persists only the suffix even when the existing message is large', () => {
  const text = 'Independently fictional text. '.repeat(10_000);
  const changes = chatChanges({ text }, { text: text + 'Next.' });
  assert.deepEqual(changes, [
    { op: 'splice', path: ['text'], offset: text.length, remove: 0, text: 'Next.' },
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(changes)) < 150);
  assert.deepEqual(applyChatChanges({ text }, changes), { text: text + 'Next.' });
});

test('root initialization clones its value and later root replacement is rejected', () => {
  const value = { messages: ['fictional'] };
  const initialized = applyChatChanges(undefined, [{ op: 'set', path: [], value }]);
  value.messages.push('later');
  assert.deepEqual(initialized, { messages: ['fictional'] });
  assert.throws(
    () => applyChatChanges(initialized, [{ op: 'set', path: [], value: {} }]),
    /Invalid conversation delta/,
  );
  assert.throws(() => applyChatChanges(undefined, []), /Invalid conversation delta/);
});

test('prototype-bearing input and prototype paths cannot mutate an object', () => {
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    const hostile = JSON.parse(`{"${name}":{"polluted":true}}`);
    assert.throws(() => cloneChatJson(hostile), /Invalid conversation delta/);
    assert.throws(() => chatChanges({}, hostile), /Invalid conversation delta/);
    assert.throws(
      () => applyChatChanges({}, [{ op: 'set', path: [name], value: true }]),
      /Invalid conversation delta/,
    );
  }
  assert.throws(
    () => cloneChatJson(Object.create({ inherited: true })),
    /Invalid conversation delta/,
  );
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

test('array paths require canonical in-range indices and array removal uses truncation', () => {
  for (const index of ['-1', '01', '1.5', '1000000', '9007199254740992', 'length', '2']) {
    assert.throws(
      () =>
        applyChatChanges({ values: ['fictional'] }, [
          { op: 'set', path: ['values', index], value: 1 },
        ]),
      /Invalid conversation delta/,
    );
  }
  assert.deepEqual(
    applyChatChanges({ values: ['first'] }, [
      { op: 'set', path: ['values', '1'], value: 'second' },
    ]),
    { values: ['first', 'second'] },
  );
  assert.throws(
    () => applyChatChanges({ values: ['first'] }, [{ op: 'remove', path: ['values', '0'] }]),
    /Invalid conversation delta/,
  );
  assert.throws(
    () =>
      applyChatChanges({ values: ['first'] }, [{ op: 'truncate', path: ['values'], length: 2 }]),
    /Invalid conversation delta/,
  );
});

test('malformed operations and string ranges are rejected rather than partially interpreted', () => {
  for (const change of [
    { op: 'unknown', path: ['text'] },
    { op: 'set', path: ['text'], value: 'new', extra: true },
    { op: 'set', path: ['text'] },
    { op: 'remove', path: ['missing'] },
    { op: 'splice', path: ['text'], offset: -1, remove: 0, text: 'x' },
    { op: 'splice', path: ['text'], offset: 2, remove: 2, text: 'x' },
    { op: 'splice', path: ['text'], offset: 0, remove: 0, text: 1 },
    { op: 'set', path: [0], value: true },
  ])
    assert.throws(() => applyChatChanges({ text: 'abc' }, [change]), /Invalid conversation delta/);
});

test('one decode budget bounds cumulative work across individually valid entries', () => {
  const nodes = { ...chatDecodeBudget(), nodes: 3 };
  cloneChatJson({ fictional: true }, 0, nodes);
  assert.throws(() => cloneChatJson({ fictional: true }, 0, nodes), ChatDecodeLimitError);
  const operations = { ...chatDecodeBudget(), operations: 3 };
  const initial = { text: 'abc' };
  applyChatChanges(initial, [{ op: 'set', path: ['text'], value: 'def' }], operations);
  assert.throws(
    () => applyChatChanges(initial, [{ op: 'set', path: ['text'], value: 'ghi' }], operations),
    ChatDecodeLimitError,
  );
  const strings = { ...chatDecodeBudget(), stringWork: 7 };
  applyChatChanges(
    initial,
    [{ op: 'splice', path: ['text'], offset: 3, remove: 0, text: 'x' }],
    strings,
  );
  assert.throws(
    () =>
      applyChatChanges(
        initial,
        [{ op: 'splice', path: ['text'], offset: 4, remove: 0, text: 'y' }],
        strings,
      ),
    ChatDecodeLimitError,
  );
});
