import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { openDatabase, transaction, type Database } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  openContributorRecordStorage,
  contributorAuthorityPath,
} from '../contributor-record-storage.ts';
import {
  attachRecordDurability,
  recordDurabilityStatus,
  type RecordStorage,
} from '../record-versions.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { freshKey } from '../vault-crypto.ts';
import { openVault } from '../vault-store.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { fictionalModel } from './fictional-model.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, createIntakePlan, workflowMutation } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareRetainedPlanAccess } from '../intake-retained-plan.ts';
import {
  openCollectionConversion,
  createCollectionCheckpoint,
  recordCollectionConversionRead,
  collectionConversionResumeContext,
  assertCollectionConversionCoverage,
} from '../intake-continuation-collection.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeEnvelopeAuthorityBinding } from '../intake-authority.ts';
import { captureRecordHeadPhysical, recordHeadStatIdentity } from '../record-head-physical.ts';

function physicalFixture(t: TestContext) {
  const root = fs.realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-physical-head-'))),
    above = join(root, 'above'),
    profile = join(above, 'profile'),
    base = join(profile, 'records'),
    files = [join(base, 'head'), join(profile, 'marker')],
    directories = [base, profile];
  fs.mkdirSync(base, { recursive: true });
  for (const file of files) writeFileSync(file, 'Fictional selected HEAD');
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(root + '.moved', { recursive: true, force: true });
  });
  return { root, above, profile, base, files, directories };
}

test('physical HEAD checks share ancestors in two complete counted sweeps', async (t) => {
  const f = physicalFixture(t),
    lstat = fs.lstatSync,
    fstat = fs.fstatSync,
    realpath = fs.realpathSync.native,
    paths = new Map<string, number>();
  let realpaths = 0,
    fstats = 0;
  Reflect.set(
    fs,
    'lstatSync',
    new Proxy(lstat, {
      apply(target, receiver, args) {
        const path = String(args[0]);
        paths.set(path, (paths.get(path) ?? 0) + 1);
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
  fs.fstatSync = new Proxy(fstat, {
    apply(target, receiver, args) {
      fstats++;
      return Reflect.apply(target, receiver, args);
    },
  });
  fs.realpathSync.native = new Proxy(realpath, {
    apply(target, receiver, args) {
      realpaths++;
      return Reflect.apply(target, receiver, args);
    },
  });
  syncBuiltinESMExports();
  let proof: ReturnType<typeof captureRecordHeadPhysical> | undefined;
  try {
    // A separate module captures the instrumented native resolver at admission.
    const module = '../record-head-physical.ts?fictional-counted-ancestors';
    const physical = (await import(module)) as typeof import('../record-head-physical.ts');
    proof = physical.captureRecordHeadPhysical(f.files, f.directories);
    assert.equal(realpaths, f.files.length + f.directories.length);
    realpaths = fstats = 0;
    paths.clear();
    assert.equal(proof.current(), true);
    const expected = new Map(f.files.map((path) => [path, 1]));
    for (let path of f.directories) {
      for (;;) {
        expected.set(path, 2);
        const parent = dirname(path);
        if (parent === path) break;
        path = parent;
      }
    }
    assert.deepEqual(paths, expected, 'each shared ancestor, including root, is checked twice');
    assert.equal(fstats, f.files.length);
    assert.equal(realpaths, 0, 'hot checks use the original canonical ancestor selection');
    writeFileSync(join(f.base, 'unrelated-sibling'), 'Fictional sibling');
    assert.equal(proof.current(), true, 'sibling membership is not this proof contract');
    proof.close();
    assert.equal(proof.current(), false);
  } finally {
    proof?.close();
    Reflect.set(fs, 'lstatSync', lstat);
    fs.fstatSync = fstat;
    fs.realpathSync.native = realpath;
    syncBuiltinESMExports();
  }
});

test('retained HEAD reads exact bytes and refuses a short positioned read', async (t) => {
  const f = physicalFixture(t),
    bytes = readFileSync(f.files[0]!),
    read = fs.readSync;
  let reads = 0;
  fs.readSync = new Proxy(read, {
    apply(target, receiver, args) {
      reads++;
      return Reflect.apply(target, receiver, args);
    },
  });
  syncBuiltinESMExports();
  let proof: ReturnType<typeof captureRecordHeadPhysical> | undefined;
  try {
    const module = '../record-head-physical.ts?fictional-retained-read';
    const physical = (await import(module)) as typeof import('../record-head-physical.ts');
    proof = physical.captureRecordHeadPhysical(f.files, f.directories);
    reads = 0;
    assert.deepEqual(proof.read(f.files[0]!), bytes);
    assert.deepEqual(proof.read(f.files[0]!), bytes, 'each call starts at position zero');
    assert.equal(reads, 2);
    assert.throws(() => proof!.read(join(f.base, 'other')), /changed before retained read/);
    fs.readSync = new Proxy(read, {
      apply() {
        return 0;
      },
    });
    syncBuiltinESMExports();
    assert.throws(() => proof!.read(f.files[0]!), /retained read truncated/);
    let replaced = false;
    fs.readSync = new Proxy(read, {
      apply(target, receiver, args) {
        const count = Reflect.apply(target, receiver, args);
        if (!replaced) {
          replaced = true;
          fs.renameSync(f.files[0]!, f.files[0]! + '.old');
          writeFileSync(f.files[0]!, bytes);
        }
        return count;
      },
    });
    syncBuiltinESMExports();
    assert.throws(() => proof!.read(f.files[0]!), /changed after retained read/);
    assert.equal(replaced, true);
  } finally {
    proof?.close();
    fs.readSync = read;
    syncBuiltinESMExports();
  }
});

test('stat HEAD identity resolves nested directories once and unrelated roots separately', async (t) => {
  const f = physicalFixture(t),
    unrelated = join(f.root, 'unrelated'),
    lstat = fs.lstatSync,
    realpath = fs.realpathSync.native,
    stats = new Map<string, number>(),
    resolved: string[] = [];
  fs.mkdirSync(unrelated);
  Reflect.set(
    fs,
    'lstatSync',
    new Proxy(lstat, {
      apply(target, receiver, args) {
        const path = String(args[0]);
        stats.set(path, (stats.get(path) ?? 0) + 1);
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
  fs.realpathSync.native = new Proxy(realpath, {
    apply(target, receiver, args) {
      resolved.push(String(args[0]));
      return Reflect.apply(target, receiver, args);
    },
  });
  syncBuiltinESMExports();
  try {
    const module = '../record-head-physical.ts?fictional-stat-path-counts';
    const physical = (await import(module)) as typeof import('../record-head-physical.ts');
    assert.ok(physical.recordHeadStatIdentity(f.files[0]!, [f.profile, f.base]));
    assert.deepEqual(
      stats,
      new Map([
        [f.profile, 1],
        [f.base, 1],
        [f.files[0]!, 1],
      ]),
    );
    assert.deepEqual(resolved, [f.base]);
    stats.clear();
    resolved.length = 0;
    assert.ok(physical.recordHeadStatIdentity(f.files[0]!, [f.base, unrelated, f.profile]));
    assert.deepEqual(
      stats,
      new Map([
        [f.base, 1],
        [unrelated, 1],
        [f.profile, 1],
        [f.files[0]!, 1],
      ]),
    );
    assert.deepEqual(resolved, [f.base, unrelated]);
    assert.equal(physical.recordHeadStatIdentity(f.files[0]!, [f.root + '/alias/..']), null);
  } finally {
    Reflect.set(fs, 'lstatSync', lstat);
    fs.realpathSync.native = realpath;
    syncBuiltinESMExports();
  }
});

test('stat HEAD identity keeps rewrite, parent, and ancestor symlink refusals', (t) => {
  const f = physicalFixture(t),
    head = f.files[0]!,
    directories = [f.profile, f.base],
    first = recordHeadStatIdentity(head, directories);
  assert.ok(first);
  fs.renameSync(head, head + '.old');
  writeFileSync(head, readFileSync(head + '.old'));
  assert.notEqual(recordHeadStatIdentity(head, directories)?.key, first.key);
  const beforeParent = recordHeadStatIdentity(head, directories);
  fs.renameSync(f.profile, f.profile + '.old');
  fs.mkdirSync(f.profile);
  fs.renameSync(join(f.profile + '.old', 'records'), f.base);
  assert.notEqual(recordHeadStatIdentity(head, directories)?.key, beforeParent?.key);
  fs.renameSync(f.above, f.above + '.moved');
  fs.symlinkSync(f.above + '.moved', f.above, 'dir');
  assert.equal(recordHeadStatIdentity(head, directories), null);
});

test('physical HEAD refuses ancestor substitutions above and within explicit parents', (t) => {
  for (const location of ['root', 'above', 'profile', 'base'] as const) {
    const f = physicalFixture(t),
      proof = captureRecordHeadPhysical(f.files, f.directories),
      path = f[location];
    try {
      fs.renameSync(path, path + '.moved');
      fs.symlinkSync(path + '.moved', path, 'dir');
      assert.equal(proof.current(), false, `${location}: same endpoint inode through symlink`);
    } finally {
      proof.close();
    }
  }
});

test('physical HEAD closing sweep refuses an ancestor swap during endpoint observation', (t) => {
  const f = physicalFixture(t),
    proof = captureRecordHeadPhysical(f.files, f.directories),
    fstat = fs.fstatSync;
  let changed = false;
  fs.fstatSync = new Proxy(fstat, {
    apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      if (!changed) {
        changed = true;
        fs.renameSync(f.above, f.above + '.moved');
        fs.symlinkSync(f.above + '.moved', f.above, 'dir');
      }
      return result;
    },
  });
  syncBuiltinESMExports();
  try {
    assert.equal(proof.current(), false);
    assert.equal(changed, true);
  } finally {
    fs.fstatSync = fstat;
    syncBuiltinESMExports();
    proof.close();
  }
});

test('physical HEAD preserves endpoint and ancestor identity refusals', (t) => {
  for (const change of [
    'rewrite',
    'replace',
    'link',
    'symlink',
    'missing',
    'mode',
    'parent',
  ] as const) {
    const f = physicalFixture(t),
      proof = captureRecordHeadPhysical(f.files, f.directories),
      file = f.files[0]!;
    try {
      if (change === 'rewrite') writeFileSync(file, readFileSync(file));
      if (change === 'replace') {
        fs.renameSync(file, file + '.old');
        writeFileSync(file, readFileSync(file + '.old'));
      }
      if (change === 'link') fs.linkSync(file, file + '.link');
      if (change === 'symlink') {
        fs.renameSync(file, file + '.old');
        fs.symlinkSync(file + '.old', file);
      }
      if (change === 'missing') fs.unlinkSync(file);
      if (change === 'mode') fs.chmodSync(f.above, (fs.lstatSync(f.above).mode & 0o7777) ^ 0o010);
      if (change === 'parent') {
        fs.renameSync(f.above, f.above + '.old');
        fs.mkdirSync(f.above);
        fs.renameSync(join(f.above + '.old', 'profile'), f.profile);
      }
      assert.equal(proof.current(), false, change);
    } finally {
      proof.close();
    }
  }
});

test('physical HEAD capture seals every endpoint and closes descriptors on refusal', (t) => {
  const f = physicalFixture(t),
    open = fs.openSync,
    fstat = fs.fstatSync,
    descriptors: number[] = [];
  let changed = false;
  fs.openSync = new Proxy(open, {
    apply(target, receiver, args) {
      const fd = Reflect.apply(target, receiver, args) as number;
      if (f.files.includes(String(args[0])) && typeof args[1] === 'number') descriptors.push(fd);
      return fd;
    },
  });
  fs.fstatSync = new Proxy(fstat, {
    apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      if (descriptors.length === 2 && !changed) {
        changed = true;
        writeFileSync(f.files[0]!, 'Changed fictional HEAD');
      }
      return result;
    },
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => captureRecordHeadPhysical(f.files, f.directories),
      /changed during capture/,
    );
    assert.equal(changed, true);
    assert.equal(descriptors.length, 2);
    for (const fd of descriptors) assert.throws(() => fstat(fd), { code: 'EBADF' });
  } finally {
    fs.openSync = open;
    fs.fstatSync = fstat;
    syncBuiltinESMExports();
  }
  assert.throws(() => captureRecordHeadPhysical(['relative-head'], []), /not canonical/);
  fs.symlinkSync(f.base, join(f.root, 'alias'), 'dir');
  assert.throws(
    () => captureRecordHeadPhysical([join(f.root, 'alias', 'head')], []),
    /not physical/,
  );
});

// Fixed future wall clock: every fictional HEAD stamp is settled, so counts do
// not depend on scheduling. Racy (unsettled) admission is covered separately.
const settledClock = (t: TestContext) =>
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3_600_000 });

function contributor(t: TestContext, profileId = 'fictional') {
  const root = mkdtempSync(join(tmpdir(), 'fictional-head-status-cache-')),
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    storage = openContributorRecordStorage(root, profileId, { initialize: true });
  attachRecordDurability(db, { profileId, storage });
  const opened: Database[] = [db];
  t.after(() => {
    for (const connection of opened) if (connection.isOpen) connection.close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    profileId,
    db,
    storage,
    opened,
    database: paths.database,
    head: join(contributorAuthorityPath(root, profileId), 'head'),
  };
}
function accept(db: Database, id: string) {
  transaction(db, () => {
    db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)').run(id, 'Fictional ' + id);
  });
}
function counted<T>(run: () => T) {
  const work = createRecordVersionWorkCounters();
  const value = withRecordVersionWork(work, run);
  return {
    value,
    reads: work.operation.headReadCalls,
    hits: work.operation.headCacheHits,
    checks: work.operation.headIdentityChecks,
  };
}
const statusTimes = (db: Database, n: number) =>
  counted(() => {
    const results = [];
    for (let i = 0; i < n; i++) results.push(recordDurabilityStatus(db));
    return results;
  });
async function settle(storage: RecordStorage) {
  // Waits on the hook's own settlement observation; outcomes stay counted.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (storage.headIdentity?.()?.settled) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.fail('fictional HEAD never settled');
}

test('settled unchanged contributor HEAD is read once across repeated status calls', (t) => {
  settledClock(t);
  const f = contributor(t);
  accept(f.db, 'first');
  const expected = recordDurabilityStatus(f.db);
  assert.equal(expected?.dirty, false);
  const run = statusTimes(f.db, 25);
  for (const status of run.value) assert.deepEqual(status, expected);
  // Before the stat-identity hook: 25 real reads.
  assert.equal(run.reads, 0, 'previous status call admitted the settled identity');
  assert.equal(run.hits, 25);
  assert.equal(run.checks, 25);
});

test('unsettled contributor HEAD identity is never admitted', (t) => {
  const f = contributor(t);
  accept(f.db, 'first');
  const changed = lstatSync(f.head, { bigint: true }).ctimeNs / 1_000_000n;
  // The wall clock equals the HEAD stamp: a same-tick rewrite could keep it.
  t.mock.timers.enable({ apis: ['Date'], now: Number(changed) });
  const run = statusTimes(f.db, 25);
  assert.equal(run.reads, 25);
  assert.equal(run.hits, 0);
});

test('in-place contributor HEAD rewrites after admission are read and detected', async (t) => {
  const f = contributor(t);
  accept(f.db, 'first');
  await settle(f.storage);
  const expected = recordDurabilityStatus(f.db);
  assert.equal(statusTimes(f.db, 3).reads, 0, 'settled identity admitted');
  const bytes = readFileSync(f.head);
  writeFileSync(f.head, bytes);
  const sameByte = statusTimes(f.db, 1);
  assert.equal(sameByte.reads, 1, 'same-byte rewrite changes ctime and forces a real read');
  assert.deepEqual(sameByte.value[0], expected);
  await settle(f.storage);
  assert.equal(statusTimes(f.db, 2).reads, 1, 'readmitted only after a real read');
  const ref = JSON.parse(bytes.toString('utf8')) as { sha256: string };
  const forged = Buffer.from(
    bytes
      .toString('utf8')
      .replace(ref.sha256, (ref.sha256[0] === 'a' ? 'b' : 'a') + ref.sha256.slice(1)),
  );
  assert.equal(forged.length, bytes.length);
  writeFileSync(f.head, forged);
  const changed = statusTimes(f.db, 1);
  assert.equal(changed.reads, 1);
  assert.equal(changed.value[0]?.conflicted, true, 'same-size foreign HEAD is not hidden');
  writeFileSync(f.head, bytes);
  assert.equal(recordDurabilityStatus(f.db)?.conflicted, false);
});

test('own contributor publication changes identity and drops entries of every configuration', (t) => {
  settledClock(t);
  const f = contributor(t);
  accept(f.db, 'first');
  const other = new DatabaseSync(f.database) as Database;
  f.opened.push(other);
  attachRecordDurability(other, { profileId: f.profileId, storage: f.storage });
  assert.equal(recordDurabilityStatus(other)?.dirty, false);
  const before = recordDurabilityStatus(f.db)!;
  assert.equal(statusTimes(f.db, 2).reads, 0);
  assert.equal(statusTimes(other, 2).reads, 0);
  accept(f.db, 'second');
  const own = statusTimes(f.db, 1);
  assert.equal(own.reads, 1);
  assert.equal(own.value[0]?.dirty, false);
  assert.equal(own.value[0]?.sequence, before.sequence + 1);
  const shared = statusTimes(other, 1);
  assert.equal(shared.reads, 1, 'a shared storage publication is never served from cache');
  assert.equal(shared.value[0]?.dirty, false);
  assert.equal(shared.value[0]?.sequence, before.sequence + 1);
});

test('stat identity is withheld from copied, wrapped, closed and in-memory storages', (t) => {
  settledClock(t);
  const f = contributor(t);
  accept(f.db, 'first');
  assert.ok(f.storage.headIdentity?.());
  const copy = { ...f.storage };
  assert.equal(copy.headIdentity?.(), null);
  const attached = new DatabaseSync(f.database) as Database;
  f.opened.push(attached);
  attachRecordDurability(attached, { profileId: f.profileId, storage: copy });
  assert.equal(statusTimes(attached, 5).reads, 5, 'a copied adapter object always reads');
  const original = f.storage.read;
  f.storage.read = function (name) {
    return Reflect.apply(original, this, [name]);
  };
  try {
    assert.equal(f.storage.headIdentity?.(), null, 'replaced method revokes identity');
    assert.equal(statusTimes(f.db, 5).reads, 5);
  } finally {
    f.storage.read = original;
  }
  const memoryDb = openDatabase(join(f.root, 'fictional-memory.sqlite'), f.profileId);
  f.opened.push(memoryDb);
  const memory = memoryRecordAuthority(memoryDb);
  assert.equal('headIdentity' in memory.storage, false);
  const second = contributor(t, 'fictional-other');
  accept(second.db, 'other');
  assert.notEqual(f.storage.headIdentity?.()?.key, second.storage.headIdentity?.()?.key);
  second.storage.close();
  assert.equal(second.storage.headIdentity?.(), null);
});

test('vault HEAD identity is its unlocked manifest value', (t) => {
  settledClock(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-head-status-vault-')),
    profileId = 'fictional',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    key = freshKey(),
    vault = openVault({ directory: paths.root, profileId, key, initialize: true }),
    storage = vault.recordStorage();
  attachRecordDurability(db, { profileId, storage });
  t.after(() => {
    if (db.isOpen) db.close();
    try {
      vault.close();
    } catch {
      /* already closed by the test */
    }
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  });
  accept(db, 'first');
  const first = storage.headIdentity?.();
  assert.equal(first?.settled, true);
  recordDurabilityStatus(db);
  const run = statusTimes(db, 25);
  assert.equal(run.reads, 0);
  assert.equal(run.hits, 25);
  accept(db, 'second');
  assert.notEqual(storage.headIdentity?.()?.key, first?.key);
  const after = statusTimes(db, 1);
  assert.equal(after.reads, 1);
  assert.equal(after.value[0]?.dirty, false);
  assert.equal(({ ...storage } as RecordStorage).headIdentity?.(), null);
  vault.close();
  assert.equal(storage.headIdentity?.(), null);
});

test('selected-pages run reuses settled HEAD reads in status and envelope binding checks', async (t) => {
  settledClock(t);
  fictionalModel(t);
  const work = createRecordVersionWorkCounters();
  const root = mkdtempSync(join(tmpdir(), 'fictional-head-selected-pages-')),
    profileId = 'fictional';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  let sourceId = '';
  await withRecordVersionWork(work, async () => {
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional.txt',
      bytes: Buffer.from('Fictional retained source.'),
    });
    sourceId = source.id;
    const planned = await createIntakePlan(db, root, profileId, source.id, {
      version: source.version,
    });
    const planId = planned.workflow!.plans[0]!.id;
    workflowMutation(
      db,
      root,
      profileId,
      source.id,
      { version: planned.version, operationId: 'fictional-page-scope' },
      (workflow) => {
        workflow.plans[0]!.units = [
          {
            id: 'page-unit',
            kind: 'pdf',
            locator: 'Fictional selected pages',
            pages: [3, 7, 3],
            status: 'pending',
            attempts: [],
          },
        ];
      },
    );
    await buildIntakeCollectionEnvelope(db, { id: source.id });
    await prepareRetainedPlanAccess(db, profileId, source.id);
    const scope = openCollectionConversion(db, root, profileId, source.id, {
      sessionId: 'retained',
    })!;
    const checkpoint = createCollectionCheckpoint(scope),
      options = { mappingVersion: planned.workflow!.plans[0]!.pins.mappingVersion };
    for (const page of [3, 7])
      await recordCollectionConversionRead(
        scope,
        checkpoint,
        'health_intake_read',
        { id: source.id, page },
        {
          original: {
            kind: 'pdf',
            page,
            pages: 20,
            text: 'Fictional page',
            offset: 0,
            nextOffset: null,
            nextPage: page + 1,
            assets: [],
          },
        },
      );
    const resume = collectionConversionResumeContext(scope, checkpoint, options);
    assert.equal(resume.pendingWindows.total, 0);
    assertCollectionConversionCoverage([scope], {
      planId,
      coverage: [{ unitId: scope.unitId, kind: 'extracted', notes: 'Fictional' }],
    });
  });
  const run = work.operation;
  t.diagnostic(
    JSON.stringify({
      headReadCalls: run.headReadCalls,
      headCacheHits: run.headCacheHits,
      headIdentityChecks: run.headIdentityChecks,
    }),
  );
  // Before the hook this flow made 2,707 real HEAD reads (now 333 + 2,374 reuses).
  assert.ok(run.headReadCalls <= 400, `real HEAD reads ${run.headReadCalls}`);
  assert.ok(run.headCacheHits >= 2_000, `cached HEAD reuses ${run.headCacheHits}`);
  const row = db.prepare('SELECT * FROM source_files WHERE id=?').get(sourceId) as never;
  const binding = counted(() => {
    const keys = [];
    for (let i = 0; i < 25; i++) keys.push(intakeEnvelopeAuthorityBinding(db, row).head);
    return keys;
  });
  assert.ok(binding.value.every((head) => head === binding.value[0] && head));
  assert.equal(binding.reads, 0, 'binding checks reuse the settled status HEAD');
  assert.equal(binding.hits, 25);
});
