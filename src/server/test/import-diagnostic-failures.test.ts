import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createImportDiagnostics,
  beginImportPhase,
  diagnosticFailureFields,
} from '../import-diagnostics.ts';
import { withDiagnosticValidation } from '../import-diagnostic-error.ts';
import { HttpError } from '../database.ts';
import { ModelToolValidationError } from '../model-tool-validation.ts';
import { ProxyModelBridge, proxyConfig, type HealthTool } from '../proxy-model-bridge.ts';

const privateText = 'FICTIONAL_MEDICAL_CONTENT_NEVER_EXPORT';
const validationError = () =>
  new ModelToolValidationError(
    'INVALID_JSONL',
    privateText,
    withDiagnosticValidation(new HttpError(400, 'INVALID_JSONL', privateText), {
      code: 'invalid_provenance',
      path: 'arguments.jsonlText[].provenance',
      line: 7,
    }),
  );

test('failure derivation accepts trusted classes and structural metadata, never arbitrary error prose or properties', () => {
  assert.deepEqual(diagnosticFailureFields(validationError()), {
    reasonCode: 'invalid_jsonl',
    errorType: 'model_tool_validation',
    errorCategory: 'validation',
    validationCode: 'invalid_provenance',
    validationPath: 'arguments.jsonlText[].provenance',
    validationLine: 7,
  });
  const spoofed = Object.assign(new Error(privateText), {
    name: privateText,
    code: privateText,
    validationPath: privateText,
  });
  assert.deepEqual(diagnosticFailureFields(spoofed), {
    reasonCode: 'unexpected_error',
    errorType: 'error',
    errorCategory: 'unexpected',
  });
  const unknownKey = withDiagnosticValidation(new Error(privateText), {
    code: 'invalid_text',
    path: `arguments.${privateText}[34].notes`,
  });
  assert.equal(diagnosticFailureFields(unknownKey).validationPath, 'arguments[unknown][].notes');
  assert.doesNotMatch(JSON.stringify(diagnosticFailureFields(unknownKey)), /FICTIONAL_MEDICAL/);
  assert.equal(diagnosticFailureFields(new TypeError(privateText)).errorType, 'type_error');
  assert.equal(
    diagnosticFailureFields(new HttpError(422, 1 as unknown as string, privateText)).reasonCode,
    'unexpected_error',
  );
});

test('default-on summaries preserve first and latest validation failure through event eviction and summary-store reload', () => {
  let stored: Uint8Array | null = null;
  const store = {
    read: () => stored,
    write: (bytes: Uint8Array) => {
      stored = Uint8Array.from(bytes);
    },
  };
  const profileId = 'fictional-failure-profile';
  const context = { profileId, operationId: randomUUID(), importId: 'fictional-private-source-id' };
  const d = createImportDiagnostics({ enabled: false });
  d.attachSummaryStore(profileId, store);
  const phase = beginImportPhase('model_tool', { toolName: 'health_intake_batch' }, context, d);
  phase.fail(validationError());
  for (let i = 0; i < 320; i++) d.record('import.progress', { readWindows: i }, context);
  beginImportPhase('continuation', {}, context, d).fail(
    new HttpError(409, 'CONVERSION_NO_PROGRESS', privateText),
  );
  d.flushSummaries(profileId);
  const snapshot = d.exportSnapshot(profileId);
  assert.equal(snapshot.events.length, 0);
  const op = snapshot.recentPerformance!.operations[0]!;
  assert.ok(op.droppedEvents > 0);
  assert.equal(op.firstFailure?.fields.reasonCode, 'invalid_jsonl');
  assert.equal(op.latestFailure?.fields.reasonCode, 'conversion_no_progress');
  assert.equal(
    op.latestValidationFailure?.fields.validationPath,
    'arguments.jsonlText[].provenance',
  );
  assert.ok(!op.spans.some((span) => span.fields.validationCode === 'invalid_provenance'));
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /FICTIONAL_MEDICAL_CONTENT|fictional-private-source-id/,
  );
  assert.ok(store.read());
  assert.ok(store.read()!.byteLength <= 512 * 1024);
  d.close();
  const restored = createImportDiagnostics({ enabled: false });
  restored.attachSummaryStore(profileId, store);
  const recovered = restored.exportSnapshot(profileId).recentPerformance!.operations[0]!;
  assert.deepEqual(recovered.latestValidationFailure, op.latestValidationFailure);
  assert.deepEqual(recovered.firstFailure, op.firstFailure);
  restored.close();
});

for (const kind of ['host', 'schema'] as const)
  test(`bridge exports privacy-safe ${kind} batch validation metadata with detail capture disabled`, async () => {
    const diagnostics = createImportDiagnostics({ enabled: false });
    const schema: HealthTool['inputSchema'] = {
      type: 'object',
      properties: { jsonlText: { type: 'string' } },
      required: ['jsonlText'],
      additionalProperties: false,
    };
    const tool: HealthTool = {
      type: 'function',
      name: 'health_intake_batch',
      description: 'Fictional bounded tool',
      inputSchema: schema,
    };
    const replies = [
      {
        model: 'fictional-model',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'fictional-call',
                  type: 'function',
                  function: {
                    name: tool.name,
                    arguments: JSON.stringify({
                      jsonlText: kind === 'host' ? privateText : { privateText },
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
      {
        model: 'fictional-model',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Fictional review pending' },
          },
        ],
      },
    ];
    let calls = 0;
    const errors: string[] = [];
    const bridge = new ProxyModelBridge({
      config: proxyConfig({
        CRS_AI_MODEL: 'fictional-model',
        CRS_AI_BASE_URL: 'http://proxy.invalid',
        CRS_AI_API_KEY: 'fictional-key',
      }),
      diagnostics,
      onExit: (error) => {
        errors.push(error.message);
      },
      diagnosticContext: { profileId: 'fictional-profile', importId: 'fictional-source' },
      fetchImpl: async () =>
        new Response(JSON.stringify(replies.shift()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      onTool: async () => {
        calls++;
        throw validationError();
      },
    });
    try {
      await bridge.start('Fictional instructions', [tool]);
      await bridge.turn('Fictional request');
      await bridge.completion;
      assert.deepEqual(errors, []);
      assert.equal(calls, kind === 'host' ? 1 : 0);
      const snapshot = diagnostics.exportSnapshot('fictional-profile');
      const failure = snapshot.recentPerformance!.operations[0]!.latestValidationFailure!;
      assert.equal(failure.event, 'model.tool.failed');
      assert.equal(failure.fields.toolName, 'health_intake_batch');
      assert.equal(
        failure.fields.reasonCode,
        kind === 'host' ? 'invalid_jsonl' : 'invalid_tool_arguments',
      );
      assert.equal(
        failure.fields.validationPath,
        kind === 'host' ? 'arguments.jsonlText[].provenance' : 'arguments.jsonlText',
      );
      assert.doesNotMatch(JSON.stringify(snapshot), /FICTIONAL_MEDICAL_CONTENT|fictional-key/);
    } finally {
      bridge.close();
      diagnostics.close();
    }
  });
