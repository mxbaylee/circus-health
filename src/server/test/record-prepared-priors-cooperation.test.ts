import test from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync } from 'node:fs';
import { DatabaseSync, StatementSync, constants } from 'node:sqlite';
import { createRecordPreparedPriors, type PreparedRecordPrior } from '../record-prepared-priors.ts';

const REFUSAL = /Prepared record predecessors changed, mismatched or expired/;
function prior(id: string): PreparedRecordPrior {
  return {
    entity: 'fictional',
    recordId: id,
    previousVersion: 'previous',
    deleted: false,
    preimage: { hash: 'a'.repeat(64), bytes: 7 },
  };
}
function fixture(t: test.TestContext) {
  let scratch: DatabaseSync | undefined;
  const exec = DatabaseSync.prototype.exec,
    probe = t.mock.method(
      DatabaseSync.prototype,
      'exec',
      function (this: DatabaseSync, sql: string) {
        const result = Reflect.apply(exec, this, [sql]);
        if (sql.startsWith('CREATE TABLE priors(')) scratch = this;
        return result;
      },
    );
  try {
    const priors = createRecordPreparedPriors();
    assert.ok(scratch);
    t.after(() => priors.close());
    return { priors, scratch };
  } finally {
    probe.mock.restore();
  }
}
function appendTiny(priors: ReturnType<typeof createRecordPreparedPriors>) {
  for (let id = 0; id < 128; id++) priors.append(prior(String(id)));
}

test('prior seal shares a bounded signing budget across changed keys and retains exact newest matches', async (t) => {
  const { priors, scratch } = fixture(t);
  appendTiny(priors);
  assert.equal(scratch.isTransaction, true);
  let checks = 0;
  await priors.sealAsync(() => checks++);
  // Three UTF-8 framing pieces per small row, with entry/exit and both commit guards.
  assert.equal(checks, 4 + 2 * ((128 * 3) / 64));
  assert.equal(scratch.isTransaction, false);
  for (let id = 0; id < 128; id++) {
    assert.deepEqual(priors.find('fictional', String(id)), {
      ...prior(String(id)),
      matched: false,
    });
    priors.match('fictional', String(id), {
      versionId: 'previous',
      deleted: false,
      preimage: { hash: 'a'.repeat(64), bytes: 7 },
    });
  }
  priors.finish({ reachedRoot: false });
  assert.throws(() => priors.find('fictional', '0'), REFUSAL);
});

test('prior signing preserves original JSON-array UTF-8 HMAC bytes and bounds every guarded interval', async (t) => {
  const original = crypto.createHmac;
  let key: Buffer | undefined,
    bytes = 0,
    pieces = 0,
    maxBytes = 0,
    maxPieces = 0,
    checks = 0;
  const probe = t.mock.method(crypto, 'createHmac', (...args: Parameters<typeof original>) => {
    if (Buffer.isBuffer(args[1])) key = Buffer.from(args[1]);
    const hmac = Reflect.apply(original, crypto, args),
      update = hmac.update;
    t.mock.method(hmac, 'update', function (...input: Parameters<typeof update>) {
      const chunk: unknown = input[0];
      if (typeof chunk === 'string') bytes += Buffer.byteLength(chunk);
      else if (ArrayBuffer.isView(chunk)) bytes += chunk.byteLength;
      else throw Error('Unexpected fictional HMAC input');
      pieces++;
      return Reflect.apply(update, hmac, input);
    });
    return hmac;
  });
  syncBuiltinESMExports();
  try {
    const { priors, scratch } = fixture(t),
      prefix = JSON.stringify(prior('')).indexOf('"recordId":"') + '"recordId":"'.length,
      value = prior('x'.repeat(2047 - prefix) + '\ud83d\ude80' + '\u0000"\\\ud800'.repeat(12000));
    priors.append(value);
    assert.ok(key);
    const row = scratch.prepare('SELECT value,signature FROM priors').get()!;
    assert.equal(String(row.value).charCodeAt(2047), 0xd83d);
    assert.equal(String(row.value).charCodeAt(2048), 0xde80);
    assert.equal(
      row.signature,
      original('sha256', key)
        .update(JSON.stringify([0, row.value, 0]))
        .digest('hex'),
    );
    bytes = pieces = 0;
    await priors.sealAsync(() => {
      checks++;
      maxBytes = Math.max(maxBytes, bytes);
      maxPieces = Math.max(maxPieces, pieces);
      bytes = pieces = 0;
    });
    assert.ok(checks > 4, 'the actual HMAC scan crosses a cooperative boundary');
    assert.ok(maxBytes > 0 && maxBytes <= 16384);
    assert.ok(maxPieces > 0 && maxPieces <= 64);
    assert.deepEqual(priors.find(value.entity, value.recordId), { ...value, matched: false });
    priors.match(value.entity, value.recordId, {
      versionId: 'previous',
      deleted: false,
      preimage: { hash: 'a'.repeat(64), bytes: 7 },
    });
    assert.equal(
      scratch.prepare('SELECT signature FROM priors').get()!.signature,
      original('sha256', key)
        .update(JSON.stringify([0, row.value, 1]))
        .digest('hex'),
    );
  } finally {
    probe.mock.restore();
    syncBuiltinESMExports();
    key?.fill(0);
  }
});

test('prior append build performs actual DML in one private transaction and commits once', async (t) => {
  const prepare = DatabaseSync.prototype.prepare,
    run = StatementSync.prototype.run,
    exec = DatabaseSync.prototype.exec,
    statements = new WeakMap<StatementSync, { db: DatabaseSync; sql: string }>();
  let scratch: DatabaseSync | undefined,
    writes = 0,
    autocommit = 0,
    begins = 0,
    commits = 0;
  const prepareProbe = t.mock.method(
      DatabaseSync.prototype,
      'prepare',
      function (this: DatabaseSync, sql: string) {
        const statement = Reflect.apply(prepare, this, [sql]) as StatementSync;
        statements.set(statement, { db: this, sql });
        return statement;
      },
    ),
    runProbe = t.mock.method(
      StatementSync.prototype,
      'run',
      function (this: StatementSync, ...args: Parameters<typeof run>) {
        const owner = statements.get(this);
        if (owner && owner.db === scratch && /^INSERT\b/.test(owner.sql)) {
          writes++;
          if (!owner.db.isTransaction) autocommit++;
        }
        return Reflect.apply(run, this, args);
      },
    ),
    execProbe = t.mock.method(
      DatabaseSync.prototype,
      'exec',
      function (this: DatabaseSync, sql: string) {
        const result = Reflect.apply(exec, this, [sql]);
        if (sql.startsWith('CREATE TABLE priors(')) scratch = this;
        if (this === scratch && sql === 'BEGIN') begins++;
        if (this === scratch && sql === 'COMMIT') commits++;
        return result;
      },
    );
  try {
    // Isolated native counts, not a cross-module history authority capability.
    const module = (await import(
        new URL(`../record-prepared-priors.ts?transaction-count=${randomUUID()}`, import.meta.url)
          .href
      )) as typeof import('../record-prepared-priors.ts'),
      priors = module.createRecordPreparedPriors();
    try {
      for (let id = 0; id < 64; id++) priors.append(prior(String(id)));
      assert.equal(writes, 64);
      assert.equal(autocommit, 0);
      assert.equal(begins, 1);
      assert.equal(commits, 0);
      await priors.sealAsync(() => {});
      assert.equal(commits, 1);
      assert.equal(scratch!.isTransaction, false);
      assert.deepEqual(priors.find('fictional', '63'), { ...prior('63'), matched: false });
      await assert.rejects(
        priors.sealAsync(() => {}),
        REFUSAL,
      );
      assert.equal(commits, 1);
      const path = scratch!.location()!;
      priors.close();
      assert.equal(scratch!.isOpen, false);
      assert.equal(existsSync(path), false);
    } finally {
      priors.close();
    }
  } finally {
    execProbe.mock.restore();
    runProbe.mock.restore();
    prepareProbe.mock.restore();
  }
});

for (const fault of ['cancel', 'scratch-write', 'parent-write', 'close', 'reentry'] as const)
  test(`prior sealing refuses ${fault} during a real pending yield and disposes transport`, async (t) => {
    const { priors, scratch } = fixture(t),
      parent = new DatabaseSync(':memory:'),
      abort = new AbortController();
    t.after(() => parent.close());
    parent.exec('CREATE TABLE evidence(value)');
    appendTiny(priors);
    const total = parent.prepare('SELECT total_changes() AS n'),
      original = total.get()!.n,
      path = scratch.location()!,
      sealing = priors.sealAsync(() => {
        abort.signal.throwIfAborted();
        assert.equal(total.get()!.n, original, 'original parent interval changed');
      });
    assert.equal(scratch.isTransaction, false, 'private commit precedes the pending readback');
    if (fault === 'cancel') abort.abort(new Error('Fictional prior cancellation'));
    else if (fault === 'scratch-write')
      scratch.prepare('UPDATE priors SET value=? WHERE position=127').run('forged');
    else if (fault === 'parent-write') parent.exec('INSERT INTO evidence VALUES(1)');
    else if (fault === 'close') priors.close();
    else
      await assert.rejects(
        priors.sealAsync(() => {}),
        REFUSAL,
      );
    await assert.rejects(
      sealing,
      fault === 'cancel'
        ? { message: 'Fictional prior cancellation' }
        : fault === 'parent-write'
          ? /original parent interval changed/
          : REFUSAL,
    );
    assert.equal(scratch.isOpen, false);
    assert.equal(existsSync(path), false);
    assert.throws(() => priors.find('fictional', '0'), REFUSAL);
    assert.equal(parent.isTransaction, false);
  });

for (const command of ['COMMIT', 'ROLLBACK'] as const)
  test(`prior seal refuses parent callback ${command} before its private commit`, async (t) => {
    const { priors, scratch } = fixture(t);
    priors.append(prior('one'));
    let first = true;
    await assert.rejects(
      priors.sealAsync(() => {
        if (first) {
          first = false;
          scratch.exec(command);
        }
      }),
      REFUSAL,
    );
    assert.equal(scratch.isOpen, false);
  });

test('prior commit cancellation and genuine SQL policy refusal cannot issue a sealed transport', async (t) => {
  const { priors, scratch } = fixture(t),
    abort = new AbortController();
  priors.append(prior('one'));
  let commits = 0;
  scratch.setAuthorizer((action, command) => {
    if (action === constants.SQLITE_TRANSACTION && command === 'COMMIT') {
      commits++;
      abort.abort(new Error('Fictional commit cancellation'));
    }
    return constants.SQLITE_OK;
  });
  await assert.rejects(
    priors.sealAsync(() => abort.signal.throwIfAborted()),
    { message: 'Fictional commit cancellation' },
  );
  assert.equal(commits, 1);
  assert.equal(scratch.isOpen, false);

  const denied = fixture(t);
  denied.priors.append(prior('two'));
  denied.scratch.setAuthorizer((action, command) =>
    action === constants.SQLITE_TRANSACTION && command === 'COMMIT'
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  await assert.rejects(denied.priors.sealAsync(() => {}));
  assert.equal(denied.scratch.isOpen, false);
});

test('empty prior seal still checks scoped cancellation and root absence remains mandatory', async (t) => {
  const empty = fixture(t);
  let checks = 0;
  await empty.priors.sealAsync(() => checks++);
  assert.equal(checks, 4);
  empty.priors.finish({ reachedRoot: false });
  const missing = fixture(t);
  missing.priors.append({ ...prior('new'), previousVersion: null, preimage: null });
  await missing.priors.sealAsync(() => {});
  assert.throws(() => missing.priors.finish({ reachedRoot: false }), REFUSAL);
  const cancelled = fixture(t),
    reason = new Error('Fictional entry cancellation');
  await assert.rejects(
    cancelled.priors.sealAsync(() => {
      throw reason;
    }),
    (error) => error === reason,
  );
  assert.equal(cancelled.scratch.isOpen, false);
});
