import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { openDatabase, HttpError, currentTransactionToken, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, proposeConversion } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { prepareCollectionClinicalReview } from '../intake-review-collection-host.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import {
  acceptIntakeReportSelectionAsync,
  getIntakeReportAcceptance,
} from '../intake-report-acceptance.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { iterateIntakeEnvelopeText } from '../intake-collection-envelope.ts';
import type { IntakeReportAcceptanceRequest } from '../../shared/intake.ts';
import { prepareIntakeLookupIndices } from '../intake-lookup-state.ts';
import { readIntakeEnvelope, stageIntakeEnvelope } from '../intake-authority.ts';
import { recordDurabilityStatus } from '../record-versions.ts';
import {
  retainedIntakeAcceptance,
  maximumIntakeDiscoveryOrder,
} from '../intake-lookup-projection.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

function line(id: string) {
  return JSON.stringify({
    format: 'health-record-v1',
    id,
    kind: 'document',
    payload: { text: 'Fictional ' + id },
    provenance: {
      capturedVia: 'Fictional export',
      sourceSystem: 'Fictional clinic',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'page ' + id,
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional ' + id,
      date: '2026-01-01',
    },
  });
}

for (const count of [1, 65])
  test(
    `native public acceptance reuses its complete ${count}-source discovery frontier`,
    { timeout: 120000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'fictional-frontier-acceptance-'));
      const profileId = 'fictional-frontier';
      const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
      // Count public acceptance work without filesystem journal publication;
      // the original integration cases below retain that durability coverage.
      memoryRecordAuthority(db);
      t.after(() => {
        clearIntakeStateCache(db);
        db.close();
        rmSync(root, { recursive: true, force: true });
      });
      const original = uploadIntake(db, root, profileId, {
        filename: 'fictional-selected.jsonl',
        bytes: Buffer.from(line('frontier-selected')),
      });
      const proposed = proposeConversion(db, root, profileId, original.id, {
        version: original.version,
        jsonlText: line('frontier-selected'),
        summary: 'Fictional selected record',
      });
      for (let index = 1; index < count; index++) {
        const unrelated = uploadIntake(db, root, profileId, {
          filename: `fictional-unrelated-${index}.txt`,
          bytes: Buffer.from(`Fictional unrelated original ${index}`),
        });
        await buildIntakeCollectionEnvelope(db, { id: unrelated.id });
      }
      await buildIntakeCollectionEnvelope(db, { id: original.id });
      await prepareCollectionReviewMembership(db, { id: original.id });
      await prepareIntakeLookupIndices(db);
      const proposalId = proposed.proposals.at(-1)!.id;
      const reviewed = prepareCollectionClinicalReview(
        db,
        root,
        profileId,
        original.id,
        proposalId,
      );
      if (reviewed.status !== 'ready') throw Error('Expected selected native review');
      const review = reviewed.session.review;
      const input: IntakeReportAcceptanceRequest = {
        operationId: randomUUID(),
        blocks: [
          {
            intakeId: original.id,
            proposalId,
            intakeVersion: review.version,
            reviewToken: review.reviewToken,
            selections: review.records.map((record) => ({
              recordId: record.id,
              candidateId: record.candidateId!,
              candidateVersionId: record.candidateVersionId!,
              mapping: record.mapping,
            })),
          },
        ],
      };
      const prepare = DatabaseSync.prototype.prepare;
      const get = StatementSync.prototype.get;
      const all = StatementSync.prototype.all;
      const iterate = StatementSync.prototype.iterate;
      const queries = new WeakMap<StatementSync, 'paged' | 'complete'>();
      let outsideRows = 0,
        insideRows = 0,
        rowsAtHostTurn = -1;
      let hostTurn: Promise<void> | undefined;
      const countRow = (statement: StatementSync, row: unknown) => {
        const kind = queries.get(statement);
        if (!kind || !row) return;
        if (currentTransactionToken(db)) insideRows++;
        else if (kind === 'paged') {
          outsideRows++;
          hostTurn ??= new Promise<void>((resolve) =>
            setImmediate(() => {
              rowsAtHostTurn = outsideRows;
              resolve();
            }),
          );
        }
      };
      DatabaseSync.prototype.prepare = function (sql: string) {
        const statement = prepare.call(this, sql);
        if (
          this === db &&
          sql.includes("FROM source_files WHERE kind='intake_original'") &&
          sql.includes('ORDER BY rowid')
        ) {
          if (sql.includes('frontier_rowid')) queries.set(statement, 'paged');
          else if (sql.startsWith('SELECT id,kind,sha256,details_json '))
            queries.set(statement, 'complete');
        }
        return statement;
      };
      StatementSync.prototype.get = function (
        this: StatementSync,
        ...parameters: Parameters<StatementSync['get']>
      ) {
        const row = Reflect.apply(get, this, parameters);
        countRow(this, row);
        return row;
      } as typeof StatementSync.prototype.get;
      StatementSync.prototype.all = function (
        this: StatementSync,
        ...parameters: Parameters<StatementSync['all']>
      ) {
        const rows = Reflect.apply(all, this, parameters) as ReturnType<StatementSync['all']>;
        for (const row of rows) countRow(this, row);
        return rows;
      } as typeof StatementSync.prototype.all;
      StatementSync.prototype.iterate = function (
        this: StatementSync,
        ...parameters: Parameters<StatementSync['iterate']>
      ) {
        const statement = this;
        const rows = Reflect.apply(iterate, statement, parameters) as ReturnType<
          StatementSync['iterate']
        >;
        return (function* () {
          for (const row of rows) {
            countRow(statement, row);
            yield row;
          }
        })();
      } as typeof StatementSync.prototype.iterate;
      let saved: Awaited<ReturnType<typeof acceptIntakeReportSelectionAsync>>;
      try {
        saved = await acceptIntakeReportSelectionAsync(db, root, profileId, input);
        await hostTurn;
      } finally {
        DatabaseSync.prototype.prepare = prepare;
        StatementSync.prototype.get = get;
        StatementSync.prototype.all = all;
        StatementSync.prototype.iterate = iterate;
      }
      assert.equal(saved.receipt.acceptedCount, 1);
      assert.equal(saved.replayed, false);
      const replay = await acceptIntakeReportSelectionAsync(db, root, profileId, input);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.receipt, saved.receipt);
      const documents = db.prepare('SELECT title FROM documents').all();
      assert.deepEqual(
        documents.map((row) => row.title),
        ['Fictional frontier-selected'],
      );
      t.diagnostic(JSON.stringify({ count, outsideRows, insideRows, rowsAtHostTurn }));
      assert.equal(
        insideRows,
        0,
        'Complete source enumeration must precede the application transaction',
      );
      assert.equal(outsideRows, 0, 'The complete prepared discovery proof avoids a second scan');
      assert.equal(rowsAtHostTurn, -1, 'Admission does not start a redundant paged scan');
    },
  );

for (const retainedCount of [1, 65])
  test(
    `one public native acceptance revisits only changed receipt contributions after ${retainedCount} retained receipts`,
    { timeout: 120000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'fictional-receipt-increment-'));
      const profileId = 'fictional-receipts';
      const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
      const authority = memoryRecordAuthority(db);
      t.after(() => {
        clearIntakeStateCache(db);
        db.close();
        rmSync(root, { recursive: true, force: true });
      });
      const selected = uploadIntake(db, root, profileId, {
        filename: 'fictional-selected.jsonl',
        bytes: Buffer.from(line('receipt-selected')),
      });
      const proposed = proposeConversion(db, root, profileId, selected.id, {
        version: selected.version,
        jsonlText: line('receipt-selected'),
        summary: 'Fictional selected record',
      });
      const control = uploadIntake(db, root, profileId, {
        filename: 'fictional-control.txt',
        bytes: Buffer.from('Fictional unrelated original'),
      });
      const seed = (id: string, receipts: Array<Record<string, unknown>>) => {
        const envelope = readIntakeEnvelope(db, { id }) as {
          intake: { workflow?: Record<string, unknown> };
        };
        assert.ok(envelope?.intake);
        envelope.intake.workflow ??= {};
        envelope.intake.workflow.reportAcceptances = receipts;
        transaction(db, () => stageIntakeEnvelope(db, { id }, envelope));
      };
      const retained = Array.from({ length: retainedCount }, (_, index) => ({
        receipt: { operationId: `fictional-retained-${index}` },
        marker: `fictional-history-${index}`,
      }));
      seed(selected.id, retained);
      const controlReceipt = {
        receipt: { operationId: 'fictional-control-receipt' },
        marker: 'fictional-control',
      };
      seed(control.id, [controlReceipt]);
      for (const source of [selected, control]) {
        await buildIntakeCollectionEnvelope(db, { id: source.id });
        await buildVerifiedWorkflowSummary(
          db,
          { id: source.id },
          { mappingVersion: 'fictional-v1', isSourceContextVersion: () => false },
        );
      }
      await prepareCollectionReviewMembership(db, { id: selected.id });
      await prepareIntakeLookupIndices(db);
      assert.deepEqual(retainedIntakeAcceptance(db, retained[0]!.receipt.operationId), retained[0]);
      assert.deepEqual(
        retainedIntakeAcceptance(db, controlReceipt.receipt.operationId),
        controlReceipt,
      );
      const maximum = maximumIntakeDiscoveryOrder(db);
      const proposalId = proposed.proposals.at(-1)!.id;
      const reviewed = prepareCollectionClinicalReview(
        db,
        root,
        profileId,
        selected.id,
        proposalId,
      );
      if (reviewed.status !== 'ready') throw Error('Expected selected native review');
      const review = reviewed.session.review;
      const input: IntakeReportAcceptanceRequest = {
        operationId: randomUUID(),
        blocks: [
          {
            intakeId: selected.id,
            proposalId,
            intakeVersion: review.version,
            reviewToken: review.reviewToken,
            selections: review.records.map((record) => ({
              recordId: record.id,
              candidateId: record.candidateId!,
              candidateVersionId: record.candidateVersionId!,
              mapping: record.mapping,
            })),
          },
        ],
      };
      const saved = await acceptIntakeReportSelectionAsync(db, root, profileId, input);
      assert.equal(saved.replayed, false);
      assert.equal(saved.receipt.acceptedCount, 1);
      const selectedAfterAcceptance = [...iterateIntakeEnvelopeText(db, { id: selected.id })].join(
        '',
      );
      const emitted = JSON.parse(selectedAfterAcceptance);
      const newReceipt = emitted.intake.workflow.reportAcceptances.at(-1);
      assert.equal(newReceipt.receipt.operationId, input.operationId);
      const beforeObjects = authority.objects.size;
      const beforeSequence = recordDurabilityStatus(db)?.sequence;
      const beforeTransactions = Number(
        db.prepare('SELECT COUNT(*) AS n FROM __record_transactions').get()!.n,
      );
      const visited = new Map<string, number>();
      const run = StatementSync.prototype.run;
      let privateReceiptRowsWritten = 0;
      StatementSync.prototype.run = function (
        this: StatementSync,
        ...parameters: Parameters<StatementSync['run']>
      ) {
        const result = Reflect.apply(run, this, parameters) as ReturnType<StatementSync['run']>;
        if (/\b(?:INTO|UPDATE|FROM)\s+acceptances\b/i.test(this.sourceSQL))
          privateReceiptRowsWritten += Number(result.changes);
        return result;
      } as typeof StatementSync.prototype.run;
      let fresh: Awaited<ReturnType<typeof prepareIntakeLookupIndices>>;
      try {
        fresh = await prepareIntakeLookupIndices(db, {
          onCheckpoint: ({ sourceId, visited: count }) => {
            visited.set(sourceId, Math.max(visited.get(sourceId) ?? 0, count));
          },
        });
      } finally {
        StatementSync.prototype.run = run;
      }
      const changedVisits = visited.get(selected.id) ?? 0;
      const controlVisits = visited.get(control.id) ?? 0;
      t.diagnostic(
        JSON.stringify({
          retainedCount,
          changedVisits,
          controlVisits,
          privateReceiptRowsWritten,
          prepared: fresh.prepared,
        }),
      );
      assert.equal(fresh.prepared, 0, 'Existing complete v6 policy remains selected');
      assert.equal(authority.objects.size, beforeObjects);
      assert.equal(recordDurabilityStatus(db)?.sequence, beforeSequence);
      assert.equal(
        [...iterateIntakeEnvelopeText(db, { id: selected.id })].join(''),
        selectedAfterAcceptance,
      );
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS n FROM __record_transactions').get()!.n),
        beforeTransactions,
      );
      assert.equal(maximumIntakeDiscoveryOrder(db), maximum);
      assert.deepEqual(retainedIntakeAcceptance(db, retained[0]!.receipt.operationId), retained[0]);
      assert.deepEqual(retainedIntakeAcceptance(db, input.operationId), newReceipt);
      assert.deepEqual(
        retainedIntakeAcceptance(db, controlReceipt.receipt.operationId),
        controlReceipt,
      );
      assert.equal(retainedIntakeAcceptance(db, 'fictional-missing-receipt'), null);
      const replay = await acceptIntakeReportSelectionAsync(db, root, profileId, input);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.receipt, saved.receipt);
      db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
        'fictional-raw-recert',
        retainedCount,
      );
      const recertVisits = new Map<string, number>();
      const recertified = await prepareIntakeLookupIndices(db, {
        onCheckpoint: ({ sourceId, visited: count }) => {
          recertVisits.set(sourceId, Math.max(recertVisits.get(sourceId) ?? 0, count));
        },
      });
      t.diagnostic(
        JSON.stringify({
          retainedCount,
          recertChangedVisits: recertVisits.get(selected.id) ?? 0,
          recertControlVisits: recertVisits.get(control.id) ?? 0,
          recertPrepared: recertified.prepared,
        }),
      );
      assert.equal(recertified.prepared, 0);
      assert.equal(recertVisits.get(selected.id) ?? 0, 0);
      assert.equal(recertVisits.get(control.id) ?? 0, 0);
      assert.equal(controlVisits, 0, 'Untouched source retains its private receipt projection');
      assert.equal(
        privateReceiptRowsWritten,
        1,
        'One append writes only its new private receipt row',
      );
      assert.ok(
        changedVisits <= 1,
        `${changedVisits} changed-source receipt visits for one append`,
      );
    },
  );
// Two durable schema migrations plus coupled checkpoint preparation exercise
// host integration. Work-count assertions, rather than this safety timeout,
// qualify scaling; slower CI filesystems need time to finish those writes.
for (const sameOriginal of [true, false])
  test(
    `native public grouped acceptance preserves ${sameOriginal ? 'one original history' : 'distinct originals'}, exact replay and atomic receipt`,
    { timeout: 120000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'fictional-native-report-host-')),
        profileId = 'fictional-reports',
        db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
      attachPersonalDurability(db, { root, profileId });
      t.after(() => {
        clearIntakeStateCache(db);
        db.close();
        rmSync(root, { recursive: true, force: true });
      });
      const upload = (id: string) =>
        uploadIntake(db, root, profileId, {
          filename: 'fictional-' + id + '.jsonl',
          newProviderName: 'Fictional clinic ' + id,
          bytes: Buffer.from(line(id)),
        });
      const first = upload('one'),
        second = sameOriginal ? first : upload('two'),
        current = new Map<string, ReturnType<typeof proposeConversion>>(
          [first, second].map((item) => [item.id, item]),
        );
      const selected = [first, second].map((item, index) => {
        const original = current.get(item.id)!,
          proposed = proposeConversion(db, root, profileId, item.id, {
            version: original.version,
            jsonlText: line(index ? 'two' : 'one'),
            summary: 'Fictional selected block',
          });
        current.set(item.id, proposed);
        return { intakeId: item.id, proposalId: proposed.proposals.at(-1)!.id };
      });
      for (const item of current.values()) {
        await buildIntakeCollectionEnvelope(db, { id: item.id });
        await prepareCollectionReviewMembership(db, { id: item.id });
      }
      const input: IntakeReportAcceptanceRequest = {
        operationId: randomUUID(),
        blocks: selected.map((block) => {
          const reviewed = prepareCollectionClinicalReview(
            db,
            root,
            profileId,
            block.intakeId,
            block.proposalId,
          );
          if (reviewed.status !== 'ready') throw Error('Expected complete selected review');
          const review = reviewed.session.review;
          return {
            ...block,
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
      const before = { ...intakeWorkCounters(db).warm };
      const saved = await acceptIntakeReportSelectionAsync(db, root, profileId, input);
      assert.equal(saved.receipt.atomic, true);
      assert.equal(saved.receipt.status, 'accepted');
      assert.equal(saved.receipt.acceptedCount, 2);
      assert.equal(saved.replayed, false);
      if (!saved.receipt.atomic) throw Error('Expected atomic receipt');
      assert.equal(saved.receipt.receipts.length, 2);
      if (sameOriginal)
        assert.equal(
          saved.receipt.receipts[1]!.intakeVersionBefore,
          saved.receipt.receipts[0]!.intakeVersionAfter,
        );
      const full = JSON.parse([...iterateIntakeEnvelopeText(db, { id: first.id })].join(''));
      assert.equal(full.intake.workflow.reportAcceptances.length, 1);
      assert.equal(full.intake.importHistory?.length ?? 0, sameOriginal ? 1 : 0);
      clearIntakeStateCache(db);
      const replay = await acceptIntakeReportSelectionAsync(db, root, profileId, input);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.receipt, saved.receipt);
      assert.deepEqual(
        getIntakeReportAcceptance(db, root, profileId, input.operationId).receipt,
        saved.receipt,
      );
      const changed = structuredClone(input);
      changed.blocks[0]!.selections[0]!.mapping.documentTitle = 'Different fictional request';
      await assert.rejects(
        acceptIntakeReportSelectionAsync(db, root, profileId, changed),
        (error: unknown) => error instanceof HttpError && error.code === 'OPERATION_CONFLICT',
      );
      assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.envelopeHydrations);
      assert.equal(intakeWorkCounters(db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
    },
  );

test(
  'native partial approval preserves saved and stale outcomes without duplicate coordinator receipts',
  { timeout: 120000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-native-partial-host-')),
      profileId = 'fictional-partial',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    t.after(() => {
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const original = uploadIntake(db, root, profileId, {
      filename: 'fictional-partial.jsonl',
      bytes: Buffer.from(line('original')),
    });
    const proposed = proposeConversion(db, root, profileId, original.id, {
      version: original.version,
      jsonlText: line('first') + '\n' + line('second'),
      summary: 'Fictional two records',
    });
    await buildIntakeCollectionEnvelope(db, { id: original.id });
    await prepareCollectionReviewMembership(db, { id: original.id });
    const reviewed = prepareCollectionClinicalReview(
      db,
      root,
      profileId,
      original.id,
      proposed.proposals.at(-1)!.id,
    );
    if (reviewed.status !== 'ready') throw Error('Expected selected review');
    const review = reviewed.session.review;
    const input: IntakeReportAcceptanceRequest = {
      operationId: randomUUID(),
      mode: 'partial-v1',
      blocks: [
        {
          intakeId: original.id,
          proposalId: proposed.proposals.at(-1)!.id,
          intakeVersion: review.version,
          reviewToken: review.reviewToken,
          selections: review.records.map((record, ordinal) => ({
            recordId: record.id,
            candidateId: record.candidateId!,
            candidateVersionId: ordinal ? 'stale-fictional-version' : record.candidateVersionId!,
            selectionReviewToken: record.selectionReviewToken,
            mapping: record.mapping,
          })),
        },
      ],
    };
    reviewed.session.close();
    const assertNoPolicies = () => {
      assert.equal(reviewIssueScratchCounts(db).databases, 0);
      assert.equal(reviewIssueScratchCounts(db).rows, 0);
      assert.equal(reviewIssueScratchCounts(db).scopes, 0);
    };
    assertNoPolicies();
    const before = { ...intakeWorkCounters(db).warm };
    const saving = acceptIntakeReportSelectionAsync(db, root, profileId, input);
    await Promise.resolve();
    assert.throws(() => getIntakeReportAcceptance(db, root, profileId, input.operationId), {
      code: 'REPORT_ACCEPTANCE_IN_PROGRESS',
    });
    const saved = await saving;
    assertNoPolicies();
    assert.equal(saved.receipt.atomic, false);
    if (saved.receipt.atomic) throw Error('Expected partial receipt');
    assert.equal(saved.receipt.acceptedCount, 1);
    assert.deepEqual(
      saved.receipt.items.map((item) => item.status),
      ['saved', 'needs_review'],
    );
    const state = JSON.parse([...iterateIntakeEnvelopeText(db, { id: original.id })].join(''));
    assert.equal(state.intake.workflow.reportAcceptances?.length ?? 0, 0);
    clearIntakeStateCache(db);
    const replay = await acceptIntakeReportSelectionAsync(db, root, profileId, input);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, saved.receipt);
    assertNoPolicies();
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.deepEqual(
        (await acceptIntakeReportSelectionAsync(db, root, profileId, input)).receipt,
        saved.receipt,
      );
      assertNoPolicies();
    }
    assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.envelopeHydrations);
    assert.equal(intakeWorkCounters(db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
  },
);
