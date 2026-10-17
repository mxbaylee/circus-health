import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as codec from '../intake-state-log.ts';
import {
  initializeIntakeLog as initialize,
  prepareIntakeLogAppend,
  forkIntakeLogSnapshot,
  inspectIntakeLogAppend,
  discardIntakeLogAppend,
  confirmIntakeLogPublication,
  rebuildIntakeLogSnapshot,
  inspectIntakeLogSnapshot,
  disposeIntakeLogSnapshot,
  replayIntakeLog,
  readIntakeLogSequence,
  parseHead,
  CAPS,
  NODE_FORMAT,
  hashWork,
  type Head,
  type Event,
  type Preparation,
  type Ref,
  type LogAdmission,
} from '../intake-state-log.ts';
const admission: LogAdmission = {
  assertCurrent() {},
  lookupBaseOperation: () => ({ kind: 'absent' }),
};

test('cached RAM retirement preserves frozen pending publication evidence', async () => {
  const pool = codec.createIntakeLogResidency({
    activePages: 6,
    cachedPages: 3,
    activeIndices: 2,
    cachedIndices: 1,
  });
  const init = initialize(identity);
  const nodes = new Map<string, string>();
  const first = await rebuildIntakeLogSnapshot(init.head, identity, (key) => nodes.get(key), {
    ...admission,
    residency: pool,
  });
  const event = makeEvent(init.head, 1);
  const pending = prepareIntakeLogAppend(first, event, admission);
  const frozen = inspectIntakeLogAppend(pending);
  codec.cacheIntakeLogSnapshot(first);
  const second = await rebuildIntakeLogSnapshot(init.head, identity, () => undefined, {
    ...admission,
    residency: pool,
  });
  codec.cacheIntakeLogSnapshot(second);
  assert.equal(codec.isIntakeLogSnapshotResident(first), false);
  assert.equal(codec.isIntakeLogSnapshotResident(second), true);
  assert.deepEqual(inspectIntakeLogAppend(pending), frozen);
  assert.throws(
    () =>
      replayIntakeLog(
        first,
        event.receipt.result.operationId,
        event.receipt.requestDigest,
        admission,
      ),
    /retired|unavailable/,
  );
  for (const row of frozen.writes) nodes.set(row.hash, row.raw);
  const accepted = await confirmIntakeLogPublication(pending, () => admission);
  assert.equal(accepted.published, true);
  assert.equal(accepted.snapshot, null);
  assert.deepEqual(accepted.receipt, event.receipt);
  assert.match(String('derivativeError' in accepted && accepted.derivativeError), /retired/);
  disposeIntakeLogSnapshot(second);
  assert.deepEqual(codec.intakeLogResidencyStats(pool), {
    activePages: 0,
    cachedPages: 0,
    activeIndices: 0,
    cachedIndices: 0,
    retirements: 1,
    activeAdmissions: 0,
  });
});

test('active RAM exhaustion is explicit, forks share pages and reentry cannot cache a busy proof', async () => {
  const pool = codec.createIntakeLogResidency({
    activePages: 3,
    cachedPages: 3,
    activeIndices: 1,
    cachedIndices: 1,
  });
  const raw = initialize(identity).head;
  const cap = await rebuildIntakeLogSnapshot(raw, identity, () => undefined, {
    ...admission,
    residency: pool,
  });
  try {
    await assert.rejects(
      rebuildIntakeLogSnapshot(raw, identity, () => undefined, { ...admission, residency: pool }),
      /active RAM capacity/,
    );
    const branch = forkIntakeLogSnapshot(cap, admission);
    assert.equal(codec.intakeLogResidencyStats(pool).activeIndices, 1);
    assert.equal(codec.intakeLogResidencyStats(pool).activePages, 3);
    assert.equal(
      replayIntakeLog(cap, makeEvent(raw, 1).receipt.result.operationId, sha('absent'), {
        assertCurrent() {
          assert.throws(() => codec.cacheIntakeLogSnapshot(branch), /operation in progress/);
          assert.throws(() => codec.retireIntakeLogSnapshot(branch), /operation in progress/);
        },
      }),
      undefined,
    );
    disposeIntakeLogSnapshot(branch);
    codec.cacheIntakeLogSnapshot(cap);
    const next = await rebuildIntakeLogSnapshot(raw, identity, () => undefined, {
      ...admission,
      residency: pool,
    });
    codec.cacheIntakeLogSnapshot(next);
    assert.equal(codec.isIntakeLogSnapshotResident(cap), false);
    disposeIntakeLogSnapshot(next);
  } finally {
    disposeIntakeLogSnapshot(cap);
  }
  assert.equal(codec.intakeLogResidencyStats(pool).activePages, 0);
  assert.equal(codec.intakeLogResidencyStats(pool).cachedPages, 0);
});

test('aggregate native page ceiling preserves an accepted receipt on promotion exhaustion', async () => {
  const pool = codec.createIntakeLogResidency({ activePages: 3 });
  const nodes = new Map<string, string>();
  let raw = initialize(identity).head;
  let cap = await rebuildIntakeLogSnapshot(raw, identity, (key) => nodes.get(key), {
    ...admission,
    residency: pool,
  });
  let exhausted = false;
  for (let n = 1; n <= 80; n++) {
    const event = makeEvent(raw, n);
    const pending = prepareIntakeLogAppend(cap, event, admission);
    const prepared = inspectIntakeLogAppend(pending);
    for (const row of prepared.writes) nodes.set(row.hash, row.raw);
    raw = prepared.head;
    const accepted = await confirmIntakeLogPublication(pending, () => admission);
    assert.deepEqual(accepted.receipt, event.receipt);
    assert.ok(codec.intakeLogResidencyStats(pool).activePages <= 3);
    if (!accepted.snapshot) {
      exhausted = true;
      assert.match(String(accepted.derivativeError), /full|RAM capacity/);
      assert.deepEqual(
        readSequence(raw, identity, (key) => nodes.get(key), n).receipt,
        event.receipt,
      );
      break;
    }
    cap = accepted.snapshot;
  }
  disposeIntakeLogSnapshot(cap);
  assert.equal(exhausted, true);
  assert.equal(codec.intakeLogResidencyStats(pool).activePages, 0);
});

test('confirmation stays active across await while released LRU peers retire', async () => {
  const pool = codec.createIntakeLogResidency({ activePages: 9, cachedPages: 3, cachedIndices: 1 });
  const raw = initialize(identity).head;
  const nodes = new Map<string, string>();
  const cap = await rebuildIntakeLogSnapshot(raw, identity, (key) => nodes.get(key), {
    ...admission,
    residency: pool,
  });
  const event = makeEvent(raw, 1);
  const pending = prepareIntakeLogAppend(cap, event, admission);
  codec.cacheIntakeLogSnapshot(cap);
  const peers: codec.IntakeLogSnapshot[] = [];
  const accepted = await confirmIntakeLogPublication(pending, async (binding) => {
    for (const row of binding.writes) nodes.set(row.hash, row.raw);
    for (let n = 0; n < 2; n++) {
      const peer = await rebuildIntakeLogSnapshot(raw, identity, () => undefined, {
        ...admission,
        residency: pool,
      });
      codec.cacheIntakeLogSnapshot(peer);
      peers.push(peer);
    }
    assert.throws(() => codec.cacheIntakeLogSnapshot(cap), /operation in progress/);
    assert.throws(() => codec.retireIntakeLogSnapshot(cap), /operation in progress/);
    assert.equal(codec.intakeLogResidencyStats(pool).activeIndices, 1);
    assert.equal(codec.isIntakeLogSnapshotResident(cap), true);
    return admission;
  });
  assert.ok(accepted.snapshot);
  assert.deepEqual(
    replayIntakeLog(
      accepted.snapshot,
      event.receipt.result.operationId,
      event.receipt.requestDigest,
      admission,
    ),
    event.receipt,
  );
  for (const peer of peers) disposeIntakeLogSnapshot(peer);
  disposeIntakeLogSnapshot(accepted.snapshot);
  assert.equal(codec.intakeLogResidencyStats(pool).activePages, 0);
  assert.equal(codec.intakeLogResidencyStats(pool).cachedPages, 0);
});

test('cancelled cold verification releases the aggregate reservation without a partial proof', async () => {
  const f = await fixture(20);
  const pool = codec.createIntakeLogResidency();
  const controller = new AbortController();
  await assert.rejects(
    rebuildIntakeLogSnapshot(f.head, identity, f.get, {
      ...admission,
      residency: pool,
      signal: controller.signal,
      onProgress() {
        controller.abort(Error('fictional resource cancellation'));
      },
    }),
    /fictional resource cancellation/,
  );
  assert.deepEqual(codec.intakeLogResidencyStats(pool), {
    activePages: 0,
    cachedPages: 0,
    activeIndices: 0,
    cachedIndices: 0,
    retirements: 0,
    activeAdmissions: 0,
  });
  assert.throws(() => codec.createIntakeLogResidency({ activePages: 65537 }), /raised/);
  assert.throws(() => codec.intakeLogResidencyStats({} as codec.IntakeLogResidency), /foreign/);
});

test('admission lease saturation stays bounded across disposed indices and releases idempotently', async () => {
  const pool = codec.createIntakeLogResidency({ activeAdmissions: 2 });
  const baseline = codec.intakeLogResidencyStats().activeAdmissions;
  const raw = initialize(identity).head;
  const old = await rebuildIntakeLogSnapshot(raw, identity, () => undefined, {
    ...admission,
    residency: pool,
  });
  const releaseA = codec.holdIntakeLogSnapshot(old);
  const releaseB = codec.holdIntakeLogSnapshot(old);
  disposeIntakeLogSnapshot(old);
  // Stale leases still retain their own closures, even after SQLite is gone.
  assert.equal(codec.intakeLogResidencyStats(pool).activeAdmissions, 2);
  assert.equal(codec.intakeLogResidencyStats(pool).activePages, 0);
  const next = await rebuildIntakeLogSnapshot(raw, identity, () => undefined, {
    ...admission,
    residency: pool,
  });
  let releaseNext: (() => void) | undefined;
  try {
    assert.throws(
      () => codec.holdIntakeLogSnapshot(next),
      (error: unknown) => {
        assert.ok(error instanceof codec.IntakeLogResourceExhausted);
        assert.equal(error.code, 'INTAKE_LOG_RESOURCE_EXHAUSTED');
        assert.equal(error.retryable, true);
        return true;
      },
    );
    assert.equal(codec.intakeLogResidencyStats().activeAdmissions, baseline + 2);
    releaseA();
    releaseA();
    releaseNext = codec.holdIntakeLogSnapshot(next);
    assert.equal(codec.intakeLogResidencyStats(pool).activeAdmissions, 2);
    assert.equal(
      replayIntakeLog(next, makeEvent(raw, 1).receipt.result.operationId, sha('absent'), admission),
      undefined,
    );
  } finally {
    releaseA();
    releaseB();
    releaseNext?.();
    releaseNext?.();
    disposeIntakeLogSnapshot(next);
  }
  assert.equal(codec.intakeLogResidencyStats(pool).activeAdmissions, 0);
  assert.equal(codec.intakeLogResidencyStats().activeAdmissions, baseline);
});
const readSequence = (
  head: string,
  identity: import('../intake-state-evidence.ts').IntakeStateIdentity,
  get: (key: string) => unknown,
  sequence: number,
) => readIntakeLogSequence(head, identity, get, sequence, admission);
async function verify(
  head: string,
  identity: import('../intake-state-evidence.ts').IntakeStateIdentity,
  get: (key: string) => unknown,
  limits = {},
) {
  const selected = new Set<string>();
  const cap = await rebuildIntakeLogSnapshot(
    head,
    identity,
    (key) => {
      selected.add(key);
      return get(key);
    },
    { ...admission, limits },
  );
  try {
    const parsed = parseHead(head, identity);
    const events: Event[] = [];
    for (let i = 1; i <= parsed.count; i++)
      events.push(readSequence(head, identity, get, parsed.baseSequence + i));
    const frontier: { key: string }[] = [];
    for (let key = parsed.peaks; key;) {
      frontier.push({ key });
      key = JSON.parse(get(key) as string).older;
    }
    return {
      head: parsed,
      events,
      selected,
      frontier,
      bytes: inspectIntakeLogSnapshot(cap, admission).bytes,
      baseHead: parsed.base ? JSON.parse(JSON.parse(get(parsed.base) as string).v4Head) : undefined,
    };
  } finally {
    disposeIntakeLogSnapshot(cap);
  }
}
async function prepareAppend(
  head: string,
  identity: import('../intake-state-evidence.ts').IntakeStateIdentity,
  get: (key: string) => unknown,
  event: Event,
  limits = {},
) {
  const cap = await rebuildIntakeLogSnapshot(head, identity, get, { ...admission, limits });
  try {
    const pending = prepareIntakeLogAppend(cap, event, admission);
    const result = inspectIntakeLogAppend(pending);
    discardIntakeLogAppend(pending);
    return result;
  } finally {
    disposeIntakeLogSnapshot(cap);
  }
}
export const identity = {
  profileId: 'fictional-profile',
  intakeId: 'fictional-intake',
  sourceHash: 'a'.repeat(64),
};
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const root = (n: number) => ({
  hash: sha(`fictional-logical-${n}`),
  count: 1,
  height: 1,
  first: 'fictional',
  last: 'fictional',
});
export function makeEvent(head: string, n: number, changes = false): Event {
  const before = parseHead(head, identity);
  const operationId = `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const logical = changes
    ? { root: root(n), domainVersion: before.logical.domainVersion + 1 }
    : before.logical;
  return {
    receipt: {
      format: 'health-intake-state-receipt-v4',
      requestDigest: sha(`fictional-request-${n}`),
      result: {
        format: 'health-intake-state-result-v4',
        intakeId: identity.intakeId,
        operationId,
        storageSequence: before.baseSequence + before.count + 1,
        logical,
        changed: changes,
      },
    },
    transition: {
      format: 'health-intake-state-log-transition-v1',
      operationId,
      previous: before,
      logical,
      builds: null,
    },
  };
}
async function fixture(n: number, base?: string) {
  const nodes = new Map<string, string>();
  let init = initialize(identity, base),
    head = init.head;
  const publish = (prepared: Preparation) => {
    for (const row of prepared.writes) {
      assert(!nodes.has(row.hash), 'new rows never overwrite old immutable nodes');
      nodes.set(row.hash, row.raw);
    }
    head = prepared.head;
  };
  publish(init);
  for (let i = 1; i <= n; i++)
    publish(
      await prepareAppend(head, identity, (k) => nodes.get(k), makeEvent(head, i, i % 3 === 0)),
    );
  return {
    nodes,
    get: (k: string) => nodes.get(k),
    get head() {
      return head;
    },
    publish,
  };
}
/** Malicious codec-independent forest writer: rehashes all nodes and binds every parent.
 * It deliberately skips all production codec validation to test semantically forged valid hashes. */
function forge(events: Event[], edit?: (body: any, index: number) => void) {
  const nodes = new Map<string, string>();
  const put = (body: any) => {
    const raw = JSON.stringify({ format: NODE_FORMAT, identity, ...body }),
      key = sha(raw);
    nodes.set(key, raw);
    return key;
  };
  let head = parseHead(initialize(identity).head, identity),
    peaks: { key: string; tree: Ref; older: string | null }[] = [];
  events.forEach((value, i) => {
    const event = structuredClone(value);
    event.transition.previous = structuredClone(head);
    const leaf: any = { kind: 'leaf', event };
    edit?.(leaf, i);
    const key = put(leaf);
    let tree: Ref = { hash: key, first: i + 1, count: 1 },
      offset = 0;
    while (peaks[offset]?.tree.count === tree.count) {
      const left = peaks[offset]!.tree;
      const body = { kind: 'merge', left, right: tree };
      edit?.(body, i);
      tree = { hash: put(body), first: left.first, count: left.count + tree.count };
      offset++;
    }
    const body = { kind: 'peak', tree, older: peaks[offset]?.key ?? null };
    edit?.(body, i);
    const peak = put(body);
    peaks = [{ key: peak, tree, older: body.older }, ...peaks.slice(offset)];
    head = {
      ...head,
      count: i + 1,
      storageSequence: i + 1,
      logical: event.receipt.result.logical,
      builds: event.transition.builds,
      peaks: peak,
    };
  });
  return { head: JSON.stringify(head), nodes, get: (k: string) => nodes.get(k) };
}
test('exact event reads and selected membership across binary carries', async () => {
  const f = await fixture(25),
    checked = await verify(f.head, identity, f.get);
  assert.equal(checked.events.length, 25);
  for (let i = 1; i <= 25; i++)
    assert.deepEqual(readSequence(f.head, identity, f.get, i), checked.events[i - 1]);
  assert.throws(() => readSequence(f.head, identity, f.get, 26));
  assert.throws(() => readSequence(f.head, identity, f.get, 0));
  assert.equal(checked.events[1]!.transition.previous.count, 1);
  assert.equal(checked.events[2]!.transition.previous.count, 2);
  assert.equal(checked.events[24]!.transition.previous.count, 24);
  assert.deepEqual(checked.head.logical, checked.events[24]!.receipt.result.logical);
});
test('preparation is deterministic, side effect free and publishes the whole append together', async () => {
  const f = await fixture(7),
    before = structuredClone([...f.nodes]),
    event = makeEvent(f.head, 8);
  const a = await prepareAppend(f.head, identity, f.get, event),
    b = await prepareAppend(f.head, identity, f.get, event);
  assert.deepEqual(a, b);
  assert.deepEqual([...f.nodes], before);
  assert.equal(a.writes.length, 5); // leaf + three carry merges + one list cell
  await assert.rejects(async () => await verify(a.head, identity, f.get)); // no partially prepared nodes are selected
  const all = new Map(f.nodes);
  a.writes.forEach((r) => all.set(r.hash, r.raw));
  assert.equal((await verify(a.head, identity, (k) => all.get(k))).events.length, 8);
  assert.equal((await verify(f.head, identity, (k) => all.get(k))).events.length, 7);
});
test('list suffix is shared and old payload bytes are never rewritten', async () => {
  const f = await fixture(10),
    old = await verify(f.head, identity, f.get),
    event = makeEvent(f.head, 11);
  const a = await prepareAppend(f.head, identity, f.get, event);
  assert.equal(a.writes.length, 2);
  const peak = JSON.parse(a.writes[1]!.raw);
  assert.equal(peak.older, old.frontier[0]!.key);
  assert.equal(a.writes.filter((r) => JSON.parse(r.raw).kind === 'leaf').length, 1);
  assert.equal(a.payloadBytes, Buffer.byteLength(JSON.stringify(event)));
});
test('missing nodes, corrupt bytes/hash/ref and source identity are refused', async () => {
  const f = await fixture(8),
    leaf = [...(await verify(f.head, identity, f.get)).selected].find(
      (k) => JSON.parse(f.nodes.get(k)!).kind === 'leaf',
    )!;
  await assert.rejects(
    async () => await verify(f.head, identity, (k) => (k === leaf ? undefined : f.get(k))),
  );
  await assert.rejects(
    async () => await verify(f.head, identity, (k) => (k === leaf ? f.get(k) + ' ' : f.get(k))),
  );
  for (const name of ['profileId', 'intakeId', 'sourceHash'] as const)
    await assert.rejects(
      async () =>
        await verify(
          f.head,
          { ...identity, [name]: name === 'sourceHash' ? 'b'.repeat(64) : 'other-fictional' },
          f.get,
        ),
    );
  const badHead = JSON.parse(f.head);
  badHead.peaks = 'f'.repeat(64);
  await assert.rejects(async () => await verify(JSON.stringify(badHead), identity, f.get));
  const forged = forge((await verify(f.head, identity, f.get)).events, (body, i) => {
    if (body.kind === 'merge' && i === 7) body.right.first++;
  });
  await assert.rejects(async () => await verify(forged.head, identity, forged.get));
});
test('validly rehashed duplicate, gapped, future and missing event sequences are refused', async () => {
  const f = await fixture(4),
    events = (await verify(f.head, identity, f.get)).events;
  for (const bad of [1, 3, 99]) {
    const g = forge(events, (body, i) => {
      if (body.kind === 'leaf' && i === 1) body.event.receipt.result.storageSequence = bad;
    });
    await assert.rejects(async () => await verify(g.head, identity, g.get));
  }
  const duplicate = forge(events, (body, i) => {
    if (body.kind === 'leaf' && i === 1) {
      body.event.receipt.result.operationId = events[0]!.receipt.result.operationId;
      body.event.transition.operationId = events[0]!.receipt.result.operationId;
    }
  });
  await assert.rejects(async () => await verify(duplicate.head, identity, duplicate.get));
  const h = JSON.parse(f.head);
  h.count++;
  await assert.rejects(async () => await verify(JSON.stringify(h), identity, f.get));
  const dup = makeEvent(f.head, 5);
  dup.receipt.result.operationId = events[0]!.receipt.result.operationId;
  dup.transition.operationId = dup.receipt.result.operationId;
  await assert.rejects(async () => await prepareAppend(f.head, identity, f.get, dup));
});
test('historical previous heads, logical roots, builds and receipt semantics stay authenticated', async () => {
  const f = await fixture(5),
    events = (await verify(f.head, identity, f.get)).events;
  const g = forge(events, (body, i) => {
    if (body.kind === 'leaf' && i === 3) body.event.transition.previous.logical.root = root(999);
  });
  await assert.rejects(async () => await verify(g.head, identity, g.get));
  const bad = forge(events, (body, i) => {
    if (body.kind === 'leaf' && i === 3) body.event.receipt.result.changed = true;
  });
  await assert.rejects(async () => await verify(bad.head, identity, bad.get));
  const h = JSON.parse(f.head);
  h.builds = root(88);
  await assert.rejects(async () => await verify(JSON.stringify(h), identity, f.get));
});
test('missing historic previous-head list cell is refused even when current forest is intact', async () => {
  const f = await fixture(8),
    selected = await verify(f.head, identity, f.get);
  const oldPeak = selected.events[3]!.transition.previous.peaks!;
  assert.notEqual(oldPeak, selected.head.peaks);
  await assert.rejects(
    async () => await verify(f.head, identity, (k) => (k === oldPeak ? undefined : f.get(k))),
  );
});

test('orphan unselected nodes are excluded, including corrupt and future events', async () => {
  const f = await fixture(3),
    a = await prepareAppend(f.head, identity, f.get, makeEvent(f.head, 4)),
    next = new Map(f.nodes);
  a.writes.forEach((row) => next.set(row.hash, row.raw));
  next.set('f'.repeat(64), 'corrupt orphan');
  const checked = await verify(f.head, identity, (k) => next.get(k));
  assert.equal(checked.events.length, 3);
  for (const row of a.writes) assert(!checked.selected.has(row.hash));
});
test('strict decoding rejects unknown fields, duplicate JSON keys, UTF-8 loss and oversize nodes/events', async () => {
  const f = await fixture(1),
    h = JSON.parse(f.head);
  h.extra = 1;
  assert.throws(() => parseHead(JSON.stringify(h), identity));
  assert.throws(() => parseHead(f.head.replace('"count":1', '"count":1,"count":1'), identity));
  assert.throws(() => parseHead(f.head + '\ud800', identity));
  const e = makeEvent(f.head, 2);
  (e as any).extra = 'x';
  await assert.rejects(async () => await prepareAppend(f.head, identity, f.get, e));
  await assert.rejects(
    async () =>
      await prepareAppend(f.head, identity, f.get, makeEvent(f.head, 2), { eventBytes: 1 }),
  );
  await assert.rejects(async () => await verify(f.head, identity, f.get, { nodeBytes: 1 }));
});
test('bounds, cumulative overflow and failed preparation expose no writes', async () => {
  const f = await fixture(3),
    before = [...f.nodes];
  for (const options of [
    { events: 3 },
    { nodes: 1 },
    { bytes: 1 },
    { preparationBytes: 1 },
    { headBytes: 1 },
    { nodes: CAPS.nodes + 1 },
  ])
    await assert.rejects(
      async () => await prepareAppend(f.head, identity, f.get, makeEvent(f.head, 4), options),
    );
  assert.deepEqual([...f.nodes], before);
  const h = JSON.parse(initialize(identity).head);
  h.baseSequence = Number.MAX_SAFE_INTEGER;
  h.count = 1;
  h.base = 'a'.repeat(64);
  h.peaks = 'b'.repeat(64);
  assert.throws(() => parseHead(JSON.stringify(h), identity));
  const bad = forge((await verify(f.head, identity, f.get)).events, (body, i) => {
    if (body.kind === 'peak' && i === 2) body.tree.count = 2 ** 53;
  });
  await assert.rejects(async () => await verify(bad.head, identity, bad.get));
});
test('exact immutable V4 head is anchored once; opaque prior graph is explicitly excluded', async () => {
  const v4 = JSON.stringify({
    format: 'health-intake-state-v4',
    identity,
    storageSequence: 10,
    logical: { root: root(77), domainVersion: 7 },
    receipts: { ...root(100), count: 10 },
    history: { ...root(101), count: 10 },
    builds: root(102),
  });
  const f = await fixture(5, v4),
    checked = await verify(f.head, identity, f.get);
  assert.equal(checked.baseHead!.storageSequence, 10);
  assert.equal(checked.events[0]!.receipt.result.storageSequence, 11);
  assert.equal([...f.nodes.values()].filter((raw) => JSON.parse(raw).kind === 'anchor').length, 1);
  const anchor = JSON.parse(f.nodes.get(checked.head.base!)!);
  assert.equal(anchor.v4Head, v4);
  assert.deepEqual(checked.events[0]!.transition.previous.logical, checked.baseHead!.logical);
  assert.deepEqual(checked.events[0]!.transition.previous.builds, checked.baseHead!.builds);
  assert.throws(() => readSequence(f.head, identity, f.get, 10));
  // Referenced V4 tree rows are absent: the test demonstrates the explicit external proof obligation.
  assert(!f.nodes.has(root(77).hash));
});

test('initialization obeys selected anchor bytes and keeps empty-head limits separate', async () => {
  const v4 = JSON.stringify({
    format: 'health-intake-state-v4',
    identity,
    storageSequence: 1,
    logical: { root: null, domainVersion: 0 },
    receipts: root(100),
    history: root(101),
    builds: null,
  });
  const anchor = initialize(identity, v4);
  assert.equal(anchor.writes.length, 1);
  const exactBytes = anchor.bytes;
  assert.equal(exactBytes, Buffer.byteLength(anchor.writes[0]!.raw));
  for (const bytes of [1, exactBytes - 1])
    assert.throws(() => initialize(identity, v4, { bytes }), 'no over-limit preparation returns');
  const bounded = initialize(identity, v4, { bytes: exactBytes, nodes: 1 });
  const nodes = new Map(bounded.writes.map(({ hash, raw }) => [hash, raw]));
  assert.equal(
    (await verify(bounded.head, identity, (key) => nodes.get(key), { bytes: exactBytes, nodes: 1 }))
      .bytes,
    exactBytes,
  );
  assert.deepEqual(bounded, anchor);
  const empty = initialize(identity, undefined, { bytes: 1, nodes: 1 });
  assert.equal(empty.writes.length, 0);
  assert.equal(empty.bytes, 0);
  assert.equal(
    (await verify(empty.head, identity, () => undefined, { bytes: 1, nodes: 1 })).bytes,
    0,
  );
  for (const options of [{ bytes: 0 }, { nodes: 0 }, { preparationBytes: 0 }]) {
    assert.throws(() => initialize(identity, v4, options));
    assert.throws(() => initialize(identity, undefined, options));
  }
});

test('two 63-data plus one-progress blocks retain exact evidence across checkpoint restarts', async () => {
  let nodes = new Map<string, string>();
  let head = initialize(identity).head;
  const expected: Event[] = [];
  const previousHeads: Head[] = [];
  for (let sequence = 1; sequence <= 128; sequence++) {
    const previous = parseHead(head, identity);
    const progress = sequence % 64 === 0;
    const event = makeEvent(head, sequence, !progress);
    event.transition.builds = progress ? root(1000 + sequence) : previous.builds;
    previousHeads.push(structuredClone(previous));
    expected.push(structuredClone(event));
    const prepared = await prepareAppend(head, identity, (key) => nodes.get(key), event);
    for (const row of prepared.writes) {
      assert(!nodes.has(row.hash));
      nodes.set(row.hash, row.raw);
    }
    head = prepared.head;
    if (!progress) continue;
    // Persist both pieces as JSON, discard the live Map, and resume from reloaded bytes.
    const persisted = JSON.stringify({ head, rows: [...nodes] });
    const reloaded = JSON.parse(persisted) as { head: string; rows: [string, string][] };
    head = reloaded.head;
    nodes = new Map(reloaded.rows);
    const checked = await verify(head, identity, (key) => nodes.get(key));
    assert.deepEqual(checked.events, expected);
    assert.equal(checked.selected.size, nodes.size);
    assert.equal(nodes.size, 3 * sequence - 1);
    assert.equal(checked.head.logical.domainVersion, sequence - sequence / 64);
    assert.deepEqual(checked.head.builds, root(1000 + sequence));
    for (let index = 0; index < sequence; index++) {
      assert.deepEqual(checked.events[index]!.receipt, expected[index]!.receipt);
      assert.deepEqual(checked.events[index]!.transition.previous, previousHeads[index]);
      assert.deepEqual(
        readSequence(head, identity, (key) => nodes.get(key), index + 1),
        expected[index],
      );
      if ((index + 1) % 64 !== 0)
        assert.deepEqual(checked.events[index]!.transition.builds, previousHeads[index]!.builds);
    }
    const last = checked.events[sequence - 1]!;
    assert.equal(last.receipt.result.changed, false);
    assert.deepEqual(last.receipt.result.logical, last.transition.previous.logical);
    assert.notDeepEqual(last.transition.builds, last.transition.previous.builds);
    // Prove the restored final boundary can resume too, without publishing beyond 128.
    const resumedEvent = makeEvent(head, sequence + 1, true);
    resumedEvent.transition.builds = checked.head.builds;
    const resumed = await prepareAppend(head, identity, (key) => nodes.get(key), resumedEvent);
    const nextNodes = new Map(nodes);
    resumed.writes.forEach((row) => nextNodes.set(row.hash, row.raw));
    const next = await verify(resumed.head, identity, (key) => nextNodes.get(key));
    assert.deepEqual(next.events, [...expected, resumedEvent]);
    assert.deepEqual(next.events[sequence]!.transition.previous, checked.head);
  }
  assert.equal(nodes.size, 383);
});

// These helpers simulate the codec's caller protocol only. They do not stand in
// for production accepted-record/session or selected-row admission proofs.
async function warm(base?: string, limits = {}, customAdmission = admission) {
  const initial = initialize(identity, base, limits);
  const nodes = new Map(initial.writes.map(({ hash, raw }) => [hash, raw]));
  const head = initial.head;
  let reads = 0;
  const get = (key: string) => {
    reads++;
    return nodes.get(key);
  };
  const cap = await rebuildIntakeLogSnapshot(head, identity, get, { ...customAdmission, limits });
  return {
    nodes,
    get,
    get head() {
      return head;
    },
    get cap() {
      return cap;
    },
    get reads() {
      return reads;
    },
    resetReads() {
      reads = 0;
    },
    close() {
      disposeIntakeLogSnapshot(cap);
    },
  };
}
const baseHead = () =>
  JSON.stringify({
    format: 'health-intake-state-v4',
    identity,
    storageSequence: 1,
    logical: { root: null, domainVersion: 0 },
    receipts: root(100),
    history: root(101),
    builds: null,
  });
function baseResult(operationId: string): Event['receipt'] {
  return {
    format: 'health-intake-state-receipt-v4',
    requestDigest: sha('fictional-base'),
    result: {
      format: 'health-intake-state-result-v4',
      intakeId: identity.intakeId,
      operationId,
      storageSequence: 1,
      logical: { root: null, domainVersion: 0 },
      changed: false,
    },
  };
}
test('warm append reservation changes no rows and discard preserves the old proof', async () => {
  const f = await warm();
  const before = inspectIntakeLogSnapshot(f.cap, admission);
  const event = makeEvent(f.head, 1),
    pending = prepareIntakeLogAppend(f.cap, event, admission),
    prepared = inspectIntakeLogAppend(pending);
  assert(Object.isFrozen(prepared));
  assert(Object.isFrozen(prepared.writes));
  assert(Object.isFrozen(prepared.writes[0]));
  assert.equal(f.nodes.size, 0);
  assert.throws(() => inspectIntakeLogSnapshot(f.cap, admission));
  assert.throws(() => prepareIntakeLogAppend(f.cap, event, admission));
  discardIntakeLogAppend(pending);
  assert.deepEqual(inspectIntakeLogSnapshot(f.cap, admission), before);
  assert.throws(() => inspectIntakeLogAppend(pending));
  f.close();
  assert.throws(() => inspectIntakeLogSnapshot(f.cap, admission));
});
test('async publication protocol blocks reentry, consumes old proof, and admits exact replay', async () => {
  const initial = initialize(identity),
    nodes = new Map<string, string>();
  const old = await rebuildIntakeLogSnapshot(
    initial.head,
    identity,
    (k) => nodes.get(k),
    admission,
  );
  const event = makeEvent(initial.head, 1, true),
    pending = prepareIntakeLogAppend(old, event, admission),
    prepared = inspectIntakeLogAppend(pending);
  const result = await confirmIntakeLogPublication(pending, async (binding) => {
    assert.deepEqual(binding.writes, prepared.writes);
    assert.equal(binding.beforeHead, initial.head);
    assert.equal(binding.afterHead, prepared.head);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.throws(() => discardIntakeLogAppend(pending));
    assert.throws(() => inspectIntakeLogAppend(pending));
    assert.throws(() => prepareIntakeLogAppend(old, event, admission));
    binding.writes.forEach((row) => nodes.set(row.hash, row.raw));
    return admission;
  });
  assert(result.snapshot);
  assert.throws(() => inspectIntakeLogSnapshot(old, admission));
  assert.deepEqual(
    replayIntakeLog(
      result.snapshot,
      event.receipt.result.operationId,
      event.receipt.requestDigest,
      admission,
    ),
    event.receipt,
  );
  assert.throws(() =>
    replayIntakeLog(result.snapshot, event.receipt.result.operationId, sha('conflict'), admission),
  );
  disposeIntakeLogSnapshot(result.snapshot);
});
test('unknown publication and postacceptance derivative failure dispose rather than roll back evidence', async () => {
  for (const published of [false, true]) {
    const f = await warm(),
      event = makeEvent(f.head, 1),
      pending = prepareIntakeLogAppend(f.cap, event, admission),
      prepared = inspectIntakeLogAppend(pending);
    if (!published)
      await assert.rejects(
        confirmIntakeLogPublication(pending, async () => {
          throw Error('unknown outcome');
        }),
        /unknown outcome/,
      );
    else {
      const result = await confirmIntakeLogPublication(pending, async (binding) => {
        binding.writes.forEach((row) => f.nodes.set(row.hash, row.raw));
        return {
          assertCurrent() {
            throw Error('postacceptance interval lost');
          },
        };
      });
      assert.equal(result.published, true);
      assert.equal(result.snapshot, null);
      assert.deepEqual(result.receipt, event.receipt);
      assert.equal(
        readSequence(prepared.head, identity, f.get, 1).receipt.requestDigest,
        event.receipt.requestDigest,
      );
    }
    assert.throws(() => inspectIntakeLogSnapshot(f.cap, admission));
  }
});
test('disposing during async confirmation preserves accepted outcome but cannot revive proof', async () => {
  const f = await warm(),
    event = makeEvent(f.head, 1),
    pending = prepareIntakeLogAppend(f.cap, event, admission);
  const result = await confirmIntakeLogPublication(pending, async (binding) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    disposeIntakeLogSnapshot(f.cap);
    binding.writes.forEach((row) => f.nodes.set(row.hash, row.raw));
    return admission;
  });
  assert.equal(result.snapshot, null);
  assert.equal(result.published, true);
  assert.throws(() => inspectIntakeLogSnapshot(f.cap, admission));
});
test('authenticated V4 lookup is mandatory and validates exact receipt, identity and replay digest', async () => {
  const initial = initialize(identity, baseHead()),
    nodes = new Map(initial.writes.map((row) => [row.hash, row.raw]));
  await assert.rejects(
    rebuildIntakeLogSnapshot(initial.head, identity, (k) => nodes.get(k), { assertCurrent() {} }),
    /lookup/,
  );
  const operationId = makeEvent(initial.head, 2).receipt.result.operationId,
    receipt = baseResult(operationId);
  const baseAdmission: LogAdmission = {
    assertCurrent() {},
    lookupBaseOperation: () => ({ kind: 'receipt', receipt, identity }),
  };
  let cap = await rebuildIntakeLogSnapshot(
    initial.head,
    identity,
    (k) => nodes.get(k),
    baseAdmission,
  );
  assert.deepEqual(
    replayIntakeLog(cap, operationId, receipt.requestDigest, baseAdmission),
    receipt,
  );
  assert.throws(
    () => prepareIntakeLogAppend(cap, makeEvent(initial.head, 2), baseAdmission),
    /duplicate/,
  );
  for (const edit of ['id', 'intake', 'sequence', 'identity', 'digest', 'thenable'] as const) {
    const bad = structuredClone(receipt);
    let scoped = identity;
    if (edit === 'id')
      bad.result.operationId = makeEvent(initial.head, 3).receipt.result.operationId;
    if (edit === 'intake') bad.result.intakeId = 'wrong-fictional';
    if (edit === 'sequence') bad.result.storageSequence = 2;
    if (edit === 'identity') scoped = { ...identity, sourceHash: 'f'.repeat(64) };
    if (edit === 'digest') bad.requestDigest = 'invalid';
    const lookup: LogAdmission = {
      assertCurrent() {},
      lookupBaseOperation: () =>
        edit === 'thenable'
          ? (Promise.resolve({ kind: 'absent' }) as never)
          : { kind: 'receipt', receipt: bad, identity: scoped },
    };
    cap = await rebuildIntakeLogSnapshot(initial.head, identity, (k) => nodes.get(k), lookup);
    assert.throws(() => replayIntakeLog(cap, operationId, receipt.requestDigest, lookup));
    disposeIntakeLogSnapshot(cap);
  }
});
test('cold verification refuses V4/suffix duplicates even when each forest hash is valid', async () => {
  const f = await fixture(1, baseHead()),
    operationId = readSequence(f.head, identity, f.get, 2).receipt.result.operationId;
  await assert.rejects(
    rebuildIntakeLogSnapshot(f.head, identity, f.get, {
      assertCurrent() {},
      lookupBaseOperation: () => ({ kind: 'receipt', identity, receipt: baseResult(operationId) }),
    }),
    /duplicate V4/,
  );
});
test('warm methods reject async admission or V4 lookup and callback reentry', async () => {
  const f = await warm();
  assert.throws(
    () => prepareIntakeLogAppend(f.cap, makeEvent(f.head, 1), { assertCurrent: async () => {} }),
    /synchronous/,
  );
  const b = await warm(baseHead());
  assert.throws(
    () =>
      prepareIntakeLogAppend(b.cap, makeEvent(b.head, 1), {
        assertCurrent() {},
        lookupBaseOperation: () => Promise.resolve({ kind: 'absent' }) as never,
      }),
    /synchronous/,
  );
  const c = await warm();
  let checked = false;
  const pending = prepareIntakeLogAppend(c.cap, makeEvent(c.head, 1), {
    assertCurrent() {
      checked = true;
      assert.throws(() => prepareIntakeLogAppend(c.cap, makeEvent(c.head, 2), admission));
    },
  });
  assert(checked);
  discardIntakeLogAppend(pending);
  c.close();
});
test('RAM index row/key/page capacity refuses without spill or durable writes', async () => {
  for (const limits of [{ indexRows: 1 }, { indexKeyBytes: 108 }]) {
    const f = await warm(undefined, limits);
    const first = prepareIntakeLogAppend(f.cap, makeEvent(f.head, 1), admission),
      prepared = inspectIntakeLogAppend(first);
    const accepted = await confirmIntakeLogPublication(first, async (binding) => {
      binding.writes.forEach((row) => f.nodes.set(row.hash, row.raw));
      return admission;
    });
    assert(accepted.snapshot);
    const state = inspectIntakeLogSnapshot(accepted.snapshot, admission);
    assert.equal(state.index.rows, 1);
    assert.equal(state.index.keyBytes, 108);
    assert(state.index.pageBytes <= CAPS.indexPages * 4096);
    const before = [...f.nodes];
    assert.throws(
      () => prepareIntakeLogAppend(accepted.snapshot, makeEvent(prepared.head, 2), admission),
      /capacity/,
    );
    assert.deepEqual([...f.nodes], before);
    disposeIntakeLogSnapshot(accepted.snapshot);
  }
  await assert.rejects(
    rebuildIntakeLogSnapshot(initialize(identity).head, identity, () => undefined, {
      ...admission,
      limits: { indexPages: 1 },
    }),
  );
});
test('cooperative cold rebuild cancels and refuses changed admission without returning partial proofs', async () => {
  const f = await fixture(35),
    original = [...f.nodes],
    controller = new AbortController();
  let yields = 0;
  await assert.rejects(
    rebuildIntakeLogSnapshot(f.head, identity, f.get, {
      ...admission,
      signal: controller.signal,
      onProgress() {
        yields++;
        controller.abort();
      },
    }),
    /abort/i,
  );
  assert.equal(yields, 1);
  assert.deepEqual([...f.nodes], original);
  let current = true;
  await assert.rejects(
    rebuildIntakeLogSnapshot(f.head, identity, f.get, {
      assertCurrent() {
        if (!current) throw Error('fixture admission changed');
      },
      onProgress() {
        current = false;
      },
    }),
    /admission changed/,
  );
});
// Load a separate module instance with an instrumented constructor-time native
// prepare binding, retaining the test-only connection handle. The production
// module exposes no connection, SQL hook, row mutator or test bypass.
async function instrumentedIndex(
  run: (module: typeof import('../intake-state-log.ts'), db: () => DatabaseSync) => Promise<void>,
) {
  const original = DatabaseSync.prototype.prepare;
  let captured: DatabaseSync | undefined;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    captured = this;
    return Reflect.apply(original, this, [sql]);
  };
  try {
    const path = new URL('../intake-state-log.ts?fixture=' + Math.random(), import.meta.url).href;
    const module = await import(path);
    await run(module, () => {
      assert(captured);
      return captured;
    });
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
}
test('private index mutations, deletions, rollback repairs and TEMP changes revoke completeness', async () => {
  const f = await fixture(1);
  for (const sql of [
    "UPDATE operations SET leaf='" + 'f'.repeat(64) + "'",
    'DELETE FROM operations',
    'BEGIN; DELETE FROM operations; ROLLBACK;',
    'CREATE TEMP TABLE forged(value);',
  ]) {
    await instrumentedIndex(async (module, db) => {
      const cap = await module.rebuildIntakeLogSnapshot(f.head, identity, f.get, admission);
      assert.equal(db().prepare('PRAGMA temp_store').get()!.temp_store, 2);
      assert.equal(db().prepare('PRAGMA database_list').get()!.file, '');
      db().exec(sql);
      assert.throws(
        () => module.prepareIntakeLogAppend(cap, makeEvent(f.head, 2), admission),
        /index/,
      );
      module.disposeIntakeLogSnapshot(cap);
      assert.equal(db().isOpen, false);
    });
  }
});
test('index integrity failure after accepted publication returns receipt and disposes only derivative', async () => {
  await instrumentedIndex(async (module, db) => {
    const initial = initialize(identity),
      nodes = new Map<string, string>(),
      cap = await module.rebuildIntakeLogSnapshot(
        initial.head,
        identity,
        (k) => nodes.get(k),
        admission,
      ),
      event = makeEvent(initial.head, 1);
    const pending = module.prepareIntakeLogAppend(cap, event, admission);
    const result = await module.confirmIntakeLogPublication(pending, async (binding) => {
      binding.writes.forEach((row) => nodes.set(row.hash, row.raw));
      db().exec('CREATE TEMP TABLE forged(value)');
      return admission;
    });
    assert.equal(result.published, true);
    assert.equal(result.snapshot, null);
    assert.deepEqual(result.receipt, event.receipt);
    assert.equal(db().isOpen, false);
  });
});
test('50/200/800 warm appends have linear durable/hash work and zero suffix preparation reads; cold work is separate', async () => {
  const measurements: {
    n: number;
    rows: number;
    hashes: number;
    reads: number;
    coldReads: number;
  }[] = [];
  for (const n of [50, 200, 800]) {
    const initial = initialize(identity),
      nodes = new Map<string, string>();
    let reads = 0,
      head = initial.head;
    const get = (key: string) => {
      reads++;
      return nodes.get(key);
    };
    let cap = await rebuildIntakeLogSnapshot(head, identity, get, admission);
    reads = 0;
    hashWork.calls = 0;
    hashWork.bytes = 0;
    for (let i = 1; i <= n; i++) {
      const event = makeEvent(head, i, i % 3 === 0),
        pending = prepareIntakeLogAppend(cap, event, admission),
        prepared = inspectIntakeLogAppend(pending);
      const result = await confirmIntakeLogPublication(pending, async (binding) => {
        assert.equal(binding.beforeHead, head);
        binding.writes.forEach((row) => {
          assert(!nodes.has(row.hash));
          nodes.set(row.hash, row.raw);
        });
        head = binding.afterHead;
        return admission;
      });
      assert(result.snapshot);
      cap = result.snapshot;
      assert.equal(nodes.size, 3 * i - i.toString(2).replaceAll('0', '').length);
      assert.equal(
        prepared.bytes,
        prepared.writes.reduce((sum, row) => sum + Buffer.byteLength(row.raw), 0),
      );
    }
    const warmReads = reads,
      warmHashes = hashWork.calls;
    assert.equal(warmReads, 0);
    assert(warmHashes <= 6 * n);
    assert(hashWork.bytes <= n * 8192);
    const state = inspectIntakeLogSnapshot(cap, admission);
    assert.equal(state.index.rows, n);
    assert.equal(state.nodes, nodes.size);
    const last = readSequence(head, identity, get, n);
    assert.deepEqual(
      replayIntakeLog(cap, last.receipt.result.operationId, last.receipt.requestDigest, admission),
      last.receipt,
    );
    disposeIntakeLogSnapshot(cap);
    reads = 0;
    const cold = await rebuildIntakeLogSnapshot(head, identity, get, admission),
      coldReads = reads;
    assert(coldReads >= nodes.size && coldReads <= nodes.size + 53);
    assert.equal(inspectIntakeLogSnapshot(cold, admission).nodes, nodes.size);
    disposeIntakeLogSnapshot(cold);
    measurements.push({ n, rows: nodes.size, hashes: warmHashes, reads: warmReads, coldReads });
  }
  assert.deepEqual(
    measurements.map((row) => row.rows),
    [147, 597, 2397],
  );
});
test('storage sequence is an exact top-level V5 commitment', () => {
  const raw = JSON.parse(initialize(identity).head);
  assert.equal(raw.storageSequence, 0);
  raw.storageSequence = 1;
  assert.throws(() => parseHead(JSON.stringify(raw), identity), /storage sequence/);
});
test('actual RAM page exhaustion after acceptance disposes derivative and preserves exact receipt', async () => {
  const nodes = new Map<string, string>();
  let head = initialize(identity).head;
  let cap = await rebuildIntakeLogSnapshot(head, identity, (key) => nodes.get(key), {
    ...admission,
    limits: { indexPages: 3 },
  });
  let refused = false;
  for (let sequence = 1; sequence <= 80; sequence++) {
    const event = makeEvent(head, sequence),
      pending = prepareIntakeLogAppend(cap, event, admission);
    const result = await confirmIntakeLogPublication(pending, async (binding) => {
      binding.writes.forEach((row) => nodes.set(row.hash, row.raw));
      head = binding.afterHead;
      return admission;
    });
    if (!result.snapshot) {
      refused = true;
      assert.equal(result.published, true);
      assert.deepEqual(result.receipt, event.receipt);
      assert.deepEqual(
        readSequence(head, identity, (key) => nodes.get(key), sequence).receipt,
        event.receipt,
      );
      assert.throws(() => inspectIntakeLogSnapshot(cap, admission));
      break;
    }
    cap = result.snapshot;
  }
  assert(
    refused,
    'the fixed three-page in-memory index must refuse before 80 rows; never fall back to a path',
  );
});
test('cancellation closes the private RAM connection and prototype method drift is refused', async () => {
  const f = await fixture(20);
  await instrumentedIndex(async (module, db) => {
    const signal = new AbortController();
    await assert.rejects(
      module.rebuildIntakeLogSnapshot(f.head, identity, f.get, {
        ...admission,
        signal: signal.signal,
        onProgress() {
          signal.abort();
        },
      }),
    );
    assert.equal(db().isOpen, false);
  });
  const g = await warm(),
    original = DatabaseSync.prototype.exec;
  try {
    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
      return Reflect.apply(original, this, [sql]);
    };
    assert.throws(() => inspectIntakeLogSnapshot(g.cap, admission), /index/);
  } finally {
    DatabaseSync.prototype.exec = original;
    g.close();
  }
});
test('externally closed index after accepted publication cannot turn receipt into a thrown failure', async () => {
  await instrumentedIndex(async (module, db) => {
    const head = initialize(identity).head,
      cap = await module.rebuildIntakeLogSnapshot(head, identity, () => undefined, admission),
      event = makeEvent(head, 1);
    const pending = module.prepareIntakeLogAppend(cap, event, admission);
    const result = await module.confirmIntakeLogPublication(pending, async () => {
      db().close();
      return admission;
    });
    assert.equal(result.published, true);
    assert.equal(result.snapshot, null);
    assert.deepEqual(result.receipt, event.receipt);
  });
});
test('throwing private cleanup is reported as a derivative error after confirmed publication', async () => {
  const original = DatabaseSync.prototype.close;
  let failClose = false;
  DatabaseSync.prototype.close = function (this: DatabaseSync) {
    const result = Reflect.apply(original, this, []);
    if (failClose) throw Error('fixture cleanup failure');
    return result;
  };
  try {
    await instrumentedIndex(async (module, db) => {
      const head = initialize(identity).head,
        cap = await module.rebuildIntakeLogSnapshot(head, identity, () => undefined, admission),
        event = makeEvent(head, 1),
        pending = module.prepareIntakeLogAppend(cap, event, admission);
      const result = await module.confirmIntakeLogPublication(pending, async () => {
        failClose = true;
        db().exec('CREATE TEMP TABLE changed(value)');
        return admission;
      });
      assert.equal(result.published, true);
      assert.equal(result.snapshot, null);
      assert.deepEqual(result.receipt, event.receipt);
      assert('derivativeError' in result);
      assert(result.derivativeError instanceof AggregateError);
      assert.match(String(result.derivativeError.errors[1]), /fixture cleanup failure/);
      assert.equal(db().isOpen, false);
    });
  } finally {
    DatabaseSync.prototype.close = original;
  }
});
test('final admission disposal refuses both positive and negative replay', async () => {
  for (const positive of [false, true]) {
    const f = await fixture(positive ? 1 : 0);
    const cap = await rebuildIntakeLogSnapshot(f.head, identity, f.get, admission);
    const receipt = positive
      ? readSequence(f.head, identity, f.get, 1).receipt
      : makeEvent(f.head, 1).receipt;
    let calls = 0;
    const finalCall = positive ? 4 : 2;
    assert.throws(
      () =>
        replayIntakeLog(cap, receipt.result.operationId, receipt.requestDigest, {
          assertCurrent() {
            if (++calls === finalCall) disposeIntakeLogSnapshot(cap);
          },
        }),
      /disposed|index/,
    );
    assert.equal(calls, finalCall);
    assert.throws(() => inspectIntakeLogSnapshot(cap, admission));
    disposeIntakeLogSnapshot(cap);
  }
});
test('pending integrity failure at inspect discard or confirm permanently revokes both capabilities', async () => {
  for (const entry of ['inspect', 'discard', 'confirm'] as const) {
    const f = await warm();
    const pending = prepareIntakeLogAppend(f.cap, makeEvent(f.head, 1), admission);
    const original = DatabaseSync.prototype.exec;
    try {
      DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
        return Reflect.apply(original, this, [sql]);
      };
      if (entry === 'inspect') assert.throws(() => inspectIntakeLogAppend(pending), /index/);
      if (entry === 'discard') assert.throws(() => discardIntakeLogAppend(pending), /index/);
      if (entry === 'confirm')
        await assert.rejects(
          confirmIntakeLogPublication(pending, async () => admission),
          /index/,
        );
    } finally {
      DatabaseSync.prototype.exec = original;
    }
    assert.throws(() => inspectIntakeLogAppend(pending), /unavailable/);
    assert.throws(() => discardIntakeLogAppend(pending), /unavailable/);
    await assert.rejects(
      confirmIntakeLogPublication(pending, async () => admission),
      /unavailable/,
    );
    assert.throws(() => inspectIntakeLogSnapshot(f.cap, admission), /unavailable/);
    f.close();
  }
});
test('final publication admission method drift returns accepted receipt with disposed derivative', async () => {
  const f = await warm();
  const event = makeEvent(f.head, 1);
  const pending = prepareIntakeLogAppend(f.cap, event, admission);
  const prepared = inspectIntakeLogAppend(pending);
  const original = DatabaseSync.prototype.exec;
  let calls = 0;
  try {
    const result = await confirmIntakeLogPublication(pending, async (binding) => {
      binding.writes.forEach((row) => f.nodes.set(row.hash, row.raw));
      return {
        assertCurrent() {
          if (++calls === 2) {
            DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
              return Reflect.apply(original, this, [sql]);
            };
          }
        },
      };
    });
    assert.equal(calls, 2);
    assert.equal(result.published, true);
    assert.equal(result.snapshot, null);
    assert.deepEqual(result.receipt, event.receipt);
    assert('derivativeError' in result);
    assert.match(String(result.derivativeError), /index/);
    assert.throws(() => inspectIntakeLogSnapshot(f.cap, admission), /unavailable/);
  } finally {
    DatabaseSync.prototype.exec = original;
    f.close();
  }
  assert.deepEqual(readSequence(prepared.head, identity, f.get, 1).receipt, event.receipt);
});

test('bounded alternative preparations share completeness and accepted promotion revokes stale siblings', async () => {
  const initial = initialize(identity),
    nodes = new Map<string, string>();
  const base = await rebuildIntakeLogSnapshot(
    initial.head,
    identity,
    (k) => nodes.get(k),
    admission,
  );
  const first = forkIntakeLogSnapshot(base, admission),
    second = forkIntakeLogSnapshot(base, admission);
  const event = makeEvent(initial.head, 1, true),
    a = prepareIntakeLogAppend(first, event, admission),
    b = prepareIntakeLogAppend(second, makeEvent(initial.head, 1, false), admission);
  assert.equal(inspectIntakeLogSnapshot(base, admission).index.rows, 0);
  discardIntakeLogAppend(b);
  disposeIntakeLogSnapshot(second);
  assert.equal(inspectIntakeLogSnapshot(base, admission).index.rows, 0);
  const sibling = forkIntakeLogSnapshot(base, admission),
    stale = prepareIntakeLogAppend(sibling, makeEvent(initial.head, 1, false), admission);
  const result = await confirmIntakeLogPublication(a, (binding) => {
    for (const row of binding.writes) nodes.set(row.hash, row.raw);
    return admission;
  });
  assert(result.snapshot);
  assert.throws(() => inspectIntakeLogSnapshot(base, admission));
  assert.throws(() => inspectIntakeLogAppend(stale));
  disposeIntakeLogSnapshot(sibling);
  disposeIntakeLogSnapshot(base);
  assert.deepEqual(
    replayIntakeLog(
      result.snapshot,
      event.receipt.result.operationId,
      event.receipt.requestDigest,
      admission,
    ),
    event.receipt,
  );
  disposeIntakeLogSnapshot(result.snapshot);
});

test('suffix index budgets follow unchanged node and byte bounds rather than an independent 100k history gate', async () => {
  const cells = (count: number) => 3 * count - count.toString(2).replaceAll('0', '').length;
  assert.equal(CAPS.nodes, 1_000_000);
  assert.equal(CAPS.bytes, 256 * 1024 * 1024);
  assert.equal(CAPS.events, 1_000_000);
  assert.equal(CAPS.indexRows, 333335);
  assert.ok(cells(CAPS.indexRows) + 1 <= CAPS.nodes, 'an anchor still fits at this exact boundary');
  assert.ok(cells(CAPS.indexRows + 1) > CAPS.nodes);
  assert.equal(CAPS.indexKeyBytes, CAPS.indexRows * (36 + 64 + 8));
  assert.equal(CAPS.indexPages, 32768);
  assert.ok(CAPS.indexPages * 4096 >= CAPS.indexKeyBytes * 3);
  const later = JSON.parse(initialize(identity).head);
  later.count = later.storageSequence = 100001;
  later.peaks = 'a'.repeat(64);
  assert.equal(parseHead(JSON.stringify(later), identity).count, 100001);
  await assert.rejects(
    rebuildIntakeLogSnapshot(JSON.stringify(later), identity, () => undefined, admission),
  );
  later.count = later.storageSequence = CAPS.events + 1;
  assert.throws(() => parseHead(JSON.stringify(later), identity), /head counts/);
  const f = await fixture(8);
  const exact = await rebuildIntakeLogSnapshot(f.head, identity, f.get, {
    ...admission,
    limits: { nodes: cells(8) },
  });
  assert.equal(inspectIntakeLogSnapshot(exact, admission).nodes, cells(8));
  disposeIntakeLogSnapshot(exact);
  await assert.rejects(
    rebuildIntakeLogSnapshot(f.head, identity, f.get, {
      ...admission,
      limits: { nodes: cells(8) - 1 },
    }),
    /selected log limits/,
  );
});
