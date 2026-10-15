import { Worker } from 'node:worker_threads';
import { setImmediate as yieldHost } from 'node:timers/promises';
import type { PackageSourceOriginalPhysical } from './intake-package-source-lease.ts';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, relative, dirname } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import type { VerifiedClinicalArtifact } from './intake-review-collection-session.ts';
import { captureRecordHeadPhysical } from './record-head-physical.ts';
import { unlockPhysicalIdentity } from './encrypted-unlock-physical.ts';
import { recordFieldDigest, recordStringFieldDigest } from './record-prior-fields.ts';
import {
  vaultRecordCertificates,
  type VaultRecordCertificate,
} from './vault-record-certificates.ts';
import { intakeTreeRef, type IntakeTreeRoot } from './intake-state-tree.ts';
import { recordVersionWork } from './record-version-work.ts';
import { unlockPhysicalEntries } from './encrypted-unlock-physical.ts';
import type {
  RecordReplaySourcePair,
  RecordReplaySourcePairRequest,
} from './record-replay-source-pair.ts';
import {
  checkedRecordReplaySourcePair,
  signRecordReplaySourcePair,
} from './record-replay-source-pair.ts';

const nativeStatementGet = StatementSync.prototype.get;
const nativeStatementRun = StatementSync.prototype.run;

interface SelectedSourceBackingBinding {
  kind?: 'source';
  sourceId: string;
  previousVersion: string;
  preimage: { hash: string; bytes: number };
  fields: readonly { name: string; hash: string; bytes: number }[];
  metadata: readonly { key: string; value: string | undefined }[];
}
export type VaultRecordBackingBinding =
  | SelectedSourceBackingBinding
  | {
      kind: 'records';
      fields: readonly [];
      metadata: readonly [];
      pair?: RecordReplaySourcePairRequest;
    }
  | {
      kind: 'head';
      fields: readonly [];
      metadata: readonly [{ key: string; value: string }];
      pair?: RecordReplaySourcePairRequest;
    };
export type VaultRecordBackingInput = VaultRecordBackingBinding & {
  mode: 'prepare' | 'verify' | 'advance';
  directory: string;
  database: string;
  physical: string;
  profileId: string;
  selectedHead: string;
  key: Uint8Array;
  signatureKey: Uint8Array;
  nonce: string;
  entries?: number;
  workspace?: string;
  workspaceNames?: readonly string[];
  originalSources?: number;
  originalArtifacts?: number;
  checkpointControl: SharedArrayBuffer;
  /** Advance only: the HEAD the retained replay projection is at, every own
   * HEAD published since (in order) and the record objects own ordinary
   * publications added. */
  replayHead?: string;
  chain?: readonly string[];
  ownObjects?: readonly string[];
  advancePair?: RecordReplaySourcePairRequest;
  advancePairOptional?: boolean;
};
/** One certificate delta entry; `previousAccepted` is the version the retained
 * replay root must still hold for the key before the delta applies. */
export interface VaultRecordAdvancedCertificate extends VaultRecordCertificate {
  previousAccepted: string | null;
}
/** Bounds for one retained replay frontier; beyond them the next proof is cold. */
const MAX_OWN_HEADS = 256,
  MAX_OWN_OBJECTS = 64 * MAX_OWN_HEADS,
  replayResidue = ['-wal', '-shm', '-journal'],
  recordObject = /^versions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.enc$/;

/** Transport owned only by the registered actual vault factory. Not authority. */
export async function prepareVaultRecordBackingTransport(
  directory: string,
  profileId: string,
  key: Uint8Array,
  selectedHead: string,
  binding: VaultRecordBackingBinding,
  initialCurrent: () => void,
  workspace?: string,
  workspaceNames?: readonly string[],
) {
  let activeCurrent: (() => void) | undefined = initialCurrent;
  const assertCurrent = () => {
    if (!activeCurrent) throw Error('Vault backing transport not acquired');
    activeCurrent();
  };
  assertCurrent();
  if (
    binding.fields.length > 64 ||
    binding.metadata.length > 4 ||
    (binding.kind === 'head'
      ? binding.fields.length !== 0 || binding.metadata.length !== 1
      : binding.kind === 'records'
        ? binding.fields.length !== 0 || binding.metadata.length !== 0
        : !/^[0-9a-f]{64}$/.test(binding.preimage.hash) ||
          !Number.isSafeInteger(binding.preimage.bytes) ||
          binding.preimage.bytes < 0) ||
    Buffer.byteLength(selectedHead) > 4096 ||
    binding.fields.some(
      (field) =>
        Buffer.byteLength(field.name) > 256 ||
        !/^[0-9a-f]{64}$/.test(field.hash) ||
        !Number.isSafeInteger(field.bytes) ||
        field.bytes < 0,
    ) ||
    new Set(binding.fields.map((field) => field.name)).size !== binding.fields.length ||
    binding.metadata.some(
      (row) =>
        Buffer.byteLength(row.key) > 16384 ||
        (row.value !== undefined && Buffer.byteLength(row.value) > 32768),
    )
  )
    throw Error('Vault backing fixed source binding invalid');
  const scratch = mkdtempSync(resolve(tmpdir(), 'circus-vault-record-backing-')),
    physical = resolve(scratch, 'physical.sqlite'),
    signatureKey = randomBytes(32),
    nonce = randomUUID();
  const retained = structuredClone(binding);
  const input: VaultRecordBackingInput = {
    ...retained,
    mode: 'prepare',
    directory,
    database: resolve(scratch, 'accepted.sqlite'),
    physical,
    profileId,
    selectedHead,
    key: Buffer.from(key),
    signatureKey,
    nonce,
    workspace,
    workspaceNames: workspaceNames && [...workspaceNames],
    checkpointControl: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  };
  let closed = false;
  const run = async (
    mode: VaultRecordBackingInput['mode'],
    entries?: number,
    final?: () => unknown,
    extra: Partial<VaultRecordBackingInput> = {},
  ) => {
    assertCurrent();
    if (closed) throw Error('Vault backing transport closed');
    const worker = new Worker(new URL('./vault-record-backing-worker.ts', import.meta.url), {
      workerData: { ...input, ...extra, mode, entries },
    });
    let reply:
      | {
          entries?: number;
          refused?: boolean;
          certificateRoot?: IntakeTreeRoot;
          decodedVersions?: number;
          sourcePair?: RecordReplaySourcePair;
          sourcePairSignature?: string;
          certificates?: VaultRecordAdvancedCertificate[];
          workspace?: { path: string; kind: string; identity: string }[];
        }
      | undefined;
    let failed: unknown;
    let stopped = false;
    let finalResult: unknown;
    let finalized = false;
    const checkpoint = () => {
      try {
        assertCurrent();
      } catch (error) {
        if (!stopped) {
          stopped = true;
          failed = error;
          void worker.terminate();
        }
      } finally {
        const control = new Int32Array(input.checkpointControl);
        Atomics.store(control, 0, 0);
        Atomics.notify(control, 0);
      }
    };
    try {
      await new Promise<void>((complete, reject) => {
        worker.on('message', (message) => {
          if (message?.checkpoint === true) checkpoint();
          else if (reply) reject(Error('Vault backing worker repeated result'));
          else {
            reply = message;
            if (final) {
              try {
                if (stopped || reply?.refused || reply?.entries !== entries)
                  throw (
                    failed ??
                    Error('Vault original backing verification refused: combined roster changed')
                  );
                // The synchronous private owner continuation runs in this reply
                // turn, not after a second worker or the worker-exit event.
                assertCurrent();
                finalResult = final();
                finalized = true;
                complete();
              } catch (error) {
                reject(error);
              }
            }
          }
        });
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (finalized) return;
          if (stopped) reject(failed);
          else if (code || reply?.refused || !Number.isSafeInteger(reply?.entries))
            reject(Error('Vault original backing verification refused'));
          else complete();
        });
      });
      if (!finalized) assertCurrent();
      recordVersionWork('vaultBackingPhysicalMembersVerified', reply!.entries!);
      return { ...reply!, finalResult };
    } finally {
      if (finalized) await worker.terminate().catch(() => undefined);
      else await worker.terminate();
    }
  };
  let sql: DatabaseSync | undefined;
  try {
    recordVersionWork('vaultBackingColdReplays');
    const prepared = await run('prepare');
    let acceptedPair: RecordReplaySourcePair | undefined;
    let acceptedPairSignature: string | undefined;
    if (
      (retained.kind === 'head' || retained.kind === 'records') &&
      retained.pair &&
      (retained.kind === 'head' || prepared.sourcePair)
    ) {
      acceptedPair = checkedRecordReplaySourcePair(retained.pair, prepared.sourcePair);
      const expected = Buffer.from(
          signRecordReplaySourcePair(signatureKey, nonce, acceptedPair),
          'hex',
        ),
        actual = Buffer.from(prepared.sourcePairSignature ?? '', 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw Error('Vault accepted source pair worker receipt changed');
      acceptedPairSignature = prepared.sourcePairSignature;
    } else if (prepared.sourcePair || prepared.sourcePairSignature)
      throw Error('Vault unsolicited accepted source pair');
    if (!Number.isSafeInteger(prepared.decodedVersions) || prepared.decodedVersions! < 0)
      throw Error('Vault backing replay count invalid');
    recordVersionWork('vaultBackingColdDecodedVersions', prepared.decodedVersions);
    let entries = prepared.entries!;
    if (prepared.certificateRoot === undefined)
      throw Error('Vault accepted certificate root missing');
    let certificateRoot: IntakeTreeRoot = prepared.certificateRoot;
    intakeTreeRef(certificateRoot);
    recordVersionWork('vaultBackingCertificateWrites', certificateRoot?.count ?? 0);
    // The retained proof keeps its verified replay projection, sealed by
    // physical identity, so exact own publications can extend it later. It is
    // never read as authority: an advance replays the new commits onto it and
    // any change to its identity discards the whole frontier.
    let replayHead = selectedHead,
      replayRoot: IntakeTreeRoot = certificateRoot,
      replay: ReturnType<typeof captureRecordHeadPhysical> | undefined;
    const chain: string[] = [],
      ownObjects: string[] = [];
    let pendingOwn = 0;
    const sealReplay = () => {
      replay?.close();
      replay = undefined;
      if (replayResidue.some((suffix) => existsSync(input.database + suffix)))
        throw Error('Vault retained replay residue present');
      const real = realpathSync.native(input.database);
      replay = captureRecordHeadPhysical([real], [dirname(real)]);
    };
    const dropReplay = () => {
      try {
        replay?.close();
      } finally {
        replay = undefined;
        for (const suffix of ['', ...replayResidue])
          rmSync(input.database + suffix, { force: true });
      }
    };
    try {
      sealReplay();
    } catch {
      dropReplay();
    }
    const tip = () => (chain.length ? chain[chain.length - 1]! : input.selectedHead);
    let pairRequest =
      retained.kind === 'head' || retained.kind === 'records' ? retained.pair : undefined;
    type PositivePairSelection = Readonly<{
      request: string;
      head: string;
      kind: 'head' | 'records';
      pair: RecordReplaySourcePair;
      signature: string;
      replay: NonNullable<typeof replay>;
    }>;
    let positivePairSelection: PositivePairSelection | undefined;
    const sameRequest = (pair: RecordReplaySourcePairRequest) =>
      JSON.stringify([pair.sourceVersionId, pair.identity]);
    const sealPositivePairSelection = (kind: VaultRecordBackingBinding['kind']) => {
      positivePairSelection =
        acceptedPair &&
        acceptedPairSignature &&
        pairRequest &&
        replay &&
        (kind === 'head' || kind === 'records')
          ? Object.freeze({
              request: sameRequest(pairRequest),
              head: input.selectedHead,
              kind,
              pair: acceptedPair,
              signature: acceptedPairSignature,
              replay,
            })
          : undefined;
    };
    sealPositivePairSelection(retained.kind);
    const reusablePositivePair = (
      pair: RecordReplaySourcePairRequest | undefined,
      kind?: VaultRecordBackingBinding['kind'],
    ) => {
      const selected = positivePairSelection;
      if (
        !pair ||
        !selected ||
        !acceptedPair ||
        !acceptedPairSignature ||
        !replay ||
        selected.replay !== replay ||
        selected.pair !== acceptedPair ||
        selected.signature !== acceptedPairSignature ||
        selected.request !== sameRequest(pair) ||
        (kind !== undefined && selected.kind !== kind) ||
        selected.head !== input.selectedHead ||
        replayHead !== input.selectedHead ||
        chain.length ||
        ownObjects.length ||
        pendingOwn ||
        pending ||
        installed ||
        capturedParent ||
        capturedHeadParent ||
        !replay.current() ||
        replayResidue.some((suffix) => existsSync(input.database + suffix))
      )
        return false;
      const expected = Buffer.from(
          signRecordReplaySourcePair(signatureKey, nonce, acceptedPair),
          'hex',
        ),
        actual = Buffer.from(selected.signature, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    };
    sql = new DatabaseSync(physical);
    const lookup = sql.prepare('SELECT kind,identity,signature FROM physical WHERE path=?'),
      insert = sql.prepare('INSERT INTO physical VALUES(?,?,?,?)'),
      update = sql.prepare('UPDATE physical SET identity=?,signature=? WHERE path=?'),
      workspaceClear = sql.prepare('DELETE FROM workspace'),
      workspaceInsert = sql.prepare('INSERT INTO workspace VALUES(?,?,?,?)');
    const changes = sql.prepare('SELECT CAST(total_changes() AS TEXT) AS n'),
      main = sql.prepare('PRAGMA main.schema_version'),
      temp = sql.prepare('PRAGMA temp.schema_version'),
      peer = sql.prepare('PRAGMA main.data_version');
    let expectedChanges = BigInt(String(changes.get()!.n));
    const schemas = [main.get()!.schema_version, temp.get()!.schema_version],
      dataVersion = peer.get()!.data_version;
    const sourceInsert = sql.prepare('INSERT OR IGNORE INTO consumed_sources VALUES(?,?,?)'),
      sourceClear = sql.prepare('DELETE FROM consumed_sources');
    const get = (statement: StatementSync) => Reflect.apply(nativeStatementGet, statement, [])!;
    const scratchCurrent = () => {
      if (
        !sql!.isOpen ||
        BigInt(String(get(changes).n)) !== expectedChanges ||
        get(main).schema_version !== schemas[0] ||
        get(temp).schema_version !== schemas[1] ||
        get(peer).data_version !== dataVersion
      )
        throw Error('Vault backing scratch continuity changed');
    };
    const root = resolve(directory, 'vault');
    const sign = (path: string, kind: string, identity: string) =>
      createHmac('sha256', signatureKey)
        .update(JSON.stringify([nonce, path, kind, identity]))
        .digest('hex');
    const certificates = vaultRecordCertificates(
      sql,
      profileId,
      nonce,
      () => {
        assertCurrent();
        scratchCurrent();
      },
      (count) => {
        expectedChanges += BigInt(count);
      },
    );
    const retainOriginalSources = async (sources: Iterable<PackageSourceOriginalPhysical>) => {
      scratchCurrent();
      expectedChanges += BigInt(sourceClear.run().changes);
      let count = 0,
        visited = 0;
      for (const original of sources) {
        assertCurrent();
        scratchCurrent();
        const accepted = certificates.getPrivate(
          certificateRoot,
          'source_files',
          JSON.stringify([original.binding.intakeId]),
        );
        if (!accepted || accepted.deleted || original.binding.profileId !== profileId)
          throw Error('Vault original leased source certificate missing');
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
                ? await recordStringFieldDigest(value, assertCurrent)
                : recordFieldDigest(JSON.stringify(value));
          if (!field || field.hash !== digest.hash || field.bytes !== digest.bytes)
            throw Error('Vault original leased source certificate differs');
          scratchCurrent();
        }
        const source = JSON.stringify(original),
          signature = sign('consumed-source:' + count, 'source', source);
        const inserted = sourceInsert.run(count, source, signature).changes;
        expectedChanges += BigInt(inserted);
        count += Number(inserted);
        if (++visited % 64 === 0) {
          await yieldHost();
          assertCurrent();
        }
      }
      input.originalSources = count;
      scratchCurrent();
    };
    const assertBinding = (next: VaultRecordBackingBinding) => {
      // Whole-record admission authenticates the full namespace/root only.
      // The private consumer must check each changed predecessor explicitly.
      if (next.kind === 'records') {
        if (next.fields.length || next.metadata.length)
          throw Error('Vault record-only binding has selected source fields');
        return;
      }
      if (next.kind !== 'head') {
        const source = certificates.getPrivate(
          certificateRoot,
          'source_files',
          JSON.stringify([next.sourceId]),
        );
        if (
          !source ||
          source.deleted ||
          source.versionId !== next.previousVersion ||
          JSON.stringify(source.preimage) !== JSON.stringify(next.preimage) ||
          source.fields.length !== next.fields.length ||
          source.fields.some(
            (field) =>
              !next.fields.some(
                (candidate) =>
                  candidate.name === field.name &&
                  candidate.hash === field.hash &&
                  candidate.bytes === field.bytes,
              ),
          )
        )
          throw Error('Vault accepted source certificate differs');
      }
      for (const row of next.metadata) {
        const accepted = certificates.getPrivate(
          certificateRoot,
          'app_meta',
          JSON.stringify([row.key]),
        );
        const field = accepted?.fields.find((field) => field.name === 'value');
        const digest =
          row.value === undefined ? undefined : recordFieldDigest(JSON.stringify(row.value));
        if (
          row.value === undefined
            ? accepted && !accepted.deleted
            : !accepted ||
              accepted.deleted ||
              field?.hash !== digest?.hash ||
              field?.bytes !== digest?.bytes
        )
          throw Error('Vault selected native certificate differs');
      }
    };
    assertBinding(retained);
    let pending:
      | { root: IntakeTreeRoot; head: string; versions: string[]; kind: 'compact' }
      | { root: IntakeTreeRoot; head: string; kind: 'records' }
      | undefined;
    let capturedParent: { path: string; identity: string } | undefined;
    let capturedHeadParent: string | undefined;
    let compactBindings = input.kind !== 'head';
    let installed:
      | {
          head: string;
          physical: ReturnType<typeof captureRecordHeadPhysical>;
          parents: readonly { path: string; kind: string; identity: string }[];
        }
      | undefined;
    // A staged promotion already advanced the certificates exactly; the replay
    // projection stays behind and catches up across it on the next advance.
    const retainStagedHead = (head: string) => {
      if (!replay || chain.length >= MAX_OWN_HEADS || pendingOwn) dropReplay();
      else chain.push(head);
    };
    /** Extend the retained replay across exactly the recorded chain. Any
     * refusal leaves this transport unusable; the caller closes it and runs a
     * complete cold replay from the selected HEAD. */
    const advance = async (
      pair: RecordReplaySourcePairRequest | undefined,
      optionalPair: boolean,
    ) => {
      scratchCurrent();
      if (!replay?.current() || replayResidue.some((suffix) => existsSync(input.database + suffix)))
        throw Error('Vault retained replay changed');
      // The worker writes the projection; its identity is resealed afterwards.
      replay.close();
      replay = undefined;
      acceptedPair = undefined;
      acceptedPairSignature = undefined;
      pairRequest = undefined;
      positivePairSelection = undefined;
      const extra: Partial<VaultRecordBackingInput> = {
        replayHead,
        chain: [...chain],
        ownObjects: [...ownObjects],
        advancePair: pair && structuredClone(pair),
        advancePairOptional: optionalPair,
        originalSources: undefined,
        originalArtifacts: undefined,
      };
      const advanced = await run('advance', entries, undefined, extra);
      if (advanced.entries !== entries) throw Error('Vault advanced backing member count changed');
      if (pair && (!optionalPair || advanced.sourcePair)) {
        const checked = checkedRecordReplaySourcePair(pair, advanced.sourcePair);
        const expected = Buffer.from(
            signRecordReplaySourcePair(signatureKey, nonce, checked),
            'hex',
          ),
          actual = Buffer.from(advanced.sourcePairSignature ?? '', 'hex');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
          throw Error('Vault accepted source pair worker receipt changed');
        acceptedPair = checked;
        acceptedPairSignature = advanced.sourcePairSignature;
      } else if (advanced.sourcePair || advanced.sourcePairSignature)
        throw Error('Vault unsolicited accepted source pair');
      if (!Number.isSafeInteger(advanced.decodedVersions) || advanced.decodedVersions! < 0)
        throw Error('Vault advanced replay count invalid');
      const changed = advanced.certificates;
      if (!Array.isArray(changed) || (!chain.length && changed.length))
        throw Error('Vault advanced certificate delta invalid');
      let next = replayRoot;
      for (const certificate of changed) {
        // Each delta continues the retained replay root's accepted predecessor.
        const predecessor = certificates.getPrivate(next, certificate.entity, certificate.recordId);
        if ((predecessor?.versionId ?? null) !== certificate.previousAccepted)
          throw Error('Vault advanced predecessor differs from original proof');
      }
      if (changed.length) {
        sql!.exec('BEGIN');
        try {
          for (let at = 0; at < changed.length; at += 64)
            next = certificates.putMany(
              next,
              changed.slice(at, at + 64).map(({ previousAccepted: _, ...value }) => value),
            ).root;
          scratchCurrent();
          sql!.exec('COMMIT');
        } catch (error) {
          if (sql!.isTransaction) sql!.exec('ROLLBACK');
          throw error;
        }
      }
      intakeTreeRef(next);
      recordVersionWork('vaultBackingCertificateWrites', changed.length);
      if (input.workspace) {
        const workspace = advanced.workspace;
        if (!Array.isArray(workspace)) throw Error('Vault advanced workspace roster missing');
        scratchCurrent();
        expectedChanges += BigInt(Reflect.apply(nativeStatementRun, workspaceClear, []).changes);
        for (const item of workspace) {
          if (
            Reflect.apply(nativeStatementRun, workspaceInsert, [
              item.path,
              item.kind,
              item.identity,
              sign('workspace:' + item.path, item.kind, item.identity),
            ]).changes !== 1
          )
            throw Error('Vault advanced workspace roster changed');
          expectedChanges++;
        }
        scratchCurrent();
      } else if (advanced.workspace !== undefined)
        throw Error('Vault unsolicited workspace roster');
      sealReplay();
      const final = tip();
      certificateRoot = next;
      replayRoot = next;
      replayHead = final;
      input.selectedHead = final;
      chain.length = 0;
      ownObjects.length = 0;
      pendingOwn = 0;
      pairRequest = acceptedPair && pair ? structuredClone(pair) : undefined;
      sealPositivePairSelection(optionalPair ? 'records' : 'head');
      scratchCurrent();
      recordVersionWork('vaultBackingIncrementalAdvances');
      recordVersionWork('vaultBackingIncrementalDecodedVersions', advanced.decodedVersions);
    };
    return {
      supportsRecordPriors: input.kind === 'records',
      supportsHeadBindings: true,
      acceptedSourcePair(request: RecordReplaySourcePairRequest): RecordReplaySourcePair {
        assertCurrent();
        scratchCurrent();
        if (
          !acceptedPair ||
          !pairRequest ||
          request.sourceVersionId !== pairRequest.sourceVersionId ||
          JSON.stringify(request.identity) !== JSON.stringify(pairRequest.identity)
        )
          throw Error('Vault accepted source pair not retained');
        return acceptedPair;
      },
      get supportsCompactBindings() {
        return compactBindings;
      },
      /** An exact positive selection can use a fresh physical verification;
       * absence and every changed frontier still require replay. */
      advanceRequired(
        pair?: RecordReplaySourcePairRequest,
        kind?: VaultRecordBackingBinding['kind'],
      ): boolean {
        return pendingOwn > 0 || (!!pair && !reusablePositivePair(pair, kind));
      },
      async acquire(
        nextHead: string,
        nextBinding: VaultRecordBackingBinding,
        check: () => void,
      ): Promise<void> {
        const pair =
          nextBinding.kind === 'head' || nextBinding.kind === 'records'
            ? nextBinding.pair
            : undefined;
        if (
          closed ||
          activeCurrent ||
          pending ||
          installed ||
          capturedParent ||
          nextHead !== tip() ||
          (nextBinding.kind !== 'records' && nextBinding.kind !== 'head' && !compactBindings) ||
          (nextBinding.kind === 'records' && input.kind !== 'records')
        )
          throw Error('Vault retained backing frontier unavailable');
        const reusePair = reusablePositivePair(pair, nextBinding.kind);
        const advancing = pendingOwn > 0 || (!!pair && !reusePair);
        activeCurrent = () => {
          check();
          if (reusePair) {
            scratchCurrent();
            if (!reusablePositivePair(pair, nextBinding.kind))
              throw Error('Vault retained positive source selection changed');
          }
        };
        assertCurrent();
        if (advancing) await advance(pair, nextBinding.kind === 'records');
        else {
          if (!reusePair) {
            acceptedPair = undefined;
            acceptedPairSignature = undefined;
            pairRequest = undefined;
            positivePairSelection = undefined;
          }
        }
        if (nextHead !== input.selectedHead)
          throw Error('Vault retained backing frontier unavailable');
        assertBinding(nextBinding);
        scratchCurrent();
        if (reusePair && (await run('verify', entries)).entries !== entries)
          throw Error('Vault retained positive source member count changed');
        assertCurrent();
        if (!advancing) recordVersionWork('vaultBackingReuses');
      },
      /** After this process's own ordinary HEAD publication: validate the
       * complete vault namespace against the signed roster before writing.
       * Every original member keeps its identity except the manifest and its
       * two parents, and every new member is a record object file that the
       * next advance must prove it read. Anything else retires the frontier. */
      /** Record an exact chain of this process's own accepted HEADs (each
       * replacing its predecessor's bytes, the first replacing the tip) and the
       * record objects they added. One sweep explains the whole chain; the
       * advance still requires every recorded object to be read and hashed. */
      recordOwnPublications(
        publications: readonly { head: string; previous: string | null }[],
      ): boolean {
        if (
          closed ||
          activeCurrent ||
          pending ||
          installed ||
          capturedParent ||
          capturedHeadParent ||
          !replay?.current() ||
          !publications.length ||
          chain.length + publications.length > MAX_OWN_HEADS ||
          publications[0]!.previous !== tip() ||
          publications.some(
            (published, index) => index > 0 && published.previous !== publications[index - 1]!.head,
          )
        )
          return false;
        scratchCurrent();
        const replaced: { path: string; kind: string; identity: string }[] = [],
          added: { path: string; identity: string }[] = [];
        let members = 0;
        for (const item of unlockPhysicalEntries(root)) {
          members++;
          const row = Reflect.apply(nativeStatementGet, lookup, [item.path]);
          if (row) {
            if (
              row.kind !== item.kind ||
              row.signature !== sign(item.path, String(row.kind), String(row.identity))
            )
              return false;
            if (row.identity === item.identity) continue;
            if (
              !(item.path === 'manifest.enc'
                ? item.kind === 'file'
                : ['', 'versions'].includes(item.path) && item.kind === 'directory')
            )
              return false;
            replaced.push(item);
          } else {
            if (item.kind !== 'file' || !recordObject.test(item.path)) return false;
            added.push(item);
          }
        }
        recordVersionWork('vaultBackingPhysicalMembersVerified', members);
        if (
          members !== entries + added.length ||
          added.length < publications.length ||
          !replaced.some((item) => item.path === 'manifest.enc') ||
          ownObjects.length + added.length > MAX_OWN_OBJECTS
        )
          return false;
        for (const item of replaced) {
          if (
            Reflect.apply(nativeStatementRun, update, [
              item.identity,
              sign(item.path, item.kind, item.identity),
              item.path,
            ]).changes !== 1
          )
            throw Error('Vault own publication roster changed');
          expectedChanges++;
        }
        for (const item of added) {
          if (
            Reflect.apply(nativeStatementRun, insert, [
              item.path,
              'file',
              item.identity,
              sign(item.path, 'file', item.identity),
            ]).changes !== 1
          )
            throw Error('Vault own publication roster changed');
          expectedChanges++;
        }
        entries += added.length;
        scratchCurrent();
        for (const published of publications) chain.push(published.head);
        for (const item of added) ownObjects.push('objects/' + recordObject.exec(item.path)![1]);
        pendingOwn += publications.length;
        recordVersionWork('vaultBackingOwnHeadsRecorded', publications.length);
        return true;
      },
      recordOwnPublication(published: { head: string; previous: string | null }): boolean {
        return this.recordOwnPublications([published]);
      },
      assertHeadBinding(next: Extract<VaultRecordBackingBinding, { kind: 'head' }>) {
        assertCurrent();
        assertBinding(next);
        scratchCurrent();
        assertCurrent();
      },
      release() {
        if (pending || capturedParent || installed)
          throw Error('Vault retained backing transition unfinished');
        scratchCurrent();
        input.originalSources = undefined;
        input.originalArtifacts = undefined;
        activeCurrent = undefined;
      },
      assertRecordPrior(
        entity: string,
        recordId: string,
        previousVersion: string | null,
        prior: { deleted: boolean; preimage: { hash: string; bytes: number } } | null,
      ) {
        // Match the existing certificate codec: preimage is the exact
        // JSON.stringify string digest of retained contents_json, not a
        // structural reserialization or an unquoted JSON document digest.
        assertCurrent();
        scratchCurrent();
        if (input.kind !== 'records' && input.kind !== 'head')
          throw Error('Vault record predecessor keyspace unavailable');
        const accepted = certificates.getPrivate(certificateRoot, entity, recordId);
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
          throw Error('Vault accepted record predecessor differs');
        assertCurrent();
        scratchCurrent();
      },
      async prepareAdvance(
        head: string,
        versions: readonly {
          entity: string;
          recordId: string;
          versionId: string;
          deleted: boolean;
          previousVersion: string | null;
          contents: Record<string, unknown>;
        }[],
      ) {
        if (pending || !versions.length) throw Error('Vault retained backing transition repeated');
        let root = certificateRoot;
        const ids: string[] = [];
        for (const version of versions) {
          assertCurrent();
          scratchCurrent();
          if (version.entity !== 'source_files' && version.entity !== 'app_meta')
            throw Error('Vault retained backing transition entity');
          const old = certificates.getPrivate(certificateRoot, version.entity, version.recordId);
          if (
            (old?.versionId ?? null) !== version.previousVersion ||
            ids.includes(version.versionId)
          )
            throw Error('Vault retained backing predecessor differs');
          const fields: VaultRecordCertificate['fields'][number][] = [];
          for (const [name, value] of Object.entries(version.deleted ? {} : version.contents)) {
            const digest =
              typeof value === 'string'
                ? await recordStringFieldDigest(value, assertCurrent)
                : recordFieldDigest(JSON.stringify(value));
            fields.push({ name, ...digest });
          }
          const preimage = await recordStringFieldDigest(
            JSON.stringify(version.contents),
            assertCurrent,
          );
          root = certificates.put(root, {
            entity: version.entity,
            recordId: version.recordId,
            versionId: version.versionId,
            deleted: Number(version.deleted),
            preimage,
            fields,
          }).root;
          ids.push(version.versionId);
          recordVersionWork('vaultBackingChangedVersions');
        }
        pending = { root, head, versions: ids, kind: 'compact' };
      },
      async prepareTransactionAdvance(
        head: string,
        versions: Iterable<{
          entity: string;
          recordId: string;
          versionId: string;
          deleted: boolean;
          previousVersion: string | null;
          contentsJson: string;
          sourceFields: readonly { name: string; hash: string; bytes: number }[];
        }>,
      ) {
        if (input.kind !== 'records' || pending || installed)
          throw Error('Vault prepared record transition unavailable');
        let root = certificateRoot;
        const keys = new Set<string>(),
          ids = new Set<string>();
        for (const version of versions) {
          assertCurrent();
          scratchCurrent();
          const key = JSON.stringify([version.entity, version.recordId]),
            old = certificates.getPrivate(certificateRoot, version.entity, version.recordId);
          if (
            (old?.versionId ?? null) !== version.previousVersion ||
            keys.has(key) ||
            ids.has(version.versionId)
          )
            throw Error('Vault prepared record predecessor differs');
          // The core plan supplies the exact serialized indexing bytes. The
          // certificate codec hashes that string quoted, without parsing it.
          const preimage = await recordStringFieldDigest(version.contentsJson, assertCurrent);
          root = certificates.put(root, {
            entity: version.entity,
            recordId: version.recordId,
            versionId: version.versionId,
            deleted: Number(version.deleted),
            preimage,
            fields: version.deleted ? [] : [...version.sourceFields],
          }).root;
          keys.add(key);
          ids.add(version.versionId);
          recordVersionWork('vaultBackingChangedVersions');
        }
        assertCurrent();
        scratchCurrent();
        if (!ids.size) throw Error('Vault prepared record transition empty');
        pending = { root, head, kind: 'records' };
      },
      promote(head: string, versionIds: readonly string[]) {
        scratchCurrent();
        if (
          !pending ||
          pending.kind !== 'compact' ||
          pending.head !== head ||
          JSON.stringify(pending.versions) !== JSON.stringify(versionIds)
        )
          throw Error('Vault retained backing installed transition differs');
        certificateRoot = pending.root;
        input.selectedHead = head;
        pending = undefined;
        retainStagedHead(head);
      },
      retainTransactionSuccessor(head: string) {
        scratchCurrent();
        if (!pending || pending.kind !== 'records' || pending.head !== head || installed)
          throw Error('Vault prepared record successor unavailable');
        const parents = ['', 'versions', 'manifest.enc'].map((path) => {
          const actual = unlockPhysicalIdentity(resolve(root, path)),
            original = Reflect.apply(nativeStatementGet, lookup, [path]);
          if (
            !original ||
            original.kind !== actual.kind ||
            original.identity !== actual.value ||
            original.signature !== sign(path, actual.kind, actual.value)
          )
            throw Error('Vault owned successor recipe differs');
          return Object.freeze({ path, kind: actual.kind, identity: actual.value });
        });
        // Captured inside the lexical installer, before observers or awaits.
        const seal = captureRecordHeadPhysical([physical], [scratch]);
        installed = { head, physical: seal, parents: Object.freeze(parents) };
        scratchCurrent();
      },
      promoteTransaction(head: string) {
        scratchCurrent();
        if (
          !installed ||
          !pending ||
          pending.kind !== 'records' ||
          pending.head !== head ||
          installed.head !== head ||
          !installed.physical.current()
        )
          throw Error('Vault original installed successor changed');
        for (const original of installed.parents) {
          const actual = unlockPhysicalIdentity(resolve(root, original.path));
          if (actual.kind !== original.kind || actual.value !== original.identity)
            throw Error('Vault original installed parent changed');
        }
        certificateRoot = pending.root;
        input.selectedHead = head;
        retainStagedHead(head);
        // Full ordinary roots retain complete preimages and source headers,
        // not the compact selected-source complete-field certificate contract.
        compactBindings = false;
        pending = undefined;
        installed.physical.close();
        installed = undefined;
        scratchCurrent();
      },
      beforeHead() {
        // The factory's exact indexed publication has replaced the original
        // source row. Its closing gate owns this phase, not the prep callback.
        scratchCurrent();
        const parent = Reflect.apply(nativeStatementGet, lookup, ['']),
          manifest = Reflect.apply(nativeStatementGet, lookup, ['manifest.enc']);
        const actualParent = unlockPhysicalIdentity(root),
          actualManifest = unlockPhysicalIdentity(resolve(root, 'manifest.enc'));
        if (
          capturedHeadParent ||
          !pending ||
          !parent ||
          !manifest ||
          parent.kind !== actualParent.kind ||
          parent.identity !== actualParent.value ||
          parent.signature !== sign('', actualParent.kind, actualParent.value) ||
          manifest.kind !== actualManifest.kind ||
          manifest.identity !== actualManifest.value ||
          manifest.signature !== sign('manifest.enc', actualManifest.kind, actualManifest.value)
        )
          throw Error('Vault original HEAD namespace changed');
        capturedHeadParent = actualParent.value;
        scratchCurrent();
      },
      afterHead() {
        scratchCurrent();
        const parent = unlockPhysicalIdentity(root),
          manifest = unlockPhysicalIdentity(resolve(root, 'manifest.enc'));
        if (
          !capturedHeadParent ||
          parent.kind !== 'directory' ||
          manifest.kind !== 'file' ||
          parent.value.split(':').slice(0, 2).join(':') !==
            capturedHeadParent.split(':').slice(0, 2).join(':')
        )
          throw Error('Vault owned HEAD parent changed');
        for (const [path, item] of [
          ['', parent],
          ['manifest.enc', manifest],
        ] as const) {
          if (
            Reflect.apply(nativeStatementRun, update, [
              item.value,
              sign(path, item.kind, item.value),
              path,
            ]).changes !== 1
          )
            throw Error('Vault owned HEAD recipe changed');
          expectedChanges++;
        }
        capturedHeadParent = undefined;
        scratchCurrent();
      },
      async assertMetadataPrior(
        key: string,
        value: string | undefined,
        previous: { versionId: string; contents: string; deleted: number } | undefined,
      ) {
        scratchCurrent();
        const recordId = JSON.stringify([key]),
          row = certificates.getPrivate(certificateRoot, 'app_meta', recordId),
          digest = value === undefined ? undefined : recordFieldDigest(JSON.stringify(value)),
          preimage =
            previous &&
            (await recordStringFieldDigest(previous.contents, () => {
              assertCurrent();
              scratchCurrent();
            }));
        scratchCurrent();
        if (
          row
            ? row.versionId !== previous?.versionId ||
              row.fields.find((field) => field.name === 'value')?.hash !== digest?.hash ||
              row.fields.find((field) => field.name === 'value')?.bytes !== digest?.bytes ||
              row.preimage.hash !== preimage?.hash ||
              row.preimage.bytes !== preimage?.bytes ||
              row.deleted !== previous?.deleted
            : previous !== undefined || value !== undefined
        )
          throw Error('Vault accepted metadata predecessor differs');
        scratchCurrent();
      },
      beforeNewRecord(path: string) {
        assertCurrent();
        scratchCurrent();
        const name = relative(root, path),
          parent = relative(root, dirname(path)),
          row = lookup.get(parent),
          identity = unlockPhysicalIdentity(dirname(path));
        if (
          parent !== 'versions' ||
          name.startsWith('../') ||
          lookup.get(name) ||
          !row ||
          row.kind !== 'directory' ||
          row.identity !== identity.value ||
          row.signature !== sign(parent, 'directory', identity.value)
        )
          throw Error('Vault original record namespace changed');
        capturedParent = { path: parent, identity: identity.value };
        scratchCurrent();
      },
      afterNewRecord(path: string) {
        scratchCurrent();
        const parent = relative(root, dirname(path)),
          name = relative(root, path),
          identity = unlockPhysicalIdentity(path),
          parentIdentity = unlockPhysicalIdentity(dirname(path));
        if (
          !capturedParent ||
          capturedParent.path !== parent ||
          identity.kind !== 'file' ||
          parentIdentity.kind !== 'directory' ||
          parentIdentity.value.split(':').slice(0, 2).join(':') !==
            capturedParent.identity.split(':').slice(0, 2).join(':')
        )
          throw Error('Vault owned record parent changed');
        if (
          insert.run(name, 'file', identity.value, sign(name, 'file', identity.value)).changes !==
            1 ||
          update.run(parentIdentity.value, sign(parent, 'directory', parentIdentity.value), parent)
            .changes !== 1
        )
          throw Error('Vault owned record backing recipe changed');
        expectedChanges += 2n;
        scratchCurrent();
        entries++;
        capturedParent = undefined;
      },
      async verify() {
        scratchCurrent();
        if (capturedParent) throw Error('Vault owned record transition unfinished');
        if ((await run('verify', entries)).entries !== entries)
          throw Error('Vault backing member count changed');
        scratchCurrent();
        assertCurrent();
        scratchCurrent();
      },
      async verifyTerminal(current: () => void, sources: Iterable<PackageSourceOriginalPhysical>) {
        // Only the actual adapter's lexical owner supplies this last checker.
        // No new physical baseline or certificate is captured here.
        assertCurrent();
        activeCurrent = current;
        await retainOriginalSources(sources);
        if (capturedParent) throw Error('Vault owned record transition unfinished');
        if ((await run('verify', entries)).entries !== entries)
          throw Error('Vault backing member count changed');
        scratchCurrent();
        assertCurrent();
        scratchCurrent();
      },
      async verifyTransaction(
        current: () => void,
        artifacts: Iterable<VerifiedClinicalArtifact>,
        sources: Iterable<PackageSourceOriginalPhysical>,
        complete: () => unknown,
      ): Promise<unknown> {
        assertCurrent();
        activeCurrent = current;
        await retainOriginalSources(sources);
        scratchCurrent();
        const clear = sql!.prepare('DELETE FROM original_artifacts'),
          insert = sql!.prepare('INSERT INTO original_artifacts VALUES(?,?,?,?,?)');
        expectedChanges += BigInt(clear.run().changes);
        let count = 0;
        for (const original of artifacts) {
          assertCurrent();
          scratchCurrent();
          if (
            typeof original.id !== 'string' ||
            !original.id ||
            typeof original.path !== 'string' ||
            !original.path ||
            typeof original.identity !== 'string' ||
            !original.identity
          )
            throw Error('Vault original artifact descriptor invalid');
          const serialized = JSON.stringify([original.id, original.path, original.identity]);
          if (
            insert.run(
              count,
              original.id,
              original.path,
              original.identity,
              sign('parent-artifact:' + count, 'artifact', serialized),
            ).changes !== 1
          )
            throw Error('Vault original artifact membership changed');
          expectedChanges++;
          count++;
          if (count % 64 === 0) {
            await yieldHost();
            assertCurrent();
          }
        }
        input.originalArtifacts = count;
        scratchCurrent();
        if (capturedParent) throw Error('Vault owned record transition unfinished');
        const sealed = captureRecordHeadPhysical([physical], [scratch]);
        try {
          const reply = await run('verify', entries, () => {
            scratchCurrent();
            if (!sealed.current()) throw Error('Vault original artifact scratch changed');
            return complete();
          });
          return reply.finalResult;
        } finally {
          sealed.close();
        }
      },
      close() {
        if (closed) return;
        closed = true;
        installed?.physical.close();
        replay?.close();
        replay = undefined;
        sql!.close();
        input.key.fill(0);
        signatureKey.fill(0);
        rmSync(scratch, { recursive: true, force: true });
      },
    };
  } catch (error) {
    closed = true;
    sql?.close();
    input.key.fill(0);
    signatureKey.fill(0);
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}
