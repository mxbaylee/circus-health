import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatementSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { appendOwnershipDecision } from '../ownership-journal.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, proposeConversion, reviewIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  prepareCollectionClinicalReviewAsync,
  prepareCollectionClinicalReviewDependencies,
  prepareCollectionClinicalReviewForCorrectionSupportAsync,
} from '../intake-review-collection-host.ts';
import {
  consumeCorrectionSupportReview,
  disposeCorrectionSupportReview,
} from '../correction-support-review-preparation.ts';
import {
  prepareCorrectionSupportingEvidence,
  readPreparedCorrectionSupport,
} from '../record-correction-support.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-support-handoff-')),
    profileId = 'fictional-support-handoff',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-original.txt',
    bytes: Buffer.from('Fictional exact supporting original'),
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
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  return {
    db,
    root,
    profileId,
    ref: {
      intakeId: source.id,
      proposalId,
      recordId: record.id,
      candidateId: record.candidateId!,
      candidateVersionId: record.candidateVersionId!,
      originalSourceFileId: source.id,
    },
  };
}

function countSweeps(t: test.TestContext) {
  const originalAll = StatementSync.prototype.all;
  let sweeps = 0,
    identities = 0;
  t.mock.method(StatementSync.prototype, 'all', function (this: StatementSync, ...args: unknown[]) {
    const rows = Reflect.apply(originalAll, this, args);
    if (
      this.sourceSQL ===
      'SELECT id,path,identity,seal FROM main.consumed_source_files ORDER BY id LIMIT 64'
    ) {
      sweeps++;
      identities += rows.length;
    }
    return rows;
  });
  return () => ({ sweeps, identities });
}

test('support preparation performs one complete physical sweep before exposing exact evidence', async (t) => {
  const f = await fixture(t),
    counts = countSweeps(t);
  const proof = await prepareCorrectionSupportingEvidence(f.db, f.root, f.profileId, [f.ref]);
  try {
    assert.deepEqual(counts(), { sweeps: 1, identities: 2 });
    assert.equal(
      readPreparedCorrectionSupport(proof, f.db, f.root, f.profileId, [f.ref])[0]!.recordId,
      f.ref.recordId,
    );
  } finally {
    proof.dispose();
  }
  assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
});

test('opaque review handoff is one-use and default preparation still verifies before returning', async (t) => {
  const f = await fixture(t);
  await prepareCollectionClinicalReviewDependencies(
    f.db,
    f.root,
    f.profileId,
    f.ref.intakeId,
    f.ref.proposalId,
  );
  const counts = countSweeps(t);
  const pending = await prepareCollectionClinicalReviewForCorrectionSupportAsync(
    f.db,
    f.root,
    f.profileId,
    f.ref.intakeId,
    f.ref.proposalId,
  );
  assert.equal(pending.status, 'prepared');
  if (pending.status !== 'prepared') throw Error('Expected fictional prepared review');
  assert.equal('session' in pending, false);
  assert.deepEqual(counts(), { sweeps: 0, identities: 0 });
  const selected = await consumeCorrectionSupportReview(pending.preparation);
  try {
    assert.deepEqual(counts(), { sweeps: 1, identities: 2 });
    assert.ok(selected.session.record(f.ref.recordId, f.ref.candidateId, f.ref.candidateVersionId));
    await assert.rejects(consumeCorrectionSupportReview(pending.preparation), /unavailable/);
    disposeCorrectionSupportReview(pending.preparation);
    assert.ok(selected.session.record(f.ref.recordId, f.ref.candidateId, f.ref.candidateVersionId));
  } finally {
    selected.session.close();
  }
  const ordinary = await prepareCollectionClinicalReviewAsync(
    f.db,
    f.root,
    f.profileId,
    f.ref.intakeId,
    f.ref.proposalId,
  );
  assert.equal(ordinary.status, 'ready');
  if (ordinary.status === 'ready') ordinary.session.close();
  assert.deepEqual(counts(), { sweeps: 2, identities: 4 });
  assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
});

test('late original caller refusal closes the unconsumed session without exposing records', async (t) => {
  const f = await fixture(t);
  await prepareCollectionClinicalReviewDependencies(
    f.db,
    f.root,
    f.profileId,
    f.ref.intakeId,
    f.ref.proposalId,
  );
  let refused = false;
  const reason = Error('Fictional late owner cancellation');
  const pending = await prepareCollectionClinicalReviewForCorrectionSupportAsync(
    f.db,
    f.root,
    f.profileId,
    f.ref.intakeId,
    f.ref.proposalId,
    {
      assertRunning() {
        if (refused) throw reason;
      },
    },
  );
  assert.equal(pending.status, 'prepared');
  if (pending.status !== 'prepared') throw Error('Expected fictional prepared review');
  refused = true;
  await assert.rejects(
    consumeCorrectionSupportReview(pending.preparation),
    (error) => error === reason,
  );
  disposeCorrectionSupportReview(pending.preparation);
  assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
});

test('a later accepted change refuses the original handoff and an abandoned handoff releases scratch', async (t) => {
  const f = await fixture(t);
  await prepareCollectionClinicalReviewDependencies(
    f.db,
    f.root,
    f.profileId,
    f.ref.intakeId,
    f.ref.proposalId,
  );
  const pending = await prepareCollectionClinicalReviewForCorrectionSupportAsync(
    f.db,
    f.root,
    f.profileId,
    f.ref.intakeId,
    f.ref.proposalId,
  );
  if (pending.status !== 'prepared') throw Error('Expected fictional prepared review');
  transaction(f.db, () =>
    appendOwnershipDecision(f.db, 'fictional-later-decision', 'Fictional later ownership review', {
      fictional: true,
    }),
  );
  await assert.rejects(consumeCorrectionSupportReview(pending.preparation), {
    code: 'INTAKE_REVIEW_CHANGED',
  });
  assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
  const abandoned = await prepareCollectionClinicalReviewForCorrectionSupportAsync(
    f.db,
    f.root,
    f.profileId,
    f.ref.intakeId,
    f.ref.proposalId,
  );
  if (abandoned.status !== 'prepared') throw Error('Expected fictional prepared review');
  disposeCorrectionSupportReview(abandoned.preparation);
  await assert.rejects(consumeCorrectionSupportReview(abandoned.preparation), /unavailable/);
  assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
});
