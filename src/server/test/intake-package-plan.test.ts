import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, HttpError } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import {
  uploadIntake,
  getIntakeOriginal,
  intakeTransaction,
  createIntakePlan,
  workflowMutation,
  saveIntakePackagePlan,
} from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { buildDurablePackageInventory } from '../intake-package-state.ts';
import { fictionalModel } from './fictional-model.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import {
  createPagedPackagePlan,
  readPackagePlanScope,
  readPackageUnitPage,
  savePagedPackageRoles,
  saveIntakePackageRolesRead,
  readPackageUnitMetadataFragment,
  preparePagedPackagePlanCompatibility,
  readSelectedPackageRoleHash,
} from '../intake-package-plan.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { clearPackageSourceSession, packageSourceSessionWork } from '../intake-package-session.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { decisionIndexGet } from '../intake-reading-state.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import {
  iterateIntakeEnvelopeText,
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { handleIntakeRoute } from '../intake-routes.ts';
import { workflowHash } from '../intake-workflow.ts';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { nativePacketReadingGaps } from '../packet-reading-gaps-native.ts';
import { recordIntakePackageFailurePaged } from '../intake-package-failures.ts';
import { inventoryIntakePackagePaged } from '../intake-package.ts';
import type { IntakePackageInventoryPaged } from '../../shared/intake-package-paging.ts';
import {
  prepareRetainedPlanAccess,
  readRetainedPlanScope,
  readRetainedIntakeUnitScope,
  prepareRetainedPlanDerived,
} from '../intake-retained-plan.ts';

function fixture(t: test.TestContext, count = 71, name?: (ordinal: number) => string) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-package-plan-')),
    profileId = 'cookie-dough',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearPackageSourceSession(db);
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.zip',
    newProviderName: 'Fictional clinic',
    bytes: zipFixture(
      Array.from({ length: count }, (_, ordinal) => ({
        name: name ? name(ordinal) : `fictional-${ordinal}.txt`,
        data: ordinal % 2 ? 'fictional same' : 'fictional different',
      })),
    ),
  });
  return { db, root, profileId, intake, id: intake.id };
}

test('actual native package plan creates implicit distinct units, exact identity and bounded pages, then replays without repeat work', async (t) => {
  const f = fixture(t),
    input = { version: f.intake.version, operationId: 'fictional-package-plan' };
  const result = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, input);
  assert.equal(result.version, input.version + 1);
  assert.equal(result.plan.unitCount, 71);
  assert.equal(result.plan.inventory.uniqueByteContents, 2);
  const scope = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!;
  const first = readPackageUnitPage(f.db, f.root, f.profileId, f.id, { limit: 50 }),
    second = readPackageUnitPage(f.db, f.root, f.profileId, f.id, { offset: first.nextOffset! });
  assert.equal(first.units.length, 50);
  assert.equal(first.nextOffset, 50);
  assert.equal(second.units.length, 21);
  assert.equal(second.nextOffset, null);
  assert.ok(
    first.units.every(
      (unit) =>
        'status' in unit &&
        unit.status === 'pending' &&
        unit.attemptCount === 0 &&
        !('attempts' in unit),
    ),
  );
  const ids = [...first.units, ...second.units].map((unit) => unit.id);
  assert.equal(new Set(ids).size, 71);
  assert.equal(result.plan.id, 'plan:' + workflowHash([f.id, result.plan.pins, ids]));
  assert.equal(scope.unitById(ids[70])!.id, ids[70]);
  assert.equal(scope.memberState(scope.inventory.member(70)!.memberId)!.unitId, ids[70]);
  const gaps = nativePacketReadingGaps(f.db, f.id);
  assert.equal(gaps.length, 71);
  assert.equal(gaps.at(-1)!.locator, scope.unitById(ids[70])!.locator);
  assert.ok(gaps.every((gap) => gap.reason === 'not yet read'));
  const file = f.db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(f.id)!;
  const full = JSON.parse([...iterateIntakeEnvelopeText(f.db, file as never)].join(''));
  assert.equal(full.intake.workflow.plans.length, 1);
  assert.equal(full.intake.workflow.plans[0].format, 'health-intake-package-plan-v2');
  assert.equal('units' in full.intake.workflow.plans[0], false);
  assert.equal(full.intake.workflow.operations[0].id, input.operationId);
  const before = intakeWorkCounters(f.db).warm;
  clearIntakeStateCache(f.db);
  assert.deepEqual(nativePacketReadingGaps(f.db, f.id), gaps);
  const replay = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.plan, result.plan);
  assert.equal(replay.version, result.version);
  const after = intakeWorkCounters(f.db).warm;
  assert.equal(after.packagePlanUnitIds, before.packagePlanUnitIds);
  assert.equal(after.packagePlanHashBytes, before.packagePlanHashBytes);
  assert.equal(after.materializationReads, before.materializationReads);
  assert.equal(
    createHash('sha256')
      .update(getIntakeOriginal(f.db, f.root, f.profileId, f.id).bytes)
      .digest('hex'),
    f.intake.sha256,
  );
  await assert.rejects(
    createPagedPackagePlan(f.db, f.root, f.profileId, f.id, { ...input, unitSize: 2 }),
    (error: unknown) => error instanceof HttpError && error.code === 'OPERATION_CONFLICT',
  );
  await assert.rejects(
    createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: input.version,
      operationId: 'another',
    }),
    (error: unknown) => error instanceof HttpError && error.code === 'VERSION_CONFLICT',
  );
});

test('new plan verifies a reused inventory against same-size physical replacement', async (t) => {
  const f = fixture(t, 3),
    context = {
      ...f,
      rawDomainVersion: intakeSourceVersion(f.db, f.id).rawVersion,
    };
  const built = await buildDurablePackageInventory(context);
  assert.equal(built.inventory.summary.members, 3);
  const path = profileOriginal(
    f.root,
    String(f.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.id)!.path),
    f.profileId,
  );
  const original = readFileSync(path),
    changed = Buffer.from(original),
    replacement = join(f.root, 'changed-fictional.zip');
  changed[0] = changed[0]! ^ 1;
  writeFileSync(replacement, changed);
  renameSync(replacement, path);
  await assert.rejects(
    createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'changed-source-plan',
    }),
    { code: 'SOURCE_CHANGED' },
  );
  assert.equal(readPackagePlanScope(f.db, f.root, f.profileId, f.id), undefined);
  writeFileSync(path, original);
  const before = packageSourceSessionWork(f.db)?.coldHashBytes ?? 0;
  const plan = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
    version: f.intake.version,
    operationId: 'verified-source-plan',
  });
  assert.equal(plan.plan.unitCount, 3);
  assert.equal((packageSourceSessionWork(f.db)?.coldHashBytes ?? 0) - before, original.length);
});

test('new plan refuses a symlink substituted after inventory verification', async (t) => {
  const f = fixture(t, 3);
  await buildDurablePackageInventory({
    ...f,
    rawDomainVersion: intakeSourceVersion(f.db, f.id).rawVersion,
  });
  const path = profileOriginal(
    f.root,
    String(f.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.id)!.path),
    f.profileId,
  );
  const moved = path + '.moved';
  renameSync(path, moved);
  symlinkSync(moved, path);
  await assert.rejects(
    createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'symlink-source-plan',
    }),
    { code: 'SOURCE_CHANGED' },
  );
  assert.equal(readPackagePlanScope(f.db, f.root, f.profileId, f.id), undefined);
});

test('new plan refuses source replacement during asynchronous unit preparation', async (t) => {
  const f = fixture(t);
  await buildDurablePackageInventory({
    ...f,
    rawDomainVersion: intakeSourceVersion(f.db, f.id).rawVersion,
  });
  const path = profileOriginal(
    f.root,
    String(f.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.id)!.path),
    f.profileId,
  );
  const original = readFileSync(path),
    changed = Buffer.from(original),
    replacement = path + '.replacement',
    before = intakeWorkCounters(f.db).warm.packagePlanUnitIds;
  changed[0] = changed[0]! ^ 1;
  let replaced = false;
  await assert.rejects(
    createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'changed-during-plan',
      assertRunning() {
        if (replaced || intakeWorkCounters(f.db).warm.packagePlanUnitIds <= before) return;
        writeFileSync(replacement, changed);
        renameSync(replacement, path);
        replaced = true;
      },
    }),
    { code: 'SOURCE_CHANGED' },
  );
  assert.equal(replaced, true);
  assert.equal(readPackagePlanScope(f.db, f.root, f.profileId, f.id), undefined);
});

test('selected package routes use authorized bounded pages and exact unit details', async (t) => {
  const f = fixture(t, 4),
    plan = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'plan',
    });
  let result: unknown;
  const context = {
    ...f,
    resource: 'intakes',
    method: 'GET',
    action: 'package-units',
    params: new URLSearchParams('limit=2'),
    respond: (value: unknown) => {
      result = value;
    },
  } as unknown as Parameters<typeof handleIntakeRoute>[0];
  assert.equal(await handleIntakeRoute(context), true);
  const page = result as ReturnType<typeof readPackageUnitPage>;
  assert.equal(page.units.length, 2);
  assert.equal(page.nextOffset, 2);
  await handleIntakeRoute({
    ...context,
    action: 'plan-unit',
    params: new URLSearchParams({
      planId: plan.plan.id,
      unitId: page.units[0]!.id,
      version: String(plan.version),
    }),
  });
  assert.equal((result as { unit: { id: string } }).unit.id, page.units[0]!.id);
  await handleIntakeRoute({
    ...context,
    action: 'package-failures',
    params: new URLSearchParams(),
  });
  assert.deepEqual((result as { entries: unknown[] }).entries, []);
  await assert.rejects(
    handleIntakeRoute({ ...context, profileId: 'foreign' }),
    /different profile/,
  );
  await assert.rejects(
    handleIntakeRoute({ ...context, params: new URLSearchParams('offset=Infinity') }),
    /bounded nonnegative integer/,
  );
  await assert.rejects(
    handleIntakeRoute({
      ...context,
      action: 'plan-unit',
      params: new URLSearchParams({
        planId: plan.plan.id,
        unitId: page.units[0]!.id,
        version: String(plan.version - 1),
      }),
    }),
    /changed/,
  );
});

test('package route first successful inventory retry uses the current plan after failure resolution', async (t) => {
  const f = fixture(t, 3);
  const plan = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
    version: f.intake.version,
    operationId: 'fictional-retry-plan',
  });
  await recordIntakePackageFailurePaged(f.db, f.root, f.profileId, f.id, {
    operationKey: 'inventory',
    reasonCode: 'PACKAGE_CRC',
    detail: 'Fictional retained inventory failure before source repair',
  });
  let response: unknown;
  let status = 0;
  const context = {
    ...f,
    resource: 'intakes',
    method: 'GET',
    action: 'package',
    req: new IncomingMessage(new Socket()),
    params: new URLSearchParams('limit=2'),
    respond(value: unknown, _options: unknown, code = 200) {
      response = value;
      status = code;
    },
  } as unknown as Parameters<typeof handleIntakeRoute>[0];
  const path = profileOriginal(
    f.root,
    String(f.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.id)!.path),
    f.profileId,
  );
  const original = readFileSync(path);
  const damaged = Buffer.from(original);
  damaged[0] = damaged[0]! ^ 1;
  writeFileSync(path, damaged);
  // Repaired bytes match the retained source again before retrying its inventory.
  writeFileSync(path, original);
  const failed = openIntakeCollectionEnvelope(f.db, { id: f.id });
  assert.equal(
    failed.info(failed.child(failed.child(failed.root(), 'intake')!, 'packageFailures')!).count,
    1,
  );
  const before = intakeSourceVersion(f.db, f.id);
  const stale = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!;
  const memberId = stale.inventory.member(0)!.memberId;
  const expectedState = stale.memberState(memberId);

  assert.equal(await handleIntakeRoute(context), true);
  assert.equal(status, 200, 'the first successful retry needs no extra client refresh');
  const page = response as IntakePackageInventoryPaged;
  assert.equal(page.version, before.version + 1);
  assert.equal(page.planId, plan.plan.id);
  assert.equal(page.members.length, 2);
  assert.equal(page.nextOffset, 2);
  const first = page.members[0]!;
  assert.ok('unitId' in first);
  assert.deepEqual(
    { unitId: first.unitId, status: first.status, coverage: first.coverage, role: first.role },
    expectedState,
  );
  const current = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!;
  assert.equal(current.version, page.version);
  assert.deepEqual(current.memberState(memberId), expectedState);
  assert.throws(() => stale.memberState(memberId), { code: 'PLAN_CHANGED' });
  await assert.rejects(inventoryIntakePackagePaged(f, stale), { code: 'PLAN_CHANGED' });
  await handleIntakeRoute({
    ...context,
    action: 'package-failures',
    params: new URLSearchParams(),
  });
  assert.deepEqual((response as { entries: unknown[] }).entries, []);
});

test('package metadata retry preserves stale reference refusal after inventory recovery', async (t) => {
  const f = fixture(t, 1, () => 'fictional-' + 'x'.repeat(9000) + '.txt');
  await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
    version: f.intake.version,
    operationId: 'fictional-metadata-retry-plan',
  });
  const page = await inventoryIntakePackagePaged(f, () =>
    readPackagePlanScope(f.db, f.root, f.profileId, f.id),
  );
  const member = page.members[0]!;
  assert.ok('metadata' in member);
  await recordIntakePackageFailurePaged(f.db, f.root, f.profileId, f.id, {
    operationKey: 'inventory',
    reasonCode: 'PACKAGE_CRC',
    detail: 'Fictional retained failure before metadata retry',
  });
  let response: unknown;
  const context = {
    ...f,
    resource: 'intakes',
    method: 'POST',
    action: 'package-metadata',
    req: Object.assign(new IncomingMessage(new Socket()), {
      headers: { 'content-type': 'application/json' },
    }),
    params: new URLSearchParams(),
    body: async () => Buffer.from(JSON.stringify({ reference: member.metadata })),
    respond: (value: unknown) => {
      response = value;
    },
  } as unknown as Parameters<typeof handleIntakeRoute>[0];
  await assert.rejects(handleIntakeRoute(context), { code: 'PLAN_CHANGED' });
  const readResponse = (): unknown => response;
  assert.equal(readResponse(), undefined);
  await assert.rejects(handleIntakeRoute(context), { code: 'PACKAGE_METADATA_CHANGED' });
  assert.equal(readResponse(), undefined);
  await handleIntakeRoute({
    ...context,
    method: 'GET',
    action: 'package',
    req: new IncomingMessage(new Socket()),
  });
  const current = (response as IntakePackageInventoryPaged).members[0]!;
  assert.ok('metadata' in current);
  assert.ok(current.metadata.version > member.metadata.version);
  assert.equal(
    await handleIntakeRoute({
      ...context,
      body: async () => Buffer.from(JSON.stringify({ reference: current.metadata })),
    }),
    true,
  );
  assert.deepEqual((response as { reference: unknown }).reference, current.metadata);
});

test('deferred package scope is selected only after successful inventory and cancellation checks', async (t) => {
  const f = fixture(t, 1);
  let calls = 0;
  const scope = () => {
    calls++;
    return readPackagePlanScope(f.db, f.root, f.profileId, f.id);
  };
  const originalExec = DatabaseSync.prototype.exec;
  const failedSpool = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.includes('CREATE TABLE central'))
        throw Object.assign(Error('Fictional package spool refusal'), { errcode: 13 });
      return originalExec.call(this, sql);
    },
  );
  try {
    await assert.rejects(inventoryIntakePackagePaged(f, scope), {
      status: 507,
      code: 'PACKAGE_STORAGE_FULL',
    });
  } finally {
    failedSpool.mock.restore();
  }
  assert.equal(calls, 0, 'failed durable inventory cannot select a success scope');
  const before = intakeSourceVersion(f.db, f.id);
  const cancellation = Error('Fictional package request cancellation');
  await assert.rejects(
    inventoryIntakePackagePaged(
      {
        ...f,
        assertRunning() {
          throw cancellation;
        },
      },
      scope,
    ),
    (error) => error === cancellation,
  );
  assert.equal(calls, 0, 'cancelled inventory cannot select a success scope');
  assert.equal(intakeSourceVersion(f.db, f.id).version, before.version);
  const page = await inventoryIntakePackagePaged(f, scope);
  assert.equal(page.version, before.version + 1);
  assert.equal(page.members.length, 1);
  assert.equal(calls, 1);
});

test('oversized unit metadata uses exact UTF8-safe bounded fragments with current source and version binding', async (t) => {
  const f = fixture(t, 1, () => '界'.repeat(12000) + '.txt'),
    first = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'plan',
    }),
    page = readPackageUnitPage(f.db, f.root, f.profileId, f.id),
    item = page.units[0];
  assert.ok(item && 'format' in item && item.format === 'health-intake-package-unit-reference-v1');
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32768);
  assert.equal(item.filenameTruncated, true);
  assert.ok(item.metadata.bytes > 32768);
  const pieces: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const fragment = readPackageUnitMetadataFragment(
      f.db,
      f.root,
      f.profileId,
      f.id,
      item.metadata,
      { offset, limit: 4096 },
    );
    assert.ok(Buffer.byteLength(fragment.text) <= 4096);
    assert.equal(fragment.text.includes('\uFFFD'), false);
    pieces.push(fragment.text);
    offset = fragment.nextOffset;
  }
  const exact = pieces.join(''),
    scope = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!;
  assert.deepEqual(JSON.parse(exact), scope.unitById(item.id));
  assert.equal(createHash('sha256').update(exact).digest('hex'), item.metadata.metadataHash);
  assert.throws(
    () =>
      readPackageUnitMetadataFragment(f.db, f.root, f.profileId, f.id, item.metadata, {
        offset: Buffer.from(exact).indexOf(Buffer.from('界')) + 1,
      }),
    /next byte offset/,
  );
  assert.throws(
    () =>
      readPackageUnitMetadataFragment(f.db, f.root, f.profileId, f.id, {
        ...item.metadata,
        memberId: 'foreign',
      }),
    /metadata changed/,
  );
  await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
    version: first.version,
    operationId: 'new-command',
  });
  assert.throws(
    () => readPackageUnitMetadataFragment(f.db, f.root, f.profileId, f.id, item.metadata),
    /metadata changed/,
  );
});

test('native unit accounting requires exact selected batch coverage and retained attempt membership', async (t) => {
  const f = fixture(t, 3),
    initial = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'plan',
    }),
    scope = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!,
    unit = scope.unit(scope.inventory.member(1)!.memberId)!;
  assert.equal(scope.accountedKind(unit.id), null);
  const file = f.db
      .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
      .get(f.id)! as never,
    view = openIntakeCollectionEnvelope(f.db, file),
    flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
    record = view.find('plan', flow, initial.plan.id)!,
    collections = selectedEnvelopeStore(f.db, file).collections,
    batchId = 'fictional-batch',
    prefix = workflowHash(initial.plan.id),
    attemptKey = workflowHash([unit.id, batchId]);
  const prepared = await prepareIntakeEnvelopeMutation(f.db, file, {
    reader: view,
    operationId: randomUUID(),
    requestDigest: workflowHash('fictional-unit-receipt'),
    domainVersion: intakeSourceVersion(f.db, f.id).rawVersion + 1,
    changes: [
      {
        op: 'append',
        record,
        field: 'batches',
        jsonText: JSON.stringify({
          id: batchId,
          proposalId: 'fictional-proposal',
          at: '2026-01-01T00:00:00.000Z',
          coverage: [{ unitId: unit.id, kind: 'context', notes: 'Fictional supporting context' }],
        }),
      },
    ],
    additionalLogicalChanges: [
      {
        area: 'logical',
        collection: 'package.units.' + prefix,
        op: 'put',
        key: unit.id,
        value: JSON.stringify({ batchId, coverageOrdinal: 0, attemptCount: 1 }),
      },
      {
        area: 'logical',
        collection: 'package.attempts.' + prefix,
        op: 'put',
        key: attemptKey,
        value: '1',
      },
    ],
  });
  intakeTransaction(f.db, () => collections.stage(prepared.prepared!), {});
  const current = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!;
  assert.equal(current.accountedKind(unit.id), 'context');
  assert.equal(current.unitById(unit.id)!.status, 'partial');
  assert.equal(current.unitById(unit.id)!.attemptCount, 1);
  const missing = collections.prepare(collections.openView(), {
    operationId: randomUUID(),
    requestDigest: workflowHash('missing-attempt'),
    domainVersion: intakeSourceVersion(f.db, f.id).rawVersion,
    changes: [
      { area: 'logical', collection: 'package.attempts.' + prefix, op: 'delete', key: attemptKey },
    ],
  });
  intakeTransaction(f.db, () => collections.stage(missing), {});
  assert.throws(
    () => readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.accountedKind(unit.id),
    /attempt is not retained/,
  );
});

test('paged role decisions retain exact history and off-page references without rewriting other members', async (t) => {
  const f = fixture(t, 61),
    plan = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'plan',
    }),
    scope = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!,
    first = scope.inventory.member(0)!,
    last = scope.inventory.member(60)!;
  const input = {
    version: plan.version,
    operationId: 'roles',
    planId: plan.plan.id,
    roles: [
      {
        memberId: first.memberId,
        role: 'context' as const,
        reason: '界'.repeat(4000),
        coverage: 'pending' as const,
        references: [
          {
            path: last.filename,
            reason: 'Fictional supporting file',
            status: 'supplied_uninspected' as const,
            targetMemberId: last.memberId,
          },
        ],
      },
    ],
  };
  const before = intakeWorkCounters(f.db).warm;
  const result = await savePagedPackageRoles(f.db, f.root, f.profileId, f.id, input);
  const current = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!;
  assert.deepEqual(current.memberState(first.memberId)!.role, {
    role: 'context',
    reason: input.roles[0].reason,
    coverage: 'pending',
    referenceCount: 1,
    missingReferenceCount: 0,
    ambiguousReferenceCount: 0,
  });
  assert.equal(current.memberState(last.memberId)!.role, null);
  assert.equal(current.unit(first.memberId)!.status, 'pending');
  assert.equal(current.unit(last.memberId)!.status, 'pending');
  const replay = await savePagedPackageRoles(f.db, f.root, f.profileId, f.id, input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.version, result.version);
  const after = intakeWorkCounters(f.db).warm;
  assert.equal(after.materializationReads, before.materializationReads);
  assert.equal(after.packagePlanUnitIds, before.packagePlanUnitIds);
  await assert.rejects(
    savePagedPackageRoles(f.db, f.root, f.profileId, f.id, {
      ...input,
      roles: [{ ...input.roles[0], reason: 'Changed request' }],
    }),
    (error: unknown) => error instanceof HttpError && error.code === 'OPERATION_CONFLICT',
  );
});

test('new public role command refuses a changed physical original while exact replay remains available', async (t) => {
  const f = fixture(t, 3),
    plan = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'role-source-plan',
    }),
    memberId = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.inventory.member(0)!.memberId,
    role = {
      memberId,
      role: 'clinical' as const,
      reason: 'Fictional selected report',
      coverage: 'pending' as const,
      references: [],
    },
    path = profileOriginal(
      f.root,
      String(f.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.id)!.path),
      f.profileId,
    );
  const original = readFileSync(path),
    changed = Buffer.from(original),
    replacement = path + '.replacement';
  changed[0] = changed[0]! ^ 1;
  writeFileSync(replacement, changed);
  renameSync(replacement, path);
  await assert.rejects(
    saveIntakePackageRolesRead(f.db, f.root, f.profileId, f.id, {
      version: plan.version,
      operationId: 'changed-role',
      planId: plan.plan.id,
      roles: [role],
    }),
    { code: 'SOURCE_CHANGED' },
  );
  assert.equal(
    readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.memberState(memberId)!.role,
    null,
  );
  writeFileSync(path, original);
  const accepted = await saveIntakePackageRolesRead(f.db, f.root, f.profileId, f.id, {
    version: plan.version,
    operationId: 'accepted-role',
    planId: plan.plan.id,
    roles: [role],
  });
  assert.ok(accepted);
  writeFileSync(replacement, changed);
  renameSync(replacement, path);
  const replay = await saveIntakePackageRolesRead(f.db, f.root, f.profileId, f.id, {
    version: plan.version,
    operationId: 'accepted-role',
    planId: plan.plan.id,
    roles: [role],
  });
  assert.ok(replay);
});

test('new public role command refuses a same-byte symlink', async (t) => {
  const f = fixture(t, 3),
    plan = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'symlink-role-plan',
    }),
    memberId = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.inventory.member(0)!.memberId,
    path = profileOriginal(
      f.root,
      String(f.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.id)!.path),
      f.profileId,
    );
  const moved = path + '.moved';
  renameSync(path, moved);
  symlinkSync(moved, path);
  await assert.rejects(
    saveIntakePackageRolesRead(f.db, f.root, f.profileId, f.id, {
      version: plan.version,
      operationId: 'symlink-role',
      planId: plan.plan.id,
      roles: [
        {
          memberId,
          role: 'clinical',
          reason: 'Fictional selected report',
          coverage: 'pending',
          references: [],
        },
      ],
    }),
    { code: 'SOURCE_CHANGED' },
  );
  assert.equal(
    readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.memberState(memberId)!.role,
    null,
  );
});

test('new paged role command refuses replacement after role work begins', async (t) => {
  const f = fixture(t, 3),
    plan = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'late-role-plan',
    }),
    memberId = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.inventory.member(0)!.memberId,
    path = profileOriginal(
      f.root,
      String(f.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.id)!.path),
      f.profileId,
    );
  const changed = Buffer.from(readFileSync(path)),
    replacement = path + '.replacement',
    before = intakeWorkCounters(f.db).warm.hashCalls;
  changed[0] = changed[0]! ^ 1;
  let replaced = false;
  await assert.rejects(
    savePagedPackageRoles(f.db, f.root, f.profileId, f.id, {
      version: plan.version,
      operationId: 'late-role',
      planId: plan.plan.id,
      roles: [
        {
          memberId,
          role: 'clinical',
          reason: 'Fictional selected report',
          coverage: 'pending',
          references: [],
        },
      ],
      assertRunning() {
        if (replaced || intakeWorkCounters(f.db).warm.hashCalls <= before) return;
        writeFileSync(replacement, changed);
        renameSync(replacement, path);
        replaced = true;
      },
    }),
    { code: 'SOURCE_CHANGED' },
  );
  assert.equal(replaced, true);
  assert.equal(
    readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.memberState(memberId)!.role,
    null,
  );
});

test('changed extraction settings require explicit replacement and preserve the prior plan and command', async (t) => {
  const f = fixture(t, 6),
    input = { version: f.intake.version, operationId: 'initial' },
    first = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, input);
  process.env.CRS_AI_MODEL = 'fictional-second-route';
  await assert.rejects(
    createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: first.version,
      operationId: 'replacement',
    }),
    (error: unknown) => error instanceof HttpError && error.code === 'PLAN_CHANGED',
  );
  const replacement = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
    version: first.version,
    operationId: 'replacement',
    replacePlanId: first.plan.id,
  });
  assert.notEqual(replacement.plan.id, first.plan.id);
  assert.equal(readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.planId, replacement.plan.id);
  const replay = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, input);
  assert.equal(replay.plan.id, first.plan.id);
  assert.equal(replay.plan.status, 'superseded');
  assert.equal(replay.version, replacement.version);
  assert.equal(readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.planId, replacement.plan.id);
});

test('new same-pin commands reuse the selected implicit recipe and stale scope fails after accepted change', async (t) => {
  const f = fixture(t, 5),
    first = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'one',
    }),
    oldScope = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!,
    before = intakeWorkCounters(f.db).warm;
  const second = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
    version: first.version,
    operationId: 'two',
  });
  assert.equal(second.plan.id, first.plan.id);
  assert.equal(second.version, first.version + 1);
  assert.equal(intakeWorkCounters(f.db).warm.packagePlanHashBytes, before.packagePlanHashBytes);
  assert.throws(
    () => oldScope.unitById('unit:' + 'a'.repeat(64)),
    (error: unknown) => error instanceof HttpError && error.code === 'PLAN_CHANGED',
  );
  assert.equal(intakeSourceVersion(f.db, f.id).version, second.version);
  assert.throws(
    () => readPackagePlanScope(f.db, f.root, 'foreign-profile', f.id),
    /different profile/,
  );
  assert.throws(() => readPackageUnitPage(f.db, f.root, f.profileId, f.id, { limit: 51 }), /1–50/);
});

test('A to B to A preserves legacy no-reactivation semantics and reuses the retained recipe without hashing again', async (t) => {
  const f = fixture(t, 4),
    model = process.env.CRS_AI_MODEL;
  const first = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
    version: f.intake.version,
    operationId: 'A',
  });
  process.env.CRS_AI_MODEL = 'fictional-B';
  const second = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
    version: first.version,
    operationId: 'B',
    replacePlanId: first.plan.id,
  });
  process.env.CRS_AI_MODEL = model;
  const before = intakeWorkCounters(f.db).warm.packagePlanHashBytes;
  const input = { version: second.version, operationId: 'A-again' };
  const third = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, input);
  assert.equal(third.plan.id, first.plan.id);
  assert.equal(third.plan.status, 'superseded');
  assert.equal(readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.planId, second.plan.id);
  assert.equal(intakeWorkCounters(f.db).warm.packagePlanHashBytes, before);
  const file = f.db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(f.id)!;
  const text = JSON.parse([...iterateIntakeEnvelopeText(f.db, file as never)].join(''));
  assert.equal(text.intake.workflow.plans.length, 2);
  assert.equal(text.intake.workflow.operations.length, 3);
  clearIntakeStateCache(f.db);
  const replay = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, input);
  assert.equal(replay.version, third.version);
  assert.equal(replay.replayed, true);
  assert.equal(intakeWorkCounters(f.db).warm.packagePlanHashBytes, before);
});

test('actual legacy inventory plan replay preserves attempts roles and skipped reading through bounded compatibility adoption', async (t) => {
  const f = fixture(t, 4),
    input = { version: f.intake.version, operationId: 'legacy-plan' };
  const legacy = await createIntakePlan(f.db, f.root, f.profileId, f.id, input);
  const plan = legacy.workflow!.plans[0]!,
    units = plan.units;
  const roles = [
    {
      memberId: units[0]!.memberId!,
      role: 'context' as const,
      reason: 'Fictional legacy context',
      coverage: 'context' as const,
      references: [],
    },
  ];
  const roleInput = {
    version: legacy.version,
    operationId: 'legacy-roles',
    planId: plan.id,
    roles,
  };
  const withRoles = await saveIntakePackagePlan(f.db, f.root, f.profileId, f.id, roleInput);
  workflowMutation(
    f.db,
    f.root,
    f.profileId,
    f.id,
    { version: withRoles.version, operationId: 'legacy-receipt' },
    (workflow) => {
      const p = workflow.plans[0]!,
        coverage = {
          unitId: p.units[0]!.id,
          kind: 'context' as const,
          notes: 'Fictional retained context',
        };
      Object.assign(p.packageRoles![0]!, { fictionalExtension: 'retained unknown role field' });
      p.batches.push({
        id: 'legacy-batch',
        proposalId: 'fictional-legacy-proposal',
        coverage: [coverage],
        at: '2026-01-01T00:00:00Z',
      });
      p.units[0]!.attempts = ['legacy-batch'];
      p.units[0]!.status = 'partial';
      p.units[0]!.coverage = coverage;
      p.units[0]!.processingException = {
        reason: 'processing_stalled',
        at: '2026-01-01T00:00:00Z',
      };
      p.units[1]!.coverage = {
        unitId: p.units[1]!.id,
        kind: 'context',
        notes: 'Fictional unsupported claim',
      };
      p.units[1]!.processingException = {
        reason: 'processing_stalled',
        at: '2026-01-01T00:00:00Z',
      };
    },
  );
  const file = f.db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(f.id)!;
  await buildIntakeCollectionEnvelope(f.db, file as never);
  const before = intakeSourceVersion(f.db, f.id);
  const replay = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.plan.id, plan.id);
  assert.deepEqual(intakeSourceVersion(f.db, f.id), before);
  const scope = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!;
  assert.equal(scope.unitById(units[0]!.id)!.attemptCount, 1);
  assert.equal(scope.accountedKind(units[0]!.id), 'context');
  assert.equal(scope.accountedKind(units[1]!.id), null);
  assert.equal(scope.memberState(units[0]!.memberId!)!.role!.reason, roles[0]!.reason);
  const roleRecord = scope.roleRecord(units[0]!.memberId!)!;
  assert.equal(
    scope.roleHash(units[0]!.memberId!),
    workflowHash(JSON.parse([...roleRecord.reader.recordChunks(roleRecord.record)].join(''))),
  );
  assert.equal(scope.roleHash(units[3]!.memberId!), null);
  assert.equal(
    readSelectedPackageRoleHash(f.db, f.profileId, f.id, units[0]!.memberId!),
    scope.roleHash(units[0]!.memberId!),
  );
  assert.throws(
    () => readSelectedPackageRoleHash(f.db, 'foreign-profile', f.id, units[0]!.memberId!),
    /different profile/,
  );
  assert.equal(
    JSON.parse([...roleRecord.reader.recordChunks(roleRecord.record)].join('')).fictionalExtension,
    'retained unknown role field',
  );
  const store = selectedEnvelopeStore(f.db, file as never).collections;
  const accounted = scope.decisionIndex('accounted'),
    skipped = scope.decisionIndex('readingSkipped');
  assert.equal(decisionIndexGet(store, accounted, '0000000000000000'), units[0]!.id);
  assert.equal(decisionIndexGet(store, skipped, '0000000000000000'), undefined);
  assert.equal(decisionIndexGet(store, skipped, '0000000000000001'), units[1]!.id);
  const work = intakeWorkCounters(f.db).warm;
  clearIntakeStateCache(f.db);
  await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, input);
  const roleReplay = await savePagedPackageRoles(f.db, f.root, f.profileId, f.id, roleInput);
  assert.equal(roleReplay.replayed, true);
  assert.equal(intakeWorkCounters(f.db).warm.packagePlanHashBytes, work.packagePlanHashBytes);
  assert.equal(intakeWorkCounters(f.db).warm.materializationReads, work.materializationReads);
  await assert.rejects(
    createPagedPackagePlan(f.db, f.root, f.profileId, f.id, { ...input, unitSize: 2 }),
    /different request/,
  );
  const changed = await savePagedPackageRoles(f.db, f.root, f.profileId, f.id, {
    ...roleInput,
    operationId: 'native-role',
    version: before.version,
    roles: [{ ...roles[0]!, reason: 'Fictional native context' }],
  });
  const adopted = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!;
  assert.equal(adopted.decisionIndex('accounted').area, 'logical');
  assert.equal(adopted.accountedKind(units[0]!.id), 'context');
  assert.equal(adopted.unitById(units[0]!.id)!.processingException?.reason, 'processing_stalled');
  assert.equal(adopted.memberState(units[0]!.memberId!)!.role!.reason, 'Fictional native context');
  const currentRole = adopted.roleRecord(units[0]!.memberId!)!;
  assert.equal(
    adopted.roleHash(units[0]!.memberId!),
    workflowHash({ ...roles[0]!, reason: 'Fictional native context' }),
  );
  assert.equal(
    JSON.parse([...currentRole.reader.recordChunks(currentRole.record)].join('')).reason,
    'Fictional native context',
  );
  assert.throws(() => scope.roleRecord(units[0]!.memberId!), /plan changed/i);
  assert.equal(changed.version, before.version + 1);
  await preparePagedPackagePlanCompatibility(f.db, f.root, f.profileId, f.id);
  assert.equal(intakeWorkCounters(f.db).warm.packagePlanHashBytes, work.packagePlanHashBytes);
  const roleIndex = adopted.decisionIndex('roles'),
    roleKey = units[0]!.memberId!;
  if (roleIndex.reference) throw Error('Role fixture requires a directly selected map');
  const selectedRole = JSON.parse(
    store.get(store.openView(), roleIndex.area, roleIndex.collection, roleKey) as string,
  );
  delete selectedRole.roleHash;
  const operationId = randomUUID(),
    fingerprint = workflowHash(operationId);
  const prepared = store.prepare(store.openView(), {
    operationId,
    requestDigest: fingerprint,
    domainVersion: intakeSourceVersion(f.db, f.id).rawVersion + 1,
    changes: [
      {
        area: 'logical',
        collection: roleIndex.collection,
        op: 'put',
        key: roleKey,
        value: JSON.stringify(selectedRole),
      },
    ],
  });
  intakeTransaction(f.db, () => store.stage(prepared), { operationId, fingerprint });
  assert.throws(
    () => readSelectedPackageRoleHash(f.db, f.profileId, f.id, roleKey),
    /requires asynchronous preparation/,
  );
});

test('legacy compatibility cancellation and concurrent logical change do not publish a complete stale view', async (t) => {
  const f = fixture(t, 4);
  await createIntakePlan(f.db, f.root, f.profileId, f.id, {
    version: f.intake.version,
    operationId: 'old',
  });
  const file = f.db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(f.id)!;
  await buildIntakeCollectionEnvelope(f.db, file as never);
  const before = intakeSourceVersion(f.db, f.id);
  let checks = 0;
  await buildDurablePackageInventory({ ...f, rawDomainVersion: before.rawVersion });
  await assert.rejects(
    preparePagedPackagePlanCompatibility(f.db, f.root, f.profileId, f.id, {
      assertRunning() {
        if (++checks === 12) throw Error('fictional cancellation');
      },
    }),
    /fictional cancellation/,
  );
  assert.deepEqual(intakeSourceVersion(f.db, f.id), before);
  assert.throws(
    () => readPackagePlanScope(f.db, f.root, f.profileId, f.id),
    /Prepare legacy|inventory/,
  );
  checks = 0;
  const store = selectedEnvelopeStore(f.db, file as never).collections;
  await assert.rejects(
    preparePagedPackagePlanCompatibility(f.db, f.root, f.profileId, f.id, {
      assertRunning() {
        if (++checks !== 8) return;
        const operationId = randomUUID(),
          fingerprint = workflowHash(operationId);
        const prepared = store.prepare(store.openView(), {
          operationId,
          requestDigest: fingerprint,
          domainVersion: before.rawVersion + 1,
          changes: [
            {
              area: 'logical',
              collection: 'fictional.concurrent',
              op: 'put',
              key: 'changed',
              value: 'yes',
            },
          ],
        });
        intakeTransaction(f.db, () => store.stage(prepared), { operationId, fingerprint });
      },
    }),
    /plan changed/i,
  );
  assert.equal(intakeSourceVersion(f.db, f.id).version, before.version + 1);
  await preparePagedPackagePlanCompatibility(f.db, f.root, f.profileId, f.id);
  const completed = intakeSourceVersion(f.db, f.id),
    work = intakeWorkCounters(f.db).warm;
  clearIntakeStateCache(f.db);
  await preparePagedPackagePlanCompatibility(f.db, f.root, f.profileId, f.id);
  assert.deepEqual(intakeSourceVersion(f.db, f.id), completed);
  assert.equal(intakeWorkCounters(f.db).warm.packagePlanHashBytes, work.packagePlanHashBytes);
});

test('older expanded ZIP unit recipes explicitly retain their legacy reader requirement', async (t) => {
  const f = fixture(t, 2);
  const legacy = await createIntakePlan(f.db, f.root, f.profileId, f.id, {
    version: f.intake.version,
    operationId: 'old-expanded',
  });
  workflowMutation(
    f.db,
    f.root,
    f.profileId,
    f.id,
    { version: legacy.version, operationId: 'fictional-expanded-fixture' },
    (workflow) => {
      delete workflow.plans[0]!.index.inventoryVersion;
    },
  );
  const file = f.db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(f.id)!;
  await buildIntakeCollectionEnvelope(f.db, file as never);
  const before = intakeSourceVersion(f.db, f.id);
  await assert.rejects(
    preparePagedPackagePlanCompatibility(f.db, f.root, f.profileId, f.id),
    /legacy expanded-unit reader/,
  );
  assert.deepEqual(intakeSourceVersion(f.db, f.id), before);
});

test('expanded retained plans preserve exact units, first plan precedence and fragmented metadata without recipe substitution', async (t) => {
  const f = fixture(t, 2);
  const old = await createIntakePlan(f.db, f.root, f.profileId, f.id, {
    version: f.intake.version,
    operationId: 'expanded-base',
  });
  const sharedId = 'unit:' + 'a'.repeat(64),
    oldOnly = 'unit:' + 'b'.repeat(64),
    giant = 'Fictional🩺'.repeat(14000);
  workflowMutation(
    f.db,
    f.root,
    f.profileId,
    f.id,
    { version: old.version, operationId: 'expanded-evidence' },
    (workflow) => {
      const plan = workflow.plans[0]!;
      delete plan.index.inventoryVersion;
      plan.units = [
        {
          id: sharedId,
          kind: 'text',
          locator: giant,
          start: 7,
          end: 19,
          status: 'completed',
          attempts: ['proof', 'proof'],
          coverage: { unitId: sharedId, kind: 'extracted', notes: giant },
        },
        {
          id: oldOnly,
          kind: 'pdf',
          locator: 'pages 3–4',
          pages: [3, 4],
          status: 'pending',
          attempts: [],
        },
      ];
      plan.batches = [
        {
          id: 'proof',
          proposalId: 'fictional',
          at: '2026-10-03T00:00:00Z',
          coverage: [{ unitId: sharedId, kind: 'extracted', notes: giant }],
        },
      ];
      plan.packageRoles = [
        {
          memberId: 'legacy-member',
          role: 'context',
          reason: giant,
          coverage: 'context',
          references: [],
        },
      ];
      plan.status = 'superseded';
      plan.id = 'plan:' + workflowHash([f.id, plan.pins, plan.units.map((unit) => unit.id)]);
      const second = structuredClone(plan);
      second.id = 'plan:' + 'c'.repeat(64);
      second.status = 'active';
      second.units = [
        { ...second.units[0]!, status: 'partial', attempts: [], coverage: undefined },
      ];
      second.batches = [];
      workflow.plans.push(second);
    },
  );
  const file = f.db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(f.id)!;
  await buildIntakeCollectionEnvelope(f.db, file as never);
  const before = intakeSourceVersion(f.db, f.id),
    hydrations = intakeWorkCounters(f.db).warm.envelopeHydrations;
  await prepareRetainedPlanAccess(f.db, f.profileId, f.id);
  assert.deepEqual(intakeSourceVersion(f.db, f.id), before);
  const selected = readRetainedIntakeUnitScope(f.db, f.root, f.profileId, f.id, sharedId);
  assert.equal(selected.format, 'retained');
  if (selected.format !== 'retained') throw Error('Expected retained unit');
  assert.equal(selected.unit.status, 'partial');
  assert.equal(selected.unit.attemptCount, 0);
  assert.equal(selected.scope.unitCount, 1);
  const historical = readRetainedIntakeUnitScope(f.db, f.root, f.profileId, f.id, oldOnly);
  assert.equal(historical.format, 'retained');
  if (historical.format !== 'retained') throw Error('Expected retained unit');
  const scope = readRetainedPlanScope(f.db, f.profileId, f.id, {
    planId: historical.scope.planId,
  })!;
  assert.equal(scope.unitCount, 2);
  assert.equal(scope.accountedKind(sharedId), 'extracted');
  assert.equal(scope.unitById(sharedId)!.attemptCount, 2);
  assert.equal(scope.attempts(sharedId, { items: 2, bytes: 4096 }).total, 2);
  const role = scope.roleRecord('legacy-member')!;
  assert.equal(
    role.hash,
    workflowHash({
      memberId: 'legacy-member',
      role: 'context',
      reason: giant,
      coverage: 'context',
      references: [],
    }),
  );
  const unit = scope.unitById(sharedId)!;
  let after: string | undefined,
    text = '';
  do {
    const page = unit.reader.fieldFragment(unit.record, 'locator', { after, bytes: 4096 });
    assert.ok(Buffer.byteLength(page.text) <= 4096);
    text += page.text;
    if (page.complete) break;
    after = page.after!;
  } while (true);
  assert.equal(JSON.parse(text), giant);
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, hydrations);
  const counted = intakeWorkCounters(f.db).reconstruction;
  assert.equal(counted.retainedPlanHeaders, 2);
  assert.equal(counted.retainedPlanUnits, 3);
  assert.equal(counted.retainedPlanCoverageReceipts, 1);
  clearIntakeStateCache(f.db);
  await prepareRetainedPlanAccess(f.db, f.profileId, f.id);
  assert.equal(
    intakeWorkCounters(f.db).reconstruction.retainedPlanUnits,
    counted.retainedPlanUnits,
  );
  assert.equal(
    readRetainedIntakeUnitScope(f.db, f.root, f.profileId, f.id, sharedId).unit.status,
    'partial',
  );
  const live = openIntakeCollectionEnvelope(f.db, file as never),
    flow = live.child(live.child(live.root(), 'intake')!, 'workflow')!,
    op = randomUUID(),
    fingerprint = workflowHash(op);
  const prepared = await prepareIntakeEnvelopeMutation(f.db, file as never, {
    reader: live,
    operationId: op,
    requestDigest: fingerprint,
    domainVersion: before.rawVersion + 1,
    changes: [
      {
        op: 'append',
        record: flow,
        field: 'questions',
        jsonText: JSON.stringify({
          id: 'fictional-question',
          kind: 'clarification',
          message: 'Fictional question',
          answers: [],
        }),
      },
    ],
    prepareDerived: (input) =>
      prepareRetainedPlanDerived(f.db, f.profileId, f.id, {
        ...input,
        impact: { kind: 'question' },
      }),
  });
  intakeTransaction(
    f.db,
    () => selectedEnvelopeStore(f.db, file as never).collections.stage(prepared.prepared!),
    { operationId: op, fingerprint },
  );
  await prepareRetainedPlanAccess(f.db, f.profileId, f.id);
  assert.equal(
    intakeWorkCounters(f.db).reconstruction.retainedPlanUnits,
    counted.retainedPlanUnits,
  );
  const warm = readRetainedIntakeUnitScope(f.db, f.root, f.profileId, f.id, oldOnly);
  assert.equal(warm.format, 'retained');
  if (warm.format === 'retained') assert.equal(warm.scope.unitCount, 2);
  assert.equal(
    readRetainedPlanScope(f.db, f.profileId, f.id, {
      planId: historical.scope.planId,
    })!.accountedKind(sharedId),
    'extracted',
  );
});

test('historical native recipe scope selects requested plan while unit lookup retains first active precedence', async (t) => {
  const f = fixture(t, 3, (ordinal) => `fictional-${ordinal}-` + 'z'.repeat(12000) + '.txt'),
    first = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'first',
    });
  const unitId = readPackageUnitPage(f.db, f.root, f.profileId, f.id).units[0]!.id;
  process.env.CRS_AI_MODEL = 'fictional-historical-route';
  const second = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
    version: first.version,
    operationId: 'second',
    replacePlanId: first.plan.id,
  });
  const history = readPackagePlanScope(f.db, f.root, f.profileId, f.id, { planId: first.plan.id })!;
  assert.equal(history.plan.status, 'superseded');
  assert.equal(history.unitById(unitId)!.id, unitId);
  const page = readPackageUnitPage(f.db, f.root, f.profileId, f.id, {
      planId: first.plan.id,
      limit: 1,
      inlineBytes: 0,
    }),
    ref = page.units[0]!;
  assert.equal(page.planId, first.plan.id);
  assert.ok('metadata' in ref);
  if ('metadata' in ref) {
    const detail = readPackageUnitMetadataFragment(f.db, f.root, f.profileId, f.id, ref.metadata, {
      limit: 4096,
    });
    assert.equal(detail.reference.planId, first.plan.id);
    assert.ok(Buffer.byteLength(detail.text) <= 4096);
    assert.equal(readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.planId, second.plan.id);
  }

  await prepareRetainedPlanAccess(f.db, f.profileId, f.id);
  const selected = readRetainedIntakeUnitScope(f.db, f.root, f.profileId, f.id, unitId);
  assert.equal(selected.format, 'native');
  assert.equal(selected.scope.planId, second.plan.id);
});

test('retained role host preserves expanded units, exact duplicate merge semantics, history and cold replay', async (t) => {
  const f = fixture(t, 3),
    legacy = await createIntakePlan(f.db, f.root, f.profileId, f.id, {
      version: f.intake.version,
      operationId: 'roles-expanded-plan',
    }),
    plan = legacy.workflow!.plans[0]!;
  const first = plan.units[0]!.memberId!,
    second = plan.units[1]!.memberId!;
  const role = (memberId: string, reason: string) => ({
    memberId,
    role: 'context' as const,
    coverage: 'context' as const,
    reason,
    references: [],
  });
  const changed = workflowMutation(
    f.db,
    f.root,
    f.profileId,
    f.id,
    { version: legacy.version, operationId: 'role-history-fixture' },
    (workflow) => {
      const selected = workflow.plans[0]!;
      selected.packageRoles = [role(first, 'first literal'), role(first, 'last literal')];
      selected.units[0]!.id = 'fictional-expanded-unit';
      selected.units[0]!.attempts = ['old'];
    },
  );
  const file = f.db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(f.id)!;
  await buildIntakeCollectionEnvelope(f.db, file as never);
  await prepareRetainedPlanAccess(f.db, f.profileId, f.id);
  assert.equal(
    readSelectedPackageRoleHash(f.db, f.profileId, f.id, first),
    workflowHash(role(first, 'first literal')),
  );
  const { saveIntakePackageRolesRead } = await import('../intake-package-plan.ts');
  const input = {
    version: changed.version,
    operationId: 'new-expanded-role',
    planId: plan.id,
    roles: [role(second, 'new literal')],
  };
  const result = await saveIntakePackageRolesRead(f.db, f.root, f.profileId, f.id, input);
  assert.equal(result.version, input.version + 1);
  let scope = readRetainedPlanScope(f.db, f.profileId, f.id)!;
  assert.equal(scope.unitById('fictional-expanded-unit')!.attemptCount, 1);
  assert.equal(
    readSelectedPackageRoleHash(f.db, f.profileId, f.id, first),
    workflowHash(role(first, 'last literal')),
  );
  assert.equal(
    readSelectedPackageRoleHash(f.db, f.profileId, f.id, second),
    workflowHash({
      memberId: second,
      role: 'context',
      reason: 'new literal',
      coverage: 'context',
      references: [],
    }),
  );
  const prior = intakeSourceVersion(f.db, f.id);
  clearIntakeStateCache(f.db);
  const replay = await saveIntakePackageRolesRead(f.db, f.root, f.profileId, f.id, input);
  assert.equal(replay.version, result.version);
  assert.deepEqual(intakeSourceVersion(f.db, f.id), prior);
  scope = readRetainedPlanScope(f.db, f.profileId, f.id)!;
  assert.equal(scope.reader.childCount(scope.record, 'packageRolesHistory'), 1);
  await assert.rejects(
    saveIntakePackageRolesRead(f.db, f.root, f.profileId, f.id, {
      ...input,
      roles: [role(second, 'different')],
    }),
    /different request/,
  );
});
