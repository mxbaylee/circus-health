import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  createTextPiecePlan,
  planTextPieceEdits,
  reconstructTextPieces,
  TEXT_PIECE_LIMITS,
  TextPieceError,
  type TextPieceSnapshot,
  type TextPiecePlan,
  type TextPieceLimits,
} from '../text-piece-edits.ts';
import { reconcileTextPieces, TEXT_PIECE_RECONCILE_LIMITS } from '../text-piece-reconcile.ts';

// Expected strings are constructed from fictional source strings, never from
// matched hashes, proposed edits, or reconstructed engine pieces.
function exact(actual: string, expected: string) {
  assert.equal(actual, expected);
  assert.deepEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}
function encoded(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
function input(snapshot: TextPieceSnapshot) {
  return JSON.stringify({
    head: snapshot.head,
    contents: [...snapshot.contents],
    occurrences: [...snapshot.occurrences],
    links: [...snapshot.links],
  });
}
function writes(plan: TextPiecePlan) {
  return {
    contentRowsWritten: plan.contentWrites.length,
    contentBytesWritten: plan.contentWrites.reduce((sum, row) => sum + encoded(row), 0),
    occurrenceRowsWritten: plan.occurrenceWrites.length,
    occurrenceBytesWritten: plan.occurrenceWrites.reduce((sum, row) => sum + encoded(row), 0),
    linkRowsWritten: plan.linkWrites.length,
    linkBytesWritten: plan.linkWrites.reduce((sum, row) => sum + encoded(row), 0),
    occurrenceRowsDeleted: plan.occurrenceDeletes.length,
    occurrenceBytesDeleted: plan.occurrenceDeletes.reduce((sum, key) => sum + encoded(key), 0),
    linkRowsDeleted: plan.linkDeletes.length,
    linkBytesDeleted: plan.linkDeletes.reduce((sum, key) => sum + encoded(key), 0),
    headBytesWritten: encoded(plan.head),
  };
}
function apply(before: TextPieceSnapshot | null, plan: TextPiecePlan): TextPieceSnapshot {
  assert.deepEqual(plan.expectedHead, before?.head ?? null);
  for (const [key, value] of Object.entries(writes(plan)))
    assert.equal(plan.metrics[key as keyof typeof plan.metrics], value, key);
  const contents = new Map(before?.contents);
  const occurrences = new Map(before?.occurrences);
  const links = new Map(before?.links);
  for (const row of plan.contentWrites) {
    if (contents.has(row.id)) assert.deepEqual(contents.get(row.id), row);
    contents.set(row.id, row);
  }
  for (const key of plan.occurrenceDeletes) occurrences.delete(key);
  for (const key of plan.linkDeletes) links.delete(key);
  for (const row of plan.occurrenceWrites) occurrences.set(row.id, row);
  for (const row of plan.linkWrites) links.set(row.id, row);
  return { head: plan.head, contents, occurrences, links };
}
function sequence(snapshot: TextPieceSnapshot) {
  const entries: { id: string; start: number; end: number; text: string }[] = [];
  let id = snapshot.head.first;
  let start = 0;
  const visited = new Set<string>();
  while (id !== null) {
    assert.ok(!visited.has(id));
    visited.add(id);
    const row = snapshot.occurrences.get(id)!;
    const text = snapshot.contents.get(row.contentId)!.text.slice(row.start, row.end);
    entries.push({ id, start, end: start + text.length, text });
    start += text.length;
    id = snapshot.links.get(id)!.next;
  }
  assert.equal(visited.size, snapshot.occurrences.size);
  return entries;
}
function bounded(snapshot: TextPieceSnapshot) {
  assert.ok(encoded(snapshot.head) <= TEXT_PIECE_LIMITS.maxHeadBytes);
  for (const row of snapshot.contents.values()) {
    assert.ok(Buffer.byteLength(row.text) <= TEXT_PIECE_LIMITS.maxContentBytes);
    assert.ok(encoded(row) <= TEXT_PIECE_LIMITS.maxRowBytes);
  }
  for (const map of [snapshot.occurrences, snapshot.links])
    for (const row of map.values()) assert.ok(encoded(row) <= TEXT_PIECE_LIMITS.maxRowBytes);
}
function initialize(text: string, limits: Partial<TextPieceLimits> = {}) {
  const initial = createTextPiecePlan(text, { sequenceId: randomUUID(), limits });
  return apply(null, initial);
}
function update(
  before: TextPieceSnapshot,
  expected: string,
  options: NonNullable<Parameters<typeof reconcileTextPieces>[2]> = {},
) {
  const saved = input(before);
  const plan = reconcileTextPieces(before, expected, options);
  assert.equal(input(before), saved, 'automatic planner must not mutate retained evidence');
  const after = apply(before, plan);
  exact(
    sequence(after)
      .map((row) => row.text)
      .join(''),
    expected,
  );
  exact(reconstructTextPieces(after).text, expected);
  bounded(after);
  for (const [id, row] of before.contents) assert.deepEqual(after.contents.get(id), row);
  return { after, plan };
}
function retained(
  before: TextPieceSnapshot,
  after: TextPieceSnapshot,
  ids: readonly string[],
  changedLinks = new Set<string>(),
) {
  for (const id of ids) {
    assert.deepEqual(after.occurrences.get(id), before.occurrences.get(id), `occurrence ${id}`);
    if (!changedLinks.has(id))
      assert.deepEqual(after.links.get(id), before.links.get(id), `link ${id}`);
  }
}

test('growing contextual duplicates keep old identities on prefix growth and move the unmatched final x', () => {
  for (const count of [10, 100, 1000]) {
    const text = Array.from({ length: count }, (_, i) => `A${i},x,`).join('') + 'END';
    const limits = { maxContentBytes: 1 };
    const before = initialize(text, limits);
    const entries = sequence(before);
    const xs = entries.filter((row) => row.text === 'x');
    assert.equal(xs.length, count);
    const grown = update(before, 'x,' + text, { limits });
    retained(
      before,
      grown.after,
      entries.map((row) => row.id),
    );
    assert.ok(grown.plan.occurrenceWrites.length <= 2);
    assert.ok(grown.plan.linkWrites.length <= 2);
    const final = xs.at(-1)!;
    const expected = 'x' + text.slice(0, final.start) + text.slice(final.end);
    const moved = update(before, expected, { limits });
    assert.equal(moved.after.head.first, final.id, 'context selects final duplicate for reuse');
    assert.equal(moved.plan.contentWrites.length, 0, 'pure moves allocate no content');
    assert.equal(moved.plan.occurrenceWrites.length, 0);
    assert.equal(moved.plan.occurrenceDeletes.length, 0);
    assert.ok(moved.plan.linkWrites.length <= 3);
    retained(
      before,
      moved.after,
      entries.map((row) => row.id),
      new Set([final.id, entries.find((row) => row.end === final.start)!.id]),
    );
  }
});

test('distant replacements and shifted global boundaries retain every unrelated huge periodic middle anchor', () => {
  for (const repeats of [10_000, 100_000]) {
    const text = 'Fictional unique prefix|' + 'ab'.repeat(repeats) + '|Fictional unique suffix';
    const before = initialize(text);
    const middle = sequence(before).filter((row) => row.start > 100 && row.end < text.length - 100);
    assert.ok(middle.length > 2);
    const replaced = text.slice(0, 1) + 'Q' + text.slice(2, -2) + 'Z' + text.slice(-1);
    const shifted = text.slice(0, 1) + 'X' + text.slice(1, -2) + text.slice(-1);
    for (const next of [replaced, shifted]) {
      const result = update(before, next);
      retained(
        before,
        result.after,
        middle.map((row) => row.id),
      );
      assert.ok(
        result.plan.contentWrites.reduce((sum, row) => sum + Buffer.byteLength(row.text), 0) < 100,
        'two local changes must not publish the distant unchanged middle',
      );
      assert.ok(result.plan.occurrenceWrites.length <= 8);
      assert.ok(result.plan.linkWrites.length <= 12);
    }
  }
});

test('automatic block moves and reorders in both directions keep interior identities without new content', () => {
  const blocks = ['A', 'B', 'C', 'D'].map((label) => `[Fictional ${label}]` + label.repeat(12_000));
  const text = blocks.join('');
  const before = initialize(text);
  for (const order of [
    [2, 0, 1, 3],
    [1, 2, 3, 0],
    [3, 2, 1, 0],
  ]) {
    const result = update(before, order.map((index) => blocks[index]).join(''));
    assert.equal(result.plan.contentWrites.length, 0);
    const interiors = sequence(before).filter((row) => {
      const blockStart = blocks.findIndex(
        (_, index) =>
          row.start >= blocks.slice(0, index).join('').length &&
          row.end <= blocks.slice(0, index + 1).join('').length,
      );
      if (blockStart < 0) return false;
      const start = blocks.slice(0, blockStart).join('').length;
      return row.start > start + 100 && row.end < start + blocks[blockStart]!.length - 100;
    });
    assert.ok(interiors.length > 4);
    retained(
      before,
      result.after,
      interiors.map((row) => row.id),
    );
    assert.ok(result.plan.linkWrites.length <= 20);
  }
});

test('exact serialized punctuation, whitespace, Unicode scalars and literal JSON escape spellings survive tiny edits', () => {
  const text = ' {"same":1,"same":2,"e":"\\u03a9","lone":"\\ud800"}\r\n😀 e\u0301 é Ω\t';
  let before = initialize(text);
  for (const next of [
    ' \t' + text,
    text,
    text.slice(0, 12) + '🪴' + text.slice(12),
    text,
    text.replace('\\u03a9', '\\u03A9'),
    '',
    'Fictional 😀 \\uDC00',
  ]) {
    before = update(before, next).after;
  }
  const cap = TEXT_PIECE_LIMITS.maxContentBytes;
  const boundaryText = 'a'.repeat(cap - 1) + '😀' + 'Ω'.repeat(cap) + 'z'.repeat(cap);
  const boundary = initialize(boundaryText);
  for (const at of [cap - 1, cap + 1, cap + 1 + cap * 2]) {
    const result = update(boundary, boundaryText.slice(0, at) + '🪴' + boundaryText.slice(at));
    assert.ok(result.plan.contentWrites.every((row) => row.text === '🪴'));
    assert.ok(result.plan.occurrenceWrites.length <= 3);
  }
  for (const invalid of ['raw \ud800', 'raw \udc00'])
    assert.throws(() => reconcileTextPieces(boundary, invalid), TextPieceError);
});

function refuse(
  snapshot: TextPieceSnapshot,
  next: string,
  options: NonNullable<Parameters<typeof reconcileTextPieces>[2]> = {},
  code?: string,
) {
  const saved = input(snapshot);
  assert.throws(
    () => reconcileTextPieces(snapshot, next, options),
    (error) => error instanceof TextPieceError && (!code || error.code === code),
  );
  assert.equal(input(snapshot), saved);
}

test('missing, corrupt, foreign and stale retained anchors refuse without a replacement fallback', () => {
  const before = initialize('AxBxCxD😀', { maxContentBytes: 4 });
  const mutations: ((snapshot: TextPieceSnapshot) => void)[] = [
    (s) => (s.occurrences as Map<string, unknown>).delete(s.head.first!),
    (s) => (s.links as Map<string, unknown>).delete(s.head.first!),
    (s) => (s.contents as Map<string, unknown>).delete(s.occurrences.get(s.head.first!)!.contentId),
    (s) => {
      const id = s.head.first!;
      (s.links as Map<string, unknown>).set(id, { id, next: id });
    },
    (s) => {
      const id = s.head.first!;
      (s.occurrences as Map<string, unknown>).set(id, { ...s.occurrences.get(id), id: 'foreign' });
    },
    (s) => {
      const row = s.contents.values().next().value!;
      (s.contents as Map<string, unknown>).set(row.id, { ...row, text: 'corrupt' });
    },
    (s) => Object.assign(s, { head: { ...s.head, topologyDigest: '0'.repeat(64) } }),
    (s) => Object.assign(s, { head: { ...s.head, sequenceId: randomUUID() } }),
    (s) => {
      const row = s.links.values().next().value!;
      (s.links as Map<string, unknown>).set('orphan', { ...row, id: 'orphan' });
    },
  ];
  for (const mutate of mutations) {
    const corrupt = structuredClone(before);
    mutate(corrupt);
    refuse(corrupt, 'updated');
  }
  refuse(
    before,
    'updated',
    { expectedHead: { ...before.head, revision: before.head.revision + 1 } },
    'mismatch',
  );
  // A stale topology head must reject an identity swap even if bytes coincide.
  const duplicates = initialize('AxBxCxD', { maxContentBytes: 1 });
  const swapped = structuredClone(duplicates);
  const order = sequence(swapped).map((row) => row.id);
  [order[1], order[3]] = [order[3]!, order[1]!];
  for (let i = 0; i < order.length; i++) {
    const id = order[i]!;
    (swapped.links as Map<string, unknown>).set(id, { id, next: order[i + 1] ?? null });
  }
  exact(
    sequence(swapped)
      .map((row) => row.text)
      .join(''),
    'AxBxCxD',
  );
  refuse(swapped, 'AxBxCxD');
});

test('capped automatic matching and inherited host-work budgets refuse explicitly rather than copying a snapshot', () => {
  const before = initialize('Fictional bounded|' + 'ab'.repeat(10_000) + '|END');
  const next = 'X' + 'Fictional bounded|' + 'ab'.repeat(10_000) + '|END';
  for (const key of [
    'maxScanSteps',
    'maxHashBytes',
    'maxCopiedBytes',
    'maxReconstructionUtf16Units',
    'maxExistingContentReadBytes',
    'maxValidationUtf16Units',
    'maxPlanBytes',
  ] as const)
    refuse(before, next, { limits: { [key]: 0 } }, 'limit');
  for (const key of [
    'maxScanUtf16Units',
    'maxComparisonUtf16Units',
    'maxAlignmentSteps',
    'maxCopiedUtf16Units',
    'maxCopiedBytes',
  ] as const)
    refuse(before, next, { matchingLimits: { [key]: 0 } }, 'limit');
  refuse(initialize('ABC'), 'AXC', { matchingLimits: { maxTraceCells: 0 } }, 'limit');
  refuse(initialize('ABCDE'), 'CDEAB', { matchingLimits: { maxReuseCandidates: 0 } }, 'limit');
  for (const key of ['maxAnchorCandidates', 'maxHashUtf16Units'] as const)
    refuse(before, next, { matchingLimits: { [key]: 0 } }, 'limit');
  refuse(
    before,
    next,
    { matchingLimits: { maxAlignmentSteps: TEXT_PIECE_RECONCILE_LIMITS.maxAlignmentSteps + 1 } },
    'invalid',
  );
});

test('100/200/300 actual automatic reconciliations separate changed rows from all returned host-work counters', (t) => {
  const initialText = 'Fictional growing evidence|' + 'ab'.repeat(20_000) + '|end';
  const initial = createTextPiecePlan(initialText, { sequenceId: randomUUID() });
  let snapshot = apply(null, initial);
  let expected = initialText;
  const original = sequence(snapshot).map((row) => row.id);
  const totals: Record<string, number> = {};
  const changedTotals: Record<string, number> = {};
  const matchingTotals: Record<string, number> = {};
  const checkpoints: {
    updates: number;
    totals: Record<string, number>;
    changed: Record<string, number>;
    matching: Record<string, number>;
  }[] = [];
  const maxima: Record<string, number> = {};
  for (const plan of [initial])
    for (const [kind, rows] of [
      ['content', plan.contentWrites],
      ['occurrence', plan.occurrenceWrites],
      ['link', plan.linkWrites],
    ] as const)
      for (const row of rows)
        maxima[kind + 'SerializedRowBytes'] = Math.max(
          maxima[kind + 'SerializedRowBytes'] ?? 0,
          encoded(row),
        );
  for (let step = 1; step <= 300; step++) {
    expected = 'x' + expected;
    const result = update(snapshot, expected);
    retained(
      snapshot,
      result.after,
      sequence(snapshot).map((row) => row.id),
    );
    retained(apply(null, initial), result.after, original);
    snapshot = result.after;
    const independentlyCounted = writes(result.plan);
    for (const [kind, rows] of [
      ['content', result.plan.contentWrites],
      ['occurrence', result.plan.occurrenceWrites],
      ['link', result.plan.linkWrites],
    ] as const)
      for (const row of rows)
        maxima[kind + 'SerializedRowBytes'] = Math.max(
          maxima[kind + 'SerializedRowBytes'] ?? 0,
          encoded(row),
        );
    assert.ok(independentlyCounted.contentRowsWritten <= 1);
    assert.ok(independentlyCounted.occurrenceRowsWritten <= 1);
    assert.ok(independentlyCounted.linkRowsWritten <= 1);
    for (const [key, value] of Object.entries(independentlyCounted))
      changedTotals[key] = (changedTotals[key] ?? 0) + value;
    for (const [key, value] of Object.entries(result.plan.matchingMetrics)) {
      assert.ok(Number.isSafeInteger(value) && value >= 0, key);
      matchingTotals[key] = (matchingTotals[key] ?? 0) + value;
      maxima['matching.' + key] = Math.max(maxima['matching.' + key] ?? 0, value);
    }
    for (const [key, value] of Object.entries(result.plan.metrics)) {
      assert.ok(Number.isSafeInteger(value) && value >= 0, key);
      totals[key] = (totals[key] ?? 0) + value;
      maxima[key] = Math.max(maxima[key] ?? 0, value);
    }
    if (step % 100 === 0)
      checkpoints.push({
        updates: step,
        totals: { ...totals },
        changed: { ...changedTotals },
        matching: { ...matchingTotals },
      });
  }
  assert.equal(totals.contentRowsWritten, 1);
  assert.deepEqual(
    checkpoints.map((row) => row.totals.occurrenceRowsWritten),
    [100, 200, 300],
  );
  assert.ok(totals.existingContentReadBytes! > 300 * 10_000);
  assert.ok(totals.hashBytes! > 300 * initialText.length);
  assert.ok(totals.reconstructionUtf16Units! > 300 * initialText.length);
  const receipt = {
    scope: 'fictional automatic ASCII prefix growth; logical transient plans only',
    initial: { changed: writes(initial), metrics: initial.metrics },
    maxima,
    checkpoints,
  };
  t.diagnostic(JSON.stringify(receipt));
});

test('seeded scalar-safe snapshot mutations match independent strings without supplied edit intent', () => {
  let seed = 0x2252026;
  const random = (max: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % max;
  };
  let expected = 'Fictional ababab Ω 😀 \\ud800 e\u0301.';
  let snapshot = initialize(expected);
  for (let step = 0; step < 120; step++) {
    const points = [0];
    for (const scalar of expected) points.push(points.at(-1)! + scalar.length);
    const start = random(points.length);
    const end = start + random(points.length - start);
    const at = points[start]!;
    const until = points[end]!;
    if (step % 3 === 0 && until > at) {
      const selected = expected.slice(at, until);
      const rest = expected.slice(0, at) + expected.slice(until);
      expected = step % 2 ? rest + selected : selected + rest;
    } else {
      const inserts = ['x', '😀', '', '\t', '\\u03A9', 'e\u0301'];
      expected = expected.slice(0, at) + inserts[random(inserts.length)]! + expected.slice(until);
    }
    snapshot = update(snapshot, expected).after;
  }
});

test('ambiguous identical text reconciliation is deterministic for the same retained identities', () => {
  const before = initialize('xxxxxxxx', { maxContentBytes: 1 });
  for (const next of ['xxxxxxxxx', 'xxxxxxx', 'xxxxxxxx']) {
    const options = { limits: { maxContentBytes: 1 } };
    const left = reconcileTextPieces(before, next, options);
    const right = reconcileTextPieces(before, next, options);
    assert.deepEqual(left, right);
    exact(reconstructTextPieces(apply(before, left)).text, next);
  }
});

test('moves inside a single retained piece and empty snapshots stay exact and local', () => {
  const before = initialize('ABCDEFGHIJK');
  for (const expected of ['ABFGHICDEJK', 'CDEABFGHIJK', 'ABFGHIJKCDE']) {
    const result = update(before, expected);
    assert.equal(result.plan.contentWrites.length, 0);
    assert.ok(result.plan.occurrenceWrites.length <= 6);
  }
  const empty = initialize('');
  const noChange = update(empty, '');
  assert.equal(noChange.after.head.first, null);
  assert.equal(noChange.after.head.revision, empty.head.revision + 1);
  const inserted = update(empty, 'Fictional 🪴');
  const removed = update(inserted.after, '');
  assert.equal(removed.after.occurrences.size, 0);
  assert.equal(removed.after.links.size, 0);
});

test('literal ticket contextual duplicate move uses the final x and its separator', () => {
  const before = initialize('A,x,B,x,C,x,D', { maxContentBytes: 1 });
  const rows = sequence(before);
  const lastX = rows.filter((row) => row.text === 'x').at(-1)!;
  const result = update(before, 'x,A,x,B,x,C,D', { limits: { maxContentBytes: 1 } });
  assert.equal(result.after.head.first, lastX.id);
  assert.equal(result.plan.contentWrites.length, 0);
  assert.equal(result.plan.occurrenceWrites.length, 0);
  assert.equal(result.plan.occurrenceDeletes.length, 0);
  const boundaryIds = new Set([
    lastX.id,
    // Identical separators are ambiguous: either adjacent separator may move.
    // Permit the cut before the preceding separator as well as the cut after x.
    rows.find((row) => row.end === lastX.start - 1)!.id,
    rows.find((row) => row.end === lastX.start)!.id,
    rows.find((row) => row.start === lastX.end)!.id,
  ]);
  retained(
    before,
    result.after,
    rows.map((row) => row.id),
    boundaryIds,
  );
  assert.ok(result.plan.linkWrites.length <= 3);
});

test('same-size automatic replacements fit exact UTF16 and UTF8 text caps without avoidable intermediate growth', () => {
  update(initialize('abcdefghij'), 'abcxefghij', {
    limits: { maxTextUtf16Units: 10, maxTextBytes: 10 },
  });
  update(initialize('a😀bc'), 'a🪴bc', { limits: { maxTextUtf16Units: 5, maxTextBytes: 7 } });
  update(initialize('aΩbc'), 'a😀c', { limits: { maxTextUtf16Units: 4, maxTextBytes: 6 } });
  refuse(
    initialize('abcdefghij'),
    'abcdefghijX',
    { limits: { maxTextUtf16Units: 10, maxTextBytes: 10 } },
    'limit',
  );
});

test('a standalone duplicate cannot steal the identity of text embedded in an untouched retained piece', () => {
  const original = initialize('ABCxDEF');
  const intactId = original.head.first!;
  const prepared = planTextPieceEdits(original, {
    expectedHead: original.head,
    expectedText: 'xABCxDEFQ',
    edits: [
      { kind: 'splice', at: 0, deleteCount: 0, insert: 'x' },
      { kind: 'splice', at: 8, deleteCount: 0, insert: 'Q' },
    ],
  });
  const before = apply(original, prepared);
  const standalone = before.head.first!;
  assert.notEqual(standalone, intactId);
  const result = update(before, 'ABCxDEFZ');
  assert.deepEqual(
    result.after.occurrences.get(intactId),
    original.occurrences.get(intactId),
    'the full unchanged ABCxDEF slice retains its original occurrence',
  );
  assert.equal(result.after.head.first, intactId);
  assert.equal(
    result.after.occurrences.has(standalone),
    false,
    'the removed standalone x cannot supply an embedded unchanged x',
  );
});

test('large exact reorder beyond local alignment distance reuses content while unresolved novel text refuses', () => {
  const a = 'a'.repeat(400);
  const b = 'b'.repeat(400);
  const before = initialize(a + b);
  const moved = update(before, b + a);
  assert.equal(
    moved.plan.contentWrites.length,
    0,
    'exact move reuse succeeds beyond the bounded local alignment search',
  );
  const saved = input(before);
  assert.throws(
    () => reconcileTextPieces(before, b + a + 'c'),
    (error) =>
      error instanceof TextPieceError &&
      error.code === 'limit' &&
      /could not establish exact move reuse/.test(error.message),
  );
  assert.equal(
    input(before),
    saved,
    'novel unresolved text refuses without replacement publication',
  );
});

test('a partial earlier context window cannot displace an intact complete retained occurrence', () => {
  const full = '0123456789abcdefghijklmnopqrstuvwxyz';
  const original = initialize(full);
  const fullId = original.head.first!;
  const prepared = planTextPieceEdits(original, {
    expectedHead: original.head,
    expectedText: 'P' + full,
    edits: [{ kind: 'splice', at: 0, deleteCount: 0, insert: 'P' }],
  });
  const before = apply(original, prepared);
  const prefixId = before.head.first!;
  const result = update(before, 'P0123456789abcdeX' + full);
  assert.deepEqual(result.after.occurrences.get(fullId), original.occurrences.get(fullId));
  assert.deepEqual(result.after.occurrences.get(prefixId), before.occurrences.get(prefixId));
  assert.deepEqual(result.after.links.get(fullId), before.links.get(fullId));
});

test('context windows disjoint in old text cannot overlap an intact complete retained occurrence in next text', () => {
  const full = '0123456789abcdefghijklmnopqrstuvwxyz';
  const tail = 'P0123456789abcdeX';
  const original = initialize(full);
  const fullId = original.head.first!;
  const prepared = planTextPieceEdits(original, {
    expectedHead: original.head,
    expectedText: full + tail,
    edits: [{ kind: 'splice', at: full.length, deleteCount: 0, insert: tail }],
  });
  const before = apply(original, prepared);
  const result = update(before, 'P' + full + 'X');
  assert.deepEqual(result.after.occurrences.get(fullId), original.occurrences.get(fullId));
});

test('reversing distinct retained rows with shared letters keeps each complete occurrence identity', () => {
  const before = initialize('bcdbdexyz', { maxContentBytes: 3 });
  const oldRows = sequence(before);
  assert.deepEqual(
    oldRows.map((row) => row.text),
    ['bcd', 'bde', 'xyz'],
  );
  const result = update(before, 'xyzbdebcd', { limits: { maxContentBytes: 3 } });
  assert.deepEqual(
    sequence(result.after).map((row) => row.id),
    oldRows.map((row) => row.id).reverse(),
  );
  for (const row of oldRows)
    assert.deepEqual(result.after.occurrences.get(row.id), before.occurrences.get(row.id));
  assert.equal(result.plan.contentWrites.length, 0);
  assert.equal(result.plan.occurrenceWrites.length, 0);
  assert.equal(result.plan.occurrenceDeletes.length, 0);
  assert.ok(result.plan.linkWrites.length <= 3);
});
