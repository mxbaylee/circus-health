import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { uploadIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareRetainedPlanAccess } from '../intake-retained-plan.ts';
import { readPreparedSourceAttention } from '../intake-source-attention.ts';
import {
  prepareCollectionReaderCoverage,
  readCollectionReaderCoverage,
} from '../intake-source-reader-index.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import { reviewPreparationStamp } from '../clinical-review-maintenance.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-cooperative-source-')),
    profileId = 'fictional-profile',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-source.txt',
    bytes: Buffer.from('Fictional source evidence.'),
  });
  return { db, root, profileId, source };
}

test('actual attention cold and warm maintenance preserves preparation authority, and its callback writes remain visible', async (t) => {
  const { db, profileId, source } = fixture(t);
  const read = (sections = () => 1) => readPreparedSourceAttention(db, profileId, 0, sections);
  const preparation = reviewPreparationStamp(db),
    raw = reviewReadStamp(db);
  assert.ok(preparation);
  const cold = await read();
  assert.equal(cold.sections, 1);
  assert.equal(reviewPreparationStamp(db), preparation);
  assert.notEqual(reviewReadStamp(db), raw, 'raw cache compatibility remains conservative');

  db.prepare('INSERT INTO temp.source_attention_dirty_v1 VALUES(?)').run(source.id);
  const warmPreparation = reviewPreparationStamp(db),
    warmRaw = reviewReadStamp(db);
  assert.deepEqual(await read(), cold);
  assert.equal(reviewPreparationStamp(db), warmPreparation);
  assert.notEqual(reviewReadStamp(db), warmRaw);

  db.prepare('INSERT INTO temp.source_attention_dirty_v1 VALUES(?)').run(source.id);
  const callbackPreparation = reviewPreparationStamp(db);
  await read(() => {
    db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional_callback_write', 'changed');
    return 1;
  });
  assert.notEqual(
    reviewPreparationStamp(db),
    callbackPreparation,
    'section dependency callbacks execute outside disposable SQL certification',
  );
  assert.equal(
    db.prepare('SELECT value FROM app_meta WHERE key=?').get('fictional_callback_write')!.value,
    'changed',
  );
});

test('actual reader cold and warm maintenance preserves preparation authority while advancing raw compatibility', async (t) => {
  const { db, root, profileId, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  // Dependency preparation is intentionally outside the disposable SQL contract.
  await prepareRetainedPlanAccess(db, profileId, source.id);
  const preparation = reviewPreparationStamp(db),
    raw = reviewReadStamp(db);
  assert.ok(preparation);
  await prepareCollectionReaderCoverage(db, root, profileId, source.id);
  assert.equal(reviewPreparationStamp(db), preparation);
  assert.notEqual(reviewReadStamp(db), raw);
  const cold = readCollectionReaderCoverage(db, profileId, source.id, { offset: 0, limit: 1 });
  cold.assertCurrent();

  const warmPreparation = reviewPreparationStamp(db),
    warmRaw = reviewReadStamp(db);
  await prepareCollectionReaderCoverage(db, root, profileId, source.id);
  assert.equal(reviewPreparationStamp(db), warmPreparation);
  assert.notEqual(reviewReadStamp(db), warmRaw);
  const warm = readCollectionReaderCoverage(db, profileId, source.id, { offset: 0, limit: 1 });
  warm.assertCurrent();
  assert.deepEqual(warm.summary, cold.summary);
  assert.deepEqual(warm.entries, cold.entries);
});
