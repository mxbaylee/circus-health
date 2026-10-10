import { parentPort, workerData } from 'node:worker_threads';
import { createHash, createHmac } from 'node:crypto';
import { setImmediate as yieldHost } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { fstatSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { regularFileIdentity } from './regular-file-identity.ts';
import type { PackageSourceOriginalPhysical } from './intake-package-source-lease.ts';
import { recordFieldDigest, recordStringFieldDigest } from './record-prior-fields.ts';
import { openContributorRecordStorage } from './contributor-record-storage.ts';
import { openDatabase } from './database.ts';
import { attachRecordDurability } from './record-versions.ts';
import { profileOriginal } from './profile-storage.ts';
import { hashFile } from './vault-store.ts';
import { unlockPhysicalEntries, unlockPhysicalIdentity } from './encrypted-unlock-physical.ts';
import { vaultRecordCertificates, VAULT_CERTIFICATE_SCHEMA } from './vault-record-certificates.ts';
import {
  withRecordReplayCheckpoints,
  createRecordVersionWorkCounters,
  withRecordVersionWork,
} from './record-version-work.ts';
import type { ContributorRecordBackingInput } from './contributor-record-staging.ts';
import type { IntakeTreeRoot } from './intake-state-tree.ts';

const input = workerData as ContributorRecordBackingInput;
const sign = (path: string, kind: string, identity: string) =>
  createHmac('sha256', input.signatureKey)
    .update(JSON.stringify([input.nonce, path, kind, identity]))
    .digest('hex');
let work = 0;
let baselineReady = input.mode === 'verify';
const pause = () => {
  const control = new Int32Array(input.checkpointControl);
  Atomics.store(control, 0, 1);
  parentPort!.postMessage({ checkpoint: true, baselineReady });
  while (Atomics.load(control, 0)) Atomics.wait(control, 0, 1);
};
const checkpoint = () => {
  if (++work % 64 === 0) pause();
};
const digest = (path: string) => hashFile(path);
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
    scratch.exec('BEGIN');
    const originalRead = storage.read;
    storage.read = (name) => {
      checkpoint();
      return originalRead(name);
    };
    if (storage.read('head')?.toString('utf8') !== input.selectedHead)
      throw Error('Contributor original accepted HEAD changed');
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
                hashFile(physical) !== row.sha256
              )
                throw Error('Contributor accepted original changed');
            }
          },
        }),
      ),
    );
    const certificates = vaultRecordCertificates(scratch, input.profileId, input.nonce, checkpoint);
    for (const row of db
      .prepare(
        'SELECT c.entity,c.record_id,c.version_id,v.contents_json,v.deleted FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id',
      )
      .iterate()) {
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
      certificateRoot = certificates.put(certificateRoot, {
        entity: String(row.entity),
        recordId: String(row.record_id),
        versionId: String(row.version_id),
        deleted: Number(row.deleted),
        preimage: await rawDigest(String(row.contents_json)),
        fields,
      }).root;
    }
    if (storage.read('head')?.toString('utf8') !== input.selectedHead)
      throw Error('Contributor accepted HEAD changed during backing replay');
    scratch.exec('COMMIT');
    if (verifyPhysical(true) !== entries || verifyPhysical(false) !== entries)
      throw Error('Contributor original namespace changed during replay');
    return { entries, certificateRoot, decodedVersions: counters.reconstruction.decodedVersions };
  } finally {
    db.close();
    storage.close();
    scratch.close();
  }
}

function verify() {
  const first = verifyPhysical(true),
    final = verifyPhysical(false);
  if (first !== final) throw Error('Contributor final physical membership changed');
  return { entries: final };
}

try {
  parentPort!.postMessage(input.mode === 'prepare' ? await prepare() : verify());
} catch {
  parentPort!.postMessage({ refused: true });
} finally {
  input.signatureKey.fill(0);
  parentPort!.close();
}
