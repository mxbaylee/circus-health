import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureManagedPhysicalScope,
  managedPhysicalScopeCurrent,
  retainManagedPhysicalScope,
  withManagedPhysicalMutation,
} from '../clinical-review-physical-epoch.ts';

test('retained original physical scope accounts for disjoint events beyond ring capacity', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-retained-physical-scope-')),
    source = join(root, 'source'),
    target = join(root, 'target');
  mkdirSync(source);
  mkdirSync(target);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = captureManagedPhysicalScope(source)!,
    unretained = captureManagedPhysicalScope(source)!,
    release = retainManagedPhysicalScope(original);
  try {
    for (let index = 0; index < 1100; index++)
      withManagedPhysicalMutation(() => {}, [join(target, String(index))]);
    assert.equal(managedPhysicalScopeCurrent(original), true);
    assert.equal(managedPhysicalScopeCurrent(unretained), false);
    withManagedPhysicalMutation(() => {}, [join(source, 'changed')]);
    assert.equal(managedPhysicalScopeCurrent(original), false);
    for (let index = 0; index < 1100; index++)
      withManagedPhysicalMutation(() => {}, [join(target, String(index))]);
    assert.equal(managedPhysicalScopeCurrent(original), false);
  } finally {
    release();
    release();
  }
  assert.equal(managedPhysicalScopeCurrent(original), false);
  assert.throws(() => retainManagedPhysicalScope(original), /changed/);
});

test('retained original physical scope permanently refuses unknown events', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-retained-unknown-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = captureManagedPhysicalScope(root)!,
    release = retainManagedPhysicalScope(original);
  try {
    withManagedPhysicalMutation(() => {});
    assert.equal(managedPhysicalScopeCurrent(original), false);
    assert.throws(() => retainManagedPhysicalScope(original), /changed/);
  } finally {
    release();
  }
  assert.equal(managedPhysicalScopeCurrent(original), false);
});

test('multiple retainers preserve one original scope and active writers still refuse', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-shared-retained-scope-')),
    source = join(root, 'source'),
    target = join(root, 'target');
  mkdirSync(source);
  mkdirSync(target);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = captureManagedPhysicalScope(source)!,
    first = retainManagedPhysicalScope(original),
    second = retainManagedPhysicalScope(original);
  try {
    first();
    for (let index = 0; index < 1100; index++)
      withManagedPhysicalMutation(() => {}, [join(target, String(index))]);
    assert.equal(managedPhysicalScopeCurrent(original), true);
    withManagedPhysicalMutation(() => {
      assert.equal(managedPhysicalScopeCurrent(original), false);
      withManagedPhysicalMutation(() => {
        assert.equal(managedPhysicalScopeCurrent(original), false);
      }, [join(target, 'nested')]);
      assert.equal(managedPhysicalScopeCurrent(original), false);
    }, [join(target, 'active')]);
    assert.equal(managedPhysicalScopeCurrent(original), true);
  } finally {
    first();
    second();
  }
  assert.equal(managedPhysicalScopeCurrent(original), false);
});

test('retained scope registrations are bounded and independently released', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-retained-scope-capacity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const releases: Array<() => void> = [];
  try {
    for (let index = 0; index < 64; index++)
      releases.push(retainManagedPhysicalScope(captureManagedPhysicalScope(root)!));
    assert.throws(
      () => retainManagedPhysicalScope(captureManagedPhysicalScope(root)!),
      /capacity exhausted/,
    );
    releases.pop()!();
    const replacement = retainManagedPhysicalScope(captureManagedPhysicalScope(root)!);
    replacement();
  } finally {
    for (const release of releases) release();
  }
  const fresh = captureManagedPhysicalScope(root)!,
    release = retainManagedPhysicalScope(fresh);
  assert.equal(managedPhysicalScopeCurrent(fresh), true);
  release();
  release();
  assert.equal(managedPhysicalScopeCurrent(fresh), true);
});
