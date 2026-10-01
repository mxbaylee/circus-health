import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIRequestContext } from 'playwright';
import {
  lockOwnedPasskeyProfile,
  physicalPasskeyConfiguration,
  physicalPasskeyPassed,
} from './qualify-physical-passkey.ts';

test('physical qualification rejects insecure, normalized, unapproved and unsupported-browser targets', (t) => {
  const output = mkdtempSync(join(tmpdir(), 'fictional-passkey-receipt-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const valid = {
    CRS_PHYSICAL_PASSKEY_QUALIFICATION: '1',
    CRS_QUALIFICATION_ORIGIN: 'https://fictional.example.test',
    CRS_QUALIFICATION_OUTPUT_DIR: output,
  };
  assert.equal(physicalPasskeyConfiguration(valid).channel, 'chrome');
  for (const origin of [
    'http://localhost:3001',
    'http://fictional.example.test',
    'https://fictional.example.test/path',
    'https://fictional.example.test/',
    'https://user:password@fictional.example.test',
  ])
    assert.throws(() =>
      physicalPasskeyConfiguration({ ...valid, CRS_QUALIFICATION_ORIGIN: origin }),
    );
  assert.throws(() =>
    physicalPasskeyConfiguration({ ...valid, CRS_PHYSICAL_PASSKEY_QUALIFICATION: undefined }),
  );
  assert.throws(() =>
    physicalPasskeyConfiguration({ ...valid, CRS_QUALIFICATION_BROWSER: 'webkit' }),
  );
  assert.throws(() =>
    physicalPasskeyConfiguration({ ...valid, CRS_QUALIFICATION_OUTPUT_DIR: process.cwd() }),
  );
});

test('a receipt cannot pass with enrollment alone, missing unlocks or missing recovery', () => {
  assert.equal(
    physicalPasskeyPassed(
      {
        confirmedEnrollment: true,
        successfulUnlocks: 3,
        recoveryFallback: true,
      },
      true,
    ),
    true,
  );
  assert.equal(
    physicalPasskeyPassed(
      { confirmedEnrollment: true, successfulUnlocks: 3, recoveryFallback: true },
      false,
    ),
    false,
  );
  for (const progress of [
    { confirmedEnrollment: false, successfulUnlocks: 3, recoveryFallback: true },
    { confirmedEnrollment: true, successfulUnlocks: 2, recoveryFallback: true },
    { confirmedEnrollment: true, successfulUnlocks: 3, recoveryFallback: false },
  ])
    assert.equal(physicalPasskeyPassed(progress, true), false);
});

test('failed journey locks only its exact generated profile, including before ID capture', async () => {
  const calls: string[] = [];
  let locked = false;
  const request = {
    async get(url: string) {
      calls.push(url);
      return {
        ok: () => true,
        json: async () => ({
          data: [
            { id: 'other', name: 'Other Person', locked: false },
            { id: 'owned', name: 'Fictional Passkey Person abcdef12', locked },
          ],
        }),
      };
    },
    async post(url: string) {
      calls.push(url);
      locked = true;
      return { ok: () => true };
    },
  } as unknown as APIRequestContext;
  assert.equal(
    await lockOwnedPasskeyProfile(
      request,
      'https://fictional.example.test',
      undefined,
      'Fictional Passkey Person abcdef12',
    ),
    true,
  );
  assert.ok(calls.includes('https://fictional.example.test/api/profiles/owned/lock'));
  calls.length = 0;
  assert.equal(
    await lockOwnedPasskeyProfile(request, 'https://fictional.example.test', undefined, 'Unknown'),
    false,
  );
  assert.equal(
    calls.some((url) => url.endsWith('/lock')),
    false,
  );
});
