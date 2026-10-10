import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  iterateIntakeEnvelopeText,
} from '../intake-collection-envelope.ts';
import { prepareIntakeCollectionProposal } from '../intake-collection-proposals.ts';
import { recordCandidateVersions } from '../intake-workflow.ts';
import { validateJSONL, canonicalLiteral } from '../intake-format.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { openReportMemberSnapshot } from '../intake-report-member-state.ts';
import type { IntakeReportMembersReference } from '../../shared/intake-report-version.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
function fixture(t: test.TestContext, retained?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-proposal-')),
    identity = {
      profileId: 'fictional-proposal',
      intakeId: 'fictional-source',
      sourceHash: 'c'.repeat(64),
    },
    db = openDatabase(join(root, 'cache.sqlite'), identity.profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const initial = prepareInitialIntakeEnvelope(
    retained ?? {
      intake: { version: 1, originalName: 'fictional.pdf', proposals: [] },
    },
  );
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      'fictional.pdf',
      identity.sourceHash,
      0,
      'intake_original',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  return {
    db,
    identity,
    source: { id: identity.intakeId, sha256: identity.sourceHash },
    file: { id: identity.intakeId, sha256: identity.sourceHash, mime_type: 'application/pdf' },
  };
}
const envelope = (id: string, locator: string) => ({
  format: 'health-record-v1',
  id,
  kind: 'record',
  payload: { literal: '12.00' },
  provenance: {
    capturedVia: 'Fictional delivery',
    sourceSystem: 'Fictional issuer',
    sourceRecordId: id,
    evidenceClass: 'provider_export',
    locator,
  },
  coverage: { status: 'complete_response', notes: [] },
  clinical: {
    kind: 'observation',
    subject: 'self',
    testLabel: 'Example',
    valueText: '12.00',
    unit: 'mg',
    date: '2026-09',
  },
  report: {
    key: 'fictional-report',
    title: 'Fictional report',
    anchor: { locator: 'page 1', text: 'Report F27' },
    subject: null,
  },
});
test('native proposal keeps legacy candidate/report identities while appending only addressed evidence', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-17T12:00:00Z') });
  const { db, identity, source, file } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const parsed = validateJSONL(
    Buffer.from(
      [envelope('a', 'page 1'), envelope('b', 'page 2')]
        .map((value) => JSON.stringify(value))
        .join('\n'),
    ),
  );
  assert.equal(parsed.valid, true);
  const entries = parsed.entries!,
    proposalId = 'fictional-proposal-1',
    oracle: {
      proposals: { id: string }[];
      workflow?: ReturnType<typeof import('../intake-workflow.ts').intakeWorkflow>;
    } = { proposals: [{ id: proposalId }] };
  recordCandidateVersions(file, oracle, entries, proposalId);
  let order = 0;
  const operationId = randomUUID(),
    requestDigest = createHash('sha256').update(operationId).digest('hex');
  const prepare = () =>
    prepareIntakeCollectionProposal(db, source, {
      reader: openIntakeCollectionEnvelope(db, source),
      file,
      proposalId,
      proposalHeader: { id: proposalId, fileId: proposalId },
      entries,
      operationId,
      requestDigest,
      domainVersion: 2,
      createdAt: new Date().toISOString(),
      reportEvidence: {
        packageEvidence: false,
        hasMember: () => false,
        contextLookup: { contexts: () => [] },
      },
      nextDiscoveryOrder: () => ++order,
    });
  const prepared = await prepare();
  assert.ok(prepared.prepared);
  const store = createIntakeStateStorage(db, identity).collections;
  transaction(db, () => store.stage(prepared.prepared!));
  const retained = JSON.parse([...iterateIntakeEnvelopeText(db, source)].join(''));
  assert.deepEqual(retained.intake.workflow.candidates, oracle.workflow!.candidates);
  const actual = retained.intake.workflow.reportGroups[0],
    expected = oracle.workflow!.reportGroups![0]!;
  assert.equal(actual.id, expected.id);
  assert.equal(actual.versions[0].id, expected.versions[0]!.id);
  assert.equal(actual.versions[0].contributionId, expected.versions[0]!.contributionId);
  const snapshot = openReportMemberSnapshot(
    createReportSnapshotCatalog(db, source),
    actual.versions[0].members as IntakeReportMembersReference,
  );
  assert.deepEqual(
    JSON.parse([...snapshot.canonicalMembers()].join('')),
    expected.versions[0]!.members,
  );
  const replay = await prepare();
  assert.deepEqual(replay.replay, store.replay(operationId, requestDigest));
  assert.equal(order, 1);
  const before = intakeWorkCounters(db).warm;
  const secondProposal = 'fictional-proposal-2';
  oracle.proposals.push({ id: secondProposal });
  recordCandidateVersions(file, oracle, [entries[0]!], secondProposal, 'fictional-batch');
  const nextId = randomUUID();
  const second = await prepareIntakeCollectionProposal(db, source, {
    reader: openIntakeCollectionEnvelope(db, source),
    file,
    proposalId: secondProposal,
    proposalHeader: { id: secondProposal, fileId: secondProposal },
    entries: [entries[0]!],
    batchId: 'fictional-batch',
    operationId: nextId,
    requestDigest: createHash('sha256').update(nextId).digest('hex'),
    domainVersion: 3,
    createdAt: new Date().toISOString(),
    reportEvidence: {
      packageEvidence: false,
      hasMember: () => false,
      contextLookup: { contexts: () => [] },
    },
    nextDiscoveryOrder: () => ++order,
    prepareDerived: async ({ reader, logical, affected }) => {
      assert.equal(logical.domainVersion, 3);
      assert.equal(store.binding(store.openView())!.logical.domainVersion, 2);
      assert.equal(affected.candidateChanges.length, 1);
      assert.equal(affected.candidateChanges[0]!.kind, 'update');
      const version = reader.resolve(affected.candidateChanges[0]!.versionAddress);
      assert.equal(reader.childCount(version, 'occurrences'), 2);
      const maintenance = randomUUID();
      store.commitMaintenance(
        store.prepare(store.openView(), {
          operationId: maintenance,
          requestDigest: createHash('sha256').update(maintenance).digest('hex'),
          domainVersion: 2,
          changes: [
            {
              area: 'builds',
              collection: 'fictional.derived',
              op: 'put',
              key: 'progress',
              value: 'ready',
            },
          ],
        }),
      );
      return [
        {
          area: 'builds',
          collection: 'fictional.derived',
          op: 'put',
          key: 'complete',
          value: JSON.stringify(logical),
        },
      ];
    },
    compose: {
      changes: function* (view) {
        const workflow = view.child(view.child(view.root(), 'intake')!, 'workflow')!;
        yield {
          op: 'append',
          record: workflow,
          field: 'operations',
          jsonText: JSON.stringify({
            id: 'fictional-batch',
            fingerprint: 'fictional',
            at: new Date().toISOString(),
          }),
        };
      },
      additionalLogicalChanges: [
        {
          area: 'logical',
          collection: 'fictional.batch',
          op: 'put',
          key: 'selected',
          value: 'fictional-batch',
        },
      ],
    },
  });
  assert.ok(second.prepared);
  transaction(db, () => store.stage(second.prepared!));
  const after = intakeWorkCounters(db).warm;
  assert.equal(after.materializationReads, before.materializationReads);
  assert.equal(after.envelopeHydrations, before.envelopeHydrations);
  assert.equal(after.proposalEntriesProcessed - before.proposalEntriesProcessed, 1);
  assert.equal(after.reportMemberHashItems - before.reportMemberHashItems, 2);
  assert.ok(after.reportMemberHashBytes > before.reportMemberHashBytes);
  const secondRetained = JSON.parse([...iterateIntakeEnvelopeText(db, source)].join(''));
  assert.deepEqual(secondRetained.intake.workflow.candidates, oracle.workflow!.candidates);
  const versions = secondRetained.intake.workflow.reportGroups[0].versions;
  assert.equal(versions.length, 2);
  assert.equal(versions[1].id, oracle.workflow!.reportGroups![0]!.versions[1]!.id);
  assert.equal(versions[0].id, expected.versions[0]!.id);
  assert.equal(order, 1);
  assert.equal(
    store.get(store.openView(), 'builds', 'fictional.derived', 'complete'),
    JSON.stringify(store.binding(store.openView())!.logical),
  );
  assert.equal(
    store.get(store.openView(), 'logical', 'fictional.batch', 'selected'),
    'fictional-batch',
  );
});

test('native proposal migrates legacy cumulative members with duplicate identities and giant unknown fields exactly once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-17T12:00:00Z') });
  const entries = validateJSONL(Buffer.from(JSON.stringify(envelope('a', 'page 1')))).entries!;
  const file = { id: 'fictional-source', sha256: 'c'.repeat(64), mime_type: 'application/pdf' };
  const old: {
    version: number;
    originalName: string;
    proposals: { id: string }[];
    workflow?: ReturnType<typeof import('../intake-workflow.ts').intakeWorkflow>;
  } = { version: 1, originalName: 'fictional.pdf', proposals: [{ id: 'old-proposal' }] };
  recordCandidateVersions(file, old, entries, 'old-proposal');
  const member = old.workflow!.reportGroups![0]!.versions[0]!.members[0]!;
  Object.assign(member, {
    aardvark: { unknown: '🌿'.repeat(20000), nested: [1, 2, { number: 1e22 }] },
    zebra: 'retained',
    section: {
      key: 'fictional-section',
      title: 'Fictional section',
      anchor: { text: 'printed', locator: 'page 1' },
      unknown: '🌿'.repeat(10000),
    },
  });
  Object.assign(member.occurrences[0]!, { unknown: 'extra retained source evidence' });
  old.workflow!.reportGroups![0]!.versions[0]!.members.push(structuredClone(member));
  const oracle = JSON.parse(JSON.stringify(old)) as typeof old;
  const { db, identity, source } = fixture(t, { intake: old });
  await buildIntakeCollectionEnvelope(db, source);
  oracle.proposals.push({ id: 'new-proposal' });
  recordCandidateVersions(file, oracle, entries, 'new-proposal', 'new-batch');
  const id = randomUUID();
  const prepared = await prepareIntakeCollectionProposal(db, source, {
    reader: openIntakeCollectionEnvelope(db, source),
    file,
    proposalId: 'new-proposal',
    proposalHeader: { id: 'new-proposal' },
    entries,
    batchId: 'new-batch',
    operationId: id,
    requestDigest: createHash('sha256').update(id).digest('hex'),
    domainVersion: 2,
    createdAt: new Date().toISOString(),
    reportEvidence: {
      packageEvidence: false,
      hasMember: () => false,
      contextLookup: { contexts: () => [] },
    },
    nextDiscoveryOrder: () => {
      throw Error('Existing group should retain discovery order');
    },
  });
  transaction(db, () =>
    createIntakeStateStorage(db, identity).collections.stage(prepared.prepared!),
  );
  const retained = JSON.parse([...iterateIntakeEnvelopeText(db, source)].join('')),
    versions = retained.intake.workflow.reportGroups[0].versions,
    expected = oracle.workflow!.reportGroups![0]!.versions;
  assert.equal(versions.length, 2);
  assert.deepEqual(versions[0], old.workflow!.reportGroups![0]!.versions[0]);
  assert.equal(versions[1].id, expected[1]!.id);
  const snapshot = openReportMemberSnapshot(
    createReportSnapshotCatalog(db, source),
    versions[1].members,
  );
  assert.equal(snapshot.reference.memberCount, 2);
  assert.equal(snapshot.member('candidate', 'absent'), undefined);
  assert.deepEqual(JSON.parse([...snapshot.canonicalMembers()].join('')), expected[1]!.members);
  assert.equal(
    [...snapshot.canonicalSection(snapshot.memberAt(0)!)].join(''),
    canonicalLiteral(member.section || null),
  );
});
