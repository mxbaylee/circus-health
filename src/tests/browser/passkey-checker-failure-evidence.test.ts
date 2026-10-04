import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';

test(
  'actual checker failures survive controller capture, IndexedDB reload and private-safe reports',
  { timeout: 60_000 },
  async (t) => {
    const vite = await createViteServer({
      configFile: false,
      root: process.cwd(),
      publicDir: false,
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'custom',
    });
    const server = createServer((req, res) => {
      if (req.url === '/fixture')
        res.end('<!doctype html><title>Fictional failure evidence</title>');
      else
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
    const browser = await chromium.launch({ headless: true, timeout: 15_000 });
    t.after(() => browser.close());
    t.signal.addEventListener(
      'abort',
      () => {
        void browser.close();
      },
      { once: true },
    );
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture`);
    const evidence = await page.evaluate(async () => {
      const moduleRoot = '/src/app/passkey-checker/';
      const core = (await import(
        moduleRoot + 'core.ts'
      )) as typeof import('../../app/passkey-checker/core.ts');
      const { createCheckerController } = (await import(
        moduleRoot + 'controller.ts'
      )) as typeof import('../../app/passkey-checker/controller.ts');
      const { openCheckerStore, deleteCheckerStore } = (await import(
        moduleRoot + 'store.ts'
      )) as typeof import('../../app/passkey-checker/store.ts');
      const { reportMarkdown } = (await import(
        moduleRoot + 'report.ts'
      )) as typeof import('../../app/passkey-checker/report.ts');
      const name = 'fictional-checker-failure-evidence';
      const build = { version: '3', revision: 'fictional-failure-build', worktree: 'clean' };
      const open = () => openCheckerStore(indexedDB, name);
      let mode = 'valid';
      let creationError = 'InvalidStateError';
      let creations = 0;
      let mismatchedExtensionReads = 0;
      const rawA = new Uint8Array(32).fill(17);
      const rawOther = new Uint8Array(32).fill(29);
      const output = new Uint8Array(32).fill(37);
      const credential = (wrong = false): Credential =>
        ({
          type: 'public-key',
          rawId: (wrong ? rawOther : rawA).slice().buffer,
          getClientExtensionResults() {
            if (wrong) {
              mismatchedExtensionReads++;
              throw Error('fixture-private-mismatched-response');
            }
            if (mode === 'extension-throws') throw new TypeError('fixture-private-extension');
            if (mode === 'absent') return {};
            if (mode === 'null-results') return { prf: { results: null } };
            if (mode === 'short-array') return { prf: { results: { first: Array(31).fill(1) } } };
            return { prf: { results: { first: output.slice().buffer } } };
          },
        }) as unknown as Credential;
      // This explicit core test port never replaces navigator.credentials and
      // supplies no physical provider evidence. Encryption and storage are real.
      const port: import('../../app/passkey-checker/core.ts').CredentialPort = {
        async create() {
          if (creations++ === 0) return credential();
          throw new DOMException('fixture-private-creation', creationError);
        },
        async get() {
          if (mode === 'not-allowed')
            throw new DOMException('fixture-private-refusal', 'NotAllowedError');
          if (mode === 'hostile-error')
            throw Object.defineProperty({}, 'name', {
              get() {
                throw Error('fixture-private-error-name');
              },
            });
          return credential(mode === 'wrong');
        },
      };
      const options = {
        build,
        openStore: open,
        core: {
          createCredential: (run, alias, existing, _port, observer) =>
            core.createCredential(run, alias, existing, port, observer),
          confirmCredential: (run, selected, _port, observer) =>
            core.confirmCredential(run, selected, port, observer),
          verifyCredential: (run, selected, _port, observer) =>
            core.verifyCredential(run, selected, port, observer),
        },
      } satisfies import('../../app/passkey-checker/controller.ts').ControllerOptions;
      let controller = await createCheckerController(options);
      await controller.runStep('A', 'create');
      const failures = [];
      for (const selectedMode of [
        'not-allowed',
        'wrong',
        'absent',
        'null-results',
        'short-array',
        'extension-throws',
        'hostile-error',
      ]) {
        mode = selectedMode;
        await controller.runStep('A', 'confirm');
        const attempt = controller.exportModel().attempts.at(-1)!;
        failures.push({
          mode,
          status: attempt.status,
          error: attempt.error,
          diagnostics: attempt.diagnostics,
          busy: controller.getSnapshot().busy,
        });
      }
      mode = 'valid';
      await controller.runStep('A', 'confirm');
      for (const step of ['use-1', 'use-2', 'use-3'] as const) await controller.runStep('A', step);
      const confirmed = controller.exportModel().credentials[0];
      const originalCipher = JSON.stringify(confirmed.cipher);
      await controller.runStep('B', 'create');
      await controller.runStep('A', 'use-after-b-failed');
      creationError = 'UnknownError';
      await controller.runStep('B', 'create');
      const reportBeforeRecovery = reportMarkdown(controller.exportModel());
      mode = 'short-array';
      await controller.runStep('A', 'use-after-b-failed');
      const beforeReload = controller.exportModel();
      controller.close();
      controller = await createCheckerController(options);
      const afterReload = controller.exportModel();
      const report = reportMarkdown(afterReload);
      const store = await open();
      const stored = (await store.load())!;
      const sample = stored.state.attempts.find((attempt) => attempt.error === 'prf-invalid')!;
      let invalidRejected = 0;
      for (const invalid of [
        { ...sample.diagnostics, stage: 'fixture-private-stage' },
        { ...sample.diagnostics, nativeErrorName: 'fixture-private-name' },
        { ...sample.diagnostics, validationRule: 'fixture-private-rule' },
        { ...sample.diagnostics, excludedCredentialCount: 3 },
        { ...sample.diagnostics, nativeMessage: 'fixture-private-message' },
      ]) {
        try {
          await store.commit(stored.token, {
            attempt: { ...sample, diagnostics: invalid } as typeof sample,
          });
        } catch (error) {
          if ((error as { reason?: string }).reason === 'incompatible') invalidRejected++;
        }
      }
      const unchangedRevision = (await store.load())!.token.revision === stored.token.revision;
      store.close();
      const returned = {
        failures,
        mismatchedExtensionReads,
        sameAttempts:
          JSON.stringify(beforeReload.attempts) === JSON.stringify(afterReload.attempts),
        sameCipher: JSON.stringify(afterReload.credentials[0].cipher) === originalCipher,
        bAttempts: afterReload.attempts
          .filter((row) => row.alias === 'B')
          .map((row) => ({ status: row.status, error: row.error, diagnostics: row.diagnostics })),
        recoveries: afterReload.attempts
          .filter((row) => row.step === 'use-after-b-failed')
          .map((row) => row.status),
        report,
        reportBeforeRecovery,
        invalidRejected,
        unchangedRevision,
        privateValuesAbsent: [
          confirmed.id,
          confirmed.salt,
          confirmed.cipher!.iv,
          confirmed.cipher!.data,
          ...afterReload.attempts.map((row) => row.id),
        ].every((value) => !report.includes(value)),
      };
      controller.close();
      await deleteCheckerStore(indexedDB, name);
      return returned;
    });
    assert.equal(evidence.sameAttempts, true);
    assert.equal(evidence.sameCipher, true);
    assert.equal(evidence.mismatchedExtensionReads, 0);
    assert.equal(evidence.invalidRejected, 5);
    assert.equal(evidence.unchangedRevision, true);
    assert.equal(evidence.privateValuesAbsent, true);
    assert.ok(evidence.failures.every((row) => row.status === 'failed' && !row.busy));
    const byMode = Object.fromEntries(evidence.failures.map((row) => [row.mode, row]));
    assert.equal(byMode['not-allowed'].diagnostics?.stage, 'native-get');
    assert.equal(byMode['not-allowed'].diagnostics?.nativeErrorName, 'NotAllowedError');
    assert.equal(byMode.wrong.diagnostics?.validationRule, 'selected-credential');
    assert.equal(byMode.wrong.diagnostics?.credentialMatched, false);
    assert.equal(byMode.wrong.diagnostics?.outputShape, undefined);
    assert.equal(byMode.absent.diagnostics?.validationRule, 'prf-extension-present');
    assert.equal(byMode['null-results'].diagnostics?.resultsShape, 'null');
    assert.equal(byMode['short-array'].diagnostics?.validationRule, 'prf-output-array-length');
    assert.equal(byMode['short-array'].diagnostics?.outputLength, 31);
    assert.equal(byMode['extension-throws'].diagnostics?.stage, 'extension-read');
    assert.equal(byMode['hostile-error'].diagnostics?.nativeErrorName, 'unrecognized');
    assert.deepEqual(
      evidence.bAttempts.map((row) => row.error),
      ['invalid-state', 'unknown-error'],
    );
    assert.deepEqual(
      evidence.bAttempts.map((row) => row.diagnostics?.nativeErrorName),
      ['InvalidStateError', 'UnknownError'],
    );
    assert.ok(
      evidence.bAttempts.every(
        (row) =>
          row.diagnostics?.stage === 'native-create' &&
          row.diagnostics?.excludedCredentialCount === 1,
      ),
    );
    assert.deepEqual(evidence.recoveries, ['verified', 'failed']);
    assert.match(evidence.reportBeforeRecovery, /latest failed B creation: unfinished/);
    assert.match(evidence.report, /Use A after B creation fails, attempt 1: verified PRF/);
    assert.match(evidence.report, /Use A after B creation fails, attempt 2: failed/);
    assert.match(evidence.report, /Linked failed B creation: attempt 1/);
    assert.match(evidence.report, /Linked failed B creation: attempt 2/);
    assert.match(evidence.report, /expected: exactly 32 array entries/);
    assert.match(evidence.report, /native error name: UnknownError/);
    assert.doesNotMatch(evidence.report, /fixture-private|rawId|nativeMessage/);
  },
);
