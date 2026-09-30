import type {
  IntakeImportFeed,
  IntakePartialAcceptanceReceipt,
  IntakeReportAcceptanceBlock,
  IntakeReportAcceptanceReceipt,
} from '../../../shared/intake';
import { initialDraft } from '../intake/useReviewDrafts';

export interface UnsentSelection {
  id: string;
  label: string;
  reason: string;
}

/** Confirmed child operations can arrive through the POST or a later receipt check. */
export function combinePartialReceipts(
  receipts: IntakePartialAcceptanceReceipt[],
): IntakePartialAcceptanceReceipt | null {
  if (!receipts.length) return null;
  const items = receipts.flatMap((receipt) => receipt.items);
  return {
    version: 1,
    operationId: receipts[0]!.operationId,
    status: 'completed',
    atomic: false,
    at: receipts[0]!.at,
    selectedCount: items.length,
    acceptedCount: items.filter((item) => item.status === 'saved').length,
    receipts: receipts.flatMap((receipt) => receipt.receipts),
    items,
  };
}

export function confirmedSelectionIds(receipt: IntakeReportAcceptanceReceipt): string[] {
  return receipt.receipts.flatMap((block) =>
    block.records.map((record) =>
      JSON.stringify([block.intakeId, record.candidateId, record.candidateVersionId]),
    ),
  );
}

export function rejectedSelectionIds(receipt: IntakeReportAcceptanceReceipt): string[] {
  return receipt.atomic
    ? []
    : receipt.items
        .filter((item) => item.status !== 'saved')
        .map((item) => JSON.stringify([item.intakeId, item.candidateId, item.candidateVersionId]));
}

export function stoppedChildSelections(chunks: IntakeReportAcceptanceBlock[][]): UnsentSelection[] {
  return chunks.flatMap((chunk) =>
    chunk.flatMap((block) =>
      block.selections.map((selection) => ({
        id: JSON.stringify([block.intakeId, selection.candidateId, selection.candidateVersionId]),
        label: 'Record in retained report',
        reason: 'Not sent because an earlier save has an unknown outcome. Check its receipt first.',
      })),
    ),
  );
}

/** Exact approval coverage is checked before transport, including selections off this page. */
export function planPartialSave(
  ids: string[],
  feed: IntakeImportFeed | null | undefined,
  approvals?: IntakeReportAcceptanceBlock[],
) {
  const shown = new Map(
    feed?.blocks.flatMap((block) =>
      block.records.map((record) => [record.feedKey, record] as const),
    ) || [],
  );
  const grouped = new Map<string, IntakeReportAcceptanceBlock>();
  if (approvals?.length) {
    for (const block of approvals) {
      const key = JSON.stringify([block.intakeId, block.proposalId]);
      const prior = grouped.get(key);
      if (prior) prior.selections.push(...structuredClone(block.selections));
      else grouped.set(key, structuredClone(block));
    }
  } else {
    for (const block of feed?.blocks || []) {
      const selections = block.records.flatMap((record) => {
        if (
          !ids.includes(record.feedKey) ||
          !record.selectable ||
          !record.candidateId ||
          !record.candidateVersionId
        )
          return [];
        const decision = initialDraft(record).decision;
        return [
          {
            selectionReviewToken: record.selectionReviewToken,
            recordId: record.id,
            candidateId: record.candidateId,
            candidateVersionId: record.candidateVersionId,
            mapping: decision.mapping,
            comparisons: decision.comparisons,
          },
        ];
      });
      if (!selections.length) continue;
      const key = JSON.stringify([block.intakeId, block.proposalId]);
      const prior = grouped.get(key);
      if (prior) prior.selections.push(...selections);
      else
        grouped.set(key, {
          intakeId: block.intakeId,
          proposalId: block.proposalId,
          intakeVersion: block.intakeVersion,
          reviewToken: block.reviewToken,
          selections,
        });
    }
  }
  const selected = new Set(ids);
  const blocks = [...grouped.values()]
    .map((block) => ({
      ...block,
      selections: block.selections.filter((selection) =>
        selected.has(
          JSON.stringify([block.intakeId, selection.candidateId, selection.candidateVersionId]),
        ),
      ),
    }))
    .filter((block) => block.selections.length);
  const sent = new Set(
    blocks.flatMap((block) =>
      block.selections.map((selection) =>
        JSON.stringify([block.intakeId, selection.candidateId, selection.candidateVersionId]),
      ),
    ),
  );
  const unsent: UnsentSelection[] = ids
    .filter((id) => !sent.has(id))
    .map((id) => ({
      id,
      label: shown.get(id)?.title || 'Record in retained report',
      reason: shown.has(id)
        ? shown.get(id)!.selectable
          ? 'No current approval was available. Review this record, then select it again.'
          : 'This record needs review before it can be saved.'
        : 'This record is no longer on the displayed page. Return to it and approve its current version.',
    }));
  const chunks: IntakeReportAcceptanceBlock[][] = [];
  let chunk: IntakeReportAcceptanceBlock[] = [];
  let count = 0;
  for (const block of blocks) {
    for (const selection of block.selections) {
      const last = chunk.at(-1);
      const newBlock =
        !last || last.intakeId !== block.intakeId || last.proposalId !== block.proposalId;
      if (count === 200 || (count && chunk.length === 100 && newBlock)) {
        chunks.push(chunk);
        chunk = [];
        count = 0;
      }
      const tail = chunk.at(-1);
      if (tail && tail.intakeId === block.intakeId && tail.proposalId === block.proposalId)
        tail.selections.push(selection);
      else chunk.push({ ...block, selections: [selection] });
      count++;
    }
  }
  if (chunk.length) chunks.push(chunk);
  return { chunks, sent, unsent };
}
