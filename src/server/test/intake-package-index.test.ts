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
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import {
  buildPackageIndex,
  authorizeCheckedPackageMember,
  extractCheckedPackageMember,
  authorizePackageVerifiedPrefix,
} from '../intake-package-index.ts';
import { createPackageSourceLeaseOwner } from '../intake-package-source-lease.ts';
import { PackageInspectionError } from '../intake-package-worker.ts';
import { DatabaseSync } from 'node:sqlite';

test('retained-prefix capabilities refuse forged, source-mismatched and changed descriptor seeds', async (t) => {
  const f = fixture(t, zipFixture([{ name: 'fictional.txt', data: 'fictional' }]));
  let retainedPrefix: ReturnType<typeof authorizePackageVerifiedPrefix> | undefined;
  await f.owner.withSource(f.source, async (lease) => {
    const original = await buildPackageIndex({ lease, scratchRoot: f.root });
    const descriptor = original.member(0)!;
    original.close();
    await assert.rejects(
      buildPackageIndex({
        lease,
        scratchRoot: f.root,
        verifiedPrefix: {} as ReturnType<typeof authorizePackageVerifiedPrefix>,
      }),
      { reasonCode: 'PACKAGE_SELECTION' },
    );
    const foreign = authorizePackageVerifiedPrefix({
      binding: { ...lease.binding, sourceHash: '0'.repeat(64) },
      count: 1,
      read: () => descriptor,
      assertAuthority() {},
    });
    await assert.rejects(
      buildPackageIndex({ lease, scratchRoot: f.root, verifiedPrefix: foreign }),
      { reasonCode: 'PACKAGE_SELECTION' },
    );
    const changed = authorizePackageVerifiedPrefix({
      binding: lease.binding,
      count: 1,
      read: () => ({ ...descriptor, filename: 'changed.txt' }),
      assertAuthority() {},
    });
    await assert.rejects(
      buildPackageIndex({ lease, scratchRoot: f.root, verifiedPrefix: changed }),
      { reasonCode: 'PACKAGE_PREFIX_CHANGED' },
    );
    const valid = authorizePackageVerifiedPrefix({
      binding: lease.binding,
      count: 1,
      read: () => descriptor,
      assertAuthority() {},
    });
    retainedPrefix = valid;
    const resumed = await buildPackageIndex({ lease, scratchRoot: f.root, verifiedPrefix: valid });
    assert.deepEqual(resumed.member(0), descriptor);
    assert.equal(resumed.work.membersReused, 1);
    assert.equal(resumed.work.hashBytes, 0);
    assert.equal(resumed.work.crcBytes, 0);
    assert.equal(resumed.work.descriptorReads, 0);
    resumed.close();
  });
  const changedSource = readFileSync(f.source.path);
  changedSource[changedSource.length - 1] ^= 1;
  writeFileSync(f.source.path, changedSource);
  let consumed = false;
  await assert.rejects(
    f.owner.withSource(f.source, (lease) => {
      consumed = true;
      return buildPackageIndex({ lease, scratchRoot: f.root, verifiedPrefix: retainedPrefix });
    }),
    { code: 'SOURCE_CHANGED' },
  );
  assert.equal(consumed, false);
});

test('only disposable spool capacity failures are mapped; authority sink errors preserve identity', async (t) => {
  const f = fixture(t, zipFixture([{ name: 'fictional.txt', data: 'fictional' }]));
  const originalExec = DatabaseSync.prototype.exec;
  const injected = Object.assign(new Error('fictional SQLite capacity refusal'), { errcode: 13 });
  const mock = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.includes('CREATE TABLE central')) throw injected;
      return originalExec.call(this, sql);
    },
  );
  await assert.rejects(
    f.owner.withSource(f.source, (lease) => buildPackageIndex({ lease, scratchRoot: f.root })),
    (error: unknown) =>
      error instanceof PackageInspectionError && error.reasonCode === 'PACKAGE_STORAGE_FULL',
  );
  mock.mock.restore();
  assert.deepEqual(readdirSync(join(f.root, '.package-index-staging')), []);
  // A durable sink can fail after starting publication. Its same SQLite code
  // must not become permission to write a new failure receipt before recovery.
  await assert.rejects(
    f.owner.withSource(f.source, (lease) =>
      buildPackageIndex({
        lease,
        scratchRoot: f.root,
        onVerifiedBatch: async () => {
          throw injected;
        },
      }),
    ),
    (error: unknown) => error === injected,
  );
  assert.deepEqual(readdirSync(join(f.root, '.package-index-staging')), []);
});

test('profile close during a reused-prefix acknowledgement stops the real worker before completion', async (t) => {
  const f = fixture(t, zipFixture([{ name: 'fictional.txt', data: 'fictional' }]));
  let callbacks = 0;
  await assert.rejects(
    f.owner.withSource(f.source, async (lease) => {
      const first = await buildPackageIndex({ lease, scratchRoot: f.root });
      const descriptor = first.member(0)!;
      first.close();
      const verifiedPrefix = authorizePackageVerifiedPrefix({
        binding: lease.binding,
        count: 1,
        read: () => descriptor,
        assertAuthority() {},
      });
      return buildPackageIndex({
        lease,
        scratchRoot: f.root,
        verifiedPrefix,
        onVerifiedBatch: async () => {
          callbacks++;
          f.owner.close();
        },
      });
    }),
    { code: 'PROFILE_LOCKED' },
  );
  assert.equal(callbacks, 1);
  assert.deepEqual(readdirSync(join(f.root, '.package-index-staging')), []);
});

test('legal large names traverse fragmented transport and byte-bounded inventory pages', async (t) => {
  const name = 'fictional-' + '"'.repeat(50000) + '.txt';
  const f = fixture(t, zipFixture([{ name, data: 'fictional small payload' }]));
  const records: Buffer[] = [];
  await f.owner.withSource(f.source, async (lease) => {
    const index = await buildPackageIndex({
      lease,
      scratchRoot: f.root,
      onVerifiedBatch: async (batch) => {
        assert.ok(batch.encodedBytes <= 32768);
        records.push(...batch.chunks.map((c) => Buffer.from(c.data)));
      },
    });
    try {
      assert.equal(index.member(0)!.filename, name);
      const chunks: Buffer[] = [];
      let next: { ordinal: number; byteOffset: number } | null = { ordinal: 0, byteOffset: 0 };
      let pages = 0;
      while (next) {
        const page = index.readPage({ ...next, byteBudget: 8192 });
        assert.ok(page.encodedBytes <= 8192);
        assert.ok(page.chunks.every((c) => c.data.length <= 4096));
        chunks.push(...page.chunks.map((c) => Buffer.from(c.data)));
        next = page.next;
        pages++;
      }
      assert.ok(pages > 10);
      assert.deepEqual(Buffer.concat(chunks), Buffer.concat(records));
      assert.equal(JSON.parse(Buffer.concat(chunks).toString()).filename, name);
    } finally {
      index.close();
    }
  });
});

test('explicit disk protocol crosses legacy metadata totals with bounded batches and selected work', async (t) => {
  const count = 5001;
  const f = fixture(
    t,
    zipFixture(
      Array.from({ length: count }, (_, ordinal) => ({
        name: `fictional/${ordinal}-` + 'x'.repeat(450) + '.txt',
        data: 'f',
      })),
    ),
  );
  let batches = 0;
  await f.owner.withSource(f.source, async (lease) => {
    const index = await buildPackageIndex({
      lease,
      scratchRoot: f.root,
      onVerifiedBatch: async (batch) => {
        batch.assertRunning();
        assert.ok(batch.encodedBytes <= 32768);
        batches++;
      },
    });
    try {
      assert.equal(index.summary.members, count);
      assert.equal(index.work.centralDeclarations, count);
      assert.equal(index.work.descriptorReads, count);
      assert.equal(index.work.hashBytes, count);
      assert.equal(batches, count);
      assert.ok(index.io.nameHashBytes > 2 * 1024 * 1024);
      assert.ok(index.io.peakBatchBytes <= 32768);
      const selected = index.member(count - 1)!;
      assert.equal(selected.duplicateOrdinal, 0);
      const member = authorizeCheckedPackageMember({
        binding: index.binding,
        descriptor: selected,
        inventoryRoot: 'b'.repeat(64),
        assertAuthority() {},
      });
      const path = join(f.root, 'last-selected');
      const outputFd = openSync(path, 'wx');
      try {
        const result = await extractCheckedPackageMember({ lease, member, outputFd });
        assert.equal(result.work.centralDeclarations, 0);
        assert.equal(result.work.descriptorReads, 1);
        assert.equal(result.work.hashBytes, 1);
        assert.equal(readFileSync(path, 'utf8'), 'f');
      } finally {
        closeSync(outputFd);
      }
    } finally {
      index.close();
    }
  });
  assert.equal(f.owner.work.coldHashBytes, f.source.bytes);
});

test('blocked authority sink is backpressured and close cancels the real worker without publishing completion', async (t) => {
  const f = fixture(
    t,
    zipFixture([
      { name: 'one.txt', data: 'fictional first' },
      { name: 'two.txt', data: 'fictional second' },
    ]),
  );
  let calls = 0;
  let guard: (() => void) | undefined;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await assert.rejects(
    f.owner.withSource(f.source, (lease) =>
      buildPackageIndex({
        lease,
        scratchRoot: f.root,
        onVerifiedBatch: async (batch) => {
          calls++;
          guard = batch.assertRunning;
          setImmediate(() => f.closeProfile());
          await blocked;
          batch.assertRunning();
        },
      }),
    ),
    { code: 'PROFILE_LOCKED' },
  );
  assert.equal(calls, 1);
  assert.throws(() => guard!(), { code: 'PROFILE_LOCKED' });
  release();
  assert.deepEqual(readdirSync(join(f.root, '.package-index-staging')), []);
});

test('checked direct extraction preserves worker storage reason, location and actual failed work', async (t) => {
  const f = fixture(
    t,
    zipFixture([{ name: 'fictional-report.txt', data: 'fictional retained bytes' }]),
  );
  await f.owner.withSource(f.source, async (lease) => {
    const index = await buildPackageIndex({ lease, scratchRoot: f.root });
    const outputPath = join(f.root, 'readonly-output');
    writeFileSync(outputPath, '');
    const outputFd = openSync(outputPath, 'r');
    try {
      const member = authorizeCheckedPackageMember({
        binding: index.binding,
        descriptor: index.member(0)!,
        inventoryRoot: 'a'.repeat(64),
        assertAuthority() {},
      });
      await assert.rejects(extractCheckedPackageMember({ lease, member, outputFd }), (error) => {
        assert.ok(error instanceof PackageInspectionError);
        assert.equal(error.reasonCode, 'PACKAGE_STORAGE');
        assert.equal(error.filename, 'fictional-report.txt');
        assert.equal(error.ordinal, 0);
        assert.equal(error.traversalWork!.centralDeclarations, 0);
        assert.equal(error.traversalWork!.descriptorReads, 1);
        assert.equal(error.traversalWork!.writtenBytes, 0);
        assert.ok(error.traversalWork!.memberReadBytes > 0);
        return true;
      });
      assert.equal(statSync(outputPath).size, 0);
    } finally {
      closeSync(outputFd);
      index.close();
    }
  });
});

for (const [name, mutate] of [
  [
    'local name',
    (bytes: Buffer) => {
      bytes[30] = 'x'.charCodeAt(0);
    },
  ],
  [
    'local flags',
    (bytes: Buffer) => {
      bytes.writeUInt16LE(8, 6);
    },
  ],
  [
    'local CRC',
    (bytes: Buffer) => {
      bytes.writeUInt32LE(0, 14);
    },
  ],
] as const) {
  test(`new inventory refuses mismatched ${name} without completing authority`, async (t) => {
    const bytes = zipFixture([{ name: 'fictional.txt', data: 'fictional retained bytes' }]);
    mutate(bytes);
    const f = fixture(t, bytes);
    let verified = 0;
    await assert.rejects(
      f.owner.withSource(f.source, (lease) =>
        buildPackageIndex({
          lease,
          scratchRoot: f.root,
          onVerifiedBatch: async () => {
            verified++;
          },
        }),
      ),
      (error) => {
        assert.ok(error instanceof PackageInspectionError);
        assert.equal(error.reasonCode, 'PACKAGE_HEADER');
        assert.equal(error.filename, 'fictional.txt');
        return true;
      },
    );
    assert.equal(verified, 0);
    assert.deepEqual(readdirSync(join(f.root, '.package-index-staging')), []);
  });
}

function fixture(t: { after: (run: () => void) => void }, bytes: Buffer) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-indexed-package-'));
  const path = join(root, 'source.zip');
  writeFileSync(path, bytes);
  let live = true;
  const owner = createPackageSourceLeaseOwner({
    profileId: 'fictional',
    root,
    assertAuthorized() {
      if (!live) throw Error('PROFILE_LOCKED');
    },
  });
  const source = {
    profileId: 'fictional',
    intakeId: 'source:fictional',
    bytes: bytes.length,
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
    path,
  };
  t.after(() => {
    live = false;
    owner.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    owner,
    source,
    closeProfile() {
      live = false;
      owner.close();
    },
  };
}

test('bounded disk inventory preserves ordinals, names, duplicate content and direct descriptor work', async (t) => {
  const entries = [
    { name: 'directory/', data: '' },
    { name: 'directory/report.json', data: '{"fictional":"exact1.000"}' },
    { name: 'other-copy.json', data: '{"fictional":"exact1.000"}' },
    { name: 'last.txt', data: 'fictional different bytes' },
  ];
  const f = fixture(t, zipFixture(entries));
  let chunks = 0;
  await f.owner.withSource(f.source, async (lease) => {
    const index = await buildPackageIndex({
      lease,
      scratchRoot: f.root,
      onVerifiedBatch: async (batch) => {
        batch.assertRunning();
        assert.ok(batch.encodedBytes <= 32768);
        for (const chunk of batch.chunks) {
          assert.ok(chunk.data.length <= 4096);
          chunks++;
        }
      },
    });
    try {
      assert.deepEqual(index.summary, {
        entries: 4,
        members: 3,
        expandedBytes: Buffer.byteLength(entries[1].data) * 2 + Buffer.byteLength(entries[3].data),
      });
      assert.equal(index.work.centralDeclarations, 4);
      assert.equal(index.work.descriptorReads, 3);
      assert.ok(chunks > 0);
      assert.equal(index.member(1)!.duplicateOrdinal, 0);
      assert.deepEqual(
        [...index.membersByExactName('directory/report.json')].map((m) => m.ordinal),
        [0],
      );
      assert.deepEqual(
        [...index.membersByDigest(index.member(0)!.sourceHash)].map((m) => m.ordinal),
        [0, 1],
      );
      assert.equal([...index.range({ offset: 1, limit: 1 })][0].filename, 'other-copy.json');
      const selected = index.member(2)!;
      let authorityLive = true;
      const member = authorizeCheckedPackageMember({
        binding: index.binding,
        descriptor: selected,
        inventoryRoot: 'a'.repeat(64),
        assertAuthority() {
          assert.equal(authorityLive, true);
        },
      });
      const path = join(f.root, 'selected'),
        outputFd = openSync(path, 'wx', 0o600);
      try {
        const result = await extractCheckedPackageMember({ lease, member, outputFd });
        assert.equal(result.work.centralDeclarations, 0);
        assert.equal(result.work.descriptorReads, 1);
        assert.equal(result.work.hashBytes, Buffer.byteLength(entries[3].data));
        assert.equal(result.work.writtenBytes, Buffer.byteLength(entries[3].data));
        assert.equal(readFileSync(path, 'utf8'), entries[3].data);
        assert.equal(statSync(path).size, selected.bytes);
        authorityLive = false;
        await assert.rejects(extractCheckedPackageMember({ lease, member, outputFd }));
      } finally {
        closeSync(outputFd);
      }
      await assert.rejects(
        extractCheckedPackageMember({
          lease,
          member: { inventoryRoot: 'a'.repeat(64) },
          outputFd: 9999,
        }),
        /another source/,
      );
    } finally {
      index.close();
    }
  });
  assert.equal(f.owner.work.coldHashBytes, f.source.bytes);
  const before = f.owner.work.coldHashBytes;
  await f.owner.withSource(f.source, async (lease) => {
    lease.assertCurrent();
  });
  assert.equal(f.owner.work.coldHashBytes, before);
  assert.equal(f.owner.work.verificationCacheHits, 1);
  assert.deepEqual(readdirSync(join(f.root, '.package-index-staging')), []);
});

for (const [name, entries] of [
  [
    'late duplicate',
    [
      { name: 'ok.txt', data: 'fictional' },
      { name: 'ok.txt', data: 'different' },
    ],
  ],
  [
    'late CRC',
    [
      { name: 'ok.txt', data: 'fictional' },
      { name: 'bad.txt', data: 'different', checksum: 0 },
    ],
  ],
  [
    'late unsafe',
    [
      { name: 'ok.txt', data: 'fictional' },
      { name: '../escape', data: 'different' },
    ],
  ],
] as const) {
  test(`incomplete ${name} cannot return a completed disk index`, async (t) => {
    const f = fixture(t, zipFixture([...entries]));
    let verifiedChunks = 0;
    await assert.rejects(
      f.owner.withSource(f.source, (lease) =>
        buildPackageIndex({
          lease,
          scratchRoot: f.root,
          onVerifiedBatch: async () => {
            verifiedChunks++;
          },
        }),
      ),
      (error) => {
        assert.ok(error instanceof PackageInspectionError);
        return true;
      },
    );
    assert.equal(verifiedChunks > 0, name === 'late CRC');
    assert.deepEqual(readdirSync(join(f.root, '.package-index-staging')), []);
  });
}
