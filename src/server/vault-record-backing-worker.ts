import { parentPort, workerData } from 'node:worker_threads';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve, relative, dirname } from 'node:path';
import { opendirSync, fstatSync, lstatSync, realpathSync } from 'node:fs';
import { openVault } from './vault-store.ts';
import { openDatabase } from './database.ts';
import { attachRecordDurability } from './record-versions.ts';
import {
  withRecordReplayCheckpoints,
  createRecordVersionWorkCounters,
  withRecordVersionWork,
} from './record-version-work.ts';
import { recordFieldDigest, recordStringFieldDigest } from './record-prior-fields.ts';
import {
  unlockPhysicalEntries,
  unlockPhysicalDigest,
  unlockPhysicalIdentity,
} from './encrypted-unlock-physical.ts';
import type { VaultRecordBackingInput } from './vault-record-backing.ts';
import type { PackageSourceOriginalPhysical } from './intake-package-source-lease.ts';
import { VAULT_CERTIFICATE_SCHEMA, vaultRecordCertificates } from './vault-record-certificates.ts';
import type { IntakeTreeRoot } from './intake-state-tree.ts';
import { regularFileIdentity } from './regular-file-identity.ts';

const input = workerData as VaultRecordBackingInput;
const key = Buffer.from(input.key),
  signatureKey = Buffer.from(input.signatureKey),
  root = resolve(input.directory, 'vault');
const sign = (path: string, kind: string, identity: string) =>
  createHmac('sha256', signatureKey)
    .update(JSON.stringify([input.nonce, path, kind, identity]))
    .digest('hex');
let work = 0;
let closing = false;
let certificateRoot: IntakeTreeRoot = null;
const replayWork = createRecordVersionWorkCounters();
const checkpoint = (phase?: 'leased-source' | 'original-artifact') => {
  if (closing) return;
  if (++work % 64 === 0 || phase) {
    const control = new Int32Array(input.checkpointControl);
    Atomics.store(control, 0, 1);
    parentPort!.postMessage({ checkpoint: true, mode: input.mode, phase });
    while (Atomics.load(control, 0)) Atomics.wait(control, 0, 1);
  }
};
function* workspaceEntries() {
  if (!input.workspace) return;
  const root = resolve(input.workspace),
    ignored = new Set(['record-stream', 'db', 'personal', 'curation', 'intake-batches']),
    identity = unlockPhysicalIdentity(root);
  if (identity.kind !== 'directory') throw Error('Vault workspace root changed');
  yield { path: '', kind: identity.kind, identity: identity.value };
  const stack = [{ path: root, directory: opendirSync(root) }];
  try {
    while (stack.length) {
      const current = stack[stack.length - 1]!,
        entry = current.directory.readSync();
      if (!entry) {
        current.directory.closeSync();
        stack.pop();
        continue;
      }
      checkpoint();
      const path = resolve(current.path, entry.name),
        name = relative(root, path);
      if (
        (current.path === root && ignored.has(entry.name)) ||
        name.endsWith('.pending') ||
        name.endsWith('/writer.lock')
      )
        continue;
      const physical = unlockPhysicalIdentity(path);
      yield { path: name, kind: physical.kind, identity: physical.value };
      if (physical.kind === 'directory') stack.push({ path, directory: opendirSync(path) });
    }
  } finally {
    for (const current of stack) current.directory.closeSync();
  }
  // Queue publication owns an exact changed frontier. Never enumerate/adopt
  // unselected queue history or crash tails through the workspace sweep.
  const selected = new Set<string>();
  for (const name of input.workspaceNames ?? []) {
    if (!name.startsWith('intake-batches/')) continue;
    let path = resolve(root, name);
    if (
      !path.startsWith(root + '/') ||
      name.includes('\\') ||
      name.split('/').some((part) => part === '..' || part === '.')
    )
      throw Error('Vault selected workspace name escaped');
    while (path !== root) {
      selected.add(path);
      path = dirname(path);
    }
  }
  for (const path of selected) {
    checkpoint();
    const physical = unlockPhysicalIdentity(path);
    yield { path: relative(root, path), kind: physical.kind, identity: physical.value };
  }
}

function verifyPhysical(expected: number): void {
  const table = new DatabaseSync(input.physical, { readOnly: true });
  try {
    const lookup = table.prepare('SELECT kind,identity,signature FROM physical WHERE path=?');
    let count = 0;
    for (const item of unlockPhysicalEntries(root)) {
      checkpoint();
      const row = lookup.get(item.path);
      if (
        !row ||
        row.kind !== item.kind ||
        row.identity !== item.identity ||
        row.signature !== sign(item.path, item.kind, item.identity)
      )
        throw Error('Vault consumed namespace changed');
      count++;
    }
    if (
      count !== expected ||
      table.prepare('SELECT count(*) AS n FROM physical').get()!.n !== count
    )
      throw Error('Vault consumed namespace membership changed');
    if (input.workspace) {
      const workspace = table.prepare('SELECT kind,identity,signature FROM workspace WHERE path=?');
      let workspaceCount = 0;
      for (const item of workspaceEntries()) {
        const row = workspace.get(item.path);
        if (
          !row ||
          row.kind !== item.kind ||
          row.identity !== item.identity ||
          row.signature !== sign('workspace:' + item.path, item.kind, item.identity)
        )
          throw Error('Vault source workspace changed');
        workspaceCount++;
      }
      if (table.prepare('SELECT count(*) AS n FROM workspace').get()!.n !== workspaceCount)
        throw Error('Vault source workspace membership changed');
    }
    if (input.originalSources !== undefined) {
      if (!Number.isSafeInteger(input.originalSources) || input.originalSources < 0)
        throw Error('Vault original source count invalid');
      let count = 0;
      const sources = table.prepare(
        'SELECT sequence,source,signature FROM consumed_sources ORDER BY sequence',
      );
      checkpoint('leased-source');
      for (const row of sources.iterate()) {
        checkpoint();
        const serialized = String(row.source);
        if (
          row.sequence !== count ||
          row.signature !== sign('consumed-source:' + count, 'source', serialized)
        )
          throw Error('Vault original source proof changed');
        const source = JSON.parse(serialized) as PackageSourceOriginalPhysical;
        const fd = fstatSync(source.sourceFd, { bigint: true }),
          path = lstatSync(source.path, { bigint: true }),
          parent = lstatSync(dirname(source.path), { bigint: true });
        const identity = (stat: typeof fd) =>
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
          throw Error('Vault original leased source changed');
        count++;
      }
      if (count !== input.originalSources) throw Error('Vault original source membership changed');
    }
    if (input.originalArtifacts !== undefined) {
      if (!Number.isSafeInteger(input.originalArtifacts) || input.originalArtifacts < 0)
        throw Error('Vault original artifact count invalid');
      const artifacts = table.prepare(
        'SELECT sequence,id,path,identity,signature FROM original_artifacts ORDER BY sequence',
      );
      let count = 0;
      checkpoint('original-artifact');
      for (const row of artifacts.iterate()) {
        checkpoint();
        if (
          row.sequence !== count ||
          typeof row.id !== 'string' ||
          !row.id ||
          typeof row.path !== 'string' ||
          !row.path ||
          typeof row.identity !== 'string' ||
          !row.identity ||
          row.signature !==
            sign(
              'parent-artifact:' + count,
              'artifact',
              JSON.stringify([row.id, row.path, row.identity]),
            ) ||
          regularFileIdentity(row.path) !== row.identity
        )
          throw Error('Vault original parent artifact changed');
        count++;
      }
      if (count !== input.originalArtifacts)
        throw Error('Vault original parent artifact membership changed');
    }
  } finally {
    table.close();
  }
}

async function prepare(): Promise<number> {
  const physical = new DatabaseSync(input.physical);
  let entries = 0;
  try {
    physical.exec(
      'CREATE TABLE physical(path TEXT PRIMARY KEY,kind TEXT NOT NULL,identity TEXT NOT NULL,signature TEXT NOT NULL); CREATE TABLE workspace(path TEXT PRIMARY KEY,kind TEXT NOT NULL,identity TEXT NOT NULL,signature TEXT NOT NULL); CREATE TABLE verified_originals(path TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(path,bytes,sha256)); CREATE TABLE consumed_sources(sequence INTEGER PRIMARY KEY,source TEXT NOT NULL,signature TEXT NOT NULL,UNIQUE(source)); CREATE TABLE original_artifacts(sequence INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,path TEXT NOT NULL,identity TEXT NOT NULL,signature TEXT NOT NULL); ' +
        VAULT_CERTIFICATE_SCHEMA +
        ' BEGIN',
    );
    const insert = physical.prepare('INSERT INTO physical VALUES(?,?,?,?)');
    for (const item of unlockPhysicalEntries(root)) {
      checkpoint();
      insert.run(item.path, item.kind, item.identity, sign(item.path, item.kind, item.identity));
      entries++;
    }
    physical.exec('COMMIT');
  } finally {
    physical.close();
  }
  const vault = openVault({ directory: input.directory, profileId: input.profileId, key });
  const originals = new DatabaseSync(input.physical);
  const original = originals.prepare(
      'SELECT 1 FROM verified_originals WHERE path=? AND bytes=? AND sha256=?',
    ),
    retainOriginal = originals.prepare('INSERT INTO verified_originals VALUES(?,?,?)');
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    // This derivative index becomes readable only after its complete original
    // replay. Avoid a durable SQLite commit for every certificate/tree node.
    originals.exec('BEGIN');
    const storage = vault.recordStorage(),
      read = storage.read;
    storage.read = (name) => {
      checkpoint();
      return read(name);
    };
    if (storage.read('head')?.toString('utf8') !== input.selectedHead)
      throw Error('Vault original accepted HEAD changed');
    const workspace = originals.prepare('INSERT INTO workspace VALUES(?,?,?,?)');
    for (const item of workspaceEntries()) {
      if (item.kind === 'file') {
        const metadata = vault.fileMetadata(item.path);
        if (
          !metadata ||
          String(metadata.bytes) !== item.identity.split(':')[2] ||
          metadata.sha256 !== unlockPhysicalDigest(resolve(input.workspace!, item.path))
        )
          throw Error('Vault workspace contains an unaccepted original change');
      }
      workspace.run(
        item.path,
        item.kind,
        item.identity,
        sign('workspace:' + item.path, item.kind, item.identity),
      );
    }
    db = openDatabase(input.database, input.profileId);
    withRecordVersionWork(replayWork, () =>
      withRecordReplayCheckpoints(checkpoint, () =>
        attachRecordDurability(db!, {
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
              if (typeof path !== 'string') continue;
              const prefix = `data/profiles/${input.profileId}/`;
              if (path.startsWith('data/profiles/') && !path.startsWith(prefix))
                throw Error('Vault original escaped its profile');
              const name = path.startsWith(prefix) ? path.slice(prefix.length) : path;
              const bytes = Number(row.bytes),
                hash = String(row.sha256);
              if (original.get(path, bytes, hash)) continue;
              if (!vault.verifyFile(name, bytes, hash) && !vault.verifyFile(path, bytes, hash))
                throw Error('Vault accepted original changed');
              retainOriginal.run(path, bytes, hash);
            }
          },
        }),
      ),
    );
    if (input.kind !== 'records') {
      const current = db
        .prepare('SELECT version_id FROM __record_current WHERE entity=? AND record_id=?')
        .get('source_files', JSON.stringify([input.sourceId]));
      if (current?.version_id !== input.previousVersion)
        throw Error('Vault accepted source version differs');
      const acceptedPreimage = db
          .prepare('SELECT contents_json FROM __record_versions WHERE version_id=?')
          .get(input.previousVersion)?.contents_json,
        preimage =
          typeof acceptedPreimage === 'string'
            ? await recordStringFieldDigest(acceptedPreimage, checkpoint)
            : undefined;
      if (
        !preimage ||
        preimage.hash !== input.preimage.hash ||
        preimage.bytes !== input.preimage.bytes
      )
        throw Error('Vault accepted source preimage differs');
      const source = db.prepare('SELECT * FROM source_files WHERE id=?').get(input.sourceId);
      if (!source || Object.keys(source).length !== input.fields.length)
        throw Error('Vault accepted source shape differs');
      for (const field of input.fields) {
        const value = source[field.name],
          digest =
            typeof value === 'string'
              ? await recordStringFieldDigest(value, checkpoint)
              : recordFieldDigest(JSON.stringify(value));
        if (digest.hash !== field.hash || digest.bytes !== field.bytes)
          throw Error('Vault accepted source column differs');
      }
      for (const metadata of input.metadata) {
        if (
          db.prepare('SELECT value FROM app_meta WHERE key=?').get(metadata.key)?.value !==
          metadata.value
        )
          throw Error('Vault selected native binding differs');
      }
    }
    const readMetadata = db.prepare('SELECT * FROM app_meta WHERE key=?');
    const certificates = vaultRecordCertificates(
      originals,
      input.profileId,
      input.nonce,
      checkpoint,
    );
    const readSource = db.prepare('SELECT * FROM source_files WHERE id=?');
    for (const row of db
      .prepare(
        'SELECT c.entity,c.record_id,c.version_id,v.contents_json,v.deleted FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id' +
          (input.kind === 'records' ? '' : " WHERE c.entity IN ('source_files','app_meta')"),
      )
      .iterate()) {
      checkpoint();
      const entity = String(row.entity),
        recordId = String(row.record_id),
        deleted = Number(row.deleted),
        preimage = await recordStringFieldDigest(String(row.contents_json), checkpoint),
        contents = deleted
          ? undefined
          : entity === 'source_files'
            ? readSource.get(JSON.parse(recordId)[0])
            : entity === 'app_meta'
              ? readMetadata.get(JSON.parse(recordId)[0])
              : undefined;
      const fields: { name: string; hash: string; bytes: number }[] = [];
      if (!deleted && ['source_files', 'app_meta'].includes(entity) && !contents)
        throw Error('Vault accepted current certificate row missing');
      for (const [name, value] of Object.entries(contents ?? {})) {
        const digest =
          typeof value === 'string'
            ? await recordStringFieldDigest(value, checkpoint)
            : recordFieldDigest(JSON.stringify(value));
        fields.push({ name, ...digest });
      }
      certificateRoot = certificates.put(certificateRoot, {
        entity,
        recordId,
        versionId: String(row.version_id),
        deleted,
        preimage,
        fields,
      }).root;
    }
    if (storage.read('head')?.toString('utf8') !== input.selectedHead)
      throw Error('Vault accepted HEAD changed during backing verification');
    originals.exec('COMMIT');
    verifyPhysical(entries);
    closing = true;
    verifyPhysical(entries);
    return entries;
  } finally {
    db?.close();
    originals.close();
    vault.close();
  }
}

try {
  if (input.mode === 'prepare')
    parentPort!.postMessage({
      entries: await prepare(),
      certificateRoot,
      decodedVersions: replayWork.reconstruction.decodedVersions,
    });
  else {
    verifyPhysical(input.entries!);
    // No supported host callback follows this complete original roster pass.
    closing = true;
    verifyPhysical(input.entries!);
    parentPort!.postMessage({ entries: input.entries });
  }
} catch {
  parentPort!.postMessage({ refused: true });
} finally {
  key.fill(0);
  signatureKey.fill(0);
  parentPort!.close();
}
