import { backup, DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  realpathSync,
  lstatSync,
} from 'node:fs';
import { resolve, dirname, isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, profileFile, containedFile } from './assets.ts';
import { revision, databaseSchemaVersion } from './database.ts';
import { profilePaths } from './profile-storage.ts';
import { validProfileId, profileDefinition } from './profiles.ts';
import { safeLegacyDatabasePath, legacyDatabaseFile } from './profile-ownership.ts';
import { writeProfileRegistry } from './profile-registry.ts';
import { writePortableSources } from './portable.ts';
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

export async function createBackup(
  db: Database,
  root: string,
  profileId: string,
  destination?: string | null,
): Promise<BackupResult> {
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const final = destination || resolve(root, 'data/backups', profileId, id),
    pending = final + '.pending';
  if (existsSync(final) || existsSync(pending))
    throw new Error('Backup destination already exists');
  mkdirSync(pending, { recursive: true, mode: 0o700 });
  let snapshot: DatabaseSync | null | undefined;
  try {
    await backup(db, resolve(pending, 'database.sqlite'));
    snapshot = new DatabaseSync(resolve(pending, 'database.sqlite'), {
      readOnly: true,
    });
    const owner = snapshot
      .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
      .get()?.value;
    if (owner !== profileId) throw new Error('Backup profile mismatch');
    const contributor = hasContributorAuthority(root, profileId);
    if (contributor) assertContributorCopyCoherence(db, root, profileId, snapshot);
    if (snapshot.prepare("SELECT value FROM app_meta WHERE key='personal_conflict'").get()?.value)
      throw new Error(
        'Resolve the newer portable personal history before creating a database-based backup',
      );
    const files = new Map<string, BackupFileReceipt>();
    for (const r of snapshot
      .prepare(
        'SELECT path,sha256,bytes FROM source_files UNION ALL SELECT stored_path AS path,sha256,bytes FROM assets',
      )
      .all() as OriginalRow[]) {
      const source = profileFile(root, r.path, profileId, snapshot);
      const bytes = readFileSync(source);
      if (hash(bytes) !== r.sha256 || bytes.length !== r.bytes)
        throw new Error('Original file changed: ' + r.path);
      if (files.has(r.path) && files.get(r.path)!.sha256 !== r.sha256)
        throw new Error('Conflicting original file hash: ' + r.path);
      files.set(r.path, { path: r.path, sha256: r.sha256, bytes: r.bytes });
      const target = resolve(pending, 'files', r.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    if (contributor) {
      // Selected history can reference originals no longer in current rows.
      // Keep their physical evidence for historical verification during rebuild.
      const retain = (path: string): void => {
        const full = resolve(root, path),
          stat = lstatSync(full);
        if (stat.isDirectory()) {
          for (const name of readdirSync(full)) retain(path + '/' + name);
        } else if (stat.isFile()) {
          if (files.has(path)) return;
          const bytes = readFileSync(profileFile(root, path, profileId));
          files.set(path, { path, bytes: bytes.length, sha256: hash(bytes) });
          const target = resolve(pending, 'files', path);
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          copyFileSync(full, target);
        } else throw Error('Backup original tree contains nonregular files');
      };
      for (const kind of ['sources', 'attachments']) {
        const path = `${profilePaths(root, profileId).relativeRoot}/${kind}`;
        if (existsSync(resolve(root, path))) retain(path);
      }
    }
    const tables = snapshot
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name",
      )
      .all()
      .map((r) => r.name as string);
    const portable = {
      format: 'circus-health-portable-v1',
      profileId,
      schemaVersion: databaseSchemaVersion(snapshot),
      tables: Object.fromEntries(
        tables.map((t) => [t, snapshot!.prepare(`SELECT * FROM "${t}"`).all()]),
      ),
    };
    writeFileSync(resolve(pending, 'portable.json'), JSON.stringify(portable, null, 2), {
      mode: 0o600,
    });
    const paths = profilePaths(root, profileId),
      currentPath = paths.database;
    const modern =
      contributor ||
      (existsSync(currentPath) &&
        realpathSync(db.location() as string) === realpathSync(currentPath)) ||
      (existsSync(resolve(paths.personal, 'current.json')) &&
        existsSync(resolve(paths.curation, 'current.json')) &&
        [...files.keys()].every((path) => path.startsWith(paths.relativeRoot + '/')));
    const profileSources: BackupFileReceipt[] = [];
    if (modern) {
      const retainedPaths = [
        ...(contributor
          ? copyContributorAuthority(root, profileId, resolve(pending, 'files'))
          : []),
        ...writePortableSources(snapshot, root, profileId, resolve(pending, 'files')),
        ...copyAssistantJournals(root, profileId, resolve(pending, 'files')),
        ...copyIntakeBatchJournals(root, profileId, resolve(pending, 'files')),
      ];
      for (const path of new Set(retainedPaths)) {
        const bytes = readFileSync(resolve(pending, 'files', path));
        const file = { path, bytes: bytes.length, sha256: hash(bytes) };
        if (
          path === `${profilePaths(root, profileId).relativeRoot}/record-authority.json` ||
          ['personal', 'curation', 'chats', 'intake-batches', 'mappings', 'records'].some((kind) =>
            path.startsWith(`${profilePaths(root, profileId).relativeRoot}/${kind}/`),
          )
        )
          profileSources.push(file);
        else {
          // Older curation candidates can reference originals absent from the
          // current projection. They remain checksummed originals in backups.
          profileFile(resolve(pending, 'files'), path, profileId);
          const prior = files.get(path);
          if (prior && (prior.sha256 !== file.sha256 || prior.bytes !== file.bytes))
            throw new Error('Conflicting historical original: ' + path);
          files.set(path, file);
        }
      }
    }
    const receipt: BackupManifest = {
      format: modern ? 'circus-health-backup-v2' : 'circus-health-backup-v1',
      profileId,
      createdAt: new Date().toISOString(),
      revision: revision(snapshot),
      schemaVersion: databaseSchemaVersion(snapshot),
      databaseSha256: hash(readFileSync(resolve(pending, 'database.sqlite'))),
      portableSha256: hash(readFileSync(resolve(pending, 'portable.json'))),
      files: [...files.values()],
      ...(modern
        ? { profileSources }
        : safeLegacyDatabasePath(relative(root, String(db.location())))
          ? { databasePath: relative(root, String(db.location())) }
          : {}),
    };
    writeFileSync(resolve(pending, 'manifest.json'), JSON.stringify(receipt, null, 2), {
      mode: 0o600,
    });
    snapshot.close();
    snapshot = null;
    renameSync(pending, final);
    return {
      path: final,
      profileId,
      revision: receipt.revision,
      files: files.size,
    };
  } catch (error) {
    snapshot?.close();
    rmSync(pending, { recursive: true, force: true });
    throw error;
  }
}
function safeRelative(path: unknown): path is string {
  return typeof path === 'string' && !isAbsolute(path) && !path.split(/[\\/]/).includes('..');
}
export function restoreBackup(backupDir: string, targetDir: string): RestoreResult {
  if (existsSync(targetDir) && readdirSync(targetDir).length)
    throw new Error('Restore target must be new or empty; live data will not be overwritten');
  // The receipt is application-owned JSON. Its asserted shape is consumed only
  // after the existing format/profile/array and per-file integrity checks.
  const manifest = JSON.parse(
    readFileSync(resolve(backupDir, 'manifest.json'), 'utf8'),
  ) as BackupManifest;
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
    hash(readFileSync(dbPath)) !== manifest.databaseSha256 ||
    hash(readFileSync(portable)) !== manifest.portableSha256
  )
    throw new Error('Backup database or portable export checksum failed');
  const profileSources =
    manifest.format === 'circus-health-backup-v2' ? manifest.profileSources : [];
  if (!Array.isArray(profileSources) || !Array.isArray(manifest.files))
    throw new Error('Invalid backup file manifest');
  for (const f of profileSources)
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
      d.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('Backup integrity failed');
    if (
      d.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
      manifest.profileId
    )
      throw new Error('Backup profile mismatch');
    for (const f of [...manifest.files, ...profileSources]) {
      if (!safeRelative(f.path)) throw new Error('Invalid manifest path');
      const file = manifest.files.includes(f)
        ? profileFile(resolve(backupDir, 'files'), f.path, manifest.profileId, d)
        : containedFile(backupDir, 'files/' + f.path);
      const bytes = readFileSync(file);
      if (bytes.length !== f.bytes || hash(bytes) !== f.sha256)
        throw new Error('Backup original checksum failed: ' + f.path);
    }
    const referenced = d
      .prepare('SELECT path FROM source_files UNION SELECT stored_path AS path FROM assets')
      .all();
    for (const f of referenced)
      if (!manifest.files.some((x) => x.path === f.path))
        throw new Error('Backup missing a referenced original: ' + f.path);
  } finally {
    d.close();
  }
  const temp = targetDir + '.restore-' + randomUUID();
  mkdirSync(temp, { recursive: true, mode: 0o700 });
  try {
    for (const f of [...manifest.files, ...profileSources]) {
      const target = resolve(temp, f.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(containedFile(backupDir, 'files/' + f.path), target);
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
    else copyFileSync(dbPath, restoredDb);
    writeProfileRegistry(temp, [
      {
        id: manifest.profileId,
        placebo: profileDefinition(manifest.profileId).placebo,
        ...(manifest.format === 'circus-health-backup-v1' ? { legacyDatabase: legacyPath } : {}),
      },
    ]);
    copyFileSync(portable, resolve(temp, 'portable.json'));
    copyFileSync(resolve(backupDir, 'manifest.json'), resolve(temp, 'restore-manifest.json'));
    if (existsSync(targetDir)) rmdirSync(targetDir);
    renameSync(temp, targetDir);
    return {
      path: targetDir,
      profileId: manifest.profileId,
      files: manifest.files.length,
    };
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}
