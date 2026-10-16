import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import {
  attachRecordDurability,
  assertRecordAcceptedSourcePreimage,
  captureRecordAcceptedSourceRead,
  closeRecordAcceptedSourceRead,
  verifyRecordAcceptedSourceReadTerminal,
} from '../record-versions.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { openVault } from '../vault-store.ts';
import { freshKey } from '../vault-crypto.ts';
import { recordStringFieldDigest } from '../record-prior-fields.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';

type Work = ReturnType<typeof createRecordVersionWorkCounters>;
const counted = (work: Work, metric: keyof Work['operation']) =>
  work.operation[metric] + work.reconstruction[metric];

function traceCertificateInserts(failAt?: number) {
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
    counts: () => ({ attempts, inserts, outsideTransaction, beforeRollback, afterRollback }),
    restore: () => {
      DatabaseSync.prototype.prepare = prepare;
      DatabaseSync.prototype.exec = exec;
    },
  };
}

async function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-vault-advance-'))),
    profileId = 'fictional-vault-advance',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    key = freshKey(),
    vault = openVault({ directory: paths.root, profileId, key, initialize: true });
  attachRecordDurability(db, { profileId, storage: vault.recordStorage() });
  t.after(() => {
    if (db.isOpen) db.close();
    vault.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  });
  const original = Buffer.from('Fictional retained vault proof original.'),
    path = profilePaths(root, profileId).relativeRoot + '/sources/fictional-vault-advance.pdf',
    id = 'fictional-vault-advance-source';
  writeFileSync(join(root, path), original);
  vault.storeFile(path, original);
  vault.publish();
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
  const recordId = JSON.stringify([id]),
    versions = join(paths.root, 'vault', 'versions');
  const currentVersion = async () => {
    const row = db
      .prepare(
        "SELECT c.version_id,v.contents_json FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity='source_files' AND c.record_id=?",
      )
      .get(recordId)!;
    return {
      versionId: String(row.version_id),
      preimage: await recordStringFieldDigest(String(row.contents_json), () => {}),
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
  const read = async (check?: Awaited<ReturnType<typeof currentVersion>>) => {
    check ??= await currentVersion();
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
  const sameByteRewrite = (target: string) => {
    const bytes = readFileSync(target);
    renameSync(target, target + '.fictional-aside');
    writeFileSync(target, bytes);
    rmSync(target + '.fictional-aside');
  };
  const retainedVersion = () => join(versions, readdirSync(versions).sort()[0]!);
  const manifest = join(paths.root, 'vault', 'manifest.enc');
  return { db, currentVersion, publish, read, sameByteRewrite, retainedVersion, manifest };
}

test('vault own publications extend the retained proof instead of replaying history', async (t) => {
  const f = await fixture(t),
    cold = createRecordVersionWorkCounters();
  await withRecordVersionWork(cold, () => f.read());
  assert.equal(counted(cold, 'vaultBackingColdReplays'), 1);
  const fullReplay = counted(cold, 'vaultBackingColdDecodedVersions'),
    firstSequence = Number(
      f.db.prepare('SELECT max(sequence) AS n FROM __record_versions').get()!.n,
    );
  assert.ok(fullReplay > 0);
  const work = createRecordVersionWorkCounters(),
    publications = 6;
  let stale = await f.currentVersion();
  await withRecordVersionWork(work, async () => {
    for (let index = 0; index < publications; index++) {
      f.publish();
      const accepted = await f.currentVersion();
      await f.read(accepted);
      // The superseded version is never authorized by the advanced proof.
      await assert.rejects(f.read(stale), /predecessor differs/);
      stale = accepted;
    }
  });
  assert.equal(counted(work, 'vaultBackingColdReplays'), 0);
  assert.equal(counted(work, 'vaultBackingForeignFallbacks'), 0);
  assert.equal(counted(work, 'vaultBackingOwnHeadsRecorded'), publications);
  assert.equal(counted(work, 'vaultBackingIncrementalAdvances'), publications);
  // With one decode per replayed version, an advance decodes exactly the new
  // commits' versions; six cold replays would decode all history six times.
  const versions = (after: number) =>
      Number(
        f.db.prepare('SELECT count(*) AS n FROM __record_versions WHERE sequence>?').get(after)!.n,
      ),
    history = versions(0) - versions(firstSequence),
    incremental = counted(work, 'vaultBackingIncrementalDecodedVersions');
  assert.equal(fullReplay, history);
  assert.equal(incremental, versions(firstSequence));
  let coldEquivalent = 0;
  for (let index = 1; index <= publications; index++)
    coldEquivalent += versions(0) - versions(firstSequence + index);
  assert.ok(incremental * 5 < coldEquivalent, `${incremental} vs ${coldEquivalent}`);
});

test('vault unpaired own publication counts an advance without a reuse', async (t) => {
  const f = await fixture(t);
  await f.read();
  f.publish();
  const work = createRecordVersionWorkCounters();
  await withRecordVersionWork(work, () => f.read());
  assert.equal(counted(work, 'vaultBackingColdReplays'), 0);
  assert.equal(counted(work, 'vaultBackingIncrementalAdvances'), 1);
  assert.equal(counted(work, 'vaultBackingReuses'), 0);
});

test('vault advances more than one certificate batch in one counted replay', async (t) => {
  const f = await fixture(t);
  const trace = traceCertificateInserts();
  try {
    await f.read();
    const before = Number(f.db.prepare('SELECT max(sequence) n FROM __record_versions').get()!.n);
    f.publish(130);
    const changed = Number(
      f.db.prepare('SELECT count(*) n FROM __record_versions WHERE sequence>?').get(before)!.n,
    );
    assert.ok(changed > 64);
    const work = createRecordVersionWorkCounters();
    trace.start();
    await withRecordVersionWork(work, () => f.read());
    assert.equal(counted(work, 'vaultBackingColdReplays'), 0);
    assert.equal(counted(work, 'vaultBackingForeignFallbacks'), 0);
    assert.equal(counted(work, 'vaultBackingIncrementalAdvances'), 1);
    assert.equal(counted(work, 'vaultBackingIncrementalDecodedVersions'), changed);
    assert.equal(counted(work, 'vaultBackingCertificateWrites'), changed);
    const { inserts, outsideTransaction } = trace.counts();
    assert.ok(inserts > 64, `only ${inserts} certificate pages inserted`);
    assert.equal(outsideTransaction, 0);
  } finally {
    trace.restore();
  }
});

test('vault refuses a later certificate page insert without retaining partial proof pages', async (t) => {
  const f = await fixture(t);
  const trace = traceCertificateInserts(65);
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
    const recovery = createRecordVersionWorkCounters();
    await withRecordVersionWork(recovery, () => f.read());
    assert.ok(
      counted(failure, 'vaultBackingColdReplays') + counted(recovery, 'vaultBackingColdReplays') >=
        1,
      'the refused retained frontier is replaced by a complete cold proof',
    );
  } finally {
    trace.restore();
  }
});

test('vault advanced proof refuses a forged accepted-version preimage', async (t) => {
  const f = await fixture(t);
  await f.read();
  f.publish();
  const accepted = await f.currentVersion(),
    forged = { ...accepted.preimage, hash: createHash('sha256').update('forged').digest('hex') };
  const work = createRecordVersionWorkCounters();
  await withRecordVersionWork(work, async () => {
    await assert.rejects(f.read({ ...accepted, preimage: forged }), /predecessor differs/);
    await assert.rejects(
      f.read({
        ...accepted,
        preimage: { ...accepted.preimage, bytes: accepted.preimage.bytes + 1 },
      }),
      /predecessor differs/,
    );
    await f.read(accepted);
  });
  assert.equal(counted(work, 'vaultBackingIncrementalAdvances'), 1);
});

test('vault same-byte rewrite of a retained member around own publications forces a full replay', async (t) => {
  const f = await fixture(t);
  await f.read();
  const retainedBefore = f.retainedVersion();
  f.publish();
  const between = createRecordVersionWorkCounters();
  await withRecordVersionWork(between, async () => {
    f.sameByteRewrite(retainedBefore);
    f.publish();
    await f.read();
  });
  assert.equal(counted(between, 'vaultBackingIncrementalAdvances'), 0);
  assert.equal(counted(between, 'vaultBackingColdReplays'), 1);
  const after = createRecordVersionWorkCounters(),
    retainedAfter = f.retainedVersion();
  await withRecordVersionWork(after, async () => {
    f.publish();
    f.sameByteRewrite(retainedAfter);
    await f.read();
  });
  assert.equal(counted(after, 'vaultBackingOwnHeadsRecorded'), 1);
  assert.equal(counted(after, 'vaultBackingIncrementalAdvances'), 0);
  assert.equal(counted(after, 'vaultBackingForeignFallbacks'), 1);
  assert.equal(counted(after, 'vaultBackingColdReplays'), 1);
});

test('vault foreign manifest replacement forces a full replay', async (t) => {
  const f = await fixture(t);
  await f.read();
  f.publish();
  const work = createRecordVersionWorkCounters();
  await withRecordVersionWork(work, async () => {
    f.sameByteRewrite(f.manifest);
    await f.read();
  });
  assert.equal(counted(work, 'vaultBackingIncrementalAdvances'), 0);
  assert.equal(counted(work, 'vaultBackingForeignFallbacks'), 1);
  assert.equal(counted(work, 'vaultBackingColdReplays'), 1);
  const reused = createRecordVersionWorkCounters();
  await withRecordVersionWork(reused, () => f.read());
  assert.equal(counted(reused, 'vaultBackingColdReplays'), 0);
  assert.equal(counted(reused, 'vaultBackingReuses'), 1);
});

test('vault accepted admission waits for a held proof instead of refusing, and stays cancelable', async (t) => {
  const f = await fixture(t);
  await f.read();
  const check = await f.currentVersion(),
    work = createRecordVersionWorkCounters();
  await withRecordVersionWork(work, async () => {
    const held = await captureRecordAcceptedSourceRead(f.db, 'fictional-vault-advance', () => {});
    let canceled = false;
    const waiting = f.read(check),
      cancelable = captureRecordAcceptedSourceRead(f.db, 'fictional-vault-advance', () => {
        if (canceled) throw Error('fictional admission canceled');
      });
    await new Promise((resolve) => setTimeout(resolve, 60));
    canceled = true;
    await assert.rejects(cancelable, /fictional admission canceled/);
    try {
      await verifyRecordAcceptedSourceReadTerminal(f.db, held, 'fictional-vault-advance');
    } finally {
      closeRecordAcceptedSourceRead(held);
    }
    // The queued proof was admitted after the release and re-proved its interval.
    await waiting;
  });
  assert.equal(counted(work, 'vaultBackingAdmissionWaits'), 2);
  assert.equal(counted(work, 'vaultBackingColdReplays'), 0);
});

test('a vault accepted source proof refused by a concurrent own publication is re-proved by advancing', async (t) => {
  const { withAcceptedSourceFileFormat } = await import('../intake-accepted-source-format.ts');
  const { prepareInitialIntakeEnvelope } = await import('../intake-authority.ts');
  const f = await fixture(t),
    sourceId = 'fictional-vault-advance-source',
    initial = prepareInitialIntakeEnvelope({
      intake: { version: 1, originalName: 'fictional-vault-advance.pdf', state: 'ready' },
    });
  transaction(f.db, () => {
    f.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(initial.detailsJson, sourceId);
  });
  const accepted = (consume: () => Promise<string> | string) =>
    withAcceptedSourceFileFormat(
      f.db,
      'fictional-vault-advance',
      sourceId,
      () => {},
      consume,
      undefined,
      { idempotent: true },
    );
  // Warm: the first accepted read installs its frontier observer (a method
  // epoch change) and replays once.
  await accepted(() => 'warm');
  const warm = createRecordVersionWorkCounters();
  await withRecordVersionWork(warm, () => accepted(() => 'warm again'));
  const work = createRecordVersionWorkCounters(),
    started = gate(),
    written = gate();
  // Another request's maintenance commit on the same connection, outside the
  // held proof, publishes a new HEAD while the first attempt is consuming.
  const writer = (async () => {
    await started.opened;
    f.publish();
    written.open();
  })();
  let attempts = 0;
  const value = await withRecordVersionWork(work, () =>
    accepted(async () => {
      if (++attempts === 1) {
        started.open();
        await written.opened;
        throw Error('fictional concurrent publication refusal');
      }
      return 'accepted';
    }),
  );
  await writer;
  assert.equal(value, 'accepted');
  assert.equal(attempts, 2);
  assert.equal(counted(work, 'acceptedSourceConcurrentWriteRetries'), 1);
  assert.equal(
    counted(work, 'vaultBackingColdReplays'),
    0,
    'the retry advanced the retained proof',
  );
  assert.equal(counted(work, 'vaultBackingForeignFallbacks'), 0);
  assert.equal(counted(work, 'vaultBackingJournaledOwnHeads'), 1);
  assert.equal(counted(work, 'vaultBackingIncrementalAdvances'), 1);
  assert.equal(counted(warm, 'vaultBackingColdReplays'), 0);

  // The same own publication plus a same-byte rewrite of a retained member
  // while the proof is held: the transport is not advanced (its retention or
  // its complete acquire refuses the physical change) and the retry replays
  // cold.
  const rewritten = createRecordVersionWorkCounters(),
    again = gate(),
    done = gate(),
    retainedBefore = f.retainedVersion();
  const tamper = (async () => {
    await again.opened;
    f.publish();
    f.sameByteRewrite(retainedBefore);
    done.open();
  })();
  attempts = 0;
  assert.equal(
    await withRecordVersionWork(rewritten, () =>
      accepted(async () => {
        if (++attempts === 1) {
          again.open();
          await done.opened;
          throw Error('fictional concurrent publication refusal');
        }
        return 'accepted';
      }),
    ),
    'accepted',
  );
  await tamper;
  assert.equal(attempts, 2);
  assert.equal(counted(rewritten, 'vaultBackingIncrementalAdvances'), 0);
  assert.equal(counted(rewritten, 'vaultBackingColdReplays'), 1);
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}
