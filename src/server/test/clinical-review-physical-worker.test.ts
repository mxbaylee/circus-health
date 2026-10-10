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
import {
  clinicalPhysicalVerificationPages,
  openClinicalPhysicalVerifier,
  type ClinicalPhysicalItem,
} from '../clinical-review-physical-worker.ts';
import { intakeFileIdentity } from '../intake-files.ts';

test('physical transport splits escaped fields without losing or rebinding items', () => {
  const items: ClinicalPhysicalItem[] = Array.from({ length: 64 }, (_, index) => ({
    kind: 'identity',
    path: '/' + '\u0001'.repeat(4000) + index,
    expectedIdentity: '\u0002'.repeat(4096),
  }));
  const pages = clinicalPhysicalVerificationPages(items);
  assert.ok(pages.length > 1);
  assert.deepEqual(pages.flat(), items);
  for (const page of pages) {
    assert.ok(page.length > 0 && page.length <= 64);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512 * 1024);
  }
  const originalPath = pages[0]![0]!.path;
  items[0]!.path = '/fictional-replacement';
  assert.equal(pages[0]![0]!.path, originalPath);
  const marker: ClinicalPhysicalItem = {
    kind: 'marker',
    path: '/fictional-marker',
    expected: { sha256: 'a'.repeat(64), bytes: 12 },
  };
  const retained = clinicalPhysicalVerificationPages([marker]);
  marker.expected = 'absent';
  assert.deepEqual(retained[0]![0], {
    kind: 'marker',
    path: '/fictional-marker',
    expected: { sha256: 'a'.repeat(64), bytes: 12 },
  });
  assert.throws(() => clinicalPhysicalVerificationPages([]), /physical evidence changed/);
  assert.throws(
    () => clinicalPhysicalVerificationPages([...items, items[0]!]),
    /physical evidence changed/,
  );
  assert.throws(
    () => clinicalPhysicalVerificationPages([{ ...items[0]!, path: '/' + 'x'.repeat(4096) }]),
    /physical evidence changed/,
  );
});

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

test('physical worker drains cancellation during module startup before rejecting', async () => {
  const controller = new AbortController();
  const opening = openClinicalPhysicalVerifier(controller.signal);
  const reason = new DOMException('Fictional startup cancellation', 'AbortError');
  controller.abort(reason);
  await assert.rejects(opening, (error) => error === reason);
  const verifier = await openClinicalPhysicalVerifier();
  await verifier.close();
});
