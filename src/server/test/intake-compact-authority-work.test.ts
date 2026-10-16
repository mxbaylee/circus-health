import test from 'node:test';
import assert from 'node:assert/strict';
import { StatementSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareIntakeCompactMetadata } from '../intake-compact-metadata.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  captureRecordAuthorityWitness,
  recordAuthorityWitnessCurrent,
  recordDurabilityStatus,
} from '../record-versions.ts';

test('compact preparation checks its original sequence with one genuine HEAD read per source guard', async (t) => {
  const db = openDatabase(':memory:', 'fictional-compact-authority'),
    authority = memoryRecordAuthority(db),
    id = 'fictional-compact-source',
    source = { id, sha256: 'a'.repeat(64) };
  t.after(() => db.close());
  registerRawIntakeFixture(
    db,
    id,
    JSON.stringify({ intake: { version: 0, originalName: 'fictional-' + 'x'.repeat(17000) } }),
  );
  const originalDetails = db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!
    .details_json as string;
  await buildIntakeCollectionEnvelope(db, source);
  transaction(db, () =>
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(originalDetails, id),
  );
  const sequence = recordDurabilityStatus(db)!.sequence,
    witness = captureRecordAuthorityWitness(db);
  assert.equal(recordAuthorityWitnessCurrent(db, witness), true);
  assert.equal(recordAuthorityWitnessCurrent(db, witness, sequence), true);
  assert.equal(recordAuthorityWitnessCurrent(db, witness, sequence + 1), false);

  const originalRead = authority.storage.read,
    originalGet = StatementSync.prototype.get,
    before = intakeWorkCounters(db).reconstruction.compactMetadataSourceGuardChecks;
  let heads = 0,
    revisions = 0;
  const inSourceGuard = () =>
    /\bat assertCurrent \(.*intake-state-migration\.ts:/.test(new Error().stack ?? '');
  t.mock.method(authority.storage, 'read', function (name: string) {
    if (name === 'head' && inSourceGuard()) heads++;
    return Reflect.apply(originalRead, authority.storage, [name]);
  });
  t.mock.method(StatementSync.prototype, 'get', function (this: StatementSync, ...args: unknown[]) {
    if (this.sourceSQL === "SELECT value FROM app_meta WHERE key='revision'" && inSourceGuard())
      revisions++;
    return Reflect.apply(originalGet, this, args);
  });
  try {
    assert.deepEqual(await prepareIntakeCompactMetadata(db, source), { changed: true });
    const guards = intakeWorkCounters(db).reconstruction.compactMetadataSourceGuardChecks - before;
    assert.ok(guards > 0, 'the actual compact preparation checked its original source');
    assert.equal(heads, guards, 'every source guard still reads the genuine accepted HEAD once');
    assert.equal(revisions, 0, 'source guards do not reread unused revision values');
  } finally {
    t.mock.restoreAll();
  }
});
