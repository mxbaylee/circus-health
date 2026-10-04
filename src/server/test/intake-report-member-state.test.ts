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
  memoryRecordAuthority(db);
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
  return { db, identity, source: { id: identity.intakeId, sha256: identity.sourceHash } };
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
test('report snapshots share old members, keep exact hash grammar and select all catalog changes atomically', async (t) => {
  const { db, source, identity } = fixture(t);
  await buildIntakeCollectionEnvelope(db, source);
  const revision = clinicalReviewRevision(db),
    catalog = createReportSnapshotCatalog(db, source),
    first = await createReportMemberSnapshot(catalog, 'first');
  const occurrence = {
    proposalId: 'fictional-proposal',
    recordId: 'fictional-record',
    batchId: null,
    locator: 'page 🌿',
  };
  const collections = createIntakeStateStorage(db, identity).collections,
    sequenceBefore = collections.binding(collections.openView())!.storageSequence;
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
