import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  ownershipIntakeScopes,
  ownershipIntakeScopeOccurrences,
} from '../ownership-intake-scopes.ts';
import { fixture } from './intake-identity-native-fixture.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { createReportMemberSnapshot } from '../intake-report-member-state.ts';

import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeWorkflowCommand } from '../intake-workflow-command.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { transaction } from '../database.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import type { IntakeReportMembersReference } from '../../shared/intake-report-version.ts';

test('native ownership scopes preserve legacy subject and version option combinations', async (t) => {
  const f = await fixture(t, false, 1);
  const options = [{}, { version: true }, { subject: false }, { subject: false, version: true }];
  const read = () =>
    options.map((option) => [
      ...ownershipIntakeScopes(f.db, f.original.id, 'fictional-0', {
        ...option,
        exactGroups: new Set([f.groupId]),
      }),
    ]);
  const legacy = read();
  assert.equal(legacy[1]!.length, 1);
  assert.ok(legacy[1]![0]!.subjectText);
  assert.ok(legacy[1]![0]!.versionId);
  await buildIntakeCollectionEnvelope(f.db, { id: f.original.id });
  assert.deepEqual(read(), legacy);
});

for (const nativeProposal of [false, true])
  test(`${nativeProposal ? 'referenced native' : 'retained inline legacy'} ownership readers resolve exact records without whole-envelope hydration`, async (t) => {
    const f = await fixture(t, true, 3, false, undefined, undefined, nativeProposal);
    const before = intakeWorkCounters(f.db);
    const occurrences = [...ownershipIntakeScopeOccurrences(f.db, f.original.id)].filter(
      (row) => row.recordId,
    );
    assert.equal(occurrences.length, 3);
    assert.equal(new Set(occurrences.map((row) => row.recordId)).size, 3);
    for (const occurrence of occurrences) {
      const scopes = [
        ...ownershipIntakeScopes(f.db, f.original.id, occurrence.recordId!, { version: true }),
      ];
      assert.deepEqual(
        scopes.map(({ id, versionId }) => ({ id, versionId })),
        [{ id: occurrence.id, versionId: occurrence.versionId }],
      );
      assert.deepEqual(
        [
          ...ownershipIntakeScopes(f.db, f.original.id, occurrence.recordId!, {
            latestOnly: true,
            subject: false,
          }),
        ],
        [{ id: occurrence.id, subjectText: '' }],
      );
    }
    assert.deepEqual(
      [...ownershipIntakeScopes(f.db, f.original.id, 'unrelated-fictional-record')],
      [],
    );
    const after = intakeWorkCounters(f.db);
    assert.equal(after.warm.envelopeHydrations, before.warm.envelopeHydrations);
    assert.equal(after.warm.envelopeTextReads, before.warm.envelopeTextReads);
    assert.equal(
      after.warm.reportSnapshotCheckpointChanges,
      before.warm.reportSnapshotCheckpointChanges,
      'scope reads publish no snapshot writes',
    );
  });

test('ownership readers explicitly refuse malformed, unavailable and oversized native references', async (t) => {
  const f = await fixture(t, true, 2, false, undefined, undefined, true);
  const source = { id: f.original.id };
  const reader = openIntakeCollectionEnvelope(f.db, source);
  const workflow = reader.child(reader.child(reader.root(), 'intake')!, 'workflow')!;
  const version = reader.childAt(reader.childAt(workflow, 'reportGroups', 0)!, 'versions', 0)!;
  const field = reader.field(version, 'members');
  assert.equal(field.kind, 'value');
  const reference = (field as { kind: 'value'; value: IntakeReportMembersReference }).value;
  const selectedRecord = [...ownershipIntakeScopeOccurrences(f.db, f.original.id)].find(
    (row) => row.recordId,
  )!.recordId!;
  async function replace(value: unknown) {
    const command = await prepareIntakeWorkflowCommand(f.db, source, {
      version: intakeSourceVersion(f.db, f.original.id).version,
      request: { fixture: 'fictional-reference-refusal', value },
      createdAt: '2026-02-10',
      *changes({ reader, workflow }) {
        const version = reader.childAt(
          reader.childAt(workflow, 'reportGroups', 0)!,
          'versions',
          0,
        )!;
        yield value === undefined
          ? {
              op: 'append',
              record: reader.childAt(workflow, 'reportGroups', 0)!,
              field: 'versions',
              jsonText: JSON.stringify({
                id: 'fictional-missing-members',
                format: 'health-intake-report-group-version-v2',
                createdAt: '2026-02-10',
              }),
            }
          : { op: 'set', record: version, field: 'members', jsonText: JSON.stringify(value) };
      },
    });
    if (command.replayed) throw Error('Unexpected fictional command replay');
    transaction(f.db, () =>
      selectedEnvelopeStore(f.db, source).collections.stage(command.prepared),
    );
  }
  for (const value of [
    null,
    'not-a-reference',
    { ...reference, format: 'unrecognized' },
    { ...reference, memberCount: -1 },
    { ...reference, occurrenceCount: 0.5 },
    { ...reference, snapshotId: 'fictional-unavailable-snapshot' },
    { ...reference, memberCount: reference.memberCount + 1 },
    { ...reference, snapshotId: 'x'.repeat(65536) },
    undefined,
  ]) {
    await replace(value);
    assert.throws(
      () => [...ownershipIntakeScopeOccurrences(f.db, f.original.id)],
      /member|snapshot|reference/i,
    );
    assert.throws(
      () => [...ownershipIntakeScopes(f.db, f.original.id, selectedRecord)],
      /member|snapshot|reference/i,
    );
    if (value === undefined) break;
    await replace(reference);
    assert.ok([...ownershipIntakeScopes(f.db, f.original.id, selectedRecord)].length);
  }
});

test('ownership scope occurrence traversal refuses a snapshot replaced after an addressed occurrence', async (t) => {
  const f = await fixture(t, true, 2, false, undefined, undefined, true);
  const source = { id: f.original.id };
  const reader = openIntakeCollectionEnvelope(f.db, source);
  const workflow = reader.child(reader.child(reader.root(), 'intake')!, 'workflow')!;
  const version = reader.childAt(reader.childAt(workflow, 'reportGroups', 0)!, 'versions', 0)!;
  const field = reader.field(version, 'members');
  assert.equal(field.kind, 'value');
  const reference = (field as { kind: 'value'; value: IntakeReportMembersReference }).value;
  const iterator = ownershipIntakeScopeOccurrences(f.db, f.original.id);
  assert.equal(iterator.next().value!.recordId, null);
  assert.ok(iterator.next().value!.recordId);
  const command = await prepareIntakeWorkflowCommand(f.db, source, {
    version: intakeSourceVersion(f.db, f.original.id).version,
    request: { fixture: 'fictional-racing-selected-snapshot' },
    createdAt: '2026-02-10',
    *changes({ reader, workflow }) {
      const version = reader.childAt(reader.childAt(workflow, 'reportGroups', 0)!, 'versions', 0)!;
      yield { op: 'set', record: version, field: 'members', jsonText: JSON.stringify(reference) };
    },
  });
  if (command.replayed) throw Error('Unexpected fictional command replay');
  transaction(f.db, () => selectedEnvelopeStore(f.db, source).collections.stage(command.prepared));
  assert.throws(() => [...iterator], /stale|changed/i);
});

test('both ownership traversals refuse a late missing record identity even after finding the selected record', async (t) => {
  const f = await fixture(t, true, 2, false, undefined, undefined, true);
  const source = { id: f.original.id };
  const selectedRecord = [...ownershipIntakeScopeOccurrences(f.db, f.original.id)].find(
    (row) => row.recordId,
  )!.recordId!;
  const catalog = createReportSnapshotCatalog(f.db, source);
  const writer = await createReportMemberSnapshot(catalog, 'fictional-null-record-identity');
  for (const [ordinal, recordId] of [selectedRecord, null].entries())
    await writer.includeOrdinaryOccurrence(
      { candidateId: 'fictional-member-' + ordinal, candidateVersionId: 'fictional-version' },
      {
        // Retained occurrence descriptors can represent absent identities;
        // ownership must refuse that evidence even after an earlier match.
        recordId: recordId as string,
        proposalId: 'fictional-proposal',
        batchId: null,
        locator: 'Fictional late missing identity',
      },
    );
  const reference = await writer.finish();
  const command = await prepareIntakeWorkflowCommand(f.db, source, {
    version: intakeSourceVersion(f.db, f.original.id).version,
    request: { fixture: 'fictional-late-null-identity' },
    createdAt: '2026-02-10',
    additionalLogicalChanges: () => catalog.finalChanges(),
    *changes({ reader, workflow }) {
      const version = reader.childAt(reader.childAt(workflow, 'reportGroups', 0)!, 'versions', 0)!;
      yield { op: 'set', record: version, field: 'members', jsonText: JSON.stringify(reference) };
    },
  });
  if (command.replayed) throw Error('Unexpected fictional command replay');
  transaction(f.db, () => selectedEnvelopeStore(f.db, source).collections.stage(command.prepared));
  assert.throws(
    () => [...ownershipIntakeScopes(f.db, f.original.id, selectedRecord)],
    /lacks a record identity/,
  );
  assert.throws(
    () => [...ownershipIntakeScopeOccurrences(f.db, f.original.id)],
    /lacks a record identity/,
  );
});
