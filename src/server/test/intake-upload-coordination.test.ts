import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { createApp } from '../index.ts';
import * as intake from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  hasIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-upload-coordination-'));
  const profileId = 'fictional-upload-coordination-profile';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const aBytes = Buffer.from('Independently fictional legacy original A');
  const a = intake.uploadIntake(db, root, profileId, {
    filename: 'fictional-a.txt',
    newProviderName: 'Fictional clinic',
    mimeType: 'text/plain',
    bytes: aBytes,
  });
  const unavailable = () => ({ available: false, readiness: 'unavailable' });
  const app = createApp({
    root,
    databases: new Map([[profileId, db]]),
    assistantOptions: {
      availability: unavailable,
      connectionCheck: async () => unavailable(),
      bridgeFactory() {
        throw new Error('No model calls in fictional upload coordination fixture');
      },
    },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      app.close();
    }
  };
  t.after(() => {
    close();
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/${profileId}/intakes`;
  const bBytes = Buffer.from('Independently fictional HTTP original B');
  const upload = () =>
    fetch(base, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'x-filename': 'fictional-b.txt',
        'x-source-name': 'Fictional%20clinic',
        'content-type': 'text/plain',
      },
      body: bBytes,
    });
  return { root, profileId, db, a, aBytes, bBytes, upload, close };
}
function checkpoint(db: ReturnType<typeof openDatabase>, id: string) {
  const { collections } = selectedEnvelopeStore(db, { id });
  const page = collections.range(collections.openView(), 'builds', 'schema.resume', {
    items: 16,
    bytes: 65536,
  });
  assert.equal(page.complete, true);
  assert.equal(page.items.length, 1);
  const value = page.items[0]!.value;
  assert.equal(typeof value, 'string');
  assert.ok(JSON.parse(value as string).count > 0);
  return value;
}
// Observe the actual fully received fictional bytes while an existing owner prevents
// publication. This is a public HTTP/filesystem oracle, not a private queue hook.
async function fullyReceived(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  while (true) {
    t.signal.throwIfAborted();
    try {
      for (const dir of readdirSync(join(f.root, '.upload-staging'))) {
        const bytes = readFileSync(join(f.root, '.upload-staging', dir, 'original'));
        if (bytes.equals(f.bBytes)) return;
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    await setImmediate();
  }
}

test(
  'HTTP upload received during another source conversion preserves both originals and native readiness',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      reached = gate(),
      release = gate();
    let paused = false;
    const converting = buildIntakeCollectionEnvelope(
      f.db,
      { id: f.a.id },
      {
        async onCheckpoint() {
          if (!paused) {
            paused = true;
            checkpoint(f.db, f.a.id);
            reached.resolve();
            await release.promise;
          }
        },
      },
    );
    t.signal.addEventListener('abort', release.resolve, { once: true });
    await reached.promise;
    const uploading = f.upload();
    t.after(async () => {
      release.resolve();
      await Promise.allSettled([uploading, converting]);
    });
    try {
      await fullyReceived(t, f);
      assert.equal(
        f.db.prepare("SELECT count(*) n FROM source_files WHERE kind='intake_original'").get()!.n,
        1,
        'The fully received second original is not published while conversion owns the lane',
      );
    } finally {
      release.resolve();
      await Promise.allSettled([uploading, converting]);
    }
    assert.ok(await converting);
    const response = await uploading;
    assert.equal(response.status, 201, await response.clone().text());
    const item = (await response.json()).data;
    for (const id of [f.a.id, item.id])
      assert.equal(hasIntakeCollectionEnvelope(f.db, { id }), true);
    assert.deepEqual(intake.getIntakeOriginal(f.db, f.root, f.profileId, f.a.id).bytes, f.aBytes);
    assert.deepEqual(intake.getIntakeOriginal(f.db, f.root, f.profileId, item.id).bytes, f.bBytes);
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM source_files WHERE kind='intake_original'").get()!.n,
      2,
    );
    const retry = await f.upload();
    assert.equal(retry.status, 201);
    const repeated = (await retry.json()).data;
    assert.equal(repeated.id, item.id);
    assert.equal(repeated.repeatedUpload, true);
    assert.deepEqual(readdirSync(join(f.root, '.upload-staging')), []);
  },
);
test(
  'queued same-source ensure cannot deadlock a current owner that prepares it first',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      entered = gate(),
      release = gate();
    let externalComplete = false;
    const owner = runExclusiveClinicalOperation(f.db, async () => {
      entered.resolve();
      await release.promise;
      await intake.ensureNativeIntakeSchema(f.db, f.profileId, f.a.id);
      return intakeWorkCounters(f.db).warm.schemaBuildOperations;
    });
    await entered.promise;
    const external = intake.ensureNativeIntakeSchema(f.db, f.profileId, f.a.id).then(() => {
      externalComplete = true;
    });
    t.signal.addEventListener('abort', release.resolve, { once: true });
    t.after(async () => {
      release.resolve();
      await Promise.allSettled([owner, external]);
    });
    try {
      await setImmediate();
      assert.equal(externalComplete, false);
    } finally {
      release.resolve();
      await Promise.allSettled([owner, external]);
    }
    const [work] = await Promise.all([owner, external]);
    assert.equal(externalComplete, true);
    assert.equal(hasIntakeCollectionEnvelope(f.db, { id: f.a.id }), true);
    assert.equal(
      intakeWorkCounters(f.db).warm.schemaBuildOperations,
      work,
      'Queued caller reused ready schema with no second build',
    );
  },
);
for (const change of ['abort', 'real rolled-back SQL', 'close'] as const)
  test(`queued conversion keeps original refusal: ${change}`, { timeout: 30000 }, async (t) => {
    const f = await fixture(t),
      reached = gate(),
      release = gate();
    let paused = false;
    const controller = new AbortController();
    t.signal.addEventListener('abort', release.resolve, { once: true });
    const building = buildIntakeCollectionEnvelope(
      f.db,
      { id: f.a.id },
      {
        assertRunning: () => controller.signal.throwIfAborted(),
        async onCheckpoint() {
          if (!paused) {
            paused = true;
            checkpoint(f.db, f.a.id);
            reached.resolve();
            await release.promise;
          }
        },
      },
    );
    const rejected = assert.rejects(
      building,
      change === 'real rolled-back SQL'
        ? /authority changed/
        : change === 'close'
          ? /no longer active|database unavailable/
          : /Fictional caller cancellation/,
    );
    t.after(async () => {
      release.resolve();
      await Promise.allSettled([building, rejected]);
    });
    await reached.promise;
    const before = checkpoint(f.db, f.a.id);
    try {
      if (change === 'abort') controller.abort(new Error('Fictional caller cancellation'));
      else if (change === 'close') f.close();
      else {
        f.db.exec('SAVEPOINT fictional_write');
        f.db
          .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
          .run('fictional_coordination_probe', '1');
        f.db.exec('ROLLBACK TO fictional_write');
        f.db.exec('RELEASE fictional_write');
      }
    } finally {
      release.resolve();
    }
    await rejected;
    if (change !== 'close') {
      assert.equal(hasIntakeCollectionEnvelope(f.db, { id: f.a.id }), false);
      assert.equal(checkpoint(f.db, f.a.id), before, 'Refusal did not publish another checkpoint');
      await intake.ensureNativeIntakeSchema(f.db, f.profileId, f.a.id);
      assert.equal(hasIntakeCollectionEnvelope(f.db, { id: f.a.id }), true);
      assert.deepEqual(intake.getIntakeOriginal(f.db, f.root, f.profileId, f.a.id).bytes, f.aBytes);
    }
  });

test(
  'independent direct same-source borrower reuses authenticated ready schema without another publication',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      reached = gate(),
      release = gate();
    let paused = false;
    const first = buildIntakeCollectionEnvelope(
      f.db,
      { id: f.a.id },
      {
        async onCheckpoint() {
          if (!paused) {
            paused = true;
            reached.resolve();
            await release.promise;
          }
        },
      },
    );
    await reached.promise;
    let done = false;
    const second = buildIntakeCollectionEnvelope(f.db, { id: f.a.id }).then((value) => {
      done = true;
      return value;
    });
    t.signal.addEventListener('abort', release.resolve, { once: true });
    t.after(async () => {
      release.resolve();
      await Promise.allSettled([first, second]);
    });
    try {
      await setImmediate();
      assert.equal(done, false);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
    const [built, reused] = await Promise.all([first, second]);
    assert.ok(built);
    assert.equal(reused, undefined);
    assert.equal(hasIntakeCollectionEnvelope(f.db, { id: f.a.id }), true);
    assert.equal(intakeWorkCounters(f.db).warm.schemaBuildOperations, built.work.operations);
    assert.deepEqual(intake.getIntakeOriginal(f.db, f.root, f.profileId, f.a.id).bytes, f.aBytes);
  },
);

test(
  'fully received HTTP upload is cleaned when its database owner closes before publication',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      reached = gate(),
      release = gate();
    t.signal.addEventListener('abort', release.resolve, { once: true });
    const original = intake.getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, f.a.id);
    let paused = false;
    const building = buildIntakeCollectionEnvelope(
      f.db,
      { id: f.a.id },
      {
        async onCheckpoint() {
          if (!paused) {
            paused = true;
            reached.resolve();
            await release.promise;
          }
        },
      },
    );
    const refused = assert.rejects(building, /no longer active|database unavailable/);
    await reached.promise;
    const upload = f.upload();
    t.after(async () => {
      release.resolve();
      await Promise.allSettled([building, refused, upload]);
    });
    try {
      await fullyReceived(t, f);
      const dirs = readdirSync(join(f.root, '.upload-staging'));
      assert.equal(dirs.length, 1);
      assert.deepEqual(
        readFileSync(join(f.root, '.upload-staging', dirs[0]!, 'original')),
        f.bBytes,
        'B is fully staged before closing',
      );
      assert.equal(
        f.db.prepare("SELECT count(*) n FROM source_files WHERE kind='intake_original'").get()!.n,
        1,
        'Queued B has not published',
      );
      f.close();
    } finally {
      release.resolve();
      await Promise.allSettled([building, refused, upload]);
    }
    await refused;
    const response = await upload;
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, 'INTERNAL_ERROR');
    assert.deepEqual(readdirSync(join(f.root, '.upload-staging')), []);
    assert.deepEqual(readFileSync(original.path), f.aBytes);
    const reopened = new DatabaseSync(ensureProfileDirectories(f.root, f.profileId).database, {
      readOnly: true,
    });
    try {
      const rows = reopened
        .prepare("SELECT id,sha256 FROM source_files WHERE kind='intake_original'")
        .all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.id, f.a.id);
      assert.equal(rows[0]!.sha256, original.sourceHash);
    } finally {
      reopened.close();
    }
  },
);
