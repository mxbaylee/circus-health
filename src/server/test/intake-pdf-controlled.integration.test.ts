import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fictionalPageMarker,
  writeFictionalBenchmarkPdf,
} from '../../scripts/fictional-pdf-benchmark-fixture.ts';
import { createAssistant } from '../assistant.ts';
import { openDatabase } from '../database.ts';
import { writeIntakeBatch } from '../intake-batch-journal.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import { disposePdfEvidenceSessions } from '../intake-pdf-session.ts';
import {
  createIntakePlan,
  getIntake,
  getIntakeRead,
  getIntakeOriginal,
  uploadIntake,
} from '../intake.ts';
import { isIntakeSummary } from '../../shared/intake-summary.ts';
import { prepareRetainedPlanAccess, readRetainedPlanScope } from '../intake-retained-plan.ts';
import { selectedFixtureValue } from './helpers/selected-intake.ts';
import { publishIntakeSourceText } from '../intake-source-text.ts';
import { attachPersonalDurability } from '../portable.ts';
import { profilePaths } from '../profile-storage.ts';
import { PROXY_MAX_TOOL_ROUNDS, ProxyModelBridge } from '../proxy-model-bridge.ts';
import { PROXY_TRANSCRIPT_LIMITS, proxyTranscriptSize } from '../proxy-transcript.ts';
import { fictionalModel } from './fictional-model.ts';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as RecordValue;
};
const integer = (value: unknown): number => {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value));
  return value;
};
const record = (page: number) =>
  JSON.stringify({
    format: 'health-record-v1',
    id: `fictional-controlled-page-${page}`,
    kind: 'document',
    payload: `Independently fictional control-flow receipt for source page ${page}.`,
    provenance: {
      capturedVia: 'Fictional controlled PDF benchmark',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: `page ${page}`,
    },
    coverage: {
      status: 'partial',
      notes: ['Scripted transport/continuation fixture; no model extraction quality measured.'],
    },
  });

test(
  'controlled 100-page PDF run automatically continues across the real 64-round bridge boundary',
  { skip: process.env.CRS_PDF_CONTROLLED_TEST !== '1', timeout: 180_000 },
  async (t) => {
    fictionalModel(t);
    const started = performance.now();
    const root = mkdtempSync(join(tmpdir(), 'circus-controlled-100-page-'));
    const fixturePath = join(root, 'fictional-mixed.pdf');
    const fixture = writeFictionalBenchmarkPdf(fixturePath, 100, 'mixed');
    const profileId = 'fictional-controlled-pages';
    const db = openDatabase(profilePaths(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    const databases = new Map([[profileId, db]]);
    let intakeId = '';
    let version = 0;
    let planId = '';
    let nextPage = 1;
    let unitId = '';
    let phase: 'context' | 'read' | 'source_text' | 'batch' | 'complete' = 'context';
    let sourceTextPage = 1;
    let lastTextPage = 1;
    let afterText: 'read' | 'batch' = 'read';
    let sourceTextRevisionId = '';
    let selectedRevisionId = '';
    let passageCursor = { offset: 0, character: 0, issueOffset: 0, relationOffset: 0 };
    const durablePagesRead = new Set<number>();
    const passageReads: Array<{ slice: number; page: number; revisionId: string }> = [];
    const beginText = (first: number, last: number, next: 'read' | 'batch') => {
      sourceTextPage = first;
      lastTextPage = last;
      afterText = next;
      passageCursor = { offset: 0, character: 0, issueOffset: 0, relationOffset: 0 };
      phase = 'source_text';
    };
    const pagesRead: number[] = [];
    const pagesDelivered = new Set<number>();
    const mediaPages = new Map<string, number>();
    const unitReceipts: Array<{
      unitId: string;
      operationId: string;
      pages: number[];
      coverage: string;
      sourceTextRevisionId: string;
    }> = [];
    const errors: string[] = [];
    const acknowledgedTools: Array<{ slice: number; tool: string }> = [];
    const requests: Array<{
      slice: number;
      textCharacters: number;
      mediaBytes: number;
      pdfParts: number;
      imageParts: number;
    }> = [];
    const boundaries: Array<{ reason: string; readWindows: number; proposals: number }> = [];
    let slice = 0;
    const assistant = createAssistant({
      root,
      databases,
      availability: () => ({ available: true, readiness: 'ready' }),
      connectionCheck: async () => ({ available: true, readiness: 'ready' }),
      bridgeFactory: (options) => {
        const currentSlice = ++slice;
        let dispatchedUnitId = '';
        // A batch requested at the round cap may not have executed. Its new
        // context rereads the ten relevant passages before attempting it again.
        if (phase === 'batch') beginText(nextPage - 10, nextPage - 1, 'batch');
        return new ProxyModelBridge({
          ...options,
          config: {
            backend: 'litellm',
            model: 'fictional-controlled-pdf',
            baseUrl: 'http://fictional.invalid:4000',
            apiKey: 'fictional-not-a-credential',
            reasoning: null,
            images: true,
            pdf: true,
            promptCache: false,
            localOnly: false,
            resolvedModel: null,
            timeoutSeconds: 60,
          },
          // The deterministic upstream chooses its next scripted operation only after
          // the real host acknowledges the prior one. It is not an extraction model.
          onTool: async (params) => {
            try {
              assert.ok(options.onTool);
              const result = object(await options.onTool(params));
              acknowledgedTools.push({ slice: currentSlice, tool: params.tool });
              if (params.tool === 'health_intake_read') {
                const args = object(params.arguments);
                const metadata = object(result.metadata);
                const original = object(metadata.original);
                const context = object(metadata.intake);
                const page = integer(args.page);
                assert.equal(original.page, page);
                assert.equal(metadata.sourceFileId ?? intakeId, intakeId);
                assert.equal(typeof result.pdfContent, 'string');
                assert.match(String(result.pdfContent), /^data:application\/pdf;base64,/);
                mediaPages.set(
                  createHash('sha256').update(String(result.pdfContent)).digest('hex'),
                  page,
                );
                pagesRead.push(page);
                assert.equal(context.format, 'health-intake-model-evidence-context-v2');
                const pins = object(context.pins);
                assert.equal(pins.sourceId, intakeId);
                assert.equal(pins.sourceHash, fixture.sourceHash);
                version = integer(pins.version);
                // Evidence metadata does not expand the retained unit collection.
                // The real initial model context supplies this slice's exact unit.
                assert.ok(dispatchedUnitId);
                unitId = dispatchedUnitId;
                nextPage = page + 1;
                // Keep each real original read beside its durable passage;
                // transcript retrieval must not consume a long no-progress run.
                beginText(page, page, page % 10 === 0 ? 'batch' : 'read');
              } else if (params.tool === 'health_intake_source_text') {
                assert.equal(result.sourceHash, fixture.sourceHash);
                assert.equal(typeof result.revisionId, 'string');
                assert.ok(result.revisionId);
                assert.equal(result.revisionId, selectedRevisionId);
                sourceTextRevisionId = String(result.revisionId);
                const spans = result.spans;
                const issues = result.issues;
                const relations = result.relations;
                assert.ok(
                  Array.isArray(spans) && Array.isArray(issues) && Array.isArray(relations),
                );
                for (const span of spans)
                  assert.equal(object(object(span).region).page, sourceTextPage);
                assert.equal(spans.length, 1);
                assert.equal(object(spans[0]).text, fictionalPageMarker(sourceTextPage, 100));
                passageReads.push({
                  slice: currentSlice,
                  page: sourceTextPage,
                  revisionId: sourceTextRevisionId,
                });
                if (
                  result.nextOffset !== null ||
                  result.nextIssueOffset !== null ||
                  result.nextRelationOffset !== null
                ) {
                  passageCursor = {
                    offset:
                      result.nextOffset === null
                        ? passageCursor.offset + spans.length
                        : integer(result.nextOffset),
                    character: integer(result.nextCharacter),
                    issueOffset:
                      result.nextIssueOffset === null
                        ? passageCursor.issueOffset + issues.length
                        : integer(result.nextIssueOffset),
                    relationOffset:
                      result.nextRelationOffset === null
                        ? passageCursor.relationOffset + relations.length
                        : integer(result.nextRelationOffset),
                  };
                } else {
                  durablePagesRead.add(sourceTextPage);
                  sourceTextPage++;
                  passageCursor = { offset: 0, character: 0, issueOffset: 0, relationOffset: 0 };
                  if (sourceTextPage > lastTextPage) phase = afterText;
                }
              } else if (params.tool === 'health_intake_plan') {
                assert.equal(result.format, 'health-intake-model-context-v2');
                assert.equal(result.state, 'ready');
                version = integer(object(result.pins).version);
                assert.equal(phase, 'context');
                phase = 'read';
              } else if (params.tool === 'health_intake_batch') {
                const args = object(params.arguments);
                assert.equal(args.sourceTextRevisionId, selectedRevisionId);
                assert.ok(Array.isArray(args.coverage) && args.coverage.length === 1);
                const coverage = object(args.coverage[0]);
                const completedUnit = (nextPage - 1) % 50 === 0;
                assert.equal(coverage.kind, completedUnit ? 'extracted' : 'inspected');
                const batchPages = Array.from({ length: 10 }, (_, index) => nextPage - 10 + index);
                const claimedPages = completedUnit
                  ? Array.from({ length: 50 }, (_, index) => nextPage - 50 + index)
                  : batchPages;
                for (const page of claimedPages) {
                  assert.ok(
                    pagesDelivered.has(page),
                    `Original page ${page} must reach the scripted upstream before coverage`,
                  );
                  assert.ok(
                    durablePagesRead.has(page),
                    `Durable page ${page} must be read before coverage`,
                  );
                }
                version = integer(result.version);
                unitReceipts.push({
                  unitId,
                  operationId: String(args.operationId),
                  pages: batchPages,
                  coverage: String(coverage.kind),
                  sourceTextRevisionId,
                });
                phase = nextPage > 100 ? 'complete' : 'read';
              }
              return result;
            } catch (error) {
              errors.push(
                `${params.tool} (${phase}, next original page ${nextPage}): ${String(error)}`,
              );
              throw error;
            }
          },
          fetchImpl: async (_url, init) => {
            const body = object(JSON.parse(String(init?.body)));
            if (!dispatchedUnitId) {
              assert.ok(Array.isArray(body.messages));
              const initial = body.messages.map(object).find((message) => message.role === 'user');
              assert.ok(initial && typeof initial.content === 'string');
              const context = object(
                JSON.parse(initial.content.slice(initial.content.indexOf('{'))),
              );
              const conversion = object(context.conversion);
              assert.equal(conversion.format, 'health-intake-conversion-resume-v2');
              assert.equal(conversion.intakeId, intakeId);
              assert.equal(conversion.sourceHash, fixture.sourceHash);
              assert.equal(conversion.planId, planId);
              const unit = object(conversion.unit);
              assert.equal(unit.pageCount, 50);
              assert.ok(typeof unit.id === 'string' && unit.id);
              dispatchedUnitId = unit.id;
            }
            const size = proxyTranscriptSize(body);
            let pdfParts = 0;
            let imageParts = 0;
            for (const raw of body.messages as unknown[]) {
              const message = object(raw);
              if (!Array.isArray(message.content)) continue;
              for (const rawPart of message.content) {
                const part = object(rawPart);
                if (part.type === 'image_url') imageParts++;
                if (part.type !== 'file') continue;
                pdfParts++;
                const data = String(object(part.file).file_data);
                const page = mediaPages.get(createHash('sha256').update(data).digest('hex'));
                assert.ok(page, 'every delivered PDF is the acknowledged original page derivative');
                pagesDelivered.add(page);
              }
            }
            requests.push({ slice: currentSlice, ...size, pdfParts, imageParts });
            assert.ok(size.textCharacters <= PROXY_TRANSCRIPT_LIMITS.textCharacters);
            assert.ok(size.mediaBytes <= PROXY_TRANSCRIPT_LIMITS.mediaBytes);
            assert.deepEqual(errors, []);
            let name = 'health_intake_plan';
            let args: RecordValue;
            if (phase === 'context')
              args = {
                id: intakeId,
                action: 'read',
                freshStart: true,
                section: 'units',
                offset: 0,
              };
            else if (phase === 'read') {
              name = 'health_intake_read';
              args = { id: intakeId, page: nextPage };
            } else if (phase === 'source_text') {
              name = 'health_intake_source_text';
              args = { id: intakeId, page: sourceTextPage, ...passageCursor };
            } else if (phase === 'batch') {
              name = 'health_intake_batch';
              args = {
                id: intakeId,
                version,
                sourceTextRevisionId,
                planId,
                operationId: `fictional-controlled-unit-${nextPage - 1}`,
                jsonlText: Array.from({ length: 10 }, (_, index) =>
                  record(nextPage - 10 + index),
                ).join('\n'),
                summary: 'Scripted fictional page receipts retained for review only',
                coverage: [
                  {
                    unitId,
                    kind: (nextPage - 1) % 50 === 0 ? 'extracted' : 'inspected',
                    notes:
                      (nextPage - 1) % 50 === 0
                        ? 'All fifty original pages and durable passages in this unit delivered; no extraction fidelity inference.'
                        : 'Ten additional original pages and durable passages delivered; the rest of the unit remains pending.',
                  },
                ],
              };
            } else args = {};
            return new Response(
              JSON.stringify({
                model: 'fictional-controlled-pdf',
                choices: [
                  {
                    index: 0,
                    finish_reason: phase === 'complete' ? 'stop' : 'tool_calls',
                    message:
                      phase === 'complete'
                        ? {
                            role: 'assistant',
                            content: 'Fictional controlled run complete; proposals await review.',
                          }
                        : {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                              {
                                type: 'function',
                                id: `fictional-call-${requests.length}`,
                                function: { name, arguments: JSON.stringify(args) },
                              },
                            ],
                          },
                  },
                ],
                // Usage deliberately absent: no provider tokens/cache savings are measured.
              }),
              { headers: { 'content-type': 'application/json' } },
            );
          },
          onDiagnostic: () => {},
          retryDelay: async () => {},
        });
      },
    });
    const manager = createIntakeBatchManager({
      root,
      databases,
      assistant,
      pollMs: 5,
      continuationDelayMs: 1,
      journalWriter: (runtimeRoot, currentProfile, batch, reason) => {
        if (reason === 'productive-slice-continued') {
          const item = batch.items[0]!;
          boundaries.push({
            reason: String(item.reading?.reason),
            readWindows: item.reading?.readWindows || 0,
            proposals: item.proposalIds.length,
          });
        }
        writeIntakeBatch(runtimeRoot, currentProfile, batch, reason);
      },
    });
    t.after(async () => {
      manager.close();
      assistant.close();
      await disposePdfEvidenceSessions();
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional-controlled-100-pages.pdf',
      bytes: readFileSync(fixturePath),
    });
    intakeId = source.id;
    // This check qualifies continuation and original-page transport, not OCR.
    // Publish the generator's known visible markers through the real accepted
    // source-text API. Partial, uninspected evidence makes no completeness claim.
    const pageNumbers = Array.from({ length: 100 }, (_, index) => index + 1);
    const seeded = publishIntakeSourceText(db, root, profileId, intakeId, {
      operationId: randomUUID(),
      expectedRevisionId: null,
      sourceHash: fixture.sourceHash,
      evidence: {
        adapter: { name: 'fictional-controlled-page-markers', version: '1' },
        pages: pageNumbers.map((page) => ({ page, disposition: 'partial', inspected: false })),
        spans: pageNumbers.map((page) => ({
          id: `fictional-marker-${page}`,
          text: fictionalPageMarker(page, 100),
          region: { page },
          provenance: 'structured',
        })),
        relations: [],
        issues: [],
      },
    });
    assert.ok(seeded.revision);
    selectedRevisionId = seeded.revision.id;
    // Genuine automatic dispatch scopes a context to its pending unit. Fifty
    // pages leave enough productive work to cross the real 64-request boundary;
    // each ten-page partial batch remains a separate durable review receipt.
    const planned = await createIntakePlan(db, root, profileId, intakeId, {
      version: getIntake(db, root, profileId, intakeId).version,
      unitSize: 50,
      overlap: 0,
    });
    const initialPlan = planned.workflow?.plans.find((plan) => plan.status === 'active');
    assert.ok(initialPlan);
    planId = initialPlan.id;
    const batch = manager.create(profileId, {
      operationId: 'fictional-controlled-start',
      intakeIds: [intakeId],
    });
    const deadline = Date.now() + 150_000;
    while (
      Date.now() < deadline &&
      !errors.length &&
      manager.get(profileId, batch.id).status !== 'complete'
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    const finalBatch = manager.get(profileId, batch.id);
    const final = getIntakeRead(db, root, profileId, intakeId);
    assert.ok(isIntakeSummary(final), 'automatic startup selects native retained authority');
    const item = finalBatch.items[0]!;
    t.diagnostic(
      JSON.stringify({
        boundaries,
        requestsPerSlice: Array.from(
          { length: slice },
          (_, index) => requests.filter((value) => value.slice === index + 1).length,
        ),
        sourceTextPassages: passageReads.length,
      }),
    );
    assert.deepEqual(errors, []);
    assert.equal(
      finalBatch.status,
      'complete',
      JSON.stringify({ phase, pages: pagesRead.length, batch: finalBatch }),
    );
    // Startup migrates the seeded legacy recipe. Observe its selected unit
    // receipts directly; forcing a legacy Intake DTO would mask tool failures.
    await prepareRetainedPlanAccess(db, profileId, intakeId);
    const plan = readRetainedPlanScope(db, profileId, intakeId, { planId });
    assert.ok(plan);
    assert.equal(phase, 'complete');
    assert.deepEqual(
      pagesRead,
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    assert.deepEqual(
      [...pagesDelivered].sort((a, b) => a - b),
      pagesRead,
    );
    assert.deepEqual(
      [...durablePagesRead].sort((a, b) => a - b),
      pagesRead,
    );
    assert.ok(
      passageReads.length >= 100,
      'Every proposed page needs an actual durable passage read',
    );
    assert.ok(
      passageReads.length <= 100 + boundaries.length * 10,
      'A fresh context rereads at most its current ten-page batch',
    );
    assert.ok(boundaries.length > 0, 'The run must cross a productive reading boundary');
    for (const [index, boundary] of boundaries.entries()) {
      assert.equal(boundary.reason, 'time_limit');
      assert.ok(boundary.readWindows > (boundaries[index - 1]?.readWindows || 0));
      assert.ok(boundary.proposals > (boundaries[index - 1]?.proposals || 0));
    }
    assert.equal(requests.filter((value) => value.slice === 1).length, PROXY_MAX_TOOL_ROUNDS);
    assert.equal(
      acknowledgedTools.filter((value) => value.slice === 1).length,
      PROXY_MAX_TOOL_ROUNDS - 1,
      'The final requested tool at the round cap is not acknowledged or treated as completed',
    );
    assert.equal(
      acknowledgedTools.filter((value) => value.tool === 'health_intake_read').length,
      100,
    );
    assert.equal(
      acknowledgedTools.filter((value) => value.tool === 'health_intake_batch').length,
      10,
    );
    // After the round boundary, fresh contexts bind to pending units and can
    // finish at those unit boundaries before reaching the round cap again.
    for (let current = 1; current <= slice; current++) {
      const count = requests.filter((value) => value.slice === current).length;
      assert.ok(count > 0 && count <= PROXY_MAX_TOOL_ROUNDS);
    }
    assert.equal(slice, boundaries.length + 1);
    assert.equal(item.readingJob?.slices, slice);
    assert.equal(item.reading?.pendingReadWindows, 0);
    assert.equal(item.reading?.readWindows, 100);
    assert.equal(item.reading?.accountedUnits, 2);
    assert.equal(item.reading?.remainingUnits, 0);
    assert.equal(item.reading?.reason, 'reading_exhausted');
    assert.equal(item.reading?.readyRecords, 100);
    assert.equal(item.reading?.modelRequests, requests.length);
    assert.equal(item.reading?.modelUsageIncomplete, true);
    assert.equal(plan.reader.childCount(plan.record, 'batches'), 10);
    assert.equal(plan.unitCount, 2);
    for (const expected of initialPlan.units) {
      const unit: ReturnType<NonNullable<ReturnType<typeof readRetainedPlanScope>>['unitById']> =
        plan.unitById(expected.id);
      assert.ok(unit);
      assert.equal(unit.pages.count, 50);
      assert.ok(unit.coverageRecord);
      assert.deepEqual(plan.reader.field(unit.coverageRecord, 'kind', { bytes: 256 }), {
        kind: 'value',
        value: 'extracted',
      });
    }
    assert.equal(new Set(unitReceipts.map((receipt) => receipt.operationId)).size, 10);
    assert.equal(unitReceipts.filter((receipt) => receipt.coverage === 'inspected').length, 8);
    assert.equal(unitReceipts.filter((receipt) => receipt.coverage === 'extracted').length, 2);
    assert.equal(final.collections.proposals.total, 10);
    assert.equal(selectedFixtureValue(db, intakeId, ['intake', 'imported']), null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()?.n, 0);
    assert.equal(
      createHash('sha256')
        .update(getIntakeOriginal(db, root, profileId, intakeId).bytes)
        .digest('hex'),
      fixture.sourceHash,
    );
    const report = {
      format: 'circus-fictional-controlled-pdf-v1',
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      fixture,
      durationMs: performance.now() - started,
      qualification:
        'Real application host reads/plans/proposals, proxy transcript transport and automatic batch continuation with a deterministic fictional upstream. No clinical extraction, provider acceptance, token savings or deployment performance claim.',
      scriptedUpstream: {
        usesLiveNetwork: false,
        advancesAfterHostAcknowledgement: true,
        tokenUsage: 'unmeasured',
        cachedInputTokens: null,
        durableSourceText:
          'Known visible fixture markers published through the accepted source-text API; OCR and transcription quality are not measured.',
      },
      physicalRequests: requests.length,
      acknowledgedTools,
      requestsPerSlice: Array.from(
        { length: slice },
        (_, index) => requests.filter((value) => value.slice === index + 1).length,
      ),
      requestMaxima: {
        textCharacters: Math.max(...requests.map((value) => value.textCharacters)),
        mediaBytes: Math.max(...requests.map((value) => value.mediaBytes)),
        pdfParts: Math.max(...requests.map((value) => value.pdfParts)),
        imageParts: Math.max(...requests.map((value) => value.imageParts)),
      },
      boundaries,
      pagesRead,
      pagesDelivered: [...pagesDelivered].sort((a, b) => a - b),
      passageReads,
      unitReceipts,
      finalReading: item.reading,
      finalReadingJob: item.readingJob,
      reviewableProposals: final.collections.proposals.total,
      readyRecords: item.reading?.readyRecords,
      acceptedDocuments: 0,
      originalSha256Unchanged: true,
    };
    if (process.env.CRS_PDF_CONTROLLED_REPORT)
      writeFileSync(process.env.CRS_PDF_CONTROLLED_REPORT, JSON.stringify(report, null, 2) + '\n', {
        flag: 'wx',
      });
    t.diagnostic(
      JSON.stringify({
        physicalRequests: requests.length,
        slices: slice,
        sourceTextPassages: passageReads.length,
        durationMs: report.durationMs,
        requestMaxima: report.requestMaxima,
      }),
    );
  },
);
