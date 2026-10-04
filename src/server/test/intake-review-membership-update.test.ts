import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../database.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeCollectionProposal } from '../intake-collection-proposals.ts';
import {
  prepareCollectionReviewMembership,
  prepareCollectionReviewMembershipDerived,
  readCollectionReviewMembership,
} from '../intake-review-membership-index.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { prepareWorkflowProposalDerived } from '../intake-workflow-update.ts';
import { validateJSONL } from '../intake-format.ts';
import { workflowHash } from '../intake-workflow.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

test('cumulative report membership shares previous proof and publishes only changed occurrence joins', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-membership-delta-')),
    profileId = 'fictional';
  const db = openDatabase(join(directory, 'cache.sqlite'), profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const source = { id: 'fictional-intake', sha256: 'a'.repeat(64), kind: 'intake_original' },
    file = { ...source, mime_type: 'application/pdf' };
  const initial = prepareInitialIntakeEnvelope({
    intake: { version: 1, originalName: 'fictional.pdf', proposals: [] },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(source.id, 'fictional.pdf', source.sha256, 0, source.kind, initial.detailsJson);
    createIntakeStateStorage(db, {
      profileId,
      intakeId: source.id,
      sourceHash: source.sha256,
    }).stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(db, source);
  const parsed = validateJSONL(
    Buffer.from(
      Array.from({ length: 3 }, (_, i) =>
        JSON.stringify({
          format: 'health-record-v1',
          id: 'r' + i,
          kind: 'record',
          payload: { literal: '12.00' },
          provenance: {
            capturedVia: 'Fictional delivery',
            sourceSystem: 'Fictional issuer',
            sourceRecordId: 'r' + i,
            evidenceClass: 'provider_export',
            locator: 'page ' + (i + 1),
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
        }),
      ).join('\n'),
    ),
  );
  assert.equal(parsed.valid, true);
  const collections = selectedEnvelopeStore(db, source).collections;
  const first = await prepareIntakeCollectionProposal(db, source, {
    reader: openIntakeCollectionEnvelope(db, source),
    file,
    proposalId: 'p1',
    proposalHeader: { id: 'p1', fileId: 'p1' },
    entries: parsed.entries!,
    operationId: randomUUID(),
    requestDigest: workflowHash('first'),
    domainVersion: 2,
    createdAt: '2026-10-03T00:00:00Z',
    reportEvidence: {
      packageEvidence: false,
      hasMember: () => false,
      contextLookup: { contexts: () => [] },
    },
    nextDiscoveryOrder: () => 1,
    prepareDerived: (input) => prepareCollectionReviewMembershipDerived(db, source, input),
  });
  transaction(db, () => collections.stage(first.prepared!));
  await prepareCollectionReviewMembership(db, source);
  const options = { mappingVersion: 'mapping', isSourceContextVersion: () => false };
  await buildVerifiedWorkflowSummary(db, source, options);
  const before = openIntakeCollectionEnvelope(db, source),
    flow = before.child(before.child(before.root(), 'intake')!, 'workflow')!;
  const group = before.childAt(flow, 'reportGroups', 0)!,
    firstVersion = before.childAt(group, 'versions', 0)!;
  const firstCandidate = before.childAt(flow, 'candidates', 0)!,
    candidateVersion = before.childAt(firstCandidate, 'versions', 0)!;
  const readText = (view: typeof before, record: typeof group, name: string) => {
    const value = view.field(record, name, { bytes: 65536 });
    if (value.kind !== 'value' || typeof value.value !== 'string') throw Error('Fixture field');
    return value.value;
  };
  const c = readText(before, firstCandidate, 'id'),
    v = readText(before, candidateVersion, 'id'),
    groupId = readText(before, group, 'id'),
    oldVersionId = readText(before, firstVersion, 'id');
  const oldMembership = readCollectionReviewMembership(db, source, before);
  const groupAddress = before.address(group),
    firstVersionAddress = before.address(firstVersion);
  assert.equal(oldMembership.contains(firstVersion, c, v, 'p1:line:1', 'p1'), true);
  const work = structuredClone(intakeWorkCounters(db));
  const second = await prepareIntakeCollectionProposal(db, source, {
    reader: before,
    file,
    proposalId: 'p2',
    proposalHeader: { id: 'p2', fileId: 'p2' },
    entries: [parsed.entries![0]!],
    batchId: 'batch-2',
    operationId: randomUUID(),
    requestDigest: workflowHash('second'),
    domainVersion: 3,
    createdAt: '2026-10-03T00:00:00Z',
    reportEvidence: {
      packageEvidence: false,
      hasMember: () => false,
      contextLookup: { contexts: () => [] },
    },
    nextDiscoveryOrder: () => {
      throw Error('Existing report must not rediscover');
    },
    prepareDerived: (input) => prepareWorkflowProposalDerived(db, source, { ...input, ...options }),
  });
  assert.equal(
    oldMembership.contains(firstVersion, c, v, 'p2:line:1', 'p2'),
    false,
    'unselected preparation does not prove new membership',
  );
  transaction(db, () => collections.stage(second.prepared!));
  clearIntakeStateCache(db);
  const after = openIntakeCollectionEnvelope(db, source),
    selectedGroup = after.resolve(groupAddress);
  const membership = readCollectionReviewMembership(db, source, after),
    latest = after.childAt(selectedGroup, 'versions', 1)!;
  assert.equal(membership.contains(latest, c, v, 'p1:line:1', 'p1'), true);
  assert.equal(membership.contains(latest, c, v, 'p2:line:1', 'p2'), true);
  assert.equal(
    membership.contains(after.resolve(firstVersionAddress), c, v, 'p2:line:1', 'p2'),
    false,
  );
  assert.deepEqual(
    [...membership.references(c, v, 'p1:line:1', 'p1')],
    [{ groupId, groupVersionId: oldVersionId }],
  );
  assert.deepEqual(
    [...membership.references(c, v, 'p2:line:1', 'p2')],
    [{ groupId, groupVersionId: readText(after, latest, 'id') }],
  );
  assert.equal(
    intakeWorkCounters(db).reconstruction.clinicalReviewMembershipRecords,
    work.reconstruction.clinicalReviewMembershipRecords,
  );
  for (const key of ['envelopeHydrations', 'sourceDTOHydrations'] as const)
    assert.equal(intakeWorkCounters(db).warm[key], work.warm[key]);
});
