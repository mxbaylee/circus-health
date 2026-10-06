import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import type {} from '../fixtures/passkey-checker-guided-ui.tsx';

for (const failB of [false, true])
  test(`guided browser: ${failB ? 'native failure and continuation' : 'A/B/C success'}, reload, actual download and explicit clear`, async (t) => {
    const vite = await createViteServer({
      configFile: false,
      root: process.cwd(),
      publicDir: false,
      plugins: [react()],
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'custom',
    });
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/fixture')) {
        res.setHeader('Content-Type', 'text/html');
        // Custom middleware must still use Vite's React/HTML transformation pipeline.
        void vite
          .transformIndexHtml(
            '/fixture',
            '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fictional guided checker</title></head><body><div id="root"></div><script type="module" src="/src/tests/fixtures/passkey-checker-guided-ui.tsx"></script></body></html>',
          )
          .then((html) => res.end(html))
          .catch((error: unknown) => {
            console.error('Fictional checker fixture failed to transform:', error);
            res.statusCode = 500;
            res.end('Fictional checker fixture failed to transform.');
          });
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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(10000);
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
      console.error('Fictional checker browser exception:', error.stack ?? error.message);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('Fictional checker console:', message.text());
    });
    await page.goto(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture${failB ? '?failB=1' : ''}`,
    );
    const idle = () =>
      page.waitForFunction(
        () =>
          !window.checkerFixture.controller.getSnapshot().busy &&
          window.checkerFixture.controller.getSnapshot().storage === 'saved',
      );
    const assertClearEnabled = async (expected: boolean) => {
      await page.waitForFunction((enabled) => {
        const button = Array.from(document.querySelectorAll('button')).find(
          (item) => item.textContent === 'Clear this run',
        );
        return button && !button.disabled === enabled;
      }, expected);
      assert.equal(
        await page.getByRole('button', { name: 'Clear this run', exact: true }).isEnabled(),
        expected,
      );
    };
    const act = async (name: string) => {
      await page.getByRole('button', { name, exact: true }).click();
      await idle();
    };
    await act('Create A');
    await act('Verify A');
    await act('Create B');
    if (failB) {
      await act('Recheck A');
      await act("Couldn't test — continue");
    } else await act('Verify B');
    const before = await page.evaluate(() => window.checkerFixture.controller.exportModel());
    await page.reload();
    await page.getByRole('button', { name: 'Create C', exact: true }).waitFor();
    const reloaded = await page.evaluate(() => window.checkerFixture.controller.exportModel());
    assert.deepEqual(reloaded.credentials, before.credentials);
    assert.deepEqual(reloaded.attempts, before.attempts);
    await act('Create C');
    await act('Verify C');
    const retained = await page.evaluate(
      () => window.checkerFixture.controller.exportModel().credentials,
    );
    await act('Recheck A');
    if (!failB) await act('Recheck B');
    await act('Recheck C');
    assert.deepEqual(
      await page.evaluate(() => window.checkerFixture.controller.exportModel().credentials),
      retained,
    );
    await assertClearEnabled(false);
    if (failB) {
      assert.match(
        await page.evaluate(() => window.checkerFixture.report()),
        /Verify B: not applicable/,
      );
      const data = await page.evaluate(() =>
        window.checkerFixture.controller
          .exportModel()
          .attempts.find((row) => row.error === 'unknown-error'),
      );
      assert.equal(data?.nativeMessage?.text, 'Fictional native refusal for this attempt.');
      // A failed download must not unlock clearing or remove any recorded attempt.
      await page.evaluate(() => {
        const original = URL.createObjectURL;
        URL.createObjectURL = () => {
          URL.createObjectURL = original;
          throw Error('Fictional download failure');
        };
      });
      await act('Download this report');
      await assertClearEnabled(false);
    }
    const downloadReport = async () => {
      const pending = page.waitForEvent('download');
      await act('Download this report');
      const download = await pending;
      assert.equal(download.suggestedFilename(), 'passkey-checker-report.md');
      const file = await download.path();
      assert.ok(file);
      const text = readFileSync(file, 'utf8');
      assert.equal(text, await page.evaluate(() => window.checkerFixture.report()));
      assert.match(text, /Report schema: 4/);
      for (const credential of retained) {
        assert.ok(!text.includes(credential.id));
        assert.ok(!text.includes(credential.salt));
        assert.ok(!text.includes(credential.cipher!.data));
      }
      if (failB) assert.match(text, /Fictional native refusal for this attempt/);
    };
    await downloadReport();
    await page.getByRole('checkbox', { name: "I've checked that this report was saved" }).check();
    await assertClearEnabled(true);
    await page.evaluate(() =>
      window.checkerFixture.controller.addObservation({
        alias: 'A',
        step: 'general',
        outcome: 'could-not-test',
        note: 'Fictional note after download.',
      }),
    );
    await idle();
    await assertClearEnabled(false);
    await downloadReport();
    await page.getByRole('checkbox', { name: "I've checked that this report was saved" }).check();
    await act('Clear this run');
    assert.equal(
      await page.evaluate(() => window.checkerFixture.controller.exportModel().attempts.length),
      0,
    );
    assert.equal(
      await page.evaluate(async () => {
        const previous = await window.checkerFixture.openCheckerStore(
          indexedDB,
          'circus-health-passkey-checker-v1',
        );
        const unchanged =
          JSON.stringify(await previous.load()) === window.checkerFixture.oldSnapshot;
        previous.close();
        return unchanged;
      }),
      true,
    );
    assert.deepEqual(errors, []);
  });
