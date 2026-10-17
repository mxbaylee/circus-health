import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs, {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createIntakeEncryptedScratch,
  withIntakeEncryptedScratch,
  IntakeEncryptedScratchCapacityError,
  IntakeEncryptedScratchIntegrityError,
  type IntakeEncryptedScratchOptions,
} from '../intake-encrypted-scratch.ts';

const options = (
  extra: Partial<IntakeEncryptedScratchOptions> = {},
): IntakeEncryptedScratchOptions => ({
  identity: {
    profileId: 'fictional-scratch-profile',
    intakeId: 'fictional-scratch-intake',
    sourceHash: 'a'.repeat(64),
  },
  selectedHead: 'Independently fictional selected head.',
  tables: ['values', 'other'],
  ...extra,
});
const files = (scratch: ReturnType<typeof createIntakeEncryptedScratch>) =>
  readdirSync(join(scratch.directory, 'cells')).map((name) =>
    join(scratch.directory, 'cells', name),
  );
function all(map: ReturnType<ReturnType<typeof createIntakeEncryptedScratch>['map']>) {
  const entries: Array<[string, unknown]> = [];
  let after: string | undefined;
  do {
    const page = map.scan({ after, items: 7, scanned: 9 });
    entries.push(...page.entries.map(({ key, value }) => [key, value] as [string, unknown]));
    if (page.complete) break;
    assert.notEqual(page.after, after);
    after = page.after;
  } while (true);
  return entries;
}

test('encrypted ordered map matches reference Map across rotations, updates, deletes and bounded scans', () => {
  const scratch = createIntakeEncryptedScratch(options()),
    map = scratch.map('values'),
    reference = new Map<string, string>();
  try {
    assert.equal(map.get('absent'), undefined);
    assert.equal(map.delete('absent'), false);
    assert.equal(scratch.stats().filesWritten, 0);
    for (const i of [
      ...Array.from({ length: 80 }, (_, n) => n),
      ...Array.from({ length: 80 }, (_, n) => 159 - n),
    ]) {
      const key = String(i).padStart(4, '0'),
        value = 'Independently fictional value ' + i;
      assert.equal(map.set(key, value), true);
      reference.set(key, value);
    }
    for (let i = 0; i < 160; i += 3) {
      const key = String(i).padStart(4, '0');
      assert.equal(map.delete(key), reference.delete(key));
      assert.equal(map.delete(key), false);
    }
    for (let i = 0; i < 160; i += 5) {
      const key = String(i).padStart(4, '0');
      map.set(key, 'fictional revised ' + i);
      reference.set(key, 'fictional revised ' + i);
    }
    assert.deepEqual(
      all(map),
      [...reference].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    assert.equal(map.size(), reference.size);
    const before = scratch.stats();
    for (const [key, value] of reference) assert.equal(map.set(key, value), false);
    assert.equal(scratch.stats().filesWritten, before.filesWritten, 'no-op writes create no pages');
    for (const key of [...reference.keys()]) assert.equal(map.delete(key), true);
    assert.equal(map.size(), 0);
    assert.deepEqual(all(map), []);
    assert.ok(
      scratch.stats().filesRetained > 160,
      'old immutable COW ciphertext is counted, not pruned',
    );
    assert.ok(scratch.stats().peakCachePages <= 128);
    assert.ok(scratch.stats().peakCacheBytes <= 128 * 32768);
    assert.ok(scratch.stats().peakPreparedWritePages <= scratch.stats().peakPreparationPageBound);
    assert.ok(
      scratch.stats().nodeWrites < scratch.stats().preparations * 40,
      'single-key work follows AVL paths rather than copying the table',
    );
  } finally {
    scratch.close();
  }
  assert.equal(existsSync(scratch.directory), false);
  assert.equal(scratch.stats().filesRetained, 0);
});

test('map preserves exact JS strings and spills encoding overhead through bounded encrypted scalars', () => {
  const scratch = createIntakeEncryptedScratch(options()),
    map = scratch.map('values');
  try {
    for (const [key, value] of [
      ['', ''],
      ['\ud800', '\ud800'],
      ['\ud801', '\ud801'],
      ['limit', 'x'.repeat(8192)],
    ]) {
      map.set(key, value);
      assert.equal(map.get(key), value);
    }
    assert.equal(map.get('\ud800'), '\ud800');
    assert.equal(map.get('\ud801'), '\ud801');
    assert.ok(scratch.stats().scalarChunkWrites >= 2);
    const before = scratch.stats().filesWritten;
    assert.equal(map.set('limit', 'x'.repeat(8192)), false);
    assert.equal(scratch.stats().filesWritten, before);
  } finally {
    scratch.close();
  }
});

test('map clear selects a fresh authenticated empty generation without pruning ciphertext', () => {
  const scratch = createIntakeEncryptedScratch(options()),
    map = scratch.map('values');
  try {
    map.set('fictional-key', 'fictional-value');
    const oldFiles = files(scratch),
      retained = scratch.stats().filesRetained;
    map.clear();
    assert.equal(map.size(), 0);
    assert.equal(map.get('fictional-key'), undefined);
    assert.deepEqual(all(map), []);
    assert.equal(scratch.stats().filesRetained, retained);
    assert.ok(oldFiles.every(existsSync));
    map.set('fictional-key', 'fictional-value');
    assert.equal(map.get('fictional-key'), 'fictional-value');
    assert.ok(
      scratch.stats().filesRetained > retained,
      'fresh node binding prevents old root reuse',
    );
    assert.ok(oldFiles.every(existsSync));
    map.clear();
    map.clear();
    assert.equal(map.size(), 0);
  } finally {
    scratch.close();
  }
  assert.throws(() => map.clear(), /closed/);
});

test('bounded map payloads survive worst-case JSON expansion in values, keys and identity', () => {
  const settings = options();
  settings.identity.profileId = '\0'.repeat(256);
  const scratch = createIntakeEncryptedScratch(settings),
    map = scratch.map('values'),
    reference = new Map<string, string>();
  try {
    for (const i of [3, 1, 5, 0, 2, 4, 6]) {
      const key = '\0'.repeat(1020) + String(i).padStart(4, '0'),
        value = '\0'.repeat(i % 2 ? 8192 : 170);
      map.set(key, value);
      reference.set(key, value);
      assert.equal(map.get(key), value);
    }
    assert.deepEqual(
      all(map),
      [...reference].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    assert.equal(map.size(), 7);
    assert.ok(scratch.stats().peakCachePages <= 128);
  } finally {
    scratch.close();
  }
});

test('scalar chunks authenticate exact bounded bytes, empty values and map descriptors', () => {
  const scratch = createIntakeEncryptedScratch(options()),
    map = scratch.map('values');
  try {
    const expected = Buffer.from('Independently fictional scalar bytes.\0'.repeat(1600));
    const scalar = scratch.writeScalar([
      expected.subarray(0, 17),
      new Uint8Array(0),
      expected.subarray(17),
    ]);
    map.set('large', scalar);
    const rebound = map.get('large');
    assert.ok(rebound && typeof rebound !== 'string');
    const pieces = [...scratch.scalarChunks(rebound)];
    assert.ok(pieces.every((piece) => piece.length <= 4096));
    assert.deepEqual(Buffer.concat(pieces), expected);
    assert.equal(rebound.bytes, expected.length);
    assert.equal(rebound.chunks, Math.ceil(expected.length / 4096));
    const empty = scratch.writeScalar([]);
    assert.equal(empty.bytes, 0);
    assert.deepEqual([...scratch.scalarChunks(empty)], []);
    for (const file of files(scratch)) {
      const raw = readFileSync(file);
      assert.equal(raw.includes(Buffer.from('Independently fictional')), false);
      assert.equal(raw.includes(Buffer.from('fictional-scratch-profile')), false);
      assert.equal(raw.subarray(0, 8).toString(), 'CIRCUS01');
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    assert.equal(statSync(scratch.directory).mode & 0o777, 0o700);
    assert.equal(scratch.stats().filesWritten, files(scratch).length);
    assert.equal(
      scratch.stats().ciphertextBytesRetained,
      files(scratch).reduce((sum, file) => sum + statSync(file).size, 0),
    );
  } finally {
    scratch.close();
  }
});

for (const attack of ['missing', 'modified', 'truncated', 'trailing', 'oversized'] as const)
  test(`reachable encrypted page ${attack} refuses even after a cached read, rather than claiming absent`, () => {
    const scratch = createIntakeEncryptedScratch(options()),
      map = scratch.map('values');
    map.set('present', 'fictional');
    assert.equal(map.get('present'), 'fictional');
    const file = files(scratch)[0]!,
      bytes = readFileSync(file);
    if (attack === 'missing') rmSync(file);
    else if (attack === 'modified') {
      bytes[40] ^= 1;
      writeFileSync(file, bytes);
    } else if (attack === 'truncated') writeFileSync(file, bytes.subarray(0, bytes.length - 1));
    else if (attack === 'trailing') writeFileSync(file, Buffer.concat([bytes, Buffer.from('x')]));
    else writeFileSync(file, Buffer.alloc(32768 + 1025));
    assert.throws(() => map.get('absent'), IntakeEncryptedScratchIntegrityError);
    assert.equal(scratch.stats().closed, true);
    assert.equal(existsSync(scratch.directory), false);
    assert.throws(() => map.get('present'), /closed/);
  });

test('old-page replay, cross-table swapping and cross-invocation ciphertext cannot replace selected roots', () => {
  for (const attack of ['old', 'table', 'invocation']) {
    const scratch = createIntakeEncryptedScratch(options()),
      map = scratch.map('values');
    let other: ReturnType<typeof createIntakeEncryptedScratch> | undefined;
    try {
      map.set('key', 'first fictional');
      const oldFile = files(scratch)[0]!,
        oldBytes = readFileSync(oldFile),
        before = new Set(files(scratch));
      if (attack === 'old') {
        map.set('key', 'second fictional');
        const current = files(scratch).find((file) => !before.has(file))!;
        writeFileSync(current, oldBytes);
      } else if (attack === 'table') {
        scratch.map('other').set('key', 'second fictional');
        const current = files(scratch).find((file) => !before.has(file))!;
        writeFileSync(oldFile, readFileSync(current));
      } else {
        other = createIntakeEncryptedScratch(options());
        other.map('values').set('key', 'first fictional');
        writeFileSync(oldFile, readFileSync(files(other)[0]!));
      }
      assert.throws(() => map.get('key'), IntakeEncryptedScratchIntegrityError);
      assert.equal(existsSync(scratch.directory), false);
    } finally {
      scratch.close();
      other?.close();
    }
  }
});

test('scalar chunk tampering fails independently of its authenticated descriptor', () => {
  const scratch = createIntakeEncryptedScratch(options());
  const scalar = scratch.writeScalar([Buffer.alloc(4096, 37)]);
  const file = files(scratch).find((file) => statSync(file).size > 4096)!;
  const bytes = readFileSync(file);
  bytes[50] ^= 1;
  writeFileSync(file, bytes);
  assert.throws(() => [...scratch.scalarChunks(scalar)], IntakeEncryptedScratchIntegrityError);
  assert.equal(scratch.stats().closed, true);
  assert.equal(existsSync(scratch.directory), false);
});

test('resource budgets and device/inode resource failures close scratch without a plaintext fallback', (t) => {
  for (const capacity of [{ files: 0 }, { bytes: 0 }]) {
    const scratch = createIntakeEncryptedScratch(options({ capacity }));
    assert.throws(
      () => scratch.map('values').set('key', 'fictional'),
      IntakeEncryptedScratchCapacityError,
    );
    assert.equal(scratch.stats().filesWritten, 0);
    assert.equal(scratch.stats().closed, true);
    assert.equal(existsSync(scratch.directory), false);
  }
  for (const code of ['ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'EFBIG']) {
    const scratch = createIntakeEncryptedScratch(options());
    const original = fs.openSync;
    const mock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).startsWith(scratch.directory))
        throw Object.assign(Error('fictional scratch resource failure'), { code });
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => scratch.map('values').set('key', 'fictional'),
        (error: unknown) =>
          error instanceof IntakeEncryptedScratchCapacityError && error.code === code,
      );
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
      scratch.close();
    }
    assert.equal(existsSync(scratch.directory), false);
  }
});

test('invocation encryption and filename keys are distinct and zeroed on success and refusal', (t) => {
  const keys: Buffer[] = [],
    original = crypto.randomBytes;
  const mock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    const bytes = original(size);
    if (size === 32) keys.push(bytes);
    return bytes;
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  try {
    const scratch = createIntakeEncryptedScratch(options());
    assert.equal(keys.length, 2);
    assert.notDeepEqual(keys[0], keys[1]);
    scratch.map('values').set('key', 'fictional');
    scratch.close();
    assert.ok(keys.every((key) => key.every((byte) => byte === 0)));
    const refused = createIntakeEncryptedScratch(options({ capacity: { files: 0 } }));
    assert.throws(
      () => refused.map('values').set('key', 'fictional'),
      IntakeEncryptedScratchCapacityError,
    );
    assert.equal(keys.length, 4);
    assert.ok(keys.every((key) => key.every((byte) => byte === 0)));
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('partial constructor key allocation is erased when the next allocation fails', (t) => {
  const original = crypto.randomBytes,
    allocated: Buffer[] = [],
    refusal = Object.assign(Error('fictional key allocation failure'), { code: 'KEY_RESOURCE' });
  const mock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    if (size === 32 && allocated.length === 1) throw refusal;
    const bytes = original(size);
    if (size === 32) allocated.push(bytes);
    return bytes;
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => createIntakeEncryptedScratch(options()),
      (error: unknown) => error === refusal,
    );
    assert.equal(allocated.length, 1);
    assert.ok(allocated[0].every((byte) => byte === 0));
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('read checkpoint revocation preserves the original session refusal and cleans scratch', () => {
  let armed = false,
    checks = 0;
  const refusal = Object.assign(Error('fictional revoked session'), { code: 'SESSION_REVOKED' }),
    scratch = createIntakeEncryptedScratch(
      options({
        assertCurrent: () => {
          if (armed && ++checks === 3) throw refusal;
        },
      }),
    );
  scratch.map('values').set('key', 'fictional');
  armed = true;
  assert.throws(
    () => scratch.map('values').get('key'),
    (error: unknown) => error === refusal,
  );
  assert.equal(checks, 3);
  assert.equal(scratch.stats().closed, true);
  assert.equal(existsSync(scratch.directory), false);
});

test('foreign scalar descriptors and cancellation during streaming erase the owned invocation', () => {
  const first = createIntakeEncryptedScratch(options()),
    second = createIntakeEncryptedScratch(options());
  const scalar = first.writeScalar([Buffer.from('independently fictional')]);
  try {
    assert.throws(
      () => second.map('values').set('foreign', scalar),
      IntakeEncryptedScratchIntegrityError,
    );
    assert.equal(existsSync(second.directory), false);
    let current = true;
    const streamed = createIntakeEncryptedScratch(
      options({
        assertCurrent: () => {
          if (!current) throw Error('fictional interrupted scalar');
        },
      }),
    );
    const value = streamed.writeScalar([Buffer.alloc(9000, 17)]),
      iterator = streamed.scalarChunks(value);
    assert.equal(iterator.next().value?.length, 4096);
    current = false;
    assert.throws(() => iterator.next(), /fictional interrupted scalar/);
    assert.equal(existsSync(streamed.directory), false);
  } finally {
    first.close();
    second.close();
  }
});

test('cancellation, caller failure and explicit close erase roots and clean invocation files', async () => {
  let active = true;
  const scratch = createIntakeEncryptedScratch(
    options({
      assertCurrent: () => {
        if (!active) throw Error('fictional cancelled scope');
      },
    }),
  );
  scratch.map('values').set('key', 'fictional');
  active = false;
  assert.throws(() => scratch.map('values').get('key'), /fictional cancelled scope/);
  assert.equal(existsSync(scratch.directory), false);
  let directory = '';
  await assert.rejects(
    withIntakeEncryptedScratch(options(), async (owned) => {
      directory = owned.directory;
      owned.map('values').set('key', 'fictional');
      throw Error('fictional caller failure');
    }),
    /fictional caller failure/,
  );
  assert.equal(existsSync(directory), false);
  await withIntakeEncryptedScratch(options(), (owned) => {
    directory = owned.directory;
    owned.close();
    assert.throws(() => owned.map('values').get('key'), /closed/);
  });
  assert.equal(existsSync(directory), false);
});

test('scalar byte ranges authenticate directly addressed chunks without reading their prefix', () => {
  const scratch = createIntakeEncryptedScratch(options()),
    bytes = Buffer.from(Array.from({ length: 4096 * 40 + 31 }, (_, i) => i % 251));
  try {
    const scalar = scratch.writeScalar([bytes]),
      before = scratch.stats();
    assert.deepEqual(
      scratch.readScalarRange(scalar, 4096 * 39 + 8, 19),
      bytes.subarray(4096 * 39 + 8, 4096 * 39 + 27),
    );
    assert.equal(scratch.stats().scalarChunkReads - before.scalarChunkReads, 1);
    const cross = scratch.stats();
    assert.deepEqual(
      scratch.readScalarRange(scalar, 4096 * 39 - 4, 4130),
      bytes.subarray(4096 * 39 - 4, 4096 * 39 - 4 + 4130),
    );
    assert.equal(scratch.stats().scalarChunkReads - cross.scalarChunkReads, 3);
    assert.deepEqual(scratch.readScalarRange(scalar, bytes.length, 0), Buffer.alloc(0));
    assert.ok(scratch.stats().peakCachePages <= 128);
  } finally {
    scratch.close();
  }
  for (const [start, count] of [
    [-1, 1],
    [0, 65537],
    [4, 2],
    [0.5, 1],
    [0, -1],
  ]) {
    const bounded = createIntakeEncryptedScratch(options());
    const scalar = bounded.writeScalar([Buffer.from('short')]);
    assert.throws(() => bounded.readScalarRange(scalar, start, count), /range bound/);
    assert.equal(existsSync(bounded.directory), false);
  }
});

test('declared append spools match byte buffers across flush, tail overlap and reset generations', () => {
  const scratch = createIntakeEncryptedScratch(options({ spools: ['canonical', 'legacy'] })),
    spool = scratch.spool('canonical'),
    other = scratch.spool('legacy');
  let reference = Buffer.alloc(0);
  try {
    assert.equal(spool.length(), 0);
    assert.deepEqual(spool.read(0, 0), Buffer.alloc(0));
    for (const count of [31, 5000, 5, 4096 * 10, 4096 - 36]) {
      const piece = Buffer.alloc(count, count % 251);
      spool.appendBytes(piece);
      reference = Buffer.concat([reference, piece]);
      assert.equal(spool.length(), reference.length);
      spool.flush();
      const before = scratch.stats().filesWritten;
      spool.flush();
      assert.equal(scratch.stats().filesWritten, before, 'repeated flush writes no new ciphertext');
      for (const start of [0, Math.max(0, reference.length - 8000), reference.length]) {
        const count = Math.min(8000, reference.length - start);
        assert.deepEqual(spool.read(start, count), reference.subarray(start, start + count));
      }
    }
    const before = scratch.stats();
    assert.deepEqual(spool.read(4096 * 9 + 3, 5), reference.subarray(4096 * 9 + 3, 4096 * 9 + 8));
    assert.equal(scratch.stats().scalarChunkReads - before.scalarChunkReads, 1);
    other.appendBytes(Buffer.from('independently fictional other spool'));
    assert.equal(other.length(), 35);
    const retained = scratch.stats().filesRetained;
    spool.reset();
    assert.equal(spool.generation(), 1);
    assert.equal(spool.length(), 0);
    assert.equal(
      scratch.stats().filesRetained,
      retained,
      'reset retains immutable encrypted history',
    );
    spool.appendBytes(Buffer.from('fictional new generation'));
    assert.deepEqual(spool.read(0, spool.length()), Buffer.from('fictional new generation'));
    assert.equal(other.length(), 35);
    assert.equal(scratch.stats().spoolTailBytes, 8192);
    assert.ok(scratch.stats().peakCachePages <= 128);
  } finally {
    scratch.close();
  }
});

test('capacity reservation precedes creation and write resource errors survive close and stat errors', (t) => {
  const refused = createIntakeEncryptedScratch(options({ capacity: { bytes: 1 } }));
  let opens = 0;
  const originalOpen = fs.openSync;
  const openMock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).startsWith(refused.directory)) opens++;
    return Reflect.apply(originalOpen, fs, args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => refused.map('values').set('key', 'fictional'),
      IntakeEncryptedScratchCapacityError,
    );
    assert.equal(opens, 0);
    assert.equal(refused.stats().filesWritten, 0);
  } finally {
    openMock.mock.restore();
    syncBuiltinESMExports();
    refused.close();
  }
  for (const secondary of ['close', 'stat']) {
    const scratch = createIntakeEncryptedScratch(options()),
      originalClose = fs.closeSync,
      originalStat = fs.lstatSync;
    let failed = false;
    const writeMock = t.mock.method(fs, 'writeSync', (() => {
      failed = true;
      throw Object.assign(Error('fictional no space'), { code: 'ENOSPC' });
    }) as typeof fs.writeSync);
    const closeMock = t.mock.method(fs, 'closeSync', (fd: number) => {
      originalClose(fd);
      if (failed && secondary === 'close')
        throw Object.assign(Error('fictional close'), { code: 'EIO' });
    });
    const statMock = t.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof fs.lstatSync>) => {
      if (failed && secondary === 'stat')
        throw Object.assign(Error('fictional stat'), { code: 'EIO' });
      return Reflect.apply(originalStat, fs, args);
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => scratch.map('values').set('key', 'fictional'),
        (error: unknown) =>
          error instanceof IntakeEncryptedScratchCapacityError && error.code === 'ENOSPC',
      );
      assert.equal(scratch.stats().filesWritten, 1);
      assert.equal(existsSync(scratch.directory), false);
    } finally {
      writeMock.mock.restore();
      closeMock.mock.restore();
      statMock.mock.restore();
      syncBuiltinESMExports();
      scratch.close();
    }
  }
});

test('partial scalar and flushed spool reads refuse missing or modified addressed ciphertext', () => {
  for (const kind of ['scalar', 'spool'])
    for (const fault of ['missing', 'modified']) {
      const scratch = createIntakeEncryptedScratch(options({ spools: ['bytes'] })),
        bytes = Buffer.alloc(4093, 113),
        scalar = kind === 'scalar' ? scratch.writeScalar([bytes]) : undefined,
        spool = scratch.spool('bytes');
      if (kind === 'spool') {
        spool.appendBytes(bytes);
        spool.flush();
      }
      const chunk = files(scratch).find((file) => statSync(file).size === bytes.length + 74);
      assert.ok(chunk, 'existing secretstream framing identifies the only fictional byte chunk');
      if (fault === 'missing') rmSync(chunk);
      else {
        const cipher = readFileSync(chunk);
        cipher[cipher.length - 1] ^= 1;
        writeFileSync(chunk, cipher);
      }
      assert.throws(
        () => (scalar ? scratch.readScalarRange(scalar, 4000, 1) : spool.read(4000, 1)),
        IntakeEncryptedScratchIntegrityError,
      );
      assert.equal(existsSync(scratch.directory), false);
    }
});

test('caller failure survives cleanup failure and cleanup still erases invocation keys', async (t) => {
  const original = fs.rmSync,
    originalRandom = crypto.randomBytes,
    keys: Buffer[] = [];
  let directory = '';
  const mock = t.mock.method(fs, 'rmSync', ((...args: Parameters<typeof fs.rmSync>) => {
    if (String(args[0]) === directory) throw Error('fictional cleanup failure');
    return Reflect.apply(original, fs, args);
  }) as typeof fs.rmSync);
  const randomMock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    const key = originalRandom(size);
    if (size === 32) keys.push(key);
    return key;
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      withIntakeEncryptedScratch(options(), (scratch) => {
        directory = scratch.directory;
        scratch.map('values').set('key', 'fictional');
        throw Error('fictional original caller refusal');
      }),
      /fictional original caller refusal/,
    );
    assert.ok(existsSync(directory));
    assert.equal(keys.length, 2);
    assert.ok(keys.every((key) => key.every((byte) => byte === 0)));
  } finally {
    mock.mock.restore();
    randomMock.mock.restore();
    syncBuiltinESMExports();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});
