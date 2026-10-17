/** One bounded real-HTTP fixture; no external network or provider qualification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import type { ImportDiagnosticExport } from '../server/import-diagnostics.ts';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import {
  finalizeQualificationPrivateTraceReport,
  prepareQualificationPrivateTrace,
  prepareQualificationTraceProfile,
  qualificationPrivateTraceCompose,
  qualificationPrivateTraceLimits,
  qualificationPrivateTraceReport,
  retainQualificationPrivateTraceStatus,
  revokeQualificationPrivateTraceForReport,
} from './provider-qualification-private-trace.ts';
import {
  prepareQualificationRequestBudget,
  readQualificationRequestBudget,
} from './provider-qualification-request-budget.ts';
import { readQualificationResponse, shareQualificationEvidence } from './qualify-provider-pdf.ts';
import { testEnvironment } from './test-suite.ts';

type WireMessage = { role: string; content: unknown };
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function toolReply(name: string, args: Record<string, unknown>, sequence: number) {
  return {
    model: 'fictional-http-trace',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `fictional-trace-call-${sequence}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  };
}
function finalReply(content: string) {
  return {
    model: 'fictional-http-trace',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  };
}

test(
  'fresh encrypted HTTP profile grants tracing before a probe, records an actual intake tool, and revokes before stopping',
  { timeout: 90_000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fictional-http-private-trace-')));
    chmodSync(root, 0o700);
    const trace = prepareQualificationPrivateTrace(root);
    const budget = prepareQualificationRequestBudget(root, trace);
    const report = qualificationPrivateTraceReport(true);
    const consumed = Promise.withResolvers<void>();
    void consumed.promise.catch(() => {
      /* Report at the awaited checkpoint below. */
    });
    const release = Promise.withResolvers<void>();
    const failures: string[] = [];
    const marker = 'INDEPENDENTLY FICTIONAL HTTP TRACE SOURCE';
    let requests = 0;
    let importId: string | undefined;
    let child: ChildProcess | undefined;
    let stderr = '';
    const upstream = createServer(async (request, response) => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        assert.ok(++requests <= 16, 'the scripted fixture cannot exceed the unchanged cap');
        let raw = '';
        for await (const chunk of request) raw += String(chunk);
        const wire = object(JSON.parse(raw));
        assert.ok(Array.isArray(wire.messages));
        const messages = wire.messages as WireMessage[];
        const definitions = Array.isArray(wire.tools) ? wire.tools : [];
        const probe = definitions.some(
          (entry) => object(object(entry).function).name === 'health_connection_test',
        );
        let reply: unknown;
        if (probe) {
          const result = messages.find((message) => message.role === 'tool');
          if (result)
            reply = finalReply(String(object(JSON.parse(String(result.content))).response));
          else {
            const challenge = /challenge ([a-f0-9-]+)/.exec(
              String(messages.find((message) => message.role === 'user')?.content),
            );
            assert.ok(challenge);
            reply = toolReply('health_connection_test', { challenge: challenge[1] }, requests);
          }
        } else if (!importId) {
          const initial = String(messages.find((message) => message.role === 'user')?.content);
          const context = object(JSON.parse(initial.slice(initial.indexOf('\n') + 1)));
          importId = String(object(context.conversion).intakeId);
          assert.ok(importId && importId !== 'undefined');
          reply = toolReply('health_intake_read', { id: importId, offset: 0 }, requests);
        } else {
          const result = messages.find((message) => message.role === 'tool');
          assert.ok(result, 'the existing host dispatched the scripted intake tool');
          const payload = object(JSON.parse(String(result.content)));
          assert.equal(payload.error, undefined, 'the scripted intake read succeeded');
          assert.ok(
            JSON.stringify(payload).includes(marker),
            'the tool returned the actual fictional original',
          );
          consumed.resolve();
          await release.promise;
          reply = finalReply(
            'Independently fictional trace fixture stopped; no proposal or acceptance.',
          );
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(reply));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'Fictional upstream failed.');
        consumed.reject(error);
        response.writeHead(500).end('Fictional scripted upstream failed.');
      }
    });
    t.after(async () => {
      try {
        try {
          revokeQualificationPrivateTraceForReport(trace, report);
        } finally {
          release.resolve();
          if (child && child.exitCode === null && child.signalCode === null) {
            const closed = once(child, 'close');
            if (child.connected) child.send('stop');
            await Promise.race([
              closed,
              delay(5000, undefined, { ref: false }).then(() => child?.kill('SIGKILL')),
            ]);
            const [code, signal] = await closed;
            assert.equal(code, 0, 'the encrypted HTTP fixture closes cleanly');
            assert.equal(signal, null);
          }
        }
      } finally {
        upstream.closeAllConnections();
        upstream.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const proxyAddress = upstream.address();
    assert.ok(proxyAddress && typeof proxyAddress === 'object');
    // The child receives no operator/provider settings or credential variables.
    const environment = Object.fromEntries(
      Object.entries(testEnvironment(process.env, 'tools')).filter(([key]) =>
        ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot'].includes(key),
      ),
    );
    const env = {
      ...environment,
      ...qualificationPrivateTraceCompose(trace).environment,
      CRS_IMPORT_DIAGNOSTICS: 'true',
      CRS_IMPORT_PRIVATE_TRACE_DIR: trace.directory,
      CRS_IMPORT_PRIVATE_TRACE_GRANT_FILE: trace.grantFile,
      CRS_QUALIFICATION_REQUEST_RECEIPTS: budget.receipts,
      CRS_DATA_DIR: join(root, 'data'),
      CRS_RUNTIME_DIR: join(root, 'runtime'),
      CRS_AI_BACKEND: 'litellm',
      CRS_AI_MODEL: 'fictional-http-trace',
      CRS_AI_BASE_URL: `http://127.0.0.1:${proxyAddress.port}`,
      CRS_AI_API_KEY: 'fictional-integrated-proxy-secret',
      CRS_AI_PROXY_LOCAL_ONLY: 'true',
      CRS_AI_PROXY_RESOLVED_MODEL: 'fictional-scripted-local',
      CRS_AI_PROXY_IMAGES: 'false',
      CRS_AI_PROXY_PDF: 'false',
      CRS_AI_PROXY_PROMPT_CACHE: 'false',
    };
    mkdirSync(env.CRS_DATA_DIR, { mode: 0o700 });
    child = spawn(
      process.execPath,
      [
        '--import',
        budget.preloader,
        fileURLToPath(
          new URL('./provider-qualification-private-trace-http-fixture.ts', import.meta.url),
        ),
      ],
      { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const ready = await Promise.race([
      once(child, 'message', { signal: t.signal }).then(([message]) => object(message)),
      once(child, 'close', { signal: t.signal }).then(() => {
        throw Error('Fictional HTTP child closed before readiness.');
      }),
    ]);
    assert.equal(ready.type, 'ready');
    const base = `http://127.0.0.1:${Number(ready.port)}`;
    let cookie = '';
    async function http<T>(path: string, input?: unknown, text?: string): Promise<T> {
      const response = await fetch(base + path, {
        method: input !== undefined || text !== undefined ? 'POST' : 'GET',
        headers: {
          Origin: 'http://localhost:5173',
          Cookie: cookie,
          Connection: 'close',
          'Content-Type': text === undefined ? 'application/json' : 'text/plain',
          ...(text === undefined ? {} : { 'X-Filename': 'independently-fictional-trace.txt' }),
        },
        ...(text === undefined
          ? input === undefined
            ? {}
            : { body: JSON.stringify(input) }
          : { body: text }),
        signal: t.signal,
      });
      return readQualificationResponse<T>(response, t.signal, {
        cookie: (value) => {
          cookie = value;
        },
      });
    }
    const setup = await http<{ setupId: string; recoveryKit: unknown }>('/api/profile-setups', {
      name: 'Independently fictional trace',
      fullName: 'Fictional Rowan Vale',
      birthDate: '1983-02-14',
      placebo: false,
    });
    const profile = await http<{ id: string }>(`/api/profile-setups/${setup.setupId}/verify`, {
      recovery: setup.recoveryKit,
      acknowledged: true,
    });
    const prefix = `/api/profiles/${profile.id}`;
    assert.equal(requests, 0);
    assert.equal(existsSync(trace.grantFile), false);
    const before = await http<ImportDiagnosticExport>(prefix + '/import-diagnostics');
    assert.equal(before.privateTrace?.enabled, false);
    assert.equal(before.privateTrace?.reason, 'grant_unavailable');
    report.readiness = await prepareQualificationTraceProfile(
      trace,
      profile.id,
      new Set([profile.id]),
      {
        diagnostics: () => http<ImportDiagnosticExport>(prefix + '/import-diagnostics'),
        requestBudget: () => readQualificationRequestBudget(budget.receipts),
      },
    );
    assert.equal(report.readiness.admittedRequests, 0);
    assert.deepEqual(report.readiness.status.limits, qualificationPrivateTraceLimits);
    assert.equal(statSync(trace.grantFile).mode & 0o777, 0o600);
    const connection = await http<{ available: boolean }>(prefix + '/assistant/test-connection', {
      image: false,
      pdf: false,
    });
    assert.equal(connection.available, true);
    assert.equal(requests, 2);
    const afterProbe = await http<ImportDiagnosticExport>(prefix + '/import-diagnostics');
    assert.equal(
      afterProbe.privateTrace?.recordedEvents,
      0,
      'capability probe payloads intentionally lack import trace context',
    );
    const uploaded = await http<{ id: string }>(
      prefix + '/intakes',
      undefined,
      marker + '\nNo clinical observations are present.\n',
    );
    const abortConsumption = () => consumed.reject(t.signal.reason);
    t.signal.addEventListener('abort', abortConsumption, { once: true });
    try {
      t.signal.throwIfAborted();
      await consumed.promise;
    } finally {
      t.signal.removeEventListener('abort', abortConsumption);
    }
    assert.equal(importId, uploaded.id);
    assert.deepEqual(failures, []);
    assert.equal(requests, 4);
    const capture = shareQualificationEvidence(
      [
        async (signal) => {
          const snapshot = await http<ImportDiagnosticExport>(prefix + '/import-diagnostics');
          signal.throwIfAborted();
          retainQualificationPrivateTraceStatus(report, snapshot.privateTrace);
          return true;
        },
      ],
      (outcomes) => {
        assert.deepEqual(outcomes, [true]);
      },
    );
    await capture.capture(t.signal);
    assert.ok(report.latestStatus?.enabled);
    assert.equal(report.latestStatus.omittedEvents, 0);
    assert.equal(report.latestStatus.truncatedEvents, 0);
    const payloadFiles = () =>
      readdirSync(trace.directory)
        .flatMap((partition) => {
          const directory = join(trace.directory, partition);
          assert.equal(statSync(directory).mode & 0o777, 0o700);
          return readdirSync(directory).map((filename) => join(partition, filename));
        })
        .sort();
    // Workers can initialize empty existing-sink partitions too. Account for
    // every actual payload file, rather than assuming one runtime initializer.
    const files = payloadFiles();
    assert.ok(files.length > 0);
    const entries = files.map((filename) => {
      const path = join(trace.directory, filename);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      const raw = gunzipSync(readFileSync(path)).toString();
      assert.doesNotMatch(raw, /fictional-integrated-proxy-secret/);
      return object(JSON.parse(raw));
    });
    assert.ok(entries.some((entry) => entry.event === 'model.request'));
    assert.ok(entries.some((entry) => entry.event === 'model.response'));
    assert.ok(
      entries.some(
        (entry) =>
          entry.event === 'tool.request' &&
          JSON.stringify(entry.payload).includes('health_intake_read'),
      ),
    );
    for (const entry of entries.filter((entry) =>
      ['model.request', 'model.response', 'tool.request', 'tool.response'].includes(
        String(entry.event),
      ),
    ))
      assert.equal(object(entry.context).importId, uploaded.id);
    assert.ok(
      entries.some(
        (entry) =>
          entry.event === 'tool.response' && JSON.stringify(entry.payload).includes(marker),
      ),
    );
    assert.equal(report.latestStatus.recordedEvents, files.length);
    revokeQualificationPrivateTraceForReport(trace, report);
    const revoked = await http<ImportDiagnosticExport>(prefix + '/import-diagnostics');
    assert.equal(revoked.privateTrace?.enabled, false);
    assert.equal(revoked.privateTrace?.reason, 'grant_unavailable');
    const batches = await http<IntakeBatch[]>(prefix + '/intake-batches');
    const batch = batches.find((candidate) =>
      candidate.items.some((item) => item.intakeId === uploaded.id),
    );
    assert.ok(batch);
    await http(prefix + `/intake-batches/${batch.id}/stop`, {});
    release.resolve();
    const afterStop = await http<ImportDiagnosticExport>(prefix + '/import-diagnostics');
    assert.equal(afterStop.privateTrace?.recordedEvents, files.length);
    assert.deepEqual(payloadFiles(), files);
    const finalBudget = readQualificationRequestBudget(budget.receipts);
    assert.equal(finalBudget.limit, 16);
    assert.equal(finalBudget.admitted, 4);
    assert.equal(finalBudget.denied, 0);
    assert.equal(finalBudget.stopReason, null);
    finalizeQualificationPrivateTraceReport(report);
    assert.equal(report.failure, null);
    assert.equal(report.teardown?.lastStatus?.enabled, true);
    assert.equal(report.grantRevoked, true);
    assert.match(report.teardown!.boundary, /shutdown tail and probe payloads are not covered/);
    assert.doesNotMatch(stderr, /fictional-integrated-proxy-secret/);
  },
);
