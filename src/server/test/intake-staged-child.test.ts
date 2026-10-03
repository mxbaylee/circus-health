import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  fstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError, openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability, rebuildProfile } from '../portable.ts';
import { createBackup } from '../recovery.ts';
import {
  getIntake,
  isUnpublishedIntakeChildError,
  intakeDurability,
  uploadIntake,
  verifyIntakeOriginal,
  withStagedIntakeChild,
  withVerifiedIntakeOriginalDescriptor,
} from '../intake.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
import { recordPublicationFixture } from './helpers/accepted-record-fixture.ts';
import type { RecordStorage } from '../record-versions.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture(t: TestContext, recordStorage?: RecordStorage) {
  const root = mkdtempSync(join(tmpdir(), 'health-staged-child-')),
    profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId, ...(recordStorage ? { recordStorage } : {}) });
  t.after(() => {
    try {
      db.close();
    } catch {
      /* Lifecycle tests explicitly close the owner. */
    }
    rmSync(root, { recursive: true, force: true });
  });
  const parent = uploadIntake(db, root, profileId, {
    filename: 'fictional.zip',
    newProviderName: 'Fictional collection',
    bytes: Buffer.from('PK fictional retained package'),
  });
  return { db, root, profileId, parentId: parent.id };
}
function member(bytes: Buffer, locator = 'zip:fictional.pdf') {
  return { filename: 'fictional.pdf', locator, bytes: bytes.length, sourceHash: hash(bytes) };
}
function assertNoChild(f: ReturnType<typeof fixture>) {
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_files').get()!.n, 1);
  const directory = join(f.root, '.intake-child-staging');
  assert.deepEqual(readdirSync(directory), []);
}

test('streamed child above 25 MiB uses bounded verification, exact occurrence identity and no retry publication', async (t) => {
  const f = fixture(t),
    chunk = Buffer.alloc(256 * 1024, 70);
  chunk.write('%PDF-1.4\n');
  const count = 104,
    expected = createHash('sha256');
  for (let i = 0; i < count; i++) expected.update(chunk);
  const input = {
    filename: 'fictional.pdf',
    locator: 'zip:large/fictional.pdf',
    bytes: count * chunk.length,
    sourceHash: expected.digest('hex'),
  };
  const counters = createIntakeFileWorkCounters();
  let inheritedSource = -1,
    inheritedOutput = -1,
    inode = 0;
  const retained = await withIntakeFileWork(counters, () =>
    withStagedIntakeChild(f, input, async ({ sourceFd, outputFd }) => {
      inheritedSource = sourceFd;
      inheritedOutput = outputFd;
      const prefix = Buffer.alloc(2);
      assert.equal(readSync(sourceFd, prefix, 0, 2, 0), 2);
      assert.equal(prefix.toString(), 'PK');
      assert.equal(fstatSync(outputFd).mode & 0o777, 0o600);
      assert.equal(statSync(join(f.root, '.intake-child-staging')).mode & 0o777, 0o700);
      inode = fstatSync(outputFd).ino;
      for (let i = 0; i < count; i++) writeSync(outputFd, chunk);
    }),
  );
  assert.throws(() => fstatSync(inheritedSource), { code: 'EBADF' });
  assert.throws(() => fstatSync(inheritedOutput), { code: 'EBADF' });
  assert.equal(retained.bytes, input.bytes);
  assert.equal(retained.mimeType, 'application/pdf');
  const view = getIntake(f.db, f.root, f.profileId, retained.id);
  assert.equal(view.sha256, input.sourceHash);
  assert.equal(view.state, 'pending_conversion');
  assert.match(view.validation.issues[0]!.message, /Binary original retained/);
  assert.equal(counters.readBytes, 0, 'no whole original read');
  assert.equal(counters.copyRequestedBytes, 0, 'same-device stage adopted');
  assert.equal(counters.bufferHashBytes, 0, 'no whole member hash');
  assert.ok(counters.streamHashBytes >= 2 * input.bytes);
  assert.ok(counters.streamHashBytes < 2 * input.bytes + 1024);
  assert.equal(
    statSync(verifyIntakeOriginal(f.db, f.root, f.profileId, retained.id).path).ino,
    inode,
  );
  assert.deepEqual(readdirSync(join(f.root, '.intake-child-staging')), []);
  const before = intakeDurability(f.db),
    retryWork = createIntakeFileWorkCounters();
  const retry = await withIntakeFileWork(retryWork, () =>
    withStagedIntakeChild(f, input, async () =>
      assert.fail('retry must reuse verified occurrence'),
    ),
  );
  assert.deepEqual(retry, retained);
  assert.deepEqual(intakeDurability(f.db), before);
  assert.equal(retryWork.publications, 0);
  assert.equal(retryWork.writes, 0);
});

test('same bytes at distinct locators survive durable rebuild as distinct children', async (t) => {
  const f = fixture(t),
    bytes = Buffer.from('%PDF-1.4\nFictional retained child');
  const one = await withStagedIntakeChild(f, member(bytes), async ({ outputFd }) => {
    writeSync(outputFd, bytes);
  });
  const twoInput = { ...member(bytes, 'zip:other/copy.pdf'), filename: 'copy.pdf' };
  const two = await withStagedIntakeChild(f, twoInput, async ({ outputFd }) => {
    writeSync(outputFd, bytes);
  });
  assert.notEqual(one.id, two.id);
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'rebuilt');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(db, { root: target, profileId: f.profileId });
  try {
    const retry = await withStagedIntakeChild({ ...f, db, root: target }, twoInput, async () =>
      assert.fail('rebuilt occurrence already retained'),
    );
    assert.deepEqual(retry, two);
    for (const child of [one, two]) {
      assert.equal(getIntake(db, target, f.profileId, child.id).parentSourceFileId, f.parentId);
      assert.deepEqual(
        readFileSync(verifyIntakeOriginal(db, target, f.profileId, child.id).path),
        bytes,
      );
    }
  } finally {
    db.close();
  }
});

for (const mode of [
  'hash',
  'partial',
  'cancel',
  'replacement',
  'stage-link',
  'disk-full',
  'io',
] as const) {
  test(`private stage rejects ${mode} before publication and cleans only its owned stage`, async (t) => {
    const f = fixture(t),
      bytes = Buffer.from('%PDF-1.4\nFictional retained child');
    let cancelled = false;
    await assert.rejects(
      withStagedIntakeChild(
        {
          ...f,
          assertRunning: () => {
            if (cancelled) throw new HttpError(409, 'INTAKE_STOPPED', 'Fictional cancellation');
          },
        },
        member(bytes),
        async ({ outputFd }) => {
          writeSync(
            outputFd,
            mode === 'partial'
              ? bytes.subarray(0, 5)
              : mode === 'hash'
                ? Buffer.alloc(bytes.length, 33)
                : bytes,
          );
          if (mode === 'cancel') cancelled = true;
          if (mode === 'replacement') {
            const source = verifyIntakeOriginal(f.db, f.root, f.profileId, f.parentId).path;
            renameSync(source, source + '.old');
            writeFileSync(source, readFileSync(source + '.old'));
          }
          if (mode === 'stage-link') {
            const stageRoot = join(f.root, '.intake-child-staging');
            const stage = join(stageRoot, readdirSync(stageRoot)[0]!, 'original');
            rmSync(stage);
            symlinkSync(verifyIntakeOriginal(f.db, f.root, f.profileId, f.parentId).path, stage);
          }
          if (mode === 'disk-full' || mode === 'io')
            throw Object.assign(new Error('fictional storage failure'), {
              code: mode === 'disk-full' ? 'ENOSPC' : 'EIO',
            });
        },
      ),
      (error: unknown) =>
        error instanceof HttpError &&
        isUnpublishedIntakeChildError(error) &&
        (mode === 'disk-full'
          ? error.status === 507
          : mode === 'io'
            ? error.status === 503
            : error.status === 409),
    );
    assertNoChild(f);
    assert.ok(verifyIntakeOriginal(f.db, f.root, f.profileId, f.parentId));
  });
}

test('descriptor rejects source symlinks and private staging symlinks', async (t) => {
  const f = fixture(t),
    original = verifyIntakeOriginal(f.db, f.root, f.profileId, f.parentId);
  renameSync(original.path, original.path + '.old');
  symlinkSync(original.path + '.old', original.path);
  await assert.rejects(
    withVerifiedIntakeOriginalDescriptor({ ...f, id: f.parentId }, async () =>
      assert.fail('linked source must not reach consumer'),
    ),
    { code: 'SOURCE_CHANGED' },
  );
  rmSync(original.path);
  renameSync(original.path + '.old', original.path);
  symlinkSync(join(f.root, 'data'), join(f.root, '.intake-child-staging'));
  const bytes = Buffer.from('%PDF-fictional');
  await assert.rejects(
    withStagedIntakeChild(f, member(bytes), async () =>
      assert.fail('linked stage must not reach writer'),
    ),
    { code: 'PROFILE_BOUNDARY' },
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_files').get()!.n, 1);
});

test('durable publication errors keep adopted evidence and never authorize a separate failure mutation', async (t) => {
  const backend = recordPublicationFixture(),
    f = fixture(t, backend.storage);
  const bytes = Buffer.from('%PDF-1.4\nFictional publication uncertainty'),
    input = member(bytes);
  const key = hash(Buffer.from([f.parentId, input.locator, input.sourceHash].join('\0')));
  const provider = f.db.prepare('SELECT provider_id FROM source_files WHERE id=?').get(f.parentId)!
    .provider_id as string;
  const retainedPath = join(
    f.root,
    'data/profiles',
    f.profileId,
    'sources',
    encodeURIComponent(provider),
    'intake',
    key,
    input.filename,
  );
  backend.refusePublication(
    Object.assign(new Error('Fictional archive write failure'), { code: 'EIO' }),
  );
  await assert.rejects(
    withStagedIntakeChild(f, input, async ({ outputFd }) => {
      writeSync(outputFd, bytes);
    }),
    (error: unknown) => {
      assert.equal(isUnpublishedIntakeChildError(error), false);
      return error instanceof HttpError && error.status === 503;
    },
  );
  assert.deepEqual(
    readFileSync(retainedPath),
    bytes,
    'an uncertain durable write must retain the adopted original',
  );
  assert.deepEqual(readdirSync(join(f.root, '.intake-child-staging')), []);
  backend.refusePublication(null);
  const retry = await withStagedIntakeChild(f, input, async ({ outputFd }) => {
    writeSync(outputFd, bytes);
  });
  assert.equal(retry.id, 'intake:' + key);
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_files').get()!.n, 2);
});

test('a corrupted parent cannot authorize a new located failure write', async (t) => {
  const f = fixture(t),
    bytes = Buffer.from('%PDF-fictional');
  const parent = verifyIntakeOriginal(f.db, f.root, f.profileId, f.parentId);
  await assert.rejects(
    withStagedIntakeChild(f, member(bytes), async ({ outputFd }) => {
      writeSync(outputFd, bytes);
      writeFileSync(parent.path, 'corrupted fictional original');
    }),
    (error: unknown) => {
      assert.equal(isUnpublishedIntakeChildError(error), false);
      return error instanceof HttpError && error.code === 'SOURCE_CHANGED';
    },
  );
  assertNoChild(f);
});

test('writer lifecycle assertion detects owner closure while a stage remains open', async (t) => {
  const f = fixture(t),
    bytes = Buffer.from('%PDF-fictional');
  let assertions = 0;
  await assert.rejects(
    withStagedIntakeChild(f, member(bytes), async ({ outputFd, assertRunning }) => {
      assertRunning();
      assertions++;
      writeSync(outputFd, bytes.subarray(0, 5));
      f.db.close();
      assertRunning();
      assert.fail('closed owner must stop the producer before its next chunk');
    }),
    (error: unknown) => {
      assert.equal(isUnpublishedIntakeChildError(error), false);
      return /not open/i.test(String(error));
    },
  );
  assert.equal(assertions, 1);
  assert.deepEqual(readdirSync(join(f.root, '.intake-child-staging')), []);
});
