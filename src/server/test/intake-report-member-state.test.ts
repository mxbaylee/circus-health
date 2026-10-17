import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, clinicalReviewRevision } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import {
  createReportMemberSnapshot,
  openReportMemberSnapshot,
} from '../intake-report-member-state.ts';
import { canonicalLiteral } from '../intake-format.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-report-snapshot-')),
    identity = {
      profileId: 'fictional-report',
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
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 1,
      originalName: 'fictional.zip',
      workflow: { format: 'health-intake-workflow-v1', candidates: [] },
    },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      'fictional.zip',
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
    authority,
    source: { id: identity.intakeId, sha256: identity.sourceHash },
  };
}
test('snapshot text keeps tiny values inline and streams escaped or oversized encoded values', async (t) => {
  const { db, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    writer = await catalog.fork();
  const before = intakeWorkCounters(db).warm.reportSnapshotCheckpointChanges;
  await writer.putText('tiny', ['fictional ', 'small value']);
  assert.equal(writer.get('tiny'), 'fictional small value');
  assert.equal(
    intakeWorkCounters(db).warm.reportSnapshotCheckpointChanges - before,
    1,
    'one inline value avoids a byte collection and attachment checkpoint',
  );
  for (const [name, value] of [
    ['escaped', '\\'.repeat(5000)],
    ['wrapper-limit', 'x'.repeat(8192)],
    ['unicode', '🌿'.repeat(5000)],
  ]) {
    await writer.putText(
      name!,
      (function* () {
        for (let at = 0; at < value!.length; at += 17) yield value!.slice(at, at + 17);
      })(),
    );
    assert.equal(typeof writer.get(name!), 'object');
    assert.equal([...writer.chunks(name!)].join(''), value);
  }
});
test('fresh report snapshot seeds bounded entries in its eager checkpoint', async (t) => {
  const { db, source, identity } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    collections = createIntakeStateStorage(db, identity).collections,
    sequence = () => collections.binding(collections.openView())!.storageSequence,
    entries = Array.from({ length: 63 }, (_, ordinal) => ({
      key: 'fictional:' + ordinal,
      value: 'value:' + ordinal,
    }));
  const before = sequence();
  const writer = await catalog.fork(undefined, entries);
  assert.equal(sequence() - before, 1, 'format and 63 entries share one real checkpoint');
  for (const entry of entries) assert.equal(writer.get(entry.key), entry.value);
  assert.equal(writer.get('$format'), 'health-intake-report-snapshot-map-v1');
  const after = sequence();
  await assert.rejects(
    catalog.fork(undefined, [...entries, { key: 'extra', value: '1' }]),
    /budget/,
  );
  await assert.rejects(catalog.fork(undefined, [{ key: 'bad', value: 'x'.repeat(9000) }]), /entry/);
  await assert.rejects(catalog.fork(undefined, [{ key: 'k'.repeat(1025), value: '1' }]), /entry/);
  await assert.rejects(catalog.fork(undefined, [{ key: '$format', value: 'wrong' }]), /entry/);
  await assert.rejects(
    catalog.fork(undefined, [
      { key: 'bad', value: 1 } as unknown as { key: string; value: string },
    ]),
    /entry/,
  );
  assert.equal(sequence(), after, 'invalid initial entries never create a partial build');
  await catalog.publish('prior', writer);
  const afterPublish = sequence();
  await assert.rejects(catalog.fork('prior', [{ key: 'extra', value: '1' }]), /budget/);
  assert.equal(sequence(), afterPublish, 'an inherited fork cannot merge new initial entries');
});
test('ordinary new member and first occurrence share one checkpoint with exact sequential content', async (t) => {
  const { db, source, identity } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    collections = createIntakeStateStorage(db, identity).collections,
    sequence = () => collections.binding(collections.openView())!.storageSequence,
    member = {
      candidateId: 'fictional-candidate',
      candidateVersionId: 'version',
      section: 'Panel',
    },
    value = {
      proposalId: 'fictional-proposal',
      recordId: 'fictional-record',
      batchId: null,
      locator: 'page 1',
    },
    combined = await createReportMemberSnapshot(catalog, 'combined'),
    sequential = await createReportMemberSnapshot(catalog, 'sequential');
  const beforeCombined = sequence();
  const combinedMember = await combined.includeOrdinaryOccurrence(member, value);
  assert.equal(sequence() - beforeCombined, 1);
  const beforeSequential = sequence();
  const sequentialMember = await sequential.occurrence(await sequential.include(member), value);
  assert.equal(sequence() - beforeSequential, 2);
  assert.deepEqual(combinedMember, sequentialMember);
  assert.deepEqual(combined.reader().reference, {
    ...sequential.reader().reference,
    snapshotId: 'combined',
  });
  assert.equal(
    [...combined.reader().canonicalMembers()].join(''),
    [...sequential.reader().canonicalMembers()].join(''),
  );
  assert.equal(combined.reader().hasOccurrence(combinedMember, value), true);
  assert.equal(combined.reader().hasSourceOccurrence(combinedMember, value), true);
  const beforeDuplicate = sequence();
  assert.deepEqual(await combined.includeOrdinaryOccurrence(member, value), combinedMember);
  assert.equal(
    sequence(),
    beforeDuplicate,
    'an existing exact occurrence stays on the original no-write path',
  );
  const next = { ...value, recordId: 'fictional-second-record' };
  const beforeExisting = sequence();
  const combinedNext = await combined.includeOrdinaryOccurrence(member, next);
  assert.equal(
    sequence() - beforeExisting,
    1,
    'an indexed member uses the original occurrence write',
  );
  const sequentialNext = await sequential.occurrence(sequentialMember, next);
  assert.deepEqual(combinedNext, sequentialNext);
  assert.deepEqual(combined.reader().reference, {
    ...sequential.reader().reference,
    snapshotId: 'combined',
  });
  assert.equal(
    [...combined.reader().canonicalMembers()].join(''),
    [...sequential.reader().canonicalMembers()].join(''),
  );
});
test('ordered ordinary members pack at most 64 changes with exact eager content', async (t) => {
  const { db, source, identity } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    collections = createIntakeStateStorage(db, identity).collections,
    sequence = () => collections.binding(collections.openView())!.storageSequence,
    items = Array.from({ length: 10 }, (_, ordinal) => ({
      member: { candidateId: 'candidate-' + ordinal, candidateVersionId: 'version', section: '🌿' },
      value: {
        proposalId: 'proposal',
        recordId: 'record-' + ordinal,
        batchId: null,
        locator: 'page 1',
      },
    })),
    bulk = await createReportMemberSnapshot(catalog, 'bulk'),
    eager = await createReportMemberSnapshot(catalog, 'eager'),
    before = sequence(),
    changesBefore = intakeWorkCounters(db).warm.reportSnapshotCheckpointChanges;
  await bulk.includeOrdinaryOccurrences(items);
  assert.equal(sequence() - before, 3, 'four 14-change discoveries fit each bounded checkpoint');
  assert.equal(intakeWorkCounters(db).warm.reportSnapshotCheckpointChanges - changesBefore, 140);
  const eagerBefore = sequence();
  for (const { member, value } of items) await eager.includeOrdinaryOccurrence(member, value);
  assert.equal(sequence() - eagerBefore, 10);
  assert.deepEqual(bulk.reader().reference, { ...eager.reader().reference, snapshotId: 'bulk' });
  assert.equal(
    [...bulk.reader().canonicalMembers()].join(''),
    [...eager.reader().canonicalMembers()].join(''),
  );
  for (const [ordinal, { member, value }] of items.entries()) {
    const actual = bulk.reader().member(member.candidateId, member.candidateVersionId)!;
    assert.equal(actual.ordinal, ordinal);
    assert.equal(bulk.reader().hasOccurrence(actual, value), true);
    assert.equal(bulk.reader().hasSourceOccurrence(actual, value), true);
  }
});
test('fresh member snapshot seeds its first ordinary occurrence in the eager checkpoint', async (t) => {
  const { db, source, identity } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    collections = createIntakeStateStorage(db, identity).collections,
    sequence = () => collections.binding(collections.openView())!.storageSequence,
    member = {
      candidateId: 'fictional-candidate',
      candidateVersionId: 'version',
      section: 'Panel',
    },
    value = {
      proposalId: 'fictional-proposal',
      recordId: 'fictional-record',
      batchId: null,
      locator: 'page 1',
    };
  const beforeSeed = sequence();
  const seeded = await createReportMemberSnapshot(catalog, 'seeded', undefined, { member, value });
  assert.equal(seeded.seededFirstOccurrence, true);
  assert.equal(
    sequence() - beforeSeed,
    1,
    'format and first occurrence share the eager checkpoint',
  );
  const beforeOrdinary = sequence();
  const ordinary = await createReportMemberSnapshot(catalog, 'ordinary');
  assert.equal(ordinary.seededFirstOccurrence, false);
  assert.equal(sequence() - beforeOrdinary, 1, 'default empty construction stays eager');
  await ordinary.includeOrdinaryOccurrence(member, value);
  assert.equal(sequence() - beforeOrdinary, 2);
  const second = { ...value, recordId: 'fictional-second-record' };
  await seeded.includeOrdinaryOccurrence(member, second);
  await ordinary.includeOrdinaryOccurrence(member, second);
  assert.deepEqual(seeded.reader().reference, {
    ...ordinary.reader().reference,
    snapshotId: 'seeded',
  });
  assert.equal(
    [...seeded.reader().canonicalMembers()].join(''),
    [...ordinary.reader().canonicalMembers()].join(''),
  );
  const seededMember = seeded.reader().member(member.candidateId, member.candidateVersionId)!;
  assert.equal(seeded.reader().hasOccurrence(seededMember, value), true);
  assert.equal(seeded.reader().hasOccurrence(seededMember, second), true);
});
test('fresh member seed keeps inherited and oversized inputs on their original paths', async (t) => {
  const { db, source, identity } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    collections = createIntakeStateStorage(db, identity).collections,
    sequence = () => collections.binding(collections.openView())!.storageSequence,
    member = { candidateId: 'fictional-candidate', candidateVersionId: 'version' },
    value = { proposalId: 'proposal', recordId: 'record', batchId: null, locator: 'page 1' };
  const first = await createReportMemberSnapshot(catalog, 'first', undefined, { member, value });
  const reference = await first.finish();
  const beforeInherited = sequence();
  const inherited = await createReportMemberSnapshot(catalog, 'inherited', reference, {
    member,
    value,
  });
  assert.equal(inherited.seededFirstOccurrence, false);
  assert.equal(sequence() - beforeInherited, 1);
  const oversized = { ...value, locator: 'L'.repeat(9000) };
  const beforeOversized = sequence();
  const fallback = await createReportMemberSnapshot(catalog, 'oversized', undefined, {
    member,
    value: oversized,
  });
  assert.equal(fallback.seededFirstOccurrence, false);
  assert.equal(sequence() - beforeOversized, 1);
  const fallbackMember = await fallback.includeOrdinaryOccurrence(member, oversized);
  assert.equal(fallback.reader().hasOccurrence(fallbackMember, oversized), true);
  const oversizedSection = { ...member, section: 'S'.repeat(9000) };
  const sectionFallback = await createReportMemberSnapshot(
    catalog,
    'oversized-section',
    undefined,
    {
      member: oversizedSection,
      value,
    },
  );
  assert.equal(sectionFallback.seededFirstOccurrence, false);
  const sectionMember = await sectionFallback.includeOrdinaryOccurrence(oversizedSection, value);
  assert.equal(sectionFallback.reader().hasOccurrence(sectionMember, value), true);
});
test('seeded member retains absent and explicit-null section grammar', async (t) => {
  const { db, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    value = { proposalId: 'proposal', recordId: 'record', batchId: null, locator: 'page 1' };
  for (const [name, member] of [
    ['absent', { candidateId: 'candidate', candidateVersionId: 'version' }],
    ['null', { candidateId: 'candidate', candidateVersionId: 'version', section: null }],
  ] as const) {
    const seeded = await createReportMemberSnapshot(catalog, name + '-seeded', undefined, {
      member,
      value,
    });
    const ordinary = await createReportMemberSnapshot(catalog, name + '-ordinary');
    assert.equal(seeded.seededFirstOccurrence, true);
    await ordinary.includeOrdinaryOccurrence(member, value);
    assert.equal(
      [...seeded.reader().canonicalMembers()].join(''),
      [...ordinary.reader().canonicalMembers()].join(''),
    );
  }
});
test('cancellation during seeded constructor leaves no selected member snapshot', async (t) => {
  const { db, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  let running = true,
    cancelAtCheckpoint = false;
  const catalog = createReportSnapshotCatalog(db, source, {
    assertRunning: () => {
      if (!running) throw Error('Fictional cancellation');
    },
    onCheckpoint: () => {
      if (cancelAtCheckpoint) running = false;
    },
  });
  await catalog.fork();
  cancelAtCheckpoint = true;
  await assert.rejects(
    createReportMemberSnapshot(catalog, 'cancelled-seed', undefined, {
      member: { candidateId: 'fictional-candidate', candidateVersionId: 'version' },
      value: { proposalId: 'proposal', recordId: 'record', batchId: null, locator: 'page 1' },
    }),
    /Fictional cancellation/,
  );
  running = true;
  assert.equal(catalog.open('cancelled-seed'), undefined);
});
test('oversized ordinary inputs use the original streamed member and occurrence checkpoints', async (t) => {
  const { db, source, identity } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    collections = createIntakeStateStorage(db, identity).collections,
    sequence = () => collections.binding(collections.openView())!.storageSequence;
  for (const [name, section, locator] of [
    ['section', 'S'.repeat(9000), 'page 1'],
    ['occurrence', 'Panel', 'L'.repeat(9000)],
  ]) {
    const member = { candidateId: name!, candidateVersionId: 'version', section: section! },
      value = {
        proposalId: 'fictional-proposal',
        recordId: name!,
        batchId: null,
        locator: locator!,
      },
      combined = await createReportMemberSnapshot(catalog, name! + '-combined'),
      sequential = await createReportMemberSnapshot(catalog, name! + '-sequential');
    const beforeCombined = sequence();
    const combinedMember = await combined.includeOrdinaryOccurrence(member, value);
    const combinedChanges = sequence() - beforeCombined;
    const beforeSequential = sequence();
    const sequentialMember = await sequential.occurrence(await sequential.include(member), value);
    assert.equal(combinedChanges, sequence() - beforeSequential);
    assert.deepEqual(combinedMember, sequentialMember);
    assert.equal(
      [...combined.reader().canonicalMembers()].join(''),
      [...sequential.reader().canonicalMembers()].join(''),
    );
  }
});
test('cancellation at the combined checkpoint leaves its report snapshot unselected', async (t) => {
  const { db, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  let running = true,
    cancelAtCheckpoint = false;
  const catalog = createReportSnapshotCatalog(db, source, {
    assertRunning: () => {
      if (!running) throw Error('Fictional cancellation');
    },
    onCheckpoint: () => {
      if (cancelAtCheckpoint) running = false;
    },
  });
  const writer = await createReportMemberSnapshot(catalog, 'cancelled');
  cancelAtCheckpoint = true;
  await assert.rejects(
    writer.includeOrdinaryOccurrence(
      { candidateId: 'fictional-candidate', candidateVersionId: 'version' },
      { proposalId: 'fictional-proposal', recordId: 'record', batchId: null, locator: 'page 1' },
    ),
    /Fictional cancellation/,
  );
  running = true;
  assert.equal(catalog.open('cancelled'), undefined);
});
test('report snapshots share old members, keep exact hash grammar and select all catalog changes atomically', async (t) => {
  const { db, source, identity } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const revision = clinicalReviewRevision(db),
    catalog = createReportSnapshotCatalog(db, source),
    collections = createIntakeStateStorage(db, identity).collections,
    sequence = () => collections.binding(collections.openView())!.storageSequence,
    beforeFresh = sequence(),
    first = await createReportMemberSnapshot(catalog, 'first');
  assert.equal(sequence() - beforeFresh, 1, 'fresh member metadata shares its format checkpoint');
  const occurrence = {
    proposalId: 'fictional-proposal',
    recordId: 'fictional-record',
    batchId: null,
    locator: 'page 🌿',
  };
  const sequenceBefore = sequence();
  let member = await first.include({ candidateId: 'candidate', candidateVersionId: 'version' });
  member = await first.occurrence(member, occurrence);
  assert.equal(
    collections.binding(collections.openView())!.storageSequence - sequenceBefore,
    2,
    'bounded member metadata and occurrence metadata each publish one checkpoint',
  );
  const ref1 = await first.finish();
  const second = await createReportMemberSnapshot(catalog, 'second', ref1);
  const extra = { ...occurrence, unknown: 'retained' };
  await second.occurrence(second.reader().member('candidate', 'version')!, extra);
  const ref2 = await second.finish();
  assert.equal(clinicalReviewRevision(db), revision);
  assert.equal(createReportSnapshotCatalog(db, source).open('first'), undefined);
  const store = createIntakeStateStorage(db, identity).collections,
    id = randomUUID();
  const prepared = store.prepare(store.openView(), {
    operationId: id,
    requestDigest: createHash('sha256').update(id).digest('hex'),
    domainVersion: 1,
    changes: await catalog.finalChanges(),
  });
  transaction(db, () => store.stage(prepared));
  assert.throws(() => catalog.open('first'), /Stale/);
  const selected = createReportSnapshotCatalog(db, source),
    old = openReportMemberSnapshot(selected, ref1),
    next = openReportMemberSnapshot(selected, ref2);
  assert.equal(
    [...old.canonicalMembers()].join(''),
    canonicalLiteral([
      { candidateId: 'candidate', candidateVersionId: 'version', occurrences: [occurrence] },
    ]),
  );
  assert.equal(
    [...next.canonicalMembers()].join(''),
    canonicalLiteral([
      { candidateId: 'candidate', candidateVersionId: 'version', occurrences: [occurrence, extra] },
    ]),
  );
  const item = next.member('candidate', 'version')!;
  const different = { ...occurrence, unknown: 'different' };
  assert.equal(next.hasOccurrence(item, different), false);
  assert.equal(
    next.hasSourceOccurrence(item, { ...occurrence, unknown: 'different' } as typeof occurrence),
    true,
  );
  const descriptors = next.occurrenceDescriptors(item, { items: 10, bytes: 4096 });
  assert.equal(
    descriptors.occurrences[0]!.sourceIdentity,
    descriptors.occurrences[1]!.sourceIdentity,
  );
  assert.equal(
    [...next.canonicalOccurrence(descriptors.occurrences[1]!)].join(''),
    canonicalLiteral(extra),
  );
  assert.throws(() => next.canonicalOccurrence({ ...descriptors.occurrences[0]! }), /Foreign/);
});
test('fragmented giant occurrence and retained duplicate members never require full member hydration', async (t) => {
  const { db, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    writer = await createReportMemberSnapshot(catalog, 'giant'),
    value = { proposalId: null, recordId: 'fictional', batchId: null, locator: '🌿'.repeat(50000) };
  let first = await writer.include(
    { candidateId: 'same', candidateVersionId: 'version' },
    {
      canonicalPrefix: ['{"candidateId":"same","candidateVersionId":"version","occurrences":'],
      canonicalSuffix: [',"unknown":', JSON.stringify('untouched'.repeat(10000)), '}'],
    },
  );
  first = await writer.occurrence(first, value);
  await writer.include(
    { candidateId: 'same', candidateVersionId: 'version' },
    { retainDuplicate: true },
  );
  const reader = writer.reader(),
    descriptors = reader.occurrenceDescriptors(first, { items: 1, bytes: 512 });
  let peak = 0,
    actual = '';
  for (const chunk of reader.canonicalOccurrence(descriptors.occurrences[0]!)) {
    peak = Math.max(peak, Buffer.byteLength(chunk));
    actual += chunk;
  }
  assert.ok(peak <= 4096);
  assert.equal(actual, canonicalLiteral(value));
  assert.equal(reader.reference.memberCount, 2);
  assert.equal(reader.member('same', 'version')?.ordinal, 0);
  assert.equal(
    [...reader.canonicalMembers()].join(''),
    canonicalLiteral([
      {
        candidateId: 'same',
        candidateVersionId: 'version',
        occurrences: [value],
        unknown: 'untouched'.repeat(10000),
      },
      { candidateId: 'same', candidateVersionId: 'version', occurrences: [] },
    ]),
  );
});

const ordinaryDiscovery = (ordinal: number) => ({
  member: { candidateId: 'candidate-' + ordinal, candidateVersionId: 'version', section: '🌿' },
  value: {
    proposalId: 'proposal',
    recordId: 'record-' + ordinal,
    batchId: null,
    locator: 'page 1',
  },
});

test('bulk discovery preserves duplicate, inherited, absent/null and oversized barriers', async (t) => {
  const { db, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    initial = await createReportMemberSnapshot(catalog, 'initial');
  await initial.includeOrdinaryOccurrence(ordinaryDiscovery(0).member, ordinaryDiscovery(0).value);
  const reference = await initial.finish(),
    bulk = await createReportMemberSnapshot(catalog, 'bulk', reference),
    eager = await createReportMemberSnapshot(catalog, 'eager', reference),
    items = [
      ordinaryDiscovery(1),
      ordinaryDiscovery(2),
      ordinaryDiscovery(1),
      {
        member: ordinaryDiscovery(1).member,
        value: { ...ordinaryDiscovery(1).value, locator: 'page 2' },
      },
      ordinaryDiscovery(0),
      {
        member: { ...ordinaryDiscovery(3).member, section: 'S'.repeat(9000) },
        value: ordinaryDiscovery(3).value,
      },
      {
        member: ordinaryDiscovery(4).member,
        value: { ...ordinaryDiscovery(4).value, locator: 'L'.repeat(9000) },
      },
      {
        member: { candidateId: 'absent', candidateVersionId: 'version' },
        value: ordinaryDiscovery(5).value,
      },
      {
        member: { candidateId: 'null', candidateVersionId: 'version', section: null },
        value: ordinaryDiscovery(6).value,
      },
      ordinaryDiscovery(7),
    ];
  await bulk.includeOrdinaryOccurrences(items);
  for (const { member, value } of items) await eager.includeOrdinaryOccurrence(member, value);
  assert.deepEqual(bulk.reader().reference, { ...eager.reader().reference, snapshotId: 'bulk' });
  assert.equal(
    [...bulk.reader().canonicalMembers()].join(''),
    [...eager.reader().canonicalMembers()].join(''),
  );
  assert.equal(bulk.reader().reference.memberCount, 8);
  assert.equal(bulk.reader().reference.occurrenceCount, 9);
  const expected = [...eager.reader().canonicalMembers()].join(''),
    selected = await bulk.finish();
  const collections = createIntakeStateStorage(db, {
      profileId: 'fictional-report',
      intakeId: source.id,
      sourceHash: source.sha256,
    }).collections,
    id = randomUUID(),
    prepared = collections.prepare(collections.openView(), {
      operationId: id,
      requestDigest: createHash('sha256').update(id).digest('hex'),
      domainVersion: 1,
      changes: await catalog.finalChanges(),
    });
  transaction(db, () => collections.stage(prepared));
  clearIntakeStateCache(db);
  const recovered = openReportMemberSnapshot(createReportSnapshotCatalog(db, source), selected);
  assert.equal([...recovered.canonicalMembers()].join(''), expected);
  assert.deepEqual(recovered.reference, selected);
});

test('bulk ownership refuses reentrant reads, writes, finish and nested batches across checkpoints', async (t) => {
  const { db, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  let inspect: (() => Promise<void>) | undefined;
  const catalog = createReportSnapshotCatalog(db, source, { onCheckpoint: () => inspect?.() }),
    writer = await createReportMemberSnapshot(catalog, 'guarded'),
    retainedReader = writer.reader(),
    retainedRead = retainedReader.member,
    retainedPieces = retainedReader.canonicalMembers()[Symbol.iterator](),
    item = ordinaryDiscovery(0);
  let observed = 0;
  inspect = async () => {
    observed++;
    assert.throws(() => writer.reader(), /batch is pending/);
    assert.throws(() => retainedReader.reference, /batch is pending/);
    assert.throws(() => retainedRead('candidate-0', 'version'), /batch is pending/);
    if (observed === 1) assert.throws(() => retainedPieces.next(), /batch is pending/);
    else
      assert.equal(
        retainedPieces.next().done,
        true,
        'a rejected iterator cannot later expose data',
      );
    await assert.rejects(writer.include(item.member), /batch is pending/);
    await assert.rejects(
      writer.includeOrdinaryOccurrence(item.member, item.value),
      /batch is pending/,
    );
    await assert.rejects(writer.includeOrdinaryOccurrences([]), /batch is pending/);
    await assert.rejects(writer.finish(), /batch is pending/);
  };
  await writer.includeOrdinaryOccurrences(
    (function* () {
      yield item;
      assert.throws(
        () => writer.reader(),
        /batch is pending/,
        'iterator cannot inspect pending discovery',
      );
      for (let ordinal = 1; ordinal < 10; ordinal++) yield ordinaryDiscovery(ordinal);
    })(),
  );
  assert.equal(observed, 3);
  inspect = undefined;
  assert.equal(writer.reader().reference.memberCount, 10);
  await writer.includeOrdinaryOccurrence(ordinaryDiscovery(10).member, ordinaryDiscovery(10).value);
  assert.equal(writer.reader().reference.memberCount, 11);
});

test('bulk cannot start during an ordinary checkpoint and staged strings survive input mutation', async (t) => {
  const { db, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  let inspect: (() => Promise<void>) | undefined;
  const catalog = createReportSnapshotCatalog(db, source, { onCheckpoint: () => inspect?.() }),
    writer = await createReportMemberSnapshot(catalog, 'ownership');
  inspect = async () => {
    await assert.rejects(writer.includeOrdinaryOccurrences([]), /operation is pending/);
  };
  await writer.includeOrdinaryOccurrence(ordinaryDiscovery(0).member, ordinaryDiscovery(0).value);
  const items = Array.from({ length: 5 }, (_, at) => ordinaryDiscovery(at + 1));
  let first = true;
  inspect = async () => {
    if (first) {
      first = false;
      // Item five was already serialized before awaiting the first four-item checkpoint.
      items[4]!.member.candidateId = 'mutated';
      items[4]!.value.locator = 'mutated';
    }
  };
  await writer.includeOrdinaryOccurrences(items);
  inspect = undefined;
  assert.equal(writer.reader().member('mutated', 'version'), undefined);
  const fifth = writer.reader().member('candidate-5', 'version')!;
  assert.equal(fifth.ordinal, 5);
  assert.equal(writer.reader().hasOccurrence(fifth, ordinaryDiscovery(5).value), true);
});

test('iterator failure keeps committed prefix, discards pending members and permits exact retry', async (t) => {
  const { db, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    writer = await createReportMemberSnapshot(catalog, 'retry');
  await assert.rejects(
    writer.includeOrdinaryOccurrences(
      (function* () {
        for (let ordinal = 0; ordinal < 6; ordinal++) yield ordinaryDiscovery(ordinal);
        throw Error('Fictional iterator failure');
      })(),
    ),
    /Fictional iterator failure/,
  );
  assert.equal(writer.reader().reference.memberCount, 4);
  assert.equal(writer.reader().member('candidate-4', 'version'), undefined);
  assert.equal(catalog.open('retry'), undefined);
  await writer.includeOrdinaryOccurrences(
    Array.from({ length: 6 }, (_, at) => ordinaryDiscovery(at)),
  );
  assert.equal(writer.reader().reference.memberCount, 6);
  assert.equal(writer.reader().reference.occurrenceCount, 6);
  for (let ordinal = 0; ordinal < 6; ordinal++)
    assert.equal(writer.reader().member('candidate-' + ordinal, 'version')!.ordinal, ordinal);
  await writer.finish();
});

test('failed bulk checkpoint leaves no partial member batch and releases ownership for retry', async (t) => {
  const { db, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    writer = await createReportMemberSnapshot(catalog, 'fault');
  db.exec(
    "CREATE TEMP TRIGGER fictional_member_fault BEFORE INSERT ON __record_versions BEGIN SELECT RAISE(ABORT,'Fictional member staging fault'); END",
  );
  await assert.rejects(
    writer.includeOrdinaryOccurrences([ordinaryDiscovery(0), ordinaryDiscovery(1)]),
    /Fictional member staging fault/,
  );
  db.exec('DROP TRIGGER fictional_member_fault');
  assert.equal(writer.reader().reference.memberCount, 0);
  assert.equal(catalog.open('fault'), undefined);
  await writer.includeOrdinaryOccurrences([ordinaryDiscovery(0), ordinaryDiscovery(1)]);
  assert.equal(writer.reader().reference.memberCount, 2);
  assert.equal(writer.reader().reference.occurrenceCount, 2);
});

test('source drift before a bulk flush rejects every pending member', async (t) => {
  const { db, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    writer = await createReportMemberSnapshot(catalog, 'stale');
  await assert.rejects(
    writer.includeOrdinaryOccurrences(
      (function* () {
        yield ordinaryDiscovery(0);
        db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('d'.repeat(64), source.id);
        yield ordinaryDiscovery(1);
      })(),
    ),
    /Intake envelope authority: missing selected intake head/,
  );
  db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run(source.sha256, source.id);
  assert.equal(writer.reader().reference.memberCount, 0);
  await assert.rejects(
    writer.includeOrdinaryOccurrences([ordinaryDiscovery(0)]),
    /uncommitted direct writes bypassed the transaction boundary/,
    'restoring a tampered source does not make its raw writes safe to publish',
  );
});

test('bulk cancellation retains only its completed bounded prefix before exact retry', async (t) => {
  const { db, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  let running = true,
    cancel = false;
  const catalog = createReportSnapshotCatalog(db, source, {
      assertRunning: () => {
        if (!running) throw Error('Fictional bulk cancellation');
      },
      onCheckpoint: () => {
        if (cancel) running = false;
      },
    }),
    writer = await createReportMemberSnapshot(catalog, 'cancelled-bulk'),
    items = Array.from({ length: 10 }, (_, at) => ordinaryDiscovery(at));
  cancel = true;
  await assert.rejects(writer.includeOrdinaryOccurrences(items), /Fictional bulk cancellation/);
  running = true;
  cancel = false;
  assert.equal(writer.reader().reference.memberCount, 4);
  assert.equal(writer.reader().reference.occurrenceCount, 4);
  assert.equal(writer.reader().member('candidate-4', 'version'), undefined);
  assert.equal(catalog.open('cancelled-bulk'), undefined);
  await writer.includeOrdinaryOccurrences(items);
  assert.equal(writer.reader().reference.memberCount, 10);
  assert.equal(writer.reader().reference.occurrenceCount, 10);
  assert.equal(
    [...writer.reader().canonicalMembers()].join(''),
    canonicalLiteral(items.map(({ member, value }) => ({ ...member, occurrences: [value] }))),
  );
  await writer.finish();
});

test('synchronous reader storage callbacks cannot start a crossing bulk operation', async (t) => {
  const { db, source, authority } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    writer = await createReportMemberSnapshot(catalog, 'read-owner'),
    item = ordinaryDiscovery(0);
  await writer.includeOrdinaryOccurrence(item.member, item.value);
  const retained = writer.reader(),
    pieces = retained.canonicalMembers()[Symbol.iterator]();
  assert.equal(pieces.next().value, '[');
  for (const read of [
    () => writer.reader(),
    () => retained.member(item.member.candidateId, item.member.candidateVersionId),
    () => pieces.next(),
  ]) {
    const original = authority.objects.get;
    let attempted: Promise<void> | undefined,
      invoked = false;
    authority.objects.get = function (key) {
      if (!invoked) {
        invoked = true;
        attempted = writer.includeOrdinaryOccurrences([ordinaryDiscovery(1)]);
      }
      return original.call(this, key);
    };
    try {
      read();
    } finally {
      authority.objects.get = original;
    }
    assert.ok(attempted, 'the actual fallback backend read callback ran');
    await assert.rejects(attempted, /operation is pending/);
    assert.equal(writer.reader().member('candidate-1', 'version'), undefined);
  }
  await writer.includeOrdinaryOccurrences([ordinaryDiscovery(1)]);
  assert.equal(writer.reader().reference.memberCount, 2);
});

test('bulk owns its entry authority callback before any reentrant discovery', async (t) => {
  const { db, source } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  let inspect: (() => void) | undefined;
  const catalog = createReportSnapshotCatalog(db, source, { assertRunning: () => inspect?.() }),
    writer = await createReportMemberSnapshot(catalog, 'entry-owner');
  let nested: Promise<void> | undefined,
    attempted = false;
  inspect = () => {
    if (!attempted) {
      attempted = true;
      nested = assert.rejects(
        writer.includeOrdinaryOccurrences([ordinaryDiscovery(1)]),
        /batch is pending/,
      );
    }
  };
  await writer.includeOrdinaryOccurrences([ordinaryDiscovery(0)]);
  inspect = undefined;
  assert.ok(nested, 'the actual catalog entry callback ran');
  await nested;
  assert.equal(writer.reader().reference.memberCount, 1);
  assert.equal(writer.reader().member('candidate-1', 'version'), undefined);
  await writer.includeOrdinaryOccurrences([ordinaryDiscovery(1)]);
  assert.equal(writer.reader().reference.memberCount, 2);
});
