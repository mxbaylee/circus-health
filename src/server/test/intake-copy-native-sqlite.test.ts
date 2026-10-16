import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { intakeCopyNativeSqlite } from '../intake-copy-native-sqlite.ts';

const rowid = 9_007_199_254_740_993n;
const blobBytes = 16 * 1024;
const readBytes = 128;
const cycles = 256;
const workerSource = `
  const { parentPort, workerData } = require('node:worker_threads');
  const { Session } = require('node:inspector');
  const session = new Session();
  const post = (method) => new Promise((resolve, reject) =>
    session.post(method, (error, result) => error ? reject(error) : resolve(result)));
  (async () => {
    const native = (await import(workerData.adapter)).intakeCopyNativeSqlite();
    const database = [];
    let blob;
    let opened = false;
    let profileStarted = false;
    let reads = 0;
    let failure;
    try {
      const openCode = native.open(workerData.path, database, 1, null);
      opened = database[0] != null;
      if (openCode !== 0 || database[0] == null) throw Error('Fictional SQLite open failed: ' + openCode);
      session.connect();
      await post('Profiler.enable');
      await post('Profiler.start');
      profileStarted = true;
      const chunk = Buffer.alloc(workerData.readBytes);
      for (let cycle = 0; cycle < workerData.cycles; cycle++) {
        const handle = [];
        const code = native.blobOpen(database[0], 'main', 'fictional', 'value',
          BigInt(workerData.rowid), 0, handle);
        blob = handle[0];
        if (code !== 0 || handle[0] == null) throw Error('Fictional BLOB open failed: ' + code);
        if (native.blobBytes(blob) !== workerData.blobBytes)
          throw Error('Fictional BLOB byte count changed');
        for (let offset = 0; offset < workerData.blobBytes; offset += chunk.length) {
          if (native.blobRead(blob, chunk, chunk.length, offset) !== 0)
            throw Error('Fictional BLOB read failed');
          for (let index = 0; index < chunk.length; index++)
            if (chunk[index] !== (offset + index) % 251)
              throw Error('Fictional BLOB byte changed at ' + (offset + index));
          reads++;
        }
        const closeCode = native.blobClose(blob);
        blob = undefined;
        if (closeCode !== 0) throw Error('Fictional BLOB close failed: ' + closeCode);
      }
      const { profile } = await post('Profiler.stop');
      profileStarted = false;
      parentPort.postMessage({ reads, cycles: workerData.cycles,
        profilerNodes: profile.nodes.length });
    } catch (error) {
      failure = error;
    }
    if (profileStarted) {
      try { await post('Profiler.stop'); } catch (error) { failure ??= error; }
    }
    try { session.disconnect(); } catch (error) { failure ??= error; }
    if (blob) {
      try {
        if (native.blobClose(blob) !== 0) throw Error('Fictional BLOB cleanup failed');
      } catch (error) { failure ??= error; }
    }
    if (opened) {
      try {
        if (native.close(database[0]) !== 0) throw Error('Fictional SQLite close failed');
      } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  })().catch(error => { throw error; });
`;

test('native worker refuses before its host owns the addon', () => {
  const adapter = new URL('../intake-copy-native-sqlite.ts', import.meta.url).href;
  const child = `
    import { Worker } from 'node:worker_threads';
    const worker = new Worker(\`
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.adapter).then(({ intakeCopyNativeSqlite }) => {
        let outcome;
        try { intakeCopyNativeSqlite(); outcome = 'admitted'; }
        catch (error) { outcome = error.message; }
        parentPort.postMessage(outcome);
        parentPort.close();
      });
    \`, { eval: true, execArgv: [], workerData: { adapter: ${JSON.stringify(adapter)} } });
    let outcome;
    worker.on('message', value => { outcome = value; });
    worker.on('error', () => { process.exitCode = 1; });
    worker.on('exit', code => {
      if (code !== 0 || !outcome) process.exitCode = 1;
      else console.log(JSON.stringify({ outcome }));
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    outcome: 'Incremental copy native worker requires main-thread initialization',
  });
});

test('N-API SQLite BLOB calls retain exact pointers under concurrent CPU profiling', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-native-sqlite-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fictional.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE fictional(value BLOB NOT NULL)');
    const value = Buffer.allocUnsafe(blobBytes);
    for (let index = 0; index < value.length; index++) value[index] = index % 251;
    db.prepare('INSERT INTO fictional(rowid,value) VALUES(?,?)').run(rowid, value);
  } finally {
    db.close();
  }

  const adapter = new URL('../intake-copy-native-sqlite.ts', import.meta.url).href;
  intakeCopyNativeSqlite();
  const run = () =>
    new Promise<{ reads: number; cycles: number; profilerNodes: number }>((resolve, reject) => {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: { adapter, path, rowid: rowid.toString(), blobBytes, readBytes, cycles },
      });
      let result: { reads: number; cycles: number; profilerNodes: number } | undefined;
      worker.once('message', (message) => {
        result = message as typeof result;
      });
      let workerError: Error | undefined;
      worker.once('error', (error) => {
        workerError = error;
      });
      worker.once('exit', (code) => {
        if (workerError) reject(workerError);
        else if (code !== 0) reject(Error(`Fictional native worker exited with ${code}`));
        else if (!result) reject(Error('Fictional native worker omitted its result'));
        else resolve(result);
      });
    });
  const settled = await Promise.allSettled([run(), run(), run()]);
  const failures: unknown[] = [];
  const results: { reads: number; cycles: number; profilerNodes: number }[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'rejected') failures.push(outcome.reason);
    else results.push(outcome.value);
  }
  if (failures.length) throw new AggregateError(failures, 'Fictional native workers failed');
  for (const result of results) {
    assert.equal(result.cycles, cycles);
    assert.equal(result.reads, cycles * (blobBytes / readBytes));
    assert.ok(result.profilerNodes > 0);
  }

  for (const mode of ['error', 'abort'] as const) {
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(
        `
          const { parentPort, workerData } = require('node:worker_threads');
          import(workerData.adapter).then(({ intakeCopyNativeSqlite }) => {
            intakeCopyNativeSqlite();
            parentPort.postMessage('native-ready');
            if (workerData.mode === 'error')
              setImmediate(() => { throw Error('Fictional native worker failed'); });
            else parentPort.on('message', () => {});
          });
        `,
        { eval: true, workerData: { adapter, mode } },
      );
      let ready = false;
      let workerError: Error | undefined;
      worker.once('message', (message) => {
        ready = message === 'native-ready';
        if (mode === 'abort') void worker.terminate();
      });
      worker.once('error', (error) => {
        workerError = error;
      });
      worker.once('exit', (code) => {
        try {
          assert.equal(ready, true);
          assert.notEqual(code, 0);
          if (mode === 'error')
            assert.match(workerError?.message ?? '', /Fictional native worker failed/);
          else assert.equal(workerError, undefined);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }
});

test('native SQLite transport refuses a live fictional WAL database', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-native-live-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fictional.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE fictional(value TEXT)');
    db.prepare('INSERT INTO fictional(value) VALUES (?)').run('fictional');
    const native = intakeCopyNativeSqlite();
    const pointer: unknown[] = [null];
    // A second SQLite library would not share node:sqlite's POSIX lock state.
    assert.throws(() => native.open(path, pointer, 0x1, null), /refuses a WAL database/);
    assert.throws(() => native.openDisposableTransfer(path, pointer), /refuses a WAL database/);
    assert.throws(
      () => native.open(`file:${path}?mode=ro`, pointer, 0x1 | 0x40, null),
      /immutable private alias/,
    );
    assert.equal(pointer[0], null);
  } finally {
    db.close();
  }
});
