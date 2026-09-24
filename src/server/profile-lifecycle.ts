import { onboardingIdentity } from './profile-onboarding.ts';
import { profileDefinition } from './profiles.ts';
import { seedSyntheticPlacebo, SYNTHETIC_PLACEBO_SEED } from './synthetic-placebo.ts';
import { backup, DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  lstatSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { openDatabase, HttpError, type Database } from './database.ts';
import { ensureProfileDirectories, profilePaths } from './profile-storage.ts';
import {
  readProfileRegistry,
  writeProfileRegistry,
  recoverProfileDeletions,
} from './profile-registry.ts';
import {
  attachPersonalDurability,
  exportCuration,
  loadPortable,
  durableWrite,
  syncDirectory,
} from './portable.ts';
import { selfIdentity, getNote, saveNote } from './notes.ts';
export interface ProfileRegistryEntry {
  id: string;
  placebo: boolean;
}
interface ProfileRegistry {
  format: string;
  revision: number;
  profiles: ProfileRegistryEntry[];
}
export interface ProfileInfo extends ProfileRegistryEntry {
  name: string;
  nameVersion: number;
  version: number;
  icon?: string;
}
interface ProfileIdentity {
  name: string;
  nameVersion: number;
  icon?: string;
}
interface ProfileNote extends Record<string, unknown> {
  id: string;
  person: Record<string, unknown>;
  version: number;
}
export interface CreateProfileInput {
  fullName?: unknown;
  birthDate?: unknown;
  name?: unknown;
  placebo?: unknown;
}
export interface RemoveProfileInput {
  confirmationName?: unknown;
  version?: unknown;
}
export interface CreateProfileLifecycleOptions {
  root: string;
  databases: Map<string, Database>;
  databaseDirectory?: string;
  runtimeRoot?: string;
  busy?: (profileId: string) => boolean;
}
export interface ProfileLifecycle {
  list(): ProfileInfo[];
  create(input: CreateProfileInput, sourceId?: string): Promise<ProfileInfo>;
  remove(
    id: string,
    input: RemoveProfileInput,
  ): {
    id: string;
    deleted: true;
    backupsRetained: true;
  };
  isLocked(id: string): boolean;
  close(): void;
}
type SaveProfileNote = (db: Database, id: string, input: Record<string, unknown>) => unknown;
const nameOf = (input: unknown): string => {
  if (
    typeof input !== 'string' ||
    !input.trim() ||
    input.trim().length > 120 ||
    /[\x00-\x1f]/.test(input)
  )
    throw new HttpError(400, 'PROFILE_NAME', 'Enter a display name of 1–120 characters');
  return input.trim();
};
function safeTree(path: string): void {
  if (!existsSync(path)) return;
  const s = lstatSync(path);
  if (s.isSymbolicLink())
    throw new HttpError(409, 'PROFILE_SOURCE_LINK', 'A private copy cannot include symbolic links');
  if (s.isDirectory()) for (const name of readdirSync(path)) safeTree(resolve(path, name));
}
export function profileInfo(db: Database, entry: ProfileRegistryEntry): ProfileInfo {
  const identity = selfIdentity(db) as ProfileIdentity;
  return { ...entry, ...identity, version: identity.nameVersion };
}
export function createProfileLifecycle({
  root,
  databases,
  databaseDirectory,
  runtimeRoot,
  busy = () => false,
}: CreateProfileLifecycleOptions): ProfileLifecycle {
  const locks = new Set<string>();
  let closed = false;
  const assertOpen = (): void => {
    if (closed)
      throw new HttpError(
        503,
        'PROFILE_STOPPED',
        'Profile operation stopped with the application; retry after restart',
      );
  };
  if ((readProfileRegistry(root) as ProfileRegistry).revision === 0)
    writeProfileRegistry(
      root,
      [...databases.keys()].map(
        (id) =>
          (readProfileRegistry(root) as ProfileRegistry).profiles.find((p) => p.id === id) || {
            id,
            placebo: profileDefinition(id).placebo,
          },
      ),
    );
  const list = (): ProfileInfo[] =>
    (readProfileRegistry(root) as ProfileRegistry).profiles
      .filter((p) => databases.has(p.id))
      .map((p) => profileInfo(databases.get(p.id)!, p));
  async function create(input: CreateProfileInput, sourceId?: string): Promise<ProfileInfo> {
    assertOpen();
    const name = nameOf(input?.name),
      id = `p-${randomUUID()}`;
    if (input?.placebo !== undefined && typeof input.placebo !== 'boolean')
      throw new HttpError(400, 'PROFILE_PLACEBO', 'Placebo must be true or false');
    if (sourceId && input?.placebo)
      throw new HttpError(
        400,
        'PROFILE_PLACEBO',
        'A private copy cannot become a synthetic placebo',
      );
    const placebo = !sourceId && input?.placebo === true;
    const identity = !sourceId && !placebo ? onboardingIdentity(input) : {};
    if (sourceId && (!databases.has(sourceId) || locks.has(sourceId) || busy(sourceId)))
      throw new HttpError(
        409,
        'PROFILE_BUSY',
        'Wait for this profile’s current work to finish before copying',
      );
    if (sourceId) locks.add(sourceId);
    const stage = resolve(root, 'data/operations/profile-staging', id);
    let db: Database | null | undefined,
      registered = false;
    let finalDb: string | undefined;
    try {
      const paths = ensureProfileDirectories(stage, id);
      if (sourceId) {
        const source = profilePaths(root, sourceId);
        for (const kind of ['sources', 'attachments'] as const) {
          safeTree(source[kind]);
          if (existsSync(source[kind])) cpSync(source[kind], paths[kind], { recursive: true });
        }
        await backup(databases.get(sourceId)!, paths.database);
        assertOpen();
      }
      // Rewrite only profile-owned storage references; provider payloads and
      // original bytes are retained verbatim in this explicitly PRIVATE copy.
      if (sourceId) {
        const copy = new DatabaseSync(paths.database);
        try {
          copy.exec('BEGIN IMMEDIATE');
          copy.prepare("UPDATE app_meta SET value=? WHERE key='owner_profile_id'").run(id);
          const before = `data/profiles/${sourceId}/`,
            after = `data/profiles/${id}/`;
          for (const [table, column] of [
            ['source_files', 'path'],
            ['assets', 'stored_path'],
          ])
            copy.prepare(`UPDATE ${table} SET ${column}=replace(${column},?,?)`).run(before, after);
          copy
            .prepare("DELETE FROM app_meta WHERE key GLOB 'personal_*' OR key='curation_revision'")
            .run();
          copy.exec('COMMIT');
        } finally {
          copy.close();
        }
      }
      db = openDatabase(paths.database, id);
      const self = getNote(db, 'patient') as ProfileNote;
      (saveNote as unknown as SaveProfileNote)(db, self.id, {
        ...self,
        title: name,
        person: {
          ...self.person,
          ...(!sourceId ? { lifeStatus: 'alive', ...identity } : {}),
          name,
        },
        version: self.version,
      });
      if (placebo)
        seedSyntheticPlacebo(db, {
          root: stage,
          profileId: id,
          name,
          seed: SYNTHETIC_PLACEBO_SEED,
        });
      attachPersonalDurability(db, { root: stage, profileId: id });
      exportCuration(db, stage, id);
      if (sourceId) {
        mkdirSync(resolve(paths.root, 'mappings'), { recursive: true });
        writeFileSync(
          resolve(paths.root, 'mappings/private-copy.json'),
          JSON.stringify(
            {
              format: 'health-private-copy-v1',
              sourceProfileId: sourceId,
              createdAt: new Date().toISOString(),
              scope:
                'Current accepted state and originals. No prior app generations or chats. Private real-data copy; not anonymized.',
            },
            null,
            2,
          ),
        );
      }
      loadPortable(stage, id);
      db.close();
      db = null;
      const final = profilePaths(root, id);
      mkdirSync(dirname(final.root), { recursive: true, mode: 0o700 });
      finalDb = databaseDirectory ? resolve(databaseDirectory, `${id}.sqlite`) : final.database;
      if (databaseDirectory) {
        mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
        cpSync(paths.database, finalDb);
        rmSync(paths.database);
      }
      function flushTree(path: string): void {
        const stat = lstatSync(path);
        if (stat.isDirectory()) {
          for (const name of readdirSync(path)) flushTree(resolve(path, name));
          syncDirectory(path);
        } else {
          const fd = openSync(path, 'r');
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
      }
      flushTree(paths.root);
      assertOpen();
      renameSync(paths.root, final.root);
      syncDirectory(dirname(final.root));
      db = openDatabase(finalDb, id);
      attachPersonalDurability(db, { root, profileId: id });
      const registry = readProfileRegistry(root) as ProfileRegistry;
      writeProfileRegistry(root, [...registry.profiles, { id, placebo }]);
      registered = true;
      databases.set(id, db);
      const result = profileInfo(db, { id, placebo });
      db = null;
      return result;
    } finally {
      if (sourceId) locks.delete(sourceId);
      db?.close();
      rmSync(stage, { recursive: true, force: true });
      // A failed publish retains its complete unregistered profile for recovery.
      if (!registered && finalDb && databaseDirectory && !existsSync(profilePaths(root, id).root))
        rmSync(finalDb, { force: true });
    }
  }
  function remove(
    id: string,
    input: RemoveProfileInput,
  ): { id: string; deleted: true; backupsRetained: true } {
    assertOpen();
    const db = databases.get(id);
    if (!db) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Profile not found');
    const identity = selfIdentity(db) as ProfileIdentity;
    if (input?.confirmationName !== identity.name || input?.version !== identity.nameVersion)
      throw new HttpError(
        409,
        'PROFILE_CONFIRMATION',
        'The name or profile changed. Review the profile and type its current full name.',
      );
    if (locks.has(id) || busy(id))
      throw new HttpError(
        409,
        'PROFILE_BUSY',
        'Wait for this profile’s current work to finish before deleting',
      );
    const target = profilePaths(root, id).root;
    safeTree(target);
    locks.add(id);
    const receipt = resolve(root, 'data/operations/profile-deletions', id + '.json');
    try {
      mkdirSync(dirname(receipt), { recursive: true, mode: 0o700 });
      durableWrite(
        receipt,
        Buffer.from(JSON.stringify({ format: 'health-profile-deletion-v1', profileId: id })),
      );
      const location = db.location();
      db.close();
      databases.delete(id);
      writeProfileRegistry(
        root,
        (readProfileRegistry(root) as ProfileRegistry).profiles.filter((p) => p.id !== id),
      );
      recoverProfileDeletions(root);
      if (
        (runtimeRoot && location!.startsWith(resolve(runtimeRoot) + '/')) ||
        (databaseDirectory && location!.startsWith(resolve(databaseDirectory) + '/'))
      )
        for (const suffix of ['', '-wal', '-shm']) rmSync(location! + suffix, { force: true });
      return { id, deleted: true, backupsRetained: true };
    } finally {
      if (!existsSync(receipt)) locks.delete(id);
    }
  }
  return {
    list,
    create,
    remove,
    isLocked: (id: string) => locks.has(id),
    close() {
      closed = true;
    },
  };
}
