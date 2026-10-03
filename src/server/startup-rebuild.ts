import { readProfileRegistry, recoverProfileDeletions } from './profile-registry.ts';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  statfsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BinaryLike } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { REPO_ROOT, LATEST_SCHEMA_VERSION, openDatabase } from './database.ts';
import { hasContributorAuthority } from './contributor-record-storage.ts';
import { rebuildContributorDatabase, selectedContributorHead } from './contributor-durability.ts';
import { profilePaths, profileOriginal } from './profile-storage.ts';
import {
  loadPortable,
  recoverPendingProfile,
  projectPortableDatabase,
  durableWrite,
  syncDirectory,
  publishedPersonalLineage,
  logicalDatabaseHash,
} from './portable.ts';
import { listChats } from './assistant-journal.ts';

export interface GenerationManifest {
  format: 'circus-health-generation-v1';
  profileId: string;
  kind: 'personal' | 'curation';
  revision: number;
  file: string;
  sha256: string;
  bytes: number;
}

interface PortableGeneration {
  manifest: GenerationManifest;
  value: {
    revision: number;
    createdAt: string;
    tables: Record<string, Array<Record<string, unknown>>>;
  };
}

export interface MappingVersion {
  sha256: string;
  files: number;
  bytes: number;
}

export interface ProfileInputPins {
  personal: GenerationManifest;
  curation: GenerationManifest;
  mappings: MappingVersion;
}

interface OriginalMetadata {
  path: string;
  sha256: string;
  bytes: number;
}

interface LoadedPortable {
  personal: PortableGeneration;
  curation: PortableGeneration;
  rows: Record<string, Array<Record<string, unknown>>> & {
    source_records: Array<Record<string, unknown>>;
  };
  originals: Map<string, OriginalMetadata>;
}

interface ProjectionResult {
  database: string;
  profileId: string;
  revision: number;
  schemaVersion: number;
  files: number;
  counts: Record<string, number>;
  logicalSha256: string;
  databaseBytes: number;
}

export interface StartupProgress {
  ready: false;
  outcome: 'starting' | 'validated' | 'failure';
  phase: string;
  profileId?: string | null;
  elapsedMs: number;
}

export interface StartupProfileMetric {
  profileId: string;
  outcome: 'starting' | 'success' | 'failure';
  phases: Record<string, number>;
  totalMs?: number;
  personal?: GenerationManifest;
  curation?: GenerationManifest;
  recordHead?: string;
  mappings?: MappingVersion;
  acceptedSourcesSha256?: string;
  inputBytes?: number;
  inputRecords?: number;
  sourceRecords?: number;
  originalFiles?: number;
  historyGenerations?: number;
  chats?: number;
  counts?: Record<string, number>;
  databaseBytes?: number;
  logicalSha256?: string;
  peakMemoryBytes?: number;
}

export interface StartupVersions {
  schemaVersion: number;
  schemaSha256: string;
  buildSha256: string;
}

export interface StartupReceipt extends StartupVersions {
  format: 'health-startup-metrics-v1';
  id: string;
  startedAt: string;
  outcome: 'starting' | 'success' | 'failure';
  profiles: StartupProfileMetric[];
  totalMs: number;
  rebuildMs?: number;
  openMs?: number;
  peakMemoryBytes: number;
  failedProfileId?: string | null;
  failedPhase?: string;
  failureCode?: 'STARTUP_OPEN_FAILED' | 'STARTUP_VALIDATION_FAILED';
}

export interface RebuildStartupOptions {
  dataDirectory?: string;
  runtimeDirectory?: string;
  codeRoot?: string;
  profileIds?: string[];
  progress?: (progress: StartupProgress) => void;
  historyLimit?: number;
}

export interface RebuildStartupResult {
  root: string;
  receipt: StartupReceipt;
  databases: Array<[string, string]>;
}

type LoadPortable = (root: string, profileId: string, pins: ProfileInputPins) => LoadedPortable;
type PersonalLineage = (
  root: string,
  profileId: string,
  options: { manifest: GenerationManifest },
) => Iterable<PortableGeneration>;
type ProjectPortable = (
  database: string,
  profileId: string,
  portable: LoadedPortable,
  options: { phase: (name: string) => void },
) => ProjectionResult;

const hash = (bytes: BinaryLike): string => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function validateRuntimeDirectory(runtimeDirectory?: string): void {
  // Filesystem type numbers are platform-specific. Native non-Linux runs are
  // contributor checks, outside the supported deployment's tmpfs guarantee.
  if (process.platform !== 'linux') return;
  const requirement = 'CRS_RUNTIME_DIR must be an existing absolute directory on a tmpfs';
  try {
    if (
      !runtimeDirectory ||
      !isAbsolute(runtimeDirectory) ||
      !statSync(runtimeDirectory).isDirectory() ||
      statfsSync(runtimeDirectory).type !== 0x01021994
    )
      throw new Error(requirement);
  } catch (cause) {
    throw new Error(requirement, { cause });
  }
}

export function validateDataDirectory(
  dataDirectory?: string,
  profileIds?: readonly string[] | null,
): string {
  if (
    !dataDirectory ||
    !isAbsolute(dataDirectory) ||
    !existsSync(dataDirectory) ||
    !statSync(dataDirectory).isDirectory()
  )
    throw new Error('CRS_DATA_DIR must be an existing absolute durable data directory');
  // Docker mounts any operator directory at this stable internal path, keeping
  // archived data/profiles/... references independent of host/code locations.
  if (basename(dataDirectory) !== 'data')
    throw new Error('Runtime CRS_DATA_DIR must be mounted as <archive-root>/data');
  const root = dirname(realpathSync(dataDirectory));
  for (const profileId of profileIds ||
    readProfileRegistry(root).profiles.map((p: { id: string }) => p.id)) {
    const paths = profilePaths(root, profileId);
    if (hasContributorAuthority(root, profileId)) {
      selectedContributorHead(root, profileId);
      continue;
    }
    for (const kind of ['personal', 'curation'] as const)
      if (!existsSync(resolve(paths[kind], 'current.json')))
        throw new Error(
          `Missing ${profileId} ${kind} generation; restore durable data before startup`,
        );
    if (realpathSync(paths.root) !== paths.root)
      throw new Error('Profile directories must not be symbolic links');
  }
  return root;
}
function filesBelow(directory: string, accept: (path: string) => boolean = () => true): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error('Versioned startup inputs cannot contain symbolic links');
    if (entry.isDirectory()) files.push(...filesBelow(path, accept));
    else if (entry.isFile() && accept(path)) files.push(path);
  }
  return files;
}
function inventoryHash(directory: string, files: string[]): string {
  return hash(
    JSON.stringify(
      files.map((path) => [
        relative(directory, path),
        statSync(path).size,
        hash(readFileSync(path)),
      ]),
    ),
  );
}
export function startupVersions(codeRoot = REPO_ROOT): StartupVersions {
  const migrations = resolve(codeRoot, 'src/server/migrations');
  const server = resolve(codeRoot, 'src/server');
  const files = filesBelow(
    server,
    (path) => /\.(mjs|sql|md)$/.test(path) && !path.includes('/test/'),
  );
  files.push(...filesBelow(resolve(codeRoot, 'src/shared')));
  for (const name of ['clinical.ts', 'format.ts']) {
    const path = resolve(codeRoot, 'src/app/data', name);
    if (existsSync(path)) files.push(path);
  }
  const lock = resolve(codeRoot, 'package-lock.json');
  if (existsSync(lock)) files.push(lock);
  files.push(...filesBelow(resolve(codeRoot, 'src/dist')));
  return {
    schemaVersion: LATEST_SCHEMA_VERSION,
    schemaSha256: inventoryHash(migrations, filesBelow(migrations)),
    buildSha256: inventoryHash(codeRoot, files),
  };
}
function mappingVersion(root: string, profileId: string): MappingVersion {
  const directory = resolve(profilePaths(root, profileId).root, 'mappings');
  const files = filesBelow(directory);
  return {
    sha256: inventoryHash(directory, files),
    files: files.length,
    bytes: files.reduce((sum, file) => sum + statSync(file).size, 0),
  };
}
export function pinProfileInputs(root: string, profileId: string): ProfileInputPins {
  const paths = profilePaths(root, profileId);
  return {
    personal: JSON.parse(readFileSync(resolve(paths.personal, 'current.json'), 'utf8')),
    curation: JSON.parse(readFileSync(resolve(paths.curation, 'current.json'), 'utf8')),
    mappings: mappingVersion(root, profileId),
  };
}
export function recordStartupMetrics<T extends { id: string; startedAt: string }>(
  root: string,
  receipt: T,
  limit = 40,
): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Invalid operational history limit');
  const directory = resolve(root, 'data/operations/startups');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  durableWrite(
    resolve(directory, `${receipt.startedAt.replaceAll(/[:.]/g, '-')}-${receipt.id}.json`),
    jsonBytes(receipt),
  );
  durableWrite(resolve(directory, 'latest.json'), jsonBytes(receipt));
  const history = readdirSync(directory)
    .filter((name) => /^\d{4}-.*-[0-9a-f-]{36}\.json$/.test(name))
    .sort();
  for (const name of history.slice(0, Math.max(0, history.length - limit)))
    rmSync(resolve(directory, name));
  syncDirectory(directory);
}

// The caller holds the data-directory lock for both startup and serving.
// This function never reads a working SQLite file and never calls an AI tool.
export function rebuildStartup({
  dataDirectory,
  runtimeDirectory,
  codeRoot = REPO_ROOT,
  profileIds,
  progress = () => {},
  historyLimit = 40,
}: RebuildStartupOptions = {}): RebuildStartupResult {
  const root = validateDataDirectory(dataDirectory, []);
  recoverProfileDeletions(root);
  profileIds ??= readProfileRegistry(root).profiles.map((p: { id: string }) => p.id);
  validateDataDirectory(dataDirectory, profileIds);
  if (!runtimeDirectory || !isAbsolute(runtimeDirectory))
    throw new Error('Runtime database directory must be absolute');
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  const runtimeReal = realpathSync(runtimeDirectory),
    durableReal = realpathSync(dataDirectory!);
  const within = (base: string, path: string): boolean => {
    const rel = relative(base, path);
    return !rel.startsWith('..') && !isAbsolute(rel);
  };
  if (within(durableReal, runtimeReal) || within(runtimeReal, durableReal))
    throw new Error('SQLite runtime and durable data directories must be separate');
  const started = performance.now(),
    id = randomUUID();
  const receipt: StartupReceipt = {
    format: 'health-startup-metrics-v1',
    id,
    startedAt: new Date().toISOString(),
    outcome: 'starting',
    ...startupVersions(codeRoot),
    profiles: [],
    totalMs: 0,
    peakMemoryBytes: 0,
  };
  const staged = resolve(runtimeReal, `.building-${id}`),
    active = resolve(runtimeReal, `generation-${id}`);
  mkdirSync(staged, { mode: 0o700 });
  let stage = 'recover',
    currentProfile: string | null = null,
    activeMetric: StartupProfileMetric | null = null,
    activeProfileStarted = 0,
    activePhaseStarted = 0;
  const announce = (phase: string): void => {
    stage = phase;
    progress({
      ready: false,
      outcome: 'starting',
      profileId: currentProfile,
      phase,
      elapsedMs: performance.now() - started,
    });
  };
  try {
    // Recover every accepted pending intent before pinning any profile.
    for (const profileId of profileIds!) {
      currentProfile = profileId;
      announce('recover');
      if (!hasContributorAuthority(root, profileId)) recoverPendingProfile(root, profileId);
    }
    const journalPins = new Map(
      profileIds!
        .filter((id) => hasContributorAuthority(root, id))
        .map((id) => [
          id,
          {
            head: selectedContributorHead(root, id),
            mappings: mappingVersion(root, id),
          },
        ]),
    );
    const pinned = new Map<string, ProfileInputPins>(
      profileIds!
        .filter((id) => !journalPins.has(id))
        .map((profileId) => [profileId, pinProfileInputs(root, profileId)]),
    );
    for (const profileId of profileIds!) {
      currentProfile = profileId;
      const profileStart = performance.now(),
        phases: Record<string, number> = {},
        pins = pinned.get(profileId)!;
      activeProfileStarted = profileStart;
      activeMetric = { profileId, outcome: 'starting', phases };
      receipt.profiles.push(activeMetric);
      let phaseStart = profileStart,
        currentPhase: string | undefined;
      const phase = (name: string): void => {
        const at = performance.now();
        if (currentPhase) phases[currentPhase] = (phases[currentPhase] || 0) + at - phaseStart;
        currentPhase = name;
        phaseStart = at;
        activePhaseStarted = at;
        announce(name);
      };
      phase('read_validate');
      const journal = journalPins.get(profileId);
      if (journal) {
        phase('record_rebuild');
        const database = resolve(staged, `${profileId}.sqlite`);
        rebuildContributorDatabase(database, root, profileId);
        const db = openDatabase(database, profileId);
        try {
          Object.assign(activeMetric, {
            outcome: 'success',
            recordHead: journal.head,
            mappings: journal.mappings,
            totalMs: performance.now() - profileStart,
            logicalSha256: logicalDatabaseHash(db),
            databaseBytes: statSync(database).size,
            chats: listChats(root, profileId).length,
            peakMemoryBytes: process.resourceUsage().maxRSS * 1024,
          });
        } finally {
          db.close();
        }
        if (
          selectedContributorHead(root, profileId) !== journal.head ||
          JSON.stringify(mappingVersion(root, profileId)) !== JSON.stringify(journal.mappings)
        )
          throw Error('Contributor selected inputs changed during startup');
        phases.record_rebuild = performance.now() - phaseStart;
        activeMetric = null;
        continue;
      }
      const portable = (loadPortable as unknown as LoadPortable)(root, profileId, pins);
      let historyBytes = 0,
        historyGenerations = 0;
      for (const generation of (publishedPersonalLineage as unknown as PersonalLineage)(
        root,
        profileId,
        { manifest: pins.personal },
      )) {
        historyBytes += generation.manifest.bytes;
        historyGenerations++;
      }
      // Conversations stay in place, but corrupt current journals block startup.
      const chats = listChats(root, profileId).length;
      const acceptedSourcesSha256 = hash(
        JSON.stringify(
          [...portable.originals.values()]
            .map((file) => [file.path, file.sha256, file.bytes])
            .sort(),
        ),
      );
      const database = resolve(staged, `${profileId}.sqlite`);
      const result = (projectPortableDatabase as unknown as ProjectPortable)(
        database,
        profileId,
        portable,
        { phase },
      );
      for (const file of portable.originals.values()) {
        const bytes = readFileSync(profileOriginal(root, file.path, profileId));
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
          throw new Error('Accepted originals changed during startup');
      }
      if (JSON.stringify(pins) !== JSON.stringify(pinProfileInputs(root, profileId)))
        throw new Error('Pinned generations or mapping inputs changed during startup');
      phases[currentPhase!] = (phases[currentPhase!] || 0) + performance.now() - phaseStart;
      Object.assign(activeMetric, {
        outcome: 'success',
        totalMs: performance.now() - profileStart,
        personal: pins.personal,
        curation: pins.curation,
        mappings: pins.mappings,
        acceptedSourcesSha256,
        inputBytes:
          [...portable.originals.values()].reduce((sum, file) => sum + file.bytes, 0) +
          pins.curation.bytes +
          historyBytes +
          pins.mappings.bytes,
        inputRecords: Object.values(portable.rows).reduce((sum, rows) => sum + rows.length, 0),
        sourceRecords: portable.rows.source_records.length,
        originalFiles: portable.originals.size,
        historyGenerations,
        chats,
        counts: result.counts,
        databaseBytes: result.databaseBytes,
        logicalSha256: result.logicalSha256,
        peakMemoryBytes: process.resourceUsage().maxRSS * 1024,
      });
      activeMetric = null;
    }
    currentProfile = null;
    announce('activate');
    renameSync(staged, active);
    syncDirectory(runtimeReal);
    receipt.outcome = 'success';
    receipt.totalMs = performance.now() - started;
    receipt.peakMemoryBytes = process.resourceUsage().maxRSS * 1024;
    recordStartupMetrics(root, receipt, historyLimit);
    progress({ ready: false, outcome: 'validated', phase: 'open', elapsedMs: receipt.totalMs });
    // Only derived generations are removed. No durable profile path is touched.
    for (const name of readdirSync(runtimeReal))
      if (
        /^(?:generation-|\.building-)[0-9a-f-]{36}$/.test(name) &&
        resolve(runtimeReal, name) !== active
      )
        rmSync(resolve(runtimeReal, name), { recursive: true, force: true });
    rmSync(resolve(runtimeReal, 'managed-profiles'), { recursive: true, force: true });
    return {
      root,
      receipt,
      databases: profileIds!.map((profileId) => [
        profileId,
        resolve(active, `${profileId}.sqlite`),
      ]),
    };
  } catch (error) {
    if (activeMetric) {
      activeMetric.outcome = 'failure';
      activeMetric.totalMs = performance.now() - activeProfileStarted;
      activeMetric.phases[stage] =
        (activeMetric.phases[stage] || 0) + performance.now() - activePhaseStarted;
    }
    receipt.outcome = 'failure';
    receipt.failedProfileId = currentProfile;
    receipt.failedPhase = stage;
    receipt.failureCode = 'STARTUP_VALIDATION_FAILED'; // Error payloads can contain clinical paths/text.
    receipt.totalMs = performance.now() - started;
    receipt.peakMemoryBytes = process.resourceUsage().maxRSS * 1024;
    rmSync(staged, { recursive: true, force: true });
    recordStartupMetrics(root, receipt, historyLimit);
    progress({
      ready: false,
      outcome: 'failure',
      phase: stage,
      profileId: currentProfile,
      elapsedMs: receipt.totalMs,
    });
    throw error;
  }
}
