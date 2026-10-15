import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  copyProfileFileCooperative,
  copyProfileTreeCooperative,
  syncProfileTreeCooperative,
} from '../profile-copy-file-work.ts';

test('private copy filesystem work is chunked, complete, and flushes nested files', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-profile-file-copy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    target = join(root, 'target');
  mkdirSync(join(source, 'nested'), { recursive: true });
  mkdirSync(target);
  const bytes = Buffer.alloc(256 * 1024 + 17, 0x42);
  writeFileSync(join(source, 'nested', 'fictional.bin'), bytes);
  let checks = 0;
  await copyProfileTreeCooperative(source, target, () => checks++);
  assert.ok(checks > 4, 'copy checks across bounded chunks');
  assert.deepEqual(readFileSync(join(target, 'nested', 'fictional.bin')), bytes);
  await syncProfileTreeCooperative(target, () => checks++);
  assert.ok(checks > 6, 'flush checks across files and directories');

  const single = join(root, 'copy.sqlite');
  await copyProfileFileCooperative(join(source, 'nested', 'fictional.bin'), single, () => checks++);
  assert.deepEqual(readFileSync(single), bytes);
  await assert.rejects(
    copyProfileFileCooperative(join(source, 'nested', 'fictional.bin'), single, () => {}),
    { code: 'EEXIST' },
  );
});

test('private copy rejects source links and a changed source during chunked copying', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-profile-file-refusal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    target = join(root, 'target');
  mkdirSync(source);
  mkdirSync(target);
  writeFileSync(join(source, 'fictional.bin'), Buffer.alloc(256 * 1024, 0x35));
  symlinkSync(join(source, 'fictional.bin'), join(source, 'linked.bin'));
  await assert.rejects(
    copyProfileTreeCooperative(source, target, () => {}),
    {
      code: 'PROFILE_SOURCE_LINK',
    },
  );
  rmSync(join(source, 'linked.bin'));
  const changed = join(root, 'changed');
  let tampered = false;
  await assert.rejects(
    copyProfileFileCooperative(join(source, 'fictional.bin'), changed, () => {
      if (!tampered && statSync(changed, { throwIfNoEntry: false })?.size) {
        tampered = true;
        writeFileSync(join(source, 'fictional.bin'), Buffer.alloc(256 * 1024 + 1, 0x36));
      }
    }),
    /source file changed/,
  );
  assert.equal(tampered, true);

  const replaced = join(root, 'replaced');
  let swapped = false;
  await assert.rejects(
    copyProfileFileCooperative(join(source, 'fictional.bin'), replaced, () => {
      if (!swapped && statSync(replaced, { throwIfNoEntry: false })?.size) {
        swapped = true;
        renameSync(replaced, replaced + '.old');
        writeFileSync(replaced, 'fictional replacement');
      }
    }),
    /target path changed/,
  );
  assert.equal(swapped, true);
});

test('private copy stops at the next bounded chunk after cancellation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-profile-file-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    target = join(root, 'target');
  writeFileSync(source, Buffer.alloc(512 * 1024, 0x21));
  const controller = new AbortController();
  let checks = 0;
  await assert.rejects(
    copyProfileFileCooperative(source, target, () => {
      if (++checks === 5) controller.abort(Error('fictional copy cancellation'));
      controller.signal.throwIfAborted();
    }),
    /fictional copy cancellation/,
  );
  assert.ok(checks >= 5);
  assert.ok(statSync(target).size < statSync(source).size);
});

test('private copy refuses a target directory swapped to a link before child dispatch', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-profile-target-swap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    target = join(root, 'target'),
    outside = join(root, 'outside');
  mkdirSync(source);
  mkdirSync(target);
  mkdirSync(outside);
  writeFileSync(join(source, 'fictional.bin'), 'fictional original');
  let checks = 0;
  await assert.rejects(
    copyProfileTreeCooperative(source, target, () => {
      if (++checks === 3) {
        renameSync(target, target + '.old');
        symlinkSync(outside, target, 'dir');
      }
    }),
    /target directory changed/,
  );
  assert.equal(statSync(join(outside, 'fictional.bin'), { throwIfNoEntry: false }), undefined);
});

test('an initially present optional tree cannot disappear into a successful partial copy', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-profile-tree-loss-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    target = join(root, 'target');
  mkdirSync(source);
  mkdirSync(target);
  writeFileSync(join(source, 'fictional.bin'), 'fictional original');
  let checks = 0;
  await assert.rejects(
    copyProfileTreeCooperative(source, target, () => {
      if (++checks === 3) rmSync(source, { recursive: true, force: true });
    }),
  );
  assert.equal(checks >= 3, true);
});
