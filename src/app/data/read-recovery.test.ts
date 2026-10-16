import test from 'node:test';
import assert from 'node:assert/strict';
import { readWithRecovery } from './read-recovery.ts';

test('a shared read clone failure rejects its subscriber and permits later reads', async (t) => {
  let pulls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    pulls++;
    return new Response(JSON.stringify({ fictional: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const nativeClone = Response.prototype.clone;
  const failure = new Error('Fictional response clone failed');
  let clones = 0;
  t.mock.method(Response.prototype, 'clone', function (this: Response) {
    if (++clones === 1) throw failure;
    return Reflect.apply(nativeClone, this, []);
  });
  const url = 'https://fictional.invalid/intakes/people/clone-failure';
  const first = readWithRecovery(url, {});
  const second = readWithRecovery(url, {});
  await assert.rejects(first, (cause) => cause === failure);
  assert.deepEqual(await (await second).json(), { fictional: true });
  assert.equal(pulls, 1, 'other subscribers retain the same successful transport');
  assert.deepEqual(await (await readWithRecovery(url, {})).json(), { fictional: true });
  assert.equal(pulls, 2, 'a settled failed subscriber cannot retain a dead shared read');
});
