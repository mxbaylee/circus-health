/** Attribution uses addressed auxiliary records; the chat retains one reference.
 * These counters are diagnostic metadata, never reading or acceptance proof. */
import { createHash, randomUUID } from 'node:crypto';
import { assertIntakeOwner } from './intake.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import { selectedEnvelopeStore } from './intake-collection-envelope.ts';
import { createEnvelopeBuildWriter } from './intake-envelope-build.ts';
import {
  ensureIntakeAttribution,
  recordAttributionRead,
  acknowledgeAttributionRead,
  type AttributionScope,
} from './intake-attribution.ts';
import type {
  NativeAssistantCheckpoint,
  NativeAssistantConversion,
} from './assistant-intake-native.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import type { ConversionCheckpoint } from './intake-continuation.ts';

type Attribution = ReturnType<typeof ensureIntakeAttribution>;
type Counters = Attribution['totals'];
type Scope = Attribution['scopes'][string];
export interface NativeAttributionReference {
  format: 'health-intake-attribution-reference-v2';
  collection: string;
  historicalReadsUnknown: boolean;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function nativeAttributionReference(
  host: NativeAssistantConversion,
  historicalReadsUnknown = false,
): NativeAttributionReference {
  return {
    format: 'health-intake-attribution-reference-v2',
    collection:
      'reading.attribution.' + hash([host.profileId, host.sessionId, host.id, host.sha256]),
    historicalReadsUnknown,
  };
}
const counters = (): Counters => ({
  attempts: 0,
  responses: 0,
  failedAttempts: 0,
  unknownUsageAttempts: 0,
  unknownCacheAttempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
});
function context(host: NativeAssistantConversion, checkpoint: NativeAssistantCheckpoint) {
  const assertCurrent = () => {
    assertIntakeOwner(host.db, host.profileId);
    const selected = intakeSourceVersion(host.db, host.id);
    if (
      selected.version !== host.version ||
      checkpoint.intakeId !== host.id ||
      checkpoint.profileId !== host.profileId ||
      checkpoint.sourceHash !== host.sha256 ||
      checkpoint.sessionId !== host.sessionId
    )
      throw Error('Native attribution source selection changed');
  };
  assertCurrent();
  const collection =
      'reading.attribution.' + hash([host.profileId, host.sessionId, host.id, host.sha256]),
    store = selectedEnvelopeStore(host.db, { id: host.id }).collections,
    get = <T>(key: string): T | undefined => {
      assertCurrent();
      const raw = store.get(store.openView(), 'builds', collection, key);
      if (raw === undefined) return undefined;
      if (typeof raw !== 'string') throw Error('Invalid native attribution metadata');
      return JSON.parse(raw) as T;
    },
    reference = get<NativeAttributionReference>('reference') ?? {
      format: 'health-intake-attribution-reference-v2' as const,
      collection,
      historicalReadsUnknown:
        checkpoint.attribution?.historicalReadsUnknown ?? checkpoint.turns > 0,
    };
  if (
    reference.collection !== collection ||
    reference.format !== 'health-intake-attribution-reference-v2'
  )
    throw Error('Native attribution reference conflicts');
  checkpoint.attribution = reference;
  const commit = (changes: readonly IntakeCollectionChange[]) => {
    assertCurrent();
    const operationId = randomUUID();
    store.commitMaintenance(
      store.prepare(store.openView(), {
        operationId,
        requestDigest: hash(operationId),
        domainVersion: intakeSourceVersion(host.db, host.id).rawVersion,
        changes,
      }),
    );
  };
  const put = (key: string, value: unknown): IntakeCollectionChange => ({
    area: 'builds',
    collection,
    op: 'put',
    key,
    value: JSON.stringify(value),
  });
  return { collection, store, get, reference, assertCurrent, commit, put };
}

/** One explicit cold import preserves retained diagnostic counters. Old window
 * hashes remain attribution metadata and never manufacture reading evidence. */
export async function importNativeAttribution(
  host: NativeAssistantConversion,
  checkpoint: NativeAssistantCheckpoint,
  previous: ConversionCheckpoint,
  options: { assertRunning?: () => void } = {},
) {
  const ctx = context(host, checkpoint);
  if (ctx.get('legacyImported')) return;
  if (ctx.get('reference')) throw Error('Native attribution already exists without this import');
  const original = previous.attribution;
  const attempt = ctx.collection + '.import.' + randomUUID();
  const check = () => {
    options.assertRunning?.();
    ctx.assertCurrent();
    if (ctx.get('reference')) throw Error('Attribution changed during legacy import');
  };
  const writer = createEnvelopeBuildWriter(
    host.db,
    { id: host.id },
    attempt,
    intakeSourceVersion(host.db, host.id).rawVersion,
    { assertRunning: check },
  );
  const reference = nativeAttributionReference(
    host,
    original?.historicalReadsUnknown ?? previous.turns > 0,
  );
  await writer.put('reference', JSON.stringify(reference));
  await writer.put('totals', JSON.stringify(original?.totals ?? counters()));
  await writer.put('unallocated', JSON.stringify(original?.unallocated ?? counters()));
  await writer.put(
    'legacyMetadata',
    JSON.stringify({
      truncated: original?.truncated ?? false,
      untrackedReadScopes: original?.untrackedReadScopes ?? 0,
      untrackedReadWindows: original?.untrackedReadWindows ?? 0,
    }),
  );
  for (const key in original?.scopes ?? {})
    if (Object.hasOwn(original!.scopes, key))
      await writer.put('scope:' + key, JSON.stringify(original!.scopes[key]));
  for (const key in original?.windows ?? {})
    if (Object.hasOwn(original!.windows, key))
      await writer.put('window:' + hash(key), JSON.stringify(original!.windows[key]));
  await writer.put('legacyImported', 'true');
  await writer.flush();
  check();
  ctx.commit([
    {
      area: 'builds',
      collection: ctx.collection,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: attempt,
    },
  ]);
  checkpoint.attribution = reference;
}
/** One bounded legacy arithmetic object reuses its exact timing/read semantics.
 * It contains only the addressed scope/window, never the retained collections. */
export function recordNativeAttributionRead(
  host: NativeAssistantConversion,
  checkpoint: NativeAssistantCheckpoint,
  windowKey: string,
  scope: AttributionScope | null,
  textLayerCharacters?: unknown,
  durationMs?: number,
) {
  const ctx = context(host, checkpoint),
    scopeKey = scope ? hash(scope) : null,
    prior = ctx.get<number>('window:' + hash(windowKey)) ?? 0,
    target = scopeKey ? ctx.get<Scope>('scope:' + scopeKey) : undefined,
    scratch = {
      intakeId: host.id,
      sourceHash: host.sha256,
      profileId: host.profileId,
      turns: checkpoint.turns,
      attribution: {
        version: 1 as const,
        historicalReadsUnknown: ctx.reference.historicalReadsUnknown,
        truncated: false,
        untrackedReadScopes: 0,
        untrackedReadWindows: 0,
        totals: counters(),
        unallocated: counters(),
        scopes: scopeKey && target ? { [scopeKey]: target } : {},
        windows: { [windowKey]: prior },
      },
    };
  const result = recordAttributionRead(scratch, windowKey, scope, textLayerCharacters, durationMs);
  ctx.commit([
    ctx.put('reference', ctx.reference),
    ctx.put('window:' + hash(windowKey), scratch.attribution.windows[windowKey]),
    ...(result.scopeKey
      ? [ctx.put('scope:' + result.scopeKey, scratch.attribution.scopes[result.scopeKey])]
      : []),
  ]);
  return result;
}
export function acknowledgeNativeAttributionRead(
  host: NativeAssistantConversion,
  checkpoint: NativeAssistantCheckpoint,
  scopeKey: string,
) {
  const ctx = context(host, checkpoint),
    target = ctx.get<Scope>('scope:' + scopeKey);
  if (!target) return;
  const scratch = {
    intakeId: host.id,
    sourceHash: host.sha256,
    profileId: host.profileId,
    turns: checkpoint.turns,
    attribution: {
      version: 1 as const,
      historicalReadsUnknown: ctx.reference.historicalReadsUnknown,
      truncated: false,
      untrackedReadScopes: 0,
      untrackedReadWindows: 0,
      totals: counters(),
      unallocated: counters(),
      scopes: { [scopeKey]: target },
      windows: {},
    },
  };
  acknowledgeAttributionRead(scratch, scopeKey);
  ctx.commit([ctx.put('scope:' + scopeKey, target)]);
}
async function updateRequest(
  host: NativeAssistantConversion,
  checkpoint: NativeAssistantCheckpoint,
  scopeKeys: readonly string[],
  update: (counter: Counters, share: number) => void,
): Promise<string[]> {
  const ctx = context(host, checkpoint),
    before = JSON.stringify(ctx.store.collection(ctx.store.openView(), 'builds', ctx.collection)),
    attempt = 'reading.attribution.build.' + randomUUID();
  const check = () => {
    ctx.assertCurrent();
    if (
      JSON.stringify(ctx.store.collection(ctx.store.openView(), 'builds', ctx.collection)) !==
      before
    )
      throw Error('Native attribution changed during preparation');
  };
  ctx.commit(
    before === undefined
      ? [
          {
            area: 'builds',
            collection: attempt,
            op: 'put',
            key: 'reference',
            value: JSON.stringify(ctx.reference),
          },
        ]
      : [
          {
            area: 'builds',
            collection: attempt,
            op: 'adoptCollection',
            fromArea: 'builds',
            fromCollection: ctx.collection,
          },
        ],
  );
  const writer = createEnvelopeBuildWriter(
    host.db,
    { id: host.id },
    attempt,
    intakeSourceVersion(host.db, host.id).rawVersion,
    { assertRunning: check },
  );
  const scopes = [...new Set(scopeKeys)].filter((key) => !!ctx.get('scope:' + key));
  const totals = ctx.get<Counters>('totals') ?? counters();
  update(totals, 1);
  await writer.put('totals', JSON.stringify(totals));
  if (!scopes.length) {
    const unallocated = ctx.get<Counters>('unallocated') ?? counters();
    update(unallocated, 1);
    await writer.put('unallocated', JSON.stringify(unallocated));
  } else
    for (const key of scopes) {
      const target = ctx.get<Scope>('scope:' + key)!;
      update(target, 1 / scopes.length);
      await writer.put('scope:' + key, JSON.stringify(target));
    }
  await writer.put('reference', JSON.stringify(ctx.reference));
  await writer.flush();
  check();
  ctx.commit([
    {
      area: 'builds',
      collection: ctx.collection,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: attempt,
    },
  ]);
  return scopes;
}
/** scopeKeys are the bounded current provider request's exposed host call IDs. */
export function startNativeAttributionRequest(
  host: NativeAssistantConversion,
  checkpoint: NativeAssistantCheckpoint,
  scopeKeys: readonly string[],
) {
  return updateRequest(host, checkpoint, scopeKeys, (target) => {
    target.attempts++;
    target.unknownUsageAttempts++;
    target.unknownCacheAttempts++;
  });
}
export function finishNativeAttributionRequest(
  host: NativeAssistantConversion,
  checkpoint: NativeAssistantCheckpoint,
  scopeKeys: readonly string[],
  response: { failed: boolean; usage?: unknown },
) {
  const raw = response.usage as Record<string, unknown> | undefined,
    count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0,
    usage =
      raw && count(raw.inputTokens) && count(raw.outputTokens)
        ? {
            inputTokens: raw.inputTokens,
            outputTokens: raw.outputTokens,
            cachedInputTokens:
              count(raw.cachedInputTokens) && raw.cachedInputTokens <= raw.inputTokens
                ? raw.cachedInputTokens
                : null,
          }
        : null;
  return updateRequest(host, checkpoint, scopeKeys, (target, share) => {
    if (response.failed) target.failedAttempts++;
    else target.responses++;
    if (!usage) return;
    target.unknownUsageAttempts = Math.max(0, target.unknownUsageAttempts - 1);
    target.inputTokens += usage.inputTokens * share;
    target.outputTokens += usage.outputTokens * share;
    if (usage.cachedInputTokens !== null) {
      target.unknownCacheAttempts = Math.max(0, target.unknownCacheAttempts - 1);
      target.cachedInputTokens += usage.cachedInputTokens * share;
    }
  });
}

/** Diagnostic export has an explicit fixed scope cap. This is not ledger proof
 * and never changes the checkpoint or treats omitted scopes as absent. */
export function readNativeAttributionMetadata(
  host: NativeAssistantConversion,
  checkpoint: NativeAssistantCheckpoint,
  limit = 4096,
): Attribution {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096)
    throw Error('Invalid attribution export scope budget');
  const ctx = context(host, checkpoint),
    scopes: Attribution['scopes'] = {};
  let after = 'scope:',
    count = 0,
    truncated = false;
  outer: for (;;) {
    const page = ctx.store.range(ctx.store.openView(), 'builds', ctx.collection, {
      after,
      items: 32,
      bytes: 32768,
    });
    for (const entry of page.items) {
      if (!entry.key.startsWith('scope:')) break outer;
      if (count === limit) {
        truncated = true;
        break outer;
      }
      if (typeof entry.value !== 'string') throw Error('Invalid attribution scope metadata');
      scopes[entry.key.slice(6)] = JSON.parse(entry.value) as Scope;
      count++;
    }
    if (page.complete) break;
    if (!page.after || page.after === after) throw Error('Attribution cursor failed to advance');
    after = page.after;
  }
  const legacy = ctx.get<{
    truncated: boolean;
    untrackedReadScopes: number;
    untrackedReadWindows: number;
  }>('legacyMetadata');
  return {
    version: 1,
    historicalReadsUnknown: ctx.reference.historicalReadsUnknown,
    truncated: truncated || !!legacy?.truncated,
    untrackedReadScopes:
      (legacy?.untrackedReadScopes ?? 0) +
      (truncated
        ? ctx.store.rank(ctx.store.openView(), 'builds', ctx.collection, 'scope;') -
          ctx.store.rank(ctx.store.openView(), 'builds', ctx.collection, 'scope:') -
          count
        : 0),
    untrackedReadWindows: legacy?.untrackedReadWindows ?? 0,
    totals: ctx.get<Counters>('totals') ?? counters(),
    unallocated: ctx.get<Counters>('unallocated') ?? counters(),
    scopes,
    windows: {},
  };
}
