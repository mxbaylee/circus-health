import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, getRetainedIntakeOriginalReference } from '../intake.ts';
import {
  readIntakeLiteralWindowIndexed,
  clearIntakeLiteralSessions,
} from '../intake-literal-session.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-literal-session-')),
    profile = 'fictional',
    db = openDatabase(ensureProfileDirectories(root, profile).database, profile);
  attachPersonalDurability(db, { root, profileId: profile });
  t.after(() => {
    clearIntakeLiteralSessions(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, root, profile };
}
test('indexed literal windows preserve UTF16 and reuse verified disk ranges without rehashing', async (t) => {
  const { db, root, profile } = fixture(t),
    text = 'a'.repeat(65534) + '\ud83d\ude03\r\n' + 'e\u0301'.repeat(40000),
    bytes = Buffer.from('\ufeff' + text),
    source = uploadIntake(db, root, profile, { filename: 'fictional.txt', bytes });
  const cold = createIntakeFileWorkCounters();
  const first = await withIntakeFileWork(cold, () =>
    readIntakeLiteralWindowIndexed(db, root, profile, source.id, {
      offset: 65535,
      limit: 5,
      expectedHash: source.sha256,
    }),
  );
  assert.equal(first.text, text.slice(65535, 65540));
  assert.equal(first.totalCharacters, text.length);
  assert.equal(cold.streamHashBytes, bytes.length);
  const warm = createIntakeFileWorkCounters();
  const last = await withIntakeFileWork(warm, () =>
    readIntakeLiteralWindowIndexed(db, root, profile, source.id, {
      offset: text.length - 9,
      limit: 20,
    }),
  );
  assert.equal(last.text, text.slice(-9));
  assert.equal(last.nextOffset, null);
  assert.equal(warm.streamHashBytes, 0);
  assert.equal(warm.streamReadBytes, 18);
  assert.equal(warm.verificationCacheHits, 1);
});
test('literal sessions reject wrong owners, source pins and changed bytes', async (t) => {
  const { db, root, profile } = fixture(t),
    source = uploadIntake(db, root, profile, {
      filename: 'fictional.txt',
      bytes: Buffer.from('Original fictional evidence'),
    });
  await readIntakeLiteralWindowIndexed(db, root, profile, source.id);
  await assert.rejects(readIntakeLiteralWindowIndexed(db, root, 'foreign', source.id));
  await assert.rejects(
    readIntakeLiteralWindowIndexed(db, root, profile, source.id, { expectedHash: '0'.repeat(64) }),
    /unit does not match/,
  );
  writeFileSync(
    getRetainedIntakeOriginalReference(db, root, profile, source.id).path,
    'Changed fictional evidence!',
  );
  await assert.rejects(
    readIntakeLiteralWindowIndexed(db, root, profile, source.id),
    /no longer matches/,
  );
});
test('interrupted or invalid UTF8 preparations never become reusable evidence', async (t) => {
  const { db, root, profile } = fixture(t),
    bytes = Buffer.from('x'.repeat(150000)),
    source = uploadIntake(db, root, profile, { filename: 'fictional.txt', bytes });
  let checks = 0;
  await assert.rejects(
    readIntakeLiteralWindowIndexed(db, root, profile, source.id, {
      assertRunning() {
        if (++checks === 3) throw Error('cancelled fixture');
      },
    }),
    /cancelled fixture/,
  );
  const work = createIntakeFileWorkCounters();
  await withIntakeFileWork(work, () =>
    readIntakeLiteralWindowIndexed(db, root, profile, source.id),
  );
  assert.equal(work.streamHashBytes, bytes.length);
  const invalid = uploadIntake(db, root, profile, {
    filename: 'invalid.txt',
    bytes: Buffer.from([0xff, 0xfe, 0xff]),
  });
  await assert.rejects(
    readIntakeLiteralWindowIndexed(db, root, profile, invalid.id),
    /encoded data/,
  );
  await assert.rejects(
    readIntakeLiteralWindowIndexed(db, root, profile, invalid.id),
    /encoded data/,
  );
});

test('profile session clearing cancels in-flight plaintext preparation', async (t) => {
  const { db, root, profile } = fixture(t),
    source = uploadIntake(db, root, profile, {
      filename: 'fictional.txt',
      bytes: Buffer.from('x'.repeat(150000)),
    });
  const pending = readIntakeLiteralWindowIndexed(db, root, profile, source.id);
  clearIntakeLiteralSessions(db);
  await assert.rejects(pending, /session was closed/);
  const work = createIntakeFileWorkCounters();
  await withIntakeFileWork(work, () =>
    readIntakeLiteralWindowIndexed(db, root, profile, source.id),
  );
  assert.equal(work.streamHashBytes, 150000);
});
