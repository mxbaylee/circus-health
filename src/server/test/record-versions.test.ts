import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, transaction, revision, type Database, type SqliteRow } from '../database.ts';
import { createNote, saveNote, finishNote } from '../notes.ts';
import { setVisibility } from '../visibility.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  queryRecordHistory,
  recordDurabilityStatus,
  type DurableRecordVersion,
  type RecordCommit,
  type RecordObjectReference,
  type RecordStorage,
} from '../record-versions.ts';
import { attachPersonalDurability, exportCuration, personalDurabilityStatus } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';

const profileId = 'cookie-dough';
function fixture(t: TestContext, seed: (db: Database) => void = () => {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-record-versions-'));
  ensureProfileDirectories(root, profileId);
  const opened: Database[] = [],
    objects = new Map<string, Buffer>(),
    writes: Array<{ name: string; bytes: number }> = [];
  const storage: RecordStorage = {
    read(name: string) {
      const value = objects.get(name);
      return value ? Buffer.from(value) : null;
    },
    writeImmutable(name: string, bytes: Uint8Array) {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(bytes));
      writes.push({ name, bytes: bytes.length });
    },
    publishHead(bytes: Uint8Array) {
      objects.set('head', Buffer.from(bytes));
      writes.push({ name: 'head', bytes: bytes.length });
    },
  };
  const open = (name: string): Database => {
    const db = openDatabase(resolve(root, name), profileId);
    opened.push(db);
    return db;
  };
  const db = open('current.sqlite');
  seed(db);
  t.after(() => {
    for (const db of opened)
      try {
        db.close();
      } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db, storage, objects, writes, open };
}
type Fixture = ReturnType<typeof fixture>;
function stored(f: Fixture, name: string): Buffer {
  const bytes = f.storage.read(name);
  assert.ok(bytes);
  return bytes;
}
function head(f: Fixture): RecordObjectReference {
  return JSON.parse(stored(f, 'head').toString('utf8')) as RecordObjectReference;
}
function commit(f: Fixture): RecordCommit {
  return JSON.parse(stored(f, head(f).name).toString('utf8')) as RecordCommit;
}
function history(db: Database, entity: string, id: string, field?: string) {
  return queryRecordHistory(db, { profileId, entity, recordId: id, field }).entries;
}
function logical(db: Database) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => [
      String(row.name),
      db
        .prepare(`SELECT * FROM "${String(row.name)}"`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]);
}
function rebuild(f: Fixture, name = 'rebuilt.sqlite') {
  const path = resolve(f.root, name);
  rebuildRecordDatabase(path, { profileId, storage: f.storage });
  const db = f.open(name);
  attachRecordDurability(db, { profileId, storage: f.storage });
  return db;
}
const errorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as Error & { code?: string }).code === code;
function durability(db: Database) {
  const status = recordDurabilityStatus(db);
  assert.ok(status);
  return status;
}

test('ordinary app edit appends changed records and bounded metadata, no corpus snapshots', (t) => {
  const f = fixture(t, (db) => {
    const insert = db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)');
    for (let i = 0; i < 1500; i++)
      insert.run('fictional-' + i, 'Fictional person ' + i + 'x'.repeat(500));
  });
  attachPersonalDurability(f.db, { root: f.root, profileId, recordStorage: f.storage });
  assert.equal(
    existsSync(resolve(f.root, 'data/profiles', profileId, 'personal/current.json')),
    false,
  );
  const before = f.writes.length;
  transaction(f.db, () =>
    f.db
      .prepare('UPDATE people SET display_name=? WHERE id=?')
      .run('Changed fictional name', 'fictional-1'),
  );
  const tx = commit(f),
    added = f.writes.slice(before).reduce((sum, row) => sum + row.bytes, 0);
  assert.equal(tx.records, 3, 'one person and two bounded revision scalars');
  const versions = Buffer.concat(tx.segments.map((segment) => stored(f, segment.name)))
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as DurableRecordVersion);
  assert.deepEqual(
    versions.map((version) => [version.entity, version.contents.key || version.contents.id]).sort(),
    [
      ['people', 'fictional-1'],
      ['app_meta', 'revision'],
      ['app_meta', 'clinical_review_revision'],
    ].sort(),
  );
  assert.ok(added < 6000, `bounded append was ${added} bytes`);
  assert.equal(history(f.db, 'people', 'fictional-1').length, 2);
  const count = f.writes.length;
  exportCuration(f.db, f.root, profileId);
  assert.equal(f.writes.length, count, 'curation flush creates no full snapshot');
  assert.equal(personalDurabilityStatus(f.db).dirty, false);
});

test('A to B to A birthdays retain full versions, nested field changes and attribution after cache reuse and loss', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  let person = createNote(f.db, {
    kind: 'person',
    title: 'Fictional friend',
    person: { name: 'Fictional friend', birthDate: '1988-04-07', nullable: null },
  });
  person = saveNote(f.db, person.id, {
    ...person,
    person: { ...person.person, birthDate: '1988' },
  });
  const op = {
    operationId: randomUUID(),
    fingerprint: 'birthday-back-to-A',
    expectedRevision: revision(f.db),
    actor: { kind: 'user' },
    origin: 'test-restoration',
    references: { restoredFrom: history(f.db, 'notes', person.id).at(-1)!.versionId },
  };
  transaction(
    f.db,
    () =>
      f.db
        .prepare('UPDATE notes SET profile_json=?,version=version+1 WHERE id=?')
        .run(JSON.stringify({ ...person.person, birthDate: '1988-04-07' }), person.id),
    op,
  );
  const rows = history(f.db, 'notes', person.id, 'profile_json.birthDate');
  assert.deepEqual(
    rows.map(
      (row) => (JSON.parse(String(row.contents.profile_json)) as { birthDate: string }).birthDate,
    ),
    ['1988-04-07', '1988', '1988-04-07'],
  );
  assert.deepEqual(rows[0]!.actor, { kind: 'user' });
  assert.equal(rows[0]!.origin, 'test-restoration');
  assert.equal(rows[0]!.previousVersion, rows[1]!.versionId);
  assert.deepEqual(rows[0]!.changes.find((c) => c.field === 'profile_json.birthDate')?.before, {
    present: true,
    value: '1988',
  });
  assert.ok(rows.every((row) => Number.isFinite(Date.parse(row.recordedAt))));
  const before = f.writes.length;
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  assert.equal(f.writes.length, before);
  const rebuilt = rebuild(f);
  assert.deepEqual(history(rebuilt, 'notes', person.id, 'profile_json.birthDate'), rows);
  assert.deepEqual(logical(rebuilt), logical(f.db));
  const oldRead = f.storage.read;
  f.storage.read = () => {
    throw new Error('history must use SQLite');
  };
  assert.deepEqual(history(rebuilt, 'notes', person.id, 'profile_json.birthDate'), rows);
  f.storage.read = oldRead;
});

test('operation retries are idempotent across reconstruction and stale revisions fail', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  const op = { operationId: randomUUID(), fingerprint: 'set-fictional-name', expectedRevision: 0 };
  let calls = 0;
  const fn = () => {
    calls++;
    f.db.prepare("UPDATE people SET display_name='Fictional result' WHERE id='patient'").run();
    return { saved: 'Fictional result' };
  };
  const result = transaction(f.db, fn, op),
    seq = durability(f.db).sequence;
  assert.deepEqual(transaction(f.db, fn, op), result);
  assert.equal(calls, 1);
  assert.equal(durability(f.db).sequence, seq);
  assert.throws(
    () => transaction(f.db, fn, { ...op, fingerprint: 'different request' }),
    (e) => errorCode(e, 'OPERATION_CONFLICT'),
  );
  assert.throws(
    () => transaction(f.db, fn, { expectedRevision: 0 }),
    (e) => errorCode(e, 'VERSION_CONFLICT'),
  );
  const rebuilt = rebuild(f);
  assert.deepEqual(
    transaction(
      rebuilt,
      () => {
        throw new Error('retried mutation must not run');
      },
      op,
    ),
    result,
  );
});

test('unpublished segments remain unaccepted and partial committed transactions fail closed', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  const originalHead = f.storage.read('head'),
    publish = f.storage.publishHead;
  f.storage.publishHead = () => {
    throw new Error('publication interrupted');
  };
  assert.throws(
    () =>
      transaction(f.db, () => {
        f.db.prepare("UPDATE people SET display_name='Unaccepted' WHERE id='patient'").run();
        f.db
          .prepare("INSERT INTO people(id,display_name) VALUES('second','Unaccepted second')")
          .run();
      }),
    /interrupted/,
  );
  assert.equal(
    f.db.prepare("SELECT display_name FROM people WHERE id='patient'").get()?.display_name,
    'Cookie Dough',
  );
  assert.equal(f.db.prepare("SELECT 1 FROM people WHERE id='second'").get(), undefined);
  assert.deepEqual(f.storage.read('head'), originalHead);
  f.storage.publishHead = publish;
  const rebuilt = rebuild(f);
  assert.equal(revision(rebuilt), 0);
  transaction(f.db, () =>
    f.db.prepare("UPDATE people SET display_name='Accepted' WHERE id='patient'").run(),
  );
  const accepted = commit(f),
    segment = accepted.segments[0]!;
  f.objects.set(segment.name, stored(f, segment.name).subarray(0, 20));
  assert.throws(() => rebuild(f, 'corrupt.sqlite'), /partial or corrupt/);
  assert.equal(existsSync(resolve(f.root, 'corrupt.sqlite')), false);
});

test('accepted head survives SQLite rollback and catches up all records atomically', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  const publish = f.storage.publishHead;
  f.storage.publishHead = (bytes) => {
    publish(bytes);
    throw new Error('simulated crash after durable commit');
  };
  const op = {
    operationId: randomUUID(),
    fingerprint: 'atomic fictional pair',
    expectedRevision: 0,
  };
  assert.throws(
    () =>
      transaction(
        f.db,
        () => {
          f.db.prepare("UPDATE people SET display_name='Accepted first' WHERE id='patient'").run();
          f.db
            .prepare("INSERT INTO people(id,display_name) VALUES('second','Accepted second')")
            .run();
          return 'accepted pair';
        },
        op,
      ),
    /simulated crash/,
  );
  assert.equal(revision(f.db), 0);
  assert.equal(f.db.prepare("SELECT 1 FROM people WHERE id='second'").get(), undefined);
  assert.throws(() => transaction(f.db, () => {}), /cache is behind/);
  f.storage.publishHead = publish;
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  assert.equal(revision(f.db), 1);
  assert.equal(
    f.db.prepare("SELECT display_name FROM people WHERE id='second'").get()?.display_name,
    'Accepted second',
  );
  assert.equal(
    transaction(
      f.db,
      () => {
        throw new Error('must replay');
      },
      op,
    ),
    'accepted pair',
  );
  assert.deepEqual(logical(rebuild(f)), logical(f.db));
});

test('removed and re-added associations and archive states remain in history; finished notes stay immutable', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  let note = createNote(f.db, {
    title: 'Fictional entry',
    links: [{ targetType: 'person', targetId: 'patient' }],
  });
  const link = f.db.prepare('SELECT * FROM note_links WHERE note_id=?').get(note.id) as
    | (SqliteRow & {
        id: string;
        note_id: string;
        target_type: string;
        target_id: string;
        relation: string;
      })
    | undefined;
  assert.ok(link);
  transaction(f.db, () => f.db.prepare('DELETE FROM note_links WHERE id=?').run(link.id));
  transaction(f.db, () =>
    f.db
      .prepare(
        'INSERT INTO note_links(id,note_id,target_type,target_id,relation) VALUES(?,?,?,?,?)',
      )
      .run(link.id, link.note_id, link.target_type, link.target_id, link.relation),
  );
  assert.deepEqual(
    history(f.db, 'note_links', link.id).map((row) => row.deleted),
    [false, true, false],
  );
  const archived = setVisibility(f.db, 'note', note.id, { archived: true, version: 0 });
  assert.equal(
    history(f.db, 'visibility_events', archived.history[0]!.id)[0]?.contents.archived,
    1,
  );
  let finished = createNote(f.db, { kind: 'historical', title: 'Fictional finished' });
  finished = finishNote(f.db, finished.id, finished);
  const before = durability(f.db).sequence;
  assert.throws(
    () =>
      transaction(f.db, () =>
        f.db.prepare('UPDATE notes SET title=? WHERE id=?').run('Blocked', finished.id),
      ),
    /Finished notes/,
  );
  assert.equal(durability(f.db).sequence, before);
  assert.deepEqual(logical(rebuild(f)), logical(f.db));
});

test('wrong profile, unsupported schema, missing commit, and forged previous-version references are rejected', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  assert.throws(
    () => queryRecordHistory(f.db, { profileId: 'other', entity: 'people', recordId: 'patient' }),
    /unlocked owning profile/,
  );
  const original = new Map([...f.objects].map(([key, value]) => [key, Buffer.from(value)]));
  const rewrite = (ref: RecordObjectReference, value: unknown): RecordObjectReference => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    f.objects.set(ref.name, bytes);
    return {
      ...ref,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  };
  for (const mutation of [
    (tx: RecordCommit) => {
      tx.profileId = 'other';
    },
    (tx: RecordCommit) => {
      tx.schemaVersion = 999;
    },
    (tx: RecordCommit) => {
      tx.sequence = 3;
    },
  ]) {
    const tx = commit(f);
    mutation(tx);
    f.objects.set('head', Buffer.from(JSON.stringify(rewrite(head(f), tx))));
    assert.throws(() => rebuild(f, 'bad.sqlite'), /Record journal/);
    f.objects.clear();
    for (const [key, value] of original) f.objects.set(key, value);
  }
  const tx = commit(f),
    segment = tx.segments[0]!,
    bytes = stored(f, segment.name),
    versions = bytes
      .toString()
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as DurableRecordVersion);
  versions[0]!.previousVersion = randomUUID();
  const altered = Buffer.from(versions.map((row) => JSON.stringify(row)).join('\n') + '\n');
  f.objects.set(segment.name, altered);
  tx.segments[0] = {
    ...tx.segments[0],
    bytes: altered.length,
    sha256: createHash('sha256').update(altered).digest('hex'),
  };
  f.objects.set('head', Buffer.from(JSON.stringify(rewrite(head(f), tx))));
  assert.throws(() => rebuild(f, 'bad.sqlite'), /previous-version/);
});

test('large complete UTF-8 records span bounded segments and reconstruct exactly', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage, segmentBytes: 1024 });
  const content = 'Fictional 💜 '.repeat(15000),
    note = createNote(f.db, { title: 'Large fictional note', content });
  const tx = commit(f);
  assert.ok(tx.segments.length > 100);
  assert.ok(tx.segments.every((ref) => ref.bytes <= 1024));
  assert.equal(history(rebuild(f), 'notes', note.id)[0]?.contents.content, content);
});

test('absent versus null and equal-value accepted edits retain their distinct versions', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  let person = createNote(f.db, {
    kind: 'person',
    title: 'Fictional',
    person: { name: 'Fictional' },
  });
  person = saveNote(f.db, person.id, { ...person, person: { ...person.person, birthDate: null } });
  person = saveNote(f.db, person.id, { ...person, person: { name: 'Fictional' } });
  const entries = history(f.db, 'notes', person.id, 'profile_json.birthDate');
  assert.deepEqual(
    entries.map((entry) => entry.changes.find((c) => c.field === 'profile_json.birthDate')?.after),
    [{ present: false }, { present: true, value: null }],
  );
  const before = history(f.db, 'people', 'patient').length;
  transaction(f.db, () =>
    f.db.prepare("UPDATE people SET display_name=display_name WHERE id='patient'").run(),
  );
  assert.equal(history(f.db, 'people', 'patient').length, before + 1);
  assert.deepEqual(history(rebuild(f), 'notes', person.id, 'profile_json.birthDate'), entries);
});

test('direct SQL bypass is rejected repeatedly, and referenced-object verification precedes acceptance', (t) => {
  const f = fixture(t);
  let reject = false;
  attachRecordDurability(f.db, {
    profileId,
    storage: f.storage,
    verifyReferences() {
      if (reject) throw new Error('Missing fictional original');
    },
  });
  const before = head(f);
  reject = true;
  assert.throws(() => createNote(f.db, { title: 'Must roll back' }), /Missing fictional original/);
  assert.deepEqual(head(f), before);
  reject = false;
  f.db.prepare("UPDATE people SET display_name='Bypassed' WHERE id='patient'").run();
  for (let i = 0; i < 2; i++)
    assert.throws(() => transaction(f.db, () => {}), /direct writes bypassed/);
});

test('in-app source intake appends literal source records and occurrences and reconstructs without snapshots', async (t) => {
  const { uploadIntake, importIntake, getIntakeOriginal, intakeDurability } =
    await import('../intake.ts');
  const f = fixture(t, (db) =>
    db.prepare("INSERT INTO providers VALUES('fictional-issuer','Fictional issuer')").run(),
  );
  attachPersonalDurability(f.db, { root: f.root, profileId, recordStorage: f.storage });
  const raw =
    '{"format":"health-record-v1","id":"fictional-1","kind":"record","payload":{"value":1.000,"date":"2026-09"},"provenance":{"capturedVia":"Fictional fixture","sourceSystem":null,"sourceRecordId":null,"evidenceClass":"health_response","locator":"response/0"},"coverage":{"status":"unknown","notes":[]}}';
  const bytes = Buffer.from(raw + '\n' + raw + '\n');
  const uploaded = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional.jsonl',
    providerId: 'fictional-issuer',
    bytes,
  });
  const intake = importIntake(f.db, f.root, profileId, uploaded.id, { version: uploaded.version });
  assert.equal(intake.imported?.records, 2);
  assert.equal(intakeDurability(f.db).pending, false);
  assert.deepEqual(getIntakeOriginal(f.db, f.root, profileId, intake.id).bytes, bytes);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM source_records').get()?.n, 2);
  assert.ok(
    f.db
      .prepare('SELECT raw_json FROM source_records')
      .all()
      .every((row) => row.raw_json === raw),
  );
  const rebuilt = rebuild(f);
  assert.equal(intakeDurability(rebuilt).pending, false);
  assert.deepEqual(logical(rebuilt), logical(f.db));
  assert.equal(
    existsSync(resolve(f.root, 'data/profiles', profileId, 'curation/current.json')),
    false,
  );
});
