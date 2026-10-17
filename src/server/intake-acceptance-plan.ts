/** Disposable admission planning. Exact approvals, originals and operation receipts
 * retain authority; this cache never becomes clinical or recovery evidence. */
import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  HttpError,
  clinicalReviewRevision,
  currentTransactionToken,
  readOrdinaryCommitCursor,
} from './database.ts';
import { canonicalLiteral } from './intake-format.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import { acceptanceOwner, reportAcceptanceRequest } from './intake-report-acceptance.ts';
import { createIntakeReviewSession, ensureNativeIntakeSchema } from './intake.ts';
import { hasNativeAcceptanceBlock } from './intake-report-acceptance-native.ts';
import { prepareNativePartialReviews, type ReviewSource } from './intake-partial-acceptance.ts';
import { acceptanceCommitGroups, acceptanceDependencyKeys } from './intake-acceptance-groups.ts';
import { currentClinicalOperation, runExclusiveClinicalOperation } from './clinical-operation.ts';
import { prepareIntakeLookupIndices } from './intake-lookup-projection.ts';
import type {
  IntakeReportAcceptanceBlock,
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptancePlan,
  IntakeReportAcceptanceReceipt,
  IntakeReview,
} from '../shared/intake.ts';

const limits = { selections: 1000, blocks: 100, bytes: 64 * 1024 * 1024 };
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');
const pair = (block: IntakeReportAcceptanceBlock) =>
  JSON.stringify([block.intakeId, block.proposalId]);
const entries = (blocks: IntakeReportAcceptanceBlock[]) =>
  blocks.flatMap((block) => block.selections.map((selection) => ({ block, selection })));
type Entry = ReturnType<typeof entries>[number];
type StoredPlan = {
  root: string;
  profileId: string;
  blocks: IntakeReportAcceptanceBlock[];
  chunks: IntakeReportAcceptanceBlock[][];
  chunkHashes: string[];
  dependencies: Set<string>[];
  assignment: number[];
  completed: Set<number>;
  stamp: string;
  cursor: ReturnType<typeof readOrdinaryCommitCursor>;
  needsGraph?: boolean;
};
const plans = new WeakMap<DatabaseSync, Map<string, StoredPlan>>();
function stamp(db: DatabaseSync, blocks: IntakeReportAcceptanceBlock[]) {
  return digest([
    clinicalReviewRevision(db),
    [...new Set(blocks.map((b) => b.intakeId))].map((id) => [id, intakeSourceVersion(db, id)]),
    blocks.map((block) =>
      db
        .prepare('SELECT bytes,sha256,kind,path FROM source_files WHERE id=?')
        .get(block.proposalId || block.intakeId),
    ),
  ]);
}

async function graph(
  db: DatabaseSync,
  root: string,
  profileId: string,
  blocks: IntakeReportAcceptanceBlock[],
  assertRunning: () => void,
) {
  const cursor = readOrdinaryCommitCursor(db);
  const assertUnchanged = () => {
    const current = readOrdinaryCommitCursor(db);
    if (!sameCursor(cursor, current)) throw planChanged();
  };
  const request = { mode: 'partial-v1', operationId: randomUUID(), blocks } as const;
  let prepared: Awaited<ReturnType<typeof prepareNativePartialReviews>> | undefined;
  const sources = new Map<string, ReviewSource | Error>();
  try {
    if (hasNativeAcceptanceBlock(db, request)) {
      prepared = await prepareNativePartialReviews(db, root, profileId, request, { assertRunning });
      for (const [key, value] of prepared.sources) sources.set(key, value);
    } else
      for (const id of new Set(blocks.map((b) => b.intakeId))) {
        assertRunning();
        try {
          sources.set(id, createIntakeReviewSession(db, root, profileId, id));
        } catch (error) {
          if (!(error instanceof HttpError) || [401, 403].includes(error.status)) throw error;
          sources.set(id, error);
        }
      }
    const basis = stamp(db, blocks);
    const reviews = new Map<string, Map<string, IntakeReview['records'][number]>>();
    const sizes = new Map<string, number>();
    for (const block of blocks) {
      assertRunning();
      const source = sources.get(block.intakeId);
      if (source && !(source instanceof Error)) {
        try {
          reviews.set(
            pair(block),
            new Map(source.review(block.proposalId).records.map((r) => [r.id, r])),
          );
        } catch (error) {
          if (!(error instanceof HttpError) || [401, 403].includes(error.status)) throw error;
        }
      }
      const row = db
        .prepare('SELECT bytes FROM source_files WHERE id=?')
        .get(block.proposalId || block.intakeId);
      if (row && Number.isSafeInteger(Number(row.bytes)) && Number(row.bytes) >= 0)
        sizes.set(pair(block), Number(row.bytes));
    }
    const selected = entries(blocks);
    const records = selected.map(({ block, selection }) =>
      reviews.get(pair(block))?.get(selection.recordId),
    );
    const dependencies = selected.map(({ selection }, index) =>
      acceptanceDependencyKeys(selection, records[index]),
    );
    assertRunning();
    assertUnchanged();
    if (stamp(db, blocks) !== basis)
      throw new HttpError(
        409,
        'REPORT_ACCEPTANCE_PLAN_CHANGED',
        'The selected evidence changed while planning. Check the current records before saving.',
      );
    return {
      selected,
      records,
      dependencies,
      sizes,
      stamp: basis,
      cursor: readOrdinaryCommitCursor(db),
    };
  } finally {
    prepared?.close();
  }
}

function selectedBlocks(selected: Entry[], indices: number[]) {
  const result = new Map<string, IntakeReportAcceptanceBlock>();
  for (const index of indices) {
    const { block, selection } = selected[index]!;
    const key = pair(block);
    if (!result.has(key)) result.set(key, { ...block, selections: [] });
    result.get(key)!.selections.push(selection);
  }
  return [...result.values()];
}
function admitted(blocks: IntakeReportAcceptanceBlock[], sizes: Map<string, number>) {
  return (
    blocks.length <= limits.blocks &&
    blocks.reduce((n, b) => n + b.selections.length, 0) <= limits.selections &&
    blocks.reduce((n, b) => n + (sizes.get(pair(b)) ?? Infinity), 0) <= limits.bytes
  );
}

/** Pure packing of a host-verified dependency inventory; byte tests need no giant fixture files. */
export function partitionAcceptancePlan(current: {
  selected: Entry[];
  records: Array<IntakeReview['records'][number] | undefined>;
  dependencies: Set<string>[];
  sizes: Map<string, number>;
}) {
  const blocks = selectedBlocks(
    current.selected,
    current.selected.map((_, i) => i),
  );
  // If current dependency evidence is unavailable, do not infer independence
  // from its absence. An opaque old token cannot recover a vanished
  // assertion's cross-original edges, so refuse the selected scope.
  if (current.records.some((record) => !record))
    for (const keys of current.dependencies) keys.add('unavailable-plan');
  const groups = acceptanceCommitGroups(current.dependencies);
  const chunks: IntakeReportAcceptanceBlock[][] = [],
    unsent: IntakeReportAcceptancePlan['unsent'] = [];
  const assignment = current.selected.map(() => -1);
  let indices: number[] = [];
  const flush = () => {
    if (!indices.length) return;
    const index = chunks.length;
    for (const item of indices) assignment[item] = index;
    chunks.push(selectedBlocks(current.selected, indices));
    indices = [];
  };
  const allFit = admitted(blocks, current.sizes);
  for (const group of groups) {
    const groupBlocks = selectedBlocks(current.selected, group);
    const missing = group.some(
      (i) => !current.records[i] || !current.sizes.has(pair(current.selected[i]!.block)),
    );
    if (missing || !admitted(groupBlocks, current.sizes)) {
      for (const i of group) {
        const { block, selection } = current.selected[i]!;
        unsent.push({
          intakeId: block.intakeId,
          proposalId: block.proposalId,
          recordId: selection.recordId,
          candidateId: selection.candidateId,
          candidateVersionId: selection.candidateVersionId,
          label: current.records[i]?.title?.slice(0, 160),
          reasonCode: missing ? 'REPORT_ACCEPTANCE_PLAN_REVIEW' : 'REPORT_ACCEPTANCE_LIMIT',
          message: missing
            ? 'The complete coupled evidence is unavailable. Review the current report before saving.'
            : 'These coupled records exceed one save limit (1000 records, 100 proposal blocks or 64 MiB). They were not sent; review their shared effects together.',
        });
      }
      continue;
    }
    if (
      indices.length &&
      ((!allFit && indices.length + group.length > 200) ||
        !admitted(selectedBlocks(current.selected, [...indices, ...group]), current.sizes))
    )
      flush();
    indices.push(...group);
  }
  flush();

  return { chunks, unsent, assignment };
}

export async function planIntakeReportAcceptance(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: unknown,
  options: { assertRunning?: () => void } = {},
): Promise<IntakeReportAcceptancePlan> {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      const assertRunning = () => {
        options.assertRunning?.();
        acceptanceOwner(db, profileId);
      };
      assertRunning();
      const request = reportAcceptanceRequest(
        { ...(input as object), mode: 'partial-v1', operationId: randomUUID() },
        true,
      );
      const blocks = request.blocks;
      // A cold reconstruction has no disposable operation index yet. Build it
      // before the first graph witness rather than during its later receipt check.
      await prepareIntakeLookupIndices(db, { assertRunning });
      // Adoption changes representation only; the exact original selections stay
      // untouched. Capture the planning witness after that one-time preparation.
      for (const id of new Set(blocks.map((block) => block.intakeId))) {
        assertRunning();
        await ensureNativeIntakeSchema(db, profileId, id, { assertRunning });
      }
      const current = await graph(db, root, profileId, blocks, assertRunning);
      const { chunks, unsent, assignment } = partitionAcceptancePlan(current);
      assertRunning();
      const planId = randomUUID();
      let retained = plans.get(db);
      if (!retained) plans.set(db, (retained = new Map()));
      // Resource bound, not an approval limit: an evicted unsent plan must be
      // explicitly planned again. Already issued operations recover by their UUID.
      if (retained.size >= 8) retained.delete(retained.keys().next().value!);
      retained.set(planId, {
        root,
        profileId,
        blocks,
        chunks,
        chunkHashes: chunks.map(digest),
        dependencies: current.dependencies,
        assignment,
        completed: new Set(),
        stamp: current.stamp,
        cursor: current.cursor,
      });
      return { planId, chunks: structuredClone(chunks), unsent };
    },
    { operation: currentClinicalOperation(db) },
  );
}

const planChanged = () =>
  new HttpError(
    409,
    'REPORT_ACCEPTANCE_PLAN_CHANGED',
    'The selected records have changed or unavailable shared effects. Check earlier receipts and review the remaining records together.',
  );
function sameCursor(
  previous: ReturnType<typeof readOrdinaryCommitCursor>,
  current: ReturnType<typeof readOrdinaryCommitCursor>,
) {
  return (
    previous.identity === current.identity &&
    previous.serial === current.serial &&
    previous.dataVersion === current.dataVersion &&
    previous.schemaVersion === current.schemaVersion &&
    current.changes === current.settledChanges &&
    current.succeeded
  );
}
export type AcceptancePlanWitness = {
  assertCurrent(): void;
  begin(rejection?: boolean): void;
  settle(): void;
  retain(receipt: IntakeReportAcceptanceReceipt): void;
};
function planWitness(db: DatabaseSync, profileId: string, plan: StoredPlan): AcceptancePlanWitness {
  const selectedIndices = new Map(
    entries(plan.blocks).map((e, i) => [
      JSON.stringify([e.block.intakeId, e.block.proposalId, e.selection.recordId]),
      i,
    ]),
  );
  const destinations = new Map<string, Set<number>>();
  plan.dependencies.forEach((keys, i) => {
    for (const key of keys) {
      let chunks = destinations.get(key);
      if (!chunks) destinations.set(key, (chunks = new Set()));
      chunks.add(plan.assignment[i]!);
    }
  });
  let ownToken: object | undefined;
  let before = plan.cursor;
  let rejected = false;
  const fail = () => {
    plan.needsGraph = true;
    rejected = true;
    throw planChanged();
  };
  const assertCurrent = () => {
    acceptanceOwner(db, profileId);
    const current = readOrdinaryCommitCursor(db);
    if (rejected || !sameCursor(plan.cursor, current)) {
      fail();
    }
  };
  return {
    assertCurrent,
    begin(rejection = false) {
      if (!rejection) assertCurrent();
      before = readOrdinaryCommitCursor(db);
      ownToken = currentTransactionToken(db);
      if (!ownToken) throw Error('Acceptance plan requires its exact publication transaction');
    },
    settle() {
      const current = readOrdinaryCommitCursor(db);
      if (
        ownToken &&
        current.token === ownToken &&
        current.serial === before.serial + 1n &&
        !current.succeeded
      ) {
        plan.needsGraph = true;
        throw Error(
          'The exact save publication acknowledgement is unknown. Reconcile its original operation before continuing.',
        );
      }
      if (
        ownToken &&
        current.serial === before.serial + 1n &&
        current.token === ownToken &&
        current.succeeded &&
        current.identity === before.identity &&
        current.dataVersion === before.dataVersion &&
        current.schemaVersion === before.schemaVersion &&
        current.changes === current.settledChanges
      ) {
        plan.cursor = current;
        plan.stamp = stamp(db, plan.blocks);
      } else if (!sameCursor(plan.cursor, current)) fail();
      ownToken = undefined;
    },
    retain(receipt) {
      // Receipt destinations are checked before the current clinical transaction
      // commits, so own publication cannot create a cross-chunk shared effect.
      for (const block of receipt.receipts)
        for (const record of block.records) {
          const i = selectedIndices.get(
            JSON.stringify([block.intakeId, block.proposalId, record.recordId]),
          );
          if (i === undefined) throw Error('Acceptance receipt is outside its exact plan');
          const key = 'destination:' + record.entityId,
            chunk = plan.assignment[i]!;
          if ([...(destinations.get(key) ?? [])].some((other) => other !== chunk)) fail();
          plan.dependencies[i]!.add(key);
          let chunks = destinations.get(key);
          if (!chunks) destinations.set(key, (chunks = new Set()));
          chunks.add(chunk);
        }
    },
  };
}

export async function assertAcceptancePlan(
  db: DatabaseSync,
  root: string,
  profileId: string,
  request: IntakeReportAcceptanceRequest,
): Promise<AcceptancePlanWitness | undefined> {
  if (!request.plan) return;
  acceptanceOwner(db, profileId);
  const plan = plans.get(db)?.get(request.plan.id);
  if (!plan || plan.root !== root || plan.profileId !== profileId)
    throw new HttpError(
      409,
      'REPORT_ACCEPTANCE_PLAN_EXPIRED',
      'This unsent save plan is unavailable. Check any issued operation by its original ID, then plan the remaining approvals again.',
    );
  if (plan.chunkHashes[request.plan.chunk] !== digest(request.blocks))
    throw new HttpError(
      409,
      'REPORT_ACCEPTANCE_PLAN_CHANGED',
      'This save does not match its exact planned approvals. Review and plan the unsent records again.',
    );
  if (plan.completed.has(request.plan.chunk))
    throw new HttpError(
      409,
      'REPORT_ACCEPTANCE_PLAN_CONSUMED',
      'This planned save was already issued. Check its original operation ID before planning unsaved work.',
    );
  // Unchanged selected evidence needs no second graph preparation. Changed
  // authority is conservative until its complete selected relationships recheck.
  if (
    !plan.needsGraph &&
    sameCursor(plan.cursor, readOrdinaryCommitCursor(db)) &&
    stamp(db, plan.blocks) === plan.stamp
  )
    return planWitness(db, profileId, plan);
  const current = await graph(db, root, profileId, plan.blocks, () =>
    acceptanceOwner(db, profileId),
  );
  if (!admitted(request.blocks, current.sizes))
    throw new HttpError(
      413,
      'REPORT_ACCEPTANCE_LIMIT',
      'The retained proposal bytes changed beyond this save limit. No new clinical save occurred; plan the unsent approvals again.',
    );
  const merged = current.dependencies.map(
    (keys, i) => new Set([...keys, ...plan.dependencies[i]!]),
  );
  for (const group of acceptanceCommitGroups(merged)) {
    const chunks = new Set(group.map((i) => plan.assignment[i]));
    if (
      chunks.size > 1 ||
      group.some((i) => !current.records[i] && !plan.completed.has(plan.assignment[i]!))
    )
      throw new HttpError(
        409,
        'REPORT_ACCEPTANCE_PLAN_CHANGED',
        'The selected records now have changed or unavailable shared effects. No new save was issued; check earlier receipts and review the remaining records together.',
      );
  }
  plan.dependencies = merged;
  plan.stamp = current.stamp;
  plan.cursor = current.cursor;
  plan.needsGraph = false;
  return planWitness(db, profileId, plan);
}

export function recordAcceptancePlanResult(
  db: DatabaseSync,
  request: IntakeReportAcceptanceRequest,
  receipt: IntakeReportAcceptanceReceipt,
) {
  if (!request.plan) return;
  const plan = plans.get(db)?.get(request.plan.id);
  if (!plan) return;
  plan.completed.add(request.plan.chunk);
  const saved = new Map(
    receipt.receipts.flatMap((b) =>
      b.records.map(
        (r) => [JSON.stringify([b.intakeId, b.proposalId, r.recordId]), r.entityId] as const,
      ),
    ),
  );
  entries(plan.blocks).forEach(({ block, selection }, i) => {
    const id = saved.get(JSON.stringify([block.intakeId, block.proposalId, selection.recordId]));
    if (id) plan.dependencies[i]!.add('destination:' + id);
  });
}
