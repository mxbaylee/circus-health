import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
} from 'node:fs';
import { Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPackage, inspectPackageToProtocol } from '../intake-package-inspector.ts';
import { PackageInspectionError } from '../intake-package-worker.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';

class PausedProtocolOutput extends Writable {
  pending?: { frame: Buffer; callback: (error?: Error | null) => void };
  frames = 0;
  waiter?: () => void;
  constructor() {
    super({ highWaterMark: 1 });
  }
  override _write(
    frame: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    assert.equal(this.pending, undefined);
    this.pending = { frame, callback };
    this.frames++;
    this.waiter?.();
    this.waiter = undefined;
  }
  async nextFrame() {
    if (!this.pending)
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    return JSON.parse(this.pending!.frame.toString()) as {
      type: string;
      work?: { memberReadBytes: number; writtenBytes: number; entries: number };
    };
  }
  release(error?: Error) {
    assert.ok(this.pending);
    const { callback } = this.pending;
    this.pending = undefined;
    callback(error);
  }
}

for (const phase of ['inventory', 'payload'] as const) {
  test(`ZIP protocol backpressure pauses ${phase} work and bounds every queued frame`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-zip-backpressure-'));
    const path = join(root, 'fixture.zip'),
      outputPath = join(root, 'member');
    const content = Buffer.alloc(3 * 1024 * 1024, 'f');
    writeFileSync(
      path,
      zipFixture(
        phase === 'inventory'
          ? Array.from({ length: 101 }, (_, i) => ({ name: `report-${i}.txt`, data: 'fictional' }))
          : [{ name: 'report.txt', data: content }],
      ),
    );
    const outputFd = openSync(outputPath, 'wx', 0o600);
    t.after(() => {
      closeSync(outputFd);
      rmSync(root, { recursive: true, force: true });
    });
    const sink = new PausedProtocolOutput();
    let finished = false;
    const result = inspectPackageToProtocol(openSync(path, 'r'), 0, outputFd, sink).then(
      (value) => {
        finished = true;
        return value;
      },
    );
    const first = await sink.nextFrame();
    assert.equal(first.type, 'progress');
    assert.equal(first.work!.entries, phase === 'inventory' ? 100 : 1);
    const heldBytes = fstatSync(outputFd).size;
    assert.equal(heldBytes, first.work!.writtenBytes);
    if (phase === 'inventory') assert.equal(heldBytes, 0);
    else assert.ok(heldBytes >= 1024 * 1024 && heldBytes < content.length);
    // Give lazy-entry/stream callbacks opportunities to run without releasing
    // the receiver. No timing threshold or large generated output is needed.
    await setImmediate();
    await setImmediate();
    assert.equal(fstatSync(outputFd).size, heldBytes);
    assert.equal(sink.frames, 1);
    assert.equal(sink.writableLength, sink.pending!.frame.length);
    assert.equal(finished, false);
    const kinds: string[] = [];
    for (;;) {
      const frame = await sink.nextFrame();
      kinds.push(frame.type);
      const count: number = sink.frames;
      await setImmediate();
      assert.equal(sink.frames, count);
      assert.equal(sink.writableLength, sink.pending!.frame.length);
      assert.equal(finished, false);
      sink.release();
      if (frame.type === 'complete') break;
    }
    assert.equal(await result, true);
    assert.deepEqual(kinds.slice(-2), ['member', 'complete']);
    assert.equal(fstatSync(outputFd).size, phase === 'inventory' ? 9 : content.length);
  });
}

test('ZIP protocol waits for a failure frame and stops when its receiver fails', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-zip-protocol-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.zip');
  writeFileSync(path, zipFixture([{ name: '../unsafe.txt', data: 'fictional' }]));
  const sink = new PausedProtocolOutput();
  let finished = false;
  const result = inspectPackageToProtocol(openSync(path, 'r'), null, undefined, sink).then(
    (value) => {
      finished = true;
      return value;
    },
  );
  assert.equal((await sink.nextFrame()).type, 'error');
  await setImmediate();
  assert.equal(finished, false);
  assert.equal(sink.frames, 1);
  sink.release();
  assert.equal(await result, false);

  writeFileSync(
    path,
    zipFixture([{ name: 'report.txt', data: Buffer.alloc(3 * 1024 * 1024, 'f') }]),
  );
  const broken = new PausedProtocolOutput();
  const failure = new Error('fictional receiver unavailable');
  const rejection = assert.rejects(
    inspectPackageToProtocol(openSync(path, 'r'), null, undefined, broken),
    (error) => error === failure,
  );
  assert.equal((await broken.nextFrame()).type, 'progress');
  broken.release(failure);
  await rejection;
  assert.equal(broken.frames, 1);
  assert.equal(broken.pending, undefined);
});

const malformed = [
  { name: '/absolute.txt', data: 'fictional' },
  { name: 'folder\\file.txt', data: 'fictional' },
  { name: 'folder//file.txt', data: 'fictional' },
  { name: './file.txt', data: 'fictional' },
  { name: 'folder/../file.txt', data: 'fictional' },
  { name: 'drive:file.txt', data: 'fictional' },
  { name: 'nul\0file.txt', data: 'fictional' },
  { name: 'control\x1ffile.txt', data: 'fictional' },
  { name: 'folder/', data: 'unexpected directory data', mode: 0o040700 },
  { name: 'fifo', data: '', mode: 0o010600 },
  { name: 'link', data: 'target', mode: 0o120777 },
  { name: 'corrupt.txt', data: 'fictional', checksum: 0 },
  { name: 'encrypted.txt', data: 'fictional', encrypted: true },
];

for (const code of ['ENOSPC', 'EDQUOT']) {
  test(`ZIP inspector classifies ${code} after a real partial staging write as capacity failure`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-zip-storage-'));
    const path = join(root, 'fixture.zip'),
      output = join(root, 'member');
    writeFileSync(path, zipFixture([{ name: 'safe/report.txt', data: 'fictional' }]));
    const outputFd = openSync(output, 'wx', 0o600);
    t.after(() => {
      closeSync(outputFd);
      rmSync(root, { recursive: true, force: true });
    });
    const write = fs.writeSync;
    let writes = 0;
    const mocked = t.mock.method(fs, 'writeSync', (...args: unknown[]) => {
      if (args[0] !== outputFd) return Reflect.apply(write, fs, args);
      if (++writes === 1) return write(outputFd, args[1] as Buffer, args[2] as number, 1);
      throw Object.assign(Error('private path /fictional/private/storage'), { code });
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(inspectPackage(path, 0, outputFd), (error) => {
        assert.ok(error instanceof PackageInspectionError);
        assert.equal(error.reasonCode, 'PACKAGE_STORAGE_FULL');
        assert.equal(error.filename, 'safe/report.txt');
        assert.equal(error.ordinal, 0);
        assert.equal(error.work?.writtenBytes, 1);
        assert.equal(error.work?.memberReadBytes, 9);
        assert.equal(error.work?.hashBytes, 9);
        assert.match(error.message, /Free runtime or archive space/);
        assert.ok(!error.message.includes('/fictional/private'));
        return true;
      });
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(writes, 2);
    assert.equal(readFileSync(output, 'utf8'), 'f');
  });
}
for (const [index, entry] of malformed.entries()) {
  test(`ZIP inspector rejects malformed fixture ${index + 1}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-zip-invalid-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'fixture.zip');
    writeFileSync(path, zipFixture([entry]));
    await assert.rejects(inspectPackage(path));
  });
}

test('ZIP inspector validates central metadata before reading selected data and preserves Unicode names', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-zip-selected-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.zip');
  writeFileSync(path, zipFixture([{ name: 'report-🌿.txt', data: 'fictional' }]));
  const output = join(root, 'member');
  const outputFd = openSync(output, 'wx', 0o600);
  t.after(() => closeSync(outputFd));
  const [member] = await inspectPackage(path, 0, outputFd);
  assert.equal(member!.filename, 'report-🌿.txt');
  assert.equal(readFileSync(output, 'utf8'), 'fictional');
  assert.equal('data' in member!, false);
  await assert.rejects(inspectPackage(path, 1, outputFd), /outside inventory/);
  await assert.rejects(inspectPackage(path, NaN, outputFd), /outside inventory/);
  writeFileSync(
    path,
    zipFixture([
      { name: 'good.txt', data: 'fictional' },
      { name: '../bad.txt', data: 'bad' },
    ]),
  );
  await assert.rejects(inspectPackage(path, 0, outputFd));
});

test('ZIP inspector rejects duplicate names and truncated archives', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-zip-incomplete-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.zip');
  writeFileSync(
    path,
    zipFixture([
      { name: 'duplicate.txt', data: 'first fictional' },
      { name: 'duplicate.txt', data: 'second fictional' },
    ]),
  );
  await assert.rejects(inspectPackage(path), /Unsafe or duplicate/);
  writeFileSync(path, zipFixture([{ name: 'fictional.txt', data: 'fictional' }]).subarray(0, 35));
  await assert.rejects(inspectPackage(path), /central directory/);
});

test('ZIP inspector rejects disagreement between local and central header filenames', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-zip-header-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.zip');
  const bytes = zipFixture([{ name: 'first.txt', data: 'fictional' }]);
  bytes[30] = 'x'.charCodeAt(0);
  writeFileSync(path, bytes);
  await assert.rejects(inspectPackage(path), /local header/);
});

test('ZIP inspector explains unsupported BZIP2 and LZMA compression without decoding it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-zip-codec-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.zip');
  for (const method of [12, 14]) {
    const bytes = zipFixture([{ name: 'report.txt', data: 'fictional' }]);
    bytes.writeUInt16LE(method, 8);
    const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt16LE(method, directory + 10);
    writeFileSync(path, bytes);
    await assert.rejects(inspectPackage(path), /export with stored or deflate compression/);
  }
});
