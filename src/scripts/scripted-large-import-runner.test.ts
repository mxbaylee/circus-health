import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScriptedLargeImport, scriptedOutputParent } from './scripted-large-import-runner.ts';
import { writeFictionalPdf } from './fictional-pdf-writer.ts';
import {
  createLargeImportOracle,
  largeImportPage,
  renderLargeImportPage,
} from './large-import-fixture.ts';
import { ScriptedLargeImportUpstream } from './scripted-large-import-upstream.ts';
const hasOcr = spawnSync('tesseract', ['--version'], { stdio: 'ignore' }).status === 0;

const ownedRuns = new WeakMap<test.TestContext, Array<Promise<unknown>>>();
function runForTest(t: test.TestContext, options: Parameters<typeof runScriptedLargeImport>[0]) {
  const promise = runScriptedLargeImport(options);
  const pending = ownedRuns.get(t) ?? [];
  pending.push(promise);
  ownedRuns.set(t, pending);
  return promise;
}
function parent(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'scripted-runner-tests-'));
  t.after(async () => {
    await Promise.allSettled(ownedRuns.get(t) ?? []);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function mixedFixture(pdf: string, oraclePath: string, pages: number) {
  const oracle = createLargeImportOracle();
  writeFileSync(oraclePath, JSON.stringify(oracle), { flag: 'wx', mode: 0o600 });
  return {
    ...writeFictionalPdf(pdf, {
      pages,
      // This bounded fixture scans page2; the full command preserves the
      // unchanged scan-table page150 and retains any generation failure.
      pageAt: (page) => renderLargeImportPage(largeImportPage(oracle, page), page !== 2),
    }),
    pages,
  };
}
const sparseClinicalPages = [1, 2, 149, 150, 151] as const;
const bounded = (pdf: string, oraclePath: string) => {
  const oracle = createLargeImportOracle();
  writeFileSync(oraclePath, JSON.stringify(oracle), { flag: 'wx', mode: 0o600 });
  return {
    ...writeFictionalPdf(pdf, {
      pages: 151,
      pageAt: (page) =>
        sparseClinicalPages.some((clinical) => clinical === page)
          ? renderLargeImportPage(largeImportPage(oracle, page), page !== 2)
          : {
              font: 'Courier',
              content: Buffer.from(
                `BT /F1 10 Tf 30 700 Td (Independently fictional nonclinical page ${page}) Tj ET`,
              ),
            },
    }),
    pages: 151,
  };
};
const interruptionSlice = (pdf: string, oracle: string) => mixedFixture(pdf, oracle, 12);
function tiny(pdf: string, _oracle: string) {
  return {
    ...writeFictionalPdf(pdf, {
      pages: 1,
      pageAt: () => ({
        font: 'Courier',
        content: Buffer.from('BT /F1 10 Tf 30 700 Td (Independently fictional test) Tj ET'),
      }),
    }),
    pages: 1,
  };
}
test('scripted output refuses relative paths and repositories including symlink targets', (t) => {
  assert.throws(() => scriptedOutputParent('.'), /absolute/);
  const root = parent(t);
  mkdirSync(join(root, '.git'));
  assert.throws(() => scriptedOutputParent(root), /outside Git/);
});
test('sparse proposal scope cannot alter the default 900-page command fixture', async (t) => {
  const root = parent(t);
  await assert.rejects(
    runForTest(t, { outputParent: root, proposalPages: [1] }),
    /explicit bounded fictional fixture/,
  );
  assert.deepEqual(readdirSync(root), []);
});
test('recording failure and count-bound stops retain original, diagnostics and separate limits', async (t) => {
  const root = parent(t);
  for (const recordingEnabled of [false, true]) {
    const attempt = await runForTest(t, {
      outputParent: root,
      fixture: tiny,
      recordingEnabled,
      maxRequests: 1,
      maxIdlePolls: 500,
    });
    assert.equal(attempt.result.outcome, 'incomplete');
    assert.equal(
      attempt.result.failure,
      recordingEnabled
        ? hasOcr
          ? 'SCRIPTED_REQUEST_BOUND'
          : 'SCRIPTED_APP_SOURCE_PREREQUISITE'
        : 'SCRIPTED_RECORDING_UNAVAILABLE',
    );
    assert.equal(attempt.result.acceptedRecords, 0);
    assert.equal(attempt.result.limits.modelWorkTimeLimit, null);
    assert.equal(statSync(join(attempt.root, 'result.json')).mode & 0o777, 0o600);
    assert.ok(readFileSync(join(attempt.root, 'original.pdf')).length);
    assert.equal(attempt.result.reviewEntry.url, null);
    assert.ok(readFileSync(join(attempt.root, 'diagnostics-final.json')).length);
  }
});
test(
  'actual bounded mixed upload delivers media, crosses real continuation and retains two-person split-row review',
  // Host hang guard for real 151-page OCR/encrypted capture and 76 automatic
  // contexts; runner progress/request counts determine its outcome.
  { skip: !hasOcr && 'Requires actual local Tesseract; OCR is never scripted', timeout: 600_000 },
  async (t) => {
    const attempt = await runForTest(t, {
      outputParent: parent(t),
      fixture: bounded,
      maxIdlePolls: 500,
      signal: t.signal,
      proposalPages: sparseClinicalPages,
    });
    const receiptDirectory = process.env.CRS_SCRIPTED_TEST_RECEIPT_DIR;
    if (receiptDirectory)
      writeFileSync(
        join(scriptedOutputParent(receiptDirectory), 'bounded-151-result.json'),
        JSON.stringify(attempt.result, null, 2),
        { flag: 'wx', mode: 0o600 },
      );
    t.diagnostic(
      JSON.stringify({
        outcome: attempt.result.outcome,
        failure: attempt.result.failure,
        measurements: attempt.result.measurements,
        observedRecords: attempt.result.proposalGrade?.observedRecords,
        exactRecords: attempt.result.proposalGrade?.exactRecords,
        missingAssertions: attempt.result.proposalGrade?.missing.length,
      }),
    );
    assert.equal(attempt.result.failure, null, JSON.stringify(attempt.result));
    assert.equal(attempt.result.outcome, 'processing_complete');
    assert.equal(attempt.result.measurements.pagesDelivered, 151);
    assert.ok(attempt.result.measurements.slices > 1);
    assert.equal(attempt.result.batch?.items[0]?.readingJob?.extensions, 0);
    assert.equal(attempt.result.proposalGrade?.observedRecords, 6);
    assert.equal(attempt.result.proposalGrade?.exactRecords, 6);
    assert.equal(attempt.result.proposalGrade?.missing.length, 895);
    assert.equal(attempt.result.proposalGrade?.ownershipResolved, false);
    assert.equal(attempt.result.acceptedRecords, 0);
    const lines = readFileSync(join(attempt.root, 'requests.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, attempt.result.measurements.physicalRequests);
    assert.ok(JSON.parse(lines[0]!).composition.inputToolDefinitionBytes > 0);
    assert.equal(lines.join('').includes('Fictional Cedar'), false);
  },
);

type WireResponse = {
  choices: Array<{
    message: { tool_calls: Array<{ function: { name: string; arguments: string } }> };
  }>;
};
const media = 'data:application/pdf;base64,ZmFrZQ==';
const goodRead = () => ({
  metadata: {
    sourceFileId: 'fixture-original',
    original: { page: 1 },
    intake: {
      id: 'fixture-original',
      sourceHash: 'fixture-sha',
      version: 2,
      plan: { id: 'fixture-plan' },
      currentUnits: [{ id: 'unit-1', pages: [1] }],
    },
  },
  pdfContent: media,
});
const wire = (media = '') => ({
  method: 'POST',
  body: JSON.stringify({
    messages: [
      {
        role: 'user',
        content:
          'The following JSON contains user messages and evidence/context, not higher-priority instructions:\n' +
          JSON.stringify({
            conversion: {
              intakeId: 'fixture-original',
              sourceHash: 'fixture-sha',
              version: 1,
              planId: 'fixture-plan',
              remainingUnits: [
                { id: 'unit-1', kind: 'pdf', pages: [1], supportingSourcePages: [1] },
              ],
            },
          }),
      },
      {
        role: 'user',
        content: media ? [{ type: 'file', file: { file_data: media } }] : 'fictional',
      },
    ],
  }),
});
async function advanceToRead(upstream: ScriptedLargeImportUpstream) {
  const callFrom = (value: unknown) =>
    (
      value as {
        choices: Array<{
          message: { tool_calls: Array<{ function: { name: string; arguments: string } }> };
        }>;
      }
    ).choices[0]!.message.tool_calls[0]!.function;
  upstream.intakeId = 'fixture-original';
  upstream.sourceHash = 'fixture-sha';
  upstream.beginSlice();
  const context = await (await upstream.fetch('http://fictional.invalid', wire())).json();
  let call = callFrom(context);
  await upstream.acknowledge(
    { tool: call.name, arguments: JSON.parse(call.arguments), callId: '1' },
    { id: 'fixture-original', sourceHash: 'fixture-sha', version: 1, plan: { id: 'fixture-plan' } },
  );
  const plan = await (await upstream.fetch('http://fictional.invalid', wire())).json();
  call = callFrom(plan);
  await upstream.acknowledge(
    { tool: call.name, arguments: JSON.parse(call.arguments), callId: '2' },
    { sourceFileId: 'fixture-original', unit: { id: 'unit-1', kind: 'pdf', pages: [1] } },
  );
  const read = await (await upstream.fetch('http://fictional.invalid', wire())).json();
  call = callFrom(read);
  return { tool: call.name, arguments: JSON.parse(call.arguments), callId: '3' };
}
test('host read acknowledgement without physical media delivery cannot support proposals', async () => {
  const upstream = new ScriptedLargeImportUpstream({ pages: 1, maxRequests: 10 });
  const params = await advanceToRead(upstream);
  await upstream.acknowledge(params, {
    metadata: {
      sourceFileId: 'fixture-original',
      original: { page: 1 },
      intake: {
        id: 'fixture-original',
        sourceHash: 'fixture-sha',
        version: 2,
        plan: { id: 'fixture-plan' },
        currentUnits: [{ id: 'unit-1', pages: [1] }],
      },
    },
    pdfContent: 'data:application/pdf;base64,ZmFrZQ==',
  });
  await acknowledgeSource(upstream, '');
  await assert.rejects(
    upstream.fetch('http://fictional.invalid', wire()),
    /SCRIPTED_MISSING_MEDIA/,
  );
});

async function acknowledgeSource(upstream: ScriptedLargeImportUpstream, media: string) {
  const response = (await (
    await upstream.fetch('http://fictional.invalid', wire(media))
  ).json()) as {
    choices: Array<{
      message: { tool_calls: Array<{ function: { name: string; arguments: string } }> };
    }>;
  };
  const call = response.choices[0]!.message.tool_calls[0]!.function;
  assert.equal(call.name, 'health_intake_source_text');
  await upstream.acknowledge(
    { tool: call.name, arguments: JSON.parse(call.arguments), callId: 'source' },
    {
      sourceHash: 'fixture-sha',
      revisionId: 'fixture-revision',
      spans: [{ region: { page: 1 } }],
      nextOffset: null,
    },
  );
}
test('wrong source, stale version, invalid unit and transport absence retain scripted failure classification', async () => {
  for (const problem of ['source', 'version', 'unit']) {
    const upstream = new ScriptedLargeImportUpstream({ pages: 1, maxRequests: 10 });
    const params = await advanceToRead(upstream);
    await assert.rejects(
      upstream.acknowledge(params, {
        metadata: {
          sourceFileId: problem === 'source' ? 'wrong' : 'fixture-original',
          original: { page: 1 },
          intake: {
            id: 'fixture-original',
            sourceHash: 'fixture-sha',
            plan: { id: 'fixture-plan' },
            version: problem === 'version' ? 0 : 2,
            currentUnits: problem === 'unit' ? [] : [{ id: 'unit-1', pages: [1] }],
          },
        },
        pdfContent: 'data:application/pdf;base64,ZmFrZQ==',
      }),
      /SCRIPTED_(WRONG_SOURCE|STALE_VERSION|WRONG_UNIT)/,
    );
    assert.ok(upstream.failure);
  }
  const upstream = new ScriptedLargeImportUpstream({ pages: 1, maxRequests: 10 });
  await advanceToRead(upstream);
  await assert.rejects(
    upstream.fetch('http://fictional.invalid', wire()),
    /SCRIPTED_MISSING_ACKNOWLEDGEMENT/,
  );
});

test('actual empty upload admission refusal and pre-request cancellation retain owned evidence', async (t) => {
  const root = parent(t);
  const refused = await runForTest(t, {
    outputParent: root,
    fixture: (pdf) => {
      writeFileSync(pdf, '', { flag: 'wx', mode: 0o600 });
      return { pages: 1, bytes: 0, sourceHash: '' };
    },
  });
  assert.equal(refused.result.failure, 'SCRIPTED_HTTP_REFUSAL');
  assert.ok(refused.result.apiFailure?.status && refused.result.apiFailure.status >= 400);
  assert.equal(refused.result.acceptedRecords, 0);
  assert.equal(refused.result.measurements.physicalRequests, 0);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runForTest(t, {
    outputParent: root,
    fixture: tiny,
    signal: controller.signal,
  });
  assert.equal(cancelled.result.failure, 'SCRIPTED_USER_CANCELLED');
  assert.equal(cancelled.result.reviewEntry.url, null);
  assert.ok(readFileSync(join(cancelled.root, 'original.pdf')).length);
});
test('scripted HTTP transport failure is distinct from acknowledgement faults', async () => {
  const upstream = new ScriptedLargeImportUpstream({ pages: 1, maxRequests: 10, httpFailureAt: 1 });
  upstream.intakeId = 'fixture-original';
  upstream.sourceHash = 'fixture-sha';
  const response = await upstream.fetch('http://fictional.invalid', wire());
  assert.equal(response.status, 503);
  assert.equal(upstream.requests, 1);
  assert.equal(upstream.failure, 'SCRIPTED_TRANSPORT_FAILURE');
});
test(
  'actual bridge transport failure and request bound preserve interrupted API evidence',
  { skip: !hasOcr && 'Requires actual local Tesseract', timeout: 60_000 },
  async (t) => {
    const attempt = await runForTest(t, {
      outputParent: parent(t),
      fixture: tiny,
      upstreamHttpFailureAt: 1,
    });
    assert.equal(attempt.result.failure, 'SCRIPTED_TRANSPORT_FAILURE');
    assert.equal(attempt.result.outcome, 'incomplete');
    assert.equal(attempt.result.measurements.physicalRequests, 1);
    assert.equal(attempt.result.acceptedRecords, 0);
    assert.equal(attempt.result.originalUnchanged, true);
    const diagnostics = readFileSync(join(attempt.root, 'diagnostics-final.json'), 'utf8');
    assert.ok(diagnostics.includes('model.request.failed'));
  },
);

test('decoded media receipts bind bytes to the source/version/plan/unit once at physical delivery', async () => {
  const rows: Array<{
    newlyDeliveredPages: Array<{
      decodedSha256: string;
      decodedBytes: number;
      sourceId: string;
      sourceHash: string;
      version: number;
      planId: string;
      unitId: string;
    }>;
  }> = [];
  const upstream = new ScriptedLargeImportUpstream({
    pages: 1,
    maxRequests: 10,
    onRequest: (row) => rows.push(row),
  });
  const params = await advanceToRead(upstream);
  const media = 'data:application/pdf;base64,ZmFrZQ==';
  await upstream.acknowledge(params, {
    metadata: {
      sourceFileId: 'fixture-original',
      original: { page: 1 },
      intake: {
        id: 'fixture-original',
        sourceHash: 'fixture-sha',
        version: 2,
        plan: { id: 'fixture-plan' },
        currentUnits: [{ id: 'unit-1', pages: [1] }],
      },
    },
    pdfContent: media,
  });
  await acknowledgeSource(upstream, media);
  const batch = (await (await upstream.fetch('http://fictional.invalid', wire(media))).json()) as {
    choices: Array<{
      message: { tool_calls: Array<{ function: { name: string; arguments: string } }> };
    }>;
  };
  const call = batch.choices[0]!.message.tool_calls[0]!.function;
  const receipt = rows.flatMap((row) => row.newlyDeliveredPages)[0]!;
  assert.equal(rows.flatMap((row) => row.newlyDeliveredPages).length, 1);
  assert.equal(receipt.decodedBytes, 4);
  assert.equal(
    receipt.decodedSha256,
    'b5d54c39e66671c9731b9f471e585d8262cd4f54963f0c93082d8dcf334d4c78',
  );
  assert.equal(receipt.sourceId, 'fixture-original');
  assert.equal(receipt.sourceHash, 'fixture-sha');
  assert.equal(receipt.version, 2);
  assert.equal(receipt.planId, 'fixture-plan');
  assert.equal(receipt.unitId, 'unit-1');
  await assert.rejects(
    upstream.acknowledge(
      { tool: call.name, arguments: JSON.parse(call.arguments), callId: '4' },
      { id: 'fixture-original', sourceHash: 'fixture-sha', version: 3, plan: { id: 'wrong-plan' } },
    ),
    /SCRIPTED_WRONG_PLAN/,
  );
});
test('wrong source at plan read and wrong plan at page read are refused', async () => {
  const first = new ScriptedLargeImportUpstream({ pages: 1, maxRequests: 10 });
  first.intakeId = 'fixture-original';
  first.sourceHash = 'fixture-sha';
  const initial = (await (await first.fetch('http://fictional.invalid', wire())).json()) as {
    choices: Array<{
      message: { tool_calls: Array<{ function: { name: string; arguments: string } }> };
    }>;
  };
  const call = initial.choices[0]!.message.tool_calls[0]!.function;
  await assert.rejects(
    first.acknowledge(
      { tool: call.name, arguments: JSON.parse(call.arguments), callId: '1' },
      { id: 'wrong-source', sourceHash: 'fixture-sha', version: 1, plan: null },
    ),
    /SCRIPTED_WRONG_SOURCE/,
  );
  const next = new ScriptedLargeImportUpstream({ pages: 1, maxRequests: 10 });
  const params = await advanceToRead(next);
  await assert.rejects(
    next.acknowledge(params, {
      metadata: {
        sourceFileId: 'fixture-original',
        original: { page: 1 },
        intake: {
          id: 'fixture-original',
          sourceHash: 'fixture-sha',
          version: 2,
          plan: { id: 'wrong-plan' },
          currentUnits: [{ id: 'unit-1', pages: [1] }],
        },
      },
      pdfContent: 'data:application/pdf;base64,ZmFrZQ==',
    }),
    /SCRIPTED_WRONG_PLAN/,
  );
});
test('scoped unit and proposal acknowledgement refuse a different source', async () => {
  for (const phase of ['unit', 'batch'] as const) {
    const upstream = new ScriptedLargeImportUpstream({ pages: 1, maxRequests: 10 });
    if (phase === 'unit') {
      upstream.intakeId = 'fixture-original';
      upstream.sourceHash = 'fixture-sha';
      const initial = (await (
        await upstream.fetch('http://fictional.invalid', wire())
      ).json()) as WireResponse;
      const call = initial.choices[0]!.message.tool_calls[0]!.function;
      await upstream.acknowledge(
        { tool: call.name, arguments: JSON.parse(call.arguments), callId: '1' },
        {
          id: 'fixture-original',
          sourceHash: 'fixture-sha',
          version: 1,
          plan: { id: 'fixture-plan' },
        },
      );
    } else {
      await upstream.acknowledge(await advanceToRead(upstream), goodRead());
      await acknowledgeSource(upstream, media);
    }
    const response = (await (
      await upstream.fetch('http://fictional.invalid', wire(phase === 'batch' ? media : ''))
    ).json()) as WireResponse;
    const call = response.choices[0]!.message.tool_calls[0]!.function;
    assert.equal(call.name, phase === 'unit' ? 'health_intake_plan' : 'health_intake_batch');
    await assert.rejects(
      upstream.acknowledge(
        { tool: call.name, arguments: JSON.parse(call.arguments), callId: 'next' },
        phase === 'unit'
          ? { sourceFileId: 'wrong-source', unit: { id: 'unit-1', kind: 'pdf', pages: [1] } }
          : {
              id: 'wrong-source',
              sourceHash: 'fixture-sha',
              version: 3,
              plan: { id: 'fixture-plan' },
            },
      ),
      phase === 'unit' ? /SCRIPTED_WRONG_UNIT/ : /SCRIPTED_WRONG_SOURCE/,
    );
  }
});
test('a stale dispatch after a completed context read is refused across slices', async () => {
  const upstream = new ScriptedLargeImportUpstream({ pages: 1, maxRequests: 10 });
  await upstream.acknowledge(await advanceToRead(upstream), goodRead());
  upstream.beginSlice();
  await assert.rejects(
    upstream.fetch('http://fictional.invalid', wire()),
    /SCRIPTED_STALE_VERSION/,
  );
});
test('wrong current source-text hash, revision and page acknowledgements are refused', async () => {
  for (const problem of ['hash', 'revision', 'page'] as const) {
    const upstream = new ScriptedLargeImportUpstream({ pages: 1, maxRequests: 10 });
    await upstream.acknowledge(await advanceToRead(upstream), goodRead());
    const response = (await (
      await upstream.fetch('http://fictional.invalid', wire(media))
    ).json()) as WireResponse;
    const call = response.choices[0]!.message.tool_calls[0]!.function;
    await assert.rejects(
      upstream.acknowledge(
        { tool: call.name, arguments: JSON.parse(call.arguments), callId: 'source' },
        {
          sourceHash: problem === 'hash' ? 'wrong-hash' : 'fixture-sha',
          revisionId: problem === 'revision' ? '' : 'fixture-revision',
          spans: [{ region: { page: problem === 'page' ? 2 : 1 } }],
          nextOffset: null,
        },
      ),
      /SCRIPTED_WRONG_SOURCE_TEXT/,
    );
  }
});
test(
  'cancellation after a physical request retains final evidence and closes the runtime',
  { skip: !hasOcr && 'Requires actual local Tesseract', timeout: 180_000 },
  async (t) => {
    const outputParent = parent(t);
    const controller = new AbortController();
    const timer = setInterval(() => {
      for (const name of readdirSync(outputParent)) {
        const requests = join(outputParent, name, 'requests.jsonl');
        if (existsSync(requests) && statSync(requests).size > 0) controller.abort();
      }
    }, 10);
    t.after(() => clearInterval(timer));
    const attempt = await runForTest(t, {
      outputParent,
      fixture: interruptionSlice,
      signal: AbortSignal.any([controller.signal, t.signal]),
    });
    clearInterval(timer);
    assert.equal(attempt.result.failure, 'SCRIPTED_USER_CANCELLED');
    assert.equal(attempt.result.outcome, 'incomplete');
    assert.ok(attempt.result.measurements.physicalRequests > 0);
    assert.equal(attempt.result.originalUnchanged, true);
    assert.equal(attempt.result.runtimeOpen, false);
    assert.equal(attempt.result.reviewEntry.url, null);
    assert.equal(attempt.result.acceptedRecords, 0);
    assert.equal(attempt.result.proposalGrade?.expectedRecords, 901);
    assert.ok(readFileSync(join(attempt.root, 'intake-final.json')).length);
    assert.ok(readFileSync(join(attempt.root, 'proposal-grade.json')).length);
    assert.ok(readFileSync(join(attempt.root, 'diagnostics-final.json')).length);
    assert.ok(readFileSync(join(attempt.root, 'review-final.json')).length);
  },
);
test(
  'interrupted real upstream retains existing proposals and a whole-oracle partial grade',
  { skip: !hasOcr && 'Requires actual local Tesseract', timeout: 180_000 },
  async (t) => {
    const attempt = await runForTest(t, {
      outputParent: parent(t),
      fixture: interruptionSlice,
      upstreamHttpFailureAt: 16,
      signal: t.signal,
    });
    assert.equal(attempt.result.failure, 'SCRIPTED_TRANSPORT_FAILURE');
    assert.equal(attempt.result.proposalGrade?.observedRecords, 4);
    assert.equal(attempt.result.proposalGrade?.missing.length, 897);
    assert.equal(attempt.result.originalUnchanged, true);
    assert.ok(readFileSync(join(attempt.root, 'diagnostics-final.json')).length);
  },
);
test(
  'keep-open without built assets closes the owned runtime and publishes no dead URL',
  { skip: existsSync(new URL('../dist/index.html', import.meta.url)) },
  async (t) => {
    const attempt = await runForTest(t, {
      outputParent: parent(t),
      fixture: tiny,
      keepOpen: true,
      maxRequests: 1,
    });
    assert.equal(attempt.result.runtimeOpen, false);
    assert.equal(attempt.result.reviewEntry.url, null);
  },
);
