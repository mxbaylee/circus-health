import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import {
  openDatabase,
  transaction,
  registerTransactionDurability,
  type Database,
} from '../database.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  recordDurabilityStatus,
  type RecordStorage,
} from '../record-versions.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import {
  prepareIntakeStateCopy,
  prepareIntakeStateCopySnapshot,
  stageIntakeStateCopy,
  type IntakeStateCopySnapshot,
} from '../intake-state-bootstrap.ts';
import { intakeDetails, storedIntakeDetails } from '../intake-state-access.ts';
import { prepareInitialIntakeEnvelope, readIntakeEnvelopeText } from '../intake-authority.ts';
import { readIntakeSourcePin, writeIntakeSourcePin } from '../intake-source-pin.ts';

const sourceId = 'fictional-bootstrap-source';
const targetId = 'fictional-bootstrap-target';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const namespace = (profileId: string, intakeId: string, sourceHash: string) =>
  `intake_state_v1:${sha(JSON.stringify({ profileId, intakeId, sourceHash }))}:`;

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable(name, bytes) {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(bytes));
    },
    publishHead: (bytes) => {
      objects.set('head', Buffer.from(bytes));
    },
  };
  return { storage, objects };
}

function detached(db: Database): IntakeStateCopySnapshot {
  return {
    sourceProfileId: sourceId,
    originals: db
      .prepare("SELECT * FROM source_files WHERE kind='intake_original' ORDER BY id")
      .all()
      .map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        sha256: String(row.sha256),
        detailsJson: String(row.details_json),
        path: String(row.path),
        sourcePin:
          (db
            .prepare('SELECT value FROM app_meta WHERE key=?')
            .get('intake_source_pin:v1:' + row.id)?.value as string | undefined) ?? null,
        preserved: {
          provider_id: row.provider_id as string | null,
          bytes: Number(row.bytes),
          mime_type: String(row.mime_type),
          coverage_status: String(row.coverage_status),
          batch_id: row.batch_id as string | null,
        },
      })),
    rows: db
      .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_*' ORDER BY key")
      .all()
      .map((row) => ({ key: String(row.key), value: String(row.value) })),
  };
}

function rows(db: Database, table: string) {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
}
function snapshot(db: Database) {
  return Object.fromEntries(
    ['app_meta', 'source_files', 'source_records', 'observations', 'providers', 'test_types'].map(
      (table) => [table, rows(db, table)],
    ),
  );
}
function withoutTransactionCounters(value: ReturnType<typeof snapshot>) {
  return {
    ...value,
    app_meta: value.app_meta!.filter(
      (row) => !['revision', 'clinical_review_revision'].includes(String(row.key)),
    ),
  };
}
const acceptedSnapshot = (objects: Map<string, Buffer>) =>
  new Map([...objects].map(([key, bytes]) => [key, Buffer.from(bytes)]));

function fixture(t: test.TestContext, count = 2) {
  const root = mkdtempSync(join(tmpdir(), 'intake-bootstrap-'));
  const opened: Database[] = [];
  const open = (filename: string, profileId: string) => {
    const db = openDatabase(join(root, filename), profileId);
    opened.push(db);
    return db;
  };
  t.after(() => {
    for (const db of opened) {
      clearIntakeStateCache(db);
      if (db.isOpen) db.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
  const source = open('source.sqlite', sourceId);
  const sourceAuthority = memoryStorage();
  const targetAuthority = memoryStorage();
  const originals: {
    id: string;
    hash: string;
    bytes: Buffer;
    raw: string;
    state: Record<string, unknown>;
    operationId: string;
  }[] = [];
  const literal = 'Independently fictional bootstrap Ω 😀. '.repeat(3000);
  for (let index = 0; index < count; index++) {
    const id = `fictional-intake-${index}`;
    const bytes = Buffer.from(`Independently fictional retained original ${index}. Ω\n`);
    const hash = sha(bytes);
    const publicOperation = 'public-fictional-operation-' + index;
    const intake = {
      originalName: `fictional-${index}.txt`,
      version: 7,
      state: 'pending',
      sourceTextRevisionId: null,
      sourceTextDependencyToken: null,
      proposals: [
        {
          id: 'proposal-' + index,
          fileId: id,
          createdAt: '2026-01-12T00:00:00.000Z',
          summary: 'Fictional pending proposal',
        },
      ],
      acceptedProposalId: null,
      imported: null,
      workflow: {
        format: 'health-intake-workflow-v1',
        questions: [
          { id: 'question-' + index, question: 'Fictional unresolved question', answer: null },
        ],
        candidates: [
          {
            id: 'candidate-' + index,
            versionId: 'candidate-version-' + index,
            recordId: 'pending-record-' + index,
          },
        ],
        plans: [
          {
            id: 'plan-' + index,
            units: [{ id: 'unit-' + index, locator: 'Fictional page 1', status: 'pending' }],
          },
        ],
        reviewDrafts: [
          {
            id: 'draft-' + index,
            proposalId: 'proposal-' + index,
            recordId: 'pending-record-' + index,
            candidateId: 'candidate-' + index,
            candidateVersionId: 'candidate-version-' + index,
            disposition: 'review_later',
            mapping: { valueText: '12.00' },
            at: '2026-01-12T00:00:00.000Z',
          },
        ],
        decisions: [
          {
            id: 'decision-' + index,
            candidateId: 'prior-candidate-' + index,
            candidateVersionId: 'prior-version-' + index,
            recordId: 'prior-record-' + index,
            action: 'accept',
            mapping: { valueText: '10.00' },
            scope: 'record',
            at: '2026-01-11T00:00:00.000Z',
          },
        ],
        reportAcceptances: [
          {
            fingerprint: 'fictional-public-fingerprint',
            receipt: {
              version: 1,
              operationId: publicOperation,
              status: 'completed',
              at: '2026-01-11T00:00:00.000Z',
              receipts: [{ id: 'public-receipt-' + index, recordId: 'prior-record-' + index }],
            },
          },
        ],
      },
      unknownFuture: { second: literal, first: null },
    };
    // These durable/search bytes deliberately differ from normalized selected state.
    const raw = ` { "before" : {"escaped":"\\u03A9","duplicate":1,"duplicate":2}, "intake" : ${JSON.stringify(intake)}, "after" : "fictional" }\n`;
    const state = JSON.parse(raw) as Record<string, unknown>;
    source
      .prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      )
      .run(
        id,
        `data/profiles/${sourceId}/sources/${index}.txt`,
        hash,
        bytes.length,
        'intake_original',
        raw,
      );
    writeIntakeSourcePin(source, id, {
      revisionId: 'pin-revision-' + index,
      dependencyToken: 'pin-token-' + index,
      requiresInterpretation: true,
      version: 3,
    });
    mkdirSync(join(root, 'source-originals'), { recursive: true });
    writeFileSync(join(root, 'source-originals', id), bytes);
    originals.push({ id, hash, bytes, raw, state, operationId: randomUUID() });
  }
  source
    .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
    .run('unrelated-fictional-metadata', '{"b":2,"a":1}');
  if (count) {
    source.exec(
      "INSERT INTO providers(id,name) VALUES('fictional-clinic','Fictional Clinic'); INSERT INTO test_types(id,label) VALUES('fictional-type','Fictional accepted reach')",
    );
    source
      .prepare('INSERT INTO source_records(id,source_file_id,raw_json) VALUES(?,?,?)')
      .run('fictional-accepted-source', originals[0]!.id, '{"literal":"10.00"}');
    source
      .prepare(
        'INSERT INTO observations(id,test_type_id,source_record_id,label,value_text,value_numeric,unit) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        'fictional-accepted-observation',
        'fictional-type',
        'fictional-accepted-source',
        'Fictional accepted reach',
        '10.00',
        10,
        'cm',
      );
  }
  attachRecordDurability(source, { profileId: sourceId, storage: sourceAuthority.storage });
  for (const original of originals) {
    const store = createIntakeStateStorage(source, {
      profileId: sourceId,
      intakeId: original.id,
      sourceHash: original.hash,
    });
    store.mutate(original.state, original.operationId);
    const reordered = {
      after: original.state.after,
      before: original.state.before,
      intake: original.state.intake,
    };
    store.mutate(reordered, randomUUID());
    const intake = reordered.intake as Record<string, unknown>;
    const future = intake.unknownFuture as Record<string, unknown>;
    original.state = {
      ...reordered,
      intake: {
        ...intake,
        unknownFuture: { ...future, second: String(future.second) + 'Fictional appended state.' },
      },
    };
    store.mutate(original.state, randomUUID());
  }
  const target = open('target.sqlite', targetId);
  // A staged fictional copy, deliberately without record projection/durability tables.
  for (const table of ['providers', 'source_files', 'source_records', 'test_types', 'observations'])
    for (const row of rows(source, table)) {
      const keys = Object.keys(row);
      target
        .prepare(
          `INSERT INTO "${table}"(${keys.map((key) => `"${key}"`).join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
        )
        .run(...(Object.values(row) as SQLInputValue[]));
    }
  for (const row of rows(source, 'app_meta'))
    if (row.key !== 'owner_profile_id')
      target
        .prepare(
          'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(row.key!, row.value!);
  target
    .prepare('UPDATE source_files SET path=replace(path,?,?)')
    .run(`data/profiles/${sourceId}/`, `data/profiles/${targetId}/`);
  for (const original of originals) {
    mkdirSync(join(root, 'target-originals'), { recursive: true });
    writeFileSync(join(root, 'target-originals', original.id), original.bytes);
  }
  const options = {
    profileId: targetId,
    readSelectedHead: () => targetAuthority.storage.read('head'),
  };
  return { root, source, target, sourceAuthority, targetAuthority, originals, options, open };
}

test('preparation is side-effect-free, handles multiple/empty sources and distinguishes detached evidence from current authority', (t) => {
  const f = fixture(t);
  const beforeSource = snapshot(f.source);
  const beforeTarget = snapshot(f.target);
  const beforeAuthority = acceptedSnapshot(f.sourceAuthority.objects);
  const input = detached(f.source);
  const inputBytes = JSON.stringify(input);
  const pure = prepareIntakeStateCopySnapshot(input, targetId);
  const live = prepareIntakeStateCopy(f.source, sourceId, targetId);
  assert.equal(pure.counters.namespaces, 2);
  assert.equal(live.counters.namespaces, 2);
  assert.ok(live.counters.preparedRows > 6);
  assert.ok(
    live.counters.preparedFrameBytes > 100_000,
    'one-time complete state preparation is disclosed',
  );
  assert.equal(JSON.stringify(input), inputBytes, 'preparation never changes its input snapshot');
  assert.deepEqual(snapshot(f.source), beforeSource);
  assert.deepEqual(snapshot(f.target), beforeTarget);
  assert.deepEqual(f.sourceAuthority.objects, beforeAuthority);
  assert.equal(f.targetAuthority.objects.size, 0);
  f.source
    .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
    .run('fictional-direct-uncommitted-write', 'not accepted');
  assert.equal(
    recordDurabilityStatus(f.source)?.dirty,
    false,
    'status alone does not detect direct SQL changes',
  );
  assert.throws(
    () => prepareIntakeStateCopy(f.source, sourceId, targetId),
    /direct writes|transaction boundary/,
  );
  assert.equal(
    prepareIntakeStateCopySnapshot(input, targetId).counters.namespaces,
    2,
    'detached validation makes no claim about current source publication',
  );
  assert.throws(
    () => prepareIntakeStateCopy(f.target, targetId, 'another-fictional-target'),
    /durability|attached|configured/i,
  );
});

test('empty retained namespace inventory bootstraps without inventing operational state', (t) => {
  const f = fixture(t, 0);
  const plan = prepareIntakeStateCopy(f.source, sourceId, targetId);
  assert.equal(plan.counters.namespaces, 0);
  assert.equal(plan.counters.preparedRows, 0);
  const before = snapshot(f.target);
  transaction(f.target, () => stageIntakeStateCopy(f.target, plan, f.options));
  assert.deepEqual(
    withoutTransactionCounters(snapshot(f.target)),
    withoutTransactionCounters(before),
  );
  assert.equal(f.targetAuthority.objects.size, 0);
  attachRecordDurability(f.target, { profileId: targetId, storage: f.targetAuthority.storage });
  assert.ok(f.targetAuthority.storage.read('head'));
});

test('complete namespace inventory rejects wrong identities, unsupported chains and unconsumed evidence without writes', async (t) => {
  const mutations: [string, (input: IntakeStateCopySnapshot) => void][] = [
    [
      'wrong-profile',
      (input) => {
        input.sourceProfileId = 'wrong-fictional-profile';
      },
    ],
    [
      'missing-original',
      (input) => {
        input.originals.pop();
      },
    ],
    [
      'duplicate-original',
      (input) => {
        input.originals.push({ ...input.originals[0]! });
      },
    ],
    [
      'duplicate-contribution',
      (input) => {
        input.rows.push({ ...input.rows[0]! });
      },
    ],
    [
      'wrong-kind',
      (input) => {
        input.originals[0]!.kind = 'source';
      },
    ],
    [
      'wrong-source-id',
      (input) => {
        input.originals[0]!.id = 'wrong-source';
      },
    ],
    [
      'wrong-original-hash',
      (input) => {
        input.originals[0]!.sha256 = 'b'.repeat(64);
      },
    ],
    [
      'wrong-source-path',
      (input) => {
        input.originals[0]!.path = 'data/profiles/foreign/sources/wrong.txt';
      },
    ],
    [
      'corrupt-source-pin',
      (input) => {
        input.originals[0]!.sourcePin = '{"version":0}';
      },
    ],
    [
      'missing-head',
      (input) => {
        input.rows = input.rows.filter((row) => !row.key.endsWith(':head'));
      },
    ],
    [
      'missing-frame',
      (input) => {
        input.rows.splice(
          input.rows.findIndex((row) => row.key.includes(':frame:')),
          1,
        );
      },
    ],
    [
      'missing-receipt',
      (input) => {
        input.rows.splice(
          input.rows.findIndex((row) => row.key.includes(':operation:')),
          1,
        );
      },
    ],
    [
      'corrupt-frame',
      (input) => {
        input.rows.find((row) => row.key.includes(':frame:'))!.value += ' ';
      },
    ],
    [
      'unsupported-v1-head',
      (input) => {
        const row = input.rows.find((row) => row.key.endsWith(':head'))!;
        const head = JSON.parse(row.value);
        head.format = 'health-intake-state-v1';
        row.value = JSON.stringify(head);
      },
    ],
    [
      'unknown-namespace',
      (input) => {
        input.rows.push({ key: 'intake_state_unknown:foreign:head', value: '{}' });
      },
    ],
    [
      'headless-namespace',
      (input) => {
        input.rows.push({
          key: 'intake_state_v1:' + 'f'.repeat(64) + ':frame:' + randomUUID(),
          value: '{}',
        });
      },
    ],
    [
      'foreign-owner-namespace',
      (input) => {
        const row = input.rows.find((row) => row.key.endsWith(':head'))!;
        const head = JSON.parse(row.value);
        head.profileId = targetId;
        input.rows.push({
          key: namespace(targetId, input.originals[0]!.id, input.originals[0]!.sha256) + 'head',
          value: JSON.stringify(head),
        });
      },
    ],
    [
      'unconsumed-frame',
      (input) => {
        const row = input.rows.find((row) => row.key.includes(':frame:'))!;
        input.rows.push({ key: row.key.replace(/[^:]+$/, randomUUID()), value: row.value });
      },
    ],
    [
      'unconsumed-receipt',
      (input) => {
        const row = input.rows.find((row) => row.key.includes(':operation:'))!;
        input.rows.push({ key: row.key.replace(/[^:]+$/, randomUUID()), value: row.value });
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    await t.test(name, (child) => {
      const f = fixture(child);
      const sourceBefore = snapshot(f.source);
      const targetBefore = snapshot(f.target);
      const authorityBefore = acceptedSnapshot(f.sourceAuthority.objects);
      const input = detached(f.source);
      mutate(input);
      const inputBefore = JSON.stringify(input);
      assert.throws(() => prepareIntakeStateCopySnapshot(input, targetId));
      assert.equal(JSON.stringify(input), inputBefore);
      assert.deepEqual(snapshot(f.source), sourceBefore);
      assert.deepEqual(snapshot(f.target), targetBefore);
      assert.deepEqual(f.sourceAuthority.objects, authorityBefore);
      assert.equal(f.targetAuthority.objects.size, 0);
    });
});

test('live preparation validates cold evidence rather than trusting a cached runtime value', (t) => {
  const f = fixture(t, 1);
  const original = f.originals[0]!;
  const runtime = createIntakeStateStorage(f.source, {
    profileId: sourceId,
    intakeId: original.id,
    sourceHash: original.hash,
  });
  assert.equal(runtime.readSerialized(), JSON.stringify(original.state));
  const frame = f.source
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:frame:*' LIMIT 1")
    .get()!;
  transaction(f.source, () =>
    f.source
      .prepare('UPDATE app_meta SET value=? WHERE key=?')
      .run(String(frame.value) + ' ', frame.key!),
  );
  const sourceBefore = snapshot(f.source);
  const acceptedBefore = acceptedSnapshot(f.sourceAuthority.objects);
  assert.throws(() => prepareIntakeStateCopy(f.source, sourceId, targetId), /hash|bytes|corrupt/i);
  assert.deepEqual(snapshot(f.source), sourceBefore);
  assert.deepEqual(f.sourceAuthority.objects, acceptedBefore);
  assert.equal(f.targetAuthority.objects.size, 0);
});

test('staging guards reject conflicts, partial installs, selected heads and retained publications', async (t) => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      'changed-original-hash',
      (f) => {
        f.target
          .prepare('UPDATE source_files SET sha256=? WHERE id=?')
          .run('c'.repeat(64), f.originals[0]!.id);
      },
    ],
    [
      'changed-original-kind',
      (f) => {
        f.target
          .prepare('UPDATE source_files SET kind=? WHERE id=?')
          .run('source', f.originals[0]!.id);
      },
    ],
    [
      'extra-intake-original',
      (f) => {
        f.target
          .prepare(
            'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
          )
          .run(
            'fictional-extra-intake',
            `data/profiles/${targetId}/sources/extra.txt`,
            'd'.repeat(64),
            1,
            'intake_original',
            '{}',
          );
      },
    ],
    [
      'changed-raw-details',
      (f) => {
        f.target
          .prepare('UPDATE source_files SET details_json=? WHERE id=?')
          .run(f.originals[0]!.raw.trim(), f.originals[0]!.id);
      },
    ],
    [
      'changed-target-path',
      (f) => {
        f.target
          .prepare('UPDATE source_files SET path=? WHERE id=?')
          .run(`data/profiles/${targetId}/sources/other.txt`, f.originals[0]!.id);
      },
    ],
    [
      'source-owned-target-path',
      (f) => {
        f.target
          .prepare('UPDATE source_files SET path=? WHERE id=?')
          .run(`data/profiles/${sourceId}/sources/0.txt`, f.originals[0]!.id);
      },
    ],
    [
      'changed-preserved-bytes',
      (f) => {
        f.target
          .prepare('UPDATE source_files SET bytes=bytes+1 WHERE id=?')
          .run(f.originals[0]!.id);
      },
    ],
    [
      'changed-target-pin',
      (f) => {
        f.target
          .prepare('UPDATE app_meta SET value=? WHERE key=?')
          .run(
            '{"revisionId":"other","dependencyToken":null,"requiresInterpretation":false,"version":4}',
            'intake_source_pin:v1:' + f.originals[0]!.id,
          );
      },
    ],
    [
      'corrupt-target-pin',
      (f) => {
        f.target
          .prepare('UPDATE app_meta SET value=? WHERE key=?')
          .run('not-json', 'intake_source_pin:v1:' + f.originals[0]!.id);
      },
    ],
    [
      'missing-copied-contribution',
      (f) => {
        f.target
          .prepare(
            "DELETE FROM app_meta WHERE key=(SELECT key FROM app_meta WHERE key GLOB 'intake_state_v1:*:frame:*' LIMIT 1)",
          )
          .run();
      },
    ],
    [
      'target-namespace-conflict',
      (f) => {
        f.target
          .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
          .run(namespace(targetId, f.originals[0]!.id, f.originals[0]!.hash) + 'head', '{}');
      },
    ],
    [
      'unknown-extra-namespace',
      (f) => {
        f.target
          .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
          .run('intake_state_unknown:head', '{}');
      },
    ],
    [
      'malformed-selected-head',
      (f) => {
        f.targetAuthority.objects.set('head', Buffer.from('not-json'));
      },
    ],
    [
      'retained-record-table',
      (f) => {
        f.target.exec(
          'CREATE TABLE __record_state (singleton INTEGER PRIMARY KEY, head_json TEXT)',
        );
      },
    ],
  ];
  for (const [name, alter] of cases)
    await t.test(name, (child) => {
      const f = fixture(child);
      const plan = prepareIntakeStateCopy(f.source, sourceId, targetId);
      alter(f);
      const before = snapshot(f.target);
      const authority = acceptedSnapshot(f.targetAuthority.objects);
      assert.throws(() =>
        transaction(f.target, () => stageIntakeStateCopy(f.target, plan, f.options)),
      );
      assert.deepEqual(snapshot(f.target), before);
      assert.deepEqual(f.targetAuthority.objects, authority);
    });
});

test('staging requires the caller transaction, poisons caught failure and rolls back all copied evidence', (t) => {
  const f = fixture(t);
  const plan = prepareIntakeStateCopy(f.source, sourceId, targetId);
  const before = snapshot(f.target);
  assert.throws(() => stageIntakeStateCopy(f.target, plan, f.options), /transaction/i);
  assert.throws(
    () =>
      transaction(f.target, () => {
        stageIntakeStateCopy(f.target, plan, f.options);
        throw Error('fictional outer bootstrap rollback');
      }),
    /fictional outer bootstrap rollback/,
  );
  assert.deepEqual(snapshot(f.target), before);
  f.target.exec(
    "CREATE TEMP TRIGGER reject_bootstrap BEFORE INSERT ON app_meta WHEN NEW.key GLOB 'intake_state_v1:*' BEGIN SELECT RAISE(ABORT,'fictional bootstrap SQL failure'); END",
  );
  assert.throws(
    () =>
      transaction(f.target, () => {
        f.target
          .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
          .run('fictional-unrelated-staged', 'must roll back');
        try {
          stageIntakeStateCopy(f.target, plan, f.options);
        } catch {}
        return { bounded: true };
      }),
    /fictional bootstrap SQL failure/,
  );
  f.target.exec('DROP TRIGGER reject_bootstrap');
  assert.deepEqual(snapshot(f.target), before);
  assert.equal(f.targetAuthority.objects.size, 0);
  assert.throws(
    () =>
      transaction(f.target, () =>
        stageIntakeStateCopy(f.target, plan, { ...f.options, profileId: sourceId }),
      ),
    /owner|profile|target/i,
  );
});

test('fabricated or deserialized plans fail capability validation and poison a caught outer transaction', (t) => {
  const f = fixture(t);
  const prepared = prepareIntakeStateCopy(f.source, sourceId, targetId);
  const before = snapshot(f.target);
  const sourceBefore = snapshot(f.source);
  for (const forged of [{ ...prepared }, JSON.parse(JSON.stringify(prepared)) as typeof prepared]) {
    assert.throws(
      () => stageIntakeStateCopy(f.target, forged, f.options),
      /unrecognized copy plan/i,
    );
    assert.throws(
      () =>
        transaction(f.target, () => {
          f.target
            .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
            .run('fictional-forged-plan-staged', 'must roll back');
          try {
            stageIntakeStateCopy(f.target, forged, f.options);
          } catch {}
          return { bounded: true };
        }),
      /unrecognized copy plan/i,
      'catching a forged plan cannot commit unrelated staged writes',
    );
    assert.deepEqual(snapshot(f.target), before);
    assert.deepEqual(snapshot(f.source), sourceBefore);
    assert.equal(f.targetAuthority.objects.size, 0);
  }
});

test('non-record transaction durability hooks also disqualify an unpublished bootstrap target', (t) => {
  const f = fixture(t);
  const plan = prepareIntakeStateCopy(f.source, sourceId, targetId);
  const before = snapshot(f.target);
  let prepares = 0;
  registerTransactionDurability(f.target, {
    capture: () => true,
    prepare: () => {
      prepares++;
    },
  });
  assert.equal(
    recordDurabilityStatus(f.target),
    null,
    'these hooks do not certify accepted record durability',
  );
  assert.equal(
    f.target
      .prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name GLOB '__record_*'")
      .get()!.n,
    0,
  );
  assert.throws(
    () =>
      transaction(f.target, () => {
        f.target
          .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
          .run('fictional-hook-target-staged', 'must roll back');
        try {
          stageIntakeStateCopy(f.target, plan, f.options);
        } catch {}
        return { bounded: true };
      }),
    /durability|unpublished/i,
  );
  assert.equal(prepares, 0, 'rejected bootstrap cannot prepare an outer durable commit');
  assert.deepEqual(snapshot(f.target), before);
  assert.equal(f.targetAuthority.objects.size, 0);
});

test('postwrite original/pin/inventory corruption rolls back the complete installation', async (t) => {
  for (const [name, statement] of [
    [
      'extra-namespace',
      "INSERT INTO app_meta(key,value) VALUES('intake_state_unknown:postwrite','{}')",
    ],
    ['changed-source-row', "UPDATE source_files SET bytes=bytes+1 WHERE id='fictional-intake-0'"],
    [
      'changed-pin',
      "UPDATE app_meta SET value='{}' WHERE key='intake_source_pin:v1:fictional-intake-0'",
    ],
  ] as const)
    await t.test(name, (child) => {
      const f = fixture(child);
      const plan = prepareIntakeStateCopy(f.source, sourceId, targetId);
      const before = snapshot(f.target);
      f.target.exec(
        `CREATE TEMP TRIGGER corrupt_bootstrap AFTER INSERT ON app_meta WHEN NEW.key GLOB 'intake_state_v1:*:head' BEGIN ${statement}; END`,
      );
      assert.throws(() =>
        transaction(f.target, () => stageIntakeStateCopy(f.target, plan, f.options)),
      );
      assert.deepEqual(snapshot(f.target), before);
      assert.equal(f.targetAuthority.objects.size, 0);
    });
});

test('a selected backend head appearing after SQL staging refuses acknowledgement and preserves that head', (t) => {
  const f = fixture(t);
  const plan = prepareIntakeStateCopy(f.source, sourceId, targetId);
  const before = snapshot(f.target);
  let reads = 0;
  const externallySelected = Buffer.from('fictional-nonnull-selected-head');
  assert.throws(
    () =>
      transaction(f.target, () =>
        stageIntakeStateCopy(f.target, plan, {
          profileId: targetId,
          readSelectedHead() {
            if (++reads === 2) f.targetAuthority.objects.set('head', externallySelected);
            return f.targetAuthority.storage.read('head');
          },
        }),
      ),
    /published|selected|head|unpublished/i,
  );
  assert.ok(reads >= 2);
  assert.deepEqual(snapshot(f.target), before);
  assert.deepEqual(f.targetAuthority.storage.read('head'), externallySelected);
});

test('preparation limits reject cumulative scope before any destination write', (t) => {
  const f = fixture(t);
  const input = detached(f.source);
  const sourceBefore = snapshot(f.source);
  const targetBefore = snapshot(f.target);
  for (const limits of [
    { namespaces: 1 },
    { rows: 1 },
    { bytes: 1024 },
    { nodes: 1 },
    { operations: 1 },
    { stringWork: 1 },
  ])
    assert.throws(
      () => prepareIntakeStateCopySnapshot(input, targetId, { limits }),
      /limit|budget|decoded|bounds|aggregate preparation/i,
    );
  assert.deepEqual(snapshot(f.source), sourceBefore);
  assert.deepEqual(snapshot(f.target), targetBefore);
  assert.equal(f.targetAuthority.objects.size, 0);
});

test('understated retained work cannot bypass remaining preparation decode budgets', (t) => {
  const f = fixture(t);
  const input = detached(f.source);
  for (const row of input.rows.filter((entry) => entry.key.endsWith(':head'))) {
    const head = JSON.parse(row.value);
    head.usage.nodes = 0;
    head.usage.operations = 0;
    head.usage.stringWork = 0;
    row.value = JSON.stringify(head);
  }
  const beforeSource = snapshot(f.source);
  const beforeTarget = snapshot(f.target);
  assert.throws(
    () => prepareIntakeStateCopySnapshot(input, targetId, { limits: { nodes: 1 } }),
    /decoded work limit/i,
  );
  assert.deepEqual(snapshot(f.source), beforeSource);
  assert.deepEqual(snapshot(f.target), beforeTarget);
  assert.equal(f.targetAuthority.objects.size, 0);
});

test('unrelated non-intake sources remain unchanged through bootstrap publication and recovery', (t) => {
  const f = fixture(t, 1);
  const plan = prepareIntakeStateCopy(f.source, sourceId, targetId);
  f.target
    .prepare('INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)')
    .run(
      'fictional-unrelated-source',
      `data/profiles/${targetId}/sources/unrelated.txt`,
      'e'.repeat(64),
      19,
      'source',
      ' {"untouched" : "fictional unrelated source"} ',
    );
  const unrelated = f.target
    .prepare('SELECT * FROM source_files WHERE id=?')
    .get('fictional-unrelated-source');
  transaction(f.target, () => stageIntakeStateCopy(f.target, plan, f.options));
  assert.deepEqual(
    f.target.prepare('SELECT * FROM source_files WHERE id=?').get('fictional-unrelated-source'),
    unrelated,
  );
  attachRecordDurability(f.target, { profileId: targetId, storage: f.targetAuthority.storage });
  const accepted = acceptedSnapshot(f.targetAuthority.objects);
  rebuildRecordDatabase(join(f.root, 'unrelated-rebuilt.sqlite'), {
    profileId: targetId,
    storage: f.targetAuthority.storage,
  });
  const rebuilt = f.open('unrelated-rebuilt.sqlite', targetId);
  attachRecordDurability(rebuilt, { profileId: targetId, storage: f.targetAuthority.storage });
  assert.deepEqual(
    rebuilt.prepare('SELECT * FROM source_files WHERE id=?').get('fictional-unrelated-source'),
    unrelated,
  );
  assert.deepEqual(f.targetAuthority.objects, accepted);
});

test('first real publication selects fresh current-format target evidence and preserves public/pin/clinical state through independent recovery', (t) => {
  const f = fixture(t);
  transaction(f.source, () => {
    for (const original of f.originals)
      f.source
        .prepare('UPDATE source_files SET details_json=? WHERE id=?')
        .run(prepareInitialIntakeEnvelope(original.state).detailsJson, original.id);
  });
  for (const original of f.originals)
    f.target
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(prepareInitialIntakeEnvelope(original.state).detailsJson, original.id);
  const plan = prepareIntakeStateCopy(f.source, sourceId, targetId);
  const sourceBefore = snapshot(f.source);
  const sourceAuthorityBefore = acceptedSnapshot(f.sourceAuthority.objects);
  const selectedSourceRows = detached(f.source).rows;
  const sourceInternalIds = new Set(
    selectedSourceRows
      .filter((row) => row.key.includes(':frame:') || row.key.includes(':operation:'))
      .map((row) => row.key.split(':').at(-1)!),
  );
  const targetScope = (original: (typeof f.originals)[number]) => ({
    profileId: targetId,
    intakeId: original.id,
    sourceHash: original.hash,
  });
  assert.throws(
    () => createIntakeStateStorage(f.target, targetScope(f.originals[0]!)).readSerialized(),
    /configured|authority/,
  );
  transaction(f.target, () => {
    f.target
      .prepare('UPDATE source_files SET path=replace(path,?,?)')
      .run(`data/profiles/${sourceId}/`, `data/profiles/${targetId}/`);
    stageIntakeStateCopy(f.target, plan, f.options);
  });
  assert.equal(
    f.targetAuthority.objects.size,
    0,
    'installation never claims temporary accepted authority',
  );
  assert.throws(
    () => createIntakeStateStorage(f.target, targetScope(f.originals[0]!)).readSerialized(),
    /configured|authority/,
  );
  const targetRows = f.target
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_*' ORDER BY key")
    .all();
  for (const row of targetRows) {
    assert.ok(
      !selectedSourceRows.some((sourceRow) => sourceRow.key === row.key),
      'no source replay namespace selected',
    );
    if (String(row.key).includes(':frame:') || String(row.key).endsWith(':head')) {
      const value = JSON.parse(String(row.value));
      assert.equal(value.profileId, targetId);
      assert.equal(value.format, 'health-intake-state-v2');
      const original = f.originals.find((entry) => entry.id === value.intakeId)!;
      assert.equal(value.sourceHash, original.hash);
      assert.ok(String(row.key).startsWith(namespace(targetId, original.id, original.hash)));
      assert.ok(
        Buffer.byteLength(String(row.value)) <=
          (String(row.key).endsWith(':head') ? 4096 : 64 * 1024),
      );
      if (value.id) assert.equal(sourceInternalIds.has(value.id), false, 'frame IDs are fresh');
      if (value.operationId)
        assert.equal(
          sourceInternalIds.has(value.operationId),
          false,
          'bootstrap operation IDs are fresh',
        );
      if (value.previous) assert.equal(sourceInternalIds.has(value.previous.id), false);
    } else assert.ok(Buffer.byteLength(String(row.value)) <= 4096);
  }
  const checkDomain = (db: Database) => {
    for (const original of f.originals) {
      assert.equal(
        createIntakeStateStorage(db, targetScope(original)).readSerialized(),
        JSON.stringify(original.state),
      );
      const file = db
        .prepare('SELECT id,kind,details_json FROM source_files WHERE id=?')
        .get(original.id)! as { id: string; kind: string; details_json: string };
      assert.equal(
        readIntakeEnvelopeText(db, file),
        JSON.stringify(original.state),
        'complete normalized envelope and original intake slot order stay exact',
      );
      const pin = readIntakeSourcePin(db, original.id)!;
      assert.deepEqual(pin, readIntakeSourcePin(f.source, original.id));
      assert.equal(storedIntakeDetails(db, file)!.version, 7);
      assert.equal(intakeDetails(db, { ...file, source_pin: JSON.stringify(pin) }).version, 10);
      assert.equal(sha(readFileSync(join(f.root, 'target-originals', original.id))), original.hash);
      assert.equal(sha(readFileSync(join(f.root, 'source-originals', original.id))), original.hash);
      const sourcePinRaw = f.source
        .prepare('SELECT value FROM app_meta WHERE key=?')
        .get('intake_source_pin:v1:' + original.id)!.value;
      assert.equal(
        db
          .prepare('SELECT value FROM app_meta WHERE key=?')
          .get('intake_source_pin:v1:' + original.id)!.value,
        sourcePinRaw,
      );
    }
    assert.deepEqual(rows(db, 'observations'), rows(f.source, 'observations'));
    assert.deepEqual(rows(db, 'source_records'), rows(f.source, 'source_records'));
    assert.equal(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get('unrelated-fictional-metadata')!
        .value,
      '{"b":2,"a":1}',
    );
  };
  attachRecordDurability(f.target, { profileId: targetId, storage: f.targetAuthority.storage });
  assert.ok(
    f.targetAuthority.storage.read('head'),
    'first actual accepted-record publication occurs only after installation',
  );
  checkDomain(f.target);
  const targetAuthorityBefore = acceptedSnapshot(f.targetAuthority.objects);
  clearIntakeStateCache(f.target);
  f.target.close();
  const reopened = f.open('target.sqlite', targetId);
  attachRecordDurability(reopened, { profileId: targetId, storage: f.targetAuthority.storage });
  checkDomain(reopened);
  clearIntakeStateCache(reopened);
  reopened.close();
  rmSync(join(f.root, 'target.sqlite'));
  for (const suffix of ['-wal', '-shm'])
    rmSync(join(f.root, 'target.sqlite' + suffix), { force: true });
  rebuildRecordDatabase(join(f.root, 'target.sqlite'), {
    profileId: targetId,
    storage: f.targetAuthority.storage,
  });
  const rebuilt = f.open('target.sqlite', targetId);
  attachRecordDurability(rebuilt, { profileId: targetId, storage: f.targetAuthority.storage });
  checkDomain(rebuilt);
  assert.deepEqual(
    f.targetAuthority.objects,
    targetAuthorityBefore,
    'rebuild only projects selected target authority',
  );
  const original = f.originals[0]!;
  const store = createIntakeStateStorage(rebuilt, targetScope(original));
  const beforeFrames = store.counters.frameBytesWritten;
  const next = { ...original.state, fictionalTargetOnly: true };
  store.mutate(next, original.operationId);
  assert.equal(store.readSerialized(), JSON.stringify(next));
  assert.ok(
    store.counters.frameBytesWritten - beforeFrames < 4096,
    'subsequent target edit is changed-size, not another bootstrap snapshot',
  );
  assert.equal(store.readSerialized(), JSON.stringify(next));
  assert.deepEqual(snapshot(f.source), sourceBefore);
  assert.deepEqual(f.sourceAuthority.objects, sourceAuthorityBefore);
  for (const entry of f.originals)
    assert.equal(
      createIntakeStateStorage(f.source, {
        profileId: sourceId,
        intakeId: entry.id,
        sourceHash: entry.hash,
      }).readSerialized(),
      JSON.stringify(entry.state),
    );
  const publishedBefore = snapshot(rebuilt);
  const publishedAuthority = acceptedSnapshot(f.targetAuthority.objects);
  assert.throws(
    () => transaction(rebuilt, () => stageIntakeStateCopy(rebuilt, plan, f.options)),
    /published|durability|record|unpublished/i,
  );
  assert.deepEqual(snapshot(rebuilt), publishedBefore);
  assert.deepEqual(f.targetAuthority.objects, publishedAuthority);
  clearIntakeStateCache(f.source);
  f.source.close();
  const sourceReopened = f.open('source.sqlite', sourceId);
  attachRecordDurability(sourceReopened, {
    profileId: sourceId,
    storage: f.sourceAuthority.storage,
  });
  const verifySource = (db: Database) => {
    for (const entry of f.originals) {
      assert.equal(
        createIntakeStateStorage(db, {
          profileId: sourceId,
          intakeId: entry.id,
          sourceHash: entry.hash,
        }).readSerialized(),
        JSON.stringify(entry.state),
      );
      assert.equal(readIntakeEnvelopeText(db, { id: entry.id }), JSON.stringify(entry.state));
      assert.equal(readIntakeSourcePin(db, entry.id)!.version, 3);
      assert.equal(sha(readFileSync(join(f.root, 'source-originals', entry.id))), entry.hash);
    }
    assert.deepEqual(rows(db, 'source_files'), sourceBefore.source_files);
    assert.deepEqual(rows(db, 'observations'), sourceBefore.observations);
  };
  verifySource(sourceReopened);
  clearIntakeStateCache(sourceReopened);
  sourceReopened.close();
  rmSync(join(f.root, 'source.sqlite'));
  for (const suffix of ['-wal', '-shm'])
    rmSync(join(f.root, 'source.sqlite' + suffix), { force: true });
  rebuildRecordDatabase(join(f.root, 'source.sqlite'), {
    profileId: sourceId,
    storage: f.sourceAuthority.storage,
  });
  const sourceRebuilt = f.open('source.sqlite', sourceId);
  attachRecordDurability(sourceRebuilt, {
    profileId: sourceId,
    storage: f.sourceAuthority.storage,
  });
  verifySource(sourceRebuilt);
  assert.deepEqual(
    f.sourceAuthority.objects,
    sourceAuthorityBefore,
    'source independently rebuilds without changing authority',
  );
});
