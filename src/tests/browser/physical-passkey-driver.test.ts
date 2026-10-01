import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import {
  physicalPasskeyJourney,
  physicalPasskeyPassed,
  type PhysicalPasskeyProgress,
} from '../../scripts/qualify-physical-passkey.ts';

test(
  'physical journey driver reaches enrollment, three unlocks and recovery with controlled browser hardware',
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
    await physicalPasskeyJourney(
      page,
      origin,
      (phrase) => {
        assert.equal(phrase.split(' ').length, 24);
        recoverySaved = true;
      },
      progress,
      async (observed) => {
        if (observed.successfulUnlocks === 3)
          await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
            authenticatorId,
            enabled: false,
          });
      },
    );
    assert.equal(recoverySaved, true);
    assert.equal(physicalPasskeyPassed(progress), true);
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
