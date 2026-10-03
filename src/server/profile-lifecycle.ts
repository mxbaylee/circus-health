import { personDisplayKey } from '../shared/person-display.ts';
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
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { openDatabase, HttpError, transaction, type Database } from './database.ts';
import { rebindCopiedIntakeSourceText } from './intake-source-text.ts';
import { stageIntakeStateCopy } from './intake-state-bootstrap.ts';
import {
  preparePortableIntakeCopy,
  assertPortableCopyCoherence,
} from './intake-state-portable-copy.ts';
import {
  copyOperationId,
  readCopyOperation,
  newCopyOperation,
  writeCopyOperation,
  selectCopyHeads,
  verifyCopyHeads,
  type ProfileCopyOperation,
} from './profile-copy-operation.ts';
import { ensureProfileDirectories, profilePaths } from './profile-storage.ts';
import { contributorAuthorityPath, hasContributorAuthority } from './contributor-record-storage.ts';
import {
  rebuildContributorDatabase,
  assertContributorCopyCoherence,
  selectedContributorHead,
} from './contributor-durability.ts';
import {
  readProfileRegistry,
  writeProfileRegistry,
  recoverProfileDeletions,
} from './profile-registry.ts';
import {
  attachPersonalDurability,
  flushPersonal,
  writePortableSources,
  loadPortable,
  durableWrite,
  syncDirectory,
  type CompleteLoadedPortable,
} from './portable.ts';
import { registerProfileDisplayGuard, selfIdentity, getNote, saveNote } from './notes.ts';
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
  operationId?: string;
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
  operationId?: unknown;
}
export interface RemoveProfileInput {
  confirmationName?: unknown;
  version?: unknown;
}
export type ProfileCopyCheckpoint =
  | 'validated'
  | 'staged'
  | 'before-export'
  | 'exported'
  | 'before-publication'
  | 'renamed'
  | 'published'
  | 'registered'
  | 'activated';
export interface ProfileCopyCheckpointContext {
  operationId: string;
  sourceProfileId: string;
  targetProfileId: string;
  stageRoot: string;
}
export interface CreateProfileLifecycleOptions {
  root: string;
  databases: Map<string, Database>;
  databaseDirectory?: string;
  runtimeRoot?: string;
  busy?: (profileId: string) => boolean;
  copyCheckpoint?: (
    checkpoint: ProfileCopyCheckpoint,
    context: ProfileCopyCheckpointContext,
  ) => void;
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
  copyCheckpoint = () => {},
}: CreateProfileLifecycleOptions): ProfileLifecycle {
  const locks = new Set<string>();
  const copyLocks = new Set<string>();
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
  function requireDistinctProfile(name: string, icon?: string, exceptId?: string) {
    if (
      list().some(
        (p) =>
          p.id !== exceptId && personDisplayKey(p.name, p.icon) === personDisplayKey(name, icon),
      )
    )
      throw new HttpError(
        409,
        'DUPLICATE_PROFILE_DISPLAY',
        'Another profile already has this display name and icon. Choose a different display name or icon.',
      );
  }
  const guard = (id: string, db: Database) =>
    registerProfileDisplayGuard(db, (name, icon) => requireDistinctProfile(name, icon, id));
  for (const [id, db] of databases) guard(id, db);
  function checkpoint(
    operation: ProfileCopyOperation | null,
    stageRoot: string,
    point: ProfileCopyCheckpoint,
  ): void {
    if (operation)
      copyCheckpoint(point, {
        operationId: operation.operationId,
        sourceProfileId: operation.sourceProfileId,
        targetProfileId: operation.targetProfileId,
        stageRoot,
      });
  }
  function rebindCopyReceipts(
    copy: Database,
    sourceProfileId: string,
    targetProfileId: string,
  ): void {
    for (const row of copy
      .prepare(
        "SELECT key,value FROM app_meta WHERE key GLOB 'personal_restore_*' OR key GLOB 'personal_assistant_*'",
      )
      .all()) {
      if (typeof row.key !== 'string' || typeof row.value !== 'string')
        throw new HttpError(409, 'PROFILE_COPY_RECEIPT', 'Source public receipt is invalid');
      const archiveKey = `private_copy_source_receipt:v1:${sourceProfileId}:${row.key}`;
      const archived = copy.prepare('SELECT value FROM app_meta WHERE key=?').get(archiveKey);
      if (archived && archived.value !== row.value)
        throw new HttpError(
          409,
          'PROFILE_COPY_RECEIPT',
          'Source public receipt conflicts with retained copy evidence',
        );
      copy
        .prepare('INSERT OR IGNORE INTO app_meta(key,value) VALUES(?,?)')
        .run(archiveKey, row.value);
      const value = JSON.parse(row.value) as Record<string, unknown>;
      if (row.key.startsWith('personal_assistant_') && value.intakePersonProposalId !== undefined) {
        if (
          value.profileId !== sourceProfileId ||
          value.kind !== 'person' ||
          typeof value.intakePersonProposalId !== 'string' ||
          typeof value.personId !== 'string' ||
          typeof value.noteId !== 'string' ||
          !Number.isSafeInteger(value.version) ||
          Number(value.version) < 1 ||
          !copy
            .prepare("SELECT 1 FROM notes WHERE id=? AND kind='person' AND person_id=?")
            .get(value.noteId, value.personId)
        )
          throw new HttpError(
            409,
            'PROFILE_COPY_RECEIPT',
            'Source saved People receipt is invalid',
          );
        // Accepted People proposal IDs/versions remain public receipt identity.
        // Source history/chat receipts are retained above as evidence, not target replay authority.
        copy
          .prepare('UPDATE app_meta SET value=? WHERE key=?')
          .run(JSON.stringify({ ...value, profileId: targetProfileId }), row.key);
      } else copy.prepare('DELETE FROM app_meta WHERE key=?').run(row.key);
    }
  }
  function activatePublishedCopy(operation: ProfileCopyOperation): ProfileInfo {
    const id = operation.targetProfileId,
      final = profilePaths(root, id);
    safeTree(final.root);
    const registry = readProfileRegistry(root) as ProfileRegistry;
    const entry = registry.profiles.find((p) => p.id === id);
    const active = databases.get(id);
    const receipt = JSON.parse(
      readFileSync(resolve(final.root, 'mappings/private-copy.json'), 'utf8'),
    );
    if (
      receipt.format !== 'health-private-copy-v1' ||
      receipt.operationId !== operation.operationId ||
      receipt.sourceProfileId !== operation.sourceProfileId ||
      receipt.targetProfileId !== id
    )
      throw new HttpError(
        409,
        'PROFILE_COPY_OPERATION',
        'Published private copy receipt conflicts',
      );
    // A completed target can legitimately have newer accepted generations.
    // Retried operations never change its selected state or user edits.
    if (entry && active) {
      if (
        !operation.published ||
        entry.placebo ||
        active.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
          id
      )
        throw new HttpError(
          409,
          'PROFILE_COPY_OPERATION',
          'Private copy registry binding conflicts',
        );
      flushPersonal(active);
      return { ...profileInfo(active, entry), operationId: operation.operationId };
    }
    if (!entry) verifyCopyHeads(operation, loadPortable(root, id) as CompleteLoadedPortable, root);
    else if (!operation.published || entry.placebo)
      throw new HttpError(409, 'PROFILE_COPY_OPERATION', 'Private copy registry binding conflicts');
    operation = { ...operation, published: true };
    writeCopyOperation(root, operation);
    const location = databaseDirectory
      ? resolve(databaseDirectory, `${id}.sqlite`)
      : final.database;
    let recovered: Database | undefined;
    try {
      if (!existsSync(location)) rebuildContributorDatabase(location, root, id);
      recovered = openDatabase(location, id);
      attachPersonalDurability(recovered, { root, profileId: id, initialize: false });
      assertPortableCopyCoherence(recovered, root, id);
      const identity = selfIdentity(recovered);
      if (!entry && identity.name !== operation.name)
        throw new HttpError(
          409,
          'PROFILE_COPY_OPERATION',
          'Published private copy display name conflicts',
        );
      requireDistinctProfile(identity.name, identity.icon, id);
      assertOpen();
      if (!entry) writeProfileRegistry(root, [...registry.profiles, { id, placebo: false }]);
      else if (entry.placebo)
        throw new HttpError(
          409,
          'PROFILE_COPY_OPERATION',
          'Private copy registry binding conflicts',
        );
      checkpoint(operation, resolve(root, 'data/operations/profile-staging', id), 'registered');
      guard(id, recovered);
      databases.set(id, recovered);
      recovered = undefined;
      checkpoint(operation, resolve(root, 'data/operations/profile-staging', id), 'activated');
      return {
        ...profileInfo(databases.get(id)!, { id, placebo: false }),
        operationId: operation.operationId,
      };
    } finally {
      recovered?.close();
    }
  }
  async function create(input: CreateProfileInput, sourceId?: string): Promise<ProfileInfo> {
    assertOpen();
    const name = nameOf(input?.name);
    if (input?.placebo !== undefined && typeof input.placebo !== 'boolean')
      throw new HttpError(400, 'PROFILE_PLACEBO', 'Placebo must be true or false');
    if (sourceId && input?.placebo)
      throw new HttpError(
        400,
        'PROFILE_PLACEBO',
        'A private copy cannot become a synthetic placebo',
      );
    const operationId = sourceId ? copyOperationId(input?.operationId) : undefined;
    if (operationId && copyLocks.has(operationId))
      throw new HttpError(
        409,
        'PROFILE_BUSY',
        'This private copy operation is already in progress',
      );
    let operation = sourceId ? readCopyOperation(root, operationId!, sourceId, name) : null;
    if (operation && existsSync(profilePaths(root, operation.targetProfileId).root)) {
      copyLocks.add(operation.operationId);
      try {
        return activatePublishedCopy(operation);
      } finally {
        copyLocks.delete(operation.operationId);
      }
    }
    if (
      operation?.published ||
      operation?.publicationAttempted ||
      (operation &&
        (databases.has(operation.targetProfileId) ||
          (readProfileRegistry(root) as ProfileRegistry).profiles.some(
            (p) => p.id === operation!.targetProfileId,
          )))
    )
      throw new HttpError(
        409,
        'PROFILE_COPY_OPERATION',
        'Published private copy is missing; recover it explicitly rather than recopying',
      );
    const placebo = !sourceId && input?.placebo === true;
    const identity = !sourceId && !placebo ? onboardingIdentity(input) : {};
    if (sourceId && (!databases.has(sourceId) || locks.has(sourceId) || busy(sourceId)))
      throw new HttpError(
        409,
        'PROFILE_BUSY',
        'Wait for this profile’s current work to finish before copying',
      );
    requireDistinctProfile(name, sourceId ? selfIdentity(databases.get(sourceId)!).icon : 'person');
    if (sourceId) {
      locks.add(sourceId);
      copyLocks.add(operationId!);
      operation ??= newCopyOperation(operationId!, sourceId, name);
    }
    const id = operation?.targetProfileId ?? `p-${randomUUID()}`;
    const stage = resolve(root, 'data/operations/profile-staging', id);
    let db: Database | null | undefined,
      registered = false;
    let finalDb: string | undefined;
    try {
      if (operation) writeCopyOperation(root, operation);
      // A crashed unpublished workspace has no selected authority and is replaced.
      if (sourceId) rmSync(stage, { recursive: true, force: true });
      const paths = ensureProfileDirectories(stage, id);
      if (sourceId) {
        const source = profilePaths(root, sourceId);
        for (const kind of ['sources', 'attachments'] as const) {
          safeTree(source[kind]);
          if (existsSync(source[kind])) cpSync(source[kind], paths[kind], { recursive: true });
        }
        await backup(databases.get(sourceId)!, paths.database);
        assertOpen();
        const copy = new DatabaseSync(paths.database);
        try {
          const plan = preparePortableIntakeCopy(
            databases.get(sourceId)!,
            copy,
            root,
            sourceId,
            id,
          );
          checkpoint(operation, stage, 'validated');
          transaction(copy, () => {
            copy.prepare("UPDATE app_meta SET value=? WHERE key='owner_profile_id'").run(id);
            const before = `data/profiles/${sourceId}/`,
              after = `data/profiles/${id}/`;
            for (const [table, column] of [
              ['source_files', 'path'],
              ['assets', 'stored_path'],
            ])
              copy
                .prepare(
                  `UPDATE ${table} SET ${column}=? || substr(${column},?) WHERE substr(${column},1,?)=?`,
                )
                .run(after, before.length + 1, before.length, before);
            rebindCopiedIntakeSourceText(copy, sourceId, id);
            for (const row of copy
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '__record_*'",
              )
              .all())
              copy.exec(`DROP TABLE IF EXISTS "${String(row.name).replaceAll('"', '""')}"`);
            stageIntakeStateCopy(copy, plan, {
              profileId: id,
              readSelectedHead: () => {
                for (const base of [stage, root]) {
                  if (hasContributorAuthority(base, id))
                    throw Error(
                      'Copy target already has selected record authority: ' +
                        contributorAuthorityPath(base, id),
                    );
                  for (const kind of ['personal', 'curation'] as const) {
                    const head = resolve(profilePaths(base, id)[kind], 'current.json');
                    if (existsSync(head)) return readFileSync(head);
                  }
                }
                return null;
              },
            });
            rebindCopyReceipts(copy, sourceId, id);
            copy
              .prepare(
                "DELETE FROM app_meta WHERE key IN ('personal_dirty','personal_persisted_revision','personal_last_error','personal_conflict','curation_revision')",
              )
              .run();
          });
          checkpoint(operation, stage, 'staged');
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
      checkpoint(operation, stage, 'before-export');
      attachPersonalDurability(db, { root: stage, profileId: id, initialize: true });
      // One-time portable copy/export artifact. Subsequent runtime writes select
      // only the record journal and never refresh these complete snapshots.
      writePortableSources(db, stage, id, stage);
      if (operation) {
        mkdirSync(resolve(paths.root, 'mappings'), { recursive: true });
        durableWrite(
          resolve(paths.root, 'mappings/private-copy.json'),
          Buffer.from(
            JSON.stringify(
              {
                format: 'health-private-copy-v1',
                operationId: operation.operationId,
                sourceProfileId: sourceId,
                targetProfileId: id,
                createdAt: operation.createdAt,
                scope:
                  'Current accepted state and originals. No prior app generations or chats. Private real-data copy; not anonymized.',
              },
              null,
              2,
            ) + '\n',
          ),
        );
      }
      checkpoint(operation, stage, 'exported');
      assertContributorCopyCoherence(db, stage, id);
      const acceptedHead = selectedContributorHead(stage, id);
      const portable = loadPortable(stage, id) as CompleteLoadedPortable;
      if (operation) {
        operation = selectCopyHeads(operation, portable, stage);
        writeCopyOperation(root, operation);
      }
      const createdIdentity = selfIdentity(db);
      db.close();
      db = null;
      const final = profilePaths(root, id);
      mkdirSync(dirname(final.root), { recursive: true, mode: 0o700 });
      finalDb = databaseDirectory ? resolve(databaseDirectory, `${id}.sqlite`) : final.database;
      if (databaseDirectory) {
        mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
        if (existsSync(finalDb))
          throw new HttpError(
            409,
            'PROFILE_COPY_OPERATION',
            'Copy destination cache already exists',
          );
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
      requireDistinctProfile(createdIdentity.name, createdIdentity.icon);
      checkpoint(operation, stage, 'before-publication');
      if (selectedContributorHead(stage, id) !== acceptedHead)
        throw Error('Prepared contributor authority changed before target publication');
      if (existsSync(final.root))
        throw new HttpError(
          409,
          'PROFILE_COPY_OPERATION',
          'Private copy destination already exists; recover it explicitly',
        );
      if (operation) {
        operation = { ...operation, publicationAttempted: true };
        writeCopyOperation(root, operation);
      }
      renameSync(paths.root, final.root);
      checkpoint(operation, stage, 'renamed');
      syncDirectory(dirname(final.root));
      if (operation) {
        operation = { ...operation, published: true };
        writeCopyOperation(root, operation);
        checkpoint(operation, stage, 'published');
        return activatePublishedCopy(operation);
      }
      db = openDatabase(finalDb, id);
      attachPersonalDurability(db, { root, profileId: id, initialize: false });
      const registry = readProfileRegistry(root) as ProfileRegistry;
      writeProfileRegistry(root, [...registry.profiles, { id, placebo }]);
      guard(id, db);
      registered = true;
      databases.set(id, db);
      const result = profileInfo(db, { id, placebo });
      db = null;
      return result;
    } finally {
      try {
        // Only this live operation can prove a failed rename retained its stage.
        // After restart, absent final storage alone never proves nonpublication.
        if (
          operation?.publicationAttempted &&
          !operation.published &&
          existsSync(profilePaths(stage, id).root) &&
          !existsSync(profilePaths(root, id).root)
        ) {
          const { publicationAttempted: _attempted, ...unpublished } = operation;
          writeCopyOperation(root, unpublished);
        }
      } finally {
        if (sourceId) locks.delete(sourceId);
        if (operationId) copyLocks.delete(operationId);
        db?.close();
        rmSync(stage, { recursive: true, force: true });
        if (!registered && finalDb && databaseDirectory && !existsSync(profilePaths(root, id).root))
          rmSync(finalDb, { force: true });
      }
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
