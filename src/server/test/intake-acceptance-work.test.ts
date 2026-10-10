/** Fictional host-only acceptance stages; not full HTTP or encrypted recovery qualification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, proposeConversion } from '../intake.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { prepareCollectionClinicalReview } from '../intake-review-collection-host.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import { acceptIntakeReportSelectionAsync } from '../intake-report-acceptance.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { iterateIntakeEnvelopeText } from '../intake-collection-envelope.ts';
import type { IntakeReportAcceptanceRequest } from '../../shared/intake.ts';

for (const count of [2, 8])
  test(`native acceptance work breakdown: ${count} records`, { timeout: 120000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-acceptance-work-'));
    const profileId = 'fictional-acceptance-work';
    const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    memoryRecordAuthority(db);
    t.after(() => {
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const stages: unknown[] = [];
    let acceptanceSql: { preparations: number; executions: number } | undefined;
    const measure = async <T>(stage: string, action: () => T | Promise<T>): Promise<T> => {
      const before = { ...intakeWorkCounters(db).warm };
      const start = performance.now();
      const cpu = process.cpuUsage();
      let metadataPreparations = 0,
        metadataExecutions = 0;
      const nativePrepare = db.prepare;
      // Count only this query; do not retain every SQL call in the test mock ledger.
      db.prepare = function (query: string) {
        const statement = nativePrepare.call(db, query);
        if (query === 'SELECT length(CAST(value AS BLOB)) AS bytes FROM app_meta WHERE key=?') {
          metadataPreparations++;
          const get = statement.get;
          statement.get = (...args: unknown[]) => {
            metadataExecutions++;
            return Reflect.apply(get, statement, args) as ReturnType<typeof get>;
          };
        }
        return statement;
      };
      let result: T;
      try {
        result = await action();
      } finally {
        db.prepare = nativePrepare;
      }
      if (stage === 'acceptance')
        acceptanceSql = { preparations: metadataPreparations, executions: metadataExecutions };
      const work = intakeWorkCounters(db).warm;
      const delta = Object.fromEntries(
        Object.entries(work)
          .map(([key, value]) => [key, value - before[key as keyof typeof before]])
          .filter(([, value]) => value !== 0),
      );
      const elapsed = process.cpuUsage(cpu);
      stages.push({
        stage,
        count,
        elapsedMs: performance.now() - start,
        processCpuMs: (elapsed.user + elapsed.system) / 1000,
        metadataPreparations,
        metadataExecutions,
        work: delta,
      });
      return result;
    };
    const lines = Array.from({ length: count }, (_, i) =>
      JSON.stringify({
        format: 'health-record-v1',
        id: `fictional-record-${i}`,
        kind: 'document',
        payload: { text: `Fictional document ${i}` },
        provenance: {
          capturedVia: 'Fictional export',
          sourceSystem: 'Fictional clinic',
          sourceRecordId: `fictional-record-${i}`,
          evidenceClass: 'provider_export',
          locator: `page ${i}`,
        },
        coverage: { status: 'complete_response', notes: [] },
        clinical: {
          kind: 'document',
          subject: 'self',
          documentTitle: `Fictional document ${i}`,
          date: '2026-01-01',
        },
      }),
    ).join('\n');
    const original = await measure('original-and-proposal', () => {
      const upload = uploadIntake(db, root, profileId, {
        filename: 'fictional.jsonl',
        newProviderName: 'Fictional clinic',
        bytes: Buffer.from(lines),
      });
      return proposeConversion(db, root, profileId, upload.id, {
        version: upload.version,
        jsonlText: lines,
        summary: 'Fictional approval',
      });
    });
    const file = db.prepare('SELECT path FROM source_files WHERE id=?').get(original.id)!;
    const originalHash = () =>
      createHash('sha256')
        .update(readFileSync(join(root, String(file.path))))
        .digest('hex');
    const expectedHash = originalHash();
    await measure('schema-preparation', () =>
      buildIntakeCollectionEnvelope(db, { id: original.id }),
    );
    await measure('membership-preparation', () =>
      prepareCollectionReviewMembership(db, { id: original.id }),
    );
    const input = await measure('complete-review', () => {
      const result = prepareCollectionClinicalReview(
        db,
        root,
        profileId,
        original.id,
        original.proposals.at(-1)!.id,
      );
      if (result.status !== 'ready') throw Error('Expected complete fictional review');
      try {
        const review = result.session.review;
        assert.equal(review.records.length, count);
        return {
          operationId: randomUUID(),
          blocks: [
            {
              intakeId: original.id,
              proposalId: original.proposals.at(-1)!.id,
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
        } satisfies IntakeReportAcceptanceRequest;
      } finally {
        result.session.close();
      }
    });
    const saved = await measure('acceptance', () =>
      acceptIntakeReportSelectionAsync(db, root, profileId, input),
    );
    assert.equal(saved.replayed, false);
    assert.equal(saved.receipt.atomic, true);
    assert.equal(saved.receipt.status, 'accepted');
    assert.equal(saved.receipt.acceptedCount, count);
    const titles = db
      .prepare('SELECT title FROM documents ORDER BY title')
      .all()
      .map((row) => row.title);
    assert.deepEqual(
      titles,
      Array.from({ length: count }, (_, i) => `Fictional document ${i}`).sort(),
    );
    clearIntakeStateCache(db);
    const replay = await measure('receipt-replay', () =>
      acceptIntakeReportSelectionAsync(db, root, profileId, input),
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, saved.receipt);
    const final = JSON.parse([...iterateIntakeEnvelopeText(db, { id: original.id })].join(''));
    assert.equal(final.intake.workflow.reportAcceptances.length, 1);
    assert.equal(originalHash(), expectedHash);
    for (const result of stages) t.diagnostic(JSON.stringify(result));
    assert.ok(
      acceptanceSql && acceptanceSql.preparations > 0,
      'real acceptance exercised checkpoint validation',
    );
    assert.ok(
      acceptanceSql.executions > acceptanceSql.preparations,
      'checkpoint SQL compilation is not repeated for every metadata check',
    );
  });
