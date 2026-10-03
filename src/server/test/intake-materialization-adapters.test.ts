import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import {
  readIntakeEnvelope,
  readIntakeEnvelopeMaterialized,
  readIntakeEnvelopeText,
  stageIntakeEnvelope,
} from '../intake-authority.ts';
import {
  intakeDetails,
  registerIntakeFile,
  requireStoredIntakeDetails,
  writeIntakeDetails,
} from '../intake-state-access.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  readSourceTextProjection,
  sourceTextProjectionCounters,
} from '../source-text-projection.ts';
import { writeIntakeSourcePin } from '../intake-source-pin.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-materialized-envelope-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional-materialized');
  memoryRecordAuthority(db);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const value = {
    before: { exact: 'Ω \\ud800' },
    intake: {
      originalName: 'fictional.txt',
      createdAt: '2026-01-01',
      version: 4,
      proposals: [{ evidence: 'independently fictional '.repeat(300) }],
      workflow: { format: 'health-intake-workflow-v1', reportGroups: [] },
    },
    after: null,
  };
  transaction(db, () =>
    registerIntakeFile(db, {
      id: 'original',
      path: 'fictional.txt',
      sha256: 'a'.repeat(64),
      size: 0,
      mimeType: 'text/plain',
      kind: 'intake_original',
      coverage: 'unknown',
      details: value,
    }),
  );
  return { db, value };
}

test('selected immutable envelopes reuse validation and exact text while public reads stay detached', (t) => {
  const { db, value } = fixture(t);
  const selected = readIntakeEnvelopeMaterialized(db, { id: 'original' });
  assert.equal(Object.isFrozen(selected.value.intake), true);
  const before = intakeWorkCounters(db);
  for (let i = 0; i < 3; i++) {
    assert.equal(readIntakeEnvelopeMaterialized(db, { id: 'original' }), selected);
    assert.equal(readIntakeEnvelopeText(db, { id: 'original' }), JSON.stringify(value));
  }
  const after = intakeWorkCounters(db);
  assert.equal(after.warm.normalizeCalls, before.warm.normalizeCalls);
  assert.equal(after.warm.envelopeSerializationCalls, before.warm.envelopeSerializationCalls);
  assert.equal(after.primitive.readCopies, before.primitive.readCopies);
  const detached = readIntakeEnvelope(db, { id: 'original' }) as typeof value;
  detached.intake.proposals[0]!.evidence = 'mutated outside authority';
  assert.deepEqual(readIntakeEnvelope(db, { id: 'original' }), value);
  assert.equal(readIntakeEnvelopeText(db, { id: 'original' }), selected.text);
});

test('same-head compact changes cannot reuse verified envelopes and rollback restores selection', (t) => {
  const { db, value } = fixture(t);
  readIntakeEnvelopeMaterialized(db, { id: 'original' });
  const compact = String(
    db.prepare("SELECT details_json FROM source_files WHERE id='original'").get()!.details_json,
  );
  const head = db
    .prepare("SELECT value FROM app_meta WHERE key GLOB 'intake_state_v1:*:head'")
    .get()!.value;
  assert.throws(
    () =>
      transaction(db, () => {
        db.prepare("UPDATE source_files SET details_json=? WHERE id='original'").run(
          compact.replace('fictional.txt', 'conflicting.txt'),
        );
        assert.equal(
          db.prepare("SELECT value FROM app_meta WHERE key GLOB 'intake_state_v1:*:head'").get()!
            .value,
          head,
        );
        readIntakeEnvelopeText(db, { id: 'original' });
      }),
    /compact metadata conflicts/,
  );
  assert.equal(readIntakeEnvelopeText(db, { id: 'original' }), JSON.stringify(value));
  assert.throws(
    () =>
      transaction(db, () => {
        const changed = structuredClone(value);
        changed.intake.version++;
        stageIntakeEnvelope(db, { id: 'original' }, changed);
        assert.equal(readIntakeEnvelopeText(db, { id: 'original' }), JSON.stringify(changed));
        throw Error('fictional rollback');
      }),
    /fictional rollback/,
  );
  assert.equal(readIntakeEnvelopeText(db, { id: 'original' }), JSON.stringify(value));
});

test('effective pin writes use stored materialization without full old-envelope clones', (t) => {
  const { db, value } = fixture(t);
  const pin = {
    revisionId: 'fictional-revision',
    dependencyToken: 'fictional-pin',
    requiresInterpretation: true,
    version: 3,
  };
  transaction(db, () => writeIntakeSourcePin(db, 'original', pin));
  const row = { id: 'original', kind: 'intake_original', source_pin: JSON.stringify(pin) };
  const details = intakeDetails(db, row);
  assert.equal(details.version, 7);
  const before = intakeWorkCounters(db);
  transaction(db, () => writeIntakeDetails(db, row, { ...details, version: 8 }));
  const after = intakeWorkCounters(db);
  assert.equal(after.primitive.readCopies, before.primitive.readCopies);
  const stored = requireStoredIntakeDetails(db, row);
  assert.equal(stored.version, 5);
  assert.equal(Object.hasOwn(stored, 'sourceTextRevisionId'), false);
  assert.equal(intakeDetails(db, row).version, 8);
  assert.equal(
    readIntakeEnvelopeText(db, row),
    JSON.stringify({ ...value, intake: { ...value.intake, version: 5 } }),
  );
});

test('raw immutable materializations retain duplicate spelling and detached JavaScript last-member views', (t) => {
  const { db } = fixture(t);
  const raw =
    '{ "intake":{"originalName":"first"},"intake":{"originalName":"last","version":1,"workflow":{}},"text":"\\u0041" }';
  registerRawIntakeFixture(db, 'raw', raw);
  const selected = readIntakeEnvelopeMaterialized(db, { id: 'raw' });
  assert.equal(selected.mode, 'raw');
  assert.equal(selected.text, raw);
  assert.equal(Object.isFrozen(selected.value.intake), true);
  assert.equal(
    db
      .prepare(
        "SELECT json_extract(details_json,'$.intake.originalName') name FROM source_files WHERE id='raw'",
      )
      .get()!.name,
    'first',
  );
  const detached = readIntakeEnvelope(db, { id: 'raw' }) as { intake: { originalName: string } };
  assert.equal(detached.intake.originalName, 'last');
  detached.intake.originalName = 'outside change';
  assert.equal(readIntakeEnvelopeText(db, { id: 'raw' }), raw);
  assert.equal(readIntakeEnvelopeMaterialized(db, { id: 'raw' }), selected);
});

test('projection reuses normalized exact-text fingerprints and hashes raw envelope bytes independently', (t) => {
  const { db, value } = fixture(t);
  assert.equal(readSourceTextProjection(db, 'original'), JSON.stringify(value));
  assert.equal(sourceTextProjectionCounters(db).authorityHashBytes, 0);
  const raw = '{ "intake": { "originalName":"fictional raw", "workflow":{} } }';
  const before = sourceTextProjectionCounters(db).authorityHashBytes;
  registerRawIntakeFixture(db, 'raw-digest', raw);
  assert.equal(readSourceTextProjection(db, 'raw-digest'), raw);
  assert.equal(
    sourceTextProjectionCounters(db).authorityHashBytes - before,
    Buffer.byteLength(raw),
  );
});
