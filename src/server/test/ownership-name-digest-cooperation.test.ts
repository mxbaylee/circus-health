import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../database.ts';
import { createNote } from '../notes.ts';
import { prepareOwnershipNamePlan } from '../ownership-name-plan.ts';
import { previewOwnershipNames } from '../ownership-names.ts';
import { ownershipHash } from '../ownership-journal.ts';
import { prepareIntakeLookupIndices } from '../intake-lookup-state.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import type { OwnershipRequest } from '../../shared/record-ownership.ts';

async function fixture(t: TestContext, longTargets = false) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-name-digest-cooperation-')),
    db = openDatabase(join(root, 'cache.sqlite'), 'fictional-name-digest');
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const person = createNote(db, {
      kind: 'person',
      title: 'Fictional Old Owner',
      person: { fullName: 'Fictional Old Owner' },
    }),
    destination = createNote(db, {
      kind: 'person',
      title: 'Fictional New Owner',
      person: { fullName: 'Fictional New Owner' },
    }),
    targets = Array.from({ length: 256 }, (_, ordinal) => ({
      recordId: 'fictional-name-digest-target-' + ordinal + '-\ud83c\udf31',
    }));
  targets[255]!.recordId += '-'.repeat(4077) + '\ud83c\udf31';
  if (longTargets) for (const ordinal of [1, 2]) targets[ordinal]!.recordId += '-'.repeat(60000);
  registerRawIntakeFixture(
    db,
    'original',
    JSON.stringify({
      intake: {
        version: 0,
        workflow: {
          identityConfirmations: [
            {
              operationId: 'fictional-name-confirmation',
              assignedPerson: { personId: person.personId },
              confirmedPrintedName: 'Fictional Printed Owner',
              scope: { intakeId: 'original', groupId: 'group', targets },
            },
          ],
          reportGroups: [{ id: 'group', versions: [{ id: 'version', members: [] }] }],
          reportAcceptances: [],
        },
      },
    }),
  );
  transaction(db, () =>
    db
      .prepare('INSERT INTO source_records(id,source_file_id,raw_json) VALUES(?,?,?)')
      .run(targets[0]!.recordId, 'original', '{}'),
  );
  const sources = new Set([targets[0]!.recordId]),
    owners = new Set([person.personId!]),
    request: OwnershipRequest = {
      selection: { type: 'records', records: [] },
      destination: { noteId: destination.id, expectedVersion: destination.version },
    },
    legacy = previewOwnershipNames(db, sources, owners, request);
  assert.equal(legacy.length, 1);
  await buildIntakeCollectionEnvelope(db, { id: 'original' });
  await prepareIntakeLookupIndices(db);
  return { db, sources, owners, request, legacy, targets };
}

function observeDigest(t: TestContext, onFirstPiece: () => void) {
  const probe = createHash('sha256'),
    prototype = Object.getPrototypeOf(probe) as { update: typeof probe.update },
    update = prototype.update;
  let selected: typeof probe | undefined,
    updates = 0,
    bytes = 0,
    maxChunkCodeUnits = 0;
  t.mock.method(prototype, 'update', function (
    this: typeof probe,
    ...values: Parameters<typeof update>
  ) {
    const piece = values[0];
    if (!selected && piece === '{"affectedSourceIds":[') {
      selected = this;
      onFirstPiece();
    }
    if (this === selected) {
      assert.equal(typeof piece, 'string');
      updates++;
      bytes += Buffer.byteLength(piece as string);
      maxChunkCodeUnits = Math.max(maxChunkCodeUnits, (piece as string).length);
    }
    return Reflect.apply(update, this, values);
  } as typeof update);
  return {
    selected: () => selected !== undefined,
    updates: () => updates,
    bytes: () => bytes,
    maxChunkCodeUnits: () => maxChunkCodeUnits,
    restore: () => t.mock.restoreAll(),
  };
}

test('complete ownership name digest yields inside the actual canonical hash and preserves exact evidence', async (t) => {
  const f = await fixture(t);
  let hostUpdates = 0,
    hostBytes = 0,
    hostTurn = false;
  const observed = observeDigest(t, () => {
    setImmediate(() => {
      hostTurn = true;
      hostUpdates = observed.updates();
      hostBytes = observed.bytes();
    });
  });
  let plan: Awaited<ReturnType<typeof prepareOwnershipNamePlan>> | undefined;
  try {
    plan = await prepareOwnershipNamePlan(
      f.db,
      'fictional-name-digest',
      f.sources,
      f.owners,
      f.request,
    );
  } finally {
    observed.restore();
    t.after(() => plan?.close());
  }
  assert.ok(plan);
  assert.equal(observed.selected(), true);
  assert.equal(hostTurn, true);
  assert.ok(hostUpdates > 0 && hostUpdates < observed.updates());
  assert.ok(hostUpdates <= 64);
  assert.ok(hostBytes <= 64 * 1024);
  assert.ok(observed.maxChunkCodeUnits() <= 4097);
  assert.equal(plan.reference.digest, ownershipHash(f.legacy));
  assert.equal(plan.reference.total, 1);
  assert.equal(plan.reference.supportTotal, 1);
  assert.equal(plan.reference.targetTotal, f.targets.length);
  const key = plan.effects().items[0]!.key,
    support = plan.supports(key).items[0]!;
  const actual: string[] = [];
  let after = -1;
  for (;;) {
    const page = plan.targets(key, support.ordinal, after, 32);
    actual.push(...page.items.map((item) => item.recordId));
    if (page.complete) break;
    after = Number(page.after);
  }
  assert.deepEqual(
    actual,
    f.targets.map((target) => target.recordId),
  );
  plan.assertCurrent();
});

test('cancellation during the actual canonical name hash disposes scratch and publishes no decision', async (t) => {
  const f = await fixture(t),
    before = readdirSync(tmpdir())
      .filter((name) => name.startsWith('fictional-ownership-name-plan-'))
      .sort(),
    acceptedRows = f.db.prepare('SELECT count(*) AS n FROM manual_batches').get()!.n;
  let cancelled = false;
  const observed = observeDigest(t, () =>
    setImmediate(() => {
      cancelled = true;
    }),
  );
  try {
    await assert.rejects(
      prepareOwnershipNamePlan(f.db, 'fictional-name-digest', f.sources, f.owners, f.request, {
        assertRunning() {
          if (cancelled) throw new DOMException('Fictional name hash cancelled', 'AbortError');
        },
      }),
      (error) => error instanceof Error && error.name === 'AbortError',
    );
  } finally {
    observed.restore();
  }
  assert.equal(observed.selected(), true);
  assert.equal(cancelled, true);
  assert.deepEqual(
    readdirSync(tmpdir())
      .filter((name) => name.startsWith('fictional-ownership-name-plan-'))
      .sort(),
    before,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM manual_batches').get()!.n, acceptedRows);
  const fresh = await prepareOwnershipNamePlan(
    f.db,
    'fictional-name-digest',
    f.sources,
    f.owners,
    f.request,
  );
  try {
    assert.equal(fresh.reference.digest, ownershipHash(f.legacy));
  } finally {
    fresh.close();
  }
});

test('canonical name hashing checkpoints the byte budget before a full piece batch', async (t) => {
  const f = await fixture(t, true);
  let hostUpdates = 0,
    hostBytes = 0,
    hostTurn = false;
  const observed = observeDigest(t, () => {
    setImmediate(() => {
      hostTurn = true;
      hostUpdates = observed.updates();
      hostBytes = observed.bytes();
    });
  });
  let plan: Awaited<ReturnType<typeof prepareOwnershipNamePlan>> | undefined;
  try {
    plan = await prepareOwnershipNamePlan(
      f.db,
      'fictional-name-digest',
      f.sources,
      f.owners,
      f.request,
    );
  } finally {
    observed.restore();
    t.after(() => plan?.close());
  }
  assert.ok(plan);
  assert.equal(observed.selected(), true);
  assert.equal(hostTurn, true);
  assert.ok(hostUpdates > 0 && hostUpdates < 64);
  assert.ok(hostBytes > 50 * 1024 && hostBytes <= 64 * 1024);
  assert.ok(observed.maxChunkCodeUnits() <= 4097);
  assert.equal(plan.reference.digest, ownershipHash(f.legacy));
  assert.equal(plan.reference.targetTotal, f.targets.length);
  plan.assertCurrent();
});
