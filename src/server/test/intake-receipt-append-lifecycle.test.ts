import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { openDatabase, observeTransactionOutcome, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, proposeConversion } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { prepareCollectionClinicalReview } from '../intake-review-collection-host.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import { acceptIntakeReportSelectionAsync } from '../intake-report-acceptance.ts';
import { prepareIntakeLookupIndices } from '../intake-lookup-state.ts';
import {
  INTAKE_LOOKUP_INDEX_COLLECTION,
  INTAKE_LOOKUP_INDEX_POLICY,
} from '../intake-lookup-state.ts';
import { retainedIntakeAcceptance } from '../intake-lookup-projection.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { schemaKey } from '../intake-envelope-schema.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { readIntakeEnvelope, stageIntakeEnvelope } from '../intake-authority.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import type { IntakeReportAcceptanceRequest } from '../../shared/intake.ts';

const line = (id: string) =>
  JSON.stringify({
    format: 'health-record-v1',
    id,
    kind: 'document',
    payload: { text: 'Fictional receipt source ' + id },
    provenance: {
      capturedVia: 'Fictional export',
      sourceSystem: 'Fictional clinic',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional receipt ' + id,
      date: '2026-01-01',
    },
  });

async function fixture(t: test.TestContext, grouped = false) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-receipt-lifecycle-'));
  const profileId = 'fictional-receipt-lifecycle';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const selected = uploadIntake(db, root, profileId, {
    filename: 'fictional-receipt.jsonl',
    bytes: Buffer.from(line('fictional-receipt')),
  });
  const proposed = proposeConversion(db, root, profileId, selected.id, {
    version: selected.version,
    jsonlText: line('fictional-receipt'),
    summary: 'Fictional receipt',
  });
  const other = grouped
    ? uploadIntake(db, root, profileId, {
        filename: 'fictional-other.jsonl',
        bytes: Buffer.from(line('fictional-other')),
      })
    : undefined;
  const otherProposed = other
    ? proposeConversion(db, root, profileId, other.id, {
        version: other.version,
        jsonlText: line('fictional-other'),
        summary: 'Fictional other receipt',
      })
    : undefined;
  for (const { source, operation } of [
    { source: selected, operation: 'fictional-retained' },
    ...(other ? [{ source: other, operation: 'fictional-other-retained' }] : []),
  ]) {
    const envelope = readIntakeEnvelope(db, { id: source.id }) as {
      intake: { workflow?: Record<string, unknown> };
    };
    envelope.intake.workflow ??= {};
    envelope.intake.workflow.reportAcceptances = [
      { receipt: { operationId: operation }, marker: 'earlier' },
    ];
    transaction(db, () => stageIntakeEnvelope(db, { id: source.id }, envelope));
    await buildIntakeCollectionEnvelope(db, { id: source.id });
    await buildVerifiedWorkflowSummary(
      db,
      { id: source.id },
      {
        mappingVersion: 'fictional-v1',
        isSourceContextVersion: () => false,
      },
    );
    await prepareCollectionReviewMembership(db, { id: source.id });
  }
  await prepareIntakeLookupIndices(db);
  assert.deepEqual(retainedIntakeAcceptance(db, 'fictional-retained'), {
    receipt: { operationId: 'fictional-retained' },
    marker: 'earlier',
  });
  const input: IntakeReportAcceptanceRequest = {
    operationId: randomUUID(),
    blocks: [
      { source: selected, proposal: proposed },
      ...(other && otherProposed ? [{ source: other, proposal: otherProposed }] : []),
    ].map(({ source, proposal }) => {
      const proposalId = proposal.proposals.at(-1)!.id;
      const reviewed = prepareCollectionClinicalReview(db, root, profileId, source.id, proposalId);
      if (reviewed.status !== 'ready') throw Error('Expected selected fictional review');
      const review = reviewed.session.review;
      return {
        intakeId: source.id,
        proposalId,
        intakeVersion: review.version,
        reviewToken: review.reviewToken,
        selections: review.records.map((record) => ({
          recordId: record.id,
          candidateId: record.candidateId!,
          candidateVersionId: record.candidateVersionId!,
          mapping: record.mapping,
        })),
      };
    }),
  };
  return { db, root, profileId, input, selected, other };
}

for (const failure of ['rollback', 'release'] as const)
  test(`native receipt append is not retained after an owned ${failure} failure`, async (t) => {
    const f = await fixture(t);
    const originalPrepare = DatabaseSync.prototype.prepare;
    const originalExec = DatabaseSync.prototype.exec;
    let armed = false;
    let failed = false;
    const outcomes: Array<{ committed: boolean; succeeded: boolean }> = [];
    const stop = observeTransactionOutcome(f.db, (outcome) => {
      if (armed) outcomes.push({ committed: outcome.committed, succeeded: outcome.succeeded });
    });
    DatabaseSync.prototype.prepare = function (sql: string) {
      if (this === f.db && sql.startsWith("UPDATE manual_batches SET status='verified'"))
        armed = true;
      return originalPrepare.call(this, sql);
    };
    DatabaseSync.prototype.exec = function (sql: string) {
      if (
        this === f.db &&
        armed &&
        !failed &&
        (failure === 'rollback'
          ? sql === "UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'"
          : sql === 'DELETE FROM __record_changed' && !this.isTransaction)
      ) {
        failed = true;
        throw Error('fictional ' + failure + ' failure');
      }
      return originalExec.call(this, sql);
    };
    try {
      await assert.rejects(
        acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, f.input),
        new RegExp(`fictional ${failure} failure`),
      );
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
      DatabaseSync.prototype.exec = originalExec;
      stop();
    }
    assert.equal(armed, true);
    assert.equal(failed, true);
    assert.deepEqual(outcomes, [{ committed: failure === 'release', succeeded: false }]);
    if (failure === 'release') f.db.exec('DELETE FROM __record_changed');
    let changedVisits = 0;
    await prepareIntakeLookupIndices(f.db, {
      onCheckpoint: ({ sourceId, visited }) => {
        if (sourceId === f.selected.id) changedVisits = Math.max(changedVisits, visited);
      },
    });
    assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-retained'), {
      receipt: { operationId: 'fictional-retained' },
      marker: 'earlier',
    });
    if (failure === 'rollback') {
      assert.equal(retainedIntakeAcceptance(f.db, f.input.operationId), null);
      assert.equal(changedVisits, 1, 'The old receipt is rederived after the aborted write');
    } else {
      assert.equal(
        (
          retainedIntakeAcceptance(f.db, f.input.operationId) as {
            receipt: { operationId: string };
          }
        ).receipt.operationId,
        f.input.operationId,
      );
      assert.ok(changedVisits > 1, 'Committed failure must derive complete receipt scope');
    }
  });

for (const failure of ['rollback', 'release'] as const)
  test(`grouped receipt append is all-or-nothing after an owned ${failure} failure`, async (t) => {
    const f = await fixture(t, true);
    assert.ok(f.other);
    const originalPrepare = DatabaseSync.prototype.prepare;
    const originalExec = DatabaseSync.prototype.exec;
    let armed = false;
    let failed = false;
    const outcomes: Array<{ committed: boolean; succeeded: boolean }> = [];
    const stop = observeTransactionOutcome(f.db, (outcome) => {
      if (armed) outcomes.push({ committed: outcome.committed, succeeded: outcome.succeeded });
    });
    DatabaseSync.prototype.prepare = function (sql: string) {
      if (this === f.db && sql.startsWith("UPDATE manual_batches SET status='verified'"))
        armed = true;
      return originalPrepare.call(this, sql);
    };
    DatabaseSync.prototype.exec = function (sql: string) {
      if (
        this === f.db &&
        armed &&
        !failed &&
        (failure === 'rollback'
          ? sql === "UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'"
          : sql === 'DELETE FROM __record_changed' && !this.isTransaction)
      ) {
        failed = true;
        throw Error('fictional grouped ' + failure + ' failure');
      }
      return originalExec.call(this, sql);
    };
    try {
      await assert.rejects(
        acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, f.input),
        new RegExp(`fictional grouped ${failure} failure`),
      );
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
      DatabaseSync.prototype.exec = originalExec;
      stop();
    }
    assert.equal(armed, true);
    assert.equal(failed, true);
    assert.deepEqual(outcomes, [{ committed: failure === 'release', succeeded: false }]);
    if (failure === 'release') f.db.exec('DELETE FROM __record_changed');
    const visits = new Map<string, number>();
    await prepareIntakeLookupIndices(f.db, {
      onCheckpoint: ({ sourceId, visited }) => {
        visits.set(sourceId, Math.max(visits.get(sourceId) ?? 0, visited));
      },
    });
    for (const operation of ['fictional-retained', 'fictional-other-retained'])
      assert.deepEqual(retainedIntakeAcceptance(f.db, operation), {
        receipt: { operationId: operation },
        marker: 'earlier',
      });
    if (failure === 'rollback') {
      assert.equal(retainedIntakeAcceptance(f.db, f.input.operationId), null);
    } else {
      assert.equal(
        (
          retainedIntakeAcceptance(f.db, f.input.operationId) as {
            receipt: { operationId: string };
          }
        ).receipt.operationId,
        f.input.operationId,
      );
      assert.ok((visits.get(f.selected.id) ?? 0) > 1);
      assert.equal(visits.get(f.other.id), 1);
    }
  });

for (const mismatch of [false, true])
  test(`native receipt append ${mismatch ? 'rejects' : 'accepts'} a selected point ${mismatch ? 'mismatch' : 'match'}`, async (t) => {
    const f = await fixture(t);
    const saved = await acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, f.input);
    assert.equal(saved.replayed, false);
    const source = {
      id: f.selected.id,
      sha256: String(
        f.db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(f.selected.id)!.sha256,
      ),
    };
    const view = openIntakeCollectionEnvelope(f.db, source);
    const intake = view.child(view.root(), 'intake')!;
    const workflow = view.child(intake, 'workflow')!;
    const prior = view.childAt(workflow, 'reportAcceptances', 0)!;
    const latest = view.childAt(workflow, 'reportAcceptances', 1)!;
    const selected = selectedEnvelopeStore(f.db, source).collections;
    const operationId = randomUUID();
    selected.commitMaintenance(
      selected.prepare(selected.openView(), {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: intakeSourceVersion(f.db, source.id).rawVersion,
        changes: [
          {
            area: 'builds',
            collection: INTAKE_LOOKUP_INDEX_COLLECTION,
            op: 'put',
            key: 'complete',
            value: JSON.stringify(view.logical),
          },
          {
            area: 'builds',
            collection: INTAKE_LOOKUP_INDEX_COLLECTION,
            op: 'put',
            key: 'policy',
            value: INTAKE_LOOKUP_INDEX_POLICY,
          },
          {
            area: 'builds',
            collection: INTAKE_LOOKUP_INDEX_COLLECTION,
            op: 'put',
            key: schemaKey(
              'lookup-acceptance-operation-first',
              Buffer.from(f.input.operationId).toString('hex').toUpperCase(),
            ),
            value: view.address(mismatch ? prior : latest),
          },
        ],
      }),
    );
    const originalRun = StatementSync.prototype.run;
    let appendWrites = 0;
    StatementSync.prototype.run = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['run']>
    ) {
      const result = Reflect.apply(originalRun, this, parameters) as ReturnType<
        StatementSync['run']
      >;
      if (this.sourceSQL.startsWith('INSERT OR IGNORE INTO acceptances'))
        appendWrites += Number(result.changes);
      return result;
    } as typeof StatementSync.prototype.run;
    let changedVisits = 0;
    try {
      await prepareIntakeLookupIndices(f.db, {
        onCheckpoint: ({ sourceId, visited }) => {
          if (sourceId === source.id) changedVisits = Math.max(changedVisits, visited);
        },
      });
    } finally {
      StatementSync.prototype.run = originalRun;
    }
    t.diagnostic(JSON.stringify({ mismatch, changedVisits, appendWrites }));
    if (mismatch) {
      assert.ok(changedVisits > 1, 'Mismatched point forces full source derivation');
      assert.equal(appendWrites, 0, 'No append writes precede selected-point validation');
    } else {
      assert.equal(changedVisits, 1);
      assert.equal(appendWrites, 1);
    }
  });
