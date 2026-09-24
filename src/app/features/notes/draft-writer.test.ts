import assert from 'node:assert/strict';
import test from 'node:test';
import { DraftWriter } from './draft-writer.ts';
import { personFields, validPartialDate } from './person-fields.ts';
const deferred = () => {
  let resolve!: () => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
type Saved = { id: string; version: number };
const setup = (
  write: ConstructorParameters<typeof DraftWriter<string, Saved>>[0]['write'],
  saved: Saved | null = { id: 'stable-id', version: 1 },
) => {
  const accepted: { value: Saved; draft: string }[] = [];
  const states: { state: 'saving' | 'saved' | 'error'; error?: unknown }[] = [];
  const writer = new DraftWriter({
    draft: 'original',
    saved,
    key: (value) => value,
    write,
    accepted: (value, draft) => accepted.push({ value, draft }),
    state: (state, error) => states.push({ state, error }),
  });
  return { writer, accepted, states };
};

test('typing during a save is preserved and serialized at the returned version', async () => {
  const first = deferred(),
    calls: unknown[][] = [];
  let active = 0,
    maximum = 0;
  const { writer, accepted } = setup(async (draft, base) => {
    active++;
    maximum = Math.max(maximum, active);
    calls.push([draft, base!.version]);
    if (calls.length === 1) await first.promise;
    active--;
    return { id: base!.id, version: base!.version + 1 };
  });
  writer.update('first edit');
  const saving = writer.flush();
  await tick();
  writer.update('second edit');
  const anotherSave = writer.flush();
  first.resolve();
  await Promise.all([saving, anotherSave]);
  assert.deepEqual(calls, [
    ['first edit', 1],
    ['second edit', 2],
  ]);
  assert.equal(maximum, 1);
  assert.deepEqual(
    accepted.map((item) => item.draft),
    ['first edit', 'second edit'],
  );
  assert.equal(writer.dirty, false);
});

test('uncertain create retains its original snapshot before retrying later typing', async () => {
  const calls: unknown[][] = [];
  let fail = true;
  const { writer } = setup(async (draft, base, retry) => {
    calls.push([draft, base?.version ?? null, retry]);
    if (fail) {
      fail = false;
      throw new Error('response lost');
    }
    return { id: 'same-created-id', version: (base?.version || 0) + 1 };
  }, null);
  writer.update('creation snapshot');
  await assert.rejects(writer.flush(), /response lost/);
  writer.update('more typing');
  await assert.rejects(writer.flush(), /response lost/);
  assert.equal(calls.length, 1);
  await writer.flush(true);
  assert.deepEqual(calls, [
    ['creation snapshot', null, false],
    ['creation snapshot', null, true],
    ['more typing', 1, false],
  ]);
});

test('CAS conflict pauses autosave without losing local content or issuing more writes', async () => {
  let writes = 0;
  const { writer } = setup(async () => {
    writes++;
    throw new Error('VERSION_CONFLICT');
  });
  writer.update('my edits');
  await assert.rejects(writer.flush(), /VERSION_CONFLICT/);
  writer.update('my edits continue');
  await assert.rejects(writer.flush(), /VERSION_CONFLICT/);
  assert.equal(writes, 1);
  assert.equal(writer.dirty, true);
  writer.reset({ id: 'stable-id', version: 7 }, 'latest from explicit reload');
  assert.equal(writer.dirty, false);
});

test('attachment mutation flushes typing, reserves its version, then saves later typing', async () => {
  const attachment = deferred(),
    calls: unknown[][] = [];
  const { writer } = setup(async (draft, base) => {
    calls.push(['text', draft, base!.version]);
    return { ...base!, version: base!.version + 1 };
  });
  writer.update('before file');
  const linking = writer.exclusive(async (saved) => {
    calls.push(['attachment', saved.version]);
    await attachment.promise;
    writer.acceptExternal({ ...saved, version: saved.version + 1 });
  });
  await tick();
  writer.update('while file linking');
  const saving = writer.flush();
  attachment.resolve();
  await Promise.all([linking, saving]);
  assert.deepEqual(calls, [
    ['text', 'before file', 1],
    ['attachment', 2],
    ['text', 'while file linking', 3],
  ]);
});

test('failed attachment mutation blocks a queued finish and retains typed changes', async () => {
  const { writer } = setup(async (_draft, base) => ({ ...base!, version: base!.version + 1 }));
  const link = writer.exclusive(async () => {
    throw new Error('link failed');
  });
  let finished = false;
  const finish = writer.exclusive(async () => {
    finished = true;
  });
  await assert.rejects(link, /link failed/);
  await assert.rejects(finish, /link failed/);
  assert.equal(finished, false);
});

test('first historical finish waits for creation and uses the newly created draft version', async () => {
  const creation = deferred();
  const order: string[] = [];
  const { writer } = setup(async () => {
    order.push('create');
    await creation.promise;
    return { id: 'draft-id', version: 1 };
  }, null);
  const finishing = writer.exclusive(async (saved) => {
    order.push(`finish:${saved.id}:${saved.version}`);
  });
  await tick();
  assert.deepEqual(order, ['create']);
  creation.resolve();
  await finishing;
  assert.deepEqual(order, ['create', 'finish:draft-id:1']);
});

test('leaving or switching profile prevents queued follow-up writes after an in-flight save', async () => {
  const first = deferred();
  let writes = 0;
  const { writer, accepted } = setup(async () => {
    writes++;
    await first.promise;
    return { id: 'stable-id', version: 2 };
  });
  writer.update('first');
  const saving = writer.flush();
  await tick();
  writer.update('later');
  writer.dispose();
  first.resolve();
  await assert.rejects(saving, /no longer active/);
  assert.equal(writes, 1);
  assert.equal(accepted.length, 0);
});

test('People full name recovery preserves labels, original family data, and unknown fields', () => {
  const original = {
    name: 'Dad',
    sourceRelative: { realName: 'Morgan Example Jr', custom: ['retained'] },
    extraFutureField: { nested: 3 },
    bloodTypeSource: 'family note',
  };
  const person = personFields(original);
  assert.equal(person.name, 'Dad');
  assert.equal(person.fullName, 'Morgan Example Jr');
  assert.equal(person.lifeStatus, 'unknown');
  assert.deepEqual(person.sourceRelative, original.sourceRelative);
  assert.deepEqual(person.extraFutureField, original.extraFutureField);
  assert.equal(person.bloodTypeSource, 'family note');
  assert.equal(personFields({ realName: 'Fallback' }).fullName, 'Fallback');
  assert.equal(personFields({ fullName: 'Chosen', realName: 'Fallback' }).fullName, 'Chosen');
});

test('unknown and partial dates remain allowed without accepting impossible dates', () => {
  for (const value of ['', '1952', '1952-02', '2000-02-29'])
    assert.equal(validPartialDate(value), true, value);
  for (const value of ['2/3/90', '2023-02-29', '2000-13', '2000-00', '2000-04-31', '0000'])
    assert.equal(validPartialDate(value), false, value);
});

test('definitively rejected validation uses corrected input rather than retrying an invalid snapshot', async () => {
  const calls: unknown[][] = [];
  const writer = new DraftWriter({
    draft: 'start',
    saved: { version: 1 },
    key: (value) => value,
    write: async (draft, base, retry) => {
      calls.push([draft, retry]);
      if (draft === 'invalid') throw new Error('invalid');
      return { version: base!.version + 1 };
    },
    keepFailedSnapshot: () => false,
    accepted: () => {},
    state: () => {},
  });
  writer.update('invalid');
  await assert.rejects(writer.flush(), /invalid/);
  writer.update('corrected');
  await writer.flush(true);
  assert.deepEqual(calls, [
    ['invalid', false],
    ['corrected', false],
  ]);
});

test('clearing a recovered full name remains an intentional blank', () => {
  assert.equal(
    personFields({
      fullName: '',
      realName: 'Old name',
      sourceRelative: { realName: 'Source name' },
    }).fullName,
    '',
  );
});

test('external adoption advances a clean baseline but refuses dirty, queued and failed work', async () => {
  const { writer } = setup(async (_draft, base) => ({ ...base!, version: base!.version + 1 }));
  assert.equal(writer.adoptClean({ id: 'stable-id', version: 5 }, 'external'), true);
  writer.update('changed');
  assert.equal(writer.adoptClean({ id: 'stable-id', version: 6 }, 'discarding'), false);
  await writer.flush();
  assert.equal(writer.current!.version, 6);
  const gate = deferred();
  const active = writer.exclusive(async () => gate.promise);
  assert.equal(writer.adoptClean({ id: 'stable-id', version: 7 }, 'premature'), false);
  await tick();
  assert.equal(writer.adoptClean({ id: 'stable-id', version: 7 }, 'premature'), false);
  gate.resolve();
  await active;
  assert.equal(writer.adoptClean({ id: 'stable-id', version: 7 }, 'latest'), true);
  await assert.rejects(
    writer.exclusive(async () => {
      throw Error('Association failed');
    }),
  );
  assert.equal(writer.adoptClean({ id: 'stable-id', version: 8 }, 'discard failure'), false);
});
