import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers';
import { setImmediate as immediate } from 'node:timers/promises';
import { StatementSync } from 'node:sqlite';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import {
  prepareCorrectionSupportingEvidence,
  readPreparedCorrectionSupport,
} from '../record-correction-support.ts';
import { uploadIntake, proposeConversion, reviewIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { readIntakeEnvelopeMaterialized } from '../intake-authority.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
  writeIntakeFixtureEnvelope,
} from './helpers/intake-authority-fixture.ts';

async function fixture(t: test.TestContext, options: { groups?: number; ancestors?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-correction-cooperation-')),
    profileId = 'fictional-correction',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-support.txt',
    bytes: Buffer.from('Fictional supporting original'),
  });
  const proposed = proposeConversion(db, root, profileId, source.id, {
    version: source.version,
    summary: 'Fictional supporting occurrence',
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-record',
      kind: 'record',
      payload: { literal: '14.00' },
      clinical: {
        kind: 'observation',
        subject: 'self',
        testLabel: 'Fictional component',
        valueText: '14.00',
        unit: 'mg',
        date: '2026-02-10',
      },
      provenance: {
        capturedVia: null,
        sourceSystem: 'Fictional source',
        sourceRecordId: 'fictional-record',
        evidenceClass: 'provider_export',
        locator: 'Fictional section',
      },
      coverage: { status: 'complete_response', notes: [] },
    }),
  });
  const proposalId = proposed.proposals[0]!.id,
    record = reviewIntake(db, root, profileId, source.id, proposalId).records[0]!;
  const ref = {
    intakeId: source.id,
    proposalId,
    recordId: record.id,
    candidateId: record.candidateId!,
    candidateVersionId: record.candidateVersionId!,
    originalSourceFileId: source.id,
  };
  const value = structuredClone(readIntakeEnvelopeMaterialized(db, { id: source.id }).value) as {
    intake: { parentSourceFileId?: string; workflow: { reportGroups: unknown[] } };
  };
  if (options.groups)
    value.intake.workflow.reportGroups = Array.from({ length: options.groups }, (_, n) => ({
      id: `fictional-empty-${n}`,
      memberId: `fictional-empty-member-${n}`,
      versions: [],
    }));
  if (options.ancestors) {
    value.intake.parentSourceFileId = 'fictional-ancestor-0';
    for (let n = 0; n < options.ancestors; n++)
      registerRawIntakeFixture(
        db,
        `fictional-ancestor-${n}`,
        JSON.stringify({
          intake: {
            version: 0,
            ...(n + 1 < options.ancestors
              ? { parentSourceFileId: `fictional-ancestor-${n + 1}` }
              : {}),
          },
        }),
      );
  }
  writeIntakeFixtureEnvelope(db, source.id, value);
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  return { db, root, profileId, ref };
}

test('supporting proof remains consumable after its preparation owner ends', async (t) => {
  const f = await fixture(t);
  const proof = await prepareCorrectionSupportingEvidence(f.db, f.root, f.profileId, [f.ref]);
  try {
    const evidence = readPreparedCorrectionSupport(proof, f.db, f.root, f.profileId, [f.ref]);
    assert.equal(evidence[0]!.originalSourceFileId, f.ref.intakeId);
    await immediate();
    assert.deepEqual(
      readPreparedCorrectionSupport(proof, f.db, f.root, f.profileId, [f.ref]),
      evidence,
    );
    assert.throws(() => readPreparedCorrectionSupport(proof, f.db, f.root, 'foreign', [f.ref]), {
      code: 'CORRECTION_EVIDENCE_CHANGED',
    });
  } finally {
    proof.dispose();
  }
  assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
});

test('supporting ancestry cancellation stops at the next bounded host turn', async (t) => {
  const f = await fixture(t, { ancestors: 130 });
  const controller = new AbortController();
  const original = StatementSync.prototype.get;
  let reads = 0,
    atAbort = -1;
  t.mock.method(StatementSync.prototype, 'get', function (this: StatementSync, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args);
    if (
      this.sourceSQL ===
        "SELECT id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'" &&
      typeof args[0] === 'string' &&
      args[0].startsWith('fictional-ancestor-') &&
      /\bat prepareSupportingSourceRoot \(/.test(new Error().stack ?? '')
    ) {
      if (++reads === 1)
        setImmediate(() => {
          atAbort = reads;
          controller.abort();
        });
    }
    return result;
  });
  await assert.rejects(
    runExclusiveClinicalOperation(
      f.db,
      async () => {
        const proof = await prepareCorrectionSupportingEvidence(f.db, f.root, f.profileId, [f.ref]);
        proof.dispose();
      },
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
  await immediate();
  t.diagnostic(JSON.stringify({ ancestryReadsAtAbort: atAbort, finalAncestryReads: reads }));
  assert.ok(atAbort > 0 && atAbort <= 128, `first ancestry turn read ${atAbort} metadata rows`);
  assert.equal(reads, atAbort, 'cancelled ancestry reads no more selected parent metadata');
  assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
  t.mock.restoreAll();
  const successor = await prepareCorrectionSupportingEvidence(f.db, f.root, f.profileId, [f.ref]);
  successor.dispose();
  assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
});

test('empty supporting report groups count toward host turns and cancellation', async (t) => {
  const f = await fixture(t, { groups: 130 });
  const controller = new AbortController();
  const originalGet = StatementSync.prototype.get,
    originalParse = JSON.parse;
  let armed = false,
    groups = 0,
    atAbort = -1;
  t.mock.method(StatementSync.prototype, 'get', function (this: StatementSync, ...args: unknown[]) {
    const result = Reflect.apply(originalGet, this, args);
    if (
      !armed &&
      this.sourceSQL ===
        'SELECT id,kind,path,sha256,bytes,details_json FROM source_files WHERE id=?' &&
      /\bat original \(.*record-correction-support\.ts:/.test(new Error().stack ?? '')
    ) {
      armed = true;
      setImmediate(() => {
        atAbort = groups;
        controller.abort();
      });
    }
    return result;
  });
  t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    const [text] = args;
    if (armed && /^"fictional-empty-member-[0-9]+"$/.test(text)) groups++;
    return Reflect.apply(originalParse, JSON, args);
  });
  await assert.rejects(
    runExclusiveClinicalOperation(
      f.db,
      async () => {
        const proof = await prepareCorrectionSupportingEvidence(f.db, f.root, f.profileId, [f.ref]);
        proof.dispose();
      },
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
  await immediate();
  t.diagnostic(JSON.stringify({ groupNamesAtAbort: atAbort, finalGroupNames: groups }));
  assert.ok(armed, 'actual support preparation reached its original and group traversal');
  assert.ok(atAbort > 0 && atAbort <= 32, `first group turn consumed ${atAbort} member names`);
  assert.equal(groups, atAbort, 'cancelled traversal consumes no later member names');
  assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
  t.mock.restoreAll();
  const successor = await prepareCorrectionSupportingEvidence(f.db, f.root, f.profileId, [f.ref]);
  successor.dispose();
  assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
});
