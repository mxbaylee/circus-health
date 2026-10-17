import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers';
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
  const authority = memoryRecordAuthority(db);
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
    authority,
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
  const firstWorkBefore = intakeWorkCounters(db).warm;
  const prepared = await prepare();
  const firstWorkAfter = intakeWorkCounters(db).warm;
  assert.equal(
    firstWorkAfter.reportSnapshotCheckpointBatches -
      firstWorkBefore.reportSnapshotCheckpointBatches,
    6,
    'fresh candidate and contribution indexes publish their singleton and reference together',
  );
  assert.equal(
    firstWorkAfter.reportSnapshotCheckpointChanges -
      firstWorkBefore.reportSnapshotCheckpointChanges,
    42,
    'the same selected changes are still staged',
  );
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

async function coldOccurrenceFixture(t: test.TestContext, count = 1) {
  const entries = validateJSONL(
      Buffer.from(JSON.stringify(envelope('cold', 'current locator'))),
    ).entries!,
    file = { id: 'fictional-source', sha256: 'c'.repeat(64), mime_type: 'application/pdf' },
    retained: {
      version: number;
      originalName: string;
      proposals: { id: string }[];
      workflow?: ReturnType<typeof import('../intake-workflow.ts').intakeWorkflow>;
    } = {
      version: 1,
      originalName: 'fictional.pdf',
      proposals: [],
    };
  recordCandidateVersions(file, retained, entries, null);
  const original = retained.workflow!.candidates[0]!.versions[0]!.occurrences[0]!;
  Object.assign(original, {
    locator: 'different retained locator',
    unknown: 'preserved source field',
  });
  if (count > 1)
    retained.workflow!.candidates[0]!.versions[0]!.occurrences.push({
      ...original,
      recordId: 'other-retained-record',
    });
  const f = fixture(t, { intake: retained });
  await buildIntakeCollectionEnvelope(f.db, f.source);
  const store = createIntakeStateStorage(f.db, f.identity).collections;
  const prepare = (
    options: { batchId?: string; onCheckpoint?: () => void; assertRunning?: () => void } = {},
  ) => {
    const id = randomUUID();
    return prepareIntakeCollectionProposal(f.db, f.source, {
      reader: openIntakeCollectionEnvelope(f.db, f.source),
      file,
      proposalId: null,
      entries,
      operationId: id,
      requestDigest: createHash('sha256').update(id).digest('hex'),
      domainVersion: store.binding(store.openView())!.logical.domainVersion + 1,
      createdAt: '2026-09-17T12:00:00Z',
      reportEvidence: {
        packageEvidence: false,
        hasMember: () => false,
        contextLookup: { contexts: () => [] },
      },
      nextDiscoveryOrder: () => {
        throw Error('Retained group must keep discovery order');
      },
      ...options,
    });
  };
  const candidates = () =>
    (
      JSON.parse([...iterateIntakeEnvelopeText(f.db, f.source)].join('')) as {
        intake: typeof retained;
      }
    ).intake.workflow!.candidates;
  return {
    ...f,
    prepare,
    store,
    candidates,
    originalCandidates: structuredClone(retained.workflow!.candidates),
    occurrenceIndex() {
      const reader = openIntakeCollectionEnvelope(f.db, f.source),
        intake = reader.child(reader.root(), 'intake')!,
        workflow = reader.child(intake, 'workflow')!,
        candidate = reader.find('candidate', workflow, retained.workflow!.candidates[0]!.id)!,
        version = reader.find(
          'version',
          candidate,
          retained.workflow!.candidates[0]!.versions[0]!.id,
        )!;
      return createReportSnapshotCatalog(f.db, f.source).open(
        'candidate-occurrences:' +
          reader.address(version) +
          ':' +
          reader.childCount(version, 'occurrences'),
      );
    },
  };
}

for (const observed of [false, true])
  test(`cold singleton compiler retains exact duplicate semantics and observer barriers observed=${observed}`, async (t) => {
    const f = await coldOccurrenceFixture(t),
      before = intakeWorkCounters(f.db).warm;
    let observations = 0;
    const prepared = await f.prepare(
        observed
          ? {
              onCheckpoint: () => {
                observations++;
              },
            }
          : {},
      ),
      after = intakeWorkCounters(f.db).warm;
    assert.equal(
      after.reportSnapshotCheckpointBatches - before.reportSnapshotCheckpointBatches,
      observed ? 7 : 4,
    );
    if (observed)
      assert.ok(observations >= 7, 'original eager checkpoint callbacks remain observable');
    transaction(f.db, () => f.store.stage(prepared.prepared!));
    assert.deepEqual(
      f.candidates(),
      f.originalCandidates,
      'same recordId/batchId remains duplicate despite differing locator/unknown source fields',
    );
    assert.equal(
      !!f.occurrenceIndex(),
      observed,
      'only the observer path materializes the duplicate index',
    );
    const secondBefore = intakeWorkCounters(f.db).warm.reportSnapshotCheckpointBatches,
      second = await f.prepare();
    assert.equal(
      intakeWorkCounters(f.db).warm.reportSnapshotCheckpointBatches,
      secondBefore,
      'retained duplicates require no later derived publication',
    );
    transaction(f.db, () => f.store.stage(second.prepared!));
    assert.deepEqual(f.candidates(), f.originalCandidates);
  });

for (const scenario of ['different-key', 'multiple-occurrences'] as const)
  test(`cold singleton compiler keeps original fallback for ${scenario}`, async (t) => {
    const f = await coldOccurrenceFixture(t, scenario === 'multiple-occurrences' ? 2 : 1);
    if (scenario === 'different-key') {
      const duplicate = await f.prepare();
      transaction(f.db, () => f.store.stage(duplicate.prepared!));
      assert.equal(f.occurrenceIndex(), undefined, 'duplicate proof leaves the index deferred');
    }
    const prepared = await f.prepare(scenario === 'different-key' ? { batchId: 'new-batch' } : {});
    transaction(f.db, () => f.store.stage(prepared.prepared!));
    const actual = f.candidates()[0]!.versions[0]!.occurrences,
      old = f.originalCandidates[0]!.versions[0]!.occurrences;
    assert.deepEqual(actual.slice(0, old.length), old);
    assert.equal(actual.length, scenario === 'different-key' ? 2 : 2);
    if (scenario === 'different-key') assert.equal(actual[1]!.batchId, 'new-batch');
    else assert.deepEqual(f.candidates(), f.originalCandidates);
  });

for (const drift of ['source', 'physical-head'] as const)
  test(`cold duplicate refuses ${drift} drift across its cooperative yield`, async (t) => {
    const f = await coldOccurrenceFixture(t),
      originalHead = Buffer.from(f.authority.objects.get('head')!);
    let directChecks = 0,
      scheduled = false,
      changed = false;
    const before = intakeWorkCounters(f.db).warm.reportSnapshotCheckpointBatches;
    const outcome = await f
      .prepare({
        assertRunning: () => {
          const stack = new Error().stack ?? '';
          // Exclude the nested catalog.open check; queue a real mutation before the compiler yields.
          if (
            /at Object\.assertCurrent[^\n]*\n\s+at Object\.changes \(/.test(stack) &&
            ++directChecks === 2
          ) {
            scheduled = true;
            setImmediate(() => {
              changed = true;
              if (drift === 'source')
                f.db
                  .prepare('UPDATE source_files SET sha256=? WHERE id=?')
                  .run('d'.repeat(64), f.source.id);
              else {
                const ref = JSON.parse(originalHead.toString()) as { sha256: string };
                ref.sha256 = ref.sha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
                f.authority.objects.set('head', Buffer.from(JSON.stringify(ref)));
              }
            });
          }
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.equal(scheduled, true, 'mutation was scheduled at the real pre-yield currentness check');
    assert.equal(changed, true, 'cooperative yield ran the queued source/HEAD mutation');
    assert.ok(outcome instanceof Error, 'the authenticated preparation refuses the drift');
    assert.match(
      outcome.message,
      drift === 'source'
        ? /missing selected intake head|Stale report snapshot source or logical state/
        : /requires configured current accepted authority/,
    );
    assert.equal(intakeWorkCounters(f.db).warm.reportSnapshotCheckpointBatches, before);
    if (drift === 'source')
      f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run(f.source.sha256, f.source.id);
    else f.authority.objects.set('head', originalHead);
    f.authority.attach(f.db);
    clearIntakeStateCache(f.db);
    assert.deepEqual(f.candidates(), f.originalCandidates);
  });

for (const point of ['before', 'after'] as const)
  test(`cold duplicate contribution-index ${point} HEAD failure leaves clinical state unchanged and retries exactly`, async (t) => {
    const f = await coldOccurrenceFixture(t),
      original = f.authority.objects.set;
    let injected = false;
    f.authority.objects.set = function (name, value) {
      if (name === 'head' && !injected) {
        injected = true;
        if (point === 'after') original.call(this, name, value);
        throw Error('Fictional cold singleton ' + point + ' HEAD fault');
      }
      return original.call(this, name, value);
    };
    try {
      await assert.rejects(
        f.prepare(),
        new RegExp('Fictional cold singleton ' + point + ' HEAD fault'),
      );
    } finally {
      f.authority.objects.set = original;
    }
    assert.equal(injected, true);
    f.authority.attach(f.db);
    clearIntakeStateCache(f.db);
    assert.deepEqual(f.candidates(), f.originalCandidates);
    const prepared = await f.prepare();
    transaction(f.db, () => f.store.stage(prepared.prepared!));
    assert.deepEqual(f.candidates(), f.originalCandidates);
  });
