import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, now } from './database.ts';
import { canonicalLiteral } from './intake-format.ts';
import { flushIntake, intakeTransaction, reviewIntake } from './intake.ts';
import { acceptanceOwner, applyAcceptanceGroup } from './intake-report-acceptance.ts';
import type {
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceBlock,
  IntakePartialAcceptanceItem,
  IntakePartialAcceptanceReceipt,
  IntakeReportAcceptanceResult,
} from '../shared/intake.ts';

type Entry = {
  block: Omit<IntakeReportAcceptanceBlock, 'selections'>;
  selection: IntakeReportAcceptanceBlock['selections'][number];
  childId: string;
};
type Manifest = {
  fingerprint: string;
  at: string;
  operationId: string;
  entries: Entry[];
  groups: number[][];
};
const prefix = 'intake_partial_acceptance:v1:';
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');
const childId = (parent: string, identity: unknown) => {
  const hash = digest([parent, identity]);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
function read<T>(db: DatabaseSync, key: string): T | null {
  const row = db.prepare('SELECT value FROM app_meta WHERE key=?').get(prefix + key);
  return row ? (JSON.parse(String(row.value)) as T) : null;
}
function write(db: DatabaseSync, key: string, value: unknown) {
  db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
    prefix + key,
    JSON.stringify(value),
  );
}
const itemKey = (manifest: Manifest, index: number) => `${manifest.operationId}:item:${index}`;
const identity = (entry: Entry): Omit<IntakePartialAcceptanceItem, 'status'> => ({
  selectionReviewToken: entry.selection.selectionReviewToken!,
  reviewedSelectionHash: digest(entry.selection),
  intakeId: entry.block.intakeId,
  proposalId: entry.block.proposalId,
  recordId: entry.selection.recordId,
  candidateId: entry.selection.candidateId,
  candidateVersionId: entry.selection.candidateVersionId,
  operationId: entry.childId,
});

export const hasPartialAcceptance = (db: DatabaseSync, operationId: string) =>
  !!read<Manifest>(db, operationId);

export function acceptPartialSelection(
  db: DatabaseSync,
  root: string,
  profileId: string,
  request: IntakeReportAcceptanceRequest,
  fingerprint: string,
): IntakeReportAcceptanceResult {
  let manifest = read<Manifest>(db, request.operationId);
  const replayed = !!manifest;
  if (manifest && manifest.fingerprint !== fingerprint)
    throw new HttpError(
      409,
      'OPERATION_CONFLICT',
      'This operation already belongs to different exact selections.',
    );
  if (!manifest) {
    const entries = request.blocks.flatMap(({ selections, ...block }) =>
      selections.map((selection) => ({
        block,
        selection,
        childId: childId(request.operationId, [block.intakeId, block.proposalId, selection]),
      })),
    );
    // Same destination or same incoming assertion is one coupled commit group.
    // Unknown/stale inputs stay conservative and are rejected within their own boundary.
    const dependencies = entries.map((entry) => {
      const keys = new Set<string>();
      for (const comparison of entry.selection.comparisons || [])
        keys.add('destination:' + comparison.otherRecordId);
      try {
        const review = reviewIntake(
          db,
          root,
          profileId,
          entry.block.intakeId,
          entry.block.proposalId,
        );
        const record = review.records.find((item) => item.id === entry.selection.recordId);
        if (record?.comparisonReference)
          keys.add('assertion:' + record.kind + ':' + record.comparisonReference.identity);
        if (record?.duplicateOf) keys.add('destination:' + record.duplicateOf.id);
        keys.add('destination:' + entry.selection.recordId);
      } catch (error) {
        if (!(error instanceof HttpError) || [401, 403].includes(error.status)) throw error;
      }
      return keys;
    });
    const groups: number[][] = [];
    for (let i = 0; i < entries.length; i++) {
      const overlapping = groups.filter((group) =>
        group.some((j) => [...dependencies[i]!].some((key) => dependencies[j]!.has(key))),
      );
      const group = [i, ...overlapping.flat()].sort((a, b) => a - b);
      for (const prior of overlapping) groups.splice(groups.indexOf(prior), 1);
      groups.push(group);
    }
    manifest = { fingerprint, operationId: request.operationId, at: now(), entries, groups };
    const retained = manifest;
    intakeTransaction(
      db,
      () => {
        write(db, request.operationId, retained);
        return { operationId: request.operationId };
      },
      { operationId: request.operationId, fingerprint },
    );
  }
  return replayed
    ? reconcileManifest(db, root, profileId, manifest)
    : processManifest(db, root, profileId, manifest, false);
}
export function getPartialAcceptance(
  db: DatabaseSync,
  root: string,
  profileId: string,
  operationId: string,
): IntakeReportAcceptanceResult | null {
  const manifest = read<Manifest>(db, operationId);
  return manifest ? reconcileManifest(db, root, profileId, manifest) : null;
}
function processManifest(
  db: DatabaseSync,
  root: string,
  profileId: string,
  manifest: Manifest,
  replayed: boolean,
): IntakeReportAcceptanceResult {
  for (const group of manifest.groups) {
    acceptanceOwner(db, profileId);
    if (group.every((index) => read(db, itemKey(manifest, index)))) continue;
    const blocks = new Map<string, IntakeReportAcceptanceBlock>();
    for (const index of group) {
      const entry = manifest.entries[index]!;
      const key = canonicalLiteral([entry.block.intakeId, entry.block.proposalId]);
      if (!blocks.has(key)) blocks.set(key, { ...entry.block, selections: [] });
      blocks.get(key)!.selections.push(entry.selection);
    }
    const operationId = childId(
      manifest.operationId,
      group.map((index) => manifest.entries[index]!.childId),
    );
    const fingerprint = digest(group.map((index) => manifest.entries[index]));
    try {
      applyAcceptanceGroup(
        db,
        root,
        profileId,
        { operationId, blocks: [...blocks.values()] },
        fingerprint,
        (receipt) => {
          for (const index of group) {
            const entry = manifest.entries[index]!;
            const block = receipt.receipts.find(
              (item) =>
                item.intakeId === entry.block.intakeId &&
                item.proposalId === entry.block.proposalId,
            )!;
            const exact = {
              ...block,
              records: block.records.filter((item) => item.recordId === entry.selection.recordId),
            };
            write(db, itemKey(manifest, index), {
              ...identity(entry),
              status: 'saved',
              receipt: exact,
            } satisfies IntakePartialAcceptanceItem);
          }
        },
      );
    } catch (error) {
      // A published head with a lost acknowledgement is unknown, never a failure.
      // See docs/import/review-reliability.md. Reopening replays its original IDs.
      acceptanceOwner(db, profileId);
      if (error instanceof HttpError && [401, 403].includes(error.status)) throw error;
      const reviewFailure =
        error instanceof HttpError && [400, 404, 409, 413, 422].includes(error.status);
      const affected = reviewFailure
        ? group
        : manifest.entries.map((_, i) => i).filter((i) => !read(db, itemKey(manifest, i)));
      intakeTransaction(
        db,
        () => {
          for (const index of affected) {
            const inGroup = group.includes(index);
            write(db, itemKey(manifest, index), {
              ...identity(manifest.entries[index]!),
              status: reviewFailure ? 'needs_review' : inGroup ? 'failed' : 'not_attempted',
              reasonCode: reviewFailure
                ? error.code
                : inGroup
                  ? 'SAVE_FAILED'
                  : 'SHARED_SAVE_STOPPED',
              message: reviewFailure
                ? `${group.length > 1 ? 'Coupled selections need review. ' : ''}${error.message}`
                : inGroup
                  ? 'No clinical publication occurred. Review and approve a new save.'
                  : 'Processing stopped after a shared failure. Review and approve a new save.',
            } satisfies IntakePartialAcceptanceItem);
          }
          return { operationId, status: reviewFailure ? 'needs_review' : 'stopped' };
        },
        { operationId: childId(operationId, 'rejection'), fingerprint },
      );
      if (!reviewFailure) break;
    }
  }
  return manifestResult(db, root, profileId, manifest, replayed);
}
function manifestResult(
  db: DatabaseSync,
  root: string,
  profileId: string,
  manifest: Manifest,
  replayed: boolean,
): IntakeReportAcceptanceResult {
  const items = manifest.entries.map((_, index) =>
    read<IntakePartialAcceptanceItem>(db, itemKey(manifest, index))!,
  );
  const receipt: IntakePartialAcceptanceReceipt = {
    version: 1,
    operationId: manifest.operationId,
    status: 'completed',
    atomic: false,
    at: manifest.at,
    selectedCount: items.length,
    acceptedCount: items.filter((item) => item.status === 'saved').length,
    receipts: items.flatMap((item) => (item.receipt ? [item.receipt] : [])),
    items,
  };
  return { receipt, replayed, durability: flushIntake(db, root, profileId) };
}

function reconcileManifest(
  db: DatabaseSync,
  root: string,
  profileId: string,
  manifest: Manifest,
): IntakeReportAcceptanceResult {
  acceptanceOwner(db, profileId);
  const missing = manifest.entries
    .map((_, index) => index)
    .filter((index) => !read(db, itemKey(manifest, index)));
  if (missing.length)
    intakeTransaction(
      db,
      () => {
        for (const index of missing)
          write(db, itemKey(manifest, index), {
            ...identity(manifest.entries[index]!),
            status: 'not_attempted',
            reasonCode: 'SAVE_INTERRUPTED',
            message:
              'Processing was interrupted. Previously committed results are retained; review and explicitly approve a new save for this item.',
          } satisfies IntakePartialAcceptanceItem);
        return { operationId: manifest.operationId, status: 'interrupted' };
      },
      {
        operationId: childId(manifest.operationId, 'interrupted'),
        fingerprint: manifest.fingerprint,
      },
    );
  return manifestResult(db, root, profileId, manifest, true);
}
