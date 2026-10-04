import { useEffect, useRef, useState } from 'react';
import type {
  IntakeClinicalRecordRead,
  IntakeClinicalReviewContext,
} from '../../../shared/intake-clinical-review';
import { readSelectedClinicalReview } from '../../data/intake-clinical-review';
import { useProfile } from '../../data/profile';
import { ClinicalReviewReference } from './ClinicalReviewPages';
import { useReportAcceptance } from './useReportAcceptance';
import { ImportSaveStatus } from '../import/ImportSaveStatus';
import { ReviewDraftHistory } from './ReviewDraftHistory';
import { ReferencedClinicalControls } from './ReferencedClinicalControls';

export function ReferencedClinicalRecord({
  context,
  record,
  onRefresh,
  onChanged,
  onBack,
  onPendingChange,
  authorityUnavailable = false,
}: {
  context: IntakeClinicalReviewContext;
  record: Extract<IntakeClinicalRecordRead['record'], { kind: 'reference' }>;
  onRefresh: () => void;
  onChanged: () => void;
  onBack: () => void;
  onPendingChange?: (pending: boolean) => void;
  authorityUnavailable?: boolean;
}) {
  const profile = useProfile();
  const scope = JSON.stringify([
    profile?.id,
    context.intakeId,
    context.proposalId,
    record.selection,
    record.reference,
  ]);
  const active = useRef(scope);
  active.current = scope;
  const [inspected, setInspected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [controlsPending, setControlsPending] = useState(false);
  useEffect(() => {
    setInspected(false);
    setBusy(false);
    setError('');
    setNotice('');
    return () => {
      active.current = '';
    };
  }, [scope]);
  const acceptance = useReportAcceptance(profile?.id || '', (result) => {
    if (active.current !== scope) return;
    const saved = result.receipt.receipts.some(
      (block) =>
        block.intakeId === context.intakeId &&
        block.proposalId === context.proposalId &&
        block.records.some(
          (row) =>
            row.recordId === record.selection.recordId &&
            row.candidateVersionId === record.selection.candidateVersionId,
        ),
    );
    setNotice(
      saved ? 'This exact record was saved to your profile.' : 'This record still needs review.',
    );
    if (saved) {
      setInspected(false);
      onRefresh();
      onChanged();
    }
  });
  const disabled =
    authorityUnavailable ||
    busy ||
    controlsPending ||
    !inspected ||
    !record.policy.canAcceptUnchanged ||
    !!context.sourceTextStale ||
    acceptance.busy ||
    acceptance.recovering ||
    !!acceptance.recoveryOperationId;
  async function save() {
    if (disabled || !profile) return;
    setBusy(true);
    setError('');
    try {
      const fresh = await readSelectedClinicalReview(
        context.intakeId,
        context.proposalId,
        record.selection.recordId,
        record.selection.candidateVersionId,
      );
      if (active.current !== scope) return;
      if (
        fresh.record.kind !== 'reference' ||
        fresh.record.reference.reviewToken !== record.reference.reviewToken ||
        fresh.record.selection.selectionReviewToken !== record.selection.selectionReviewToken ||
        !fresh.record.policy.canAcceptUnchanged ||
        fresh.context.sourceTextStale
      )
        throw new Error('This exact evidence changed. Refresh and read its pages before saving.');
      const selection = fresh.record.selection;
      if (
        !selection.candidateId ||
        !selection.candidateVersionId ||
        !selection.selectionReviewToken
      )
        throw new Error('The exact acceptance authority is not ready. Refresh this review.');
      await acceptance.submit({
        mode: 'partial-v1',
        operationId: crypto.randomUUID(),
        blocks: [
          {
            intakeId: context.intakeId,
            proposalId: context.proposalId,
            intakeVersion: fresh.context.version,
            reviewToken: fresh.context.reviewToken,
            selections: [
              {
                recordId: selection.recordId,
                candidateId: selection.candidateId,
                candidateVersionId: selection.candidateVersionId,
                selectionReviewToken: selection.selectionReviewToken,
                mapping: {},
                useRetainedDecision: true,
              },
            ],
          },
        ],
      });
    } catch (cause) {
      if (active.current === scope)
        setError(cause instanceof Error ? cause.message : 'This exact save could not complete.');
    } finally {
      if (active.current === scope) setBusy(false);
    }
  }
  return (
    <section aria-label="Review referenced record" className="import-detail">
      <button
        type="button"
        className="text-link"
        disabled={busy || controlsPending}
        onClick={onBack}
      >
        Back to Import
      </button>
      <h2>Review exact {record.policy.kind} evidence</h2>
      <p>
        The complete saved clinical draft is retained. Open every evidence page before accepting
        this record.
      </p>
      {record.ownershipBlockers && (
        <p>
          {record.ownershipBlockers.count.toLocaleString()} person assignment requirements remain.
          Select Person assignment requirements in the record controls to inspect the complete
          retained evidence.
        </p>
      )}
      {record.reportGroups && (
        <p>
          {record.reportGroups.count.toLocaleString()} retained report links belong to this record.
          Select Linked reports in the record controls to inspect the complete list.
        </p>
      )}
      {context.sourceTextStale && (
        <p role="alert">
          Source text changed. Read the corrected source before accepting this record.
        </p>
      )}
      {(error || acceptance.error) && <p role="alert">{error || acceptance.error}</p>}
      {notice && <p role="status">{notice}</p>}
      <ClinicalReviewReference
        intakeId={context.intakeId}
        proposalId={context.proposalId}
        reference={record.reference}
        onRefresh={() => {
          if (!controlsPending) onRefresh();
        }}
        onInspected={setInspected}
      />
      <ReviewDraftHistory history={record.draftHistory} />
      <ReferencedClinicalControls
        disabled={authorityUnavailable}
        context={context}
        selection={record.selection}
        onRefresh={onRefresh}
        onPending={(pending) => {
          setControlsPending(pending);
          onPendingChange?.(pending);
        }}
      />
      {!record.policy.canAcceptUnchanged && (
        <p role="status">
          This record needs{' '}
          {record.policy.blockingIssueCount
            ? `${record.policy.blockingIssueCount} blocking questions resolved`
            : record.policy.unreviewedPairChoices
              ? 'its related record decisions reviewed'
              : 'additional clinical review'}{' '}
          before acceptance.
        </p>
      )}
      <ImportSaveStatus
        pendingOperation={!!acceptance.recoveryOperationId}
        saving={acceptance.busy}
        checking={acceptance.recovering}
        canRetry={!!acceptance.pending}
        onCheck={() => void acceptance.checkReceipt()}
        onRetry={() => void acceptance.retry()}
      />
      <button
        type="button"
        className="button primary"
        disabled={disabled}
        onClick={() => void save()}
      >
        Save reviewed clinical record
      </button>
    </section>
  );
}
