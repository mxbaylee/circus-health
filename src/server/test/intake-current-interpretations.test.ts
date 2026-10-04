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
  assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.envelopeHydrations);
  await assert.rejects(prepareCurrentIntakeInterpretations(db, 'foreign', source.id));
});
