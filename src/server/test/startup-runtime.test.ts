import { createTestRuntimeDirectory } from './runtime-fixture.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { openDatabase, revision, type Database } from '../database.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { attachPersonalDurability, exportCuration, recoverPendingProfile } from '../portable.ts';
import { createNote, saveNote } from '../notes.ts';
import { uploadIntake } from '../intake.ts';
import { writeChat, readChat } from '../assistant-journal.ts';
import {
  rebuildStartup,
  validateDataDirectory,
  validateRuntimeDirectory,
  recordStartupMetrics,
} from '../startup-rebuild.ts';
import { acquireStorageLock } from '../storage-lock.ts';
import type { StorageLock } from '../storage-lock.ts';
import type { StartupProgress } from '../startup-rebuild.ts';
import {
  startLegacyRuntime as startRuntime,
  startRuntime as startEncryptedRuntime,
} from '../runtime.ts';
import { createBackup, restoreBackup } from '../recovery.ts';

function fixture(
  t: TestContext,
  ids: readonly string[] = ['cedar', 'cookie-dough', 'orchid'],
  portableSnapshots = false,
) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-startup-'));
  const dbs = new Map<string, Database>();
  for (const profileId of ids) {
    const paths = ensureProfileDirectories(root, profileId),
      db = openDatabase(paths.database, profileId);
    dbs.set(profileId, db);
    attachPersonalDurability(db, { root, profileId, portableSnapshots });
    exportCuration(db, root, profileId);
  }
  t.after(() => {
    for (const db of dbs.values()) {
      try {
        db.close();
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    dbs,
    dataDirectory: resolve(root, 'data'),
    runtimeDirectory: resolve(root, 'working'),
    profileIds: [...ids],
  };
}
type Fixture = ReturnType<typeof fixture>;
function removeWorking(f: Fixture) {
  for (const [id, db] of f.dbs) {
    db.close();
    rmSync(profilePaths(f.root, id).databaseDirectory, { recursive: true });
  }
  f.dbs.clear();
}

test('startup requires existing durable inputs and a separate disposable database root', (t) => {
  const f = fixture(t);
  assert.throws(() => validateDataDirectory(), /CRS_DATA_DIR/);
  assert.throws(() => validateDataDirectory('relative'), /absolute/);
  assert.throws(
    () => rebuildStartup({ ...f, runtimeDirectory: resolve(f.dataDirectory, 'working') }),
    /separate/,
  );
  rmSync(resolve(profilePaths(f.root, 'orchid').records, 'head'));
  assert.throws(() => rebuildStartup(f), /missing|head|authority/i);
});

test('both runtime entry points reject disk-backed Linux runtime storage before acquiring a writer', async (t) => {
  const f = fixture(t, ['cedar']);
  mockRuntimeFilesystem(t, 'linux', 0xef53);
  let lockAttempts = 0;
  for (const start of [startRuntime, startEncryptedRuntime]) {
    await assert.rejects(
      start({
        ...f,
        runtimeDirectory: f.root,
        lockFactory: async () => {
          lockAttempts++;
          throw new Error('Runtime reached the writer before validating its storage');
        },
      }),
      /CRS_RUNTIME_DIR.*tmpfs/,
    );
  }
  assert.equal(lockAttempts, 0);
});

function mockRuntimeFilesystem(t: TestContext, platform: NodeJS.Platform, type: number) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const stats = fs.statfsSync(tmpdir());
  const probe = t.mock.method(fs, 'statfsSync', () => ({ ...stats, type }));
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { value: platform });
  t.after(() => {
    Object.defineProperty(process, 'platform', descriptor);
    probe.mock.restore();
    syncBuiltinESMExports();
  });
  return probe;
}

test('Linux runtime validation accepts tmpfs and rejects missing, relative, and file paths', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'runtime-directory-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const probe = mockRuntimeFilesystem(t, 'linux', 0x01021994);
  assert.doesNotThrow(() => validateRuntimeDirectory(root));
  assert.equal(probe.mock.callCount(), 1);
  writeFileSync(resolve(root, 'file'), 'fictional');
  for (const directory of [
    undefined,
    '',
    'relative',
    resolve(root, 'missing'),
    resolve(root, 'file'),
  ])
    assert.throws(() => validateRuntimeDirectory(directory), /CRS_RUNTIME_DIR.*tmpfs/);
  probe.mock.mockImplementation(() => {
    throw new Error('statfs unavailable');
  });
  assert.throws(() => validateRuntimeDirectory(root), /CRS_RUNTIME_DIR.*tmpfs/);
});

for (const platform of ['darwin', 'win32'] as const)
  test(`${platform} contributor checks do not apply Linux filesystem magic`, (t) => {
    const probe = mockRuntimeFilesystem(t, platform, 26);
    assert.doesNotThrow(() => validateRuntimeDirectory(tmpdir()));
    assert.doesNotThrow(() => validateRuntimeDirectory('/fictional/missing-runtime'));
    assert.equal(probe.mock.callCount(), 0);
  });

test('two startups reconstruct all profiles with identical logical content and retained history/chats', (t) => {
  const f = fixture(t);
  const note = createNote(f.dbs.get('cedar')!, {
    title: 'Retained synthetic note',
    content: 'Initial',
  });
  saveNote(f.dbs.get('cedar')!, note.id, {
    version: note.version,
    content: 'Accepted edit',
  });
  const chatId = randomUUID();
  writeChat(
    f.root,
    'cedar',
    { id: chatId, title: 'Synthetic chat', updatedAt: '2026-09-11T00:00:00Z', messages: [] },
    'created',
  );
  const history = readdirSync(resolve(profilePaths(f.root, 'cedar').records, 'objects'));
  removeWorking(f);
  const phases: string[] = [],
    first = rebuildStartup({ ...f, progress: (x: StartupProgress) => void phases.push(x.phase) });
  const second = rebuildStartup(f);
  assert.deepEqual(
    first.receipt.profiles.map((x) => x.logicalSha256),
    second.receipt.profiles.map((x) => x.logicalSha256),
  );
  assert.deepEqual(readdirSync(resolve(profilePaths(f.root, 'cedar').records, 'objects')), history);
  assert.equal((readChat(f.root, 'cedar', chatId) as { title: string }).title, 'Synthetic chat');
  assert.ok(
    ['read_validate', 'record_rebuild', 'activate'].every((phase) => phases.includes(phase)),
  );
  for (const p of second.receipt.profiles) {
    assert.ok((p.totalMs ?? 0) > 0 && (p.databaseBytes ?? 0) > 0 && (p.peakMemoryBytes ?? 0) > 0);
    assert.equal(p.outcome, 'success');
    assert.equal(existsSync(profilePaths(f.root, p.profileId).database), false);
  }
  assert.equal(JSON.stringify(second.receipt).includes('Retained synthetic note'), false);
  const db = new DatabaseSync(second.databases[0]![1], { readOnly: true });
  assert.equal(
    db.prepare('SELECT content FROM notes WHERE id=?').get(note.id)?.content,
    'Accepted edit',
  );
  db.close();
});

test('acknowledged edits survive SIGKILL and total SQLite loss despite failed publication', (t) => {
  const f = fixture(t, ['cedar'], true);
  const paths = profilePaths(f.root, 'cedar');
  f.dbs.get('cedar')!.close();
  f.dbs.clear();
  const script = `
import { openDatabase } from ${JSON.stringify(new URL('../database.ts', import.meta.url).href)};
import { attachPersonalDurability } from ${JSON.stringify(new URL('../portable.ts', import.meta.url).href)};
import { createNote } from ${JSON.stringify(new URL('../notes.ts', import.meta.url).href)};
const db = openDatabase(${JSON.stringify(paths.database)}, "cedar");
attachPersonalDurability(db, { root: ${JSON.stringify(f.root)}, profileId: "cedar", portableSnapshots:true, writer() { throw new Error("publication unavailable"); } });
const note = createNote(db, { title: "Acknowledged before crash", content: "Retain exact accepted text" });
process.stdout.write(JSON.stringify(note), () => process.kill(process.pid, "SIGKILL"));
`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(killed.signal, 'SIGKILL');
  const acknowledged = JSON.parse(killed.stdout) as { id: string; content: string };
  assert.equal(existsSync(resolve(paths.personal, 'pending.json')), true);
  rmSync(paths.databaseDirectory, { recursive: true });
  const rebuilt = rebuildStartup(f),
    db = new DatabaseSync(rebuilt.databases[0][1], { readOnly: true });
  assert.equal(
    db.prepare('SELECT content FROM notes WHERE id=?').get(acknowledged.id)!.content,
    acknowledged.content,
  );
  assert.equal(existsSync(resolve(paths.personal, 'pending.json')), false);
  db.close();
  assert.equal(recoverPendingProfile(f.root, 'cedar'), null, 'Replay is idempotent');
});

test('failed durable intent rolls SQLite back before the save is acknowledged', (t) => {
  const f = fixture(t, ['cedar'], true),
    db = f.dbs.get('cedar')!,
    before = revision(db);
  attachPersonalDurability(db, {
    portableSnapshots: true,
    root: f.root,
    profileId: 'cedar',
    journalWriter() {
      throw new Error('durable disk unavailable');
    },
  });
  assert.throws(() => createNote(db, { title: 'Must not commit' }), /durable disk unavailable/);
  assert.equal(db.prepare("SELECT 1 FROM notes WHERE title='Must not commit'").get(), undefined);
  assert.equal(revision(db), before);
  assert.equal(existsSync(resolve(profilePaths(f.root, 'cedar').personal, 'pending.json')), false);
});

test('source registration published before lost acknowledgement survives total SQLite loss without fabricating request success', (t) => {
  const f = fixture(t, ['cedar']),
    db = f.dbs.get('cedar')!;
  const bytes = Buffer.from('Independently fictional source publication evidence Ω.');
  const head = resolve(profilePaths(f.root, 'cedar').records, 'head');
  const before = readFileSync(head);
  const rename = fs.renameSync;
  let published = false;
  const fault = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    rename(from, to);
    if (String(to) === head) {
      published = true;
      throw Error('Fictional source publication acknowledgement lost');
    }
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () =>
        uploadIntake(db, f.root, 'cedar', {
          filename: 'retained.txt',
          bytes,
          newProviderName: 'Synthetic issuer',
        }),
      /acknowledgement lost/,
    );
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(
    published,
    true,
    'the actual selected filesystem head was published before the error',
  );
  assert.notDeepEqual(readFileSync(head), before);
  assert.equal(
    db.prepare("SELECT count(*) n FROM source_files WHERE kind='intake_original'").get()!.n,
    0,
    'the failed request did not fabricate a SQL acknowledgement',
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM providers WHERE name='Synthetic issuer'").get()!.n,
    0,
  );
  removeWorking(f);
  const rebuilt = rebuildStartup(f),
    restored = new DatabaseSync(rebuilt.databases[0][1], { readOnly: true });
  try {
    const original = restored
      .prepare("SELECT id,path,bytes FROM source_files WHERE kind='intake_original'")
      .get()!;
    assert.ok(original, 'startup selects the published source registration despite SQL rollback');
    assert.equal(
      restored.prepare("SELECT count(*) n FROM source_files WHERE kind='intake_original'").get()!.n,
      1,
    );
    assert.equal(
      restored.prepare("SELECT count(*) n FROM providers WHERE name='Synthetic issuer'").get()!.n,
      1,
    );
    assert.equal(original.bytes, bytes.length);
    assert.deepEqual(readFileSync(resolve(f.root, String(original.path))), bytes);
  } finally {
    restored.close();
  }
});

test('unresolved or corrupt intents block startup and leave durable history in place', (t) => {
  const f = fixture(t, ['cedar'], true),
    db = f.dbs.get('cedar')!,
    paths = profilePaths(f.root, 'cedar');
  attachPersonalDurability(db, {
    portableSnapshots: true,
    root: f.root,
    profileId: 'cedar',
    writer() {
      throw new Error('publication unavailable');
    },
  });
  createNote(db, { title: 'Pending synthetic content' });
  const pending = JSON.parse(readFileSync(resolve(paths.personal, 'pending.json'), 'utf8'));
  writeFileSync(resolve(paths.personal, pending.personal.file), 'corrupt');
  const files = readdirSync(resolve(paths.personal, 'snapshots'));
  removeWorking(f);
  assert.throws(() => rebuildStartup(f), /checksum/);
  assert.equal(existsSync(resolve(paths.personal, 'pending.json')), true);
  assert.deepEqual(readdirSync(resolve(paths.personal, 'snapshots')), files);
  const metric = JSON.parse(
    readFileSync(resolve(f.dataDirectory, 'operations/startups/latest.json'), 'utf8'),
  );
  assert.equal(metric.outcome, 'failure');
  assert.equal(metric.failedPhase, 'recover');
  assert.equal(JSON.stringify(metric).includes('Pending synthetic content'), false);
});

test('operational timing retention is bounded independently of personal history', (t) => {
  const f = fixture(t, ['cedar']),
    history = readdirSync(resolve(profilePaths(f.root, 'cedar').records, 'objects'));
  for (let i = 0; i < 5; i++)
    recordStartupMetrics(
      f.root,
      { id: randomUUID(), startedAt: `2026-09-11T00:00:0${i}.000Z`, outcome: 'success' },
      2,
    );
  assert.equal(readdirSync(resolve(f.dataDirectory, 'operations/startups')).length, 3);
  assert.deepEqual(readdirSync(resolve(profilePaths(f.root, 'cedar').records, 'objects')), history);
});

test('backup from container-local SQLite retains portable generations and conversation history', async (t) => {
  const f = fixture(t, ['cedar']),
    chatId = randomUUID();
  createNote(f.dbs.get('cedar')!, { title: 'Backup from ephemeral projection' });
  writeChat(
    f.root,
    'cedar',
    { id: chatId, title: 'Retained chat', updatedAt: '2026-09-11', messages: [] },
    'created',
  );
  removeWorking(f);
  const rebuilt = rebuildStartup(f),
    db = openDatabase(rebuilt.databases[0][1], 'cedar');
  attachPersonalDurability(db, { root: f.root, profileId: 'cedar' });
  const backup = await createBackup(db, f.root, 'cedar');
  db.close();
  const manifest = JSON.parse(readFileSync(resolve(backup.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'circus-health-backup-v2');
  assert.ok(
    (manifest as { profileSources: Array<{ path: string }> }).profileSources.some((file) =>
      file.path.includes('/chats/'),
    ),
  );
  const target = resolve(f.root, 'restore');
  restoreBackup(backup.path, target);
  assert.equal((readChat(target, 'cedar', chatId) as { title: string }).title, 'Retained chat');
  assert.ok(readdirSync(resolve(profilePaths(target, 'cedar').records, 'objects')).length > 1);
});

test('kernel lease excludes concurrent writers and releases after process loss', async (t) => {
  const f = fixture(t, ['cedar']),
    first = await acquireStorageLock(f.dataDirectory);
  await assert.rejects(acquireStorageLock(f.dataDirectory), /active writer/);
  await first.release();
  // A subprocess provides an abrupt-loss check independent of explicit release.
  const script = `import { acquireStorageLock } from ${JSON.stringify(new URL('../storage-lock.ts', import.meta.url).href)}; const lease = await acquireStorageLock(${JSON.stringify(f.dataDirectory)}); process.stdout.write("ready");`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((done, reject) => {
    child.stdout.once('data', done);
    child.once('exit', (code) => reject(new Error(`lock child ${code}`)));
  });
  await assert.rejects(acquireStorageLock(f.dataDirectory), /active writer/);
  child.kill('SIGKILL');
  await new Promise((done) => child.once('exit', done));
  const last = await acquireStorageLock(f.dataDirectory);
  await last.release();
});

test('runtime exposes startup progress and only serves the API after verified rebuild', async (t) => {
  const f = fixture(t, ['cedar']);
  createNote(f.dbs.get('cedar')!, { title: 'Runtime synthetic note' });
  removeWorking(f);
  const runtimeDirectory = createTestRuntimeDirectory();
  const runtime = await startRuntime({
    ...f,
    runtimeDirectory,
    host: '127.0.0.1',
    port: 0,
    assistantOptions: {
      availability: async () => ({ available: false, reason: 'disabled in test' }),
    },
  });
  t.after(async () => {
    await runtime.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
  });
  const address = runtime.server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const starting = await fetch(origin + '/health/ready');
  assert.ok([200, 503].includes(starting.status));
  const ready = await runtime.ready;
  assert.equal(ready.ready, true);
  assert.equal((await fetch(origin + '/health/ready')).status, 200);
  assert.equal((await fetch(origin + '/api/profiles')).status, 200);
  const res = await fetch(origin + '/api/profiles/cedar/notes', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Accepted through runtime' }),
  });
  assert.equal(res.status, 201);
  assert.equal(
    ((await res.json()) as { meta: { durability: { dirty: boolean } } }).meta.durability.dirty,
    false,
  );
  assert.equal(existsSync(profilePaths(f.root, 'cedar').database), false);
});

test('losing the kernel lease aborts an already forwarded POST before another writer starts', async (t) => {
  const f = fixture(t, ['cedar']);
  removeWorking(f);
  let lease: StorageLock | undefined;
  const runtimeDirectory = createTestRuntimeDirectory();
  const runtime = await startRuntime({
    ...f,
    runtimeDirectory,
    host: '127.0.0.1',
    port: 0,
    lockFactory: async (directory) => {
      lease = await acquireStorageLock(directory);
      return lease;
    },
    assistantOptions: { availability: async () => ({ available: false }) },
  });
  t.after(async () => {
    await runtime.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
  });
  await runtime.ready;
  const address = runtime.server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`,
    bytes = Buffer.from(JSON.stringify({ title: 'Must not save after lease loss' }));
  const pointerPath = resolve(profilePaths(f.root, 'cedar').records, 'head'),
    previous = readFileSync(pointerPath, 'utf8');
  const forwarded = new Promise((done) => runtime.server.once('request', done));
  let pending: ReturnType<typeof request> | undefined;
  const response = new Promise<number | null | undefined>((done) => {
    pending = request(
      origin + '/api/profiles/cedar/notes',
      {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'Content-Length': bytes.length,
        },
      },
      (res) => {
        res.resume();
        done(res.statusCode);
      },
    );
    pending.on('error', () => done(null));
    pending.write(bytes.subarray(0, 5));
  });
  await forwarded;
  assert.ok(lease);
  assert.ok(pending);
  const activeLease = lease;
  assert.ok(activeLease.pid);
  process.kill(activeLease.pid, 'SIGKILL');
  await assert.rejects(activeLease.failure, /lock was lost/);
  assert.equal(runtime.status.ready, false);
  const next = await acquireStorageLock(f.dataDirectory);
  pending.end(bytes.subarray(5));
  assert.notEqual(await response, 201);
  assert.equal(readFileSync(pointerPath, 'utf8'), previous);
  await next.release();
});
