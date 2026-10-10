import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  extractionUnits,
  packageMemberUnit,
  streamedExtractionPlanId,
  type EvidenceIndex,
} from '../intake-plan.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

function pdf(pages: number): EvidenceIndex {
  return { kind: 'pdf', pages };
}

test('omitted PDF overlap partitions every target page exactly once', () => {
  const examples = new Map<number, number[][]>([
    [1, [[1]]],
    [2, [[1, 2]]],
    [3, [[1, 2], [3]]],
    [7, [[1, 2], [3, 4], [5, 6], [7]]],
  ]);
  for (const [pageCount, expected] of examples) {
    const units = extractionUnits(pdf(pageCount));
    assert.deepEqual(
      units.map((unit) => unit.pages),
      expected,
    );
    assert.deepEqual(
      units.flatMap((unit) => unit.pages || []),
      Array.from({ length: pageCount }, (_, index) => index + 1),
    );
    assert.deepEqual(extractionUnits(pdf(pageCount)), units, 'unit IDs stay deterministic');
  }

  const large = extractionUnits(pdf(585));
  assert.equal(large.length, 293);
  assert.deepEqual(large[0]!.pages, [1, 2]);
  assert.deepEqual(large.at(-1)!.pages, [585]);
  assert.deepEqual(
    large.flatMap((unit) => unit.pages || []),
    Array.from({ length: 585 }, (_, index) => index + 1),
  );
});

test('explicit PDF overlap remains available and changes deterministic unit identity', () => {
  const withoutOverlap = extractionUnits(pdf(7));
  const withOverlap = extractionUnits(pdf(7), { unitSize: 2, overlap: 1 });
  assert.deepEqual(
    withOverlap.map((unit) => unit.pages),
    [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
    ],
  );
  assert.notDeepEqual(
    withOverlap.map((unit) => unit.id),
    withoutOverlap.map((unit) => unit.id),
  );
});

test('omitted overlap keeps the existing shared-row behavior for HTML plans', () => {
  const units = extractionUnits(
    {
      kind: 'html',
      sections: [
        {
          id: 'fictional-table',
          locator: 'fictional table',
          rows: Array.from({ length: 5 }, (_, index) => ({
            id: `row-${index + 1}`,
            start: index * 10,
            end: index * 10 + 9,
          })),
        },
      ],
    },
    { unitSize: 2 },
  );
  assert.deepEqual(
    units.map((unit) => unit.rows),
    [
      ['row-1', 'row-2'],
      ['row-2', 'row-3'],
      ['row-3', 'row-4'],
      ['row-4', 'row-5'],
    ],
  );
});

const fictionalPins = {
  sourceHash: 'a'.repeat(64),
  backend: 'fictional-provider',
  model: 'fictional-model "with quotes"',
  reasoningEffort: null,
  instructionVersion: 'b'.repeat(64),
  mappingVersion: 'c'.repeat(64),
};
const unitId = (ordinal: number) =>
  'unit:' + createHash('sha256').update(String(ordinal)).digest('hex');

test('implicit package units retain the exact existing occurrence identity recipe', () => {
  const member = {
    memberId: 'member:fictional-occurrence',
    ordinal: 0,
    filename: 'fictional/雪😀\\".pdf',
    locator: 'ZIP member fictional/雪😀\\".pdf',
    bytes: 450,
    compressedBytes: 120,
    sourceHash: 'd'.repeat(64),
    duplicateOf: null,
  };
  const value = {
    kind: 'package_member',
    memberId: member.memberId,
    sourceHash: member.sourceHash,
    filename: member.filename,
    locator: member.locator,
    bytes: member.bytes,
    duplicateOf: null,
    note: 'Inventory only. Read and account for this occurrence; filenames and byte reuse never establish clinical record identity.',
  };
  const expected = {
    id: 'unit:' + createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    ...value,
    status: 'pending',
    attempts: [],
  };
  assert.deepEqual(packageMemberUnit(member), expected);
  assert.deepEqual(
    extractionUnits({
      kind: 'zip',
      inventoryVersion: 1,
      members: [{ ...member, index: { kind: 'package_member' } }],
    }),
    [expected],
  );
  const duplicate = packageMemberUnit({
    ...member,
    memberId: 'member:separate-occurrence',
    ordinal: 1,
    duplicateOf: member.memberId,
  });
  assert.notEqual(duplicate.id, expected.id);
  assert.deepEqual(duplicate.attempts, []);
});

test('streamed plan IDs equal legacy ordered JSON for empty, escaped and reordered pins', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const sourceId = 'fictional-source-雪😀-"-\\-\ud800';
    const ordered = [unitId(0), unitId(2), unitId(1)];
    for (const pins of [
      fictionalPins,
      { ...fictionalPins, connectionIdentity: 'fictional-connection' },
      {
        mappingVersion: fictionalPins.mappingVersion,
        instructionVersion: fictionalPins.instructionVersion,
        reasoningEffort: fictionalPins.reasoningEffort,
        model: fictionalPins.model,
        backend: fictionalPins.backend,
        sourceHash: fictionalPins.sourceHash,
      },
    ]) {
      for (const ids of [[], ordered, [...ordered].reverse()]) {
        const encoded = JSON.stringify([sourceId, pins, ids]);
        const before = intakeWorkCounters(db).warm;
        const result = await streamedExtractionPlanId(db, sourceId, pins, ids);
        const after = intakeWorkCounters(db).warm;
        assert.equal(result.id, 'plan:' + createHash('sha256').update(encoded).digest('hex'));
        assert.equal(result.unitCount, ids.length);
        assert.equal(after.packagePlanUnitIds - before.packagePlanUnitIds, ids.length);
        assert.equal(
          after.packagePlanHashBytes - before.packagePlanHashBytes,
          Buffer.byteLength(encoded),
        );
      }
    }
  } finally {
    db.close();
  }
});

test('large plan fingerprint reads a single-pass producer once and yields to host requests', async () => {
  const db = new DatabaseSync(':memory:');
  let iterations = 0,
    visits = 0,
    yieldedToHost = false;
  const source = {
    *[Symbol.iterator]() {
      assert.equal(++iterations, 1);
      for (let ordinal = 0; ordinal < 10_001; ordinal++) {
        visits++;
        yield unitId(ordinal);
      }
    },
  };
  try {
    setImmediate(() => {
      yieldedToHost = true;
    });
    const result = await streamedExtractionPlanId(db, 'fictional-large', fictionalPins, source);
    assert.equal(result.unitCount, 10_001);
    assert.equal(iterations, 1);
    assert.equal(visits, 10_001);
    assert.equal(yieldedToHost, true);
    const work = intakeWorkCounters(db).warm;
    assert.equal(work.packagePlanUnitIds, 10_001);
    const framing = Buffer.byteLength(JSON.stringify(['fictional-large', fictionalPins, []]));
    assert.equal(work.packagePlanHashBytes, framing + 10_001 * 71 + 10_000);
  } finally {
    db.close();
  }
});

test('cancelled plan identity closes its producer and never acknowledges a partial fingerprint', async () => {
  const db = new DatabaseSync(':memory:');
  let visits = 0,
    closed = false;
  const cancelled = new Error('fictional cancellation');
  function* source() {
    try {
      for (;;) {
        visits++;
        yield unitId(visits);
      }
    } finally {
      closed = true;
    }
  }
  try {
    await assert.rejects(
      streamedExtractionPlanId(db, 'fictional-cancelled', fictionalPins, source(), () => {
        if (visits === 70) throw cancelled;
      }),
      (error) => error === cancelled,
    );
    assert.equal(closed, true);
    assert.equal(visits, 70);
    assert.equal(intakeWorkCounters(db).warm.packagePlanUnitIds, 69);
  } finally {
    db.close();
  }
});
