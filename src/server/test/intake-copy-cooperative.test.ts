import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  finishIntakeCopyStepsAsync,
  captureIntakeCopyReadInterval,
  intakeCopyNativeSelect,
} from '../intake-copy-work.ts';
import { openDatabase } from '../database.ts';
import {
  intakeCopyManualReceiptSteps,
  prepareIntakeCopyPieceSpoolSteps,
  intakeCopyTrimmedPieceSteps,
  intakeCopyTextPieces,
} from '../intake-copy-json.ts';
import { createProfileLifecycle } from '../profile-lifecycle.ts';
import type { Database } from '../database.ts';
import {
  prepareContributorCopyCertification,
  verifyContributorCopyCertificationForPublication,
  consumeContributorCopyPublicationSeal,
  disposeContributorCopyCertification,
} from '../contributor-durability.ts';
import { profilePaths } from '../profile-storage.ts';

test('original copy read interval refuses rollback ABA, TEMP shadowing and method replacement', () => {
  const db = openDatabase(':memory:', 'fictional-copy-read-interval');
  try {
    const rollback = captureIntakeCopyReadInterval(db, 'fictional-copy-read-interval');
    db.exec("BEGIN; INSERT INTO app_meta VALUES('fictional-copy-aba','temporary'); ROLLBACK");
    assert.throws(rollback, /read interval changed/);
    const temp = captureIntakeCopyReadInterval(db, 'fictional-copy-read-interval');
    db.exec('CREATE TEMP TABLE app_meta(key TEXT,value TEXT); DROP TABLE temp.app_meta');
    assert.throws(temp, /read interval changed/);
    const methods = captureIntakeCopyReadInterval(db, 'fictional-copy-read-interval'),
      original = db.prepare;
    db.prepare = function (sql: string) {
      return original.call(this, sql);
    };
    assert.throws(methods, /read interval changed/);
    db.prepare = original;
    const logical = captureIntakeCopyReadInterval(db, 'fictional-copy-read-interval');
    db.function('fictional_copy_guard', () => 1);
    assert.throws(logical, /read interval changed/);
  } finally {
    db.close();
  }
});

test('installed SQL policy cannot supply transient public prepare rows to native copy reads', () => {
  const db = openDatabase(':memory:', 'fictional-copy-native-read'),
    prepare = db.prepare;
  let installed = false,
    forged = 0;
  try {
    db.setAuthorizer((action, table) => {
      if (!installed && action === constants.SQLITE_READ && table === 'app_meta') {
        installed = true;
        db.prepare = function () {
          forged++;
          db.prepare = prepare;
          return prepare.call(this, "SELECT 'fictional-forged-owner' AS value");
        };
      }
      return constants.SQLITE_OK;
    });
    const selected = intakeCopyNativeSelect(
      db,
      "SELECT value FROM main.app_meta WHERE key='owner_profile_id'",
    );
    assert.equal(selected.get()?.value, 'fictional-copy-native-read');
    assert.equal([...selected.iterate()][0]?.value, 'fictional-copy-native-read');
    assert.equal(forged, 0, 'copy reads cannot consume a policy-supplied public statement');
    db.prepare = prepare;
    assert.equal(installed, true, 'the original installed policy genuinely authorized compilation');
  } finally {
    db.prepare = prepare;
    db.setAuthorizer(null);
    db.close();
  }
});

test('read interval acquisition rejects ABA writes from later native witness compilation', () => {
  const db = openDatabase(':memory:', 'fictional-copy-acquisition');
  let changed = false;
  try {
    db.setAuthorizer((action, name) => {
      if (!changed && action === constants.SQLITE_PRAGMA && name === 'schema_version') {
        changed = true;
        db.exec(
          "INSERT INTO app_meta VALUES('fictional-copy-compile-aba','temporary'); DELETE FROM app_meta WHERE key='fictional-copy-compile-aba'",
        );
      }
      return constants.SQLITE_OK;
    });
    assert.throws(
      () => captureIntakeCopyReadInterval(db, 'fictional-copy-acquisition'),
      /read interval changed/,
    );
    assert.equal(changed, true, 'the installed policy actually performed a restored write');
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key='fictional-copy-compile-aba'").get(),
      undefined,
    );
  } finally {
    db.setAuthorizer(null);
    db.close();
  }
});

test(
  'giant receipt, unknown keys and whitespace scanning yield before completion and cancel without a result',
  { timeout: 90000 },
  async () => {
    const giant = 'Independently fictional cooperative value '.repeat(60000);
    let ticks = 0,
      running = true;
    const heartbeat = () => {
      if (running) {
        ticks++;
        setImmediate(heartbeat);
      }
    };
    setImmediate(heartbeat);
    try {
      const result = await finishIntakeCopyStepsAsync(
        intakeCopyManualReceiptSteps(
          intakeCopyTextPieces(
            JSON.stringify({
              actor: 'profile-owner',
              unknown: { [giant]: giant },
              person: { noteId: giant, personId: giant },
            }),
          ),
        ),
      );
      assert.ok(result);
      assert.ok(ticks > 100, 'giant field work must expose repeated cooperative boundaries');
      const controller = new AbortController(),
        before = ticks;
      const cancel = () => {
        if (ticks - before >= 8) controller.abort(Error('fictional cancellation'));
        else setImmediate(cancel);
      };
      setImmediate(cancel);
      await assert.rejects(
        finishIntakeCopyStepsAsync(
          prepareIntakeCopyPieceSpoolSteps(
            intakeCopyTrimmedPieceSteps(
              intakeCopyTextPieces(' ' + giant + ' '.repeat(giant.length)),
            ),
          ),
          controller.signal,
        ),
        /fictional cancellation/,
      );
    } finally {
      running = false;
    }
  },
);

test('closing the authorized lifecycle at validated preparation prevents target publication', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-copy-cancellation-')),
    databases = new Map<string, Database>();
  let cancel = false;
  const lifecycle = createProfileLifecycle({
    root,
    databases,
    copyCheckpoint(point) {
      if (cancel && point === 'validated') lifecycle.close();
    },
  });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await lifecycle.create({
    name: 'Fictional cancellation source',
    fullName: 'Fictional cancellation source',
    birthDate: '1987-01-08',
  });
  const db = databases.get(source.id)!,
    before = db.prepare('SELECT key,value FROM app_meta ORDER BY key').all();
  const controller = new AbortController();
  const preparing = prepareContributorCopyCertification(
    db,
    root,
    source.id,
    undefined,
    controller.signal,
  );
  setImmediate(() => controller.abort(Error('fictional worker startup cancellation')));
  await assert.rejects(preparing, /fictional worker startup cancellation/);
  cancel = true;
  await assert.rejects(
    lifecycle.create(
      { name: 'Fictional never-published copy', operationId: randomUUID() },
      source.id,
    ),
    /stopped|closed/,
  );
  assert.deepEqual([...databases.keys()], [source.id]);
  assert.deepEqual(db.prepare('SELECT key,value FROM app_meta ORDER BY key').all(), before);
});

for (const point of ['before-export', 'before-publication'] as const)
  for (const fault of ['sql-aba', 'policy'] as const)
    test(`original copy source ${fault} at ${point} refuses target publication`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'fictional-copy-final-source-')),
        databases = new Map<string, Database>();
      let sourceDb: Database | undefined,
        targetId: string | undefined,
        changed = false;
      const lifecycle = createProfileLifecycle({
        root,
        databases,
        copyCheckpoint(current, operation) {
          if (sourceDb && !changed && current === point) {
            changed = true;
            targetId = operation.targetProfileId;
            if (fault === 'sql-aba')
              sourceDb.exec(
                "INSERT INTO app_meta VALUES('fictional-copy-final-aba','temporary'); DELETE FROM app_meta WHERE key='fictional-copy-final-aba'",
              );
            else sourceDb.setAuthorizer(() => constants.SQLITE_OK);
          }
        },
      });
      t.after(() => {
        lifecycle.close();
        for (const db of databases.values()) if (db.isOpen) db.close();
        rmSync(root, { recursive: true, force: true });
      });
      const source = await lifecycle.create({
        name: 'Fictional final source',
        fullName: 'Fictional final source',
        birthDate: '1986-03-02',
      });
      sourceDb = databases.get(source.id)!;
      const before = sourceDb.prepare('SELECT key,value FROM app_meta ORDER BY key').all(),
        copyInput = { name: 'Fictional guarded copy', operationId: randomUUID() };
      await assert.rejects(lifecycle.create(copyInput, source.id), /original.*(changed|interval)/);
      assert.equal(changed, true);
      assert.equal(existsSync(profilePaths(root, targetId!).root), false);
      assert.deepEqual([...databases.keys()], [source.id]);
      assert.deepEqual(
        sourceDb.prepare('SELECT key,value FROM app_meta ORDER BY key').all(),
        before,
      );
      assert.equal(lifecycle.isLocked(source.id), false);
      const retry = await lifecycle.create(copyInput, source.id);
      assert.equal(
        retry.id,
        targetId,
        'an unpublished retry retains its original operation identity',
      );
    });

test('late lifecycle cancellation releases retained source proof without publishing a target', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-copy-late-cancel-')),
    databases = new Map<string, Database>();
  let targetId: string | undefined;
  const lifecycle = createProfileLifecycle({
    root,
    databases,
    copyCheckpoint(point, operation) {
      if (point === 'before-export') {
        targetId = operation.targetProfileId;
        lifecycle.close();
      }
    },
  });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await lifecycle.create({
    name: 'Fictional late cancellation',
    fullName: 'Fictional late cancellation',
    birthDate: '1984-04-14',
  });
  await assert.rejects(
    lifecycle.create({ name: 'Fictional cancelled copy', operationId: randomUUID() }, source.id),
    /closed|stopped/,
  );
  assert.equal(existsSync(profilePaths(root, targetId!).root), false);
  assert.equal(lifecycle.isLocked(source.id), false);
  assert.deepEqual([...databases.keys()], [source.id]);
});

test('published copy retry remains valid after genuine source removal', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-copy-independent-recovery-')),
    databases = new Map<string, Database>();
  const lifecycle = createProfileLifecycle({ root, databases });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await lifecycle.create({
      name: 'Fictional removable source',
      fullName: 'Fictional removable source',
      birthDate: '1983-05-12',
    }),
    copyInput = { name: 'Fictional independent copy', operationId: randomUUID() },
    target = await lifecycle.create(copyInput, source.id);
  lifecycle.remove(source.id, { confirmationName: source.name, version: source.nameVersion });
  assert.equal(databases.has(source.id), false);
  assert.equal(existsSync(profilePaths(root, source.id).root), false);
  const copy = databases.get(target.id)!;
  copy.close();
  databases.delete(target.id);
  const recovered = await lifecycle.create(copyInput, source.id);
  assert.equal(recovered.id, target.id);
  assert.equal(recovered.name, copyInput.name);
  assert.equal(databases.has(target.id), true);
});

test('final source publication seal is exact-certificate bound, one-use and callback-free', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-copy-source-seal-')),
    databases = new Map<string, Database>(),
    lifecycle = createProfileLifecycle({ root, databases });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await lifecycle.create({
      name: 'Fictional sealed source',
      fullName: 'Fictional sealed source',
      birthDate: '1981-02-09',
    }),
    db = databases.get(source.id)!;
  let policyReads = 0,
    policyCalls = 0;
  db.setAuthorizer((action) => {
    policyCalls++;
    if (action === constants.SQLITE_READ) policyReads++;
    return constants.SQLITE_OK;
  });
  const certification = await prepareContributorCopyCertification(db, root, source.id);
  let other: Awaited<ReturnType<typeof prepareContributorCopyCertification>> | undefined;
  try {
    policyReads = 0;
    const verification = verifyContributorCopyCertificationForPublication(certification);
    assert.ok(policyReads > 0, 'final verification preflight must retain genuine SQL policy');
    // The synchronous preflight finishes before worker events can reach the host.
    policyReads = 0;
    policyCalls = 0;
    const seal = await verification;
    consumeContributorCopyPublicationSeal(seal, certification);
    assert.equal(
      policyReads,
      0,
      'final worker and source continuation must not call installed SQL policy',
    );
    assert.equal(policyCalls, 0, 'final worker and source continuation must make no policy calls');
    assert.throws(() => consumeContributorCopyPublicationSeal(seal, certification), /unavailable/);
    other = await prepareContributorCopyCertification(db, root, source.id);
    const foreign = await verifyContributorCopyCertificationForPublication(certification);
    assert.throws(() => consumeContributorCopyPublicationSeal(foreign, other!), /unavailable/);
    assert.throws(
      () => consumeContributorCopyPublicationSeal(foreign, certification),
      /unavailable/,
    );
  } finally {
    if (other) disposeContributorCopyCertification(other);
    disposeContributorCopyCertification(certification);
  }
});
