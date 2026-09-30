import { ImportAcceptanceOutcomes, acceptanceSummary } from './ImportAcceptanceOutcomes';
import type { IntakeReportAcceptanceReceipt } from '../../../shared/intake';
import type { IntakeIdentityAnswers } from '../../../shared/intake-identity';
import type { ImportPersonSelection } from './ImportPersonChoice';
import type { ManualSourceRecordResult } from '../../../shared/intake-manual-source-record';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { X } from 'lucide-react';
import type {
  Intake,
  IntakeAcceptedRecord,
  IntakeDraftRepairField,
  IntakeDraftRepairSelection,
  IntakeDraftRepairUpdate,
  IntakeImportFeed,
  IntakeImportFeedRecord,
  IntakeReportAcceptanceRequest,
  IntakeReportQueueGroup,
  IntakeReportSourceResult,
  IntakeReportSourceReview,
  IntakeReportSourceUpdate,
  IntakeReview,
} from '../../../shared/intake';
import type {
  IntakeIdentityConfirmation,
  IntakeIdentityReview,
} from '../../../shared/intake-identity';
import { hasPausedIntakeReading } from '../../../shared/intake-batch';
import type {
  IntakePeopleQueue,
  IntakePersonApplyRequest,
  IntakePersonApplyResult,
  IntakePersonDispositionRequest,
  IntakePersonProposal,
} from '../../../shared/intake-people';
import { hasUnreviewedPairChoices } from '../../../shared/clinical-review';
import { beginClientOperation } from '../../data/import-performance';
import type { ClientOperationSummary } from '../../../shared/import-performance';
import { api, ApiError, useResource } from '../../data/api';
import { confirmIdentityWithFreshness } from '../../data/identity-confirmation-freshness';
import { useProfile } from '../../data/profile';
import { sameDisplayedSourceReview } from '../../data/source-label-freshness';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import { useAssistantSelection } from '../assistant/pageContext';
import { initialDraft } from '../intake/useReviewDrafts';
import { useReportAcceptance } from '../intake/useReportAcceptance';
import { intakeReadingPauseLabel, reportActivityLabel } from '../intake/reviewQueue';
import { useIntakeBatch } from '../intake/useIntakeBatch';
import {
  ImportReviewPresentation,
  type ImportReviewKind,
  type ImportReviewModel,
  type ImportReviewRecord,
  type ImportReviewStatus,
} from './ImportReviewPresentation';
import { ImportDetailReview, type ImportDetailSelection } from './ImportDetailReview';
import { ImportSourceTextBrowser } from './ImportSourceTextBrowser';
import { ImportSaveStatus } from './ImportSaveStatus';
import { possibleSavedOverlapCount } from './possible-overlaps';
import {
  acceptedRecordsForScope,
  appendSavedPersonDestination,
  SavedPersonDestinations,
  SavedRecordDestinations,
  type SavedPersonDestination,
} from './SavedRecordDestinations';

type HistoricalImportSelection = {
  key: string;
  groupId?: string;
  error?: string;
  loading: boolean;
};

type IdentityReviewLoad = {
  pending: boolean;
  signature: string;
  token: symbol;
};

type DraftRepairUndo = {
  intakeId: string;
  request: IntakeDraftRepairUpdate;
};

const identityReviewSignature = (profileSignature: string, group: IntakeReportQueueGroup) =>
  JSON.stringify([
    profileSignature,
    group.intakeId,
    group.groupId,
    group.groupVersionId,
    group.intakeVersion,
  ]);

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Unable to complete this import action.';

const status = (value: IntakeImportFeedRecord['queueState']): ImportReviewStatus =>
  value === 'pending'
    ? 'review'
    : value === 'deferred'
      ? 'later'
      : value === 'accepted'
        ? 'saved'
        : 'excluded';

const kind: Record<IntakeImportFeedRecord['feedKind'], ImportReviewKind> = {
  test: 'Test results',
  prescription: 'Prescriptions',
  vision: 'Vision',
  procedure: 'Procedures',
  history: 'Documents',
  unsupported: 'Documents',
};
const feedKind: Partial<Record<ImportReviewKind, IntakeImportFeedRecord['feedKind'] | 'person'>> = {
  'Test results': 'test',
  Prescriptions: 'prescription',
  Vision: 'vision',
  Procedures: 'procedure',
  Documents: 'history',
  People: 'person',
};

function recordLabel(record: IntakeImportFeedRecord) {
  return (
    record.mapping.testLabel ||
    record.mapping.medicationName ||
    record.mapping.procedureLabel ||
    record.mapping.documentTitle ||
    record.mapping.label ||
    record.title
  );
}

function recordValue(record: IntakeImportFeedRecord) {
  const mapping = initialDraft(record).decision.mapping;
  if (record.feedKind === 'prescription')
    return { value: mapping.doseText || mapping.status || 'Prescription', unit: mapping.frequency };
  if (record.feedKind === 'procedure')
    return { value: mapping.status || mapping.eventKind || 'Procedure', unit: '' };
  if (record.feedKind === 'history' || record.feedKind === 'unsupported') {
    const literal = (mapping.text || mapping.status || record.title).replace(/\s+/g, ' ').trim();
    return { value: literal.length > 120 ? `${literal.slice(0, 117)}…` : literal, unit: '' };
  }
  if (record.feedKind === 'vision' && mapping.opticalPrescription) {
    const eyes = mapping.opticalPrescription.eyes.map((eye) => {
      const side =
        eye.sideText ||
        (eye.side === 'right'
          ? 'OD'
          : eye.side === 'left'
            ? 'OS'
            : eye.side === 'both'
              ? 'OU'
              : 'Eye');
      const values = [
        eye.sph && `SPH ${eye.sph.valueText}${eye.sph.unit ? ` ${eye.sph.unit}` : ''}`,
        eye.cyl && `CYL ${eye.cyl.valueText}${eye.cyl.unit ? ` ${eye.cyl.unit}` : ''}`,
        eye.axis && `AXIS ${eye.axis.valueText}${eye.axis.unit ? ` ${eye.axis.unit}` : ''}`,
        eye.add && `ADD ${eye.add.valueText}${eye.add.unit ? ` ${eye.add.unit}` : ''}`,
      ].filter(Boolean);
      return `${side} ${values.join(' ')}`.trim();
    });
    const literal = eyes.filter(Boolean).join(' · ');
    return { value: literal || 'Vision prescription', unit: '' };
  }
  return { value: mapping.valueText || 'Value to review', unit: mapping.unit };
}

function recordSaveBlockReason(record: IntakeImportFeedRecord): string | undefined {
  if (record.selectable || (record.queueState !== 'pending' && record.queueState !== 'deferred'))
    return undefined;
  if (hasUnreviewedPairChoices(record))
    return 'Review the possible record matches before saving this record.';
  if (record.identityReview?.blocking)
    return record.identityReview.message || 'Review the report identity before saving this record.';
  const issue = record.issues?.find(
    (candidate) => candidate.blocking && candidate.status !== 'resolved',
  );
  if (issue?.kind === 'identity') return 'Review the report identity before saving this record.';
  if (issue?.kind === 'date') return 'Resolve the date question before saving this record.';
  if (issue?.kind === 'uncertain_reading')
    return 'Resolve the uncertain reading before saving this record.';
  if (issue?.kind === 'information')
    return 'Answer the required review question before saving this record.';
  if (record.classification === 'unsupported')
    return 'This item is kept with its original and cannot be saved as a structured record.';
  return 'Open the full review to resolve what is blocking this record.';
}

function detailUrl(
  group: IntakeReportQueueGroup,
  block: IntakeImportFeed['blocks'][number],
  record: IntakeImportFeedRecord,
) {
  const params = new URLSearchParams({
    group: group.groupId,
    intake: block.intakeId,
    proposal: block.proposalId || 'original',
    record: record.id,
  });
  return `/import?${params}`;
}

export function ImportPage() {
  const profile = useProfile();
  const closeInlineReview = useRef<(() => Promise<boolean>) | null>(null);
  const pendingSourceReviews = useRef(new Set<string>());
  const [preserveSourceReview, setPreserveSourceReview] = useState(false);
  function sourceReviewPending(key: string, pending: boolean) {
    if (pending) pendingSourceReviews.current.add(key);
    else pendingSourceReviews.current.delete(key);
    setPreserveSourceReview(pendingSourceReviews.current.size > 0);
  }
  const [manualReview, setManualReview] = useState<ManualSourceRecordResult | null>(null);
  useEffect(() => {
    setManualReview(null);
    pendingSourceReviews.current.clear();
    setPreserveSourceReview(false);
  }, [profile?.id]);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectionQuery = searchParams.toString();
  const [filters, setFilters] = useState<NonNullable<ImportReviewModel['filters']>>({
    view: 'review',
    kind: 'All',
    query: '',
    editedOnly: false,
  });
  const feedPath = useMemo(() => {
    const view =
      filters.view === 'review' ? 'active' : filters.view === 'later' ? 'deferred' : 'all';
    const state =
      filters.view === 'review'
        ? 'pending'
        : filters.view === 'later'
          ? 'deferred'
          : filters.view === 'saved'
            ? 'accepted'
            : 'kept_original';
    const selection = new URLSearchParams(selectionQuery);
    const groupId = selection.get('group') || selection.get('report');
    const intakeId = selection.get('intake');
    const params = new URLSearchParams({ view, state, limit: '100' });
    if ((groupId || intakeId) && !selection.has('person')) {
      params.set('view', 'all');
      params.delete('state');
      if (groupId) params.set('groupId', groupId);
      if (intakeId) params.set('intakeId', intakeId);
      if (selection.get('record')) params.set('recordId', selection.get('record')!);
    }
    if (filters.query) params.set('q', filters.query);
    if (filters.kind !== 'All') params.set('kind', feedKind[filters.kind] || 'unsupported');
    if (filters.editedOnly && filters.kind !== 'People') params.set('edited', 'true');
    return `/intakes/import-feed?${params}`;
  }, [filters, selectionQuery]);
  const feed = useResource<IntakeImportFeed>(feedPath, 'review_open');
  const [pagedFeed, setPagedFeed] = useState<IntakeImportFeed | null>(null);
  const [pagedFeedScope, setPagedFeedScope] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const limits = useResource<{ uploadBytes: number; extractionBytes: number }>('/intakes/limits');
  const batch = useIntakeBatch(profile?.id || '');
  const [people, setPeople] = useState<IntakePersonProposal[]>([]);
  const [peopleNext, setPeopleNext] = useState<Map<string, string>>(new Map());
  const [identityReviews, setIdentityReviews] = useState<Map<string, IntakeIdentityReview>>(
    new Map(),
  );
  const [identityReviewErrors, setIdentityReviewErrors] = useState<Map<string, string>>(new Map());
  const identityReviewGeneration = useRef(0);
  const identityReviewLoads = useRef(new Map<string, IdentityReviewLoad>());
  const identityGroundingRefreshes = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [operationStatus, setOperationStatus] = useState<string | null>(null);
  const [draftRepairUndo, setDraftRepairUndo] = useState<DraftRepairUndo | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recentSavedPeople, setRecentSavedPeople] = useState<SavedPersonDestination[]>([]);
  const [savedDestinationsError, setSavedDestinationsError] = useState('');
  const [savedDestinations, setSavedDestinations] = useState<Map<string, IntakeAcceptedRecord>>(
    new Map(),
  );
  const activeProfile = useRef(profile?.id);
  const activeFeedPath = useRef(feedPath);
  const activeSelectionQuery = useRef(selectionQuery);
  const identityPageMounted = useRef(false);
  const pendingOperations = useRef(new Map<string, { operationId: string }>());
  const [historicalSelection, setHistoricalSelection] = useState<HistoricalImportSelection | null>(
    null,
  );
  activeProfile.current = profile?.id;
  activeFeedPath.current = feedPath;
  activeSelectionQuery.current = selectionQuery;
  const profileIdentitySignature = JSON.stringify([
    profile?.id ?? null,
    profile?.nameVersion ?? null,
    profile?.version ?? null,
  ]);
  useAssistantSelection(undefined, 'Import');

  useEffect(() => {
    identityPageMounted.current = true;
    return () => {
      identityPageMounted.current = false;
      identityReviewGeneration.current += 1;
      identityReviewLoads.current.clear();
    };
  }, []);

  useEffect(() => {
    identityReviewGeneration.current += 1;
    setPagedFeed(null);
    setPagedFeedScope('');
    setPeople([]);
    setPeopleNext(new Map());
    setIdentityReviews(new Map());
    setIdentityReviewErrors(new Map());
    identityReviewLoads.current.clear();
    setError('');
    setNotice('');
    setRecentSavedPeople([]);
    setSavedDestinationsError('');
    setSavedDestinations(new Map());
    setBusy(false);
    setUploadStatus(null);
    setOperationStatus(null);
    setDraftRepairUndo(null);
    setHistoricalSelection(null);
    pendingOperations.current.clear();
  }, [profile?.id]);

  useEffect(() => {
    setPagedFeed(feed.data);
    setPagedFeedScope(`${profile?.id || ''}:${feedPath}`);
  }, [feed.data, feedPath, profile?.id]);
  const requestScope = `${profile?.id || ''}:${feedPath}`;
  const displayedFeed = pagedFeedScope === requestScope ? pagedFeed : null;

  useEffect(() => {
    const refreshRestoredImport = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      // A retained-original navigation can restore this page from the browser's
      // back-forward cache before an in-flight identity refresh completed. Do
      // not leave the pre-confirmation action usable while current state loads.
      identityReviewGeneration.current += 1;
      identityReviewLoads.current.clear();
      setIdentityReviews(new Map());
      setIdentityReviewErrors(new Map());
      feed.reload();
    };
    window.addEventListener('pageshow', refreshRestoredImport);
    return () => window.removeEventListener('pageshow', refreshRestoredImport);
  }, [feed.reload]);

  useEffect(() => {
    const data = displayedFeed;
    const requestedProfile = profile?.id;
    setSavedDestinationsError('');
    setSavedDestinations(new Map());
    if (!data || !requestedProfile) return;
    const prefix = `/api/profiles/${encodeURIComponent(requestedProfile)}`;
    identityReviewGeneration.current += 1;
    const clinicalGroups = data.groups.filter((group) =>
      data.blocks.some((block) => block.groupId === group.groupId && block.records.length > 0),
    );
    const activeSignatures = new Map(
      clinicalGroups.map((group) => [
        group.groupId,
        identityReviewSignature(profileIdentitySignature, group),
      ]),
    );
    for (const groupId of identityGroundingRefreshes.current.keys())
      if (
        !activeSignatures.has(groupId) ||
        !data.blocks.some(
          (block) =>
            block.groupId === groupId &&
            block.records.some((record) => record.identityReview?.blocking),
        )
      )
        identityGroundingRefreshes.current.delete(groupId);
    for (const [groupId, load] of identityReviewLoads.current) {
      if (activeSignatures.get(groupId) === load.signature) continue;
      identityReviewLoads.current.delete(groupId);
    }
    setIdentityReviews((reviews) => {
      const next = new Map(
        [...reviews].filter(
          ([groupId]) =>
            activeSignatures.get(groupId) === identityReviewLoads.current.get(groupId)?.signature,
        ),
      );
      return next.size === reviews.size ? reviews : next;
    });
    setIdentityReviewErrors((errors) => {
      const next = new Map(
        [...errors].filter(
          ([groupId]) =>
            activeSignatures.get(groupId) === identityReviewLoads.current.get(groupId)?.signature,
        ),
      );
      return next.size === errors.size ? errors : next;
    });
    for (const group of clinicalGroups) {
      const signature = activeSignatures.get(group.groupId)!;
      const previous = identityReviewLoads.current.get(group.groupId);
      // An unrelated feed refresh must not replace an in-flight request and
      // starve this exact report. Resolved entries may refresh in place.
      if (previous?.signature === signature && previous.pending) continue;
      const load: IdentityReviewLoad = { pending: true, signature, token: Symbol() };
      identityReviewLoads.current.set(group.groupId, load);
      void api<IntakeIdentityReview>(
        `${prefix}/intakes/${encodeURIComponent(group.intakeId)}/identity-review?groupId=${encodeURIComponent(group.groupId)}`,
      )
        .then(({ data: review }) => {
          if (
            activeProfile.current !== requestedProfile ||
            identityReviewLoads.current.get(group.groupId)?.token !== load.token
          )
            return;
          identityReviewLoads.current.set(group.groupId, { ...load, pending: false });
          recordIdentityReviewDiagnostic(review);
          setIdentityReviews((reviews) => new Map(reviews).set(group.groupId, review));
          const groundingRefreshKey = JSON.stringify([
            signature,
            review.scope?.scopeToken,
            data.blocks
              .filter((block) => block.groupId === group.groupId)
              .map((block) => block.reviewToken),
          ]);
          if (
            ['prior_confirmation', 'evidenced_match'].includes(review.status) &&
            !review.blocking &&
            identityGroundingRefreshes.current.get(group.groupId) !== groundingRefreshKey &&
            data.blocks.some(
              (block) =>
                block.groupId === group.groupId &&
                block.records.some((record) => record.identityReview?.blocking),
            )
          ) {
            // The host has just grounded an existing confirmation on this page.
            // Reload eligibility and exact review tokens before exposing Save.
            // If the same row still blocks, do not loop on an unchanged scope.
            identityGroundingRefreshes.current.set(group.groupId, groundingRefreshKey);
            feed.reload();
          }
          setIdentityReviewErrors((errors) => {
            if (!errors.has(group.groupId)) return errors;
            const next = new Map(errors);
            next.delete(group.groupId);
            return next;
          });
        })
        .catch((cause) => {
          if (
            activeProfile.current !== requestedProfile ||
            identityReviewLoads.current.get(group.groupId)?.token !== load.token
          )
            return;
          identityReviewLoads.current.set(group.groupId, { ...load, pending: false });
          setIdentityReviews((reviews) => {
            if (!reviews.has(group.groupId)) return reviews;
            const next = new Map(reviews);
            next.delete(group.groupId);
            return next;
          });
          setIdentityReviewErrors((errors) =>
            new Map(errors).set(group.groupId, errorMessage(cause)),
          );
        });
    }
  }, [displayedFeed, profile?.id, profileIdentitySignature, feed.reload]);

  const [acceptanceReceipt, setAcceptanceReceipt] = useState<IntakeReportAcceptanceReceipt | null>(
    null,
  );
  useEffect(() => setAcceptanceReceipt(null), [profile?.id]);
  const acceptance = useReportAcceptance(profile?.id || '', (result) => {
    setBusy(false);
    setAcceptanceReceipt(result.receipt);
    setNotice(
      result.receipt.acceptedCount === result.receipt.selectedCount
        ? `Imported ${result.receipt.acceptedCount} ${result.receipt.acceptedCount === 1 ? 'record' : 'records'}`
        : acceptanceSummary(result.receipt),
    );
    feed.reload();
  });

  useEffect(() => {
    const data = displayedFeed;
    const requestedProfile = profile?.id;
    if (!data) return;
    const acceptedBlocks = data.blocks.filter((block) =>
      block.records.some((record) => record.queueState === 'accepted'),
    );
    if (!acceptedBlocks.length) {
      setSavedDestinations(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(
      [...new Set(acceptedBlocks.map((block) => block.intakeId))].map(
        async (intakeId) =>
          [intakeId, (await api<Intake>(`/intakes/${encodeURIComponent(intakeId)}`)).data] as const,
      ),
    )
      .then((intakes) => {
        if (cancelled || activeProfile.current !== requestedProfile) return;
        const byIntake = new Map(intakes);
        const next = new Map<string, IntakeAcceptedRecord>();
        for (const block of acceptedBlocks) {
          const intake = byIntake.get(block.intakeId);
          if (!intake) continue;
          const rows = block.records.filter((record) => record.queueState === 'accepted');
          const accepted = acceptedRecordsForScope(intake, {
            groupId: block.groupId,
            proposalId: block.proposalId,
            recordIds: rows.map((record) => record.id),
          });
          for (const row of rows) {
            const destination = accepted.find((record) => record.recordId === row.id);
            if (destination) next.set(row.feedKey, destination);
          }
        }
        setSavedDestinations(next);
      })
      .catch(() => {
        if (cancelled || activeProfile.current !== requestedProfile) return;
        setSavedDestinationsError(
          'Saved record links could not load. Your saved records are unchanged.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [displayedFeed, profile?.id]);

  const batchKey = batch.batch?.items
    .map(
      (item) =>
        `${item.intakeId}:${item.status}:${item.reading?.status || ''}:${item.reading?.readyRecords || 0}:${item.reading?.remainingUnits || 0}:${item.reading?.readWindows || 0}:${item.reading?.pendingReadWindows || 0}:${item.reading?.phase || ''}:${item.readingJob?.slices || 0}`,
    )
    .join('|');
  useEffect(() => {
    if (batchKey) feed.reload();
  }, [batchKey]);

  useEffect(() => {
    const groups = displayedFeed?.people.groups || [];
    const requestedProfile = profile?.id;
    if (!groups.length) {
      setPeople([]);
      return;
    }
    let cancelled = false;
    const prefix = `/api/profiles/${encodeURIComponent(requestedProfile || '')}`;
    Promise.all(
      groups.map(
        async (group) =>
          (
            await api<IntakePeopleQueue>(
              `${prefix}/intakes/people/${encodeURIComponent(group.groupId)}?limit=100`,
            )
          ).data,
      ),
    )
      .then((pages) => {
        if (!cancelled && activeProfile.current === requestedProfile) {
          setPeople(pages.flatMap((page) => page.people));
          setPeopleNext(
            new Map(
              pages.flatMap((page) =>
                page.peopleNextCursor ? [[page.groupId, page.peopleNextCursor] as const] : [],
              ),
            ),
          );
        }
      })
      .catch((cause) => {
        if (!cancelled && activeProfile.current === requestedProfile) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [displayedFeed?.people.groups, profile?.id]);

  const lookup = useMemo(() => {
    const records = new Map<
      string,
      { block: IntakeImportFeed['blocks'][number]; record: IntakeImportFeedRecord }
    >();
    for (const block of displayedFeed?.blocks || [])
      for (const record of block.records) records.set(record.feedKey, { block, record });
    return records;
  }, [displayedFeed?.blocks]);

  const requestedSelection = useMemo(() => {
    const params = new URLSearchParams(selectionQuery);
    const intakeId = params.get('intake') || undefined;
    const requestedGroup = params.get('group') || params.get('report') || undefined;
    const proposal = params.get('proposal');
    const proposalId = proposal === null ? undefined : proposal === 'original' ? null : proposal;
    const recordId = params.get('record') || undefined;
    const personId = params.get('person') || undefined;
    return { intakeId, requestedGroup, proposal, proposalId, recordId, personId };
  }, [selectionQuery]);

  const inferredFeedGroup = useMemo(() => {
    const { intakeId, requestedGroup, proposal, proposalId, recordId } = requestedSelection;
    // No selector means the overview, not the first available report. In particular,
    // an absent proposal parameter must not behave like an explicit original proposal.
    if (requestedGroup || (!intakeId && proposal === null && !recordId)) return undefined;
    return displayedFeed?.groups.find(
      (group) =>
        (!intakeId || group.intakeId === intakeId) &&
        (proposal === null ||
          displayedFeed.blocks.some(
            (block) => block.groupId === group.groupId && block.proposalId === (proposalId ?? null),
          )) &&
        (!recordId ||
          displayedFeed.blocks.some(
            (block) =>
              block.groupId === group.groupId &&
              block.intakeId === (intakeId || block.intakeId) &&
              block.records.some((record) => record.id === recordId),
          )),
    )?.groupId;
  }, [displayedFeed, requestedSelection]);

  const historicalSelectionKey =
    requestedSelection.intakeId && !requestedSelection.requestedGroup && !inferredFeedGroup
      ? JSON.stringify([
          profile?.id || '',
          requestedSelection.intakeId,
          requestedSelection.proposal ?? '',
          requestedSelection.recordId || '',
        ])
      : null;
  const activeHistoricalSelection =
    historicalSelection?.key === historicalSelectionKey ? historicalSelection : null;

  useEffect(() => {
    const { intakeId, requestedGroup, proposal, proposalId, recordId } = requestedSelection;
    if (!intakeId || requestedGroup || inferredFeedGroup) {
      setHistoricalSelection(null);
      return;
    }
    const key = JSON.stringify([profile?.id || '', intakeId, proposal ?? '', recordId || '']);
    let cancelled = false;
    setHistoricalSelection({ key, loading: true });
    void (async () => {
      try {
        const intake = (await api<Intake>(`/intakes/${encodeURIComponent(intakeId)}`)).data;
        let groupId: string | undefined;
        if (recordId || proposal !== null) {
          const query = proposalId ? `?proposalId=${encodeURIComponent(proposalId)}` : '';
          const review = (
            await api<IntakeReview>(`/intakes/${encodeURIComponent(intakeId)}/review${query}`)
          ).data;
          const exactRecord = recordId
            ? review.records.find((record) => record.id === recordId)
            : review.records[0];
          if (recordId && !exactRecord)
            throw new Error('That exact record is no longer present in the selected proposal.');
          groupId = exactRecord?.reportGroups?.[0]?.groupId;
        }
        groupId ||= intake.workflow?.reportGroups?.[0]?.id;
        if (!groupId)
          throw new Error('This historical link does not identify a retained report to review.');
        if (!cancelled) setHistoricalSelection({ key, groupId, loading: false });
      } catch (cause) {
        if (!cancelled)
          setHistoricalSelection({
            key,
            loading: false,
            error: `${errorMessage(cause)} Open Import to choose the current report.`,
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inferredFeedGroup, profile?.id, requestedSelection]);

  const detailSelection = useMemo<ImportDetailSelection | null>(() => {
    const { intakeId, requestedGroup, proposalId, recordId, personId } = requestedSelection;
    const groupId = requestedGroup || inferredFeedGroup || activeHistoricalSelection?.groupId;
    if (!groupId) return null;
    return { groupId, intakeId, proposalId, recordId, personId };
  }, [activeHistoricalSelection?.groupId, inferredFeedGroup, requestedSelection]);

  function closeDetail() {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const key of ['group', 'report', 'intake', 'proposal', 'record', 'person', 'review'])
          next.delete(key);
        return next;
      },
      { replace: true },
    );
  }

  const model = useMemo<ImportReviewModel>(() => {
    const data = displayedFeed;
    const groups = [
      ...new Map(
        [...(data?.groups || []), ...(data?.people.groups || [])].map((group) => [
          group.groupId,
          group,
        ]),
      ).values(),
    ];
    const groupRecords = new Map<string, IntakeImportFeedRecord[]>();
    for (const block of data?.blocks || [])
      groupRecords.set(block.groupId, [
        ...(groupRecords.get(block.groupId) || []),
        ...block.records,
      ]);
    const reports = groups.map((group) => {
      const rows = groupRecords.get(group.groupId) || [];
      const sourceConfirmed = group.sourceCoverage?.current.status === 'single';
      const effectiveSource = sourceConfirmed
        ? group.sourceCoverage?.current.bySource[0]?.source
        : null;
      const rowDates = [
        ...new Set(
          rows
            .map((record) => {
              const mapping = initialDraft(record).decision.mapping;
              return mapping.date || mapping.startDate || mapping.documentDate || record.date;
            })
            .filter((value): value is string => !!value),
        ),
      ];
      const identityReview = identityReviews.get(group.groupId);
      const identityStatus = identityReview?.status;
      const subjectLabel =
        identityReview?.assignedPerson?.fullName ||
        identityReview?.evidencedIdentity?.fullName ||
        profile?.name ||
        'Self';
      return {
        id: group.groupId,
        sourceIntakeId: group.intakeId,
        filename: group.original.filename,
        source:
          group.sourceSuggestion && !sourceConfirmed
            ? group.sourceSuggestion.value
            : effectiveSource || group.source || 'Source not labeled',
        sourceSuggested: !!group.sourceSuggestion && !sourceConfirmed,
        sourceLabelAvailable: !!group.sourceLabelScope,
        sourceNeedsLabel: !group.source && !group.sourceSuggestion,
        sourceEvidence: (group.sourceSuggestion || group.sourceLabelScope)?.evidence,
        sourceConfirmed,
        sourceCoverage: group.sourceCoverage,
        reportType: group.title,
        date:
          group.date || (rowDates.length > 1 ? 'Multiple dates' : rowDates[0] || 'Date not given'),
        subject: {
          label: subjectLabel,
          evidence: identityReview?.evidencedIdentity ? ('named' as const) : ('missing' as const),
          confirmed:
            identityStatus === 'evidenced_match' || identityStatus === 'prior_confirmation',
          identityStatus,
          nameOnlyMatch:
            identityStatus === 'evidenced_match' && !identityReview?.evidencedIdentity.birthDate,
          birthDate: identityReview?.evidencedIdentity.birthDate,
          birthDateReview: identityReview?.scope?.birthDateReview,
          selfBirthDateConflict: identityReview?.selfBirthDateConflict,
          defaultPerson: identityReview?.defaultPerson,
          identityMessage:
            identityReview?.message ||
            (identityReviewErrors.has(group.groupId)
              ? 'Identity status could not load. Retry before saving this report.'
              : 'Checking the retained identity evidence…'),
          warnings: identityReview?.warnings,
          blocking: identityReview?.blocking ?? identityReviewErrors.has(group.groupId),
          offeredSelfFields: identityReview?.offeredSelfFields || {},
          people: identityReview?.people,
          peopleTruncated: identityReview?.peopleTruncated,
          assignedPerson: identityReview?.assignedPerson,
          printedName: identityReview?.evidencedIdentity.fullName,
          printedNameRequired:
            !!identityReview?.scope && !identityReview.evidencedIdentity.fullName,
          selfDisplayName: profile?.name || 'Self',
          selfNames: identityReview
            ? [identityReview.self.fullName || '', ...(identityReview.self.knownNames || [])]
            : [],
          evidenceText:
            identityReview?.scope?.subject.text || identityReview?.evidencedIdentity?.fullName,
          questions: identityReview?.scope?.questions,
          targetCount: (identityReview?.scope?.assignmentTargets || identityReview?.scope?.targets)
            ?.length,
          scopeReady: !!identityReview?.scope,
          scopeError: identityReviewErrors.get(group.groupId),
          conflicts: identityReview?.conflicts || [],
          reviewUrl: `/import?${new URLSearchParams({ group: group.groupId, intake: group.intakeId })}`,
          hidden: rows.length === 0,
        },
      };
    });
    const records: ImportReviewRecord[] = (data?.blocks || [])
      .flatMap((block) => {
        const group = groups.find((item) => item.groupId === block.groupId);
        if (!group) return [];
        return block.records.map((record) => {
          const literal = recordValue(record);
          const mapping = initialDraft(record).decision.mapping;
          return {
            id: record.feedKey,
            approval:
              record.candidateId && record.candidateVersionId
                ? {
                    intakeId: block.intakeId,
                    proposalId: block.proposalId,
                    intakeVersion: block.intakeVersion,
                    reviewToken: block.reviewToken,
                    selections: [
                      {
                        recordId: record.id,
                        candidateId: record.candidateId,
                        candidateVersionId: record.candidateVersionId,
                        selectionReviewToken: record.selectionReviewToken,
                        mapping: initialDraft(record).decision.mapping,
                        comparisons: initialDraft(record).decision.comparisons,
                      },
                    ],
                  }
                : undefined,
            reportId: group.groupId,
            kind: kind[record.feedKind],
            label: recordLabel(record),
            originalLabel: record.mapping.label || record.title,
            value: literal.value,
            unit: literal.unit,
            date:
              mapping.date || mapping.startDate || mapping.documentDate || record.date || undefined,
            status: status(record.queueState),
            eligible: record.selectable,
            saveBlockReason: recordSaveBlockReason(record),
            saveBlockReview:
              !hasUnreviewedPairChoices(record) &&
              (record.identityReview?.blocking ||
                record.issues?.find((issue) => issue.blocking && issue.status !== 'resolved')
                  ?.kind === 'identity')
                ? ('identity' as const)
                : undefined,
            manuallyEdited: record.manuallyEdited,
            possibleOverlap: possibleSavedOverlapCount(record, mapping) > 0,
            relatedMatch:
              record.duplicateOf &&
              !record.duplicateOf.sameSourceRecord &&
              record.duplicateOf.persistedMatch !== false
                ? {
                    value: record.duplicateOf.label,
                    source: 'saved record',
                    date: record.duplicateOf.date || 'Date unknown',
                  }
                : undefined,
            originalUrl: group.original.contentUrl,
            detailUrl: detailUrl(group, block, record),
            savedDestination: savedDestinations.get(record.feedKey),
            draftRepair:
              record.classification !== 'unsupported' &&
              (record.queueState === 'pending' || record.queueState === 'deferred') &&
              record.candidateVersionId &&
              (mapping.kind === 'observation' || mapping.kind === 'procedure')
                ? {
                    intakeId: block.intakeId,
                    proposalId: block.proposalId,
                    recordId: record.id,
                    candidateVersionId: record.candidateVersionId,
                    fields: {
                      ...(mapping.kind === 'observation' || mapping.kind === 'procedure'
                        ? { date: mapping.date || '' }
                        : {}),
                      ...(mapping.kind === 'observation'
                        ? {
                            method: mapping.method || '',
                            observationCategory: mapping.observationCategory || '',
                          }
                        : {}),
                    },
                  }
                : undefined,
          };
        });
      })
      .sort((left, right) => {
        const a = lookup.get(left.id)?.record.feedOrder || '';
        const b = lookup.get(right.id)?.record.feedOrder || '';
        return a.localeCompare(b);
      });
    for (const proposal of people) {
      const group = groups.find((item) => item.groupId === proposal.groupId);
      if (!group) continue;
      records.push({
        id: `person:${proposal.id}`,
        reportId: proposal.groupId,
        kind: 'People',
        label: proposal.person.fullName,
        originalLabel: proposal.title,
        value: proposal.person.relationship || proposal.person.tags.join(' · ') || 'Named person',
        status:
          proposal.state === 'pending'
            ? 'review'
            : proposal.state === 'later'
              ? 'later'
              : proposal.state === 'saved'
                ? 'saved'
                : 'excluded',
        eligible:
          (proposal.state === 'pending' || proposal.state === 'later') &&
          !proposal.selfMatch &&
          proposal.matches.length === 0,
        saveBlockReason: proposal.selfMatch
          ? 'This person may be Self. Review the person before adding them.'
          : proposal.matches.length
            ? 'Review the possible person matches before adding this person.'
            : undefined,
        originalUrl: proposal.source.contentUrl,
        detailUrl: `/import?${new URLSearchParams({ group: proposal.groupId, intake: proposal.intakeId, person: proposal.id })}`,
        savedPersonDestination: proposal.saved
          ? {
              proposalId: proposal.id,
              noteId: proposal.saved.noteId,
              personId: proposal.saved.personId,
              resultUrl: proposal.saved.resultUrl,
              title: proposal.person.fullName,
            }
          : undefined,
      });
    }
    const peopleCount = data
      ? filters.view === 'review'
        ? data.people.counts.pending
        : filters.view === 'later'
          ? data.people.counts.later
          : filters.view === 'saved'
            ? data.people.counts.saved
            : data.people.counts.excluded
      : 0;
    const activeFiles = (data?.activity.runningFiles || 0) + (data?.activity.queuedFiles || 0);
    const pausedItem = batch.batch?.items.find(hasPausedIntakeReading);
    const currentItem =
      batch.batch?.items.find((item) => ['running', 'starting'].includes(item.status)) ||
      batch.batch?.items.find((item) => item.status === 'queued') ||
      pausedItem;
    const reading = currentItem?.reading;
    const readingDetail =
      currentItem?.reason === 'source_prerequisite'
        ? 'Local OCR is unavailable. Processing will retry when the shared prerequisite is restored.'
        : currentItem?.reason === 'provider_rejected'
          ? intakeReadingPauseLabel('provider_rejected')
          : currentItem?.reason === 'provider_authentication'
            ? 'Sign in to the configured provider. Eligible imports will continue automatically.'
            : currentItem?.reason === 'retrying_extraction'
              ? 'Retrying the interrupted source section from saved progress.'
              : currentItem?.reason === 'model_unavailable'
                ? 'Waiting for the model connection. Your progress is saved.'
                : currentItem?.reason === 'waiting_for_provider'
                  ? (currentItem.providerWait?.outcome === 'unknown'
                      ? "The previous request's result is unknown; retrying may use additional provider usage."
                      : 'Waiting for the provider.') +
                    (currentItem.providerWait?.retryAt
                      ? ' Next attempt: ' +
                        new Date(currentItem.providerWait.retryAt).toLocaleTimeString() +
                        '.'
                      : ' The finish time is uncertain.')
                  : currentItem?.reason === 'waiting_for_local_capacity'
                    ? 'Moxie will continue when the app is ready. Your progress is saved.'
                    : currentItem?.reason === 'extracting_source_text'
                      ? 'Moxie is getting your files ready.'
                      : currentItem?.reason === 'continuing'
                        ? 'Moxie is continuing to read. Your progress is saved.'
                        : reading?.phase === 'indexing_source'
                          ? 'Moxie is getting your files ready.'
                          : reading?.phase === 'reading_source'
                            ? 'Results appear here as Moxie reads.'
                            : reading?.phase === 'preparing_results'
                              ? 'Moxie is preparing the records for your review.'
                              : reading?.phase === 'waiting_for_model'
                                ? 'Results appear here as Moxie reads. You can leave this page.'
                                : 'Moxie is getting ready to read. Your progress is saved.';
    const paused = batch.batch?.status === 'stopped' || batch.batch?.status === 'paused';
    return {
      confirmedSavedIds: acceptanceReceipt?.receipts.flatMap((block) =>
        block.records.map((record) =>
          JSON.stringify([block.intakeId, record.candidateId, record.candidateVersionId]),
        ),
      ),
      contextKey: `${profile?.id || ''}:${feedPath}`,
      loading: !data,
      reports,
      records,
      counts: data
        ? {
            review: data.counts.pending + data.people.counts.pending,
            later: data.counts.deferred + data.people.counts.later,
            excluded: data.counts.keptOriginal + data.people.counts.excluded,
            saved: data.counts.accepted + data.people.counts.saved,
          }
        : { review: 0, later: 0, excluded: 0, saved: 0 },
      kindCounts: data
        ? {
            All:
              data.kindCounts.test +
              data.kindCounts.prescription +
              data.kindCounts.vision +
              data.kindCounts.procedure +
              data.kindCounts.history +
              data.kindCounts.unsupported +
              peopleCount,
            'Test results': data.kindCounts.test,
            Prescriptions: data.kindCounts.prescription,
            Vision: data.kindCounts.vision,
            Procedures: data.kindCounts.procedure,
            Documents: data.kindCounts.history,
            People: peopleCount,
          }
        : undefined,
      filters,
      hasMore: !!data?.nextCursor || !!data?.people.nextCursor || peopleNext.size > 0,
      loadingMore,
      searchAppliedByModel: true,
      operationStatus: operationStatus || undefined,
      activity: {
        activeFiles: batch.batch?.status === 'running' ? Math.max(1, activeFiles) : 0,
        uploading: !!uploadStatus,
        controlsBusy: batch.busy,
        detailIsImportant:
          !!uploadStatus ||
          [
            'waiting_for_provider',
            'waiting_for_local_capacity',
            'provider_authentication',
            'provider_rejected',
            'retrying_extraction',
            'source_prerequisite',
            'model_unavailable',
          ].includes(currentItem?.reason || ''),
        resumeLabel: 'Resume imports',
        progress: batch.batch
          ? {
              elapsedStartedAt: batch.batch.createdAt,
              elapsedEndedAt: batch.batch.status === 'running' ? null : batch.batch.updatedAt,
              accounted: batch.batch.items.reduce(
                (sum, item) => sum + (item.reading?.accountedUnits || 0),
                0,
              ),
              total: batch.batch.items.reduce(
                (sum, item) => sum + (item.reading?.totalUnits || 0),
                0,
              ),
              files: batch.batch.items.map((item) => ({
                accounted: item.reading?.accountedUnits || 0,
                total: item.reading?.totalUnits || 0,
                readWindows: item.reading?.distinctReads ?? item.reading?.readWindows ?? 0,
                activeMs: item.readingJob?.activeMs || 0,
                sliceStartedAt: item.readingJob?.sliceStartedAt || null,
                retryAt: item.retryAt || item.providerWait?.retryAt || null,
                uncertain: [
                  'source_prerequisite',
                  'provider_authentication',
                  'provider_rejected',
                  'model_unavailable',
                ].includes(item.reason || ''),
                done: !item.automaticRun,
                exceptions: item.exceptions?.length || 0,
              })),
              readyRecords: batch.batch.items.reduce(
                (total, item) => total + (item.reading?.readyRecords || 0),
                0,
              ),
              readWindows: batch.batch.items.reduce(
                (sum, item) =>
                  sum + (item.reading?.distinctReads ?? item.reading?.readWindows ?? 0),
                0,
              ),
              activeMs: currentItem?.readingJob?.activeMs || 0,
              sliceStartedAt: currentItem?.readingJob?.sliceStartedAt || null,
              lastProgressAt:
                [currentItem?.readingJob?.lastProgressAt, reading?.pageTiming?.lastCompletedAt]
                  .filter((value): value is string => !!value)
                  .sort()
                  .at(-1) || null,
              pageTiming: reading?.pageTiming,
            }
          : undefined,
        label:
          uploadStatus ||
          (batch.batch?.status === 'complete'
            ? batch.batch.reason === 'exceptions'
              ? 'Done, with exceptions'
              : 'Done'
            : batch.batch?.status === 'stopped'
              ? 'Imports stopped'
              : currentItem?.reason === 'waiting_for_provider'
                ? 'Waiting for provider'
                : currentItem?.reason === 'source_prerequisite'
                  ? 'Waiting for local extraction'
                  : currentItem?.reason === 'retrying_extraction'
                    ? 'Retrying extraction'
                    : batch.batch?.reason === 'needs_user_action' ||
                        currentItem?.reason === 'provider_rejected'
                      ? 'Import needs attention'
                      : currentItem?.reason === 'provider_authentication'
                        ? 'Provider sign-in needed'
                        : activeFiles
                          ? `Moxie is reading ${activeFiles} ${activeFiles === 1 ? 'file' : 'files'}`
                          : paused
                            ? 'Reading paused'
                            : reportActivityLabel(
                                data?.activity || {
                                  runningFiles: 0,
                                  pausedFiles: 0,
                                  queuedFiles: 0,
                                  filesAwaitingConversion: 0,
                                  remainingUnits: 0,
                                  extractionUnknownFiles: 0,
                                  extractionComplete: false,
                                  allCurrentReportsReviewed: false,
                                },
                              )),
        detail: uploadStatus
          ? 'Keep this page open until the original is retained.'
          : batch.batch?.status === 'running'
            ? readingDetail
            : pausedItem
              ? intakeReadingPauseLabel(
                  ['source_review_required', 'source_changed'].includes(pausedItem.reason || '') ||
                    pausedItem.reason?.startsWith('provider_')
                    ? pausedItem.reason
                    : pausedItem.reading?.reason || pausedItem.reason,
                )
              : paused
                ? 'Reading stopped before every report finished. Completed results and originals are kept.'
                : data?.activity.readingAccounting?.sourceCount === 0
                  ? 'Choose a report above. Moxie will read it and show results here for review.'
                  : 'Completed work and originals are kept.',
        paused,
      },
    };
  }, [
    acceptanceReceipt,
    batch.batch,
    batch.busy,
    displayedFeed,
    filters,
    identityReviews,
    identityReviewErrors,
    loadingMore,
    lookup,
    operationStatus,
    people,
    peopleNext,
    profile?.name,
    savedDestinations,
    uploadStatus,
  ]);

  async function perform(
    action: (context: {
      prefix: string;
      current: () => boolean;
      operationId: string;
      request: typeof api;
    }) => Promise<void>,
    kind: ClientOperationSummary['kind'] = 'review_action',
    counts: ClientOperationSummary['counts'] = { actions: 1 },
  ): Promise<boolean> {
    if (busy || acceptance.busy || acceptance.recovering || acceptance.recoveryOperationId)
      return false;
    const requestedProfile = profile?.id;
    if (!requestedProfile) return false;
    const prefix = `/api/profiles/${encodeURIComponent(requestedProfile)}`;
    const current = () => activeProfile.current === requestedProfile;
    const operation = beginClientOperation(kind, counts);
    const started = performance.now();
    let outcome: ClientOperationSummary['outcome'] = 'completed';
    const request: typeof api = (path, options) =>
      api(path, { ...options, operationId: operation.operationId });
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action({ prefix, current, operationId: operation.operationId, request });
      return true;
    } catch (cause) {
      outcome = current() ? 'failed' : 'cancelled';
      if (activeProfile.current === requestedProfile) setError(errorMessage(cause));
      return false;
    } finally {
      if (activeProfile.current === requestedProfile) {
        setBusy(false);
        setUploadStatus(null);
        setOperationStatus(null);
      }
      operation.phase('action_work', started);
      operation.afterRender(current() ? outcome : 'cancelled');
    }
  }

  function personFor(id: string) {
    return id.startsWith('person:')
      ? people.find((proposal) => proposal.id === id.slice('person:'.length))
      : undefined;
  }

  function exactRequest<T extends { operationId: string }>(key: string, build: () => T) {
    const retained = pendingOperations.current.get(key) as T | undefined;
    if (retained) return retained;
    const request = build();
    pendingOperations.current.set(key, request);
    return request;
  }

  async function exactMutation<T>(key: string, send: () => Promise<T>) {
    try {
      const result = await send();
      pendingOperations.current.delete(key);
      return result;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500)
        pendingOperations.current.delete(key);
      throw cause;
    }
  }

  async function freshPerson(prefix: string, proposal: IntakePersonProposal) {
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const page = (
        await api<IntakePeopleQueue>(
          `${prefix}/intakes/people/${encodeURIComponent(proposal.groupId)}?${query}`,
        )
      ).data;
      const current = page.people.find((item) => item.id === proposal.id);
      if (current) return current;
      cursor = page.peopleNextCursor;
    } while (cursor);
    throw new Error(`${proposal.person.fullName} changed. Review People again.`);
  }

  async function setPersonState(
    proposal: IntakePersonProposal,
    state: 'pending' | 'later' | 'excluded',
    prefix: string,
  ) {
    const fresh = await freshPerson(prefix, proposal);
    const operationKey = `person-disposition:${fresh.id}:${state}`;
    const request = exactRequest<IntakePersonDispositionRequest>(operationKey, () => ({
      operationId: crypto.randomUUID(),
      intakeId: fresh.intakeId,
      proposalId: fresh.id,
      proposalVersion: fresh.version,
      state,
      intakeVersion: fresh.intakeVersion,
    }));
    await exactMutation(operationKey, () =>
      api<Intake>(`${prefix}/intakes/people-disposition`, {
        method: 'POST',
        body: JSON.stringify(request),
      }),
    );
  }

  async function disposition(ids: string[], next: 'pending' | 'later' | 'excluded') {
    await perform(async ({ prefix, current: profileCurrent, request: requestApi }) => {
      setOperationStatus(`Starting ${ids.length} selected ${ids.length === 1 ? 'item' : 'items'}…`);
      for (const [index, id] of ids.entries()) {
        if (!profileCurrent())
          throw new Error('Profile changed. Remaining items were not changed.');
        const person = personFor(id);
        if (person) {
          await setPersonState(person, next, prefix);
          setOperationStatus(`Updated ${index + 1} of ${ids.length} selected items.`);
          continue;
        }
        const entry = lookup.get(id);
        if (!entry) throw new Error('This result changed. Reload and review it again.');
        const query = entry.block.proposalId
          ? `?proposalId=${encodeURIComponent(entry.block.proposalId)}`
          : '';
        const review = (
          await requestApi<IntakeReview>(
            `${prefix}/intakes/${encodeURIComponent(entry.block.intakeId)}/review${query}`,
          )
        ).data;
        const current = review.records.find(
          (record) =>
            record.id === entry.record.id &&
            record.candidateVersionId === entry.record.candidateVersionId,
        );
        if (!current)
          throw new Error(`${recordLabel(entry.record)} changed. Review the current version.`);
        const draft = initialDraft(current);
        const disposition =
          next === 'later'
            ? 'review_later'
            : next === 'excluded'
              ? 'keep_original_only'
              : 'pending';
        const operationKey = `draft:${entry.record.feedKey}:${next}`;
        const request = exactRequest(operationKey, () => ({
          version: review.version,
          operationId: crypto.randomUUID(),
          proposalId: review.proposalId,
          recordId: current.id,
          candidateVersionId: current.candidateVersionId,
          mapping: draft.decision.mapping,
          resolutions: draft.resolutions,
          answers: draft.answers,
          disposition,
          decision: {
            ...draft.decision,
            action:
              next === 'excluded' || next === 'later' ? ('skip' as const) : ('accept' as const),
          },
        }));
        await exactMutation(operationKey, () =>
          requestApi<Intake>(
            `${prefix}/intakes/${encodeURIComponent(entry.block.intakeId)}/review-draft`,
            {
              method: 'POST',
              body: JSON.stringify(request),
            },
          ),
        );
        setOperationStatus(`Updated ${index + 1} of ${ids.length} selected items.`);
      }
      feed.reload();
      setNotice(
        next === 'later'
          ? `${ids.length} ${ids.length === 1 ? 'item was' : 'items were'} moved to Review later.`
          : next === 'excluded'
            ? `${ids.length} ${ids.length === 1 ? 'item was' : 'items were'} excluded. Originals are kept.`
            : `${ids.length} ${ids.length === 1 ? 'item was' : 'items were'} returned to review.`,
      );
      setOperationStatus(null);
    });
  }

  async function save(ids: string[], approvals?: IntakeReportAcceptanceRequest['blocks']) {
    const savedIds: string[] = [];
    await perform(
      async ({ prefix, current, operationId, request: requestApi }) => {
        setOperationStatus(
          `Preparing ${ids.length} selected ${ids.length === 1 ? 'item' : 'items'}…`,
        );
        const personIds = ids.filter((id) => personFor(id));
        const clinical = ids.filter((id) => !id.startsWith('person:'));
        let savedPeople = 0;
        if (personIds.length && clinical.length)
          throw new Error(
            'Save clinical results and People separately so each exact review stays current.',
          );
        for (const [index, id] of personIds.entries()) {
          if (!current()) throw new Error('Profile changed before saving finished.');
          const proposal = await freshPerson(prefix, personFor(id)!);
          if (proposal.selfMatch || proposal.matches.length)
            throw new Error(`${proposal.person.fullName} needs a People match decision.`);
          const operationKey = `person-apply:${proposal.id}:add`;
          const request = exactRequest<IntakePersonApplyRequest>(operationKey, () => ({
            operationId: crypto.randomUUID(),
            intakeId: proposal.intakeId,
            proposalId: proposal.id,
            proposalVersion: proposal.version,
            action: 'add',
          }));
          const response = await exactMutation(operationKey, () =>
            requestApi<IntakePersonApplyResult>(`${prefix}/intakes/people-apply`, {
              operationId,
              method: 'POST',
              body: JSON.stringify(request),
            }),
          );
          if (!current()) throw new Error('Profile changed before saving finished.');
          const saved = response.data;
          setRecentSavedPeople((destinations) =>
            appendSavedPersonDestination(destinations, {
              proposalId: saved.proposalId,
              noteId: saved.noteId,
              personId: saved.personId,
              resultUrl: saved.resultUrl,
              title: proposal.person.fullName,
            }),
          );
          savedPeople += 1;
          savedIds.push(id);
          setOperationStatus(`Saved ${index + 1} of ${personIds.length} selected people.`);
          setNotice(
            `${savedPeople} ${savedPeople === 1 ? 'person was' : 'people were'} saved. Open the exact ${savedPeople === 1 ? 'entry' : 'entries'} below.`,
          );
          feed.reload();
        }
        if (clinical.length) {
          setOperationStatus(`Checking ${clinical.length} selected clinical records…`);
          const grouped = new Map<string, IntakeReportAcceptanceRequest['blocks'][number]>();
          for (const block of displayedFeed?.blocks || []) {
            const selections = block.records.flatMap((record) => {
              if (
                !clinical.includes(record.feedKey) ||
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
            if (prior) {
              if (
                prior.intakeVersion !== block.intakeVersion ||
                prior.reviewToken !== block.reviewToken
              )
                throw new Error('These results changed. Reload and review the current versions.');
              prior.selections.push(...selections);
            } else
              grouped.set(key, {
                intakeId: block.intakeId,
                proposalId: block.proposalId,
                intakeVersion: block.intakeVersion,
                reviewToken: block.reviewToken,
                selections,
              });
          }
          if (approvals?.length) {
            grouped.clear();
            for (const snapshot of approvals) {
              const key = JSON.stringify([snapshot.intakeId, snapshot.proposalId]);
              const prior = grouped.get(key);
              if (prior) prior.selections.push(...snapshot.selections);
              else grouped.set(key, structuredClone(snapshot));
            }
          }
          const blocks = [...grouped.values()];
          const request: IntakeReportAcceptanceRequest = {
            mode: 'partial-v1',
            operationId: crypto.randomUUID(),
            blocks,
          };
          const result = await acceptance.submit(request, operationId);
          if (!result)
            throw new Error(
              acceptance.error ||
                'Save was not confirmed. Check the saved receipt before retrying.',
            );
          savedIds.push(
            ...result.receipt.receipts.flatMap((block) =>
              block.records.map((record) =>
                JSON.stringify([block.intakeId, record.candidateId, record.candidateVersionId]),
              ),
            ),
          );
          setOperationStatus(acceptanceSummary(result.receipt));
        } else {
          feed.reload();
        }
        setOperationStatus(null);
      },
      'review_save',
      { selected: ids.length, actions: 1 },
    );
    return { savedIds };
  }

  async function correctDrafts(
    selection: IntakeDraftRepairSelection,
    field: IntakeDraftRepairField,
    after: string,
  ): Promise<string | null> {
    const succeeded = await perform(async ({ prefix, current, request: requestApi }) => {
      const selected = selection.rows.map((row) => {
        const entry = [...lookup.values()].find(
          (candidate) =>
            candidate.block.intakeId === selection.intakeId &&
            candidate.block.proposalId === row.proposalId &&
            candidate.record.id === row.recordId &&
            candidate.record.candidateVersionId === row.candidateVersionId,
        );
        if (!entry)
          throw new Error('A selected draft changed. Review the current rows before applying.');
        const shown = model.records.find((record) => record.id === entry.record.feedKey);
        const before = shown?.draftRepair?.fields[field];
        if (before === undefined)
          throw new Error('That field is not editable for every selected draft.');
        return { entry, before };
      });
      const versions = new Set(selected.map(({ entry }) => entry.block.intakeVersion));
      if (versions.size !== 1)
        throw new Error('These drafts changed at different times. Reload before applying.');
      const operationKey = `draft-repair:${selection.groupId}:${field}:${selection.rows
        .map((row) => `${row.recordId}:${row.candidateVersionId}`)
        .join(',')}:${after}`;
      const request = exactRequest<IntakeDraftRepairUpdate>(operationKey, () => ({
        version: selected[0].entry.block.intakeVersion,
        operationId: crypto.randomUUID(),
        groupId: selection.groupId,
        corrections: selected.map(({ entry, before }) => ({
          proposalId: entry.block.proposalId,
          recordId: entry.record.id,
          candidateVersionId: entry.record.candidateVersionId!,
          field,
          before,
          after,
        })),
      }));
      setOperationStatus(`Applying ${request.corrections.length} previewed draft corrections…`);
      const response = await exactMutation(operationKey, () =>
        requestApi<Intake>(
          `${prefix}/intakes/${encodeURIComponent(selection.intakeId)}/draft-repair`,
          {
            method: 'POST',
            body: JSON.stringify(request),
          },
        ),
      );
      if (!current()) throw new Error('Profile changed after the draft correction.');
      feed.reload();
      setDraftRepairUndo({
        intakeId: selection.intakeId,
        request: {
          version: response.data.version,
          operationId: crypto.randomUUID(),
          groupId: request.groupId,
          corrections: request.corrections.map((correction) => ({
            ...correction,
            before: correction.after,
            after: correction.before,
          })),
        },
      });
      setNotice(
        `${request.corrections.length} previewed draft ${request.corrections.length === 1 ? 'field was' : 'fields were'} corrected. The original and save state are unchanged.`,
      );
      setOperationStatus(null);
    });
    return succeeded
      ? null
      : 'The drafts were not changed. Review the current fields and try again.';
  }

  function undoDraftCorrection() {
    const retained = draftRepairUndo;
    if (!retained) return;
    void perform(async ({ prefix, current, request: requestApi }) => {
      setOperationStatus('Restoring the prior draft fields…');
      await requestApi<Intake>(
        `${prefix}/intakes/${encodeURIComponent(retained.intakeId)}/draft-repair`,
        {
          method: 'POST',
          body: JSON.stringify(retained.request),
        },
      );
      if (!current()) throw new Error('Profile changed after the draft fields were restored.');
      setDraftRepairUndo(null);
      feed.reload();
      setNotice('The prior draft fields were restored. The original and save state are unchanged.');
    });
  }

  function askDraftRepair(selection: IntakeDraftRepairSelection, request: string) {
    window.dispatchEvent(
      new CustomEvent('health:ask', {
        detail: {
          message: request,
          context: {
            route: `/import?${new URLSearchParams({ group: selection.groupId, intake: selection.intakeId })}`,
            intakeRepair: selection,
          },
        },
      }),
    );
  }

  async function upload(files: File[]) {
    await perform(
      async ({ prefix, current, operationId, request: requestApi }) => {
        if (!limits.data)
          throw new Error('Upload limits are still loading. Try again in a moment.');
        if (files.some((file) => !file.size)) throw new Error('Choose nonempty files to upload.');
        if (files.some((file) => file.size > limits.data!.uploadBytes))
          throw new Error(
            `The upload limit is ${limits.data.uploadBytes / 1024 / 1024} MiB per file. Choose a smaller file, or ask the operator to raise the upload and runtime storage limits together.`,
          );
        const uploaded: string[] = [];
        const failed: string[] = [];
        for (const [index, file] of files.entries()) {
          if (!current()) throw new Error('Profile changed. Remaining files were not uploaded.');
          setUploadStatus(`Uploading file ${index + 1} of ${files.length}: ${file.name}`);
          try {
            const intake = await requestApi<Intake>(`${prefix}/intakes`, {
              operationId,
              onUploadProgress: (sent, total) => {
                if (current())
                  setUploadStatus(
                    `Uploading file ${index + 1} of ${files.length}${total ? `: ${Math.min(100, Math.floor((sent / total) * 100))}%` : ''}${total && sent >= total ? ' — retaining original…' : ''}`,
                  );
              },
              method: 'POST',
              headers: {
                'Content-Type': file.type || 'application/octet-stream',
                'X-Filename': encodeURIComponent(file.name),
              },
              body: file,
            });
            uploaded.push(intake.data.id);
          } catch (cause) {
            if (!current()) throw cause;
            failed.push(`${file.name}: ${errorMessage(cause)}`);
          }
        }
        if (uploaded.length && current()) await batch.refresh();
        if (failed.length)
          throw new Error(
            `${failed.length} ${failed.length === 1 ? 'file' : 'files'} could not upload: ${failed.join(', ')}`,
          );
        feed.reload();
        setNotice(
          `${uploaded.length} ${uploaded.length === 1 ? 'file was' : 'files were'} retained and queued for reading.`,
        );
      },
      'upload',
      { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) },
    );
  }

  async function reviewSource(reportId: string): Promise<IntakeReportSourceReview> {
    const group = [...(displayedFeed?.groups || []), ...(displayedFeed?.people.groups || [])].find(
      (item) => item.groupId === reportId,
    );
    if (!group) throw new Error('This report changed. Reload its source review.');
    const requestedProfile = profile?.id;
    const requestedPath = feedPath;
    const prefix = `/api/profiles/${encodeURIComponent(requestedProfile || '')}`;
    const review = (
      await api<IntakeReportSourceReview>(
        `${prefix}/intakes/${encodeURIComponent(group.intakeId)}/report-source-review?groupId=${encodeURIComponent(group.groupId)}&view=${encodeURIComponent(displayedFeed?.view || 'active')}`,
      )
    ).data;
    if (
      activeProfile.current !== requestedProfile ||
      activeFeedPath.current !== requestedPath ||
      review.profileId !== requestedProfile
    )
      throw new Error('This report changed while its source scope loaded. Review it again.');
    if (
      review.groupVersionId !== group.groupVersionId ||
      review.intakeVersion !== group.intakeVersion
    )
      feed.reload();
    return review;
  }

  async function source(
    reportId: string,
    value: string,
    displayedReview?: IntakeReportSourceReview,
  ): Promise<string | null> {
    const requestedFeedPath = feedPath;
    const group = [...(displayedFeed?.groups || []), ...(displayedFeed?.people.groups || [])].find(
      (item) => item.groupId === reportId,
    );
    if (!group && !displayedReview)
      return 'This report no longer has a source-label scope. Review it again.';
    let actionError: string | null = null;
    const completed = await perform(async ({ prefix, current, request: requestApi }) => {
      const sourceContextCurrent = () => current() && activeFeedPath.current === requestedFeedPath;
      const review = displayedReview || (await reviewSource(reportId));
      if (review.groupId !== reportId || review.profileId !== profile?.id || !review.targets.length)
        throw new Error('The affected source records changed. Review the current scope again.');
      if (
        group &&
        (review.groupVersionId !== group.groupVersionId ||
          review.intakeVersion !== group.intakeVersion)
      )
        feed.reload();
      const operationKey = `source:${review.scopeToken}:${value}`;
      const request = exactRequest<IntakeReportSourceUpdate>(operationKey, () => ({
        version: review.intakeVersion,
        operationId: crypto.randomUUID(),
        groupId: review.groupId,
        groupVersionId: review.groupVersionId,
        contextId: review.groupVersionId,
        source: value,
        basis: 'explicit_current_members' as const,
        view: review.view,
        scopeToken: review.scopeToken,
      }));
      try {
        await exactMutation(operationKey, () =>
          requestApi<IntakeReportSourceResult>(
            `${prefix}/intakes/${encodeURIComponent(review.intakeId)}/report-source`,
            { method: 'POST', body: JSON.stringify(request) },
          ).then(({ data }) => data),
        );
        if (!sourceContextCurrent()) return;
        feed.reload();
        setNotice(`${value} will be used for ${review.targets.length} reviewed report records.`);
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') {
          if (!sourceContextCurrent()) return;
          const fresh = (
            await requestApi<IntakeReportSourceReview>(
              `${prefix}/intakes/${encodeURIComponent(review.intakeId)}/report-source-review?groupId=${encodeURIComponent(review.groupId)}&view=${encodeURIComponent(review.view)}`,
            )
          ).data;
          if (!sourceContextCurrent()) return;
          if (!sameDisplayedSourceReview(review, fresh)) {
            feed.reload();
            actionError =
              'This report gained or changed source evidence, people, or records while you were labeling it. Your label is still entered; review the updated scope, then use it again.';
            throw new Error(actionError);
          }
          const retry = {
            ...request,
            version: fresh.intakeVersion,
            groupVersionId: fresh.groupVersionId,
            contextId: fresh.groupVersionId,
            scopeToken: fresh.scopeToken,
            view: fresh.view,
          };
          pendingOperations.current.set(operationKey, retry);
          await exactMutation(operationKey, () =>
            requestApi<IntakeReportSourceResult>(
              `${prefix}/intakes/${encodeURIComponent(fresh.intakeId)}/report-source`,
              { method: 'POST', body: JSON.stringify(retry) },
            ).then(({ data }) => data),
          );
          if (!sourceContextCurrent()) return;
          feed.reload();
          setNotice(`${value} will be used for ${fresh.targets.length} reviewed report records.`);
        } else {
          actionError ||= errorMessage(cause);
          throw cause;
        }
      }
    });
    return completed ? null : actionError || 'The source label was not applied. Try again.';
  }

  function identity(
    reportId: string,
    selectedFields: { fullName?: string; birthDate?: string },
    personSelection?: ImportPersonSelection,
    printedName?: string,
    identityAnswers?: IntakeIdentityAnswers,
  ) {
    const group = displayedFeed?.groups.find((item) => item.groupId === reportId);
    const displayedReview = identityReviews.get(reportId);
    const displayedScope = displayedReview?.scope;
    if (!group || !displayedReview || !displayedScope) return;
    void perform(async ({ prefix, current: profileCurrent, request: requestApi }) => {
      let operationKey = '';
      const actionGeneration = identityReviewGeneration.current;
      const actionFeedPath = feedPath;
      const actionSelectionQuery = selectionQuery;
      const actionPageCurrent = () =>
        identityPageMounted.current &&
        profileCurrent() &&
        activeFeedPath.current === actionFeedPath &&
        activeSelectionQuery.current === actionSelectionQuery;
      const actionCurrent = () =>
        actionPageCurrent() && identityReviewGeneration.current === actionGeneration;
      const offered = displayedReview.offeredSelfFields;
      const fields = Object.fromEntries(
        Object.entries(personSelection ? {} : selectedFields).filter(
          ([field, value]) => !!value && offered[field as keyof typeof offered] === value,
        ),
      ) as { fullName?: string; birthDate?: string };
      try {
        operationKey = `identity:${displayedScope.groupId}:${displayedScope.groupVersionId}:${displayedScope.intakeVersion}:${JSON.stringify([fields, personSelection, printedName, identityAnswers])}`;
        const request = (pendingOperations.current.get(operationKey) as
          IntakeIdentityConfirmation | undefined) || {
          version: displayedScope.intakeVersion,
          operationId: crypto.randomUUID(),
          scope: displayedScope,
          outcome: personSelection ? 'this_is_person' : 'this_is_me',
          ...(personSelection ? { personSelection } : {}),
          ...(printedName ? { printedName } : {}),
          ...(identityAnswers ? { identityAnswers } : {}),
          attestation: displayedScope.questions?.length
            ? 'confirmed_displayed_identity_questions'
            : 'confirmed_displayed_report_subject',
          ...(Object.keys(fields).length
            ? {
                selfUpdate: {
                  expectedVersion: displayedReview.self.version,
                  fields,
                },
              }
            : {}),
        };
        const outcome = await confirmIdentityWithFreshness({
          displayed: displayedReview,
          request,
          send: async (next) =>
            (
              await requestApi<Intake>(
                `${prefix}/intakes/${encodeURIComponent(group.intakeId)}/identity-scope`,
                { method: 'POST', body: JSON.stringify(next) },
              )
            ).data,
          loadFresh: async () =>
            (
              await requestApi<IntakeIdentityReview>(
                `${prefix}/intakes/${encodeURIComponent(group.intakeId)}/identity-review?groupId=${encodeURIComponent(group.groupId)}`,
              )
            ).data,
          isContextCurrent: actionCurrent,
          retainRequest: (next) => {
            if (next) pendingOperations.current.set(operationKey, next);
            else pendingOperations.current.delete(operationKey);
          },
        });
        if (outcome.status === 'context_changed') {
          // A successful Self fill changes the profile signature and intentionally
          // retires the displayed identity load. Refresh record readiness without
          // replaying or clearing the already-bound identity operation.
          if (actionPageCurrent()) feed.reload();
          return;
        }
        if (!actionCurrent()) return;
        if (outcome.status === 'scope_changed') {
          identityReviewGeneration.current += 1;
          setIdentityReviews((reviews) => new Map(reviews).set(reportId, outcome.fresh));
          setIdentityReviewErrors((errors) => {
            const next = new Map(errors);
            next.delete(reportId);
            return next;
          });
          setError(outcome.message);
          return;
        }
        identityReviewGeneration.current += 1;
        setIdentityReviews((reviews) => {
          const next = new Map(reviews);
          next.delete(reportId);
          return next;
        });
      } catch (cause) {
        if (!actionCurrent()) return;
        if (cause instanceof ApiError && cause.status === 409) {
          pendingOperations.current.delete(operationKey);
          const generation = ++identityReviewGeneration.current;
          setIdentityReviews((reviews) => {
            const next = new Map(reviews);
            next.delete(reportId);
            return next;
          });
          let refreshed: IntakeIdentityReview;
          try {
            refreshed = (
              await requestApi<IntakeIdentityReview>(
                `${prefix}/intakes/${encodeURIComponent(group.intakeId)}/identity-review?groupId=${encodeURIComponent(group.groupId)}`,
              )
            ).data;
          } catch (refreshCause) {
            if (
              profileCurrent() &&
              activeFeedPath.current === actionFeedPath &&
              activeSelectionQuery.current === actionSelectionQuery &&
              generation === identityReviewGeneration.current
            )
              setIdentityReviewErrors((errors) =>
                new Map(errors).set(
                  reportId,
                  'Identity status could not refresh. Review current evidence before trying again.',
                ),
              );
            throw refreshCause;
          }
          if (
            !profileCurrent() ||
            activeFeedPath.current !== actionFeedPath ||
            activeSelectionQuery.current !== actionSelectionQuery ||
            generation !== identityReviewGeneration.current
          )
            return;
          setIdentityReviews((reviews) => new Map(reviews).set(reportId, refreshed));
          setIdentityReviewErrors((errors) => {
            const next = new Map(errors);
            next.delete(reportId);
            return next;
          });
          if (cause.code === 'IDENTITY_ALREADY_RESOLVED') {
            feed.reload();
            setNotice(
              'This report identity was already confirmed. No additional confirmation was recorded.',
            );
            return;
          }
          throw new Error(
            'The report or Self profile changed. Check the refreshed identity details, then confirm again.',
          );
        }
        throw cause;
      }
      if (
        !profileCurrent() ||
        activeFeedPath.current !== actionFeedPath ||
        activeSelectionQuery.current !== actionSelectionQuery
      )
        return;
      feed.reload();
      setNotice(
        personSelection
          ? 'The report is assigned to the selected person in People. Clinical records remain in review.'
          : Object.keys(fields).length
            ? displayedReview.status === 'confirmation_required'
              ? 'Identity confirmed and the selected blank Self details were filled in the same action.'
              : 'The selected blank Self details were added. This report was already allowed by retained identity evidence.'
            : 'This report is confirmed as yours and its supported name is retained in your saved names. Clinical records remain in review.',
      );
    });
  }

  async function loadMore() {
    const cursor = displayedFeed?.nextCursor;
    const peopleCursor = displayedFeed?.people.nextCursor;
    const innerPeople = peopleNext.entries().next().value as [string, string] | undefined;
    if ((!cursor && !peopleCursor && !innerPeople) || loadingMore) return;
    const requestedPath = feedPath;
    const requestedProfile = profile?.id;
    setLoadingMore(true);
    try {
      if (!cursor && !peopleCursor && innerPeople) {
        const [groupId, next] = innerPeople;
        const prefix = `/api/profiles/${encodeURIComponent(requestedProfile || '')}`;
        const page = (
          await api<IntakePeopleQueue>(
            `${prefix}/intakes/people/${encodeURIComponent(groupId)}?limit=100&cursor=${encodeURIComponent(next)}`,
          )
        ).data;
        if (activeProfile.current !== requestedProfile || activeFeedPath.current !== requestedPath)
          return;
        setPeople((current) => [
          ...current,
          ...page.people.filter((item) => !current.some((prior) => prior.id === item.id)),
        ]);
        setPeopleNext((current) => {
          const updated = new Map(current);
          if (page.peopleNextCursor) updated.set(groupId, page.peopleNextCursor);
          else updated.delete(groupId);
          return updated;
        });
        return;
      }
      const pagePath = new URLSearchParams();
      if (cursor) pagePath.set('cursor', cursor);
      if (peopleCursor) pagePath.set('peopleCursor', peopleCursor);
      const page = (await api<IntakeImportFeed>(`${feedPath}&${pagePath}`)).data;
      if (activeProfile.current !== requestedProfile || activeFeedPath.current !== requestedPath)
        return;
      setPagedFeed((current) => {
        if (!current) return page;
        const groups = new Map(current.groups.map((group) => [group.groupId, group]));
        page.groups.forEach((group) => groups.set(group.groupId, group));
        const peopleGroups = new Map(current.people.groups.map((group) => [group.groupId, group]));
        page.people.groups.forEach((group) => peopleGroups.set(group.groupId, group));
        const blocks = new Map(
          current.blocks.map((block) => [
            `${block.groupId}:${block.intakeId}:${block.proposalId || ''}`,
            block,
          ]),
        );
        for (const block of page.blocks) {
          const key = `${block.groupId}:${block.intakeId}:${block.proposalId || ''}`;
          const prior = blocks.get(key);
          if (!prior) blocks.set(key, block);
          else {
            const records = new Map(prior.records.map((record) => [record.feedKey, record]));
            block.records.forEach((record) => records.set(record.feedKey, record));
            blocks.set(key, { ...block, records: [...records.values()] });
          }
        }
        return {
          ...page,
          groups: [...groups.values()],
          blocks: [...blocks.values()],
          people: { ...page.people, groups: [...peopleGroups.values()] },
        };
      });
    } catch (cause) {
      if (activeProfile.current === requestedProfile) setError(errorMessage(cause));
    } finally {
      if (activeProfile.current === requestedProfile) setLoadingMore(false);
    }
  }

  const sourceReviewProps = {
    onChanged: feed.reload,
    onManualCreated: (result: ManualSourceRecordResult) => {
      feed.reload();
      void (async () => {
        if (closeInlineReview.current && !(await closeInlineReview.current())) return;
        setFilters({ view: 'review', kind: 'All', query: '', editedOnly: false });
        setManualReview(result);
      })();
    },
    readingBlocked: batch.loading
      ? 'Checking saved reading requests…'
      : batch.pendingCreate
        ? 'Use Retry reading above to confirm the earlier reading request first.'
        : batch.busy
          ? 'Wait for the current reading request to finish.'
          : batch.batch?.status === 'running'
            ? 'Wait for the active reading batch to finish, or stop it before starting a fresh reading.'
            : undefined,
    onRead: async (intakeId: string) => {
      const result = await batch.create([intakeId]);
      if (!result)
        throw new Error(
          'Clinical reading did not start. Try again when the current request finishes.',
        );
    },
  };

  return (
    <div className="page import-page">
      {(error || acceptance.error || batch.error) && (
        <div className="import-error" role="alert">
          {error || acceptance.error || batch.error}
        </div>
      )}
      <ImportAcceptanceOutcomes receipt={acceptanceReceipt} />
      {notice && (
        <div className="import-page-notice" role="status">
          <span>{notice}</span>
          {draftRepairUndo && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={undoDraftCorrection}
            >
              Undo draft correction
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice('')}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      <SavedPersonDestinations destinations={recentSavedPeople} />
      <SavedRecordDestinations records={[]} error={savedDestinationsError} onRetry={feed.reload} />
      {batch.pendingCreate && (
        <div className="import-page-notice" role="status">
          <span>Your originals are retained. The reading request still needs confirmation.</span>
          <button
            type="button"
            className="button secondary"
            disabled={batch.busy}
            onClick={() =>
              void batch
                .retryCreate()
                .then(() => feed.reload())
                .catch(() => {})
            }
          >
            Retry reading
          </button>
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
      {feed.loading && !feed.data && (
        <LoadingIndicator label="Opening import review…" layout="centered" />
      )}
      {detailSelection && !detailSelection.personId && (
        <button className="text-link" type="button" onClick={closeDetail}>
          All imports
        </button>
      )}

      {historicalSelectionKey && !activeHistoricalSelection ? (
        <LoadingIndicator label="Opening the report from this historical link…" layout="centered" />
      ) : activeHistoricalSelection?.loading ? (
        <LoadingIndicator label="Opening the report from this historical link…" layout="centered" />
      ) : activeHistoricalSelection?.error ? (
        <section className="import-detail-state" role="alert">
          <p>{activeHistoricalSelection.error}</p>
          <button className="button secondary" type="button" onClick={closeDetail}>
            Open Import
          </button>
        </section>
      ) : detailSelection &&
        (!detailSelection.recordId ||
          detailSelection.personId ||
          searchParams.get('review') === 'full') ? (
        <ImportDetailReview
          selection={detailSelection}
          onBack={closeDetail}
          onChanged={feed.reload}
          onUseSource={source}
        />
      ) : (
        <ImportReviewPresentation
          requestedRecordId={
            manualReview
              ? [...lookup].find(
                  ([, row]) =>
                    row.block.intakeId === manualReview.intake.id &&
                    row.block.proposalId === manualReview.proposalId &&
                    row.record.id === manualReview.recordId,
                )?.[0]
              : detailSelection
                ? model.records.find(
                    (record) =>
                      record.reportId === detailSelection.groupId &&
                      (!detailSelection.recordId ||
                        lookup.get(record.id)?.record.id === detailSelection.recordId),
                  )?.id
                : undefined
          }
          preserveSourceReview={preserveSourceReview}
          beforeReviewChange={async () => {
            if (pendingSourceReviews.current.size) {
              setNotice('Save or discard the source review draft before changing the review view.');
              return false;
            }
            return (await closeInlineReview.current?.()) ?? true;
          }}
          renderRecordReview={(record, close) => {
            if (!record.detailUrl) return null;
            const params = new URLSearchParams(record.detailUrl.split('?')[1]);
            const groupId = params.get('group');
            const recordId = params.get('record');
            if (!groupId || !recordId) return null;
            return (
              <ImportDetailReview
                key={record.id}
                embedded
                beforeCloseRef={closeInlineReview}
                selection={{
                  groupId,
                  recordId,
                  intakeId: params.get('intake') || undefined,
                  proposalId: params.get('proposal') === 'original' ? null : params.get('proposal'),
                }}
                onBack={close}
                onChanged={feed.reload}
                onUseSource={source}
              />
            );
          }}
          renderSourceAttention={(onCount) => (
            <ImportSourceTextBrowser
              attentionRows
              onAttentionCount={onCount}
              attentionRefreshKey={feed.data}
              {...sourceReviewProps}
              onPendingChange={(pending) => sourceReviewPending('source-attention', pending)}
            />
          )}
          renderReportSourceReview={(report) =>
            report.sourceIntakeId ? (
              <ImportSourceTextBrowser
                {...sourceReviewProps}
                intakeId={report.sourceIntakeId}
                onPendingChange={(pending) => sourceReviewPending(report.id, pending)}
              />
            ) : null
          }
          model={model}
          actions={{
            busy:
              busy || acceptance.busy || acceptance.recovering || !!acceptance.recoveryOperationId,
            onFiles: upload,
            onSave: save,
            onLater: (ids) => disposition(ids, 'later'),
            onExclude: (ids) => disposition(ids, 'excluded'),
            onResume: (ids) => disposition(ids, 'pending'),
            onUseSource: source,
            onReviewSource: reviewSource,
            onConfirmIdentity: identity,
            onCorrectDrafts: correctDrafts,
            onAskDraftRepair: askDraftRepair,
            onFiltersChange: setFilters,
            onLoadMore: loadMore,
            onStopReading:
              batch.batch?.status === 'running'
                ? async () => {
                    await batch.stop();
                    feed.reload();
                  }
                : undefined,
            onRetryExceptions: batch.batch?.items.some((item) => item.exceptions?.length)
              ? async () => {
                  await batch.retryExceptions();
                  feed.reload();
                }
              : undefined,
            onResumeReading:
              (batch.batch?.status === 'stopped' ||
                (batch.batch?.status === 'paused' &&
                  batch.batch.reason !== 'needs_user_action' &&
                  !batch.batch.automaticRun)) &&
              batch.batch?.items.some(hasPausedIntakeReading)
                ? async () => {
                    await batch.resume();
                  }
                : undefined,
          }}
        />
      )}
    </div>
  );
}
import { recordIdentityReviewDiagnostic } from '../../data/import-diagnostics';
