import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  beginManagedPhysicalMutation,
  captureManagedPhysicalEpoch,
  managedPhysicalEpochCurrent,
  withManagedPhysicalMutation,
} from '../clinical-review-physical-epoch.ts';
import { openClinicalPhysicalVerifier } from '../clinical-review-physical-worker.ts';
import { intakeFileIdentity } from '../intake-files.ts';

test('physical worker checks bounded original, marker, directory and absence pages', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-physical-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = join(root, 'fictional-original.txt');
  const marker = join(root, 'current');
  writeFileSync(original, 'fictional original');
  writeFileSync(marker, 'fictional marker');
  const directory = statSync(root, { bigint: true });
  const verifier = await openClinicalPhysicalVerifier();
  try {
    await verifier.verifyPage([
      { kind: 'identity', path: original, expectedIdentity: intakeFileIdentity(original) },
      {
        kind: 'marker',
        path: marker,
        expected: {
          sha256: createHash('sha256').update('fictional marker').digest('hex'),
          bytes: Buffer.byteLength('fictional marker'),
        },
      },
      {
        kind: 'directory',
        path: root,
        expectedIdentity: [directory.dev, directory.ino, directory.mtimeNs, directory.ctimeNs].join(
          ':',
        ),
      },
      { kind: 'marker', path: join(root, 'missing-marker'), expected: 'absent' },
      { kind: 'directory', path: join(root, 'missing-directory'), expectedIdentity: 'absent' },
    ]);
    await verifier.close();
  } finally {
    await verifier.abort();
  }
});

test('physical worker refuses replacement and oversized transport', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-physical-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = join(root, 'fictional-original.txt');
  writeFileSync(original, 'fictional original');
  const identity = intakeFileIdentity(original);
  const verifier = await openClinicalPhysicalVerifier();
  try {
    writeFileSync(original, 'different fictional original');
    await assert.rejects(
      verifier.verifyPage([{ kind: 'identity', path: original, expectedIdentity: identity }]),
      /physical evidence changed/,
    );
  } finally {
    await verifier.abort();
  }
  const second = await openClinicalPhysicalVerifier();
  try {
    await assert.rejects(
      second.verifyPage(
        Array.from({ length: 65 }, () => ({
          kind: 'identity' as const,
          path: original,
          expectedIdentity: identity,
        })),
      ),
      /physical evidence changed/,
    );
  } finally {
    await second.abort();
  }
});

test('managed physical epoch refuses in-flight, completed and failed attempts', () => {
  const first = captureManagedPhysicalEpoch();
  assert.ok(first);
  const finish = beginManagedPhysicalMutation();
  assert.equal(captureManagedPhysicalEpoch(), undefined);
  assert.equal(managedPhysicalEpochCurrent(first), false);
  finish();
  finish();
  const second = captureManagedPhysicalEpoch();
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(managedPhysicalEpochCurrent(second), true);
  withManagedPhysicalMutation(() => {
    assert.equal(captureManagedPhysicalEpoch(), undefined);
  });
  assert.equal(managedPhysicalEpochCurrent(second), false);
  const third = captureManagedPhysicalEpoch();
  assert.ok(third);
  assert.throws(() =>
    withManagedPhysicalMutation(() => {
      throw Error('fictional failure');
    }),
  );
  assert.equal(managedPhysicalEpochCurrent(third), false);
  assert.ok(captureManagedPhysicalEpoch());
});

test('physical worker preserves its caller abort reason and drains', async () => {
  const controller = new AbortController();
  const verifier = await openClinicalPhysicalVerifier(controller.signal);
  const reason = new DOMException('Fictional cancellation', 'AbortError');
  controller.abort(reason);
  await assert.rejects(
    verifier.verifyPage([{ kind: 'identity', path: '/fictional/source', expectedIdentity: 'x' }]),
    (error) => error === reason,
  );
  await verifier.abort();
});
