import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openDatabase, transaction } from '../database.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { nativePacketReadingGaps } from '../packet-reading-gaps-native.ts';
import { packetReadingIndexReferences } from '../packet-reading-index-references.ts';
import { packetSourceAncestry } from '../packet-source-ancestry.ts';
import { packetDependencies } from '../packet-selection.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { createReportMemberSnapshot } from '../intake-report-member-state.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { nativePacketReportReview } from '../packet-report-review-native.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-packet-native-scope-')),
    db = openDatabase(join(root, 'cache.sqlite'), 'fictional-packet');
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return db;
}

// One giant retained scalar exercises real page publication and receipt hashing;
// the timeout is a fixture hang guard, not a product performance bound.
test(
  'native retained reading disclosure covers every page and exact receipts without hydrating coverage notes',
  { timeout: 120000 },
  async (t) => {
    const db = fixture(t),
      notes = 'Exact fictional coverage 🪁'.repeat(20000),
      units = Array.from({ length: 71 }, (_, ordinal) => ({
        id: 'unit-' + ordinal,
        locator: 'Page ' + (ordinal + 1),
        attempts: ordinal % 3 ? ['batch'] : [],
        coverage: {
          unitId: 'unit-' + ordinal,
          kind: ordinal === 70 ? 'unreadable' : 'extracted',
          notes: ordinal === 1 ? notes : 'Fictional coverage',
        },
        ...(ordinal === 69
          ? { processingException: { reason: 'processing_stalled', at: '2026-01-01' } }
          : {}),
      }));
    registerRawIntakeFixture(
      db,
      'fictional',
      JSON.stringify({
        intake: {
          version: 1,
          originalName: 'fictional.pdf',
          workflow: {
            plans: [
              {
                id: 'fictional-plan',
                status: 'active',
                units,
                batches: [
                  {
                    id: 'batch',
                    coverage: units
                      .filter((unit) => unit.attempts.length)
                      .map((unit) => unit.coverage),
                  },
                ],
                index: {
                  references: [
                    {
                      status: 'capacity_exception',
                      locator: 'Remaining references',
                      note: 'Fictional unindexed references',
                    },
                  ],
                },
              },
            ],
          },
        },
      }),
    );
    await buildIntakeCollectionEnvelope(db, { id: 'fictional' });
    const before = { ...intakeWorkCounters(db).warm },
      gaps = nativePacketReadingGaps(db, 'fictional');
    assert.equal(gaps.length, 26);
    assert.deepEqual(gaps.at(-3), { locator: 'Page 70', reason: 'processing_stalled' });
    assert.deepEqual(gaps.at(-2), { locator: 'Page 71', reason: 'unreadable' });
    assert.deepEqual(gaps.at(-1), {
      locator: 'Remaining references',
      reason: 'capacity exception: Fictional unindexed references',
    });
    clearIntakeStateCache(db);
    assert.deepEqual(nativePacketReadingGaps(db, 'fictional'), gaps);
    for (const key of [
      'envelopeHydrations',
      'materializationReads',
      'sourceDTOHydrations',
    ] as const)
      assert.equal(intakeWorkCounters(db).warm[key], before[key], key);
  },
);

test('native report member snapshots preserve duplicate/current-version counting and giant occurrence evidence', async (t) => {
  const db = fixture(t);
  registerRawIntakeFixture(
    db,
    'fictional',
    JSON.stringify({
      intake: {
        version: 1,
        originalName: 'fictional.jsonl',
        workflow: {
          candidates: [
            {
              id: 'one',
              versions: [
                { id: 'old', status: 'accepted' },
                { id: 'current', status: 'pending' },
              ],
            },
            { id: 'two', versions: [{ id: 'saved', status: 'accepted' }] },
            {
              id: 'context',
              versions: [{ id: 'context-version', status: 'accepted', sourceContext: true }],
            },
          ],
          reportGroups: [{ id: 'report', basis: 'report_anchor', versions: [] }],
        },
      },
    }),
  );
  await buildIntakeCollectionEnvelope(db, { id: 'fictional' });
  const catalog = createReportSnapshotCatalog(db, { id: 'fictional' }),
    writer = await createReportMemberSnapshot(catalog, 'fictional-members');
  for (const [candidateId, candidateVersionId] of [
    ['one', 'old'],
    ['one', 'current'],
    ['two', 'saved'],
    ['context', 'context-version'],
    ['two', 'saved'],
  ] as const) {
    let member = await writer.include(
      { candidateId, candidateVersionId },
      { retainDuplicate: true },
    );
    member = await writer.occurrence(member, {
      proposalId: null,
      recordId: 'included',
      batchId: null,
      locator: 'Exact giant fictional locator 🪁'.repeat(10000),
    });
  }
  const members = await writer.finish(),
    view = openIntakeCollectionEnvelope(db, { id: 'fictional' }),
    flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
    group = view.find('reportGroup', flow, 'report')!,
    operationId = randomUUID();
  const result = await prepareIntakeEnvelopeMutation(
    db,
    { id: 'fictional' },
    {
      reader: view,
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 2,
      changes: [
        {
          op: 'append',
          record: group,
          field: 'versions',
          jsonText: JSON.stringify({
            format: 'health-intake-report-group-version-v2',
            id: 'latest',
            title: 'Fictional 🪁'.repeat(20000),
            members,
          }),
        },
      ],
      additionalLogicalChanges: () => catalog.finalChanges(),
    },
  );
  transaction(db, () =>
    selectedEnvelopeStore(db, { id: 'fictional' }).collections.stage(result.prepared!),
  );
  const before = { ...intakeWorkCounters(db).warm },
    reports = nativePacketReportReview(db, 'fictional', new Set(['included']));
  assert.deepEqual(
    reports.map(({ savedCount, totalCount, title }) => ({
      savedCount,
      totalCount,
      title: title.length,
    })),
    [{ savedCount: 1, totalCount: 2, title: 500 }],
  );
  assert.deepEqual(nativePacketReportReview(db, 'fictional', new Set(['unrelated'])), []);
  clearIntakeStateCache(db);
  assert.deepEqual(nativePacketReportReview(db, 'fictional', new Set(['included'])), reports);
  for (const key of ['envelopeHydrations', 'materializationReads', 'sourceDTOHydrations'] as const)
    assert.equal(intakeWorkCounters(db).warm[key], before[key], key);
});

test('packet ancestry retains every original in a deep chain and rejects cycles without a depth cap', async (t) => {
  const db = fixture(t);
  for (let ordinal = 0; ordinal < 66; ordinal++)
    registerRawIntakeFixture(
      db,
      'source-' + ordinal,
      JSON.stringify({
        intake: {
          version: 1,
          originalName: 'fictional-' + ordinal + '.txt',
          parentSourceFileId: ordinal ? 'source-' + (ordinal - 1) : null,
          workflow: { plans: [] },
        },
      }),
    );
  await buildIntakeCollectionEnvelope(db, { id: 'source-65' });
  const before = { ...intakeWorkCounters(db).warm },
    ancestors = [...packetSourceAncestry(db, ['source-65'])];
  assert.equal(ancestors.length, 66);
  const dependencies = packetDependencies(db, {
    key: 'source_file:source-65',
    type: 'source_file',
    id: 'source-65',
    title: 'Fictional deep source',
    date: null,
    row: {},
    citations: [],
    attachments: [],
  });
  assert.equal(dependencies.files.size, 66);
  assert.ok(dependencies.files.has('source-0'));
  assert.deepEqual([...dependencies.hashes], ['a'.repeat(64)]);
  clearIntakeStateCache(db);
  assert.deepEqual([...packetSourceAncestry(db, ['source-65'])], ancestors);
  for (const key of ['envelopeHydrations', 'materializationReads', 'sourceDTOHydrations'] as const)
    assert.equal(intakeWorkCounters(db).warm[key], before[key], key);
  registerRawIntakeFixture(
    db,
    'cycle-a',
    JSON.stringify({ intake: { version: 1, parentSourceFileId: 'cycle-b' } }),
  );
  registerRawIntakeFixture(
    db,
    'cycle-b',
    JSON.stringify({ intake: { version: 1, parentSourceFileId: 'cycle-a' } }),
  );
  assert.throws(
    () => [...packetSourceAncestry(db, ['cycle-a'])],
    /Cyclic retained source ancestry/,
  );
});

test('direct index capacity disclosures survive every escaped-string chunk boundary while unrelated rows stream', () => {
  const reference = {
      status: 'capacity_exception',
      locator: 'Page 🪁 "two"',
      note: 'Remaining\nfictional references',
    },
    text = JSON.stringify({
      sections: [{ rows: ['fictional'.repeat(10000)] }],
      references: [{ status: 'resolved', locator: 'Private unrelated' }, reference],
      extra: { nested: [{ more: 'ignored' }] },
    });
  for (const size of [1, 2, 3, 11, 4096]) {
    function* chunks() {
      for (let offset = 0; offset < text.length; offset += size)
        yield text.slice(offset, offset + size);
    }
    assert.deepEqual(
      [...packetReadingIndexReferences(chunks())],
      [{ locator: reference.locator, reason: 'capacity exception: ' + reference.note }],
    );
  }
});
