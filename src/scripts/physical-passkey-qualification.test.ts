import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { physicalPasskeyConfiguration, physicalPasskeyPassed } from './qualify-physical-passkey.ts';

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
