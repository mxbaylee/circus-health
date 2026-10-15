import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createProfileLifecycle } from '../profile-lifecycle.ts';
import { contributorAuthorityPath } from '../contributor-record-storage.ts';
import type { Database } from '../database.ts';
import {
  contributorCopyComparisonGuardWork,
  contributorCopyEqualityWork,
  contributorCopySourceTextInventory,
  disposeContributorCopyCertification,
  prepareContributorCopyCertification,
} from '../contributor-durability.ts';

test('source-text inventory reuses exact native equality under its original intervals', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-copy-inventory-reuse-')),
    databases = new Map<string, Database>(),
    lifecycle = createProfileLifecycle({ root, databases });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await lifecycle.create({
      name: 'Fictional source inventory',
      fullName: 'Fictional source inventory',
      birthDate: '1980-02-17',
    }),
    db = databases.get(source.id)!,
    certification = await prepareContributorCopyCertification(db, root, source.id);
  try {
    const compared = contributorCopyEqualityWork(db);
    const guards = contributorCopyComparisonGuardWork(db);
    assert.ok(compared.rows > 0, 'initial certification consumes actual source rows');
    assert.ok(compared.bytes > 0, 'initial certification encodes actual source bytes');
    assert.ok(guards.steps > 0, 'comparison advances cooperatively');
    assert.ok(
      guards.steps < compared.rows * 8,
      'small row syntax shares guarded hash quanta instead of yielding per fragment',
    );
    assert.equal(guards.fullChecks, guards.steps + 2);
    // One complete proof per guarded window of up to 16 back-to-back quanta,
    // windows growing 1, 2, 4, 8 and 16: never one proof per row quantum.
    assert.ok(guards.quanta > guards.steps, 'windows run several bounded quanta');
    assert.ok(
      guards.steps <= Math.ceil(Math.max(0, guards.quanta - 15) / 16) + 4,
      `windows ${guards.steps} scale with quanta ${guards.quanta} / 16`,
    );
    assert.ok(
      guards.nestedChecks > guards.fullChecks,
      'native column checks stay pinned without multiplying full original proof',
    );
    const inventory = await contributorCopySourceTextInventory(certification, db, root, source.id);
    assert.deepEqual(contributorCopyEqualityWork(db), compared);
    assert.deepEqual(contributorCopyComparisonGuardWork(db), guards);
    assert.equal(inventory.has('owner_profile_id'), true);
    assert.equal(inventory.has('fictional-absent-source-text'), false);
    db.exec(
      "BEGIN; INSERT INTO app_meta(key,value) VALUES('fictional-inventory-aba','temporary'); ROLLBACK",
    );
    assert.throws(() => inventory.has('owner_profile_id'), /read interval changed/);
    await assert.rejects(
      contributorCopySourceTextInventory(certification, db, root, source.id),
      /read interval changed/,
    );
    assert.deepEqual(contributorCopyEqualityWork(db), compared);
    t.diagnostic(
      JSON.stringify({ initialSourceEquality: compared, guards, inventoryAdditionalRows: 0 }),
    );
  } finally {
    await disposeContributorCopyCertification(certification);
  }
});

test('a same-byte original rewrite during a batched equality yield refuses certification', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-copy-quantum-rewrite-')),
    databases = new Map<string, Database>(),
    lifecycle = createProfileLifecycle({ root, databases });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await lifecycle.create({
      name: 'Fictional quantum source',
      fullName: 'Fictional quantum source',
      birthDate: '1980-02-17',
    }),
    db = databases.get(source.id)!,
    controller = new AbortController();
  const attempt = prepareContributorCopyCertification(
    db,
    root,
    source.id,
    undefined,
    controller.signal,
  ).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  let settled = false;
  void attempt.then(() => {
    settled = true;
  });
  let faulted = false;
  try {
    const deadline = performance.now() + 15000;
    while (
      !settled &&
      contributorCopyComparisonGuardWork(db).steps < 2 &&
      performance.now() < deadline
    )
      await setImmediate();
    assert.ok(
      !settled && contributorCopyComparisonGuardWork(db).steps >= 2,
      'fictional comparison reached a cooperative row quantum',
    );
    const head = join(contributorAuthorityPath(root, source.id), 'head');
    writeFileSync(head, readFileSync(head));
    faulted = true;
    const outcome = await attempt;
    assert.equal(outcome.value, undefined);
    assert.match(String(outcome.error), /changed|physical/i);
  } finally {
    if (!faulted) controller.abort();
    const outcome = await attempt;
    if (outcome.value) await disposeContributorCopyCertification(outcome.value);
  }
});

// The comparison no longer repeats the complete original proof after each
// non-final step; a same-byte HEAD replacement made inside a synchronous step
// must still be refused by the proof that precedes the next step.
test('a same-byte original rewrite inside a guarded comparison step refuses certification', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-copy-step-rewrite-')),
    databases = new Map<string, Database>(),
    lifecycle = createProfileLifecycle({ root, databases });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await lifecycle.create({
      name: 'Fictional step source',
      fullName: 'Fictional step source',
      birthDate: '1980-02-17',
    }),
    db = databases.get(source.id)!,
    controller = new AbortController(),
    head = join(contributorAuthorityPath(root, source.id), 'head'),
    abortable = controller.signal.throwIfAborted.bind(controller.signal);
  let rewrittenAtStep: number | undefined,
    nestedSeen = -1;
  // Nested native-column checks run inside a step; this fictional fault uses
  // that genuine synchronous point rather than a yield.
  controller.signal.throwIfAborted = () => {
    const { steps, nestedChecks } = contributorCopyComparisonGuardWork(db);
    // A nested check is counted inside a comparison step just before this call.
    if (
      rewrittenAtStep === undefined &&
      steps >= 1 &&
      nestedSeen >= 0 &&
      nestedChecks > nestedSeen
    ) {
      rewrittenAtStep = steps;
      writeFileSync(head, readFileSync(head));
    }
    nestedSeen = nestedChecks;
    abortable();
  };
  const outcome = await prepareContributorCopyCertification(
    db,
    root,
    source.id,
    undefined,
    controller.signal,
  ).then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined, error }),
  );
  if (outcome.value) await disposeContributorCopyCertification(outcome.value);
  assert.ok(rewrittenAtStep !== undefined, 'fictional rewrite ran inside a comparison step');
  assert.equal(outcome.value, undefined, 'certification refused the replaced HEAD');
  assert.match(String(outcome.error), /changed|physical/i);
  assert.ok(
    contributorCopyComparisonGuardWork(db).steps <= rewrittenAtStep + 1,
    'refusal precedes any further comparison step',
  );
});
