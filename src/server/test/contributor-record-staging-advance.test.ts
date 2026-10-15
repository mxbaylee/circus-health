import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto, { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import {
  attachRecordDurability,
  assertRecordAcceptedSourcePreimage,
  captureRecordAcceptedSourceRead,
  closeRecordAcceptedSourceRead,
  verifyRecordAcceptedSourceReadTerminal,
} from '../record-versions.ts';
import {
  captureContributorRecordStaging,
  discardContributorRecordStaging,
  prepareContributorRecordTransactionBacking,
} from '../contributor-record-staging.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import {
  captureContributorRecordReadOwner,
  closeContributorRecordReadOwner,
  contributorAuthorityPath,
  contributorAuthorityMarker,
  openContributorRecordStorage,
} from '../contributor-record-storage.ts';
import { recordFieldDigest } from '../record-prior-fields.ts';
import {
  MAX_CERTIFICATE_DELTA_CHUNK_BYTES,
  certificateDeltaMinimumBytes,
  checkedCertificateDeltaChunk,
  signCertificateDeltaChunk,
  type ContributorCertificateDelta,
} from '../contributor-certificate-delta.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { unlockPhysicalEntries, unlockPhysicalIdentity } from '../encrypted-unlock-physical.ts';
import {
  VAULT_CERTIFICATE_SCHEMA,
  vaultRecordCertificates,
  type VaultRecordCertificate,
} from '../vault-record-certificates.ts';
import type { IntakeTreeRoot } from '../intake-state-tree.ts';

type Work = ReturnType<typeof createRecordVersionWorkCounters>;
const counted = (work: Work, metric: keyof Work['operation']) =>
  work.operation[metric] + work.reconstruction[metric];

function traceCertificateInserts(afterFirstInsert?: () => void, failAt?: number) {
  const prepare = DatabaseSync.prototype.prepare,
    exec = DatabaseSync.prototype.exec;
  let active = false,
    attempts = 0,
    inserts = 0,
    outsideTransaction = 0,
    certificateSql: DatabaseSync | undefined,
    beforeRollback: number | undefined,
    afterRollback: number | undefined;
  const pages = (sql: DatabaseSync) =>
    Number(prepare.call(sql, 'SELECT count(*) n FROM certificate_pages').get()!.n);
  DatabaseSync.prototype.exec = function (source: string) {
    if (active && this === certificateSql && source === 'BEGIN') beforeRollback = pages(this);
    const result = exec.call(this, source);
    if (active && this === certificateSql && source === 'ROLLBACK') afterRollback = pages(this);
    return result;
  };
  DatabaseSync.prototype.prepare = function (source: string) {
    const statement = prepare.call(this, source);
    if (source !== 'INSERT OR IGNORE INTO certificate_pages VALUES(?,?)') return statement;
    const sql = this;
    certificateSql = sql;
    return new Proxy(statement, {
      get(target, property) {
        if (property !== 'run') return Reflect.get(target, property, target);
        return (...args: unknown[]) => {
          const inTransaction = sql.isTransaction;
          if (active) {
            attempts++;
            if (attempts === failAt) throw Error('Fictional certificate page insert refused');
          }
          const result = Reflect.apply(target.run, target, args) as { changes: number | bigint };
          if (active) {
            const changes = Number(result.changes);
            inserts += changes;
            if (!inTransaction) outsideTransaction += changes;
            if (changes && inserts === 1) afterFirstInsert?.();
          }
          return result;
        };
      },
    });
  };
  return {
    start: () => {
      active = true;
    },
    stop: () => {
      active = false;
    },
    counts: () => ({ attempts, inserts, outsideTransaction, beforeRollback, afterRollback }),
    database: () => certificateSql,
    restore: () => {
      DatabaseSync.prototype.prepare = prepare;
      DatabaseSync.prototype.exec = exec;
    },
  };
}

function interruptCertificatePageRead(change: (sql: DatabaseSync) => void) {
  const prepare = DatabaseSync.prototype.prepare;
  let active = false,
    changed = false;
  DatabaseSync.prototype.prepare = function (source: string) {
    const statement = prepare.call(this, source);
    if (source !== 'SELECT raw FROM certificate_pages WHERE hash=?') return statement;
    const sql = this;
    return new Proxy(statement, {
      get(target, property) {
        if (property !== 'get') return Reflect.get(target, property, target);
        return (...args: unknown[]) => {
          const result = Reflect.apply(target.get, target, args);
          if (active && !changed) {
            changed = true;
            change(sql);
          }
          return result;
        };
      },
    });
  };
  return {
    start: () => {
      active = true;
    },
    changed: () => changed,
    restore: () => {
      DatabaseSync.prototype.prepare = prepare;
    },
  };
}

function fixture(t: TestContext) {
  const previousTemporary = process.env.TMPDIR;
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-contributor-advance-')));
  const temporary = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'fictional-contributor-advance-scratch-')),
  );
  // Other test processes may stage certificates concurrently in the host temp directory.
  process.env.TMPDIR = temporary;
  const profileId = 'fictional-advance',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    storage = openContributorRecordStorage(root, profileId, { initialize: true });
  attachRecordDurability(db, { profileId, storage });
  t.after(() => {
    try {
      storage.close();
    } finally {
      try {
        db.close();
      } finally {
        if (previousTemporary === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTemporary;
        rmSync(root, { recursive: true, force: true });
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  });
  const original = Buffer.from('Fictional retained-proof original.'),
    path = profilePaths(root, profileId).relativeRoot + '/sources/fictional-advance.pdf',
    id = 'fictional-advance-source';
  writeFileSync(join(root, path), original);
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,mime_type,details_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      id,
      path,
      createHash('sha256').update(original).digest('hex'),
      original.length,
      'intake_original',
      'application/pdf',
      '{}',
    );
  });
  const base = contributorAuthorityPath(root, profileId),
    recordId = JSON.stringify([id]);
  const currentVersion = () => {
    const row = db
      .prepare(
        "SELECT c.version_id,v.contents_json FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity='source_files' AND c.record_id=?",
      )
      .get(recordId)!;
    return {
      versionId: String(row.version_id),
      preimage: recordFieldDigest(String(row.contents_json)),
    };
  };
  let revision = 0;
  const publish = (extraRecords = 0) =>
    transaction(db, () => {
      db.prepare('UPDATE source_files SET mime_type=? WHERE id=?').run(
        `application/fictional-${++revision}`,
        id,
      );
      const insert = db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)');
      for (let index = 0; index < extraRecords; index++)
        insert.run(`fictional-added-${revision}-${index}`, `Fictional Added ${index}`);
    });
  /** One complete accepted proof: capture, certificate point, terminal. */
  const read = async (check = currentVersion()) => {
    const cap = await captureRecordAcceptedSourceRead(db, profileId, () => {});
    try {
      assertRecordAcceptedSourcePreimage(
        db,
        cap,
        profileId,
        recordId,
        check.versionId,
        check.preimage,
      );
      await verifyRecordAcceptedSourceReadTerminal(db, cap, profileId);
    } finally {
      closeRecordAcceptedSourceRead(cap);
    }
  };
  const readOptional = async (check = currentVersion()) => {
    const pair = {
      sourceVersionId: check.versionId,
      identity: {
        profileId,
        intakeId: id,
        sourceHash: createHash('sha256').update(original).digest('hex'),
      },
    };
    const cap = await captureRecordAcceptedSourceRead(db, profileId, () => {}, pair);
    try {
      assertRecordAcceptedSourcePreimage(
        db,
        cap,
        profileId,
        recordId,
        check.versionId,
        check.preimage,
      );
      await verifyRecordAcceptedSourceReadTerminal(db, cap, profileId);
    } finally {
      closeRecordAcceptedSourceRead(cap);
    }
  };
  const sameByteRewrite = (name: string) => {
    const target = join(base, name),
      bytes = readFileSync(target);
    renameSync(target, target + '.fictional-aside');
    writeFileSync(target, bytes);
    rmSync(target + '.fictional-aside');
  };
  const retainedObject = () => 'objects/' + readdirSync(join(base, 'objects')).sort()[0]!;
  return {
    base,
    db,
    storage,
    profileId,
    recordId,
    currentVersion,
    sourcePairRequest: (sourceVersionId = currentVersion().versionId) => ({
      sourceVersionId,
      identity: {
        profileId,
        intakeId: id,
        sourceHash: createHash('sha256').update(original).digest('hex'),
      },
    }),
    publish,
    read,
    readOptional,
    retainedReplay: () => {
      const marker = unlockPhysicalIdentity(contributorAuthorityMarker(root, profileId));
      const scratch = readdirSync(tmpdir()).filter((name) => {
        if (!name.startsWith('circus-contributor-backing-')) return false;
        const physical = join(tmpdir(), name, 'physical.sqlite');
        if (!existsSync(physical)) return false;
        let sql: DatabaseSync | undefined;
        try {
          sql = new DatabaseSync(physical, { readOnly: true });
          const recorded = sql.prepare("SELECT identity FROM physical WHERE path='@marker'").get();
          return (
            recorded?.identity === marker.value &&
            existsSync(join(tmpdir(), name, 'replay', 'accepted.sqlite'))
          );
        } catch {
          return false;
        } finally {
          sql?.close();
        }
      });
      assert.equal(scratch.length, 1);
      return join(tmpdir(), scratch[0]!, 'replay', 'accepted.sqlite');
    },
    sameByteRewrite,
    retainedObject,
  };
}

function privateCertificateDeltaSpool(): string {
  const names = readdirSync(tmpdir()).filter((name) =>
    name.startsWith('circus-contributor-certificate-delta-'),
  );
  assert.equal(names.length, 1);
  return join(tmpdir(), names[0]!, 'chunks');
}

test('contributor retained replay discovery ignores another fixture scratch', async (t) => {
  const f = fixture(t);
  await f.readOptional();
  const unrelated = mkdtempSync(join(tmpdir(), 'circus-contributor-backing-'));
  t.after(() => rmSync(unrelated, { recursive: true, force: true }));
  mkdirSync(join(unrelated, 'replay'));
  const replay = new DatabaseSync(join(unrelated, 'replay', 'accepted.sqlite'));
  replay.close();
  const sql = new DatabaseSync(join(unrelated, 'physical.sqlite'));
  try {
    sql.exec('CREATE TABLE physical(path TEXT PRIMARY KEY, identity TEXT NOT NULL)');
    sql.prepare('INSERT INTO physical VALUES(?,?)').run('@marker', 'fictional-other-marker');
  } finally {
    sql.close();
  }
  assert.ok(existsSync(f.retainedReplay()));
});

test('contributor backing reuses one worker but opens a fresh job for every proof', async (t) => {
  const f = fixture(t),
    post = Worker.prototype.postMessage,
    jobs: { worker: Worker; id: number; mode: string }[] = [];
  Worker.prototype.postMessage = function (value: unknown, ...transfer: unknown[]) {
    const message = value as { id?: number; input?: { mode?: string } };
    if (message?.input?.mode && message.id !== undefined)
      jobs.push({ worker: this, id: message.id, mode: message.input.mode });
    return Reflect.apply(post, this, [value, ...transfer]);
  };
  try {
    await f.read();
    f.publish(1);
    await f.read();
    f.publish(1);
    await f.read();
  } finally {
    Worker.prototype.postMessage = post;
  }
  assert.ok(jobs.length >= 5);
  assert.equal(jobs[0]!.mode, 'prepare');
  assert.ok(jobs.some((row) => row.mode === 'advance'));
  assert.ok(jobs.some((row) => row.mode === 'verify'));
  assert.ok(jobs.every((row) => row.worker === jobs[0]!.worker));
  assert.deepEqual(
    jobs.map((row) => row.id),
    Array.from({ length: jobs.length }, (_, index) => index + 1),
  );
});

test('contributor discards a retained worker after a stale result id', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  f.publish(1);
  let stale = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { id?: number; result?: { entries?: number } } | undefined;
    if (event === 'message' && message?.result?.entries && !stale) {
      stale = true;
      message.id = message.id! - 1;
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, () => f.read());
    assert.ok(stale);
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor discards a retained worker after a duplicate terminal reply', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  f.publish(1);
  let repeated = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { id?: number; result?: { entries?: number } } | undefined;
    const delivered = Reflect.apply(emit, this, [event, ...args]);
    if (event === 'message' && message?.result?.entries && !repeated) {
      repeated = true;
      Reflect.apply(emit, this, [event, { ...message }]);
    }
    return delivered;
  };
  try {
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, () => f.read());
    assert.ok(repeated);
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor closes a poisoned retained owner during its fallback callback', async (t) => {
  const f = fixture(t);
  await f.read();
  const replay = f.retainedReplay();
  f.publish(1);
  const owner = captureContributorRecordReadOwner(f.storage);
  assert.ok(owner);
  const witness = captureContributorRecordStaging(f.db, f.storage, owner, true);
  assert.ok(witness);
  const emit = Worker.prototype.emit;
  let stale = false,
    closed = false,
    exited: Promise<unknown> | undefined;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { id?: number; result?: { entries?: number } } | undefined;
    if (event === 'message' && message?.result?.entries && !stale) {
      stale = true;
      exited = new Promise((resolve) => this.once('exit', resolve));
      message.id = message.id! - 1;
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    await assert.rejects(
      prepareContributorRecordTransactionBacking(
        witness,
        f.storage.read('head')!.toString('utf8'),
        () => {
          if (stale && !closed) {
            closed = true;
            discardContributorRecordStaging(witness);
          }
        },
      ),
    );
    assert.ok(stale && closed);
    await exited;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!existsSync(replay), 'reentrant close releases the failed replay');
  } finally {
    Worker.prototype.emit = emit;
    discardContributorRecordStaging(witness);
    closeContributorRecordReadOwner(owner);
  }
});

test('contributor closes an active worker before deleting its replay scratch', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  const replay = f.retainedReplay();
  f.publish(130);
  let closed = false;
  let exited: Promise<unknown> | undefined;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { certificateChunk?: unknown } | undefined;
    if (event === 'message' && message?.certificateChunk && !closed) {
      closed = true;
      exited = new Promise((resolve) => this.once('exit', resolve));
      f.storage.close();
      assert.ok(existsSync(replay), 'active replay remains until worker exit');
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    await assert.rejects(f.read(), /closed|changed|unavailable|recovery/);
    assert.ok(closed);
    await exited;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!existsSync(replay), 'replay scratch closes after worker exit');
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor reuses an explicitly absent optional source selection under the original replay proof', async (t) => {
  const f = fixture(t);
  await f.read();
  const selected = createRecordVersionWorkCounters();
  await withRecordVersionWork(selected, () => f.readOptional());
  assert.equal(counted(selected, 'contributorBackingOptionalPairSelections'), 1);
  assert.equal(counted(selected, 'contributorBackingIncrementalAdvances'), 1);
  const selectedVisits = counted(selected, 'contributorBackingPhysicalMemberVisits');
  assert.ok(selectedVisits > 0 && selectedVisits % 2 === 0);
  await f.read();
  const reused = createRecordVersionWorkCounters();
  await withRecordVersionWork(reused, () => f.readOptional());
  assert.equal(counted(reused, 'contributorBackingOptionalPairSelectionReuses'), 1);
  assert.equal(counted(reused, 'contributorBackingOptionalPairSelections'), 0);
  assert.equal(counted(reused, 'contributorBackingIncrementalAdvances'), 0);
  assert.equal(counted(reused, 'contributorBackingColdReplays'), 0);
  assert.equal(counted(reused, 'contributorBackingForeignFallbacks'), 0);
  assert.equal(counted(reused, 'contributorBackingPhysicalMemberVisits'), selectedVisits);
});

test('contributor cached selection makes one full retained check per verify boundary', async (t) => {
  const f = fixture(t);
  await f.readOptional();
  const owner = captureContributorRecordReadOwner(f.storage);
  assert.ok(owner);
  const witness = captureContributorRecordStaging(f.db, f.storage, owner, true);
  assert.ok(witness);
  const emit = Worker.prototype.emit;
  let checkpoints = 0;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    if (event === 'message' && (args[0] as { checkpoint?: boolean } | undefined)?.checkpoint)
      checkpoints++;
    return Reflect.apply(emit, this, [event, ...args]);
  };
  const work = createRecordVersionWorkCounters();
  try {
    await withRecordVersionWork(work, () =>
      prepareContributorRecordTransactionBacking(
        witness,
        f.storage.read('head')!.toString('utf8'),
        () => {},
        f.sourcePairRequest(),
        true,
      ),
    );
  } finally {
    Worker.prototype.emit = emit;
    discardContributorRecordStaging(witness);
    closeContributorRecordReadOwner(owner);
  }
  assert.equal(counted(work, 'contributorBackingOptionalPairSelectionReuses'), 1);
  assert.equal(checkpoints, 1);
  // Opening and closing checks are fixed; each worker checkpoint adds one.
  assert.equal(counted(work, 'contributorBackingRetainedChecks'), checkpoints + 4);
});

test('contributor retained worker callbacks use the current job context', async (t) => {
  const f = fixture(t);
  const context = new AsyncLocalStorage<string>();
  await context.run('first', () => f.readOptional());
  const owner = captureContributorRecordReadOwner(f.storage);
  assert.ok(owner);
  const witness = captureContributorRecordStaging(f.db, f.storage, owner, true);
  assert.ok(witness);
  const work = createRecordVersionWorkCounters();
  const observed: (string | undefined)[] = [];
  try {
    await context.run('second', () =>
      withRecordVersionWork(work, () =>
        prepareContributorRecordTransactionBacking(
          witness,
          f.storage.read('head')!.toString('utf8'),
          () => {
            observed.push(context.getStore());
          },
          f.sourcePairRequest(),
          true,
        ),
      ),
    );
  } finally {
    discardContributorRecordStaging(witness);
    closeContributorRecordReadOwner(owner);
  }
  assert.ok(observed.length > 1, 'the retained worker crossed a checkpoint');
  assert.deepEqual([...new Set(observed)], ['second']);
  assert.equal(counted(work, 'contributorBackingOptionalPairSelectionReuses'), 1);
  assert.equal(counted(work, 'contributorBackingColdReplays'), 0);
  assert.equal(counted(work, 'contributorBackingForeignFallbacks'), 0);
});

test('contributor optional absence cannot satisfy a required accepted pair', async (t) => {
  const f = fixture(t);
  await f.readOptional();
  const owner = captureContributorRecordReadOwner(f.storage);
  assert.ok(owner);
  const witness = captureContributorRecordStaging(f.db, f.storage, owner, true);
  assert.ok(witness);
  try {
    await assert.rejects(
      prepareContributorRecordTransactionBacking(
        witness,
        f.storage.read('head')!.toString('utf8'),
        () => {},
        f.sourcePairRequest(),
      ),
      /Contributor original backing verification refused/,
    );
  } finally {
    discardContributorRecordStaging(witness);
    closeContributorRecordReadOwner(owner);
  }
});

test('contributor optional receipt misses a different request and a replaced original HEAD', async (t) => {
  const f = fixture(t);
  await f.readOptional();
  f.publish();
  const changed = createRecordVersionWorkCounters();
  await withRecordVersionWork(changed, () => f.readOptional());
  assert.equal(counted(changed, 'contributorBackingOptionalPairSelectionReuses'), 0);
  assert.equal(counted(changed, 'contributorBackingIncrementalAdvances'), 1);
  f.sameByteRewrite('head');
  const replaced = createRecordVersionWorkCounters();
  await withRecordVersionWork(replaced, () => f.readOptional());
  assert.equal(counted(replaced, 'contributorBackingOptionalPairSelectionReuses'), 0);
  assert.equal(counted(replaced, 'contributorBackingColdReplays'), 1);
});

test('contributor optional receipt refuses a changed retained replay identity', async (t) => {
  const f = fixture(t);
  await f.readOptional();
  const path = f.retainedReplay(),
    bytes = readFileSync(path);
  renameSync(path, path + '.fictional-aside');
  writeFileSync(path, bytes);
  rmSync(path + '.fictional-aside');
  const work = createRecordVersionWorkCounters();
  await withRecordVersionWork(work, () => f.readOptional());
  assert.equal(counted(work, 'contributorBackingOptionalPairSelectionReuses'), 0);
  assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
});

test('contributor optional receipt refuses replay sidecar residue', async (t) => {
  const f = fixture(t);
  await f.readOptional();
  writeFileSync(f.retainedReplay() + '-wal', 'fictional residue');
  const work = createRecordVersionWorkCounters();
  await withRecordVersionWork(work, () => f.readOptional());
  assert.equal(counted(work, 'contributorBackingOptionalPairSelectionReuses'), 0);
  assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
});

test('contributor refuses a missing worker signature for an optional absence', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  let removed = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { result?: { sourcePairSelectionSignature?: string } } | undefined;
    if (event === 'message' && message?.result?.sourcePairSelectionSignature) {
      removed = true;
      delete message.result.sourcePairSelectionSignature;
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    await assert.rejects(f.readOptional(), /optional source selection worker receipt changed/);
    assert.ok(removed);
  } finally {
    Worker.prototype.emit = emit;
  }
  const recovered = createRecordVersionWorkCounters();
  await withRecordVersionWork(recovered, () => f.readOptional());
  assert.equal(counted(recovered, 'contributorBackingOptionalPairSelections'), 1);
  assert.equal(counted(recovered, 'contributorBackingOptionalPairSelectionReuses'), 0);
});

test('contributor optional receipt refuses a selected HEAD rewrite at a worker checkpoint', async (t) => {
  const f = fixture(t);
  await f.readOptional();
  const owner = captureContributorRecordReadOwner(f.storage);
  assert.ok(owner);
  const witness = captureContributorRecordStaging(f.db, f.storage, owner, true);
  assert.ok(witness);
  const emit = Worker.prototype.emit;
  let checkpoints = 0;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    if (event === 'message' && (args[0] as { checkpoint?: boolean } | undefined)?.checkpoint)
      checkpoints++;
    return Reflect.apply(emit, this, [event, ...args]);
  };
  let checks = 0,
    rewritten = false;
  const work = createRecordVersionWorkCounters();
  try {
    await withRecordVersionWork(work, () =>
      assert.rejects(
        prepareContributorRecordTransactionBacking(
          witness,
          f.storage.read('head')!.toString('utf8'),
          () => {
            if (++checks === 3) {
              f.sameByteRewrite('head');
              rewritten = true;
            }
          },
          f.sourcePairRequest(),
          true,
        ),
        /Contributor original staging owner changed/,
      ),
    );
    assert.ok(rewritten);
    assert.ok(checkpoints > 0, 'mutation followed an actual worker checkpoint');
    assert.equal(counted(work, 'contributorBackingOptionalPairSelectionReuses'), 0);
  } finally {
    Worker.prototype.emit = emit;
    discardContributorRecordStaging(witness);
    closeContributorRecordReadOwner(owner);
  }
});

test('contributor optional receipt is not adopted after caller cancellation', async (t) => {
  const f = fixture(t);
  await f.readOptional();
  const owner = captureContributorRecordReadOwner(f.storage);
  assert.ok(owner);
  const witness = captureContributorRecordStaging(f.db, f.storage, owner, true);
  assert.ok(witness);
  let checks = 0;
  const work = createRecordVersionWorkCounters();
  try {
    await withRecordVersionWork(work, () =>
      assert.rejects(
        prepareContributorRecordTransactionBacking(
          witness,
          f.storage.read('head')!.toString('utf8'),
          () => {
            if (++checks >= 2) throw Error('Fictional caller cancellation');
          },
          f.sourcePairRequest(),
          true,
        ),
        /Fictional caller cancellation/,
      ),
    );
    assert.ok(checks >= 2);
    assert.equal(counted(work, 'contributorBackingOptionalPairSelectionReuses'), 0);
  } finally {
    discardContributorRecordStaging(witness);
    closeContributorRecordReadOwner(owner);
  }
});

test('contributor coalesces own-publication roster proof before retained advance', async (t) => {
  const f = fixture(t),
    cold = createRecordVersionWorkCounters();
  await withRecordVersionWork(cold, () => f.read());
  assert.equal(counted(cold, 'contributorBackingColdReplays'), 1);
  const fullReplay = counted(cold, 'contributorBackingColdDecodedVersions'),
    firstSequence = Number(
      f.db.prepare('SELECT max(sequence) AS n FROM __record_versions').get()!.n,
    );
  assert.ok(fullReplay > 0);
  const work = createRecordVersionWorkCounters(),
    publications = 6,
    stale = f.currentVersion(),
    before = new Map([...unlockPhysicalEntries(f.base)].map((item) => [item.path, item])),
    originalSecretKey = crypto.createSecretKey,
    originalHmac = crypto.createHmac,
    keys = new Map<crypto.KeyObject, Buffer>(),
    messages: string[] = [];
  await withRecordVersionWork(work, async () => {
    for (let index = 0; index < publications; index++) f.publish();
    assert.equal(counted(work, 'contributorBackingOwnRosterReconciliations'), 0);
    assert.equal(counted(work, 'contributorBackingPhysicalMemberVisits'), 0);
    crypto.createSecretKey = function (
      key: NodeJS.ArrayBufferView | string,
      encoding?: BufferEncoding,
    ) {
      const prepared =
        typeof key === 'string' ? originalSecretKey(key, encoding!) : originalSecretKey(key);
      keys.set(prepared, prepared.export());
      return prepared;
    };
    crypto.createHmac = function (...args) {
      const hmac = originalHmac(...args),
        raw = args[1] instanceof crypto.KeyObject ? keys.get(args[1]) : undefined;
      if (!raw) return hmac;
      return new Proxy(hmac, {
        get(target, property) {
          if (property !== 'update') return Reflect.get(target, property, target);
          return (message: string) => {
            assert.equal(typeof message, 'string');
            messages.push(message);
            assert.equal(
              originalHmac(...args)
                .update(message)
                .digest('hex'),
              originalHmac(args[0], raw).update(message).digest('hex'),
              'native and raw keys produce byte-for-byte equivalent signatures',
            );
            return target.update(message);
          };
        },
      });
    };
    syncBuiltinESMExports();
    try {
      await f.read();
    } finally {
      crypto.createSecretKey = originalSecretKey;
      crypto.createHmac = originalHmac;
      syncBuiltinESMExports();
      for (const raw of keys.values()) raw.fill(0);
    }
    const marker = JSON.parse(messages[0]!) as string[];
    assert.equal(marker[1], '@marker');
    const expected = [messages[0]!];
    for (const item of unlockPhysicalEntries(f.base)) {
      const prior = before.get(item.path);
      if (prior) expected.push(JSON.stringify([marker[0], prior.path, prior.kind, prior.identity]));
      if (!prior || prior.identity !== item.identity)
        expected.push(JSON.stringify([marker[0], item.path, item.kind, item.identity]));
    }
    assert.deepEqual(messages.sort(), expected.sort(), 'one complete roster check still signs');
    await assert.rejects(f.read(stale), /predecessor differs/);
  });
  assert.equal(keys.size, 1, 'one native key is prepared for the complete reconciliation');
  assert.equal(counted(work, 'contributorBackingColdReplays'), 0);
  assert.equal(counted(work, 'contributorBackingForeignFallbacks'), 0);
  assert.equal(counted(work, 'contributorBackingOwnHeadsRecorded'), publications);
  assert.equal(counted(work, 'contributorBackingOwnRosterReconciliations'), 1);
  assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 1);
  // Each advance decodes only the new commit's versions, never history: the
  // replay reads every version the same fixed number of times, so the decoded
  // count is exactly that multiple of the new versions. Six cold replays (the
  // previous behavior: every own HEAD retired the proof) would decode all
  // history again.
  const versions = (after: number) =>
      Number(
        f.db.prepare('SELECT count(*) AS n FROM __record_versions WHERE sequence>?').get(after)!.n,
      ),
    history = versions(0) - versions(firstSequence),
    perVersion = fullReplay / history,
    incremental = counted(work, 'contributorBackingIncrementalDecodedVersions');
  assert.ok(Number.isInteger(perVersion), String(perVersion));
  assert.equal(incremental, perVersion * versions(firstSequence));
  let coldEquivalent = 0;
  for (let index = 1; index <= publications; index++)
    coldEquivalent += perVersion * (versions(0) - versions(firstSequence + index));
  assert.ok(incremental * 5 < coldEquivalent, `${incremental} vs ${coldEquivalent}`);
});

test('contributor repeatedly advances exact own publications without replaying history', async (t) => {
  const f = fixture(t);
  await f.read();
  const work = createRecordVersionWorkCounters();
  let stale = f.currentVersion();
  await withRecordVersionWork(work, async () => {
    for (let index = 0; index < 6; index++) {
      f.publish();
      const accepted = f.currentVersion();
      await f.read(accepted);
      await assert.rejects(f.read(stale), /predecessor differs/);
      stale = accepted;
    }
  });
  assert.equal(counted(work, 'contributorBackingOwnHeadsRecorded'), 6);
  assert.equal(counted(work, 'contributorBackingOwnRosterReconciliations'), 6);
  assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 6);
  assert.equal(counted(work, 'contributorBackingColdReplays'), 0);
});

test('contributor native predecessor chunk retains all 64 accepted transitions without cold replay', async (t) => {
  const f = fixture(t);
  const cold = createRecordVersionWorkCounters();
  await withRecordVersionWork(cold, () => f.read());
  const initialVersions = Number(f.db.prepare('SELECT count(*) n FROM __record_versions').get()!.n),
    perVersion = counted(cold, 'contributorBackingColdDecodedVersions') / initialVersions;
  assert.ok(Number.isInteger(perVersion) && perVersion > 0);
  const before = Number(f.db.prepare('SELECT max(sequence) n FROM __record_versions').get()!.n);
  f.publish(61);
  const changed = Number(
    f.db.prepare('SELECT count(*) n FROM __record_versions WHERE sequence>?').get(before)!.n,
  );
  assert.equal(changed, 64);
  const work = createRecordVersionWorkCounters();
  await withRecordVersionWork(work, () => f.read());
  assert.equal(counted(work, 'contributorBackingColdReplays'), 0);
  assert.equal(counted(work, 'contributorBackingForeignFallbacks'), 0);
  assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 1);
  assert.equal(counted(work, 'contributorBackingIncrementalDecodedVersions'), perVersion * changed);
  const fullChecks = counted(work, 'contributorBackingAdvanceFullChecks');
  assert.ok(
    fullChecks < changed,
    `${fullChecks} owner seals for one ${changed}-record native span`,
  );
  for (let index = 0; index < 61; index++)
    assert.equal(
      f.db.prepare('SELECT display_name FROM people WHERE id=?').get('fictional-added-1-' + index)
        ?.display_name,
      'Fictional Added ' + index,
    );
});

test('contributor changed roster bounds real multi-chunk tree writes and preserves every predecessor', async (t) => {
  const f = fixture(t),
    trace = traceCertificateInserts(),
    emit = Worker.prototype.emit,
    chunks: ContributorCertificateDelta[][] = [],
    checkpointMessages: Record<string, number> = {};
  let oldRoot: IntakeTreeRoot | undefined,
    measuringAdvance = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as
      | {
          result?: { certificateRoot?: IntakeTreeRoot };
          certificateChunk?: { certificates: ContributorCertificateDelta[] };
          checkpoint?: boolean;
          phase?: string;
        }
      | undefined;
    if (event === 'message' && message?.result?.certificateRoot !== undefined)
      oldRoot = message.result.certificateRoot;
    if (event === 'message' && message?.certificateChunk)
      chunks.push(message.certificateChunk.certificates);
    if (event === 'message' && message?.checkpoint && measuringAdvance) {
      const phase = message.phase ?? 'unknown';
      checkpointMessages[phase] = (checkpointMessages[phase] ?? 0) + 1;
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  const reference = new DatabaseSync(':memory:'),
    ordered = new DatabaseSync(':memory:');
  try {
    f.publish(512);
    await f.read();
    assert.ok(oldRoot);
    const physical = trace.database()!;
    for (const sql of [reference, ordered]) {
      sql.exec(VAULT_CERTIFICATE_SCHEMA);
      for (const table of ['certificates', 'certificate_pages']) {
        const insert = sql.prepare('INSERT INTO ' + table + ' VALUES(?,?)');
        for (const row of physical.prepare('SELECT hash,raw FROM ' + table).iterate())
          insert.run(row.hash, row.raw);
      }
    }
    const identity = JSON.parse(
        String(physical.prepare('SELECT raw FROM certificate_pages LIMIT 1').get()!.raw),
      ).identity as { profileId: string; intakeId: string },
      initialCertificates = [...physical.prepare('SELECT raw FROM certificates').iterate()].map(
        (row) => JSON.parse(String(row.raw)) as VaultRecordCertificate,
      ),
      prior = new Map(
        initialCertificates.map((value) => [JSON.stringify([value.entity, value.recordId]), value]),
      );
    f.publish();
    transaction(f.db, () => {
      const update = f.db.prepare('UPDATE people SET display_name=? WHERE id=?');
      for (let index = 0; index < 512; index++)
        update.run('Fictional Changed ' + index, 'fictional-added-1-' + index);
      for (let index = 0; index < 14; index++)
        f.db.prepare('DELETE FROM people WHERE id=?').run('fictional-added-1-' + index);
      for (let index = 0; index < 50; index++)
        f.db
          .prepare('INSERT INTO people(id,display_name) VALUES(?,?)')
          .run('fictional-new-' + index, 'Fictional New ' + index);
    });
    transaction(f.db, () => {
      for (let index = 0; index < 8; index++)
        f.db
          .prepare('INSERT INTO people(id,display_name) VALUES(?,?)')
          .run('fictional-added-1-' + index, 'Fictional Resurrected ' + index);
    });
    trace.start();
    const work = createRecordVersionWorkCounters();
    const advanceStarted = performance.now();
    measuringAdvance = true;
    await withRecordVersionWork(work, () => f.read());
    measuringAdvance = false;
    const advanceHostMsSupportingOnly = performance.now() - advanceStarted;
    const productionCounts = trace.counts();
    trace.stop();
    const changed = chunks.flat(),
      key = (value: { entity: string; recordId: string }) =>
        createHash('sha256')
          .update(JSON.stringify([value.entity, value.recordId]))
          .digest('hex'),
      keys = changed.map(key);
    assert.ok(chunks.length > 8 && changed.length > 512);
    assert.equal(new Set(keys).size, changed.length, 'repeated changes emit one final transition');
    assert.equal(counted(work, 'contributorBackingColdReplays'), 0);
    assert.equal(counted(work, 'contributorBackingForeignFallbacks'), 0);
    for (const value of changed)
      assert.equal(
        value.previousAccepted,
        prior.get(JSON.stringify([value.entity, value.recordId]))?.versionId ?? null,
      );
    for (let index = 0; index < 14; index++) {
      const value = changed.find(
        (value) =>
          value.entity === 'people' &&
          value.recordId === JSON.stringify(['fictional-added-1-' + index]),
      )!;
      assert.equal(
        value.deleted,
        Number(index >= 8),
        'first predecessor survives delete/resurrection',
      );
    }
    for (let index = 0; index < 50; index++)
      assert.equal(
        changed.find((value) => value.recordId === JSON.stringify(['fictional-new-' + index]))!
          .previousAccepted,
        null,
      );
    const pageCount = (sql: DatabaseSync) =>
        Number(sql.prepare('SELECT count(*) n FROM certificate_pages').get()!.n),
      certificateCount = (sql: DatabaseSync) =>
        Number(sql.prepare('SELECT count(*) n FROM certificates').get()!.n),
      referenceBefore = pageCount(reference),
      orderedBefore = pageCount(ordered),
      rawBefore = initialCertificates.length,
      baselineCodec = vaultRecordCertificates(
        reference,
        identity.profileId,
        identity.intakeId,
        () => {},
      ),
      candidateCodec = vaultRecordCertificates(
        ordered,
        identity.profileId,
        identity.intakeId,
        () => {},
      ),
      actualCodec = vaultRecordCertificates(
        physical,
        identity.profileId,
        identity.intakeId,
        () => {},
      );
    let baselineRoot: IntakeTreeRoot = oldRoot,
      candidateRoot: IntakeTreeRoot = oldRoot;
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
      baseline = changed
        .slice()
        .sort((a, b) => compare(a.entity, b.entity) || compare(a.recordId, b.recordId));
    for (let offset = 0; offset < baseline.length; offset += 64)
      baselineRoot = baselineCodec.putMany(
        baselineRoot,
        baseline.slice(offset, offset + 64).map(({ previousAccepted: _, ...value }) => value),
      ).root;
    for (const chunk of chunks)
      candidateRoot = candidateCodec.putMany(
        candidateRoot,
        chunk.map(({ previousAccepted: _, ...value }) => value),
      ).root;
    const actualPages = productionCounts.inserts,
      baselinePages = pageCount(reference) - referenceBefore,
      orderedPages = pageCount(ordered) - orderedBefore;
    assert.equal(
      actualPages,
      orderedPages,
      'production writes exactly the ordered reference pages',
    );
    assert.ok(
      actualPages < baselinePages,
      `${actualPages} vs ${baselinePages} real tree-page writes`,
    );
    assert.deepEqual(
      keys,
      [...keys].sort(),
      'authenticated chunks retain one global fixed-key order',
    );
    assert.equal(
      certificateCount(reference) - rawBefore,
      changed.length,
      'every final raw certificate is retained',
    );
    assert.equal(certificateCount(ordered), certificateCount(physical));
    for (const value of initialCertificates)
      assert.deepEqual(actualCodec.get(oldRoot, value.entity, value.recordId), value);
    const expected = new Map(
      initialCertificates.map((value) => [JSON.stringify([value.entity, value.recordId]), value]),
    );
    for (const { previousAccepted: _, ...value } of changed)
      expected.set(JSON.stringify([value.entity, value.recordId]), value);
    for (const value of expected.values()) {
      assert.deepEqual(baselineCodec.get(baselineRoot, value.entity, value.recordId), value);
      assert.deepEqual(candidateCodec.get(candidateRoot, value.entity, value.recordId), value);
      assert.deepEqual(actualCodec.get(candidateRoot, value.entity, value.recordId), value);
      const selected = f.db
        .prepare('SELECT version_id FROM __record_current WHERE entity=? AND record_id=?')
        .get(value.entity, value.recordId)!;
      assert.equal(selected.version_id, value.versionId);
    }
    assert.equal(productionCounts.outsideTransaction, 0);
    for (const sql of [physical, reference, ordered])
      assert.deepEqual(
        sql
          .prepare('PRAGMA integrity_check')
          .all()
          .map((row) => row.integrity_check),
        ['ok'],
      );
    t.diagnostic(
      JSON.stringify({
        changed: changed.length,
        chunks: chunks.length,
        actualPages,
        baselinePages,
        rawCertificates: changed.length,
        advanceHostMsSupportingOnly,
        checkpointMessages,
        retainedHistoryRows: Number(
          f.db.prepare('SELECT count(*) n FROM __record_versions').get()!.n,
        ),
        touchedQueryPlan: f.db
          .prepare(
            'EXPLAIN QUERY PLAN SELECT entity,record_id,min(sequence) AS first FROM __record_versions ' +
              'WHERE profile_id=? AND sequence>? GROUP BY entity,record_id',
          )
          .all(f.profileId, 0)
          .map((row) => row.detail),
        predecessorPath: 'existing custom preparation fallback; actual putMany writes unchanged',
      }),
    );
  } finally {
    Worker.prototype.emit = emit;
    trace.restore();
    reference.close();
    ordered.close();
  }
});

test('contributor advances more than one certificate batch in one counted replay', async (t) => {
  const f = fixture(t);
  const trace = traceCertificateInserts();
  try {
    const cold = createRecordVersionWorkCounters();
    await withRecordVersionWork(cold, () => f.read());
    const initialVersions = Number(
        f.db.prepare('SELECT count(*) n FROM __record_versions').get()!.n,
      ),
      perVersion = counted(cold, 'contributorBackingColdDecodedVersions') / initialVersions;
    assert.ok(Number.isInteger(perVersion) && perVersion > 0);
    const before = Number(f.db.prepare('SELECT max(sequence) n FROM __record_versions').get()!.n);
    f.publish(130);
    const changed = Number(
      f.db.prepare('SELECT count(*) n FROM __record_versions WHERE sequence>?').get(before)!.n,
    );
    assert.ok(changed > 64);
    const work = createRecordVersionWorkCounters();
    trace.start();
    await withRecordVersionWork(work, () => f.read());
    assert.equal(counted(work, 'contributorBackingColdReplays'), 0);
    assert.equal(counted(work, 'contributorBackingForeignFallbacks'), 0);
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 1);
    assert.equal(
      counted(work, 'contributorBackingIncrementalDecodedVersions'),
      perVersion * changed,
    );
    const fullChecks = counted(work, 'contributorBackingAdvanceFullChecks'),
      scratchChecks = counted(work, 'contributorBackingAdvanceScratchChecks'),
      chunks = Math.ceil(changed / 64);
    // Predecessor/batch seals plus two checks at every yield in all three passes.
    assert.equal(fullChecks, 2 * (changed + chunks) + 1 + 2 * 3 * chunks);
    assert.ok(scratchChecks > fullChecks * 2, `${scratchChecks} vs ${fullChecks}`);
    const { inserts, outsideTransaction } = trace.counts();
    assert.ok(inserts > 64, `only ${inserts} certificate pages inserted`);
    assert.equal(outsideTransaction, 0);
  } finally {
    trace.restore();
  }
});

test('contributor streams more than 4096 changed certificates without a cold replay', async (t) => {
  const f = fixture(t);
  await f.read();
  const before = Number(f.db.prepare('SELECT max(sequence) n FROM __record_versions').get()!.n),
    emit = Worker.prototype.emit;
  let chunks = 0,
    largest = 0;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { certificateChunk?: { certificates: unknown[] } } | undefined;
    if (event === 'message' && message?.certificateChunk) {
      chunks++;
      largest = Math.max(largest, Buffer.byteLength(JSON.stringify(message.certificateChunk)));
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    f.publish(4097);
    const changed = Number(
      f.db
        .prepare(
          'SELECT count(*) n FROM (SELECT entity,record_id FROM __record_versions WHERE sequence>? GROUP BY entity,record_id)',
        )
        .get(before)!.n,
    );
    assert.ok(changed > 4096);
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, () => f.read(f.currentVersion()));
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 1);
    assert.equal(counted(work, 'contributorBackingColdReplays'), 0);
    assert.equal(counted(work, 'contributorBackingForeignFallbacks'), 0);
    assert.ok(chunks > 64, `${chunks} chunks for ${changed} changed records`);
    assert.ok(largest <= 256 * 1024, `${largest} byte chunk`);
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor certificate spool discovery excludes another fixture', async (t) => {
  const unrelated = mkdtempSync(join(tmpdir(), 'circus-contributor-certificate-delta-'));
  writeFileSync(join(unrelated, 'chunks'), 'Fictional unrelated scratch.');
  t.after(() => rmSync(unrelated, { recursive: true, force: true }));
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  f.publish(130);
  let checked = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { result?: { certificateCount?: number } } | undefined;
    if (event === 'message' && message?.result?.certificateCount) {
      assert.notEqual(privateCertificateDeltaSpool(), join(unrelated, 'chunks'));
      checked = true;
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    await f.read();
    assert.ok(checked);
    assert.equal(readFileSync(join(unrelated, 'chunks'), 'utf8'), 'Fictional unrelated scratch.');
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor certificate frames enforce the exact encoded byte boundary', () => {
  const key = Buffer.alloc(32, 7),
    nonce = 'fictional-delta-nonce',
    head = 'fictional-selected-head',
    certificate: ContributorCertificateDelta = {
      entity: 'people',
      recordId: '',
      versionId: 'fictional-version',
      deleted: 0,
      preimage: { hash: 'a'.repeat(64), bytes: 1 },
      fields: [],
      previousAccepted: null,
    },
    chunk = (length: number) => {
      const certificates = [{ ...certificate, recordId: 'x'.repeat(length) }];
      return {
        ordinal: 0,
        certificates,
        signature: signCertificateDeltaChunk(key, nonce, head, 0, certificates),
      };
    },
    overhead = Buffer.byteLength(JSON.stringify(chunk(0))),
    exact = chunk(MAX_CERTIFICATE_DELTA_CHUNK_BYTES - overhead);
  assert.equal(
    checkedCertificateDeltaChunk(key, nonce, head, exact).encoded.length,
    MAX_CERTIFICATE_DELTA_CHUNK_BYTES,
  );
  assert.throws(
    () =>
      checkedCertificateDeltaChunk(
        key,
        nonce,
        head,
        chunk(exact.certificates[0]!.recordId.length + 1),
      ),
    /chunk too large/,
  );
  assert.throws(
    () =>
      certificateDeltaMinimumBytes({
        ...certificate,
        recordId: 'x'.repeat(MAX_CERTIFICATE_DELTA_CHUNK_BYTES + 1),
      }),
    /value invalid|chunk too large/,
  );
});

test('contributor discards a forged certificate chunk before accepting a root', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  f.publish(130);
  let forged = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { certificateChunk?: { signature: string } } | undefined;
    if (event === 'message' && message?.certificateChunk && !forged) {
      forged = true;
      message.certificateChunk.signature = '0'.repeat(64);
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, () => f.read());
    assert.ok(forged, 'a genuine worker chunk was changed');
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor discards a malformed certificate field before accepting a root', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  f.publish(130);
  let malformed = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as
      { certificateChunk?: { certificates: { preimage: { hash: unknown } }[] } } | undefined;
    if (event === 'message' && message?.certificateChunk && !malformed) {
      malformed = true;
      message.certificateChunk.certificates[0]!.preimage.hash = 42;
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, () => f.read());
    assert.ok(malformed, 'a genuine worker field was malformed');
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor discards a missing certificate chunk at the terminal receipt', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  f.publish(130);
  let omitted = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { id?: number; certificateChunk?: unknown } | undefined;
    if (event === 'message' && message?.certificateChunk && !omitted) {
      omitted = true;
      return Reflect.apply(emit, this, [
        event,
        { id: message.id, checkpoint: true, baselineReady: true },
      ]);
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, () => f.read());
    assert.ok(omitted, 'a genuine worker chunk was omitted');
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor discards a repeated certificate chunk before accepting a root', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  f.publish(130);
  let repeated = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { certificateChunk?: unknown } | undefined;
    if (event === 'message' && message?.certificateChunk && !repeated) {
      repeated = true;
      Reflect.apply(emit, this, [event, ...args]);
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, () => f.read());
    assert.ok(repeated, 'a genuine worker chunk was repeated');
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor discards staged chunks when the worker refuses its terminal proof', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  f.publish(130);
  let staged = false,
    refused = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as
      | { id?: number; certificateChunk?: unknown; result?: { certificateCount?: number } }
      | undefined;
    if (event === 'message' && message?.certificateChunk) staged = true;
    if (event === 'message' && message?.result?.certificateCount && staged && !refused) {
      refused = true;
      return Reflect.apply(emit, this, [event, { id: message.id, refused: true }]);
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, () => f.read());
    assert.ok(staged && refused, 'a successful worker prefix was followed by refusal');
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor discards a changed private delta spool before root adoption', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  f.publish(130);
  let changed = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { result?: { certificateCount?: number } } | undefined;
    if (event === 'message' && message?.result?.certificateCount && !changed) {
      const path = privateCertificateDeltaSpool(),
        bytes = readFileSync(path);
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(path, bytes);
      changed = true;
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, () => f.read());
    assert.ok(changed, 'the private spool was changed after genuine worker chunks');
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor discards a truncated private delta spool before root adoption', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  f.publish(130);
  let truncated = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { result?: { certificateCount?: number } } | undefined;
    if (event === 'message' && message?.result?.certificateCount && !truncated) {
      const path = privateCertificateDeltaSpool();
      truncateSync(path, readFileSync(path).length - 1);
      truncated = true;
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, () => f.read());
    assert.ok(truncated, 'the private spool was truncated after genuine worker chunks');
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor discards a same-byte replaced private delta spool', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  f.publish(130);
  let replaced = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { result?: { certificateCount?: number } } | undefined;
    if (event === 'message' && message?.result?.certificateCount && !replaced) {
      const path = privateCertificateDeltaSpool(),
        bytes = readFileSync(path);
      renameSync(path, path + '.fictional-aside');
      writeFileSync(path, bytes);
      rmSync(path + '.fictional-aside');
      replaced = true;
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, () => f.read());
    assert.ok(replaced, 'the private spool identity changed after genuine worker chunks');
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor rolls back when a staged chunk changes during certificate insertion', async (t) => {
  const f = fixture(t),
    trace = traceCertificateInserts(() => {
      const path = privateCertificateDeltaSpool(),
        bytes = readFileSync(path);
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(path, bytes);
    });
  try {
    await f.read();
    f.publish(130);
    const work = createRecordVersionWorkCounters();
    trace.start();
    await withRecordVersionWork(work, () => f.read());
    const { inserts, beforeRollback, afterRollback } = trace.counts();
    assert.ok(inserts > 0, 'spool mutation followed a genuine private certificate insert');
    assert.ok(beforeRollback !== undefined);
    assert.equal(afterRollback, beforeRollback, 'tentative certificate pages rolled back');
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
  } finally {
    trace.restore();
  }
});

test('contributor refuses a selected HEAD rewrite at a certificate chunk boundary', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  f.publish(130);
  let rewritten = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { certificateChunk?: unknown } | undefined;
    if (event === 'message' && message?.certificateChunk && !rewritten) {
      rewritten = true;
      f.sameByteRewrite('head');
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, () =>
      assert.rejects(f.read(), /Record journal: original record read authority changed/),
    );
    assert.ok(rewritten);
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    const recovery = createRecordVersionWorkCounters();
    await withRecordVersionWork(recovery, () => f.read());
    assert.equal(counted(recovery, 'contributorBackingColdReplays'), 1);
  } finally {
    Worker.prototype.emit = emit;
  }
});

test('contributor does not adopt streamed certificates after caller cancellation', async (t) => {
  const f = fixture(t),
    emit = Worker.prototype.emit;
  await f.read();
  f.publish(130);
  const owner = captureContributorRecordReadOwner(f.storage);
  assert.ok(owner);
  const witness = captureContributorRecordStaging(f.db, f.storage, owner, true);
  assert.ok(witness);
  let canceled = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { certificateChunk?: unknown } | undefined;
    if (event === 'message' && message?.certificateChunk && !canceled) {
      const result = Reflect.apply(emit, this, [event, ...args]);
      assert.ok(readFileSync(privateCertificateDeltaSpool()).length > 0);
      canceled = true;
      return result;
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    const work = createRecordVersionWorkCounters();
    await withRecordVersionWork(work, () =>
      assert.rejects(
        prepareContributorRecordTransactionBacking(
          witness,
          f.storage.read('head')!.toString('utf8'),
          () => {
            if (canceled) throw Error('Fictional caller canceled');
          },
        ),
        /Fictional caller canceled/,
      ),
    );
    assert.ok(canceled, 'cancellation followed a staged certificate chunk');
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
  } finally {
    Worker.prototype.emit = emit;
    discardContributorRecordStaging(witness);
    closeContributorRecordReadOwner(owner);
  }
  await assert.rejects(f.read(), /Contributor retained backing requires recovery/);
});

for (const phase of ['predecessors', 'insertion'] as const) {
  test(`contributor yields to caller cancellation during certificate ${phase}`, async (t) => {
    const f = fixture(t);
    let canceled = false;
    const interrupt = () => {
      setImmediate(() => {
        canceled = true;
      });
    };
    const trace = traceCertificateInserts(phase === 'insertion' ? interrupt : undefined);
    const lookup = phase === 'predecessors' ? interruptCertificatePageRead(interrupt) : undefined;
    let witness: ReturnType<typeof captureContributorRecordStaging>;
    let owner: ReturnType<typeof captureContributorRecordReadOwner>;
    try {
      await f.read();
      f.publish(130);
      owner = captureContributorRecordReadOwner(f.storage);
      assert.ok(owner);
      witness = captureContributorRecordStaging(f.db, f.storage, owner, true);
      assert.ok(witness);
      trace.start();
      lookup?.start();
      const work = createRecordVersionWorkCounters();
      await withRecordVersionWork(work, () =>
        assert.rejects(
          prepareContributorRecordTransactionBacking(
            witness!,
            f.storage.read('head')!.toString('utf8'),
            () => {
              if (canceled) throw Error('Fictional caller canceled during host consumption');
            },
          ),
          /Fictional caller canceled during host consumption/,
        ),
      );
      assert.ok(canceled, 'an event-loop callback ran before the host adopted its root');
      const { inserts, beforeRollback, afterRollback } = trace.counts();
      if (phase === 'insertion') {
        assert.ok(inserts > 0, 'cancellation follows a tentative certificate write');
        assert.ok(beforeRollback !== undefined);
        assert.equal(afterRollback, beforeRollback, 'yielded transaction rolled back');
      } else assert.equal(inserts, 0, 'cancellation precedes certificate writes');
      assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
      assert.equal(counted(work, 'contributorBackingColdReplays'), 0);
    } finally {
      lookup?.restore();
      trace.restore();
      if (witness) discardContributorRecordStaging(witness);
      if (owner) closeContributorRecordReadOwner(owner);
    }
  });
}

test('contributor refuses a selected HEAD rewrite inside a certificate lookup', async (t) => {
  const f = fixture(t);
  const interruption = interruptCertificatePageRead(() => f.sameByteRewrite('head'));
  try {
    await f.read();
    f.publish();
    const work = createRecordVersionWorkCounters();
    interruption.start();
    await withRecordVersionWork(work, () =>
      assert.rejects(f.read(), /Contributor original staging owner changed/),
    );
    assert.ok(interruption.changed());
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    const recovery = createRecordVersionWorkCounters();
    await withRecordVersionWork(recovery, () => f.read());
    assert.equal(counted(recovery, 'contributorBackingColdReplays'), 1);
  } finally {
    interruption.restore();
  }
});

test('contributor refuses private scratch mutation inside a certificate lookup', async (t) => {
  const f = fixture(t);
  const interruption = interruptCertificatePageRead((sql) => {
    sql.prepare('INSERT OR IGNORE INTO certificate_pages VALUES(?,?)').run('f'.repeat(64), '{}');
  });
  try {
    await f.read();
    f.publish();
    const work = createRecordVersionWorkCounters();
    interruption.start();
    await withRecordVersionWork(work, () =>
      assert.rejects(f.read(), /Contributor original backing scratch changed/),
    );
    assert.ok(interruption.changed());
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    const recovery = createRecordVersionWorkCounters();
    await withRecordVersionWork(recovery, () => f.read());
    assert.equal(counted(recovery, 'contributorBackingColdReplays'), 1);
  } finally {
    interruption.restore();
  }
});

test('contributor refuses a storage method change inside a certificate lookup', async (t) => {
  const f = fixture(t),
    read = f.storage.read;
  const interruption = interruptCertificatePageRead(() => {
    f.storage.read = () => null;
  });
  try {
    await f.read();
    f.publish();
    const work = createRecordVersionWorkCounters();
    interruption.start();
    await withRecordVersionWork(work, () =>
      assert.rejects(f.read(), /Contributor original staging owner changed/),
    );
    assert.ok(interruption.changed());
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    f.storage.read = read;
    const recovery = createRecordVersionWorkCounters();
    await withRecordVersionWork(recovery, () => f.read());
    assert.equal(counted(recovery, 'contributorBackingColdReplays'), 1);
  } finally {
    f.storage.read = read;
    interruption.restore();
  }
});

test('contributor rolls back a certificate batch when the selected HEAD changes during insertion', async (t) => {
  const f = fixture(t);
  const trace = traceCertificateInserts(() => f.sameByteRewrite('head'));
  try {
    await f.read();
    f.publish(130);
    const work = createRecordVersionWorkCounters();
    trace.start();
    await withRecordVersionWork(work, () =>
      assert.rejects(f.read(), /Contributor original staging owner changed/),
    );
    const { inserts, outsideTransaction, beforeRollback, afterRollback } = trace.counts();
    assert.ok(inserts > 0);
    assert.equal(outsideTransaction, 0);
    assert.ok(beforeRollback !== undefined);
    assert.equal(afterRollback, beforeRollback, 'tentative pages rolled back before root adoption');
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    const recovery = createRecordVersionWorkCounters();
    await withRecordVersionWork(recovery, () => f.read());
    assert.equal(counted(recovery, 'contributorBackingColdReplays'), 1);
  } finally {
    trace.restore();
  }
});

test('contributor rolls back when the selected HEAD changes during a host yield', async (t) => {
  const f = fixture(t);
  let rewritten = false;
  const trace = traceCertificateInserts(() => {
    setImmediate(() => {
      rewritten = true;
      f.sameByteRewrite('head');
    });
  });
  try {
    await f.read();
    f.publish(130);
    const work = createRecordVersionWorkCounters();
    trace.start();
    await withRecordVersionWork(work, () =>
      assert.rejects(f.read(), /Record journal: original record read authority changed/),
    );
    assert.ok(rewritten, 'the host yielded after tentative certificate writes');
    const { inserts, beforeRollback, afterRollback } = trace.counts();
    assert.ok(inserts > 0);
    assert.ok(beforeRollback !== undefined);
    assert.equal(afterRollback, beforeRollback);
    assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
    const recovery = createRecordVersionWorkCounters();
    await withRecordVersionWork(recovery, () => f.read());
    assert.equal(counted(recovery, 'contributorBackingColdReplays'), 1);
  } finally {
    trace.restore();
  }
});

test('contributor rolls back a later certificate insert and cold replays', async (t) => {
  const f = fixture(t),
    trace = traceCertificateInserts(undefined, 65);
  try {
    await f.read();
    f.publish(130);
    const failure = createRecordVersionWorkCounters();
    trace.start();
    await withRecordVersionWork(failure, async () => {
      try {
        await f.read();
      } catch (error) {
        assert.match(String(error), /Fictional certificate page insert refused/);
      }
    });
    const { attempts, inserts, beforeRollback, afterRollback } = trace.counts();
    assert.equal(attempts, 65);
    assert.ok(inserts > 0);
    assert.ok(beforeRollback !== undefined);
    assert.equal(afterRollback, beforeRollback, 'partial private certificate pages rolled back');
    assert.equal(counted(failure, 'contributorBackingIncrementalAdvances'), 0);
    const recovery = createRecordVersionWorkCounters();
    await withRecordVersionWork(recovery, () => f.read());
    assert.ok(
      counted(failure, 'contributorBackingColdReplays') +
        counted(recovery, 'contributorBackingColdReplays') >=
        1,
    );
  } finally {
    trace.restore();
  }
});

test('contributor advanced proof refuses a forged accepted-version preimage', async (t) => {
  const f = fixture(t);
  await f.read();
  f.publish();
  const accepted = f.currentVersion(),
    forged = { ...accepted.preimage, hash: createHash('sha256').update('forged').digest('hex') };
  await assert.rejects(f.read({ ...accepted, preimage: forged }), /predecessor differs/);
  await assert.rejects(
    f.read({ ...accepted, preimage: { ...accepted.preimage, bytes: accepted.preimage.bytes + 1 } }),
    /predecessor differs/,
  );
  await f.read(accepted);
});

test('contributor same-byte rewrite of a retained member between own publications forces a full replay', async (t) => {
  const f = fixture(t);
  await f.read();
  f.publish();
  const between = createRecordVersionWorkCounters();
  await withRecordVersionWork(between, async () => {
    f.sameByteRewrite(f.retainedObject());
    f.publish();
    await f.read();
  });
  assert.equal(counted(between, 'contributorBackingIncrementalAdvances'), 0);
  assert.equal(counted(between, 'contributorBackingColdReplays'), 1);
  const after = createRecordVersionWorkCounters();
  await withRecordVersionWork(after, async () => {
    f.publish();
    f.sameByteRewrite(f.retainedObject());
    await f.read();
  });
  assert.equal(counted(after, 'contributorBackingOwnHeadsRecorded'), 1);
  assert.equal(counted(after, 'contributorBackingIncrementalAdvances'), 0);
  assert.equal(counted(after, 'contributorBackingForeignFallbacks'), 1);
  assert.equal(counted(after, 'contributorBackingColdReplays'), 1);
});

test('provisional own publications cannot adopt an unrecorded physical object', async (t) => {
  const f = fixture(t);
  await f.read();
  f.publish();
  f.publish();
  const foreign = join(f.base, 'objects', '00000000-0000-4000-8000-000000000000');
  writeFileSync(foreign, Buffer.from('Fictional unrecorded object.'));
  const work = createRecordVersionWorkCounters();
  await withRecordVersionWork(work, async () => {
    try {
      await f.read();
    } catch {
      // A complete cold proof may also refuse the unrecorded object.
    }
  });
  assert.equal(counted(work, 'contributorBackingOwnRosterReconciliations'), 0);
  assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
  assert.equal(counted(work, 'contributorBackingForeignFallbacks'), 1);
});

test('a transient unconsumed foreign object does not become retained authority', async (t) => {
  const f = fixture(t);
  await f.read();
  f.publish();
  const foreign = join(f.base, 'objects', '00000000-0000-4000-8000-000000000000');
  writeFileSync(foreign, Buffer.from('Fictional transient object.'));
  f.publish();
  rmSync(foreign);
  const accepted = f.currentVersion(),
    work = createRecordVersionWorkCounters();
  // No retained proof used the transient namespace; the final complete sweep
  // and exact factory receipts still have to prove the accepted version.
  await withRecordVersionWork(work, () => f.read(accepted));
  assert.equal(counted(work, 'contributorBackingOwnRosterReconciliations'), 1);
  assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 1);
  assert.equal(counted(work, 'contributorBackingColdReplays'), 0);
});

test('provisional reconciliation refuses a missing original member before retaining', async (t) => {
  const f = fixture(t);
  await f.read();
  const retained = f.retainedObject();
  f.publish();
  f.publish();
  rmSync(join(f.base, retained));
  const work = createRecordVersionWorkCounters();
  await withRecordVersionWork(work, () => assert.rejects(f.read()));
  assert.equal(counted(work, 'contributorBackingOwnRosterReconciliations'), 0);
  assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
  assert.equal(counted(work, 'contributorBackingForeignFallbacks'), 1);
});

test('provisional reconciliation refuses a HEAD replacement during its roster sweep', async (t) => {
  const f = fixture(t);
  await f.read();
  f.publish();
  f.publish();
  const originalHmac = crypto.createHmac;
  let replaced = false;
  crypto.createHmac = function (...args) {
    const hmac = originalHmac(...args);
    if (!(args[1] instanceof crypto.KeyObject)) return hmac;
    return new Proxy(hmac, {
      get(target, property) {
        if (property !== 'update') return Reflect.get(target, property, target);
        return (message: string) => {
          const entry = JSON.parse(message) as unknown[];
          if (!replaced && entry[1] === '') {
            replaced = true;
            f.sameByteRewrite('head');
          }
          return target.update(message);
        };
      },
    });
  };
  syncBuiltinESMExports();
  const work = createRecordVersionWorkCounters();
  try {
    await withRecordVersionWork(work, () =>
      assert.rejects(f.read(), /Contributor original staging owner changed/),
    );
  } finally {
    crypto.createHmac = originalHmac;
    syncBuiltinESMExports();
  }
  assert.equal(replaced, true);
  assert.equal(counted(work, 'contributorBackingOwnRosterReconciliations'), 0);
  assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
  assert.equal(counted(work, 'contributorBackingForeignFallbacks'), 1);
  const recovery = createRecordVersionWorkCounters();
  await withRecordVersionWork(recovery, () => f.read());
  assert.equal(counted(recovery, 'contributorBackingColdReplays'), 1);
});

test('a committed scratch update reported as failed cannot expose a provisional proof', async (t) => {
  const f = fixture(t);
  await f.read();
  f.publish();
  f.publish();
  const exec = DatabaseSync.prototype.exec;
  let injected = false;
  DatabaseSync.prototype.exec = function (source: string) {
    const result = exec.call(this, source);
    if (
      !injected &&
      source === 'COMMIT' &&
      String(this.prepare('PRAGMA database_list').get()?.file).endsWith('/physical.sqlite')
    ) {
      injected = true;
      throw Error('Fictional committed scratch interruption');
    }
    return result;
  };
  const work = createRecordVersionWorkCounters();
  try {
    await withRecordVersionWork(work, () => f.read());
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
  assert.equal(injected, true);
  assert.equal(counted(work, 'contributorBackingOwnRosterReconciliations'), 0);
  assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
  assert.equal(counted(work, 'contributorBackingForeignFallbacks'), 1);
  assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
  const recovery = createRecordVersionWorkCounters();
  await withRecordVersionWork(recovery, () => f.read());
  assert.equal(counted(recovery, 'contributorBackingColdReplays'), 0);
});

test('contributor foreign HEAD replacement forces a full replay', async (t) => {
  const f = fixture(t);
  await f.read();
  const work = createRecordVersionWorkCounters();
  await withRecordVersionWork(work, async () => {
    f.sameByteRewrite('head');
    await f.read();
  });
  assert.equal(counted(work, 'contributorBackingIncrementalAdvances'), 0);
  assert.equal(counted(work, 'contributorBackingForeignFallbacks'), 1);
  assert.equal(counted(work, 'contributorBackingColdReplays'), 1);
  const reused = createRecordVersionWorkCounters();
  await withRecordVersionWork(reused, () => f.read());
  assert.equal(counted(reused, 'contributorBackingColdReplays'), 0);
});
