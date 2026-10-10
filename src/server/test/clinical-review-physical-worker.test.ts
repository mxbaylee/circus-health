import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  beginManagedPhysicalMutation,
  captureManagedPhysicalEpoch,
  captureManagedPhysicalScope,
  managedPhysicalEpochCurrent,
  managedPhysicalScopeCurrent,
  withManagedPhysicalMutation,
} from '../clinical-review-physical-epoch.ts';
import {
  ClinicalPhysicalEvidenceChanged,
  clinicalPhysicalVerificationPages,
  openClinicalPhysicalVerifier,
  type ClinicalPhysicalItem,
} from '../clinical-review-physical-worker.ts';
import { intakeFileIdentity } from '../intake-files.ts';
import { regularFileIdentity } from '../regular-file-identity.ts';

test('physical file identity leaf preserves exact host identity and non-file refusal', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-physical-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'original');
  writeFileSync(path, 'fictional original');
  const stat = statSync(path, { bigint: true }),
    expected = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  assert.equal(regularFileIdentity(path), expected);
  assert.equal(intakeFileIdentity(path), expected);
  assert.equal(regularFileIdentity(root), undefined);
  assert.throws(intakeFileIdentity.bind(null, root), {
    status: 409,
    code: 'SOURCE_CHANGED',
    message: 'Retained original is not a regular file',
  });
  assert.throws(() => regularFileIdentity(join(root, 'missing')), { code: 'ENOENT' });
});

test('physical proof worker loads only its filesystem identity leaf', async (t) => {
  const entry = new URL('../clinical-review-physical-worker-thread.ts', import.meta.url),
    leaf = new URL('../regular-file-identity.ts', import.meta.url),
    worker = new Worker(
      `const { registerHooks } = require('node:module');
       const { parentPort, workerData } = require('node:worker_threads');
       const imports = [];
       registerHooks({ load(url, context, nextLoad) {
         if (url.startsWith('file:')) imports.push(url);
         return nextLoad(url, context);
       } });
       import(workerData).then(() => parentPort.postMessage({ imports }));`,
      { eval: true, workerData: entry.href },
    );
  t.after(() => worker.terminate());
  const exit = new Promise<number>((resolve) => worker.once('exit', resolve));
  const imports = await new Promise<string[]>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (message) => {
      if (Array.isArray(message.imports)) resolve(message.imports);
    });
  });
  assert.deepEqual(imports.sort(), [entry.href, leaf.href].sort());
  worker.postMessage({ type: 'close', id: 1 });
  assert.equal(await exit, 0);
});

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
      (error) => error instanceof ClinicalPhysicalEvidenceChanged,
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
      (error) =>
        error instanceof Error &&
        !(error instanceof ClinicalPhysicalEvidenceChanged) &&
        /physical evidence changed/.test(error.message),
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

test('scoped physical witnesses ignore disjoint paths and refuse aliases, ancestors and unknown writes', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'fictional-physical-scope-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const selected = join(base, 'selected');
  const other = join(base, 'other');
  mkdirSync(selected);
  mkdirSync(other);
  symlinkSync(selected, join(base, 'alias'));
  const first = captureManagedPhysicalScope(selected);
  assert.ok(first);
  const active = beginManagedPhysicalMutation([join(other, 'source')]);
  assert.equal(managedPhysicalScopeCurrent(first), false);
  active();
  assert.equal(managedPhysicalScopeCurrent(first), true);
  withManagedPhysicalMutation(() => {}, [join(base, 'alias', 'source')]);
  assert.equal(managedPhysicalScopeCurrent(first), false);
  const second = captureManagedPhysicalScope(selected);
  assert.ok(second);
  withManagedPhysicalMutation(() => {}, [base]);
  assert.equal(managedPhysicalScopeCurrent(second), false);
  const third = captureManagedPhysicalScope(selected);
  assert.ok(third);
  withManagedPhysicalMutation(() => {});
  assert.equal(managedPhysicalScopeCurrent(third), false);
  const sameByte = join(selected, 'source');
  writeFileSync(sameByte, 'fictional');
  const fourth = captureManagedPhysicalScope(selected);
  assert.ok(fourth);
  withManagedPhysicalMutation(() => writeFileSync(sameByte, 'fictional'), [sameByte]);
  assert.equal(managedPhysicalScopeCurrent(fourth), false);
  const fifth = captureManagedPhysicalScope(selected);
  assert.ok(fifth);
  withManagedPhysicalMutation(
    () => {},
    Array.from({ length: 5 }, (_, index) => join(other, String(index))),
  );
  assert.equal(managedPhysicalScopeCurrent(fifth), false);
  const sixth = captureManagedPhysicalScope(selected);
  assert.ok(sixth);
  withManagedPhysicalMutation(() => {}, [parse(selected).root]);
  assert.equal(managedPhysicalScopeCurrent(sixth), false);
  const seventh = captureManagedPhysicalScope(selected);
  assert.ok(seventh);
  withManagedPhysicalMutation(() => {}, [join(other, 'x'.repeat(4096))]);
  assert.equal(managedPhysicalScopeCurrent(seventh), false);
  assert.equal(managedPhysicalScopeCurrent({}), false);
});

test('scoped physical witness refuses stale event history without retaining every write', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'fictional-physical-overflow-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const selected = join(base, 'selected');
  const other = join(base, 'other');
  mkdirSync(selected);
  mkdirSync(other);
  const witness = captureManagedPhysicalScope(selected);
  assert.ok(witness);
  for (let index = 0; index < 1025; index++)
    withManagedPhysicalMutation(() => {}, [join(other, String(index))]);
  assert.equal(managedPhysicalScopeCurrent(witness), false);
  const fresh = captureManagedPhysicalScope(selected);
  assert.ok(fresh);
  assert.equal(managedPhysicalScopeCurrent(fresh), true);
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
