import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, revision, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, reviewIntake, importIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  previewNativeRecordOwnership,
  commitNativeRecordOwnership,
  clearNativeOwnershipPlans,
} from '../record-ownership-native.ts';
import {
  ownershipReceiptReference,
  replayOwnershipReceiptReference,
  ownershipOutcomePage,
  ownershipOutcomeDigest,
} from '../ownership-outcome-page.ts';
import { ownershipHash, appendOwnershipDecision } from '../ownership-journal.ts';
import { retainOwnershipPlan, childOwnershipOperation } from '../ownership-groups.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import {
  prepareOwnershipDecisionIndex,
  ownershipDecisionIndexWork,
  ownershipReceiptIndexWork,
} from '../ownership-decision-index.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  type RecordStorage,
} from '../record-versions.ts';
import type { OwnershipOutcomeEvidenceItem } from '../../shared/ownership-report-reference.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';
import type { IncomingMessage } from 'node:http';
import { handleRecordOwnershipRoute } from '../record-ownership-routes.ts';

for (const partial of [false, true])
  test(`native independent group receipts page exact outcomes and replay after recovery (partial=${partial})`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-native-parent-receipt-')),
      profileId = 'fictional-parent',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId),
      objects = new Map<string, Buffer>();
    const storage: RecordStorage = {
      read(name) {
        const bytes = objects.get(name);
        return bytes ? Buffer.from(bytes) : null;
      },
      writeImmutable(name, bytes) {
        const prior = objects.get(name);
        if (prior) assert.deepEqual(prior, Buffer.from(bytes));
        else objects.set(name, Buffer.from(bytes));
      },
      publishHead(bytes) {
        objects.set('head', Buffer.from(bytes));
      },
    };
    attachPersonalDurability(db, { root, profileId, recordStorage: storage });
    t.after(() => {
      clearNativeOwnershipPlans(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const originals: string[] = [];
    for (const [group, labels] of [['Amber reach'], ['Jade rhythm']].entries()) {
      const envelopes: HealthRecordEnvelope[] = labels.map((label, i) => ({
        format: 'health-record-v1',
        id: `fictional-${group}-${i}`,
        kind: 'record',
        payload: { literal: 'Fictional retained evidence' },
        clinical: {
          kind: 'observation',
          subject: 'self',
          date: '2026-01-12',
          testLabel: label,
          valueText: '12.00',
          unit: 'cm',
        },
        provenance: {
          sourceSystem: 'Fictional Clinic',
          sourceRecordId: `fictional-${group}-${i}`,
          capturedVia: null,
          evidenceClass: 'provider_export',
          locator: `Fictional row ${i + 1}`,
        },
        coverage: { status: 'complete_response', notes: [] },
      }));
      const original = uploadIntake(db, root, profileId, {
        filename: `fictional-${group}.jsonl`,
        bytes: Buffer.from(envelopes.map((envelope) => JSON.stringify(envelope)).join('\n')),
        newProviderName: 'Fictional Clinic',
      });
      const review = reviewIntake(db, root, profileId, original.id);
      importIntake(db, root, profileId, original.id, {
        version: review.version,
        reviewToken: review.reviewToken,
        decisions: review.records.map((record) => ({
          recordId: record.id,
          action: 'accept',
          mapping: {},
        })),
      });
      originals.push(original.id);
    }
    for (const id of originals) await buildIntakeCollectionEnvelope(db, { id });
    const previousPeople = Number(
      db.prepare("SELECT COUNT(*) n FROM notes WHERE kind='person'").get()!.n,
    );
    const preview = await previewNativeRecordOwnership(db, root, profileId, {
      selection: {
        type: 'records',
        records: db
          .prepare('SELECT id FROM observations ORDER BY id')
          .all()
          .map((row) => ({ kind: 'observation', recordId: String(row.id) })),
      },
      destination: { newPerson: { fullName: 'Fictional Shared Destination' } },
    });
    assert.ok('reportEvidence' in preview);
    assert.equal(preview.commitGroups.length, 2);
    assert.deepEqual(
      preview.commitGroups.map((group) => group.recordTotal),
      [1, 1],
    );
    const operationId = randomUUID(),
      command = {
        operationId,
        request: preview.request,
        version: preview.version,
        scopeToken: preview.scopeToken,
      };
    let clinicalPublications = 0,
      publications = 0;
    const children = new Set<string>();
    attachRecordDurability(db, {
      profileId,
      storage: {
        ...storage,
        publishHead(bytes) {
          publications++;
          // Preparation can publish auxiliary snapshots. Fail only the second actual clinical unit.
          const publishedChildren = db
            .prepare(
              "SELECT json_extract(coverage_json,'$.receipt.operationId') operationId FROM manual_batches WHERE title='Record ownership correction'",
            )
            .all();
          for (const row of publishedChildren)
            if (!children.has(String(row.operationId))) {
              children.add(String(row.operationId));
              clinicalPublications++;
              if (partial && clinicalPublications === 2)
                throw Error('Fictional later clinical group failure');
            }
          storage.publishHead(bytes);
        },
      },
    });
    const receipt = await commitNativeRecordOwnership(db, root, profileId, command);
    assert.equal(receipt.outcomesIncluded, false);
    assert.equal('outcomes' in receipt, false);
    assert.equal(receipt.moved, partial ? 1 : 2);
    assert.equal(receipt.outcomeTotal, receipt.moved);
    assert.equal(receipt.groups?.length, 2);
    assert.deepEqual(
      receipt.groups?.map((group) => group.status),
      partial ? ['committed', 'needs_review'] : ['committed', 'committed'],
    );
    assert.equal(clinicalPublications, 2);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM notes WHERE kind='person'").get()!.n,
      previousPeople + 1,
    );
    assert.equal(
      db
        .prepare('SELECT COUNT(*) n FROM observations WHERE person_id=?')
        .get(receipt.destinationPersonId)!.n,
      receipt.moved,
    );
    const expected: OwnershipOutcomeEvidenceItem[] = [];
    for (const group of receipt.groups!) {
      assert.equal(group.recordIds.length, 1);
      const child = ownershipReceiptReference(db, profileId, group.operationId);
      assert.equal(Boolean(child), group.status === 'committed');
      for (const row of db
        .prepare(
          "SELECT coverage_json FROM manual_batches WHERE title='Record ownership event' AND json_extract(coverage_json,'$.operationId')=? ORDER BY id",
        )
        .iterate(group.operationId)) {
        const outcome = JSON.parse(String(row.coverage_json));
        expected.push({
          recordId: outcome.recordId,
          kind: outcome.kind,
          destinationRecordId: outcome.destinationRecordId,
          action: outcome.action,
          previousOwnerNoteId: outcome.fromNoteId,
          sourceReport: outcome.sourceReport,
        });
      }
    }
    assert.equal(receipt.outcomeDigest, ownershipHash(expected));
    const actual: OwnershipOutcomeEvidenceItem[] = [];
    let cursor = '',
      firstCursor: string | null = null;
    do {
      const page = ownershipOutcomePage(db, profileId, operationId, cursor, 1);
      assert.equal(page.total, expected.length);
      assert.equal(page.digest, receipt.outcomeDigest);
      assert.equal(page.items.length, 1);
      actual.push(...page.items);
      if (page.complete) {
        assert.equal(page.after, null);
        break;
      }
      assert.ok(page.after?.startsWith('parent-v1.'));
      firstCursor ??= page.after;
      cursor = page.after!;
    } while (true);
    assert.deepEqual(actual, expected);
    const indexed = ownershipDecisionIndexWork(db);
    transaction(db, () => {
      for (let index = 0; index < 512; index++)
        appendOwnershipDecision(db, `fictional-later-history-${index}`, 'Record ownership event', {
          operationId: `fictional-unrelated-operation-${index}`,
          recordId: `fictional-unrelated-record-${index}`,
          payload: 'Fictional unrelated retained history',
        });
    });
    await prepareOwnershipDecisionIndex(db);
    assert.equal(ownershipDecisionIndexWork(db).coldRows, indexed.coldRows);
    assert.equal(ownershipDecisionIndexWork(db).changedRows - indexed.changedRows, 512);
    const indexedBefore = ownershipReceiptIndexWork(db);
    assert.deepEqual(ownershipOutcomePage(db, profileId, operationId, '', 32).items, expected);
    const indexedAfter = ownershipReceiptIndexWork(db);
    assert.equal(indexedAfter.planRows - indexedBefore.planRows, 2);
    assert.equal(indexedAfter.eventRows - indexedBefore.eventRows, expected.length);
    assert.equal(indexedAfter.eventChecks - indexedBefore.eventChecks, partial ? 1 : 0);
    const before = {
      revision: revision(db),
      publications,
      head: Buffer.from(objects.get('head')!),
    };
    assert.deepEqual(replayOwnershipReceiptReference(db, profileId, command), {
      ...receipt,
      replayed: true,
    });
    assert.deepEqual(replayOwnershipReceiptReference(db, profileId, command), {
      ...receipt,
      replayed: true,
    });
    assert.throws(
      () =>
        replayOwnershipReceiptReference(db, profileId, {
          ...command,
          request: { ...command.request, reason: 'Fictional different request' },
        }),
      { code: 'OPERATION_CONFLICT' },
    );
    assert.equal(revision(db), before.revision);
    assert.equal(publications, before.publications);
    assert.deepEqual(objects.get('head'), before.head);
    assert.throws(() => ownershipReceiptReference(db, 'foreign', operationId), {
      code: 'PROFILE_BOUNDARY',
    });
    assert.throws(() => ownershipOutcomePage(db, profileId, operationId, 'not-a-parent-cursor'), {
      code: 'OWNERSHIP_CURSOR',
    });
    const otherOperationCursor =
      'parent-v1.' +
      Buffer.from(
        JSON.stringify([randomUUID(), ownershipHash(receipt), receipt.groups![0]!.id, 'fictional']),
      ).toString('base64url');
    assert.throws(() => ownershipOutcomePage(db, profileId, operationId, otherOperationCursor), {
      code: 'OWNERSHIP_CURSOR',
    });

    const late = db
      .prepare(
        "SELECT id,coverage_json FROM manual_batches WHERE title='Record ownership event' AND json_extract(coverage_json,'$.operationId')=? ORDER BY id DESC LIMIT 1",
      )
      .get(receipt.groups![partial ? 0 : 1]!.operationId)!;
    const corrupted = JSON.parse(String(late.coverage_json));
    corrupted.fromNoteId = 'fictional-corrupted-owner';
    db.prepare('UPDATE manual_batches SET coverage_json=? WHERE id=?').run(
      JSON.stringify(corrupted),
      late.id,
    );
    assert.throws(() => ownershipOutcomePage(db, profileId, operationId, '', 1), /complete digest/);
    assert.throws(() => ownershipReceiptReference(db, profileId, operationId), /complete digest/);
    db.prepare('UPDATE manual_batches SET coverage_json=? WHERE id=?').run(
      late.coverage_json,
      late.id,
    );
    db.prepare('UPDATE manual_batches SET title=? WHERE id=?').run(
      'Fictional missing event',
      late.id,
    );
    assert.throws(
      () => ownershipOutcomePage(db, profileId, operationId, firstCursor ?? '', 1),
      /incomplete/,
    );
    db.prepare('UPDATE manual_batches SET title=? WHERE id=?').run(
      'Record ownership event',
      late.id,
    );
    const childReceipt = db
      .prepare('SELECT id FROM manual_batches WHERE id=?')
      .get('ownership:' + receipt.groups![0]!.operationId)!;
    db.prepare('UPDATE manual_batches SET title=? WHERE id=?').run(
      'Fictional missing child receipt',
      childReceipt.id,
    );
    assert.throws(
      () => ownershipReceiptReference(db, profileId, operationId),
      /child receipt is missing/,
    );
    db.prepare('UPDATE manual_batches SET title=? WHERE id=?').run(
      'Record ownership correction',
      childReceipt.id,
    );

    clearNativeOwnershipPlans(db);
    const recoveredPath = join(root, 'recovered.sqlite');
    rebuildRecordDatabase(recoveredPath, { profileId, storage });
    const recovered = openDatabase(recoveredPath, profileId);
    try {
      assert.deepEqual(ownershipReceiptReference(recovered, profileId, operationId), {
        ...receipt,
        replayed: true,
      });
      const responses: unknown[] = [];
      // Actual concurrent cold route entry must share one complete index preparation.
      await Promise.all(
        [
          { id: operationId, action: undefined },
          { id: 'outcomes', action: operationId },
          { id: operationId, action: undefined },
        ].map(async ({ id, action }) => {
          assert.equal(
            await handleRecordOwnershipRoute({
              resource: 'record-ownership',
              id,
              action,
              method: 'GET',
              req: { headers: {}, url: '/fictional?limit=32' } as IncomingMessage,
              db: recovered,
              root,
              profileId,
              body: async () => {
                throw Error('A receipt read must not request a body');
              },
              respond: (data) => {
                responses.push(data);
              },
            }),
            true,
          );
        }),
      );
      assert.equal(responses.length, 3);
      assert.equal(
        responses.filter(
          (response) =>
            (response as { outcomeDigest?: string }).outcomeDigest === receipt.outcomeDigest,
        ).length,
        2,
      );
      assert.equal(
        responses.filter(
          (response) => (response as { digest?: string }).digest === receipt.outcomeDigest,
        ).length,
        1,
      );
      assert.equal(
        ownershipDecisionIndexWork(recovered).coldRows,
        Number(recovered.prepare('SELECT COUNT(*) n FROM manual_batches').get()!.n),
      );
      assert.deepEqual(replayOwnershipReceiptReference(recovered, profileId, command), {
        ...receipt,
        replayed: true,
      });
      assert.deepEqual(
        ownershipOutcomePage(recovered, profileId, operationId, '', 32).items,
        expected,
      );
      if (firstCursor)
        assert.deepEqual(
          ownershipOutcomePage(recovered, profileId, operationId, firstCursor, 1).items,
          [expected[1]],
        );
      assert.equal(
        recovered
          .prepare('SELECT COUNT(*) n FROM observations WHERE person_id=?')
          .get(receipt.destinationPersonId)!.n,
        receipt.moved,
      );
    } finally {
      recovered.close();
    }
  });

test('parent references preserve legacy children and no-op groups and reject incomplete or over-bound plans', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-parent-receipt-edges-')),
    profileId = 'fictional-parent',
    db = openDatabase(join(root, 'cache.sqlite'), profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const groups = ['fictional-a', 'fictional-b', 'fictional-c']
      .map((id) => ({
        id: ownershipHash([id]),
        recordIds: [id],
        pendingCount: 0,
        atomic: true as const,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    operationId = randomUUID(),
    command = {
      operationId,
      version: 1,
      scopeToken: 'fictional-scope',
      request: {
        selection: {
          type: 'records' as const,
          records: groups.map((group) => ({
            kind: 'observation' as const,
            recordId: group.recordIds[0]!,
          })),
        },
        destination: { noteId: 'fictional-person-note', expectedVersion: 1 },
      },
    };
  transaction(db, () => {
    retainOwnershipPlan(db, operationId, ownershipHash(command), groups, 'fictional-person');
    groups.forEach((group, index) => {
      const child = childOwnershipOperation(operationId, group.id),
        moved = index === 2 ? 0 : 1;
      if (moved)
        appendOwnershipDecision(
          db,
          `ownership-event:${child}:${group.recordIds[0]}`,
          'Record ownership event',
          {
            operationId: child,
            recordId: group.recordIds[0],
            kind: 'observation',
            destinationRecordId: group.recordIds[0],
            action: 'move',
            fromNoteId: 'fictional-self',
            toPersonId: 'fictional-person',
          },
        );
      appendOwnershipDecision(db, 'ownership:' + child, 'Record ownership correction', {
        fingerprint: ownershipHash([child]),
        receipt: {
          operationId: child,
          at: '2026-01-01T00:00:00.000Z',
          destinationPersonId: 'fictional-person',
          moved,
          unchanged: 1 - moved,
          pending: 0,
          replayed: false,
          groupId: group.id,
          ...(index === 1
            ? {}
            : {
                outcomesIncluded: false,
                outcomeTotal: moved,
                outcomeDigest: ownershipOutcomeDigest(db, child),
                outcomesUrl: 'ignored-derived-url',
              }),
        },
      });
    });
  });
  const receipt = ownershipReceiptReference(db, profileId, operationId)!;
  assert.equal(receipt.moved, 2);
  assert.equal(receipt.unchanged, 1);
  assert.deepEqual(
    receipt.groups?.map((group) => group.status),
    ['committed', 'committed', 'committed'],
  );
  assert.deepEqual(replayOwnershipReceiptReference(db, profileId, command), receipt);
  const first = ownershipOutcomePage(db, profileId, operationId, '', 1);
  assert.equal(first.total, 2);
  assert.equal(first.digest, receipt.outcomeDigest);
  assert.ok(first.after);
  const second = ownershipOutcomePage(db, profileId, operationId, first.after!, 1);
  assert.equal(second.complete, true);
  assert.deepEqual(
    [first.items[0]!.recordId, second.items[0]!.recordId],
    groups.slice(0, 2).map((group) => group.recordIds[0]),
  );

  // Losing a zero-outcome receipt changes group status even though the outcome digest is unchanged.
  const noOpId = 'ownership:' + childOwnershipOperation(operationId, groups[2]!.id);
  db.prepare('UPDATE manual_batches SET title=? WHERE id=?').run(
    'Fictional missing no-op receipt',
    noOpId,
  );
  const partial = ownershipReceiptReference(db, profileId, operationId)!;
  assert.equal(partial.outcomeDigest, receipt.outcomeDigest);
  assert.equal(partial.groups![2]!.status, 'needs_review');
  assert.throws(() => ownershipOutcomePage(db, profileId, operationId, first.after!, 1), {
    code: 'OWNERSHIP_CURSOR',
  });
  db.prepare('UPDATE manual_batches SET title=? WHERE id=?').run(
    'Record ownership correction',
    noOpId,
  );
  const selected = db
      .prepare('SELECT coverage_json FROM manual_batches WHERE id=?')
      .get(`ownership-plan:${operationId}:${groups[0]!.id}`)!,
    malformed = JSON.parse(String(selected.coverage_json));
  malformed.totalGroups = 4;
  db.prepare('UPDATE manual_batches SET coverage_json=? WHERE id=?').run(
    JSON.stringify(malformed),
    `ownership-plan:${operationId}:${groups[0]!.id}`,
  );
  assert.throws(
    () => ownershipReceiptReference(db, profileId, operationId),
    /malformed or incomplete/,
  );
  db.prepare('UPDATE manual_batches SET coverage_json=? WHERE id=?').run(
    selected.coverage_json,
    `ownership-plan:${operationId}:${groups[0]!.id}`,
  );
  const missingPlanId = `ownership-plan:${operationId}:${groups[2]!.id}`;
  db.prepare('UPDATE manual_batches SET title=? WHERE id=?').run(
    'Fictional missing group plan',
    missingPlanId,
  );
  assert.throws(
    () => ownershipReceiptReference(db, profileId, operationId),
    /malformed or incomplete/,
  );
  db.prepare('UPDATE manual_batches SET title=? WHERE id=?').run(
    'Ownership correction group',
    missingPlanId,
  );

  const overflowOperation = randomUUID();
  for (let index = 0; index <= 1000; index++)
    appendOwnershipDecision(db, `fictional-overflow-${index}`, 'Ownership correction group', {
      parentOperationId: overflowOperation,
    });
  assert.throws(
    () => ownershipReceiptReference(db, profileId, overflowOperation),
    /exceeds its bound/,
  );
});
