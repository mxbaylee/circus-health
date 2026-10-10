import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { readPackageRecords, writePackageRecord } from '../intake-package-protocol.ts';

test('fragmented records preserve exact large metadata through bounded writable backpressure', async () => {
  const stream = new PassThrough({ highWaterMark: 1024 });
  const value = { type: 'fictional', filename: '"'.repeat(65535) };
  const read = (async () => {
    const values = [];
    for await (const record of readPackageRecords(stream)) values.push(record);
    return values;
  })();
  await writePackageRecord(stream, value);
  stream.end();
  assert.deepEqual(await read, [value]);
});

for (const [label, frame] of [
  ['empty fragment', JSON.stringify({ part: '', last: false }) + '\n'],
  ['tiny nonterminal fragment', JSON.stringify({ part: 'YQ==', last: false }) + '\n'],
  ['invalid base64', JSON.stringify({ part: '***', last: true }) + '\n'],
  ['oversized frame', 'a'.repeat(32769)],
  ['truncated frame', '{'],
  [
    'unfinished record',
    JSON.stringify({ part: Buffer.alloc(12288, 97).toString('base64'), last: false }) + '\n',
  ],
] as const) {
  test(`malformed ${label} cannot be treated as a complete record`, async () => {
    await assert.rejects(async () => {
      for await (const _record of readPackageRecords(Readable.from([frame]))) {
        assert.fail('Malformed transport emitted a fact');
      }
    });
  });
}
