import { backup, DatabaseSync } from 'node:sqlite';
import {
  mkdirSync as rawMkdirSync,
  opendirSync,
  statSync,
  existsSync,
  copyFileSync as rawCopyFileSync,
  readdirSync,
  renameSync as rawRenameSync,
  rmSync as rawRmSync,
  rmdirSync as rawRmdirSync,
  realpathSync,
  lstatSync,
} from 'node:fs';
import { withManagedPhysicalMutation } from './clinical-review-physical-epoch.ts';

const mkdirSync: typeof rawMkdirSync = (...args) =>
  withManagedPhysicalMutation(() => rawMkdirSync(...args));
const copyFileSync: typeof rawCopyFileSync = (...args) =>
  withManagedPhysicalMutation(() => rawCopyFileSync(...args));
const renameSync: typeof rawRenameSync = (...args) =>
  withManagedPhysicalMutation(() => rawRenameSync(...args));
const rmSync: typeof rawRmSync = (...args) => withManagedPhysicalMutation(() => rawRmSync(...args));
const rmdirSync: typeof rawRmdirSync = (...args) =>
  withManagedPhysicalMutation(() => rawRmdirSync(...args));
import { resolve, dirname, isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { profileFile, containedFile } from './assets.ts';
import { revision, databaseSchemaVersion } from './database.ts';
import { profilePaths } from './profile-storage.ts';
import { validProfileId, profileDefinition } from './profiles.ts';
import { safeLegacyDatabasePath, legacyDatabaseFile } from './profile-ownership.ts';
import { writeProfileRegistry } from './profile-registry.ts';
import { writePortableSources, portableFileDigest, durableWriteChunks } from './portable.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { streamPortableJson } from './portable-json-stream.ts';
import { portableWork } from './portable-work.ts';
import { hasContributorAuthority } from './contributor-record-storage.ts';
import {
  assertContributorCopyCoherence,
  copyContributorAuthority,
  rebuildContributorDatabase,
} from './contributor-durability.ts';
import { copyAssistantJournals } from './assistant-journal.ts';
import { copyIntakeBatchJournals } from './intake-batch-journal.ts';
import type { Database, SqliteRow } from './database.ts';

export interface BackupFileReceipt {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BackupManifest {
  format: 'circus-health-backup-v1' | 'circus-health-backup-v2';
  profileId: string;
  createdAt: string;
  revision: number;
  schemaVersion: number;
  databaseSha256: string;
  portableSha256: string;
  files: BackupFileReceipt[];
  profileSources?: BackupFileReceipt[];
  /** Exact historical data path, when retained by a newer backup writer. */
  databasePath?: string;
}

export interface BackupResult {
  path: string;
  profileId: string;
  revision: number;
  files: number;
}

export interface RestoreResult {
  path: string;
  profileId: string;
  files: number;
}

interface OriginalRow extends SqliteRow {
  path: string;
  sha256: string;
  bytes: number;
}

function copyBackupFile(source: string, target: string): void {
  portableWork('fileCopyCalls', 1);
  copyFileSync(source, target);
  portableWork('fileCopyBytes', statSync(target).size);
}
export async function createBackup(
  db: Database,
  root: string,
  profileId: string,
  destination?: string | null,
): Promise<BackupResult> {
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const final = destination || resolve(root, 'data/backups', profileId, id),
    pending = final + '.pending';
  if (existsSync(final) || existsSync(pending)) throw Error('Backup destination already exists');
  let snapshot: DatabaseSync | null | undefined;
  const inventory = backupInventory();
  try {
    mkdirSync(pending, { recursive: true, mode: 0o700 });
    await backup(db, resolve(pending, 'database.sqlite'));
    snapshot = new DatabaseSync(resolve(pending, 'database.sqlite'), { readOnly: true });
    if (
      snapshot.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
      profileId
    )
      throw Error('Backup profile mismatch');
    const contributor = hasContributorAuthority(root, profileId);
    if (contributor) assertContributorCopyCoherence(db, root, profileId, snapshot);
    if (snapshot.prepare("SELECT value FROM app_meta WHERE key='personal_conflict'").get()?.value)
      throw Error(
        'Resolve the newer portable personal history before creating a database-based backup',
      );
    for (const row of snapshot
      .prepare(
        'SELECT path,sha256,bytes FROM source_files UNION ALL SELECT stored_path AS path,sha256,bytes FROM assets',
      )
      .iterate()) {
      const r = row as OriginalRow,
        source = profileFile(root, r.path, profileId, snapshot),
        digest = portableFileDigest(source);
      if (digest.sha256 !== r.sha256 || digest.bytes !== r.bytes)
        throw Error('Original file changed: ' + r.path);
      const prior = inventory.get('files', r.path);
      if (prior && prior.sha256 !== r.sha256)
        throw Error('Conflicting original file hash: ' + r.path);
      inventory.put('files', { path: r.path, ...digest });
      const target = resolve(pending, 'files', r.path);
      mkdirSync(dirname(target), { recursive: true });
      copyBackupFile(source, target);
    }
    if (contributor) {
      const retain = (path: string) => {
        const full = resolve(root, path),
          stat = lstatSync(full);
        if (stat.isDirectory()) {
          const directory = opendirSync(full);
          try {
            for (let entry = directory.readSync(); entry; entry = directory.readSync())
              retain(path + '/' + entry.name);
          } finally {
            directory.closeSync();
          }
        } else if (stat.isFile()) {
          if (inventory.get('files', path)) return;
          inventory.put('files', {
            path,
            ...portableFileDigest(profileFile(root, path, profileId)),
          });
          const target = resolve(pending, 'files', path);
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          copyBackupFile(full, target);
        } else throw Error('Backup original tree contains nonregular files');
      };
      for (const kind of ['sources', 'attachments']) {
        const path = `${profilePaths(root, profileId).relativeRoot}/${kind}`;
        if (existsSync(resolve(root, path))) retain(path);
      }
    }
    const selectedSnapshot = snapshot;
    function* portableChunks() {
      yield JSON.stringify({
        format: 'circus-health-portable-v1',
        profileId,
        schemaVersion: databaseSchemaVersion(selectedSnapshot),
      }).slice(0, -1) + ',"tables":{';
      let firstTable = true;
      for (const table of selectedSnapshot
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name",
        )
        .iterate()) {
        const name = String(table.name);
        if (!firstTable) yield ',';
        firstTable = false;
        yield JSON.stringify(name) + ':[';
        let first = true;
        for (const row of selectedSnapshot
          .prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"')
          .iterate()) {
          if (!first) yield ',';
          first = false;
          yield JSON.stringify(row);
        }
        yield ']';
      }
      yield '}}';
    }
    durableWriteChunks(resolve(pending, 'portable.json'), portableChunks());
    const paths = profilePaths(root, profileId),
      currentPath = paths.database;
    let ownedOriginals = true;
    for (const file of inventory.rows('files'))
      if (!file.path.startsWith(paths.relativeRoot + '/')) {
        ownedOriginals = false;
        break;
      }
    const modern =
      contributor ||
      (existsSync(currentPath) &&
        realpathSync(db.location() as string) === realpathSync(currentPath)) ||
      (existsSync(resolve(paths.personal, 'current.json')) &&
        existsSync(resolve(paths.curation, 'current.json')) &&
        ownedOriginals);
    function retainPath(path: string) {
      const file = { path, ...portableFileDigest(resolve(pending, 'files', path)) };
      if (
        path === `${paths.relativeRoot}/record-authority.json` ||
        ['personal', 'curation', 'chats', 'intake-batches', 'mappings', 'records'].some((kind) =>
          path.startsWith(`${paths.relativeRoot}/${kind}/`),
        )
      )
        inventory.put('profileSources', file);
      else {
        profileFile(resolve(pending, 'files'), path, profileId);
        const prior = inventory.get('files', path);
        if (prior && (prior.sha256 !== file.sha256 || prior.bytes !== file.bytes))
          throw Error('Conflicting historical original: ' + path);
        inventory.put('files', file);
      }
    }
    if (modern) {
      if (contributor)
        copyContributorAuthority(root, profileId, resolve(pending, 'files'), {
          onFile: retainPath,
        });
      writePortableSources(snapshot, root, profileId, resolve(pending, 'files'), {
        onFile: retainPath,
      });
      copyAssistantJournals(root, profileId, resolve(pending, 'files'), { onFile: retainPath });
      copyIntakeBatchJournals(root, profileId, resolve(pending, 'files'), { onFile: retainPath });
    }
    const receipt = {
      format: modern ? 'circus-health-backup-v2' : 'circus-health-backup-v1',
      profileId,
      createdAt: new Date().toISOString(),
      revision: revision(snapshot),
      schemaVersion: databaseSchemaVersion(snapshot),
      databaseSha256: portableFileDigest(resolve(pending, 'database.sqlite')).sha256,
      portableSha256: portableFileDigest(resolve(pending, 'portable.json')).sha256,
      ...(!modern && safeLegacyDatabasePath(relative(root, String(db.location())))
        ? { databasePath: relative(root, String(db.location())) }
        : {}),
    };
    function* manifestChunks() {
      yield JSON.stringify(receipt).slice(0, -1);
      for (const kind of modern ? ['files', 'profileSources'] : ['files']) {
        yield ',' + JSON.stringify(kind) + ':[';
        let first = true;
        for (const file of inventory.rows(kind)) {
          if (!first) yield ',';
          first = false;
          yield JSON.stringify(file);
        }
        yield ']';
      }
      yield '}';
    }
    durableWriteChunks(resolve(pending, 'manifest.json'), manifestChunks());
    snapshot.close();
    snapshot = null;
    renameSync(pending, final);
    return { path: final, profileId, revision: receipt.revision, files: inventory.count('files') };
  } catch (error) {
    snapshot?.close();
    rmSync(pending, { recursive: true, force: true });
    throw error;
  } finally {
    inventory.close();
  }
}
function backupInventory() {
  const scratch = disposableSqlite('circus-backup-manifest-'),
    db = scratch.db;
  try {
    db.exec(
      'CREATE TABLE files(ordinal INTEGER PRIMARY KEY, kind TEXT, path TEXT, value TEXT); CREATE INDEX file_kind ON files(kind,path);',
    );
  } catch (error) {
    scratch.close();
    throw error;
  }
  return {
    close: scratch.close,
    clear(kind: string) {
      db.prepare('DELETE FROM files WHERE kind=?').run(kind);
    },
    add(kind: string, file: BackupFileReceipt) {
      db.prepare('INSERT INTO files(kind,path,value) VALUES(?,?,?)').run(
        kind,
        file.path,
        JSON.stringify(file),
      );
    },
    put(kind: string, file: BackupFileReceipt) {
      const prior = db
        .prepare('SELECT ordinal FROM files WHERE kind=? AND path=?')
        .get(kind, file.path);
      if (prior)
        db.prepare('UPDATE files SET value=? WHERE ordinal=?').run(
          JSON.stringify(file),
          prior.ordinal!,
        );
      else
        db.prepare('INSERT INTO files(kind,path,value) VALUES(?,?,?)').run(
          kind,
          file.path,
          JSON.stringify(file),
        );
    },
    get(kind: string, path: string): BackupFileReceipt | undefined {
      const row = db.prepare('SELECT value FROM files WHERE kind=? AND path=?').get(kind, path);
      return row ? (JSON.parse(String(row.value)) as BackupFileReceipt) : undefined;
    },
    *rows(kind: string): Generator<BackupFileReceipt> {
      for (const row of db
        .prepare('SELECT value FROM files WHERE kind=? ORDER BY ordinal')
        .iterate(kind))
        yield JSON.parse(String(row.value)) as BackupFileReceipt;
    },
    count(kind: string) {
      return Number(db.prepare('SELECT COUNT(*) n FROM files WHERE kind=?').get(kind)!.n);
    },
  };
}
function safeRelative(path: unknown): path is string {
  return typeof path === 'string' && !isAbsolute(path) && !path.split(/[\\/]/).includes('..');
}
export function restoreBackup(backupDir: string, targetDir: string): RestoreResult {
  if (existsSync(targetDir) && readdirSync(targetDir).length)
    throw new Error('Restore target must be new or empty; live data will not be overwritten');
  const inventory = backupInventory();
  try {
    const fields = new Set<string>();
    const manifest = streamPortableJson(
      resolve(backupDir, 'manifest.json'),
      (name) => {
        inventory.clear(name.slice(1));
        fields.add(name);
      },
      (name, value) => {
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          typeof (value as BackupFileReceipt).path !== 'string'
        )
          throw Error('Invalid backup file manifest');
        inventory.add(name.slice(1), value as BackupFileReceipt);
      },
      undefined,
      { arrayFields: ['files', 'profileSources'], requireTables: false, parseTables: false },
    ) as unknown as Omit<BackupManifest, 'files' | 'profileSources'>;
    if (
      !['circus-health-backup-v1', 'circus-health-backup-v2'].includes(manifest.format) ||
      !validProfileId(manifest.profileId)
    )
      throw new Error('Unsupported backup');
    if (manifest.databasePath !== undefined && !safeLegacyDatabasePath(manifest.databasePath))
      throw new Error('Invalid backup database path');
    const dbPath = containedFile(backupDir, 'database.sqlite'),
      portable = containedFile(backupDir, 'portable.json');
    if (
      portableFileDigest(dbPath).sha256 !== manifest.databaseSha256 ||
      portableFileDigest(portable).sha256 !== manifest.portableSha256
    )
      throw new Error('Backup database or portable export checksum failed');
    const profileSources = () =>
      manifest.format === 'circus-health-backup-v2' ? inventory.rows('profileSources') : [];
    if (
      !fields.has('$files') ||
      (manifest.format === 'circus-health-backup-v2' && !fields.has('$profileSources'))
    )
      throw Error('Invalid backup file manifest');
    for (const f of profileSources())
      if (
        f.path !==
          `${profilePaths(backupDir, manifest.profileId).relativeRoot}/record-authority.json` &&
        !['personal', 'curation', 'chats', 'intake-batches', 'mappings', 'records'].some((kind) =>
          f.path.startsWith(`${profilePaths(backupDir, manifest.profileId).relativeRoot}/${kind}/`),
        )
      )
        throw new Error('Backup portable source is outside profile');
    const d = new DatabaseSync(dbPath, { readOnly: true });
    try {
      if (
        d.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
        d.prepare('PRAGMA foreign_key_check').get()
      )
        throw new Error('Backup integrity failed');
      if (
        d.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
        manifest.profileId
      )
        throw new Error('Backup profile mismatch');
      for (const kind of manifest.format === 'circus-health-backup-v2'
        ? ['files', 'profileSources']
        : ['files']) {
        for (const f of inventory.rows(kind)) {
          if (!safeRelative(f.path)) throw Error('Invalid manifest path');
          const file =
            kind === 'files'
              ? profileFile(resolve(backupDir, 'files'), f.path, manifest.profileId, d)
              : containedFile(backupDir, 'files/' + f.path);
          const digest = portableFileDigest(file);
          if (digest.bytes !== f.bytes || digest.sha256 !== f.sha256)
            throw Error('Backup original checksum failed: ' + f.path);
        }
      }
      for (const file of d
        .prepare('SELECT path FROM source_files UNION SELECT stored_path AS path FROM assets')
        .iterate())
        if (!inventory.get('files', String(file.path)))
          throw Error('Backup missing a referenced original: ' + file.path);
    } finally {
      d.close();
    }
    const temp = targetDir + '.restore-' + randomUUID();
    mkdirSync(temp, { recursive: true, mode: 0o700 });
    try {
      for (const kind of manifest.format === 'circus-health-backup-v2'
        ? ['files', 'profileSources']
        : ['files'])
        for (const f of inventory.rows(kind)) {
          const target = resolve(temp, f.path);
          mkdirSync(dirname(target), { recursive: true });
          copyBackupFile(containedFile(backupDir, 'files/' + f.path), target);
        }
      const legacyPath =
        manifest.databasePath ??
        profileDefinition(manifest.profileId).legacyDatabase ??
        'data/database.sqlite';
      const restoredDb =
        manifest.format === 'circus-health-backup-v2'
          ? profilePaths(temp, manifest.profileId).database
          : legacyDatabaseFile(temp, legacyPath);
      mkdirSync(dirname(restoredDb), { recursive: true });
      if (hasContributorAuthority(temp, manifest.profileId))
        rebuildContributorDatabase(restoredDb, temp, manifest.profileId);
      else copyBackupFile(dbPath, restoredDb);
      writeProfileRegistry(temp, [
        {
          id: manifest.profileId,
          placebo: profileDefinition(manifest.profileId).placebo,
          ...(manifest.format === 'circus-health-backup-v1' ? { legacyDatabase: legacyPath } : {}),
        },
      ]);
      copyBackupFile(portable, resolve(temp, 'portable.json'));
      copyBackupFile(resolve(backupDir, 'manifest.json'), resolve(temp, 'restore-manifest.json'));
      if (existsSync(targetDir)) rmdirSync(targetDir);
      renameSync(temp, targetDir);
      return {
        path: targetDir,
        profileId: manifest.profileId,
        files: inventory.count('files'),
      };
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      throw error;
    }
  } finally {
    inventory.close();
  }
}
