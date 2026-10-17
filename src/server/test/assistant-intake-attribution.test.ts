import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, getIntakeRead } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { reportSnapshotInlineTextFits } from '../intake-report-snapshot-catalog.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  nativeAssistantConversion,
  type NativeAssistantCheckpoint,
} from '../assistant-intake-native.ts';
import {
  recordNativeAttributionRead,
  acknowledgeNativeAttributionRead,
  startNativeAttributionRequest,
  finishNativeAttributionRequest,
  readNativeAttributionMetadata,
  nativeAttributionReference,
} from '../assistant-intake-attribution.ts';
import {
  ensureIntakeAttribution,
  recordAttributionRead,
  acknowledgeAttributionRead,
  startAttributionRequest,
  finishAttributionRequest,
} from '../intake-attribution.ts';

test('native addressed attribution matches legacy arithmetic without checkpoint collections and exports explicit omissions', async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-native-attribution-'))),
    profile = 'fictional',
    db = openDatabase(ensureProfileDirectories(root, profile).database, profile);
  attachPersonalDurability(db, { root, profileId: profile });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profile, {
    filename: 'fictional.txt',
    bytes: Buffer.from('Fictional source'),
  });
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  const selected = getIntakeRead(db, root, profile, source.id);
  if (!('format' in selected)) throw Error('Expected native metadata');
  const host = nativeAssistantConversion(db, root, profile, 'fictional-session', selected);
  const checkpoint: NativeAssistantCheckpoint = {
    format: 'health-intake-conversion-checkpoint-v2',
    intakeId: host.id,
    profileId: profile,
    sourceHash: host.sha256,
    sessionId: host.sessionId,
    planId: 'fictional-plan',
    inventoryId: 'fictional-index',
    activeUnitId: 'fictional-unit',
    ledgerId: 'fictional-ledger',
    version: host.version,
    turns: 0,
    modelRequests: 0,
    measuredModelTokens: 0,
    modelUsageIncomplete: false,
    unmeasuredRequests: 0,
    usableModelResponses: 0,
    attribution: nativeAttributionReference(host),
  };
  const old = {
    intakeId: host.id,
    profileId: profile,
    sourceHash: host.sha256,
    turns: 0,
    attribution: undefined as ReturnType<typeof ensureIntakeAttribution> | undefined,
  };
  const keys: string[] = [];
  const transactions = () =>
    Number(db.prepare('SELECT count(*) AS n FROM __record_transactions').get()!.n);
  const nodesWritten = () => {
    const work = intakeWorkCounters(db);
    return work.warm.collectionNodesWritten + work.reconstruction.collectionNodesWritten;
  };
  for (let page = 1; page <= 3; page++) {
    const scope = { sourceFileId: host.id, memberId: null, page },
      a = recordAttributionRead(old, String(page), scope, 20, 4),
      b = await recordNativeAttributionRead(host, checkpoint, String(page), scope, 20, 4);
    assert.deepEqual(b, a);
    keys.push(b.scopeKey!);
    acknowledgeAttributionRead(old, a.scopeKey!);
    await acknowledgeNativeAttributionRead(host, checkpoint, b.scopeKey!);
  }
  for (const request of [
    { keys, failed: false, usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 } },
    { keys: [keys[0]!], failed: true },
    { keys: [], failed: false, usage: { inputTokens: 50, outputTokens: 3, cachedInputTokens: 0 } },
  ]) {
    const a = startAttributionRequest(old, request.keys),
      beforeStart = transactions(),
      nodesBeforeStart = nodesWritten(),
      b = await startNativeAttributionRequest(host, checkpoint, request.keys);
    assert.equal(transactions() - beforeStart, 1, 'bounded request start publishes once');
    assert.ok(nodesWritten() - nodesBeforeStart <= 32, 'bounded start writes only addressed nodes');
    assert.deepEqual(b, a);
    finishAttributionRequest(old, a, request);
    const beforeFinish = transactions(),
      nodesBeforeFinish = nodesWritten();
    await finishNativeAttributionRequest(host, checkpoint, b, request);
    assert.equal(transactions() - beforeFinish, 1, 'bounded request finish publishes once');
    assert.ok(
      nodesWritten() - nodesBeforeFinish <= 32,
      'bounded finish writes only addressed nodes',
    );
  }
  const native = readNativeAttributionMetadata(host, checkpoint);
  assert.deepEqual(native.totals, old.attribution!.totals);
  assert.deepEqual(native.unallocated, old.attribution!.unallocated);
  assert.deepEqual(native.scopes, old.attribution!.scopes);
  assert.equal('scopes' in checkpoint.attribution!, false);
  const capped = readNativeAttributionMetadata(host, checkpoint, 1);
  assert.equal(capped.truncated, true);
  assert.equal(capped.untrackedReadScopes, 2);
  assert.equal(Object.keys(capped.scopes).length, 1);

  const collection = nativeAttributionReference(host).collection,
    store = selectedEnvelopeStore(db, { id: source.id }).collections,
    rawScope = store.get(store.openView(), 'builds', collection, 'scope:' + keys[0]);
  assert.equal(typeof rawScope, 'string');
  const extraKeys = Array.from({ length: 60 }, (_, index) => `fictional-extra-${index}`),
    operationId = randomUUID();
  store.commitMaintenance(
    await store.prepareAsync(store.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: host.version,
      changes: extraKeys.map((key) => ({
        area: 'builds',
        collection,
        op: 'put',
        key: 'scope:' + key,
        value: rawScope as string,
      })),
    }),
  );
  const beforeWide = transactions();
  const nodesBeforeWide = nodesWritten();
  const totalsBeforeWide = readNativeAttributionMetadata(host, checkpoint).totals;
  const wide = await startNativeAttributionRequest(host, checkpoint, [...keys, ...extraKeys]);
  assert.equal(wide.length, 63);
  assert.ok(transactions() - beforeWide >= 3, 'over-budget request retains scratch publications');
  assert.ok(nodesWritten() - nodesBeforeWide > 64, 'wide fallback keeps its bounded chunks');
  const wideMetadata = readNativeAttributionMetadata(host, checkpoint),
    sourceScope = JSON.parse(rawScope as string) as {
      attempts: number;
      unknownUsageAttempts: number;
    };
  assert.equal(wideMetadata.totals.attempts, totalsBeforeWide.attempts + 1);
  assert.equal(wideMetadata.totals.unknownUsageAttempts, totalsBeforeWide.unknownUsageAttempts + 1);
  for (const key of extraKeys) {
    assert.equal(wideMetadata.scopes[key]?.attempts, sourceScope.attempts + 1);
    assert.equal(
      wideMetadata.scopes[key]?.unknownUsageAttempts,
      sourceScope.unknownUsageAttempts + 1,
    );
  }

  const originalScope = JSON.parse(rawScope as string) as Record<string, unknown>;
  originalScope.attempts = 9;
  let padded = '';
  for (let length = 8192; length >= 0; length--) {
    const candidate = JSON.stringify({ ...originalScope, fictionalPadding: 'x'.repeat(length) });
    if (reportSnapshotInlineTextFits(candidate)) {
      padded = candidate;
      break;
    }
  }
  assert.ok(padded);
  const largeKey = 'fictional-large-scope',
    largeId = randomUUID();
  store.commitMaintenance(
    await store.prepareAsync(store.openView(), {
      operationId: largeId,
      requestDigest: createHash('sha256').update(largeId).digest('hex'),
      domainVersion: host.version,
      changes: [{ area: 'builds', collection, op: 'put', key: 'scope:' + largeKey, value: padded }],
    }),
  );
  assert.equal(reportSnapshotInlineTextFits(padded), true);
  const beforeLarge = transactions();
  await assert.rejects(startNativeAttributionRequest(host, checkpoint, [largeKey]));
  assert.equal(transactions() - beforeLarge, 1, 'oversize update takes the existing scratch path');
  assert.equal(store.get(store.openView(), 'builds', collection, 'scope:' + largeKey), padded);

  const beforeCancellation = transactions();
  const canceled = new Promise<void>((resolve) =>
    setImmediate(() => {
      checkpoint.sessionId = 'fictional-canceled-session';
      resolve();
    }),
  );
  const pending = startNativeAttributionRequest(host, checkpoint, []);
  await canceled;
  await assert.rejects(pending, /attribution source selection changed/i);
  checkpoint.sessionId = host.sessionId;
  assert.equal(transactions(), beforeCancellation, 'canceled update makes no publication');
  const beforeConcurrent = transactions();
  const beforeLogical = store.binding(store.openView())!.logical;
  const beforeContext = {
    sessionId: checkpoint.sessionId,
    version: host.version,
    reference: structuredClone(checkpoint.attribution),
  };
  const changed = new Promise<void>((resolve, reject) =>
    setImmediate(async () => {
      try {
        await recordNativeAttributionRead(host, checkpoint, 'fictional-concurrent-window', {
          sourceFileId: host.id,
          memberId: null,
          page: 100,
        });
        resolve();
      } catch (error) {
        reject(error);
      }
    }),
  );
  const stale = startNativeAttributionRequest(host, checkpoint, []);
  // Genuine async admission can fence this concurrent candidate before its
  // collection guard observes the other accepted write. Keep the exact owner
  // expiry cases and the original one-publication oracle below.
  const refused = assert.rejects(
    stale,
    /attribution changed during preparation|legacy bridge original read authority changed|Contributor original staging owner changed/i,
  );
  await changed;
  await refused;
  assert.deepEqual(store.binding(store.openView())!.logical, beforeLogical);
  assert.deepEqual(
    { sessionId: checkpoint.sessionId, version: host.version, reference: checkpoint.attribution },
    beforeContext,
  );
  assert.equal(transactions() - beforeConcurrent, 1, 'stale update adds no second publication');
});
