import { parentPort, workerData } from 'node:worker_threads';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve, relative, dirname } from 'node:path';
import { opendirSync } from 'node:fs';
import { openVault } from './vault-store.ts';
import { openDatabase } from './database.ts';
import { attachRecordDurability } from './record-versions.ts';
import { withRecordReplayCheckpoints } from './record-version-work.ts';
import { recordFieldDigest, recordStringFieldDigest } from './record-prior-fields.ts';
import {
  unlockPhysicalEntries,
  unlockPhysicalDigest,
  unlockPhysicalIdentity,
} from './encrypted-unlock-physical.ts';
import type { VaultRecordBackingInput } from './vault-record-backing.ts';

const input = workerData as VaultRecordBackingInput;
const key = Buffer.from(input.key),
  signatureKey = Buffer.from(input.signatureKey),
  root = resolve(input.directory, 'vault');
const sign = (path: string, kind: string, identity: string) =>
  createHmac('sha256', signatureKey)
    .update(JSON.stringify([input.nonce, path, kind, identity]))
    .digest('hex');
let work = 0;
const checkpoint = () => {
  if (++work % 64 === 0) parentPort!.postMessage({ checkpoint: true });
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
  } finally {
    table.close();
  }
}

async function prepare(): Promise<number> {
  const physical = new DatabaseSync(input.physical);
  let entries = 0;
  try {
    physical.exec(
      'CREATE TABLE physical(path TEXT PRIMARY KEY,kind TEXT NOT NULL,identity TEXT NOT NULL,signature TEXT NOT NULL); CREATE TABLE workspace(path TEXT PRIMARY KEY,kind TEXT NOT NULL,identity TEXT NOT NULL,signature TEXT NOT NULL); CREATE TABLE verified_originals(path TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(path,bytes,sha256)); CREATE TABLE accepted_metadata(record_id TEXT PRIMARY KEY,version_id TEXT NOT NULL,hash TEXT,bytes INTEGER,preimage_hash TEXT NOT NULL,preimage_bytes INTEGER NOT NULL,deleted INTEGER NOT NULL,signature TEXT NOT NULL); BEGIN',
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
    );
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
    const metadata = originals.prepare('INSERT INTO accepted_metadata VALUES(?,?,?,?,?,?,?,?)'),
      readMetadata = db.prepare('SELECT value FROM app_meta WHERE key=?');
    for (const row of db
      .prepare(
        "SELECT c.record_id,c.version_id,v.contents_json,v.deleted FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity='app_meta'",
      )
      .iterate()) {
      checkpoint();
      const recordId = String(row.record_id),
        versionId = String(row.version_id),
        value = readMetadata.get(JSON.parse(recordId)[0])?.value,
        preimage = await recordStringFieldDigest(String(row.contents_json), checkpoint),
        digest =
          value === undefined
            ? undefined
            : await recordStringFieldDigest(String(value), checkpoint);
      metadata.run(
        recordId,
        versionId,
        digest?.hash ?? null,
        digest?.bytes ?? null,
        preimage.hash,
        preimage.bytes,
        row.deleted,
        sign(
          'metadata:' + recordId,
          versionId,
          JSON.stringify([
            digest?.hash ?? null,
            digest?.bytes ?? null,
            preimage.hash,
            preimage.bytes,
            row.deleted,
          ]),
        ),
      );
    }
    if (storage.read('head')?.toString('utf8') !== input.selectedHead)
      throw Error('Vault accepted HEAD changed during backing verification');
    verifyPhysical(entries);
    return entries;
  } finally {
    db?.close();
    originals.close();
    vault.close();
  }
}

try {
  if (input.mode === 'prepare') parentPort!.postMessage({ entries: await prepare() });
  else {
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
