import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createEncryptedProfiles } from '../encrypted-profiles.ts';
import { createNote, getNote, saveNote } from '../notes.ts';
import { startRuntime } from '../runtime.ts';
import { acquireStorageLock } from '../storage-lock.ts';
import { decryptObject, encryptObject, recoveryEntropy, unwrapKey } from '../vault-crypto.ts';
import {
  queryRecordHistory,
  iterateRecordCommitSegments,
  type RecordObjectReference,
} from '../record-versions.ts';
import { createTestRuntimeDirectory } from './runtime-fixture.ts';
import { newProfile } from './helpers/vault-fixture.ts';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function inventory(directory: string, authorityOnly = false): unknown[] {
  const result: unknown[] = [];
  function visit(relative = '') {
    const path = resolve(directory, relative);
    const stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) {
      result.push([relative, 'directory']);
      for (const name of readdirSync(path).sort()) {
        if (
          authorityOnly &&
          (['cache', 'diagnostics'].includes(name) || name.startsWith('.health-writer'))
        )
          continue;
        visit(relative ? `${relative}/${name}` : name);
      }
    } else {
      assert.ok(stat.isFile());
      result.push([relative, stat.size, digest(readFileSync(path))]);
    }
  }
  visit();
  return result;
}

async function fixture(t: TestContext) {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-release-refusal-'));
  const source = resolve(base, 'source/data');
  mkdirSync(source, { recursive: true, mode: 0o700 });
  const runtimeDirectory = createTestRuntimeDirectory();
  const lease = await acquireStorageLock(source);
  const manager = createEncryptedProfiles({ dataDirectory: source, runtimeDirectory });
  const setup = await newProfile(manager, 'Fictional release refusal person');
  const state = manager.opened.get(setup.profileId)!;
  const note = createNote(state.db, { title: 'Fictional retained note', content: 'Before' });
  const original = getNote(state.db, note.id);
  saveNote(state.db, note.id, { ...original, content: 'Accepted correction' });
  state.vault.storeFile(
    'sources/fictional.txt',
    Buffer.from('Independently fictional retained original.'),
  );
  state.vault.publish();
  const history = queryRecordHistory(state.db, {
    profileId: setup.profileId,
    entity: 'notes',
    recordId: note.id,
  });
  manager.close();
  await lease.release();
  const protectedSource = inventory(source);
  const runtimes: Awaited<ReturnType<typeof startRuntime>>[] = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    assert.deepEqual(inventory(source), protectedSource, 'the pre-update source stays untouched');
    rmSync(runtimeDirectory, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });
  function copy(name: string) {
    const data = resolve(base, name, 'data');
    cpSync(source, data, { recursive: true, preserveTimestamps: true });
    chmodSync(resolve(base, name), 0o700);
    return data;
  }
  async function start(dataDirectory: string) {
    const runtime = await startRuntime({
      dataDirectory,
      runtimeDirectory,
      host: '127.0.0.1',
      port: 0,
      assistantOptions: { availability: async () => ({ available: false }) },
    });
    runtimes.push(runtime);
    const origin = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    let cookie = '';
    return {
      runtime,
      async request(path: string, input?: unknown) {
        const response = await fetch(origin + path, {
          method: input === undefined ? 'GET' : 'POST',
          headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        });
        cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
        return { status: response.status, body: await response.json() };
      },
    };
  }
  const prefix = `/api/profiles/${setup.profileId}`;
  return { base, source, copy, start, setup, prefix, history, note };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function mutateEncrypted(
  f: Fixture,
  data: string,
  mutation: (io: {
    read: (name: string, purpose: string) => Buffer;
    write: (name: string, purpose: string, bytes: Buffer) => void;
  }) => void,
) {
  const directory = resolve(data, 'profiles', f.setup.profileId);
  const ring = JSON.parse(readFileSync(resolve(directory, 'keyring.json'), 'utf8'));
  const secret = recoveryEntropy(f.setup.recoveryKit, f.setup.profileId);
  const key = unwrapKey(ring.recovery, secret, f.setup.profileId);
  secret.fill(0);
  try {
    mutation({
      read: (name, purpose) =>
        decryptObject(resolve(directory, name), key, f.setup.profileId, purpose),
      write: (name, purpose, bytes) =>
        encryptObject(resolve(directory, name), bytes, key, f.setup.profileId, purpose),
    });
  } finally {
    key.fill(0);
  }
}
function changeJson(path: string, change: (value: any) => void) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  change(value);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

test('candidate startup refuses a future registry and failed startup preserves complete protected copies', async (t) => {
  const f = await fixture(t);
  for (const kind of ['future-registry', 'missing-registry']) {
    const data = f.copy(kind);
    const registry = resolve(data, 'profiles.json');
    if (kind === 'future-registry')
      changeJson(registry, (value) => {
        value.format = 'circus-health-profiles-v999';
      });
    else rmSync(registry);
    const before = inventory(data);
    await assert.rejects(
      f.start(data),
      /Archive registry.*(?:unsupported|missing).*Preserve.*(?:compatible app release|restore a complete backup)/,
    );
    assert.deepEqual(inventory(data), before);
    const lease = await acquireStorageLock(data);
    await lease.release();
  }
});

test('candidate unlock refuses future key, encrypted index and accepted-history formats without any archive writes', async (t) => {
  const f = await fixture(t);
  for (const kind of [
    'keyring',
    'wrapped-key',
    'head',
    'index',
    'record-commit',
    'record-commit-matching-cache',
    'record-schema',
    'record-schema-incompatible-cache',
    'record-version',
    'eager-framing',
    'deferred-framing',
  ]) {
    const data = f.copy(kind);
    const directory = resolve(data, 'profiles', f.setup.profileId);
    if (kind === 'keyring' || kind === 'wrapped-key') {
      changeJson(resolve(directory, 'keyring.json'), (ring) => {
        if (kind === 'keyring') ring.format = 'circus-health-keyring-v999';
        else ring.recovery.algorithm = 'future-key-algorithm';
      });
    } else {
      mutateEncrypted(f, data, ({ read, write }) => {
        const head = JSON.parse(read('vault/manifest.enc', 'manifest').toString());
        if (kind === 'eager-framing' || kind === 'deferred-framing') {
          let ref = head.indexTip;
          let objectId: string | undefined;
          while (ref && !objectId) {
            const generation = JSON.parse(
              read(`vault/indices/${ref.id}.enc`, `index:${ref.id}`).toString(),
            );
            objectId = generation.files.find(
              ([name]: [string, string]) =>
                name === (kind === 'eager-framing' ? 'setup.json' : 'sources/fictional.txt'),
            )?.[1];
            ref = generation.previous;
          }
          assert.ok(objectId);
          const path = resolve(directory, 'vault/objects', objectId + '.enc');
          const bytes = readFileSync(path);
          Buffer.from('CIRCUS99').copy(bytes);
          writeFileSync(path, bytes);
          return;
        } else if (kind === 'head') head.format = 'circus-health-vault-head-v999';
        else if (kind === 'index') {
          const name = `vault/indices/${head.indexTip.id}.enc`;
          const purpose = `index:${head.indexTip.id}`;
          const generation = JSON.parse(read(name, purpose).toString());
          generation.format = 'circus-health-vault-index-delta-v999';
          const bytes = Buffer.from(JSON.stringify(generation));
          head.usage.bytes += bytes.length - head.indexTip.bytes;
          head.indexTip.bytes = bytes.length;
          head.indexTip.sha256 = digest(bytes);
          write(name, purpose, bytes);
        } else {
          // Propagate every content hash/length to the selected head. The cache
          // retains its prior accepted head, as after a legitimate newer writer.
          const ref: RecordObjectReference = JSON.parse(
            Buffer.from(head.recordsHead, 'base64').toString(),
          );
          const commitName = `vault/versions/${ref.name.slice(8)}.enc`;
          const commit = JSON.parse(read(commitName, `record:${ref.name}`).toString());
          if (kind.startsWith('record-commit')) commit.format = 'health-record-versions-v999';
          else if (kind.startsWith('record-schema')) commit.schemaVersion = 999999;
          else {
            commit.segments = [
              ...iterateRecordCommitSegments(
                {
                  read: (name) =>
                    read('vault/versions/' + name.slice(8) + '.enc', 'record:' + name),
                  writeImmutable() {
                    throw Error('read-only fixture');
                  },
                  publishHead() {
                    throw Error('read-only fixture');
                  },
                },
                commit,
              ),
            ];
            commit.format = 'health-record-versions-v1';
            const segment = commit.segments[0];
            const name = `vault/versions/${segment.name.slice(8)}.enc`;
            const lines = read(name, `record:${segment.name}`).toString().trimEnd().split('\n');
            const version = JSON.parse(lines[0]);
            version.format = 'health-record-versions-v999';
            lines[0] = JSON.stringify(version);
            const bytes = Buffer.from(lines.join('\n') + '\n');
            segment.bytes = bytes.length;
            segment.sha256 = digest(bytes);
            write(name, `record:${segment.name}`, bytes);
            // Require reconstruction to inspect complete accepted versions.
            rmSync(resolve(directory, 'cache'), { recursive: true });
          }
          const bytes = Buffer.from(JSON.stringify(commit));
          ref.bytes = bytes.length;
          ref.sha256 = digest(bytes);
          write(commitName, `record:${ref.name}`, bytes);
          head.recordsHead = Buffer.from(JSON.stringify(ref)).toString('base64');
          if (kind === 'record-commit-matching-cache') {
            // Model a newer writer retaining the same SQLite schema while
            // publishing its new envelope format and a matching encrypted cache.
            const path = resolve(f.base, 'future-writer-cache.sqlite');
            writeFileSync(path, read('cache/sqlite.enc', 'sqlite-cache'), { mode: 0o600 });
            const cache = new DatabaseSync(path);
            try {
              cache
                .prepare('UPDATE __record_state SET head_json=? WHERE singleton=1')
                .run(JSON.stringify(ref));
              cache
                .prepare('UPDATE __record_transactions SET commit_json=? WHERE sequence=?')
                .run(JSON.stringify(commit), commit.sequence);
              cache.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            } finally {
              cache.close();
            }
            write('cache/sqlite.enc', 'sqlite-cache', readFileSync(path));
            rmSync(path);
          } else if (kind === 'record-schema-incompatible-cache') {
            write(
              'cache/metadata.enc',
              'sqlite-cache-meta',
              Buffer.from(JSON.stringify({ schemaVersion: 999999 })),
            );
          }
        }
        write('vault/manifest.enc', 'manifest', Buffer.from(JSON.stringify(head)));
      });
    }
    const before = inventory(data);
    const app = await f.start(data);
    assert.equal(
      (await app.request('/health/ready')).status,
      200,
      'readiness covers locked public startup',
    );
    const response = await app.request(f.prefix + '/unlock', { recovery: f.setup.recoveryKit });
    assert.equal(response.status, 409, kind);
    assert.equal(response.body.error.code, 'ARCHIVE_UNSUPPORTED');
    assert.match(
      response.body.error.message,
      /Profile (?:keyring|encrypted index or manifest|accepted record history|encrypted object format)/,
    );
    assert.match(
      response.body.error.message,
      /Preserve this archive and use a compatible app release/,
    );
    assert.equal((await app.request(f.prefix + '/notes')).status, 423);
    await app.runtime.close();
    assert.deepEqual(inventory(data), before, kind);
  }
});

test('incompatible cache rebuilds supported authority and the actual runtime excludes a second writer', async (t) => {
  const f = await fixture(t);
  const data = f.copy('cache-rebuild');
  mutateEncrypted(f, data, ({ write }) => {
    write(
      'cache/metadata.enc',
      'sqlite-cache-meta',
      Buffer.from(JSON.stringify({ schemaVersion: 999999 })),
    );
  });
  const before = inventory(data, true);
  const app = await f.start(data);
  await assert.rejects(f.start(data), /active writer/);
  const response = await app.request(f.prefix + '/unlock', { recovery: f.setup.recoveryKit });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.metrics.cacheHit, false);
  const note = await app.request(f.prefix + '/notes/' + f.note.id);
  assert.equal(note.status, 200);
  assert.equal(note.body.data.content, 'Accepted correction');
  await app.runtime.close();
  assert.deepEqual(inventory(data, true), before);
  // Reopen through the manager to compare complete accepted history, not counts.
  const lease = await acquireStorageLock(data);
  const manager = createEncryptedProfiles({
    dataDirectory: data,
    runtimeDirectory: resolve(f.base, 'verification'),
  });
  try {
    manager.unlock(f.setup.profileId, f.setup.recoveryKit);
    assert.deepEqual(
      queryRecordHistory(manager.opened.get(f.setup.profileId)!.db, {
        profileId: f.setup.profileId,
        entity: 'notes',
        recordId: f.note.id,
      }),
      f.history,
    );
  } finally {
    manager.close();
    await lease.release();
  }
  assert.deepEqual(inventory(data, true), before);
});

test('authenticated old history projection rebuilds accepted state but cannot rescue invalid authority', async (t) => {
  const f = await fixture(t);
  const oldProjection = (data: string) =>
    mutateEncrypted(f, data, ({ read, write }) => {
      const path = resolve(f.base, 'old-projection.sqlite');
      writeFileSync(path, read('cache/sqlite.enc', 'sqlite-cache'), { mode: 0o600 });
      try {
        const cache = new DatabaseSync(path);
        try {
          cache.prepare('UPDATE __record_state SET projection=2 WHERE singleton=1').run();
          cache.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } finally {
          cache.close();
        }
        write('cache/sqlite.enc', 'sqlite-cache', readFileSync(path));
      } finally {
        rmSync(path, { force: true });
      }
    });

  const data = f.copy('old-projection');
  oldProjection(data);
  const before = inventory(data, true);
  const app = await f.start(data);
  const unlocked = await app.request(f.prefix + '/unlock', { recovery: f.setup.recoveryKit });
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.body.data.metrics.cacheHit, false);
  const note = await app.request(f.prefix + '/notes/' + f.note.id);
  assert.equal(note.status, 200);
  assert.equal(note.body.data.content, 'Accepted correction');
  await app.runtime.close();
  assert.deepEqual(inventory(data, true), before);

  const lease = await acquireStorageLock(data);
  const manager = createEncryptedProfiles({
    dataDirectory: data,
    runtimeDirectory: resolve(f.base, 'old-projection-verification'),
  });
  try {
    manager.unlock(f.setup.profileId, f.setup.recoveryKit);
    assert.deepEqual(
      queryRecordHistory(manager.opened.get(f.setup.profileId)!.db, {
        profileId: f.setup.profileId,
        entity: 'notes',
        recordId: f.note.id,
      }),
      f.history,
    );
  } finally {
    manager.close();
    await lease.release();
  }
  assert.deepEqual(inventory(data, true), before);

  const invalid = f.copy('old-projection-invalid-authority');
  oldProjection(invalid);
  mutateEncrypted(f, invalid, ({ read, write }) => {
    const head = JSON.parse(read('vault/manifest.enc', 'manifest').toString());
    head.recordsHead = Buffer.from('{}').toString('base64');
    write('vault/manifest.enc', 'manifest', Buffer.from(JSON.stringify(head)));
  });
  const invalidBefore = inventory(invalid);
  const refused = await f.start(invalid);
  const response = await refused.request(f.prefix + '/unlock', {
    recovery: f.setup.recoveryKit,
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'ARCHIVE_UNSUPPORTED');
  assert.match(response.body.error.message, /Profile accepted record history/);
  await refused.runtime.close();
  assert.deepEqual(inventory(invalid), invalidBefore);
});
