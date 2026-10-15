import { parentPort, workerData } from 'node:worker_threads';
import { createHash, createHmac, createSecretKey, type KeyObject } from 'node:crypto';
import { setImmediate as yieldHost } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { fstatSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { regularFileIdentity } from './regular-file-identity.ts';
import type { PackageSourceOriginalPhysical } from './intake-package-source-lease.ts';
import {
  unlockPhysicalDigest,
  unlockPhysicalEntries,
  unlockPhysicalIdentity,
} from './encrypted-unlock-physical.ts';
import {
  withRecordReplayCheckpoints,
  createRecordVersionWorkCounters,
  withRecordVersionWork,
} from './record-version-work.ts';
import type { ContributorRecordBackingInput } from './contributor-record-staging.ts';
import {
  MAX_CERTIFICATE_DELTA_CHUNK_BYTES,
  MAX_CERTIFICATE_DELTA_CHUNK_COUNT,
  certificateDeltaHead,
  certificateDeltaMinimumBytes,
  checkedCertificateDeltaChunk,
  signCertificateDeltaChunk,
  signCertificateDeltaTerminal,
  type ContributorCertificateDelta,
} from './contributor-certificate-delta.ts';
import type { IntakeTreeRoot } from './intake-state-tree.ts';
import type { VaultRecordCertificate } from './vault-record-certificates.ts';
import {
  signRecordReplaySourcePair,
  signRecordReplaySourcePairSelection,
  withRecordReplaySourcePair,
  withOptionalRecordReplaySourcePair,
  type RecordReplaySourcePair,
} from './record-replay-source-pair.ts';
import { intakeNamespace } from './intake-state-evidence.ts';
import { intakeSourcePinKey } from './intake-source-pin-key.ts';

if (workerData !== null) throw Error('Contributor backing worker protocol');
let input: ContributorRecordBackingInput = undefined!;
let jobId = 0;
let completedJobId = 0;
let signingKey: KeyObject | undefined;
const job = () => {
  if (!input || jobId !== completedJobId + 1) throw Error('Contributor backing worker protocol');
  return input;
};
const sign = (path: string, kind: string, identity: string) => {
  const selected = job();
  if (!signingKey) throw Error('Contributor backing worker signing key unavailable');
  return createHmac('sha256', signingKey)
    .update(JSON.stringify([selected.nonce, path, kind, identity]))
    .digest('hex');
};
let work = 0;
let baselineReady = false;
const pause = (phase?: 'final-verify') => {
  const control = new Int32Array(job().checkpointControl);
  Atomics.store(control, 0, 1);
  parentPort!.postMessage({ id: jobId, checkpoint: true, baselineReady, phase });
  while (Atomics.load(control, 0)) Atomics.wait(control, 0, 1);
};
const checkpoint = () => {
  if (++work % 64 === 0) pause();
};
const sendCertificateChunk = (ordinal: number, certificates: ContributorCertificateDelta[]) => {
  const chunk = {
    ordinal,
    certificates,
    signature: signCertificateDeltaChunk(
      input.signatureKey,
      input.nonce,
      certificateDeltaHead(input.selectedHead, input.ownHeads),
      ordinal,
      certificates,
    ),
  };
  const { encoded } = checkedCertificateDeltaChunk(
    input.signatureKey,
    input.nonce,
    certificateDeltaHead(input.selectedHead, input.ownHeads),
    chunk,
  );
  if (encoded.length > MAX_CERTIFICATE_DELTA_CHUNK_BYTES)
    throw Error('Contributor certificate delta chunk too large');
  const control = new Int32Array(input.checkpointControl);
  Atomics.store(control, 0, 1);
  parentPort!.postMessage({ id: jobId, certificateChunk: chunk });
  while (Atomics.load(control, 0)) Atomics.wait(control, 0, 1);
  return encoded;
};
const digest = unlockPhysicalDigest;
async function rawDigest(value: string): Promise<{ hash: string; bytes: number }> {
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
    checkpoint();
    await yieldHost();
  }
  return { hash: hash.digest('hex'), bytes };
}

function verifyPhysical(progress: boolean): number {
  const expected = input.entries;
  if (!Number.isSafeInteger(expected) || expected === undefined || expected < 0)
    throw Error('Contributor original member count missing');
  const sql = new DatabaseSync(input.physical, { readOnly: true });
  try {
    const original = sql.prepare('SELECT kind,identity,signature FROM physical WHERE path=?'),
      addition = sql.prepare(
        'SELECT identity,sha256,bytes,signature FROM own_additions WHERE name=?',
      ),
      ownCount = Number(sql.prepare('SELECT count(*) AS n FROM own_additions').get()!.n),
      marker = unlockPhysicalIdentity(input.marker),
      recordedMarker = original.get('@marker');
    if (
      marker.kind !== 'file' ||
      !recordedMarker ||
      recordedMarker.kind !== 'file' ||
      recordedMarker.identity !== marker.value ||
      recordedMarker.signature !== sign('@marker', 'file', marker.value)
    )
      throw Error('Contributor selection marker changed');
    let count = 0,
      added = 0;
    for (const item of unlockPhysicalEntries(input.base)) {
      if (progress) checkpoint();
      const row = original.get(item.path);
      if (row) {
        const ownObjectsParent = item.path === 'objects' && ownCount > 0,
          sameParent =
            ownObjectsParent &&
            input.objectsIdentity === item.identity &&
            input.objectsSignature === sign('objects', item.kind, item.identity) &&
            String(row.identity).split(':').slice(0, 2).join(':') ===
              item.identity.split(':').slice(0, 2).join(':');
        if (
          row.kind !== item.kind ||
          row.signature !== sign(item.path, String(row.kind), String(row.identity)) ||
          (row.identity !== item.identity && !sameParent)
        )
          throw Error('Contributor original physical member changed');
      } else {
        const own = addition.get(item.path);
        if (
          !own ||
          item.kind !== 'file' ||
          item.identity !== own.identity ||
          own.signature !==
            createHmac('sha256', input.signatureKey)
              .update(
                JSON.stringify([
                  input.nonce,
                  'own-addition',
                  item.path,
                  own.identity,
                  own.sha256,
                  own.bytes,
                ]),
              )
              .digest('hex') ||
          digest(resolve(input.base, item.path)) !== own.sha256 ||
          Number(item.identity.split(':')[2]) !== own.bytes
        )
          throw Error('Contributor foreign physical member appeared');
        added++;
      }
      count++;
    }
    if (
      added !== ownCount ||
      count !== expected + ownCount ||
      sql.prepare('SELECT count(*) AS n FROM physical').get()!.n !== expected + 1
    )
      throw Error('Contributor original namespace membership changed');
    let sources = 0;
    for (const row of sql
      .prepare('SELECT sequence,source,signature FROM consumed_sources ORDER BY sequence')
      .iterate()) {
      if (progress) checkpoint();
      const serialized = String(row.source);
      if (
        row.sequence !== sources ||
        row.signature !== sign('consumed-source:' + sources, 'source', serialized)
      )
        throw Error('Contributor original source proof changed');
      const source = JSON.parse(serialized) as PackageSourceOriginalPhysical,
        fd = fstatSync(source.sourceFd, { bigint: true }),
        path = lstatSync(source.path, { bigint: true }),
        parent = lstatSync(dirname(source.path), { bigint: true }),
        identity = (stat: typeof fd) =>
          [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      if (
        !fd.isFile() ||
        !path.isFile() ||
        (source.parentKind === 'directory'
          ? !parent.isDirectory()
          : source.parentKind !== 'symlink' || !parent.isSymbolicLink()) ||
        source.binding.profileId !== input.profileId ||
        fd.size !== BigInt(source.binding.bytes) ||
        identity(fd) !== source.statIdentity ||
        identity(path) !== source.statIdentity ||
        `${parent.dev}:${parent.ino}:${parent.mode}` !== source.parentIdentity ||
        realpathSync(dirname(source.path)) !== source.parentRealpath
      )
        throw Error('Contributor original leased source changed');
      sources++;
    }
    if (sources !== (input.originalSources ?? 0))
      throw Error('Contributor original source membership changed');
    let artifacts = 0;
    for (const row of sql
      .prepare(
        'SELECT sequence,id,path,identity,signature FROM original_artifacts ORDER BY sequence',
      )
      .iterate()) {
      if (progress) checkpoint();
      if (
        row.sequence !== artifacts ||
        typeof row.id !== 'string' ||
        !row.id ||
        typeof row.path !== 'string' ||
        !row.path ||
        typeof row.identity !== 'string' ||
        !row.identity ||
        row.signature !==
          sign(
            'parent-artifact:' + artifacts,
            'artifact',
            JSON.stringify([row.id, row.path, row.identity]),
          ) ||
        regularFileIdentity(row.path) !== row.identity
      )
        throw Error('Contributor original parent artifact changed');
      artifacts++;
    }
    if (artifacts !== (input.originalArtifacts ?? 0))
      throw Error('Contributor original parent artifact membership changed');
    return count;
  } finally {
    sql.close();
  }
}

async function prepare() {
  // Repeated physical verification does not need the recovery/application graph.
  const { openContributorRecordStorage } = await import('./contributor-record-storage.ts'),
    { openDatabase } = await import('./database.ts'),
    { attachRecordDurability } = await import('./record-versions.ts'),
    { profileOriginal } = await import('./profile-storage.ts'),
    { recordFieldDigest, recordStringFieldDigest } = await import('./record-prior-fields.ts'),
    { vaultRecordCertificates, VAULT_CERTIFICATE_SCHEMA, orderedVaultCertificateRows } =
      await import('./vault-record-certificates.ts');
  const sql = new DatabaseSync(input.physical);
  let entries = 0;
  try {
    sql.exec(
      'CREATE TABLE physical(path TEXT PRIMARY KEY,kind TEXT NOT NULL,identity TEXT NOT NULL,signature TEXT NOT NULL); ' +
        'CREATE TABLE own_additions(name TEXT PRIMARY KEY,identity TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,signature TEXT NOT NULL,sequence INTEGER UNIQUE NOT NULL); ' +
        'CREATE TABLE consumed_sources(sequence INTEGER PRIMARY KEY,source TEXT UNIQUE NOT NULL,signature TEXT NOT NULL); CREATE TABLE original_artifacts(sequence INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,path TEXT NOT NULL,identity TEXT NOT NULL,signature TEXT NOT NULL); ' +
        VAULT_CERTIFICATE_SCHEMA +
        ' BEGIN',
    );
    const insert = sql.prepare('INSERT INTO physical VALUES(?,?,?,?)'),
      marker = unlockPhysicalIdentity(input.marker);
    if (marker.kind !== 'file') throw Error('Contributor marker is not a file');
    insert.run('@marker', marker.kind, marker.value, sign('@marker', marker.kind, marker.value));
    for (const item of unlockPhysicalEntries(input.base)) {
      checkpoint();
      insert.run(item.path, item.kind, item.identity, sign(item.path, item.kind, item.identity));
      entries++;
    }
    sql.exec('COMMIT');
    input.entries = entries;
    baselineReady = true;
    pause();
  } finally {
    sql.close();
  }
  const scratch = new DatabaseSync(input.physical),
    storage = openContributorRecordStorage(input.root, input.profileId, { readOnly: true }),
    db = openDatabase(input.database, input.profileId),
    counters = createRecordVersionWorkCounters();
  let certificateRoot: IntakeTreeRoot = null;
  try {
    db.exec('PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-2048');
    scratch.exec('BEGIN');
    const originalRead = storage.read;
    storage.read = (name) => {
      checkpoint();
      return originalRead(name);
    };
    if (storage.read('head')?.toString('utf8') !== input.selectedHead)
      throw Error('Contributor original accepted HEAD changed');
    const rebuild = () =>
      withRecordVersionWork(counters, () =>
        withRecordReplayCheckpoints(checkpoint, () =>
          attachRecordDurability(db, {
            profileId: input.profileId,
            storage,
            verifyReferences(versions) {
              for (const version of versions) {
                checkpoint();
                if (version.deleted) continue;
                const row = version.contents,
                  path =
                    version.entity === 'source_files'
                      ? row.path
                      : version.entity === 'assets'
                        ? row.stored_path
                        : null;
                if (!path) continue;
                const physical = profileOriginal(input.root, path, input.profileId);
                if (physical !== resolve(input.root, String(path)))
                  throw Error('Contributor accepted original escaped profile');
                const identity = unlockPhysicalIdentity(physical);
                if (
                  identity.kind !== 'file' ||
                  Number(row.bytes) !== Number(identity.value.split(':')[2]) ||
                  digest(physical) !== row.sha256
                )
                  throw Error('Contributor accepted original changed');
              }
            },
          }),
        ),
      );
    const sourcePair = input.pair
      ? input.mode === 'prepare' && input.readOnlyPairCandidate
        ? withOptionalRecordReplaySourcePair(input.pair, rebuild).pair
        : withRecordReplaySourcePair(input.pair, rebuild).pair
      : (rebuild(), undefined);
    const certificates = vaultRecordCertificates(scratch, input.profileId, input.nonce, checkpoint);
    const certificateBatch: VaultRecordCertificate[] = [];
    const flushCertificates = () => {
      if (!certificateBatch.length) return;
      certificateRoot = certificates.putMany(certificateRoot, certificateBatch).root;
      certificateBatch.length = 0;
    };
    for (const row of orderedVaultCertificateRows(db, checkpoint)) {
      checkpoint();
      const fields: { name: string; hash: string; bytes: number }[] = [];
      if (row.entity === 'source_files' && !row.deleted) {
        const key = JSON.parse(String(row.record_id)) as unknown[];
        if (!Array.isArray(key) || key.length !== 1) throw Error('Contributor source key differs');
        const source = db
          .prepare('SELECT id,kind,path,sha256,bytes FROM main.source_files WHERE id=?')
          .get(key[0] as string);
        if (!source) throw Error('Contributor source certificate row missing');
        for (const name of ['id', 'kind', 'path', 'sha256', 'bytes']) {
          const value = source[name],
            digest =
              typeof value === 'string'
                ? await recordStringFieldDigest(value, checkpoint)
                : recordFieldDigest(JSON.stringify(value));
          fields.push({ name, ...digest });
        }
      }
      certificateBatch.push({
        entity: String(row.entity),
        recordId: String(row.record_id),
        versionId: String(row.version_id),
        deleted: Number(row.deleted),
        preimage: await rawDigest(String(row.contents_json)),
        fields,
      });
      if (certificateBatch.length === 64) flushCertificates();
    }
    flushCertificates();
    if (storage.read('head')?.toString('utf8') !== input.selectedHead)
      throw Error('Contributor accepted HEAD changed during backing replay');
    scratch.exec('COMMIT');
    if (verifyPhysical(true) !== entries || verifyPhysical(false) !== entries)
      throw Error('Contributor original namespace changed during replay');
    return {
      entries,
      certificateRoot,
      decodedVersions: counters.reconstruction.decodedVersions,
      sourcePair,
      sourcePairSignature: sourcePair
        ? signRecordReplaySourcePair(input.signatureKey, input.nonce, sourcePair)
        : undefined,
      sourcePairSelectionSignature:
        input.pair && input.readOnlyPairCandidate
          ? signRecordReplaySourcePairSelection(
              input.signatureKey,
              input.nonce,
              input.pair,
              input.selectedHead,
              sourcePair ?? null,
            )
          : undefined,
    };
  } finally {
    try {
      db.close();
    } finally {
      try {
        storage.close();
      } finally {
        scratch.close();
      }
    }
  }
}

/** Extend the retained replay projection from its original-proof HEAD across
 * exactly the recorded own publications. The ancestry walk, every new
 * version's validation and every new original's digest still run; history
 * already proven by the original cold replay is not decoded again. */
async function advance() {
  const { openContributorRecordStorage } = await import('./contributor-record-storage.ts'),
    { openDatabase } = await import('./database.ts'),
    { attachRecordDurability } = await import('./record-versions.ts'),
    { profileOriginal } = await import('./profile-storage.ts'),
    { recordFieldDigest, recordStringFieldDigest } = await import('./record-prior-fields.ts'),
    { observeRecordReplayVersion, completeRecordReplayCommit } =
      await import('./record-replay-source-pair.ts'),
    { orderedChangedVaultCertificateRows } = await import('./vault-record-certificates.ts');
  const ownHeads = input.ownHeads ?? [],
    finalHead = ownHeads.length ? ownHeads[ownHeads.length - 1]! : input.selectedHead,
    additions = new Set(input.ownObjects ?? []);
  if (ownHeads.length > 256 || additions.size !== (input.ownObjects ?? []).length)
    throw Error('Contributor own publication roster invalid');
  const storage = openContributorRecordStorage(input.root, input.profileId, { readOnly: true }),
    db = openDatabase(input.database, input.profileId),
    counters = createRecordVersionWorkCounters(),
    read = new Set<string>();
  try {
    db.exec('PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-2048');
    const state = () =>
      db.prepare('SELECT sequence,head_json FROM __record_state WHERE singleton=1').get() as
        { sequence: number; head_json: string } | undefined;
    const before = state();
    if (!before || before.head_json + '\n' !== input.selectedHead)
      throw Error('Contributor retained replay HEAD differs from original proof');
    const originalRead = storage.read;
    storage.read = (name) => {
      checkpoint();
      read.add(name);
      return originalRead(name);
    };
    if (storage.read('head')?.toString('utf8') !== finalHead)
      throw Error('Contributor accepted HEAD is not the recorded own publication');
    withRecordVersionWork(counters, () =>
      withRecordReplayCheckpoints(checkpoint, () =>
        attachRecordDurability(db, {
          profileId: input.profileId,
          storage,
          verifyReferences(versions) {
            for (const version of versions) {
              checkpoint();
              if (version.deleted) continue;
              const row = version.contents,
                path =
                  version.entity === 'source_files'
                    ? row.path
                    : version.entity === 'assets'
                      ? row.stored_path
                      : null;
              if (!path) continue;
              const physical = profileOriginal(input.root, path, input.profileId);
              if (physical !== resolve(input.root, String(path)))
                throw Error('Contributor accepted original escaped profile');
              const identity = unlockPhysicalIdentity(physical);
              if (
                identity.kind !== 'file' ||
                Number(row.bytes) !== Number(identity.value.split(':')[2]) ||
                digest(physical) !== row.sha256
              )
                throw Error('Contributor accepted original changed');
            }
          },
        }),
      ),
    );
    // Exactly the recorded own chain: commit k names own HEAD k-1 as previous.
    const after = state();
    if (!after || after.head_json + '\n' !== finalHead)
      throw Error('Contributor advanced replay HEAD differs');
    const commits = db
      .prepare(
        'SELECT sequence,commit_json FROM __record_transactions WHERE sequence>? ORDER BY sequence',
      )
      .all(before.sequence);
    if (commits.length !== ownHeads.length || after.sequence !== before.sequence + ownHeads.length)
      throw Error('Contributor accepted history contains foreign publications');
    let previous = input.selectedHead;
    for (let index = 0; index < commits.length; index++) {
      checkpoint();
      const commit = JSON.parse(String(commits[index]!.commit_json)) as {
        sequence: number;
        previous: unknown;
      };
      if (
        commits[index]!.sequence !== before.sequence + index + 1 ||
        commit.sequence !== commits[index]!.sequence ||
        JSON.stringify(commit.previous) + '\n' !== previous
      )
        throw Error('Contributor accepted history is not the own publication chain');
      previous = ownHeads[index]!;
    }
    // Every object this process added must be one the verified own chain read.
    for (const name of additions)
      if (!read.has(name)) throw Error('Contributor unexplained physical addition');
    let certificates: ContributorCertificateDelta[] = [],
      certificateChunks = 0,
      certificateCount = 0;
    const certificateHash = createHash('sha256');
    const flushCertificates = () => {
      if (!certificates.length) return;
      const encoded = sendCertificateChunk(certificateChunks++, certificates);
      certificateHash.update(encoded);
      certificateCount += certificates.length;
      certificates = [];
    };
    if (ownHeads.length) {
      for (const row of orderedChangedVaultCertificateRows(
        db,
        input.profileId,
        before.sequence,
        (phase) => (phase === 'enrollment' ? pause() : checkpoint()),
      )) {
        const entity = String(row.entity),
          recordId = String(row.record_id);
        const fields: { name: string; hash: string; bytes: number }[] = [];
        if (entity === 'source_files' && !row.deleted) {
          const key = JSON.parse(recordId) as unknown[];
          if (!Array.isArray(key) || key.length !== 1)
            throw Error('Contributor source key differs');
          const source = db
            .prepare('SELECT id,kind,path,sha256,bytes FROM main.source_files WHERE id=?')
            .get(key[0] as string);
          if (!source) throw Error('Contributor source certificate row missing');
          for (const name of ['id', 'kind', 'path', 'sha256', 'bytes']) {
            const value = source[name];
            fields.push({
              name,
              ...(typeof value === 'string'
                ? await recordStringFieldDigest(value, checkpoint)
                : recordFieldDigest(JSON.stringify(value))),
            });
          }
        }
        const certificate: ContributorCertificateDelta = {
          entity,
          recordId,
          versionId: String(row.version_id),
          deleted: Number(row.deleted),
          preimage: await rawDigest(String(row.contents_json)),
          fields,
          previousAccepted: row.previous_version === null ? null : String(row.previous_version),
        };
        if (certificateDeltaMinimumBytes(certificate) > MAX_CERTIFICATE_DELTA_CHUNK_BYTES - 256)
          throw Error('Contributor certificate delta value too large');
        if (
          certificates.length &&
          Buffer.byteLength(JSON.stringify([...certificates, certificate])) >
            MAX_CERTIFICATE_DELTA_CHUNK_BYTES - 256
        )
          flushCertificates();
        certificates.push(certificate);
        if (certificates.length === MAX_CERTIFICATE_DELTA_CHUNK_COUNT) flushCertificates();
      }
    }
    flushCertificates();
    let sourcePair: RecordReplaySourcePair | undefined;
    if (input.pair) {
      // Fold the identical replay observer over the retained projection's
      // accepted versions, in commit order, for exactly the pair's records.
      const identity = input.pair.identity,
        fold = () => {
          const deletedVisibility = db
            .prepare(
              "SELECT 1 FROM __record_versions WHERE profile_id=? AND entity='visibility_events' AND deleted=1 LIMIT 1",
            )
            .get(input.profileId);
          if (deletedVisibility) throw Error('Accepted source visibility history deleted');
          let sequence: number | undefined;
          for (const row of db
            .prepare(
              "SELECT sequence,contents_json,metadata_json FROM __record_versions WHERE profile_id=? AND ((entity='source_files' AND record_id=?) OR (entity='app_meta' AND record_id IN (?,?)) OR (entity='visibility_events' AND json_extract(contents_json,'$.target_type')='source_file' AND json_extract(contents_json,'$.target_id')=?)) ORDER BY sequence,rowid",
            )
            .iterate(
              input.profileId,
              JSON.stringify([identity.intakeId]),
              JSON.stringify([intakeNamespace(identity) + 'head']),
              JSON.stringify([intakeSourcePinKey(identity.intakeId)]),
              identity.intakeId,
            )) {
            checkpoint();
            if (sequence !== undefined && row.sequence !== sequence)
              completeRecordReplayCommit({ sequence } as never);
            sequence = Number(row.sequence);
            const metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
            if (metadata.sequence !== sequence) throw Error('Accepted source pair history changed');
            observeRecordReplayVersion({
              ...metadata,
              contents: JSON.parse(String(row.contents_json)),
            } as never);
          }
          if (sequence !== undefined) completeRecordReplayCommit({ sequence } as never);
        };
      sourcePair = input.readOnlyPairCandidate
        ? withOptionalRecordReplaySourcePair(input.pair, fold).pair
        : withRecordReplaySourcePair(input.pair, fold).pair;
    }
    if (storage.read('head')?.toString('utf8') !== finalHead)
      throw Error('Contributor accepted HEAD changed during advance');
    const entries = input.entries;
    if (verifyPhysical(true) !== entries || verifyPhysical(false) !== entries)
      throw Error('Contributor original namespace changed during advance');
    const certificateDigest = certificateHash.digest('hex');
    return {
      entries,
      certificateCount,
      certificateChunks,
      certificateDigest,
      certificateSignature: signCertificateDeltaTerminal(
        input.signatureKey,
        input.nonce,
        finalHead,
        certificateChunks,
        certificateCount,
        certificateDigest,
      ),
      decodedVersions: counters.reconstruction.decodedVersions,
      sourcePair,
      sourcePairSignature: sourcePair
        ? signRecordReplaySourcePair(input.signatureKey, input.nonce, sourcePair)
        : undefined,
      sourcePairSelectionSignature:
        input.pair && input.readOnlyPairCandidate
          ? signRecordReplaySourcePairSelection(
              input.signatureKey,
              input.nonce,
              input.pair,
              finalHead,
              sourcePair ?? null,
            )
          : undefined,
    };
  } finally {
    try {
      db.close();
    } finally {
      storage.close();
    }
  }
}

function verify() {
  pause(input.retainedCapture ? undefined : 'final-verify');
  const first = verifyPhysical(true),
    final = verifyPhysical(false);
  if (first !== final) throw Error('Contributor final physical membership changed');
  return { entries: final };
}

parentPort!.on(
  'message',
  async (message: { id?: number; input?: ContributorRecordBackingInput }) => {
    if (
      input ||
      !Number.isSafeInteger(message?.id) ||
      message.id !== completedJobId + 1 ||
      !message.input ||
      !['prepare', 'verify', 'advance'].includes(message.input.mode) ||
      !(message.input.signatureKey instanceof Uint8Array) ||
      !(message.input.checkpointControl instanceof SharedArrayBuffer)
    ) {
      parentPort!.postMessage({ id: message?.id, refused: true });
      parentPort!.close();
      return;
    }
    jobId = message.id;
    input = message.input;
    work = 0;
    baselineReady = input.mode !== 'prepare';
    let result:
      | Awaited<ReturnType<typeof prepare>>
      | Awaited<ReturnType<typeof advance>>
      | ReturnType<typeof verify>
      | undefined;
    let refused = false;
    try {
      // Key conversion is shared by this dispatch, never a signature or proof.
      signingKey = createSecretKey(input.signatureKey);
      result =
        input.mode === 'prepare'
          ? await prepare()
          : input.mode === 'advance'
            ? await advance()
            : verify();
    } catch {
      refused = true;
    } finally {
      signingKey = undefined;
      input.signatureKey.fill(0);
      new Int32Array(input.checkpointControl).fill(0);
      input = undefined!;
      baselineReady = false;
      work = 0;
    }
    if (refused) {
      parentPort!.postMessage({ id: jobId, refused: true });
      parentPort!.close();
    } else {
      completedJobId = jobId;
      parentPort!.postMessage({ id: jobId, result });
    }
  },
);
parentPort!.postMessage({ ready: true });
