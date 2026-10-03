import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistant } from '../assistant.ts';
import { readChat } from '../assistant-journal.ts';
import { assertConversionCoverage } from '../intake-continuation.ts';
import { openDatabase } from '../database.ts';
import { createIntakePlan, getIntake, linkIntakeConversion, uploadIntake } from '../intake.ts';
import { attachPersonalDurability } from '../portable.ts';
import { profilePaths } from '../profile-storage.ts';
import { ProxyModelBridge } from '../proxy-model-bridge.ts';
import { fictionalModel } from './fictional-model.ts';

const model = 'fictional-consumption';
const response = (name?: string, args?: unknown) =>
  new Response(
    JSON.stringify({
      model,
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 3 },
      },
      choices: [
        {
          index: 0,
          finish_reason: name ? 'tool_calls' : 'stop',
          message: name
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    type: 'function',
                    id: 'fictional-' + name,
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              }
            : { role: 'assistant', content: 'Fictional receipt remains reviewable.' },
        },
      ],
    }),
    { headers: { 'content-type': 'application/json' } },
  );

for (const boundary of ['time', 'transcript', 'provider-context', 'invalid-response'] as const)
  test(`unconsumed evidence remains pending after ${boundary} and only a valid resumed response enables coverage`, async (t) => {
    fictionalModel(t);
    const root = mkdtempSync(join(tmpdir(), 'circus-consumption-'));
    const profileId = 'fictional-consumption';
    const db = openDatabase(profilePaths(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    const databases = new Map([[profileId, db]]);
    let now = 0;
    let recovery = false;
    let requests = 0;
    let hostReads = 0;
    let resumedPrompt = '';
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional.txt',
      bytes: Buffer.from('FICTIONAL SOURCE SENTINEL. '.repeat(200)),
    });
    const planned = await createIntakePlan(db, root, profileId, source.id, {
      version: source.version,
    });
    const plan = planned.workflow!.plans[0]!;
    const coverage = [
      {
        unitId: plan.units[0]!.id,
        kind: 'extracted' as const,
        notes: 'Fictional transport test only',
      },
    ];
    const assistant = createAssistant({
      root,
      databases,
      monotonicNow: () => now,
      availability: () => ({ available: true, readiness: 'ready' }),
      connectionCheck: async () => ({ available: true, readiness: 'ready' }),
      bridgeFactory: (options) => {
        let round = 0;
        let sourceTextRevisionId: string | undefined;
        return new ProxyModelBridge({
          ...options,
          config: {
            backend: 'litellm',
            model,
            baseUrl: 'http://fictional.invalid:4000',
            apiKey: 'fictional-key',
            reasoning: null,
            images: false,
            pdf: false,
            promptCache: false,
            localOnly: false,
            resolvedModel: null,
            timeoutSeconds: 60,
          },
          onTool: async (params) => {
            assert.ok(options.onTool);
            const result = await options.onTool(params);
            if (params.tool === 'health_intake_source_text')
              sourceTextRevisionId = (result as { revisionId: string }).revisionId;
            if (params.tool === 'health_intake_read') {
              hostReads++;
              if (!recovery && boundary === 'time') now = 900_001;
              if (!recovery && boundary === 'transcript')
                return {
                  ...(result as object),
                  fictionalOversizeResult: 'x'.repeat(3 * 1024 * 1024),
                };
            }
            return result;
          },
          fetchImpl: async (_url, init) => {
            requests++;
            round++;
            if (round === 1) {
              if (recovery) resumedPrompt = String(init?.body);
              return response('health_intake_read', { id: source.id });
            }
            if (!recovery) {
              if (boundary === 'provider-context')
                return new Response(
                  JSON.stringify({
                    error: {
                      code: 'context_length_exceeded',
                      message: 'Fictional bounded context error',
                    },
                  }),
                  { status: 400 },
                );
              if (boundary === 'invalid-response')
                return new Response('{"choices":[]}', {
                  headers: { 'content-type': 'application/json' },
                });
              assert.fail('time/transcript boundary must prevent the next physical request');
            }
            if (round === 2) return response('health_intake_source_text', { id: source.id });
            if (round === 3)
              return response('health_intake_batch', {
                id: source.id,
                version: getIntake(db, root, profileId, source.id).version,
                planId: plan.id,
                operationId: 'fictional-recovered-batch',
                sourceTextRevisionId,
                coverage,
                summary: 'Fictional source receipt for review',
                jsonlText: JSON.stringify({
                  format: 'health-record-v1',
                  id: 'fictional-recovered',
                  kind: 'document',
                  payload: 'Fictional receipt',
                  provenance: {
                    capturedVia: 'Fictional test',
                    sourceSystem: null,
                    sourceRecordId: null,
                    evidenceClass: 'transcription',
                    locator: 'fictional.txt',
                  },
                  coverage: { status: 'partial', notes: ['No clinical fidelity claim'] },
                }),
              });
            return response();
          },
          onDiagnostic: () => {},
          retryDelay: async () => {},
        });
      },
    });
    t.after(() => {
      assistant.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const chat = assistant.create(profileId, { title: 'Fictional consumption boundary' });
    linkIntakeConversion(db, root, profileId, source.id, chat.id);
    const send = () =>
      assistant.send(profileId, chat.id, {
        message: 'Continue the fictional conversion',
        context: { intakeId: source.id },
      });
    const settled = async () => {
      const deadline = Date.now() + 5000;
      while (chat.status === 'running' && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.notEqual(chat.status, 'running');
    };
    send();
    await settled();
    assert.equal(hostReads, 1);
    assert.equal(requests, ['time', 'transcript'].includes(boundary) ? 1 : 2);
    assert.equal(chat.reading?.readWindows, 0, 'host completion is not provider consumption');
    assert.equal(chat.conversionCheckpoint!.pending.length, 1);
    assert.equal(chat.conversionCheckpoint!.pending[0]!.args.id, source.id);
    const current = getIntake(db, root, profileId, source.id);
    assert.throws(
      () =>
        assertConversionCoverage(
          chat.conversionCheckpoint!,
          { ...current, workflow: current.workflow! },
          { planId: plan.id, coverage },
        ),
      { code: 'CONVERSION_COVERAGE_PENDING' },
    );
    const retained = readChat(root, profileId, chat.id) as typeof chat;
    assert.deepEqual(retained.conversionCheckpoint, chat.conversionCheckpoint);
    assert.ok(!JSON.stringify(retained.conversionCheckpoint).includes('FICTIONAL SOURCE SENTINEL'));
    assert.equal(current.proposals.length, 0);
    const beforeAttribution = chat.conversionCheckpoint!.attribution!;
    const beforeScope = Object.values(beforeAttribution.scopes)[0]!;
    assert.equal(beforeScope.hostReads, 1);
    assert.equal(beforeScope.acknowledgedReads, 0);
    assert.equal(beforeScope.attempts, ['time', 'transcript'].includes(boundary) ? 0 : 1);
    assert.equal(beforeAttribution.totals.attempts, requests);
    assert.equal(beforeAttribution.totals.inputTokens, 10);
    recovery = true;
    send();
    await settled();
    assert.match(resumedPrompt, /nextReadWindows/);
    assert.equal(hostReads, 2, 'the pending scope is re-read in the fresh context');
    assert.equal(chat.reading?.readWindows, 1);
    assert.equal(chat.reading?.pendingReadWindows, 0);
    assert.equal(chat.reading?.reason, 'reading_exhausted');
    assert.equal(getIntake(db, root, profileId, source.id).proposals.length, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()?.n, 0);
    const attribution = chat.conversionCheckpoint!.attribution!;
    const scope = Object.values(attribution.scopes)[0]!;
    assert.equal(scope.hostReads, 2, 'host read tally does not reset across explicit continues');
    assert.equal(scope.acknowledgedReads, 1);
    assert.equal(attribution.totals.attempts, requests);
    assert.equal(
      scope.inputTokens,
      30,
      'the three recent requests retain the original and revision-pinned source payload',
    );
    assert.equal(attribution.totals.inputTokens, 50);
    assert.equal(
      attribution.totals.unknownUsageAttempts,
      ['time', 'transcript'].includes(boundary) ? 0 : 1,
    );
    const metadata = assistant.attributionMetadata(profileId, [
      getIntake(db, root, profileId, source.id),
    ]);
    assert.equal(metadata.chats.length, 1);
    assert.equal(metadata.unavailableChats, 0);
    assert.ok(!JSON.stringify(metadata).includes('FICTIONAL SOURCE SENTINEL'));
  });
