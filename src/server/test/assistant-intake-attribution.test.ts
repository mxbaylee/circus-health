import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, getIntakeRead } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
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
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-attribution-')),
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
  for (let page = 1; page <= 3; page++) {
    const scope = { sourceFileId: host.id, memberId: null, page },
      a = recordAttributionRead(old, String(page), scope, 20, 4),
      b = recordNativeAttributionRead(host, checkpoint, String(page), scope, 20, 4);
    assert.deepEqual(b, a);
    keys.push(b.scopeKey!);
    acknowledgeAttributionRead(old, a.scopeKey!);
    acknowledgeNativeAttributionRead(host, checkpoint, b.scopeKey!);
  }
  for (const request of [
    { keys, failed: false, usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 } },
    { keys: [keys[0]!], failed: true },
    { keys: [], failed: false, usage: { inputTokens: 50, outputTokens: 3, cachedInputTokens: 0 } },
  ]) {
    const a = startAttributionRequest(old, request.keys),
      b = await startNativeAttributionRequest(host, checkpoint, request.keys);
    assert.deepEqual(b, a);
    finishAttributionRequest(old, a, request);
    await finishNativeAttributionRequest(host, checkpoint, b, request);
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
});
