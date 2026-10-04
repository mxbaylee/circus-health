import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction, clinicalReviewRevision } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  iterateIntakeEnvelopeText,
  prepareIntakeEnvelopeFieldMutation,
  stageIntakeEnvelopeFieldMutation,
  intakeEnvelopeFieldAccess,
  projectIntakeEnvelopeMetadata,
  intakeEnvelopeRecordOrder,
  intakeEnvelopePropertyOrder,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { schemaKey } from '../intake-envelope-schema.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
function fixture(t: test.TestContext, input: Record<string, unknown> | string) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-envelope-schema-')),
    identity = {
      profileId: 'fictional-schema',
      intakeId: 'fictional-intake',
      sourceHash: 'c'.repeat(64),
    },
    db = openDatabase(join(root, 'cache.sqlite'), identity.profileId);
  const authority = memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const initial = prepareInitialIntakeEnvelope(input);
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      'fictional.zip',
      identity.sourceHash,
      0,
      'intake_original',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  return {
    db,
    authority,
    path: join(root, 'cache.sqlite'),
    identity,
    source: { id: identity.intakeId, kind: 'intake_original', sha256: identity.sourceHash },
  };
}

test('selected storage handles reuse only current profile/source bindings and expire on cache disposal', async (t) => {
  const { db, source, identity, authority, path } = fixture(t, { intake: { version: 1 } });
  await buildIntakeCollectionEnvelope(db, source);
  const first = selectedEnvelopeStore(db, source).collections,
    before = intakeWorkCounters(db).primitive.handlesCreated;
  for (let index = 0; index < 32; index++)
    assert.equal(selectedEnvelopeStore(db, source).collections, first);
  assert.equal(intakeWorkCounters(db).primitive.handlesCreated, before);
  clearIntakeStateCache(db);
  const next = selectedEnvelopeStore(db, source).collections;
  assert.notEqual(next, first);
  assert.equal(next.binding(next.openView())!.identity.sourceHash, identity.sourceHash);
  for (const [sql, parameter, selected] of [
    ['UPDATE source_files SET sha256=? WHERE id=?', 'd'.repeat(64), source],
    [
      'UPDATE source_files SET id=? WHERE id=?',
      'fictional-other-source',
      { id: 'fictional-other-source' },
    ],
  ] as const) {
    db.exec('SAVEPOINT fictional_rebinding');
    try {
      db.prepare(sql).run(parameter, source.id);
      assert.throws(() => selectedEnvelopeStore(db, selected), /missing|binding|source/);
    } finally {
      db.exec('ROLLBACK TO fictional_rebinding; RELEASE fictional_rebinding');
    }
    assert.equal(selectedEnvelopeStore(db, source).identity.sourceHash, identity.sourceHash);
  }
  db.exec('SAVEPOINT fictional_rebinding');
  try {
    db.prepare(
      "UPDATE app_meta SET value='fictional-other-profile' WHERE key='owner_profile_id'",
    ).run();
    assert.throws(() => selectedEnvelopeStore(db, source), /missing|binding|owner/);
  } finally {
    db.exec('ROLLBACK TO fictional_rebinding; RELEASE fictional_rebinding');
  }
  db.close();
  assert.throws(() => selectedEnvelopeStore(db, source), /not open|closed/);
  const reopened = openDatabase(path, identity.profileId);
  try {
    authority.attach(reopened);
    const selected = selectedEnvelopeStore(reopened, source).collections;
    assert.notEqual(selected, next);
    assert.equal(selected.binding(selected.openView())!.identity.sourceHash, identity.sourceHash);
  } finally {
    clearIntakeStateCache(reopened);
    reopened.close();
  }
});
for (const raw of [false, true])
  test(`schema migration preserves exact ${raw ? 'raw duplicate' : 'normalized unknown'} bytes and paged known scopes`, async (t) => {
    const input = {
      unknown: { untouched: '🌿'.repeat(3000) },
      intake: {
        version: 3,
        originalName: 'fictional.zip',
        workflow: {
          format: 'health-intake-workflow-v1',
          candidates: [
            { id: 'candidate', versions: [{ id: 'version', status: 'pending', occurrences: [] }] },
          ],
          plans: [{ id: 'plan', units: [{ id: 'unit', attempts: ['batch1', 'batch2'] }] }],
        },
        packageFailures: { one: { status: 'pending', message: 'fictional' } },
      },
    };
    const text = raw
        ? ' { "duplicate":1,"duplicate":2,' + JSON.stringify(input).slice(1) + ' \n'
        : JSON.stringify(input),
      { db, source } = fixture(t, raw ? text : input),
      revision = clinicalReviewRevision(db);
    let checkpoints = 0;
    await buildIntakeCollectionEnvelope(db, source, {
      onCheckpoint() {
        checkpoints++;
      },
    });
    assert.ok(checkpoints > 1);
    assert.equal(clinicalReviewRevision(db), revision);
    const before = intakeWorkCounters(db).warm.materializationReads,
      chunks = [...iterateIntakeEnvelopeText(db, source)];
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.every((c) => Buffer.byteLength(c) <= 4096));
    const reader = openIntakeCollectionEnvelope(db, source),
      intake = reader.child(reader.root(), 'intake')!,
      workflow = reader.child(intake, 'workflow')!;
    const candidate = reader.find('candidate', workflow, 'candidate')!;
    assert.equal(reader.field(candidate, 'id').kind, 'value');
    const versions = reader.children(candidate, 'versions', { items: 1, bytes: 1024 });
    assert.equal(versions.total, 1);
    assert.equal(versions.records.length, 1);
    const plan = reader.find('plan', workflow, 'plan')!,
      unit = reader.children(plan, 'units', { items: 1, bytes: 1024 }).records[0]!;
    assert.equal(reader.contains(unit, 'attempts', 'batch2'), true);
    assert.equal(reader.contains(unit, 'attempts', 'absent'), false);
    const failureMap = reader.child(intake, 'packageFailures')!;
    assert.equal(reader.propertyRecords(failureMap, { items: 1, bytes: 1024 }).records.length, 1);
    assert.throws(() => reader.lookup('pending-package-failure', []), /incomplete/);
    assert.equal(intakeWorkCounters(db).warm.materializationReads, before);
    clearIntakeStateCache(db);
    assert.equal([...iterateIntakeEnvelopeText(db, source)].join(''), text);
    const current = openIntakeCollectionEnvelope(db, source),
      nextIntake = current.child(current.root(), 'intake')!,
      operationId = randomUUID();
    const prepared = prepareIntakeEnvelopeFieldMutation(db, source, {
      reader: current,
      record: nextIntake,
      field: 'version',
      jsonText: '4',
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 4,
    });
    transaction(db, () => stageIntakeEnvelopeFieldMutation(db, source, prepared));
    assert.equal(
      [...iterateIntakeEnvelopeText(db, source)].join(''),
      text.replace('"version":3', '"version":4'),
    );
    assert.throws(() => current.field(nextIntake, 'version'), /stale/);
  });

test('addressed mutation creates missing workflow, appends records and atomically selects domain indexes', async (t) => {
  const { db, source, identity } = fixture(t, {
    intake: { version: 0, originalName: 'fictional.zip' },
  });
  await buildIntakeCollectionEnvelope(db, source);
  const { prepareIntakeEnvelopeMutation } = await import('../intake-envelope-mutation.ts');
  const command = async (
    changes: (
      reader: ReturnType<typeof openIntakeCollectionEnvelope>,
    ) => Parameters<typeof prepareIntakeEnvelopeMutation>[2]['changes'],
    version: number,
    operationId = randomUUID(),
  ) => {
    const reader = openIntakeCollectionEnvelope(db, source);
    const result = await prepareIntakeEnvelopeMutation(db, source, {
      reader,
      changes: changes(reader),
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: version,
      additionalLogicalChanges: [
        {
          area: 'logical',
          collection: 'package.active',
          op: 'put',
          key: 'plan',
          value: 'plan' + version,
        },
      ],
    });
    if (result.prepared)
      transaction(db, () =>
        createIntakeStateStorage(db, identity).collections.stage(result.prepared!),
      );
    return result;
  };
  await command(
    (reader) => [
      {
        op: 'set',
        record: reader.child(reader.root(), 'intake')!,
        field: 'workflow',
        jsonText: JSON.stringify({
          format: 'health-intake-workflow-v1',
          plans: [{ id: 'plan0', status: 'pending' }],
        }),
      },
    ],
    1,
  );
  const operationId = randomUUID();
  await command(
    (reader) => [
      {
        op: 'append',
        record: reader.child(reader.child(reader.root(), 'intake')!, 'workflow')!,
        field: 'plans',
        jsonText: JSON.stringify({ id: 'plan1', status: 'pending', units: [] }),
      },
      {
        op: 'append',
        record: reader.child(reader.child(reader.root(), 'intake')!, 'workflow')!,
        field: 'operations',
        jsonText: JSON.stringify({ id: 'op', action: 'plan' }),
      },
    ],
    2,
    operationId,
  );
  const reader = openIntakeCollectionEnvelope(db, source),
    intake = reader.child(reader.root(), 'intake')!,
    workflow = reader.child(intake, 'workflow')!;
  assert.equal(reader.childCount(workflow, 'plans'), 2);
  assert.equal(reader.childCount(workflow, 'operations'), 1);
  assert.ok(reader.find('plan', workflow, 'plan1'));
  assert.deepEqual(reader.field(intake, 'version'), { kind: 'value', value: 2 });
  const old = JSON.stringify(
    createIntakeStateStorage(db, identity).collections.binding(
      createIntakeStateStorage(db, identity).collections.openView(),
    ),
  );
  const replay = await command(() => [], 2, operationId);
  assert.equal(replay.replay?.operationId, operationId);
  assert.equal(
    JSON.stringify(
      createIntakeStateStorage(db, identity).collections.binding(
        createIntakeStateStorage(db, identity).collections.openView(),
      ),
    ),
    old,
  );
  const parsed = JSON.parse([...iterateIntakeEnvelopeText(db, source)].join(''));
  assert.equal(parsed.intake.workflow.plans.length, 2);
  assert.equal(parsed.intake.workflow.operations[0].id, 'op');
});

test('UTF8 fragments advance directly and late corrupt cells cannot produce a complete export', async (t) => {
  const value = '🦊🌿'.repeat(2500),
    { db, source } = fixture(t, {
      intake: { version: 0, workflow: { format: 'health-intake-workflow-v1' } },
      unknown: value,
    });
  await buildIntakeCollectionEnvelope(db, source);
  const reader = openIntakeCollectionEnvelope(db, source),
    record = reader.root();
  let text = '',
    after: string | undefined,
    requests = 0;
  do {
    const page = reader.fieldFragment(record, 'unknown', { after, bytes: 4096 });
    text += page.text;
    requests++;
    if (page.complete) break;
    assert.notEqual(page.after, after);
    after = page.after!;
  } while (true);
  assert.ok(requests > 1);
  assert.equal(JSON.parse(text), value);
  clearIntakeStateCache(db);
  const iterator = iterateIntakeEnvelopeText(db, source);
  assert.equal(iterator.next().done, false);
  const row = [
    ...db.prepare("SELECT key,value FROM app_meta WHERE key LIKE '%:node:%'").iterate(),
  ].find((row) => {
    if (typeof row.value !== 'string') return false;
    const node = JSON.parse(row.value) as { value?: string };
    return (
      typeof node.value === 'string' &&
      Buffer.from(node.value, 'base64').toString('utf8').includes('🦊🌿')
    );
  });
  assert.ok(row);
  db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', row.key!);
  assert.throws(() => [...iterator], /schema|hash|node|reference/);
});

test('explicit SQL-first fields retain shadowed raw occurrences without changing operational last-field reads', async (t) => {
  const raw =
      '{"intake":1,"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportGroups":[{"id":"first"}]},"workflow":{"format":"health-intake-workflow-v1","reportGroups":[{"id":"last"}]}}}',
    { db, source } = fixture(t, raw);
  await buildIntakeCollectionEnvelope(db, source);
  const first = openIntakeCollectionEnvelope(db, source, { fieldSelection: 'first' }),
    last = openIntakeCollectionEnvelope(db, source);
  assert.equal(first.child(first.root(), 'intake'), undefined);
  const intake = last.child(last.root(), 'intake')!,
    workflow = last.child(intake, 'workflow')!;
  assert.deepEqual(last.field(last.childAt(workflow, 'reportGroups', 0)!, 'id'), {
    kind: 'value',
    value: 'last',
  });
  const raw2 =
      '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportGroups":[{"id":"first"}]},"workflow":{"format":"health-intake-workflow-v1","reportGroups":[{"id":"last"}]}}}',
    second = fixture(t, raw2);
  await buildIntakeCollectionEnvelope(second.db, second.source);
  const sql = openIntakeCollectionEnvelope(second.db, second.source, { fieldSelection: 'first' }),
    sqlIntake = sql.child(sql.root(), 'intake')!,
    sqlWorkflow = sql.child(sqlIntake, 'workflow')!,
    record = sql.childAt(sqlWorkflow, 'reportGroups', 0)!;
  assert.deepEqual(sql.field(record, 'id'), { kind: 'value', value: 'first' });
  assert.equal([...sql.recordChunks(record)].join(''), '{"id":"first"}');
});

test('dictionary put/delete keeps unique operational keys and raw duplicate evidence until addressed deletion', async (t) => {
  const raw =
      '{"intake":{"version":0,"packageFailures":{"one":{"status":"old"},"one":{"status":"pending"},"two":{"status":"pending"}},"workflow":{"format":"health-intake-workflow-v1","candidates":[{"id":"same","label":"first"},{"id":"same","label":"second"}]}}}',
    { db, source, identity } = fixture(t, raw);
  await buildIntakeCollectionEnvelope(db, source);
  let reader = openIntakeCollectionEnvelope(db, source),
    intake = reader.child(reader.root(), 'intake')!,
    failures = reader.child(intake, 'packageFailures')!;
  assert.equal(reader.info(failures).count, 2);
  assert.equal(reader.propertyRecords(failures, { items: 10, bytes: 32768 }).records.length, 2);
  const workflow = reader.child(intake, 'workflow')!;
  assert.deepEqual(reader.field(reader.find('candidate', workflow, 'same')!, 'label'), {
    kind: 'value',
    value: 'first',
  });
  const { prepareIntakeEnvelopeMutation } = await import('../intake-envelope-mutation.ts');
  const mutate = async (op: 'put' | 'delete', field: string, text?: string) => {
    reader = openIntakeCollectionEnvelope(db, source);
    intake = reader.child(reader.root(), 'intake')!;
    failures = reader.child(intake, 'packageFailures')!;
    const old = reader.child(failures, 'one');
    const operationId = randomUUID(),
      version = (reader.field(intake, 'version') as { kind: 'value'; value: number }).value + 1;
    const result = await prepareIntakeEnvelopeMutation(db, source, {
      reader,
      changes: [
        op === 'delete'
          ? { op, record: failures, field }
          : { op, record: failures, field, jsonText: text! },
      ],
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: version,
    });
    transaction(db, () =>
      createIntakeStateStorage(db, identity).collections.stage(result.prepared!),
    );
    return old && reader.address.bind(reader, old);
  };
  await mutate('delete', 'one');
  let parsed = JSON.parse([...iterateIntakeEnvelopeText(db, source)].join(''));
  assert.deepEqual(Object.keys(parsed.intake.packageFailures), ['two']);
  await mutate('put', 'three', JSON.stringify({ status: 'pending', message: '🌿'.repeat(4000) }));
  await mutate('put', 'two', JSON.stringify({ status: 'resolved' }));
  parsed = JSON.parse([...iterateIntakeEnvelopeText(db, source)].join(''));
  assert.equal(parsed.intake.packageFailures.two.status, 'resolved');
  assert.equal(parsed.intake.packageFailures.three.message.length, 8000);
  await mutate('delete', 'two');
  await mutate('delete', 'three');
  assert.deepEqual(
    JSON.parse([...iterateIntakeEnvelopeText(db, source)].join('')).intake.packageFailures,
    {},
  );
  await mutate('put', 'last', '{"status":"pending"}');
  assert.deepEqual(
    JSON.parse([...iterateIntakeEnvelopeText(db, source)].join('')).intake.packageFailures,
    { last: { status: 'pending' } },
  );
});

test('addressed field descriptors page giant names and field fragments bridge primitive UTF8 chunk boundaries', async (t) => {
  const name = 'field-🌿'.repeat(40000),
    { db, source, identity } = fixture(
      t,
      JSON.stringify({ intake: { version: 0 }, [name]: 42, unknown: '🌿'.repeat(3000) }),
    );
  await buildIntakeCollectionEnvelope(db, source);
  let reader = openIntakeCollectionEnvelope(db, source),
    root = reader.root(),
    access = intakeEnvelopeFieldAccess(reader),
    after: string | undefined,
    found: string | undefined;
  do {
    const page = access.descriptors(root, { after, items: 4, bytes: 4096 });
    assert.ok(Buffer.byteLength(JSON.stringify(page.fields)) <= 4096);
    for (const field of page.fields)
      if (field.name === undefined) {
        found = field.key;
        assert.ok(field.nameBytes > 256 * 1024);
      }
    if (page.complete) break;
    after = page.after!;
  } while (true);
  assert.ok(found);
  assert.deepEqual(access.value(root, found), { kind: 'value', value: 42 });
  let nameText = '',
    nameAfter: string | undefined;
  do {
    const page = access.nameFragment(root, found, { after: nameAfter, bytes: 4096 });
    assert.ok(Buffer.byteLength(page.text) <= 4096);
    nameText += page.text;
    if (page.complete) break;
    assert.notEqual(page.after, nameAfter);
    nameAfter = page.after!;
  } while (true);
  assert.equal(JSON.parse(nameText), name);
  assert.throws(
    () => access.value(reader.child(root, 'intake')!, found),
    /foreign addressed field/,
  );
  const store = createIntakeStateStorage(db, identity).collections,
    raw = store.get(
      store.openView(),
      'logical',
      'envelope.data',
      'f:' + reader.address(root) + ':' + schemaKey('unknown'),
    );
  assert.equal(typeof raw, 'string');
  const target = JSON.parse(raw as string) as { id: string },
    expected = JSON.stringify('🌿'.repeat(3000)),
    bytes = Buffer.from(expected),
    blob = 'fictional-split-' + randomUUID();
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    const id = randomUUID();
    store.commitMaintenance(
      store.prepare(store.openView(), {
        operationId: id,
        requestDigest: createHash('sha256').update(id).digest('hex'),
        domainVersion: 0,
        changes: [
          {
            area: 'builds',
            collection: blob,
            op: 'appendBytes',
            bytes: bytes.subarray(offset, offset + 4096),
          },
        ],
      }),
    );
  }
  const id = randomUUID(),
    prepared = store.prepare(store.openView(), {
      operationId: id,
      requestDigest: createHash('sha256').update(id).digest('hex'),
      domainVersion: 0,
      changes: [
        {
          area: 'logical',
          collection: 'envelope.data',
          op: 'putBytes',
          key: 'c:' + target.id,
          fromArea: 'builds',
          fromCollection: blob,
        },
      ],
    });
  transaction(db, () => store.stage(prepared));
  reader = openIntakeCollectionEnvelope(db, source);
  root = reader.root();
  let actual = '',
    cursor: string | undefined,
    pages = 0;
  do {
    const page = reader.fieldFragment(root, 'unknown', { after: cursor, bytes: 4096 });
    assert.ok(Buffer.byteLength(page.text) <= 4096);
    actual += page.text;
    pages++;
    if (page.complete) break;
    assert.notEqual(page.after, cursor);
    cursor = page.after!;
  } while (true);
  assert.ok(pages > 2);
  assert.equal(actual, expected);
});

test('compact metadata projector shares exact raw duplicate agreement and projects staged metadata only on demand', async (t) => {
  const raw =
    '{"intake":{"version":0,"originalName":"first.zip","metadata":{"sourceProviderId":"first"}},"intake":{"version":0,"originalName":"second.zip","metadata":{"sourceProviderId":"old"},"metadata":{"sourceProviderId":"effective"},"workflow":{"operations":[]}}}';
  const { db, source } = fixture(t, raw);
  await buildIntakeCollectionEnvelope(db, source);
  const view = openIntakeCollectionEnvelope(db, source),
    old = db.prepare('SELECT details_json FROM source_files WHERE id=?').get(source.id)!
      .details_json as string;
  assert.equal(projectIntakeEnvelopeMetadata(view, { bytes: 8192 }), old);
  assert.throws(() => projectIntakeEnvelopeMetadata(view, { bytes: 30 }), /compact metadata/);
  const { prepareIntakeEnvelopeMutation } = await import('../intake-envelope-mutation.ts');
  const intake = view.child(view.root(), 'intake')!,
    metadata = view.child(intake, 'metadata')!,
    op = randomUUID();
  const prepared = await prepareIntakeEnvelopeMutation(db, source, {
    reader: view,
    operationId: op,
    requestDigest: schemaKey(op),
    domainVersion: 1,
    changes: [{ op: 'set', record: metadata, field: 'sourceProviderId', jsonText: '"new"' }],
  });
  const projected = prepared.projectDetailsJson!({ bytes: 8192 });
  assert.equal(
    projected,
    old.replace('"sourceProviderId":"effective"', '"sourceProviderId":"new"'),
  );
  assert.equal(
    db.prepare('SELECT details_json FROM source_files WHERE id=?').get(source.id)!.details_json,
    old,
  );
  const store = createIntakeStateStorage(db, {
    profileId: 'fictional-schema',
    intakeId: source.id,
    sourceHash: source.sha256,
  }).collections;
  transaction(db, () => {
    store.stage(prepared.prepared!);
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(projected, source.id);
  });
  assert.equal(
    projectIntakeEnvelopeMetadata(openIntakeCollectionEnvelope(db, source), { bytes: 8192 }),
    projected,
  );
});

test('selected record ordinal paths and dictionary property keys retain first insertion and numeric order', async (t) => {
  const giant = 'fictional-'.repeat(5000),
    raw =
      '{"intake":{"version":0,"originalName":"fictional.zip","packageFailures":{"2":{"status":"two"},"1":{"status":"one"},"01":{"status":"leading"},"dup":{"status":"old"},"4294967295":{"status":"not-index"},"dup":{"status":"new"},' +
      JSON.stringify(giant) +
      ':{"status":"giant"}}}}';
  const { db, source } = fixture(t, raw);
  await buildIntakeCollectionEnvelope(db, source);
  const view = openIntakeCollectionEnvelope(db, source),
    intake = view.child(view.root(), 'intake')!,
    map = view.child(intake, 'packageFailures')!;
  assert.deepEqual(intakeEnvelopePropertyOrder(view, view.child(map, '2')!), [0, 2]);
  assert.deepEqual(intakeEnvelopePropertyOrder(view, view.child(map, '01')!), [1, 2]);
  assert.deepEqual(intakeEnvelopePropertyOrder(view, view.child(map, 'dup')!), [1, 3]);
  assert.deepEqual(intakeEnvelopePropertyOrder(view, view.child(map, '4294967295')!), [1, 4]);
  assert.deepEqual(intakeEnvelopePropertyOrder(view, view.child(map, giant)!), [1, 6]);
  assert.deepEqual(intakeEnvelopeRecordOrder(view, view.child(map, 'dup')!), [0, 2, 5]);
  assert.throws(() => intakeEnvelopePropertyOrder(view, view.root()), /property|record/);
});

test('narrow structured replacements and import archive retain untouched descendants', async (t) => {
  const previous = {
      clinical: { records: [{ id: 'saved', evidence: 'fictional '.repeat(18000) }] },
      at: 'old',
    },
    input = {
      intake: {
        version: 1,
        originalName: 'fictional.zip',
        metadata: { provider: 'old', unknown: { retained: true } },
        imported: previous,
        workflow: {
          plans: [{ id: 'p', units: [{ id: 'u', coverage: { kind: 'inspected', notes: 'old' } }] }],
        },
      },
    },
    { db, source, identity } = fixture(t, input);
  await buildIntakeCollectionEnvelope(db, source);
  const { prepareIntakeEnvelopeMutation } = await import('../intake-envelope-mutation.ts'),
    view = openIntakeCollectionEnvelope(db, source),
    intake = view.child(view.root(), 'intake')!,
    receipt = view.child(intake, 'imported')!,
    clinical = view.child(receipt, 'clinical')!,
    retained = view.childAt(clinical, 'records', 0)!,
    retainedAddress = view.address(retained),
    workflow = view.child(intake, 'workflow')!,
    plan = view.find('plan', workflow, 'p')!,
    unit = view.childAt(plan, 'units', 0)!,
    operationId = randomUUID();
  const prepared = await prepareIntakeEnvelopeMutation(db, source, {
    reader: view,
    operationId,
    requestDigest: createHash('sha256').update(operationId).digest('hex'),
    domainVersion: 2,
    changes: [
      {
        op: 'put',
        record: intake,
        field: 'metadata',
        jsonText: JSON.stringify({ provider: 'new', unknown: { retained: true } }),
      },
      {
        op: 'put',
        record: unit,
        field: 'coverage',
        jsonText: JSON.stringify({ kind: 'extracted', notes: 'new' }),
      },
      {
        op: 'archive-current-import',
        record: intake,
        acceptedProposalId: 'old-proposal',
        reviewToken: 'old-token',
      },
      {
        op: 'set',
        record: intake,
        field: 'imported',
        jsonText: JSON.stringify({ at: 'new', clinical: { records: [] } }),
      },
    ],
  });
  const compact = prepared.projectDetailsJson!({ bytes: 32768 });
  transaction(db, () => {
    createIntakeStateStorage(db, identity).collections.stage(prepared.prepared!);
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(compact, source.id);
  });
  clearIntakeStateCache(db);
  const { selectedEnvelopeStore, validateIntakeCollectionEnvelopeRepresentation } =
      await import('../intake-collection-envelope.ts'),
    { intakeNamespace } = await import('../intake-state-evidence.ts'),
    { collections } = selectedEnvelopeStore(db, source),
    head = collections.binding(collections.openView())!;
  validateIntakeCollectionEnvelopeRepresentation(
    compact,
    head,
    (hash) =>
      db
        .prepare('SELECT value FROM app_meta WHERE key=?')
        .get(intakeNamespace(identity) + 'node:' + hash)?.value,
  );
  const selected = openIntakeCollectionEnvelope(db, source),
    next = selected.child(selected.root(), 'intake')!,
    archived = selected.childAt(next, 'importHistory', 0)!,
    saved = selected.childAt(selected.child(archived, 'clinical')!, 'records', 0)!;
  assert.equal(selected.address(saved), retainedAddress);
  const actual = JSON.parse([...iterateIntakeEnvelopeText(db, source)].join(''));
  assert.deepEqual(actual.intake.importHistory, [
    { ...previous, acceptedProposalId: 'old-proposal', reviewToken: 'old-token' },
  ]);
  assert.equal(actual.intake.metadata.provider, 'new');
  assert.deepEqual(actual.intake.metadata.unknown, { retained: true });
  assert.equal(actual.intake.workflow.plans[0].units[0].coverage.kind, 'extracted');
  assert.equal(actual.intake.imported.at, 'new');
  await assert.rejects(
    prepareIntakeEnvelopeMutation(db, source, {
      reader: selected,
      operationId: randomUUID(),
      requestDigest: 'e'.repeat(64),
      domainVersion: 3,
      changes: [{ op: 'put', record: next, field: 'workflow', jsonText: '{}' }],
    }),
    /Put requires addressed dictionary/,
  );
});

test('schema writer batches existing inline cells and preserves exact fragmented bytes after reopening', async (t) => {
  const { db, source, identity, authority, path } = fixture(t, { intake: { version: 1 } });
  await buildIntakeCollectionEnvelope(db, source);
  const { createEnvelopeBuildWriter } = await import('../intake-envelope-build.ts');
  const { collectionCellReader } = await import('../intake-collection-envelope.ts');
  let checkpoints = 0;
  const build = 'fictional-inline-cell-count';
  const writer = createEnvelopeBuildWriter(db, source, build, 1, {
    onCheckpoint() {
      checkpoints++;
    },
  });
  const literal = JSON.stringify('Patient: Fictional alternative ' + 'z'.repeat(3900));
  for (let n = 0; n < 64; n++) {
    if (n % 2) await writer.cellPieces('c:' + n, [literal.slice(0, 700), literal.slice(700)]);
    else await writer.cell('c:' + n, literal);
  }
  await writer.flush();
  assert.equal(checkpoints, 1, '64 supported inline cells publish one bounded checkpoint');
  const first = collectionCellReader(db, source, 'builds', build).store;
  for (let n = 0; n < 64; n++) assert.equal(first.get('c:' + n), literal);
  const escaped = '\\'.repeat(5000),
    giant = 'Fictional 🌿 '.repeat(1400);
  assert.ok(Buffer.byteLength(escaped) < 8192);
  assert.ok(Buffer.byteLength(JSON.stringify({ kind: 'inline', text: escaped })) > 8192);
  await writer.cell('escaped', escaped);
  await writer.cellPieces('giant', [giant.slice(0, 11), giant.slice(11)]);
  await writer.flush();
  const read = (selected: typeof first, key: string) => {
    selected.check();
    const value = selected.get(key);
    assert.ok(value);
    if (typeof value === 'string') return value;
    const parts: Buffer[] = [];
    let after: string | undefined;
    for (;;) {
      const page = selected.chunks(value, after, 4096);
      assert.ok(page.chunks.every((chunk) => chunk.byteLength <= 4096));
      parts.push(...page.chunks);
      if (page.complete) break;
      assert.ok(page.after && page.after !== after);
      after = page.after;
    }
    return Buffer.concat(parts).toString('utf8');
  };
  first.check();
  assert.equal(typeof first.get('escaped'), 'object', 'encoded wrapper overflow stays fragmented');
  assert.equal(read(first, 'escaped'), escaped);
  assert.equal(read(first, 'giant'), giant);
  clearIntakeStateCache(db);
  db.close();
  const reopened = openDatabase(path, identity.profileId);
  try {
    authority.attach(reopened);
    const retained = collectionCellReader(reopened, source, 'builds', build).store;
    assert.equal(retained.get('c:63'), literal);
    assert.equal(read(retained, 'escaped'), escaped);
    assert.equal(read(retained, 'giant'), giant);
  } finally {
    clearIntakeStateCache(reopened);
    reopened.close();
  }
});
