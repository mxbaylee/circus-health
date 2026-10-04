import { clearCollectionProcessingException } from '../intake-processing-exceptions.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  uploadIntake,
  createIntakePlan,
  workflowMutation,
  getIntakeRead,
  getRetainedIntakeOriginalReference,
} from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { runBatchProcessingException } from '../intake-batches.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { isIntakeSummary } from '../../shared/intake-summary.ts';
import { selectedFixtureValue } from './helpers/selected-intake.ts';
import { workflowHash } from '../intake-workflow.ts';
import { fictionalModel } from './fictional-model.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
type Workflow = Parameters<Parameters<typeof workflowMutation>[5]>[0];

function gate(t: TestContext) {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  t.signal.addEventListener('abort', resolve, { once: true });
  t.after(resolve);
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-batch-exception-owner-'));
  const profileId = 'fictional-exception-owner';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const objects = new Map<string, Buffer>();
  let heads = 0;
  attachPersonalDurability(db, {
    root,
    profileId,
    recordStorage: {
      read: (name) => objects.get(name) ?? null,
      writeImmutable: (name, bytes) => {
        assert.equal(objects.has(name), false);
        objects.set(name, Buffer.from(bytes));
      },
      publishHead: (bytes) => {
        heads++;
        objects.set('head', Buffer.from(bytes));
      },
    },
  });
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    bytes: Buffer.from('Fictional retained source.'),
  });
  const planned = await createIntakePlan(db, root, profileId, source.id, {
    version: source.version,
  });
  workflowMutation(
    db,
    root,
    profileId,
    source.id,
    { version: planned.version, operationId: 'fictional-two-stalls' },
    (workflow) => {
      const plan = workflow.plans[0]!;
      plan.units = ['fictional-unit-a', 'fictional-unit-b'].map((id) => ({
        id,
        kind: 'text',
        locator: 'Fictional retained source',
        status: 'pending',
        attempts: [],
        processingException: { reason: 'processing_stalled', at: '2026-10-04T00:00:00Z' },
      }));
    },
  );
  const selected = getIntakeRead(db, root, profileId, source.id);
  assert.equal(isIntakeSummary(selected), false);
  const flow = () => selectedFixtureValue<Workflow>(db, source.id, ['intake', 'workflow']);
  return {
    root,
    profileId,
    db,
    source,
    selected,
    flow,
    heads: () => heads,
    objects,
    current: () => getIntakeRead(db, root, profileId, source.id),
  };
}
const clearUnit = () => ({
  kind: 'clear-unit' as const,
  unitId: 'fictional-unit-a',
  batchId: 'fictional-batch',
  epoch: 0,
  operationId: 'resume-stall:fictional-batch:fictional-unit-a:0',
});

for (const kind of ['set', 'clear-unit', 'clear'] as const)
  test(
    `queued batch ${kind} selects newly native representation without rebasing semantic authority`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t),
        entered = gate(t),
        release = gate(t);
      let readsAfterConversion = -1;
      const owner = runExclusiveClinicalOperation(f.db, async () => {
        entered.resolve();
        await release.promise;
        const built = await buildIntakeCollectionEnvelope(f.db, { id: f.source.id });
        assert.ok(built);
        assert.equal(f.current().version, f.selected.version);
        readsAfterConversion = intakeWorkCounters(f.db).warm.materializationReads;
      });
      await entered.promise;
      const command =
        kind === 'clear-unit'
          ? clearUnit()
          : kind === 'clear'
            ? { kind, operationId: 'fictional-clear-all' }
            : {
                kind,
                operationId: 'fictional-set',
                unitId: 'fictional-unit-a',
                at: '2026-10-04T01:00:00Z',
              };
      const work = runBatchProcessingException(
        f.db,
        f.root,
        f.profileId,
        f.selected,
        command,
        () => {},
      );
      t.after(async () => {
        release.resolve();
        await Promise.allSettled([owner, work]);
      });
      release.resolve();
      await owner;
      await work;
      assert.ok(isIntakeSummary(f.current()));
      assert.equal(f.current().version, f.selected.version + 1);
      assert.equal(intakeWorkCounters(f.db).warm.materializationReads, readsAfterConversion);
      const flow = f.flow(),
        units = flow.plans[0]!.units;
      assert.equal(!!units[0]!.processingException, kind === 'set');
      assert.equal(!!units[1]!.processingException, kind !== 'clear');
      const request =
        kind === 'clear-unit'
          ? { operationId: command.operationId, kind, unitId: 'fictional-unit-a' }
          : { operationId: command.operationId };
      assert.equal(
        flow.operations.find((op) => op.id === command.operationId)!.fingerprint,
        workflowHash(request),
      );
      const heads = f.heads(),
        version = f.current().version;
      await runBatchProcessingException(f.db, f.root, f.profileId, f.selected, command, () => {});
      assert.equal(f.current().version, version);
      assert.equal(
        f.heads(),
        heads,
        'Exact native replay publishes nothing despite original old version',
      );
    },
  );

test(
  'historical legacy clear-unit replay survives conversion without a weaker new receipt',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      command = clearUnit();
    await runBatchProcessingException(f.db, f.root, f.profileId, f.selected, command, () => {});
    await buildIntakeCollectionEnvelope(f.db, { id: f.source.id });
    const before = f.flow(),
      version = f.current().version,
      heads = f.heads(),
      count = f.objects.size;
    assert.equal(
      before.operations.find((op) => op.id === command.operationId)!.fingerprint,
      workflowHash({ operationId: command.operationId }),
    );
    await runBatchProcessingException(f.db, f.root, f.profileId, f.selected, command, () => {});
    assert.deepEqual(f.flow(), before);
    assert.equal(f.current().version, version);
    assert.equal(f.heads(), heads);
    assert.equal(f.objects.size, count);
    for (const changed of [
      { ...command, unitId: 'fictional-unit-b' },
      { ...command, operationId: 'not-derived' },
    ])
      await assert.rejects(
        runBatchProcessingException(f.db, f.root, f.profileId, f.selected, changed, () => {}),
        { code: 'OPERATION_CONFLICT' },
      );
    assert.deepEqual(f.flow(), before);
  },
);

test(
  'native clear-unit strong fingerprint cannot replay for another unit',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      command = clearUnit();
    await buildIntakeCollectionEnvelope(f.db, { id: f.source.id });
    // The native API can retain a stronger receipt whose ID has the batch's valid
    // shape, but whose authenticated request names another unit. The helper must
    // reach both receipt checks, rather than fail only its identity precondition.
    await clearCollectionProcessingException(f.db, f.root, f.profileId, f.source.id, {
      version: f.selected.version,
      operationId: command.operationId,
      unitId: 'fictional-unit-b',
    });
    const before = f.flow(),
      heads = f.heads();
    assert.equal(
      before.operations.find((op) => op.id === command.operationId)!.fingerprint,
      workflowHash({
        operationId: command.operationId,
        kind: 'clear-unit',
        unitId: 'fictional-unit-b',
      }),
    );
    assert.ok(before.plans[0]!.units[0]!.processingException);
    assert.equal(before.plans[0]!.units[1]!.processingException, undefined);
    await assert.rejects(
      runBatchProcessingException(f.db, f.root, f.profileId, f.selected, command, () => {}),
      { code: 'OPERATION_CONFLICT' },
    );
    assert.deepEqual(f.flow(), before);
    assert.equal(f.heads(), heads);
  },
);

for (const drift of [
  'version',
  'source hash',
  'physical original',
  'authorization',
  'close',
] as const)
  test(
    `queued batch exception fresh work refuses ${drift} drift`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t),
        entered = gate(t),
        release = gate(t);
      let live = true;
      const owner = runExclusiveClinicalOperation(f.db, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const work = runBatchProcessingException(
        f.db,
        f.root,
        f.profileId,
        f.selected,
        { kind: 'clear', operationId: 'fictional-queued-clear' },
        () => {
          if (!live) throw Error('Fictional stopped generation');
        },
      );
      const rejection = assert.rejects(
        work,
        drift === 'version'
          ? { code: 'VERSION_CONFLICT' }
          : drift === 'source hash'
            ? (error: unknown) =>
                error instanceof Error &&
                error.message === 'Intake envelope authority: missing selected intake head'
            : drift === 'physical original'
              ? { code: 'SOURCE_CHANGED' }
              : drift === 'authorization'
                ? /Fictional stopped generation/
                : /no longer active|database is not open/,
      );
      t.after(async () => {
        release.resolve();
        await Promise.allSettled([owner, work, rejection]);
      });
      const original = getRetainedIntakeOriginalReference(f.db, f.root, f.profileId, f.source.id),
        bytes = readFileSync(original.path);
      let heads = 0;
      try {
        if (drift === 'version')
          workflowMutation(
            f.db,
            f.root,
            f.profileId,
            f.source.id,
            { version: f.selected.version, operationId: 'fictional-newer-version' },
            () => {},
          );
        else if (drift === 'source hash')
          transaction(f.db, () =>
            f.db
              .prepare('UPDATE source_files SET sha256=? WHERE id=?')
              .run('f'.repeat(64), f.source.id),
          );
        else if (drift === 'physical original')
          writeFileSync(original.path, Buffer.from('Fictional replacement'));
        else if (drift === 'authorization') live = false;
        else f.db.close();
        heads = f.heads();
      } finally {
        release.resolve();
      }
      await rejection;
      await Promise.allSettled([owner]);
      assert.equal(f.heads(), heads, 'Queued refused command did not publish');
      if (drift === 'physical original') writeFileSync(original.path, bytes);
    },
  );

test(
  'current clinical owner awaits native batch exception work without nested admission deadlock',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await buildIntakeCollectionEnvelope(f.db, { id: f.source.id });
    await runExclusiveClinicalOperation(f.db, async () => {
      await runBatchProcessingException(
        f.db,
        f.root,
        f.profileId,
        f.selected,
        { kind: 'clear', operationId: 'fictional-nested-clear' },
        () => {},
      );
    });
    assert.equal(f.current().version, f.selected.version + 1);
    assert.ok(f.flow().plans[0]!.units.every((unit) => !unit.processingException));
  },
);
