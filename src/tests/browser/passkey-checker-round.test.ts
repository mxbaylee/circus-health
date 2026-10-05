import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';

test('fresh checker round preserves old evidence and resumes each mode separately', async (t) => {
  const vite = await createViteServer({
    configFile: false,
    root: process.cwd(),
    publicDir: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  });
  const server = createHttpServer((req, res) => {
    if (req.url === '/fixture') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Fictional checker round fixture</title>');
    } else
      vite.middlewares(req, res, () => {
        res.statusCode = 404;
        res.end();
      });
  });
  t.after(async () => {
    await vite.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, timeout: 15000 });
  t.after(() => browser.close());
  t.signal.addEventListener('abort', () => void browser.close(), { once: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture`);
  const evidence = await page.evaluate(async () => {
    const root = '/src/app/passkey-checker/';
    const { openCheckerStore } = (await import(
      root + 'store.ts'
    )) as typeof import('../../app/passkey-checker/store.ts');
    const { createRun, inspectEnvironment } = (await import(
      root + 'environment.ts'
    )) as typeof import('../../app/passkey-checker/environment.ts');
    const { roundDatabase, LEGACY_DATABASE } = (await import(
      root + 'round.ts'
    )) as typeof import('../../app/passkey-checker/round.ts');
    const { reportMarkdown } = (await import(
      root + 'report.ts'
    )) as typeof import('../../app/passkey-checker/report.ts');
    const build = { version: '3', revision: 'fictional-round-fixture', worktree: 'clean' };
    const legacy = await openCheckerStore(indexedDB, LEGACY_DATABASE);
    const oldRun = createRun(build, inspectEnvironment());
    const oldToken = await legacy.commit(null, { run: oldRun });
    await legacy.commit(oldToken, {
      observation: {
        id: 'fictional-old-observation',
        alias: 'A',
        step: 'general',
        outcome: 'could-not-test',
        note: 'Fictional historical observation retained exactly.',
        createdAt: oldRun.createdAt,
        build,
        environment: oldRun.environment,
      },
    });
    const before = JSON.stringify(await legacy.load());
    const rounds = [];
    for (const mode of ['eval', 'enable-only'] as const) {
      const store = await openCheckerStore(indexedDB, roundDatabase(mode));
      const empty = await store.load();
      const run = createRun(build, inspectEnvironment());
      const token = await store.commit(null, { run });
      await store.commit(token, {
        attempt: {
          id: 'fictional-failed-attempt',
          alias: 'A',
          step: 'create',
          status: 'failed',
          error: 'not-allowed',
          startedAt: run.createdAt,
          finishedAt: run.createdAt,
          sequence: 1,
          build,
          environment: run.environment,
          diagnostics: {
            requestMode: mode,
            inputShape: mode === 'enable-only' ? 'absent' : 'array-buffer',
            operation: 'create',
            stage: 'native-create',
            nativeOutcome: 'rejected',
            nativeErrorName: 'NotAllowedError',
            nativeDuration: '1-5s',
            userActivationAtInvocation: true,
            documentFocusedAtInvocation: false,
          },
        },
      });
      store.close();
      const reopened = await openCheckerStore(indexedDB, roundDatabase(mode));
      const retained = (await reopened.load())!;
      rounds.push({
        beganEmpty: empty === null,
        runId: retained.state.run.id,
        report: reportMarkdown(retained.state),
        diagnostics: retained.state.attempts[0].diagnostics,
      });
      if (mode === 'enable-only') {
        await reopened.reset(retained.token, createRun(build, inspectEnvironment()));
      }
      reopened.close();
    }
    const baseline = await openCheckerStore(indexedDB, roundDatabase('eval'));
    const baselineStillRetained = (await baseline.load())!.state.attempts.length === 1;
    baseline.close();
    const oldUnchanged = JSON.stringify(await legacy.load()) === before;
    legacy.close();
    return { oldUnchanged, baselineStillRetained, rounds, oldRunId: oldRun.id };
  });
  assert.equal(evidence.oldUnchanged, true);
  assert.equal(evidence.baselineStillRetained, true);
  assert.equal(evidence.rounds.every((round) => round.beganEmpty), true);
  assert.notEqual(evidence.rounds[0].runId, evidence.rounds[1].runId);
  assert.ok(evidence.rounds.every((round) => round.runId !== evidence.oldRunId));
  for (const round of evidence.rounds) {
    assert.equal(round.diagnostics?.nativeOutcome, 'rejected');
    assert.equal(round.diagnostics?.documentFocusedAtInvocation, false);
    assert.match(round.report, /native invocation outcome: rejected/);
    assert.match(round.report, /document focused at native invocation: false/);
    assert.doesNotMatch(round.report, /fictional-failed-attempt|fictional-old-observation/);
  }
});
