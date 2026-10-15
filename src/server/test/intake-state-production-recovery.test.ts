import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, clinicalReviewRevision, type Database } from '../database.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { rebuildRecordDatabase } from '../record-versions.ts';
import { prepareInitialIntakeEnvelope, readIntakeEnvelopeText } from '../intake-authority.ts';
import { newProfile, vaultFixture } from './helpers/vault-fixture.ts';
import { ensureNativeIntakeSchema, uploadIntake } from '../intake.ts';
import {
  prepareIntakeLookupIndices,
  maximumIntakeDiscoveryOrder,
} from '../intake-lookup-projection.ts';
import { profileOriginal } from '../profile-storage.ts';
import { createProfileLifecycle } from '../profile-lifecycle.ts';
import { rebuildProfile } from '../portable.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { schemaKey } from '../intake-envelope-schema.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { fictionalModel } from './fictional-model.ts';
import {
  createPagedPackagePlan,
  savePagedPackageRoles,
  readPackagePlanScope,
} from '../intake-package-plan.ts';
import type { IntakeCollectionChange } from '../intake-state-collections.ts';
import {
  iterateIntakeEnvelopeText,
  hasIntakeCollectionEnvelope,
  openIntakeCollectionEnvelope,
  prepareIntakeEnvelopeFieldMutation,
  stageIntakeEnvelopeFieldMutation,
} from '../intake-collection-envelope.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeSourcePinKey, writeIntakeSourcePin } from '../intake-source-pin.ts';
import {
  prepareProductionIntakeStateCopy,
  validateProductionIntakeAuthority,
  stageIntakeStateCopy,
  disposeIntakeStateCopyPlan,
} from '../intake-state-bootstrap.ts';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(t: test.TestContext, raw: boolean, unknownKey?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-production-intake-'));
  const identity = {
    profileId: 'fictional-production-source',
    intakeId: 'fictional-package',
    sourceHash: sha('fictional package bytes'),
  };
  const db = openDatabase(join(directory, 'source.sqlite'), identity.profileId),
    authority = memoryRecordAuthority(db);
  const input = {
    ...(unknownKey ? { [unknownKey]: 'Fictional retained unknown field' } : {}),
    unknown: { literal: '🌿'.repeat(3000), order: { second: 2, first: 1 } },
    intake: {
      version: 7,
      originalName: 'fictional.zip',
      state: 'pending',
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: [
          {
            id: 'candidate-public',
            versions: [{ id: 'version-public', status: 'pending', occurrences: [] }],
          },
        ],
        plans: [
          {
            id: 'plan-public',
            units: [{ id: 'unit-public', status: 'pending', attempts: ['attempt-public'] }],
          },
        ],
      },
    },
  };
  const text = raw
    ? ' {"duplicate":1,"duplicate":2,' + JSON.stringify(input).slice(1) + '\n'
    : JSON.stringify(input);
  const initial = prepareInitialIntakeEnvelope(raw ? text : input);
  const operationId = randomUUID();
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json,mime_type) VALUES(?,?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      `data/profiles/${identity.profileId}/sources/fictional.zip`,
      identity.sourceHash,
      23,
      'intake_original',
      initial.detailsJson,
      'application/zip',
    );
    writeIntakeSourcePin(db, identity.intakeId, {
      revisionId: null,
      dependencyToken: null,
      requiresInterpretation: false,
      version: 1,
    });
    createIntakeStateStorage(db, identity).stage(initial.state, operationId);
  });
  const opened = [db];
  t.after(() => {
    for (const item of opened) {
      clearIntakeStateCache(item);
      if (item.isOpen) item.close();
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const source = { id: identity.intakeId, kind: 'intake_original', sha256: identity.sourceHash };
  function rebuild(currentAuthority = authority, profileId = identity.profileId) {
    const path = join(directory, randomUUID() + '.sqlite');
    rebuildRecordDatabase(path, { profileId, storage: currentAuthority.storage });
    const rebuilt = openDatabase(path, profileId);
    opened.push(rebuilt);
    validateProductionIntakeAuthority(rebuilt, profileId);
    currentAuthority.attach(rebuilt);
    return rebuilt;
  }
  return {
    directory,
    identity,
    db,
    source,
    text,
    initial,
    operationId,
    authority,
    opened,
    rebuild,
  };
}
function cloneIntakeRows(
  source: Database,
  target: Database,
  sourceProfile: string,
  targetProfile: string,
) {
  for (const row of source.prepare('SELECT * FROM source_files').iterate()) {
    const columns = Object.keys(row);
    target
      .prepare(
        `INSERT INTO source_files(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
      )
      .run(
        ...columns.map((name) =>
          name === 'path'
            ? String(row[name]).replace(
                `data/profiles/${sourceProfile}/`,
                `data/profiles/${targetProfile}/`,
              )
            : row[name]!,
        ),
      );
  }
  for (const row of source
    .prepare(
      "SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_*' OR key GLOB 'intake_source_pin:*'",
    )
    .iterate())
    target.prepare('INSERT INTO app_meta VALUES(?,?)').run(row.key!, row.value!);
}
for (const raw of [false, true])
  test(`production ${raw ? 'raw' : 'normalized'} bridge/build/adoption copies and rebuilds exact selected evidence`, async (t) => {
    const f = fixture(t, raw),
      revision = clinicalReviewRevision(f.db);
    await buildIntakeCollectionEnvelope(f.db, f.source);
    assert.equal(clinicalReviewRevision(f.db), revision);
    validateProductionIntakeAuthority(f.db, f.identity.profileId);
    assert.equal([...iterateIntakeEnvelopeText(f.db, f.source)].join(''), f.text);
    const rebuilt = f.rebuild();
    assert.equal([...iterateIntakeEnvelopeText(rebuilt, f.source)].join(''), f.text);
    const targetId = 'fictional-production-target',
      target = openDatabase(join(f.directory, 'target.sqlite'), targetId);
    f.opened.push(target);
    const plan = prepareProductionIntakeStateCopy(rebuilt, f.identity.profileId, targetId);
    t.after(() => disposeIntakeStateCopyPlan(plan));
    cloneIntakeRows(rebuilt, target, f.identity.profileId, targetId);
    transaction(target, () =>
      stageIntakeStateCopy(target, plan, { profileId: targetId, readSelectedHead: () => null }),
    );
    validateProductionIntakeAuthority(target, targetId);
    const targetAuthority = memoryRecordAuthority(target);
    const copied = f.rebuild(targetAuthority, targetId);
    assert.equal([...iterateIntakeEnvelopeText(copied, f.source)].join(''), f.text);
    assert.equal(
      copied.prepare('SELECT details_json FROM source_files WHERE id=?').get(f.identity.intakeId)!
        .details_json,
      f.initial.detailsJson,
    );
    assert.equal(
      copied
        .prepare('SELECT value FROM app_meta WHERE key=?')
        .get(intakeSourcePinKey(f.identity.intakeId))!.value,
      f.db
        .prepare('SELECT value FROM app_meta WHERE key=?')
        .get(intakeSourcePinKey(f.identity.intakeId))!.value,
    );
    const reader = openIntakeCollectionEnvelope(copied, f.source),
      intake = reader.child(reader.root(), 'intake')!,
      workflow = reader.child(intake, 'workflow')!;
    assert.ok(reader.find('candidate', workflow, 'candidate-public'));
    assert.ok(reader.find('plan', workflow, 'plan-public'));
    const sourceReceipt = rebuilt
      .prepare('SELECT value FROM app_meta WHERE key LIKE ?')
      .get('%operation:' + f.operationId)!.value;
    assert.equal(JSON.parse(String(sourceReceipt)).result.operationId, f.operationId);
    assert.equal(
      copied
        .prepare('SELECT value FROM app_meta WHERE key LIKE ?')
        .get('%operation:' + f.operationId),
      undefined,
    );
  });
test('production interrupted schema build retains checked legacy state and incomplete build evidence across rebuild', async (t) => {
  const f = fixture(t, true);
  transaction(f.db, () => {
    f.db
      .prepare('INSERT INTO providers(id,name) VALUES(?,?)')
      .run('fictional-provider', 'Fictional clinic');
    f.db
      .prepare('UPDATE source_files SET provider_id=? WHERE id=?')
      .run('fictional-provider', f.source.id);
  });
  const revision = clinicalReviewRevision(f.db);
  await assert.rejects(
    () =>
      buildIntakeCollectionEnvelope(f.db, f.source, {
        onCheckpoint: () => {
          throw Error('fictional checkpoint pause');
        },
      }),
    /fictional checkpoint pause/,
  );
  validateProductionIntakeAuthority(f.db, f.identity.profileId);
  const collections = createIntakeStateStorage(f.db, f.identity).collections,
    head = collections.binding(collections.openView())!;
  assert.ok(head.builds);
  assert.equal(head.logical.domainVersion, 7);
  assert.equal(clinicalReviewRevision(f.db), revision);
  const rebuilt = f.rebuild();
  assert.equal([...iterateIntakeEnvelopeText(rebuilt, f.source)].join(''), f.text);
  assert.equal(hasIntakeCollectionEnvelope(rebuilt, f.source), false);
  const lookup = await prepareIntakeLookupIndices(rebuilt);
  assert.equal(lookup.prepared, 0);
  assert.equal(maximumIntakeDiscoveryOrder(rebuilt), 0);
  await ensureNativeIntakeSchema(rebuilt, f.identity.profileId, f.source.id);
  assert.equal(hasIntakeCollectionEnvelope(rebuilt, f.source), true);
  openIntakeCollectionEnvelope(rebuilt, f.source);
  validateProductionIntakeAuthority(rebuilt, f.identity.profileId);
  assert.equal([...iterateIntakeEnvelopeText(rebuilt, f.source)].join(''), f.text);
});
test('production evolved schema preserves historical version and rejects mismatched source metadata', async (t) => {
  const f = fixture(t, false);
  await buildIntakeCollectionEnvelope(f.db, f.source);
  const reader = openIntakeCollectionEnvelope(f.db, f.source),
    intake = reader.child(reader.root(), 'intake')!,
    operationId = randomUUID();
  const prepared = prepareIntakeEnvelopeFieldMutation(f.db, f.source, {
    reader,
    record: intake,
    field: 'version',
    jsonText: '8',
    operationId,
    requestDigest: sha(operationId),
    domainVersion: 8,
  });
  const text = f.text.replace('"version":7', '"version":8'),
    next = prepareInitialIntakeEnvelope(JSON.parse(text));
  transaction(f.db, () => {
    stageIntakeEnvelopeFieldMutation(f.db, f.source, prepared);
    f.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(next.detailsJson, f.identity.intakeId);
  });
  validateProductionIntakeAuthority(f.db, f.identity.profileId);
  const rebuilt = f.rebuild();
  assert.equal([...iterateIntakeEnvelopeText(rebuilt, f.source)].join(''), text);
  transaction(rebuilt, () =>
    rebuilt
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(f.initial.detailsJson.replace('fictional.zip', 'conflicting.zip'), f.identity.intakeId),
  );
  assert.throws(
    () => validateProductionIntakeAuthority(rebuilt, f.identity.profileId),
    /metadata|version|agreement|conflict/,
  );
});

test('encrypted profile copy preserves adopted schema and original bytes after independent cache loss', async (t) => {
  const { manager } = vaultFixture(t),
    created = await newProfile(manager, 'Fictional schema source');
  const state = manager.opened.get(created.profile.id)!;
  const bytes = Buffer.from('Independently fictional retained original Ω.');
  const uploaded = uploadIntake(state.db, state.root, created.profile.id, {
    filename: 'fictional-source.txt',
    newProviderName: 'Fictional clinic',
    bytes,
  });
  const source = { id: uploaded.id, kind: 'intake_original', sha256: uploaded.sha256 };
  const text = readIntakeEnvelopeText(state.db, source);
  await buildIntakeCollectionEnvelope(state.db, source);
  const copy = manager.begin({ name: 'Fictional schema copy', copyFrom: created.profile.id });
  await manager.verify(copy.setupId, { acknowledged: true, recovery: copy.recoveryKit });
  manager.lock(copy.profileId);
  rmSync(join(manager.pathFor(copy.profileId), 'cache'), { recursive: true, force: true });
  manager.unlock(copy.profileId, copy.recoveryKit);
  const copied = manager.opened.get(copy.profileId)!;
  validateProductionIntakeAuthority(copied.db, copy.profileId);
  assert.equal([...iterateIntakeEnvelopeText(copied.db, source)].join(''), text);
  const row = copied.db
    .prepare('SELECT path,sha256 FROM source_files WHERE id=?')
    .get(uploaded.id)!;
  assert.equal(row.sha256, uploaded.sha256);
  assert.deepEqual(
    readFileSync(profileOriginal(copied.root, String(row.path), copy.profileId)),
    bytes,
  );
  assert.equal([...iterateIntakeEnvelopeText(state.db, source)].join(''), text);
});
for (const packaged of [false, true])
  test(`contributor profile lifecycle copy certifies and rebuilds ${packaged ? 'native package plan inventory and roles' : 'adopted schema'} through its actual selected backend`, async (t) => {
    if (packaged) fictionalModel(t);
    const root = mkdtempSync(join(tmpdir(), 'fictional-contributor-schema-')),
      databases = new Map<string, Database>();
    const actions = createProfileLifecycle({ root, databases });
    t.after(() => {
      actions.close();
      for (const db of databases.values()) if (db.isOpen) db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const owner = await actions.create({
      name: 'Fictional contributor source',
      fullName: 'Fictional contributor source',
      birthDate: '1982-04-17',
    });
    const db = databases.get(owner.id)!,
      bytes = packaged
        ? zipFixture([
            { name: 'fictional-one.txt', data: 'Fictional one' },
            { name: 'fictional-two.txt', data: 'Fictional two' },
            { name: 'fictional-copy.txt', data: 'Fictional one' },
          ])
        : Buffer.from('Fictional portable schema original.');
    const uploaded = uploadIntake(db, root, owner.id, {
      filename: packaged ? 'fictional-package.zip' : 'fictional-source.txt',
      newProviderName: 'Fictional clinic',
      bytes,
    });
    const source = { id: uploaded.id, kind: 'intake_original', sha256: uploaded.sha256 };
    let retained:
      | { planId: string; inventoryId: string; memberId: string; unit: unknown; role: unknown }
      | undefined;
    if (packaged) {
      const plan = await createPagedPackagePlan(db, root, owner.id, uploaded.id, {
        version: uploaded.version,
        operationId: 'fictional-source-plan',
      });
      const scope = readPackagePlanScope(db, root, owner.id, uploaded.id)!,
        member = scope.inventory.member(0)!;
      await savePagedPackageRoles(db, root, owner.id, uploaded.id, {
        version: plan.version,
        operationId: 'fictional-source-role',
        planId: plan.plan.id,
        roles: [
          {
            memberId: member.memberId,
            role: 'context',
            reason: 'Fictional original role',
            coverage: 'pending',
            references: [],
          },
        ],
      });
      const selected = readPackagePlanScope(db, root, owner.id, uploaded.id)!;
      retained = {
        planId: plan.plan.id,
        inventoryId: selected.inventory.inventoryId,
        memberId: member.memberId,
        unit: selected.unit(member.memberId),
        role: selected.memberState(member.memberId)!.role,
      };
    }
    const text = packaged
      ? [...iterateIntakeEnvelopeText(db, source)].join('')
      : readIntakeEnvelopeText(db, source);
    if (!packaged) await buildIntakeCollectionEnvelope(db, source);
    const copied = await actions.create(
      { name: 'Fictional contributor copy', operationId: randomUUID() },
      owner.id,
    );
    validateProductionIntakeAuthority(databases.get(copied.id)!, copied.id);
    assert.equal([...iterateIntakeEnvelopeText(databases.get(copied.id)!, source)].join(''), text);
    if (retained) {
      const scope = readPackagePlanScope(databases.get(copied.id)!, root, copied.id, uploaded.id)!;
      assert.equal(scope.plan.id, retained.planId);
      assert.equal(scope.inventory.inventoryId, retained.inventoryId);
      assert.equal(scope.inventory.binding.profileId, copied.id);
      assert.deepEqual(scope.unit(retained.memberId), retained.unit);
      assert.deepEqual(scope.memberState(retained.memberId)!.role, retained.role);
    }
    const result = rebuildProfile(root, copied.id, join(root, 'independent-recovery'));
    const recovered = openDatabase(result.database, copied.id);
    try {
      validateProductionIntakeAuthority(recovered, copied.id);
    } finally {
      recovered.close();
    }
  });

test('cold schema validation preserves unknown property names larger than an interactive field page', async (t) => {
  const f = fixture(t, true, '界'.repeat(100000));
  await buildIntakeCollectionEnvelope(f.db, f.source);
  validateProductionIntakeAuthority(f.db, f.identity.profileId);
  assert.equal([...iterateIntakeEnvelopeText(f.rebuild(), f.source)].join(''), f.text);
});

for (const fault of [
  'phantom field',
  'wrong parent',
  'shared child',
  'phantom public id',
  'phantom public last id',
  'phantom membership',
  'wrong first ordinal',
  'wrong predecessor',
] as const)
  test(`cold production schema refuses ${fault} in authenticated selected rows`, async (t) => {
    const f = fixture(t, false);
    await buildIntakeCollectionEnvelope(f.db, f.source);
    const reader = openIntakeCollectionEnvelope(f.db, f.source),
      root = reader.root(),
      intake = reader.child(root, 'intake')!,
      rootId = reader.address(root),
      intakeId = reader.address(intake);
    const collections = createIntakeStateStorage(f.db, f.identity).collections,
      view = collections.openView();
    const get = (key: string) => {
      const value = collections.get(view, 'logical', 'envelope.data', key);
      assert.equal(typeof value, 'string');
      return value as string;
    };
    const changes: IntakeCollectionChange[] = [];
    const put = (key: string, value: string) =>
      changes.push({ area: 'logical', collection: 'envelope.data', op: 'put', key, value });
    if (fault === 'phantom field')
      put(
        'f:' + rootId + ':' + schemaKey('phantom'),
        get('f:' + intakeId + ':' + schemaKey('originalName')),
      );
    else if (fault === 'wrong parent') {
      const edge = JSON.parse(get('p:' + intakeId));
      edge.ordinal++;
      put('p:' + intakeId, JSON.stringify(edge));
    } else if (fault === 'shared child') {
      const key = 'o:' + rootId + ':0000000000000000',
        order = JSON.parse(get(key));
      order.target = { type: 'record', id: intakeId };
      put(key, JSON.stringify(order));
      put('f:' + rootId + ':' + schemaKey('unknown'), JSON.stringify(order.target));
    } else if (fault === 'phantom public id')
      put('i:' + rootId + ':' + schemaKey('intake', 'fake'), intakeId);
    else if (fault === 'phantom public last id')
      put('j:' + rootId + ':' + schemaKey('intake', 'fake'), intakeId);
    else if (fault === 'phantom membership') put('m:' + rootId + ':' + schemaKey('fake'), intakeId);
    else if (fault === 'wrong first ordinal') put('b:' + rootId + ':' + schemaKey('intake'), '0');
    else put('d:' + rootId + ':0000000000000001', '0');
    const id = randomUUID(),
      prepared = collections.prepare(view, {
        operationId: id,
        requestDigest: sha(id),
        domainVersion: 7,
        changes,
      });
    transaction(f.db, () => collections.stage(prepared));
    assert.throws(
      () => validateProductionIntakeAuthority(f.db, f.identity.profileId),
      /phantom|descriptor|parent|cyclic|duplicate|predecessor/,
    );
  });
