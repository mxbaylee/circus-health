import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createAssistant } from '../assistant.ts';
import { readChat, writeChat } from '../assistant-journal.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import { readIntakeBatch, writeIntakeBatch } from '../intake-batch-journal.ts';
import { uploadIntake } from '../intake.ts';
import { newProfile, vaultFixture } from './helpers/vault-fixture.ts';
import { observeVaultQueueWork } from './helpers/vault-queue-work.ts';
import { fictionalModel } from './fictional-model.ts';

async function fixture(t: test.TestContext) {
  fictionalModel(t);
  const f = vaultFixture(t);
  const created = await newProfile(f.manager, 'Fictional queue publication person');
  const state = f.manager.opened.get(created.profile.id)!;
  const databases = new Map([[state.id, state.db]]);
  const assistant = createAssistant({
    root: state.root,
    databases,
    availability: () => ({ available: false, readiness: 'unavailable' }),
    connectionCheck: async () => ({ available: false, readiness: 'unavailable' }),
  });
  let instant = 0;
  const batches = createIntakeBatchManager({
    root: state.root,
    databases,
    assistant,
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, instant++)),
    journalWriter(root, profileId, batch, reason) {
      writeIntakeBatch(root, profileId, batch, reason);
      f.manager.flush(profileId, { duringLock: true });
    },
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    batches.close();
    assistant.close();
  };
  t.after(close);
  const source = uploadIntake(state.db, state.root, state.id, {
    filename: 'fictional-queue-source.txt',
    newProviderName: 'Fictional queue clinic',
    bytes: Buffer.from('Independently fictional original retained during queue publication.'),
  });
  const batch = batches.create(state.id, {
    operationId: 'fictional-queue-publication',
    intakeIds: [source.id],
  });
  return { ...f, created, state, batches, batch, close };
}

test('real encrypted manager changes and response flush remain bounded at 0/100/200/300 retained transitions', async (t) => {
  const f = await fixture(t);
  const { id } = f.state;
  const directory = join(f.state.workspace, 'intake-batches', f.batch.id, 'events');
  const first = fs.readdirSync(directory).find((name) => name.endsWith('.json'))!;
  const original = fs.readFileSync(join(directory, first));
  const sourceMetadata = f.state.vault.metadata();
  const originalName = Object.keys(sourceMetadata.files).find((name) =>
    name.startsWith('sources/'),
  )!;
  const originalCiphertext = fs.readFileSync(
    join(f.manager.pathFor(id), 'vault/objects', sourceMetadata.files[originalName] + '.enc'),
  );
  const stop = () =>
    observeVaultQueueWork(() => {
      const batch = f.batches.stop(id, f.batch.id);
      // The foreground response performs this generic flush after the queue
      // writer and accepted-record hooks. Include its complete real I/O.
      f.manager.flush(id);
      return batch;
    });
  let last = stop();
  const samples = [{ transitions: 0, work: last.work }];
  for (let transition = 1; transition <= 300; transition++) {
    if (transition % 2) f.batches.resume(id, f.batch.id);
    else {
      last = stop();
      if (transition % 100 === 0) samples.push({ transitions: transition, work: last.work });
    }
  }
  for (const sample of samples) {
    assert.equal(sample.work.queue.directoryReads, 0);
    assert.equal(sample.work.queue.directoryEntries, 0);
    assert.ok(sample.work.queue.stats < 100);
    assert.ok(sample.work.queue.readBytes < 10_000);
    assert.ok(sample.work.queue.writeBytes < 5_000);
    assert.ok(sample.work.indices.readBytes < 10_000);
    assert.ok(sample.work.indices.writeBytes < 10_000);
    assert.ok(sample.work.sha256Bytes < 50_000);
  }
  for (const sample of samples.slice(2)) {
    for (const field of [
      'opens',
      'stats',
      'metadataChecks',
      'syncs',
      'mutations',
      'directoryReads',
      'directoryEntries',
      'reads',
      'writes',
    ] as const)
      assert.equal(sample.work.queue[field], samples[1].work.queue[field]);
    // Fixed-width filenames, plus at most a few decimal counter digits in the
    // current marker/index usage. No retained payload or reference list grows.
    assert.ok(sample.work.queue.readBytes <= samples[1].work.queue.readBytes + 16);
    assert.ok(sample.work.queue.writeBytes <= samples[1].work.queue.writeBytes + 4);
    assert.deepEqual(sample.work.otherWorkspace, samples[1].work.otherWorkspace);
    assert.equal(sample.work.indices.opens, samples[1].work.indices.opens);
    assert.ok(sample.work.indices.writeBytes <= samples[1].work.indices.writeBytes + 32);
    assert.ok(sample.work.sha256Bytes <= samples[1].work.sha256Bytes + 64);
  }
  assert.deepEqual(fs.readFileSync(join(directory, first)), original);
  assert.deepEqual(
    fs.readFileSync(
      join(f.manager.pathFor(id), 'vault/objects', sourceMetadata.files[originalName] + '.enc'),
    ),
    originalCiphertext,
  );
  assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.json')).length, 302);
  f.close();
  f.manager.lock(id);
  fs.rmSync(join(f.manager.pathFor(id), 'cache'), { recursive: true, force: true });
  f.manager.unlock(id, f.created.recoveryKit);
  const reopened = f.manager.opened.get(id)!;
  assert.deepEqual(readIntakeBatch(reopened.root, id, f.batch.id), last.value);
  t.diagnostic(
    JSON.stringify({
      samples,
      scope:
        'Real encrypted queue manager Stop, accepted-record hooks and generic response flush. Non-queue workspace scans are measured separately and still depend on unrelated workspace contents; cold reopen is excluded.',
    }),
  );
});

test('all pending queue selections publish with coupled chat/source files and never adopt orphan tails or locks', async (t) => {
  const f = await fixture(t);
  const { id, root, workspace, vault } = f.state;
  f.batches.stop(id, f.batch.id);
  let batch = readIntakeBatch(root, id, f.batch.id);
  const directory = join(workspace, 'intake-batches', batch.id, 'events');
  batch.reason = 'fictional pending first';
  writeIntakeBatch(root, id, batch, 'first pending');
  batch.reason = 'fictional pending second';
  writeIntakeBatch(root, id, batch, 'second pending');
  const chat = {
    id: randomUUID(),
    title: 'Fictional coupled chat',
    messages: [{ content: 'Fictional source decision' }],
  };
  writeChat(root, id, chat, 'coupled');
  fs.writeFileSync(
    join(workspace, 'sources', 'fictional-pending-original.txt'),
    'fictional pending original',
  );
  const selectedHead = JSON.parse(fs.readFileSync(join(directory, 'current'), 'utf8'));
  const orphanSequence = Number(selectedHead.tail.name.slice(0, 12)) + 1;
  const orphan = String(orphanSequence).padStart(12, '0') + '-' + randomUUID() + '.json';
  const priorEvent = JSON.parse(fs.readFileSync(join(directory, selectedHead.tail.name), 'utf8'));
  fs.writeFileSync(
    join(directory, orphan),
    JSON.stringify({
      ...priorEvent,
      sequence: orphanSequence,
      previous: selectedHead.tail,
      reason: 'fictional complete unselected tail',
    }),
  );
  const pending = join(directory, 'fictional.pending');
  fs.writeFileSync(pending, 'fictional incomplete stage');
  const before = Object.keys(vault.metadata().files).filter(
    (name) => name.startsWith('intake-batches/') && name.endsWith('.json'),
  ).length;
  // Staging updates fingerprints but is not an acknowledgement. The next
  // generic flush must publish pending bindings even without changed bytes.
  vault.syncWorkspace(workspace, {
    excludeDirectory: (name) => name === 'intake-batches',
    exclude: (name) =>
      ['record-stream/', 'db/', 'personal/', 'curation/'].some((prefix) =>
        name.startsWith(prefix),
      ) ||
      name.endsWith('.pending') ||
      name.endsWith('/writer.lock'),
    publishNow: false,
  });
  f.manager.flush(id);
  const files = Object.keys(vault.metadata().files);
  assert.equal(
    files.filter((name) => name.startsWith('intake-batches/') && name.endsWith('.json')).length,
    before + 2,
  );
  assert.ok(files.some((name) => name.startsWith(`chats/${chat.id}/events/`)));
  assert.ok(files.includes('sources/fictional-pending-original.txt'));
  assert.equal(
    files.some(
      (name) => name.includes(orphan) || name.endsWith('.pending') || name.endsWith('/writer.lock'),
    ),
    false,
  );
  // External crash-tail injection invalidates the live writer fingerprint;
  // reopen the selected chain before its next publication.
  batch = readIntakeBatch(root, id, f.batch.id);
  batch.reason = 'fictional accepted-record coupled selection';
  writeIntakeBatch(root, id, batch, 'record head coupling');
  // The real record storage hook stages workspace dependencies and selects
  // them together with the unchanged accepted-record authority head.
  f.state.recordStorage.publishHead(f.state.recordStorage.read('head')!);
  const settled = observeVaultQueueWork(() => f.manager.flush(id));
  assert.equal(settled.work.queue.stats, 0, 'successful record publication drains selected names');
  f.close();
  f.manager.lock(id);
  f.manager.unlock(id, f.created.recoveryKit);
  const reopened = f.manager.opened.get(id)!;
  assert.equal(readIntakeBatch(reopened.root, id, batch.id).reason, batch.reason);
  assert.deepEqual(readChat(reopened.root, id, chat.id), chat);
  assert.equal(
    reopened.vault.readFile('sources/fictional-pending-original.txt')!.toString(),
    'fictional pending original',
  );
});

test('uncertain plaintext current rename is republished into the real encrypted manifest on retry', async (t) => {
  const f = await fixture(t);
  const { id, root, workspace } = f.state;
  f.batches.stop(id, f.batch.id);
  f.close();
  const batch = readIntakeBatch(root, id, f.batch.id);
  batch.reason = 'fictional selected rename with uncertain acknowledgement';
  const current = join(workspace, 'intake-batches', batch.id, 'events/current');
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = ((from, to) => {
    const result = originalRename(from, to);
    if (!injected && String(to) === current) {
      injected = true;
      throw Error('fictional selected current rename fault');
    }
    return result;
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => writeIntakeBatch(root, id, batch, 'uncertain'),
      /fictional selected current rename fault/,
    );
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
  assert.ok(injected);
  const recovered = readIntakeBatch(root, id, batch.id);
  assert.equal(recovered.reason, batch.reason);
  writeIntakeBatch(root, id, recovered, 'identical retry');
  f.manager.flush(id);
  f.manager.lock(id);
  f.manager.unlock(id, f.created.recoveryKit);
  assert.deepEqual(readIntakeBatch(f.manager.opened.get(id)!.root, id, batch.id), recovered);
});

for (const after of [false, true])
  test(`real encrypted manifest fault ${after ? 'after' : 'before'} replacement requires reopen and selects exact queue state`, async (t) => {
    const f = await fixture(t);
    const { id, root, vault } = f.state;
    const before = f.batches.stop(id, f.batch.id);
    f.close();
    const next = readIntakeBatch(root, id, f.batch.id);
    next.reason = 'fictional candidate after encrypted fault';
    writeIntakeBatch(root, id, next, 'fault candidate');
    const originalRename = fs.renameSync;
    let injected = false;
    fs.renameSync = ((from, to) => {
      if (!injected && String(to) === join(f.manager.pathFor(id), 'vault/manifest.enc')) {
        injected = true;
        if (after) originalRename(from, to);
        throw Error('fictional encrypted manifest publication fault');
      }
      return originalRename(from, to);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => f.manager.flush(id), /fictional encrypted manifest publication fault/);
    } finally {
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
    }
    assert.ok(injected);
    assert.throws(() => vault.publish(), /Profile is locked/);
    assert.throws(() => f.manager.lock(id), /Profile is locked/);
    f.manager.unlock(id, f.created.recoveryKit);
    const reopened = f.manager.opened.get(id)!;
    assert.deepEqual(readIntakeBatch(reopened.root, id, f.batch.id), after ? next : before);
  });
