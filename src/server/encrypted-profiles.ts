import { clearSourceDetailsSearchCache } from './source-details-search.ts';
import { clearSourceTextProjectionCache } from './source-text-projection.ts';
import { clearIntakeLookupCache } from './intake-lookup-projection.ts';
import { clearIntakeStateCache } from './intake-state-storage.ts';
import { personDisplayKey } from '../shared/person-display.ts';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  rmSync,
  cpSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import {
  importDiagnostics,
  measureImportPhase,
  type ImportDiagnostics,
} from './import-diagnostics.ts';
import { performance } from 'node:perf_hooks';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { Server, ServerResponse } from 'node:http';
import {
  openDatabase,
  HttpError,
  LATEST_SCHEMA_VERSION,
  transaction,
  type Database,
} from './database.ts';
import { durableWrite, attachPersonalDurability } from './portable.ts';
import {
  registerProfileDisplayGuard,
  selfIdentity,
  getNote,
  saveNote,
  createNote,
} from './notes.ts';
import { ensureProfileDirectories, registerProfileOriginalResolver } from './profile-storage.ts';
import { importStorageEstimate, runtimeCapacity } from './archive-storage.ts';
import { intakeLimits } from './intake-files.ts';
import { writeProfileRegistry } from './profile-registry.ts';
import { seedSyntheticPlacebo } from './synthetic-placebo.ts';
import {
  freshKey,
  recoveryPhrase,
  recoveryEntropy,
  wrapKey,
  unwrapKey,
  type RecoveryKit,
  type VaultKey,
  type WrappedKey,
} from './vault-crypto.ts';
import { openVault, hashFile, type Vault, type VaultRecordStorage } from './vault-store.ts';
import { onboardingIdentity } from './profile-onboarding.ts';
import { validPersonIcon } from '../shared/person-icon.ts';
import { rebuildRecordDatabase, type DurableRecordVersion } from './record-versions.ts';
import { rebindCopiedIntakeSourceText } from './intake-source-text.ts';
import { clearChatJournalCache } from './assistant-journal.ts';
import {
  prepareProductionIntakeStateCopy,
  stageIntakeStateCopy,
  validateProductionIntakeAuthority,
} from './intake-state-bootstrap.ts';
export interface EncryptedLabel {
  algorithm: 'xchacha20poly1305-ietf';
  nonce: string;
  ciphertext: string;
}

export interface ProfilePasskey {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  encryptedLabel?: EncryptedLabel;
  salt: string;
  rpID: string;
  wrapped: WrappedKey;
  createdAt: string;
  lastUsedAt?: string;
}

export interface ProfileKeyring {
  format: 'circus-health-keyring-v1';
  profileId: string;
  recovery: WrappedKey;
  passkeys: ProfilePasskey[];
  active: boolean;
}

export interface ProfileRegistryEntry {
  id: string;
  name: string;
  icon: string;
  placebo: boolean;
  nameVersion: number;
  version: number;
}

interface ProfileRegistry {
  format: 'circus-health-profiles-v1';
  revision: number;
  profiles: ProfileRegistryEntry[];
}

export interface OpenedProfile {
  id: string;
  key: VaultKey;
  vault: Vault;
  root: string;
  workspace: string;
  db: Database;
  recordStorage: VaultRecordStorage;
  metrics: { cacheHit: boolean; loadMs: number };
  app: { server: Server; close(reason?: string): void } | null;
  requests: Set<ServerResponse>;
  closing: boolean;
  disposeOriginalResolver(): void;
}

interface SetupState {
  id: string;
  expires: number;
}

interface SetupDetails {
  fullName?: string;
  birthDate?: string;
  profileId: string;
  name: string;
  icon: string;
  placebo: boolean;
  copyFrom: string | null;
}

interface OpenOptions {
  fullName?: string;
  birthDate?: string;
  initial?: boolean;
  name?: string;
  icon?: string;
  placebo?: boolean;
  copyState?: OpenedProfile;
  pendingActivation?: boolean;
}

type RecordVersion = DurableRecordVersion;

interface BeginInput {
  fullName?: unknown;
  birthDate?: unknown;
  name?: unknown;
  icon?: string;
  placebo?: boolean;
  copyFrom?: string;
}

interface VerifyInput {
  acknowledged?: unknown;
  recovery?: unknown;
}

interface VerifyOptions {
  /** The HTTP caller enforces its current source-session authorization here. */
  authorizeCopySource?: (profileId: string) => void;
}

interface RemoveInput {
  confirmationName?: unknown;
  version?: unknown;
}

type AttachVaultDurability = (
  database: Database,
  options: {
    root: string;
    profileId: string;
    recordStorage: VaultRecordStorage;
    verifyReferences: (versions: RecordVersion[]) => void;
  },
) => unknown;

export interface CreateEncryptedProfilesOptions {
  dataDirectory: string;
  runtimeDirectory: string;
  diagnostics?: ImportDiagnostics;
  /** Injectable filesystem observation for controlled capacity tests. */
  availableRuntimeBytes?: () => number | null;
}

const idValid = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^p-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
function nameOf(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 120 ||
    /[\x00-\x1f]/.test(value)
  )
    throw new HttpError(400, 'PROFILE_NAME', 'Enter a display name of 1–120 characters');
  return value.trim();
}
function safeDir(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw Error('Profile path cannot be a symbolic link');
}
const privateFile = (name: string): boolean =>
  !name.startsWith('record-stream/') &&
  !name.startsWith('db/') &&
  !name.startsWith('personal/') &&
  !name.startsWith('curation/') &&
  !name.endsWith('.pending');
const deferredOriginal = (name: string): boolean =>
  name.startsWith('sources/') || name.startsWith('attachments/');
export function createEncryptedProfiles({
  dataDirectory,
  runtimeDirectory,
  diagnostics = importDiagnostics,
  availableRuntimeBytes = () => runtimeCapacity(runtimeDirectory).reportedAvailableBytes,
}: CreateEncryptedProfilesOptions) {
  const data = realpathSync(dataDirectory),
    registryPath = resolve(data, 'profiles.json'),
    profilesDir = resolve(data, 'profiles'),
    registryStat = lstatSync(registryPath, { throwIfNoEntry: false }),
    profilesStat = lstatSync(profilesDir, { throwIfNoEntry: false });
  if (registryStat && !registryStat.isFile())
    throw Error('Profile registry must be a regular file');
  if (profilesStat && !profilesStat.isDirectory())
    throw Error('Profile directory must be a directory without symbolic links');
  if (!registryStat && profilesStat) {
    // First-time setup is resumable before the first registry publication. An
    // active profile, or an entry we cannot establish as a pending setup, must
    // never turn a damaged archive into an apparently empty installation.
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      let pending = false;
      if (entry.isDirectory() && idValid(entry.name)) {
        const ringPath = resolve(profilesDir, entry.name, 'keyring.json');
        if (lstatSync(ringPath, { throwIfNoEntry: false })?.isFile()) {
          try {
            const ring = JSON.parse(readFileSync(ringPath, 'utf8')) as ProfileKeyring | null;
            pending =
              ring?.format === 'circus-health-keyring-v1' &&
              ring.profileId === entry.name &&
              ring.active === false;
          } catch {
            // Corrupt setup metadata cannot authorize an empty registry.
          }
        }
      }
      if (!pending)
        throw Error(
          'Archive registry is missing while retained profile data exists. Preserve the archive and restore a complete backup; private records and history are unavailable.',
        );
    }
  }
  let registry: ProfileRegistry = registryStat
    ? (JSON.parse(readFileSync(registryPath) as unknown as string) as ProfileRegistry)
    : { format: 'circus-health-profiles-v1', revision: 0, profiles: [] };
  if (
    !registry ||
    registry.format !== 'circus-health-profiles-v1' ||
    !Array.isArray(registry.profiles) ||
    registry.profiles.some((p) => !idValid(p.id) || typeof p.placebo !== 'boolean')
  )
    throw Error('Unsupported archive: use a new empty data directory for encrypted profiles');
  if (new Set(registry.profiles.map((p) => p.id)).size !== registry.profiles.length)
    throw Error('Duplicate profile IDs');
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  const runtime = realpathSync(runtimeDirectory),
    rel = relative(data, runtime),
    back = relative(runtime, data);
  if ((!rel.startsWith('..') && !isAbsolute(rel)) || (!back.startsWith('..') && !isAbsolute(back)))
    throw Error('Runtime plaintext must be separate from durable data');
  mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
  const requireRuntime = (bytes: number, code: string, purpose: string): void => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('Invalid runtime planning size');
    const available = availableRuntimeBytes();
    if (available !== null && available < bytes)
      throw new HttpError(
        507,
        code,
        `Not enough runtime capacity ${purpose}: the planning allowance needs ${Math.ceil(bytes / 1024 / 1024)} MiB and ${Math.floor(available / 1024 / 1024)} MiB is reported available. Lock another profile or increase the runtime mount and host memory together, then retry. Retained originals remain in the encrypted archive.`,
      );
  };
  const opened = new Map<string, OpenedProfile>(),
    setups = new Map<string, SetupState>();
  let registryPublished = !!registryStat;
  const pathFor = (id: unknown): string => {
    if (!idValid(id)) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Profile not found');
    const p = resolve(profilesDir, id);
    safeDir(p);
    return p;
  };
  const writeRegistry = (next?: ProfileRegistry | null): void => {
    const published = { ...(next || registry), revision: registry.revision + 1 };
    durableWrite(registryPath, jsonBytes(published));
    registry = published;
    registryPublished = true;
  };
  const keyring = (id: string): ProfileKeyring =>
    JSON.parse(
      readFileSync(resolve(pathFor(id), 'keyring.json')) as unknown as string,
    ) as ProfileKeyring;
  const writeKeyring = (id: string, value: ProfileKeyring): void =>
    durableWrite(resolve(pathFor(id), 'keyring.json'), jsonBytes(value));
  function bytesBelow(path: string): number {
    if (!existsSync(path)) return 0;
    const s = lstatSync(path);
    if (s.isSymbolicLink()) throw Error('Profile storage cannot contain links');
    return s.isDirectory()
      ? readdirSync(path).reduce((n, f) => n + bytesBelow(resolve(path, f)), 0)
      : s.size;
  }
  function card(id: string) {
    const c = registry.profiles.find((p) => p.id === id);
    if (!c) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Profile not found');
    return { ...c, locked: !opened.has(id), storageBytes: bytesBelow(pathFor(id)) };
  }
  function refreshCard(state: OpenedProfile): void {
    const identity = selfIdentity(state.db) as {
      name: string;
      icon: string;
      nameVersion: number;
    };
    const c = registry.profiles.find((p) => p.id === state.id);
    if (
      c &&
      (c.name !== identity.name ||
        c.icon !== identity.icon ||
        c.nameVersion !== identity.nameVersion)
    ) {
      writeRegistry({
        ...registry,
        profiles: registry.profiles.map((p) =>
          p === c ? { ...p, ...identity, version: identity.nameVersion } : p,
        ),
      });
    }
  }
  function verifyRing(id: string, ring: ProfileKeyring): void {
    if (ring.format !== 'circus-health-keyring-v1' || ring.profileId !== id)
      throw Error('Invalid profile keyring');
  }
  function open(
    id: string,
    key: VaultKey,
    {
      initial = false,
      name,
      fullName,
      birthDate,
      icon,
      placebo = false,
      copyState,
      pendingActivation = false,
    }: OpenOptions = {},
  ): OpenedProfile {
    if (opened.has(id)) {
      key.fill(0);
      return opened.get(id)!;
    }
    const started = performance.now(),
      directory = pathFor(id),
      root = resolve(runtime, id),
      workspace = resolve(root, 'data/profiles', id),
      dbPath = resolve(root, 'db/database.sqlite');
    // A previous process's runtime is never an authority.
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true, mode: 0o700 });
    ensureProfileDirectories(root, id);
    let vault: Vault;
    try {
      vault = openVault({ directory, profileId: id, key, initialize: initial });
    } catch (error) {
      key.fill(0);
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
    let db: Database | null | undefined;
    let disposeOriginalResolver = () => {};
    try {
      // A selected accepted head always wins, including publication followed by
      // an exception before verification/activation acknowledged its success.
      if (vault.recordStorage().read('head') !== null) {
        initial = false;
        copyState = undefined;
      }
      const workspacePlan = vault.workspaceEstimate(deferredOriginal);
      const uploadPlanningBytes = importStorageEstimate(
        intakeLimits().uploadBytes,
        data,
        runtime,
      ).runtimePlanningBytes;
      const databasePlanningBytes = Math.max(
        workspacePlan.databasePlanningBytes,
        copyState ? statSync(copyState.db.location()!).size * 2 : 0,
      );
      requireRuntime(
        workspacePlan.eagerBytes + databasePlanningBytes + uploadPlanningBytes,
        'PROFILE_RUNTIME_CAPACITY',
        'to unlock this profile with its required workspace and one configured upload',
      );
      vault.materialize(workspace, { exclude: deferredOriginal });
      disposeOriginalResolver = registerProfileOriginalResolver(root, id, (path) => {
        const name = path.slice(`data/profiles/${id}/`.length);
        const object = vault.fileMetadata(name);
        if (!object)
          throw new HttpError(
            404,
            'MISSING_FILE',
            'The original file is missing from the encrypted archive',
          );
        requireRuntime(object.bytes, 'ORIGINAL_RUNTIME_CAPACITY', 'to open this retained original');
        if (!vault.materializeFile(name, workspace))
          throw new HttpError(
            404,
            'MISSING_FILE',
            'The original file is missing from the encrypted archive',
          );
      });
      const recordStorage = vault.recordStorage(() =>
        vault.syncWorkspace(workspace, { exclude: (n) => !privateFile(n), publishNow: false }),
      );
      const verifyReferences = (versions: RecordVersion[]): void => {
        for (const v of versions) {
          if (v.deleted) continue;
          const row = v.contents;
          const path = (
            v.entity === 'source_files' ? row.path : v.entity === 'assets' ? row.stored_path : null
          ) as string | null;
          if (!path) continue;
          const prefix = `data/profiles/${id}/`;
          if (
            !path.startsWith(prefix) ||
            path.split('/').some((p) => p === '..' || p === '.') ||
            path.includes('\\')
          )
            throw Error('Original reference escaped its profile');
          const target = resolve(root, path);
          if (!existsSync(target)) {
            if (!vault.verifyFile(path.slice(prefix.length), Number(row.bytes), String(row.sha256)))
              throw Error('Original evidence is missing or changed');
            continue;
          }
          if (
            !existsSync(target) ||
            realpathSync(target) !== target ||
            statSync(target).size !== row.bytes ||
            hashFile(target) !== row.sha256
          )
            throw Error('Original evidence is missing or changed');
        }
      };
      let cacheHit = false;
      if (initial) {
        if (copyState) {
          const intakePlan = prepareProductionIntakeStateCopy(copyState.db, copyState.id, id);
          copyState.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          mkdirSync(resolve(root, 'db'), { recursive: true, mode: 0o700 });
          cpSync(copyState.db.location()!, dbPath);
          // Rebind projection ownership before opening under the new profile.
          const copied = new DatabaseSync(dbPath);
          try {
            transaction(copied, () => {
              copied.prepare("UPDATE app_meta SET value=? WHERE key='owner_profile_id'").run(id);
              for (const [table, column] of [
                ['source_files', 'path'],
                ['assets', 'stored_path'],
              ])
                copied
                  .prepare(`UPDATE ${table} SET ${column}=replace(${column},?,?)`)
                  .run(`data/profiles/${copyState!.id}/`, `data/profiles/${id}/`);
              rebindCopiedIntakeSourceText(copied, copyState!.id, id);
              for (const t of copied
                .prepare(
                  "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '__record_*'",
                )
                .all())
                copied.exec(`DROP TABLE IF EXISTS "${(t.name as string).replaceAll('"', '""')}"`);
              stageIntakeStateCopy(copied, intakePlan, {
                profileId: id,
                readSelectedHead: () => recordStorage.read('head'),
              });
              validateProductionIntakeAuthority(copied, id);
            });
          } finally {
            copied.close();
          }
          // Copy selected durable evidence only. Plaintext workspace changes
          // cannot silently publish new source authority while making a copy.
          const copyManifest = copyState.vault.metadata();
          const scratch = resolve(root, 'copy-original');
          for (const [name, objectId] of Object.entries(copyManifest.files)) {
            if (
              !['sources/', 'attachments/', 'mappings/'].some((prefix) => name.startsWith(prefix))
            )
              continue;
            requireRuntime(
              copyManifest.objects[objectId]!.bytes,
              'PROFILE_RUNTIME_CAPACITY',
              'to copy one retained original',
            );
            try {
              copyState.vault.materializeFile(name, scratch);
              vault.storeFile(name, resolve(scratch, name));
              if (!deferredOriginal(name)) vault.materializeFile(name, workspace);
            } finally {
              rmSync(scratch, { recursive: true, force: true });
            }
          }
        }
        db = openDatabase(dbPath, id);
        const self = getNote(db, 'patient') as Record<string, unknown> & {
          id: string;
          person: Record<string, unknown>;
          version: number;
        };
        (
          saveNote as unknown as (
            db: Database,
            id: string,
            input: Record<string, unknown>,
          ) => unknown
        )(db, self.id, {
          ...self,
          title: name,
          person: {
            ...self.person,
            ...(!copyState
              ? {
                  lifeStatus: 'alive',
                  ...(fullName ? { fullName } : {}),
                  ...(birthDate ? { birthDate } : {}),
                }
              : {}),
            name,
            icon: icon || 'person',
          },
          version: self.version,
        });
        // A new profile gets one ordinary editable note. Copies retain their source
        // notes exactly, and the existence check makes an interrupted initial open safe.
        if (
          !copyState &&
          !db
            .prepare("SELECT 1 FROM notes WHERE kind='note' AND title='Annual Planning' LIMIT 1")
            .get()
        )
          (createNote as unknown as (db: Database, input: Record<string, unknown>) => unknown)(db, {
            kind: 'note',
            title: 'Annual Planning',
            content: '',
            person: {},
          });
        if (placebo) seedSyntheticPlacebo(db, { root, profileId: id, name: name! });
      } else {
        const cache = vault.readCache(dbPath);
        if (
          (cache as { schemaVersion?: unknown } | null)?.schemaVersion === LATEST_SCHEMA_VERSION
        ) {
          try {
            db = openDatabase(dbPath, id);
            if (
              (db.prepare('PRAGMA quick_check').get() as { quick_check?: SQLOutputValue })
                .quick_check !== 'ok'
            )
              throw Error('Invalid cache');
            cacheHit = true;
          } catch {
            if (db) {
              clearIntakeStateCache(db);
              clearIntakeLookupCache(db);
              clearSourceTextProjectionCache(db);
              clearSourceDetailsSearchCache(db);
            }
            db?.close();
            db = null;
          }
        }
        if (!db) {
          for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
          rebuildRecordDatabase(dbPath, {
            profileId: id,
            storage: recordStorage,
            verifyReferences,
          });
          db = openDatabase(dbPath, id);
        }
      }
      if (cacheHit) {
        // Cache reuse must not hide damaged retained originals. Authenticate the
        // deferred files without filling runtime storage with their plaintext.
        const manifest = vault.metadata();
        for (const [file, objectId] of Object.entries(manifest.files)) {
          if (!deferredOriginal(file)) continue;
          const object = manifest.objects[objectId];
          if (!object || !vault.verifyFile(file, object.bytes, object.sha256))
            throw Error('Original evidence is missing or changed');
        }
      }
      try {
        validateProductionIntakeAuthority(db, id);
        (attachPersonalDurability as unknown as AttachVaultDurability)(db, {
          root,
          profileId: id,
          recordStorage,
          verifyReferences,
        });
      } catch (error) {
        if (!cacheHit) throw error;
        clearIntakeStateCache(db);
        clearIntakeLookupCache(db);
        clearSourceTextProjectionCache(db);
        clearSourceDetailsSearchCache(db);
        db.close();
        for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
        rebuildRecordDatabase(dbPath, { profileId: id, storage: recordStorage, verifyReferences });
        db = openDatabase(dbPath, id);
        validateProductionIntakeAuthority(db, id);
        (attachPersonalDurability as unknown as AttachVaultDurability)(db, {
          root,
          profileId: id,
          recordStorage,
          verifyReferences,
        });
        cacheHit = false;
      }
      writeProfileRegistry(root, [
        { id, placebo: placebo || registry.profiles.find((p) => p.id === id)?.placebo || false },
      ]);
      const state: OpenedProfile = {
        id,
        key,
        vault,
        root,
        workspace,
        db,
        recordStorage,
        metrics: { cacheHit, loadMs: performance.now() - started },
        app: null,
        requests: new Set(),
        closing: false,
        disposeOriginalResolver,
      };
      if (!pendingActivation) installOpened(state);
      return state;
    } catch (e) {
      discardFailedOpen({ id, root, key, vault, db, disposeOriginalResolver }, e);
    }
  }
  function installOpened(state: OpenedProfile): void {
    registerProfileDisplayGuard(state.db, (name, icon) =>
      requireDistinctProfile(name, icon, state.id),
    );
    refreshCard(state);
    opened.set(state.id, state);
    diagnostics.attachSummaryStore(state.id, {
      read: () => state.vault.readPerformanceSummary(),
      write: (bytes) => state.vault.writePerformanceSummary(bytes),
    });
    diagnostics.attachEventStore(state.id, state.vault.diagnosticChunks());
  }
  function discardFailedOpen(
    state: Pick<OpenedProfile, 'id' | 'root' | 'key' | 'vault' | 'disposeOriginalResolver'> & {
      db: Database | null | undefined;
    },
    failure: unknown,
  ): never {
    const errors = [failure];
    const cleanup = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    };
    const installed = opened.get(state.id);
    if (installed) installed.closing = true;
    opened.delete(state.id);
    cleanup(() => clearChatJournalCache(state.root, state.id));
    if (state.db) {
      const db = state.db;
      cleanup(() => clearIntakeStateCache(db));
      cleanup(() => clearIntakeLookupCache(db));
      cleanup(() => clearSourceTextProjectionCache(db));
      cleanup(() => clearSourceDetailsSearchCache(db));
      cleanup(() => {
        if (db.isOpen) db.close();
      });
    }
    cleanup(() => state.disposeOriginalResolver());
    cleanup(() => state.vault.close());
    state.key.fill(0);
    // Stores can have attached before installation failed. Close their vault
    // first so detaching diagnostics cannot flush into the retained authority.
    cleanup(() => diagnostics.detachSummaryStore(state.id));
    cleanup(() => rmSync(state.root, { recursive: true, force: true }));
    if (errors.length > 1)
      throw new AggregateError(
        errors,
        'Profile opening failed and runtime cleanup reported errors',
      );
    throw failure;
  }
  function requireDistinctProfile(name: string, icon: string | undefined, exceptId?: string) {
    const pair = personDisplayKey(name, icon);
    if (
      registry.profiles.some((entry) => {
        if (entry.id === exceptId) return false;
        const state = opened.get(entry.id);
        const current = state ? selfIdentity(state.db) : entry;
        return personDisplayKey(current.name, current.icon) === pair;
      })
    )
      throw new HttpError(
        409,
        'DUPLICATE_PROFILE_DISPLAY',
        'Another profile already has this display name and icon. Choose a different display name or icon.',
      );
  }
  function begin(input: BeginInput) {
    const name = nameOf(input.name);
    if (input.icon !== undefined && !validPersonIcon(input.icon))
      throw new HttpError(400, 'PROFILE_ICON', 'Choose a supported person icon');
    if (input.placebo !== undefined && typeof input.placebo !== 'boolean')
      throw new HttpError(400, 'PROFILE_PLACEBO', 'Placebo must be true or false');
    if (input.copyFrom && input.placebo)
      throw new HttpError(400, 'PROFILE_COPY', 'A private copy cannot become a Placebo account');
    const copyState = input.copyFrom ? opened.get(input.copyFrom) : null;
    if (input.copyFrom && !copyState)
      throw new HttpError(423, 'PROFILE_LOCKED', 'Unlock the source profile before copying');
    requireDistinctProfile(name, input.icon || 'person');
    const identity = !input.copyFrom && input.placebo !== true ? onboardingIdentity(input) : {};
    const id = `p-${randomUUID()}`,
      setupId = randomBytes(32).toString('base64url'),
      key = freshKey(),
      secret = freshKey();
    const phrase = recoveryPhrase(secret);
    mkdirSync(pathFor(id), { recursive: true, mode: 0o700 });
    const ring: ProfileKeyring = {
      format: 'circus-health-keyring-v1',
      profileId: id,
      recovery: wrapKey(key, secret, id),
      passkeys: [],
      active: false,
    };
    secret.fill(0);
    writeKeyring(id, ring);
    const vault = openVault({ directory: pathFor(id), profileId: id, key, initialize: true });
    vault.storeFile(
      'setup.json',
      jsonBytes({
        profileId: id,
        name,
        ...identity,
        icon: input.icon || 'person',
        placebo: input.placebo === true,
        copyFrom: input.copyFrom || null,
      }),
    );
    vault.publish();
    vault.close();
    key.fill(0);
    setups.set(setupId, { id, expires: Date.now() + 30 * 60 * 1000 });
    return {
      setupId,
      profileId: id,
      recoveryKit: { format: 'circus-health-recovery-v1', profileId: id, phrase },
    };
  }
  function secretKey(id: string, recovery: unknown): VaultKey {
    const ring = keyring(id);
    verifyRing(id, ring);
    let secret: Buffer | undefined;
    try {
      secret = recoveryEntropy(recovery, id);
      return unwrapKey(ring.recovery, secret, id);
    } catch {
      throw new HttpError(
        400,
        'RECOVERY_INVALID',
        'That recovery key could not unlock this profile. Check the complete phrase or file.',
      );
    } finally {
      secret?.fill(0);
    }
  }
  async function verify(
    setupId: string,
    input: VerifyInput,
    { authorizeCopySource }: VerifyOptions = {},
  ) {
    const setup = setups.get(setupId);
    if (!setup || setup.expires < Date.now())
      throw new HttpError(410, 'SETUP_EXPIRED', 'Restart profile setup.');
    if (input.acknowledged !== true)
      throw new HttpError(
        400,
        'RECOVERY_ACKNOWLEDGMENT',
        'Download and acknowledge your recovery key first',
      );
    const key = secretKey(setup.id, input.recovery);
    let pending: OpenedProfile | undefined;
    try {
      if (registry.profiles.some((p) => p.id === setup.id)) {
        open(setup.id, key);
        return card(setup.id);
      }
      const vault = openVault({ directory: pathFor(setup.id), profileId: setup.id, key });
      let details: SetupDetails;
      let published: boolean;
      try {
        details = JSON.parse(vault.readFile('setup.json') as unknown as string) as SetupDetails;
        published = vault.recordStorage().read('head') !== null;
      } finally {
        vault.close();
      }
      if (details.profileId !== setup.id)
        throw new HttpError(400, 'SETUP_INVALID', 'This recovery file could not resume setup');
      requireDistinctProfile(details.name, details.icon || 'person', setup.id);
      let copyState;
      if (details.copyFrom && !published) {
        authorizeCopySource?.(details.copyFrom);
        copyState = opened.get(details.copyFrom);
        if (!copyState || copyState.closing)
          throw new HttpError(
            423,
            'PROFILE_LOCKED',
            'Unlock the original profile before completing its copy',
          );
      }
      if (!registryPublished) {
        // A crash after the active keyring is published must still leave the
        // registry needed to resume first-time activation with the saved kit.
        writeRegistry();
      }
      pending = open(setup.id, key, {
        ...details,
        initial: !published,
        copyState,
        pendingActivation: true,
      });
      const identity = selfIdentity(pending.db) as {
        name: string;
        icon: string;
        nameVersion: number;
      };
      const ring = keyring(setup.id);
      ring.active = true;
      writeKeyring(setup.id, ring);
      writeRegistry({
        ...registry,
        profiles: [
          ...registry.profiles,
          {
            id: setup.id,
            name: identity.name,
            icon: identity.icon,
            placebo: details.placebo,
            nameVersion: identity.nameVersion,
            version: identity.nameVersion,
          },
        ],
      });
      installOpened(pending);
      return card(setup.id);
    } catch (error) {
      if (pending) discardFailedOpen(pending, error);
      else key.fill(0);
      throw error;
    }
  }
  function unlock(id: string, recovery: unknown) {
    card(id);
    const key = secretKey(id, recovery);
    const state = open(id, key);
    return { ...card(id), metrics: state.metrics };
  }
  function flush(id: string, { duringLock = false }: { duringLock?: boolean } = {}): void {
    const state = opened.get(id);
    if (!state || (state.closing && !duringLock))
      throw new HttpError(423, 'PROFILE_LOCKED', 'Unlock this profile');
    measureImportPhase(
      'encrypted_workspace_flush',
      () => {
        state.vault.syncWorkspace(state.workspace, { exclude: (n) => !privateFile(n) });
        refreshCard(state);
      },
      {},
      { profileId: id },
      diagnostics,
    );
  }
  function lock(id: string) {
    const state = opened.get(id);
    if (!state) return card(id);
    state.closing = true;
    for (const response of state.requests) response.destroy();
    try {
      state.app?.close('profile_locked');
      if (!state.app) state.db.close();
      state.vault.syncWorkspace(state.workspace, { exclude: (n) => !privateFile(n) });
      state.vault.writeCache(resolve(state.root, 'db/database.sqlite'), {
        schemaVersion: LATEST_SCHEMA_VERSION,
      });
    } finally {
      clearIntakeStateCache(state.db);
      clearIntakeLookupCache(state.db);
      clearSourceTextProjectionCache(state.db);
      clearSourceDetailsSearchCache(state.db);
      clearChatJournalCache(state.root, id);
      state.disposeOriginalResolver();
      diagnostics.detachSummaryStore(id);
      state.vault.close();
      state.key.fill(0);
      opened.delete(id);
      rmSync(state.root, { recursive: true, force: true });
    }
    return card(id);
  }
  function remove(id: string, input: RemoveInput) {
    const value = card(id);
    if (value.name !== input.confirmationName || value.version !== input.version)
      throw new HttpError(
        409,
        'PROFILE_CONFIRMATION',
        'Type the current full profile name and try again',
      );
    lock(id);
    writeRegistry({ ...registry, profiles: registry.profiles.filter((p) => p.id !== id) });
    rmSync(pathFor(id), { recursive: true, force: true });
    return { id, deleted: true, backupsRetained: true };
  }
  function resume(recovery: unknown) {
    const id = (recovery as Partial<RecoveryKit> | null)?.profileId;
    if (!idValid(id))
      throw new HttpError(
        400,
        'RECOVERY_FILE',
        'Use the downloaded recovery file to resume interrupted setup',
      );
    const key = secretKey(id, recovery);
    try {
      if (registry.profiles.some((p) => p.id === id))
        return { profileId: id, active: true, name: card(id).name };
      // Resume the original encrypted setup identity for password-manager forms,
      // rather than reusing another profile's name from the browser's UI state.
      const vault = openVault({ directory: pathFor(id), profileId: id, key });
      let details: Partial<SetupDetails>;
      try {
        details = JSON.parse(
          vault.readFile('setup.json') as unknown as string,
        ) as Partial<SetupDetails>;
      } finally {
        vault.close();
      }
      if (details.profileId !== id || typeof details.name !== 'string' || !details.name.trim())
        throw new HttpError(400, 'SETUP_INVALID', 'This recovery file could not resume setup');
      const setupId = randomBytes(32).toString('base64url');
      setups.set(setupId, { id, expires: Date.now() + 30 * 60 * 1000 });
      return { setupId, profileId: id, active: false, name: details.name };
    } finally {
      key.fill(0);
    }
  }
  return {
    begin,
    resume,
    verify,
    unlock,
    lock,
    remove,
    flush,
    card,
    keyring,
    writeKeyring,
    pathFor,
    opened,
    list: () => registry.profiles.map((p) => card(p.id)),
    unlockWithKey(id: string, key: VaultKey) {
      card(id);
      open(id, key);
      return card(id);
    },
    close(): void {
      const errors: unknown[] = [];
      for (const id of [...opened.keys()])
        try {
          lock(id);
        } catch (error) {
          errors.push(error);
        }
      if (errors.length)
        throw new AggregateError(
          errors,
          'Some profile caches could not be saved; all profiles were locked',
        );
    },
  };
}
