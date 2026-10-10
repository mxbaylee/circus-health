import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIntakeTree,
  decodeIntakeTreeNode,
  type IntakeTreeNode,
  type IntakeTreeCachedNode,
  type IntakeTreeReadCertificate,
  INTAKE_TREE_PAGE_BYTES,
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

test('sealed readonly page certificates retain at most the existing 128 authenticated pages', () => {
  const raw = new Map<string, string>(),
    cache = new Map<string, IntakeTreeCachedNode>(),
    writer = createIntakeTree(identity, (hash) => raw.get(hash), cache);
  let root: IntakeTreeRoot = null;
  for (let index = 0; index < 300; index++)
    root = writer.put(root, String(index).padStart(4, '0'), '🦊'.repeat(100));
  for (const page of writer.writes([root])) raw.set(page.hash, page.raw);
  const proof: IntakeTreeReadCertificate = {
    witness: 'fictional-exact-read',
    registry: {},
    epoch: {},
    state: 'active',
  };
  const reader = createIntakeTree(identity, (hash) => raw.get(hash), cache, {
    certificate: proof,
    check() {
      assert.equal(proof.state, 'active');
    },
  });
  assert.equal([...reader.entries(root)].length, 300);
  proof.state = 'sealed';
  assert.equal(cache.size, 128);
  assert.ok([...cache.values()].every((entry) => entry.certificate === proof));
  assert.ok(
    [...cache.values()].every((entry) => Buffer.byteLength(entry.raw) <= INTAKE_TREE_PAGE_BYTES),
  );
  assert.ok(
    [...cache.values()].reduce((bytes, entry) => bytes + Buffer.byteLength(entry.raw), 0) <=
      128 * INTAKE_TREE_PAGE_BYTES,
  );
  assert.deepEqual(Object.keys(proof).sort(), ['epoch', 'registry', 'state', 'witness']);
  const [hash, cached] = [...cache].at(-1)!;
  const ref = {
    hash,
    count: 1 + (cached.node.left?.count ?? 0) + (cached.node.right?.count ?? 0),
    height: 1 + Math.max(cached.node.left?.height ?? 0, cached.node.right?.height ?? 0),
    first: cached.node.left?.first ?? cached.node.key,
    last: cached.node.right?.last ?? cached.node.key,
  };
  let rawReads = 0;
  const next: IntakeTreeReadCertificate = { ...proof, state: 'active' };
  const sealed = createIntakeTree(
    identity,
    () => {
      rawReads++;
      return cached.raw;
    },
    cache,
    {
      certificate: next,
      check() {
        assert.equal(next.state, 'active');
      },
    },
  );
  assert.throws(() => sealed.load({ ...ref, count: ref.count + 1 }), /cached tree reference/);
  assert.throws(() => sealed.load({ ...ref, first: 'forged-range' }), /cached tree reference/);
  const foreign = createIntakeTree(
    { ...identity, sourceHash: '4'.repeat(64) },
    () => {
      rawReads++;
      return cached.raw;
    },
    cache,
    { certificate: next, check() {} },
  );
  assert.throws(() => foreign.load(ref), /cached tree source binding/);
  assert.equal(rawReads, 0, 'the certified hit still verifies complete reference and source');
});

test('bounded map batches preserve exact history through tall joins, repeats and ordinary deletion', () => {
  const persisted = new Map<string, string>();
  const expected = new Map<string, string>();
  let root: IntakeTreeRoot = null,
    state = 38491;
  const ordered = (map: Map<string, string>) =>
    [...map]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ key, value }));
  let retained: { root: IntakeTreeRoot; entries: ReturnType<typeof ordered> } | undefined;
  for (let batch = 0; batch < 32; batch++) {
    const pages = createIntakeTree(identity, (hash) => persisted.get(hash), new Map());
    const before = new Map(expected);
    const changes = Array.from({ length: 64 }, (_, i) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const key =
        batch % 4 === 0
          ? `a${String(batch * 64 + i).padStart(5, '0')}`
          : batch % 4 === 1
            ? `z${String(batch * 64 + i).padStart(5, '0')}`
            : String(state % 600).padStart(5, '0');
      return { key, value: `fictional-${state} 🌿` };
    });
    changes[63] = { key: changes[0]!.key, value: 'last duplicate wins' };
    const result = pages.putMany(root, changes);
    assert.deepEqual(
      [...result.previous].sort(),
      [...new Set(changes.map((c) => c.key))]
        .filter((k) => before.has(k))
        .map((k) => [k, before.get(k)!])
        .sort(),
    );
    for (const entry of changes) expected.set(entry.key, entry.value);
    root = result.root;
    const key = changes[17]!.key;
    root = pages.put(root, key, null);
    expected.delete(key);
    root = pages.put(root, 'ordinary', 'still supported');
    expected.set('ordinary', 'still supported');
    for (const page of pages.writes([root])) {
      decodeIntakeTreeNode(page.raw, page.ref, identity);
      persisted.set(page.hash, page.raw);
    }
    const cold = createIntakeTree(identity, (hash) => persisted.get(hash), new Map());
    assert.deepEqual([...cold.entries(root)], ordered(expected));
    assert.equal(root?.count, expected.size);
    assert.ok(root!.height < 24);
    if (batch === 0) retained = { root, entries: ordered(expected) };
    assert.deepEqual(
      [...cold.entries(retained!.root)],
      retained!.entries,
      'old roots remain exact',
    );
    const unchanged = cold.putMany(
      root,
      changes.slice(0, 16).map(({ key }) => ({ key, value: expected.get(key)! })),
    );
    assert.equal(unchanged.root, root, 'exact no-op keeps its original root object and hash');
    assert.equal([...cold.writes([unchanged.root])].length, 0);
  }
  const cold = createIntakeTree(identity, (hash) => persisted.get(hash), new Map());
  assert.equal(cold.putMany(root, []).root, root);
  assert.throws(
    () =>
      cold.putMany(
        root,
        Array.from({ length: 65 }, () => ({ key: 'k', value: 'v' })),
      ),
    /batch budget/,
  );
  assert.throws(
    () =>
      cold.putMany(root, [
        { key: 'k', value: 'x'.repeat(8193) },
        { key: 'k', value: 'valid' },
      ]),
    /value bytes/,
    'an overwritten invalid value is still refused',
  );
  assert.throws(() => cold.putMany(root, [{ key: 'x'.repeat(1025), value: 'v' }]), /key/);
  assert.throws(
    () =>
      cold.putMany({ ...root!, count: root!.count + 1 }, [
        { key: 'ordinary', value: 'replacement' },
      ]),
    /reference/,
  );
  const foreign = createIntakeTree(
    { ...identity, profileId: 'foreign' },
    (hash) => persisted.get(hash),
    new Map(),
  );
  assert.throws(
    () => foreign.putMany(root, [{ key: 'ordinary', value: 'replacement' }]),
    /source binding/,
  );
  const corrupt = createIntakeTree(
    identity,
    (hash) => (hash === root!.hash ? '{}' : persisted.get(hash)),
    new Map(),
  );
  assert.throws(() => corrupt.putMany(root, [{ key: 'ordinary', value: 'replacement' }]), /schema/);
});
