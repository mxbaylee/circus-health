import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  opendirSync,
  lstatSync,
  readFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { disposableSqlite } from './disposable-sqlite.ts';
import { portableWork } from './portable-work.ts';
import { openDatabase, type Database } from './database.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  flushRecordDurability,
  recordDurabilityStatus,
  captureRecordReadOwner,
  assertRecordReadOwnerInterval,
  assertRecordReadOwnerBeforeVerification,
  closeRecordReadOwner,
  type RecordReadOwner,
} from './record-versions.ts';
import { validateProductionIntakeAuthority } from './intake-state-bootstrap.ts';
import { intakeCopyRowKeySteps } from './intake-copy-json.ts';
import {
  finishIntakeCopyStepsAsync,
  captureIntakeCopyReadInterval,
  intakeCopyNativeSelect,
} from './intake-copy-work.ts';
import {
  captureManagedPhysicalScope,
  managedPhysicalScopeCurrent,
  retainManagedPhysicalScope,
} from './clinical-review-physical-epoch.ts';
import type { UnlockPhysicalWitness } from './encrypted-unlock-physical.ts';
import { ensureProfileDirectories } from './profile-storage.ts';
import {
  contributorAuthorityPath,
  contributorAuthorityMarker,
  hasContributorAuthority,
  openContributorRecordStorage,
  contributorOriginalVerifier,
  type ContributorRecordStorage,
} from './contributor-record-storage.ts';

const attached = new WeakMap<Database, ContributorRecordStorage>();
export function attachContributorDurability(
  db: Database,
  root: string,
  profileId: string,
  initialize = false,
) {
  if (attached.has(db)) return flushRecordDurability(db)!;
  ensureProfileDirectories(root, profileId);
  // Initialization is permitted only for a fresh unpublished profile. Existing
  // marker presence always selects the journal, including incomplete authority.
  const fresh = !hasContributorAuthority(root, profileId);
  if (fresh && db.prepare("SELECT 1 FROM sqlite_schema WHERE name='__record_state'").get())
    throw Error('Contributor selected authority is missing; existing cache cannot initialize it');
  if (fresh) validateProductionIntakeAuthority(db, profileId);
  const storage = openContributorRecordStorage(root, profileId, { initialize });
  try {
    if (!fresh) assertIndexedContributorCache(db, root, profileId, storage);
    const status = attachRecordDurability(db, {
      profileId,
      storage,
      verifyReferences: contributorOriginalVerifier(root, profileId),
    });
    validateProductionIntakeAuthority(db, profileId);
    if (!fresh) assertContributorCopyCoherence(db, root, profileId);
    attached.set(db, storage);
    const close = db.close.bind(db);
    db.close = () => {
      try {
        close();
      } finally {
        storage.close();
        attached.delete(db);
      }
    };
    return status;
  } catch (error) {
    storage.close();
    throw error;
  }
}
export function selectedContributorHead(root: string, profileId: string): string {
  const storage = openContributorRecordStorage(root, profileId, { readOnly: true });
  try {
    return storage.read('head')!.toString('utf8');
  } finally {
    storage.close();
  }
}
export function rebuildContributorDatabase(database: string, root: string, profileId: string) {
  const storage = openContributorRecordStorage(root, profileId, { readOnly: true });
  const head = storage.read('head')!;
  try {
    const result = rebuildRecordDatabase(database, {
      profileId,
      storage,
      verifyReferences: contributorOriginalVerifier(root, profileId),
    });
    const db = openDatabase(database, profileId);
    try {
      validateProductionIntakeAuthority(db, profileId);
    } finally {
      db.close();
    }
    if (!storage.read('head')!.equals(head))
      throw Error('Contributor authority changed during reconstruction');
    return result;
  } finally {
    storage.close();
  }
}
/** Registry-free discovery requires the verified selected journal, including its
 * reconstructed owner and originals. A directory name or selection marker alone
 * does not establish profile identity. The source archive remains unchanged. */
export function verifyContributorProfileAuthority(root: string, profileId: string): void {
  const directory = mkdtempSync(resolve(tmpdir(), 'health-contributor-owner-'));
  try {
    rebuildContributorDatabase(resolve(directory, 'owner.sqlite'), root, profileId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const bookkeeping = (key: unknown) =>
  typeof key === 'string' &&
  ((key.startsWith('personal_') && !/^personal_(assistant|restore)_/.test(key)) ||
    key === 'curation_revision');
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
/** Stream the exact previous table/normalized-row comparison grammar. */
function* rows(db: Database): Generator<string> {
  const scratch = disposableSqlite('circus-contributor-compare-');
  try {
    scratch.db.exec('CREATE TABLE rows(sort BLOB, value TEXT)');
    const insert = scratch.db.prepare('INSERT INTO rows VALUES(?,?)');
    yield '[';
    let firstTable = true;
    for (const { name } of db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name",
      )
      .iterate()) {
      if (!firstTable) yield ',';
      firstTable = false;
      yield '[' + JSON.stringify(name) + ',[';
      scratch.db.exec('DELETE FROM rows');
      for (const row of db.prepare(`SELECT * FROM ${quote(String(name))}`).iterate()) {
        if (name === 'app_meta' && bookkeeping(row.key)) continue;
        const value = JSON.stringify(
          Object.fromEntries(
            Object.keys(row)
              .sort()
              .map((key) => [key, row[key]]),
          ),
        );
        const sort = Buffer.from(value, 'utf16le');
        sort.swap16();
        insert.run(sort, value);
      }
      let first = true;
      for (const row of scratch.db.prepare('SELECT value FROM rows ORDER BY sort').iterate()) {
        if (!first) yield ',';
        first = false;
        yield JSON.stringify(row.value);
      }
      yield ']]';
    }
    yield ']';
  } finally {
    scratch.close();
  }
}
function equalRows(left: Database, right: Database): boolean {
  const a = rows(left),
    b = rows(right);
  try {
    while (true) {
      const l = a.next(),
        r = b.next();
      if (l.done || r.done) return l.done === r.done;
      if (l.value !== r.value) return false;
    }
  } finally {
    a.return(undefined);
    b.return(undefined);
  }
}
/** Verify the cache against its own accepted baseline before catch-up can
 * overwrite rows. A newer selected head authorizes recovery of acknowledged
 * state, never silent erasure of conflicting unacknowledged cache edits. */
function assertIndexedContributorCache(
  db: Database,
  root: string,
  profileId: string,
  storage: ContributorRecordStorage,
): void {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='__record_state'").get())
    throw Error('Contributor cache is missing its accepted index; rebuild it explicitly');
  const indexed = db
    .prepare('SELECT profile_id,head_json FROM __record_state WHERE singleton=1')
    .get();
  if (!indexed)
    throw Error('Contributor cache is missing its accepted baseline; rebuild it explicitly');
  if (indexed.profile_id !== profileId || typeof indexed.head_json !== 'string')
    throw Error('Contributor indexed cache has invalid authority binding');
  const baseline = Buffer.from(indexed.head_json);
  const directory = mkdtempSync(resolve(tmpdir(), 'health-contributor-baseline-'));
  try {
    const path = resolve(directory, 'baseline.sqlite');
    rebuildRecordDatabase(path, {
      profileId,
      storage: {
        read: (name) => (name === 'head' ? baseline : storage.read(name)),
        writeImmutable() {
          throw Error('Contributor baseline validation is read only');
        },
        publishHead() {
          throw Error('Contributor baseline validation is read only');
        },
      },
      verifyReferences: contributorOriginalVerifier(root, profileId),
    });
    const accepted = openDatabase(path, profileId);
    try {
      if (!equalRows(db, accepted))
        throw Error(
          'Contributor cache conflicts with its indexed accepted authority before recovery',
        );
    } finally {
      accepted.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
/** Full comparison occurs at open/recovery and one-time copy/backup certification. */
export function assertContributorCopyCoherence(
  db: Database,
  root: string,
  profileId: string,
  backup?: Database,
): void {
  if (!db.isOpen || db.isTransaction || (backup && (!backup.isOpen || backup.isTransaction)))
    throw Error('Contributor copy requires an idle source and backup');
  const status = recordDurabilityStatus(db);
  if (!status || status.dirty || status.conflicted)
    throw Error('Contributor copy requires current accepted record authority');
  flushRecordDurability(db);
  const head = selectedContributorHead(root, profileId);
  const directory = mkdtempSync(resolve(tmpdir(), 'health-contributor-copy-'));
  try {
    const path = resolve(directory, 'selected.sqlite');
    rebuildContributorDatabase(path, root, profileId);
    const selected = openDatabase(path, profileId);
    try {
      if (!equalRows(db, selected) || (backup && !equalRows(backup, selected)))
        throw Error('Contributor copy cache conflicts with selected record authority');
    } finally {
      selected.close();
    }
    if (selectedContributorHead(root, profileId) !== head)
      throw Error('Contributor copy selected authority changed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

declare const contributorCopyBrand: unique symbol;
export interface ContributorCopyCertification {
  readonly [contributorCopyBrand]: true;
}
interface ContributorCopyData {
  source: Database;
  root: string;
  profileId: string;
  head: string;
  directory: string;
  selected: Database;
  storage: ContributorRecordStorage;
  owner: RecordReadOwner;
  physicalScope: object;
  releasePhysicalScope: () => void;
  sourceCurrent: () => void;
  selectedCurrent: () => void;
  physical: Array<{ root: string; path: string; witness: UnlockPhysicalWitness }>;
}
const contributorCopies = new WeakMap<ContributorCopyCertification, ContributorCopyData>();

function assertCopyCurrent(
  data: Omit<ContributorCopyData, 'selected' | 'physical' | 'selectedCurrent'>,
): void {
  data.sourceCurrent();
  if ('selectedCurrent' in data) (data.selectedCurrent as () => void)();
  const status = recordDurabilityStatus(data.source);
  if (
    !data.source.isOpen ||
    data.source.isTransaction ||
    !status ||
    status.dirty ||
    status.conflicted
  )
    throw Error('Contributor copy original durability changed');
  if (
    data.source.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
    data.profileId
  )
    throw Error('Contributor copy original owner changed');
  if (!managedPhysicalScopeCurrent(data.physicalScope))
    throw Error('Contributor copy original physical scope changed');
  if (selectedContributorHead(data.root, data.profileId) !== data.head)
    throw Error('Contributor copy original selected head changed');
  assertRecordReadOwnerBeforeVerification(data.source, data.owner);
  data.sourceCurrent();
  if ('selectedCurrent' in data) (data.selectedCurrent as () => void)();
}

async function runContributorCopyWorker(
  data: unknown,
  signal: AbortSignal | undefined,
  checkpoint: () => void,
): Promise<Pick<ContributorCopyData, 'physical'>> {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./contributor-copy-worker.ts', import.meta.url), {
    workerData: data,
  });
  let ready = false,
    started = false,
    exited = false,
    received = false,
    failure: unknown;
  let bootResolve!: () => void, exitResolve!: () => void;
  const boot = new Promise<void>((resolve) => {
      bootResolve = resolve;
    }),
    exit = new Promise<void>((resolve) => {
      exitResolve = resolve;
    });
  let resultResolve!: (result: Pick<ContributorCopyData, 'physical'>) => void,
    resultReject!: (error: unknown) => void;
  const result = new Promise<Pick<ContributorCopyData, 'physical'>>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  const fail = (error: unknown) => {
    failure ??= error;
    resultReject(error);
    if (!exited && ready) {
      if (started) void worker.terminate();
      else worker.postMessage({ cancel: true });
    }
  };
  const abort = () => fail(signal!.reason);
  signal?.addEventListener('abort', abort, { once: true });
  worker.on('error', (error) => {
    bootResolve();
    fail(error);
  });
  worker.on('exit', (code) => {
    exited = true;
    bootResolve();
    exitResolve();
    if (code !== 0 || !received)
      fail(Error('Contributor copy worker exited without certification'));
  });
  worker.on(
    'message',
    (message: {
      ready?: true;
      progress?: true;
      failure?: string;
      prepared?: Pick<ContributorCopyData, 'physical'>;
    }) => {
      try {
        if (message.ready) {
          if (ready) throw Error('Contributor copy worker protocol');
          ready = true;
          bootResolve();
          if (failure || signal?.aborted) {
            worker.postMessage({ cancel: true });
            return;
          }
          checkpoint();
          started = true;
          worker.postMessage({ start: true });
          return;
        }
        signal?.throwIfAborted();
        checkpoint();
        if (!ready || !started) throw Error('Contributor copy worker protocol');
        if (message.progress) return;
        if (message.failure) throw Error(message.failure);
        if (!message.prepared || received) throw Error('Contributor copy worker protocol');
        received = true;
        resultResolve(message.prepared);
      } catch (error) {
        fail(error);
      }
    },
  );
  try {
    const prepared = await result;
    await exit;
    if (failure) throw failure;
    signal?.throwIfAborted();
    checkpoint();
    return prepared;
  } finally {
    await boot;
    if (!exited && started) await worker.terminate();
    else if (!exited && ready) worker.postMessage({ cancel: true });
    await exit;
    signal?.removeEventListener('abort', abort);
  }
}

function* equalCopyRowsSteps(
  left: Database,
  right: Database,
  checkpoint: () => void,
): Generator<void, boolean> {
  const names = (db: Database) =>
    intakeCopyNativeSelect(
      db,
      "SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name",
      checkpoint,
    )
      .all()
      .map((row) => String(row.name));
  const tables = names(left);
  if (JSON.stringify(tables) !== JSON.stringify(names(right))) return false;
  const scratch = disposableSqlite('contributor-copy-comparison-');
  try {
    scratch.db.exec('CREATE TABLE comparison(key TEXT PRIMARY KEY,count INTEGER NOT NULL)');
    for (const table of tables) {
      scratch.db.exec('DELETE FROM comparison');
      for (const row of intakeCopyNativeSelect(
        left,
        `SELECT * FROM main.${quote(table)}`,
        checkpoint,
      ).iterate()) {
        checkpoint();
        yield;
        if (table === 'app_meta' && bookkeeping(row.key)) continue;
        const key = yield* intakeCopyRowKeySteps(row);
        scratch.db
          .prepare(
            'INSERT INTO comparison VALUES(?,1) ON CONFLICT(key) DO UPDATE SET count=count+1',
          )
          .run(key);
      }
      for (const row of intakeCopyNativeSelect(
        right,
        `SELECT * FROM main.${quote(table)}`,
        checkpoint,
      ).iterate()) {
        checkpoint();
        yield;
        if (table === 'app_meta' && bookkeeping(row.key)) continue;
        const key = yield* intakeCopyRowKeySteps(row);
        if (
          !scratch.db
            .prepare('UPDATE comparison SET count=count-1 WHERE key=? AND count>0')
            .run(key).changes
        )
          return false;
      }
      if (scratch.db.prepare('SELECT 1 FROM comparison WHERE count<>0 LIMIT 1').get()) return false;
    }
    return true;
  } finally {
    scratch.close();
  }
}

export async function prepareContributorCopyCertification(
  db: Database,
  root: string,
  profileId: string,
  backup?: Database,
  signal?: AbortSignal,
): Promise<ContributorCopyCertification> {
  const sourceCurrent = captureIntakeCopyReadInterval(db, profileId);
  const storage = attached.get(db);
  if (!storage) throw Error('Contributor copy requires genuine attached writer');
  const owner = captureRecordReadOwner(db, profileId),
    physicalScope = captureManagedPhysicalScope(resolve(root, 'data/profiles', profileId));
  if (!owner || !physicalScope) {
    closeRecordReadOwner(owner);
    throw Error('Contributor copy physical source unavailable');
  }
  let directory: string | undefined,
    selected: Database | undefined,
    releasePhysicalScope: (() => void) | undefined,
    complete = false;
  try {
    releasePhysicalScope = retainManagedPhysicalScope(physicalScope);
    directory = mkdtempSync(resolve(tmpdir(), 'health-contributor-copy-'));
    const initial = {
      source: db,
      root,
      profileId,
      head: selectedContributorHead(root, profileId),
      directory,
      storage,
      owner,
      physicalScope,
      releasePhysicalScope,
      sourceCurrent,
    };
    const checkpoint = () => {
      signal?.throwIfAborted();
      assertCopyCurrent(initial);
    };
    checkpoint();
    const path = resolve(directory, 'selected.sqlite'),
      prepared = await runContributorCopyWorker(
        { root, profileId, directory, path },
        signal,
        checkpoint,
      );
    selected = openDatabase(path, profileId);
    const selectedCurrent = captureIntakeCopyReadInterval(selected, profileId);
    if (
      !(await finishIntakeCopyStepsAsync(equalCopyRowsSteps(db, selected, checkpoint), signal)) ||
      (backup &&
        !(await finishIntakeCopyStepsAsync(
          equalCopyRowsSteps(backup, selected, checkpoint),
          signal,
        )))
    )
      throw Error('Contributor copy cache conflicts with selected record authority');
    checkpoint();
    selectedCurrent();
    await runContributorCopyWorker(
      { root, profileId, directory, path, physical: prepared.physical },
      signal,
      checkpoint,
    );
    checkpoint();
    selectedCurrent();
    const certification = Object.freeze({}) as ContributorCopyCertification;
    contributorCopies.set(certification, {
      ...initial,
      selected,
      selectedCurrent,
      physical: prepared.physical,
    });
    complete = true;
    return certification;
  } finally {
    if (!complete) {
      try {
        selected?.close();
      } finally {
        try {
          if (directory) rmSync(directory, { recursive: true, force: true });
        } finally {
          try {
            closeRecordReadOwner(owner);
          } finally {
            releasePhysicalScope?.();
          }
        }
      }
    }
  }
}

export async function contributorCopySourceTextInventory(
  certification: ContributorCopyCertification,
  source: Database,
  root: string,
  profileId: string,
  signal?: AbortSignal,
): Promise<{ has(key: string): boolean; assertCurrent(): void }> {
  const data = contributorCopies.get(certification);
  if (!data || data.source !== source || data.root !== root || data.profileId !== profileId)
    throw Error('Contributor copy certification scope');
  const checkpoint = () => {
    signal?.throwIfAborted();
    assertCopyCurrent(data);
  };
  if (
    !(await finishIntakeCopyStepsAsync(
      equalCopyRowsSteps(source, data.selected, checkpoint),
      signal,
    ))
  )
    throw Error('Contributor copy certified cache changed');
  await runContributorCopyWorker(
    {
      root,
      profileId,
      directory: data.directory,
      path: resolve(data.directory, 'selected.sqlite'),
      physical: data.physical,
    },
    signal,
    checkpoint,
  );
  checkpoint();
  return {
    assertCurrent: checkpoint,
    has(key) {
      checkpoint();
      const found = !!data.selected.prepare('SELECT 1 FROM app_meta WHERE key=?').get(key);
      checkpoint();
      return found;
    },
  };
}

export function disposeContributorCopyCertification(
  certification: ContributorCopyCertification,
): void {
  const data = contributorCopies.get(certification);
  if (!data) return;
  contributorCopies.delete(certification);
  try {
    data.selected.close();
  } finally {
    try {
      rmSync(data.directory, { recursive: true, force: true });
    } finally {
      try {
        closeRecordReadOwner(data.owner);
      } finally {
        data.releasePhysicalScope();
      }
    }
  }
}

export function assertContributorCopyCertificationCurrent(
  certification: ContributorCopyCertification,
): void {
  const data = contributorCopies.get(certification);
  if (!data) throw Error('Contributor copy certification disposed');
  assertCopyCurrent(data);
}

declare const contributorPublicationBrand: unique symbol;
export interface ContributorCopyPublicationSeal {
  readonly [contributorPublicationBrand]: true;
}
const copyPublicationSeals = new WeakMap<
  ContributorCopyPublicationSeal,
  { certification: ContributorCopyCertification; data: ContributorCopyData }
>();

function assertCopyPublicationCurrent(data: ContributorCopyData): void {
  data.sourceCurrent();
  data.selectedCurrent();
  assertRecordReadOwnerInterval(data.source, data.owner);
  if (!managedPhysicalScopeCurrent(data.physicalScope))
    throw Error('Contributor copy original physical source changed');
  data.sourceCurrent();
  data.selectedCurrent();
  assertRecordReadOwnerInterval(data.source, data.owner);
}

/** Reverify the original complete roster after all callback-capable work. All
 * worker/handoff guards from this point use native reads and factory identities. */
export async function verifyContributorCopyCertificationForPublication(
  certification: ContributorCopyCertification,
  signal?: AbortSignal,
): Promise<ContributorCopyPublicationSeal> {
  const data = contributorCopies.get(certification);
  if (!data) throw Error('Contributor copy certification disposed');
  assertCopyCurrent(data);
  const checkpoint = () => {
    signal?.throwIfAborted();
    if (contributorCopies.get(certification) !== data)
      throw Error('Contributor copy certification disposed');
    assertCopyPublicationCurrent(data);
  };
  checkpoint();
  await runContributorCopyWorker(
    {
      root: data.root,
      profileId: data.profileId,
      directory: data.directory,
      path: resolve(data.directory, 'selected.sqlite'),
      physical: data.physical,
    },
    signal,
    checkpoint,
  );
  checkpoint();
  const seal = Object.freeze({}) as ContributorCopyPublicationSeal;
  copyPublicationSeals.set(seal, { certification, data });
  return seal;
}

/** One-use callback-free continuation immediately before owner-controlled rename. */
export function consumeContributorCopyPublicationSeal(
  seal: ContributorCopyPublicationSeal,
  certification: ContributorCopyCertification,
): void {
  const value = copyPublicationSeals.get(seal);
  copyPublicationSeals.delete(seal);
  if (
    !value ||
    value.certification !== certification ||
    contributorCopies.get(certification) !== value.data
  )
    throw Error('Contributor copy publication seal unavailable');
  assertCopyPublicationCurrent(value.data);
}

export async function assertContributorCopyCoherenceAsync(
  db: Database,
  root: string,
  profileId: string,
  backup?: Database,
  signal?: AbortSignal,
): Promise<void> {
  const certification = await prepareContributorCopyCertification(
    db,
    root,
    profileId,
    backup,
    signal,
  );
  disposeContributorCopyCertification(certification);
}
/** Same-profile archive recovery retains journal identity, unlike private copy. */
export function copyContributorAuthority(
  root: string,
  profileId: string,
  targetRoot: string,
  { onFile }: { onFile?: (path: string) => void } = {},
): string[] {
  const source = contributorAuthorityPath(root, profileId),
    target = contributorAuthorityPath(targetRoot, profileId);
  const head = selectedContributorHead(root, profileId);
  if (hasContributorAuthority(targetRoot, profileId))
    throw Error('Contributor recovery authority target exists');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const files: string[] = [];
  function copy(from: string, to: string): void {
    const stat = lstatSync(from);
    if (stat.isDirectory()) {
      mkdirSync(to, { mode: 0o700 });
      const directory = opendirSync(from);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync())
          if (entry.name !== 'writer.lock' && !entry.name.startsWith('.pending-'))
            copy(resolve(from, entry.name), resolve(to, entry.name));
      } finally {
        directory.closeSync();
      }
    } else if (stat.isFile()) {
      portableWork('fileCopyCalls', 1);
      copyFileSync(from, to);
      portableWork('fileCopyBytes', stat.size);
      const path = relative(targetRoot, to);
      if (onFile) onFile(path);
      else files.push(path);
    } else throw Error('Contributor authority copy contains nonregular files');
    const fd = openSync(to, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  copy(source, target);
  copy(
    contributorAuthorityMarker(root, profileId),
    contributorAuthorityMarker(targetRoot, profileId),
  );
  if (
    selectedContributorHead(root, profileId) !== head ||
    readFileSync(resolve(target, 'head'), 'utf8') !== head
  )
    throw Error('Contributor authority changed during archive copy');
  return files;
}
