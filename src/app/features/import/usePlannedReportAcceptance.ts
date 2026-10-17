import { useEffect, useRef, useState } from 'react';
import type {
  IntakeReportAcceptanceBlock,
  IntakeReportAcceptancePlan,
  IntakeReportAcceptanceReceipt,
  IntakeReportAcceptanceResult,
  IntakePartialAcceptanceReceipt,
} from '../../../shared/intake';
import { api } from '../../data/api';
import { currentProfile } from '../../data/profile';
import { useReportAcceptance } from '../intake/useReportAcceptance';
import {
  combinePartialReceipts,
  stoppedChildSelections,
  type UnsentSelection,
} from './partial-save-plan';

export interface UnknownSelection extends UnsentSelection {
  operationId: string;
}

/** Planning never approves new values. Each issued child retains its own recovery UUID. */
export function usePlannedReportAcceptance(
  profileId: string,
  onConfirmed: (result: IntakeReportAcceptanceResult) => void,
) {
  const [receipt, setReceipt] = useState<IntakeReportAcceptanceReceipt | null>(null);
  const [unsent, setUnsent] = useState<UnsentSelection[]>([]);
  const [unknown, setUnknown] = useState<UnknownSelection[]>([]);
  const receipts = useRef<IntakePartialAcceptanceReceipt[]>([]);
  const running = useRef<object | null>(null);
  const issuedViews = useRef(new Map<string, () => boolean>());
  const generation = useRef(0);
  const activeProfile = useRef(profileId);
  activeProfile.current = profileId;
  const acceptance = useReportAcceptance(profileId, (result) => {
    if (activeProfile.current !== profileId) return;
    const issuedView = issuedViews.current.get(result.receipt.operationId);
    issuedViews.current.delete(result.receipt.operationId);
    setUnknown((prior) => prior.filter((item) => item.operationId !== result.receipt.operationId));
    if (result.receipt.atomic) setReceipt(result.receipt);
    else {
      receipts.current = [
        ...receipts.current.filter((item) => item.operationId !== result.receipt.operationId),
        result.receipt,
      ];
      setReceipt(combinePartialReceipts(receipts.current));
    }
    // The original receipt remains evidence even after its feed window changes.
    // Selection marks and notices, however, belong only to the view that approved it.
    if (!issuedView || issuedView()) onConfirmed(result);
  });
  useEffect(() => {
    generation.current++;
    setReceipt(null);
    setUnsent([]);
    setUnknown([]);
    receipts.current = [];
    issuedViews.current.clear();
    running.current = null;
    return () => {
      generation.current++;
    };
  }, [profileId]);
  async function save(
    blocks: IntakeReportAcceptanceBlock[],
    {
      current = () => activeProfile.current === profileId,
      unsent: omitted = [],
      operationId,
      onProgress,
    }: {
      current?: () => boolean;
      unsent?: UnsentSelection[];
      operationId?: string;
      onProgress?: (completed: number, total: number) => void;
    } = {},
  ) {
    const selected = currentProfile();
    if (
      !profileId ||
      selected?.id !== profileId ||
      selected.locked ||
      running.current ||
      acceptance.hasUnconfirmedOperation() ||
      acceptance.busy ||
      acceptance.recovering ||
      acceptance.recoveryOperationId
    )
      return [];
    const run = {};
    const startedGeneration = generation.current;
    const sameGeneration = () =>
      generation.current === startedGeneration && activeProfile.current === profileId;
    const live = () => sameGeneration() && current() && currentProfile()?.id === profileId;
    running.current = run;
    try {
      setReceipt(null);
      receipts.current = [];
      issuedViews.current.clear();
      setUnknown([]);
      setUnsent(omitted);
      if (!blocks.length) return [];
      const results: IntakeReportAcceptanceResult[] = [];
      let plan: IntakeReportAcceptancePlan;
      try {
        plan = (
          await api<IntakeReportAcceptancePlan>(
            `/api/profiles/${encodeURIComponent(profileId)}/intakes/report-acceptance-plan`,
            {
              method: 'POST',
              body: JSON.stringify({ blocks }),
              operationId,
            },
          )
        ).data;
      } catch (cause) {
        if (live())
          setUnsent([
            ...omitted,
            ...stoppedChildSelections([blocks]).map((item) => ({
              ...item,
              reason:
                'Not sent because save planning could not complete. Review the error before trying again.',
            })),
          ]);
        throw cause;
      }
      if (!live()) return results;
      const excluded = plan.unsent.map((item) => ({
        id: JSON.stringify([item.intakeId, item.candidateId, item.candidateVersionId]),
        label: item.label || 'Record in retained report',
        reason: item.message,
      }));
      setUnsent([...omitted, ...excluded]);
      for (const [index, chunk] of plan.chunks.entries()) {
        if (!live()) break;
        const childId = crypto.randomUUID();
        issuedViews.current.set(childId, live);
        const result = await acceptance.submit(
          {
            mode: 'partial-v1',
            operationId: childId,
            blocks: chunk,
            plan: { id: plan.planId, chunk: index },
          },
          operationId,
        );
        if (!sameGeneration()) break;
        if (!result) {
          const unconfirmed = acceptance.hasUnconfirmedOperation(childId);
          if (!unconfirmed) issuedViews.current.delete(childId);
          const remaining = stoppedChildSelections(plan.chunks.slice(index + 1)).map((item) =>
            unconfirmed
              ? item
              : {
                  ...item,
                  reason:
                    'Not sent because an earlier save was refused. Review the current selection before continuing.',
                },
          );
          const issued = stoppedChildSelections([chunk]);
          if (unconfirmed)
            setUnknown(
              issued.map((item) => ({
                ...item,
                operationId: childId,
                reason:
                  'Checking save status. This selection may have saved; check the original operation before continuing.',
              })),
            );
          setUnsent([
            ...omitted,
            ...excluded,
            ...remaining,
            ...(!unconfirmed
              ? issued.map((item) => ({
                  ...item,
                  reason:
                    'This save was refused before a durable receipt was available. Review the error and approve again.',
                }))
              : []),
          ]);
          break;
        }
        results.push(result);
        if (!live()) {
          setUnsent([
            ...omitted,
            ...excluded,
            ...stoppedChildSelections(plan.chunks.slice(index + 1)).map((item) => ({
              ...item,
              reason:
                'Not sent because the review view changed. Review the current selection before continuing.',
            })),
          ]);
          break;
        }
        onProgress?.(index + 1, plan.chunks.length);
      }
      return results;
    } finally {
      if (running.current === run) running.current = null;
    }
  }
  return { ...acceptance, save, receipt, unsent, unknown };
}
