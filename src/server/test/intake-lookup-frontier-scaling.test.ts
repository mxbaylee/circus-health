import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { openDatabase, currentTransactionToken } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, proposeConversion } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { prepareCollectionClinicalReview } from '../intake-review-collection-host.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import { prepareDuplicateEvidenceIndex } from '../duplicate-evidence-index.ts';
import { readPreparedSourceAttention } from '../intake-source-attention.ts';
import { acceptIntakeReportSelectionAsync } from '../intake-report-acceptance.ts';
import { prepareIntakeLookupIndices } from '../intake-lookup-state.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import {
  captureIntakeFrontierAttempts,
  ensureIntakeFrontierObserver,
  intakeFrontierAttemptCounts,
  readIntakeFrontierAttempts,
} from '../intake-lookup-frontier-observer.ts';
import {
  clearIntakeLookupCache,
  maximumIntakeDiscoveryOrder,
  retainedIntakeAcceptance,
} from '../intake-lookup-projection.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import type { IntakeReportAcceptanceRequest } from '../../shared/intake.ts';

function fictionalLine(id: string) {
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

for (const { count, warmAttention } of [
  { count: 1, warmAttention: false },
  { count: 8, warmAttention: false },
  { count: 8, warmAttention: true },
])
  test(`one accepted source keeps global lookup frontier work changed-only among ${count} originals${warmAttention ? ' with prepared attention' : ''}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-lookup-frontier-'));
    const profileId = 'fictional-frontier';
    const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    memoryRecordAuthority(db);
    t.after(() => {
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const selectedText = [fictionalLine('selected'), fictionalLine('selected-followup')].join('\n');
    const original = uploadIntake(db, root, profileId, {
      filename: 'fictional-selected.jsonl',
      bytes: Buffer.from(selectedText),
    });
    const proposed = proposeConversion(db, root, profileId, original.id, {
      version: original.version,
      jsonlText: selectedText,
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
    const reviewed = prepareCollectionClinicalReview(db, root, profileId, original.id, proposalId);
    if (reviewed.status !== 'ready') throw Error('Expected selected native review');
    const review = reviewed.session.review;
    const request: IntakeReportAcceptanceRequest = {
      operationId: randomUUID(),
      blocks: [
        {
          intakeId: original.id,
          proposalId,
          intakeVersion: review.version,
          reviewToken: review.reviewToken,
          selections: review.records.slice(0, 1).map((record) => ({
            recordId: record.id,
            candidateId: record.candidateId!,
            candidateVersionId: record.candidateVersionId!,
            mapping: record.mapping,
          })),
        },
      ],
    };
    await acceptIntakeReportSelectionAsync(db, root, profileId, request);
    await prepareIntakeLookupIndices(db);
    await prepareDuplicateEvidenceIndex(db);
    const followup = prepareCollectionClinicalReview(db, root, profileId, original.id, proposalId);
    if (followup.status !== 'ready') throw Error('Expected follow-up native review');
    const nextRecord = followup.session.review.records.at(-1)!;
    const nextRequest: IntakeReportAcceptanceRequest = {
      operationId: randomUUID(),
      blocks: [
        {
          intakeId: original.id,
          proposalId,
          intakeVersion: followup.session.review.version,
          reviewToken: followup.session.review.reviewToken,
          selections: [
            {
              recordId: nextRecord.id,
              candidateId: nextRecord.candidateId!,
              candidateVersionId: nextRecord.candidateVersionId!,
              mapping: nextRecord.mapping,
            },
          ],
        },
      ],
    };
    if (warmAttention) await readPreparedSourceAttention(db, profileId, 0, () => 0);
    ensureIntakeFrontierObserver(db);
    await prepareIntakeLookupIndices(db);
    const observerSnapshot = captureIntakeFrontierAttempts(db);
    assert.ok(observerSnapshot);
    const maximumBefore = maximumIntakeDiscoveryOrder(db);
    const preparedStamp = reviewReadStamp(db);
    const runBeforeAcceptance = StatementSync.prototype.run;
    const getBeforeAcceptance = StatementSync.prototype.get;
    const allBeforeAcceptance = StatementSync.prototype.all;
    const iterateBeforeAcceptance = StatementSync.prototype.iterate;
    const prepareBeforeAcceptance = DatabaseSync.prototype.prepare;
    const execBeforeAcceptance = DatabaseSync.prototype.exec;
    const authorizeBeforeAcceptance = DatabaseSync.prototype.setAuthorizer;
    const functionBeforeAcceptance = DatabaseSync.prototype.function;
    let beforeOwnerMetaWrites = 0;
    let beforeOwnerMetaHeadWrites = 0;
    let beforeOwnerMetaNodeWrites = 0;
    let beforeOwnerMetaOtherWrites = 0;
    let beforeOwnerSourceWrites = 0;
    let ownerStarted = false;
    let pretransactionAuthorizerCalls = 0;
    let pretransactionFunctionCalls = 0;
    let transactionBegins = 0;
    let firstStampDriftAt = 0;
    let firstTempSchemaDriftAt = 0;
    let tempDdlExecs = 0;
    let tempDdlStatements = 0;
    let firstDdlPrefix = '';
    let firstStatementDdlPrefix = '';
    let firstChangingDdlPrefix = '';
    let firstRevokedSql = '';
    let acceptanceOriginalRows = 0;
    const statementWrites = new Map<string, number>();
    const scansOriginals = (sql: string) =>
      /\b(?:FROM|JOIN)\s+(?:main\.)?source_files\b/i.test(sql) &&
      /(?:\bkind|\.kind)\s*=\s*'intake_original'/i.test(sql) &&
      !/\b(?:[a-z_]\w*\.)?id\s*=\s*\?/i.test(sql);
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      const statement = Reflect.apply(prepareBeforeAcceptance, this, [sql]);
      if (this === db && !firstRevokedSql && intakeFrontierAttemptCounts(db)?.revoked)
        firstRevokedSql = sql.replace(/\s+/g, ' ').slice(0, 140);
      return statement;
    } as typeof DatabaseSync.prototype.prepare;
    StatementSync.prototype.get = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['get']>
    ) {
      const row = Reflect.apply(getBeforeAcceptance, this, parameters);
      if (row && scansOriginals(this.sourceSQL)) {
        acceptanceOriginalRows++;
      }
      return row;
    } as typeof StatementSync.prototype.get;
    StatementSync.prototype.iterate = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['iterate']>
    ) {
      const statement = this;
      const rows = Reflect.apply(iterateBeforeAcceptance, statement, parameters);
      return (function* () {
        for (const row of rows) {
          if (scansOriginals(statement.sourceSQL)) {
            acceptanceOriginalRows++;
          }
          yield row;
        }
      })();
    } as typeof StatementSync.prototype.iterate;
    StatementSync.prototype.all = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['all']>
    ) {
      const rows = Reflect.apply(allBeforeAcceptance, this, parameters) as ReturnType<
        StatementSync['all']
      >;
      if (scansOriginals(this.sourceSQL)) acceptanceOriginalRows += rows.length;
      return rows;
    } as typeof StatementSync.prototype.all;
    StatementSync.prototype.run = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['run']>
    ) {
      if (
        /^\s*(?:CREATE|DROP|ALTER)\s+(?:TEMP\s+)?(?:TABLE|INDEX|TRIGGER)\b/i.test(this.sourceSQL)
      ) {
        tempDdlStatements++;
        if (!firstStatementDdlPrefix) firstStatementDdlPrefix = this.sourceSQL.slice(0, 100);
      }
      if (/\bUPDATE\s+manual_batches\b/i.test(this.sourceSQL)) ownerStarted = true;
      const isBeforeOwnerMeta =
        !ownerStarted && /\b(?:INTO|UPDATE|FROM)\s+app_meta\b/i.test(this.sourceSQL);
      const isBeforeOwnerSource =
        !ownerStarted && /\b(?:INTO|UPDATE|FROM)\s+source_files\b/i.test(this.sourceSQL);
      const result = Reflect.apply(runBeforeAcceptance, this, parameters) as ReturnType<
        StatementSync['run']
      >;
      if (Number(result.changes) > 0) {
        const label = this.sourceSQL.replace(/\s+/g, ' ').slice(0, 110);
        statementWrites.set(label, (statementWrites.get(label) ?? 0) + Number(result.changes));
      }
      if (isBeforeOwnerMeta) {
        const changes = Number(result.changes);
        beforeOwnerMetaWrites += changes;
        const key: unknown = parameters[0];
        if (typeof key === 'string' && key.startsWith('intake_state_v1:')) {
          if (key.endsWith(':head')) beforeOwnerMetaHeadWrites += changes;
          else beforeOwnerMetaNodeWrites += changes;
        } else beforeOwnerMetaOtherWrites += changes;
      }
      if (isBeforeOwnerSource) beforeOwnerSourceWrites += Number(result.changes);
      if (!firstRevokedSql && intakeFrontierAttemptCounts(db)?.revoked)
        firstRevokedSql = this.sourceSQL.replace(/\s+/g, ' ').slice(0, 140);
      return result;
    } as typeof StatementSync.prototype.run;
    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
      const isDdl =
        this === db && /\b(?:CREATE|DROP|ALTER)\s+(?:TEMP\s+)?(?:TABLE|INDEX|TRIGGER)\b/i.test(sql);
      const beforeDdl = isDdl
        ? db.prepare('PRAGMA temp.schema_version').get()?.schema_version
        : undefined;
      if (isDdl) {
        tempDdlExecs++;
        if (!firstDdlPrefix) firstDdlPrefix = sql.slice(0, 80);
      }
      if (this === db && sql === 'BEGIN IMMEDIATE') {
        transactionBegins++;
        const current = reviewReadStamp(db);
        if (firstStampDriftAt === 0 && current !== preparedStamp)
          firstStampDriftAt = transactionBegins;
        const tempSchema = db.prepare('PRAGMA temp.schema_version').get()?.schema_version;
        if (firstTempSchemaDriftAt === 0 && tempSchema !== observerSnapshot.tempSchema)
          firstTempSchemaDriftAt = transactionBegins;
      }
      const result = Reflect.apply(execBeforeAcceptance, this, [sql]);
      if (
        isDdl &&
        !firstChangingDdlPrefix &&
        db.prepare('PRAGMA temp.schema_version').get()?.schema_version !== beforeDdl
      )
        firstChangingDdlPrefix = sql.slice(0, 80);
      if (!firstRevokedSql && intakeFrontierAttemptCounts(db)?.revoked)
        firstRevokedSql = sql.replace(/\s+/g, ' ').slice(0, 140);
      return result;
    };
    DatabaseSync.prototype.setAuthorizer = function (
      this: DatabaseSync,
      ...parameters: Parameters<DatabaseSync['setAuthorizer']>
    ) {
      if (this === db && !currentTransactionToken(db)) pretransactionAuthorizerCalls++;
      return Reflect.apply(authorizeBeforeAcceptance, this, parameters);
    } as typeof DatabaseSync.prototype.setAuthorizer;
    DatabaseSync.prototype.function = function (
      this: DatabaseSync,
      ...parameters: Parameters<DatabaseSync['function']>
    ) {
      if (this === db && !currentTransactionToken(db)) pretransactionFunctionCalls++;
      return Reflect.apply(functionBeforeAcceptance, this, parameters);
    } as typeof DatabaseSync.prototype.function;
    let saved: Awaited<ReturnType<typeof acceptIntakeReportSelectionAsync>>;
    try {
      saved = await acceptIntakeReportSelectionAsync(db, root, profileId, nextRequest);
      const acceptedRows = acceptanceOriginalRows;
      for (const _source of db
        .prepare(
          "SELECT id,kind,sha256,details_json,rowid source_order FROM main.source_files WHERE kind='intake_original' ORDER BY rowid",
        )
        .iterate()) {
        // The known full-source fallback must be visible to this work oracle.
      }
      assert.equal(acceptanceOriginalRows - acceptedRows, count);
      acceptanceOriginalRows = acceptedRows;
    } finally {
      StatementSync.prototype.run = runBeforeAcceptance;
      StatementSync.prototype.get = getBeforeAcceptance;
      StatementSync.prototype.all = allBeforeAcceptance;
      StatementSync.prototype.iterate = iterateBeforeAcceptance;
      DatabaseSync.prototype.prepare = prepareBeforeAcceptance;
      DatabaseSync.prototype.exec = execBeforeAcceptance;
      DatabaseSync.prototype.setAuthorizer = authorizeBeforeAcceptance;
      DatabaseSync.prototype.function = functionBeforeAcceptance;
    }
    assert.equal(saved.replayed, false);
    assert.equal(saved.receipt.acceptedCount, 1);
    const ownerAttempts = readIntakeFrontierAttempts(db, observerSnapshot);
    const observerCounts = intakeFrontierAttemptCounts(db);
    const afterObserverSnapshot = captureIntakeFrontierAttempts(db);

    const prepare = DatabaseSync.prototype.prepare;
    const get = StatementSync.prototype.get;
    const all = StatementSync.prototype.all;
    const iterate = StatementSync.prototype.iterate;
    type Phase = 'initial' | 'catalog' | 'final' | 'discovery';
    const phases = new WeakMap<StatementSync, Phase>();
    const rows: Record<Phase, number> = { initial: 0, catalog: 0, final: 0, discovery: 0 };
    let postOriginalRows = 0;
    const countPostOriginal = (_sql: string, count: number) => (postOriginalRows += count);
    let cursorStatements = 0;
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = prepare.call(this, sql);
      if (this === db) {
        if (sql.includes('lookup_rowid') && sql.includes("kind='intake_original'")) {
          phases.set(statement, cursorStatements++ < 2 ? 'initial' : 'final');
        } else if (
          sql.includes('LEFT JOIN') &&
          sql.includes('source_order') &&
          sql.includes("kind='intake_original'")
        ) {
          phases.set(statement, 'catalog');
        } else if (
          /^SELECT id,kind,sha256,details_json FROM (?:main\.)?source_files/i.test(sql) &&
          sql.includes("kind='intake_original'")
        ) {
          phases.set(statement, 'discovery');
        }
      }
      return statement;
    };
    StatementSync.prototype.get = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['get']>
    ) {
      const row = Reflect.apply(get, this, parameters);
      const phase = phases.get(this);
      if (phase && row) rows[phase]++;
      if (row && scansOriginals(this.sourceSQL)) countPostOriginal(this.sourceSQL, 1);
      return row;
    } as typeof StatementSync.prototype.get;
    StatementSync.prototype.iterate = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['iterate']>
    ) {
      const statement = this;
      const result = Reflect.apply(iterate, statement, parameters) as ReturnType<
        StatementSync['iterate']
      >;
      return (function* () {
        for (const row of result) {
          const phase = phases.get(statement);
          if (phase) rows[phase]++;
          if (scansOriginals(statement.sourceSQL)) countPostOriginal(statement.sourceSQL, 1);
          yield row;
        }
      })();
    } as typeof StatementSync.prototype.iterate;
    StatementSync.prototype.all = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['all']>
    ) {
      const result = Reflect.apply(all, this, parameters) as ReturnType<StatementSync['all']>;
      const phase = phases.get(this);
      if (phase) rows[phase] += result.length;
      if (scansOriginals(this.sourceSQL)) countPostOriginal(this.sourceSQL, result.length);
      return result;
    } as typeof StatementSync.prototype.all;
    let fastMaximum = 0;
    let fastFirst: unknown;
    let fastSecond: unknown;
    let fastMissing: unknown;
    try {
      const prepared = await prepareIntakeLookupIndices(db);
      assert.equal(prepared.prepared, 0);
      fastMaximum = maximumIntakeDiscoveryOrder(db);
      fastFirst = retainedIntakeAcceptance(db, request.operationId);
      fastSecond = retainedIntakeAcceptance(db, nextRequest.operationId);
      fastMissing = retainedIntakeAcceptance(db, 'fictional-missing-operation');
      const measuredRows = postOriginalRows;
      const measuredPhases = { ...rows };
      for (const _source of db
        .prepare(
          "SELECT id,kind,sha256,details_json,rowid source_order FROM main.source_files WHERE kind='intake_original' ORDER BY rowid",
        )
        .iterate()) {
        // Keep the calibrated full scan outside the measured post-acceptance work.
      }
      assert.equal(postOriginalRows - measuredRows, count);
      postOriginalRows = measuredRows;
      Object.assign(rows, measuredPhases);
    } finally {
      DatabaseSync.prototype.prepare = prepare;
      StatementSync.prototype.get = get;
      StatementSync.prototype.all = all;
      StatementSync.prototype.iterate = iterate;
    }
    assert.ok(fastMaximum >= maximumBefore);
    assert.ok(fastFirst);
    assert.ok(fastSecond);
    assert.equal(fastMissing, null);
    clearIntakeLookupCache(db);
    await prepareIntakeLookupIndices(db);
    assert.equal(maximumIntakeDiscoveryOrder(db), fastMaximum);
    assert.deepEqual(retainedIntakeAcceptance(db, request.operationId), fastFirst);
    assert.deepEqual(retainedIntakeAcceptance(db, nextRequest.operationId), fastSecond);
    assert.equal(retainedIntakeAcceptance(db, 'fictional-missing-operation'), fastMissing);
    t.diagnostic(
      JSON.stringify({
        count,
        warmAttention,
        rows,
        postOriginalRows,
        cursorStatements,
        beforeOwnerMetaWrites,
        beforeOwnerMetaHeadWrites,
        beforeOwnerMetaNodeWrites,
        beforeOwnerMetaOtherWrites,
        beforeOwnerSourceWrites,
        acceptanceOriginalRows,
        projectionWrites: [...statementWrites]
          .filter(([sql]) => /(?:__record_intake_lookup_|__intake_lookup_)/.test(sql))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12),
        statementWrites: [...statementWrites].sort((a, b) => b[1] - a[1]).slice(0, 12),
        pretransactionAuthorizerCalls,
        pretransactionFunctionCalls,
        transactionBegins,
        firstStampDriftAt,
        firstTempSchemaDriftAt,
        tempDdlExecs,
        tempDdlStatements,
        firstDdlPrefix,
        firstStatementDdlPrefix,
        firstChangingDdlPrefix,
        firstRevokedSql,
        ownerAttempts,
        observerCounts,
        observerSnapshotAvailable: !!afterObserverSnapshot,
        observerTempSchemaChanged:
          afterObserverSnapshot?.tempSchema !== observerSnapshot.tempSchema,
      }),
    );
    assert.ok(rows.initial <= 1, 'Initial frontier visits only the changed source');
    assert.ok(rows.catalog <= 1, 'Catalog frontier visits only the changed source');
    assert.ok(rows.final <= 1, 'Final frontier visits only the changed source');
    assert.ok(postOriginalRows <= 1, 'Post-acceptance reads do not scan unrelated originals');
    assert.ok(
      acceptanceOriginalRows <= 1,
      'Accepted operation does not scan unrelated original sources',
    );
  });
