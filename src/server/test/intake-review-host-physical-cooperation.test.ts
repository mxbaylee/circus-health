import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, managedDatabaseMethodEpoch } from '../database.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import {
  prepareCollectionClinicalReviewAsync,
  prepareCollectionClinicalReviewDependencies,
} from '../intake-review-collection-host.ts';
import { collectionClinicalProjectionContextAsync } from '../intake-review-collection-session.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';

const line = JSON.stringify({
  format: 'health-record-v1',
  id: 'fictional-physical-proof',
  kind: 'document',
  payload: { text: 'Fictional source' },
  provenance: {
    capturedVia: 'Fictional export',
    sourceSystem: 'Fictional clinic',
    sourceRecordId: 'fictional-physical-proof',
    evidenceClass: 'provider_export',
    locator: 'page 1',
  },
  coverage: { status: 'complete_response', notes: [] },
  clinical: {
    kind: 'document',
    subject: 'self',
    documentTitle: 'Fictional source',
    date: '2026-01-01',
  },
});

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-host-physical-'));
  const profileId = 'fictional-profile';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional.jsonl',
    bytes: Buffer.from(line),
    newProviderName: 'Fictional clinic',
  });
  await buildIntakeCollectionEnvelope(db, { id: source.id, sha256: source.sha256 });
  await prepareCollectionReviewMembership(db, { id: source.id });
  await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id);
  const relativePath = String(
    db.prepare('SELECT path FROM source_files WHERE id=?').get(source.id)!.path,
  );
  return { db, root, profileId, source, path: profileOriginal(root, relativePath, profileId) };
}

function actOnNextProofPage(t: test.TestContext, path: string, act: () => void) {
  const original = Worker.prototype.postMessage;
  let rewrites = 0;
  Worker.prototype.postMessage = function (value, transferList) {
    const message = value as { type?: string; items?: Array<{ path?: string }> };
    if (
      rewrites === 0 &&
      message?.type === 'page' &&
      message.items?.some((item) => item.path === path)
    ) {
      act();
      rewrites++;
    }
    return original.call(this, value, transferList);
  };
  t.after(() => {
    Worker.prototype.postMessage = original;
  });
  return () => rewrites;
}

function rewriteOnNextProofPage(t: test.TestContext, path: string) {
  return actOnNextProofPage(t, path, () => {
    const before = statSync(path);
    writeFileSync(path, readFileSync(path));
    utimesSync(path, before.atime, new Date(before.mtimeMs + 2000));
  });
}

test('cooperative host refuses same-byte original rewrite before ready escapes', async (t) => {
  const { db, root, profileId, source, path } = await fixture(t);
  const rewrites = rewriteOnNextProofPage(t, path);
  await assert.rejects(
    prepareCollectionClinicalReviewAsync(db, root, profileId, source.id, null, {
      signal: t.signal,
    }),
    /Retained clinical evidence changed/,
  );
  assert.equal(rewrites(), 1);
  assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
});

test('cooperative context accessor refuses a later same-byte original rewrite', async (t) => {
  const { db, root, profileId, source, path } = await fixture(t);
  const ready = await prepareCollectionClinicalReviewAsync(db, root, profileId, source.id, null, {
    signal: t.signal,
  });
  assert.equal(ready.status, 'ready');
  if (ready.status !== 'ready') return;
  t.after(() => ready.session.close());
  const rewrites = rewriteOnNextProofPage(t, path);
  await assert.rejects(
    collectionClinicalProjectionContextAsync(ready.session, t.signal),
    /Retained clinical evidence changed/,
  );
  assert.equal(rewrites(), 1);
});

test('reused cooperative context checks its current caller rather than a released preparation lease', async (t) => {
  const { db, root, profileId, source } = await fixture(t);
  let preparing = true;
  const ready = await prepareCollectionClinicalReviewAsync(db, root, profileId, source.id, null, {
    signal: t.signal,
    assertRunning() {
      assert.equal(preparing, true, 'The initial request lease was released');
    },
  });
  assert.equal(ready.status, 'ready');
  if (ready.status !== 'ready') return;
  t.after(() => ready.session.close());
  preparing = false;
  let currentChecks = 0;
  await collectionClinicalProjectionContextAsync(ready.session, t.signal, () => {
    currentChecks++;
  });
  assert.ok(currentChecks > 1, 'Current caller checked across worker gaps');
  await assert.rejects(
    collectionClinicalProjectionContextAsync(ready.session, t.signal, () => {
      throw Error('Fictional current caller cancelled');
    }),
    /Fictional current caller cancelled/,
  );
});

for (const method of ['function', 'authorizer'] as const)
  test(`cooperative context refuses ${method} replacement during its physical proof`, async (t) => {
    const { db, root, profileId, source, path } = await fixture(t);
    const ready = await prepareCollectionClinicalReviewAsync(db, root, profileId, source.id, null, {
      signal: t.signal,
    });
    assert.equal(ready.status, 'ready');
    if (ready.status !== 'ready') return;
    t.after(() => ready.session.close());
    const actions = actOnNextProofPage(t, path, () => {
      const before = reviewReadStamp(db);
      const epoch = managedDatabaseMethodEpoch(db);
      if (method === 'function') db.function('fictional_physical_probe', () => 1);
      else db.setAuthorizer(null);
      assert.equal(reviewReadStamp(db), before, 'SQL state alone cannot detect this change');
      assert.notEqual(managedDatabaseMethodEpoch(db), epoch);
    });
    await assert.rejects(
      collectionClinicalProjectionContextAsync(ready.session, t.signal),
      /Retained clinical evidence changed/,
    );
    assert.equal(actions(), 1);
    ready.session.close();
    assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
  });
