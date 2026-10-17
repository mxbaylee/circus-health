import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  transaction,
  observeTransactionOutcome,
  currentTransactionToken,
  readOrdinaryCommitCursor,
} from '../database.ts';
import { DatabaseSync } from 'node:sqlite';
import { createNote } from '../notes.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachRecordDurability, rebuildRecordDatabase } from '../record-versions.ts';
import {
  contributorAuthorityPath,
  openContributorRecordStorage,
} from '../contributor-record-storage.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import {
  iterateIntakeEnvelopeText,
  hasIntakeCollectionEnvelope,
} from '../intake-collection-envelope.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  uploadIntake,
  reviewIntake,
  saveIntakeReviewDraftRead,
  reviewIntakeRead,
  ensureNativeIntakeSchema,
} from '../intake.ts';
import { planIntakeReportAcceptance, partitionAcceptancePlan } from '../intake-acceptance-plan.ts';
import { acceptanceCommitGroups, acceptanceDependencyKeys } from '../intake-acceptance-groups.ts';
import {
  acceptIntakeReportSelectionAsync,
  reportAcceptanceRequest,
} from '../intake-report-acceptance.ts';
import type {
  IntakeReportAcceptanceBlock,
  IntakeReportAcceptancePlan,
  IntakePartialAcceptanceItem,
  IntakeReview,
} from '../../shared/intake.ts';

function block(intakeId: string, count: number): IntakeReportAcceptanceBlock {
  return {
    intakeId,
    proposalId: null,
    intakeVersion: 1,
    reviewToken: 'fictional-review',
    selections: Array.from({ length: count }, (_, i) => ({
      recordId: `${intakeId}:line:${i + 1}`,
      candidateId: `${intakeId}-candidate-${i}`,
      candidateVersionId: `${intakeId}-version-${i}`,
      selectionReviewToken: `fictional-${i}`,
      mapping: { kind: 'observation', testLabel: 'Fictional', valueText: '7' },
    })),
  };
}
function inventory(blocks: IntakeReportAcceptanceBlock[], bytes = 100) {
  const selected = blocks.flatMap((block) =>
    block.selections.map((selection) => ({ block, selection })),
  );
  return {
    selected,
    records: selected.map(
      ({ selection }) =>
        ({ id: selection.recordId, title: 'Fictional result' }) as IntakeReview['records'][number],
    ) as Array<IntakeReview['records'][number] | undefined>,
    dependencies: selected.map(({ selection }) => acceptanceDependencyKeys(selection, undefined)),
    sizes: new Map(blocks.map((b) => [JSON.stringify([b.intakeId, b.proposalId]), bytes])),
  };
}
const count = (chunk: IntakeReportAcceptanceBlock[]) =>
  chunk.reduce((n, b) => n + b.selections.length, 0);
const observationCountForLabel = (db: DatabaseSync, label: string) =>
  Number(db.prepare('SELECT count(*) n FROM observations WHERE label=?').get(label)!.n);
const observationIds = (db: DatabaseSync) =>
  db
    .prepare('SELECT id FROM observations ORDER BY id')
    .all()
    .map((row) => String(row.id));

test('complete groups cross old 200 boundaries without splitting; within caps stays one operation', () => {
  const current = inventory([block('fictional-many', 1001)]);
  current.dependencies[199]!.add('shared-source-assertion');
  current.dependencies[200]!.add('shared-source-assertion');
  const plan = partitionAcceptancePlan(current);
  assert.deepEqual(plan.chunks.map(count), [199, 200, 200, 200, 200, 2]);
  assert.equal(plan.assignment[199], plan.assignment[200]);
  assert.equal(plan.unsent.length, 0);
  assert.equal(partitionAcceptancePlan(inventory([block('fictional-one', 1000)])).chunks.length, 1);
});

test('packing counts unique proposal block bytes, blocks and indivisible oversize groups', () => {
  const current = inventory(
    Array.from({ length: 4 }, (_, i) => block(`fictional-large-${i}`, 150)),
    20 * 1024 * 1024,
  );
  const plan = partitionAcceptancePlan(current);
  assert.equal(plan.unsent.length, 0);
  for (const chunk of plan.chunks) {
    assert.ok(count(chunk) <= 1000);
    assert.ok(chunk.length <= 100);
    assert.ok(
      chunk.reduce(
        (n, b) => n + current.sizes.get(JSON.stringify([b.intakeId, b.proposalId]))!,
        0,
      ) <=
        64 * 1024 * 1024,
    );
  }
  assert.equal(plan.chunks.flatMap((b) => b.flatMap((b) => b.selections)).length, 600);
  const many = inventory(Array.from({ length: 101 }, (_, i) => block(`fictional-block-${i}`, 1)));
  many.dependencies[99]!.add('shared-comparison');
  many.dependencies[100]!.add('shared-comparison');
  const split = partitionAcceptancePlan(many);
  assert.equal(split.assignment[99], split.assignment[100]);
  assert.ok(split.chunks.every((chunk) => chunk.length <= 100));
  const oversize = inventory([block('fictional-coupled', 1001), block('fictional-independent', 1)]);
  for (let i = 0; i < 1001; i++) oversize.dependencies[i]!.add('indivisible-source');
  const refused = partitionAcceptancePlan(oversize);
  assert.equal(refused.unsent.length, 1001);
  assert.equal(refused.unsent[0]!.reasonCode, 'REPORT_ACCEPTANCE_LIMIT');
  assert.deepEqual(refused.chunks.map(count), [1]);
  const largeGroup = inventory(
    Array.from({ length: 4 }, (_, i) => block(`fictional-byte-group-${i}`, 1)),
    20 * 1024 * 1024,
  );
  for (const keys of largeGroup.dependencies) keys.add('indivisible-destination');
  assert.equal(partitionAcceptancePlan(largeGroup).unsent.length, 4);
});

test('unavailable old dependency evidence refuses the whole selected scope, including other originals', () => {
  const current = inventory([block('fictional-missing', 1), block('fictional-other-original', 1)]);
  current.records[0] = undefined;
  const plan = partitionAcceptancePlan(current);
  assert.equal(plan.chunks.length, 0);
  assert.equal(plan.unsent.length, 2);
});

test('retained draft comparisons join the same commit groups as explicit comparisons', () => {
  const first = block('fictional-retained', 2);
  first.selections[0]!.useRetainedDecision = true;
  first.selections[0]!.mapping = {};
  first.selections[1]!.comparisons = [
    {
      otherRecordId: 'fictional-destination',
      outcome: 'distinct',
      reason: 'Separate fictional events',
    },
  ];
  const records = [
    { draft: { decision: { comparisons: first.selections[1]!.comparisons } } },
    {},
  ] as IntakeReview['records'];
  const groups = acceptanceCommitGroups(
    first.selections.map((s, i) => acceptanceDependencyKeys(s, records[i])),
  );
  assert.deepEqual(groups, [[0, 1]]);
});

test('direct API cap message explains sequential operations and rejects more than 100 blocks', () => {
  assert.throws(
    () =>
      reportAcceptanceRequest({
        mode: 'partial-v1',
        operationId: randomUUID(),
        blocks: [block('fictional', 1001)],
      }),
    (error) => error instanceof Error && /at most 1000.*sequential operations/.test(error.message),
  );
  assert.throws(
    () =>
      reportAcceptanceRequest({
        mode: 'partial-v1',
        operationId: randomUUID(),
        blocks: Array.from({ length: 101 }, (_, i) => block(`fictional-${i}`, 1)),
      }),
    (error) => error instanceof Error && /1–100/.test(error.message),
  );
});

const evidenceText = (db: DatabaseSync, id: string) =>
  hasIntakeCollectionEnvelope(db, { id })
    ? [...iterateIntakeEnvelopeText(db, { id })].join('')
    : readIntakeEnvelopeText(db, { id });
function fixture(t: test.TestContext) {
  let root = mkdtempSync(join(tmpdir(), 'fictional-save-plan-'));
  const profileId = 'fictional-save-plan';
  let opened: DatabaseSync | undefined;
  let authority: ReturnType<typeof openContributorRecordStorage> | undefined;
  t.after(() => {
    try {
      if (opened) clearIntakeStateCache(opened);
    } finally {
      try {
        if (opened?.isOpen) opened.close();
      } finally {
        try {
          authority?.close();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });
  root = realpathSync.native(root);
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  opened = db;
  const storage = openContributorRecordStorage(root, profileId, { initialize: true });
  authority = storage;
  attachRecordDurability(db, { profileId, storage });
  const upload = (
    name: string,
    ids: string[],
    paddingBytes = 0,
    testLabel?: string,
    sourceRecordId?: string,
  ): IntakeReportAcceptanceBlock => {
    const source = uploadIntake(db, root, profileId, {
      filename: name + '.jsonl',
      bytes: Buffer.from(
        ids
          .map((id) =>
            JSON.stringify({
              format: 'health-record-v1',
              id,
              kind: 'record',
              payload: { literal: '7' },
              provenance: {
                capturedVia: 'Fictional export',
                sourceSystem: 'Fictional clinic',
                sourceRecordId: sourceRecordId ?? id,
                evidenceClass: 'provider_export',
                locator: 'row ' + id,
              },
              coverage: { status: 'complete_response', notes: [] },
              clinical: {
                kind: 'observation',
                subject: 'self',
                testLabel: testLabel ?? id,
                valueText: '7',
                unit: 'mg',
                date: '2026-01-01',
              },
            }),
          )
          .join('\n') + (paddingBytes ? '\n' + ' '.repeat(paddingBytes) : ''),
      ),
    });
    const review = reviewIntake(db, root, profileId, source.id);
    return {
      intakeId: source.id,
      proposalId: null,
      intakeVersion: review.version,
      reviewToken: review.reviewToken,
      selections: review.records.map((r) => ({
        recordId: r.id,
        candidateId: r.candidateId!,
        candidateVersionId: r.candidateVersionId!,
        selectionReviewToken: r.selectionReviewToken,
        mapping: r.mapping,
      })),
    } satisfies IntakeReportAcceptanceBlock;
  };
  return { db, root, profileId, upload, storage, paths };
}

const selectionKey = (item: { intakeId: string; proposalId: string | null; recordId: string }) =>
  JSON.stringify([item.intakeId, item.proposalId, item.recordId]);
const approvalEntries = (blocks: IntakeReportAcceptanceBlock[]) =>
  blocks.flatMap((block) =>
    block.selections.map((selection) => ({
      key: selectionKey({ ...block, ...selection }),
      block,
      selection,
    })),
  );
function retainedOriginals(f: ReturnType<typeof fixture>, blocks: IntakeReportAcceptanceBlock[]) {
  return [...new Set(blocks.map((block) => block.proposalId ?? block.intakeId))].map((id) => {
    const row = f.db.prepare('SELECT path,bytes,sha256 FROM source_files WHERE id=?').get(id)!;
    assert.equal(
      statSync(join(f.root, String(row.path))).size,
      Number(row.bytes),
      'caps use actual retained original bytes',
    );
    return { id, path: String(row.path), bytes: Number(row.bytes), sha256: String(row.sha256) };
  });
}
function assertPlannedCoverage(
  f: ReturnType<typeof fixture>,
  blocks: IntakeReportAcceptanceBlock[],
  plan: IntakeReportAcceptancePlan,
) {
  const original = new Map(approvalEntries(blocks).map((entry) => [entry.key, entry])),
    seen: string[] = [],
    sizes = new Map(retainedOriginals(f, blocks).map((row) => [row.id, row.bytes]));
  for (const chunk of plan.chunks) {
    assert.ok(chunk.length > 0 && chunk.length <= 100);
    assert.ok(count(chunk) > 0 && count(chunk) <= 1000);
    assert.ok(
      chunk.reduce((bytes, block) => bytes + sizes.get(block.proposalId ?? block.intakeId)!, 0) <=
        64 * 1024 * 1024,
    );
    assert.equal(
      new Set(chunk.map((block) => JSON.stringify([block.intakeId, block.proposalId]))).size,
      chunk.length,
    );
    for (const entry of approvalEntries(chunk)) {
      const approved = original.get(entry.key);
      assert.ok(approved, 'every planned selection belongs to the exact original approvals');
      assert.deepEqual(
        { ...entry.block, selections: [entry.selection] },
        { ...approved.block, selections: [approved.selection] },
      );
      seen.push(entry.key);
    }
  }
  for (const item of plan.unsent) {
    const approved = original.get(selectionKey(item));
    assert.ok(approved);
    assert.equal(item.candidateId, approved.selection.candidateId);
    assert.equal(item.candidateVersionId, approved.selection.candidateVersionId);
    seen.push(approved.key);
  }
  assert.equal(seen.length, original.size);
  assert.equal(new Set(seen).size, seen.length, 'no selection is omitted or assigned twice');
  assert.deepEqual([...seen].sort(), [...original.keys()].sort());
}
async function executeExactPlan(
  f: ReturnType<typeof fixture>,
  blocks: IntakeReportAcceptanceBlock[],
  plan: IntakeReportAcceptancePlan,
  needsReview: ReadonlySet<string> = new Set(),
) {
  const approved = structuredClone(blocks),
    items: IntakePartialAcceptanceItem[] = [],
    savedEntities: string[] = [];
  for (const [chunk, chunkBlocks] of plan.chunks.entries()) {
    const entries = approvalEntries(chunkBlocks),
      receipt = (
        await acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, {
          operationId: randomUUID(),
          mode: 'partial-v1',
          plan: { id: plan.planId, chunk },
          blocks: chunkBlocks,
        })
      ).receipt;
    if (receipt.atomic) throw Error('Expected partial');
    assert.equal(receipt.selectedCount, entries.length);
    assert.deepEqual(
      receipt.items.map(selectionKey).sort(),
      entries.map((entry) => entry.key).sort(),
    );
    const expected = new Map(entries.map((entry) => [entry.key, entry.selection]));
    for (const item of receipt.items) {
      const selection = expected.get(selectionKey(item))!;
      assert.equal(
        item.status,
        needsReview.has(selectionKey(item)) ? 'needs_review' : 'saved',
        JSON.stringify(item),
      );
      assert.equal(item.candidateId, selection.candidateId);
      assert.equal(item.candidateVersionId, selection.candidateVersionId);
      assert.equal(item.selectionReviewToken, selection.selectionReviewToken);
    }
    const saved = receipt.items.filter((item) => item.status === 'saved'),
      records = receipt.receipts.flatMap((block) =>
        block.records.map((record) => ({ ...block, ...record })),
      );
    assert.equal(receipt.acceptedCount, saved.length);
    assert.deepEqual(
      records.map(selectionKey).sort(),
      saved.map(selectionKey).sort(),
      'only saved selections have accepted receipt records',
    );
    for (const record of records) {
      assert.equal(record.kind, 'observation');
      assert.equal(record.outcome, 'added');
      savedEntities.push(record.entityId);
    }
    items.push(...receipt.items);
    assert.deepEqual(
      observationIds(f.db),
      [...savedEntities].sort(),
      'database destinations exactly match the cumulative saved receipts',
    );
    assert.deepEqual(blocks, approved, 'sequential saves never refresh or alter approved requests');
  }
  assert.equal(new Set(savedEntities).size, savedEntities.length);
  return items;
}

async function waitForCommittedSelection(
  t: test.TestContext,
  db: DatabaseSync,
  saving: Promise<unknown>,
  count: number,
  mutate: () => void,
) {
  let settled = false;
  void saving.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const current = () => Number(db.prepare('SELECT count(*) n FROM observations').get()!.n);
  // Adoption and native preparation may yield many times before the first
  // clinical commit. Mutate the successor's evidence only at that real boundary.
  while (!settled && (db.isTransaction || current() < count)) {
    t.signal.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (settled) await saving;
  assert.equal(settled, false, 'the successor must still be pending before mutation');
  assert.equal(db.isTransaction, false);
  assert.equal(current(), count, 'observe the exact committed selection before mutation');
  // Stay in this turn: returning to an awaiting caller could let the successor
  // finish before its evidence is changed.
  mutate();
}

test('planned exact approvals cannot change; receipt replay survives disposable plan eviction', async (t) => {
  const f = fixture(t),
    selected = f.upload('fictional-one', ['fictional-one']);
  const plan = await planIntakeReportAcceptance(f.db, f.root, f.profileId, { blocks: [selected] });
  const input = {
    operationId: randomUUID(),
    mode: 'partial-v1' as const,
    plan: { id: plan.planId, chunk: 0 },
    blocks: plan.chunks[0]!,
  };
  const changed = structuredClone(input);
  changed.blocks[0]!.selections[0]!.mapping.valueText = '8';
  await assert.rejects(() => acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, changed), {
    code: 'REPORT_ACCEPTANCE_PLAN_CHANGED',
  });
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  const result = await acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, input);
  assert.equal(result.receipt.acceptedCount, 1, JSON.stringify(result));
  for (let i = 0; i < 8; i++)
    await planIntakeReportAcceptance(f.db, f.root, f.profileId, { blocks: [selected] });
  assert.deepEqual(
    (await acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, input)).receipt,
    result.receipt,
  );
  await assert.rejects(
    () =>
      acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, {
        ...input,
        operationId: randomUUID(),
      }),
    { code: 'REPORT_ACCEPTANCE_PLAN_EXPIRED' },
  );
});
test('exact legacy approvals survive supported one-time native schema adoption', async (t) => {
  const f = fixture(t),
    selected = f.upload('fictional-legacy-adoption', ['fictional-legacy-adoption']);
  const original = structuredClone(selected);
  await ensureNativeIntakeSchema(f.db, f.profileId, selected.intakeId);
  const plan = await planIntakeReportAcceptance(f.db, f.root, f.profileId, { blocks: [selected] });
  assert.deepEqual(plan.chunks[0], [original]);
  const saved = await acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, {
    operationId: randomUUID(),
    mode: 'partial-v1',
    plan: { id: plan.planId, chunk: 0 },
    blocks: plan.chunks[0]!,
  });
  if (saved.receipt.atomic) throw Error('Expected partial');
  assert.equal(saved.receipt.acceptedCount, 1, JSON.stringify(saved.receipt.items));
  assert.equal(
    saved.receipt.items[0]!.selectionReviewToken,
    original.selections[0]!.selectionReviewToken,
  );
});

test('planning groups a stale cross-original pair beyond 1000 before any save', async (t) => {
  const f = fixture(t);
  const first = f.upload(
    'fictional-large',
    Array.from({ length: 1000 }, (_, i) =>
      i === 199 ? 'fictional-shared' : `fictional-independent-${i}`,
    ),
  );
  const second = f.upload('fictional-other', ['fictional-shared']);
  second.selections[0]!.selectionReviewToken = 'fictional-stale';
  const blocks = [first, second],
    approved = structuredClone(blocks),
    originals = retainedOriginals(f, blocks);
  const plan = await planIntakeReportAcceptance(f.db, f.root, f.profileId, {
    blocks,
  });
  assertPlannedCoverage(f, blocks, plan);
  assert.deepEqual(blocks, approved);
  assert.equal(plan.unsent.length, 0);
  const chunk = plan.chunks.findIndex((c) => c.some((b) => b.intakeId === second.intakeId));
  assert.ok(chunk >= 0);
  assert.ok(
    plan.chunks[chunk]!.some(
      (b) =>
        b.intakeId === first.intakeId &&
        b.selections.some((s) => s.recordId === first.selections[199]!.recordId),
    ),
  );
  const pairKeys = new Set([
      selectionKey({ ...first, ...first.selections[199]! }),
      selectionKey({ ...second, ...second.selections[0]! }),
    ]),
    items = await executeExactPlan(f, blocks, plan, pairKeys),
    pair = items.filter((item) => pairKeys.has(selectionKey(item)));
  assert.equal(pair.length, 2);
  assert.deepEqual(
    pair.map((i) => i.status),
    ['needs_review', 'needs_review'],
  );
  assert.equal(items.length, 1001);
  assert.equal(items.filter((item) => item.status === 'saved').length, 999);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 999);
  assert.equal(observationCountForLabel(f.db, 'fictional-shared'), 0);
  assert.deepEqual(blocks, approved);
  assert.deepEqual(retainedOriginals(f, blocks), originals);
});

test('genuine original dependency inventory couples a shared source assertion across distinct payload IDs', (t) => {
  const f = fixture(t),
    blocks = [
      f.upload(
        'fictional-inventory-first',
        ['fictional-payload-first'],
        0,
        'fictional-shared-label',
        'fictional-shared-source',
      ),
      f.upload(
        'fictional-inventory-second',
        ['fictional-payload-second'],
        0,
        'fictional-shared-label',
        'fictional-shared-source',
      ),
      f.upload(
        'fictional-inventory-independent',
        ['fictional-payload-independent'],
        0,
        'fictional-shared-label',
      ),
    ],
    originals = retainedOriginals(f, blocks),
    dependencies = blocks.map((block) => {
      const review = reviewIntake(f.db, f.root, f.profileId, block.intakeId);
      assert.equal(review.records.length, 1);
      assert.ok(review.records[0]!.comparisonReference);
      return acceptanceDependencyKeys(block.selections[0]!, review.records[0]);
    });
  assert.equal(new Set(blocks.map((block) => block.intakeId)).size, 3);
  assert.equal(new Set(originals.map((row) => row.sha256)).size, 3);
  assert.deepEqual(acceptanceCommitGroups(dependencies), [[0, 1], [2]]);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  assert.equal(observationCountForLabel(f.db, 'fictional-shared-label'), 0);
  assert.deepEqual(observationIds(f.db), []);
});

test('genuine 101-original plan keeps the stale pair across blocks 100 and 101 together while 99 independent approvals save', async (t) => {
  const f = fixture(t),
    blocks = Array.from({ length: 101 }, (_, index) =>
      f.upload(
        `fictional-block-${index}`,
        [`fictional-block-independent-${index}`],
        0,
        index >= 99 ? 'fictional-block-shared' : undefined,
        index >= 99 ? 'fictional-block-shared' : undefined,
      ),
    );
  blocks[100]!.selections[0]!.selectionReviewToken = 'fictional-stale';
  const approved = structuredClone(blocks),
    originals = retainedOriginals(f, blocks),
    plan = await planIntakeReportAcceptance(f.db, f.root, f.profileId, { blocks });
  assert.equal(plan.unsent.length, 0);
  assertPlannedCoverage(f, blocks, plan);
  assert.deepEqual(
    plan.chunks.map((chunk) => chunk.length),
    [99, 2],
  );
  assert.deepEqual(plan.chunks.flat(), approved);
  const pairKeys = new Set(
      [99, 100].map((index) =>
        selectionKey({ ...blocks[index]!, ...blocks[index]!.selections[0]! }),
      ),
    ),
    items = await executeExactPlan(f, blocks, plan, pairKeys);
  assert.equal(items.length, 101);
  assert.equal(items.filter((item) => item.status === 'saved').length, 99);
  assert.equal(items.filter((item) => item.status === 'needs_review').length, 2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 99);
  assert.equal(observationCountForLabel(f.db, 'fictional-block-shared'), 0);
  assert.deepEqual(blocks, approved);
  assert.deepEqual(retainedOriginals(f, blocks), originals);
});

test('genuine retained originals above 64 MiB split into admitted operations and all independent approvals save', async (t) => {
  const f = fixture(t),
    blocks = Array.from({ length: 3 }, (_, index) =>
      f.upload(
        `fictional-byte-positive-${index}`,
        [`fictional-byte-positive-${index}`],
        22 * 1024 * 1024,
      ),
    ),
    approved = structuredClone(blocks),
    originals = retainedOriginals(f, blocks);
  assert.ok(originals.reduce((bytes, row) => bytes + row.bytes, 0) > 64 * 1024 * 1024);
  const plan = await planIntakeReportAcceptance(f.db, f.root, f.profileId, { blocks });
  assert.equal(plan.unsent.length, 0);
  assertPlannedCoverage(f, blocks, plan);
  assert.deepEqual(plan.chunks.map(count), [2, 1]);
  assert.deepEqual(plan.chunks.flat(), approved);
  const items = await executeExactPlan(f, blocks, plan);
  assert.equal(items.length, 3);
  assert.ok(items.every((item) => item.status === 'saved'));
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 3);
  assert.deepEqual(blocks, approved);
  assert.deepEqual(retainedOriginals(f, blocks), originals);
});

test('genuine oversized coupled original group remains unsent while one independent approval saves', async (t) => {
  const f = fixture(t),
    coupled = Array.from({ length: 4 }, (_, index) =>
      f.upload(
        `fictional-byte-coupled-${index}`,
        [`fictional-byte-coupled-${index}`],
        20 * 1024 * 1024,
        'fictional-byte-shared',
        'fictional-byte-shared',
      ),
    ),
    independent = f.upload('fictional-byte-independent', ['fictional-byte-independent']),
    blocks = [...coupled, independent],
    approved = structuredClone(blocks),
    originals = retainedOriginals(f, blocks);
  assert.ok(originals.slice(0, 4).reduce((bytes, row) => bytes + row.bytes, 0) > 64 * 1024 * 1024);
  const plan = await planIntakeReportAcceptance(f.db, f.root, f.profileId, { blocks });
  assertPlannedCoverage(f, blocks, plan);
  assert.deepEqual(plan.chunks, [[independent]]);
  assert.equal(plan.unsent.length, 4);
  assert.ok(plan.unsent.every((item) => item.reasonCode === 'REPORT_ACCEPTANCE_LIMIT'));
  assert.deepEqual(
    plan.unsent.map(selectionKey).sort(),
    approvalEntries(coupled)
      .map((entry) => entry.key)
      .sort(),
  );
  const items = await executeExactPlan(f, blocks, plan);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.status, 'saved');
  assert.equal(
    selectionKey(items[0]!),
    selectionKey({ ...independent, ...independent.selections[0]! }),
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.equal(observationCountForLabel(f.db, 'fictional-byte-shared'), 0);
  for (const block of coupled) {
    const review = await reviewIntakeRead(f.db, f.root, f.profileId, block.intakeId);
    assert.ok('format' in review && review.format === 'health-intake-clinical-review-page-v2');
    assert.equal(review.nextCursor, null);
    assert.equal(review.items.length, 1);
    const item = review.items[0]!;
    assert.equal(item.kind, 'value');
    if (item.kind !== 'value') throw Error('Expected actual unsent inline review');
    const record = item.value as IntakeReview['records'][number];
    assert.equal(record.id, block.selections[0]!.recordId);
    assert.equal(record.candidateVersionId, block.selections[0]!.candidateVersionId);
    assert.equal(record.reviewState, 'pending');
  }
  assert.deepEqual(blocks, approved);
  assert.deepEqual(retainedOriginals(f, blocks), originals);
});

test('a newly retained comparison cannot bridge planned chunks before either chunk publishes', async (t) => {
  const f = fixture(t),
    target = f.upload('fictional-target', ['fictional-bridge-0']);
  await acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, {
    operationId: randomUUID(),
    blocks: [target],
  });
  const destination = String(f.db.prepare('SELECT id FROM observations').get()!.id);
  // Real retained originals exceed the aggregate byte cap while each remains
  // valid bounded JSONL. A whitespace-only line adds no clinical records and
  // keeps this relationship regression independent of large schema adoption.
  const blocks = Array.from({ length: 3 }, (_, i) =>
    f.upload(
      `fictional-new-bridge-${i}`,
      [`fictional-bridge-new-${i}`],
      22 * 1024 * 1024,
      i === 0 ? 'fictional-bridge-0' : undefined,
    ),
  );
  const first = blocks[0]!,
    selected = blocks.at(-1)!;
  const later = selected.selections[0]!,
    laterMapping = later.mapping;
  const firstRecord = reviewIntake(f.db, f.root, f.profileId, first.intakeId).records[0]!;
  const firstComparison = firstRecord.comparisons?.find((item) => item.id === destination);
  assert.ok(firstComparison, 'the first record has an actual displayed saved comparison');
  first.selections[0]!.comparisons = [
    {
      otherRecordId: destination,
      scope: firstComparison.scope,
      outcome: 'distinct',
      reason: 'The first fictional original establishes a distinct specimen.',
    },
  ];
  assert.ok(
    acceptanceDependencyKeys(first.selections[0]!, firstRecord).has('destination:' + destination),
  );
  later.useRetainedDecision = true;
  later.mapping = {};
  const initialLaterRecord = reviewIntake(f.db, f.root, f.profileId, selected.intakeId).records[0]!;
  assert.equal(initialLaterRecord.id, later.recordId);
  assert.equal(
    acceptanceDependencyKeys(later, initialLaterRecord).has('destination:' + destination),
    false,
    'the later record is initially independent of the shared saved destination',
  );
  const approved = structuredClone(blocks);
  const plan = await planIntakeReportAcceptance(f.db, f.root, f.profileId, { blocks });
  assert.equal(plan.unsent.length, 0);
  assert.deepEqual(plan.chunks.map(count), [2, 1]);
  assert.deepEqual(plan.chunks.flat(), approved, 'planning must preserve exact original approvals');
  const firstChunk = plan.chunks.findIndex((chunk) =>
    chunk.some((block) =>
      block.selections.some((selection) => selection.recordId === first.selections[0]!.recordId),
    ),
  );
  const laterChunk = plan.chunks.findIndex((chunk) =>
    chunk.some((block) =>
      block.selections.some((selection) => selection.recordId === later.recordId),
    ),
  );
  assert.ok(firstChunk >= 0 && laterChunk >= 0 && firstChunk !== laterChunk);
  await saveIntakeReviewDraftRead(f.db, f.root, f.profileId, selected.intakeId, {
    operationId: randomUUID(),
    version: selected.intakeVersion,
    proposalId: null,
    recordId: later.recordId,
    candidateVersionId: later.candidateVersionId,
    mapping: { ...laterMapping, testLabel: first.selections[0]!.mapping.testLabel },
  });
  const current = await reviewIntakeRead(f.db, f.root, f.profileId, selected.intakeId);
  assert.ok('format' in current && current.format === 'health-intake-clinical-review-page-v2');
  assert.equal(current.nextCursor, null, 'the actual selected review fits one bounded page');
  const item = current.items[0]!;
  assert.equal(item.kind, 'value');
  if (item.kind !== 'value') throw Error('Expected the actual inline selected record');
  const record = item.value as IntakeReview['records'][number];
  assert.equal(record.id, later.recordId);
  const comparison = record.comparisons?.find((comparison) => comparison.id === destination);
  assert.ok(comparison, 'the changed displayed mapping has an actual saved comparison');
  await saveIntakeReviewDraftRead(f.db, f.root, f.profileId, selected.intakeId, {
    operationId: randomUUID(),
    version: current.version,
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    mapping: record.mapping,
    disposition: 'pending',
    decision: {
      recordId: record.id,
      action: 'accept',
      mapping: record.mapping,
      comparisons: [
        {
          otherRecordId: destination,
          scope: comparison.scope,
          outcome: 'distinct',
          reason: 'The fictional original establishes a distinct specimen.',
        },
      ],
    },
  });
  const retained = await reviewIntakeRead(f.db, f.root, f.profileId, selected.intakeId);
  assert.ok('format' in retained && retained.format === 'health-intake-clinical-review-page-v2');
  assert.equal(retained.nextCursor, null, 'the retained review fits one actual bounded page');
  const retainedItem = retained.items[0]!;
  assert.equal(retainedItem.kind, 'value');
  if (retainedItem.kind !== 'value') throw Error('Expected the actual retained selected record');
  const retainedRecord = retainedItem.value as IntakeReview['records'][number];
  assert.equal(retainedRecord.id, later.recordId);
  assert.ok(
    acceptanceDependencyKeys(later, retainedRecord).has('destination:' + destination),
    'the actual retained decision adds the shared saved destination dependency',
  );
  assert.deepEqual(blocks, approved, 'retained changes must not refresh the original approvals');
  await assert.rejects(
    () =>
      acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, {
        operationId: randomUUID(),
        mode: 'partial-v1',
        plan: { id: plan.planId, chunk: firstChunk },
        blocks: plan.chunks[firstChunk]!,
      }),
    { code: 'REPORT_ACCEPTANCE_PLAN_CHANGED' },
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
});

for (const native of [false, true])
  test(`${native ? 'native' : 'legacy'} planned and direct byte admission refuse before issuing a save`, async (t) => {
    const f = fixture(t),
      selected = f.upload('fictional-byte-admission', ['fictional-byte-admission']);
    if (native) await buildIntakeCollectionEnvelope(f.db, { id: selected.intakeId });
    const plan = await planIntakeReportAcceptance(f.db, f.root, f.profileId, {
      blocks: [selected],
    });
    f.db
      .prepare('UPDATE source_files SET bytes=? WHERE id=?')
      .run(64 * 1024 * 1024 + 1, selected.intakeId);
    for (const planned of [false, true])
      await assert.rejects(
        () =>
          acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, {
            mode: 'partial-v1',
            operationId: randomUUID(),
            blocks: plan.chunks[0]!,
            ...(planned ? { plan: { id: plan.planId, chunk: 0 } } : {}),
          }),
        { status: 413, code: 'REPORT_ACCEPTANCE_LIMIT' },
      );
    assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  });

test('ordinary commit cursor records exact own commits, harmless rollback and callback writes distinctly', (t) => {
  const f = fixture(t),
    initial = readOrdinaryCommitCursor(f.db);
  let token: object | undefined;
  transaction(f.db, () => {
    token = currentTransactionToken(f.db);
    f.db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run('fictional-cursor', 'one');
  });
  const committed = readOrdinaryCommitCursor(f.db);
  assert.equal(committed.serial, initial.serial + 1n);
  assert.equal(committed.token, token);
  assert.equal(committed.changes, committed.settledChanges);
  assert.throws(() =>
    transaction(f.db, () => {
      f.db
        .prepare('UPDATE app_meta SET value=? WHERE key=?')
        .run('rolled back', 'fictional-cursor');
      throw Error('fictional rollback');
    }),
  );
  const rolledBack = readOrdinaryCommitCursor(f.db);
  assert.equal(rolledBack.serial, committed.serial);
  assert.equal(rolledBack.changes, rolledBack.settledChanges);
  assert.equal(
    f.db.prepare('SELECT value FROM app_meta WHERE key=?').get('fictional-cursor')!.value,
    'one',
  );
  const dispose = observeTransactionOutcome(f.db, () => {
    f.db
      .prepare('UPDATE app_meta SET value=? WHERE key=?')
      .run('external callback', 'fictional-cursor');
  });
  try {
    transaction(f.db, () =>
      f.db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('own', 'fictional-cursor'),
    );
  } finally {
    dispose();
  }
  const callback = readOrdinaryCommitCursor(f.db);
  assert.notEqual(callback.changes, callback.settledChanges);
});
for (const mutation of ['ordinary', 'raw', 'peer'])
  test(`planned save refuses remaining work after ${mutation} evidence mutation during a yield`, async (t) => {
    const f = fixture(t),
      first = f.upload(
        'fictional-witness-first',
        Array.from({ length: 200 }, (_, i) => 'fictional-witness-' + i),
      ),
      second = f.upload('fictional-witness-second', ['fictional-witness-second']);
    const plan = await planIntakeReportAcceptance(f.db, f.root, f.profileId, {
      blocks: [first, second],
    });
    const saving = acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, {
      mode: 'partial-v1',
      operationId: randomUUID(),
      blocks: plan.chunks[0]!,
      plan: { id: plan.planId, chunk: 0 },
    });
    await waitForCommittedSelection(t, f.db, saving, 200, () => {
      if (mutation === 'ordinary')
        createNote(f.db, { kind: 'note', title: 'Fictional concurrent evidence' });
      else if (mutation === 'raw')
        f.db
          .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
          .run('fictional-external', 'raw');
      else {
        const peer = new DatabaseSync(ensureProfileDirectories(f.root, f.profileId).database);
        try {
          peer
            .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
            .run('fictional-external', 'peer');
        } finally {
          peer.close();
        }
      }
    });
    if (mutation === 'raw') {
      await assert.rejects(saving, /uncommitted direct writes bypassed the transaction boundary/);
      assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 200);
      return;
    }
    const receipt = (await saving).receipt;
    if (receipt.atomic) throw Error('Expected partial');
    assert.equal(receipt.acceptedCount, 200);
    assert.equal(receipt.items[200]!.status, 'needs_review');
    assert.equal(receipt.items[200]!.reasonCode, 'REPORT_ACCEPTANCE_PLAN_CHANGED');
    assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 200);
  });

test('old V3 archive reads exactly, adopts without refreshing approval and reconstructs the original planned receipt', async (t) => {
  const f = fixture(t),
    approved = f.upload('fictional-archived-approval', ['Fictional archived approval']);
  const literal = evidenceText(f.db, approved.intakeId);
  let archiveRoot = mkdtempSync(join(tmpdir(), 'fictional-planned-archive-'));
  let archiveStorage: ReturnType<typeof openContributorRecordStorage> | undefined;
  const connections: DatabaseSync[] = [];
  t.after(() => {
    let failure: unknown;
    for (const db of connections) {
      try {
        clearIntakeStateCache(db);
      } catch (error) {
        failure ??= error;
      }
      try {
        if (db.isOpen) db.close();
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      archiveStorage?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      rmSync(archiveRoot, { recursive: true, force: true });
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  });
  archiveRoot = realpathSync.native(archiveRoot);
  const archivePaths = ensureProfileDirectories(archiveRoot, f.profileId);
  const storage = openContributorRecordStorage(archiveRoot, f.profileId, { initialize: true });
  archiveStorage = storage;
  // Fork only durable evidence and physical fictional originals. Rebuild every
  // disposable database from the copied journal through a genuine factory.
  for (const name of readdirSync(join(contributorAuthorityPath(f.root, f.profileId), 'objects'))) {
    const key = 'objects/' + name;
    storage.writeImmutable(key, f.storage.read(key)!);
  }
  storage.publishHead(f.storage.read('head')!);
  cpSync(f.paths.sources, archivePaths.sources, { recursive: true });
  const reopen = (name: string) => {
    const path = join(archiveRoot, name + '.sqlite');
    rebuildRecordDatabase(path, { profileId: f.profileId, storage });
    const db = openDatabase(path, f.profileId);
    connections.push(db);
    attachRecordDurability(db, { profileId: f.profileId, storage });
    return db;
  };
  const old = reopen('fictional-old-archive');
  assert.equal(hasIntakeCollectionEnvelope(old, { id: approved.intakeId }), false);
  assert.equal(evidenceText(old, approved.intakeId), literal);
  const originalReview = reviewIntake(old, archiveRoot, f.profileId, approved.intakeId);
  assert.equal(
    originalReview.records[0]!.selectionReviewToken,
    approved.selections[0]!.selectionReviewToken,
  );
  const version = intakeSourceVersion(old, approved.intakeId);
  const plan = await planIntakeReportAcceptance(old, archiveRoot, f.profileId, {
    blocks: [approved],
  });
  assert.equal(hasIntakeCollectionEnvelope(old, { id: approved.intakeId }), true);
  assert.deepEqual(plan.chunks, [[approved]], 'conversion must not refresh any approved value');
  assert.equal(intakeSourceVersion(old, approved.intakeId).version, version.version);
  const request = {
    mode: 'partial-v1' as const,
    operationId: randomUUID(),
    plan: { id: plan.planId, chunk: 0 },
    blocks: plan.chunks[0]!,
  };
  const saved = await acceptIntakeReportSelectionAsync(old, archiveRoot, f.profileId, request);
  assert.equal(saved.receipt.acceptedCount, 1);
  const savedLiteral = evidenceText(old, approved.intakeId);
  const restored = reopen('fictional-native-reconstructed');
  assert.equal(evidenceText(restored, approved.intakeId), savedLiteral);
  const replayed = await acceptIntakeReportSelectionAsync(
    restored,
    archiveRoot,
    f.profileId,
    request,
  );
  assert.equal(replayed.replayed, true, 'durable receipt wins after disposable plan loss');
  assert.deepEqual(replayed.receipt, saved.receipt);
  assert.equal(restored.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
});

test('cancelled legacy adoption preserves exact original evidence and permits a checked retry', async (t) => {
  const f = fixture(t),
    approved = f.upload('fictional-cancelled-adoption', ['Fictional cancelled adoption']);
  const literal = evidenceText(f.db, approved.intakeId);
  const failure = Error('Fictional request cancelled before publication');
  let checks = 0;
  await assert.rejects(
    ensureNativeIntakeSchema(f.db, f.profileId, approved.intakeId, {
      assertRunning() {
        if (++checks === 20) throw failure;
      },
    }),
    failure,
  );
  assert.equal(checks, 20);
  assert.equal(evidenceText(f.db, approved.intakeId), literal);
  const plan = await planIntakeReportAcceptance(f.db, f.root, f.profileId, { blocks: [approved] });
  assert.deepEqual(plan.chunks, [[approved]]);
  const saved = await acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, {
    mode: 'partial-v1',
    operationId: randomUUID(),
    plan: { id: plan.planId, chunk: 0 },
    blocks: plan.chunks[0]!,
  });
  assert.equal(saved.receipt.acceptedCount, 1);
});

test('an unrelated rollback cannot conceal an earlier unowned persistent write', (t) => {
  const f = fixture(t);
  const before = readOrdinaryCommitCursor(f.db);
  f.db
    .prepare(
      "INSERT INTO app_meta(key,value) VALUES('fictional-unowned-before-rollback','outside')",
    )
    .run();
  assert.throws(() =>
    transaction(f.db, () => {
      f.db
        .prepare("INSERT INTO app_meta(key,value) VALUES('fictional-owned-rollback','inside')")
        .run();
      throw Error('Fictional unrelated rollback');
    }),
  );
  const after = readOrdinaryCommitCursor(f.db);
  assert.ok(
    before.identity !== after.identity ||
      before.serial !== after.serial ||
      !after.succeeded ||
      after.changes !== after.settledChanges,
    'the exact earlier plan must not regain a clean unchanged cursor after an unowned persistent write',
  );
  assert.equal(
    f.db.prepare("SELECT value FROM app_meta WHERE key='fictional-unowned-before-rollback'").get()!
      .value,
    'outside',
  );
  assert.equal(
    f.db.prepare("SELECT value FROM app_meta WHERE key='fictional-owned-rollback'").get(),
    undefined,
  );
});
