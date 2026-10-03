import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { openDatabase, revision, transaction, type Database } from '../database.ts';
import { hash } from '../assets.ts';
import { createNote } from '../notes.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  queryRecordHistory,
  type RecordStorage,
} from '../record-versions.ts';
import {
  attachPersonalDurability,
  exportCuration,
  rebuildProfile,
  loadPortable,
} from '../portable.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { newProfile, vaultFixture } from './helpers/vault-fixture.ts';
import {
  packetPreferenceKey,
  readPacketPreference,
  readPacketPreferences,
  writePacketPreference,
  type PacketPreferenceInput,
} from '../packet-preferences.ts';

const profileId = 'cedar';
const ref = { kind: 'note', recordId: 'note-a' };
const request = (overrides: Partial<PacketPreferenceInput> = {}): PacketPreferenceInput => ({
  record: ref,
  alwaysWithhold: true,
  tags: ['personally chosen'],
  expectedVersion: 0,
  ...overrides,
});

test('clinical and recovery modules initialize independently in fresh processes', () => {
  for (const entry of ['clinical-references', 'record-owner', 'portable', 'packet-preferences']) {
    const url = new URL(`../${entry}.ts`, import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`],
      { encoding: 'utf8' },
    );
    assert.equal(result.error, undefined, `${entry}: ${result.error?.message}`);
    assert.equal(result.status, 0, `${entry} cold import failed:\n${result.stderr}`);
  }
});

function seed(db: Database, root: string, count = 3) {
  const original = Buffer.from('{"fictional":"retained exact source"}');
  const path = `data/profiles/${profileId}/sources/fictional.json`;
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), original);
  db.prepare('INSERT INTO source_files(id,path,sha256,bytes) VALUES(?,?,?,?)').run(
    'file',
    path,
    hash(original),
    original.length,
  );
  db.exec(
    "INSERT INTO people(id,display_name) VALUES('relative','Fictional relative'); INSERT INTO test_types(id,label) VALUES('test','Fictional reading')",
  );
  db.prepare(
    "INSERT INTO source_records(id,source_file_id,raw_json) VALUES('source','file',?)",
  ).run(original.toString());
  db.exec(
    "INSERT INTO observations(id,test_type_id,source_record_id,label,value_text) VALUES('reading','test','source','Fictional reading','10'); INSERT INTO procedures(id,source_record_id,label) VALUES('destination','source','Fictional procedure')",
  );
  const insert = db.prepare(
    "INSERT INTO notes(id,kind,status,title,content,profile_json,created_at,updated_at) VALUES(?,'note','editable',?,'Fictional complete private text',?,'2026-01-01','2026-01-01')",
  );
  for (let i = 0; i < count; i++)
    insert.run(
      i === 0 ? 'note-a' : `note-${i}`,
      `Fictional note ${i}`,
      JSON.stringify(i === 1 ? { recordOwnerPersonId: 'relative' } : {}),
    );
}
function fixture(t: TestContext, count = 3) {
  const root = mkdtempSync(resolve(tmpdir(), 'packet-preferences-'));
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  seed(db, root, count);
  const opened: Database[] = [db];
  t.after(() => {
    for (const db of opened) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const objects = new Map<string, Buffer>();
  const writes: Array<{ name: string; bytes: number }> = [];
  const storage: RecordStorage = {
    read: (name) => objects.get(name) ?? null,
    writeImmutable(name, bytes) {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(bytes));
      writes.push({ name, bytes: bytes.length });
    },
    publishHead(bytes) {
      objects.set('head', Buffer.from(bytes));
      writes.push({ name: 'head', bytes: bytes.length });
    },
  };
  const attach = () => attachRecordDurability(db, { profileId, storage });
  const open = (path: string) => {
    const value = openDatabase(path, profileId);
    opened.push(value);
    return value;
  };
  return { root, paths, db, writes, storage, attach, open };
}
function clinical(db: Database) {
  return ['notes', 'observations', 'procedures', 'source_records', 'source_files', 'evidence'].map(
    (table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
  );
}

function countPreferenceReads(db: Database) {
  const original = db.prepare.bind(db);
  const counts = { queries: 0, rows: 0, inventories: 0 };
  Object.defineProperty(db, 'prepare', {
    configurable: true,
    value: (sql: string) => {
      const statement = original(sql);
      return new Proxy(statement, {
        get(target, key) {
          const method = Reflect.get(target, key);
          if (typeof method !== 'function') return method;
          return (...args: unknown[]) => {
            const result = Reflect.apply(method, target, args);
            if (
              (key === 'get' || key === 'all') &&
              sql.startsWith('SELECT') &&
              sql.includes('FROM app_meta') &&
              args.some((arg) => typeof arg === 'string' && arg.startsWith('packet_preference:'))
            ) {
              counts.queries++;
              counts.rows += Array.isArray(result) ? result.length : result === undefined ? 0 : 1;
              if (key === 'all') counts.inventories++;
            }
            return result;
          };
        },
      });
    },
  });
  return {
    counts,
    reset() {
      counts.queries = 0;
      counts.rows = 0;
      counts.inventories = 0;
    },
    restore() {
      Object.defineProperty(db, 'prepare', { configurable: true, value: original });
    },
  };
}

test('bounded manual preferences preserve clinical evidence, enforce person scope and support no-op, retry and stale checks', (t) => {
  const f = fixture(t);
  f.attach();
  const before = clinical(f.db);
  const initialWrites = f.writes.length;
  assert.equal(readPacketPreference(f.db, 'patient', ref).version, 0);
  writePacketPreference(f.db, 'patient', request({ alwaysWithhold: false, tags: [] }));
  assert.equal(f.writes.length, initialWrites);
  const operationId = randomUUID();
  const input = request({ operationId, tags: ['z', ' a ', 'z'] });
  const saved = writePacketPreference(f.db, 'patient', input);
  assert.deepEqual(saved.tags, ['a', 'z']);
  assert.equal(saved.version, 1);
  assert.equal(saved.actor, 'profile-user');
  assert.ok(saved.updatedAt);
  const checkpoint = [f.writes.length, revision(f.db)];
  assert.deepEqual(writePacketPreference(f.db, 'patient', input), saved);
  assert.deepEqual(
    writePacketPreference(f.db, 'patient', request({ tags: ['a', 'z'], expectedVersion: 1 })),
    saved,
  );
  assert.deepEqual([f.writes.length, revision(f.db)], checkpoint);
  assert.throws(() => writePacketPreference(f.db, 'patient', request()), {
    code: 'VERSION_CONFLICT',
  });
  assert.throws(
    () =>
      writePacketPreference(
        f.db,
        'patient',
        request({ operationId, expectedVersion: 1, tags: ['a', 'z'] }),
      ),
    { code: 'OPERATION_CONFLICT' },
  );
  assert.throws(() => readPacketPreference(f.db, 'relative', ref), { status: 404 });
  assert.throws(() => writePacketPreference(f.db, 'relative', request()), { status: 404 });
  assert.deepEqual(readPacketPreferences(f.db, 'relative'), []);
  for (const tags of [Array(33).fill('tag'), ['x'.repeat(81)], ['line\nbreak']])
    assert.throws(
      () => writePacketPreference(f.db, 'patient', request({ expectedVersion: 1, tags })),
      { code: 'INVALID_PACKET_PREFERENCE' },
    );
  assert.deepEqual(clinical(f.db), before);
  const history = queryRecordHistory(f.db, {
    profileId,
    entity: 'app_meta',
    recordId: packetPreferenceKey('patient', ref),
  });
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0]!.actor, 'profile-user');
  assert.equal(history.entries[0]!.origin, 'packet-preference');
});

test('source and original preferences require explicit single subject evidence or packet candidate membership', (t) => {
  const f = fixture(t);
  f.attach();
  const source = { kind: 'source', recordId: 'source' };
  const file = { kind: 'source_file', recordId: 'file' };
  assert.throws(() => writePacketPreference(f.db, 'patient', request({ record: source })), {
    status: 404,
  });
  assert.throws(() => writePacketPreference(f.db, 'patient', request({ record: file })), {
    status: 404,
  });
  transaction(f.db, () =>
    f.db.exec(
      "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role) VALUES('owner','person','relative','source','report_subject')",
    ),
  );
  writePacketPreference(f.db, 'relative', request({ record: source }));
  assert.throws(() => readPacketPreference(f.db, 'patient', source), { status: 404 });
  const options = {
    validateMembership: (
      _db: Database,
      person: string,
      record: { kind: string; recordId: string },
    ) => person === 'relative' && record.kind === 'source_file' && record.recordId === 'file',
  };
  writePacketPreference(f.db, 'relative', request({ record: file }), options);
  assert.equal(readPacketPreferences(f.db, 'relative', options).length, 2);
  assert.throws(() => writePacketPreference(f.db, 'patient', request({ record: file }), options), {
    status: 404,
  });
});

test('reclassification and joined ownership identities preserve restrictive choices with usable explicit reconciliation', (t) => {
  const f = fixture(t);
  f.attach();
  const reading = { kind: 'observation', recordId: 'reading' };
  const destination = { kind: 'procedure', recordId: 'destination' };
  writePacketPreference(
    f.db,
    'patient',
    request({ record: reading, tags: ['former owner secret tag'] }),
  );
  writePacketPreference(
    f.db,
    'patient',
    request({ record: destination, alwaysWithhold: false, tags: ['joined tag'] }),
  );
  transaction(f.db, () => {
    f.db.exec(
      "DELETE FROM observations WHERE id='reading'; INSERT INTO procedures(id,source_record_id,label) VALUES('reading','source','Reclassified reading')",
    );
    f.db
      .prepare(
        "INSERT INTO manual_batches(id,title,status,created_at,coverage_json) VALUES('classification','Import record exception','verified','2026-01-01',?)",
      )
      .run(
        JSON.stringify({
          recordException: {
            reclassification: { recordId: 'reading', fromKind: 'observation', toKind: 'procedure' },
            sequence: 1,
          },
        }),
      );
  });
  assert.equal(readPacketPreference(f.db, 'patient', reading).record.kind, 'procedure');
  assert.equal(
    readPacketPreference(f.db, 'patient', { kind: 'procedure', recordId: 'reading' })
      .alwaysWithhold,
    true,
  );
  transaction(f.db, () => {
    f.db.exec("UPDATE procedures SET person_id='relative' WHERE id='destination'");
    f.db
      .prepare(
        "INSERT INTO manual_batches(id,title,status,created_at,coverage_json) VALUES('redirect','Record ownership redirect','verified','2026-01-01',?)",
      )
      .run(
        JSON.stringify({
          recordId: 'reading',
          destinationRecordId: 'destination',
          kind: 'procedure',
          revision: 1,
        }),
      );
  });
  assert.throws(() => readPacketPreference(f.db, 'patient', reading), { status: 404 });
  const inherited = readPacketPreference(f.db, 'relative', reading);
  assert.equal(inherited.alwaysWithhold, true);
  assert.deepEqual(inherited.tags, []);
  assert.equal(inherited.version, 2);
  assert.deepEqual(readPacketPreferences(f.db, 'patient'), []);
  assert.deepEqual(readPacketPreferences(f.db, 'relative'), [inherited]);
  const cleared = writePacketPreference(
    f.db,
    'relative',
    request({
      record: destination,
      expectedVersion: 2,
      alwaysWithhold: false,
      tags: ['new owner choice'],
    }),
  );
  assert.equal(cleared.version, 3);
  assert.equal(cleared.alwaysWithhold, false);
  assert.deepEqual(readPacketPreference(f.db, 'relative', reading), cleared);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM app_meta WHERE key GLOB 'packet_preference:*'").get()!.n,
    1,
  );
  assert.throws(
    () =>
      writePacketPreference(f.db, 'relative', request({ record: destination, expectedVersion: 2 })),
    { code: 'VERSION_CONFLICT' },
  );
});

test('one preference edit writes bounded journal bytes at two corpus sizes and rebuilds from accepted versions', (t) => {
  const samples: number[] = [];
  for (const count of [30, 600]) {
    const f = fixture(t, count);
    f.attach();
    for (let i = 2; i < count; i++)
      writePacketPreference(
        f.db,
        'patient',
        request({ record: { kind: 'note', recordId: `note-${i}` } }),
      );
    writePacketPreference(f.db, 'patient', request());
    const before = clinical(f.db);
    const at = f.writes.length;
    const reads = countPreferenceReads(f.db);
    const saved = writePacketPreference(
      f.db,
      'patient',
      request({ expectedVersion: 1, alwaysWithhold: false }),
    );
    assert.equal(reads.counts.inventories, 0, 'single-record writes never inventory preferences');
    assert.equal(
      reads.counts.queries,
      2,
      'one exact-key lookup before and inside the accepted transaction',
    );
    assert.equal(reads.counts.rows, 2, 'only the changed preference is read');
    reads.reset();
    assert.equal(readPacketPreferences(f.db, 'patient').length, count - 1);
    assert.deepEqual(
      reads.counts,
      { queries: 1, rows: count - 1, inventories: 1 },
      'listing reads one metadata inventory, without per-record rescans',
    );
    reads.restore();
    const bytes = f.writes.slice(at).reduce((sum, write) => sum + write.bytes, 0);
    samples.push(bytes);
    assert.ok(bytes < 8000, `one change at ${count} records wrote ${bytes} bytes`);
    const head = JSON.parse(f.storage.read('head')!.toString());
    const commit = JSON.parse(f.storage.read(head.name)!.toString());
    assert.equal(commit.records, 3, 'one preference and two revision scalars only');
    const target = resolve(f.root, 'rebuilt.sqlite');
    rebuildRecordDatabase(target, { profileId, storage: f.storage });
    const rebuilt = f.open(target);
    attachRecordDurability(rebuilt, { profileId, storage: f.storage });
    assert.deepEqual(readPacketPreference(rebuilt, 'patient', ref), saved);
    assert.deepEqual(clinical(rebuilt), before);
    assert.equal(
      queryRecordHistory(rebuilt, {
        profileId,
        entity: 'app_meta',
        recordId: packetPreferenceKey('patient', ref),
      }).entries.length,
      2,
    );
  }
  assert.ok(
    samples[1]! < samples[0]! * 1.1,
    `journal bytes should not scale with corpus: ${samples.join(', ')}`,
  );
  t.diagnostic(`Changed preference journal bytes at 30 and 600 records: ${samples.join(', ')}`);
});

test('encrypted cache loss retains packet preferences and complete private notes', async (t) => {
  const { manager } = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(manager);
  const state = manager.opened.get(profile.id)!;
  const note = createNote(state.db, {
    title: 'Fictional private note',
    content: 'Retain this complete private history',
  });
  const record = { kind: 'note', recordId: note.id };
  const saved = writePacketPreference(state.db, 'patient', request({ record }));
  const before = state.db.prepare('SELECT * FROM notes ORDER BY id').all();
  manager.lock(profile.id);
  rmSync(resolve(manager.pathFor(profile.id), 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, recoveryKit);
  const recovered = manager.opened.get(profile.id)!;
  assert.equal(recovered.metrics.cacheHit, false);
  assert.deepEqual(readPacketPreference(recovered.db, 'patient', record), saved);
  assert.deepEqual(recovered.db.prepare('SELECT * FROM notes ORDER BY id').all(), before);
});

test('supported accepted-version backup restore retains preferences, originals and evidence', async (t) => {
  const f = fixture(t);
  attachPersonalDurability(f.db, { root: f.root, profileId });
  const saved = writePacketPreference(f.db, 'patient', request());
  const before = clinical(f.db);
  const backup = await createBackup(f.db, f.root, profileId, resolve(f.root, 'backup'));
  const target = resolve(f.root, 'restored');
  restoreBackup(backup.path, target);
  const paths = ensureProfileDirectories(target, profileId);
  const restored = f.open(paths.database);
  attachPersonalDurability(restored, { root: target, profileId, initialize: false });
  assert.deepEqual(readPacketPreference(restored, 'patient', ref), saved);
  assert.deepEqual(clinical(restored), before);
  assert.deepEqual(
    readFileSync(resolve(target, `data/profiles/${profileId}/sources/fictional.json`)),
    readFileSync(resolve(f.root, `data/profiles/${profileId}/sources/fictional.json`)),
  );
});

test('explicit portable snapshot recovery overlays later personal preferences on prior curation', (t) => {
  const f = fixture(t);
  attachPersonalDurability(f.db, { root: f.root, profileId, portableSnapshots: true });
  exportCuration(f.db, f.root, profileId);
  const saved = writePacketPreference(f.db, 'patient', request());
  const loaded = loadPortable(f.root, profileId);
  assert.equal(loaded.personal.value.packetPreferences!.length, 1);
  const result = rebuildProfile(f.root, profileId, resolve(f.root, 'snapshot-rebuilt'));
  const restored = f.open(result.database);
  assert.deepEqual(readPacketPreference(restored, 'patient', ref), saved);
});
