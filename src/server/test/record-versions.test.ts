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
  type RecordCommitV1 as RecordCommit,
  type RecordCommit as StoredRecordCommit,
  type RecordCommitV2,
  iterateRecordCommitSegments,
  type RecordObjectReference,
  type RecordStorage,
} from '../record-versions.ts';
import { attachPersonalDurability, exportCuration, personalDurabilityStatus } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';

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
  const selected = JSON.parse(stored(f, head(f).name).toString('utf8')) as StoredRecordCommit;
  // Fixture-only old-format oracle also exercises retained v1 replay after re-signing mutations.
  return {
    ...selected,
    format: 'health-record-versions-v1',
    segments: [...iterateRecordCommitSegments(f.storage, selected)],
  };
}
function history(db: Database, entity: string, id: string, field?: string) {
  return queryRecordHistory(db, { profileId, entity, recordId: id, field }).entries;
}
function logical(db: Database) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_intake_lookup_*' ORDER BY name",
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

test('record work accounts for actual encoded payloads and independent replay on a temporary connection', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  const work = createRecordVersionWorkCounters();
  const firstWrite = f.writes.length;
  withRecordVersionWork(work, () =>
    transaction(f.db, () => {
      f.db
        .prepare('INSERT INTO people(id,display_name) VALUES(?,?)')
        .run('fictional-metric', 'Fictional Ω');
    }),
  );
  const selected = commit(f);
  assert.equal(
    work.operation.encodedBytes,
    f.writes.slice(firstWrite).reduce((sum, item) => sum + item.bytes, 0),
  );
  assert.equal(
    work.operation.encodeCalls,
    selected.records + work.operation.segmentIndexPagesWritten + 2,
    'each complete version, bounded manifest page, commit and head is encoded once',
  );
  assert.equal(work.operation.indexedVersionAttempts, selected.records);
  assert.equal(work.operation.versionValidations, selected.records);
  assert.equal(work.operation.decodedVersions, selected.records);
  assert.ok(work.operation.hashedBytes > 0);
  assert.ok(work.operation.parsedBytes > 0);
  assert.ok(work.operation.fieldVisits > 0);
  assert.ok(work.operation.headReadBytes > 0);
  assert.equal(work.reconstruction.replayDeleteAttempts, 0);

  const inspected = createRecordVersionWorkCounters();
  const entries = withRecordVersionWork(inspected, () =>
    history(f.db, 'people', 'fictional-metric'),
  );
  assert.equal(entries.length, 1);
  assert.ok(inspected.operation.indexedVersionValidations >= entries.length);
  assert.ok(inspected.operation.validatedColumns > 0);
  assert.equal(
    inspected.operation.versionValidations,
    0,
    'indexed history has its own validation counter',
  );
  assert.equal(
    inspected.operation.objectReadBytes,
    0,
    'indexed history does not reread retained objects',
  );

  // Rebuild owns and closes another connection; a final-connection-only counter
  // would silently omit this verification and all replayed rows.
  const rebuilt = createRecordVersionWorkCounters();
  withRecordVersionWork(rebuilt, () =>
    rebuildRecordDatabase(resolve(f.root, 'work-rebuilt.sqlite'), {
      profileId,
      storage: f.storage,
    }),
  );
  assert.equal(rebuilt.operation.parseCalls, 0);
  assert.ok(rebuilt.reconstruction.replayDeleteAttempts >= selected.records);
  assert.ok(rebuilt.reconstruction.replayInsertAttempts >= selected.records);
  assert.ok(rebuilt.reconstruction.decodedVersions > selected.records);
  assert.ok(rebuilt.reconstruction.validatedColumns > 0);
  assert.equal(
    rebuilt.reconstruction.encodedBytes,
    0,
    'recovery reads retained authority without republishing it',
  );
  const db = f.open('work-rebuilt.sqlite');
  assert.equal(
    db.prepare('SELECT display_name FROM people WHERE id=?').get('fictional-metric')!.display_name,
    'Fictional Ω',
  );
});

test('failed publication retains observed work and async scopes do not charge another operation', async (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  const earlierHead = Buffer.from(f.objects.get('head')!);
  const work = createRecordVersionWorkCounters();
  const other = createRecordVersionWorkCounters();
  const original = f.storage.publishHead;
  f.storage.publishHead = () => {
    throw Error('fictional accounting publication failure');
  };
  try {
    await withRecordVersionWork(work, async () => {
      await Promise.resolve();
      assert.throws(
        () =>
          transaction(f.db, () => {
            f.db
              .prepare('INSERT INTO people(id,display_name) VALUES(?,?)')
              .run('fictional-failed-metric', 'Fictional failure');
          }),
        /fictional accounting publication failure/,
      );
      const before = structuredClone(work);
      await withRecordVersionWork(other, async () => {
        await Promise.resolve();
        assert.equal(recordDurabilityStatus(f.db)!.dirty, false);
      });
      assert.deepEqual(work, before, 'nested instrumentation scope owns its own work');
    });
  } finally {
    f.storage.publishHead = original;
  }
  assert.ok(work.operation.encodedBytes > 0);
  assert.ok(work.operation.hashedBytes > 0);
  assert.ok(other.operation.parsedBytes > 0);
  assert.deepEqual(f.objects.get('head'), earlierHead);
  assert.equal(
    f.db.prepare('SELECT count(*) n FROM people WHERE id=?').get('fictional-failed-metric')!.n,
    0,
  );
  const observed = structuredClone(work);
  recordDurabilityStatus(f.db);
  assert.deepEqual(work, observed, 'work outside the async scope is not attributed');
});

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
  const lookup = await import('../intake-state-access.ts');
  assert.equal(
    lookup.maximumReportDiscoveryOrder(rebuilt),
    lookup.maximumReportDiscoveryOrder(f.db),
  );
  assert.deepEqual(
    lookup.intakeIdentityConfirmations(rebuilt),
    lookup.intakeIdentityConfirmations(f.db),
  );
  assert.equal(
    lookup.retainedReportAcceptance(rebuilt, 'fictional-missing-operation'),
    lookup.retainedReportAcceptance(f.db, 'fictional-missing-operation'),
  );
  assert.equal(
    existsSync(resolve(f.root, 'data/profiles', profileId, 'curation/current.json')),
    false,
  );
});

test('literal condition occurrences require person and source, remain distinct and replay complete versions', (t) => {
  const f = fixture(t);
  f.db.exec(
    "INSERT INTO people(id,display_name) VALUES('relative','Fictional relative'); INSERT INTO source_files(id,path,sha256,bytes) VALUES('file','providers/fictional.json','fictional',0)",
  );
  const fixtures = [
    {
      id: 'problem',
      person: 'patient',
      raw: {
        kind: 'problem-list',
        label: 'Example diagnosis',
        status: 'ACTIVE',
        code: 'F00.001',
        nullable: null,
      },
    },
    {
      id: 'fhir',
      person: 'patient',
      raw: {
        resourceType: 'Condition',
        code: { text: 'Example diagnosis' },
        clinicalStatus: { text: 'provider wording' },
      },
    },
    {
      id: 'visit',
      person: 'patient',
      raw: { kind: 'visit-summary', diagnosis: 'Example diagnosis', date: '2020-04' },
    },
    {
      id: 'relative',
      person: 'relative',
      raw: { diagnosis: 'Example diagnosis', status: 'resolved?' },
    },
  ];
  for (const row of fixtures)
    f.db
      .prepare('INSERT INTO source_records(id,source_file_id,kind,raw_json) VALUES(?,?,?,?)')
      .run(row.id, 'file', 'clinical_object', JSON.stringify(row.raw));
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  const originals = f.db.prepare('SELECT * FROM source_records ORDER BY id').all();
  const insert = f.db.prepare(
    'INSERT INTO conditions(id,source_record_id,person_id,label,status,effective_at,extra_json) VALUES(?,?,?,?,?,?,?)',
  );
  for (const row of fixtures) {
    const before = f.writes.length;
    transaction(
      f.db,
      () =>
        insert.run(
          row.id,
          row.id,
          row.person,
          'Example diagnosis',
          'Printed status',
          row.id === 'visit' ? '2020-04' : null,
          JSON.stringify(row.raw),
        ),
      { actor: 'fictional-reviewer', origin: 'fixture-review' },
    );
    assert.equal(commit(f).records, 3);
    assert.ok(f.writes.slice(before).reduce((n, w) => n + w.bytes, 0) < 7000);
  }
  assert.throws(
    () => transaction(f.db, () => insert.run('bad', 'problem', null, 'x', null, null, '{}')),
    /NOT NULL/,
  );
  assert.throws(
    () => transaction(f.db, () => insert.run('bad', 'missing', 'patient', 'x', null, null, '{}')),
    /FOREIGN KEY/,
  );
  assert.throws(
    () => transaction(f.db, () => insert.run('bad', 'problem', 'missing', 'x', null, null, '{}')),
    /FOREIGN KEY/,
  );
  assert.throws(
    () =>
      transaction(f.db, () => insert.run('bad', 'problem', 'patient', 'x', null, null, 'broken')),
    /CHECK/,
  );
  // SQLite rowid tables otherwise permit NULL text primary keys, which ID-based journals cannot recover.
  assert.throws(
    () => transaction(f.db, () => insert.run(null, 'problem', 'patient', 'x', null, null, '{}')),
    /NOT NULL/,
  );
  const originalVersion = history(f.db, 'conditions', 'problem');
  transaction(
    f.db,
    () =>
      f.db.prepare("UPDATE conditions SET status='reviewed correction' WHERE id='problem'").run(),
    { actor: 'fictional-caregiver', origin: 'fixture-correction' },
  );
  const recovered = rebuild(f);
  assert.deepEqual(
    recovered.prepare('SELECT * FROM conditions ORDER BY id').all(),
    f.db.prepare('SELECT * FROM conditions ORDER BY id').all(),
  );
  assert.deepEqual(recovered.prepare('SELECT * FROM source_records ORDER BY id').all(), originals);
  assert.equal(
    recovered.prepare("SELECT count(*) n FROM conditions WHERE person_id='patient'").get()?.n,
    3,
  );
  assert.equal(
    recovered.prepare("SELECT count(*) n FROM conditions WHERE person_id='relative'").get()?.n,
    1,
  );
  assert.deepEqual(history(recovered, 'conditions', 'problem').slice(1), originalVersion);
  assert.equal(history(recovered, 'conditions', 'problem')[0]?.actor, 'fictional-caregiver');
});

test('condition acceptance writes scale with changed occurrences at two corpus sizes', (t) => {
  for (const size of [4, 400]) {
    const f = fixture(t, (db) => {
      db.exec(
        "INSERT INTO source_files(id,path,sha256,bytes) VALUES('file','providers/fictional.json','fictional',0)",
      );
      const source = db.prepare(
        "INSERT INTO source_records(id,source_file_id,raw_json) VALUES(?,'file',?)",
      );
      const occurrence = db.prepare(
        "INSERT INTO conditions(id,source_record_id,person_id,label) VALUES(?,?,'patient',?)",
      );
      for (let i = 0; i < size; i++) {
        source.run('source-' + i, JSON.stringify({ diagnosis: 'Fictional condition ' + i }));
        occurrence.run('condition-' + i, 'source-' + i, 'Fictional condition ' + i);
      }
    });
    attachRecordDurability(f.db, { profileId, storage: f.storage });
    const old = new Map(f.objects),
      before = f.writes.length;
    transaction(
      f.db,
      () =>
        f.db
          .prepare(
            "UPDATE conditions SET status='literal source correction' WHERE id='condition-0'",
          )
          .run(),
      { actor: 'fictional-reviewer' },
    );
    assert.equal(commit(f).records, 3, 'one occurrence and two revision scalars');
    assert.equal(
      f.writes.length - before,
      4,
      'one bounded segment, manifest page, commit and head',
    );
    assert.ok(f.writes.slice(before).reduce((sum, row) => sum + row.bytes, 0) < 6500);
    for (const [name, bytes] of old) if (name !== 'head') assert.deepEqual(stored(f, name), bytes);
    assert.equal(history(rebuild(f), 'conditions', 'condition-0').length, 2);
  }
});

test('compact history preserves JSON ancestors, dotted collisions, arrays and Unicode fields', (t) => {
  const initial = {
    'a.b': 'literal',
    a: { b: 'nested', gone: null },
    list: [1, null],
    '\uE000': 'first',
    '😀': 'first',
  };
  const f = fixture(t, (db) =>
    db
      .prepare('INSERT INTO source_files(id,path,sha256,bytes,details_json) VALUES(?,?,?,?,?)')
      .run('fictional-history', 'fictional.json', 'fictional', 1, JSON.stringify(initial)),
  );
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  const update = (value: string) =>
    transaction(f.db, () =>
      f.db
        .prepare('UPDATE source_files SET details_json=? WHERE id=?')
        .run(value, 'fictional-history'),
    );
  const changed = {
    'a.b': 'changed literal',
    a: { b: 'changed nested' },
    list: [2],
    '\uE000': 'next',
    '😀': 'next',
  };
  update(JSON.stringify(changed));
  const latest = history(f.db, 'source_files', 'fictional-history')[0];
  const field = (name: string) => latest.changes.find((change) => change.field === name);
  assert.deepEqual(field('details_json.a.b')?.before, { present: true, value: 'nested' });
  assert.deepEqual(field('details_json.a.b')?.after, { present: true, value: 'changed nested' });
  assert.deepEqual(field('details_json.a.gone')?.before, { present: true, value: null });
  assert.deepEqual(field('details_json.a.gone')?.after, { present: false });
  assert.deepEqual(field('details_json.list')?.after, { present: true, value: [2] });
  assert.equal(field('details_json.list.0'), undefined, 'arrays remain whole field values');
  assert.deepEqual(field('details_json.a')?.after, { present: true, value: changed.a });
  assert.deepEqual(field('details_json.😀')?.after, { present: true, value: 'next' });
  assert.deepEqual(
    history(rebuild(f), 'source_files', 'fictional-history'),
    history(f.db, 'source_files', 'fictional-history'),
  );
  // Exercise the history decoder's literal fallback with an independently fictional
  // historical value; current source writes retain their JSON constraint.
  f.db.exec('PRAGMA ignore_check_constraints=ON');
  update('literal invalid JSON');
  f.db.exec('PRAGMA ignore_check_constraints=OFF');
  assert.deepEqual(
    history(f.db, 'source_files', 'fictional-history', 'details_json.a')[0].changes.find(
      (change) => change.field === 'details_json.a',
    )?.after,
    { present: false },
  );
  transaction(f.db, () =>
    f.db.prepare('DELETE FROM source_files WHERE id=?').run('fictional-history'),
  );
  const tombstone = history(f.db, 'source_files', 'fictional-history')[0];
  assert.equal(tombstone.deleted, true);
  assert.deepEqual(tombstone.changes.find((change) => change.field === 'details_json')?.before, {
    present: true,
    value: 'literal invalid JSON',
  });
  assert.deepEqual(tombstone.changes.find((change) => change.field === 'details_json')?.after, {
    present: false,
  });
});

test('selected history fails on missing or corrupt compact references and rejects obsolete caches before writes', (t) => {
  for (const fault of ['missing', 'wrong-reference', 'presence', 'metadata', 'previous'] as const) {
    const f = fixture(t);
    attachRecordDurability(f.db, { profileId, storage: f.storage });
    transaction(f.db, () =>
      f.db.prepare("UPDATE people SET display_name='Fictional revised' WHERE id='patient'").run(),
    );
    const entry = history(f.db, 'people', 'patient')[0];
    if (fault === 'missing')
      f.db
        .prepare('DELETE FROM __record_fields WHERE version_id=? AND field=?')
        .run(entry.versionId, 'display_name');
    if (fault === 'wrong-reference')
      f.db
        .prepare('UPDATE __record_fields SET before_version=? WHERE version_id=?')
        .run(entry.versionId, entry.versionId);
    if (fault === 'presence')
      f.db
        .prepare('UPDATE __record_fields SET before_present=9 WHERE version_id=?')
        .run(entry.versionId);
    if (fault === 'metadata')
      f.db
        .prepare(
          "UPDATE __record_versions SET metadata_json=json_set(metadata_json,'$.entity','other') WHERE version_id=?",
        )
        .run(entry.versionId);
    if (fault === 'previous')
      f.db.prepare('DELETE FROM __record_versions WHERE version_id=?').run(entry.previousVersion);
    assert.throws(() => history(f.db, 'people', 'patient'), /indexed/);
  }
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  f.db.prepare('UPDATE __record_state SET projection=1').run();
  const writes = f.writes.length;
  assert.throws(
    () => attachRecordDurability(f.db, { profileId, storage: f.storage }),
    /unsupported/,
  );
  assert.equal(f.writes.length, writes);
  assert.ok(history(rebuild(f), 'people', 'patient').length);
});

test('initial accepted head survives a failed cache commit and an exact empty index can recover', (t) => {
  const f = fixture(t);
  const publish = f.storage.publishHead;
  f.storage.publishHead = (bytes) => {
    publish(bytes);
    throw Error('Fictional interruption after initial acceptance');
  };
  assert.throws(
    () => attachRecordDurability(f.db, { profileId, storage: f.storage }),
    /Fictional interruption/,
  );
  const accepted = stored(f, 'head');
  const writes = f.writes.length;
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM __record_versions').get()?.count, 0);
  f.storage.publishHead = publish;
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  assert.deepEqual(stored(f, 'head'), accepted);
  assert.equal(f.writes.length, writes, 'recovery only indexes accepted bytes');
  assert.deepEqual(history(rebuild(f), 'people', 'patient'), history(f.db, 'people', 'patient'));
});

test('long journal ancestry replays forward from disk references and reauthenticates spooled commits', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  const oldest = head(f);
  for (let ordinal = 0; ordinal < 128; ordinal++)
    transaction(f.db, () => {
      f.db
        .prepare(
          "INSERT INTO app_meta(key,value) VALUES('fictional_ancestry',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(String(ordinal));
    });
  const selected = commit(f),
    work = createRecordVersionWorkCounters();
  const restored = withRecordVersionWork(work, () => rebuild(f, 'long-ancestry.sqlite'));
  assert.equal(
    restored.prepare("SELECT value FROM app_meta WHERE key='fictional_ancestry'").get()?.value,
    '127',
  );
  assert.equal(work.reconstruction.ancestryReferencesSpooled, selected.sequence);
  assert.equal(work.reconstruction.ancestryReferencesReplayed, selected.sequence);
  assert.ok(work.reconstruction.commitValidations >= selected.sequence * 2);
  assert.equal(durability(restored).sequence, selected.sequence);

  const read = f.storage.read;
  let oldestReads = 0;
  f.storage.read = (name) =>
    name === oldest.name && ++oldestReads === 2
      ? Buffer.from('changed after ancestry validation')
      : read(name);
  assert.throws(() => rebuild(f, 'changed-spooled-commit.sqlite'), /partial or corrupt/);
  assert.equal(oldestReads, 2);
  assert.equal(existsSync(resolve(f.root, 'changed-spooled-commit.sqlite')), false);
  f.storage.read = read;
});

test('journal ancestry refuses a repeated committed object name without retaining a seen set', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage });
  const selected = head(f),
    cycle = { ...commit(f), previous: selected };
  const bytes = Buffer.from(JSON.stringify(cycle) + '\n');
  f.objects.set(selected.name, bytes);
  f.objects.set(
    'head',
    Buffer.from(
      JSON.stringify({
        ...selected,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
    ),
  );
  assert.throws(() => rebuild(f, 'cycle.sqlite'), /cyclic commits/);
  assert.equal(existsSync(resolve(f.root, 'cycle.sqlite')), false);
});

test('v2 transaction manifests bound segment references and preserve exact forward order and old commit compatibility', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage, segmentBytes: 1024 });
  const work = createRecordVersionWorkCounters();
  withRecordVersionWork(work, () =>
    transaction(f.db, () => {
      const insert = f.db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)');
      for (let i = 0; i < 180; i++)
        insert.run('fictional-' + String(i).padStart(4, '0'), 'Fictional 🌿 ' + '.'.repeat(900));
    }),
  );
  const raw = JSON.parse(stored(f, head(f).name).toString()) as StoredRecordCommit;
  assert.equal(raw.format, 'health-record-versions-v2');
  if (raw.format !== 'health-record-versions-v2') return;
  assert.ok(raw.segments.count > 128);
  assert.ok(head(f).bytes < 4096);
  assert.equal(work.operation.maxSegmentReferencesBuffered, 64);
  assert.ok(work.operation.segmentIndexPagesWritten >= 3);
  assert.equal(work.operation.segmentReferencesSpooled, raw.segments.count);
  const refs = [...iterateRecordCommitSegments(f.storage, raw)];
  assert.equal(refs.length, raw.segments.count);
  assert.ok(refs.every((ref) => ref.bytes <= 1024));
  const rows = Buffer.concat(refs.map((ref) => stored(f, ref.name)))
    .toString()
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as DurableRecordVersion);
  assert.deepEqual(
    rows.filter((row) => row.entity === 'people').map((row) => row.contents.id),
    Array.from({ length: 180 }, (_, i) => 'fictional-' + String(i).padStart(4, '0')),
  );
  const recovered = withRecordVersionWork(work, () => rebuild(f, 'indexed-manifest.sqlite'));
  assert.equal(
    recovered.prepare("SELECT count(*) n FROM people WHERE id LIKE 'fictional-%'").get()!.n,
    180,
  );
  assert.equal(work.reconstruction.maxSegmentReferencesBuffered, 64);
  // Re-sign this fixture as the old monolithic manifest to verify retained-v1 compatibility.
  const old = { ...raw, format: 'health-record-versions-v1', segments: refs },
    bytes = Buffer.from(JSON.stringify(old) + '\n'),
    ref = head(f);
  f.objects.set(ref.name, bytes);
  f.objects.set(
    'head',
    Buffer.from(
      JSON.stringify({
        ...ref,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
    ),
  );
  assert.equal(
    rebuild(f, 'legacy-manifest.sqlite')
      .prepare("SELECT count(*) n FROM people WHERE id LIKE 'fictional-%'")
      .get()!.n,
    180,
  );
});

test('v2 segment page corruption, repeated authenticated links and oversized page claims refuse before replay', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage, segmentBytes: 1024 });
  createNote(f.db, { title: 'Fictional large manifest', content: '🌿'.repeat(45000) });
  const original = new Map(f.objects),
    originalHead = head(f),
    raw = JSON.parse(stored(f, originalHead.name).toString()) as StoredRecordCommit;
  assert.equal(raw.format, 'health-record-versions-v2');
  if (raw.format !== 'health-record-versions-v2') return;
  const originalPage = JSON.parse(stored(f, raw.segments.head!.name).toString());
  const rewrite = (ref: RecordObjectReference, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    f.objects.set(ref.name, bytes);
    return {
      ...ref,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  };
  const mutations: [string, (commit: RecordCommitV2, page: typeof originalPage) => void][] = [
    [
      'count',
      (commit) => {
        commit.segments.count++;
      },
    ],
    [
      'ordinal',
      (_commit, page) => {
        page.firstSegment++;
      },
    ],
    [
      'profile',
      (_commit, page) => {
        page.profileId = 'foreign';
      },
    ],
    [
      'operation',
      (_commit, page) => {
        page.operationId = randomUUID();
      },
    ],
    [
      'sequence',
      (_commit, page) => {
        page.sequence++;
      },
    ],
    [
      'missing previous',
      (_commit, page) => {
        page.previous = null;
      },
    ],
    [
      'empty page',
      (_commit, page) => {
        page.segments = [];
      },
    ],
    [
      'oversized reference window',
      (_commit, page) => {
        page.segments = Array(65).fill(page.segments[0]);
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const selected = structuredClone(raw),
      page = structuredClone(originalPage);
    mutate(selected, page);
    selected.segments.head = rewrite(selected.segments.head!, page);
    f.objects.set('head', Buffer.from(JSON.stringify(rewrite(originalHead, selected))));
    assert.throws(
      () => rebuild(f, 'bad-' + name.replaceAll(' ', '-') + '.sqlite'),
      /segment page|segment index/,
      name,
    );
    f.objects.clear();
    for (const [key, bytes] of original) f.objects.set(key, bytes);
  }
  const repeated = structuredClone(raw),
    page = structuredClone(originalPage),
    newRef = { ...raw.segments.head!, name: 'objects/' + randomUUID() };
  page.previous = raw.segments.head;
  repeated.segments.head = rewrite(newRef, page);
  f.objects.set('head', Buffer.from(JSON.stringify(rewrite(originalHead, repeated))));
  assert.throws(() => rebuild(f, 'repeated-link.sqlite'), /segment page/);
  f.objects.clear();
  for (const [key, bytes] of original) f.objects.set(key, bytes);
  const oversized = structuredClone(raw);
  oversized.segments.head!.bytes = 32769;
  f.objects.set('head', Buffer.from(JSON.stringify(rewrite(originalHead, oversized))));
  let readPage = false;
  const read = f.storage.read;
  f.storage.read = (name) => {
    if (name === oversized.segments.head!.name) readPage = true;
    return read(name);
  };
  assert.throws(() => rebuild(f, 'oversized-page.sqlite'), /segment page reference/);
  assert.equal(readPage, false);
});

test('failed manifest page publication and cancellation keep the prior atomic head and all old rows', (t) => {
  for (const failure of ['page', 'cancel'] as const) {
    const f = fixture(t);
    let cancel = false,
      seen = 0;
    attachRecordDurability(f.db, {
      profileId,
      storage: f.storage,
      segmentBytes: 1024,
      verifyReferences: () => {
        if (cancel && ++seen === 120) throw Error('fictional cancellation');
      },
    });
    const previous = stored(f, 'head'),
      write = f.storage.writeImmutable;
    let pages = 0;
    if (failure === 'page')
      f.storage.writeImmutable = (name, bytes) => {
        let format: unknown;
        try {
          format = JSON.parse(Buffer.from(bytes).toString()).format;
        } catch {}
        if (format === 'health-record-segment-page-v1' && ++pages === 2)
          throw Error('fictional manifest failure');
        write(name, bytes);
      };
    else cancel = true;
    assert.throws(
      () =>
        transaction(f.db, () => {
          const insert = f.db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)');
          for (let i = 0; i < 180; i++)
            insert.run('cancelled-' + i, 'Fictional ' + '.'.repeat(900));
        }),
      /fictional/,
    );
    assert.deepEqual(stored(f, 'head'), previous);
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM people WHERE id LIKE 'cancelled-%'").get()!.n,
      0,
    );
    assert.equal(
      rebuild(f, 'failed-' + failure + '.sqlite')
        .prepare("SELECT count(*) n FROM people WHERE id LIKE 'cancelled-%'")
        .get()!.n,
      0,
    );
  }
});
