import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readRecordJsonLines, type RecordJsonLineWork } from '../record-json-lines.ts';

function* segments(bytes: Buffer, width: number) {
  for (let offset = 0; offset < bytes.length; offset += width)
    yield bytes.subarray(offset, offset + width);
}

test('journal lines spool giant records with fixed windows and retain exact Unicode and numeric fields', () => {
  const large = {
      contents: {
        details_json: JSON.stringify({
          originalName: 'fictional-'.repeat(54000) + '\ud83d\ude00\udfff',
        }),
      },
    },
    raw = Buffer.from(
      JSON.stringify({ small: true }) +
        '\n' +
        JSON.stringify(large) +
        '\n' +
        '{"number":-0,"large":1e400}\n',
    );
  let work: Readonly<RecordJsonLineWork> | undefined,
    checkpoints = 0,
    parsedSmall = 0;
  const found = [
    ...readRecordJsonLines(segments(raw, 997), {
      parseSmall(text) {
        assert.ok(Buffer.byteLength(text) <= 65536);
        parsedSmall++;
        return JSON.parse(text);
      },
      checkpoint() {
        checkpoints++;
      },
      onWork(value) {
        work = value;
      },
    }),
  ];
  assert.deepEqual(found, [{ small: true }, large, { number: -0, large: Infinity }]);
  assert.equal(parsedSmall, 2, 'no complete giant version is passed to JSON.parse');
  assert.equal(work!.records, 3);
  assert.equal(work!.spooledRecords, 1);
  assert.ok(work!.maxRecordBufferBytes <= 65536);
  assert.equal(work!.maxSpoolReadBytes, 8192);
  assert.ok(checkpoints > 66);
  assert.throws(() => [...readRecordJsonLines([Buffer.from('{}')])], /Partial final JSONL/);
  assert.throws(() => [...readRecordJsonLines([Buffer.from([0xc3, 0x28, 10])])], /encoded data/);
});

test('spool tampering cannot replace authenticated input and iterator return closes its input', () => {
  const write = fs.writeSync;
  let tampered = false;
  fs.writeSync = function (fd: number, ...args: unknown[]) {
    const result = Reflect.apply(write, fs, [fd, ...args]);
    if (!tampered) {
      tampered = true;
      write(fd, Buffer.from('!'), 0, 1, 0);
    }
    return result;
  } as typeof fs.writeSync;
  syncBuiltinESMExports();
  try {
    const bytes = Buffer.from(JSON.stringify({ name: 'fictional-'.repeat(10000) }) + '\n');
    assert.throws(
      () => [...readRecordJsonLines(segments(bytes, 8192))],
      /Invalid JSON canonical input|scratch changed/,
    );
    assert.equal(tampered, true);
  } finally {
    fs.writeSync = write;
    syncBuiltinESMExports();
  }
  let closed = false;
  const lines = readRecordJsonLines(
    (function* () {
      try {
        yield Buffer.from('{}\n{}\n');
      } finally {
        closed = true;
      }
    })(),
  );
  assert.equal(lines.next().done, false);
  lines.return(undefined);
  assert.equal(closed, true);
});
