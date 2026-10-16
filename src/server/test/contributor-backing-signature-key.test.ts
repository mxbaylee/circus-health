import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { unlockPhysicalEntries, unlockPhysicalIdentity } from '../encrypted-unlock-physical.ts';
import type { ContributorRecordBackingInput } from '../contributor-record-staging.ts';

interface Observation {
  keyCreations: number;
  signHmacs: number;
  rawSignHmacs: number;
  erased: boolean;
}
interface Reply {
  id?: number;
  ready?: boolean;
  checkpoint?: boolean;
  refused?: boolean;
  result?: { entries: number };
  observation?: Observation;
}

function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-backing-key-'))),
    base = join(root, 'authority'),
    marker = join(root, 'marker'),
    physical = join(root, 'physical.sqlite'),
    signatureKey = randomBytes(32),
    nonce = randomUUID();
  mkdirSync(base);
  mkdirSync(join(base, 'objects'));
  for (let index = 0; index < 100; index++)
    writeFileSync(join(base, 'objects', String(index)), 'Independently fictional object ' + index);
  writeFileSync(marker, 'Independently fictional selection marker');
  const rows = [...unlockPhysicalEntries(base)],
    sql = new DatabaseSync(physical),
    sign = (path: string, kind: string, identity: string) =>
      createHmac('sha256', signatureKey)
        .update(JSON.stringify([nonce, path, kind, identity]))
        .digest('hex');
  try {
    sql.exec(
      'CREATE TABLE physical(path TEXT PRIMARY KEY,kind TEXT,identity TEXT,signature TEXT);' +
        'CREATE TABLE own_additions(name TEXT,identity TEXT,sha256 TEXT,bytes INTEGER,signature TEXT);' +
        'CREATE TABLE consumed_sources(sequence INTEGER,source TEXT,signature TEXT);' +
        'CREATE TABLE original_artifacts(sequence INTEGER,id TEXT,path TEXT,identity TEXT,signature TEXT);',
    );
    const insert = sql.prepare('INSERT INTO physical VALUES(?,?,?,?)'),
      selected = unlockPhysicalIdentity(marker);
    insert.run(
      '@marker',
      selected.kind,
      selected.value,
      sign('@marker', selected.kind, selected.value),
    );
    for (const row of rows)
      insert.run(row.path, row.kind, row.identity, sign(row.path, row.kind, row.identity));
  } finally {
    sql.close();
  }
  const input: ContributorRecordBackingInput = {
    mode: 'verify',
    root,
    base,
    marker,
    physical,
    signatureKey,
    nonce,
    profileId: 'fictional-backing-key',
    selectedHead: 'fictional-unused-head',
    database: join(root, 'unused-replay.sqlite'),
    entries: rows.length,
    checkpointControl: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  };
  t.after(() => {
    signatureKey.fill(0);
    rmSync(root, { recursive: true, force: true });
  });
  return { input, rows, file: join(base, rows.find((row) => row.kind === 'file')!.path) };
}

function observedWorker(t: TestContext) {
  const entry = new URL('../contributor-record-backing-worker.ts', import.meta.url).href;
  // Observe real native crypto calls in the actual worker, without replacing
  // signatures or exposing keys. The input reference detects existing erasure.
  const worker = new Worker(
    `
    const crypto = require('node:crypto');
    const { syncBuiltinESMExports } = require('node:module');
    const { parentPort } = require('node:worker_threads');
    const hmac = crypto.createHmac, secret = crypto.createSecretKey;
    let observation, cloned;
    parentPort.on('message', message => {
      cloned = message.input.signatureKey;
      observation = { keyCreations: 0, signHmacs: 0, rawSignHmacs: 0 };
    });
    crypto.createSecretKey = function(key, ...args) {
      if (observation) observation.keyCreations++;
      return secret.call(this, key, ...args);
    };
    crypto.createHmac = function(algorithm, key, ...args) {
      if (observation && new Error().stack.includes('at sign (')) {
        observation.signHmacs++;
        if (key instanceof Uint8Array) observation.rawSignHmacs++;
      }
      return hmac.call(this, algorithm, key, ...args);
    };
    syncBuiltinESMExports();
    const post = parentPort.postMessage;
    parentPort.postMessage = function(message, ...args) {
      if (message.result || message.refused)
        message = {...message, observation: {...observation,
          erased: cloned.every(byte => byte === 0)}};
      return post.call(this, message, ...args);
    };
    import(${JSON.stringify(entry)});
  `,
    { eval: true, workerData: null },
  );
  t.after(async () => {
    await worker.terminate();
  });
  const ready = new Promise<void>((resolve, reject) => {
    worker.once('message', (message: Reply) => {
      if (message.ready !== true) reject(Error('Fictional worker did not become ready'));
      else resolve();
    });
    worker.once('error', reject);
  });
  let id = 0;
  return async (input: ContributorRecordBackingInput, checkpoint?: (ordinal: number) => void) => {
    await ready;
    const selected = ++id;
    return await new Promise<Reply>((resolve, reject) => {
      let checkpoints = 0;
      const message = (row: Reply) => {
        if (row.id !== selected) {
          reject(Error('Fictional worker changed job'));
          return;
        }
        if (row.checkpoint) {
          try {
            checkpoint?.(++checkpoints);
          } catch (error) {
            reject(error);
          } finally {
            const control = new Int32Array(input.checkpointControl);
            Atomics.store(control, 0, 0);
            Atomics.notify(control, 0);
          }
        } else {
          worker.off('message', message);
          worker.off('error', reject);
          resolve(row);
        }
      };
      worker.on('message', message);
      worker.once('error', reject);
      worker.postMessage({ id: selected, input });
    });
  };
}

test('contributor signatures convert one private native key per job while retaining every HMAC', async (t) => {
  const f = fixture(t),
    run = observedWorker(t);
  for (let job = 0; job < 2; job++) {
    const result = await run(f.input);
    assert.equal(result.refused, undefined);
    assert.equal(result.result!.entries, f.rows.length);
    assert.deepEqual(result.observation, {
      keyCreations: 1,
      signHmacs: 2 * (f.rows.length + 1),
      rawSignHmacs: 0,
      erased: true,
    });
    assert.ok(
      f.input.signatureKey.some((byte) => byte !== 0),
      'parent key was cloned, not erased',
    );
  }
  const foreign = await run({ ...f.input, signatureKey: randomBytes(32) });
  assert.equal(foreign.refused, true, 'a later job cannot reuse the prior key');
  assert.deepEqual(foreign.observation, {
    keyCreations: 1,
    signHmacs: 1,
    rawSignHmacs: 0,
    erased: true,
  });
});

for (const phase of ['initial', 'closing'] as const)
  test(`contributor native key reuse retains ${phase} physical refusal and key erasure`, async (t) => {
    const f = fixture(t),
      run = observedWorker(t);
    let changed = false;
    const result = await run(f.input, (ordinal) => {
      if (ordinal === (phase === 'initial' ? 1 : 2)) {
        changed = true;
        writeFileSync(f.file, 'Independently fictional changed object');
      }
    });
    assert.equal(changed, true);
    assert.equal(result.refused, true);
    assert.equal(result.observation!.keyCreations, 1);
    assert.equal(result.observation!.rawSignHmacs, 0);
    assert.ok(result.observation!.signHmacs > 0);
    assert.equal(result.observation!.erased, true);
  });
