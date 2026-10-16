import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPrivateEnvelopeCandidate } from '../intake-envelope-candidate.ts';

const priorTmpdir = process.env.TMPDIR;
const suiteTmpdir = mkdtempSync(join(tmpdir(), 'fictional-candidate-signing-'));
process.env.TMPDIR = suiteTmpdir;
after(() => {
  if (priorTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = priorTmpdir;
  rmSync(suiteTmpdir, { recursive: true, force: true });
});

const identity = {
  profileId: 'fictional-candidate-signing',
  intakeId: 'fictional-intake',
  sourceHash: crypto.createHash('sha256').update('Independently fictional source').digest('hex'),
};
const workspaces = () => readdirSync(suiteTmpdir).sort();

function observeSigning(t: test.TestContext) {
  const secretKey = crypto.createSecretKey,
    hmac = crypto.createHmac;
  const conversions: Array<{ input: Buffer; oracle: Buffer; key: crypto.KeyObject }> = [];
  let hmacCalls = 0,
    objectHmacCalls = 0;
  crypto.createSecretKey = new Proxy(secretKey, {
    apply(target, thisArg, args) {
      const input = args[0];
      assert.ok(Buffer.isBuffer(input), 'the candidate converts its private Buffer');
      const key: crypto.KeyObject = Reflect.apply(target, thisArg, args);
      conversions.push({ input, oracle: Buffer.from(input), key });
      return key;
    },
  });
  crypto.createHmac = (...args: Parameters<typeof hmac>) => {
    hmacCalls++;
    if (args[1] instanceof crypto.KeyObject) objectHmacCalls++;
    return hmac(...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    crypto.createSecretKey = secretKey;
    crypto.createHmac = hmac;
    syncBuiltinESMExports();
    for (const entry of conversions) entry.oracle.fill(0);
  });
  return {
    conversions,
    hmac,
    get hmacCalls() {
      return hmacCalls;
    },
    get objectHmacCalls() {
      return objectHmacCalls;
    },
  };
}

function fixture(t: test.TestContext, assertOriginal: () => void = () => {}) {
  const db = new DatabaseSync(':memory:'),
    exec = DatabaseSync.prototype.exec;
  let scratch: DatabaseSync | undefined;
  DatabaseSync.prototype.exec = function (sql) {
    const result = exec.call(this, sql);
    if (sql.includes('CREATE TABLE reader_transitions(')) scratch = this;
    return result;
  };
  let candidate: ReturnType<typeof createPrivateEnvelopeCandidate>;
  try {
    candidate = createPrivateEnvelopeCandidate({
      db,
      nodePrefix: 'fictional:node:',
      identity,
      collection: 'data',
      descriptor: { kind: 'map', root: null, bytes: 0 },
      readOriginal: () => undefined,
      assertOriginal,
    });
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
  t.after(() => {
    candidate.close();
    db.close();
  });
  assert.ok(scratch);
  return { db, scratch, candidate };
}

function populate(candidate: ReturnType<typeof createPrivateEnvelopeCandidate>, count = 128) {
  for (let offset = 0; offset < count; offset += 64)
    candidate.apply(
      Array.from({ length: Math.min(64, count - offset) }, (_, index) => ({
        area: 'builds' as const,
        collection: 'data',
        op: 'put' as const,
        key: String(offset + index).padStart(5, '0'),
        value: 'Fictional literal \\ \u0000 \u00e9 ' + (offset + index),
      })),
    );
}

test('private candidate converts one key and retains exact fresh node and reader HMACs', async (t) => {
  const observed = observeSigning(t),
    { candidate, scratch } = fixture(t);
  populate(candidate, 384);
  candidate.recordReaderCoverageTransition(identity.intakeId, 'before', 'after', [
    { kind: 'plan', key: 'fictional-plan', value: 'literal \\ \u0000 \u00e9' },
    { kind: 'unit', key: 'fictional-unit', value: 'literal unit' },
  ]);
  assert.equal(observed.conversions.length, 1);
  const converted = observed.conversions[0]!;
  const nodes = scratch.prepare('SELECT hash,raw,ref,signature FROM nodes').all();
  assert.ok(nodes.length > 384);
  for (const row of nodes)
    assert.equal(
      row.signature,
      observed
        .hmac('sha256', converted.oracle)
        .update(String(row.hash))
        .update(String(row.ref))
        .update(String(row.raw))
        .digest('hex'),
    );
  for (const row of scratch.prepare('SELECT * FROM reader_transitions').all())
    assert.equal(
      row.signature,
      observed
        .hmac('sha256', converted.oracle)
        .update(JSON.stringify([row.source, row.after, row.before, row.pass]))
        .digest('hex'),
    );
  for (const row of scratch.prepare('SELECT * FROM reader_effects').all())
    assert.equal(
      row.signature,
      observed
        .hmac('sha256', converted.oracle)
        .update(JSON.stringify([row.source, row.after, row.kind, row.key, row.value, row.pass]))
        .digest('hex'),
    );
  assert.deepEqual(
    [...candidate.readerCoverageRows()],
    [
      { kind: 'transition', sourceId: identity.intakeId, before: 'before', after: 'after' },
      {
        kind: 'effect',
        sourceId: identity.intakeId,
        after: 'after',
        effectKind: 'plan',
        key: 'fictional-plan',
        value: 'literal \\ \u0000 \u00e9',
      },
      {
        kind: 'effect',
        sourceId: identity.intakeId,
        after: 'after',
        effectKind: 'unit',
        key: 'fictional-unit',
        value: 'literal unit',
      },
    ],
  );
  const roster = await candidate.seal(),
    rows = [...roster.rows()],
    digest = crypto.createHash('sha256');
  for (const row of rows) digest.update(row.hash).update(row.raw);
  assert.equal(rows.length, roster.count);
  assert.equal(roster.descriptor.root?.count, 384);
  assert.equal(digest.digest('hex'), roster.digest);
  assert.equal(candidate.store.get('00000'), 'Fictional literal \\ \u0000 \u00e9 0');
  assert.equal(candidate.store.get('missing'), undefined);
  assert.ok(
    observed.hmacCalls > nodes.length,
    'signing and every roster verification still create fresh HMACs',
  );
  assert.equal(observed.objectHmacCalls, observed.hmacCalls);
  assert.equal(
    observed.conversions.length,
    1,
    'seal and row verification reuse conversion, not evidence',
  );
  candidate.close();
  assert.deepEqual(
    converted.input,
    Buffer.alloc(32),
    'the original Buffer is still explicitly wiped',
  );
});

test('private signing keys remain isolated and close revokes retained row iterators', async (t) => {
  const observed = observeSigning(t),
    first = fixture(t),
    second = fixture(t);
  populate(first.candidate);
  populate(second.candidate);
  first.candidate.recordReaderCoverageTransition(identity.intakeId, 'before', 'after', [
    { kind: 'plan', key: 'plan', value: 'value' },
  ]);
  assert.equal(observed.conversions.length, 2);
  assert.notEqual(observed.conversions[0]!.key, observed.conversions[1]!.key);
  const firstNode = first.scratch.prepare('SELECT * FROM nodes ORDER BY hash LIMIT 1').get()!,
    secondNode = second.scratch.prepare('SELECT * FROM nodes WHERE hash=?').get(firstNode.hash)!;
  assert.equal(firstNode.raw, secondNode.raw);
  assert.notEqual(firstNode.signature, secondNode.signature);
  assert.notEqual(
    firstNode.signature,
    observed
      .hmac('sha256', observed.conversions[1]!.oracle)
      .update(String(firstNode.hash))
      .update(String(firstNode.ref))
      .update(String(firstNode.raw))
      .digest('hex'),
  );
  const roster = await first.candidate.seal(),
    rows = roster.rows(),
    coverage = first.candidate.readerCoverageRows();
  assert.equal(rows.next().done, false);
  assert.equal(coverage.next().done, false);
  first.candidate.close();
  const before = observed.hmacCalls;
  // SQLite can refuse its already-finalized iterator before the next row proof.
  assert.throws(() => rows.next(), /workspace changed|statement has been finalized/);
  assert.throws(() => coverage.next(), /workspace changed/);
  assert.throws(() => first.candidate.apply([]), /workspace changed/);
  assert.throws(() => first.candidate.store.get('00000'), /workspace changed/);
  assert.equal(observed.hmacCalls, before, 'revoked closures cannot produce another HMAC');
  assert.deepEqual(observed.conversions[0]!.input, Buffer.alloc(32));
  assert.equal(second.candidate.store.get('00000'), 'Fictional literal \\ \u0000 \u00e9 0');
});

test('construction failure after conversion wipes its Buffer and closes scratch', (t) => {
  const observed = observeSigning(t),
    db = new DatabaseSync(':memory:'),
    before = workspaces(),
    exec = DatabaseSync.prototype.exec,
    reason = Error('Fictional candidate initialization failure');
  let scratch: DatabaseSync | undefined;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.includes('CREATE TABLE reader_transitions(')) {
      scratch = this;
      throw reason;
    }
    return exec.call(this, sql);
  };
  try {
    assert.throws(
      () =>
        createPrivateEnvelopeCandidate({
          db,
          nodePrefix: 'fictional:node:',
          identity,
          collection: 'data',
          descriptor: { kind: 'map', root: null, bytes: 0 },
          readOriginal: () => undefined,
          assertOriginal() {},
        }),
      (error) => error === reason,
    );
  } finally {
    DatabaseSync.prototype.exec = exec;
    db.close();
  }
  assert.equal(observed.conversions.length, 1);
  assert.deepEqual(observed.conversions[0]!.input, Buffer.alloc(32));
  assert.equal(scratch?.isOpen, false);
  assert.deepEqual(workspaces(), before);
});

for (const operation of ['seal', 'finalize'] as const)
  for (const refusal of ['throw', 'close'] as const)
    test(`${operation} yielded ${refusal} revokes signing before further work`, async (t) => {
      const observed = observeSigning(t),
        before = workspaces(),
        { candidate, scratch } = fixture(t),
        reason = Error('Fictional candidate cancellation');
      if (operation === 'seal') populate(candidate);
      else
        candidate.apply(
          Array.from({ length: 16 }, (_, index) => ({
            area: 'builds' as const,
            collection: 'part' + index,
            op: 'put' as const,
            key: 'one',
            value: 'Fictional',
          })),
        );
      let checkpoints = 0,
        stoppedHmacs = -1;
      const checkpoint = () => {
        if (++checkpoints !== (operation === 'seal' ? 2 : 1)) return;
        stoppedHmacs = observed.hmacCalls;
        if (refusal === 'throw') throw reason;
        candidate.close();
      };
      await assert.rejects(
        operation === 'seal'
          ? candidate.seal(checkpoint)
          : candidate.finalizeBuilds(
              Array.from({ length: 16 }, (_, index) => 'part' + index),
              checkpoint,
            ),
        (error) =>
          refusal === 'throw' ? error === reason : /workspace changed/.test(String(error)),
      );
      assert.ok(stoppedHmacs >= 0, 'the refusal happens at the actual yielded checkpoint');
      assert.equal(observed.hmacCalls, stoppedHmacs);
      assert.deepEqual(observed.conversions[0]!.input, Buffer.alloc(32));
      assert.equal(scratch.isOpen, false);
      assert.throws(candidate.check, /workspace changed/);
      assert.deepEqual(workspaces(), before);
    });

test('reader coverage callback close refuses before signReader can use a retained key', (t) => {
  const observed = observeSigning(t),
    { candidate, scratch } = fixture(t);
  let stoppedHmacs = -1;
  const effects = function* () {
    candidate.close();
    stoppedHmacs = observed.hmacCalls;
    yield { kind: 'plan', key: 'plan', value: 'Fictional' };
  };
  assert.throws(
    () => candidate.recordReaderCoverageTransition(identity.intakeId, 'before', 'after', effects()),
    /workspace changed/,
  );
  assert.equal(observed.hmacCalls, stoppedHmacs);
  assert.equal(scratch.isOpen, false);
  assert.deepEqual(observed.conversions[0]!.input, Buffer.alloc(32));
});

test('original-current callback close refuses before node signing', (t) => {
  const observed = observeSigning(t);
  let closeOnCheck = false;
  const { candidate, scratch } = fixture(t, () => {
    if (closeOnCheck) candidate.close();
  });
  populate(candidate, 1);
  closeOnCheck = true;
  const before = observed.hmacCalls;
  assert.throws(() => populate(candidate, 1), /workspace changed/);
  assert.equal(observed.hmacCalls, before);
  assert.equal(scratch.isOpen, false);
  assert.deepEqual(observed.conversions[0]!.input, Buffer.alloc(32));
});
