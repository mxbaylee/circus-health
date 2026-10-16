import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, createIntakePlan, readIntakeUnit } from '../intake.ts';
import { readIntakeUnitRead } from '../intake-unit-read.ts';
import { clearIntakeLiteralSessions } from '../intake-literal-session.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { fictionalModel } from './fictional-model.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
import { readCollectionModelContext } from '../intake-model-collection.ts';
test('migrated retained text units preserve literal windows and expose exact metadata without workflow hydration', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-unit-read-')),
    profile = 'fictional',
    db = openDatabase(ensureProfileDirectories(root, profile).database, profile);
  attachPersonalDurability(db, { root, profileId: profile });
  t.after(() => {
    clearIntakeLiteralSessions(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profile, {
    filename: 'fictional.txt',
    bytes: Buffer.from('Fictional \ud83d\ude03 source\r\n'.repeat(7000)),
  });
  const planned = await createIntakePlan(db, root, profile, source.id, { version: source.version });
  const unit = planned.workflow!.plans[0]!.units[0]!;
  const expected = readIntakeUnit(db, root, profile, source.id, unit.id, { offset: 7, limit: 23 });
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  const before = { ...intakeWorkCounters(db).warm };
  const actual = await readIntakeUnitRead(db, root, profile, source.id, unit.id, {
    offset: 7,
    limit: 23,
  });
  assert.ok('text' in actual && 'totalCharacters' in actual);
  if (!('text' in actual) || !('totalCharacters' in actual)) throw Error('Expected literal text');
  assert.equal(actual.text, expected.text);
  assert.equal(actual.totalCharacters, expected.totalCharacters);
  assert.ok('format' in actual && actual.format === 'health-intake-unit-read-v2');
  if (!('metadataReference' in actual) || !('mappingVersion' in actual))
    throw Error('Expected selected metadata');
  assert.equal(actual.metadataReference.state, 'referenced');
  const metadata = readCollectionModelContext(
    db,
    root,
    profile,
    source.id,
    {
      format: 'health-intake-model-context-request-v2',
      section: 'units',
      version: actual.version,
      mappingVersion: actual.mappingVersion,
      cursor: actual.metadataReference.unit.cursor,
    },
    { mappingVersion: actual.mappingVersion },
  );
  assert.equal(metadata.state, 'ready');
  const work = createIntakeFileWorkCounters();
  await withIntakeFileWork(work, () =>
    readIntakeUnitRead(db, root, profile, source.id, unit.id, { offset: 30, limit: 10 }),
  );
  assert.equal(work.streamHashBytes, 0);
  assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
  await assert.rejects(readIntakeUnitRead(db, root, 'foreign', source.id, unit.id));
});
