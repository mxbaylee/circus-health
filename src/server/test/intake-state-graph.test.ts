import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, type Database } from '../database.ts';
import { attachRecordDurability, type RecordStorage } from '../record-versions.ts';
import { createIntakeStateStorage, type IntakeCollectionChange } from '../intake-state-storage.ts';
import {
  intakeNamespace,
  limits,
  budget,
  digest,
  frameIntakeChanges,
  reconstructIntakeEvidence,
  reconstructIntakeEvidenceSteps,
} from '../intake-state-evidence.ts';
import { applyIntakeChanges, serializeIntakeJson } from '../intake-state-codec.ts';
import { createIntakeTree } from '../intake-state-tree.ts';
import {
  parseIntakeCollectionDescriptor,
  parseIntakeStoredValue,
} from '../intake-state-collections.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { INTAKE_LEGACY_BRIDGE_CONTROL } from '../intake-state-migration.ts';
import {
  captureIntakeStateCopySnapshot,
  validateIntakeStateCopySnapshot,
  validateIntakeStateCopyRows,
  prepareIntakeStateCopySnapshot,
  stageIntakeStateCopy,
  disposeIntakeStateCopyPlan,
  type IntakeStateCopySnapshot,
} from '../intake-state-bootstrap.ts';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-graph-'));
  const identity = {
    profileId: 'fictional-source',
    intakeId: 'fictional-package',
    sourceHash: '8'.repeat(64),
  };
  const db = openDatabase(join(directory, 'source.sqlite'), identity.profileId);
  const target = openDatabase(join(directory, 'target.sqlite'), 'fictional-target');
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read: (key) => objects.get(key) ?? null,
    writeImmutable: (key, value) => {
      objects.set(key, Buffer.from(value));
    },
    publishHead: (value) => {
      objects.set('head', Buffer.from(value));
    },
  };
  const raw = ' {"literal":"\\u03a9", "duplicate":1,"duplicate":2} ';
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(
    identity.intakeId,
    `data/profiles/${identity.profileId}/sources/a.zip`,
    identity.sourceHash,
    0,
    'intake_original',
    raw,
  );
  attachRecordDurability(db, { profileId: identity.profileId, storage });
  const store = createIntakeStateStorage(db, identity).collections;
  const operationIds: string[] = [];
  function mutate(changes: IntakeCollectionChange[], version: number) {
    const operationId = randomUUID();
    operationIds.push(operationId);
    const prepared = store.prepare(store.openView(), {
      operationId,
      requestDigest: sha(operationId),
      domainVersion: version,
      changes,
    });
    transaction(db, () => store.stage(prepared));
  }
  mutate(
    [
      {
        area: 'logical',
        collection: 'members',
        op: 'put',
        key: 'public-member',
        value: 'original decision',
      },
    ],
    1,
  );
  mutate(
    [
      {
        area: 'logical',
        collection: 'members',
        op: 'put',
        key: 'public-member',
        value: 'reviewed decision',
      },
    ],
    2,
  );
  mutate(
    [
      {
        area: 'builds',
        collection: 'pending',
        op: 'appendBytes',
        bytes: Buffer.from('future raw Ω'),
      },
    ],
    2,
  );
  mutate(
    [
      {
        area: 'logical',
        collection: 'unknown',
        op: 'putBytes',
        key: 'public-opaque',
        fromArea: 'builds',
        fromCollection: 'pending',
      },
    ],
    3,
  );
  mutate([], 3);
  t.after(() => {
    db.close();
    target.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    target,
    identity,
    operationIds,
    raw,
    snapshot: () => captureIntakeStateCopySnapshot(db, identity.profileId),
  };
}
function copiedOriginals(source: Database, target: Database) {
  for (const row of source.prepare('SELECT * FROM source_files').iterate()) {
    const keys = Object.keys(row);
    target
      .prepare(
        `INSERT INTO source_files(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
      )
      .run(
        ...keys.map((key) =>
          key === 'path'
            ? String(row[key]).replace('fictional-source', 'fictional-target')
            : row[key]!,
        ),
      );
  }
  for (const row of source
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_*'")
    .iterate())
    target.prepare('INSERT INTO app_meta VALUES(?,?)').run(row.key!, row.value!);
}
test('v4 cold graph validates retained historical decisions, byte attachments and incomplete builds', (t) => {
  const f = fixture(t);
  validateIntakeStateCopySnapshot(f.snapshot());
});
test('multiple v4 namespaces validate and copy without holding a cursor across graph scratch DDL', (t) => {
  const f = fixture(t);
  for (const name of ['fictional-second', 'fictional-third']) {
    const identity = { ...f.identity, intakeId: name, sourceHash: sha(name) };
    transaction(f.db, () =>
      f.db
        .prepare(
          'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
        )
        .run(
          name,
          `data/profiles/${identity.profileId}/sources/${name}.json`,
          identity.sourceHash,
          0,
          'intake_original',
          f.raw,
        ),
    );
    const store = createIntakeStateStorage(f.db, identity).collections,
      operationId = randomUUID(),
      prepared = store.prepare(store.openView(), {
        operationId,
        requestDigest: sha(operationId),
        domainVersion: 1,
        changes: [
          { area: 'logical', collection: 'members', op: 'put', key: 'public-member', value: name },
        ],
      });
    transaction(f.db, () => store.stage(prepared));
  }
  const snapshot = f.snapshot();
  assert.equal(snapshot.originals.length, 3);
  validateIntakeStateCopySnapshot(snapshot);
  const plan = prepareIntakeStateCopySnapshot(snapshot, 'fictional-target');
  t.after(() => disposeIntakeStateCopyPlan(plan));
  assert.equal(plan.counters.namespaces, 3);
  copiedOriginals(f.db, f.target);
  transaction(f.target, () =>
    stageIntakeStateCopy(f.target, plan, {
      profileId: 'fictional-target',
      readSelectedHead: () => null,
    }),
  );
  const copied = captureIntakeStateCopySnapshot(f.target, 'fictional-target');
  validateIntakeStateCopySnapshot(copied);
  assert.deepEqual(
    copied.originals.map((source) => source.id),
    snapshot.originals.map((source) => source.id),
  );
  assert.equal(copied.rows.filter((row) => row.key.endsWith(':head')).length, 3);
  for (const source of copied.originals)
    assert.ok(
      copied.rows.some(
        (row) =>
          row.key.startsWith(
            intakeNamespace({
              profileId: 'fictional-target',
              intakeId: source.id,
              sourceHash: source.sha256,
            }),
          ) && row.key.endsWith(':head'),
      ),
    );
});
test('nested typed collections validate and copy beyond an in-memory traversal frontier, refusing missing referenced evidence', (t) => {
  const f = fixture(t),
    store = createIntakeStateStorage(f.db, f.identity).collections;
  const mutate = (changes: IntakeCollectionChange[]) => {
    const operationId = randomUUID(),
      prepared = store.prepare(store.openView(), {
        operationId,
        requestDigest: sha(operationId),
        domainVersion: 3,
        changes,
      });
    transaction(f.db, () => store.stage(prepared));
  };
  mutate([
    {
      area: 'logical',
      collection: 'nested',
      op: 'put',
      key: 'literal',
      value: 'retained nested literal',
    },
  ]);
  for (let n = 0; n < 220; n++)
    mutate([
      {
        area: 'logical',
        collection: 'nested',
        op: 'putCollection',
        key: 'previous',
        fromArea: 'logical',
        fromCollection: 'nested',
      },
    ]);
  const source = f.snapshot();
  validateIntakeStateCopySnapshot(source);
  const plan = prepareIntakeStateCopySnapshot(source, 'fictional-target');
  t.after(() => disposeIntakeStateCopyPlan(plan));
  copiedOriginals(f.db, f.target);
  transaction(f.target, () =>
    stageIntakeStateCopy(f.target, plan, {
      profileId: 'fictional-target',
      readSelectedHead: () => null,
    }),
  );
  const copied = captureIntakeStateCopySnapshot(f.target, 'fictional-target');
  validateIntakeStateCopySnapshot(copied);
  const head = JSON.parse(copied.rows.find((row) => row.key.endsWith(':head'))!.value),
    prefix = intakeNamespace(head.identity);
  const tree = createIntakeTree(
    head.identity,
    (hash) => copied.rows.find((row) => row.key === prefix + 'node:' + hash)?.value,
    new Map(),
  );
  let collection = parseIntakeCollectionDescriptor(tree.get(head.logical.root, 'nested'))!;
  let firstHash = '';
  for (let n = 0; n < 220; n++) {
    assert.equal(parseIntakeStoredValue(tree.get(collection.root, 'literal')!).kind, 'inline');
    const previous = parseIntakeStoredValue(tree.get(collection.root, 'previous')!);
    assert.equal(previous.kind, 'collection');
    if (previous.kind !== 'collection') throw Error('missing typed collection');
    collection = previous.descriptor;
    if (n === 0) firstHash = collection.root!.hash;
  }
  assert.equal(tree.get(collection.root, 'previous'), undefined);
  copied.rows = copied.rows.filter((row) => row.key !== prefix + 'node:' + firstHash);
  assert.throws(() => validateIntakeStateCopySnapshot(copied));
});
test('v4 graph copy rebinds selected values and incomplete builds with fresh internal replay evidence', (t) => {
  const f = fixture(t),
    plan = prepareIntakeStateCopySnapshot(f.snapshot(), 'fictional-target');
  t.after(() => disposeIntakeStateCopyPlan(plan));
  copiedOriginals(f.db, f.target);
  transaction(f.target, () =>
    stageIntakeStateCopy(f.target, plan, {
      profileId: 'fictional-target',
      readSelectedHead: () => null,
    }),
  );
  const copied = captureIntakeStateCopySnapshot(f.target, 'fictional-target');
  validateIntakeStateCopySnapshot(copied);
  assert.equal(copied.originals[0]!.detailsJson, f.raw);
  assert.equal(copied.originals[0]!.id, f.identity.intakeId);
  const head = JSON.parse(copied.rows.find((row) => row.key.endsWith(':head'))!.value);
  assert.equal(head.storageSequence, 1);
  assert.equal(head.logical.domainVersion, 3);
  assert.ok(head.builds);
  assert.ok(copied.rows.some((row) => row.value.includes('public-member')));
  assert.ok(copied.rows.some((row) => row.value.includes('reviewed decision')));
  for (const id of f.operationIds)
    assert.equal(
      copied.rows.some((row) => row.value.includes(id)),
      false,
    );
  const objects = new Map<string, Buffer>();
  attachRecordDurability(f.target, {
    profileId: 'fictional-target',
    storage: {
      read: (key) => objects.get(key) ?? null,
      writeImmutable: (key, value) => {
        objects.set(key, Buffer.from(value));
      },
      publishHead: (value) => {
        objects.set('head', Buffer.from(value));
      },
    },
  });
  const target = createIntakeStateStorage(f.target, {
    ...f.identity,
    profileId: 'fictional-target',
  }).collections;
  const view = target.openView();
  assert.equal(target.get(view, 'logical', 'members', 'public-member'), 'reviewed decision');
  const value = target.get(view, 'logical', 'unknown', 'public-opaque');
  assert.ok(value && typeof value !== 'string');
  assert.equal(
    Buffer.concat(target.readBytes(value, { items: 64, bytes: 65536 }).chunks).toString(),
    'future raw Ω',
  );
  for (const id of f.operationIds) assert.equal(target.replay(id, sha(id)), undefined);
});
test('v4 graph refuses missing, disconnected, corrupt and foreign contributions including historical values', async (t) => {
  const mutations: Array<[string, (snapshot: IntakeStateCopySnapshot) => void]> = [
    [
      'missing history child',
      (s) => {
        s.rows.splice(
          s.rows.findIndex((row) => row.value.includes('original decision')),
          1,
        );
      },
    ],
    [
      'corrupt history child',
      (s) => {
        s.rows.find((row) => row.value.includes('original decision'))!.value += ' ';
      },
    ],
    [
      'foreign node',
      (s) => {
        const row = s.rows.find((row) => row.key.includes(':node:'))!;
        const node = JSON.parse(row.value);
        node.identity.profileId = 'foreign';
        row.value = JSON.stringify(node);
      },
    ],
    [
      'disconnected node',
      (s) => {
        const row = s.rows.find((row) => row.key.includes(':node:'))!;
        s.rows.push({ ...row, key: row.key.replace(/[^:]+$/, 'f'.repeat(64)) });
      },
    ],
    [
      'wrong root count',
      (s) => {
        const row = s.rows.find((row) => row.key.endsWith(':head'))!;
        const head = JSON.parse(row.value);
        head.logical.root.count++;
        row.value = JSON.stringify(head);
      },
    ],
    [
      'unknown rows',
      (s) => {
        s.rows.push({ key: 'intake_state_unknown:head', value: '{}' });
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    await t.test(name, (child) => {
      const f = fixture(child),
        snapshot = f.snapshot();
      mutate(snapshot);
      assert.throws(() => validateIntakeStateCopySnapshot(snapshot));
    });
});
test('mixed v3/v4 namespace recovery keeps strict v3 evidence alongside selected graph', (t) => {
  const f = fixture(t),
    id = { ...f.identity, intakeId: 'fictional-legacy' };
  transaction(f.db, () =>
    f.db
      .prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      )
      .run(
        id.intakeId,
        `data/profiles/${id.profileId}/sources/b.txt`,
        id.sourceHash,
        0,
        'intake_original',
        '{}',
      ),
  );
  createIntakeStateStorage(f.db, id).mutate(
    { unknown: { exact: 'Ω' }, publicId: 'retained-public' },
    randomUUID(),
  );
  const snapshot = f.snapshot();
  validateIntakeStateCopySnapshot(snapshot);
  assert.ok(snapshot.rows.some((row) => row.key === intakeNamespace(id) + 'head'));
  const plan = prepareIntakeStateCopySnapshot(snapshot, 'fictional-target');
  t.after(() => disposeIntakeStateCopyPlan(plan));
  assert.equal(plan.counters.namespaces, 2);
});

test('streamed mixed-profile inventory admits over ten thousand namespaces and a million total legacy nodes', () => {
  const profileId = 'fictional-many-originals';
  const count = 10_001;
  function* originals() {
    for (let index = 0; index < count; index++)
      yield {
        id: 'original-' + index,
        kind: 'intake_original',
        sha256: '6'.repeat(64),
        path: `data/profiles/${profileId}/sources/${index}.txt`,
        detailsJson: '{}',
        sourcePin: null,
        preserved: {
          provider_id: null,
          bytes: 0,
          mime_type: 'text/plain',
          coverage_status: 'unknown',
          batch_id: null,
        },
      };
  }
  function* rows() {
    for (let index = 0; index < count; index++) {
      const identity = { profileId, intakeId: 'original-' + index, sourceHash: '6'.repeat(64) };
      const value = { literal: index, annotations: Array.from({ length: 101 }, () => null) };
      const changes = [{ op: 'set', path: [], value }];
      const caps = limits(),
        remaining = budget(caps, { bytes: 0, frames: 0, nodes: 0, operations: 0, stringWork: 0 });
      applyIntakeChanges(undefined, changes, remaining);
      const evidence = frameIntakeChanges(
        identity,
        changes,
        digest(serializeIntakeJson(value)),
        randomUUID(),
        caps,
        undefined,
        remaining,
      );
      const prefix = intakeNamespace(identity);
      for (const frame of evidence.frames) yield { key: frame.key, value: frame.serialized };
      yield { key: prefix + 'operation:' + evidence.result.operationId, value: evidence.receipt };
      yield { key: prefix + 'head', value: evidence.serializedHead };
    }
  }
  validateIntakeStateCopyRows({ sourceProfileId: profileId, originals: originals(), rows: rows() });
});

test('cold traversal cancellation leaves selected evidence untouched and reports bounded progress', (t) => {
  const f = fixture(t),
    before = f.snapshot(),
    controller = new AbortController();
  controller.abort(Error('fictional cancelled validation'));
  assert.throws(
    () => validateIntakeStateCopyRows(before, { signal: controller.signal }),
    /fictional cancelled validation/,
  );
  assert.deepEqual(f.snapshot(), before);
  let records = 0;
  const originals = Array.from({ length: 300 }, (_, index) => ({
    ...before.originals[0]!,
    id: 'fictional-' + index,
  }));
  const later = new AbortController();
  assert.throws(
    () =>
      validateIntakeStateCopyRows(
        { sourceProfileId: before.sourceProfileId, originals, rows: [] },
        {
          signal: later.signal,
          onProgress: (progress) => {
            records = progress.records;
            later.abort(Error('fictional progress cancellation'));
          },
        },
      ),
    /fictional progress cancellation/,
  );
  assert.equal(records, 256);
  assert.deepEqual(f.snapshot(), before);
});

function legacyBridgeSnapshot() {
  const identity = {
    profileId: 'fictional-bridge-source',
    intakeId: 'fictional-legacy-package',
    sourceHash: '9'.repeat(64),
  };
  const raw =
    ' {"before":{"escaped":"\\u03a9","duplicate":1,"duplicate":2},"intake":{"originalName":"fictional.zip","version":7,"workflow":{"format":"health-intake-workflow-v1","publicId":"public-reviewed-decision"}},"future":{"second":2,"first":1}}\n';
  const prepared = prepareInitialIntakeEnvelope(raw),
    caps = limits();
  const initialBudget = budget(caps, {
    bytes: 0,
    frames: 0,
    nodes: 0,
    operations: 0,
    stringWork: 0,
  });
  const changes = [{ op: 'set', path: [], value: prepared.state }];
  applyIntakeChanges(undefined, changes, initialBudget);
  const first = frameIntakeChanges(
    identity,
    changes,
    digest(serializeIntakeJson(prepared.state)),
    randomUUID(),
    caps,
    undefined,
    initialBudget,
  );
  const noopBudget = budget(caps, first.head.usage);
  applyIntakeChanges(prepared.state, [], noopBudget);
  const noop = frameIntakeChanges(
    identity,
    [],
    digest(serializeIntakeJson(prepared.state)),
    randomUUID(),
    caps,
    first.head,
    noopBudget,
  );
  const prefix = intakeNamespace(identity);
  const rows = [...first.frames, ...noop.frames].map((frame) => ({
    key: frame.key,
    value: frame.serialized,
  }));
  for (const event of [first, noop])
    rows.push({ key: prefix + 'operation:' + event.result.operationId, value: event.receipt });
  const tree = createIntakeTree(identity, () => undefined, new Map());
  const control = tree.put(
    null,
    'representation',
    JSON.stringify({ kind: 'inline', text: INTAKE_LEGACY_BRIDGE_CONTROL }),
  );
  const logical = {
    root: tree.put(
      null,
      'envelope.control',
      JSON.stringify({
        kind: 'map',
        root: control,
        bytes: Buffer.byteLength(INTAKE_LEGACY_BRIDGE_CONTROL),
      }),
    ),
    domainVersion: 7,
  };
  const operationId = randomUUID();
  const receipts = tree.put(
    null,
    operationId,
    JSON.stringify({
      format: 'health-intake-state-receipt-v4',
      requestDigest: sha(operationId),
      result: {
        format: 'health-intake-state-result-v4',
        intakeId: identity.intakeId,
        operationId,
        storageSequence: 1,
        logical,
        changed: false,
      },
    }),
  );
  const history = tree.put(
    null,
    '0000000000000001',
    JSON.stringify({
      format: 'health-intake-state-history-v4',
      operationId,
      previous: { format: 'health-intake-legacy-v3', head: noop.head },
      logical,
      builds: null,
    }),
  );
  const head = {
    format: 'health-intake-state-v4',
    identity,
    storageSequence: 1,
    logical,
    receipts,
    history,
    builds: null,
  };
  for (const node of tree.writes([logical.root, control, receipts, history]))
    rows.push({ key: prefix + 'node:' + node.hash, value: node.raw });
  rows.push({ key: prefix + 'head', value: JSON.stringify(head) });
  const snapshot: IntakeStateCopySnapshot = {
    sourceProfileId: identity.profileId,
    originals: [
      {
        id: identity.intakeId,
        kind: 'intake_original',
        sha256: identity.sourceHash,
        path: `data/profiles/${identity.profileId}/sources/a.zip`,
        detailsJson: prepared.detailsJson,
        sourcePin: null,
        preserved: {
          provider_id: null,
          bytes: 0,
          mime_type: 'application/zip',
          coverage_status: 'unknown',
          batch_id: null,
        },
      },
    ],
    rows,
  };
  return { snapshot, identity, raw, noop };
}
test('tagged v3 bridge validates raw unknown evidence and literal legacy no-op result, then rebinds through fresh target replay', (t) => {
  const f = legacyBridgeSnapshot();
  validateIntakeStateCopySnapshot(f.snapshot);
  assert.equal(
    JSON.parse(
      f.snapshot.rows.find((row) => row.key.endsWith('operation:' + f.noop.result.operationId))!
        .value,
    ).result.version,
    2,
  );
  const plan = prepareIntakeStateCopySnapshot(f.snapshot, 'fictional-bridge-target');
  t.after(() => disposeIntakeStateCopyPlan(plan));
  const root = mkdtempSync(join(tmpdir(), 'fictional-bridge-copy-')),
    target = openDatabase(join(root, 'target.sqlite'), 'fictional-bridge-target');
  t.after(() => {
    target.close();
    rmSync(root, { recursive: true, force: true });
  });
  const original = f.snapshot.originals[0]!;
  target
    .prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json,mime_type,coverage_status) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      original.id,
      original.path.replace('fictional-bridge-source', 'fictional-bridge-target'),
      original.sha256,
      0,
      original.kind,
      original.detailsJson,
      original.preserved.mime_type,
      original.preserved.coverage_status,
    );
  for (const row of f.snapshot.rows)
    target.prepare('INSERT INTO app_meta VALUES(?,?)').run(row.key, row.value);
  transaction(target, () =>
    stageIntakeStateCopy(target, plan, {
      profileId: 'fictional-bridge-target',
      readSelectedHead: () => null,
    }),
  );
  const copied = captureIntakeStateCopySnapshot(target, 'fictional-bridge-target');
  validateIntakeStateCopySnapshot(copied);
  const copiedHead = JSON.parse(copied.rows.find((row) => row.key.endsWith(':head'))!.value);
  assert.equal(copiedHead.storageSequence, 2);
  assert.equal(copiedHead.logical.domainVersion, 7);
  const bridge = copied.rows
    .map((row) => {
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    })
    .find(
      (node) =>
        node?.format === 'health-intake-node-v4' && node.value.includes('health-intake-legacy-v3'),
    );
  const previous = JSON.parse(bridge.value).previous;
  const legacy = reconstructIntakeEvidence(
    { ...f.identity, profileId: 'fictional-bridge-target' },
    limits(),
    previous.head,
    (key) => copied.rows.find((row) => row.key === key)?.value,
  );
  assert.deepEqual(legacy.value, { raw: f.raw });
  const steps = reconstructIntakeEvidenceSteps(
    { ...f.identity, profileId: 'fictional-bridge-target' },
    limits(),
    previous.head,
    (key) => copied.rows.find((row) => row.key === key)?.value,
  );
  let turns = 0;
  for (;;) {
    const next = steps.next();
    if (next.done) {
      assert.equal(next.value.serialized, legacy.serialized);
      assert.equal(next.value.fingerprint, legacy.fingerprint);
      assert.deepEqual(next.value.value, legacy.value);
      break;
    }
    turns++;
  }
  assert.ok(turns > 0, 'cold replay yields between frame and JSON/semantic work');
  assert.equal(
    copied.rows.some((row) => row.key.endsWith('operation:' + f.noop.result.operationId)),
    false,
  );
  assert.equal(copied.originals[0]!.detailsJson, original.detailsJson);
});
test('tagged bridge rejects missing legacy receipts and corrupt raw-envelope evidence', () => {
  for (const kind of ['receipt', 'frame'] as const) {
    const f = legacyBridgeSnapshot();
    if (kind === 'receipt')
      f.snapshot.rows = f.snapshot.rows.filter(
        (row) => !row.key.endsWith('operation:' + f.noop.result.operationId),
      );
    else f.snapshot.rows.find((row) => row.key.includes(':frame:'))!.value += ' ';
    assert.throws(() => validateIntakeStateCopySnapshot(f.snapshot));
  }
});
