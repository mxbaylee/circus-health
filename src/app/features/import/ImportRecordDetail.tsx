import { detailUrl, ImportFileDetails } from './ImportReviewContext';
import {
  readSelectedClinicalReview,
  type SelectedClinicalReview,
} from '../../data/intake-clinical-review';
import { useSelectedClinicalReview } from '../intake/useSelectedClinicalReview';
import { ClinicalReviewSections } from '../intake/ClinicalReviewPages';
import { ReferencedClinicalRecord } from '../intake/ReferencedClinicalRecord';
import { ReferencedClinicalControls } from '../intake/ReferencedClinicalControls';
import { ReviewDraftHistory } from '../intake/ReviewDraftHistory';
import { QuestionAnswerHistory } from '../intake/QuestionAnswerHistory';
import {
  intakeFilenameDisplay,
  isIntakePackageHeader,
  isReferencedIntakeSummary,
  type IntakePublicRead,
  type IntakeHeader,
} from '../../../shared/intake-summary';
import {
  mappingFields,
  recordCorrectionFields,
  type EditableKind,
} from './import-correction-fields';
import { beginClientOperation } from '../../data/import-performance';
import type { ClientOperationSummary } from '../../../shared/import-performance';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import type {
  Intake,
  IntakeAcceptedRecord,
  IntakeClinicalMapping,
  IntakeEvidenceComparison,
  IntakeMappingRule,
  IntakeMetadata,
  IntakeReportAcceptanceReceipt,
  IntakeReportAcceptanceBlock,
  IntakeReportQueueBlock,
  IntakeReviewDecision,
  IntakeReviewRecord,
} from '../../../shared/intake';
import type {
  IntakeRelatedRecordsResult,
  RelatedRecordSearch,
} from '../../../shared/clinical-review';
import type {
  RecordCorrectionApplyRequest,
  RecordCorrectionApplyResult,
  RecordCorrectionPreview,
  RecordCorrectionRequest,
} from '../../../shared/record-correction';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import { OpticalPrescriptionEditor } from '../../components/OpticalPrescriptionEditor';
import { OpticalPrescriptionPreview } from '../../components/OpticalPrescriptionPreview';
import { api, ApiError, useResource } from '../../data/api';
import { useProfile } from '../../data/profile';
import {
  comparisonDecisionsNeedReview,
  RelatedRecordReview,
} from '../clinical-review/RelatedRecordReview';
import {
  RecordCorrectionDialog,
  type CorrectionSupportingChoice,
} from '../clinical-review/RecordCorrectionDialog';
import { PackageInventory } from '../intake/PackageInventory';
import {
  IntakeMetadataEditor,
  type IntakeMetadataSuggestions,
  RecordText,
  ReviewIssue,
  ReviewLayout,
  ReviewNavigationGuard,
  groupReviewIssues,
  intakeEvidencePage,
  reviewRecordTitle,
} from '../intake/ReviewWorkspace';
import { SourceTextReview } from '../intake/SourceTextReview';
import { useReportAcceptance } from '../intake/useReportAcceptance';
import { initialDraft, type LocalReviewDraft, useReviewDrafts } from '../intake/useReviewDrafts';
import { ownRevisionTransition, sameReviewValue } from '../intake/review-draft-pair-scope';
import { ImportSaveStatus } from './ImportSaveStatus';
import { ImportRecordCorrection } from './ImportRecordCorrection';
import { loadAcceptedRecordsForScope, SavedRecordDestinations } from './SavedRecordDestinations';
import '../intake/intake.css';
import '../intake/intake-guided.css';

export interface InlineRecordApproval {
  intakeId: string;
  proposalId: string | null;
  recordId: string;
  approve: (fresh: SelectedClinicalReview) => IntakeReportAcceptanceBlock | null;
}

const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Unable to complete this import review action.';

const visibleMetadata = (intake: IntakeHeader): IntakeMetadata => ({
  source: intake.metadata ? intake.metadata.source : intake.provider || null,
  careArea: intake.metadata?.careArea ?? null,
  documentType: intake.metadata?.documentType ?? null,
  topics: intake.metadata?.topics ?? [],
});

const sameMetadata = (left: IntakeMetadata, right: IntakeMetadata) =>
  JSON.stringify({
    source: left.source,
    careArea: left.careArea,
    documentType: left.documentType,
    topics: left.topics,
  }) ===
  JSON.stringify({
    source: right.source,
    careArea: right.careArea,
    documentType: right.documentType,
    topics: right.topics,
  });

function MetadataSummary({ metadata }: { metadata: IntakeMetadata }) {
  return (
    <dl className="intake-source-identity">
      <div>
        <dt>Source</dt>
        <dd>{metadata.source || 'Not set'}</dd>
      </div>
      <div>
        <dt>Care area</dt>
        <dd>{metadata.careArea || 'Not set'}</dd>
      </div>
      <div>
        <dt>Document type</dt>
        <dd>{metadata.documentType || 'Not set'}</dd>
      </div>
      <div>
        <dt>Topics</dt>
        <dd>{metadata.topics.join(', ') || 'None'}</dd>
      </div>
    </dl>
  );
}

function MappingSummary({ mapping }: { mapping: IntakeClinicalMapping }) {
  return (
    <dl className="intake-source-identity">
      {Object.entries(mapping).map(([field, value]) => (
        <div key={field}>
          <dt>{field}</dt>
          <dd>{typeof value === 'string' ? value || 'Not set' : JSON.stringify(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DraftSummary({ draft }: { draft: LocalReviewDraft }) {
  return (
    <div>
      <p>
        Disposition: <strong>{draft.disposition.replaceAll('_', ' ')}</strong> · decision:{' '}
        <strong>{draft.decision.action}</strong>
      </p>
      <MappingSummary mapping={draft.decision.mapping} />
      <p>
        Related-record decisions:{' '}
        {draft.decision.comparisons?.length
          ? draft.decision.comparisons
              .map((choice) => `${choice.outcome}: ${choice.reason || 'No reason supplied'}`)
              .join(' · ')
          : 'None'}
      </p>
      {draft.resolutionsReference && (
        <>
          <p>
            {draft.resolutionsReference.count.toLocaleString()} saved question decisions remain
            referenced in this draft. The entries below show only decisions edited in this open
            review.
          </p>
          <ReviewDraftHistory history={draft.history} />
        </>
      )}
      <p>
        {draft.resolutionsReference ? 'Decisions shown in this review' : 'Issue resolutions'}:{' '}
        {draft.resolutions.length
          ? draft.resolutions
              .map((resolution) => `${resolution.issueId}: ${resolution.outcome}`)
              .join(' · ')
          : 'None'}
      </p>
      <p>
        Saved answers:{' '}
        {Object.entries(draft.answers).length
          ? Object.entries(draft.answers)
              .map(([question, answer]) => `${question}: ${answer || 'Blank'}`)
              .join(' · ')
          : 'None'}
      </p>
      <p>Reusable mapping rule: {draft.decision.rememberRule ? 'Included' : 'None'}</p>
    </div>
  );
}

function reusableRule(
  record: IntakeReviewRecord,
  mapping: IntakeClinicalMapping,
): IntakeMappingRule {
  const kind = mapping.kind as EditableKind;
  const safe =
    kind === 'observation'
      ? { testLabel: mapping.testLabel }
      : kind === 'procedure'
        ? { procedureLabel: mapping.procedureLabel, procedureCategory: mapping.procedureCategory }
        : kind === 'medication'
          ? { medicationName: mapping.medicationName }
          : kind === 'document'
            ? { documentTitle: mapping.documentTitle }
            : {};
  return {
    match: { kind, label: record.mapping.label || record.title },
    set: Object.fromEntries(Object.entries(safe).filter(([, value]) => value)),
  };
}

function originalSourceFileId(record: IntakeReviewRecord, intake: IntakeHeader) {
  for (const evidence of record.evidence) {
    const match = evidence.contentUrl?.match(/\/api\/sources\/([^/?#]+)\/content(?:[?#]|$)/);
    if (match)
      try {
        return decodeURIComponent(match[1]);
      } catch {
        // Fall through to the guarded intake fallback.
      }
  }
  return isIntakePackageHeader(intake) ? null : intake.id;
}

/** Keep shared context mounted while a selected draft is pending, including portal event paths. */
function GuardedReviewContext({ blocked, children }: { blocked: boolean; children: ReactNode }) {
  if (!children) return null;
  return (
    <fieldset
      disabled={blocked}
      inert={blocked}
      style={{ border: 0, margin: 0, padding: 0 }}
      onClickCapture={(event) => {
        if (
          blocked &&
          !(
            event.target instanceof Element && event.target.closest('[data-review-context-dismiss]')
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDownCapture={(event) => {
        if (
          blocked &&
          event.key !== 'Escape' &&
          !(
            event.target instanceof Element && event.target.closest('[data-review-context-dismiss]')
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {children}
    </fieldset>
  );
}

export function ImportRecordDetail({
  embedded = false,
  contextPending = false,
  guardNavigation = true,
  beforeCloseRef,
  reviewApprovalRef,
  groupId,
  block,
  recordId,
  savedDestination,
  identityPanel,
  identityRevision,
  sourcePanel,
  commonIdentityIssueIds,
  sourceError,
  contextError,
  onRetryContext,
  onBack,
  onChanged,
  onUseSource,
}: {
  embedded?: boolean;
  contextPending?: boolean;
  guardNavigation?: boolean;
  beforeCloseRef?: RefObject<(() => Promise<boolean>) | null>;
  reviewApprovalRef?: RefObject<InlineRecordApproval | null>;
  groupId: string;
  block: Pick<IntakeReportQueueBlock, 'intakeId' | 'proposalId'>;
  recordId: string;
  savedDestination?: IntakeAcceptedRecord;
  identityPanel: ReactNode;
  identityRevision: number;
  sourcePanel: ReactNode;
  commonIdentityIssueIds: Set<string>;
  sourceError: string;
  contextError?: string;
  onRetryContext?: () => void;
  onBack: () => void;
  onChanged: () => void;
  onUseSource: (groupId: string, source: string) => void;
}) {
  const profile = useProfile();
  const detailScope = JSON.stringify([
    profile?.id || '',
    groupId,
    block.intakeId,
    block.proposalId,
    recordId,
  ]);
  const activeDetailScope = useRef(detailScope);
  activeDetailScope.current = detailScope;
  const activeProfile = useRef(profile?.id);
  activeProfile.current = profile?.id;
  const intake = useResource<IntakePublicRead>(`/intakes/${encodeURIComponent(block.intakeId)}`);
  const review = useSelectedClinicalReview(block.intakeId, block.proposalId, recordId);
  const identityReviewScope = JSON.stringify([
    profile?.id || '',
    block.intakeId,
    block.proposalId,
    recordId,
  ]);
  const observedIdentityRevision = useRef({
    scope: identityReviewScope,
    revision: identityRevision,
  });
  const authorityUnavailable =
    review.loading ||
    !!review.error ||
    intake.loading ||
    !!intake.refreshing ||
    !!intake.error ||
    !!contextError;
  const drafts = useReviewDrafts(
    profile?.id || '',
    () => {
      review.reload();
      intake.reload();
      onChanged();
    },
    { retainedComparisons: !!review.selected?.native },
  );
  const [recentAcceptance, setRecentAcceptance] = useState<{
    scope: string;
    record: IntakeReportAcceptanceReceipt['receipts'][number]['records'][number];
  }>();
  const [selectedControlsPending, setSelectedControlsPending] = useState(false);
  const recentDestination =
    recentAcceptance?.scope === detailScope ? recentAcceptance.record : undefined;
  const acceptance = useReportAcceptance(profile?.id || '', (result) => {
    if (activeDetailScope.current !== detailScope) return;
    const receipt = result.receipt.receipts.find(
      (item) =>
        item.intakeId === block.intakeId &&
        item.proposalId === block.proposalId &&
        item.records.some((accepted) => accepted.recordId === recordId),
    );
    const acceptedRecord = receipt?.records.find((item) => item.recordId === recordId);
    setRecentAcceptance(
      acceptedRecord ? { scope: detailScope, record: acceptedRecord } : undefined,
    );
    setError('');
    const saved = receipt?.records.some((item) => item.recordId === recordId);
    const failure = !result.receipt.atomic
      ? result.receipt.items.find(
          (item) =>
            item.intakeId === block.intakeId &&
            item.proposalId === block.proposalId &&
            item.recordId === recordId,
        )
      : null;
    setNotice(saved ? 'This exact record was saved to your profile.' : '');
    if (!saved) setError(failure?.message || 'This record needs review before saving.');
    review.reload();
    intake.reload();
    onChanged();
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [metadataError, setMetadataError] = useState('');
  const [metadataNotice, setMetadataNotice] = useState('');
  const [metadataDirty, setMetadataDirty] = useState(false);
  const [metadataEditorRevision, setMetadataEditorRevision] = useState(0);
  const [metadataConflict, setMetadataConflict] = useState<{
    intake: Intake;
    requested: IntakeMetadata;
  } | null>(null);
  const metadataOperation = useRef<{
    profileId: string;
    intakeId: string;
    scope: string;
    body: string;
    requested: IntakeMetadata;
  } | null>(null);
  const metadataPendingRef = useRef(false);
  metadataPendingRef.current =
    metadataDirty || !!metadataOperation.current || !!metadataConflict || metadataBusy;
  const answerOperations = useRef(new Map<string, string>());

  useEffect(() => {
    drafts.clearPairCommits();
    metadataOperation.current = null;
    setMetadataBusy(false);
    setMetadataError('');
    setMetadataNotice('');
    setMetadataDirty(false);
    setMetadataConflict(null);
  }, [detailScope]);

  useEffect(() => {
    if (review.data && review.record) drafts.hydrateRecords(review.data, [review.record]);
  }, [review.data, review.record]);
  useEffect(() => {
    const previous = observedIdentityRevision.current;
    observedIdentityRevision.current = { scope: identityReviewScope, revision: identityRevision };
    // The selected-review hook already fetches on mount and exact selection changes.
    if (
      previous.scope === identityReviewScope &&
      previous.revision !== identityRevision &&
      identityRevision > 0
    )
      review.reload();
  }, [identityReviewScope, identityRevision, review.reload]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!metadataPendingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const record = review.record;
  const draft = record && review.data ? drafts.current(review.data, record) : null;
  const decision = draft?.decision;
  const blocked =
    !!record &&
    !!draft &&
    (record.issues?.some(
      (issue) =>
        issue.blocking &&
        issue.status !== 'resolved' &&
        !draft.resolutions.some(
          (resolution) => resolution.issueId === issue.id && resolution.outcome !== 'unknown',
        ),
    ) ||
      false);
  // The exact receipt is authoritative before a background review refresh catches up.
  // Scope and candidate pins prevent it from finalizing another profile or version.
  const accepted =
    record?.reviewState === 'accepted' ||
    !!(
      recentDestination &&
      recentDestination.recordId === recordId &&
      recentDestination.candidateId === record?.candidateId &&
      recentDestination.candidateVersionId === record?.candidateVersionId
    );
  const finalized = accepted || record?.reviewState === 'kept_original';
  const [durableDestination, setDurableDestination] = useState<IntakeAcceptedRecord>();
  const [destinationError, setDestinationError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setDurableDestination(undefined);
    setDestinationError('');
    if (!intake.data || !accepted) return;
    void loadAcceptedRecordsForScope(
      block.intakeId,
      { groupId, proposalId: block.proposalId, recordIds: [recordId] },
      intake.data,
    )
      .then((records) => {
        if (!cancelled) setDurableDestination(records[0]);
      })
      .catch(() => {
        if (!cancelled)
          setDestinationError(
            'Saved record links could not load. Your saved records are unchanged.',
          );
      });
    return () => {
      cancelled = true;
    };
  }, [intake.data, accepted, block.intakeId, block.proposalId, groupId, recordId]);
  const destination = recentDestination || savedDestination || durableDestination;
  const metadataSuggestions = useMemo<IntakeMetadataSuggestions>(() => {
    const collected = {
      source: new Set<string>(),
      careArea: new Set<string>(),
      documentType: new Set<string>(),
      topics: new Set<string>(),
    };
    for (const item of record ? [record] : [])
      for (const issue of item.issues || []) {
        const suggestion = issue.metadataSuggestion;
        if (!suggestion) continue;
        if (suggestion.careArea) collected.careArea.add(suggestion.careArea);
        if (suggestion.documentType) collected.documentType.add(suggestion.documentType);
        for (const topic of suggestion.topics || []) collected.topics.add(topic);
      }
    return Object.fromEntries(
      Object.entries(collected).map(([field, values]) => [field, [...values]]),
    ) as unknown as IntakeMetadataSuggestions;
  }, [review.data]);
  const acceptanceBlocked =
    !!acceptance.recoveryOperationId || acceptance.recovering || !!review.data?.sourceTextStale;
  // Approval must use the review the person can see after their own write.
  // Otherwise an answer/autosave acknowledgement races its resource refresh.
  const canSave =
    !authorityUnavailable &&
    !contextPending &&
    !selectedControlsPending &&
    !review.loading &&
    !drafts.pending() &&
    !drafts.error &&
    !!review.data &&
    review.data.version >= (drafts.version(block.intakeId) || 0) &&
    !!record &&
    !!decision &&
    draft?.disposition === 'pending' &&
    !finalized &&
    !blocked &&
    !!mappingFields[decision.mapping.kind as EditableKind] &&
    !decision.comparisons?.some((pair) => !pair.reason.trim()) &&
    !comparisonDecisionsNeedReview(record, decision);

  async function perform(
    action: (operationId: string) => Promise<void>,
    kind: ClientOperationSummary['kind'] = 'review_action',
  ) {
    if (busy || authorityUnavailable || contextPending) return;
    const operation = beginClientOperation(kind, { selected: 1, actions: 1 });
    const started = performance.now();
    let outcome: ClientOperationSummary['outcome'] = 'completed';
    setBusy(true);
    setError('');
    try {
      await action(operation.operationId);
    } catch (cause) {
      outcome = 'failed';
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      operation.phase('action_work', started);
      operation.afterRender(outcome);
    }
  }

  async function answer(questionId: string, value: string) {
    if (!review.data || !value.trim()) return;
    await perform(async () => {
      if (!(await drafts.flush())) throw new Error('Save the current review draft first.');
      const key = `${review.data!.version}:${questionId}:${value}`;
      if (!answerOperations.current.has(key))
        answerOperations.current.set(
          key,
          JSON.stringify({
            version: drafts.version(block.intakeId) || review.data!.version,
            operationId: crypto.randomUUID(),
            questionId,
            answer: value,
          }),
        );
      const answered = await api<Intake>(`/intakes/${encodeURIComponent(block.intakeId)}/answers`, {
        method: 'POST',
        body: answerOperations.current.get(key),
      });
      drafts.observe(answered.data);
      answerOperations.current.delete(key);
      review.reload();
      intake.reload();
      onChanged();
      setNotice('Answer saved. The clinical record is still waiting for explicit acceptance.');
    });
  }

  async function disposition(next: 'pending' | 'review_later' | 'keep_original_only') {
    if (!review.data || !record || !draft) return;
    if (!(await flushPendingReview())) return;
    drafts.update(review.data, record, {
      disposition: next,
      decision: {
        ...draft.decision,
        action: next === 'pending' ? 'accept' : 'skip',
        ...(next === 'keep_original_only' ? { rememberRule: undefined } : {}),
      },
    });
    if (await drafts.flush()) {
      setNotice(
        next === 'review_later'
          ? 'This record is saved for Review later.'
          : next === 'keep_original_only'
            ? 'The original is retained and this record was excluded.'
            : 'This record returned to review.',
      );
      review.reload();
      intake.reload();
      onChanged();
    }
  }

  async function sendMetadataOperation(operation: {
    profileId: string;
    intakeId: string;
    scope: string;
    body: string;
    requested: IntakeMetadata;
  }) {
    if (
      activeDetailScope.current !== operation.scope ||
      activeProfile.current !== operation.profileId
    )
      return false;
    setMetadataBusy(true);
    setMetadataError('');
    setMetadataNotice('');
    try {
      const result = await api<Intake>(
        `/api/profiles/${encodeURIComponent(operation.profileId)}/intakes/${encodeURIComponent(operation.intakeId)}/metadata`,
        { method: 'POST', body: operation.body },
      );
      if (
        activeDetailScope.current !== operation.scope ||
        activeProfile.current !== operation.profileId
      )
        return false;
      drafts.observe(result.data);
      metadataOperation.current = null;
      setMetadataConflict(null);
      setMetadataNotice('File details saved. Clinical acceptance remains separate.');
      intake.reload();
      review.reload();
      onChanged();
      return true;
    } catch (cause) {
      if (
        activeDetailScope.current !== operation.scope ||
        activeProfile.current !== operation.profileId
      )
        return false;
      if (cause instanceof ApiError && cause.status === 409) {
        metadataOperation.current = null;
        try {
          const latest = (
            await api<Intake>(
              `/api/profiles/${encodeURIComponent(operation.profileId)}/intakes/${encodeURIComponent(operation.intakeId)}`,
            )
          ).data;
          if (
            activeDetailScope.current !== operation.scope ||
            activeProfile.current !== operation.profileId
          )
            return false;
          drafts.observe(latest);
          setMetadataConflict({ intake: latest, requested: operation.requested });
          setMetadataError(
            'File details changed elsewhere. Compare the newer saved details with your reviewed details.',
          );
        } catch (refreshCause) {
          if (
            activeDetailScope.current === operation.scope &&
            activeProfile.current === operation.profileId
          )
            setMetadataError(errorMessage(refreshCause));
        }
      } else {
        if (cause instanceof ApiError && cause.status > 0 && cause.status < 500)
          metadataOperation.current = null;
        setMetadataError(
          cause instanceof ApiError && cause.status > 0 && cause.status < 500
            ? cause.message
            : 'File-details save was not confirmed. Retry the exact save before making another change.',
        );
      }
      return false;
    } finally {
      if (
        activeDetailScope.current === operation.scope &&
        activeProfile.current === operation.profileId
      )
        setMetadataBusy(false);
    }
  }

  async function saveMetadata(metadata: IntakeMetadata) {
    if (authorityUnavailable || !profile?.id || !intake.data || metadataBusy) return false;
    const scope = detailScope;
    const profileId = profile.id;
    const intakeId = block.intakeId;
    if (metadataOperation.current) {
      setMetadataError(
        'An earlier file-details save is not confirmed. Retry that exact save before making another change.',
      );
      return false;
    }
    if (!(await drafts.flush())) {
      if (activeDetailScope.current !== scope || activeProfile.current !== profileId) return false;
      setMetadataError('Save the current review draft before changing file details.');
      return false;
    }
    if (activeDetailScope.current !== scope || activeProfile.current !== profileId) return false;
    const operation = {
      profileId,
      intakeId,
      scope,
      requested: metadata,
      body: JSON.stringify({
        version: drafts.version(block.intakeId) || intake.data.version,
        operationId: crypto.randomUUID(),
        metadata: {
          source: metadata.source,
          careArea: metadata.careArea,
          documentType: metadata.documentType,
          topics: metadata.topics,
        },
      }),
    };
    metadataOperation.current = operation;
    return sendMetadataOperation(operation);
  }

  async function applyReviewedMetadata() {
    const comparison = metadataConflict;
    if (
      authorityUnavailable ||
      !comparison ||
      !profile?.id ||
      metadataBusy ||
      metadataOperation.current
    )
      return;
    const scope = detailScope;
    const profileId = profile.id;
    const intakeId = block.intakeId;
    setMetadataBusy(true);
    setMetadataError('');
    try {
      const latest = (
        await api<Intake>(
          `/api/profiles/${encodeURIComponent(profileId)}/intakes/${encodeURIComponent(intakeId)}`,
        )
      ).data;
      if (activeDetailScope.current !== scope || activeProfile.current !== profileId) return;
      if (!sameMetadata(visibleMetadata(latest), visibleMetadata(comparison.intake))) {
        drafts.observe(latest);
        setMetadataConflict({ ...comparison, intake: latest });
        setMetadataError('File details changed again. Review the newest saved details first.');
        return;
      }
      const operation = {
        profileId,
        intakeId,
        scope,
        requested: comparison.requested,
        body: JSON.stringify({
          version: latest.version,
          operationId: crypto.randomUUID(),
          metadata: comparison.requested,
        }),
      };
      metadataOperation.current = operation;
      await sendMetadataOperation(operation);
    } catch (cause) {
      if (activeDetailScope.current === scope && activeProfile.current === profileId)
        setMetadataError(errorMessage(cause));
    } finally {
      if (activeDetailScope.current === scope && activeProfile.current === profileId)
        setMetadataBusy(false);
    }
  }

  const [sourceTextPending, setSourceTextPending] = useState(false);
  const correctionPending = useRef(false);
  const [fieldCorrectionDirty, setFieldCorrectionDirty] = useState(false);
  const [sourceTextLoaded, setSourceTextLoaded] = useState(false);
  const displayedCorrectionMapping = useRef<IntakeClinicalMapping | null>(null);
  const metadataPending = () =>
    metadataDirty || !!metadataOperation.current || !!metadataConflict || metadataBusy;
  async function flushPendingReview() {
    if (contextPending) {
      setError('Retry the pending report identity or source choice before leaving.');
      return false;
    }
    if (selectedControlsPending) {
      setError('Save, retry or discard the selected record choice before leaving.');
      return false;
    }
    if (correctionPending.current) {
      setError('Update the correction, or use Close review inside the editor to discard it.');
      return false;
    }
    if (sourceTextPending) {
      setError('Save or discard the source text draft before leaving.');
      return false;
    }
    if (!(await drafts.flush())) return false;
    const operation = metadataOperation.current;
    if (operation) return sendMetadataOperation(operation);
    return !metadataPending();
  }
  useEffect(() => {
    if (!beforeCloseRef) return;
    beforeCloseRef.current = flushPendingReview;
    return () => {
      beforeCloseRef.current = null;
    };
  });

  useEffect(() => {
    if (!reviewApprovalRef || !review.data || !record || !decision) return;
    const shown = review.data;
    const shownRevision = review.selected?.revision;
    const approval: InlineRecordApproval = {
      intakeId: block.intakeId,
      proposalId: block.proposalId,
      recordId,
      approve: (fresh) => {
        if (activeDetailScope.current !== detailScope || fresh.record.kind !== 'record')
          return null;
        const current = fresh.record.record;
        const own = drafts.ownCommit(shown, record);
        // Only this editor's acknowledged write can advance unseen transport pins.
        const ownTransition =
          own &&
          Number.isSafeInteger(shownRevision) &&
          ownRevisionTransition(own, shownRevision!) &&
          own.profileId === profile?.id &&
          own.intakeId === block.intakeId &&
          own.request.proposalId === block.proposalId &&
          own.request.recordId === recordId &&
          own.candidateId === record.candidateId &&
          own.request.candidateVersionId === record.candidateVersionId &&
          own.request.version === shown.version &&
          own.version === shown.version + 1 &&
          fresh.context.version === own.version &&
          fresh.revision === own.revision &&
          current.draft?.id === own.request.operationId;
        const displayed = drafts.afterOwnSave(fresh.context, current).decision;
        const retained = initialDraft(current).decision;
        if (
          fresh.context.sourceTextStale ||
          current.id !== record.id ||
          current.candidateId !== record.candidateId ||
          current.candidateVersionId !== record.candidateVersionId ||
          (!ownTransition && current.selectionReviewToken !== record.selectionReviewToken) ||
          !sameReviewValue(displayed.mapping, decision.mapping) ||
          (embedded && !sameReviewValue(displayedCorrectionMapping.current, decision.mapping)) ||
          !sameReviewValue(retained.mapping, displayed.mapping) ||
          !sameReviewValue(retained.comparisons, displayed.comparisons) ||
          comparisonDecisionsNeedReview(current, displayed)
        )
          return null;
        return {
          intakeId: block.intakeId,
          proposalId: block.proposalId,
          intakeVersion: fresh.context.version,
          reviewToken: fresh.context.reviewToken,
          selections: [
            {
              recordId: current.id,
              candidateId: current.candidateId!,
              candidateVersionId: current.candidateVersionId!,
              selectionReviewToken: current.selectionReviewToken,
              mapping: displayed.mapping,
              comparisons: displayed.comparisons,
            },
          ],
        };
      },
    };
    reviewApprovalRef.current = approval;
    return () => {
      if (reviewApprovalRef.current === approval) reviewApprovalRef.current = null;
    };
  });

  async function save() {
    if (!profile?.id || !review.data || !record || !decision || !canSave || acceptanceBlocked)
      return;
    const scope = detailScope;
    const profileId = profile.id;
    const intakeId = block.intakeId;
    const proposalId = block.proposalId;
    const exactRecord = record;
    await perform(async (diagnosticOperationId) => {
      if (!(await flushPendingReview()))
        throw new Error('Save or discard unfinished review edits before accepting this record.');
      if (activeDetailScope.current !== scope || activeProfile.current !== profileId) return;
      let selected = await readSelectedClinicalReview(
        intakeId,
        proposalId,
        exactRecord.id,
        exactRecord.candidateVersionId,
        { operationId: diagnosticOperationId },
      );
      if (activeDetailScope.current !== scope || activeProfile.current !== profileId) return;
      let fresh = selected.context;
      let current = selected.record.kind === 'record' ? selected.record.record : undefined;
      if (
        !current?.candidateId ||
        !current.candidateVersionId ||
        current.selectionReviewToken !== exactRecord.selectionReviewToken
      )
        throw new Error('This exact record changed. Review the current proposal before saving.');
      let currentDraft = drafts.afterOwnSave(fresh, current);
      if (
        currentDraft.disposition !== 'pending' ||
        (current.draft && current.draft.disposition !== 'pending')
      )
        throw new Error('Return this record to review before saving it.');
      if (comparisonDecisionsNeedReview(current, currentDraft.decision))
        throw new Error(
          'Review both exact record versions and their originals again before choosing this relationship.',
        );
      if (selected.native && current.draft?.decision?.action === 'skip') {
        // Correcting an unsupported mapping does not grant clinical acceptance.
        // This explicit click publishes that intent through the existing queue;
        // only its newly acknowledged, unchanged revision can continue the save.
        const before = selected;
        const approval = await drafts.prepareAcceptance(fresh, current);
        if (activeDetailScope.current !== scope || activeProfile.current !== profileId) return;
        if (!approval?.commit.transition)
          throw new Error('Review the saved choices before confirming this record again.');
        const refreshed = await readSelectedClinicalReview(
          intakeId,
          proposalId,
          exactRecord.id,
          exactRecord.candidateVersionId,
          { operationId: diagnosticOperationId },
        );
        if (activeDetailScope.current !== scope || activeProfile.current !== profileId) return;
        const next = refreshed.record.kind === 'record' ? refreshed.record.record : undefined;
        const { commit } = approval;
        if (
          !approval.isCurrent() ||
          !refreshed.native ||
          !Number.isSafeInteger(before.revision) ||
          !ownRevisionTransition(commit, before.revision!) ||
          commit.profileId !== profileId ||
          commit.intakeId !== intakeId ||
          commit.request.proposalId !== proposalId ||
          commit.request.recordId !== exactRecord.id ||
          commit.candidateId !== exactRecord.candidateId ||
          commit.request.candidateVersionId !== exactRecord.candidateVersionId ||
          commit.request.version !== before.context.version ||
          commit.version !== before.context.version + 1 ||
          refreshed.revision !== commit.revision ||
          refreshed.context.version !== commit.version ||
          refreshed.context.sourceTextStale ||
          !next?.selectionReviewToken ||
          next.candidateId !== exactRecord.candidateId ||
          next.draft?.id !== commit.request.operationId ||
          next.draft.disposition !== 'pending' ||
          next.draft.decision?.action !== 'accept'
        )
          throw new Error('This exact record changed. Review the current proposal before saving.');
        selected = refreshed;
        fresh = refreshed.context;
        current = next;
        currentDraft = drafts.afterOwnSave(fresh, current, commit);
        if (comparisonDecisionsNeedReview(current, currentDraft.decision))
          throw new Error(
            'Review both exact record versions and their originals again before choosing this relationship.',
          );
      }
      if (!current.candidateId || !current.candidateVersionId)
        throw new Error('This exact record changed. Review the current proposal before saving.');
      const result = await acceptance.submit(
        {
          mode: 'partial-v1',
          operationId: crypto.randomUUID(),
          blocks: [
            {
              intakeId,
              proposalId,
              intakeVersion: fresh.version,
              reviewToken: fresh.reviewToken,
              selections: [
                {
                  selectionReviewToken: current.selectionReviewToken,
                  recordId: current.id,
                  candidateId: current.candidateId,
                  candidateVersionId: current.candidateVersionId,
                  ...(selected.native
                    ? { mapping: {}, useRetainedDecision: true }
                    : {
                        mapping: currentDraft.decision.mapping,
                        comparisons: currentDraft.decision.comparisons,
                      }),
                },
              ],
            },
          ],
        },
        diagnosticOperationId,
      );
      if (!result)
        throw new Error(
          acceptance.error || 'Save was not confirmed. Check the exact receipt before retrying.',
        );
      if (embedded && result.receipt.acceptedCount === 1) onBack();
    }, 'review_save');
  }

  if ((review.loading && !review.data) || (intake.loading && !intake.data))
    return <LoadingIndicator label="Opening record fields and evidence…" layout="centered" />;
  const refreshError = review.error?.message || intake.error?.message || contextError;
  const refreshNotice =
    (review.selected || intake.data) && authorityUnavailable ? (
      <section className="import-detail-state" role={refreshError ? 'alert' : 'status'}>
        <p>{refreshError || 'Refreshing this record’s current review…'}</p>
        {refreshError && (
          <>
            <p>
              Your open review is retained. Refresh it before making a new choice. An unconfirmed
              save can still retry its exact request.
            </p>
            <button
              className="button secondary"
              type="button"
              onClick={() => {
                review.reload();
                intake.reload();
                onRetryContext?.();
              }}
            >
              Retry exact record
            </button>
          </>
        )}
      </section>
    ) : null;
  const contextBlocked =
    authorityUnavailable ||
    selectedControlsPending ||
    drafts.pending() ||
    fieldCorrectionDirty ||
    sourceTextPending;
  const identityContextPanel = (
    <GuardedReviewContext blocked={contextBlocked}>{identityPanel}</GuardedReviewContext>
  );
  const sourceContextPanel = (
    <GuardedReviewContext blocked={contextBlocked}>{sourcePanel}</GuardedReviewContext>
  );
  if ((review.error && !review.selected) || (intake.error && !intake.data))
    return (
      <section className="import-detail-state" role="alert">
        <p>{review.error?.message || intake.error?.message}</p>
        <button
          className="button secondary"
          type="button"
          onClick={() => {
            review.reload();
            intake.reload();
            onRetryContext?.();
          }}
        >
          Retry exact record
        </button>
        <button className="text-link" type="button" onClick={onBack}>
          Back to Import
        </button>
      </section>
    );
  if (review.selected?.record.kind === 'reference')
    return (
      <>
        {refreshNotice}
        {identityContextPanel}
        {sourceContextPanel}
        <ReferencedClinicalRecord
          key={`${review.selected.record.selection.recordId}:${review.selected.record.selection.candidateVersionId}`}
          context={review.selected.context}
          record={review.selected.record}
          onRefresh={review.reload}
          onChanged={onChanged}
          onBack={onBack}
          onPendingChange={setSelectedControlsPending}
          authorityUnavailable={authorityUnavailable}
          contextPending={contextPending}
          guardNavigation={guardNavigation}
        />
        <ClinicalReviewSections intakeId={block.intakeId} proposalId={block.proposalId} />
      </>
    );
  if (!review.data || !intake.data || !record || !draft || !decision)
    return (
      <section className="import-detail-state" role="alert">
        <p>
          This exact record version is no longer current. No replacement was selected automatically.
        </p>
        <button className="button secondary" type="button" onClick={onBack}>
          Back to Import
        </button>
      </section>
    );
  if (isReferencedIntakeSummary(intake.data))
    return (
      <section className="import-detail-state" role="alert">
        <p>The selected record needs its complete source context before it can be edited.</p>
        <ImportFileDetails intakeId={block.intakeId} />
        <button className="button secondary" type="button" onClick={intake.reload}>
          Refresh exact record
        </button>
        <button className="text-link" type="button" onClick={onBack}>
          Back to Import
        </button>
      </section>
    );

  const linkedReportScope =
    record.reportGroups && !Array.isArray(record.reportGroups) ? (
      <section aria-label="Complete linked reports">
        <p>
          {record.reportGroups.count.toLocaleString()} retained report links belong to this record.
          The first link identifies a starting report; open the complete list to inspect every
          association.
        </p>
        <ReferencedClinicalControls
          guardNavigation={false}
          context={review.selected!.context}
          selection={{
            recordId: record.id,
            candidateVersionId: record.candidateVersionId,
            selectionReviewToken: record.selectionReviewToken,
          }}
          initialSection="reportGroups"
          sections={['reportGroups']}
          triggerLabel="Inspect linked reports"
          disabled={contextBlocked || busy || drafts.saving || acceptance.busy || acceptanceBlocked}
          onPending={() => {}}
          onRefresh={review.reload}
        />
      </section>
    ) : null;
  const ownershipBlockerScope = record.identityReview?.ownershipBlockers ? (
    <section aria-label="Complete person assignment requirements">
      <p>
        {record.identityReview.ownershipBlockers.count.toLocaleString()} person assignment
        requirements remain. Open their retained evidence before resolving the person review for
        this report.
      </p>
      <ReferencedClinicalControls
        guardNavigation={false}
        context={review.selected!.context}
        selection={{
          recordId: record.id,
          candidateVersionId: record.candidateVersionId,
          selectionReviewToken: record.selectionReviewToken,
        }}
        initialSection="ownershipBlockers"
        sections={['ownershipBlockers']}
        triggerLabel="Inspect person assignment requirements"
        disabled={contextBlocked || busy || drafts.saving || acceptance.busy || acceptanceBlocked}
        onPending={() => {}}
        onRefresh={review.reload}
      />
    </section>
  ) : null;
  const identityWarningScope = record.identityReview?.warningsReference ? (
    <section aria-label="Complete record identity warnings">
      <p>
        {record.identityReview.warningsReference.count.toLocaleString()} advisory warnings belong to
        this record. Inspect the complete retained warning evidence.
      </p>
      <ReferencedClinicalControls
        guardNavigation={false}
        context={review.selected!.context}
        selection={{
          recordId: record.id,
          candidateVersionId: record.candidateVersionId,
          selectionReviewToken: record.selectionReviewToken,
        }}
        initialSection="identityWarnings"
        sections={['identityWarnings']}
        triggerLabel="Inspect record identity warnings"
        disabled={contextBlocked || busy || drafts.saving || acceptance.busy || acceptanceBlocked}
        onPending={() => {}}
        onRefresh={review.reload}
      />
    </section>
  ) : null;
  const relatedReview = (
    <>
      {linkedReportScope}
      {ownershipBlockerScope}
      {identityWarningScope}
      <ImportRelatedRecordEditor
        nativeControls={
          review.selected?.native && review.selected.record.kind === 'record'
            ? (onCorrectSaved) => (
                <ReferencedClinicalControls
                  guardNavigation={false}
                  context={review.selected!.context}
                  selection={{
                    recordId: record.id,
                    candidateVersionId: record.candidateVersionId,
                    selectionReviewToken: record.selectionReviewToken,
                  }}
                  initialSection="comparisons"
                  sections={['comparisons', 'comparisonDrafts']}
                  initiallyOpen
                  incoming={{
                    title: record.title,
                    date: record.date,
                    mapping: decision.mapping,
                    evidence: record.evidence,
                  }}
                  disabled={
                    contextPending ||
                    authorityUnavailable ||
                    busy ||
                    drafts.pending() ||
                    drafts.saving ||
                    acceptance.busy ||
                    acceptanceBlocked ||
                    fieldCorrectionDirty
                  }
                  onPending={setSelectedControlsPending}
                  onRefresh={() => {
                    review.reload();
                    intake.reload();
                    onChanged();
                  }}
                  onCorrectSaved={onCorrectSaved}
                />
              )
            : undefined
        }
        record={record}
        decision={decision}
        busy={
          contextPending ||
          busy ||
          drafts.saving ||
          acceptance.busy ||
          acceptanceBlocked ||
          !!drafts.comparison ||
          fieldCorrectionDirty
        }
        onChange={(next) => drafts.update(review.data!, record, { decision: next })}
        onDiscoverRelated={(search) =>
          api<IntakeRelatedRecordsResult>(
            `/intakes/${encodeURIComponent(block.intakeId)}/related-records`,
            {
              method: 'POST',
              body: JSON.stringify({
                proposalId: block.proposalId,
                recordId: record.id,
                candidateVersionId: record.candidateVersionId,
                ...search,
              }),
            },
          ).then(({ data }) => data)
        }
        correctionSupporting={
          record.candidateId &&
          record.candidateVersionId &&
          originalSourceFileId(record, intake.data)
            ? {
                reference: {
                  intakeId: intake.data.id,
                  proposalId: review.data.proposalId,
                  recordId: record.id,
                  candidateId: record.candidateId,
                  candidateVersionId: record.candidateVersionId,
                  originalSourceFileId: originalSourceFileId(record, intake.data)!,
                },
                label: record.title,
                locator:
                  record.evidence.map((entry) => entry.locator).join(' · ') || 'Original intake',
                contentUrl:
                  record.evidence.find((entry) => entry.contentUrl)?.contentUrl ||
                  intake.data.contentUrl,
              }
            : undefined
        }
        previewCorrection={(request) =>
          api<RecordCorrectionPreview>('/clinical-review/correction-preview', {
            method: 'POST',
            body: JSON.stringify(request),
          }).then(({ data }) => data)
        }
        applyCorrection={(request) =>
          api<RecordCorrectionApplyResult>('/clinical-review/correction-apply', {
            method: 'POST',
            body: JSON.stringify(request),
          }).then(({ data }) => data)
        }
        onCorrectionApplied={() => {
          review.reload();
          intake.reload();
          onChanged();
        }}
      />
    </>
  );

  if (embedded && !finalized) {
    const fields = recordCorrectionFields(decision.mapping.kind || record.kind, record.issues);
    return (
      <section className="import-detail is-embedded is-focused-correction">
        {refreshNotice}
        {guardNavigation && (
          <ReviewNavigationGuard
            anyLocationChange
            pending={() =>
              contextPending ||
              selectedControlsPending ||
              correctionPending.current ||
              drafts.pending()
            }
            flush={flushPendingReview}
          />
        )}
        <a className="text-link" href={`#${detailUrl(groupId, block, record)}`}>
          Open full review <ArrowRight size={15} aria-hidden="true" />
        </a>
        <ReviewDraftHistory history={record.draft?.history} />
        {(error || drafts.error) && (
          <div className="import-error" role="alert">
            {error || drafts.error}
            {drafts.error && (
              <button
                className="text-link"
                type="button"
                onClick={() => void (drafts.conflict ? drafts.inspectConflict() : drafts.retry())}
              >
                {drafts.conflict ? 'Review newer saved changes' : 'Retry draft save'}
              </button>
            )}
            {drafts.error && (
              <button
                className="text-link"
                type="button"
                disabled={drafts.saving}
                onClick={async () => {
                  if (await drafts.useCurrent()) {
                    correctionPending.current = false;
                    onBack();
                  }
                }}
              >
                Discard unsaved correction and close
              </button>
            )}
          </div>
        )}
        {drafts.comparison && (
          <section aria-label="Review draft conflict" className="import-page-notice">
            <p>Newer saved fields</p>
            <DraftSummary draft={initialDraft(drafts.comparison.record)} />
            <p>Your reviewed fields</p>
            <DraftSummary draft={drafts.comparison.local} />
            <button className="button secondary" onClick={() => void drafts.useCurrent()}>
              Use newer saved fields
            </button>
            <button className="button primary" onClick={() => void drafts.reapply()}>
              Save my reviewed fields over these changes
            </button>
          </section>
        )}
        {review.data.sourceTextStale && (
          <p role="alert">
            The source text changed. Read the corrected source again before updating this record.
          </p>
        )}
        <ImportRecordCorrection
          key={`${detailScope}:${drafts.comparison ? 'conflict' : 'current'}`}
          intake={intake.data}
          record={record}
          mapping={decision.mapping}
          onDisplayedMappingChange={(mapping) => {
            displayedCorrectionMapping.current = mapping;
          }}
          fields={fields}
          disabled={
            contextPending ||
            authorityUnavailable ||
            selectedControlsPending ||
            busy ||
            drafts.saving ||
            acceptanceBlocked ||
            !!drafts.error ||
            !!drafts.comparison
          }
          onDirtyChange={(dirty) => {
            correctionPending.current = dirty;
            setFieldCorrectionDirty(dirty);
          }}
          onClose={onBack}
          onUpdate={async (patch, correctionReason) => {
            if (authorityUnavailable || contextPending) return false;
            const resolutions = (record.issues || [])
              .filter(
                (issue) =>
                  ['uncertain_reading', 'date'].includes(issue.kind) &&
                  issue.field &&
                  Object.hasOwn(patch, issue.field),
              )
              .map((issue) => ({
                issueId: issue.id,
                outcome:
                  patch[issue.field as keyof IntakeClinicalMapping] ===
                  decision.mapping[issue.field as keyof IntakeClinicalMapping]
                    ? ('confirmed' as const)
                    : ('corrected' as const),
                mapping: { [issue.field!]: patch[issue.field as keyof IntakeClinicalMapping] },
              }));
            drafts.update(review.data!, record, {
              correctionReason,
              decision: { ...decision, mapping: { ...decision.mapping, ...patch } },
              resolutions: [
                ...draft.resolutions.filter(
                  (prior) => !resolutions.some((next) => next.issueId === prior.issueId),
                ),
                ...resolutions,
              ],
            });
            const saved = await drafts.flush();
            if (activeDetailScope.current !== detailScope || activeProfile.current !== profile?.id)
              return false;
            if (saved) {
              correctionPending.current = false;
              onChanged();
            }
            return saved;
          }}
        />
        {relatedReview}
      </section>
    );
  }

  return (
    <section
      className={`import-detail${embedded ? ' is-embedded' : ''}`}
      aria-label={`Review ${reviewRecordTitle(record)}`}
    >
      {refreshNotice}
      {guardNavigation && (
        <ReviewNavigationGuard
          anyLocationChange
          pending={() =>
            contextPending ||
            selectedControlsPending ||
            drafts.pending() ||
            metadataPending() ||
            sourceTextPending
          }
          flush={flushPendingReview}
        />
      )}
      <button
        type="button"
        className="text-link import-detail-back"
        onClick={async () => {
          if (await flushPendingReview()) onBack();
        }}
      >
        <ArrowLeft size={15} aria-hidden="true" /> {embedded ? 'Close review' : 'Back to Import'}
      </button>
      {(error || sourceError || drafts.error || acceptance.error || metadataError) && (
        <div className="import-error" role="alert">
          {error || sourceError || drafts.error || acceptance.error || metadataError}
          {drafts.error &&
            (drafts.conflict ? (
              <button
                className="text-link"
                type="button"
                onClick={() => void drafts.inspectConflict()}
              >
                Review newer saved changes
              </button>
            ) : (
              <button className="text-link" type="button" onClick={() => void drafts.retry()}>
                Retry draft save
              </button>
            ))}
          {metadataOperation.current && !metadataConflict && (
            <button
              className="text-link"
              type="button"
              disabled={metadataBusy}
              onClick={() => {
                const operation = metadataOperation.current;
                if (operation) void sendMetadataOperation(operation);
              }}
            >
              Retry exact file-details save
            </button>
          )}
        </div>
      )}
      {(notice || metadataNotice) && (
        <div className="import-page-notice" role="status">
          {notice || metadataNotice}
        </div>
      )}
      <ImportSaveStatus
        pendingOperation={!!acceptance.recoveryOperationId}
        saving={acceptance.busy}
        checking={acceptance.recovering}
        canRetry={!!acceptance.pending}
        onCheck={() => void acceptance.checkReceipt()}
        onRetry={() => void acceptance.retry()}
      />
      <header className="import-detail-heading">
        <div>
          <p className="eyebrow">{embedded ? 'REVIEW ORIGINAL & RECORD' : 'EXACT RECORD REVIEW'}</p>
          <h2>{reviewRecordTitle(record, decision.mapping)}</h2>
          <p>
            {intakeFilenameDisplay(intake.data)} · {record.date || 'Date not given'}
          </p>
        </div>
      </header>
      <SavedRecordDestinations
        records={destination ? [destination] : []}
        label="Saved destination"
        error={destinationError}
        onRetry={intake.reload}
      />
      {identityContextPanel}
      {sourceContextPanel}
      {drafts.comparison && (
        <section aria-label="Review draft conflict" className="import-page-notice">
          <h3>Review newer saved changes</h3>
          <p>Newer saved fields</p>
          <DraftSummary draft={initialDraft(drafts.comparison.record)} />
          <p>Your reviewed fields</p>
          <DraftSummary draft={drafts.comparison.local} />
          <div className="intake-actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => void drafts.useCurrent()}
            >
              Use newer saved fields
            </button>
            <button className="button primary" type="button" onClick={() => void drafts.reapply()}>
              Save my reviewed fields over these changes
            </button>
          </div>
        </section>
      )}
      {metadataConflict && (
        <section aria-label="File details conflict" className="import-page-notice">
          <h3>File details changed</h3>
          <p>Newer saved file details</p>
          <MetadataSummary metadata={visibleMetadata(metadataConflict.intake)} />
          <p>Your reviewed file details</p>
          <MetadataSummary metadata={metadataConflict.requested} />
          <div className="intake-actions">
            <button
              className="button secondary"
              type="button"
              disabled={metadataBusy}
              onClick={() => {
                metadataOperation.current = null;
                setMetadataConflict(null);
                setMetadataError('');
                setMetadataDirty(false);
                setMetadataEditorRevision((revision) => revision + 1);
                setMetadataNotice('Kept the newer saved file details.');
                intake.reload();
              }}
            >
              Keep newer saved file details
            </button>
            <button
              className="button primary"
              type="button"
              disabled={metadataBusy}
              onClick={() => void applyReviewedMetadata()}
            >
              Apply my reviewed file details
            </button>
          </div>
        </section>
      )}
      <details
        className="intake-processing-details"
        onToggle={(event) => {
          if (event.currentTarget.open) setSourceTextLoaded(true);
        }}
      >
        <summary>Extracted text & corrections</summary>
        {sourceTextLoaded && (
          <SourceTextReview
            embedded
            initialPage={intakeEvidencePage(intake.data, record.evidence)}
            guardNavigation={false}
            onPendingChange={setSourceTextPending}
            intakeId={intake.data.id}
            onChanged={() => {
              intake.reload();
              onChanged();
            }}
          />
        )}
      </details>
      {review.data.sourceTextStale && (
        <p className="intake-notice" role="alert">
          Source text changed after these clinical drafts were prepared. Reread the corrected source
          before accepting them. Existing accepted versions remain intact.
        </p>
      )}
      <ReviewLayout intake={intake.data} evidence={record.evidence} sideBySide={embedded}>
        <details className="intake-processing-details">
          <summary>
            Source and file details
            {Object.values(metadataSuggestions).some((values) => values.length)
              ? ' · suggestions available'
              : ''}
          </summary>
          <p className="helper-text">
            These file-organization labels are separate from the reviewed report label above and
            from immutable acquisition and issuer evidence. Review the report label separately
            before accepting clinical records.
          </p>
          <IntakeMetadataEditor
            key={`${profile?.id || ''}:${intake.data.id}:${metadataEditorRevision}`}
            intake={intake.data}
            options={[intake.data]}
            suggestions={metadataSuggestions}
            busy={
              contextPending ||
              authorityUnavailable ||
              metadataBusy ||
              !!metadataOperation.current ||
              !!metadataConflict
            }
            onSave={saveMetadata}
            onDirtyChange={setMetadataDirty}
          />
        </details>
        <StandaloneRecordEditor
          intakeId={block.intakeId}
          onRefresh={review.reload}
          record={record}
          decision={decision}
          draft={draft}
          commonIdentityIssueIds={commonIdentityIssueIds}
          busy={
            contextPending ||
            authorityUnavailable ||
            selectedControlsPending ||
            busy ||
            drafts.saving ||
            acceptance.busy ||
            acceptanceBlocked ||
            !!drafts.comparison
          }
          onChange={(next) => drafts.update(review.data!, record, { decision: next })}
          onDraft={(patch) => drafts.update(review.data!, record, patch)}
          onAnswer={(id, value) => void answer(id, value)}
          onSuggestedSource={(source) => onUseSource(groupId, source)}
          relatedReview={relatedReview}
          onReviewLater={() => void disposition('review_later')}
        />
        <ClinicalReviewSections intakeId={block.intakeId} proposalId={block.proposalId} />
        <ReviewDraftHistory history={record.draft?.history} />
        <section className="intake-accept intake-guided-actions" aria-label="Review actions">
          <p role="status">
            {drafts.saving
              ? 'Saving your review…'
              : accepted
                ? 'This exact record is already saved to your profile.'
                : record.reviewState === 'kept_original'
                  ? 'This exact record is excluded from clinical results. Its original is kept.'
                  : draft.disposition === 'review_later'
                    ? 'Saved for Review later. Return to review before saving this clinical record.'
                    : draft.disposition === 'keep_original_only'
                      ? 'Excluded from clinical results; the original is kept. Return to review to change this choice.'
                      : blocked
                        ? 'Answer the highlighted blocking questions before saving, or choose Review later.'
                        : canSave
                          ? 'Ready for explicit clinical acceptance.'
                          : 'Finish the related-record choices before saving.'}
          </p>
          {!finalized && (
            <div>
              {draft.disposition !== 'pending' ? (
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void disposition('pending')}
                >
                  Return to review
                </button>
              ) : (
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void disposition('review_later')}
                >
                  Review later
                </button>
              )}
              <button
                className="text-link"
                type="button"
                disabled={busy}
                onClick={() => void disposition('keep_original_only')}
              >
                Exclude; keep original
              </button>
              {draft.disposition === 'pending' && (
                <button
                  className="button primary"
                  type="button"
                  disabled={
                    busy || !canSave || !!drafts.error || acceptanceBlocked || sourceTextPending
                  }
                  onClick={() => void save()}
                >
                  <Check size={16} aria-hidden="true" />{' '}
                  {busy || acceptance.busy ? 'Saving…' : 'Confirm and save record'}
                </button>
              )}
            </div>
          )}
        </section>
      </ReviewLayout>
      {isIntakePackageHeader(intake.data) && (
        <details className="intake-processing-details">
          <summary>Package and original file details</summary>
          <PackageInventory intake={intake.data} />
        </details>
      )}
    </section>
  );
}

function ImportRelatedRecordEditor({
  record,
  decision,
  busy,
  onChange,
  onDiscoverRelated,
  correctionSupporting,
  previewCorrection,
  applyCorrection,
  onCorrectionApplied,
  nativeControls,
}: {
  record: IntakeReviewRecord;
  decision: IntakeReviewDecision;
  busy: boolean;
  onChange: (next: IntakeReviewDecision) => void;
  onDiscoverRelated: (search: RelatedRecordSearch) => Promise<IntakeRelatedRecordsResult>;
  correctionSupporting?: CorrectionSupportingChoice;
  previewCorrection: (request: RecordCorrectionRequest) => Promise<RecordCorrectionPreview>;
  applyCorrection: (request: RecordCorrectionApplyRequest) => Promise<RecordCorrectionApplyResult>;
  onCorrectionApplied: (result: RecordCorrectionApplyResult) => void | Promise<void>;
  nativeControls?: (onCorrectSaved: (record: IntakeEvidenceComparison) => void) => ReactNode;
}) {
  const [correctionTarget, setCorrectionTarget] = useState<IntakeEvidenceComparison | null>(null);
  return (
    <>
      <details
        className="intake-related-disclosure"
        open={comparisonDecisionsNeedReview(record, decision)}
      >
        <summary>
          {record.comparisons?.length
            ? `Review ${record.comparisons.length} possible related saved ${record.comparisons.length === 1 ? 'record' : 'records'}`
            : 'Find possible related saved records'}
        </summary>
        {nativeControls ? (
          <section className="clinical-related-review" aria-label="Paired evidence review">
            {nativeControls(setCorrectionTarget)}
          </section>
        ) : (
          <RelatedRecordReview
            record={record}
            decision={decision}
            onChange={onChange}
            onDiscover={onDiscoverRelated}
            onCorrectSaved={(other) => setCorrectionTarget(other)}
            disabled={busy}
          />
        )}
      </details>
      {correctionTarget &&
        ['observation', 'medication', 'procedure', 'document'].includes(correctionTarget.kind) && (
          <RecordCorrectionDialog
            open
            onOpenChange={(open) => !open && setCorrectionTarget(null)}
            target={{
              kind: correctionTarget.kind as EditableKind,
              recordId: correctionTarget.id,
              title: correctionTarget.title,
              mapping: correctionTarget.mapping,
            }}
            supporting={correctionSupporting}
            previewCorrection={previewCorrection}
            applyCorrection={applyCorrection}
            onApplied={onCorrectionApplied}
            returnLabel="Return to import review"
          />
        )}
    </>
  );
}

function StandaloneRecordEditor({
  intakeId,
  onRefresh,
  record,
  decision,
  draft,
  commonIdentityIssueIds,
  busy,
  onChange,
  onDraft,
  onAnswer,
  onSuggestedSource,
  onReviewLater,
  relatedReview,
}: {
  intakeId: string;
  onRefresh: () => void;
  record: IntakeReviewRecord;
  decision: IntakeReviewDecision;
  draft: LocalReviewDraft;
  commonIdentityIssueIds: Set<string>;
  busy: boolean;
  onChange: (next: IntakeReviewDecision) => void;
  onDraft: (patch: Partial<LocalReviewDraft>) => void;
  onAnswer: (questionId: string, answer: string) => void;
  onSuggestedSource: (source: string) => void;
  relatedReview: ReactNode;
  onReviewLater: () => void;
}) {
  const kind = decision.mapping.kind as EditableKind;
  const fields = mappingFields[kind] || [];
  const issueGroups = groupReviewIssues(record, draft.resolutions);
  const update = (key: keyof IntakeClinicalMapping, value: string) =>
    onChange({
      ...decision,
      mapping: { ...decision.mapping, [key]: value },
      rememberRule:
        key === 'kind'
          ? undefined
          : decision.rememberRule
            ? reusableRule(record, { ...decision.mapping, [key]: value })
            : undefined,
    });
  return (
    <article
      className="intake-record import-standalone-record"
      aria-label={reviewRecordTitle(record)}
    >
      <RecordText
        record={{
          ...record,
          issues: issueGroups.flatMap((group) =>
            group.issues.map((issue) => ({ ...issue, id: group.issue.id })),
          ),
        }}
        mapping={decision.mapping}
      />
      {decision.mapping.opticalPrescription && (
        <OpticalPrescriptionPreview prescription={decision.mapping.opticalPrescription} />
      )}
      {record.duplicateOf &&
        !record.duplicateOf.sameSourceRecord &&
        record.duplicateOf.persistedMatch !== false && (
          <p className="intake-duplicate">
            Matches {record.duplicateOf.label}
            {record.duplicateOf.date ? ` from ${record.duplicateOf.date}` : ''}. Review the
            relationship below; the saved record and this source evidence remain retained.
          </p>
        )}
      {issueGroups
        .filter(
          ({ issue, issues }) =>
            (issue.kind !== 'information' || issue.blocking) &&
            !(
              issue.kind === 'identity' &&
              issues.every((related) => commonIdentityIssueIds.has(related.id))
            ),
        )
        .map(({ issue, issues }) => (
          <ReviewIssue
            key={issue.id}
            issue={issue}
            relatedIssues={issues}
            mapping={decision.mapping}
            resolution={
              draft.resolutions.find((resolution) => resolution.issueId === issue.id) ||
              issue.resolution
            }
            busy={busy}
            onUseSource={onSuggestedSource}
            onLater={onReviewLater}
            onResolve={(resolution) => {
              const resolutions = issues.map((related) => ({ ...resolution, issueId: related.id }));
              onDraft({
                resolutions: [
                  ...draft.resolutions.filter(
                    (prior) => !resolutions.some((next) => next.issueId === prior.issueId),
                  ),
                  ...resolutions,
                ],
                decision: { ...decision, mapping: { ...decision.mapping, ...resolution.mapping } },
              });
            }}
          />
        ))}
      {record.questions
        ?.filter(
          (question) =>
            question.field !== 'duplicate' &&
            !record.issues?.some((issue) => issue.questionId === question.id),
        )
        .map((question) => (
          <StandaloneQuestion
            key={question.id}
            intakeId={intakeId}
            onRefresh={onRefresh}
            question={question}
            answer={draft.answers[question.id] ?? question.answers.at(-1)?.answer ?? ''}
            busy={busy}
            onChange={(answer) => onDraft({ answers: { ...draft.answers, [question.id]: answer } })}
            onSave={(answer) => onAnswer(question.id, answer)}
          />
        ))}
      {record.questions
        ?.filter(
          (question) =>
            question.answerHistory &&
            (question.field === 'duplicate' ||
              record.issues?.some((issue) => issue.questionId === question.id)),
        )
        .map((question) => (
          <section key={`history:${question.id}`}>
            <p>{question.prompt}</p>
            <QuestionAnswerHistory
              intakeId={intakeId}
              history={question.answerHistory}
              onRefresh={onRefresh}
            />
          </section>
        ))}
      {relatedReview}
      {decision.mapping.opticalPrescription && (
        <OpticalPrescriptionEditor
          prescription={decision.mapping.opticalPrescription}
          disabled={busy || draft.disposition !== 'pending'}
          onChange={(opticalPrescription) =>
            onChange({ ...decision, mapping: { ...decision.mapping, opticalPrescription } })
          }
        />
      )}
      <fieldset className="intake-mapping" disabled={busy || draft.disposition !== 'pending'}>
        <label>
          Clinical kind
          <select
            value={decision.mapping.kind || 'unsupported'}
            onChange={(event) => update('kind', event.target.value)}
          >
            <option value="unsupported">Choose a kind</option>
            <option value="observation">Observation</option>
            <option value="medication">Medication</option>
            <option value="procedure">Procedure</option>
            <option value="document">Document</option>
          </select>
        </label>
        <label>
          Subject
          <select
            value={decision.mapping.subject || 'unknown'}
            onChange={(event) => update('subject', event.target.value)}
          >
            <option value="self">Self</option>
            <option value="other">Other person</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          Event type
          <select
            value={decision.mapping.eventKind || 'unknown'}
            onChange={(event) => update('eventKind', event.target.value)}
          >
            <option value="unknown">Unknown</option>
            <option value="order">Order</option>
            <option value="performed">Performed event</option>
            <option value="historical_mention">Historical mention</option>
          </select>
        </label>
        <label>
          Clinical date
          <input
            value={String(decision.mapping.date ?? '')}
            placeholder="YYYY-MM-DD"
            onChange={(event) => update('date', event.target.value)}
          />
        </label>
        {kind === 'medication' && (
          <>
            <label>
              Medication record type
              <select
                value={decision.mapping.medicationKind || 'unknown'}
                onChange={(event) => update('medicationKind', event.target.value)}
              >
                <option value="order">Order</option>
                <option value="reported_use">Reported use</option>
                <option value="dispense">Dispense</option>
                <option value="administration">Administration</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
            <label>
              Clinical date means
              <select
                value={decision.mapping.dateRole || 'recorded'}
                onChange={(event) => update('dateRole', event.target.value)}
              >
                <option value="recorded">Recorded or order date</option>
                <option value="start">Treatment start date</option>
              </select>
            </label>
          </>
        )}
        {fields.map((field) => (
          <label key={field.key} className={field.multiline ? 'intake-mapping-wide' : undefined}>
            {field.label}
            {field.multiline ? (
              <textarea
                value={String(decision.mapping[field.key] ?? '')}
                rows={8}
                onChange={(event) => update(field.key, event.target.value)}
              />
            ) : (
              <input
                value={String(decision.mapping[field.key] ?? '')}
                placeholder={field.placeholder}
                onChange={(event) => update(field.key, event.target.value)}
              />
            )}
          </label>
        ))}
        {kind === 'procedure' && (
          <label>
            Category
            <select
              value={decision.mapping.procedureCategory || 'unspecified'}
              onChange={(event) => update('procedureCategory', event.target.value)}
            >
              <option value="surgery">Surgery</option>
              <option value="clinical_procedure">Clinical procedure</option>
              <option value="imaging">Imaging</option>
              <option value="laboratory">Laboratory</option>
              <option value="pathology">Pathology</option>
              <option value="unspecified">Unspecified</option>
            </select>
          </label>
        )}
      </fieldset>
      {fields.length > 0 && kind === record.kind && record.classification !== 'duplicate' && (
        <label className="intake-rule">
          <input
            type="checkbox"
            checked={!!decision.rememberRule}
            disabled={busy || decision.action === 'skip'}
            onChange={(event) =>
              onChange({
                ...decision,
                rememberRule: event.target.checked
                  ? reusableRule(record, decision.mapping)
                  : undefined,
              })
            }
          />
          Use this label or classification for the same source label
        </label>
      )}
      {(decision.mapping.sourceSystem || decision.mapping.sourceRecordId) && (
        <dl className="intake-source-identity">
          <div>
            <dt>Issuing source system</dt>
            <dd>{decision.mapping.sourceSystem || 'Not supplied'}</dd>
          </div>
          <div>
            <dt>Source record ID</dt>
            <dd>{decision.mapping.sourceRecordId || 'Not supplied'}</dd>
          </div>
        </dl>
      )}
      <section className="intake-evidence" aria-label="Exact original evidence">
        <h4>Evidence</h4>
        {record.evidence.length ? (
          record.evidence.map((evidence, index) => (
            <p key={`${evidence.locator}:${index}`}>
              <strong>{evidence.label}:</strong> {evidence.locator}
              {evidence.contentUrl && (
                <>
                  {' '}
                  ·{' '}
                  <a href={evidence.contentUrl} target="_blank" rel="noreferrer">
                    Open original
                  </a>
                </>
              )}
            </p>
          ))
        ) : (
          <p>No evidence locator was supplied.</p>
        )}
      </section>
    </article>
  );
}

export function StandaloneQuestion({
  intakeId,
  onRefresh,
  question,
  answer,
  busy,
  onChange,
  onSave,
}: {
  intakeId: string;
  onRefresh: () => void;
  question: NonNullable<IntakeReviewRecord['questions']>[number];
  answer: string;
  busy: boolean;
  onChange: (answer: string) => void;
  onSave: (answer: string) => void;
}) {
  const disabled = busy || question.status !== 'unanswered';
  return (
    <section className="intake-question">
      <strong>Needs review</strong>
      <p>{question.prompt}</p>
      <label>
        Answer
        <input
          value={answer}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <button
        className="button secondary"
        type="button"
        disabled={disabled || !answer.trim()}
        onClick={() => onSave(answer)}
      >
        Save answer
      </button>
      {question.status !== 'unanswered' && (
        <small>Answer saved; clinical acceptance remains separate.</small>
      )}
      {question.answers.map((saved) => (
        <p key={saved.id}>
          {question.answerScope === 'latest' ? 'Latest saved answer' : 'Saved answer'}:{' '}
          {saved.answer}
        </p>
      ))}
      <QuestionAnswerHistory
        intakeId={intakeId}
        history={question.answerHistory}
        onRefresh={onRefresh}
      />
    </section>
  );
}
