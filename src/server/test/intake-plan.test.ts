import test from 'node:test';
import assert from 'node:assert/strict';
import { extractionUnits, type EvidenceIndex } from '../intake-plan.ts';

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
