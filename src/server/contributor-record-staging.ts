import { Worker } from 'node:worker_threads';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setImmediate as yieldHost } from 'node:timers/promises';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Database } from './database.ts';
import type { IntakeTreeRoot } from './intake-state-tree.ts';
import { intakeTreeRef } from './intake-state-tree.ts';
import { vaultRecordCertificates } from './vault-record-certificates.ts';
import { recordVersionWork } from './record-version-work.ts';
import { captureRecordHeadPhysical } from './record-head-physical.ts';
import { unlockPhysicalIdentity } from './encrypted-unlock-physical.ts';
import { recordFieldDigest, recordStringFieldDigest } from './record-prior-fields.ts';
import {
  consumeRecordTransactionBackingAdvance,
  consumeRecordTransactionBackingPublication,
  verifiedRecordTransactionBackingVersions,
  verifiedRecordTransactionOriginalArtifacts,
  verifiedRecordTransactionOriginalSources,
  recordTransactionTerminalExecutionCurrent,
  recordTransactionBackingPlanCurrent,
  runRecordTransactionTerminalExecution,
  type RecordTransactionTerminalExecution,
  type RecordTransactionBackingPlan,
  type RecordTransactionIndexedPublication,
} from './record-versions.ts';
import {
  contributorRecordBackingLocation,
  contributorRecordReadOwnerCurrent,
  captureContributorRecordWriteWitness,
  contributorRecordWriteWitnessCurrent,
  contributorRecordWriteWitnessSequence,
  closeContributorRecordWriteWitness,
  stageContributorRecordFactoryObject,
  prepareContributorRecordHeadPublication,
  contributorRecordHeadPublicationCurrent,
  installContributorRecordHeadPublication,
  closeContributorRecordHeadPublication,
  closeContributorRecordReadOwner,
  contributorRecordReadOwnersSameSelection,
  captureContributorRecordInstalledReadOwner,
  registerContributorRecordStagingDisposal,
  type ContributorRecordReadOwner,
  type ContributorRecordWriteWitness,
  type ContributorRecordHeadPublication,
} from './contributor-record-storage.ts';

export interface ContributorRecordBackingInput {
  mode: 'prepare' | 'verify';
  root: string;
  profileId: string;
  base: string;
  marker: string;
  selectedHead: string;
  database: string;
  physical: string;
  nonce: string;
  signatureKey: Uint8Array;
  checkpointControl: SharedArrayBuffer;
  entries?: number;
  originalArtifacts?: number;
  originalSources?: number;
  objectsIdentity?: string;
  objectsSignature?: string;
}

declare const stagingBrand: unique symbol;
export interface ContributorRecordStagingWitness {
  readonly [stagingBrand]: true;
}
interface StagingData {
  db: Database;
  storage: object;
  original: ContributorRecordReadOwner;
  writes: ContributorRecordWriteWitness;
  location: { root: string; profileId: string; base: string; marker: string };
  staged: number;
  preparationAttempted: boolean;
  prepared?: {
    scratch: string;
    sql: DatabaseSync;
    input: ContributorRecordBackingInput;
    root: IntakeTreeRoot;
    entries: number;
    expectedChanges: bigint;
    schema: unknown;
    tempSchema: unknown;
    dataVersion: unknown;
    statements: {
      changes: StatementSync;
      schema: StatementSync;
      tempSchema: StatementSync;
      dataVersion: StatementSync;
      insert: StatementSync;
      lookup: StatementSync;
      count: StatementSync;
      own: StatementSync;
      promote: StatementSync;
      replace: StatementSync;
      clearOwn: StatementSync;
      clearSources: StatementSync;
      clearArtifacts: StatementSync;
      physicalRow: StatementSync;
    };
    physical?: ReturnType<typeof captureRecordHeadPhysical>;
  };
  head?: ContributorRecordHeadPublication;
  candidateHead?: string;
  pending?: {
    root: IntakeTreeRoot;
    head: string;
    plan: RecordTransactionBackingPlan;
    versionIds: string[];
  };
  finished: boolean;
  finalAttempted: boolean;
  closed: boolean;
  reused?: boolean;
  installed?: boolean;
  installedSuccessor?: ContributorRecordReadOwner;
  installedParents?: readonly { path: string; kind: 'file' | 'directory'; identity: string }[];
}
const witnesses = new WeakMap<ContributorRecordStagingWitness, StagingData>();
interface RetainedFrontier {
  db: Database;
  original: ContributorRecordReadOwner;
  prepared: NonNullable<StagingData['prepared']>;
  poisoned: boolean;
  active: boolean;
}
const frontiers = new WeakMap<object, RetainedFrontier>();
const closedStorages = new WeakSet<object>();
const storageResources = new WeakMap<
  object,
  {
    active: Set<ContributorRecordStagingWitness>;
    release(): void;
  }
>();
const nativePrepare = DatabaseSync.prototype.prepare,
  nativeClose = DatabaseSync.prototype.close,
  nativeGet = StatementSync.prototype.get,
  nativeRun = StatementSync.prototype.run;
const get = (statement: StatementSync, ...args: unknown[]) =>
  Reflect.apply(nativeGet, statement, args) as ReturnType<StatementSync['get']>;
const run = (statement: StatementSync, ...args: unknown[]) =>
  Reflect.apply(nativeRun, statement, args) as ReturnType<StatementSync['run']>;
function live(data: StagingData): void {
  if (
    data.closed ||
    !contributorRecordReadOwnerCurrent(data.storage, data.original) ||
    !contributorRecordWriteWitnessCurrent(data.storage, data.writes)
  )
    throw Error('Contributor original staging owner changed');
}
function closePrepared(prepared: NonNullable<StagingData['prepared']>): void {
  try {
    prepared.physical?.close();
  } finally {
    try {
      if (prepared.sql.isOpen) Reflect.apply(nativeClose, prepared.sql, []);
    } finally {
      prepared.input.signatureKey.fill(0);
      rmSync(prepared.scratch, { recursive: true, force: true });
    }
  }
}
function retained(data: StagingData) {
  live(data);
  const prepared = data.prepared;
  if (!prepared || !prepared.sql.isOpen || (prepared.physical && !prepared.physical.current()))
    throw Error('Contributor original backing unavailable');
  const { statements } = prepared;
  if (
    contributorRecordWriteWitnessSequence(data.storage, data.writes) !== BigInt(data.staged) ||
    BigInt(String(get(statements.changes)!.n)) !== prepared.expectedChanges ||
    get(statements.schema)!.schema_version !== prepared.schema ||
    get(statements.tempSchema)!.schema_version !== prepared.tempSchema ||
    get(statements.dataVersion)!.data_version !== prepared.dataVersion
  )
    throw Error('Contributor original backing scratch changed');
  return prepared;
}
async function runWorker(
  input: ContributorRecordBackingInput,
  current: () => void,
  beforeBaseline: () => void = current,
  complete?: (entries: number) => unknown,
): Promise<{
  entries: number;
  certificateRoot?: IntakeTreeRoot;
  decodedVersions?: number;
  result?: unknown;
}> {
  beforeBaseline();
  const worker = new Worker(new URL('./contributor-record-backing-worker.ts', import.meta.url), {
    workerData: input,
  });
  let reply:
      | {
          entries?: number;
          certificateRoot?: IntakeTreeRoot;
          decodedVersions?: number;
          refused?: boolean;
        }
      | undefined,
    failed: unknown,
    stopped = false,
    result: unknown;
  const checkpoint = (baselineReady: boolean) => {
    try {
      (baselineReady ? current : beforeBaseline)();
    } catch (error) {
      failed = error;
      stopped = true;
      void worker.terminate();
    } finally {
      const control = new Int32Array(input.checkpointControl);
      Atomics.store(control, 0, 0);
      Atomics.notify(control, 0);
    }
  };
  try {
    await new Promise<void>((resolveDone, reject) => {
      worker.on('message', (message) => {
        if (message?.checkpoint === true) checkpoint(message.baselineReady === true);
        else if (reply) reject(Error('Contributor backing worker repeated result'));
        else {
          reply = message;
          if (complete) {
            try {
              if (message?.refused || !Number.isSafeInteger(message?.entries))
                throw Error('Contributor original backing verification refused');
              result = complete(message.entries);
            } catch (error) {
              failed = error;
              stopped = true;
              reject(error);
            }
          }
        }
      });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (stopped) reject(failed);
        else if (code || reply?.refused || !Number.isSafeInteger(reply?.entries))
          reject(Error('Contributor original backing verification refused'));
        else resolveDone();
      });
    });
    return {
      entries: reply!.entries!,
      certificateRoot: reply!.certificateRoot,
      decodedVersions: reply!.decodedVersions,
      result,
    };
  } finally {
    await worker.terminate();
  }
}

export function captureContributorRecordStaging(
  db: Database,
  storage: object,
  original: ContributorRecordReadOwner,
): ContributorRecordStagingWitness | undefined {
  const location = contributorRecordBackingLocation(storage, original);
  if (!location) return undefined;
  const writes = captureContributorRecordWriteWitness(storage);
  if (!writes) return undefined;
  const witness = Object.freeze({}) as ContributorRecordStagingWitness;
  const frontier = frontiers.get(storage);
  if (
    frontier &&
    (frontier.poisoned ||
      frontier.active ||
      frontier.db !== db ||
      !contributorRecordReadOwnersSameSelection(storage, frontier.original, original))
  ) {
    closeContributorRecordWriteWitness(writes);
    throw Error('Contributor retained backing requires recovery');
  }
  if (frontier) frontier.active = true;
  witnesses.set(witness, {
    db,
    storage,
    original,
    writes,
    location,
    staged: 0,
    preparationAttempted: false,
    finished: false,
    finalAttempted: false,
    closed: false,
    prepared: frontier?.prepared,
    reused: !!frontier,
  });
  let resources = storageResources.get(storage);
  if (!resources) {
    const active = new Set<ContributorRecordStagingWitness>(),
      release = registerContributorRecordStagingDisposal(storage, original, () => {
        closedStorages.add(storage);
        storageResources.delete(storage);
        const frontier = frontiers.get(storage);
        frontiers.delete(storage);
        let failed: unknown;
        for (const member of active) {
          try {
            closeContributorRecordStaging(member);
          } catch (error) {
            failed ??= error;
          }
        }
        active.clear();
        if (frontier) {
          try {
            closeContributorRecordReadOwner(frontier.original);
          } catch (error) {
            failed ??= error;
          }
          try {
            closePrepared(frontier.prepared);
          } catch (error) {
            failed ??= error;
          }
        }
        if (failed) throw failed;
      });
    resources = { active, release };
    storageResources.set(storage, resources);
  }
  resources.active.add(witness);
  return witness;
}

export function contributorRecordStagingCurrent(witness: ContributorRecordStagingWitness): boolean {
  const data = witnesses.get(witness);
  if (!data) return false;
  try {
    if (data.prepared) retained(data);
    else live(data);
    return true;
  } catch {
    return false;
  }
}

export async function prepareContributorRecordTransactionBacking(
  witness: ContributorRecordStagingWitness,
  selectedHead: string,
  current: () => void,
): Promise<void> {
  const data = witnesses.get(witness);
  if (
    !data ||
    data.preparationAttempted ||
    (data.prepared && !data.reused) ||
    data.closed ||
    data.staged
  )
    throw Error('Contributor backing attempt expired');
  data.preparationAttempted = true;
  live(data);
  if (contributorRecordWriteWitnessSequence(data.storage, data.writes))
    throw Error('Contributor backing capture followed immutable writes');
  if (data.reused) {
    try {
      const prepared = retained(data);
      if (selectedHead !== prepared.input.selectedHead || get(prepared.statements.count)!.n !== 0)
        throw Error('Contributor retained backing original selection differs');
      const verified = await runWorker(
        { ...prepared.input, mode: 'verify', entries: prepared.entries },
        () => {
          current();
          retained(data);
        },
      );
      if (verified.entries !== prepared.entries)
        throw Error('Contributor retained backing member count changed');
      recordVersionWork('contributorBackingPhysicalMemberVisits', 2 * prepared.entries);
      return;
    } catch (error) {
      closeContributorRecordStaging(witness);
      throw error;
    }
  }
  const scratch = mkdtempSync(resolve(tmpdir(), 'circus-contributor-backing-')),
    input: ContributorRecordBackingInput = {
      mode: 'prepare',
      ...data.location,
      selectedHead,
      database: resolve(scratch, 'accepted.sqlite'),
      physical: resolve(scratch, 'physical.sqlite'),
      nonce: randomUUID(),
      signatureKey: randomBytes(32),
      checkpointControl: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    };
  let sql: DatabaseSync | undefined;
  try {
    const privateCurrent = () => {
      live(data);
      if (contributorRecordWriteWitnessSequence(data.storage, data.writes))
        throw Error('Contributor original backing changed during replay');
    };
    const prepared = await runWorker(
      input,
      () => {
        current();
        privateCurrent();
      },
      privateCurrent,
    );
    if (prepared.certificateRoot === undefined)
      throw Error('Contributor accepted certificate root missing');
    intakeTreeRef(prepared.certificateRoot);
    rmSync(input.database, { force: true });
    rmSync(input.database + '-wal', { force: true });
    rmSync(input.database + '-shm', { force: true });
    sql = new DatabaseSync(input.physical);
    const prepare = (source: string) =>
        Reflect.apply(nativePrepare, sql!, [source]) as StatementSync,
      statements = {
        changes: prepare('SELECT total_changes() AS n'),
        schema: prepare('PRAGMA main.schema_version'),
        tempSchema: prepare('PRAGMA temp.schema_version'),
        dataVersion: prepare('PRAGMA main.data_version'),
        insert: prepare('INSERT INTO own_additions VALUES(?,?,?,?,?,?)'),
        lookup: prepare('SELECT identity,sha256,bytes,signature FROM own_additions WHERE name=?'),
        count: prepare('SELECT count(*) AS n FROM own_additions'),
        own: prepare(
          'SELECT name,identity,sha256,bytes,signature FROM own_additions WHERE sequence=?',
        ),
        promote: prepare('INSERT INTO physical VALUES(?,?,?,?)'),
        replace: prepare('UPDATE physical SET kind=?,identity=?,signature=? WHERE path=?'),
        clearOwn: prepare('DELETE FROM own_additions'),
        clearSources: prepare('DELETE FROM consumed_sources'),
        clearArtifacts: prepare('DELETE FROM original_artifacts'),
        physicalRow: prepare('SELECT kind,identity,signature FROM physical WHERE path=?'),
      },
      expectedChanges = BigInt(String(get(statements.changes)!.n));
    data.prepared = {
      scratch,
      sql,
      input,
      root: prepared.certificateRoot,
      entries: prepared.entries,
      expectedChanges,
      schema: get(statements.schema)!.schema_version,
      tempSchema: get(statements.tempSchema)!.schema_version,
      dataVersion: get(statements.dataVersion)!.data_version,
      statements,
    };
    recordVersionWork('contributorBackingPhysicalMemberVisits', 3 * prepared.entries);
    recordVersionWork('contributorBackingColdDecodedVersions', prepared.decodedVersions ?? 0);
  } catch (error) {
    if (!data.prepared) {
      sql?.close();
      input.signatureKey.fill(0);
      rmSync(scratch, { recursive: true, force: true });
    }
    closeContributorRecordStaging(witness);
    throw error;
  }
}

export function assertContributorRecordTransactionPrior(
  witness: ContributorRecordStagingWitness,
  entity: string,
  recordId: string,
  previousVersion: string | null,
  prior: { deleted: boolean; preimage: { hash: string; bytes: number } } | null,
): void {
  const data = witnesses.get(witness);
  if (!data) throw Error('Contributor original predecessor unavailable');
  const prepared = retained(data),
    certificates = vaultRecordCertificates(
      prepared.sql,
      prepared.input.profileId,
      prepared.input.nonce,
      () => retained(data),
    ),
    accepted = certificates.get(prepared.root, entity, recordId);
  if (
    previousVersion === null
      ? accepted !== undefined || prior !== null
      : !accepted ||
        !prior ||
        accepted.versionId !== previousVersion ||
        !!accepted.deleted !== prior.deleted ||
        accepted.preimage.hash !== prior.preimage.hash ||
        accepted.preimage.bytes !== prior.preimage.bytes
  )
    throw Error('Contributor accepted record predecessor differs');
  retained(data);
}

export function stageContributorRecordObject(
  witness: ContributorRecordStagingWitness,
  ref: { name: string; sha256: string; bytes: number },
  input: Uint8Array,
): void {
  const data = witnesses.get(witness);
  if (!data || !data.prepared || data.head || data.finished)
    throw Error('Contributor immutable staging continuation expired');
  const preparedParent = retained(data),
    objects = get(preparedParent.statements.physicalRow, 'objects'),
    expectedObjects = preparedParent.input.objectsIdentity ?? String(objects?.identity),
    actualObjects = unlockPhysicalIdentity(resolve(data.location.base, 'objects'));
  if (
    !objects ||
    objects.kind !== 'directory' ||
    objects.signature !==
      createHmac('sha256', preparedParent.input.signatureKey)
        .update(
          JSON.stringify([preparedParent.input.nonce, 'objects', 'directory', objects.identity]),
        )
        .digest('hex') ||
    actualObjects.kind !== 'directory' ||
    actualObjects.value !== expectedObjects
  )
    throw Error('Contributor original objects parent changed before own write');
  // This exact owned write begins a new scratch recipe. The next final worker
  // receives a fresh seal after the signed additions and pending root are fixed.
  data.prepared.physical?.close();
  data.prepared.physical = undefined;
  const retainedObject = stageContributorRecordFactoryObject(data.storage, data.writes, ref, input),
    prepared = data.prepared,
    signature = createHmac('sha256', prepared.input.signatureKey)
      .update(
        JSON.stringify([
          prepared.input.nonce,
          'own-addition',
          ref.name,
          retainedObject.identity,
          retainedObject.sha256,
          retainedObject.bytes,
        ]),
      )
      .digest('hex');
  if (
    run(
      prepared.statements.insert,
      ref.name,
      retainedObject.identity,
      retainedObject.sha256,
      retainedObject.bytes,
      signature,
      data.staged,
    ).changes !== 1
  )
    throw Error('Contributor immutable staging row changed');
  prepared.expectedChanges++;
  data.staged++;
  const ownedObjects = unlockPhysicalIdentity(resolve(data.location.base, 'objects'));
  if (ownedObjects.kind !== 'directory') throw Error('Contributor owned objects parent changed');
  prepared.input.objectsIdentity = ownedObjects.value;
  prepared.input.objectsSignature = createHmac('sha256', prepared.input.signatureKey)
    .update(JSON.stringify([prepared.input.nonce, 'objects', 'directory', ownedObjects.value]))
    .digest('hex');
  retained(data);
}

export function prepareContributorRecordStagingHead(
  witness: ContributorRecordStagingWitness,
  ref: { name: string; sha256: string; bytes: number },
): void {
  const data = witnesses.get(witness);
  if (!data || data.head || data.finished || !data.prepared)
    throw Error('Contributor HEAD staging expired');
  retained(data);
  const row = get(data.prepared.statements.lookup, ref.name);
  if (!row || row.sha256 !== ref.sha256 || row.bytes !== ref.bytes)
    throw Error('Contributor HEAD object was not staged');
  const cap = prepareContributorRecordHeadPublication(data.storage, ref);
  if (!cap) throw Error('Contributor HEAD installation owner missing');
  data.head = cap;
  data.candidateHead = JSON.stringify(ref) + '\n';
}

async function rawRecordDigest(value: string, current: () => void) {
  const hash = createHash('sha256');
  let bytes = 0;
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + 4096, value.length);
    if (
      end < value.length &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    )
      end++;
    const piece = value.slice(offset, end);
    hash.update(piece);
    bytes += Buffer.byteLength(piece);
    offset = end;
    current();
    await yieldHost();
  }
  current();
  return { hash: hash.digest('hex'), bytes };
}

/** Keep the successor derivative separate until the exact indexed receipt is consumed. */
export async function prepareContributorRecordBackingAdvance(
  witness: ContributorRecordStagingWitness,
  exactHead: string,
  plan: RecordTransactionBackingPlan,
): Promise<void> {
  const data = witnesses.get(witness);
  if (!data || !data.head || !data.prepared || data.pending || data.finished)
    throw Error('Contributor retained backing transition expired');
  const prepared = retained(data);
  if (exactHead !== data.candidateHead)
    throw Error('Contributor retained backing successor HEAD differs');
  const certificates = vaultRecordCertificates(
    prepared.sql,
    prepared.input.profileId,
    prepared.input.nonce,
    () => retained(data),
    (writes) => {
      prepared.expectedChanges += BigInt(writes);
    },
  );
  let root = prepared.root;
  const versionIds: string[] = [],
    seen = new Set<string>();
  for (const version of verifiedRecordTransactionBackingVersions(
    plan,
    data.db,
    witness,
    exactHead,
  )) {
    retained(data);
    if (
      !version.entity ||
      !version.recordId ||
      !version.versionId ||
      typeof version.contentsJson !== 'string' ||
      seen.has(version.versionId)
    )
      throw Error('Contributor retained backing changed version invalid');
    const predecessor = certificates.get(root, version.entity, version.recordId);
    if ((predecessor?.versionId ?? null) !== version.previousVersion)
      throw Error('Contributor retained backing changed predecessor differs');
    root = certificates.put(root, {
      entity: version.entity,
      recordId: version.recordId,
      versionId: version.versionId,
      deleted: Number(version.deleted),
      preimage: await rawRecordDigest(version.contentsJson, () => {
        if (!recordTransactionBackingPlanCurrent(plan, data.db, witness))
          throw Error('Contributor pending backing owner changed');
        retained(data);
      }),
      fields: version.sourceFields,
    }).root;
    versionIds.push(version.versionId);
    seen.add(version.versionId);
  }
  if (!versionIds.length) throw Error('Contributor retained backing transition empty');
  retained(data);
  data.pending = { root, head: exactHead, plan, versionIds };
}

export async function finishContributorRecordStagingPreparation(
  witness: ContributorRecordStagingWitness,
  current: () => void,
): Promise<void> {
  const data = witnesses.get(witness);
  if (!data || !data.head || data.finished || data.finalAttempted)
    throw Error('Contributor final staging expired');
  data.finalAttempted = true;
  const prepared = retained(data);
  if (get(prepared.statements.count)!.n !== data.staged)
    throw Error('Contributor immutable write roster differs from staged objects');
  const physical = realpathSync.native(prepared.input.physical);
  prepared.physical = captureRecordHeadPhysical([physical], [dirname(physical)]);
  current();
  const verified = await runWorker(
    {
      ...prepared.input,
      mode: 'verify',
      entries: prepared.entries,
    },
    () => {
      current();
      retained(data);
      if (!contributorRecordHeadPublicationCurrent(data.storage, data.head!))
        throw Error('Contributor HEAD owner changed during final verification');
    },
  );
  if (verified.entries !== prepared.entries + data.staged)
    throw Error('Contributor final physical member count differs');
  data.finished = true;
  recordVersionWork('contributorBackingPhysicalMemberVisits', 2 * verified.entries);
}

/** The final reply can execute only the private core-issued T2 body. */
export async function finishContributorRecordTransactionPreparation(
  witness: ContributorRecordStagingWitness,
  plan: RecordTransactionBackingPlan,
  execution: RecordTransactionTerminalExecution,
): Promise<unknown> {
  const data = witnesses.get(witness);
  if (
    !data ||
    !data.head ||
    !data.pending ||
    data.finished ||
    data.finalAttempted ||
    data.pending.plan !== plan
  )
    throw Error('Contributor record transaction completion expired');
  data.finalAttempted = true;
  const prepared = retained(data),
    current = () => {
      retained(data);
      if (
        !recordTransactionTerminalExecutionCurrent(execution, data.db, witness, plan) ||
        !contributorRecordHeadPublicationCurrent(data.storage, data.head!)
      )
        throw Error('Contributor record transaction terminal issuer changed');
    },
    prepare = (sql: string) => Reflect.apply(nativePrepare, prepared.sql, [sql]) as StatementSync,
    sourceInsert = prepare('INSERT OR IGNORE INTO consumed_sources VALUES(?,?,?)'),
    sourceClear = prepare('DELETE FROM consumed_sources'),
    artifactInsert = prepare('INSERT INTO original_artifacts VALUES(?,?,?,?,?)'),
    artifactClear = prepare('DELETE FROM original_artifacts'),
    certificates = vaultRecordCertificates(
      prepared.sql,
      prepared.input.profileId,
      prepared.input.nonce,
      current,
    ),
    sign = (path: string, kind: string, identity: string) =>
      createHmac('sha256', prepared.input.signatureKey)
        .update(JSON.stringify([prepared.input.nonce, path, kind, identity]))
        .digest('hex');
  prepared.physical?.close();
  prepared.physical = undefined;
  prepared.expectedChanges += BigInt(run(sourceClear).changes) + BigInt(run(artifactClear).changes);
  let sources = 0;
  for (const original of verifiedRecordTransactionOriginalSources(plan, data.db, witness)) {
    current();
    const accepted = certificates.get(
      prepared.root,
      'source_files',
      JSON.stringify([original.binding.intakeId]),
    );
    if (!accepted || accepted.deleted || original.binding.profileId !== prepared.input.profileId)
      throw Error('Contributor original leased source certificate missing');
    const binding = {
      id: original.binding.intakeId,
      kind: 'intake_original',
      path: original.acceptedPath,
      sha256: original.binding.sourceHash,
      bytes: original.binding.bytes,
    };
    for (const [name, value] of Object.entries(binding)) {
      const field = accepted.fields.find((candidate) => candidate.name === name),
        digest =
          typeof value === 'string'
            ? await recordStringFieldDigest(value, current)
            : recordFieldDigest(JSON.stringify(value));
      if (!field || field.hash !== digest.hash || field.bytes !== digest.bytes)
        throw Error('Contributor original leased source certificate differs');
    }
    const serialized = JSON.stringify(original),
      inserted = run(
        sourceInsert,
        sources,
        serialized,
        sign('consumed-source:' + sources, 'source', serialized),
      ).changes;
    prepared.expectedChanges += BigInt(inserted);
    sources += Number(inserted);
    await yieldHost();
  }
  prepared.input.originalSources = sources;
  let artifacts = 0;
  for (const original of verifiedRecordTransactionOriginalArtifacts(plan, data.db, witness)) {
    current();
    if (
      run(
        artifactInsert,
        artifacts,
        original.id,
        original.path,
        original.identity,
        sign(
          'parent-artifact:' + artifacts,
          'artifact',
          JSON.stringify([original.id, original.path, original.identity]),
        ),
      ).changes !== 1
    )
      throw Error('Contributor original artifact membership differs');
    prepared.expectedChanges++;
    artifacts++;
    if (artifacts % 64 === 0) await yieldHost();
  }
  prepared.input.originalArtifacts = artifacts;
  current();
  if (get(prepared.statements.count)!.n !== data.staged)
    throw Error('Contributor immutable write roster differs from staged objects');
  const physical = realpathSync.native(prepared.input.physical);
  prepared.physical = captureRecordHeadPhysical([physical], [dirname(physical)]);
  const verified = await runWorker(
    { ...prepared.input, mode: 'verify', entries: prepared.entries },
    current,
    current,
    (entries) => {
      if (entries !== prepared.entries + data.staged)
        throw Error('Contributor final physical member count differs');
      current();
      data.finished = true;
      recordVersionWork('contributorBackingPhysicalMemberVisits', 2 * entries);
      return runRecordTransactionTerminalExecution(execution, data.db, witness, plan);
    },
  );
  return verified.result;
}

export function installContributorRecordStagingHead(
  witness: ContributorRecordStagingWitness,
  indexed: RecordTransactionIndexedPublication,
  plan: RecordTransactionBackingPlan,
): void {
  const data = witnesses.get(witness);
  if (!data || !data.finished || !data.head || !data.pending)
    throw Error('Contributor HEAD installation not sealed');
  retained(data);
  if (!contributorRecordHeadPublicationCurrent(data.storage, data.head))
    throw Error('Contributor HEAD installation owner changed');
  if (
    data.pending.head !== data.candidateHead ||
    data.pending.plan !== plan ||
    !consumeRecordTransactionBackingAdvance(data.db, indexed, witness, data.pending.head, plan)
  )
    throw Error('Contributor indexed backing transition unavailable');
  const cap = data.head;
  data.finished = false;
  installContributorRecordHeadPublication(data.storage, cap);
  data.installedSuccessor = captureContributorRecordInstalledReadOwner(data.storage, cap);
  const paths = ['', 'objects', 'head'],
    parents = [];
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index]!;
    const actual = unlockPhysicalIdentity(resolve(data.location.base, path));
    parents.push(Object.freeze({ path, kind: actual.kind, identity: actual.value }));
  }
  data.installedParents = Object.freeze(parents);
  data.installed = true;
}

/** Post-commit derivative promotion is not publication permission. A failed
 * promotion expires the cache but preserves the already committed receipt. */
export function completeContributorRecordStagingPublication(
  db: Database,
  witness: ContributorRecordStagingWitness,
  plan: RecordTransactionBackingPlan,
): void {
  // Validate the actual one-use committed grant BEFORE observing a possibly
  // disposed derivative. Closing resources cannot erase an accepted receipt.
  consumeRecordTransactionBackingPublication(plan, db, witness);
  const data = witnesses.get(witness);
  if (!data) return;
  if (
    data.db !== db ||
    !db.isOpen ||
    !data.installed ||
    !data.head ||
    !data.pending ||
    !data.prepared ||
    data.pending.plan !== plan
  ) {
    try {
      closeContributorRecordStaging(witness);
    } catch {
      /* accepted receipt survives disposal */
    }
    return;
  }
  const prepared = data.prepared;
  const previousFrontier = frontiers.get(data.storage);
  let successor: ContributorRecordReadOwner | undefined;
  try {
    if (
      !prepared.physical?.current() ||
      BigInt(String(get(prepared.statements.changes)!.n)) !== prepared.expectedChanges ||
      get(prepared.statements.schema)!.schema_version !== prepared.schema ||
      get(prepared.statements.tempSchema)!.schema_version !== prepared.tempSchema ||
      get(prepared.statements.dataVersion)!.data_version !== prepared.dataVersion ||
      get(prepared.statements.count)!.n !== data.staged
    )
      throw Error('Contributor accepted scratch continuation changed');
    successor = data.installedSuccessor;
    if (
      !successor ||
      !contributorRecordReadOwnerCurrent(data.storage, successor) ||
      !data.installedParents
    )
      throw Error('Contributor original installed successor changed');
    prepared.physical.close();
    prepared.physical = undefined;
    const sign = (path: string, kind: string, identity: string) =>
      createHmac('sha256', prepared.input.signatureKey)
        .update(JSON.stringify([prepared.input.nonce, path, kind, identity]))
        .digest('hex');
    for (let sequence = 0; sequence < data.staged; sequence++) {
      const row = get(prepared.statements.own, sequence);
      if (
        !row ||
        row.signature !==
          createHmac('sha256', prepared.input.signatureKey)
            .update(
              JSON.stringify([
                prepared.input.nonce,
                'own-addition',
                row.name,
                row.identity,
                row.sha256,
                row.bytes,
              ]),
            )
            .digest('hex')
      )
        throw Error('Contributor accepted own addition changed');
      if (
        run(
          prepared.statements.promote,
          row.name,
          'file',
          row.identity,
          sign(String(row.name), 'file', String(row.identity)),
        ).changes !== 1
      )
        throw Error('Contributor accepted own addition membership changed');
      prepared.expectedChanges++;
    }
    // Only identities changed by this exact create-only object recipe and
    // lexical HEAD installer advance. No namespace enumeration occurs here.
    for (const original of data.installedParents) {
      const { path } = original,
        actual = unlockPhysicalIdentity(resolve(data.location.base, path));
      if (
        actual.kind !== original.kind ||
        actual.value !== original.identity ||
        (path === 'head' ? actual.kind !== 'file' : actual.kind !== 'directory') ||
        run(
          prepared.statements.replace,
          actual.kind,
          original.identity,
          sign(path, original.kind, original.identity),
          path,
        ).changes !== 1
      )
        throw Error('Contributor accepted owned parent continuation changed');
      prepared.expectedChanges++;
    }
    prepared.expectedChanges +=
      BigInt(run(prepared.statements.clearOwn).changes) +
      BigInt(run(prepared.statements.clearSources).changes) +
      BigInt(run(prepared.statements.clearArtifacts).changes);
    prepared.entries += data.staged;
    prepared.root = data.pending.root;
    prepared.input.selectedHead = data.pending.head;
    prepared.input.originalSources = undefined;
    prepared.input.originalArtifacts = undefined;
    prepared.input.objectsIdentity = undefined;
    prepared.input.objectsSignature = undefined;
    const physical = realpathSync.native(prepared.input.physical);
    prepared.physical = captureRecordHeadPhysical([physical], [dirname(physical)]);
    if (previousFrontier) closeContributorRecordReadOwner(previousFrontier.original);
    frontiers.set(data.storage, {
      db: data.db,
      original: successor,
      prepared,
      poisoned: false,
      active: false,
    });
    successor = undefined;
    data.installedSuccessor = undefined;
    data.prepared = undefined;
    try {
      closeContributorRecordStaging(witness);
    } catch {
      /* accepted receipt survives disposal */
    }
  } catch {
    try {
      if (successor) closeContributorRecordReadOwner(successor);
    } catch {
      /* continue disposal */
    }
    try {
      if (previousFrontier) closeContributorRecordReadOwner(previousFrontier.original);
    } catch {
      /* continue disposal */
    }
    // An uncertain derivative must not adopt orphan additions on a later try.
    frontiers.set(data.storage, {
      db: data.db,
      original: data.original,
      prepared,
      poisoned: true,
      active: false,
    });
    try {
      closeContributorRecordStaging(witness);
    } catch {
      /* accepted receipt survives disposal */
    }
  }
}

export function discardContributorRecordStaging(witness: ContributorRecordStagingWitness): void {
  closeContributorRecordStaging(witness);
}
function closeContributorRecordStaging(witness: ContributorRecordStagingWitness): void {
  const data = witnesses.get(witness);
  witnesses.delete(witness);
  if (!data || data.closed) return;
  data.closed = true;
  storageResources.get(data.storage)?.active.delete(witness);
  let failed: unknown;
  const dispose = (cleanup: () => void) => {
    try {
      cleanup();
    } catch (error) {
      failed ??= error;
    }
  };
  const frontier = frontiers.get(data.storage);
  if (
    data.reused &&
    frontier &&
    frontier.prepared === data.prepared &&
    !data.preparationAttempted &&
    !data.staged &&
    !data.head
  ) {
    frontier.active = false;
    data.prepared = undefined;
  } else if (data.reused && frontier && frontier.prepared === data.prepared) {
    frontier.poisoned = true;
    frontier.active = false;
    dispose(() => closeContributorRecordReadOwner(frontier.original));
  } else if (data.prepared && !frontier && !closedStorages.has(data.storage)) {
    frontiers.set(data.storage, {
      db: data.db,
      original: data.original,
      prepared: data.prepared,
      poisoned: true,
      active: false,
    });
  }
  if (data.head) dispose(() => closeContributorRecordHeadPublication(data.head!));
  if (data.installedSuccessor)
    dispose(() => closeContributorRecordReadOwner(data.installedSuccessor!));
  dispose(() => closeContributorRecordWriteWitness(data.writes));
  if (data.prepared) {
    dispose(() => closePrepared(data.prepared!));
  }
  if (failed) throw failed;
}
