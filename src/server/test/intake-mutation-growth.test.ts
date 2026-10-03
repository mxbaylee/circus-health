import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as intake from '../intake.ts';
import { sourceFiles } from '../queries.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { sourceTextProjectionCounters } from '../source-text-projection.ts';
import { sourceDetailsSearchCounters } from '../source-details-search.ts';
import { intakeLookupCounters } from '../intake-lookup-projection.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { readStoredIntakeDetails } from '../intake-state-access.ts';
import { readIntakeSourcePin } from '../intake-source-pin.ts';
import { createMutationFixture } from './helpers/intake-mutation-fixture.ts';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';

// The dedicated qualification retains 301 clinical evidence carriers and measures
// the expensive warm projection, complete DTO, history and cache-loss path. Its
// coarse host hang guard is separate from routine CI and from model performance.
for (const fullQualification of [false, true]) {
  const lastCycle = fullQualification ? 300 : 6;
  const acceptancePoints = fullQualification ? [0, 100, 200, 300] : [0, 1, 2, 3];
  const smallIndex = lastCycle - 1;
  test(
    fullQualification
      ? 'qualification: 300 real batch/proposal/draft cycles, clinical acceptance and cache-loss parity'
      : 'real intake mutation pipeline: clinical literals, pending decisions, restart and cache loss',
    {
      timeout: fullQualification ? 7_200_000 : 600_000,
      skip: fullQualification && process.env.CRS_INTAKE_MUTATION_QUALIFY !== '1',
    },
    async (t) => {
      const fileWork = createIntakeFileWorkCounters();
      const artifactRoot = mkdtempSync(join(tmpdir(), 'fictional-intake-growth-artifacts-'));
      return withIntakeFileWork(fileWork, async () => {
        const f = await createMutationFixture(t, { fileWorkSnapshot: () => ({ ...fileWork }) });
        let smallFinished = false;
        await f.prepare(0);
        f.accept(0, '21000000-0000-4000-8000-000000000000');
        const sqlInventory = () => {
          const tables = f.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all();
          return Object.fromEntries(
            tables.map(({ name }) => {
              const table = String(name),
                quoted = '"' + table.replaceAll('"', '""') + '"';
              const rows = f.db.prepare(`SELECT * FROM ${quoted}`).all();
              return [
                table,
                {
                  rows: rows.length,
                  storedValueBytes: rows.reduce(
                    (n, row) =>
                      n +
                      Object.values(row).reduce<number>(
                        (sum, value) =>
                          sum +
                          (value === null
                            ? 0
                            : typeof value === 'object' && ArrayBuffer.isView(value)
                              ? value.byteLength
                              : Buffer.byteLength(String(value))),
                        0,
                      ),
                    0,
                  ),
                  serializedValueBytes: rows.reduce(
                    (n, row) => n + Buffer.byteLength(JSON.stringify(row)),
                    0,
                  ),
                },
              ];
            }),
          );
        };
        const measure = (checkpoint: number) => ({
          checkpoint,
          cycles: checkpoint + 1,
          applicationMutations: {
            batchProposal: checkpoint + 1,
            reviewDraft: checkpoint + 1 + (smallFinished ? 1 : 0),
            clinicalAcceptances: f.operationIds.length,
          },
          io: { ...f.io },
          fileWork: { ...fileWork },
          physicalSourceEvidence: {
            inventory: f.physicalEvidenceInventory(),
            originalFiles: 1,
            originalBytes: f.original.bytes.length,
            proposalFiles: f.proposalBytes.size,
            proposalBytes: [...f.proposalBytes.values()].reduce(
              (sum, bytes) => sum + bytes.length,
              0,
            ),
          },
          objects: {
            count: f.objects.size,
            bytes: [...f.objects.values()].reduce((n, b) => n + b.length, 0),
            byKind: Object.fromEntries(
              [...f.objects].reduce((map, [name, bytes]) => {
                let kind = name === 'head' ? 'published-head' : 'record-segment';
                if (name !== 'head') {
                  try {
                    const value = JSON.parse(bytes.toString());
                    if (Array.isArray(value.segments)) kind = 'record-commit';
                  } catch {
                    /* Segments can divide a version's JSON bytes. */
                  }
                }
                const item = map.get(kind) ?? { count: 0, bytes: 0 };
                item.count++;
                item.bytes += bytes.length;
                map.set(kind, item);
                return map;
              }, new Map<string, { count: number; bytes: number }>()),
            ),
          },
          sql: sqlInventory(),
          transactionResults: (() => {
            const rows = f.db.prepare('SELECT result_json FROM __record_transactions').all();
            const lengths = rows.map((row) => Buffer.byteLength(String(row.result_json)));
            return {
              rows: rows.length,
              totalBytes: lengths.reduce((sum, n) => sum + n, 0),
              largestBytes: Math.max(0, ...lengths),
            };
          })(),
          intakeMetadata: Object.fromEntries(
            f.db
              .prepare("SELECT key,value FROM app_meta WHERE key LIKE 'intake_state_v1:%'")
              .all()
              .reduce((map, row) => {
                const key = String(row.key),
                  kind = key.includes(':operation:')
                    ? 'operation-result'
                    : key.endsWith(':head')
                      ? 'selected-head'
                      : 'contribution';
                const count = map.get(kind) ?? { rows: 0, storedBytes: 0 };
                count.rows++;
                count.storedBytes += Buffer.byteLength(String(row.value));
                map.set(kind, count);
                return map;
              }, new Map<string, { rows: number; storedBytes: number }>()),
          ),
          allocation: {
            pageCount: f.db.prepare('PRAGMA page_count').get()!.page_count,
            pageSize: f.db.prepare('PRAGMA page_size').get()!.page_size,
            freePages: f.db.prepare('PRAGMA freelist_count').get()!.freelist_count,
          },
          host: intakeWorkCounters(f.db),
          lookup: intakeLookupCounters(f.db),
          search: sourceDetailsSearchCounters(f.db),
          text: sourceTextProjectionCounters(f.db),
        });
        const parity = () => {
          const expected = f.db
            .prepare('SELECT * FROM source_files ORDER BY path,id')
            .all()
            .map((row) => ({
              id: row.id,
              path: row.path,
              kind: row.kind,
              text:
                row.kind === 'intake_original'
                  ? readIntakeEnvelopeText(f.db, {
                      id: String(row.id),
                      sha256: String(row.sha256),
                      details_json: String(row.details_json),
                    })
                  : String(row.details_json),
            }));
          for (const query of [
            'Invented serum measure',
            '21000000-0000-4000-8000-000000000000',
            'Retained source specimen',
            'not-present-Ω',
          ]) {
            // SQLite LIKE is the pre-projection literal SQL oracle, fed complete selected
            // text rather than compact source rows. It also establishes exact ordering.
            f.db.exec(
              'CREATE TEMP TABLE IF NOT EXISTS mutation_search_oracle(id TEXT,path TEXT,kind TEXT,text TEXT)',
            );
            f.db.exec('DELETE FROM mutation_search_oracle');
            for (const row of expected)
              f.db
                .prepare('INSERT INTO mutation_search_oracle VALUES(?,?,?,?)')
                .run(row.id, row.path, row.kind, row.text);
            const oracle = f.db
              .prepare(
                'SELECT id,text FROM mutation_search_oracle WHERE path LIKE ? OR text LIKE ? ORDER BY path,id',
              )
              .all('%' + query + '%', '%' + query + '%');
            const result = sourceFiles(f.db, new URLSearchParams({ q: query, limit: '500' }));
            assert.equal(result.total, oracle.length);
            const actual = [...result.data];
            for (let offset = result.limit; offset < result.total; offset += result.limit)
              actual.push(
                ...sourceFiles(
                  f.db,
                  new URLSearchParams({ q: query, limit: '200', offset: String(offset) }),
                ).data,
              );
            assert.deepEqual(
              actual.map((row) => row.id),
              oracle.map((row) => row.id),
            );
            assert.deepEqual(
              actual.map((row) => JSON.stringify(row.details)),
              oracle.map((row) => JSON.stringify(JSON.parse(String(row.text)))),
            );
          }
          const item = intake.getIntake(f.db, f.root, f.profileId, f.original.id);
          assert.equal(item.proposals.length, f.proposals.size);
          assert.equal(item.workflow!.plans[0]!.batches.length, f.proposals.size);
          assert.deepEqual(
            item.proposals.map((p) => p.id),
            [...f.proposals.values()],
          );
          assert.equal(item.workflow!.candidates.length, f.proposals.size);
          const pin = readIntakeSourcePin(f.db, f.original.id)!;
          assert.equal(
            item.version,
            readStoredIntakeDetails(f.db, f.original.id)!.version + pin.version,
          );
          assert.ok(
            item.proposals.every((proposal) => proposal.sourceTextRevisionId === pin.revisionId),
          );
          assert.ok(
            item.proposals.every(
              (proposal) => proposal.sourceTextDependencyToken === pin.dependencyToken,
            ),
          );
          assert.deepEqual(
            item.workflow!.candidates.map((candidate) =>
              candidate.versions.map((version) => version.status),
            ),
            [...f.proposals.keys()].map((index) => [
              acceptancePoints.slice(0, f.operationIds.length).includes(index)
                ? 'accepted'
                : 'pending',
            ]),
          );
          assert.deepEqual(
            item.workflow!.plans[0]!.batches.map((batch) => ({
              id: batch.id,
              proposalId: batch.proposalId,
              coverage: batch.coverage.map((c) => ({ kind: c.kind, notes: c.notes })),
            })),
            [...f.proposals].map(([index, id]) => ({
              id: `batch-${index}`,
              proposalId: id,
              coverage: [{ kind: 'extracted', notes: `Retained source specimen ${index}` }],
            })),
          );
          assert.deepEqual(
            item.workflow!.candidates.map((candidate) => [
              candidate.envelopeId,
              candidate.sourceRecordId,
            ]),
            [...f.proposals.keys()].map((index) => [
              `juniper-measure-${index}`,
              `specimen-${index}`,
            ]),
          );
          const expectedDrafts = [...f.proposals].map(([index, id]) => [
            `draft-${index}`,
            id,
            'mg/L',
            'pending',
          ]);
          if (smallFinished)
            expectedDrafts.push([
              'small-after-large',
              f.proposals.get(smallIndex)!,
              'mg/L',
              'review_later',
            ]);
          assert.deepEqual(
            item.workflow!.reviewDrafts!.map((draft) => [
              draft.id,
              draft.proposalId,
              draft.mapping.unit,
              draft.disposition,
            ]),
            expectedDrafts,
          );
          assert.deepEqual(
            item.workflow!.decisions.map((decision) => decision.action),
            f.operationIds.map(() => 'accept'),
          );
          assert.deepEqual(
            item.workflow!.reportAcceptances!.map((op) => op.receipt.operationId),
            f.operationIds,
          );
          for (const [ordinal, op] of item.workflow!.reportAcceptances!.entries()) {
            assert.equal(op.receipt.acceptedCount, 1);
            assert.equal(op.receipt.selectedCount, 1);
            assert.equal(op.receipt.atomic, true);
            if (!op.receipt.atomic)
              throw Error('fixture requires independently reviewed atomic acceptance');
            assert.equal(
              op.receipt.receipts[0]!.proposalId,
              f.proposals.get(acceptancePoints[ordinal]!),
            );
            assert.equal(op.receipt.receipts[0]!.records[0]!.outcome, 'added');
          }
          assert.equal(item.pendingCount, f.proposals.size - f.operationIds.length);
          assert.deepEqual(
            intake.getIntakeOriginal(f.db, f.root, f.profileId, f.original.id).bytes,
            f.original.bytes,
          );
          assert.equal(
            createHash('sha256')
              .update(intake.getIntakeOriginal(f.db, f.root, f.profileId, f.original.id).bytes)
              .digest('hex'),
            f.original.sha256,
          );
          for (const [id, bytes] of f.proposalBytes) {
            const row = f.db.prepare('SELECT path,sha256 FROM source_files WHERE id=?').get(id)!;
            assert.deepEqual(readFileSync(join(f.root, String(row.path))), bytes);
            assert.equal(row.sha256, createHash('sha256').update(bytes).digest('hex'));
          }
          const physical = f.physicalEvidenceInventory();
          assert.equal(
            fileWork.writes,
            physical.files,
            'one physical publication per independently retained original/proposal',
          );
          assert.equal(
            fileWork.writeBytes,
            physical.bytes,
            'no rewritten or omitted physical source payload',
          );
          return f.snapshot();
        };
        parity();
        assert.deepEqual(
          f
            .snapshot()
            .clinical.map((row) => [
              row.label,
              row.value_text,
              row.unit,
              row.effective_at,
              row.date_precision,
            ]),
          [['Invented serum measure 0', '< 0.030', 'mg/L', '2025-04', 'month']],
        );
        const measurements = [measure(0)];
        // TEMP audit captures every changed stored value, including accepted-history,
        // intake heads/frames/results and all disposable lookup/rope representations.
        // Its own counters are outside accepted-record capture and allocation authority.
        const installSqlAudit = () => {
          f.db.exec(
            'CREATE TEMP TABLE mutation_sql_writes(table_name TEXT PRIMARY KEY,inserts INTEGER,updates INTEGER,deletes INTEGER,new_value_bytes INTEGER,old_value_bytes INTEGER)',
          );
          const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
          for (const row of f.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .all()) {
            const table = String(row.name),
              columns = f.db
                .prepare(`PRAGMA table_info(${quote(table)})`)
                .all()
                .map((column) => String(column.name));
            f.db.prepare('INSERT INTO mutation_sql_writes VALUES(?,0,0,0,0,0)').run(table);
            const bytes = (prefix: string) =>
              columns
                .map((column) => `COALESCE(length(CAST(${prefix}.${quote(column)} AS BLOB)),0)`)
                .join('+');
            const literal = "'" + table.replaceAll("'", "''") + "'";
            for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
              const counter = { INSERT: 'inserts', UPDATE: 'updates', DELETE: 'deletes' }[event];
              f.db.exec(
                `CREATE TEMP TRIGGER ${quote('mutation_audit_' + table + '_' + event)} AFTER ${event} ON main.${quote(table)} BEGIN UPDATE mutation_sql_writes SET ${counter}=${counter}+1,new_value_bytes=new_value_bytes+${event === 'DELETE' ? '0' : bytes('NEW')},old_value_bytes=old_value_bytes+${event === 'INSERT' ? '0' : bytes('OLD')} WHERE table_name=${literal}; END`,
              );
            }
          }
        };
        installSqlAudit();
        for (let i = 1; i <= lastCycle; i++) {
          try {
            await f.prepare(i);
          } catch (error) {
            const failure = {
              failedCycle: i,
              host: intakeWorkCounters(f.db),
              fileWork: { ...fileWork },
              io: { ...f.io },
            };
            t.diagnostic(JSON.stringify(failure));
            writeFileSync(join(artifactRoot, 'failure.json'), JSON.stringify(failure, null, 2));
            t.diagnostic(JSON.stringify({ artifact: join(artifactRoot, 'failure.json') }));
            throw error;
          }
          if (acceptancePoints.includes(i)) {
            f.accept(i, `21000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
            parity();
            // Independently specified clinical oracle, including exact sign/precision.
            assert.deepEqual(
              f
                .snapshot()
                .clinical.map((row) => [
                  row.label,
                  row.value_text,
                  row.unit,
                  row.effective_at,
                  row.date_precision,
                ]),
              [
                ['Invented serum measure 0', '< 0.030', 'mg/L', '2025-04', 'month'],
                [
                  `Invented serum measure ${acceptancePoints[1]}`,
                  '+004.500',
                  'mg/L',
                  '2025-04',
                  'month',
                ],
                [
                  `Invented serum measure ${acceptancePoints[2]}`,
                  '7.20',
                  'mg/L',
                  '2025-04',
                  'month',
                ],
                [
                  `Invented serum measure ${acceptancePoints[3]}`,
                  '−0.125',
                  'mg/L',
                  '2025-04',
                  'month',
                ],
              ].slice(0, f.operationIds.length),
            );
            const measurement = {
              ...measure(i),
              sqlWrites: f.db
                .prepare('SELECT * FROM mutation_sql_writes ORDER BY table_name')
                .all(),
            };
            measurements.push(measurement);
            t.diagnostic(JSON.stringify(measurement));
            writeFileSync(
              join(artifactRoot, `checkpoint-${i}.json`),
              JSON.stringify(measurement, null, 2),
            );
            t.diagnostic(JSON.stringify({ artifact: join(artifactRoot, `checkpoint-${i}.json`) }));
          }
        }
        const before = parity();
        const immutable = new Map(
          [...f.objects]
            .filter(([name]) => name !== 'head')
            .map(([name, bytes]) => [name, Buffer.from(bytes)]),
        );
        const beforeOpenIO = { ...f.io };
        const beforeOpenFileWork = { ...fileWork };
        f.reopen();
        assert.deepEqual(parity(), before);
        const openWork = intakeWorkCounters(f.db);
        const afterOpenIO = { ...f.io };
        const afterOpenFileWork = { ...fileWork };
        f.rebuild();
        assert.deepEqual(parity(), before);
        const reconstruction = intakeWorkCounters(f.db);
        const afterReconstructionIO = { ...f.io };
        const afterReconstructionFileWork = { ...fileWork };
        const ioDelta = (after: typeof f.io, before: typeof f.io) =>
          Object.fromEntries(
            Object.keys(after).map((key) => [
              key,
              after[key as keyof typeof after] - before[key as keyof typeof before],
            ]),
          );
        for (const [name, bytes] of immutable) assert.deepEqual(f.objects.get(name), bytes);
        const proposalId = f.proposals.get(smallIndex)!;
        const review = intake.reviewIntake(f.db, f.root, f.profileId, f.original.id, proposalId),
          record = review.records[0]!;
        const beforeSmall = measure(lastCycle);
        installSqlAudit();
        intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, f.original.id, {
          version: review.version,
          operationId: 'small-after-large',
          proposalId,
          recordId: record.id,
          candidateVersionId: record.candidateVersionId!,
          disposition: 'review_later',
        });
        smallFinished = true;
        parity();
        const report = {
          qualification: {
            mode: fullQualification ? 'full-300' : 'ci-pipeline',
            lastCycle,
            acceptancePoints,
            fictionalClinicalAssertions: 301,
          },
          setup: f.phases,
          rawConversion: {
            calls: 0,
            reason:
              'New application upload registers normalized authority; separate raw conversion qualification applies.',
          },
          schedulerJournal: {
            calls: 0,
            reason:
              'submitIntakeBatch is a workflow API, independent scheduler journal measured separately.',
          },
          initial: measurements[0],
          checkpoints: measurements.slice(1),
          openWork,
          reconstruction,
          openIO: ioDelta(afterOpenIO, beforeOpenIO),
          cacheLossIO: ioDelta(afterReconstructionIO, afterOpenIO),
          openFileWork: Object.fromEntries(
            Object.keys(fileWork).map((key) => [
              key,
              afterOpenFileWork[key as keyof typeof fileWork] -
                beforeOpenFileWork[key as keyof typeof fileWork],
            ]),
          ),
          cacheLossFileWork: Object.fromEntries(
            Object.keys(fileWork).map((key) => [
              key,
              afterReconstructionFileWork[key as keyof typeof fileWork] -
                afterOpenFileWork[key as keyof typeof fileWork],
            ]),
          ),
          small: {
            before: beforeSmall,
            after: measure(lastCycle),
            sqlWrites: f.db.prepare('SELECT * FROM mutation_sql_writes ORDER BY table_name').all(),
          },
        };
        writeFileSync(join(artifactRoot, 'measurements.json'), JSON.stringify(report, null, 2));
        t.diagnostic(JSON.stringify({ artifact: join(artifactRoot, 'measurements.json') }));
        t.diagnostic(
          JSON.stringify({
            qualification: report.qualification,
            initial: report.initial,
            setup: report.setup,
            rawConversion: report.rawConversion,
            schedulerJournal: report.schedulerJournal,
            openWork,
            reconstruction,
            openIO: report.openIO,
            cacheLossIO: report.cacheLossIO,
            openFileWork: report.openFileWork,
            cacheLossFileWork: report.cacheLossFileWork,
            small: report.small,
          }),
        );
      });
    },
  );
}
