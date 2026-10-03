import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPackage } from '../intake-package-inspector.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';

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
