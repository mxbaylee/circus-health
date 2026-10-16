import { parentPort, workerData } from 'node:worker_threads';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve, relative, dirname } from 'node:path';
import { opendirSync, fstatSync, lstatSync, realpathSync } from 'node:fs';
import {
  withRecordReplayCheckpoints,
  createRecordVersionWorkCounters,
  withRecordVersionWork,
} from './record-version-work.ts';
import {
  unlockPhysicalEntries,
  unlockPhysicalDigest,
  unlockPhysicalIdentity,
} from './encrypted-unlock-physical.ts';
import type { VaultRecordBackingInput } from './vault-record-backing.ts';
import type { PackageSourceOriginalPhysical } from './intake-package-source-lease.ts';
import type { IntakeTreeRoot } from './intake-state-tree.ts';
import type { VaultRecordCertificate } from './vault-record-certificates.ts';
import { regularFileIdentity } from './regular-file-identity.ts';
import {
  withRecordReplaySourcePair,
  withOptionalRecordReplaySourcePair,
  signRecordReplaySourcePair,
  type RecordReplaySourcePair,
} from './record-replay-source-pair.ts';
import { intakeNamespace } from './intake-state-evidence.ts';
import { intakeSourcePinKey } from './intake-source-pin-key.ts';
import type { VaultRecordAdvancedCertificate } from './vault-record-backing.ts';

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
let sourcePair: RecordReplaySourcePair | undefined;
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

function verifyPhysical(expected: number, workspaceRoster = true): void {
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
    if (input.workspace && workspaceRoster) {
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
  // Repeated physical verification does not need the recovery/application graph.
  const { openVault } = await import('./vault-store.ts'),
    { openDatabase } = await import('./database.ts'),
    { attachRecordDurability } = await import('./record-versions.ts'),
    { recordFieldDigest, recordStringFieldDigest } = await import('./record-prior-fields.ts'),
    { VAULT_CERTIFICATE_SCHEMA, vaultRecordCertificates, orderedVaultCertificateRows } =
      await import('./vault-record-certificates.ts');
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
    db.exec('PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-2048');
    const rebuild = () =>
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
    if (input.kind === 'head' && input.pair)
      sourcePair = withRecordReplaySourcePair(input.pair, rebuild).pair;
    else if (input.kind === 'records' && input.pair)
      sourcePair = withOptionalRecordReplaySourcePair(input.pair, rebuild).pair;
    else rebuild();
    if (input.kind !== 'records' && input.kind !== 'head') {
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
    }
    for (const metadata of input.metadata) {
      if (
        db.prepare('SELECT value FROM app_meta WHERE key=?').get(metadata.key)?.value !==
        metadata.value
      )
        throw Error('Vault selected native binding differs');
    }
    const readMetadata = db.prepare('SELECT * FROM app_meta WHERE key=?');
    const certificates = vaultRecordCertificates(
      originals,
      input.profileId,
      input.nonce,
      checkpoint,
    );
    const readSource = db.prepare('SELECT * FROM source_files WHERE id=?');
    const certificateBatch: VaultRecordCertificate[] = [];
    const flushCertificates = () => {
      if (!certificateBatch.length) return;
      certificateRoot = certificates.putMany(certificateRoot, certificateBatch).root;
      certificateBatch.length = 0;
    };
    for (const row of orderedVaultCertificateRows(db, checkpoint, input.kind !== 'records')) {
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
      certificateBatch.push({
        entity,
        recordId,
        versionId: String(row.version_id),
        deleted,
        preimage,
        fields,
      });
      if (certificateBatch.length === 64) flushCertificates();
    }
    flushCertificates();
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

/** Extend the retained replay projection from its proven HEAD across exactly
 * the recorded own chain. The ancestry walk, every new version's validation and
 * every newly referenced original's digest still run; history the original
 * cold replay proved is not decoded again. The complete vault namespace is
 * still verified twice against the signed roster, and the workspace is swept
 * with the same accepted-metadata checks as a cold proof. */
async function advance() {
  const { openVault } = await import('./vault-store.ts'),
    { openDatabase } = await import('./database.ts'),
    { attachRecordDurability } = await import('./record-versions.ts'),
    { recordFieldDigest, recordStringFieldDigest } = await import('./record-prior-fields.ts'),
    { observeRecordReplayVersion, completeRecordReplayCommit } =
      await import('./record-replay-source-pair.ts');
  const chain = input.chain ?? [],
    finalHead = chain.length ? chain[chain.length - 1]! : input.replayHead!,
    additions = new Set(input.ownObjects ?? []);
  if (
    typeof input.replayHead !== 'string' ||
    chain.length > 256 ||
    additions.size !== (input.ownObjects ?? []).length ||
    !Number.isSafeInteger(input.entries)
  )
    throw Error('Vault own publication roster invalid');
  const vault = openVault({ directory: input.directory, profileId: input.profileId, key }),
    table = new DatabaseSync(input.physical, { readOnly: true }),
    db = openDatabase(input.database, input.profileId),
    read = new Set<string>();
  try {
    db.exec('PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-2048');
    const state = () =>
      db.prepare('SELECT sequence,head_json FROM __record_state WHERE singleton=1').get() as
        { sequence: number; head_json: string } | undefined;
    const before = state();
    if (!before || before.head_json + '\n' !== input.replayHead)
      throw Error('Vault retained replay HEAD differs from original proof');
    const storage = vault.recordStorage(),
      originalRead = storage.read;
    storage.read = (name) => {
      checkpoint();
      read.add(name);
      return originalRead(name);
    };
    if (storage.read('head')?.toString('utf8') !== finalHead)
      throw Error('Vault accepted HEAD is not the recorded own publication');
    const original = table.prepare(
      'SELECT 1 FROM verified_originals WHERE path=? AND bytes=? AND sha256=?',
    );
    withRecordVersionWork(replayWork, () =>
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
            }
          },
        }),
      ),
    );
    // Exactly the recorded chain: commit k names chain HEAD k-1 as previous.
    const after = state();
    if (!after || after.head_json + '\n' !== finalHead)
      throw Error('Vault advanced replay HEAD differs');
    const commits = db
      .prepare(
        'SELECT sequence,commit_json FROM __record_transactions WHERE sequence>? ORDER BY sequence',
      )
      .all(before.sequence);
    if (commits.length !== chain.length || after.sequence !== before.sequence + chain.length)
      throw Error('Vault accepted history contains foreign publications');
    let previous = input.replayHead;
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
        throw Error('Vault accepted history is not the own publication chain');
      previous = chain[index]!;
    }
    // Every object an own publication added must be one the verified chain read.
    for (const name of additions)
      if (!read.has(name)) throw Error('Vault unexplained physical addition');
    const certificates: VaultRecordAdvancedCertificate[] = [];
    if (chain.length) {
      const scope = input.kind !== 'records' ? " AND entity IN ('source_files','app_meta')" : '',
        touched = db.prepare(
          'SELECT entity,record_id,min(sequence) AS first FROM __record_versions WHERE profile_id=? AND sequence>?' +
            scope +
            ' GROUP BY entity,record_id ORDER BY entity,record_id',
        ),
        earliest = db.prepare(
          'SELECT previous_version FROM __record_versions WHERE profile_id=? AND entity=? AND record_id=? AND sequence=? ORDER BY rowid LIMIT 1',
        ),
        currentRow = db.prepare(
          'SELECT c.version_id,v.contents_json,v.deleted FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
        ),
        readSource = db.prepare('SELECT * FROM source_files WHERE id=?'),
        readMetadata = db.prepare('SELECT * FROM app_meta WHERE key=?');
      for (const row of touched.iterate(input.profileId, before.sequence)) {
        checkpoint();
        if (certificates.length >= 4096) throw Error('Vault own publication delta too large');
        const entity = String(row.entity),
          recordId = String(row.record_id),
          selected = currentRow.get(entity, recordId),
          first = earliest.get(input.profileId, entity, recordId, row.first);
        if (!selected || !first) throw Error('Vault advanced current record missing');
        const deleted = Number(selected.deleted),
          // Identical to the cold certificate codec: complete current SQL row
          // fields for sources and metadata, the exact contents_json preimage.
          contents = deleted
            ? undefined
            : entity === 'source_files'
              ? readSource.get(JSON.parse(recordId)[0])
              : entity === 'app_meta'
                ? readMetadata.get(JSON.parse(recordId)[0])
                : undefined;
        if (!deleted && ['source_files', 'app_meta'].includes(entity) && !contents)
          throw Error('Vault advanced current certificate row missing');
        const fields: { name: string; hash: string; bytes: number }[] = [];
        for (const [name, value] of Object.entries(contents ?? {}))
          fields.push({
            name,
            ...(typeof value === 'string'
              ? await recordStringFieldDigest(value, checkpoint)
              : recordFieldDigest(JSON.stringify(value))),
          });
        certificates.push({
          entity,
          recordId,
          versionId: String(selected.version_id),
          deleted,
          preimage: await recordStringFieldDigest(String(selected.contents_json), checkpoint),
          fields,
          previousAccepted: first.previous_version === null ? null : String(first.previous_version),
        });
      }
    }
    if (input.advancePair) {
      // Fold the identical replay observer over the retained projection's
      // accepted versions, in commit order, for exactly the pair's records.
      const identity = input.advancePair.identity,
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
      sourcePair = input.advancePairOptional
        ? withOptionalRecordReplaySourcePair(input.advancePair, fold).pair
        : withRecordReplaySourcePair(input.advancePair, fold).pair;
    }
    let workspace: { path: string; kind: string; identity: string }[] | undefined;
    if (input.workspace) {
      const sweep = () => {
        const found: { path: string; kind: string; identity: string }[] = [];
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
          found.push({ path: item.path, kind: item.kind, identity: item.identity });
          if (found.length > 1_000_000) throw Error('Vault workspace roster too large');
        }
        return found;
      };
      workspace = sweep();
      if (JSON.stringify(sweep()) !== JSON.stringify(workspace))
        throw Error('Vault source workspace changed during advance');
    }
    if (storage.read('head')?.toString('utf8') !== finalHead)
      throw Error('Vault accepted HEAD changed during advance');
    verifyPhysical(input.entries!, false);
    closing = true;
    verifyPhysical(input.entries!, false);
    return { entries: input.entries!, certificates, workspace };
  } finally {
    db.close();
    table.close();
    vault.close();
  }
}

try {
  if (input.mode === 'prepare')
    parentPort!.postMessage({
      entries: await prepare(),
      certificateRoot,
      decodedVersions: replayWork.reconstruction.decodedVersions,
      sourcePair,
      sourcePairSignature: sourcePair
        ? signRecordReplaySourcePair(signatureKey, input.nonce, sourcePair)
        : undefined,
    });
  else if (input.mode === 'advance') {
    const advanced = await advance();
    parentPort!.postMessage({
      ...advanced,
      decodedVersions: replayWork.reconstruction.decodedVersions,
      sourcePair,
      sourcePairSignature: sourcePair
        ? signRecordReplaySourcePair(signatureKey, input.nonce, sourcePair)
        : undefined,
    });
  } else {
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
