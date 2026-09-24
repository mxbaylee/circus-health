import test from 'node:test';
import assert from 'node:assert/strict';
import { readJSONStructure } from '../intake-json.ts';
import {
  conversionCheckpoint,
  recordConversionRead,
  conversionReadingState,
} from '../intake-continuation.ts';
import type { IntakeWithWorkflow } from '../intake-continuation.ts';
import type { IntakeExtractionUnit } from '../../shared/intake.ts';

const tool = 'health_intake_package';
const args = { id: 'fictional-package', action: 'read_member', memberId: 'fictional-member' };
const intake: IntakeWithWorkflow = {
  id: args.id,
  providerId: 'fictional-provider',
  provider: 'Fictional provider',
  filename: 'fictional-package.json',
  mimeType: 'application/json',
  bytes: 0,
  sha256: 'fictional-hash',
  createdAt: '2026-01-01T00:00:00.000Z',
  state: 'pending_conversion',
  proposals: [],
  version: 1,
  contentUrl: '/fictional-package',
  validation: {
    valid: false,
    rows: 0,
    exactRepeatedRows: 0,
    partialRows: 0,
    unrecognizedRows: 0,
    issues: [],
    preview: [],
    previewComplete: true,
  },
  acceptedProposalId: null,
  conversionChatId: null,
  imported: null,
  durability: { pending: false, mutationRevision: 0, persistedRevision: 0, error: null },
  workflow: {
    format: 'health-intake-workflow-v1',
    questions: [],
    plans: [
      {
        id: 'fictional-plan',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'active',
        pins: {
          sourceHash: 'fictional-hash',
          backend: 'fictional-backend',
          model: null,
          reasoningEffort: null,
          instructionVersion: 'fictional-instructions',
          mappingVersion: 'fictional-mapping',
        },
        index: { kind: 'json', coverage: 'inventory_only', missingAssets: [] },
        units: [
          {
            id: 'fictional-unit',
            kind: 'text',
            locator: 'fictional-unit',
            status: 'unprocessed' as unknown as IntakeExtractionUnit['status'],
            attempts: [],
          },
        ],
        batches: [],
      },
    ],
    candidates: [],
    decisions: [],
  },
};
const checkpoint = () => conversionCheckpoint({}, intake, 'fictional-profile');

test('array pages supply complete raw records without skipping or repeating and preserve explicit character offsets', () => {
  const records = Array.from(
    { length: 137 },
    (_, i) =>
      '{"id":"fictional-' +
      i +
      '","huge":900719925474099312345,"value":1.2300,"a/b":{"~key":"unknown-' +
      'x'.repeat(850) +
      '"}}',
  );
  const text = '{"items":[' + records.join(',') + ']}';
  const supplied = [];
  let jsonOffset: number | null = 0;
  do {
    const page = readJSONStructure(text, { jsonPointer: '/items', jsonOffset });
    assert.ok(JSON.stringify(page).length <= 48000);
    assert.ok(page.children.length > 1, 'one read supplies multiple whole records');
    assert.equal(page.complete, false);
    assert.equal(page.coverage, 'structure_preview_only');
    for (const child of page.children) {
      assert.equal(child.jsonPointer, '/items/' + supplied.length);
      assert.equal(child.literalComplete, true);
      assert.equal(child.nextOffset, null);
      assert.equal(child.literal, records[supplied.length]);
      supplied.push(child.literal);
    }
    jsonOffset = page.nextJSONOffset;
  } while (jsonOffset !== null);
  assert.deepEqual(supplied, records);
  const explicit = readJSONStructure(text, { jsonPointer: '/items', jsonOffset: 4, offset: 123 });
  assert.equal(explicit.literal, text.slice(9 + 123, 9 + 123 + 12000));
  assert.equal(explicit.offset, 123);
  assert.equal(explicit.children[0].literal, records[4]);
  const escaped = readJSONStructure(text, { jsonPointer: '/items/0/a~1b' });
  assert.equal(escaped.children[0].jsonPointer, '/items/0/a~1b/~0key');
  assert.equal(escaped.children[0].literalComplete, true);
});

test('oversized first children retain metadata and resumable literal prefixes without consuming the next child', () => {
  const raw = '"' + '\\t\\"'.repeat(18000) + '"';
  const text = '[' + raw + ',{"id":"after-large-value","precise":1.2300}]';
  const first = readJSONStructure(text);
  assert.ok(JSON.stringify(first).length <= 48000);
  assert.equal(first.children.length, 1);
  assert.equal(first.nextJSONOffset, 1);
  const child = first.children[0];
  assert.equal(child.jsonPointer, '/0');
  assert.equal(child.type, 'string');
  assert.equal(child.totalChildren, null);
  assert.equal(child.start, 1);
  assert.equal(child.end, 1 + raw.length);
  assert.equal(child.totalCharacters, raw.length);
  assert.equal(child.literalComplete, false);
  assert.equal(child.nextOffset, child.literal.length);
  let literal = child.literal,
    offset: number | null = child.nextOffset;
  do {
    const page = readJSONStructure(text, { jsonPointer: child.jsonPointer, offset });
    assert.ok(JSON.stringify(page).length <= 48000);
    literal += page.literal;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(literal, raw);
  const next = readJSONStructure(text, { jsonOffset: first.nextJSONOffset });
  assert.equal(next.children[0].literal, '{"id":"after-large-value","precise":1.2300}');
  assert.equal(next.nextJSONOffset, null);
});

test('fully supplied children and descendants are read evidence, never extraction completion or fresh repeat progress', () => {
  const text =
    '[' +
    Array.from(
      { length: 80 },
      (_, i) => '{"id":' + i + ',"unknown":{"literal":"' + 'x'.repeat(400) + '"}}',
    ).join(',') +
    ']';
  const state = checkpoint();
  const first = readJSONStructure(text);
  recordConversionRead(state, tool, args, { structure: first });
  const seen = state.seen.length;
  assert.ok(first.children.length > 1);
  assert.ok(first.children.every((child) => child.literalComplete));
  assert.equal(
    state.pending.some((window) => window.args.jsonPointer === '/0'),
    false,
  );
  assert.ok(state.pending.some((window) => window.args.jsonOffset === first.nextJSONOffset));
  assert.equal(
    recordConversionRead(
      state,
      tool,
      { ...args, jsonPointer: '/0' },
      {
        structure: readJSONStructure(text, { jsonPointer: '/0' }),
      },
    ),
    false,
  );
  assert.equal(
    recordConversionRead(
      state,
      tool,
      { ...args, jsonPointer: '/0/unknown' },
      {
        structure: readJSONStructure(text, { jsonPointer: '/0/unknown' }),
      },
    ),
    false,
  );
  assert.equal(state.seen.length, seen);
  assert.equal(intake.workflow.plans[0].units[0].status, 'unprocessed');
  assert.deepEqual(state.completedUnits, []);
});

test('partial child windows enqueue their own unread character offset and metadata-only legacy structures still require reads', () => {
  const text = '["' + 'x'.repeat(80000) + '",2]';
  const state = checkpoint();
  const first = readJSONStructure(text);
  recordConversionRead(state, tool, args, { structure: first });
  assert.ok(
    state.pending.some(
      (window) =>
        window.args.jsonPointer === '/0' && window.args.offset === first.children[0].nextOffset,
    ),
  );
  assert.ok(state.pending.some((window) => window.args.jsonOffset === 1));
  const legacy = checkpoint();
  recordConversionRead(legacy, tool, args, {
    structure: {
      jsonPointer: '',
      jsonOffset: 0,
      children: [{ jsonPointer: '/items', type: 'array' }],
      nextOffset: null,
      nextJSONOffset: null,
    },
  });
  assert.ok(legacy.pending.some((window) => window.args.jsonPointer === '/items'));
  assert.deepEqual(legacy.completedUnits, []);
  assert.equal(conversionReadingState(legacy, intake).coverage, 'reading_progress_only');
});

test('an oversized value behind an overlong escaped key retains a parent-literal continuation', () => {
  const text = JSON.stringify({ ['/'.repeat(2500)]: 'x'.repeat(80000) });
  const state = checkpoint();
  const first = readJSONStructure(text);
  assert.equal(first.children[0].jsonPointer, null);
  assert.equal(first.children[0].keyTruncated, true);
  assert.equal(first.children[0].literalComplete, false);
  assert.ok(JSON.stringify(first).length <= 48000);
  recordConversionRead(state, tool, args, { structure: first });
  assert.ok(
    state.pending.some(
      (window) => !window.args.jsonPointer && window.args.offset === first.nextOffset,
    ),
  );
  let literal = first.literal,
    offset = first.nextOffset;
  while (offset !== null) {
    const page = readJSONStructure(text, { offset });
    recordConversionRead(state, tool, { ...args, offset }, { structure: page });
    literal += page.literal;
    offset = page.nextOffset;
  }
  assert.equal(literal, text);
  assert.equal(state.pending.length, 0);
});

// The tests below cover the always-on document-level yield counters
// (distinctReads, proposalsProduced). They run with HEALTH_IMPORT_DIAGNOSTICS
// unset, like the rest of this file, because these counters must work without
// diagnostics enabled. recordsAccepted was dropped (see task-6-report.md,
// "Fix report"): it read 0 for the entire normal import flow, which is
// misleading rather than merely an undercount.

function planWithBatches(count: number, status: 'active' | 'superseded', suffix: string) {
  const template = intake.workflow.plans[0]!;
  return {
    ...template,
    id: `fictional-plan-${suffix}`,
    status: status as typeof template.status,
    batches: Array.from({ length: count }, (_, index) => ({
      id: `fictional-batch-${suffix}-${index}`,
      proposalId: `fictional-proposal-${suffix}-${index}`,
      at: '2026-01-01T00:00:00.000Z',
      coverage: [],
    })),
  };
}

const withPlans = (...plans: ReturnType<typeof planWithBatches>[]): IntakeWithWorkflow => ({
  ...intake,
  workflow: { ...intake.workflow, plans },
});

test('the always-on reading state reports distinct reads directly from the checkpoint', () => {
  const state = checkpoint();
  state.distinctReads = 40;
  const reading = conversionReadingState(state, intake);
  assert.equal(reading.distinctReads, 40);
});

test('the always-on reading state derives proposals produced from every plan’s batches, not a checkpoint counter', () => {
  const state = checkpoint();
  assert.equal(conversionReadingState(state, intake).proposalsProduced, 0);
  // Two submitted batches report as 2, derived fresh from the plans' batches rather
  // than an incrementable field — this is what keeps a replayed batch submission
  // (which adds no new plan.batches entry) from ever double counting.
  assert.equal(
    conversionReadingState(state, withPlans(planWithBatches(2, 'active', 'a'))).proposalsProduced,
    2,
  );
});

test('proposalsProduced does not drop when a plan is superseded, because the reads it counts against do not reset', () => {
  const state = checkpoint();
  state.distinctReads = 60;

  const beforeReplacement = conversionReadingState(
    state,
    withPlans(planWithBatches(3, 'active', 'first')),
  );
  assert.equal(beforeReplacement.proposalsProduced, 3);
  assert.equal(beforeReplacement.distinctReads, 60);

  // What intake.ts does on a plan replacement: the old plan is superseded and the
  // replacement is pushed with `batches: []`. The checkpoint that carries
  // `distinctReads` is created once per chat and is never reset, so scoping this
  // counter to the active plan alone would report 60 reads against 0 proposals — the
  // "60 pages yielded nothing" misreading that got recordsAccepted deleted.
  const afterReplacement = conversionReadingState(
    state,
    withPlans(planWithBatches(3, 'superseded', 'first'), planWithBatches(0, 'active', 'second')),
  );
  assert.equal(
    afterReplacement.proposalsProduced,
    3,
    'a superseded plan’s proposals stay counted after its replacement arrives empty',
  );
  assert.equal(afterReplacement.distinctReads, 60, 'its denominator did not reset either');

  // A batch against the replacement adds to the total rather than restarting it.
  assert.equal(
    conversionReadingState(
      state,
      withPlans(planWithBatches(3, 'superseded', 'first'), planWithBatches(1, 'active', 'second')),
    ).proposalsProduced,
    4,
  );
});

test('recordConversionRead counts a freshly read window once and does not recount a repeat of it', () => {
  const state = checkpoint();
  assert.equal(conversionReadingState(state, intake).distinctReads, 0);
  const text = '{"a":1}';
  const first = readJSONStructure(text);
  const fresh = recordConversionRead(state, tool, args, { structure: first });
  assert.equal(fresh, true);
  assert.equal(conversionReadingState(state, intake).distinctReads, 1);
  // The exact same window, read again, is not a newly read window.
  const repeat = recordConversionRead(state, tool, args, { structure: first });
  assert.equal(repeat, false);
  assert.equal(conversionReadingState(state, intake).distinctReads, 1);
});

test('native PDF reads account only for the supplied original page and enqueue remaining pages', () => {
  const state = checkpoint();
  const pageArgs = { id: intake.id, page: 2 };
  const result = {
    pdfContent: 'data:application/pdf;base64,ZmljdGlvbmFs',
    metadata: { original: { page: 2, nextPage: 3, nextOffset: null, complete: false } },
  };
  assert.equal(recordConversionRead(state, 'health_intake_read', pageArgs, result), true);
  assert.equal(state.distinctReads, 1);
  assert.equal(state.seen.length, 1);
  assert.ok(state.pending.some((window) => window.args.page === 3));
  assert.ok(!state.seen.some((window) => window.includes('"page":3')));
  assert.equal(recordConversionRead(state, 'health_intake_read', pageArgs, result), false);
  assert.equal(state.distinctReads, 1);
  assert.equal(JSON.stringify(state).includes('application/pdf'), false);
});

test('distinctReads counts what the model read, not every window marked seen', () => {
  const state = checkpoint();
  // One JSON structure read whose own literal is incomplete but whose children each
  // arrive complete. Those children are satisfied by inference: `suppliedJSON` marks
  // each one seen — so they land in `readWindows` — without any of them ever being
  // read, and without incrementing `distinctReads`. This is why the two counters are
  // not interchangeable, and why the old `pagesProcessed` name was wrong twice over:
  // nothing here is a page, and nothing here is one window per count.
  const records = Array.from(
    { length: 30 },
    (_, index) => `{"id":"fictional-${index}","note":"${'x'.repeat(900)}"}`,
  );
  const structure = readJSONStructure('{"items":[' + records.join(',') + ']}', {
    jsonPointer: '/items',
  });
  assert.equal(structure.literalComplete, false, 'the read window itself is not complete');
  assert.ok(
    structure.children.every((child) => child.literalComplete === true),
    'every child value arrived whole, so none of them needs its own read',
  );

  assert.equal(recordConversionRead(state, tool, args, { structure }), true);

  const reading = conversionReadingState(state, intake);
  assert.equal(reading.distinctReads, 1, 'the model performed exactly one read');
  assert.ok(
    reading.readWindows! > reading.distinctReads!,
    `one read marked ${reading.readWindows} windows seen; distinctReads must not follow it`,
  );
});

test('a checkpoint persisted before the rename keeps the reads it already counted', () => {
  const state = checkpoint();
  delete state.distinctReads;
  // A pre-rename checkpoint carries the count under the old name. Dropping to zero
  // would look like a conversion that had read nothing after a restart.
  state.pagesProcessed = 7;
  assert.equal(conversionReadingState(state, intake).distinctReads, 7);
  recordConversionRead(state, tool, args, { structure: readJSONStructure('{"a":1}') });
  assert.equal(state.distinctReads, 8, 'the next read continues the migrated count');
});

test('a checkpoint with neither field reports zero for distinctReads, never undefined', () => {
  const state = checkpoint();
  delete state.distinctReads;
  const reading = conversionReadingState(state, intake);
  assert.equal(reading.distinctReads, 0);
  assert.equal(Number.isNaN(reading.distinctReads), false);
  // Reading from an old-shaped checkpoint must not throw, and a subsequent
  // increment must still work from a clean zero rather than propagating undefined.
  recordConversionRead(state, tool, args, { structure: readJSONStructure('{"a":1}') });
  assert.equal(state.distinctReads, 1);
});
