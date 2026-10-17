import { detailUrl, ImportFileDetails } from './ImportReviewContext';
import { CollectionReportReview } from './CollectionImportReview';
import {
  isCollectionReportDetail,
  type CollectionReportDetail,
} from '../../../shared/intake-clinical-pages';
import { type IntakePublicRead } from '../../../shared/intake-summary';
import { RecordOwnershipAction } from '../clinical-review/RecordOwnershipAction';
import type { IntakeIdentityAnswers } from '../../../shared/intake-identity';
import type { FutureNameChoice } from './ImportFutureNameChoice';
import { ImportIdentityWarnings } from './ImportIdentityWarnings';
import * as Dialog from '@radix-ui/react-dialog';
import type { ImportPersonSelection } from './ImportPersonChoice';
import { ImportDetailIdentityPanel } from './ImportDetailIdentityPanel';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, X } from 'lucide-react';
import type {
  Intake,
  IntakeAcceptedRecord,
  IntakeReportQueueBlock,
  IntakeReportQueueDetail,
  IntakeReportQueueRecord,
  IntakeReportSourceReview,
} from '../../../shared/intake';
import type {
  IntakeIdentityConfirmation,
  IntakeIdentityReview,
} from '../../../shared/intake-identity';
import type {
  IntakePeopleQueue,
  IntakePersonApplyRequest,
  IntakePersonApplyResult,
  IntakePersonDispositionRequest,
  IntakePersonProposal,
} from '../../../shared/intake-people';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import { api, ApiError, useResource } from '../../data/api';
import { confirmIdentityWithFreshness } from '../../data/identity-confirmation-freshness';
import { useProfile } from '../../data/profile';
import { ReportPeopleReview } from '../intake/ReportPeopleReview';
import { mergeReportDetailPages } from '../intake/reviewQueue';
import { reviewRecordTitle } from '../intake/ReviewWorkspace';
import { SourceTextReview } from '../intake/SourceTextReview';
import { loadAcceptedRecordsForScope, SavedRecordDestinations } from './SavedRecordDestinations';
import '../intake/intake.css';
import '../intake/intake-guided.css';
export interface ImportDetailSelection {
  groupId: string;
  intakeId?: string;
  proposalId?: string | null;
  recordId?: string;
  personId?: string;
}
export { DraftSummary, StandaloneQuestion, ImportRecordDetail } from './ImportRecordDetail';
export type { InlineRecordApproval } from './ImportRecordDetail';
import { ImportRecordDetail, type InlineRecordApproval } from './ImportRecordDetail';

const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Unable to complete this import review action.';

function recordKey(block: IntakeReportQueueBlock, record: IntakeReportQueueRecord) {
  return JSON.stringify([
    block.intakeId,
    block.proposalId,
    record.id,
    record.candidateVersionId || '',
  ]);
}

export function ImportDetailReview({
  selection,
  onBack,
  onChanged,
  onUseSource,
  embedded = false,
  beforeCloseRef,
  reviewApprovalRef,
  guardNavigation = true,
  externalPending = false,
}: {
  embedded?: boolean;
  guardNavigation?: boolean;
  externalPending?: boolean;
  beforeCloseRef?: RefObject<(() => Promise<boolean>) | null>;
  reviewApprovalRef?: RefObject<InlineRecordApproval | null>;
  selection: ImportDetailSelection;
  onBack: () => void;
  onChanged: () => void;
  onUseSource: (
    groupId: string,
    source: string,
    review?: IntakeReportSourceReview,
  ) => void | string | null | Promise<void | string | null>;
}) {
  const profile = useProfile();
  const activeProfile = useRef(profile?.id);
  activeProfile.current = profile?.id;
  const identityContext = JSON.stringify([
    profile?.id || '',
    selection.groupId,
    selection.intakeId,
    selection.proposalId,
    selection.recordId,
    selection.personId,
  ]);
  const activeIdentityContext = useRef(identityContext);
  activeIdentityContext.current = identityContext;
  const identityGeneration = useRef(0);
  const identityMounted = useRef(true);
  const restoringIdentityRef = useRef(false);
  const rawDetail = useResource<IntakeReportQueueDetail | CollectionReportDetail>(
    `/intakes/report-queue/${encodeURIComponent(selection.groupId)}?view=all&limit=40&bytes=65536${selection.intakeId ? `&intakeId=${encodeURIComponent(selection.intakeId)}` : ''}${selection.personId ? `&personId=${encodeURIComponent(selection.personId)}` : ''}`,
    'review_open',
  );
  const nativeDetail = isCollectionReportDetail(rawDetail.data) ? rawDetail.data : undefined;
  const detail = {
    ...rawDetail,
    data: isCollectionReportDetail(rawDetail.data) ? null : rawDetail.data,
  };
  const sourceReview = useResource<IntakeReportSourceReview>(
    detail.data
      ? `/intakes/${encodeURIComponent(selection.intakeId || '')}/report-source-review?groupId=${encodeURIComponent(selection.groupId)}&view=all`
      : null,
  );
  const people = useResource<IntakePeopleQueue>(
    detail.data ? `/intakes/people/${encodeURIComponent(selection.groupId)}?limit=100` : null,
  );
  const [pagedPeople, setPagedPeople] = useState<IntakePeopleQueue | null>(null);
  const [pagedDetail, setPagedDetail] = useState<IntakeReportQueueDetail | null>(null);
  const [recordsLoadingMore, setRecordsLoadingMore] = useState(false);
  const [recordsError, setRecordsError] = useState('');
  const [peopleLoadingMore, setPeopleLoadingMore] = useState(false);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [peopleError, setPeopleError] = useState('');
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [contextSheet, setContextSheet] = useState<'source' | 'identity' | null>(null);
  const [sourceDraft, setSourceDraft] = useState('');
  const sourceReviewContext = `${profile?.id || ''}:${selection.intakeId || ''}:${selection.groupId}`;
  const activeSourceReviewContext = useRef(sourceReviewContext);
  activeSourceReviewContext.current = sourceReviewContext;
  const sourceActionGeneration = useRef(0);
  const [refreshedSourceReview, setRefreshedSourceReview] = useState<{
    context: string;
    review: IntakeReportSourceReview;
  } | null>(null);
  useEffect(() => {
    sourceActionGeneration.current += 1;
    setRefreshedSourceReview(null);
    setSourceBusy(false);
    setSourceError('');
  }, [sourceReviewContext]);
  const [identityBusy, setIdentityBusy] = useState(false);
  const [identityError, setIdentityError] = useState('');
  const [identityNotice, setIdentityNotice] = useState('');
  const [refreshedIdentity, setRefreshedIdentity] = useState<{
    context: string;
    review: IntakeIdentityReview;
  } | null>(null);
  const [identityRevision, setIdentityRevision] = useState(0);
  const [savedDestinationsError, setSavedDestinationsError] = useState('');
  const [savedDestinations, setSavedDestinations] = useState<Map<string, IntakeAcceptedRecord>>(
    new Map(),
  );
  const personOperations = useRef(
    new Map<string, IntakePersonApplyRequest | IntakePersonDispositionRequest>(),
  );
  const identityOperations = useRef(new Map<string, IntakeIdentityConfirmation>());

  useEffect(() => {
    identityMounted.current = true;
    return () => {
      identityGeneration.current += 1;
      identityMounted.current = false;
    };
  }, []);

  useEffect(() => {
    identityGeneration.current += 1;
    setRefreshedIdentity(null);
    setIdentityBusy(false);
    setIdentityError('');
    setIdentityNotice('');
  }, [identityContext]);

  useEffect(() => setSourceError(''), [profile?.id]);

  useEffect(() => setPagedPeople(people.data), [people.data]);
  useEffect(() => setPagedDetail(detail.data), [detail.data]);
  useEffect(
    () => setRecordsError(''),
    [selection.groupId, selection.intakeId, selection.proposalId, selection.recordId],
  );
  const displayedDetail =
    pagedDetail?.group.groupId === selection.groupId ? pagedDetail : detail.data;
  useEffect(() => {
    const current = displayedDetail;
    setSavedDestinations(new Map());
    setSavedDestinationsError('');
    // Exact record detail already loads its own durable intake with useResource.
    if (!current || selection.recordId) return;
    const acceptedBlocks = current.blocks.filter((block) =>
      block.records.some((record) => record.reviewState === 'accepted'),
    );
    if (!acceptedBlocks.length) return;
    let cancelled = false;
    void Promise.all(
      [...new Set(acceptedBlocks.map((block) => block.intakeId))].map(
        async (intakeId) =>
          [
            intakeId,
            (await api<IntakePublicRead>(`/intakes/${encodeURIComponent(intakeId)}`)).data,
          ] as const,
      ),
    )
      .then(async (intakes) => {
        if (cancelled) return;
        const byIntake = new Map(intakes);
        const next = new Map<string, IntakeAcceptedRecord>();
        for (const block of current.blocks) {
          const intake = byIntake.get(block.intakeId);
          if (!intake) continue;
          const accepted = await loadAcceptedRecordsForScope(
            intake.id,
            {
              groupId: current.group.groupId,
              proposalId: block.proposalId,
              recordIds: block.records.map((record) => record.id),
            },
            intake,
          );
          if (cancelled) return;
          for (const record of block.records) {
            const destination = accepted.find((item) => item.recordId === record.id);
            if (destination) next.set(recordKey(block, record), destination);
          }
        }
        setSavedDestinations(next);
      })
      .catch(() => {
        if (cancelled) return;
        setSavedDestinationsError(
          'Saved record links could not load. Your saved records are unchanged.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [displayedDetail, selection.recordId]);
  const identity = useResource<IntakeIdentityReview>(
    displayedDetail
      ? `/intakes/${encodeURIComponent(displayedDetail.group.intakeId)}/identity-review?groupId=${encodeURIComponent(selection.groupId)}`
      : null,
  );
  const currentIdentityReview =
    refreshedIdentity?.context === identityContext ? refreshedIdentity.review : identity.data;
  const identityGroundingRefresh = useRef<string | null>(null);
  useEffect(() => {
    const blocked = displayedDetail?.blocks.some((block) =>
      block.records.some((record) => record.identityReview?.blocking),
    );
    if (!blocked) identityGroundingRefresh.current = null;
    const key = JSON.stringify([
      identityContext,
      currentIdentityReview?.scope?.scopeToken,
      displayedDetail?.blocks.map((block) => block.reviewToken),
    ]);
    if (
      (currentIdentityReview?.status === 'prior_confirmation' ||
        currentIdentityReview?.status === 'evidenced_match') &&
      !currentIdentityReview.blocking &&
      blocked &&
      identityGroundingRefresh.current !== key
    ) {
      // Async original grounding changes the synchronous review token as well
      // as row eligibility. Fetch both again before an acceptance is prepared.
      // A remaining blocker on the same scope must not cause a reload loop.
      identityGroundingRefresh.current = key;
      detail.reload();
    }
  }, [currentIdentityReview, displayedDetail, detail.reload, identityContext]);
  const [restoringIdentity, setRestoringIdentity] = useState(false);
  const restoringIdentityStarted = useRef(false);
  useEffect(() => {
    identityGeneration.current += 1;
    setRefreshedIdentity(null);
    setIdentityBusy(false);
  }, [identity.data]);
  useEffect(() => {
    const refreshRestoredDetail = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      identityGeneration.current += 1;
      restoringIdentityRef.current = true;
      restoringIdentityStarted.current = false;
      setRestoringIdentity(true);
      setIdentityBusy(false);
      identity.reload();
      detail.reload();
    };
    window.addEventListener('pageshow', refreshRestoredDetail);
    return () => window.removeEventListener('pageshow', refreshRestoredDetail);
  }, [detail.reload, identity.reload]);
  useEffect(() => {
    if (!restoringIdentity) return;
    if (identity.loading || identity.refreshing) {
      restoringIdentityStarted.current = true;
      return;
    }
    if (restoringIdentityStarted.current) {
      restoringIdentityStarted.current = false;
      restoringIdentityRef.current = false;
      setRestoringIdentity(false);
    }
  }, [identity.loading, identity.refreshing, restoringIdentity]);
  useEffect(() => {
    const group = displayedDetail?.group;
    if (group)
      setSourceDraft(
        (group.sourceCoverage?.current.status === 'single'
          ? group.sourceCoverage.current.bySource[0]?.source
          : undefined) ||
          (!group.sourceConfirmation ? group.sourceSuggestion?.value : undefined) ||
          group.source ||
          '',
      );
  }, [displayedDetail?.group.groupId, displayedDetail?.group.source]);

  const exact = useMemo(() => {
    const entries =
      displayedDetail?.blocks.flatMap((block) =>
        block.records.map((record) => ({ block, record, key: recordKey(block, record) })),
      ) || [];
    if (!selection.recordId) return null;
    return (
      entries.find(
        ({ block, record }) =>
          record.id === selection.recordId &&
          (!selection.intakeId || block.intakeId === selection.intakeId) &&
          (selection.proposalId === undefined || block.proposalId === selection.proposalId),
      ) || null
    );
  }, [displayedDetail, selection]);

  async function mutatePerson(
    proposal: IntakePersonProposal,
    choice:
      | { state: 'pending' | 'later' | 'excluded' }
      | { action: 'add' }
      | { action: 'update'; noteId: string; version: number },
  ) {
    if (peopleBusy) return;
    setPeopleBusy(true);
    setPeopleError('');
    try {
      if ('state' in choice) {
        const key = `disposition:${proposal.id}:${proposal.version}:${choice.state}`;
        let request = personOperations.current.get(key) as
          IntakePersonDispositionRequest | undefined;
        request ||= {
          operationId: crypto.randomUUID(),
          intakeId: proposal.intakeId,
          proposalId: proposal.id,
          proposalVersion: proposal.version,
          state: choice.state,
          intakeVersion: proposal.intakeVersion,
        };
        personOperations.current.set(key, request);
        await api<Intake>('/intakes/people-disposition', {
          method: 'POST',
          body: JSON.stringify(request),
        });
        personOperations.current.delete(key);
      } else {
        const key = `apply:${proposal.id}:${proposal.version}:${choice.action}:${'noteId' in choice ? choice.noteId : ''}`;
        let request = personOperations.current.get(key) as IntakePersonApplyRequest | undefined;
        request ||= {
          operationId: crypto.randomUUID(),
          intakeId: proposal.intakeId,
          proposalId: proposal.id,
          proposalVersion: proposal.version,
          ...choice,
        };
        personOperations.current.set(key, request);
        await api<IntakePersonApplyResult>('/intakes/people-apply', {
          method: 'POST',
          body: JSON.stringify(request),
        });
        personOperations.current.delete(key);
      }
      people.reload();
      detail.reload();
      onChanged();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500)
        personOperations.current.clear();
      setPeopleError(errorMessage(cause));
    } finally {
      setPeopleBusy(false);
    }
  }

  async function loadMorePeople() {
    if (!pagedPeople?.peopleNextCursor || peopleLoadingMore) return;
    setPeopleLoadingMore(true);
    try {
      const page = (
        await api<IntakePeopleQueue>(
          `/intakes/people/${encodeURIComponent(selection.groupId)}?limit=100&cursor=${encodeURIComponent(pagedPeople.peopleNextCursor)}`,
        )
      ).data;
      setPagedPeople((current) =>
        current
          ? {
              ...page,
              people: [
                ...new Map(
                  [...current.people, ...page.people].map((proposal) => [proposal.id, proposal]),
                ).values(),
              ],
            }
          : page,
      );
    } catch (cause) {
      setPeopleError(errorMessage(cause));
    } finally {
      setPeopleLoadingMore(false);
    }
  }

  async function loadMoreRecords() {
    if (!displayedDetail?.nextCursor || recordsLoadingMore) return;
    setRecordsLoadingMore(true);
    setRecordsError('');
    try {
      const page = (
        await api<IntakeReportQueueDetail>(
          `/intakes/report-queue/${encodeURIComponent(selection.groupId)}?view=all&limit=100&cursor=${encodeURIComponent(displayedDetail.nextCursor)}`,
        )
      ).data;
      setPagedDetail((current) => (current ? mergeReportDetailPages(current, page) : page));
    } catch (cause) {
      setRecordsError(errorMessage(cause));
    } finally {
      setRecordsLoadingMore(false);
    }
  }

  useEffect(() => {
    if (
      selection.recordId &&
      !exact &&
      displayedDetail?.nextCursor &&
      !recordsLoadingMore &&
      !recordsError
    )
      void loadMoreRecords();
  }, [
    displayedDetail?.nextCursor,
    exact,
    recordsError,
    recordsLoadingMore,
    selection.intakeId,
    selection.proposalId,
    selection.recordId,
  ]);

  async function useReportSource(groupId: string, source: string) {
    const requestedContext = sourceReviewContext;
    const generation = ++sourceActionGeneration.current;
    const current = () =>
      activeSourceReviewContext.current === requestedContext &&
      sourceActionGeneration.current === generation;
    const refreshAfterFailure = async () => {
      const refreshed = (
        await api<IntakeReportSourceReview>(
          `/intakes/${encodeURIComponent(selection.intakeId || '')}/report-source-review?groupId=${encodeURIComponent(selection.groupId)}&view=all`,
        )
      ).data;
      if (current()) setRefreshedSourceReview({ context: requestedContext, review: refreshed });
    };
    setSourceBusy(true);
    setSourceError('');
    try {
      const review =
        refreshedSourceReview?.context === requestedContext
          ? refreshedSourceReview.review
          : sourceReview.data;
      if (!review?.targets.length) {
        if (current())
          setSourceError('The affected source records are still loading or changed. Review again.');
        return;
      }
      const message = await onUseSource(groupId, source, review);
      if (!current()) return;
      if (typeof message === 'string' && message) {
        setSourceError(message);
        await refreshAfterFailure();
        return;
      }
      detail.reload();
      sourceReview.reload();
      setContextSheet(null);
      onChanged();
    } catch (cause) {
      if (!current()) return;
      setSourceError(errorMessage(cause));
      try {
        await refreshAfterFailure();
      } catch {
        // Keep the action error visible; the next full resource reload can recover the preflight.
        setRefreshedSourceReview(null);
        sourceReview.reload();
      }
    } finally {
      if (current()) setSourceBusy(false);
    }
  }

  async function confirmIdentity(
    fields: { fullName?: string; birthDate?: string },
    personSelection?: ImportPersonSelection,
    printedName?: string,
    identityAnswers?: IntakeIdentityAnswers,
    futureNameOwner?: FutureNameChoice,
  ) {
    const group = displayedDetail?.group;
    const review = currentIdentityReview;
    const requestedProfile = profile?.id;
    if (identity.refreshing || restoringIdentity) return;
    if (!requestedProfile || !group || !review?.scope) {
      setIdentityError('The exact identity scope is not ready. Reload it before confirming.');
      return;
    }
    const selected = Object.fromEntries(
      Object.entries(personSelection ? {} : fields).filter(
        ([field, value]) =>
          !!value &&
          review.offeredSelfFields[field as keyof typeof review.offeredSelfFields] === value,
      ),
    ) as { fullName?: string; birthDate?: string };
    // Retained uncertain requests are recoverable only inside the exact profile
    // and deep-link selection that created them.
    const key = `${identityContext}:${review.scope.groupId}:${review.scope.groupVersionId}:${review.scope.intakeVersion}:${JSON.stringify([selected, personSelection, printedName, identityAnswers, futureNameOwner])}`;
    const request: IntakeIdentityConfirmation = identityOperations.current.get(key) || {
      version: review.scope.intakeVersion,
      operationId: crypto.randomUUID(),
      scope: review.scope,
      outcome: personSelection ? 'this_is_person' : 'this_is_me',
      ...(personSelection ? { personSelection } : {}),
      ...(printedName ? { printedName } : {}),
      ...(identityAnswers ? { identityAnswers } : {}),
      ...(review.challengedName ? { futureNameOwner: futureNameOwner || { outcome: 'ask' } } : {}),
      attestation: review.scope.questions?.length
        ? 'confirmed_displayed_identity_questions'
        : 'confirmed_displayed_report_subject',
      ...(Object.keys(selected).length
        ? { selfUpdate: { expectedVersion: review.self.version, fields: selected } }
        : {}),
    };
    const actionContext = identityContext;
    const actionGeneration = identityGeneration.current;
    const prefix = `/api/profiles/${encodeURIComponent(requestedProfile)}`;
    const actionCurrent = () =>
      identityMounted.current &&
      activeProfile.current === requestedProfile &&
      activeIdentityContext.current === actionContext &&
      identityGeneration.current === actionGeneration &&
      !restoringIdentityRef.current;
    if (!actionCurrent()) return;
    setIdentityBusy(true);
    setIdentityError('');
    setIdentityNotice('');
    try {
      const outcome = await confirmIdentityWithFreshness({
        displayed: review,
        request,
        send: async (next) =>
          (
            await api<Intake>(
              `${prefix}/intakes/${encodeURIComponent(group.intakeId)}/identity-scope`,
              {
                method: 'POST',
                body: JSON.stringify(next),
              },
            )
          ).data,
        loadFresh: async () =>
          (
            await api<IntakeIdentityReview>(
              `${prefix}/intakes/${encodeURIComponent(group.intakeId)}/identity-review?groupId=${encodeURIComponent(group.groupId)}`,
            )
          ).data,
        isContextCurrent: actionCurrent,
        retainRequest: (next) => {
          if (next) identityOperations.current.set(key, next);
          else identityOperations.current.delete(key);
        },
      });
      if (outcome.status === 'context_changed' || !actionCurrent()) return;
      if (outcome.status === 'scope_changed') {
        setIdentityBusy(false);
        identityGeneration.current += 1;
        setRefreshedIdentity({ context: actionContext, review: outcome.fresh });
        setIdentityError(outcome.message);
        return;
      }
      setIdentityNotice(
        personSelection
          ? 'The report is assigned to the selected person in People. Clinical records remain in review.'
          : Object.keys(selected).length
            ? review.status === 'confirmation_required'
              ? 'Identity and the selected blank Self details were confirmed in one action. Clinical records are not saved yet.'
              : 'The selected blank Self details were added. Clinical records are not saved yet.'
            : 'This report is confirmed as yours and its supported name is retained in your saved names. Clinical records are not saved yet.',
      );
      identity.reload();
      detail.reload();
      setIdentityRevision((revision) => revision + 1);
      setContextSheet(null);
      onChanged();
      if (!selection.recordId) onBack();
    } catch (cause) {
      if (!actionCurrent()) return;
      if (cause instanceof ApiError && cause.status === 409) {
        identity.reload();
        if (cause.code === 'IDENTITY_ALREADY_RESOLVED') {
          setIdentityNotice(
            'This report identity was already confirmed. No additional confirmation was recorded.',
          );
          setContextSheet(null);
          if (!selection.recordId) onBack();
          return;
        }
      }
      setIdentityError(
        cause instanceof ApiError && cause.status === 409
          ? 'The report or Self profile changed. Check the refreshed identity details, then confirm again.'
          : errorMessage(cause),
      );
    } finally {
      if (actionCurrent()) setIdentityBusy(false);
    }
  }

  const identityEditor = (
    <ImportDetailIdentityPanel
      review={
        identity.refreshing || restoringIdentity || identity.error
          ? undefined
          : currentIdentityReview || undefined
      }
      loading={identity.loading || !!identity.refreshing || restoringIdentity}
      error={identityError || identity.error?.message || ''}
      notice={identityNotice}
      busy={identityBusy}
      onDone={() => {
        setContextSheet(null);
        if (!selection.recordId) onBack();
      }}
      onRetry={identity.reload}
      onConfirm={(fields, personSelection, printedName, identityAnswers, futureNameOwner) =>
        void confirmIdentity(fields, personSelection, printedName, identityAnswers, futureNameOwner)
      }
    />
  );
  const sourceGroup = displayedDetail?.group;
  const sourceScope = sourceGroup?.sourceSuggestion || sourceGroup?.sourceLabelScope;
  const displayedSourceReview =
    refreshedSourceReview?.context === sourceReviewContext
      ? refreshedSourceReview.review
      : sourceReview.error
        ? null
        : sourceReview.data;
  const reviewedSource =
    sourceGroup?.sourceCoverage?.current.status === 'single'
      ? sourceGroup.sourceCoverage.current.bySource[0]?.source
      : undefined;
  const sourcePanel =
    sourceGroup && sourceScope ? (
      <section className="import-source-question" aria-label="Report source label">
        <span>
          {reviewedSource || sourceGroup.sourceConfirmation
            ? `Reviewed source: ${reviewedSource || sourceGroup.source || 'Source not labeled'}. New eligible results you save use this label. Original issuer and upload history stay unchanged.`
            : sourceGroup.sourceSuggestion
              ? 'Suggested source—not applied yet. Use it for this report and eligible results you save. Original issuer and upload history stay unchanged.'
              : 'Add a source for this report and eligible results you save. Original issuer and upload history stay unchanged.'}
          {sourceScope.evidence.contentUrl && (
            <a href={sourceScope.evidence.contentUrl} target="_blank" rel="noreferrer">
              Review source evidence <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
          {displayedSourceReview && (
            <>
              <small>
                This action affects {displayedSourceReview.targets.length}{' '}
                {displayedSourceReview.targets.length === 1 ? 'current record' : 'current records'};{' '}
                {displayedSourceReview.coverage.covered} already have a reviewed source and{' '}
                {displayedSourceReview.coverage.uncovered} do not.
              </small>
              {!!displayedSourceReview.sourceEvidence.length && (
                <small>
                  Retained source evidence: {displayedSourceReview.sourceEvidence.join(', ')}.
                </small>
              )}
              {sourceDraft.trim() &&
                displayedSourceReview.sourceEvidence.some(
                  (value) => value !== sourceDraft.trim(),
                ) && (
                  <small role="alert">
                    “{sourceDraft.trim()}” differs from retained source evidence. Check the original
                    before confirming this one label.
                  </small>
                )}
              <details>
                <summary>Review affected records</summary>
                <ul>
                  {displayedSourceReview.targets.map((target) => (
                    <li key={target.id}>
                      {target.title}
                      {target.date ? ` · ${target.date}` : ''} · {target.occurrence.locator}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
          {displayedSourceReview?.warning && (
            <small role="alert">{displayedSourceReview.warning}</small>
          )}
          {sourceReview.error && !displayedSourceReview && (
            <small role="alert">{sourceReview.error.message}</small>
          )}
        </span>
        <div className="import-detail-source-controls">
          <label>
            Report label
            <input
              value={sourceDraft}
              disabled={sourceBusy}
              onChange={(event) => setSourceDraft(event.target.value)}
            />
          </label>
          <button
            className="button secondary"
            type="button"
            disabled={
              sourceBusy ||
              sourceReview.loading ||
              sourceReview.refreshing ||
              (!sourceReview.error &&
                (!displayedSourceReview?.targets.length || !sourceDraft.trim()))
            }
            onClick={() => {
              if (sourceReview.error && !displayedSourceReview) sourceReview.reload();
              else void useReportSource(sourceGroup.groupId, sourceDraft.trim());
            }}
          >
            {sourceBusy
              ? 'Saving label…'
              : sourceReview.error && !displayedSourceReview
                ? 'Retry affected records'
                : displayedSourceReview
                  ? `Use report label for ${displayedSourceReview.targets.length} ${
                      displayedSourceReview.targets.length === 1 ? 'record' : 'records'
                    }`
                  : 'Reviewing affected records…'}
          </button>
        </div>
      </section>
    ) : null;
  const personConfirmed =
    currentIdentityReview?.status === 'evidenced_match' ||
    currentIdentityReview?.status === 'prior_confirmation';
  const nameOnlyMatch =
    currentIdentityReview?.status === 'evidenced_match' &&
    !currentIdentityReview.evidencedIdentity.birthDate;
  const personChangeReady = personConfirmed && !nameOnlyMatch;
  const selfPerson =
    !currentIdentityReview?.assignedPerson ||
    currentIdentityReview.assignedPerson.personId === 'patient';
  const personLabel =
    currentIdentityReview?.evidencedIdentity.fullName ||
    currentIdentityReview?.assignedPerson?.fullName ||
    currentIdentityReview?.scope?.subject.text ||
    'Person not identified';
  const identityPanel = (
    <>
      <div className="import-report-context import-detail-context">
        {sourceGroup && sourceScope && (
          <button
            type="button"
            className="import-source-control"
            aria-label="Change source for this report"
            onClick={() => setContextSheet('source')}
          >
            <span className="import-source">
              {reviewedSource ||
                (!sourceGroup.sourceConfirmation
                  ? sourceGroup.sourceSuggestion?.value
                  : undefined) ||
                sourceGroup.source ||
                'Source not labeled'}
            </span>
            {!reviewedSource && !sourceGroup.sourceConfirmation && sourceGroup.sourceSuggestion && (
              <span className="import-suggested">Suggested · not applied</span>
            )}
            <span className="import-source-action">Change</span>
          </button>
        )}
        <button
          type="button"
          className="import-source-control"
          aria-label={`${personChangeReady ? 'Change' : 'Review'} person for this report`}
          onClick={() => setContextSheet('identity')}
        >
          <span>
            {currentIdentityReview?.correctedPerson
              ? `Corrected to ${currentIdentityReview.correctedPerson.fullName}`
              : `For ${personLabel}`}
            {!currentIdentityReview?.correctedPerson && personConfirmed
              ? selfPerson
                ? nameOnlyMatch
                  ? ' (you?)'
                  : ' (you)'
                : nameOnlyMatch
                  ? ' (?)'
                  : ''
              : ''}
          </span>
          <span className="import-source-action">{personChangeReady ? 'Change' : 'Review'}</span>
        </button>
      </div>
      <ImportIdentityWarnings
        warnings={currentIdentityReview?.warnings}
        onReviewPerson={() => setContextSheet('identity')}
        reviewLabel={personChangeReady ? 'Change person' : 'Review person'}
      />
      <Dialog.Root
        open={contextSheet !== null}
        onOpenChange={(open) => {
          if (!open && !identityBusy && !sourceBusy) setContextSheet(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="import-sheet-overlay" />
          <Dialog.Content className="import-sheet import-context-sheet">
            <div className="import-sheet-header">
              <Dialog.Title>
                {contextSheet === 'identity' ? 'Who is this report for?' : 'Change source'}
              </Dialog.Title>
              <Dialog.Close
                className="icon-button"
                aria-label="Close"
                data-review-context-dismiss
                disabled={identityBusy || sourceBusy}
              >
                <X size={18} />
              </Dialog.Close>
            </div>
            <Dialog.Description>
              Review the source and person for this report. Clinical records remain in review.
            </Dialog.Description>
            <nav className="import-context-tabs" aria-label="Report details">
              <button
                type="button"
                aria-pressed={contextSheet === 'source'}
                disabled={identityBusy || sourceBusy || !sourceScope}
                onClick={() => setContextSheet('source')}
              >
                Source
              </button>
              <button
                type="button"
                aria-pressed={contextSheet === 'identity'}
                disabled={identityBusy || sourceBusy}
                onClick={() => setContextSheet('identity')}
              >
                Person
              </button>
            </nav>
            <div hidden={contextSheet !== 'identity'}>{identityEditor}</div>
            <div hidden={contextSheet !== 'source'}>
              {sourcePanel}
              {sourceError && <p role="alert">{sourceError}</p>}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
  const commonIdentityIssueIds = (recordId: string) =>
    new Set(
      currentIdentityReview?.scope?.targets
        .filter((target) => target.recordId === recordId)
        .flatMap((target) => [target.issueId, ...(target.issueIds || [])]) || [],
    );

  if (nativeDetail)
    return (
      <CollectionReportReview
        parentError={rawDetail.error?.message}
        guardNavigation={guardNavigation}
        externalPending={externalPending}
        initial={nativeDetail}
        firstPage={rawDetail}
        selection={selection}
        onBack={onBack}
        onChanged={onChanged}
        onUseSource={onUseSource}
        embedded={embedded}
        beforeCloseRef={beforeCloseRef}
        reviewApprovalRef={reviewApprovalRef}
      />
    );
  if (detail.loading && !detail.data)
    return <LoadingIndicator label="Opening exact import review…" layout="centered" />;
  if (detail.error && (!detail.data || !selection.recordId))
    return (
      <section className="import-detail-state" role="alert">
        <p>{detail.error.message}</p>
        <button className="button secondary" type="button" onClick={detail.reload}>
          Retry exact review
        </button>
        <button className="text-link" type="button" onClick={onBack}>
          Back to Import
        </button>
      </section>
    );
  if (!displayedDetail) return null;
  if (selection.recordId && !exact && displayedDetail.nextCursor && !recordsError)
    return <LoadingIndicator label="Finding the exact proposal record…" layout="centered" />;
  if (selection.recordId && exact)
    return (
      <ImportRecordDetail
        embedded={embedded}
        guardNavigation={guardNavigation}
        contextPending={externalPending}
        beforeCloseRef={beforeCloseRef}
        reviewApprovalRef={reviewApprovalRef}
        groupId={selection.groupId}
        block={exact.block}
        recordId={exact.record.id}
        contextError={detail.error?.message}
        onRetryContext={detail.reload}
        savedDestination={savedDestinations.get(recordKey(exact.block, exact.record))}
        identityPanel={identityPanel}
        identityRevision={identityRevision}
        sourcePanel={null}
        commonIdentityIssueIds={commonIdentityIssueIds(exact.record.id)}
        sourceError={sourceError}
        onBack={onBack}
        onChanged={() => {
          detail.reload();
          onChanged();
        }}
        onUseSource={(_groupId, source) => {
          setSourceDraft(source);
          setSourceError('');
        }}
      />
    );

  const group = displayedDetail.group;
  const shownPeople = pagedPeople?.groupId === group.groupId ? pagedPeople : people.data;
  return (
    <section className="import-detail" aria-label={`Review ${group.title}`}>
      <button type="button" className="text-link import-detail-back" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" /> Back to Import
      </button>
      <header className="import-detail-heading import-report-title">
        <div>
          <p className="eyebrow">
            New Import Source: {group.member?.filename || group.original.filename}
          </p>
          <h2>{group.title}</h2>
          <p>
            {group.source || 'Source not labeled'}
            {group.date ? ` · ${group.date}` : ''}
            {group.member?.filename
              ? ` · ${group.member.filename}`
              : ` · ${group.original.filename}`}
          </p>
        </div>
        <a
          className="button secondary"
          href={group.original.contentUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open original <ExternalLink size={15} aria-hidden="true" />
        </a>
      </header>
      <RecordOwnershipAction
        selection={{
          type: 'report',
          intakeId: group.intakeId,
          groupId: group.groupId,
          groupVersionId: group.groupVersionId,
        }}
        label="Change person · saved and pending records"
        onApplied={() => {
          detail.reload();
          onChanged();
        }}
      />
      {identityPanel}
      <SourceTextReview
        intakeId={group.intakeId}
        onChanged={() => {
          detail.reload();
          onChanged();
        }}
      />
      <p className="helper-text">
        Choose a row for every field, question, related-record decision, correction, and original
        evidence control. Nothing is saved as a clinical record from this report overview.
      </p>
      <SavedRecordDestinations
        records={[...savedDestinations.values()]}
        label="Saved destinations for this report"
        error={savedDestinationsError}
        onRetry={detail.reload}
      />
      <div className="import-detail-records">
        {displayedDetail.blocks.flatMap((block) =>
          block.records.map((record) => (
            <a
              className="import-detail-record-link"
              href={`#${detailUrl(group.groupId, block, record)}`}
              key={recordKey(block, record)}
            >
              <span>
                <strong>{reviewRecordTitle(record)}</strong>
                <small>
                  {record.date || 'Date not given'} · {record.queueState.replaceAll('_', ' ')}
                </small>
              </span>
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          )),
        )}
      </div>
      {displayedDetail.nextCursor && (
        <button
          className="button secondary"
          type="button"
          disabled={recordsLoadingMore}
          onClick={() => void loadMoreRecords()}
        >
          {recordsLoadingMore ? 'Loading report records…' : 'Load more report records'}
        </button>
      )}
      {selection.recordId && !exact && !displayedDetail.nextCursor && (
        <div className="import-error" role="alert">
          That exact proposal record is no longer in this report version. Its retained report and
          current records are shown here; no different record was selected automatically.
        </div>
      )}
      {recordsError && (
        <div className="import-error" role="alert">
          {recordsError}
          <button className="text-link" type="button" onClick={() => void loadMoreRecords()}>
            Retry exact record search
          </button>
        </div>
      )}
      {peopleError && <p role="alert">{peopleError}</p>}
      {sourceError && <p role="alert">{sourceError}</p>}
      {shownPeople && shownPeople.totalPeople > 0 && (
        <ReportPeopleReview
          queue={shownPeople}
          preferredPersonId={selection.personId}
          busy={peopleBusy}
          loadingMore={peopleLoadingMore}
          onLoadMore={() => void loadMorePeople()}
          onDisposition={(proposal, state) => void mutatePerson(proposal, { state })}
          onApply={(proposal, choice) => void mutatePerson(proposal, choice)}
        />
      )}
      {selection.intakeId && <ImportFileDetails intakeId={selection.intakeId} />}
    </section>
  );
}
