import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFictionalBenchmarkPdf } from '../../scripts/fictional-pdf-benchmark-fixture.ts';
import { createAssistant } from '../assistant.ts';
import { openDatabase } from '../database.ts';
import { writeIntakeBatch } from '../intake-batch-journal.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import { disposePdfEvidenceSessions } from '../intake-pdf-session.ts';
import { getIntake, getIntakeOriginal, uploadIntake } from '../intake.ts';
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
    let phase: 'context' | 'plan' | 'read' | 'batch' | 'complete' = 'context';
    const pagesRead: number[] = [];
    const pagesDelivered = new Set<number>();
    const mediaPages = new Map<string, number>();
    const unitReceipts: Array<{ unitId: string; pages: number[] }> = [];
    const errors: string[] = [];
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
                version = integer(context.version);
                const units = context.currentUnits;
                assert.ok(Array.isArray(units) && units.length === 1);
                unitId = String(object(units[0]).id);
                nextPage = page + 1;
                phase = page % 10 === 0 ? 'batch' : 'read';
              } else if (params.tool === 'health_intake_plan') {
                version = integer(result.version);
                if (phase === 'context') phase = 'plan';
                else {
                  planId = String(object(result.plan).id);
                  phase = 'read';
                }
              } else if (params.tool === 'health_intake_batch') {
                version = integer(result.version);
                unitReceipts.push({
                  unitId,
                  pages: Array.from({ length: 10 }, (_, index) => nextPage - 10 + index),
                });
                phase = nextPage > 100 ? 'complete' : 'read';
              }
              return result;
            } catch (error) {
              errors.push(String(error));
              throw error;
            }
          },
          fetchImpl: async (_url, init) => {
            const body = object(JSON.parse(String(init?.body)));
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
            else if (phase === 'plan')
              args = { id: intakeId, action: 'create', version, unitSize: 10, overlap: 0 };
            else if (phase === 'read') {
              name = 'health_intake_read';
              args = { id: intakeId, page: nextPage };
            } else if (phase === 'batch') {
              name = 'health_intake_batch';
              args = {
                id: intakeId,
                version,
                planId,
                operationId: `fictional-controlled-unit-${nextPage - 1}`,
                jsonlText: Array.from({ length: 10 }, (_, index) =>
                  record(nextPage - 10 + index),
                ).join('\n'),
                summary: 'Scripted fictional page receipts retained for review only',
                coverage: [
                  {
                    unitId,
                    kind: 'extracted',
                    notes:
                      'All ten original page windows delivered to the scripted transport; no extraction fidelity inference.',
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
    const batch = manager.create(profileId, {
      operationId: 'fictional-controlled-start',
      intakeIds: [intakeId],
    });
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline && manager.get(profileId, batch.id).status !== 'complete')
      await new Promise((resolve) => setTimeout(resolve, 20));
    const finalBatch = manager.get(profileId, batch.id);
    const final = getIntake(db, root, profileId, intakeId);
    const item = finalBatch.items[0]!;
    const plan = final.workflow?.plans.find((value) => value.id === planId);
    assert.deepEqual(errors, []);
    assert.equal(
      finalBatch.status,
      'complete',
      JSON.stringify({ phase, pages: pagesRead.length, batch: finalBatch }),
    );
    assert.equal(phase, 'complete');
    assert.deepEqual(
      pagesRead,
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    assert.deepEqual(
      [...pagesDelivered].sort((a, b) => a - b),
      pagesRead,
    );
    assert.ok(boundaries.length > 0, 'The run must cross a productive reading boundary');
    for (const [index, boundary] of boundaries.entries()) {
      assert.equal(boundary.reason, 'time_limit');
      assert.ok(boundary.readWindows > (boundaries[index - 1]?.readWindows || 0));
      assert.ok(boundary.proposals > (boundaries[index - 1]?.proposals || 0));
    }
    assert.equal(requests.filter((value) => value.slice === 1).length, PROXY_MAX_TOOL_ROUNDS);
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
    assert.equal(item.reading?.accountedUnits, 10);
    assert.equal(item.reading?.remainingUnits, 0);
    assert.equal(item.reading?.reason, 'reading_exhausted');
    assert.equal(item.reading?.readyRecords, 100);
    assert.equal(item.reading?.modelRequests, requests.length);
    assert.equal(item.reading?.modelUsageIncomplete, true);
    assert.equal(plan?.batches.length, 10);
    assert.equal(plan?.units.length, 10);
    assert.ok(plan?.units.every((unit) => unit.coverage?.kind === 'extracted'));
    assert.equal(final.proposals.length, 10);
    assert.equal(final.imported, null);
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
      },
      physicalRequests: requests.length,
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
      unitReceipts,
      finalReading: item.reading,
      finalReadingJob: item.readingJob,
      reviewableProposals: final.proposals.length,
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
        durationMs: report.durationMs,
        requestMaxima: report.requestMaxima,
      }),
    );
  },
);
