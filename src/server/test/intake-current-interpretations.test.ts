import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, currentIntakeInterpretations, proposeConversion } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareCurrentIntakeInterpretations } from '../intake-current-interpretations.ts';
import { writeIntakeSourcePin } from '../intake-source-pin.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { clearIntakeCollectionCache } from '../intake-state-collections.ts';
test('selected interpretation existence preserves old fallback and rechecks changed dependency evidence without ID arrays', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-interpretations-')),
    profile = 'fictional',
    db = openDatabase(ensureProfileDirectories(root, profile).database, profile);
  attachPersonalDurability(db, { root, profileId: profile });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profile, {
    filename: 'fictional.txt',
    bytes: Buffer.from('Fictional original'),
  });
  const record = {
    format: 'health-record-v1',
    id: 'fictional',
    kind: 'context',
    payload: { text: 'fictional' },
    provenance: {
      capturedVia: 'fictional',
      sourceSystem: 'fictional',
      sourceRecordId: 'fictional',
      evidenceClass: 'transcription',
      locator: 'page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
  };
  const proposed = proposeConversion(db, root, profile, source.id, {
      version: source.version,
      jsonlText: JSON.stringify(record),
      summary: 'Fictional context',
    }),
    old = currentIntakeInterpretations(db, profile, source.id);
  assert.equal(old.proposalIds.length, 1);
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  const before = { ...intakeWorkCounters(db).warm };
  const actual = await prepareCurrentIntakeInterpretations(db, profile, source.id);
  assert.equal(actual.original, old.original);
  assert.equal(actual.hasCurrentProposal, true);
  assert.equal(actual.proposalTotal, 1);
  assert.equal('proposalIds' in actual, false);
  actual.hasCurrentProposal = false;
  assert.equal(
    (await prepareCurrentIntakeInterpretations(db, profile, source.id)).hasCurrentProposal,
    true,
    'Caller mutation must not rewrite the cached result',
  );
  await prepareCurrentIntakeInterpretations(db, profile, source.id, {
    onProposal() {
      throw Error('Warm scan');
    },
  });
  writeIntakeSourcePin(db, source.id, {
    revisionId: 'changed',
    dependencyToken: 'changed',
    requiresInterpretation: true,
    version: 1,
  });
  assert.equal(
    (await prepareCurrentIntakeInterpretations(db, profile, source.id)).hasCurrentProposal,
    false,
  );
  db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
    'intake_proposal_dependencies:v1:' + proposed.proposals[0]!.id,
    JSON.stringify({ format: 'intake-proposal-dependencies-v1', sources: [] }),
  );
  assert.equal(
    (await prepareCurrentIntakeInterpretations(db, profile, source.id)).hasCurrentProposal,
    true,
  );
  db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(
    'invalid',
    'intake_proposal_dependencies:v1:' + proposed.proposals[0]!.id,
  );
  assert.equal(
    (await prepareCurrentIntakeInterpretations(db, profile, source.id)).hasCurrentProposal,
    false,
  );
  const dependencyKey = 'intake_proposal_dependencies:v1:' + proposed.proposals[0]!.id,
    validDependency = JSON.stringify({ format: 'intake-proposal-dependencies-v1', sources: [] });
  db.exec('SAVEPOINT fictional_temporary_repair');
  db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(validDependency, dependencyKey);
  assert.equal(
    (await prepareCurrentIntakeInterpretations(db, profile, source.id)).hasCurrentProposal,
    true,
  );
  const beforeRollback = db.prepare('SELECT total_changes() AS count').get()!.count;
  db.exec('ROLLBACK TO fictional_temporary_repair; RELEASE fictional_temporary_repair');
  assert.equal(db.prepare('SELECT total_changes() AS count').get()!.count, beforeRollback);
  assert.equal(
    (await prepareCurrentIntakeInterpretations(db, profile, source.id)).hasCurrentProposal,
    false,
    'Rolled-back dependency repair cannot supply a current proposal',
  );

  const peer = openDatabase(ensureProfileDirectories(root, profile).database, profile);
  try {
    const ownChanges = db.prepare('SELECT total_changes() AS count').get()!.count;
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(validDependency, dependencyKey);
    assert.equal(db.prepare('SELECT total_changes() AS count').get()!.count, ownChanges);
    assert.equal(
      (await prepareCurrentIntakeInterpretations(db, profile, source.id)).hasCurrentProposal,
      true,
      'Peer repair invalidates a cached negative',
    );
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run('invalid', dependencyKey);
    assert.equal(
      (await prepareCurrentIntakeInterpretations(db, profile, source.id)).hasCurrentProposal,
      false,
      'Peer dependency change invalidates a cached positive',
    );
  } finally {
    peer.close();
  }
  const quote = (value: string) => String(db.prepare('SELECT quote(?) value').get(value)!.value);
  const beforeTemp = db
    .prepare('SELECT total_changes() n,(SELECT schema_version FROM pragma_schema_version) schema')
    .get();
  db.exec(
    `CREATE TEMP VIEW app_meta AS SELECT key, CASE WHEN key=${quote(dependencyKey)} THEN ${quote(validDependency)} ELSE value END value FROM main.app_meta`,
  );
  assert.deepEqual(
    db
      .prepare('SELECT total_changes() n,(SELECT schema_version FROM pragma_schema_version) schema')
      .get(),
    beforeTemp,
  );
  assert.equal(
    (await prepareCurrentIntakeInterpretations(db, profile, source.id)).hasCurrentProposal,
    true,
    'TEMP dependency shadow invalidates a cached negative without main writes',
  );
  db.exec('DROP VIEW temp.app_meta');
  assert.equal(
    (await prepareCurrentIntakeInterpretations(db, profile, source.id)).hasCurrentProposal,
    false,
    'Dropping the TEMP shadow invalidates its cached positive',
  );
  clearIntakeCollectionCache(db);
  await assert.rejects(
    prepareCurrentIntakeInterpretations(db, profile, source.id, {
      onProposal() {
        db.exec(
          `CREATE TEMP VIEW app_meta AS SELECT key, CASE WHEN key=${quote(dependencyKey)} THEN ${quote(validDependency)} ELSE value END value FROM main.app_meta`,
        );
      },
    }),
    /Interpretation selection changed/,
  );
  db.exec('DROP VIEW temp.app_meta');
  async function assertRescanned() {
    let visited = 0;
    assert.equal(
      (
        await prepareCurrentIntakeInterpretations(db, profile, source.id, {
          onProposal() {
            visited++;
          },
        })
      ).hasCurrentProposal,
      false,
    );
    assert.equal(visited, 1, 'Changed projection requires fresh negative evidence');
  }
  const beforeSchema = db.prepare('SELECT total_changes() AS count').get()!.count;
  db.exec('CREATE TABLE fictional_interpretation_schema_probe (id TEXT)');
  assert.equal(db.prepare('SELECT total_changes() AS count').get()!.count, beforeSchema);
  await assertRescanned();
  clearIntakeCollectionCache(db);
  await assertRescanned();
  db.exec('SAVEPOINT fictional_unchanged_transaction');
  await assertRescanned();
  await assertRescanned();
  db.exec('RELEASE fictional_unchanged_transaction');
  await assertRescanned();
  db.exec('SAVEPOINT fictional_changed_source');
  db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('0'.repeat(64), source.id);
  await assert.rejects(prepareCurrentIntakeInterpretations(db, profile, source.id));
  db.exec('ROLLBACK TO fictional_changed_source; RELEASE fictional_changed_source');
  await assertRescanned();
  db.exec('SAVEPOINT fictional_changed_owner');
  db.prepare("UPDATE app_meta SET value=? WHERE key='owner_profile_id'").run('foreign');
  await assert.rejects(prepareCurrentIntakeInterpretations(db, profile, source.id));
  db.exec('ROLLBACK TO fictional_changed_owner; RELEASE fictional_changed_owner');
  await assertRescanned();
  assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.envelopeHydrations);
  await assert.rejects(prepareCurrentIntakeInterpretations(db, 'foreign', source.id));
});
