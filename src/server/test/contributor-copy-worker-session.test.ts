import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Database } from '../database.ts';
import { createProfileLifecycle } from '../profile-lifecycle.ts';
import { profilePaths } from '../profile-storage.ts';
import {
  contributorCopySourceTextInventory,
  contributorCopyWorkerWork,
  consumeContributorCopyPublicationSeal,
  disposeContributorCopyCertification,
  prepareContributorCopyCertification,
  verifyContributorCopyCertificationForPublication,
} from '../contributor-durability.ts';

test('one copy witness performs fresh complete physical scans in one private worker', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-copy-worker-session-')),
    databases = new Map<string, Database>(),
    lifecycle = createProfileLifecycle({ root, databases });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await lifecycle.create({
      name: 'Fictional worker source',
      fullName: 'Fictional worker source',
      birthDate: '1980-02-17',
    }),
    db = databases.get(source.id)!;
  const certification = await prepareContributorCopyCertification(db, root, source.id);
  try {
    assert.deepEqual(contributorCopyWorkerWork(db), { boots: 1, physicalSweeps: 4, exits: 0 });
    const inventory = await contributorCopySourceTextInventory(certification, db, root, source.id);
    assert.equal(inventory.has('owner_profile_id'), true);
    assert.deepEqual(contributorCopyWorkerWork(db), { boots: 1, physicalSweeps: 6, exits: 0 });
    const seal = await verifyContributorCopyCertificationForPublication(certification);
    consumeContributorCopyPublicationSeal(seal, certification);
    assert.deepEqual(contributorCopyWorkerWork(db), { boots: 1, physicalSweeps: 8, exits: 0 });
  } finally {
    const first = disposeContributorCopyCertification(certification);
    const second = disposeContributorCopyCertification(certification);
    assert.strictEqual(second, first, 'repeated disposal awaits the same worker exit');
    await first;
  }
  assert.deepEqual(contributorCopyWorkerWork(db), { boots: 1, physicalSweeps: 8, exits: 1 });
});

test('a later worker request refuses changed fixture-owned physical evidence', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-copy-worker-drift-')),
    databases = new Map<string, Database>(),
    lifecycle = createProfileLifecycle({ root, databases });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await lifecycle.create({
      name: 'Fictional drift source',
      fullName: 'Fictional drift source',
      birthDate: '1981-02-18',
    }),
    db = databases.get(source.id)!;
  const certification = await prepareContributorCopyCertification(db, root, source.id);
  try {
    writeFileSync(join(profilePaths(root, source.id).sources, 'fictional-late.txt'), 'fictional');
    await assert.rejects(
      verifyContributorCopyCertificationForPublication(certification),
      /Encrypted profile physical evidence changed/,
    );
    assert.equal(contributorCopyWorkerWork(db).boots, 1);
    assert.equal(contributorCopyWorkerWork(db).physicalSweeps, 4);
  } finally {
    await disposeContributorCopyCertification(certification);
  }
  assert.equal(contributorCopyWorkerWork(db).exits, 1);
});

test('aborting during worker boot drains the attempt before releasing its owner', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-copy-worker-boot-')),
    databases = new Map<string, Database>(),
    lifecycle = createProfileLifecycle({ root, databases });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await lifecycle.create({
      name: 'Fictional boot source',
      fullName: 'Fictional boot source',
      birthDate: '1982-02-19',
    }),
    db = databases.get(source.id)!,
    controller = new AbortController();
  const pending = prepareContributorCopyCertification(
    db,
    root,
    source.id,
    undefined,
    controller.signal,
  );
  controller.abort(Error('Fictional worker boot cancellation'));
  await assert.rejects(pending, /Fictional worker boot cancellation/);
  assert.deepEqual(contributorCopyWorkerWork(db), { boots: 1, physicalSweeps: 0, exits: 1 });
});

test('aborting between physical sweeps poisons the same certification', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-copy-worker-scan-')),
    databases = new Map<string, Database>(),
    lifecycle = createProfileLifecycle({ root, databases });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await lifecycle.create({
      name: 'Fictional scan source',
      fullName: 'Fictional scan source',
      birthDate: '1983-02-20',
    }),
    db = databases.get(source.id)!,
    certification = await prepareContributorCopyCertification(db, root, source.id),
    controller = new AbortController();
  const emit = Worker.prototype.emit;
  let interrupted = false;
  Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    const message = args[0] as { scanComplete?: true } | undefined;
    if (!interrupted && event === 'message' && message?.scanComplete) {
      interrupted = true;
      controller.abort(Error('Fictional worker scan cancellation'));
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    await assert.rejects(
      verifyContributorCopyCertificationForPublication(certification, controller.signal),
      /Fictional worker scan cancellation/,
    );
    assert.equal(interrupted, true);
    await assert.rejects(
      verifyContributorCopyCertificationForPublication(certification),
      /worker unavailable|scan cancellation/,
    );
  } finally {
    Worker.prototype.emit = emit;
    await disposeContributorCopyCertification(certification);
  }
  assert.equal(contributorCopyWorkerWork(db).boots, 1);
  assert.equal(contributorCopyWorkerWork(db).exits, 1);
});
