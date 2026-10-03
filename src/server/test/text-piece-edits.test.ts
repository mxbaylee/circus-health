import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  createTextPiecePlan,
  planTextPieceEdits,
  reconstructTextPieces,
  TEXT_PIECE_LIMITS,
  TextPieceError,
} from '../text-piece-edits.ts';

// Deliberately independent of retained pieces, hashes and engine reconstruction.
// The caller supplies sequential intent, and this simple exact-string oracle
// applies it directly to the text before each individual operation.
type OracleEdit =
  | { op: 'splice'; offset: number; remove: number; text: string }
  | { op: 'move'; from: number; length: number; to: number };
function oracle(before: string, edits: readonly OracleEdit[]): string {
  let next = before;
  for (const edit of edits) {
    if (edit.op === 'splice') {
      next = next.slice(0, edit.offset) + edit.text + next.slice(edit.offset + edit.remove);
    } else {
      const moved = next.slice(edit.from, edit.from + edit.length);
      const rest = next.slice(0, edit.from) + next.slice(edit.from + edit.length);
      const destination = edit.to > edit.from ? edit.to - edit.length : edit.to;
      next = rest.slice(0, destination) + moved + rest.slice(destination);
    }
  }
  return next;
}
function exact(actual: string, expected: string) {
  assert.equal(actual, expected);
  assert.deepEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}

test('independent sequential move oracle distinguishes source and destination positions', () => {
  exact(oracle('ABCDEF', [{ op: 'move', from: 4, length: 2, to: 0 }]), 'EFABCD');
  exact(oracle('ABCDEF', [{ op: 'move', from: 0, length: 2, to: 6 }]), 'CDEFAB');
  exact(
    oracle('ABCDEF', [
      { op: 'splice', offset: 0, remove: 0, text: '😀' },
      { op: 'splice', offset: 6, remove: 1, text: 'Ω' },
    ]),
    '😀ABCDΩF',
  );
});

// Engine assertions below use an independent Map-based application harness:
// a plan is transient individually changed rows, never a new durable snapshot.

type Snapshot = Parameters<typeof planTextPieceEdits>[0];
type Plan = ReturnType<typeof createTextPiecePlan>;
function apply(before: Snapshot | null, plan: Plan): Snapshot {
  assert.deepEqual(plan.expectedHead, before?.head ?? null);
  assert.equal(plan.metrics.occurrenceRowsDeleted, plan.occurrenceDeletes.length);
  assert.equal(plan.metrics.linkRowsDeleted, plan.linkDeletes.length);
  assert.equal(
    plan.metrics.occurrenceBytesDeleted,
    plan.occurrenceDeletes.reduce((bytes, id) => bytes + Buffer.byteLength(JSON.stringify(id)), 0),
  );
  assert.equal(
    plan.metrics.linkBytesDeleted,
    plan.linkDeletes.reduce((bytes, id) => bytes + Buffer.byteLength(JSON.stringify(id)), 0),
  );
  const snapshot: Snapshot = {
    head: plan.head,
    contents: new Map(before?.contents),
    occurrences: new Map(before?.occurrences),
    links: new Map(before?.links),
  };
  for (const row of plan.contentWrites) {
    const prior = snapshot.contents.get(row.id);
    if (prior) assert.deepEqual(row, prior, 'content hashes never allow an immutable rewrite');
    (snapshot.contents as Map<string, typeof row>).set(row.id, row);
  }
  for (const id of plan.occurrenceDeletes)
    (snapshot.occurrences as Map<string, unknown>).delete(id);
  for (const id of plan.linkDeletes) (snapshot.links as Map<string, unknown>).delete(id);
  for (const row of plan.occurrenceWrites)
    (snapshot.occurrences as Map<string, typeof row>).set(row.id, row);
  for (const row of plan.linkWrites) (snapshot.links as Map<string, typeof row>).set(row.id, row);
  return snapshot;
}
function sequence(snapshot: Snapshot) {
  const result: { id: string; start: number; end: number; text: string }[] = [];
  let id = snapshot.head.first;
  let start = 0;
  const seen = new Set<string>();
  while (id !== null) {
    assert.equal(seen.has(id), false);
    seen.add(id);
    const occurrence = snapshot.occurrences.get(id)!;
    const content = snapshot.contents.get(occurrence.contentId)!;
    const text = content.text.slice(occurrence.start, occurrence.end);
    result.push({ id, start, end: start + text.length, text });
    start += text.length;
    id = snapshot.links.get(id)!.next;
  }
  return result;
}
function serializedInput(snapshot: Snapshot) {
  return JSON.stringify({
    head: snapshot.head,
    contents: [...snapshot.contents],
    occurrences: [...snapshot.occurrences],
    links: [...snapshot.links],
  });
}
function unchanged(before: Snapshot, after: Snapshot, plan: Plan) {
  const occurrencesChanged = new Set([
    ...plan.occurrenceDeletes,
    ...plan.occurrenceWrites.map((row) => row.id),
  ]);
  const linksChanged = new Set([...plan.linkDeletes, ...plan.linkWrites.map((row) => row.id)]);
  for (const [id, row] of before.contents)
    assert.deepEqual(after.contents.get(id), row, 'all retained content stays byte-identical');
  for (const [id, row] of before.occurrences)
    if (!occurrencesChanged.has(id))
      assert.equal(JSON.stringify(after.occurrences.get(id)), JSON.stringify(row));
  for (const [id, row] of before.links)
    if (!linksChanged.has(id))
      assert.equal(JSON.stringify(after.links.get(id)), JSON.stringify(row));
}
function initialize(
  text: string,
  limits: NonNullable<Parameters<typeof createTextPiecePlan>[1]>['limits'] = {},
): Snapshot {
  const initial = createTextPiecePlan(text, { sequenceId: randomUUID(), limits });
  const result = apply(null, initial);
  exact(reconstructTextPieces(result).text, text);
  return result;
}
function edit(
  before: Snapshot,
  edits: readonly OracleEdit[],
  limits: NonNullable<Parameters<typeof createTextPiecePlan>[1]>['limits'] = {},
) {
  const oldText = sequence(before)
    .map((row) => row.text)
    .join('');
  const expectedText = oracle(oldText, edits);
  const inputBefore = serializedInput(before);
  const translated = edits.map((operation) =>
    operation.op === 'splice'
      ? {
          kind: 'splice' as const,
          at: operation.offset,
          deleteCount: operation.remove,
          insert: operation.text,
        }
      : { kind: 'move' as const, from: operation.from, length: operation.length, to: operation.to },
  );
  const request = { expectedHead: before.head, expectedText, edits: translated, limits };
  const requestBefore = JSON.stringify(request);
  const plan = planTextPieceEdits(before, request);
  assert.equal(serializedInput(before), inputBefore, 'plan does not mutate retained inputs');
  assert.equal(JSON.stringify(request), requestBefore, 'plan does not mutate supplied intent');
  const after = apply(before, plan);
  unchanged(before, after, plan);
  exact(reconstructTextPieces(after).text, expectedText);
  exact(
    sequence(after)
      .map((row) => row.text)
      .join(''),
    expectedText,
  );
  return { after, plan, expectedText };
}

test('tiny prefix and middle insertion/deletion retain exact punctuation, whitespace and escaped raw spelling', () => {
  let snapshot = initialize(
    ' { "first":"\\u03a9", "same":1,"same":2, "lone":"\\ud800", "nested": {"z":0,"a":1} }\n',
  );
  for (const edits of [
    [{ op: 'splice', offset: 0, remove: 0, text: ' \t' }],
    [{ op: 'splice', offset: 24, remove: 0, text: 'Fictional Ω 😀' }],
    [{ op: 'splice', offset: 0, remove: 2, text: '' }],
    [{ op: 'splice', offset: 24, remove: 14, text: '' }],
  ] satisfies OracleEdit[][])
    snapshot = edit(snapshot, edits).after;
});

test('distant sequential edits preserve byte-identical periodic middle across shifted fresh chunk boundaries', () => {
  const text = 'Fictional unique prefix|' + 'ab'.repeat(100_000) + '|Fictional unique suffix';
  const before = initialize(text);
  const edits: OracleEdit[] = [
    { op: 'splice', offset: 1, remove: 1, text: 'Q' },
    { op: 'splice', offset: text.length - 2, remove: 1, text: 'Z' },
  ];
  const result = edit(before, edits);
  assert.ok(
    result.plan.contentWrites.reduce((bytes, row) => bytes + Buffer.byteLength(row.text), 0) < 100,
    'distant edits write only supplied insertions',
  );
  const interior = sequence(before).filter((row) => row.start > 100 && row.end < text.length - 100);
  assert.ok(interior.length > 3);
  for (const row of interior) {
    assert.deepEqual(result.after.occurrences.get(row.id), before.occurrences.get(row.id));
    assert.deepEqual(result.after.links.get(row.id), before.links.get(row.id));
  }
  const shifted = edit(before, [
    { op: 'splice', offset: 1, remove: 0, text: 'X' },
    { op: 'splice', offset: text.length - 1, remove: 1, text: '' },
  ]);
  for (const row of interior) {
    assert.deepEqual(shifted.after.occurrences.get(row.id), before.occurrences.get(row.id));
    assert.deepEqual(shifted.after.links.get(row.id), before.links.get(row.id));
  }
});

test('moves in both directions reuse moved interior occurrences, content and links', () => {
  const text = 'Fictional start|' + '0123456789'.repeat(30_000) + '|Fictional end';
  for (const move of [
    { op: 'move', from: 20_000, length: 140_000, to: 0 },
    { op: 'move', from: 20_000, length: 140_000, to: text.length },
  ] satisfies OracleEdit[]) {
    const before = initialize(text);
    const result = edit(before, [move]);
    assert.equal(result.plan.contentWrites.length, 0, 'a pure move never copies unchanged values');
    const movedInterior = sequence(before).filter(
      (row) => row.start > move.from && row.end < move.from + move.length,
    );
    assert.ok(movedInterior.length > 3);
    for (const row of movedInterior) {
      assert.deepEqual(result.after.occurrences.get(row.id), before.occurrences.get(row.id));
      assert.deepEqual(result.after.links.get(row.id), before.links.get(row.id));
    }
    assert.ok(result.plan.linkWrites.length <= 8, 'only move boundary links may change');
    assert.ok(
      result.plan.occurrenceWrites.length <= 4,
      'only split boundary occurrences may change',
    );
  }
});

function bounded(snapshot: Snapshot) {
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.head)) <= TEXT_PIECE_LIMITS.maxHeadBytes);
  for (const row of snapshot.contents.values()) {
    assert.ok(Buffer.byteLength(row.text) <= TEXT_PIECE_LIMITS.maxContentBytes);
    assert.ok(Buffer.byteLength(JSON.stringify(row)) <= TEXT_PIECE_LIMITS.maxRowBytes);
  }
  for (const rows of [snapshot.occurrences, snapshot.links])
    for (const row of rows.values())
      assert.ok(Buffer.byteLength(JSON.stringify(row)) <= TEXT_PIECE_LIMITS.maxRowBytes);
}

test('maximum UTF8 piece boundaries split slices without copying retained content or unsafe scalar boundaries', () => {
  const cap = TEXT_PIECE_LIMITS.maxContentBytes;
  const text = 'a'.repeat(cap - 1) + '😀' + 'Ω'.repeat(cap) + 'z'.repeat(cap);
  const before = initialize(text);
  bounded(before);
  const positions = [cap - 1, cap + 1, cap + 1 + cap * 2];
  for (const at of positions) {
    const result = edit(before, [{ op: 'splice', offset: at, remove: 0, text: '🪴' }]);
    bounded(result.after);
    assert.ok(
      result.plan.contentWrites.every((row) => row.text === '🪴'),
      'only inserted scalar becomes new immutable content',
    );
    assert.ok(
      result.plan.occurrenceWrites.filter((row) => before.contents.has(row.contentId)).length <= 2,
    );
  }
});

test('growing duplicate occurrence adversaries preserve contextual anchors for prepends and final-to-prefix moves', () => {
  for (const count of [10, 100, 1000]) {
    const text = Array.from({ length: count }, (_, index) => `A${index},x,`).join('') + 'END';
    const limits = { maxContentBytes: 1 };
    const before = initialize(text, limits);
    const entries = sequence(before);
    const duplicates = entries.filter((row) => row.text === 'x');
    assert.equal(duplicates.length, count);
    assert.equal(new Set(duplicates.map((row) => row.id)).size, count);
    assert.equal(
      new Set(duplicates.map((row) => before.occurrences.get(row.id)!.contentId)).size,
      1,
      'equal bytes share content but never occurrence identity',
    );
    const prepended = edit(before, [{ op: 'splice', offset: 0, remove: 0, text: 'x,' }], limits);
    assert.ok(prepended.plan.occurrenceWrites.length <= 2);
    assert.ok(prepended.plan.linkWrites.length <= 2);
    for (const row of entries) {
      assert.deepEqual(prepended.after.occurrences.get(row.id), before.occurrences.get(row.id));
      assert.deepEqual(prepended.after.links.get(row.id), before.links.get(row.id));
    }
    const final = duplicates.at(-1)!;
    const moved = edit(before, [{ op: 'move', from: final.start, length: 1, to: 0 }], limits);
    assert.equal(moved.plan.contentWrites.length, 0);
    assert.equal(
      moved.after.head.first,
      final.id,
      'explicit intent moves the final duplicate identity',
    );
    assert.ok(moved.plan.linkWrites.length <= 3);
    for (const row of entries) {
      assert.deepEqual(moved.after.occurrences.get(row.id), before.occurrences.get(row.id));
      if (row.id !== final.id && row.end !== final.start)
        assert.deepEqual(moved.after.links.get(row.id), before.links.get(row.id));
    }
    bounded(moved.after);
  }
});

test('nonBMP, combining marks and literal alternate escapes preserve exact UTF16/UTF8 spelling', () => {
  const text = 'Fictional 😀 e\u0301 é Ω \\u03a9 \\u03A9 \\ud800 \\uDC00 \\n \t';
  const before = initialize(text);
  const moved = edit(before, [
    { op: 'move', from: text.indexOf('😀'), length: 2, to: text.length },
  ]);
  assert.equal(moved.plan.contentWrites.length, 0);
  edit(moved.after, [{ op: 'splice', offset: 0, remove: 0, text: '\r\n🪴' }]);
  assert.throws(() => initialize('Fictional raw \ud800 lone high surrogate'), TextPieceError);
  assert.throws(() => initialize('Fictional raw \udc00 lone low surrogate'), TextPieceError);
});

function refuse(
  snapshot: Snapshot,
  request: Parameters<typeof planTextPieceEdits>[1],
  code?: 'invalid' | 'limit' | 'mismatch',
) {
  const before = serializedInput(snapshot);
  const input = JSON.stringify(request);
  assert.throws(
    () => planTextPieceEdits(snapshot, request),
    (error) => error instanceof TextPieceError && (!code || error.code === code),
  );
  assert.equal(serializedInput(snapshot), before);
  assert.equal(JSON.stringify(request), input);
}

test('expected head/result, malformed edit identities and unsafe scalar boundaries fail explicitly without mutation', () => {
  const snapshot = initialize('A😀BΩC');
  const request = { expectedHead: snapshot.head, expectedText: 'A😀BΩC', edits: [] };
  refuse(
    snapshot,
    { ...request, expectedHead: { ...snapshot.head, revision: snapshot.head.revision + 1 } },
    'mismatch',
  );
  refuse(snapshot, { ...request, expectedText: 'A😀BΩD' }, 'mismatch');
  const invalidEdits = [
    { kind: 'splice', at: 2, deleteCount: 0, insert: 'x' },
    { kind: 'splice', at: 1, deleteCount: 1, insert: '' },
    { kind: 'splice', at: 0, deleteCount: 0, insert: '\ud800' },
    { kind: 'splice', at: -1, deleteCount: 0, insert: 'x' },
    { kind: 'splice', at: 99, deleteCount: 0, insert: '' },
    { kind: 'splice', at: 0.5, deleteCount: 0, insert: '' },
    { kind: 'splice', at: 0, deleteCount: -1, insert: '' },
    { kind: 'move', from: 1, length: 1, to: 0 },
    { kind: 'move', from: 0, length: 3, to: 2 },
    { kind: 'move', from: 0, length: 1, to: 2 },
    { kind: 'move', from: 0, length: 99, to: 0 },
    { kind: 'unknown', at: 0 },
  ];
  for (const invalid of invalidEdits)
    refuse(snapshot, { ...request, edits: [invalid] } as Parameters<typeof planTextPieceEdits>[1]);
});

test('cycles, dangling rows, identity/hash corruption and orphan active anchors fail explicitly', () => {
  const initial = initialize('Fictional 😀 retained validation text'.repeat(500));
  const corruptions: [string, (snapshot: Snapshot) => void][] = [
    [
      'dangling link',
      (snapshot) => {
        const first = snapshot.head.first!;
        const row = snapshot.links.get(first)!;
        (snapshot.links as Map<string, typeof row>).set(first, {
          ...row,
          next: 'foreign-identity',
        });
      },
    ],
    [
      'cycle',
      (snapshot) => {
        const first = snapshot.head.first!;
        const row = snapshot.links.get(first)!;
        (snapshot.links as Map<string, typeof row>).set(first, { ...row, next: first });
      },
    ],
    [
      'missing occurrence',
      (snapshot) => {
        (snapshot.occurrences as Map<string, unknown>).delete(snapshot.head.first!);
      },
    ],
    [
      'missing content',
      (snapshot) => {
        const occurrence = snapshot.occurrences.get(snapshot.head.first!)!;
        (snapshot.contents as Map<string, unknown>).delete(occurrence.contentId);
      },
    ],
    [
      'wrong occurrence identity',
      (snapshot) => {
        const first = snapshot.head.first!;
        const row = snapshot.occurrences.get(first)!;
        (snapshot.occurrences as Map<string, typeof row>).set(first, {
          ...row,
          id: 'foreign-identity',
        });
      },
    ],
    [
      'unsafe retained scalar slice',
      (snapshot) => {
        const first = snapshot.head.first!;
        const row = snapshot.occurrences.get(first)!;
        (snapshot.occurrences as Map<string, typeof row>).set(first, { ...row, start: 11 });
      },
    ],
    [
      'out-of-range retained slice',
      (snapshot) => {
        const first = snapshot.head.first!;
        const row = snapshot.occurrences.get(first)!;
        (snapshot.occurrences as Map<string, typeof row>).set(first, { ...row, end: row.end + 1 });
      },
    ],
    [
      'wrong content hash',
      (snapshot) => {
        const row = snapshot.contents.values().next().value!;
        (snapshot.contents as Map<string, typeof row>).set(row.id, {
          ...row,
          text: row.text + 'corrupt',
        });
      },
    ],
    [
      'orphan link',
      (snapshot) => {
        const row = snapshot.links.values().next().value!;
        (snapshot.links as Map<string, typeof row>).set('orphan', { ...row, id: 'orphan' });
      },
    ],
    [
      'wrong selected count',
      (snapshot) => {
        Object.assign(snapshot, { head: { ...snapshot.head, pieces: snapshot.head.pieces + 1 } });
      },
    ],
  ];
  for (const [label, corrupt] of corruptions) {
    const snapshot: Snapshot = structuredClone(initial);
    corrupt(snapshot);
    const before = serializedInput(snapshot);
    assert.throws(() => reconstructTextPieces(snapshot), TextPieceError, label);
    refuse(snapshot, {
      expectedHead: snapshot.head,
      expectedText: 'irrelevant expected result',
      edits: [],
    });
    assert.equal(serializedInput(snapshot), before);
  }
  assert.throws(
    () => createTextPiecePlan('Fictional text', { sequenceId: 'invalid-sequence-id' }),
    TextPieceError,
  );
});

test('declared row, operation, reconstruction and host-work budgets refuse rather than falling back', () => {
  const snapshot = initialize('Fictional bounded text '.repeat(1000));
  const request = {
    expectedHead: snapshot.head,
    expectedText: sequence(snapshot)
      .map((row) => row.text)
      .join(''),
    edits: [],
  };
  const keys = [
    'maxPieces',
    'maxRetainedContentRows',
    'maxRetainedContentBytes',
    'maxScanSteps',
    'maxValidationUtf16Units',
    'maxReconstructionUtf16Units',
    'maxHashBytes',
    'maxCopiedUtf16Units',
    'maxCopiedBytes',
    'maxExistingContentReadBytes',
    'maxTextUtf16Units',
    'maxTextBytes',
  ] as const;
  for (const key of keys) refuse(snapshot, { ...request, limits: { [key]: 0 } }, 'limit');
  refuse(
    snapshot,
    {
      ...request,
      limits: { maxOperations: 0 },
      edits: [{ kind: 'splice', at: 0, deleteCount: 0, insert: 'X' }],
    },
    'limit',
  );
  refuse(
    snapshot,
    {
      ...request,
      limits: { maxPlanBytes: 0 },
      edits: [{ kind: 'splice', at: 0, deleteCount: 0, insert: 'X' }],
      expectedText: 'X' + request.expectedText,
    },
    'limit',
  );
  assert.throws(
    () => createTextPiecePlan('😀', { sequenceId: randomUUID(), limits: { maxContentBytes: 3 } }),
    TextPieceError,
  );
  assert.throws(
    () => createTextPiecePlan('a', { sequenceId: randomUUID(), limits: { maxRowBytes: 1 } }),
    TextPieceError,
  );
  assert.throws(
    () => createTextPiecePlan('', { sequenceId: randomUUID(), limits: { maxHeadBytes: 1 } }),
    TextPieceError,
  );
});

test('100/200/300 actual explicit updates disclose cumulative changed writes and linear host work separately', (t) => {
  const initialText = 'Fictional growing evidence|' + 'ab'.repeat(20_000) + '|end';
  const initial = createTextPiecePlan(initialText, { sequenceId: randomUUID() });
  let snapshot = apply(null, initial);
  exact(reconstructTextPieces(snapshot).text, initialText);
  const totals = {
    contentRows: 0,
    contentBytes: 0,
    occurrenceRows: 0,
    occurrenceBytes: 0,
    linkRows: 0,
    linkBytes: 0,
    headBytes: 0,
    existingContentReads: 0,
    existingContentReadBytes: 0,
    scanSteps: 0,
    validationUtf16Units: 0,
    reconstructionUtf16Units: 0,
    hashBytes: 0,
    copiedBytes: 0,
    comparisonUtf16Units: 0,
  };
  const measurements: { updates: number; totals: typeof totals }[] = [];
  const maxima = {
    contentRowsPerStep: 0,
    contentBytesPerStep: 0,
    occurrenceRowsPerStep: 0,
    occurrenceBytesPerStep: 0,
    linkRowsPerStep: 0,
    linkBytesPerStep: 0,
    contentRowBytes: 0,
    occurrenceRowBytes: 0,
    linkRowBytes: 0,
    headBytes: 0,
  };
  for (const row of initial.contentWrites)
    maxima.contentRowBytes = Math.max(
      maxima.contentRowBytes,
      Buffer.byteLength(JSON.stringify(row)),
    );
  for (let update = 1; update <= 300; update++) {
    const result = edit(snapshot, [{ op: 'splice', offset: 0, remove: 0, text: 'x' }]);
    snapshot = result.after;
    bounded(snapshot);
    const metric = result.plan.metrics;
    assert.equal(metric.contentRowsWritten, result.plan.contentWrites.length);
    assert.equal(metric.occurrenceRowsWritten, result.plan.occurrenceWrites.length);
    assert.equal(metric.linkRowsWritten, result.plan.linkWrites.length);
    assert.equal(
      metric.contentBytesWritten,
      result.plan.contentWrites.reduce(
        (bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row)),
        0,
      ),
    );
    assert.equal(
      metric.occurrenceBytesWritten,
      result.plan.occurrenceWrites.reduce(
        (bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row)),
        0,
      ),
    );
    assert.equal(
      metric.linkBytesWritten,
      result.plan.linkWrites.reduce(
        (bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row)),
        0,
      ),
    );
    assert.equal(metric.headBytesWritten, Buffer.byteLength(JSON.stringify(result.plan.head)));
    maxima.contentRowsPerStep = Math.max(maxima.contentRowsPerStep, metric.contentRowsWritten);
    maxima.contentBytesPerStep = Math.max(maxima.contentBytesPerStep, metric.contentBytesWritten);
    maxima.occurrenceRowsPerStep = Math.max(
      maxima.occurrenceRowsPerStep,
      metric.occurrenceRowsWritten,
    );
    maxima.occurrenceBytesPerStep = Math.max(
      maxima.occurrenceBytesPerStep,
      metric.occurrenceBytesWritten,
    );
    maxima.linkRowsPerStep = Math.max(maxima.linkRowsPerStep, metric.linkRowsWritten);
    maxima.linkBytesPerStep = Math.max(maxima.linkBytesPerStep, metric.linkBytesWritten);
    maxima.headBytes = Math.max(
      maxima.headBytes,
      Buffer.byteLength(JSON.stringify(result.plan.head)),
    );
    for (const row of result.plan.contentWrites)
      maxima.contentRowBytes = Math.max(
        maxima.contentRowBytes,
        Buffer.byteLength(JSON.stringify(row)),
      );
    for (const row of result.plan.occurrenceWrites)
      maxima.occurrenceRowBytes = Math.max(
        maxima.occurrenceRowBytes,
        Buffer.byteLength(JSON.stringify(row)),
      );
    for (const row of result.plan.linkWrites)
      maxima.linkRowBytes = Math.max(maxima.linkRowBytes, Buffer.byteLength(JSON.stringify(row)));
    totals.contentRows += metric.contentRowsWritten;
    totals.contentBytes += metric.contentBytesWritten;
    totals.occurrenceRows += metric.occurrenceRowsWritten;
    totals.occurrenceBytes += metric.occurrenceBytesWritten;
    totals.linkRows += metric.linkRowsWritten;
    totals.linkBytes += metric.linkBytesWritten;
    totals.headBytes += metric.headBytesWritten;
    totals.existingContentReads += metric.existingContentReads;
    totals.existingContentReadBytes += metric.existingContentReadBytes;
    totals.scanSteps += metric.scanSteps;
    totals.validationUtf16Units += metric.validationUtf16Units;
    totals.reconstructionUtf16Units += metric.reconstructionUtf16Units;
    totals.hashBytes += metric.hashBytes;
    totals.copiedBytes += metric.copiedBytes;
    totals.comparisonUtf16Units += metric.comparisonUtf16Units;
    assert.ok(result.plan.contentWrites.length <= 1);
    assert.ok(result.plan.occurrenceWrites.length <= 1);
    assert.ok(result.plan.linkWrites.length <= 1);
    if (update % 100 === 0) measurements.push({ updates: update, totals: { ...totals } });
  }
  assert.deepEqual(
    measurements.map((row) => row.totals.occurrenceRows),
    [100, 200, 300],
  );
  assert.deepEqual(
    measurements.map((row) => row.totals.linkRows),
    [100, 200, 300],
  );
  assert.equal(totals.contentRows, 1, 'equal inserted bytes reuse one immutable content row');
  const initialUniqueContentBytes = initial.contentWrites.reduce(
    (bytes, row) => bytes + Buffer.byteLength(row.text),
    0,
  );
  assert.ok(
    totals.existingContentReadBytes >= initialUniqueContentBytes * 300,
    'retained unique-content rereads remain separately visible',
  );
  assert.ok(totals.hashBytes > 40_000 * 300);
  assert.ok(totals.reconstructionUtf16Units > 40_000 * 300);
  assert.ok(totals.comparisonUtf16Units > 40_000 * 300);
  t.diagnostic(
    JSON.stringify({
      scope: 'explicit ASCII prefix edits; no automatic reconciliation or storage',
      initial: initial.metrics,
      maxima,
      measurements,
    }),
  );
});

test('equal-content occurrence swaps cannot pass a selected old topology head even when exact text is unchanged', () => {
  const snapshot = initialize('AxBxCxD', { maxContentBytes: 1 });
  const before = sequence(snapshot);
  const reordered = [...before];
  [reordered[1], reordered[3]] = [reordered[3]!, reordered[1]!];
  const tampered: Snapshot = structuredClone(snapshot);
  for (let index = 0; index < reordered.length; index++) {
    const id = reordered[index]!.id;
    const link = tampered.links.get(id)!;
    (tampered.links as Map<string, typeof link>).set(id, {
      ...link,
      next: reordered[index + 1]?.id ?? null,
    });
  }
  exact(
    sequence(tampered)
      .map((row) => row.text)
      .join(''),
    'AxBxCxD',
  );
  assert.throws(
    () => reconstructTextPieces(tampered, { limits: { maxContentBytes: 1 } }),
    TextPieceError,
  );
  refuse(tampered, {
    expectedHead: snapshot.head,
    expectedText: 'AxBxCxD',
    edits: [],
    limits: { maxContentBytes: 1 },
  });
});

test('empty/full deletion, reinsertion and moves sharing one original piece remain exact and local', () => {
  const before = initialize('ABCDEFGHIJK');
  const moved = edit(before, [{ op: 'move', from: 2, length: 3, to: 9 }]);
  assert.equal(moved.plan.contentWrites.length, 0);
  assert.ok(moved.plan.occurrenceWrites.length <= 4);
  const empty = edit(moved.after, [{ op: 'splice', offset: 0, remove: 11, text: '' }]);
  assert.equal(empty.after.head.first, null);
  assert.equal(empty.after.occurrences.size, 0);
  assert.equal(empty.after.links.size, 0);
  const inserted = edit(empty.after, [
    { op: 'splice', offset: 0, remove: 0, text: 'Fictional 🪴 text' },
  ]);
  bounded(inserted.after);
  edit(initialize(''), []);
});

test('seeded sequential scalar-safe mixed edits match independent exact strings and UTF8 buffers', () => {
  let seed = 0x224_2026;
  const random = (max: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % max;
  };
  const boundaries = (text: string) => {
    const result = [0];
    let offset = 0;
    for (const scalar of text) {
      offset += scalar.length;
      result.push(offset);
    }
    return result;
  };
  let snapshot = initialize('Fictional ababab Ω 😀 literal \\ud800 and e\u0301.');
  for (let iteration = 0; iteration < 150; iteration++) {
    const text = sequence(snapshot)
      .map((row) => row.text)
      .join('');
    const points = boundaries(text);
    const start = random(points.length);
    const end = start + random(points.length - start);
    let operation: OracleEdit;
    if (iteration % 3 === 0 && start !== end) {
      const destinations = points.filter(
        (point) => point <= points[start]! || point >= points[end]!,
      );
      operation = {
        op: 'move',
        from: points[start]!,
        length: points[end]! - points[start]!,
        to: destinations[random(destinations.length)]!,
      };
    } else {
      const insertions = ['x', '😀', 'Ω', '', '\\u03A9', '\t', 'e\u0301'];
      operation = {
        op: 'splice',
        offset: points[start]!,
        remove: points[end]! - points[start]!,
        text: insertions[random(insertions.length)]!,
      };
    }
    snapshot = edit(snapshot, [operation]).after;
    bounded(snapshot);
  }
});

test('sequential intermediate text byte and retained-content caps cannot be bypassed by a later deletion', () => {
  const snapshot = initialize('abc');
  const edits = [
    { kind: 'splice' as const, at: 3, deleteCount: 0, insert: 'WXYZ' },
    { kind: 'splice' as const, at: 3, deleteCount: 4, insert: '' },
  ];
  refuse(
    snapshot,
    { expectedHead: snapshot.head, expectedText: 'abc', edits, limits: { maxTextBytes: 4 } },
    'limit',
  );
  // UTF16 fits but the first non-BMP insertion still exceeds the byte cap.
  refuse(
    snapshot,
    {
      expectedHead: snapshot.head,
      expectedText: 'abc',
      edits: [
        { kind: 'splice', at: 3, deleteCount: 0, insert: '😀' },
        { kind: 'splice', at: 3, deleteCount: 2, insert: '' },
      ],
      limits: { maxTextBytes: 6 },
    },
    'limit',
  );
  const before = serializedInput(snapshot);
  assert.throws(
    () =>
      planTextPieceEdits(snapshot, {
        expectedHead: snapshot.head,
        expectedText: 'abcx',
        edits: [{ kind: 'splice', at: 3, deleteCount: 0, insert: 'x' }],
        limits: { maxRetainedContentBytes: 3, maxPlanBytes: 0 },
      }),
    (error) =>
      error instanceof TextPieceError &&
      error.code === 'limit' &&
      /retained content bytes/.test(error.message),
  );
  assert.equal(
    serializedInput(snapshot),
    before,
    'retained-content capacity is refused before a candidate row or plan can escape',
  );
  refuse(
    snapshot,
    {
      expectedHead: snapshot.head,
      expectedText: 'abc',
      edits,
      limits: { maxRetainedContentBytes: 6 },
    },
    'limit',
  );
});

test('valid no-op edits consume operation budget without changed rows, while deletion bytes count individual keys', () => {
  const snapshot = initialize('ABCDEF');
  const noops = [
    { op: 'splice' as const, offset: 2, remove: 0, text: '' },
    { op: 'move' as const, from: 0, length: 0, to: 6 },
    { op: 'move' as const, from: 1, length: 2, to: 1 },
    { op: 'move' as const, from: 1, length: 2, to: 3 },
  ];
  const result = edit(snapshot, noops);
  assert.equal(result.plan.metrics.operations, 4);
  assert.deepEqual(result.plan.contentWrites, []);
  assert.deepEqual(result.plan.occurrenceWrites, []);
  assert.deepEqual(result.plan.linkWrites, []);
  assert.deepEqual(result.plan.occurrenceDeletes, []);
  assert.deepEqual(result.plan.linkDeletes, []);
  const removed = edit(snapshot, [{ op: 'splice', offset: 0, remove: 6, text: '' }]);
  assert.equal(removed.plan.occurrenceDeletes.length, 1);
  assert.equal(
    removed.plan.metrics.occurrenceBytesDeleted,
    Buffer.byteLength(JSON.stringify(snapshot.head.first)),
  );
  assert.equal(
    removed.plan.metrics.linkBytesDeleted,
    Buffer.byteLength(JSON.stringify(snapshot.head.first)),
  );
  refuse(
    snapshot,
    {
      expectedHead: snapshot.head,
      expectedText: 'ABCDEF',
      edits: [{ kind: 'splice', at: 0, deleteCount: 0, insert: '' }],
      limits: { maxOperations: 0 },
    },
    'limit',
  );
});

test('sparse, accessor, iterator and subclass edit arrays refuse without invoking caller code', () => {
  const snapshot = initialize('Fictional dense edit inventory');
  const noop = { kind: 'splice' as const, at: 0, deleteCount: 0, insert: '' };
  const expectedText = sequence(snapshot)
    .map((row) => row.text)
    .join('');
  let invoked = 0;
  const sparse = new Array(1) as (typeof noop)[];
  const accessor = [noop];
  Object.defineProperty(accessor, '0', {
    get() {
      invoked++;
      throw Error('caller getter must never run');
    },
    configurable: true,
  });
  const customIterator = [noop];
  Object.defineProperty(customIterator, Symbol.iterator, {
    value() {
      invoked++;
      throw Error('caller iterator must never run');
    },
  });
  class Subclass extends Array<typeof noop> {
    override [Symbol.iterator](): ArrayIterator<typeof noop> {
      invoked++;
      throw Error('caller subclass iterator must never run');
    }
  }
  const subclass = new Subclass(noop);
  const extraProperty = [noop];
  Object.defineProperty(extraProperty, 'extra', { value: true });
  const before = serializedInput(snapshot);
  for (const edits of [sparse, accessor, customIterator, subclass, extraProperty]) {
    // Do not serialize adversarial inputs: JSON.stringify itself invokes an
    // accessor. The engine must inspect descriptors before touching an index.
    assert.throws(
      () => planTextPieceEdits(snapshot, { expectedHead: snapshot.head, expectedText, edits }),
      (error) => error instanceof TextPieceError && error.code === 'invalid',
    );
    assert.equal(invoked, 0);
    assert.equal(serializedInput(snapshot), before);
  }
});
