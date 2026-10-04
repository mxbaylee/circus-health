import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIntakeTree,
  decodeIntakeTreeNode,
  type IntakeTreeNode,
  type IntakeTreeRoot,
} from '../intake-state-tree.ts';

const identity = {
  profileId: 'fictional-tree',
  intakeId: 'fictional-original',
  sourceHash: '3'.repeat(64),
};
test('authenticated page trees preserve sorted exact keys through rotations, deletion and cold range reads', () => {
  const persisted = new Map<string, string>();
  const cache = new Map<string, { raw: string; node: IntakeTreeNode }>();
  let root: IntakeTreeRoot = null;
  const expected = new Map<string, string>();
  let state = 12345;
  for (let batch = 0; batch < 12; batch++) {
    const pages = createIntakeTree(identity, (key) => persisted.get(key), cache);
    for (let index = 0; index < 32; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const key = String(state % 180).padStart(4, '0');
      const value = state % 5 ? `fictional-${state}` : null;
      root = pages.put(root, key, value);
      if (value === null) expected.delete(key);
      else expected.set(key, value);
    }
    for (const page of pages.writes([root])) {
      decodeIntakeTreeNode(page.raw, page.ref, identity);
      persisted.set(page.hash, page.raw);
    }
    cache.clear();
    let reads = 0;
    const cold = createIntakeTree(
      identity,
      (key) => {
        reads++;
        return persisted.get(key);
      },
      cache,
    );
    assert.deepEqual(
      [...cold.entries(root)],
      [...expected].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value })),
    );
    assert.deepEqual(
      [...cold.entries(root, '0090')],
      [...expected]
        .filter(([key]) => key > '0090')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ key, value })),
    );
    assert.equal(root?.count ?? 0, expected.size);
    assert.ok((root?.height ?? 0) < 16);
    for (const boundary of ['', '0000', '0090', '0150', '9999']) {
      reads = 0;
      assert.equal(
        cold.rank(root, boundary),
        [...expected.keys()].filter((key) => key < boundary).length,
      );
      assert.ok(reads <= (root?.height ?? 0));
      cache.clear();
      reads = 0;
      const preceding = [...expected]
        .filter(([key]) => key < boundary)
        .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))[0];
      assert.deepEqual(
        cold.preceding(root, boundary),
        preceding ? { key: preceding[0], value: preceding[1] } : undefined,
      );
      assert.ok(reads <= (root?.height ?? 0));
    }
  }
  assert.ok(root);
  const pages = createIntakeTree(identity, (key) => persisted.get(key), cache);
  assert.throws(() => pages.load({ ...root!, count: root!.count + 1 }), /reference/);
  const foreign = createIntakeTree(
    { ...identity, profileId: 'different' },
    (key) => persisted.get(key),
    new Map(),
  );
  assert.throws(() => foreign.load(root!), /source binding/);
  const sharedCacheForeign = createIntakeTree(
    { ...identity, profileId: 'different' },
    (key) => persisted.get(key),
    cache,
  );
  assert.throws(() => sharedCacheForeign.load(root!), /source binding/);
  const corrupted = createIntakeTree(
    identity,
    (key) => (key === root!.hash ? '{}' : persisted.get(key)),
    new Map(),
  );
  assert.throws(() => corrupted.get(root, '0090'), /schema/);
  assert.throws(() => corrupted.rank(root, '9999'), /schema/);
  assert.throws(() => sharedCacheForeign.rank(root, '9999'), /source binding/);
  assert.throws(() => pages.rank(root, 'a'.repeat(1025)), /key/);
});
