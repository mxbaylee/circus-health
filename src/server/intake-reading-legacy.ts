/** Durable legacy checkpoint evidence remains session scoped: hashes do not
 * manufacture literal windows, and completion IDs do not replace coverage. */
import { randomUUID, createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { HttpError, type Database } from './database.ts';
import { selectedEnvelopeStore } from './intake-collection-envelope.ts';
import { createEnvelopeBuildWriter } from './intake-envelope-build.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import { workflowHash } from './intake-workflow.ts';
import {
  conversionWindowKey,
  conversionJSONScope,
  type ReadWindow,
  type ConversionCheckpoint,
} from './intake-continuation.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import { schemaOrdinal } from './intake-envelope-schema.ts';
import { prepareLegacyCheckpointTargets } from './intake-legacy-checkpoint-targets.ts';
import { assertIntakeOwner } from './intake.ts';

export const LEGACY_READING_POLICY = 'health-intake-legacy-reading-v1';
export const legacyReadingSessionName = (sessionId: string, intakeId: string, sourceHash: string) =>
  'reading.session.' + workflowHash([sessionId, intakeId, sourceHash]);
export const legacyReadingUnitKey = (planAddress: string, unitId: string) =>
  workflowHash([planAddress, unitId]);
export const legacyReadingAncestorKey = (window: ReadWindow, pointer: string) =>
  workflowHash([conversionJSONScope(window), pointer]);
export function legacyReadingAncestors(window: ReadWindow): string[] {
  const pointer = window.args.jsonPointer || '';
  if (typeof pointer !== 'string' || pointer.length > 4000)
    throw Error('Invalid imported JSON pointer');
  const result = [''];
  for (let i = 1; i < pointer.length; i++) if (pointer[i] === '/') result.push(pointer.slice(0, i));
  if (pointer) result.push(pointer);
  return result;
}
type Context = {
  db: Database;
  intakeId: string;
  sourceHash: string;
  sessionId: string;
  unitKey: string;
  assertCurrent(): void;
};
export function openLegacyReadingSession(
  context: Context,
  collection?: string,
  options: { allowUnindexedUnit?: boolean } = {},
) {
  const { collections } = selectedEnvelopeStore(context.db, { id: context.intakeId });
  const name =
    collection ?? legacyReadingSessionName(context.sessionId, context.intakeId, context.sourceHash);
  const text = (key: string) => {
    context.assertCurrent();
    const value = collections.get(collections.openView(), 'builds', name, key);
    if (value === undefined || typeof value === 'string') return value;
    if (value.bytes > 32768)
      throw Error('Imported reading window exceeds its retained argument budget');
    let after: string | undefined,
      result = '';
    do {
      const page = collections.readBytes(value, { after, items: 16, bytes: 16384 });
      for (const chunk of page.chunks)
        result += new TextDecoder('utf-8', { fatal: true }).decode(chunk);
      if (page.complete) return result;
      if (!page.after || page.after === after)
        throw Error('Imported reading bytes failed to advance');
      after = page.after;
    } while (true);
  };
  if (text('legacy.complete') === undefined) return undefined;
  const complete = JSON.parse(text('legacy.complete')!) as { format: string; sourceHash: string };
  if (complete.format !== LEGACY_READING_POLICY || complete.sourceHash !== context.sourceHash)
    throw Error('Imported reading authority conflicts');
  if (!options.allowUnindexedUnit && text('legacy.unit:' + context.unitKey) === undefined)
    throw new HttpError(
      409,
      'CONVERSION_CHANGED',
      'This imported reading session belongs to an earlier extraction plan. Start a new conversion session to read the current plan; the prior reading evidence remains retained.',
    );
  const count = (key: string) => {
    const value = Number(text(key) ?? '0');
    if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid imported reading count');
    return value;
  };
  function* entries(prefix: string) {
    let after = prefix;
    while (true) {
      context.assertCurrent();
      const page = collections.range(collections.openView(), 'builds', name, {
        after,
        items: 32,
        bytes: 32768,
      });
      for (const item of page.items) {
        if (!item.key.startsWith(prefix)) return;
        if (typeof item.value !== 'string') throw Error('Invalid imported reading index');
        yield { key: item.key, value: item.value };
      }
      if (page.complete) return;
      if (!page.after || page.after === after)
        throw Error('Imported reading index failed to advance');
      after = page.after;
    }
  }
  return {
    name,
    text,
    count,
    entries,
    has: (prefix: string, key: string) =>
      prefix === 'pending'
        ? count('legacy.pendingCount:' + key) > 0
        : text('legacy.' + prefix + ':' + key) !== undefined,
    pending: () => count('legacy.count:' + context.unitKey),
    unmatched: () => count('legacy.unmatchedCount'),
    readPages: () => count('legacy.pages:' + context.unitKey),
    readPageRank: (n: number) => {
      context.assertCurrent();
      const prefix = 'legacy.pageRead:' + context.unitKey + ':';
      return (
        collections.rank(collections.openView(), 'builds', name, prefix + schemaOrdinal(n)) -
        collections.rank(collections.openView(), 'builds', name, prefix)
      );
    },
    *pendingEntries() {
      // Merge the two already ordered indexes so an earlier unmatched window
      // stays visible ahead of later selected-unit windows.
      const unit = entries('legacy.order:' + context.unitKey + ':'),
        unmatched = entries('legacy.unmatched:');
      let a = unit.next(),
        b = unmatched.next();
      while (!a.done || !b.done) {
        if (b.done || (!a.done && a.value.key.slice(-16) < b.value.key.slice(-16))) {
          yield a.value!;
          a = unit.next();
        } else {
          yield b.value;
          b = unmatched.next();
        }
      }
    },
    window(key: string) {
      const value = text('legacy.window:' + key);
      return value ? (JSON.parse(value) as ReadWindow) : undefined;
    },
    lastWindowKey: () => text('legacy.lastWindow'),
  };
}

/** A replaced plan introduces new unit identities, not new reading evidence.
 * Extend its exact reverse targets from retained windows/hashes, without copying
 * unchanged unit maps or resetting session counters. Superseded target entries
 * remain history and are removed by the same eventual window acknowledgement. */
export async function prepareLegacyReadingTargets(
  context: Context & { root: string; profileId: string },
  options: { assertRunning?: () => void; onCheckpoint?: () => void | Promise<void> } = {},
) {
  const old = openLegacyReadingSession(context, undefined, { allowUnindexedUnit: true });
  if (!old || old.text('legacy.unit:' + context.unitKey) !== undefined) return { changed: false };
  const { collections } = selectedEnvelopeStore(context.db, { id: context.intakeId });
  const selectedRoot = collections.collection(collections.openView(), 'builds', old.name)?.root
    ?.hash;
  const current = () => {
    options.assertRunning?.();
    context.assertCurrent();
    if (
      collections.collection(collections.openView(), 'builds', old.name)?.root?.hash !==
      selectedRoot
    )
      throw Error('Imported reading session changed during plan preparation');
  };
  function* seen() {
    for (const entry of old!.entries('legacy.seen:')) yield entry.key.slice('legacy.seen:'.length);
  }
  const targets = await prepareLegacyCheckpointTargets(
    context.db,
    context.root,
    context.profileId,
    context.intakeId,
    {
      intakeId: context.intakeId,
      profileId: context.profileId,
      sourceHash: context.sourceHash,
      seen: seen(),
    },
    { assertRunning: current },
  );
  try {
    const assertCurrent = () => {
      current();
      targets.assertCurrent();
    };
    let examined = 0;
    const checkpoint = async () => {
      assertCurrent();
      if (++examined % 64 === 0) {
        await setImmediate();
        assertCurrent();
      }
    };
    const build = 'reading.reindex.' + randomUUID(),
      operationId = randomUUID();
    collections.commitMaintenance(
      collections.prepare(collections.openView(), {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: intakeSourceVersion(context.db, context.intakeId).rawVersion,
        changes: [
          {
            area: 'builds',
            collection: build,
            op: 'adoptCollection',
            fromArea: 'builds',
            fromCollection: old.name,
          },
        ],
      }),
    );
    const writer = createEnvelopeBuildWriter(
      context.db,
      { id: context.intakeId },
      build,
      intakeSourceVersion(context.db, context.intakeId).rawVersion,
      { ...options, assertRunning: assertCurrent },
    );
    const count = (key: string) => Number(writer.peek(key) ?? '0');
    const increment = async (key: string, amount = 1) => {
      const value = count(key) + amount;
      if (!Number.isSafeInteger(value) || value < 0)
        throw Error('Imported reading count conflicts');
      await writer.put(key, String(value));
    };
    for (const unit of targets.units()) {
      await checkpoint();
      if (writer.peek('legacy.unit:' + unit.unitKey) === undefined) {
        await writer.put('legacy.indexing:' + unit.unitKey, '1');
        await writer.put('legacy.unit:' + unit.unitKey, '1');
      }
    }
    for (const page of targets.pages()) {
      await checkpoint();
      if (writer.peek('legacy.indexing:' + page.unitKey) === undefined) continue;
      await writer.put(
        'legacy.pageTargets:' + page.scopeKey + ':' + page.unitKey,
        JSON.stringify({ unitKey: page.unitKey, ordinal: page.ordinal }),
      );
      if (old.has('read', page.scopeKey)) {
        await increment('legacy.pages:' + page.unitKey);
        await writer.put(
          'legacy.pageRead:' + page.unitKey + ':' + schemaOrdinal(page.ordinal),
          '1',
        );
      }
    }
    for (const pending of old.entries('legacy.pending:')) {
      await checkpoint();
      const key = pending.key.slice('legacy.pending:'.length, 'legacy.pending:'.length + 64),
        ordinal = pending.value,
        window = old.window(key);
      if (!window) throw Error('Imported pending window is missing');
      let matched = false;
      for (const unit of targets.targets(window)) {
        await checkpoint();
        matched = true;
        if (writer.peek('legacy.indexing:' + unit.unitKey) === undefined) continue;
        const keyName = 'legacy.targets:' + key + ':' + unit.unitKey + ':' + ordinal;
        if (writer.peek(keyName) !== undefined) continue;
        const value = JSON.stringify({ ...unit, ordinal, windowKey: key });
        await writer.put(keyName, value);
        await writer.put('legacy.order:' + unit.unitKey + ':' + ordinal, key);
        if (unit.textReadUnit)
          await writer.put('legacy.text:' + unit.unitKey + ':' + ordinal, value);
        await increment('legacy.count:' + unit.unitKey);
      }
      const unmatchedKey = 'legacy.unmatched:' + ordinal,
        unmatched = writer.peek(unmatchedKey) !== undefined;
      if (matched && unmatched) {
        await writer.remove(unmatchedKey);
        await increment('legacy.unmatchedCount', -1);
      } else if (!matched && !unmatched) {
        await writer.put(unmatchedKey, key);
        await increment('legacy.unmatchedCount');
      }
    }
    for (const unit of targets.units()) {
      await checkpoint();
      if (writer.peek('legacy.indexing:' + unit.unitKey) !== undefined)
        await writer.remove('legacy.indexing:' + unit.unitKey);
    }
    if (writer.peek('legacy.unit:' + context.unitKey) === undefined)
      throw Error('Selected unit is not part of an active imported reading plan');
    await writer.flush();
    assertCurrent();
    const publication = randomUUID();
    collections.commitMaintenance(
      collections.prepare(collections.openView(), {
        operationId: publication,
        requestDigest: createHash('sha256').update(publication).digest('hex'),
        domainVersion: intakeSourceVersion(context.db, context.intakeId).rawVersion,
        changes: [
          {
            area: 'builds',
            collection: old.name,
            op: 'adoptCollection',
            fromArea: 'builds',
            fromCollection: build,
          },
        ],
      }),
    );
    return { changed: true };
  } finally {
    targets.dispose();
  }
}

/** Import the old journal checkpoint once. Preparation may scan its complete
 * historical state, but publishes only a complete session map. Hashed evidence
 * remains hashed; completed unit labels never become clinical coverage. */
export async function importLegacyReadingCheckpoint(
  db: Database,
  root: string,
  profileId: string,
  intakeId: string,
  sessionId: string,
  checkpoint: ConversionCheckpoint,
  options: { assertRunning?: () => void; onCheckpoint?: () => void | Promise<void> } = {},
) {
  assertIntakeOwner(db, profileId);
  if (!sessionId || Buffer.byteLength(sessionId) > 200)
    throw Error('Invalid conversion session identity');
  const selected = selectedEnvelopeStore(db, { id: intakeId }),
    collections = selected.collections;
  const sourceHash = selected.source.sha256;
  if (
    !sourceHash ||
    checkpoint.sourceHash !== sourceHash ||
    checkpoint.intakeId !== intakeId ||
    checkpoint.profileId !== profileId
  )
    throw Error('Legacy reading checkpoint source changed');
  const name = legacyReadingSessionName(sessionId, intakeId, sourceHash);
  const existing = collections.get(collections.openView(), 'builds', name, 'legacy.complete');
  if (existing !== undefined) {
    if (typeof existing !== 'string') throw Error('Invalid imported reading marker');
    const marker = JSON.parse(existing) as { format: string; sourceHash: string };
    if (marker.format !== LEGACY_READING_POLICY || marker.sourceHash !== sourceHash)
      throw Error('Imported reading authority conflicts');
    return { imported: false };
  }
  if (collections.collection(collections.openView(), 'builds', name))
    throw Error('Cannot replace an existing native reading session with an old checkpoint');
  const target = await prepareLegacyCheckpointTargets(
    db,
    root,
    profileId,
    intakeId,
    checkpoint,
    options,
  );
  try {
    const current = () => {
      options.assertRunning?.();
      target.assertCurrent();
      if (collections.collection(collections.openView(), 'builds', name))
        throw Error('Reading session changed during checkpoint import');
    };
    const build = 'reading.import.' + randomUUID(),
      writer = createEnvelopeBuildWriter(
        db,
        { id: intakeId },
        build,
        intakeSourceVersion(db, intakeId).rawVersion,
        { ...options, assertRunning: current },
      );
    const count = (key: string) => Number(writer.peek(key) ?? '0');
    const increment = async (key: string) => {
      const next = count(key) + 1;
      if (!Number.isSafeInteger(next)) throw Error('Imported reading count overflow');
      await writer.put(key, String(next));
    };
    for (const [prefix, values] of [
      ['seen', checkpoint.seen],
      ['read', checkpoint.readScopes],
      ['json', checkpoint.jsonRoots],
    ] as const)
      for (const key of values) {
        current();
        if (!/^[a-f0-9]{64}$/.test(key)) throw Error('Invalid retained reading evidence hash');
        await writer.put('legacy.' + prefix + ':' + key, '1');
      }
    for (const window of checkpoint.suppliedJSON ?? [])
      await writer.put(
        'legacy.supplied:' + legacyReadingAncestorKey(window, window.args.jsonPointer || ''),
        '1',
      );
    if (checkpoint.lastWindow) {
      const key = conversionWindowKey(checkpoint.lastWindow),
        raw = JSON.stringify(checkpoint.lastWindow);
      if (Buffer.byteLength(raw) > 32768)
        throw Error('Imported last reading window exceeds its argument budget');
      await writer.cell('legacy.window:' + key, raw);
      await writer.put('legacy.lastWindow', key);
    }
    for (const unit of target.units()) await writer.put('legacy.unit:' + unit.unitKey, '1');
    for (const page of target.pages()) {
      const descriptor = JSON.stringify({ unitKey: page.unitKey, ordinal: page.ordinal });
      await writer.put('legacy.pageTargets:' + page.scopeKey + ':' + page.unitKey, descriptor);
      if (writer.peek('legacy.read:' + page.scopeKey) !== undefined) {
        await increment('legacy.pages:' + page.unitKey);
        await writer.put(
          'legacy.pageRead:' + page.unitKey + ':' + schemaOrdinal(page.ordinal),
          '1',
        );
      }
    }
    for (let n = 0; n < checkpoint.pending.length; n++) {
      current();
      const window = checkpoint.pending[n]!,
        key = conversionWindowKey(window),
        ordinal = schemaOrdinal(n),
        raw = JSON.stringify(window);
      if (Buffer.byteLength(raw) > 32768)
        throw Error('Imported reading window exceeds its retained argument budget');
      await writer.cell('legacy.window:' + key, raw);
      await writer.put('legacy.pending:' + key + ':' + ordinal, ordinal);
      await increment('legacy.pendingCount:' + key);
      let matched = false;
      for (const unit of target.targets(window)) {
        const targetKey = 'legacy.targets:' + key + ':' + unit.unitKey + ':' + ordinal;
        // Several equivalent predicates may find the same unit. It remains one
        // target for this exact pending occurrence.
        if (writer.peek(targetKey) !== undefined) continue;
        matched = true;
        const targetValue = JSON.stringify({ ...unit, ordinal, windowKey: key });
        await writer.put(targetKey, targetValue);
        await writer.put('legacy.order:' + unit.unitKey + ':' + ordinal, key);
        if (unit.textReadUnit)
          await writer.put('legacy.text:' + unit.unitKey + ':' + ordinal, targetValue);
        await increment('legacy.count:' + unit.unitKey);
      }
      if (!matched) {
        await writer.put('legacy.unmatched:' + ordinal, key);
        await increment('legacy.unmatchedCount');
      }
      for (const pointer of legacyReadingAncestors(window))
        await writer.put(
          'legacy.desc:' + legacyReadingAncestorKey(window, pointer) + ':' + key,
          key,
        );
    }
    for (const [prefix, values] of [
      ['completed', checkpoint.completedUnits],
      ['accounted', checkpoint.accountedUnits ?? []],
    ] as const)
      for (let n = 0; n < values.length; n++)
        await writer.cell('legacy.' + prefix + ':' + schemaOrdinal(n), JSON.stringify(values[n]));
    const totals = {
      seen: checkpoint.seen.length,
      distinct: checkpoint.distinctReads ?? checkpoint.pagesProcessed ?? 0,
      pending: checkpoint.pending.length,
    };
    if (!Object.values(totals).every((n) => Number.isSafeInteger(n) && n >= 0))
      throw Error('Invalid imported reading totals');
    await writer.put('counts', JSON.stringify(totals));
    await writer.put(
      'legacy.complete',
      JSON.stringify({ format: LEGACY_READING_POLICY, sourceHash }),
    );
    await writer.flush();
    current();
    const operationId = randomUUID();
    collections.commitMaintenance(
      collections.prepare(collections.openView(), {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: intakeSourceVersion(db, intakeId).rawVersion,
        changes: [
          {
            area: 'builds',
            collection: name,
            op: 'adoptCollection',
            fromArea: 'builds',
            fromCollection: build,
          },
        ],
      }),
    );
    return { imported: true };
  } finally {
    target.dispose();
  }
}

/** The selected session map is forked once; even a shared-window fanout selects
 * only that map and the selected native unit ledger at final publication. */
export async function prepareLegacyReadingUpdate(
  context: Context,
  options: {
    assertRunning?: () => void;
    onCheckpoint?: () => void | Promise<void>;
    onPendingRemoved?: (key: string) => void;
  } = {},
) {
  const old = openLegacyReadingSession(context);
  if (!old) return undefined;
  const { collections } = selectedEnvelopeStore(context.db, { id: context.intakeId });
  const selectedRoot = collections.collection(collections.openView(), 'builds', old.name)?.root
    ?.hash;
  const current = () => {
    options.assertRunning?.();
    context.assertCurrent();
    if (
      collections.collection(collections.openView(), 'builds', old.name)?.root?.hash !==
      selectedRoot
    )
      throw Error('Imported reading session changed during acknowledgment');
  };
  const build = 'reading.legacy.' + randomUUID(),
    operationId = randomUUID();
  current();
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: intakeSourceVersion(context.db, context.intakeId).rawVersion,
      changes: [
        {
          area: 'builds',
          collection: build,
          op: 'adoptCollection',
          fromArea: 'builds',
          fromCollection: old.name,
        },
      ],
    }),
  );
  const writer = createEnvelopeBuildWriter(
    context.db,
    { id: context.intakeId },
    build,
    intakeSourceVersion(context.db, context.intakeId).rawVersion,
    { assertRunning: current, onCheckpoint: options.onCheckpoint },
  );
  const read = openLegacyReadingSession(context, build)!;
  let removed = 0;
  const count = (key: string) => Number(writer.peek(key) ?? '0');
  const subtract = async (key: string, n = 1) => {
    const value = count(key) - n;
    if (!Number.isSafeInteger(value) || value < 0)
      throw Error('Imported reading target count conflicts');
    await writer.put(key, String(value));
  };
  const removeTarget = async (key: string, raw: string) => {
    const target = JSON.parse(raw) as {
      unitKey: string;
      ordinal: string;
      textReadUnit: boolean;
      windowKey: string;
    };
    await writer.remove('legacy.order:' + target.unitKey + ':' + target.ordinal);
    await writer.remove(key);
    if (target.textReadUnit)
      await writer.remove('legacy.text:' + target.unitKey + ':' + target.ordinal);
    await subtract('legacy.count:' + target.unitKey);
  };
  const removeWindow = async (key: string) => {
    if (!count('legacy.pendingCount:' + key)) return;
    options.onPendingRemoved?.(key);
    await writer.flush();
    for (const item of read.entries('legacy.targets:' + key + ':'))
      await removeTarget(item.key, item.value);
    for (const item of read.entries('legacy.pending:' + key + ':')) {
      const ordinal = item.value;
      if (writer.peek('legacy.unmatched:' + ordinal) !== undefined) {
        await writer.remove('legacy.unmatched:' + ordinal);
        await subtract('legacy.unmatchedCount');
      }
      await writer.remove(item.key);
      removed++;
    }
    await writer.put('legacy.pendingCount:' + key, '0');
    const window = read.window(key);
    if (!window) throw Error('Imported pending window is missing');
    for (const pointer of legacyReadingAncestors(window))
      await writer.remove('legacy.desc:' + legacyReadingAncestorKey(window, pointer) + ':' + key);
  };
  return {
    has: (prefix: string, key: string) =>
      prefix === 'pending'
        ? count('legacy.pendingCount:' + key) > 0
        : writer.peek('legacy.' + prefix + ':' + key) !== undefined,
    async markSeen(window: ReadWindow) {
      await writer.put('legacy.seen:' + conversionWindowKey(window), '1');
    },
    async markLast(window: ReadWindow) {
      const key = conversionWindowKey(window);
      await writer.cell('legacy.window:' + key, JSON.stringify(window));
      await writer.put('legacy.lastWindow', key);
    },
    removeWindow,
    async markRead(scopeKey: string) {
      if (writer.peek('legacy.read:' + scopeKey) !== undefined) return;
      await writer.put('legacy.read:' + scopeKey, '1');
      await writer.flush();
      for (const target of read.entries('legacy.pageTargets:' + scopeKey + ':')) {
        const { unitKey, ordinal } = JSON.parse(target.value) as {
          unitKey: string;
          ordinal: number;
        };
        await writer.put('legacy.pages:' + unitKey, String(count('legacy.pages:' + unitKey) + 1));
        await writer.put('legacy.pageRead:' + unitKey + ':' + schemaOrdinal(ordinal), '1');
      }
      await writer.flush();
    },
    readPageRank: read.readPageRank,
    async sourceRoute(key: string, value: string) {
      await writer.put('sourceUnit:' + key, value);
    },
    async markJSON(key: string) {
      await writer.put('legacy.json:' + key, '1');
    },
    async supply(window: ReadWindow) {
      const identity = legacyReadingAncestorKey(window, window.args.jsonPointer || '');
      await writer.put('legacy.supplied:' + identity, '1');
      await writer.flush();
      for (const item of read.entries('legacy.desc:' + identity + ':'))
        await removeWindow(item.value);
    },
    async readUnit() {
      await writer.flush();
      for (const item of read.entries('legacy.text:' + context.unitKey + ':')) {
        const target = JSON.parse(item.value) as { windowKey: string; ordinal: string };
        const key =
          'legacy.targets:' + target.windowKey + ':' + context.unitKey + ':' + target.ordinal;
        const raw = writer.peek(key);
        if (raw !== undefined) await removeTarget(key, raw);
      }
    },
    async finish(totals: { seen: number; distinct: number; pending?: number }) {
      if (totals.pending !== undefined) totals.pending -= removed;
      if (
        totals.pending !== undefined &&
        (!Number.isSafeInteger(totals.pending) || totals.pending < 0)
      )
        throw Error('Imported session pending count conflicts');
      await writer.put('counts', JSON.stringify(totals));
      await writer.flush();
      current();
      return {
        area: 'builds',
        collection: old.name,
        op: 'adoptCollection',
        fromArea: 'builds',
        fromCollection: build,
      } satisfies IntakeCollectionChange;
    },
    assertCurrent: current,
  };
}
