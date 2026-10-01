import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import {
  lockOwnedPasskeyProfile,
  physicalPasskeyConfiguration,
  physicalPasskeyJourney,
  physicalPasskeyPassed,
  type PhysicalPasskeyProgress,
} from '../../scripts/qualify-physical-passkey.ts';

for (const failFinalLock of [false, true])
  test(
    failFinalLock
      ? 'physical journey cannot pass when the final lock fails'
      : 'physical journey driver reaches enrollment, three unlocks and recovery with controlled browser hardware',
    { timeout: 60000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'fictional-passkey-driver-'));
      const runtimeDirectory = createTestRuntimeDirectory();
      mkdirSync(join(root, 'data'));
      const runtime = await startBrowserRuntime(t, {
        dataDirectory: join(root, 'data'),
        runtimeDirectory,
        port: 0,
        host: '127.0.0.1',
      });
      const browser = await launchBrowser(t);
      t.after(async () => {
        await browser.close();
        await runtime.close();
        rmSync(root, { recursive: true, force: true });
        rmSync(runtimeDirectory, { recursive: true, force: true });
      });
      const page = await newTestPage(browser);
      const origin = `http://localhost:${(runtime.server.address() as AddressInfo).port}`;
      const config = physicalPasskeyConfiguration({
        CRS_PHYSICAL_PASSKEY_QUALIFICATION: '1',
        CRS_QUALIFICATION_ORIGIN: origin,
        CRS_QUALIFICATION_OUTPUT_DIR: root,
      });
      assert.equal(config.https, false);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          ctap2Version: 'ctap2_1',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          hasPrf: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      const progress: PhysicalPasskeyProgress = {
        confirmedEnrollment: false,
        successfulUnlocks: 0,
        recoveryFallback: false,
      };
      let recoverySaved = false;
      let ownedName = '';
      const journey = physicalPasskeyJourney(
        page,
        config.origin,
        (phrase) => {
          assert.equal(phrase.split(' ').length, 24);
          recoverySaved = true;
        },
        progress,
        async (observed) => {
          if (failFinalLock && observed.recoveryFallback)
            await page.route('**/lock', (route) =>
              route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ data: null }),
              }),
            );
          if (observed.successfulUnlocks === 3)
            await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
              authenticatorId,
              enabled: false,
            });
        },
        () => {},
        (name) => {
          ownedName = name;
        },
      );
      if (failFinalLock) {
        await assert.rejects(journey);
        assert.equal(progress.recoveryFallback, true);
        assert.equal(physicalPasskeyPassed(progress, false), false);
        assert.equal(
          await lockOwnedPasskeyProfile(page.context().request, origin, undefined, ownedName),
          true,
        );
        const cards = await page.evaluate(
          async () =>
            ((await (await fetch('/api/profiles')).json()) as { data: { locked: boolean }[] }).data,
        );
        assert.equal(cards[0]?.locked, true);
        return;
      }
      await journey;
      assert.equal(recoverySaved, true);
      assert.equal(physicalPasskeyPassed(progress, true), true);
      assert.equal(
        await lockOwnedPasskeyProfile(page.context().request, origin, undefined, ownedName),
        true,
      );
      // Controlled hardware validates the driver only; it is not physical acceptance.
      const existing = {
        ...progress,
        confirmedEnrollment: false,
        successfulUnlocks: 0,
        recoveryFallback: false,
      };
      await assert.rejects(
        physicalPasskeyJourney(
          page,
          origin,
          () => assert.fail('Existing profile must not produce another recovery kit'),
          existing,
        ),
        /fresh isolated fictional/u,
      );
      assert.equal(physicalPasskeyPassed(existing), false);
    },
  );

test(
  'physical driver rejects insecure contexts and changed origins before profile access',
  { timeout: 60000 },
  async (t) => {
    const browser = await launchBrowser(t);
    t.after(() => browser.close());
    const redirectServer = createServer((request, response) => {
      if (request.headers.host?.startsWith('localhost:')) {
        response.writeHead(302, {
          Location: `http://127.0.0.1:${(redirectServer.address() as AddressInfo).port}`,
        });
        response.end();
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<title>Fictional redirected origin</title>');
      }
    });
    await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          redirectServer.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    for (const redirected of [false, true]) {
      const page = await newTestPage(browser);
      const origin = redirected
        ? `http://localhost:${(redirectServer.address() as AddressInfo).port}`
        : 'http://fictional-insecure.example.test';
      const requests: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      if (!redirected)
        await page.route('**/*', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<title>Fictional preflight</title>',
          });
        });
      const progress: PhysicalPasskeyProgress = {
        confirmedEnrollment: false,
        successfulUnlocks: 0,
        recoveryFallback: false,
      };
      await assert.rejects(
        physicalPasskeyJourney(
          page,
          origin,
          () => assert.fail('No recovery material before preflight'),
          progress,
        ),
        redirected ? /origin changed/ : /secure context/,
      );
      assert.ok(
        !requests.some((url) => url.includes('/api/')),
        'No profile listing or writes before the origin/security guard',
      );
      assert.equal(physicalPasskeyPassed(progress, true), false);
      await page.close();
    }
  },
);
