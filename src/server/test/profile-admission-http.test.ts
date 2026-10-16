import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createVaultApp } from '../vault-app.ts';
import { createProfilePasskeys } from '../profile-passkeys.ts';
import { deferred, newProfile } from './helpers/vault-fixture.ts';

const credential = {
  id: 'ZmljdGlvbmFs',
  publicKey: new Uint8Array([1, 2, 3]),
  counter: 0,
  transports: ['internal'],
};
const verification = {
  async verifyRegistrationResponse() {
    return { verified: true, registrationInfo: { credential } };
  },
  async verifyAuthenticationResponse() {
    return { verified: true, authenticationInfo: { newCounter: 2 } };
  },
};

for (const kind of ['setup', 'passkey'] as const)
  for (const outcome of ['late-success', 'expired-entry', 'disconnect', 'queue-failure'] as const)
    test(`HTTP ${kind} ${outcome} retains admission across the real activation queue`, async (t) => {
      const base = mkdtempSync(resolve(tmpdir(), 'circus-admission-http-'));
      mkdirSync(resolve(base, 'data'));
      let verifierCalls = 0;
      const app = createVaultApp({
        dataDirectory: resolve(base, 'data'),
        runtimeDirectory: resolve(base, 'runtime'),
        passkeyVerification: {
          ...verification,
          async verifyAuthenticationResponse() {
            verifierCalls++;
            return verification.verifyAuthenticationResponse();
          },
        },
      });
      await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
      t.after(() => {
        app.close();
        rmSync(base, { recursive: true, force: true });
      });
      const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
        origin = 'http://localhost:5173';
      let cookie = '';
      async function post(path: string, body: unknown, signal?: AbortSignal) {
        const response = await fetch(url + path, {
          method: 'POST',
          headers: {
            Origin: origin,
            Cookie: cookie,
            'Content-Type': 'application/json',
            Connection: 'close',
          },
          body: JSON.stringify(body),
          signal,
        });
        if (response.headers.get('set-cookie'))
          cookie = response.headers.get('set-cookie')!.split(';')[0]!;
        return { status: response.status, ...(await response.json()) };
      }
      const previous = await newProfile(app.manager, 'Fictional queue predecessor');
      const target =
        kind === 'setup'
          ? app.manager.begin({
              name: 'Fictional HTTP queued setup',
              fullName: 'Fictional HTTP queued setup',
              birthDate: '1982-04-17',
            })
          : await newProfile(app.manager, 'Fictional HTTP passkey target');
      const prf = randomBytes(32).toString('base64url');
      if (kind === 'passkey') {
        const passkeys = createProfilePasskeys(app.manager, verification);
        const registration = await passkeys.registrationOptions(
          target.profileId,
          'fictional-enrollment-session',
          origin,
        );
        const confirmation = await passkeys.register(
          target.profileId,
          'fictional-enrollment-session',
          { challengeId: registration.challengeId, response: { id: credential.id } },
        );
        await passkeys.confirm(target.profileId, 'fictional-enrollment-session', {
          challengeId: confirmation.challengeId,
          response: { id: credential.id },
          prf,
        });
      }
      assert.equal(
        (
          await post(`/api/profiles/${previous.profileId}/unlock`, {
            recovery: previous.recoveryKit,
          })
        ).status,
        200,
      );
      const authentication =
        kind === 'passkey'
          ? (await post(`/api/profiles/${target.profileId}/passkeys/authentication-options`, {}))
              .data
          : undefined;
      const now = Date.now;
      let elapsed = 0;
      t.mock.method(Date, 'now', () => now() + elapsed);
      const entered = deferred(),
        gate = deferred(),
        admitted = deferred(),
        disconnected = deferred();
      const unlock = app.manager.unlockAsync;
      t.mock.method(app.manager, 'unlockAsync', async (...args: Parameters<typeof unlock>) => {
        entered.resolve();
        await gate.promise;
        if (outcome === 'queue-failure') throw Error('Fictional predecessor refusal');
        return unlock(...args);
      });
      t.after(() => gate.resolve());
      const predecessor = post(`/api/profiles/${previous.profileId}/unlock`, {
        recovery: previous.recoveryKit,
      });
      predecessor.catch(() => {});
      await entered.promise;
      if (kind === 'setup') {
        const admit = app.manager.admitSetup;
        t.mock.method(app.manager, 'admitSetup', (...args: Parameters<typeof admit>) => {
          const claim = admit(...args);
          args[2]?.signal?.addEventListener('abort', () => disconnected.resolve(), { once: true });
          admitted.resolve();
          return claim;
        });
      } else {
        const admit = app.manager.admitPasskeyAuthentication;
        t.mock.method(
          app.manager,
          'admitPasskeyAuthentication',
          (...args: Parameters<typeof admit>) => {
            const claim = admit(...args);
            args[1]?.addEventListener('abort', () => disconnected.resolve(), { once: true });
            admitted.resolve();
            return claim;
          },
        );
      }
      const input =
        kind === 'setup'
          ? { acknowledged: true, recovery: target.recoveryKit }
          : { challengeId: authentication.challengeId, response: { id: credential.id }, prf };
      const path =
        kind === 'setup'
          ? `/api/profile-setups/${target.setupId}/verify`
          : `/api/profiles/${target.profileId}/passkeys/authenticate`;
      const controller = new AbortController();
      if (outcome === 'expired-entry') elapsed = 31 * 60 * 1000;
      const pending = post(path, input, controller.signal);
      pending.catch(() => {});
      if (outcome === 'expired-entry') {
        const response = await pending;
        assert.equal(response.error.code, kind === 'setup' ? 'SETUP_EXPIRED' : 'PASSKEY_CHALLENGE');
        assert.equal(verifierCalls, 0);
        gate.resolve();
        await predecessor;
        assert.equal(app.manager.opened.has(target.profileId), false);
        return;
      }
      await admitted.promise;
      elapsed = 31 * 60 * 1000;
      assert.equal(verifierCalls, 0, 'queued work has not verified or unwrapped its key');
      if (outcome === 'disconnect') {
        controller.abort();
        await assert.rejects(pending);
        await disconnected.promise;
      }
      gate.resolve();
      assert.equal((await predecessor).status, outcome === 'queue-failure' ? 500 : 200);
      if (outcome !== 'disconnect') {
        const response = await pending;
        assert.equal(response.status, kind === 'setup' ? 201 : 200);
        assert.equal(app.manager.opened.has(target.profileId), true);
        assert.equal(
          (
            await fetch(url + `/api/profiles/${target.profileId}/notes/patient`, {
              headers: { Cookie: cookie },
            })
          ).status,
          200,
        );
      } else {
        // A following activation waits for the abandoned queued operation to drain.
        t.mock.method(app.manager, 'unlockAsync', unlock);
        assert.equal(
          (
            await post(`/api/profiles/${previous.profileId}/unlock`, {
              recovery: previous.recoveryKit,
            })
          ).status,
          200,
        );
        assert.equal(app.manager.opened.has(target.profileId), false);
        assert.equal(verifierCalls, 0);
      }
    });
