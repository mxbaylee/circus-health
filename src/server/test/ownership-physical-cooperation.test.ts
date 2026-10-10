import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, type DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { withManagedPhysicalMutation } from '../clinical-review-physical-epoch.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { selectedContributorHead } from '../contributor-durability.ts';
import {
  openDatabase,
  observeTransactionBeforePublication,
  observeTransactionOutcome,
} from '../database.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { importIntake, reviewIntake, uploadIntake } from '../intake.ts';
import { intakeFileIdentity } from '../intake-files.ts';
import { createNote } from '../notes.ts';
import { childOwnershipOperation } from '../ownership-groups.ts';
import {
  captureOwnershipReportOriginalProof,
  ownershipReportOriginalProofCurrent,
  verifiedOwnershipReportOriginalArtifacts,
  type OwnershipReportOriginalProof,
} from '../ownership-report-plan.ts';
import { attachPersonalDurability } from '../portable.ts';
import {
  captureRecordPublicationOriginals,
  withRecordPublicationOriginals,
  closeRecordPublicationOriginals,
  type RecordPublicationOriginals,
} from '../record-versions.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import {
  clearNativeOwnershipPlans,
  commitNativeRecordOwnership,
  nativeOwnershipReportPlan,
  previewNativeRecordOwnership,
  withNativeOwnershipNamePlan,
  withNativeOwnershipReportPlan,
} from '../record-ownership-native.ts';

async function fixture(
  t: TestContext,
  beforePreview?: (db: DatabaseSync, path: string) => void,
  originalCount = 1,
) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-ownership-physical-')),
    profileId = 'fictional';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearNativeOwnershipPlans(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const destination = createNote(db, {
    kind: 'person',
    title: 'Fictional Recipient',
    person: { fullName: 'Fictional Recipient' },
  });
  const originals: string[] = [];
  for (let index = 0; index < originalCount; index++) {
    const recordId = index === 0 ? 'fictional' : `fictional-${index}`;
    const original = uploadIntake(db, root, profileId, {
      filename: 'fictional.jsonl',
      newProviderName: 'Fictional Clinic',
      bytes: Buffer.from(
        JSON.stringify({
          format: 'health-record-v1',
          id: recordId,
          kind: 'record',
          payload: { literal: 'Fictional retained evidence' },
          clinical: {
            kind: 'observation',
            subject: 'self',
            date: '2026-01-12',
            testLabel: index === 0 ? 'Fictional reach' : 'Jade rhythm',
            valueText: '12.00',
            unit: 'cm',
          },
          provenance: {
            sourceSystem: 'Fictional Clinic',
            sourceRecordId: recordId,
            capturedVia: null,
            evidenceClass: 'provider_export',
            locator: 'Fictional row 1',
          },
          coverage: { status: 'complete_response', notes: [] },
        }),
      ),
    });
    const review = reviewIntake(db, root, profileId, original.id);
    importIntake(db, root, profileId, original.id, {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
    });
    originals.push(original.id);
  }
  for (const id of originals) await buildIntakeCollectionEnvelope(db, { id });
  const records = db.prepare('SELECT id FROM observations ORDER BY id').all();
  const path = profileOriginal(
    root,
    db.prepare('SELECT path FROM source_files WHERE id=?').get(originals[0]!)!.path,
    profileId,
  );
  beforePreview?.(db, path);
  const preview = await previewNativeRecordOwnership(db, root, profileId, {
    selection: {
      type: 'records',
      records: records.map((record) => ({ kind: 'observation', recordId: String(record.id) })),
    },
    destination: { noteId: destination.id, expectedVersion: destination.version },
  });
  assert.ok('reportEvidence' in preview);
  return {
    root,
    db,
    profileId,
    preview,
    path,
  };
}

test('ownership physical read closures cooperate and reject writes to the selected preview', async (t) => {
  const f = await fixture(t);
  let unrelated = false;
  const read = withNativeOwnershipReportPlan(
    f.db,
    f.profileId,
    f.preview.reportEvidence.token,
    (plan) => plan.page('records'),
  );
  setImmediate(() => {
    unrelated = true;
  });
  const page = await read;
  assert.equal(unrelated, true);
  assert.equal(page.total, 1);
  const report = nativeOwnershipReportPlan(f.db, f.profileId, f.preview.reportEvidence.token);
  await assert.rejects(
    report.withVerifiedRead(() => report.finalize()),
    /preview changed during verification/,
  );
  assert.equal((await report.finalizeVerified()).scopeToken, f.preview.scopeToken);
});

test('ownership name and report evidence retain the original physical baseline across a host turn', async (t) => {
  const f = await fixture(t);
  const read = withNativeOwnershipNamePlan(
    f.db,
    f.profileId,
    f.preview.nameEvidence.token,
    (plan) => plan.effects(),
  );
  setImmediate(() =>
    withManagedPhysicalMutation(() => writeFileSync(f.path, 'Changed fictional source')),
  );
  await assert.rejects(read, /physical evidence changed|Retained clinical evidence changed/);
  await assert.rejects(
    withNativeOwnershipReportPlan(f.db, f.profileId, f.preview.reportEvidence.token, (plan) =>
      plan.page('records'),
    ),
    /physical evidence changed/,
  );
});

for (const kind of ['report', 'name'] as const)
  test(`ownership ${kind} read refuses raw original replacement during result rendering`, async (t) => {
    const f = await fixture(t),
      bytes = readFileSync(f.path),
      identity = intakeFileIdentity(f.path);
    let rendered = false;
    const replace = () => {
      rendered = true;
      writeFileSync(f.path, bytes);
      assert.notEqual(intakeFileIdentity(f.path), identity);
    };
    let failure: unknown;
    try {
      if (kind === 'report')
        await withNativeOwnershipReportPlan(
          f.db,
          f.profileId,
          f.preview.reportEvidence.token,
          (plan) => {
            const value = plan.page('records');
            assert.equal(value.total, 1);
            replace();
            return value;
          },
        );
      else
        await withNativeOwnershipNamePlan(
          f.db,
          f.profileId,
          f.preview.nameEvidence.token,
          (plan) => {
            const value = plan.effects();
            replace();
            return value;
          },
        );
    } catch (error) {
      failure = error;
    }
    assert.equal(rendered, true, 'the real result was rendered before replacing its evidence');
    assert.deepEqual(readFileSync(f.path), bytes);
    assert.ok(failure instanceof Error, 'read activation must refuse a changed original identity');
    assert.match(failure.message, /physical|original|Retained clinical evidence changed/i);
  });

test('ownership readonly handoff never calls a contributor cancellation override after its proof', async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    bytes = readFileSync(f.path),
    identity = intakeFileIdentity(f.path);
  let armed = false,
    lateCalls = 0;
  Object.defineProperty(controller.signal, 'throwIfAborted', {
    configurable: true,
    value() {
      if (armed) {
        lateCalls++;
        writeFileSync(f.path, bytes);
      }
    },
  });
  const value = await withNativeOwnershipReportPlan(
    f.db,
    f.profileId,
    f.preview.reportEvidence.token,
    (plan) => {
      const page = plan.page('records');
      armed = true;
      return page;
    },
    { signal: controller.signal },
  );
  assert.equal(value.total, 1);
  assert.equal(lateCalls, 0);
  assert.equal(intakeFileIdentity(f.path), identity);
});

test('ownership readonly refuses unrecognized post-read ancestor work', async (t) => {
  const f = await fixture(t);
  let rendered = false,
    afterRead = false;
  await assert.rejects(
    runExclusiveClinicalOperation(f.db, async () => {
      const value = await withNativeOwnershipReportPlan(
        f.db,
        f.profileId,
        f.preview.reportEvidence.token,
        (plan) => {
          rendered = true;
          return plan.page('records');
        },
      );
      afterRead = true;
      return value;
    }),
    /Original ownership read authority changed/,
  );
  assert.equal(rendered, false);
  assert.equal(afterRead, false);
});

test('ownership readonly preserves native cancellation during its actual original worker page', async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    postMessage = Worker.prototype.postMessage;
  let fired = false,
    callerMethods = 0;
  Object.defineProperty(controller.signal, 'throwIfAborted', {
    configurable: true,
    value() {
      callerMethods++;
    },
  });
  Worker.prototype.postMessage = function (message, ...rest) {
    Reflect.apply(postMessage, this, [message, ...rest]);
    if (
      !fired &&
      message?.type === 'page' &&
      message.items?.some((item: { path?: string }) => item.path === f.path)
    ) {
      fired = true;
      controller.abort();
    }
  };
  t.after(() => {
    Worker.prototype.postMessage = postMessage;
  });
  await assert.rejects(
    withNativeOwnershipReportPlan(
      f.db,
      f.profileId,
      f.preview.reportEvidence.token,
      (plan) => plan.page('records'),
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
  assert.equal(fired, true);
  assert.equal(callerMethods, 0);
});

test('ownership readonly refuses unknown ancestor assertions before rendering', async (t) => {
  const f = await fixture(t);
  let rendered = false;
  await assert.rejects(
    runExclusiveClinicalOperation(
      f.db,
      async () =>
        withNativeOwnershipReportPlan(f.db, f.profileId, f.preview.reportEvidence.token, (plan) => {
          rendered = true;
          return plan.page('records');
        }),
      { assertRunning() {} },
    ),
    /Original ownership read authority changed/,
  );
  assert.equal(rendered, false);
});

test('ownership readonly verifies raw policy effects before its final original proof', async (t) => {
  let armed = false,
    fired = false;
  const f = await fixture(t, (db, path) => {
      const bytes = readFileSync(path);
      db.setAuthorizer((action, table) => {
        if (armed && !fired && action === constants.SQLITE_READ && table === '__record_state') {
          fired = true;
          writeFileSync(path, bytes);
        }
        return constants.SQLITE_OK;
      });
    }),
    bytes = readFileSync(f.path),
    identity = intakeFileIdentity(f.path);
  await assert.rejects(
    withNativeOwnershipReportPlan(f.db, f.profileId, f.preview.reportEvidence.token, (plan) => {
      const page = plan.page('records');
      armed = true;
      return page;
    }),
    /physical|original|Retained clinical evidence changed/i,
  );
  assert.equal(fired, true);
  assert.notEqual(intakeFileIdentity(f.path), identity);
  assert.deepEqual(readFileSync(f.path), bytes);
});

test('ownership publication rejects a source change at the pre-durability terminal guard', async (t) => {
  const f = await fixture(t),
    operationId = randomUUID();
  await nativeOwnershipReportPlan(
    f.db,
    f.profileId,
    f.preview.reportEvidence.token,
  ).prepareSourceSnapshots();
  let reachedTerminal = false;
  const stop = observeTransactionBeforePublication(f.db, () => {
    reachedTerminal = true;
    withManagedPhysicalMutation(() => writeFileSync(f.path, 'Changed fictional source'));
  });
  t.after(stop);
  await assert.rejects(
    commitNativeRecordOwnership(f.db, f.root, f.profileId, {
      operationId,
      request: f.preview.request,
      scopeToken: f.preview.scopeToken,
      version: f.preview.version,
    }),
    /Retained clinical evidence changed/,
  );
  assert.equal(reachedTerminal, true);
  assert.equal(
    f.db.prepare('SELECT 1 FROM manual_batches WHERE id=?').get('ownership:' + operationId),
    undefined,
  );
  assert.equal(f.db.prepare('SELECT person_id FROM observations').get()!.person_id, 'patient');
});

test('ownership publication refuses a raw same-byte original rewrite inside its final callback', async (t) => {
  const f = await fixture(t),
    operationId = randomUUID();
  await nativeOwnershipReportPlan(
    f.db,
    f.profileId,
    f.preview.reportEvidence.token,
  ).prepareSourceSnapshots();
  const beforeHead = selectedContributorHead(f.root, f.profileId),
    beforeRecord = f.db.prepare('SELECT * FROM observations').get(),
    bytes = readFileSync(f.path),
    identity = intakeFileIdentity(f.path);
  let reachedTerminal = false;
  const stop = observeTransactionBeforePublication(f.db, () => {
    reachedTerminal = true;
    writeFileSync(f.path, bytes);
    assert.notEqual(intakeFileIdentity(f.path), identity);
  });
  t.after(stop);
  let failure: unknown;
  try {
    await commitNativeRecordOwnership(f.db, f.root, f.profileId, {
      operationId,
      request: f.preview.request,
      scopeToken: f.preview.scopeToken,
      version: f.preview.version,
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(reachedTerminal, true, 'the actual pre-durability callback rewrote the original');
  assert.deepEqual(readFileSync(f.path), bytes, 'content equality must not conceal replacement');
  assert.ok(failure instanceof Error, 'publication must refuse the changed original identity');
  assert.match(failure.message, /physical|original|Retained clinical evidence changed/i);
  assert.equal(selectedContributorHead(f.root, f.profileId), beforeHead);
  assert.equal(
    f.db.prepare('SELECT 1 FROM manual_batches WHERE id=?').get('ownership:' + operationId),
    undefined,
  );
  assert.deepEqual(f.db.prepare('SELECT * FROM observations').get(), beforeRecord);
});

test('ownership publication refuses a raw original rewrite in installed journal indexing policy', async (t) => {
  let armed = false,
    fired = false;
  const f = await fixture(t, (db, path) => {
    const bytes = readFileSync(path),
      identity = intakeFileIdentity(path);
    db.setAuthorizer((action, table) => {
      if (
        armed &&
        !fired &&
        action === constants.SQLITE_INSERT &&
        table === '__record_transactions'
      ) {
        fired = true;
        writeFileSync(path, bytes);
        assert.notEqual(intakeFileIdentity(path), identity);
      }
      return constants.SQLITE_OK;
    });
  });
  await nativeOwnershipReportPlan(
    f.db,
    f.profileId,
    f.preview.reportEvidence.token,
  ).prepareSourceSnapshots();
  const operationId = randomUUID(),
    beforeHead = selectedContributorHead(f.root, f.profileId),
    beforeRecord = f.db.prepare('SELECT * FROM observations').get(),
    bytes = readFileSync(f.path);
  armed = true;
  let failure: unknown;
  try {
    await commitNativeRecordOwnership(f.db, f.root, f.profileId, {
      operationId,
      request: f.preview.request,
      scopeToken: f.preview.scopeToken,
      version: f.preview.version,
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(armed, true);
  assert.equal(fired, true, 'the unchanged installed policy rewrote the original during indexing');
  assert.deepEqual(readFileSync(f.path), bytes);
  assert.ok(failure instanceof Error, 'indexing must refuse the changed original identity');
  assert.match(failure.message, /physical|original|Retained clinical evidence changed/i);
  assert.equal(selectedContributorHead(f.root, f.profileId), beforeHead);
  assert.equal(
    f.db.prepare('SELECT 1 FROM manual_batches WHERE id=?').get('ownership:' + operationId),
    undefined,
  );
  assert.deepEqual(f.db.prepare('SELECT * FROM observations').get(), beforeRecord);
});

test('original ownership proof transport requires its genuine live plan and parent operation', async (t) => {
  const f = await fixture(t),
    plan = nativeOwnershipReportPlan(f.db, f.profileId, f.preview.reportEvidence.token);
  let proof: OwnershipReportOriginalProof | undefined;
  let worker: RecordPublicationOriginals | undefined;
  t.after(() => {
    if (worker) closeRecordPublicationOriginals(worker);
  });
  await runExclusiveClinicalOperation(f.db, async (operation) => {
    assert.throws(() => captureOwnershipReportOriginalProof({ ...plan }, f.db, f.profileId));
    assert.throws(() => captureOwnershipReportOriginalProof(plan, f.db, 'foreign'));
    let expired: OwnershipReportOriginalProof | undefined;
    await runExclusiveClinicalOperation(
      f.db,
      async () => {
        expired = captureOwnershipReportOriginalProof(plan, f.db, f.profileId);
        assert.equal(ownershipReportOriginalProofCurrent(expired, f.db, f.profileId), true);
        assert.ok([...verifiedOwnershipReportOriginalArtifacts(expired, f.db, f.profileId)].length);
      },
      { operation },
    );
    assert.throws(() => [...verifiedOwnershipReportOriginalArtifacts(expired!, f.db, f.profileId)]);
    assert.equal(ownershipReportOriginalProofCurrent(expired!, f.db, f.profileId), false);
    proof = captureOwnershipReportOriginalProof(plan, f.db, f.profileId);
    assert.equal(ownershipReportOriginalProofCurrent(proof, f.db, f.profileId), true);
    assert.equal(
      ownershipReportOriginalProofCurrent({} as OwnershipReportOriginalProof, f.db, f.profileId),
      false,
    );
    assert.equal(ownershipReportOriginalProofCurrent(proof, f.db, 'foreign'), false);
    assert.throws(() => [
      ...verifiedOwnershipReportOriginalArtifacts(
        {} as OwnershipReportOriginalProof,
        f.db,
        f.profileId,
      ),
    ]);
    assert.throws(() => [...verifiedOwnershipReportOriginalArtifacts(proof!, f.db, 'foreign')]);
    const original = [...verifiedOwnershipReportOriginalArtifacts(proof, f.db, f.profileId)];
    assert.ok(original.some((item) => item.path === f.path));
    worker = await captureRecordPublicationOriginals(f.db, f.profileId, proof);
    await withRecordPublicationOriginals(f.db, worker, (current) => current());
    writeFileSync(f.path, readFileSync(f.path));
    assert.deepEqual(
      [...verifiedOwnershipReportOriginalArtifacts(proof, f.db, f.profileId)],
      original,
    );
    assert.notEqual(
      intakeFileIdentity(f.path),
      original.find((item) => item.path === f.path)!.identity,
    );
    await assert.rejects(
      withRecordPublicationOriginals(f.db, worker, () => assert.fail('new baseline accepted')),
      /Retained clinical evidence changed|Retained physical evidence changed/,
    );
    const paused = verifiedOwnershipReportOriginalArtifacts(proof, f.db, f.profileId);
    assert.equal(paused.next().done, false);
    plan.close();
    assert.equal(ownershipReportOriginalProofCurrent(proof, f.db, f.profileId), false);
    assert.throws(() => paused.next());
    assert.throws(() => [...verifiedOwnershipReportOriginalArtifacts(proof!, f.db, f.profileId)]);
  });
  assert.throws(() => [...verifiedOwnershipReportOriginalArtifacts(proof!, f.db, f.profileId)]);
  assert.equal(ownershipReportOriginalProofCurrent(proof!, f.db, f.profileId), false);
});

test('ownership later groups retain the parent original proof after an earlier accepted receipt', async (t) => {
  const f = await fixture(t, undefined, 2),
    operationId = randomUUID();
  assert.equal(f.preview.commitGroups.length, 2);
  const plan = nativeOwnershipReportPlan(f.db, f.profileId, f.preview.reportEvidence.token),
    groups = (await plan.finalizeVerified()).commitGroups,
    firstId = 'ownership:' + childOwnershipOperation(operationId, groups[0]!.id),
    laterId = 'ownership:' + childOwnershipOperation(operationId, groups[1]!.id),
    laterRequest = plan.requestForGroup(groups[1]!);
  assert.equal(laterRequest.selection.type, 'records');
  if (laterRequest.selection.type !== 'records') throw Error('Expected exact selected records');
  assert.equal(laterRequest.selection.records.length, 1);
  const laterRecordId = laterRequest.selection.records[0]!.recordId,
    laterRecord = f.db.prepare('SELECT * FROM observations WHERE id=?').get(laterRecordId)!,
    laterPath = profileOriginal(
      f.root,
      f.db
        .prepare(
          'SELECT f.path FROM source_files f JOIN source_records r ON r.source_file_id=f.id JOIN observations o ON o.source_record_id=r.id WHERE o.id=?',
        )
        .get(laterRecordId)!.path,
      f.profileId,
    ),
    bytes = readFileSync(laterPath),
    identity = intakeFileIdentity(laterPath);
  let fired = false,
    firstReceipt: unknown;
  const stop = observeTransactionOutcome(f.db, (outcome) => {
    if (!outcome.committed || !outcome.succeeded || fired) return;
    const receipt = f.db.prepare('SELECT * FROM manual_batches WHERE id=?').get(firstId);
    if (!receipt) return;
    firstReceipt = receipt;
    fired = true;
    writeFileSync(laterPath, bytes);
  });
  t.after(stop);
  let failure: unknown;
  try {
    await commitNativeRecordOwnership(f.db, f.root, f.profileId, {
      operationId,
      request: f.preview.request,
      scopeToken: f.preview.scopeToken,
      version: f.preview.version,
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(fired, true, 'the first group was durably accepted before replacing later evidence');
  assert.notEqual(intakeFileIdentity(laterPath), identity);
  assert.deepEqual(readFileSync(laterPath), bytes);
  assert.ok(failure instanceof Error, 'the later group must not adopt a new original baseline');
  assert.deepEqual(
    f.db.prepare('SELECT * FROM manual_batches WHERE id=?').get(firstId),
    firstReceipt,
  );
  assert.equal(f.db.prepare('SELECT 1 FROM manual_batches WHERE id=?').get(laterId), undefined);
  assert.deepEqual(
    f.db.prepare('SELECT * FROM observations WHERE id=?').get(laterRecordId),
    laterRecord,
  );
});

test('profile lock interrupts cooperative ownership evidence and disposes its retained plan', async (t) => {
  const f = await fixture(t);
  const read = withNativeOwnershipReportPlan(
    f.db,
    f.profileId,
    f.preview.reportEvidence.token,
    (plan) => plan.page('records'),
  );
  setImmediate(() => clearNativeOwnershipPlans(f.db));
  await assert.rejects(read, /PROFILE_LOCKED|Unlock this profile|Closed ownership|Closed.*plan/);
  await assert.rejects(
    withNativeOwnershipReportPlan(f.db, f.profileId, f.preview.reportEvidence.token, (plan) =>
      plan.page('records'),
    ),
    /current report evidence/,
  );
});
