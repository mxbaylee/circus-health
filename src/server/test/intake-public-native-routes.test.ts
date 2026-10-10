import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { fictionalModel } from './fictional-model.ts';
import {
  memoryRecordAuthority,
  writeIntakeFixtureEnvelope,
} from './helpers/intake-authority-fixture.ts';
import { uploadIntake, createIntakePlan } from '../intake.ts';
import { createPagedPackagePlan } from '../intake-package-plan.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { readIntakeEnvelopeMaterialized } from '../intake-authority.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import {
  maximumIntakeDiscoveryOrder,
  prepareIntakeLookupIndices,
} from '../intake-lookup-projection.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { createApp } from '../index.ts';
import { randomUUID } from 'node:crypto';

async function fixture(t: test.TestContext) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-public-routes-')),
    profileId = 'fictional-routes',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  const app = createApp({
    root,
    databases: new Map([[profileId, db]]),
    intakeBatchOptions: { authorized: () => false },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/profiles/${profileId}/intakes/`;
  t.after(() => {
    app.close();
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    profileId,
    db,
    async upload(filename: string, rows: HealthRecordEnvelope[]) {
      const response = await fetch(base.slice(0, -1), {
        method: 'POST',
        headers: {
          origin: 'http://127.0.0.1:5173',
          'content-type': 'application/x-ndjson',
          'x-filename': filename,
        },
        body: rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
      });
      const result = await response.json();
      assert.equal(response.status, 201, JSON.stringify(result));
      return result.data;
    },
    async request(id: string, action: string, input?: unknown, status = 200) {
      const response = await fetch(base + encodeURIComponent(id) + '/' + action, {
        ...(input === undefined
          ? {}
          : {
              method: 'POST',
              headers: {
                origin: 'http://127.0.0.1:5173',
                'content-type': 'application/json',
              },
              body: JSON.stringify(input),
            }),
      });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    },
  };
}

test('successive public JSONL uploads prepare native discovery lookups and preserve mixed-source order', async (t) => {
  const f = await fixture(t);
  const entry = (id: string): HealthRecordEnvelope => ({
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: 'Fictional upload discovery report ' + id,
    provenance: {
      capturedVia: 'Fictional upload test',
      sourceSystem: 'Fictional clinic',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'page 1',
    },
    coverage: { status: 'partial', notes: [] },
    report: {
      key: id,
      title: 'Fictional report ' + id,
      anchor: { locator: 'page 1 heading', text: 'Fictional report ' + id },
      subject: null,
    },
    clinical: { kind: 'document', documentTitle: 'Fictional report ' + id },
  });
  const legacy = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-legacy.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(JSON.stringify(entry('legacy')) + '\n'),
  });
  const prior = structuredClone(readIntakeEnvelopeMaterialized(f.db, { id: legacy.id }).value) as {
    intake: { workflow: { reportGroups: { discoveryOrder: number }[] } };
  };
  prior.intake.workflow.reportGroups[0]!.discoveryOrder = 40;
  writeIntakeFixtureEnvelope(f.db, legacy.id, prior);
  assert.equal(maximumIntakeDiscoveryOrder(f.db), 40);

  const orders = (id: string) => {
    const view = openIntakeCollectionEnvelope(f.db, { id });
    const workflow = view.child(view.child(view.root(), 'intake')!, 'workflow')!;
    return Array.from({ length: view.childCount(workflow, 'reportGroups') }, (_, ordinal) => {
      const field = view.field(view.childAt(workflow, 'reportGroups', ordinal)!, 'discoveryOrder');
      assert.equal(field.kind, 'value');
      return field.kind === 'value' ? field.value : undefined;
    });
  };
  const clinical = await f.upload('fictional-clinical.jsonl', [entry('first'), entry('second')]);
  assert.deepEqual(orders(clinical.id), [41, 42]);
  // Schema publication deliberately does not claim a complete semantic index.
  assert.throws(() => maximumIntakeDiscoveryOrder(f.db), /semantic indexes.*incomplete/);
  const people: HealthRecordEnvelope = {
    ...entry('people'),
    payload: 'Fictional report people. Fictional Ellis is a clinician.',
    clinical: undefined,
    people: [
      {
        id: 'fictional-ellis',
        fullName: 'Fictional Ellis',
        role: 'clinician',
        evidence: [{ textAnchor: 'Fictional Ellis is a clinician.', supports: ['fullName'] }],
      },
    ],
  };
  const second = await f.upload('fictional-people.jsonl', [people]);
  assert.deepEqual(orders(second.id), [43]);
  assert.deepEqual(orders(clinical.id), [41, 42]);
  const preparation = await prepareIntakeLookupIndices(f.db);
  assert.equal(preparation.prepared, 1, 'only the newly published native source needs preparation');
  assert.equal(preparation.reused, 1, 'the preceding upload lookup remains current');
  assert.equal(maximumIntakeDiscoveryOrder(f.db), 43);
  const before = { ...intakeWorkCounters(f.db).warm };
  const repeated = await f.upload('fictional-people.jsonl', [people]);
  assert.equal(repeated.id, second.id);
  assert.equal(repeated.repeatedUpload, true);
  const after = intakeWorkCounters(f.db).warm;
  assert.equal(after.collectionNodesWritten, before.collectionNodesWritten);
  assert.equal(after.envelopeHydrations, before.envelopeHydrations);
  assert.equal(after.sourceDTOHydrations, before.sourceDTOHydrations);
});

for (const native of [false, true])
  test(`public plan, package, member and literal endpoints retain ${native ? 'native bounded' : 'legacy'} contracts`, async (t) => {
    const f = await fixture(t),
      original = uploadIntake(f.db, f.root, f.profileId, {
        filename: 'fictional.zip',
        newProviderName: 'Fictional clinic',
        bytes: zipFixture([
          { name: 'fictional-a.txt', data: 'Fictional literal A' },
          { name: 'fictional-b.txt', data: 'Fictional literal B' },
          { name: 'fictional-c.txt', data: 'Fictional literal C' },
        ]),
      });
    const planned = await (native ? createPagedPackagePlan : createIntakePlan)(
      f.db,
      f.root,
      f.profileId,
      original.id,
      { version: original.version, operationId: 'fictional-public-plan' },
    );
    const before = { ...intakeWorkCounters(f.db).warm };
    const plan = (await f.request(original.id, 'plan')).data;
    if (native) {
      assert.equal(plan.format, 'health-intake-summary-v2');
      assert.equal(plan.activePlan.state, 'exact');
      assert.equal(plan.activePlan.plan.unitCount, 3);
      assert.equal(plan.workflow, undefined);
    } else {
      assert.equal(plan.intakeId, original.id);
      assert.equal(plan.plans.length, 1);
      assert.equal(plan.plans[0].units.length, 3);
    }
    assert.equal(plan.version, planned.version);
    const first = (await f.request(original.id, 'package?limit=2')).data;
    assert.equal(first.totalMembers, 3);
    assert.equal(first.members.length, 2);
    assert.equal(first.nextOffset, 2);
    if (native) assert.equal(first.format, 'health-intake-package-inventory-v2');
    const next = (await f.request(original.id, 'package?offset=2&limit=2')).data;
    assert.equal(next.members.length, 1);
    assert.equal(next.nextOffset, null);
    const selected = (
      await f.request(original.id, 'package-member', {
        memberId: first.members[0].memberId,
      })
    ).data;
    assert.ok(selected.sourceFileId);
    if (native) assert.equal(selected.member.unitId, first.members[0].unitId);
    else assert.equal(selected.member.filename, first.members[0].filename);
    const literal = (await f.request(selected.sourceFileId, 'read?offset=2&limit=5')).data;
    assert.equal(literal.text, 'ction');
    assert.equal(literal.offset, 2);
    assert.equal(literal.nextOffset, 7);
    assert.equal(literal.intake.id, selected.sourceFileId);
    if (native) {
      assert.equal(literal.intake.format, 'health-intake-summary-v2');
      assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
      assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
    }
    await f.request(original.id, 'package?limit=51', undefined, 400);
  });

test('public native navigation follows bounded cursors and preserves incomplete and ambiguous evidence', async (t) => {
  const f = await fixture(t),
    original = uploadIntake(f.db, f.root, f.profileId, {
      filename: 'fictional.html',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from('<h1>Fictional literal</h1>'),
    }),
    source = { id: original.id },
    previous = readIntakeEnvelopeMaterialized(f.db, source).value;
  writeIntakeFixtureEnvelope(f.db, original.id, {
    ...previous,
    intake: {
      ...(previous.intake as object),
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: [],
        questions: [],
        decisions: [],
        plans: [
          {
            id: 'fictional-plan',
            createdAt: '2026-10-03T00:00:00Z',
            status: 'active',
            pins: {
              sourceHash: original.sha256,
              backend: 'fictional',
              model: null,
              reasoningEffort: null,
              instructionVersion: 'fictional',
              mappingVersion: 'fictional',
            },
            units: [],
            batches: [],
            index: {
              kind: 'html',
              sections: Array.from({ length: 17 }, (_, i) => ({
                id: 'fictional-section-' + i,
                locator: 'fictional section ' + i,
                start: 0,
                end: 25,
              })),
              references: [{ id: 'self-reference', sourceFileId: original.id, fragment: 'same' }],
              anchors: [
                { name: 'same', start: 0, locator: 'first anchor' },
                { name: 'same', start: 10, locator: 'second anchor' },
              ],
            },
          },
        ],
      },
    },
  });
  await buildIntakeCollectionEnvelope(f.db, source);
  const pending = (await f.request(original.id, 'navigate?action=search&query=fictional')).data;
  assert.equal(pending.format, 'health-intake-navigation-v2');
  assert.equal(pending.state, 'pending');
  assert.equal(pending.searched, false);
  await buildVerifiedWorkflowSummary(f.db, source, {
    mappingVersion: 'fictional',
    isSourceContextVersion: () => false,
  });
  const before = { ...intakeWorkCounters(f.db).warm };
  let cursor: string | null = null,
    matches = 0,
    pages = 0;
  do {
    const result: {
      format: string;
      scannedSections: number;
      results: unknown[];
      complete: boolean;
      nextCursor: string | null;
    } = (
      await f.request(
        original.id,
        'navigate?action=search&query=fictional' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      )
    ).data;
    assert.equal(result.format, 'health-intake-navigation-v2');
    assert.ok(result.scannedSections <= 8);
    matches += result.results.length;
    pages++;
    if (pages === 1) {
      assert.equal(result.complete, false);
      assert.ok(result.nextCursor);
      await f.request(
        original.id,
        'navigate?action=search&query=other&cursor=' + encodeURIComponent(result.nextCursor),
        undefined,
        409,
      );
    }
    cursor = result.nextCursor;
  } while (cursor);
  assert.equal(matches, 17);
  assert.equal(pages, 3);
  const followed = (
    await f.request(original.id, 'navigate?action=follow&referenceId=self-reference')
  ).data;
  assert.equal(followed.followed, false);
  assert.equal(followed.reason, 'Ambiguous duplicate anchor');
  await f.request(original.id, 'navigate?action=search&query=fictional&offset=1', undefined, 400);
  assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
});

// Search must discover matching People outside the first report/page. Query-bound
// cursors and exact disposition refresh prevent silently mixing searched scopes.
test('native public People search filters complete groups and pages with current counts', async (t) => {
  const f = await fixture(t);
  const reports = [
    ['Fictional Alder'],
    ['Fictional Fern Sprig', 'Fictional Fern Meadow'],
    ['Fictional Fern Vale'],
  ];
  const uploaded = await f.upload(
    'fictional-named-people.jsonl',
    reports.map((names, n): HealthRecordEnvelope => ({
      format: 'health-record-v1',
      id: 'fictional-people-search-' + n,
      kind: 'record',
      payload: ['Fictional directory ' + n, ...names.map((name) => name + ' is a clinician.')].join(
        '\n',
      ),
      provenance: {
        capturedVia: 'Fictional fixture',
        sourceSystem: 'Fictional clinic',
        sourceRecordId: 'directory-' + n,
        evidenceClass: 'provider_export',
        locator: 'page 1',
      },
      coverage: { status: 'complete_response', notes: [] },
      report: {
        key: 'directory-' + n,
        title: 'Fictional directory ' + n,
        anchor: { locator: 'page 1 heading', text: 'Fictional directory ' + n },
        subject: null,
      },
      people: names.map((name, ordinal) => ({
        id: 'person-' + ordinal,
        fullName: name,
        role: 'clinician',
        evidence: [{ textAnchor: name + ' is a clinician.', supports: ['fullName'] }],
      })),
    })),
  );
  const before = { ...intakeWorkCounters(f.db).warm };
  const feed = async (query: string, extra = '', status = 200) =>
    (
      await f.request(
        'import-feed',
        '?view=active&kind=person&limit=1&q=' + encodeURIComponent(query) + extra,
        undefined,
        status,
      )
    ).data;
  const unfiltered = await feed('');
  const found = await feed('  FERN  ');
  assert.equal(found.kindCounts.person, 3);
  assert.equal(found.people.counts.pending, 3);
  assert.equal(found.people.totalGroups, 2);
  assert.equal(found.people.groups.length, 1);
  assert.notEqual(found.people.groups[0].groupId, unfiltered.people.groups[0].groupId);
  assert.ok(found.people.nextCursor);
  const nextGroup = await feed(
    'fern',
    '&peopleCursor=' + encodeURIComponent(found.people.nextCursor),
  );
  assert.equal(nextGroup.people.groups.length, 1);
  assert.notEqual(nextGroup.people.groups[0].groupId, found.people.groups[0].groupId);
  assert.equal(nextGroup.people.nextCursor, null);
  await feed('alder', '&peopleCursor=' + encodeURIComponent(found.people.nextCursor), 409);
  const group = found.people.groups[0];
  const people = async (q: string, extra = '', status = 200) =>
    (
      await f.request(
        'people',
        encodeURIComponent(group.groupId) +
          '?intakeId=' +
          encodeURIComponent(uploaded.id) +
          '&view=active&limit=1&q=' +
          encodeURIComponent(q) +
          extra,
        undefined,
        status,
      )
    ).data;
  const first = await people('FERN');
  assert.equal(first.totalPeople, 2);
  assert.equal(first.counts.pending, 2);
  assert.equal(first.people.length, 1);
  assert.equal(first.people[0].kind, 'person');
  assert.ok(first.nextCursor);
  const second = await people('fern', '&cursor=' + encodeURIComponent(first.nextCursor));
  assert.equal(second.people.length, 1);
  assert.notEqual(first.people[0].person.id, second.people[0].person.id);
  assert.equal(second.nextCursor, null);
  await people('alder', '&cursor=' + encodeURIComponent(first.nextCursor), 409);
  assert.equal((await people('no fictional match')).totalPeople, 0);
  assert.equal((await people('professional')).totalPeople, 2, 'tags remain searchable');
  assert.equal(
    (await people('fictional-named-people.jsonl')).totalPeople,
    2,
    'the retained filename remains searchable',
  );
  const selected = first.people[0].person;
  await f.request('people-disposition', '', {
    operationId: randomUUID(),
    intakeId: uploaded.id,
    intakeVersion: selected.intakeVersion,
    proposalId: selected.id,
    proposalVersion: selected.version,
    state: 'later',
  });
  const changed = await feed('fern');
  assert.equal(changed.kindCounts.person, 2);
  assert.equal(changed.people.counts.pending, 2);
  assert.equal(changed.people.counts.later, 1);
  assert.equal(changed.people.totalGroups, 2);
  const changedPeople = await people('fern');
  assert.equal(changedPeople.totalPeople, 1);
  assert.equal(changedPeople.counts.later, 1);
  assert.notEqual(changedPeople.people[0].person.id, selected.id);
  await people('fern', '&cursor=' + encodeURIComponent(first.nextCursor), 409);
  const lastInGroup = changedPeople.people[0].person;
  await f.request('people-disposition', '', {
    operationId: randomUUID(),
    intakeId: uploaded.id,
    intakeVersion: lastInGroup.intakeVersion,
    proposalId: lastInGroup.id,
    proposalVersion: lastInGroup.version,
    state: 'later',
  });
  const remaining = await feed('fern');
  assert.equal(remaining.kindCounts.person, 1);
  assert.equal(remaining.people.counts.later, 2);
  assert.equal(
    remaining.people.totalGroups,
    1,
    'a group leaves discovery when its last match leaves this view',
  );
  assert.notEqual(remaining.people.groups[0].groupId, group.groupId);
  assert.equal((await people('fern')).totalPeople, 0);
  const allNames = await feed('');
  assert.equal(allNames.kindCounts.person, 2);
  assert.equal(allNames.people.counts.pending, 2);
  assert.equal(allNames.people.counts.later, 2);
  assert.equal(
    allNames.people.totalGroups,
    2,
    'the unmatched Alder report remains in the unfiltered view',
  );
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
});
