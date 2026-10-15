import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import {
  captureUnlockPhysicalWitness,
  unlockPhysicalIdentity,
  verifyUnlockPhysicalWitness,
  type UnlockPhysicalWitness,
} from '../encrypted-unlock-physical.ts';
import { stageSetupImmutableAdditions } from '../encrypted-setup-publication.ts';

function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(resolve(tmpdir(), 'circus-finish-worker-'))),
    profileId = 'fictional-finish-worker',
    dataDirectory = resolve(base, 'data'),
    root = resolve(dataDirectory, 'profiles', profileId, 'vault'),
    candidate = resolve(base, 'candidate'),
    witnessDirectory = resolve(base, 'witness'),
    witnessPath = resolve(witnessDirectory, 'physical.sqlite');
  mkdirSync(witnessDirectory);
  for (const directory of [root, candidate]) {
    mkdirSync(resolve(directory, 'objects'), { recursive: true });
    writeFileSync(resolve(directory, 'manifest.enc'), 'Fictional original manifest ciphertext');
    writeFileSync(resolve(directory, 'objects/original.enc'), 'Fictional retained ciphertext');
  }
  writeFileSync(resolve(candidate, 'objects/new.enc'), 'Fictional new ciphertext');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const original = captureUnlockPhysicalWitness(root, witnessPath),
    sql = new DatabaseSync(witnessPath, { readOnly: true }),
    originalRows = sql.prepare('SELECT * FROM physical ORDER BY path').all();
  sql.close();
  const physicalWitness = stageSetupImmutableAdditions(root, candidate, witnessPath, original);
  renameSync(resolve(candidate, 'manifest.enc'), resolve(root, 'manifest.enc'));
  return {
    root,
    witnessPath,
    originalRows,
    input: {
      dataDirectory,
      profileId,
      witnessDirectory,
      key: new Uint8Array(32).fill(0x24),
      setup: {
        task: 'finish',
        physicalWitness,
        manifestIdentity: unlockPhysicalIdentity(resolve(root, 'manifest.enc')).value,
        ownedRootIdentity: unlockPhysicalIdentity(root).value,
      },
    },
  };
}

async function finishWorker(
  t: TestContext,
  input: ReturnType<typeof fixture>['input'],
  start = true,
) {
  const entry = new URL('../encrypted-setup-worker.ts', import.meta.url),
    allowed = [
      entry.href,
      new URL('../encrypted-setup-publication.ts', import.meta.url).href,
      new URL('../encrypted-unlock-physical.ts', import.meta.url).href,
    ],
    worker = new Worker(
      `const { registerHooks } = require('node:module');
       const { parentPort, workerData } = require('node:worker_threads');
       const imports = [];
       registerHooks({ load(url, context, nextLoad) {
         if (url.startsWith('file:')) {
           if (!workerData.allowed.includes(url)) throw Error('Unexpected application import');
           imports.push(url);
         }
         return nextLoad(url, context);
       } });
       import(workerData.entry).then(() => parentPort.postMessage({ imports }));`,
      { eval: true, workerData: { ...input, entry: entry.href, allowed } },
    );
  t.after(() => worker.terminate());
  const messages: {
    ready?: boolean;
    imports?: string[];
    prepared?: { physicalWitness: UnlockPhysicalWitness };
    failure?: { status: number; code: string; message: string };
  }[] = [];
  await new Promise<void>((done, reject) => {
    worker.on('error', reject);
    worker.on('message', (message) => {
      messages.push(message);
      if (message.ready) worker.postMessage(start ? { start: true } : { cancel: true });
    });
    worker.on('exit', (code) => {
      if (code === 0) done();
      else reject(Error('Fictional finish worker exited with code ' + code));
    });
  });
  assert.equal(messages.filter((message) => message.ready).length, 1);
  assert.deepEqual(messages.find((message) => message.imports)?.imports?.sort(), allowed.sort());
  return messages;
}

test('setup finish closes its complete physical witness without loading application modules', async (t) => {
  const f = fixture(t),
    messages = await finishWorker(t, f.input),
    results = messages.filter((message) => message.prepared);
  assert.equal(results.length, 1);
  assert.equal(
    messages.some((message) => message.failure),
    false,
  );
  const witness = results[0]!.prepared!.physicalWitness;
  assert.equal(verifyUnlockPhysicalWitness(f.root, f.witnessPath, witness), witness.entries);
  const sql = new DatabaseSync(f.witnessPath, { readOnly: true });
  try {
    assert.deepEqual(sql.prepare('SELECT * FROM physical ORDER BY path').all(), f.originalRows);
  } finally {
    sql.close();
  }
});

test('setup finish still refuses a changed retained member with its original failure reply', async (t) => {
  const f = fixture(t);
  writeFileSync(resolve(f.root, 'objects/original.enc'), 'Fictional changed ciphertext');
  const messages = await finishWorker(t, f.input);
  assert.equal(
    messages.some((message) => message.prepared),
    false,
  );
  assert.deepEqual(
    messages.filter((message) => message.failure).map((message) => message.failure),
    [
      {
        status: 409,
        code: 'SETUP_PREPARATION_CHANGED',
        message: 'Profile setup changed. Retry with the saved recovery key.',
      },
    ],
  );
});

test('setup finish cancellation before start leaves its physical witness untouched', async (t) => {
  const f = fixture(t),
    before = readFileSync(f.witnessPath),
    messages = await finishWorker(t, f.input, false);
  assert.equal(
    messages.some((message) => message.prepared || message.failure),
    false,
  );
  assert.deepEqual(readFileSync(f.witnessPath), before);
});
