import { clearSourceContextClassificationCache } from './intake-source-context-classification.ts';
import { archiveRefusal } from './archive-refusal.ts';
import { clearSourceDetailsSearchCache } from './source-details-search.ts';
import { clearSourceTextProjectionCache } from './source-text-projection.ts';
import { clearIntakeLookupCache } from './intake-lookup-projection.ts';
import { clearIntakeStateCache } from './intake-state-storage.ts';
import { clearIdentityGrounding } from './intake-identity-grounding.ts';
import { clearPackageSourceSession } from './intake-package-session.ts';
import {
  prepareManualSourceCopy,
  stageManualSourceCopy,
  disposeManualSourceCopyPlan,
} from './intake-manual-copy.ts';
import { personDisplayKey } from '../shared/person-display.ts';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  mkdirSync as rawMkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  rmSync as rawRmSync,
  cpSync as rawCpSync,
  statSync,
  realpathSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import {
  withManagedPhysicalMutation,
  captureManagedPhysicalEpoch,
  managedPhysicalEpochCurrent,
} from './clinical-review-physical-epoch.ts';

const mkdirSync: typeof rawMkdirSync = (...args) =>
  withManagedPhysicalMutation(() => rawMkdirSync(...args));
const rmSync: typeof rawRmSync = (...args) => withManagedPhysicalMutation(() => rawRmSync(...args));
const cpSync: typeof rawCpSync = (...args) => withManagedPhysicalMutation(() => rawCpSync(...args));
import { resolve, relative, isAbsolute } from 'node:path';
import {
  importDiagnostics,
  measureImportPhase,
  type ImportDiagnostics,
} from './import-diagnostics.ts';
import { performance } from 'node:perf_hooks';
import { rm as removeRuntime, opendir, lstat, mkdtemp } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import {
  prepareEncryptedUnlock,
  unlockAuthorityWitness,
  assertUnlockAuthority,
  unlockPathIdentity,
  type PreparedUnlock,
  type UnlockAuthorityWitness,
} from './encrypted-profile-preparation.ts';
import type { UnlockPhysicalWitness } from './encrypted-unlock-physical.ts';
import { unlockPhysicalDigest, unlockPhysicalIdentity } from './encrypted-unlock-physical.ts';
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
import {
  openVault,
  openVaultAsync,
  hashFile,
  type Vault,
  type VaultRecordStorage,
} from './vault-store.ts';
import { onboardingIdentity } from './profile-onboarding.ts';
import { validPersonIcon } from '../shared/person-icon.ts';
import {
  rebuildRecordDatabase,
  verifyRecordAuthorityHead,
  flushRecordDurability,
  type DurableRecordVersion,
} from './record-versions.ts';
import { rebindCopiedIntakeSourceText } from './intake-source-text.ts';
import { clearChatJournalCache } from './assistant-journal.ts';
import {
  clearIntakeBatchJournalCache,
  registerIntakeBatchPublication,
} from './intake-batch-journal.ts';
import {
  prepareProductionIntakeStateCopy,
  disposeIntakeStateCopyPlan,
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
  /** Fixed numeric cold/recovery work, distinct from current operation counters. */
  recoveryWork?: PreparedUnlock['work'] & {
    physicalWitnessEntries: number;
    physicalWitnessMetadataBytes: number;
    physicalCheckedEntries: number;
    mainVaultCheckpoints: number;
  };
  app: { server: Server; close(reason?: string): void } | null;
  requests: Set<ServerResponse>;
  closing: boolean;
  disposeOriginalResolver(): void;
  disposeBatchPublication(): void;
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
  readonlyAuthority?: boolean;
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
  signal?: AbortSignal;
  assertAuthorized?: () => void;
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
  /** Payload-free controlled host checkpoints for runtime qualification. */
  unlockCheckpoint?: (phase: 'preparation' | 'vault' | 'publication') => void;
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
  !name.endsWith('.pending') &&
  !name.endsWith('/writer.lock');
const workspaceSyncOptions = {
  exclude: (name: string) => !privateFile(name),
  // The queue writer supplies exact selected event/head names. Walking this
  // directory would both scale with history and adopt unselected crash tails.
  excludeDirectory: (name: string) => name === 'intake-batches',
};
const deferredOriginal = (name: string): boolean =>
  name.startsWith('sources/') || name.startsWith('attachments/');
export function createEncryptedProfiles({
  dataDirectory,
  runtimeDirectory,
  diagnostics = importDiagnostics,
  availableRuntimeBytes = () => runtimeCapacity(runtimeDirectory).reportedAvailableBytes,
  unlockCheckpoint,
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
  const registryRefusal = () => archiveRefusal('Archive registry', 'All profiles are unavailable.');
  let registry: ProfileRegistry;
  try {
    registry = registryStat
      ? (JSON.parse(readFileSync(registryPath, 'utf8')) as ProfileRegistry)
      : { format: 'circus-health-profiles-v1', revision: 0, profiles: [] };
  } catch {
    throw registryRefusal();
  }
  if (
    !registry ||
    registry.format !== 'circus-health-profiles-v1' ||
    !Array.isArray(registry.profiles) ||
    !Number.isSafeInteger(registry.revision) ||
    registry.revision < (registryStat ? 1 : 0) ||
    registry.profiles.some((p) => !p || !idValid(p.id) || typeof p.placebo !== 'boolean')
  )
    throw registryRefusal();
  if (new Set(registry.profiles.map((p) => p.id)).size !== registry.profiles.length)
    throw registryRefusal();
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
  const preparing = new Map<string, AbortController>();
  const copyDependents = new Map<string, Set<AbortController>>();
  const cancelCopies = (id: string) => {
    for (const attempt of copyDependents.get(id) ?? [])
      attempt.abort(Error('Copy source access changed'));
  };
  let registryPublished = !!registryStat;
  let registryIdentity = registryStat ? unlockPathIdentity(registryPath) : null;
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
    registryIdentity = unlockPathIdentity(registryPath);
  };
  const keyring = (id: string): ProfileKeyring => {
    const path = resolve(pathFor(id), 'keyring.json');
    try {
      const ring = JSON.parse(readFileSync(path, 'utf8')) as ProfileKeyring;
      verifyRing(id, ring);
      return ring;
    } catch {
      throw archiveRefusal('Profile keyring', 'This profile cannot be unlocked.');
    }
  };
  const writeKeyring = (id: string, value: ProfileKeyring): void => {
    preparing.get(id)?.abort(Error('Profile keyring changed'));
    cancelCopies(id);
    durableWrite(resolve(pathFor(id), 'keyring.json'), jsonBytes(value));
  };
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
  async function storageBytesAsync(path: string, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw Error('Profile storage cannot contain links');
    if (!stat.isDirectory()) return stat.size;
    let bytes = 0;
    for await (const entry of await opendir(path))
      bytes += await storageBytesAsync(resolve(path, entry.name), signal);
    return bytes;
  }
  function refreshCard(
    state: OpenedProfile,
    identity = selfIdentity(state.db) as {
      name: string;
      icon: string;
      nameVersion: number;
    },
  ): void {
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
    const wrapped = (value: WrappedKey | undefined): boolean =>
      value?.algorithm === 'xchacha20poly1305-ietf' &&
      typeof value.nonce === 'string' &&
      typeof value.ciphertext === 'string';
    if (
      !ring ||
      ring.format !== 'circus-health-keyring-v1' ||
      ring.profileId !== id ||
      typeof ring.active !== 'boolean' ||
      !wrapped(ring.recovery) ||
      !Array.isArray(ring.passkeys) ||
      ring.passkeys.some((passkey) => !passkey || !wrapped(passkey.wrapped))
    )
      throw archiveRefusal('Profile keyring', 'This profile cannot be unlocked.');
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
      readonlyAuthority = false,
    }: OpenOptions = {},
  ): OpenedProfile {
    if (preparing.has(id)) {
      key.fill(0);
      throw new HttpError(409, 'PROFILE_PREPARING', 'This profile is already opening');
    }
    if (opened.has(id)) {
      key.fill(0);
      return opened.get(id)!;
    }
    const started = performance.now(),
      directory = pathFor(id),
      root = resolve(runtime, id),
      workspace = resolve(root, 'data/profiles', id),
      dbPath = resolve(root, 'db/database.sqlite');
    const stage = <T>(phase: string, operation: () => T): T =>
      measureImportPhase(phase, operation, {}, { profileId: id }, diagnostics);
    // A previous process's runtime is never an authority.
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true, mode: 0o700 });
    ensureProfileDirectories(root, id);
    let vault: Vault;
    try {
      vault = stage('profile_vault_open', () =>
        openVault({ directory, profileId: id, key, initialize: initial }),
      );
    } catch (error) {
      key.fill(0);
      rmSync(root, { recursive: true, force: true });
      throw archiveRefusal(
        'Profile encrypted index or manifest',
        'This profile’s records and history are unavailable.',
      );
    }
    let db: Database | null | undefined;
    let disposeOriginalResolver = () => {};
    let disposeBatchPublication = () => {};
    try {
      if (readonlyAuthority && vault.recordStorage().read('head') === null)
        throw Error('Selected accepted record history is missing');
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
      stage('profile_workspace_materialize', () =>
        vault.materialize(workspace, { exclude: deferredOriginal }),
      );
      disposeBatchPublication = registerIntakeBatchPublication(root, id, (names) =>
        vault.trackWorkspaceFiles(workspace, names),
      );
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
      const recordStorage = vault.recordStorage(
        () => vault.syncWorkspace(workspace, { ...workspaceSyncOptions, publishNow: false }),
        workspace,
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
      const rebuildHistory = () => {
        try {
          return stage('profile_record_replay', () =>
            rebuildRecordDatabase(dbPath, {
              profileId: id,
              storage: recordStorage,
              verifyReferences,
            }),
          );
        } catch {
          throw archiveRefusal(
            'Profile accepted record history',
            'This profile’s records and history are unavailable.',
          );
        }
      };
      let cacheHit = false;
      if (initial) {
        if (copyState) {
          const intakePlan = prepareProductionIntakeStateCopy(copyState.db, copyState.id, id);
          let manualPlan: ReturnType<typeof prepareManualSourceCopy> | undefined;
          try {
            manualPlan = prepareManualSourceCopy(copyState.db, copyState.root, copyState.id, id);
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
                const publication = {
                  profileId: id,
                  readSelectedHead: () => recordStorage.read('head'),
                };
                stageIntakeStateCopy(copied, intakePlan, publication);
                stageManualSourceCopy(copied, manualPlan!, publication);
                validateProductionIntakeAuthority(copied, id);
              });
            } finally {
              copied.close();
            }
          } finally {
            if (manualPlan) disposeManualSourceCopyPlan(manualPlan);
            disposeIntakeStateCopyPlan(intakePlan);
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
        // Check the selected authority before trusting even a matching cache.
        // This reads one commit, not the growing history on every write.
        try {
          verifyRecordAuthorityHead(recordStorage, id, LATEST_SCHEMA_VERSION);
        } catch {
          throw archiveRefusal(
            'Profile accepted record history',
            'This profile’s records and history are unavailable.',
          );
        }
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
              clearPackageSourceSession(db);
              clearIntakeStateCache(db);
              clearIdentityGrounding(db);
              clearIntakeLookupCache(db);
              clearSourceContextClassificationCache(db);
              clearSourceTextProjectionCache(db);
              clearSourceDetailsSearchCache(db);
            }
            db?.close();
            db = null;
          }
        }
        if (!db) {
          for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
          rebuildHistory();
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
        stage('profile_intake_validation', () => validateProductionIntakeAuthority(db!, id));
        stage('profile_durability_attach', () =>
          (attachPersonalDurability as unknown as AttachVaultDurability)(db!, {
            root,
            profileId: id,
            recordStorage,
            verifyReferences,
          }),
        );
      } catch (error) {
        if (!cacheHit) {
          if (initial) throw error;
          throw archiveRefusal(
            'Profile accepted record history',
            'This profile’s records and history are unavailable.',
          );
        }
        clearPackageSourceSession(db);
        clearIntakeStateCache(db);
        clearIdentityGrounding(db);
        clearIntakeLookupCache(db);
        clearSourceContextClassificationCache(db);
        clearSourceTextProjectionCache(db);
        clearSourceDetailsSearchCache(db);
        db.close();
        for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
        rebuildHistory();
        db = openDatabase(dbPath, id);
        stage('profile_intake_validation', () => validateProductionIntakeAuthority(db!, id));
        stage('profile_durability_attach', () =>
          (attachPersonalDurability as unknown as AttachVaultDurability)(db!, {
            root,
            profileId: id,
            recordStorage,
            verifyReferences,
          }),
        );
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
        disposeBatchPublication,
      };
      if (!pendingActivation) stage('profile_runtime_install', () => installOpened(state));
      return state;
    } catch (e) {
      discardFailedOpen(
        { id, root, key, vault, db, disposeOriginalResolver, disposeBatchPublication },
        e,
      );
    }
  }
  function installOpened(state: OpenedProfile): void {
    registerProfileDisplayGuard(state.db, (name, icon) =>
      requireDistinctProfile(name, icon, state.id),
    );
    refreshCard(state);
    opened.set(state.id, state);
    attachOpenedDiagnostics(state);
  }
  function attachOpenedDiagnostics(state: OpenedProfile, checkpoint?: () => void): void {
    diagnostics.attachSummaryStore(state.id, {
      read: () => state.vault.readPerformanceSummary(),
      write: (bytes) => state.vault.writePerformanceSummary(bytes),
    });
    checkpoint?.();
    diagnostics.attachEventStore(state.id, state.vault.diagnosticChunks());
    checkpoint?.();
  }
  function discardFailedOpen(
    state: Pick<
      OpenedProfile,
      'id' | 'root' | 'key' | 'vault' | 'disposeOriginalResolver' | 'disposeBatchPublication'
    > & {
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
    cleanup(() => clearIntakeBatchJournalCache(state.root, state.id));
    if (state.db) {
      const db = state.db;
      cleanup(() => clearPackageSourceSession(db));
      cleanup(() => clearIntakeStateCache(db));
      cleanup(() => clearIdentityGrounding(db));
      cleanup(() => clearIntakeLookupCache(db));
      cleanup(() => clearSourceContextClassificationCache(db));
      cleanup(() => clearSourceTextProjectionCache(db));
      cleanup(() => clearSourceDetailsSearchCache(db));
      cleanup(() => {
        if (db.isOpen) db.close();
      });
    }
    cleanup(() => state.disposeOriginalResolver());
    cleanup(() => state.disposeBatchPublication());
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
  async function setupWorker<T>(
    id: string,
    key: VaultKey,
    authority: UnlockAuthorityWitness,
    controller: AbortController,
    witnessDirectory: string,
    setup: object,
    checkpoint: () => void,
    sourceKey?: VaultKey,
  ): Promise<T> {
    return prepareEncryptedUnlock<T>(
      {
        dataDirectory: data,
        runtimeDirectory: runtime,
        profileId: id,
        key,
        authority,
        signal: controller.signal,
        availableRuntimeBytes: availableRuntimeBytes(),
        witnessDirectory,
        checkpoint,
      },
      (workerData, transferList) => {
        const sourceCopy = sourceKey ? Uint8Array.from(sourceKey) : undefined;
        try {
          return new Worker(new URL('./encrypted-setup-worker.ts', import.meta.url), {
            workerData: { ...(workerData as object), setup: { ...setup, sourceKey: sourceCopy } },
            transferList: sourceCopy ? [...transferList, sourceCopy.buffer] : transferList,
          });
        } catch (error) {
          sourceCopy?.fill(0);
          throw error;
        }
      },
    );
  }
  interface InspectedSetup {
    details: SetupDetails;
    published: boolean;
    physicalWitness: UnlockPhysicalWitness;
  }
  async function verifyAsync(
    setupId: string,
    input: VerifyInput,
    { signal, assertAuthorized, authorizeCopySource }: VerifyOptions = {},
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
    if (registry.profiles.some((p) => p.id === setup.id))
      return unlockWithKeyAsync(setup.id, secretKey(setup.id, input.recovery), {
        signal,
        assertAuthorized: () => {
          assertAuthorized?.();
          if (setups.get(setupId) !== setup || setup.expires < Date.now())
            throw Error('Setup access changed');
        },
      });
    const id = setup.id,
      key = secretKey(id, input.recovery),
      controller = new AbortController();
    if (preparing.has(id)) {
      key.fill(0);
      throw new HttpError(409, 'PROFILE_PREPARING', 'This profile is already opening');
    }
    preparing.set(id, controller);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let stageData: string | undefined;
    let witnessDirectory: string | undefined,
      source: OpenedProfile | undefined,
      sourceAuthority: UnlockAuthorityWitness | undefined,
      sourceHead: string | undefined;
    let adopted = false,
      sourcePhysicalWitness: UnlockPhysicalWitness | undefined;
    try {
      if (!registryPublished) writeRegistry();
      let authority = unlockAuthorityWitness(pathFor(id));
      const check = () => {
        controller.signal.throwIfAborted();
        assertAuthorized?.();
        if (
          preparing.get(id) !== controller ||
          setups.get(setupId) !== setup ||
          setup.expires < Date.now() ||
          registry.profiles.some((p) => p.id === id) ||
          unlockPathIdentity(registryPath) !== registryIdentity
        )
          throw Error('Setup access changed');
        assertUnlockAuthority(pathFor(id), authority);
        if (source) {
          authorizeCopySource?.(source.id);
          if (
            opened.get(source.id) !== source ||
            source.closing ||
            source.recordStorage.read('head')?.toString('utf8') !== sourceHead
          )
            throw Error('Copy source changed');
          assertUnlockAuthority(pathFor(source.id), sourceAuthority!);
          flushRecordDurability(source.db);
        }
      };
      check();
      witnessDirectory = await mkdtemp(resolve(runtime, '.unlock-physical-'));
      const inspected = await setupWorker<InspectedSetup>(
        id,
        key,
        authority,
        controller,
        witnessDirectory,
        { task: 'inspect' },
        check,
      );
      check();
      const details = inspected.details;
      if (details.profileId !== id || typeof details.name !== 'string' || !details.name.trim())
        throw new HttpError(400, 'SETUP_INVALID', 'This recovery file could not resume setup');
      requireDistinctProfile(details.name, details.icon || 'person', id);
      let physicalWitness = inspected.physicalWitness;
      if (!inspected.published) {
        if (details.copyFrom) {
          authorizeCopySource?.(details.copyFrom);
          source = opened.get(details.copyFrom);
          if (!source || source.closing)
            throw new HttpError(
              423,
              'PROFILE_LOCKED',
              'Unlock the original profile before completing its copy',
            );
          flushRecordDurability(source.db);
          sourceAuthority = unlockAuthorityWitness(pathFor(source.id));
          sourceHead = source.recordStorage.read('head')?.toString('utf8');
          if (!sourceHead) throw Error('Copy source history missing');
          let dependents = copyDependents.get(source.id);
          if (!dependents) copyDependents.set(source.id, (dependents = new Set()));
          dependents.add(controller);
        }
        // Ciphertext staging shares the archive filesystem so immutable moves
        // and the selected-manifest transition remain atomic across mounts.
        stageData = resolve(pathFor(id), `.setup-stage-${randomUUID()}`);
        mkdirSync(stageData, { mode: 0o700 });
        check();
        const staged = await setupWorker<{
          physicalWitness: UnlockPhysicalWitness;
          sourcePhysicalWitness?: UnlockPhysicalWitness;
          manifestPath: string;
          manifestIdentity: string;
          manifestDigest: string;
          originalRootIdentity: string;
          selectedHead: string;
        }>(
          id,
          key,
          authority,
          controller,
          witnessDirectory,
          {
            task: 'prepare',
            physicalWitness,
            details,
            stageData,
            sourceId: source?.id,
            sourceAuthority,
            sourceHead,
          },
          check,
          source?.key,
        );
        sourcePhysicalWitness = staged.sourcePhysicalWitness;
        check();
        unlockCheckpoint?.('publication');
        check();
        const physicalEpoch = captureManagedPhysicalEpoch();
        if (!physicalEpoch) throw Error('Setup physical evidence is being changed');
        const verifyPhysical = async (
          profileId: string,
          witness: UnlockPhysicalWitness,
          witnessName: string,
        ) => {
          const result = await prepareEncryptedUnlock<{ checked: number }>(
            {
              dataDirectory: data,
              runtimeDirectory: runtime,
              profileId,
              key: Buffer.alloc(32),
              authority,
              signal: controller.signal,
              availableRuntimeBytes: null,
              witnessDirectory,
            },
            (workerData, transferList) =>
              new Worker(new URL('./encrypted-unlock-physical-worker.ts', import.meta.url), {
                workerData: { ...(workerData as object), physicalWitness: witness, witnessName },
                transferList,
              }),
          );
          if (result.checked !== witness.entries) throw Error('Setup physical evidence changed');
        };
        await verifyPhysical(id, staged.physicalWitness, 'physical.sqlite');
        if (source) await verifyPhysical(source.id, staged.sourcePhysicalWitness!, 'source.sqlite');
        check();
        if (
          !managedPhysicalEpochCurrent(physicalEpoch) ||
          unlockPhysicalIdentity(resolve(pathFor(id), 'vault')).value !==
            staged.originalRootIdentity ||
          unlockPhysicalIdentity(staged.manifestPath).value !== staged.manifestIdentity ||
          unlockPhysicalDigest(staged.manifestPath) !== staged.manifestDigest
        )
          throw Error('Setup physical evidence changed');
        // Immutable additions are unselected until this single durable authority
        // transition. A crash afterward resumes the accepted, inactive profile.
        withManagedPhysicalMutation(() => {
          renameSync(staged.manifestPath, resolve(pathFor(id), 'vault/manifest.enc'));
          const fd = openSync(resolve(pathFor(id), 'vault'), 'r');
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        });
        const ownedRootIdentity = unlockPhysicalIdentity(resolve(pathFor(id), 'vault')).value;
        if (
          ownedRootIdentity.split(':').slice(0, 2).join(':') !==
          staged.originalRootIdentity.split(':').slice(0, 2).join(':')
        )
          throw Error('Setup publication changed');
        const publishedManifestIdentity = unlockPhysicalIdentity(
          resolve(pathFor(id), 'vault/manifest.enc'),
        ).value;
        if (
          publishedManifestIdentity.split(':').slice(0, 4).join(':') !==
          staged.manifestIdentity.split(':').slice(0, 4).join(':')
        )
          throw Error('Setup publication changed');
        authority = unlockAuthorityWitness(pathFor(id));
        if (!authority.manifest.endsWith(`:${staged.manifestDigest}`))
          throw Error('Setup publication changed');
        const finished = await setupWorker<{ physicalWitness: UnlockPhysicalWitness }>(
          id,
          key,
          authority,
          controller,
          witnessDirectory,
          {
            task: 'finish',
            physicalWitness: staged.physicalWitness,
            manifestIdentity: publishedManifestIdentity,
            ownedRootIdentity,
          },
          check,
        );
        physicalWitness = finished.physicalWitness;
        await removeRuntime(stageData, { recursive: true, force: true });
        stageData = undefined;
      }
      check();
      const pendingEntry = {
        id,
        name: details.name,
        icon: details.icon || 'person',
        placebo: details.placebo,
        nameVersion: 1,
        version: 1,
      };
      const result = await unlockWithKeyAsync(
        id,
        key,
        { signal: controller.signal, assertAuthorized: check },
        {
          entry: pendingEntry,
          authority,
          physicalWitness,
          witnessDirectory,
          controller,
          async terminalVerification() {
            if (!source) return;
            const result = await prepareEncryptedUnlock<{ checked: number }>(
              {
                dataDirectory: data,
                runtimeDirectory: runtime,
                profileId: source.id,
                key: Buffer.alloc(32),
                authority: sourceAuthority!,
                signal: controller.signal,
                availableRuntimeBytes: null,
                witnessDirectory,
              },
              (workerData, transferList) =>
                new Worker(new URL('./encrypted-unlock-physical-worker.ts', import.meta.url), {
                  workerData: {
                    ...(workerData as object),
                    physicalWitness: sourcePhysicalWitness,
                    witnessName: 'source.sqlite',
                  },
                  transferList,
                }),
            );
            if (result.checked !== sourcePhysicalWitness!.entries)
              throw Error('Copy source physical evidence changed');
          },
          commit() {
            const ring = keyring(id);
            ring.active = true;
            durableWrite(resolve(pathFor(id), 'keyring.json'), jsonBytes(ring));
            writeRegistry({ ...registry, profiles: [...registry.profiles, pendingEntry] });
          },
        },
      );
      adopted = true;
      return result;
    } finally {
      if (!adopted) key.fill(0);
      if (source) {
        const dependents = copyDependents.get(source.id);
        dependents?.delete(controller);
        if (!dependents?.size) copyDependents.delete(source.id);
      }
      if (preparing.get(id) === controller) preparing.delete(id);
      signal?.removeEventListener('abort', abort);
      if (stageData) await removeRuntime(stageData, { recursive: true, force: true });
      if (witnessDirectory) await removeRuntime(witnessDirectory, { recursive: true, force: true });
    }
  }
  function unlock(id: string, recovery: unknown) {
    card(id);
    const key = secretKey(id, recovery);
    const state = open(id, key);
    return { ...card(id), metrics: state.metrics };
  }
  async function unlockWithKeyAsync(
    id: string,
    key: VaultKey,
    { signal, assertAuthorized }: { signal?: AbortSignal; assertAuthorized?: () => void } = {},
    activation?: {
      entry: ProfileRegistry['profiles'][number];
      authority: UnlockAuthorityWitness;
      physicalWitness: UnlockPhysicalWitness;
      witnessDirectory: string;
      controller: AbortController;
      terminalVerification?(): Promise<void>;
      commit(): void;
    },
  ) {
    const entry = activation?.entry ?? registry.profiles.find((profile) => profile.id === id);
    if (!entry) {
      key.fill(0);
      throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Profile not found');
    }
    if (opened.has(id)) {
      key.fill(0);
      signal?.throwIfAborted();
      assertAuthorized?.();
      const state = opened.get(id)!;
      const storageBytes = await storageBytesAsync(pathFor(id), signal);
      signal?.throwIfAborted();
      assertAuthorized?.();
      if (opened.get(id) !== state || state.closing)
        throw new HttpError(423, 'PROFILE_LOCKED', 'Profile access changed');
      return {
        ...registry.profiles.find((p) => p.id === id)!,
        locked: false,
        storageBytes,
        metrics: state.metrics,
      };
    }
    if (preparing.has(id) && preparing.get(id) !== activation?.controller) {
      key.fill(0);
      throw new HttpError(409, 'PROFILE_PREPARING', 'This profile is already opening');
    }
    let directory: string;
    try {
      directory = pathFor(id);
    } catch (error) {
      key.fill(0);
      throw error;
    }
    const controller = activation?.controller ?? new AbortController();
    preparing.set(id, controller);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const root = resolve(runtime, id),
      workspace = resolve(root, 'data/profiles', id),
      dbPath = resolve(root, 'db/database.sqlite');
    let vault: Vault | undefined;
    let db: Database | undefined;
    let disposeOriginalResolver = () => {};
    let disposeBatchPublication = () => {};
    let installed = false;
    let diagnosticsPrepared = false;
    let witnessDirectory: string | undefined;
    try {
      const authority = activation?.authority ?? unlockAuthorityWitness(directory);
      const entryCurrent = () =>
        activation
          ? !registry.profiles.some((p) => p.id === id)
          : registry.profiles.find((p) => p.id === id) === entry;
      const checkpoint = (phase: 'preparation' | 'vault' | 'publication' = 'preparation') => {
        controller.signal.throwIfAborted();
        if (
          preparing.get(id) !== controller ||
          !entryCurrent() ||
          registryIdentity === null ||
          unlockPathIdentity(registryPath) !== registryIdentity
        )
          throw Error('Encrypted profile preparation changed');
        assertAuthorized?.();
        assertUnlockAuthority(directory, authority);
        unlockCheckpoint?.(phase);
        controller.signal.throwIfAborted();
        if (!entryCurrent() || unlockPathIdentity(registryPath) !== registryIdentity)
          throw Error('Encrypted profile preparation changed');
        assertAuthorized?.();
        assertUnlockAuthority(directory, authority);
      };
      checkpoint();
      witnessDirectory =
        activation?.witnessDirectory ?? (await mkdtemp(resolve(runtime, '.unlock-physical-')));
      checkpoint();
      const prepared = await prepareEncryptedUnlock({
        dataDirectory: data,
        runtimeDirectory: runtime,
        profileId: id,
        key,
        authority,
        signal: controller.signal,
        availableRuntimeBytes: availableRuntimeBytes(),
        checkpoint,
        witnessDirectory,
        physicalWitness: activation?.physicalWitness,
      });
      checkpoint();
      let mainVaultCheckpoints = 0;
      const preparedCheckpoint = () => {
        mainVaultCheckpoints++;
        checkpoint('vault');
        if (
          unlockPathIdentity(root, true) !== prepared.rootIdentity ||
          unlockPathIdentity(dbPath) !== prepared.databaseIdentity
        )
          throw Error('Encrypted profile preparation changed');
      };
      vault = await openVaultAsync({ directory, profileId: id, key }, preparedCheckpoint);
      preparedCheckpoint();
      const recordStorage = vault.recordStorage(
        () => vault!.syncWorkspace(workspace, { ...workspaceSyncOptions, publishNow: false }),
        workspace,
      );
      if (recordStorage.read('head')?.toString('utf8') !== prepared.selectedHead)
        throw Error('Encrypted profile preparation changed');
      db = openDatabase(dbPath, id);
      const indexed = db.prepare('SELECT head_json FROM __record_state WHERE singleton=1').get();
      const selected = JSON.parse(prepared.selectedHead) as unknown;
      if (
        !indexed ||
        JSON.stringify(JSON.parse(String(indexed.head_json))) !== JSON.stringify(selected)
      )
        throw Error('Prepared projection does not match selected history');
      const verifyReferences = (versions: RecordVersion[]) => {
        for (const version of versions) {
          if (version.deleted) continue;
          const row = version.contents;
          const path = (
            version.entity === 'source_files'
              ? row.path
              : version.entity === 'assets'
                ? row.stored_path
                : null
          ) as string | null;
          if (!path) continue;
          const prefix = `data/profiles/${id}/`;
          if (
            !path.startsWith(prefix) ||
            path.includes('\\') ||
            path.split('/').some((part) => part === '.' || part === '..')
          )
            throw Error('Original reference escaped its profile');
          const target = resolve(root, path);
          if (existsSync(target)) {
            if (
              realpathSync(target) !== target ||
              statSync(target).size !== row.bytes ||
              hashFile(target) !== row.sha256
            )
              throw Error('Original evidence is missing or changed');
          } else if (
            !vault!.verifyFile(path.slice(prefix.length), Number(row.bytes), String(row.sha256))
          )
            throw Error('Original evidence is missing or changed');
        }
      };
      (attachPersonalDurability as unknown as AttachVaultDurability)(db, {
        root,
        profileId: id,
        recordStorage,
        verifyReferences,
      });
      disposeBatchPublication = registerIntakeBatchPublication(root, id, (names) =>
        vault!.trackWorkspaceFiles(workspace, names),
      );
      disposeOriginalResolver = registerProfileOriginalResolver(root, id, (path) => {
        const name = path.slice(`data/profiles/${id}/`.length);
        const object = vault!.fileMetadata(name);
        if (!object)
          throw new HttpError(
            404,
            'MISSING_FILE',
            'The original file is missing from the encrypted archive',
          );
        requireRuntime(object.bytes, 'ORIGINAL_RUNTIME_CAPACITY', 'to open this retained original');
        if (!vault!.materializeFile(name, workspace))
          throw new HttpError(
            404,
            'MISSING_FILE',
            'The original file is missing from the encrypted archive',
          );
      });
      const state: OpenedProfile = {
        id,
        key,
        vault,
        root,
        workspace,
        db,
        recordStorage,
        metrics: prepared.metrics,
        recoveryWork: {
          ...prepared.work,
          physicalWitnessEntries: prepared.physicalWitness.entries,
          physicalWitnessMetadataBytes: prepared.physicalWitness.metadataBytes,
          physicalCheckedEntries: 0,
          mainVaultCheckpoints,
        },
        app: null,
        requests: new Set(),
        closing: false,
        disposeOriginalResolver,
        disposeBatchPublication,
      };
      const identity = selfIdentity(db) as { name: string; icon: string; nameVersion: number };
      registerProfileDisplayGuard(db, (name, icon) => requireDistinctProfile(name, icon, id));
      // Injectable installation effects run while the target remains private;
      // terminal validation and cancellation checks follow every callback.
      const attachedDatabaseIdentity = unlockPathIdentity(dbPath);
      const dataVersion = db.prepare('PRAGMA data_version').get()!.data_version;
      const walIdentity = () =>
        existsSync(dbPath + '-wal') ? unlockPathIdentity(dbPath + '-wal') : null;
      const attachedWalIdentity = walIdentity();
      diagnosticsPrepared = true;
      attachOpenedDiagnostics(state, () => {
        checkpoint();
        if (
          unlockPathIdentity(root, true) !== prepared.rootIdentity ||
          unlockPathIdentity(dbPath) !== attachedDatabaseIdentity ||
          walIdentity() !== attachedWalIdentity ||
          db!.prepare('PRAGMA data_version').get()!.data_version !== dataVersion
        )
          throw Error('Encrypted profile preparation changed');
      });
      checkpoint('publication');
      const physicalEpoch = captureManagedPhysicalEpoch();
      if (!physicalEpoch) throw Error('Encrypted profile physical evidence is being changed');
      const checked = await prepareEncryptedUnlock<{ checked: number }>(
        {
          dataDirectory: data,
          runtimeDirectory: runtime,
          profileId: id,
          // Physical verification needs no profile decryption key.
          key: Buffer.alloc(32),
          authority,
          signal: controller.signal,
          availableRuntimeBytes: null,
          witnessDirectory,
        },
        (workerData, transferList) =>
          new Worker(new URL('./encrypted-unlock-physical-worker.ts', import.meta.url), {
            workerData: { ...(workerData as object), physicalWitness: prepared.physicalWitness },
            transferList,
          }),
      );
      if (checked.checked !== prepared.physicalWitness.entries)
        throw Error('Encrypted profile physical evidence changed');
      await activation?.terminalVerification?.();
      await removeRuntime(witnessDirectory, { recursive: true, force: true });
      witnessDirectory = undefined;
      assertAuthorized?.();
      // No callbacks or await after this closing seal. Opening the prepared DB
      // may change its timestamps, but never its original file identity.
      controller.signal.throwIfAborted();
      if (
        preparing.get(id) !== controller ||
        !entryCurrent() ||
        unlockPathIdentity(registryPath) !== registryIdentity ||
        !managedPhysicalEpochCurrent(physicalEpoch)
      )
        throw Error('Encrypted profile preparation changed');
      assertUnlockAuthority(directory, authority);
      if (
        unlockPathIdentity(root, true) !== prepared.rootIdentity ||
        unlockPathIdentity(dbPath) !== attachedDatabaseIdentity ||
        attachedDatabaseIdentity.split(':').slice(0, 2).join(':') !==
          prepared.databaseIdentity.split(':').slice(0, 2).join(':') ||
        walIdentity() !== attachedWalIdentity ||
        db.prepare('PRAGMA data_version').get()!.data_version !== dataVersion ||
        recordStorage.read('head')?.toString('utf8') !== prepared.selectedHead ||
        JSON.stringify(
          JSON.parse(
            String(
              db.prepare('SELECT head_json FROM __record_state WHERE singleton=1').get()?.head_json,
            ),
          ),
        ) !== JSON.stringify(selected)
      )
        throw Error('Encrypted profile preparation changed');
      state.recoveryWork!.physicalCheckedEntries = checked.checked;
      activation?.commit();
      refreshCard(state, identity);
      opened.set(id, state);
      installed = true;
      return {
        ...registry.profiles.find((p) => p.id === id)!,
        locked: false,
        storageBytes: prepared.storageBytes,
        metrics: prepared.metrics,
      };
    } catch (error) {
      const errors = [error];
      const cleanup = (operation: () => void) => {
        try {
          operation();
        } catch (failure) {
          errors.push(failure);
        }
      };
      const partial = opened.get(id);
      if (partial?.key === key) {
        opened.delete(id);
      }
      cleanup(disposeOriginalResolver);
      cleanup(disposeBatchPublication);
      if (db?.isOpen) cleanup(() => db!.close());
      cleanup(() => vault?.close());
      key.fill(0);
      if (diagnosticsPrepared) cleanup(() => diagnostics.detachSummaryStore(id));
      try {
        await removeRuntime(root, { recursive: true, force: true });
      } catch (failure) {
        errors.push(failure);
      }
      if (witnessDirectory) {
        try {
          await removeRuntime(witnessDirectory, { recursive: true, force: true });
        } catch (failure) {
          errors.push(failure);
        }
      }
      if (errors.length > 1)
        throw new AggregateError(errors, 'Encrypted profile opening failed during cleanup');
      throw error;
    } finally {
      if (!installed) key.fill(0);
      if (preparing.get(id) === controller) preparing.delete(id);
      signal?.removeEventListener('abort', abort);
    }
  }
  function flush(id: string, { duringLock = false }: { duringLock?: boolean } = {}): void {
    const state = opened.get(id);
    if (!state || (state.closing && !duringLock))
      throw new HttpError(423, 'PROFILE_LOCKED', 'Unlock this profile');
    measureImportPhase(
      'encrypted_workspace_flush',
      () => {
        state.vault.syncWorkspace(state.workspace, workspaceSyncOptions);
        refreshCard(state);
      },
      {},
      { profileId: id },
      diagnostics,
    );
  }
  function lock(id: string) {
    cancelCopies(id);
    preparing.get(id)?.abort(new HttpError(423, 'PROFILE_LOCKED', 'Profile opening was cancelled'));
    const state = opened.get(id);
    if (!state) return card(id);
    state.closing = true;
    for (const response of state.requests) response.destroy();
    try {
      state.app?.close('profile_locked');
      if (!state.app) state.db.close();
      state.vault.syncWorkspace(state.workspace, workspaceSyncOptions);
      state.vault.writeCache(resolve(state.root, 'db/database.sqlite'), {
        schemaVersion: LATEST_SCHEMA_VERSION,
      });
    } finally {
      clearPackageSourceSession(state.db);
      clearIntakeStateCache(state.db);
      clearIdentityGrounding(state.db);
      clearIntakeLookupCache(state.db);
      clearSourceContextClassificationCache(state.db);
      clearSourceTextProjectionCache(state.db);
      clearSourceDetailsSearchCache(state.db);
      clearChatJournalCache(state.root, id);
      clearIntakeBatchJournalCache(state.root, id);
      state.disposeOriginalResolver();
      state.disposeBatchPublication();
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
  async function resumeAsync(
    recovery: unknown,
    { signal, assertAuthorized }: { signal?: AbortSignal; assertAuthorized?: () => void } = {},
  ) {
    const id = (recovery as Partial<RecoveryKit> | null)?.profileId;
    if (!idValid(id))
      throw new HttpError(
        400,
        'RECOVERY_FILE',
        'Use the downloaded recovery file to resume interrupted setup',
      );
    const key = secretKey(id, recovery),
      entry = registry.profiles.find((p) => p.id === id);
    if (entry) {
      key.fill(0);
      signal?.throwIfAborted();
      assertAuthorized?.();
      return { profileId: id, active: true, name: entry.name };
    }
    if (preparing.has(id)) {
      key.fill(0);
      throw new HttpError(409, 'PROFILE_PREPARING', 'This profile is already opening');
    }
    const controller = new AbortController(),
      abort = () => controller.abort(signal?.reason);
    preparing.set(id, controller);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let witnessDirectory: string | undefined;
    try {
      const authority = unlockAuthorityWitness(pathFor(id));
      const check = () => {
        controller.signal.throwIfAborted();
        assertAuthorized?.();
        if (preparing.get(id) !== controller || registry.profiles.some((p) => p.id === id))
          throw Error('Setup access changed');
        assertUnlockAuthority(pathFor(id), authority);
      };
      check();
      witnessDirectory = await mkdtemp(resolve(runtime, '.unlock-physical-'));
      check();
      const inspected = await setupWorker<InspectedSetup>(
        id,
        key,
        authority,
        controller,
        witnessDirectory,
        { task: 'inspect' },
        check,
      );
      check();
      if (
        inspected.details.profileId !== id ||
        typeof inspected.details.name !== 'string' ||
        !inspected.details.name.trim()
      )
        throw new HttpError(400, 'SETUP_INVALID', 'This recovery file could not resume setup');
      const setupId = randomBytes(32).toString('base64url');
      setups.set(setupId, { id, expires: Date.now() + 30 * 60 * 1000 });
      return { setupId, profileId: id, active: false, name: inspected.details.name };
    } finally {
      key.fill(0);
      if (preparing.get(id) === controller) preparing.delete(id);
      signal?.removeEventListener('abort', abort);
      if (witnessDirectory) await removeRuntime(witnessDirectory, { recursive: true, force: true });
    }
  }
  return {
    begin,
    resume,
    resumeAsync,
    verify,
    verifyAsync,
    unlock,
    unlockAsync(id: string, recovery: unknown, options?: Parameters<typeof unlockWithKeyAsync>[2]) {
      return unlockWithKeyAsync(id, secretKey(id, recovery), options);
    },
    unlockWithKeyAsync,
    prepareUnlockWithKey(id: string, key: VaultKey) {
      return open(id, key, { pendingActivation: true, readonlyAuthority: true });
    },
    prepareSetupWithKey(
      id: string,
      key: VaultKey,
      details: SetupDetails,
      copyState?: OpenedProfile,
    ) {
      return open(id, key, { ...details, initial: true, copyState, pendingActivation: true });
    },
    preparationStorageBytes(id: string) {
      return bytesBelow(pathFor(id));
    },
    assertProfileExists(id: string) {
      if (!registry.profiles.some((profile) => profile.id === id))
        throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Profile not found');
    },
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
      for (const attempt of preparing.values()) attempt.abort(Error('Application is stopping'));
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
