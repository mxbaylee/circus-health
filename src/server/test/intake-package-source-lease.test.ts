import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, renameSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPackageSourceLeaseOwner,
  packageSourceLeaseOriginalPhysical,
} from '../intake-package-source-lease.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';

test('cold verification yields after bounded work and profile close revokes it before consumption', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-package-cold-close-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(3 * 1024 * 1024, 'fictional');
  const path = join(root, 'source.zip');
  writeFileSync(path, bytes);
  const owner = createPackageSourceLeaseOwner({
    profileId: 'fictional',
    root,
    assertAuthorized() {},
  });
  let consumed = false;
  const closed = new Promise<void>((resolve) =>
    setImmediate(() => {
      owner.close();
      resolve();
    }),
  );
  await assert.rejects(
    owner.withSource(
      {
        profileId: 'fictional',
        intakeId: 'original',
        path,
        bytes: bytes.length,
        sourceHash: createHash('sha256').update(bytes).digest('hex'),
      },
      async () => {
        consumed = true;
      },
    ),
    { code: 'PROFILE_LOCKED' },
  );
  await closed;
  assert.equal(consumed, false);
  assert.equal(owner.work.verificationYields, 1);
  assert.equal(owner.work.coldReadBytes, 1024 * 1024);
  assert.equal(owner.work.coldHashBytes, owner.work.coldReadBytes);
});

test('source verification is cold once per identity, bounded, and revoked by mutation/replacement/close', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-package-lease-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(700000, 'fictional');
  const path = join(root, 'source.zip');
  writeFileSync(path, bytes);
  const source = {
    profileId: 'fictional',
    intakeId: 'original',
    path,
    bytes: bytes.length,
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
  };
  const owner = createPackageSourceLeaseOwner({
    profileId: source.profileId,
    root,
    assertAuthorized() {},
    cacheEntries: 1,
  });
  const diagnostics = createIntakeFileWorkCounters();
  await withIntakeFileWork(diagnostics, () =>
    owner.withSource(source, async (lease) => {
      lease.assertCurrent();
      assert.equal(lease.verificationWork.coldHashBytes, bytes.length);
      assert.equal(lease.verificationWork.coldReadBytes, bytes.length);
    }),
  );
  assert.equal(diagnostics.streamReadBytes, bytes.length);
  assert.equal(diagnostics.streamHashBytes, bytes.length);
  assert.equal(diagnostics.bufferHashBytes, 0);
  assert.equal(owner.work.coldHashBytes, bytes.length);
  assert.equal(owner.work.peakVerificationBufferBytes, 256 * 1024);
  await owner.withSource(source, async (lease) => {
    lease.assertCurrent();
  });
  assert.equal(owner.work.coldHashBytes, bytes.length);
  const replacement = join(root, 'replacement');
  writeFileSync(replacement, bytes);
  renameSync(replacement, path);
  await owner.withSource(source, async () => {});
  assert.equal(owner.work.coldHashBytes, 2 * bytes.length);
  await assert.rejects(
    owner.withSource(source, async (lease) => {
      writeFileSync(path, Buffer.alloc(bytes.length, 'changed'));
      lease.assertCurrent();
    }),
    { code: 'SOURCE_CHANGED' },
  );
  await assert.rejects(
    owner.withSource(source, async () => {}),
    { code: 'SOURCE_CHANGED' },
  );
  writeFileSync(path, bytes);
  await owner.withSource(source, async () => {});
  owner.invalidate();
  const count = owner.work.coldHashBytes;
  await owner.withSource(source, async () => {});
  assert.equal(owner.work.coldHashBytes - count, bytes.length);
  await assert.rejects(
    owner.withSource(source, async (lease) => {
      owner.close();
      lease.assertCurrent();
    }),
    { code: 'PROFILE_LOCKED' },
  );
  await assert.rejects(
    owner.withSource(source, async () => {}),
    { code: 'PROFILE_LOCKED' },
  );
});

test('publication liveness keeps the original file and owner pinned across an own authority transition', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-package-publication-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('fictional retained original');
  const path = join(root, 'source.zip');
  writeFileSync(path, bytes);
  let transitioning = false;
  const owner = createPackageSourceLeaseOwner({
    profileId: 'fictional',
    root,
    assertAuthorized() {
      if (transitioning) throw Error('Own accepted HEAD is not installed yet');
    },
    assertPublicationAuthorized() {},
  });
  const source = {
    profileId: 'fictional',
    intakeId: 'original',
    path,
    bytes: bytes.length,
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
  };
  await assert.rejects(
    owner.withSource(source, async (lease) => {
      transitioning = true;
      assert.throws(() => lease.assertCurrent(), /accepted HEAD/);
      lease.assertPublicationCurrent();
      const replacement = join(root, 'replacement');
      writeFileSync(replacement, bytes);
      renameSync(replacement, path);
      assert.throws(() => lease.assertPublicationCurrent(), { code: 'SOURCE_CHANGED' });
      transitioning = false;
      assert.throws(() => lease.assertCurrent(), { code: 'SOURCE_CHANGED' });
    }),
    { code: 'SOURCE_CHANGED' },
  );
  owner.close();
});

test('publication liveness retains a direct caller cancellation guard by default', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-package-cancellation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('fictional retained original');
  const path = join(root, 'source.zip');
  writeFileSync(path, bytes);
  const owner = createPackageSourceLeaseOwner({
    profileId: 'fictional',
    root,
    assertAuthorized() {},
  });
  let cancelled = false;
  await assert.rejects(
    owner.withSource(
      {
        profileId: 'fictional',
        intakeId: 'original',
        path,
        bytes: bytes.length,
        sourceHash: createHash('sha256').update(bytes).digest('hex'),
      },
      async (lease) => {
        lease.assertPublicationCurrent();
        cancelled = true;
        lease.assertPublicationCurrent();
      },
      () => {
        if (cancelled) throw Error('Fictional request cancelled');
      },
    ),
    /request cancelled/,
  );
  owner.close();
});

test('source lease pins an in-root alias parent and refuses its same-target replacement', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-package-parent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const physical = join(root, 'physical');
  mkdirSync(physical);
  const alias = join(root, 'alias');
  symlinkSync(physical, alias);
  const bytes = Buffer.from('fictional retained source');
  writeFileSync(join(physical, 'source.zip'), bytes);
  const owner = createPackageSourceLeaseOwner({
    profileId: 'fictional',
    root,
    assertAuthorized() {},
  });
  let consumed = false;
  await assert.rejects(
    owner.withSource(
      {
        profileId: 'fictional',
        intakeId: 'original',
        path: join(alias, 'source.zip'),
        bytes: bytes.length,
        sourceHash: createHash('sha256').update(bytes).digest('hex'),
      },
      async (lease) => {
        consumed = true;
        const original = packageSourceLeaseOriginalPhysical(lease.assertPublicationCurrent);
        assert.equal(original?.parentKind, 'symlink');
        assert.equal(original?.parentRealpath, physical);
        const replacement = join(root, 'replacement-alias');
        symlinkSync(physical, replacement);
        renameSync(replacement, alias);
        assert.throws(() => lease.assertPublicationCurrent(), { code: 'SOURCE_CHANGED' });
      },
    ),
    { code: 'SOURCE_CHANGED' },
  );
  assert.equal(consumed, true);
  owner.close();
});
