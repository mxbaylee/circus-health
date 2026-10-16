import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, transaction, type Database } from '../database.ts';
import {
  attachRecordDurability,
  iterateRecordCommitSegments,
  REPLAY_DECODE_REUSE_RECORDS,
  REPLAY_DECODE_REUSE_BYTES,
  rebuildRecordDatabase,
  rebuildRecordDatabaseSteps,
  type DurableRecordVersion,
  type RecordCommit,
  type RecordObjectReference,
  type RecordStorage,
} from '../record-versions.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';

const profileId = 'fictional-replay-decode';

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-replay-decode-'));
  ensureProfileDirectories(root, profileId);
  const objects = new Map<string, Buffer>();
  const opened: Database[] = [];
  const storage: RecordStorage = {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable(name, bytes) {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(bytes));
    },
    publishHead(bytes) {
      objects.set('head', Buffer.from(bytes));
    },
  };
  const db = openDatabase(resolve(root, 'current.sqlite'), profileId);
  opened.push(db);
  attachRecordDurability(db, { profileId, storage });
  t.after(() => {
    for (const db of opened)
      try {
        db.close();
      } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const insertPeople = (prefix: string, count: number) =>
    transaction(db, () => {
      const insert = db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)');
      for (let index = 0; index < count; index++)
        insert.run(`${prefix}-${index}`, `Fictional ${prefix} ${index}`);
    });
  const commits = (): RecordCommit[] => {
    const found: RecordCommit[] = [];
    let ref = JSON.parse(objects.get('head')!.toString('utf8')) as RecordObjectReference | null;
    while (ref) {
      const commit = JSON.parse(objects.get(ref.name)!.toString('utf8')) as RecordCommit;
      found.push(commit);
      ref = commit.previous;
    }
    return found;
  };
  const rebuild = (name: string, verifyReferences?: (versions: DurableRecordVersion[]) => void) => {
    const work = createRecordVersionWorkCounters();
    withRecordVersionWork(work, () =>
      rebuildRecordDatabase(resolve(root, name), { profileId, storage, verifyReferences }),
    );
    const rebuilt = openDatabase(resolve(root, name), profileId);
    opened.push(rebuilt);
    return { work: work.reconstruction, db: rebuilt };
  };
  return { root, db, objects, storage, insertPeople, commits, rebuild };
}

test('cold replay decodes each durable version once and reuses it for every replay pass', (t) => {
  const f = fixture(t);
  for (let round = 0; round < 6; round++) f.insertPeople(`round${round}`, 7 + round);
  const durable = f.commits().reduce((sum, commit) => sum + commit.records, 0);
  assert.ok(durable >= 57);

  const { work, db } = f.rebuild('rebuilt.sqlite');
  assert.equal(work.decodedVersions, durable, 'one decode per durable version');
  assert.equal(work.replayDecodeReuseOverBudget, 0);
  // Every version still runs both application passes and indexing on the reused value.
  assert.equal(work.replayDeleteAttempts, durable);
  assert.ok(work.replayInsertAttempts <= durable && work.replayInsertAttempts > 0);
  assert.equal(work.indexedVersionAttempts, durable);
  assert.ok(work.versionValidations >= 2 * durable, 'validation and indexing each validate');
  assert.equal(
    work.replayDecodedVersionReuses,
    3 * durable,
    'delete, insert and index passes reuse the first decode',
  );
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM people WHERE id GLOB 'round*'").get()!.count,
    7 + 8 + 9 + 10 + 11 + 12,
  );
});

test('a transaction above the record budget reuses only its bounded complete prefix', (t) => {
  const f = fixture(t);
  f.insertPeople('wide', 4097);
  const commits = f.commits();
  const wide = commits[0]!;
  assert.ok(wide.records > REPLAY_DECODE_REUSE_RECORDS);
  const durable = commits.reduce((sum, commit) => sum + commit.records, 0);
  const { work } = f.rebuild('rebuilt-wide.sqlite');
  const retained = REPLAY_DECODE_REUSE_RECORDS;
  assert.equal(work.replayDecodedVersionReuses, 3 * (durable - wide.records + retained));
  assert.equal(work.decodedVersions, durable + 3 * (wide.records - retained));
  assert.equal(work.replayDeleteAttempts, durable);
  assert.equal(work.indexedVersionAttempts, durable);
  assert.ok(work.versionValidations >= 2 * durable);

  const abandoned = resolve(f.root, 'rebuilt-wide-abandoned.sqlite');
  const steps = rebuildRecordDatabaseSteps(abandoned, { profileId, storage: f.storage });
  const abandonedWork = createRecordVersionWorkCounters();
  const seedRecords = durable - wide.records;
  for (
    let stepsTaken = 0;
    abandonedWork.reconstruction.decodedVersions <= seedRecords;
    stepsTaken++
  ) {
    assert.ok(stepsTaken < 1_000_000, 'the wide first pass must advance');
    assert.equal(withRecordVersionWork(abandonedWork, () => steps.next()).done, false);
  }
  assert.ok(abandonedWork.reconstruction.decodedVersions < durable);
  withRecordVersionWork(abandonedWork, () => steps.return(undefined as never));
  assert.equal(existsSync(abandoned), false);

  const suffix = [...iterateRecordCommitSegments(f.storage, wide)].at(-1)!;
  let callbacks = 0;
  let changed = false;
  assert.throws(
    () =>
      f.rebuild('rebuilt-wide-changed.sqlite', (versions) => {
        if (versions[0]!.sequence !== wide.sequence) return;
        if (++callbacks !== wide.records) return;
        const bytes = Buffer.from(f.objects.get(suffix.name)!);
        bytes[bytes.length - 1] ^= 1;
        f.objects.set(suffix.name, bytes);
        changed = true;
      }),
    /partial or corrupt committed object/,
  );
  assert.equal(callbacks, wide.records);
  assert.equal(changed, true);
  assert.equal(existsSync(resolve(f.root, 'rebuilt-wide-changed.sqlite')), false);
});

test('a byte-limited prefix keeps small frames around a split giant frame', (t) => {
  const f = fixture(t);
  attachRecordDurability(f.db, { profileId, storage: f.storage, segmentBytes: 16 * 1024 });
  const filler = 'Fictional wide name '.repeat(240);
  const giant = 'Fictional split record '.repeat(6000);
  transaction(f.db, () => {
    const insert = f.db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)');
    for (let index = 0; index < 2000; index++)
      insert.run(`bytes-${index}`, index === 100 ? giant : filler + index);
  });
  const commits = f.commits();
  const wide = commits[0]!;
  assert.ok(wide.records <= 4096, 'only the byte budget applies');
  const segments = [...iterateRecordCommitSegments(f.storage, wide)];
  assert.ok(segments.length > 100);
  const admitted: Buffer[] = [];
  let admittedBytes = 0;
  for (const segment of segments) {
    const bytes = f.objects.get(segment.name)!;
    if (admittedBytes + bytes.length > REPLAY_DECODE_REUSE_BYTES) break;
    admitted.push(bytes);
    admittedBytes += bytes.length;
  }
  assert.ok(admittedBytes > 0 && admittedBytes <= REPLAY_DECODE_REUSE_BYTES);
  const prefix = Buffer.concat(admitted);
  let completeLines = 0;
  let giantFrames = 0;
  for (let start = 0, end = prefix.indexOf(10); end !== -1; end = prefix.indexOf(10, start)) {
    if (completeLines < REPLAY_DECODE_REUSE_RECORDS && end - start > 64 * 1024) giantFrames++;
    completeLines++;
    start = end + 1;
  }
  assert.equal(giantFrames, 1, 'the split giant is inside the admitted byte prefix');
  const retained = Math.min(completeLines, REPLAY_DECODE_REUSE_RECORDS) - giantFrames;
  assert.ok(retained > 150 && retained < wide.records);
  const durable = commits.reduce((sum, commit) => sum + commit.records, 0);
  const { work, db } = f.rebuild('rebuilt-bytes.sqlite');
  assert.equal(work.replayDecodeReuseOverBudget, 1);
  assert.equal(work.replayDecodedVersionReuses, 3 * (durable - wide.records + retained));
  assert.ok(work.journalRecordsSpooled >= 4, 'the giant frame is re-decoded on each partial pass');
  assert.equal(work.decodedVersions, durable + 3 * (wide.records - retained));
  assert.equal(work.replayDeleteAttempts, durable);
  assert.equal(work.indexedVersionAttempts, durable);
  assert.equal(
    db.prepare('SELECT display_name FROM people WHERE id=?').get('bytes-100')!.display_name,
    giant,
  );
});

test('reference callback mutation cannot alter a rebuilt accepted field', (t) => {
  const f = fixture(t);
  f.insertPeople('mutable', 2);
  const journal = [...f.objects].map(([name, bytes]) => [name, bytes.toString('hex')]);
  let held: DurableRecordVersion | undefined;
  let observed = 0;
  let lateMutation = false;
  const { db } = f.rebuild('rebuilt-callback.sqlite', (versions) => {
    for (const version of versions) {
      if (version.entity !== 'people') continue;
      if (version.contents.id === 'mutable-0') {
        held = version;
        version.contents.display_name = 'Fictional immediate callback mutation';
      } else if (version.contents.id === 'mutable-1') {
        assert.ok(held);
        held.contents.display_name = 'Fictional late alias mutation';
        lateMutation = true;
      } else continue;
      observed++;
    }
  });
  assert.equal(observed, 2);
  assert.equal(lateMutation, true);
  for (let index = 0; index < 2; index++) {
    const id = `mutable-${index}`;
    assert.equal(
      db.prepare('SELECT display_name FROM people WHERE id=?').get(id)!.display_name,
      `Fictional mutable ${index}`,
    );
    const version = db
      .prepare(
        "SELECT contents_json FROM __record_versions WHERE entity='people' AND record_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(JSON.stringify([id]))!;
    assert.equal(
      JSON.parse(String(version.contents_json)).display_name,
      `Fictional mutable ${index}`,
    );
  }
  assert.deepEqual(
    [...f.objects].map(([name, bytes]) => [name, bytes.toString('hex')]),
    journal,
    'callback writes never replace authenticated journal objects',
  );
  assert.throws(
    () =>
      f.rebuild('rebuilt-callback-refusal.sqlite', () => {
        throw Error('Fictional reference refusal');
      }),
    /Fictional reference refusal/,
  );
  assert.equal(existsSync(resolve(f.root, 'rebuilt-callback-refusal.sqlite')), false);
});

test('a corrupted retained version is still refused by the single decode', (t) => {
  const f = fixture(t);
  f.insertPeople('kept', 3);
  f.insertPeople('corrupt', 3);
  const latest = f.commits()[0]!;
  const segment = [...iterateRecordCommitSegments(f.storage, latest)][0]!;
  const bytes = f.objects.get(segment.name)!;
  const changed = Buffer.from(
    bytes.toString('utf8').replace('Fictional corrupt 1', 'Fictional corrupt 7'),
  );
  assert.notDeepEqual(changed, bytes);
  f.objects.set(segment.name, changed);
  assert.throws(() => f.rebuild('rebuilt-corrupt.sqlite'), /partial or corrupt committed object/);
});
