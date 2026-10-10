/** Replay a checked lexical build prefix without publishing it a second time.
 * Only the selected intake owner's authenticated progress is recovery evidence.
 * The private SQL mirror reconstructs parser-local duplicate/precedence facts. */
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { managedDatabaseMethodSerial, type Database } from './database.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { holdReadOnlySourceTextProjection } from './source-text-projection.ts';
import { selectedEnvelopeStore } from './intake-collection-envelope.ts';
import {
  assertSelectedIntakeBuildView,
  type IntakeEnvelopeSource,
  type PreparedSelectedIntakeBuildView,
} from './intake-authority.ts';
import type { IntakeLegacyBridgeReadWitness } from './intake-state-migration.ts';
import type { sealSelectedIntakeBuildView } from './intake-authority.ts';
import { ENVELOPE_SCHEMA, schemaKey } from './intake-envelope-schema.ts';
import { intakeCollectionCacheGeneration } from './intake-state-collections.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import { intakeSourcePinKey } from './intake-source-pin.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';
import { FILENAME_FACTS_FORMAT } from './intake-filename-facts.ts';
import {
  captureIntakeFrontierAttempts,
  readIntakeFrontierAttempts,
  readIntakeFrontierSourceEquality,
} from './intake-lookup-frontier-observer.ts';
import type { IntakeCollectionResult } from './intake-state-evidence.ts';
import { intakeNamespace } from './intake-state-evidence.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import { sourceTextAuthorityDirtyRow } from './source-text-projection.ts';

const FORMAT = 'health-intake-envelope-build-resume-v1';
const COLLECTION = 'schema.resume';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const emptyHash = hash('');
const selectedResumeCollections = new WeakMap<
  object,
  {
    db: Database;
    sourceId: string;
    sourceHash: string;
    collections: ReturnType<typeof selectedEnvelopeStore>['collections'];
    assertCurrent: () => void;
  }
>();
function fail(reason: string): never {
  throw Error(`Intake envelope build resume: ${reason}`);
}
interface Progress {
  format: typeof FORMAT;
  binding: string;
  count: number;
  digest: string;
}
export function prepareEnvelopeBuildResume(
  db: Database,
  source: IntakeEnvelopeSource,
  legacy: {
    mode: 'raw' | 'normalized';
    version: number;
    hash: string;
    bytes: number;
  },
  options: { assertRunning?: () => void },
  selectedBuild?: ReturnType<typeof sealSelectedIntakeBuildView>,
  selectedView?: PreparedSelectedIntakeBuildView,
  originalRead?: IntakeLegacyBridgeReadWitness,
) {
  if (db.isTransaction) fail('prepare outside a transaction');
  const selectedFallback = selectedBuild ? undefined : selectedEnvelopeStore(db, source);
  const selected = selectedBuild ?? selectedFallback!;
  const selectedHeadKey = `${intakeNamespace(selected.identity)}head`;
  if (selected.binding.logicalHead === undefined) fail('missing legacy bridge');
  const sourcePin = () =>
    db.prepare('SELECT value FROM app_meta WHERE key=?').get(intakeSourcePinKey(source.id))?.value;
  const pinHash = hash(JSON.stringify([sourcePin() ?? null]));
  const binding = JSON.stringify({
    format: FORMAT,
    codec: ENVELOPE_SCHEMA,
    filenameFacts: FILENAME_FACTS_FORMAT,
    compactScalars: 'originalName+locator-v1',
    identity: selected.identity,
    logical: hash(selected.binding.logicalHead),
    details: selectedBuild
      ? selectedBuild.detailsDigest
      : hash(selectedFallback!.source.details_json ?? ''),
    pin: pinHash,
    ...legacy,
  });
  const build = 'schema.' + hash(binding);
  const { collections } = selected;
  let sequence = collections.binding(collections.openView())?.storageSequence;
  if (!Number.isSafeInteger(sequence)) fail('missing selected storage sequence');
  let accepted = collections.get(collections.openView(), 'builds', COLLECTION, build);
  if (accepted !== undefined && typeof accepted !== 'string') fail('fragmented progress');
  const initial = accepted === undefined ? undefined : (JSON.parse(accepted) as Progress);
  if (
    accepted !== undefined &&
    (!initial ||
      typeof initial !== 'object' ||
      Array.isArray(initial) ||
      Object.keys(initial).sort().join(',') !== 'binding,count,digest,format' ||
      initial.format !== FORMAT ||
      initial.binding !== binding ||
      !Number.isSafeInteger(initial.count) ||
      initial.count < 0 ||
      !/^[a-f0-9]{64}$/.test(initial.digest) ||
      (initial.count === 0 && initial.digest !== emptyHash))
  )
    fail('invalid progress');
  if (
    (accepted === undefined || initial!.count === 0) &&
    (collections.collection(collections.openView(), 'builds', build) !== undefined ||
      collections.hasCollectionPrefix(collections.openView(), 'builds', build + '.'))
  )
    fail('missing progress for retained build data');
  const prefixCount = initial?.count ?? 0;
  const scratch = disposableSqlite('intake-envelope-build-prefix-');
  try {
    scratch.db.exec('CREATE TABLE facts(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID');
    const insert = scratch.db.prepare('INSERT OR REPLACE INTO facts VALUES(?,?)');
    const lookup = scratch.db.prepare('SELECT value FROM facts WHERE key=?');
    const stampQuery = db.prepare(
      'SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS external,(SELECT schema_version FROM pragma_schema_version) AS schema',
    );
    stampQuery.setReadBigInts(true);
    const tempQuery = db.prepare('PRAGMA temp.schema_version');
    tempQuery.setReadBigInts(true);
    const stamp = () => {
      if (!db.isOpen) fail('database unavailable');
      return JSON.stringify([stampQuery.get(), tempQuery.get()], (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
    };
    let witness = stamp(),
      generation = intakeCollectionCacheGeneration(db),
      count = 0,
      prefixVerified = prefixCount === 0;
    const methods = managedDatabaseMethodSerial(db);
    let frontier = captureIntakeFrontierAttempts(db);
    if (methods === undefined || !frontier) fail('original frontier authority unavailable');
    let checkpointDirty: ReturnType<typeof sourceTextAuthorityDirtyRow> | undefined;
    const transcript = createHash('sha256');
    const work = {
      replayedOperations: 0,
      transcriptHashBytes: 0,
      scratchReadBytes: 0,
      scratchWrittenBytes: 0,
      replayYields: 0,
      validationHashBytes: 0,
      validationChunks: 0,
      validationYields: 0,
      sourceHashBytes: legacy.bytes,
      operations: 0,
    };
    const metrics = {
      operations: 'schemaBuildOperations',
      replayedOperations: 'schemaBuildReplayedOperations',
      transcriptHashBytes: 'schemaBuildTranscriptHashBytes',
      scratchReadBytes: 'schemaBuildScratchReadBytes',
      scratchWrittenBytes: 'schemaBuildScratchWrittenBytes',
      replayYields: 'schemaBuildReplayYields',
      validationHashBytes: 'schemaBuildValidationHashBytes',
      validationChunks: 'schemaBuildValidationChunks',
      validationYields: 'schemaBuildValidationYields',
      sourceHashBytes: 'schemaBuildSourceHashBytes',
    } as const;
    const countWork = (key: keyof typeof metrics, amount = 1) => {
      work[key] += amount;
      withIntakeWork(db, 'warm', () => recordIntakeWork(metrics[key], amount));
    };
    const assertMethods = () => {
      if (methods === undefined) return;
      if (managedDatabaseMethodSerial(db) !== methods)
        fail('method authority changed during preparation');
    };
    const assertWitness = () => {
      assertMethods();
      if (stamp() !== witness || intakeCollectionCacheGeneration(db) !== generation)
        fail('authority changed during preparation');
    };
    const assertSelectedBinding = () => {
      if (selectedBuild && selectedView && originalRead) {
        assertSelectedIntakeBuildView(db, selectedView, originalRead);
        if (hash(JSON.stringify([sourcePin() ?? null])) !== pinHash) fail('source pin changed');
        return;
      }
      const current = selectedEnvelopeStore(db, source);
      if (
        JSON.stringify(current.identity) !== JSON.stringify(selected.identity) ||
        current.binding.logicalHead !== selected.binding.logicalHead ||
        current.source.details_json !== selectedFallback!.source.details_json ||
        hash(JSON.stringify([sourcePin() ?? null])) !== pinHash
      )
        fail('source binding changed');
    };
    const assertQuietFrontier = () => {
      if (!frontier) return false;
      const interval = readIntakeFrontierAttempts(db, frontier);
      if (
        !interval ||
        interval.attempts !== 0 ||
        interval.ownedWrites !== 0 ||
        interval.headSourceIds.length ||
        interval.ordinaryTokens.length
      )
        fail('source authority changed during preparation');
      return true;
    };
    const assertCurrent = () => {
      options.assertRunning?.();
      if (db.isTransaction) fail('prepare outside a transaction');
      assertWitness();
      const durability = recordDurabilityStatus(db);
      if (!durability?.configured || durability.dirty || durability.conflicted)
        fail('accepted physical head changed during preparation');
      if (!assertQuietFrontier()) assertSelectedBinding();
      // The physical accepted-head reader may itself observe another writer.
      // Compare the original baseline after its final observation, too.
      assertWitness();
      assertQuietFrontier();
    };
    const assertProgress = () => {
      assertCurrent();
      if (collections.get(collections.openView(), 'builds', COLLECTION, build) !== accepted)
        fail('progress changed during preparation');
      assertWitness();
    };
    const releaseReadOnlySearch = holdReadOnlySourceTextProjection(db, assertCurrent);
    const result = {
      build,
      work,
      countWork,
      assertCurrent,
      assertWitness,
      blobName: (key: string) =>
        build + '.' + Buffer.from(schemaKey(key), 'hex').toString('base64url'),
      peek(key: string): string | undefined {
        const value = lookup.get(key)?.value;
        if (typeof value === 'string') {
          countWork('scratchReadBytes', Buffer.byteLength(key) + Buffer.byteLength(value));
          return value;
        }
        return undefined;
      },
      async emit(change: IntakeCollectionChange): Promise<boolean> {
        assertCurrent();
        if (change.op === 'put' && /^[fli]:/.test(change.key)) {
          insert.run(change.key, change.value);
          countWork(
            'scratchWrittenBytes',
            Buffer.byteLength(change.key) + Buffer.byteLength(change.value),
          );
        }
        const encoded =
          JSON.stringify(
            change.op === 'appendBytes'
              ? {
                  ...change,
                  bytes: Buffer.from(change.bytes).toString('base64'),
                }
              : change,
          ) + '\n';
        transcript.update(encoded);
        countWork('transcriptHashBytes', Buffer.byteLength(encoded));
        countWork('operations');
        count++;
        if (count <= prefixCount) {
          countWork('replayedOperations');
          if (count === prefixCount) {
            if (transcript.copy().digest('hex') !== initial!.digest)
              fail('prefix transcript mismatch');
            assertProgress();
            prefixVerified = true;
          }
          if (count % 63 === 0) {
            countWork('replayYields');
            await setImmediate();
            assertCurrent();
          }
          return false;
        }
        if (!prefixVerified) fail('unverified prefix');
        return true;
      },
      progress(): IntakeCollectionChange {
        if (!prefixVerified) fail('unverified prefix');
        assertProgress();
        return {
          area: 'builds',
          collection: COLLECTION,
          op: 'put',
          key: build,
          value: JSON.stringify({
            format: FORMAT,
            binding,
            count,
            digest: transcript.copy().digest('hex'),
          }),
        };
      },
      beginCheckpoint() {
        if (checkpointDirty !== undefined) fail('overlapping checkpoint');
        assertCurrent();
        checkpointDirty = sourceTextAuthorityDirtyRow(db, source.id, selectedHeadKey);
        assertCurrent();
      },
      committed(
        progress: IntakeCollectionChange,
        result: IntakeCollectionResult,
        operationId: string,
      ) {
        if (progress.op !== 'put') fail('invalid progress publication');
        const beforeDirty = checkpointDirty;
        checkpointDirty = undefined;
        if (beforeDirty === undefined) fail('missing checkpoint admission');
        const readCheckpointInterval = () => {
          if (!frontier) return undefined;
          const strict = readIntakeFrontierAttempts(db, frontier);
          if (strict) return strict;
          if (!beforeDirty || beforeDirty.dirty) return undefined;
          const afterDirty = sourceTextAuthorityDirtyRow(db, source.id, selectedHeadKey);
          const current = captureIntakeFrontierAttempts(db);
          if (
            !afterDirty?.dirty ||
            afterDirty.authority !== beforeDirty.authority ||
            !current ||
            current.identity !== frontier.identity ||
            current.unrelatedChanges !== frontier.unrelatedChanges + 1n
          )
            return undefined;
          const equality = readIntakeFrontierSourceEquality(db, frontier);
          return equality && { ...equality, ordinaryTokens: [] };
        };
        const interval = readCheckpointInterval();
        if (
          frontier &&
          (!interval ||
            interval.attempts !== interval.ownedWrites ||
            interval.ordinaryTokens.length !== 0 ||
            interval.headSourceIds.length !== 1 ||
            interval.headSourceIds[0] !== source.id)
        )
          fail('unowned checkpoint transition');
        if (
          result.format !== 'health-intake-state-result-v4' ||
          result.intakeId !== source.id ||
          result.operationId !== operationId ||
          result.changed !== false ||
          result.storageSequence !== sequence! + 1 ||
          JSON.stringify(result.logical) !== selected.binding.logicalHead ||
          JSON.stringify(collections.replay(operationId, hash(operationId))) !==
            JSON.stringify(result)
        )
          fail('unrecognized checkpoint result');
        if (!frontier) assertSelectedBinding();
        if (collections.get(collections.openView(), 'builds', COLLECTION, build) !== progress.value)
          fail('checkpoint progress differs');
        if (frontier) {
          const after = readCheckpointInterval();
          if (
            !after ||
            after.attempts !== interval!.attempts ||
            after.ownedWrites !== interval!.ownedWrites ||
            JSON.stringify(after.headSourceIds) !== JSON.stringify(interval!.headSourceIds) ||
            after.ordinaryTokens.length
          )
            fail('checkpoint changed during verification');
          const next = captureIntakeFrontierAttempts(db);
          if (!next) fail('checkpoint observer unavailable');
          frontier = next;
        }
        // Only this exact accepted owner outcome may advance the read witness.
        accepted = progress.value;
        sequence = result.storageSequence;
        witness = stamp();
        generation = intakeCollectionCacheGeneration(db);
        assertProgress();
      },
      finish() {
        if (!prefixVerified || count < prefixCount) fail('prefix exceeds complete transcript');
        assertProgress();
        assertSelectedBinding();
        assertProgress();
      },
      close() {
        try {
          scratch.close();
        } finally {
          selectedResumeCollections.delete(result);
          releaseReadOnlySearch();
        }
      },
    };
    selectedResumeCollections.set(result, {
      db,
      sourceId: selected.identity.intakeId,
      sourceHash: selected.identity.sourceHash,
      collections,
      assertCurrent,
    });
    return result;
  } catch (error) {
    scratch.close();
    throw error;
  }
}
export type EnvelopeBuildResume = ReturnType<typeof prepareEnvelopeBuildResume>;

export function selectedEnvelopeBuildCollections(
  db: Database,
  source: IntakeEnvelopeSource,
  resume: EnvelopeBuildResume,
) {
  const selected = selectedResumeCollections.get(resume);
  if (
    !selected ||
    selected.db !== db ||
    selected.sourceId !== source.id ||
    (source.sha256 !== undefined && selected.sourceHash !== source.sha256) ||
    Object.getOwnPropertyDescriptor(resume, 'assertCurrent')?.value !== selected.assertCurrent
  )
    fail('selected resume owner changed');
  selected.assertCurrent();
  return selected.collections;
}
