import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPackageFile, PackageInspectionError } from '../intake-package-worker.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';

function fixture(t: { after: (fn: () => void) => void }, bytes: Buffer) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-package-worker-'));
  const path = join(root, 'source.zip'),
    output = join(root, 'member');
  writeFileSync(path, bytes);
  const sourceFd = openSync(path, 'r'),
    outputFd = openSync(output, 'wx', 0o600);
  t.after(() => {
    closeSync(sourceFd);
    closeSync(outputFd);
    rmSync(root, { recursive: true, force: true });
  });
  return { sourceFd, outputFd, output, path };
}

test('ZIP worker writes a large selected member through inherited descriptors with bounded counted chunks', async (t) => {
  const bytes = Buffer.alloc(26 * 1024 * 1024, 'fictional source\n');
  const setup = fixture(t, zipFixture([{ name: 'report-🌿.txt', data: bytes }]));
  const { members, work } = await inspectPackageFile({ ...setup, selectedOrdinal: 0 });
  assert.deepEqual(members, [
    {
      ordinal: 0,
      filename: 'report-🌿.txt',
      bytes: bytes.length,
      compressedBytes: members[0]!.compressedBytes,
      sourceHash: createHash('sha256').update(bytes).digest('hex'),
    },
  ]);
  assert.equal('data' in members[0]!, false);
  assert.deepEqual(readFileSync(setup.output), bytes);
  assert.equal(work.memberReadBytes, bytes.length);
  assert.equal(work.hashBytes, bytes.length);
  assert.equal(work.crcBytes, bytes.length);
  assert.equal(work.writtenBytes, bytes.length);
  assert.ok(work.peakChunkBytes <= 64 * 1024);
  assert.ok(work.memberChunks > 1);
  assert.equal(fstatSync(setup.sourceFd).size > 0, true);
});

test('ZIP inventory work grows with payload bytes and emits metadata only', async (t) => {
  const first = fixture(
    t,
    zipFixture([{ name: 'first.txt', data: Buffer.alloc(1024 * 1024, 'a') }], { store: true }),
  );
  const second = fixture(
    t,
    zipFixture([{ name: 'second.txt', data: Buffer.alloc(2 * 1024 * 1024, 'b') }], { store: true }),
  );
  const a = await inspectPackageFile({ sourceFd: first.sourceFd });
  const b = await inspectPackageFile({ sourceFd: second.sourceFd });
  assert.equal(b.work.memberReadBytes, a.work.memberReadBytes * 2);
  assert.equal(b.work.hashBytes, a.work.hashBytes * 2);
  assert.equal(b.work.writtenBytes, 0);
  assert.equal(a.work.peakChunkBytes, b.work.peakChunkBytes);
  assert.ok(b.work.peakChunkBytes <= 64 * 1024);
  assert.equal(fstatSync(second.outputFd).size, 0);
});

test('ZIP worker CRC failures retain safe occurrence location and counted unacknowledged output', async (t) => {
  const setup = fixture(
    t,
    zipFixture([{ name: 'safe/report.txt', data: 'fictional', checksum: 0 }]),
  );
  await assert.rejects(inspectPackageFile({ ...setup, selectedOrdinal: 0 }), (error) => {
    assert.ok(error instanceof PackageInspectionError);
    assert.equal(error.reasonCode, 'PACKAGE_CHECKSUM');
    assert.equal(error.filename, 'safe/report.txt');
    assert.equal(error.ordinal, 0);
    assert.equal(error.work?.writtenBytes, 9);
    assert.ok(!error.message.includes(setup.path));
    return true;
  });
});

test('ZIP worker refuses unsafe metadata before writing any selected payload', async (t) => {
  const setup = fixture(
    t,
    zipFixture([
      { name: 'safe.txt', data: 'fictional' },
      { name: '../unsafe.txt', data: 'untrusted' },
    ]),
  );
  await assert.rejects(inspectPackageFile({ ...setup, selectedOrdinal: 0 }), (error) => {
    assert.ok(error instanceof PackageInspectionError);
    assert.equal(error.filename, undefined);
    assert.ok(!error.message.includes('../'));
    return true;
  });
  assert.equal(fstatSync(setup.outputFd).size, 0);
});

test('ZIP worker retains metadata safeguards with a located processing refusal', async (t) => {
  const setup = fixture(
    t,
    zipFixture(
      Array.from({ length: 5001 }, (_, index) => ({ name: `member-${index}.txt`, data: '' })),
    ),
  );
  await assert.rejects(inspectPackageFile({ sourceFd: setup.sourceFd }), (error) => {
    assert.ok(error instanceof PackageInspectionError);
    assert.equal(error.reasonCode, 'PACKAGE_METADATA');
    assert.equal(error.filename, 'member-5000.txt');
    assert.equal(error.ordinal, 5000);
    assert.match(error.message, /processing safeguard; original retained/);
    return true;
  });
});

test('ZIP worker propagates cancellation after launch and leaves descriptors with its caller', async (t) => {
  const setup = fixture(t, zipFixture([{ name: 'report.txt', data: 'fictional' }]));
  const cancellation = new Error('Fixture profile closed');
  let checks = 0;
  await assert.rejects(
    inspectPackageFile({
      sourceFd: setup.sourceFd,
      assertRunning: () => {
        if (++checks > 1) throw cancellation;
      },
    }),
    (error) => error === cancellation,
  );
  assert.ok(fstatSync(setup.sourceFd).isFile());
});

test('ZIP worker detects source mutation and refuses nonempty output', async (t) => {
  const setup = fixture(t, zipFixture([{ name: 'report.txt', data: 'fictional' }]));
  let checks = 0;
  await assert.rejects(
    inspectPackageFile({
      sourceFd: setup.sourceFd,
      assertRunning: () => {
        if (++checks === 2)
          writeFileSync(setup.path, zipFixture([{ name: 'report.txt', data: 'different' }]));
      },
    }),
    /source changed/,
  );
  writeSync(setup.outputFd, Buffer.from('existing'));
  await assert.rejects(
    inspectPackageFile({ ...setup, selectedOrdinal: 0 }),
    /empty private regular file/,
  );
});

test('ZIP worker rejects invalid descriptor selection pairs before launch', async (t) => {
  const setup = fixture(t, zipFixture([{ name: 'report.txt', data: 'fictional' }]));
  await assert.rejects(
    inspectPackageFile({ sourceFd: setup.sourceFd, selectedOrdinal: 0 }),
    /ordinal and private output/,
  );
  await assert.rejects(
    inspectPackageFile({ sourceFd: setup.sourceFd, outputFd: setup.sourceFd, selectedOrdinal: 0 }),
    /empty private regular file/,
  );
});

test('ZIP worker reports actual unwritable output as unavailable storage with its retained occurrence', async (t) => {
  const setup = fixture(t, zipFixture([{ name: 'safe/report.txt', data: 'fictional' }]));
  const readonlyOutput = openSync(setup.output, 'r');
  t.after(() => closeSync(readonlyOutput));
  await assert.rejects(
    inspectPackageFile({ sourceFd: setup.sourceFd, outputFd: readonlyOutput, selectedOrdinal: 0 }),
    (error) => {
      assert.ok(error instanceof PackageInspectionError);
      assert.equal(error.reasonCode, 'PACKAGE_STORAGE');
      assert.equal(error.filename, 'safe/report.txt');
      assert.equal(error.ordinal, 0);
      assert.equal(error.work?.writtenBytes, 0);
      assert.equal(error.work?.memberReadBytes, 9);
      assert.equal(error.work?.hashBytes, 9);
      assert.match(error.message, /restore writable storage/);
      assert.ok(!error.message.includes(setup.path));
      return true;
    },
  );
  assert.equal(fstatSync(setup.outputFd).size, 0);
});
