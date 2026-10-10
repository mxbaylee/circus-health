import test from 'node:test';
import assert from 'node:assert/strict';
import { recordSourceFieldChanges } from '../record-source-field-changes.ts';

function fields(raw: string | undefined) {
  const found = new Map<string, string>();
  const visit = (path: string, value: unknown) => {
    found.set(path, JSON.stringify(value));
    if (value && typeof value === 'object' && !Array.isArray(value))
      for (const key of Object.keys(value))
        visit(path + '.' + key, (value as Record<string, unknown>)[key]);
  };
  for (const [key, value] of Object.entries(JSON.parse(raw ?? '{}'))) {
    visit(key, value);
    if (key.endsWith('_json') && typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          for (const child of Object.keys(parsed)) visit(key + '.' + child, parsed[child]);
      } catch {
        /* Literal invalid JSON remains exact. */
      }
    }
  }
  return found;
}

test('disk source changes retain every field reference and overwrite order for giant literal and nested metadata', () => {
  const name = 'fictional-'.repeat(54000),
    before = JSON.stringify({
      details_json: JSON.stringify({
        originalName: name,
        parent: { 'a.b': 1, a: { b: 2 } },
        values: [1, null],
      }),
      'details_json.parent.a.b': 3,
      mime_type: null,
    }),
    after = JSON.stringify({
      details_json: JSON.stringify({
        originalName: { format: 'fictional-exact-reference', bytes: name.length },
        parent: { a: { b: null } },
        values: [2, null],
        extra: true,
      }),
      mime_type: 'application/pdf',
    });
  for (const [old, next] of [
    [before, after],
    [after, before],
    [undefined, before],
    [before, undefined],
    [before, before],
  ]) {
    const a = fields(old),
      b = fields(next),
      expected = [];
    for (const field of new Set([...a.keys(), ...b.keys()]))
      if (a.get(field) !== b.get(field))
        expected.push({ field, beforePresent: a.has(field), afterPresent: b.has(field) });
    let checkpoints = 0;
    assert.deepEqual([...recordSourceFieldChanges(old, next, () => checkpoints++)], expected);
    assert.ok(checkpoints > 66);
  }
  let steps = 0;
  assert.throws(
    () => [
      ...recordSourceFieldChanges(before, after, () => {
        if (++steps === 80) throw Error('fictional replay owner expired');
      }),
    ],
    /replay owner expired/,
  );
});
