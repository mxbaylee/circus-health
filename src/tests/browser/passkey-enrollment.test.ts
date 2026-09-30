import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { Browser } from 'playwright';
import type { Note } from '../../shared/api.ts';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

declare global {
  interface Window {
    passkeyCalls: { create: number; get: number };
    pauseConfirmation: boolean;
    failAuthenticationOnce?: boolean;
    releaseConfirmation?: () => void;
  }
}

// Default: production UI and encrypted runtime. Opt-in: the actual built app
// image and Compose health service, isolated from all existing user archives.
const dockerMode = process.env.CRS_PASSKEY_DOCKER_TEST === '1';
for (const prfOutput of ['buffer', 'array'])
  test(
    `automatic passkey confirmation and default restart unlock with ${prfOutput} PRF; cancellation and missing PRF preserve recovery`,
    { timeout: 60000 },
    async (t) => {
      const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'circus-passkey-browser-')));
      const repository = fileURLToPath(new URL('../../../', import.meta.url));
      const data = resolve(root, 'data');
      mkdirSync(data);
      const socket = createServer();
      await new Promise<void>((done) => socket.listen(0, '127.0.0.1', done));
      const port = (socket.address() as AddressInfo).port;
      await new Promise((done) => socket.close(done));
      const origin = `http://localhost:${port}`,
        project = `circus-passkey-test-${process.pid}`,
        container = `${project}-health`;
      let runtime: Awaited<ReturnType<typeof startBrowserRuntime>> | undefined,
        browser: Browser | undefined;
      mkdirSync(resolve(root, 'auth'));
      writeFileSync(resolve(root, 'empty.env'), '');
      writeFileSync(resolve(root, 'config.yaml'), 'model_list: []\n');
      writeFileSync(resolve(root, 'key'), 'fictional-passkey-test-only\n', { mode: 0o600 });
      const runtimeDirectory = createTestRuntimeDirectory();
      const env = {
        ...process.env,
        CRS_DATA_DIR: data,
        CRS_PORT: String(port),
        CRS_PUBLIC_ORIGIN: origin,
        CRS_AUTH_DIR: resolve(root, 'auth'),
        CRS_PROXY_KEY: resolve(root, 'key'),
        CRS_LITELLM_CONFIG: resolve(root, 'config.yaml'),
        CRS_LITELLM_ENV_FILE: resolve(root, 'empty.env'),
        CRS_MODEL: 'fictional-only',
        CRS_RESPONSE_MODEL: 'fictional-only',
        CRS_IMAGES: 'false',
      };
      const compose = [
        'compose',
        '--env-file',
        resolve(root, 'empty.env'),
        '-f',
        resolve(repository, 'compose.yaml'),
        '-p',
        project,
      ];
      const docker = (args: string[]) =>
        execFileSync('docker', args, {
          cwd: repository,
          env,
          encoding: 'utf8',
          timeout: 60000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      async function start() {
        if (dockerMode)
          docker([
            ...compose,
            'run',
            '--no-deps',
            '--service-ports',
            '--detach',
            '--name',
            container,
            'health',
          ]);
        else
          runtime = await startBrowserRuntime(t, {
            dataDirectory: data,
            runtimeDirectory,
            port,
            host: '127.0.0.1',
          });
        for (let i = 0; i < 150; i++) {
          try {
            if ((await fetch(origin + '/health/ready')).ok) return;
          } catch {}
          await delay(100);
        }
        assert.fail('Encrypted runtime did not start');
      }
      async function stop() {
        if (dockerMode) {
          try {
            docker(['rm', '-f', container]);
          } catch {}
        } else await runtime?.close();
      }
      t.after(async () => {
        await browser?.close();
        await stop();
        if (dockerMode) docker([...compose, 'down', '--remove-orphans']);
        rmSync(runtimeDirectory, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      });
      await start();
      browser = await launchBrowser(t);
      const page = await newTestPage(browser, { viewport: { width: 1280, height: 900 } }),
        errors: string[] = [],
        savedRequests = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (request.url().endsWith('/passkeys/confirm')) savedRequests.push(request.url());
      });
      const visuals = process.env.CRS_PASSKEY_VISUAL_DIR;
      async function capture(prefix: string) {
        if (!visuals || prfOutput !== 'buffer') return;
        assert(
          resolve(visuals).startsWith('/') &&
            !resolve(visuals).startsWith(resolve(repository) + '/'),
        );
        mkdirSync(visuals, { recursive: true });
        for (const theme of ['light', 'dark'])
          for (const [size, viewport] of [
            ['desktop', { width: 1280, height: 900 }],
            ['mobile', { width: 390, height: 844 }],
          ] as const) {
            await page.setViewportSize(viewport);
            await page.evaluate((theme) => {
              document.documentElement.dataset.theme = theme;
              document.documentElement.style.colorScheme = theme;
            }, theme);
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.screenshot({
              path: resolve(visuals, `${prefix}-${theme}-${size}.png`),
              animations: 'disabled',
            });
          }
        await page.setViewportSize({ width: 1280, height: 900 });
      }
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      const virtualOptions = {
        protocol: 'ctap2',
        ctap2Version: 'ctap2_1',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        hasPrf: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      } as const;
      let { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: virtualOptions,
      });
      await page.addInitScript(
        ({ prfOutput }) => {
          const create = navigator.credentials.create.bind(navigator.credentials),
            get = navigator.credentials.get.bind(navigator.credentials);
          window.passkeyCalls = { create: 0, get: 0 };
          window.pauseConfirmation = true;
          navigator.credentials.create = async (options) => {
            window.passkeyCalls.create++;
            const credential = (await create(options)) as PublicKeyCredential,
              output = credential.getClientExtensionResults();
            // Simulate a provider that reports capability at creation, keeping real
            // Chromium credential generation, signatures and subsequent PRF results.
            Object.defineProperty(credential, 'getClientExtensionResults', {
              value: () => ({ ...output, prf: { enabled: output.prf?.enabled } }),
            });
            return credential;
          };
          navigator.credentials.get = async (options) => {
            window.passkeyCalls.get++;
            if (window.failAuthenticationOnce) {
              window.failAuthenticationOnce = false;
              throw new DOMException('Fictional prompt cancelled', 'NotAllowedError');
            }
            if (window.pauseConfirmation)
              await new Promise<void>((done, reject) => {
                window.releaseConfirmation = () => {
                  window.pauseConfirmation = false;
                  done();
                };
                options!.signal?.addEventListener(
                  'abort',
                  () => reject(new DOMException('Skipped', 'AbortError')),
                  { once: true },
                );
              });
            const credential = (await get(options)) as PublicKeyCredential;
            if (prfOutput === 'array') {
              const output = credential.getClientExtensionResults();
              if (output.prf?.results?.first) {
                const values = output.prf.results;
                // Preserve actual cryptographic bytes while reproducing the plain
                // Array representation reported for 1Password Firefox/Chrome.
                Object.defineProperty(credential, 'getClientExtensionResults', {
                  value: () => ({
                    ...output,
                    prf: {
                      ...output.prf,
                      results: {
                        ...values,
                        first: Array.from(new Uint8Array(values.first as ArrayBuffer)),
                      },
                    },
                  }),
                });
              }
            }
            return credential;
          };
        },
        { prfOutput },
      );
      await page.goto(origin);
      const api = (path: string, body?: unknown) =>
        page.evaluate(
          async ({ path, body }) => {
            const response = await fetch(
              path,
              body === undefined
                ? {}
                : {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                  },
            );
            return { status: response.status, value: await response.json() };
          },
          { path, body },
        );
      assert.equal((await api('/api/runtime')).value.encrypted, true);
      assert.deepEqual((await api('/api/profiles')).value.data, []);
      await page.getByRole('button', { name: 'Create profile', exact: true }).click();
      await page.getByLabel('Display name', { exact: true }).fill('Fictional Passkey Robin');
      await page.getByLabel('Your name').fill('Fictional Passkey Robin');
      await page.getByLabel('Date of birth', { exact: true }).fill('1982-04-17');
      await page.getByRole('button', { name: 'Continue to recovery key' }).click();
      const recovery = await page.getByLabel('Recovery key', { exact: true }).inputValue();
      await page.getByLabel('I have saved my recovery key').check();
      await capture('save-recovery');
      await page.getByRole('button', { name: 'Verify recovery key', exact: true }).click();
      const verification = page.getByRole('dialog', { name: 'Open profile', exact: true });
      assert.equal(
        await verification.getByLabel('Recovery key', { exact: true }).inputValue(),
        '',
        'recovery verification cannot prefill the displayed secret',
      );
      assert.equal(
        await verification.locator('input[name="username"]').inputValue(),
        'Fictional Passkey Robin',
      );
      assert.equal(
        await verification.locator('input[name="password"]').getAttribute('type'),
        'password',
      );
      assert.equal(
        await verification.locator('input[name="password"]').getAttribute('autocomplete'),
        'current-password',
      );
      assert.equal(await verification.locator('form').getAttribute('method'), 'post');
      await capture('open-profile');
      await verification.getByLabel('Recovery key', { exact: true }).fill(recovery);
      await verification.getByRole('button', { name: 'Open profile', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Recovery unlocked', exact: true })
        .getByRole('button', { name: 'Add passkey', exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Add passkey for Fictional Passkey Robin' });
      await dialog.getByRole('status').filter({ hasText: 'Confirm your passkey' }).waitFor();
      await page.waitForFunction(() => typeof window.releaseConfirmation === 'function');
      assert.equal(
        await dialog.getByRole('button', { name: 'Add passkey', exact: true }).count(),
        0,
      );
      assert.equal(
        await dialog.getByRole('button', { name: 'Skip', exact: true }).isEnabled(),
        true,
      );
      assert.equal(
        (await api('/api/profiles')).value.data[0].hasPasskey,
        false,
        'creation alone cannot advertise a usable passkey',
      );
      await capture('passkey');
      const confirmationResponse = page.waitForResponse((response) =>
        response.url().endsWith('/passkeys/confirm'),
      );
      await page.evaluate(() => window.releaseConfirmation!());
      assert.equal((await confirmationResponse).status(), 200);
      for (const step of ['Primary care provider', 'Emergency contact']) {
        const setup = page.getByRole('dialog', { name: 'Care contacts' });
        await setup.getByRole('heading', { name: step, exact: true }).waitFor();
        await setup.getByRole('button', { name: 'Skip for now' }).click();
      }
      assert.deepEqual(await page.evaluate(() => window.passkeyCalls), { create: 1, get: 1 });
      const profile = (await api('/api/profiles')).value.data[0],
        path = `/api/profiles/${profile.id}`;
      assert.equal(profile.hasPasskey, true);
      const peerSetup = (
        await api('/api/profile-setups', {
          fullName: 'Fictional Recovery Wren',
          birthDate: '1982-04-17',
          name: 'Fictional Recovery Wren',
          placebo: false,
        })
      ).value.data;
      assert.equal(
        (
          await api(`/api/profile-setups/${peerSetup.setupId}/verify`, {
            acknowledged: true,
            recovery: peerSetup.recoveryKit,
          })
        ).status,
        201,
      );
      const peerPath = `/api/profiles/${peerSetup.profileId}`;
      assert.equal(
        (await api('/api/profiles')).value.data.find(
          (item: { id: string }) => item.id === profile.id,
        ).locked,
        true,
        'new profile activation locks the prior profile',
      );
      await stop();
      await start();
      await page.reload();
      assert.equal(
        (await api('/api/profiles')).value.data.find(
          (item: { id: string }) => item.id === profile.id,
        ).hasPasskey,
        true,
        'confirmed availability survives container recreation',
      );
      assert.equal(
        (await api(peerPath + '/unlock', { recovery: peerSetup.recoveryKit })).status,
        200,
      );
      const invalid = (await api(path + '/passkeys/authentication-options', {})).value.data;
      assert.equal(
        (
          await api(path + '/passkeys/authenticate', {
            challengeId: invalid.challengeId,
            response: { id: 'fictional-wrong-key' },
          })
        ).status,
        400,
      );
      assert.equal(
        (await api(peerPath + '/notes')).status,
        200,
        'failed passkey proof leaves the active profile usable',
      );
      const login = page.getByRole('dialog', {
        name: 'Open Fictional Passkey Robin',
        exact: true,
      });
      await page.getByRole('button', { name: 'Choose profile', exact: true }).click();
      await page.getByRole('button', { name: /^Fictional Passkey Robin\s*Locked/ }).click();
      await page.waitForFunction(() => typeof window.releaseConfirmation === 'function');
      assert.deepEqual(
        await page.evaluate(() => window.passkeyCalls),
        { create: 0, get: 1 },
        'opening the profile starts exactly one sign-in',
      );
      assert.equal(
        await login.getByRole('button', { name: 'Use recovery key', exact: true }).isEnabled(),
        true,
      );
      await login.getByText('Approve in your password manager.', { exact: true }).waitFor();
      assert.equal(await login.getByLabel('Recovery key', { exact: true }).count(), 0);
      assert.equal(await login.locator('form').count(), 0);
      assert.equal(
        await login.getByRole('button', { name: /^(Use passkey|Try passkey again)$/ }).count(),
        0,
        'waiting shows no retry button, including disabled retries',
      );
      await capture('automatic-unlock');
      await page.evaluate(() => window.releaseConfirmation!());
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(
        (await api('/api/profiles')).value.data.find(
          (item: { id: string }) => item.id === profile.id,
        ).locked,
        false,
      );
      assert.equal(
        (await api(peerPath + '/notes')).status,
        423,
        'successful passkey unlock locks the other profile',
      );
      assert(
        (await api(path + '/notes')).value.data.some(
          (note: Note) => note.title === 'Annual Planning',
        ),
      );

      async function addFromActions() {
        const manager = page.getByRole('dialog', { name: 'Manage passkeys', exact: true });
        if (!(await manager.isVisible())) {
          await page.locator('.profile-current').click();
          await page.getByRole('button', { name: 'Manage passkeys', exact: true }).click();
        }
        await manager.getByRole('button', { name: 'Add another passkey', exact: true }).click();
      }
      // Adding another key needs another authenticator: the original credential is
      // deliberately excluded by WebAuthn registration options.
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
      ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: virtualOptions,
      }));
      await page.evaluate(() => {
        window.pauseConfirmation = true;
        window.releaseConfirmation = undefined;
      });
      await addFromActions();
      await page.waitForFunction(() => typeof window.releaseConfirmation === 'function');
      await dialog.getByRole('button', { name: 'Skip', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(savedRequests.length, 1, 'Skip cannot publish a second key');
      const saved = (await api(path + '/passkeys/authentication-options', {})).value.data.options
        .allowCredentials;
      assert.equal(saved.length, 1);

      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
      ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: { ...virtualOptions, hasPrf: false },
      }));
      await page.evaluate(() => {
        window.pauseConfirmation = false;
      });
      await addFromActions();
      await dialog.getByRole('alert').waitFor();
      assert.equal(savedRequests.length, 1, 'A credential without PRF cannot be saved as usable');
      assert.equal(
        (await api(path + '/passkeys/authentication-options', {})).value.data.options
          .allowCredentials.length,
        1,
      );
      await dialog.getByRole('button', { name: 'Skip', exact: true }).click();
      await api(path + '/lock', {});
      await page.reload();
      await page.getByRole('button', { name: 'Choose profile', exact: true }).click();
      await page.getByRole('button', { name: /^Fictional Passkey Robin\s*Locked/ }).click();
      await page.waitForFunction(() => typeof window.releaseConfirmation === 'function');
      const cancelled = page.waitForResponse((response) =>
        response.url().endsWith('/passkeys/cancel'),
      );
      await login.getByRole('button', { name: 'Use recovery key', exact: true }).click();
      assert.equal((await cancelled).status(), 200);
      assert.equal((await api('/api/profiles')).value.data[0].locked, true);
      const recoveryInput = login.getByLabel('Recovery key', { exact: true });
      await login.locator('input[name="password"]:focus').waitFor();
      assert.equal(await recoveryInput.inputValue(), '');
      assert.equal(
        await login.locator('input[name="username"]').inputValue(),
        'Fictional Passkey Robin',
      );
      assert.equal(await recoveryInput.getAttribute('type'), 'password');
      assert.equal(await recoveryInput.getAttribute('autocomplete'), 'current-password');
      assert.equal(await login.locator('form').getAttribute('method'), 'post');
      assert.equal(
        await login.getByText('Approve in your password manager.', { exact: true }).count(),
        0,
      );
      await capture('recovery-fallback');
      assert.deepEqual(
        await page.evaluate(() => window.passkeyCalls),
        { create: 0, get: 1 },
        'recovery mode does not restart the cancelled sign-in',
      );
      await page.evaluate(() => {
        window.failAuthenticationOnce = true;
      });
      await login.getByRole('button', { name: 'Use passkey instead', exact: true }).click();
      await login.getByRole('alert').waitFor();
      await login.getByRole('button', { name: 'Try passkey again', exact: true }).waitFor();
      assert.equal(await recoveryInput.count(), 0);
      assert.deepEqual(
        await page.evaluate(() => window.passkeyCalls),
        { create: 0, get: 2 },
        'Use passkey instead starts one explicit attempt without a second click or automatic retry',
      );
      await login.getByRole('button', { name: 'Use recovery key', exact: true }).click();
      await login.locator('input[name="password"]:focus').waitFor();
      await login.getByLabel('Recovery key', { exact: true }).fill(recovery);
      await login.getByRole('button', { name: 'Open profile', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Recovery unlocked', exact: true })
        .getByRole('button', { name: 'Skip', exact: true })
        .click();
      assert.equal((await api('/api/profiles')).value.data[0].locked, false);
      assert.deepEqual(
        await page.evaluate(() => window.passkeyCalls),
        { create: 0, get: 2 },
        'recovery does not restart the cancelled sign-in',
      );
      // Multiple confirmed keys remain independently manageable, with usage only
      // after successful activation (enrollment confirmation is not profile use).
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
      ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: virtualOptions,
      }));
      await page.evaluate(() => {
        window.pauseConfirmation = false;
      });
      await addFromActions();
      const manager = page.getByRole('dialog', { name: 'Manage passkeys', exact: true });
      await manager.waitFor();
      await manager.getByRole('button', { name: 'Remove Passkey 2', exact: true }).waitFor();
      const keys = (await api(path + '/passkeys')).value.data;
      assert.equal(keys.length, 2);
      assert(keys[0].lastUsedAt, 'successful earlier profile unlock records use');
      assert.equal(keys[1].lastUsedAt, null, 'confirmation alone is not profile use');
      assert.equal(await manager.getByText('No recorded use', { exact: true }).count(), 1);
      assert.deepEqual(Object.keys(keys[0]).sort(), [
        'createdAt',
        'id',
        'label',
        'lastUsedAt',
        'rpID',
      ]);
      await manager.getByRole('button', { name: 'Rename Passkey', exact: true }).click();
      const nameInput = manager.getByLabel('Passkey name', { exact: true });
      assert.equal(
        await manager.getByRole('button', { name: 'Save name', exact: true }).isEnabled(),
        false,
      );
      await nameInput.fill('1Password');
      await capture('rename-passkey');
      await nameInput.press('Enter');
      await manager.getByRole('button', { name: 'Rename 1Password', exact: true }).waitFor();
      await manager.getByRole('button', { name: 'Rename 1Password', exact: true }).click();
      assert.equal(
        await manager.getByRole('button', { name: 'Save name', exact: true }).isEnabled(),
        false,
      );
      await nameInput.fill('Unused draft');
      await nameInput.press('Escape');
      await manager.getByRole('button', { name: 'Rename 1Password', exact: true }).waitFor();
      await manager.getByRole('button', { name: 'Rename Passkey 2', exact: true }).click();
      await nameInput.fill('Hardware key');
      await manager.getByRole('button', { name: 'Save name', exact: true }).click();
      await manager.getByRole('button', { name: 'Rename Hardware key', exact: true }).waitFor();
      assert.deepEqual(
        (await api(path + '/passkeys')).value.data.map(
          (key: { id: string; label: string }) => key.label,
        ),
        ['1Password', 'Hardware key'],
      );
      const publicProfiles = JSON.stringify((await api('/api/profiles')).value);
      assert(!publicProfiles.includes('1Password') && !publicProfiles.includes('Hardware key'));
      await stop();
      await start();
      await page.reload();
      await page.getByRole('button', { name: 'Choose profile', exact: true }).click();
      await page.getByRole('button', { name: /^Fictional Passkey Robin\s*Locked/ }).click();
      await page.waitForFunction(() => typeof window.releaseConfirmation === 'function');
      await page.evaluate(() => window.releaseConfirmation!());
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.locator('.profile-current').click();
      await page.getByRole('button', { name: 'Manage passkeys', exact: true }).click();
      await manager.getByRole('button', { name: 'Rename Hardware key', exact: true }).waitFor();
      assert.deepEqual(
        (await api(path + '/passkeys')).value.data.map(
          (key: { id: string; label: string }) => key.label,
        ),
        ['1Password', 'Hardware key'],
        'names survive runtime/container recreation and passkey authentication',
      );
      await capture('manage-passkeys');
      await manager.getByRole('button', { name: 'Remove 1Password', exact: true }).click();
      const removal = page.getByRole('dialog', { name: 'Remove passkey', exact: true });
      await removal.getByText('1Password', { exact: true }).waitFor();
      await removal.getByRole('button', { name: 'Back to passkeys', exact: true }).click();
      assert.equal((await api(path + '/passkeys')).value.data.length, 2);
      await manager.getByRole('button', { name: 'Remove 1Password', exact: true }).click();
      await capture('remove-passkey');
      await removal.getByRole('button', { name: 'Remove passkey', exact: true }).click();
      await manager.waitFor();
      const remaining = (await api(path + '/passkeys')).value.data;
      assert.deepEqual(
        remaining.map((key: { id: string; label: string }) => key.id),
        [keys[1].id],
      );
      assert.equal(remaining[0].label, 'Hardware key');
      await manager.getByRole('button', { name: 'Back to profiles', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Add passkey', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Manage passkeys', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Lock profile', exact: true }).click();
      assert.equal(
        (await api(path + '/passkeys')).status,
        423,
        'key metadata is private while locked',
      );
      await page.reload();
      await page.getByRole('button', { name: 'Choose profile', exact: true }).click();
      await page.getByRole('button', { name: /^Fictional Passkey Robin\s*Locked/ }).click();
      await page.waitForFunction(() => typeof window.releaseConfirmation === 'function');
      await page.evaluate(() => window.releaseConfirmation!());
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert(
        (await api(path + '/passkeys')).value.data[0].lastUsedAt,
        'second key independently unlocks after first was removed',
      );
      assert.deepEqual(errors, []);
    },
  );
