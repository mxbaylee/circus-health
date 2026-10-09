import { hostGroundedIdentity } from './identity-grounding';
import { CollectionEvidenceWindow } from '../intake/CollectionEvidenceWindow';
export { CollectionEvidenceWindow } from '../intake/CollectionEvidenceWindow';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  CollectionFeedRecord,
  CollectionImportFeed,
  CollectionReportDetail,
  CollectionPersonProposal,
  CollectionPeoplePage,
  CollectionPersonReference,
  IntakeReviewFragmentReference,
} from '../../../shared/intake-clinical-pages';
import { isCollectionReportDetail } from '../../../shared/intake-clinical-pages';
import type {
  Intake,
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceReceipt,
  IntakeDraftRepairUpdate,
  IntakeDraftRepairSelection,
  IntakeDraftRepairField,
} from '../../../shared/intake';
import { readSelectedClinicalReview } from '../../data/intake-clinical-review';
import { useReportAcceptance } from '../intake/useReportAcceptance';
import { initialDraft } from '../intake/useReviewDrafts';
import { ImportSaveStatus } from './ImportSaveStatus';
import { hasUnreviewedPairChoices } from '../../../shared/clinical-review';
import type {
  IntakeIdentityConfirmation,
  IntakeIdentityReview,
} from '../../../shared/intake-identity';
import type {
  IntakePersonApplyRequest,
  IntakePersonDispositionRequest,
} from '../../../shared/intake-people';
import { api, apiUrl, useResource, ApiError } from '../../data/api';
import { useProfile } from '../../data/profile';
import { confirmIdentityWithFreshness } from '../../data/identity-confirmation-freshness';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import { ReportPeopleReview } from '../intake/ReportPeopleReview';
import { ClinicalReviewReference } from '../intake/ClinicalReviewPages';
import { ImportDetailReview, ImportRecordDetail } from './ImportDetailReview';
import { ImportDetailIdentityPanel } from './ImportDetailIdentityPanel';
import { ImportSourceTextBrowser, type SourceBrowserProps } from './ImportSourceTextBrowser';
import { CollectionReportSource } from './CollectionReportSource';
import { useCollectionBulkActions, type CollectionDisposition } from './useCollectionBulkActions';
import { ReviewNavigationGuard } from '../intake/ReviewWorkspace';
import {
  SavedPersonDestinations,
  appendSavedPersonDestination,
  type SavedPersonDestination,
} from './SavedRecordDestinations';
import {
  CollectionFeedDestination,
  CollectionRecordDestination,
} from './CollectionFeedDestinations';
import { ImportReviewPresentation, type ImportReviewModel } from './ImportReviewPresentation';
import {
  collectionKind,
  collectionDetailUrl,
  groupKey,
  useCollectionDisplayModel,
} from './collection-display-model';
import { ImportAcceptanceOutcomes } from './ImportAcceptanceOutcomes';
import { confirmedSelectionIds, rejectedSelectionIds } from './partial-save-plan';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'This review could not finish. Refresh and try again.';
const label = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
const feedQueryKey = (path: string) => {
  const [pathname, search] = path.split('?');
  const params = new URLSearchParams(search);
  params.sort();
  return `${pathname}?${params}`;
};
const selectionUrl = (
  intakeId: string,
  groupId: string,
  proposalId?: string | null,
  recordId?: string,
) => {
  const params = new URLSearchParams({ intake: intakeId, group: groupId });
  if (proposalId !== undefined) params.set('proposal', proposalId || 'original');
  if (recordId) {
    params.set('record', recordId);
    params.set('review', 'full');
  }
  return params;
};

/** Only the displayed clinical and People windows enter the shared presentation model. */
export function CollectionImportReview({
  initial,
  selection,
  selectionLoading,
  selectionError,
  path,
  firstPage,
  onChanged,
  sourceProps,
  onUpload,
  uploadUnavailable,
  busy,
  status,
  error: actionError,
  reading,
}: {
  initial: CollectionImportFeed;
  selection?: import('./ImportDetailReview').ImportDetailSelection | null;
  selectionLoading?: boolean;
  selectionError?: string;
  path: string;
  firstPage?: { reload: () => void; refreshing?: boolean; error: Error | null };
  onChanged: () => void;
  sourceProps: SourceBrowserProps;
  onUpload: (files: File[]) => Promise<void>;
  uploadUnavailable?: string;
  busy: boolean;
  status: string;
  error: string;
  reading?: ReactNode;
}) {
  const profile = useProfile();
  const [params, setParams] = useSearchParams();
  const groupId = params.get('group') || params.get('report') || selection?.groupId;
  const intakeId = params.get('intake') || selection?.intakeId;
  const requestedRecord = params.get('record') || selection?.recordId;
  const inlineRequested = !!requestedRecord && params.get('review') !== 'full';
  const detailRequested = !!groupId && !inlineRequested;
  const [cursor, setCursor] = useState<string>();
  const [peopleCursor, setPeopleCursor] = useState<string>();
  const [peopleGroupKey, setPeopleGroupKey] = useState('');
  const [peopleRowCursor, setPeopleRowCursor] = useState<string>();
  const [filters, setFilters] = useState<NonNullable<ImportReviewModel['filters']>>({
    view: initial.view === 'deferred' ? 'later' : 'review',
    kind: 'All',
    query: '',
    editedOnly: false,
  });
  const view = filters.view === 'review' ? 'active' : filters.view === 'later' ? 'deferred' : 'all';
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveNotice, setSaveNotice] = useState('');
  const [receipt, setReceipt] = useState<IntakeReportAcceptanceReceipt | null>(null);
  const [confirmedSavedIds, setConfirmedSavedIds] = useState<string[]>([]);
  const [recentPeople, setRecentPeople] = useState<SavedPersonDestination[]>([]);
  const [pendingSources, setPendingSources] = useState<Set<string>>(() => new Set());
  const pendingSourcesRef = useRef(pendingSources);
  const inlineBeforeClose = useRef<(() => Promise<boolean>) | null>(null);
  const sourcePending = pendingSources.size > 0;
  const sourcePendingChange = (key: string, pending: boolean) => {
    const current = pendingSourcesRef.current;
    if (current.has(key) === pending) return;
    const next = new Set(current);
    if (pending) next.add(key);
    else next.delete(key);
    pendingSourcesRef.current = next;
    setPendingSources(next);
  };
  const queryParams = new URLSearchParams(path.split('?')[1]);
  queryParams.set('view', view);
  queryParams.set('limit', '40');
  queryParams.set('bytes', '65536');
  for (const field of ['state', 'q', 'cursor', 'peopleCursor', 'kind', 'edited'])
    queryParams.delete(field);
  if (filters.view === 'review') queryParams.set('state', 'pending');
  if (filters.view === 'later') queryParams.set('state', 'deferred');
  if (filters.view === 'saved') queryParams.set('state', 'accepted');
  if (filters.view === 'excluded') queryParams.set('state', 'kept_original');
  if (filters.query) queryParams.set('q', filters.query);
  if (filters.kind !== 'All') {
    const kinds = Object.entries(collectionKind)
      .filter(([, value]) => value === filters.kind)
      .map(([key]) => key);
    if (filters.kind === 'Documents') queryParams.set('kind', 'documents');
    else if (kinds.length === 1) queryParams.set('kind', kinds[0]!);
  }
  if (filters.editedOnly) queryParams.set('edited', 'true');
  if (cursor) queryParams.set('cursor', cursor);
  if (peopleCursor) queryParams.set('peopleCursor', peopleCursor);
  const ownPath = `/intakes/import-feed?${queryParams}`;
  const usesFirstPage = !!firstPage && feedQueryKey(path) === feedQueryKey(ownPath);
  const pagedFeed = useResource<CollectionImportFeed>(
    detailRequested || usesFirstPage ? null : ownPath,
  );
  const page = usesFirstPage ? { ...firstPage, data: initial, loading: false } : pagedFeed;
  const observedInitial = useRef(initial);
  useEffect(() => {
    if (observedInitial.current === initial) return;
    observedInitial.current = initial;
    // Batch/source changes arrive through the parent. A filtered or later
    // window must reread its own exact query after that change as well.
    if (firstPage && !usesFirstPage && !detailRequested) pagedFeed.reload();
  }, [initial, firstPage, usesFirstPage, detailRequested, pagedFeed.reload]);
  useEffect(() => {
    setCursor(undefined);
    setPeopleCursor(undefined);
    setPeopleRowCursor(undefined);
  }, [path, filters, profile?.id]);
  const data =
    page.data ||
    (!firstPage &&
    !cursor &&
    !peopleCursor &&
    view === initial.view &&
    filters.kind === 'All' &&
    !filters.query &&
    !filters.editedOnly
      ? initial
      : null);
  const activeScope = JSON.stringify([profile?.id, ownPath]);
  const active = useRef(activeScope);
  active.current = activeScope;
  useEffect(
    () => () => {
      active.current = '';
    },
    [],
  );
  const peopleGroup =
    data?.people.groups.find(
      (group) => groupKey(group.intakeId, group.groupId) === peopleGroupKey,
    ) || data?.people.groups[0];
  const peopleQuery = new URLSearchParams({
    intakeId: peopleGroup?.intakeId || '',
    view,
    limit: '40',
    bytes: '65536',
  });
  if (peopleRowCursor) peopleQuery.set('cursor', peopleRowCursor);
  if (filters.query) peopleQuery.set('q', filters.query);
  const peoplePage = useResource<CollectionPeoplePage>(
    !detailRequested && peopleGroup
      ? `/intakes/people/${encodeURIComponent(peopleGroup.groupId)}?${peopleQuery}`
      : null,
  );
  const shownPeople = useMemo(
    () =>
      peoplePage.data?.people.flatMap((item) => (item.kind === 'person' ? [item.person] : [])) ||
      [],
    [peoplePage.data],
  );
  const [identities, setIdentities] = useState<Map<string, IntakeIdentityReview>>(() => new Map());
  const identityLoads = useRef(new Map<string, string>());
  const identityRefreshes = useRef(new Map<string, string>());
  const identityProfile = JSON.stringify([profile?.id, profile?.nameVersion, profile?.version]);
  useEffect(() => {
    identityLoads.current.clear();
    identityRefreshes.current.clear();
    setIdentities(new Map());
    setRecentPeople([]);
    setReceipt(null);
    setConfirmedSavedIds([]);
  }, [identityProfile]);
  useEffect(() => {
    if (!data || detailRequested || !profile?.id) return;
    let live = true;
    const controller = new AbortController();
    const pendingKeys = new Set<string>();
    // The host serializes groups from one original. Dispatch its next read
    // after the preceding read settles, before starting its transport timer.
    const identityLanes = new Map<string, Promise<void>>();
    const reports = new Map<
      string,
      { intakeId: string; groupId: string; version: number; tokens: Set<string> }
    >();
    for (const row of data.records) {
      const key = groupKey(row.intakeId, row.groupId);
      const report = reports.get(key) || {
        intakeId: row.intakeId,
        groupId: row.groupId,
        version: row.intakeVersion,
        tokens: new Set<string>(),
      };
      report.tokens.add(row.reviewToken);
      reports.set(key, report);
    }
    setIdentities((current) => new Map([...current].filter(([key]) => reports.has(key))));
    for (const key of identityRefreshes.current.keys())
      if (!reports.has(key)) identityRefreshes.current.delete(key);
    for (const key of identityLoads.current.keys())
      if (!reports.has(key)) {
        identityLoads.current.delete(key);
        identityRefreshes.current.delete(key);
      }
    for (const [key, report] of reports) {
      const tokens = [...report.tokens].sort();
      const signature = JSON.stringify([identityProfile, report.version, tokens]);
      if (identityLoads.current.get(key) === signature) continue;
      identityLoads.current.set(key, signature);
      pendingKeys.add(key);
      const previous = identityLanes.get(report.intakeId) || Promise.resolve();
      const next = previous.then(() => {
        if (!live || controller.signal.aborted || identityLoads.current.get(key) !== signature)
          return;
        return api<IntakeIdentityReview>(
          `/intakes/${encodeURIComponent(report.intakeId)}/identity-review?groupId=${encodeURIComponent(report.groupId)}`,
          { signal: controller.signal },
        )
          .then(({ data: review }) => {
            pendingKeys.delete(key);
            if (!live || identityLoads.current.get(key) !== signature) return;
            if (!review.evidencedIdentity || typeof review.blocking !== 'boolean')
              throw new Error('Identity response did not match the requested report.');
            setIdentities((current) => new Map(current).set(key, review));
            const hasBlocked = data.records.some(
              (row) =>
                row.intakeId === report.intakeId &&
                row.groupId === report.groupId &&
                (row.detail.kind === 'reference' || row.detail.record.identityReview?.blocking),
            );
            // The same verified scope refreshes once even when an unrelated blocker remains.
            const refreshKey = JSON.stringify([
              identityProfile,
              (review.scopeReference || review.scope)?.scopeToken,
            ]);
            if (
              hasBlocked &&
              hostGroundedIdentity(review) &&
              identityRefreshes.current.get(key) !== refreshKey
            ) {
              identityRefreshes.current.set(key, refreshKey);
              page.reload();
            }
          })
          .catch(() => {
            if (live && identityLoads.current.get(key) === signature)
              identityLoads.current.delete(key);
          });
      });
      identityLanes.set(report.intakeId, next);
    }
    return () => {
      live = false;
      controller.abort();
      // Interrupted requests must be retried in the new displayed scope, not mistaken for loaded headers.
      for (const [key, report] of reports) {
        if (!pendingKeys.has(key)) continue;
        const signature = JSON.stringify([
          identityProfile,
          report.version,
          [...report.tokens].sort(),
        ]);
        if (identityLoads.current.get(key) === signature) identityLoads.current.delete(key);
      }
    };
  }, [data, detailRequested, identityProfile, profile?.id, page.reload]);
  const nativeSourceProps: SourceBrowserProps = {
    ...sourceProps,
    guardNavigation: false,
    onManualCreated: (result) => {
      sourceProps.onManualCreated?.(result);
      setFilters({ view: 'review', kind: 'All', query: '', editedOnly: false });
      setParams({
        intake: result.intake.id,
        group: result.groupId,
        proposal: result.proposalId,
        record: result.recordId,
      });
    },
  };
  const refresh = () => {
    if (firstPage) firstPage.reload();
    else {
      page.reload();
      onChanged();
    }
    peoplePage.reload();
  };
  const acceptance = useReportAcceptance(profile?.id || '', (result) => {
    setReceipt(result.receipt);
    setConfirmedSavedIds(confirmedSelectionIds(result.receipt));
    setSaveNotice(
      `${result.receipt.acceptedCount} records saved. Any remaining records still need review.`,
    );
    refresh();
  });
  const donePeople = useRef<string[]>([]);
  const bulk = useCollectionBulkActions({
    scope: JSON.stringify([activeScope, peopleGroupKey, peopleRowCursor]),
    onClinicalDone: () => {},
    onPersonDone: (id) => {
      donePeople.current.push(`person:${id}`);
    },
    onPersonSaved: (saved, title) =>
      setRecentPeople((current) =>
        appendSavedPersonDestination(current, { ...saved, title }).slice(-40),
      ),
    onRefresh: refresh,
  });
  const repairRequest = useRef<{ path: string; body: IntakeDraftRepairUpdate } | null>(null);
  const [repairPending, setRepairPending] = useState(false);
  useEffect(() => {
    repairRequest.current = null;
    setRepairPending(false);
    setSaving(false);
    setSaveError('');
  }, [profile?.id]);
  const mutationPending =
    saving ||
    acceptance.busy ||
    acceptance.recovering ||
    !!acceptance.recoveryOperationId ||
    bulk.pending ||
    repairPending;
  const reviewBlocked = useRef(false);
  reviewBlocked.current = mutationPending || sourcePending;
  const authorityUnavailable =
    !!page.error ||
    page.loading ||
    page.refreshing ||
    !!firstPage?.error ||
    firstPage?.refreshing ||
    (!!firstPage && !usesFirstPage && observedInitial.current !== initial);
  const selectionWindowKey = JSON.stringify([
    activeScope,
    peopleGroup?.intakeId,
    peopleGroup?.groupId,
    peopleRowCursor,
  ]);
  useEffect(() => setConfirmedSavedIds([]), [selectionWindowKey]);
  const display = useCollectionDisplayModel({
    data: detailRequested ? null : data,
    people: detailRequested ? [] : shownPeople,
    peopleGroup: detailRequested ? undefined : peopleGroup,
    identities,
    filters,
    loading: !data,
    confirmedSavedIds,
    selectionWindowKey,
  });
  async function beforeReviewChange() {
    if (reviewBlocked.current || pendingSourcesRef.current.size) return false;
    const allowed = (await inlineBeforeClose.current?.()) ?? true;
    return allowed && !reviewBlocked.current && !pendingSourcesRef.current.size;
  }
  async function saveRows(rows: CollectionFeedRecord[]) {
    if (mutationPending || sourcePending || authorityUnavailable || !rows.length)
      return { savedIds: [] };
    setSaving(true);
    setSaveError('');
    try {
      const blocks = new Map<string, IntakeReportAcceptanceRequest['blocks'][number]>();
      for (const row of rows) {
        if (row.detail.kind !== 'record' || !row.detail.record.selectable)
          throw new Error('Open this exact record to review its evidence before saving.');
        const shown = row.detail.record;
        const fresh = await readSelectedClinicalReview(
          row.intakeId,
          row.proposalId,
          shown.id,
          shown.candidateVersionId,
        );
        if (active.current !== activeScope) return { savedIds: [] };
        if (
          fresh.record.kind !== 'record' ||
          fresh.context.sourceTextStale ||
          fresh.record.record.selectionReviewToken !== shown.selectionReviewToken
        )
          throw new Error(
            'A selected record changed. Refresh the page and review it before saving.',
          );
        const record = fresh.record.record;
        if (
          !record.candidateId ||
          !record.candidateVersionId ||
          !record.selectionReviewToken ||
          hasUnreviewedPairChoices(record)
        )
          throw new Error('A selected record needs its exact related-record decisions reviewed.');
        const key = JSON.stringify([row.intakeId, row.proposalId]);
        const block = blocks.get(key) || {
          intakeId: row.intakeId,
          proposalId: row.proposalId,
          intakeVersion: fresh.context.version,
          reviewToken: fresh.context.reviewToken,
          selections: [],
        };
        if (
          block.intakeVersion !== fresh.context.version ||
          block.reviewToken !== fresh.context.reviewToken
        )
          throw new Error(
            'The report changed while checking this selection. Refresh before saving.',
          );
        block.selections.push({
          recordId: record.id,
          candidateId: record.candidateId,
          candidateVersionId: record.candidateVersionId,
          selectionReviewToken: record.selectionReviewToken,
          mapping: initialDraft(record).decision.mapping,
          comparisons: initialDraft(record).decision.comparisons,
        });
        blocks.set(key, block);
      }
      const result = await acceptance.submit({
        mode: 'partial-v1',
        operationId: crypto.randomUUID(),
        blocks: [...blocks.values()],
      });
      return {
        savedIds: result ? confirmedSelectionIds(result.receipt) : [],
        rejectedIds: result ? rejectedSelectionIds(result.receipt) : [],
      };
    } catch (cause) {
      if (active.current === activeScope) setSaveError(message(cause));
      return { savedIds: [] };
    } finally {
      if (active.current === activeScope) setSaving(false);
    }
  }
  async function save(ids: string[]) {
    const people = shownPeople.filter((person) => ids.includes(`person:${person.id}`));
    if (people.length) {
      if (
        mutationPending ||
        sourcePending ||
        pendingSourcesRef.current.size ||
        authorityUnavailable ||
        peoplePage.loading ||
        peoplePage.refreshing ||
        peoplePage.error
      )
        return { savedIds: [] };
      donePeople.current = [];
      await bulk.addPeople(people, peopleGroup!.groupId);
      return { savedIds: [...donePeople.current] };
    }
    return saveRows(data?.records.filter((row) => ids.includes(row.feedKey)) || []);
  }
  async function disposition(ids: string[], state: CollectionDisposition) {
    if (mutationPending || sourcePending || authorityUnavailable) return;
    await bulk.disposition(
      data?.records.filter((row) => ids.includes(row.feedKey)) || [],
      shownPeople.filter((person) => ids.includes(`person:${person.id}`)),
      peopleGroup?.groupId || '',
      state,
    );
  }
  async function sendRepair() {
    const request = repairRequest.current;
    if (!request) return null;
    setSaving(true);
    setSaveError('');
    try {
      await api(request.path, { method: 'POST', body: JSON.stringify(request.body) });
      repairRequest.current = null;
      setRepairPending(false);
      refresh();
      return null;
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        ![408, 429].includes(cause.status)
      ) {
        repairRequest.current = null;
        setRepairPending(false);
      }
      const error = message(cause);
      setSaveError(
        error +
          (repairRequest.current
            ? ' The outcome is unconfirmed. Retry the exact draft correction.'
            : ''),
      );
      return error;
    } finally {
      setSaving(false);
    }
  }
  async function correctDrafts(
    selected: IntakeDraftRepairSelection,
    field: IntakeDraftRepairField,
    after: string,
  ) {
    if (mutationPending || authorityUnavailable)
      return 'Finish the pending review action before correcting fields.';
    const corrections = selected.rows.map((item) => {
      const row = data?.records.find(
        (row) =>
          row.intakeId === selected.intakeId &&
          row.groupId === selected.groupId &&
          row.proposalId === item.proposalId &&
          row.detail.kind === 'record' &&
          row.detail.record.id === item.recordId &&
          row.detail.record.candidateVersionId === item.candidateVersionId,
      );
      const shown = display.model.records.find((record) => record.id === row?.feedKey);
      const before = shown?.draftRepair?.fields[field];
      if (!row || before === undefined)
        throw new Error(
          'A selected draft changed. Review the current fields before correcting it.',
        );
      return {
        row,
        correction: {
          proposalId: item.proposalId,
          recordId: item.recordId,
          candidateVersionId: item.candidateVersionId,
          field,
          before,
          after,
        },
      };
    });
    if (
      !corrections.length ||
      new Set(corrections.map((item) => item.row.intakeVersion)).size !== 1
    )
      return 'These drafts changed. Refresh the displayed page before correcting them.';
    repairRequest.current = {
      path: `/intakes/${encodeURIComponent(selected.intakeId)}/draft-repair`,
      body: {
        version: corrections[0]!.row.intakeVersion,
        operationId: crypto.randomUUID(),
        groupId: selected.groupId,
        corrections: corrections.map((item) => item.correction),
      },
    };
    setRepairPending(true);
    return sendRepair();
  }
  const inlineRow = data?.records.find(
    (row) =>
      row.intakeId === intakeId &&
      row.groupId === groupId &&
      (row.detail.kind === 'record' ? row.detail.record.id : row.detail.selection.recordId) ===
        requestedRecord,
  );
  const detailSelection = {
    groupId: groupId!,
    intakeId: intakeId!,
    proposalId: params.has('proposal')
      ? params.get('proposal') === 'original'
        ? null
        : params.get('proposal')
      : (selection?.proposalId ?? inlineRow?.proposalId),
    recordId: requestedRecord || undefined,
    personId: params.get('person') || undefined,
  };
  if (selectionLoading || selectionError)
    return (
      <section className="import-detail-state" role={selectionError ? 'alert' : 'status'}>
        <p>{selectionError || 'Opening the exact retained report…'}</p>
        {selectionError && (
          <button type="button" onClick={() => setParams({})}>
            Back to Import
          </button>
        )}
      </section>
    );
  if (detailRequested && groupId && intakeId)
    return (
      <ImportDetailReview
        key={`${profile?.id}:${groupId}:${intakeId}`}
        selection={detailSelection}
        onBack={() => setParams({})}
        onChanged={refresh}
        onUseSource={() => {}}
      />
    );
  return (
    <div className="page import-page">
      <ReviewNavigationGuard
        anyLocationChange
        pending={() => mutationPending || sourcePending || !!inlineBeforeClose.current}
        flush={beforeReviewChange}
      />
      {reading}
      {status && <p role="status">{status}</p>}
      {saveNotice && <p role="status">{saveNotice}</p>}
      {(saveError || acceptance.error) && <p role="alert">{saveError || acceptance.error}</p>}
      {bulk.error && <p role="alert">{bulk.error}</p>}
      {bulk.notice && <p role="status">{bulk.notice}</p>}
      {bulk.pending && !bulk.busy && (
        <button type="button" onClick={() => void bulk.retry()}>
          Retry exact selected action
        </button>
      )}
      {repairPending && !saving && (
        <button type="button" onClick={() => void sendRepair()}>
          Retry exact draft correction
        </button>
      )}
      <SavedPersonDestinations destinations={recentPeople} />
      <ImportAcceptanceOutcomes receipt={receipt} />
      <ImportSaveStatus
        pendingOperation={!!acceptance.recoveryOperationId}
        saving={acceptance.busy}
        checking={acceptance.recovering}
        canRetry={!!acceptance.pending}
        onCheck={() => void acceptance.checkReceipt()}
        onRetry={() => void acceptance.retry()}
      />
      {(actionError || page.error || firstPage?.error) && (
        <p role="alert">
          {actionError || page.error?.message || firstPage?.error?.message}
          <button type="button" disabled={mutationPending} onClick={refresh}>
            Refresh import review
          </button>
        </p>
      )}
      {!!display.headerErrors?.size && (
        <p role="alert">
          Some displayed report details could not load.
          <button type="button" onClick={display.reloadHeaders}>
            Retry report details
          </button>
        </p>
      )}
      {inlineRequested &&
        (!inlineRow || inlineRow.detail.kind === 'reference') &&
        groupId &&
        intakeId && (
          <div className="import-record-accordion">
            <ImportDetailReview
              embedded
              guardNavigation={false}
              externalPending={mutationPending || sourcePending}
              beforeCloseRef={inlineBeforeClose}
              selection={detailSelection}
              onBack={() => setParams({})}
              onChanged={refresh}
              onUseSource={() => {}}
            />
          </div>
        )}
      <ImportReviewPresentation
        model={display.model}
        requestedRecordId={
          inlineRequested && inlineRow?.detail.kind === 'record' ? inlineRow.feedKey : undefined
        }
        beforeReviewChange={beforeReviewChange}
        preserveSourceReview={sourcePending}
        renderRecordReview={(record, close) => {
          const detail = new URLSearchParams(record.detailUrl?.split('?')[1]);
          if (!detail.get('record')) return null;
          return (
            <ImportDetailReview
              key={record.id}
              embedded
              guardNavigation={false}
              externalPending={mutationPending || sourcePending}
              beforeCloseRef={inlineBeforeClose}
              selection={{
                groupId: detail.get('group')!,
                intakeId: detail.get('intake')!,
                proposalId: detail.get('proposal') === 'original' ? null : detail.get('proposal'),
                recordId: detail.get('record')!,
              }}
              onBack={() => {
                close();
                if (inlineRequested) setParams({});
              }}
              onChanged={refresh}
              onUseSource={() => {}}
            />
          );
        }}
        renderSavedDestination={(record) => {
          const row = data?.records.find((row) => row.feedKey === record.id);
          return row ? <CollectionFeedDestination row={row} /> : null;
        }}
        renderSourceAttention={(onCount) => (
          <ImportSourceTextBrowser
            {...nativeSourceProps}
            attentionRows
            onAttentionCount={onCount}
            attentionRefreshKey={data}
            onPendingChange={(pending) => sourcePendingChange('attention', pending)}
          />
        )}
        renderReportSourceReview={(report) =>
          report.sourceIntakeId ? (
            <ImportSourceTextBrowser
              {...nativeSourceProps}
              intakeId={report.sourceIntakeId}
              onPendingChange={(pending) => sourcePendingChange(report.id, pending)}
            />
          ) : null
        }
        renderReportContext={(tab, report, close, onPending) => (
          <>
            {report.sourceEvidence?.contentUrl && (
              <a href={report.sourceEvidence.contentUrl} target="_blank" rel="noreferrer">
                Review original evidence
              </a>
            )}
            {tab === 'identity' ? (
              <NativeIdentity
                intakeId={report.sourceIntakeId!}
                groupId={report.id}
                onChanged={refresh}
                onDone={close}
                onPending={(pending) => {
                  onPending(pending);
                  sourcePendingChange('context', pending);
                }}
              />
            ) : (
              <CollectionReportSource
                intakeId={report.sourceIntakeId!}
                groupId={report.id}
                onChanged={() => {
                  display.reloadHeaders();
                  refresh();
                }}
                initiallyOpen
                onPending={(pending) => {
                  onPending(pending);
                  sourcePendingChange('context', pending);
                }}
              />
            )}
            <button type="button" onClick={close}>
              Cancel
            </button>
          </>
        )}
        actions={{
          busy: busy || mutationPending || sourcePending || authorityUnavailable,
          peopleBusy: peoplePage.loading || peoplePage.refreshing || !!peoplePage.error,
          uploadBusy: busy || mutationPending,
          uploadUnavailable,
          onFiles: onUpload,
          onSave: save,
          onLater: (ids) => disposition(ids, 'later'),
          onExclude: (ids) => disposition(ids, 'excluded'),
          onResume: (ids) => disposition(ids, 'pending'),
          onFiltersChange: setFilters,
          onCorrectDrafts: correctDrafts,
          onAskDraftRepair: (selected, request) =>
            window.dispatchEvent(
              new CustomEvent('health:ask', {
                detail: {
                  message: request,
                  context: {
                    route: `/import?${new URLSearchParams({ group: selected.groupId, intake: selected.intakeId })}`,
                    intakeRepair: selected,
                  },
                },
              }),
            ),
        }}
      />
      {data && (
        <>
          <p>
            {data.activity.runningFiles} files reading · {data.activity.queuedFiles} queued ·{' '}
            {data.activity.pausedFiles} paused.{' '}
            {data.activity.remainingUnits.state === 'exact'
              ? `${data.activity.remainingUnits.value.toLocaleString()} reading units remain.`
              : 'Remaining reading work is still being checked.'}
          </p>
          <p>
            {data.totalRecords.toLocaleString()} clinical records ·{' '}
            {data.totalGroups.toLocaleString()} reports. Selection covers the displayed clinical and
            People pages.
          </p>
          {data.records
            .filter((row) => row.detail.kind === 'reference')
            .map((row) => (
              <section key={row.feedKey}>
                <p>Clinical record with paged evidence</p>
                <Link to={collectionDetailUrl(row)}>Review exact record</Link>
              </section>
            ))}
          {data.nextCursor && (
            <button
              type="button"
              disabled={mutationPending}
              onClick={async () => {
                if (await beforeReviewChange()) setCursor(data.nextCursor!);
              }}
            >
              Next records
            </button>
          )}
          {cursor && (
            <button
              type="button"
              disabled={mutationPending}
              onClick={async () => {
                if (await beforeReviewChange()) setCursor(undefined);
              }}
            >
              First records
            </button>
          )}
          <section aria-label="Reports with People">
            <h2>People pages</h2>
            <p>{data.people.totalGroups} reports contain named People.</p>
            {!!data.people.groups.length && (
              <label>
                People report
                <select
                  value={peopleGroup ? groupKey(peopleGroup.intakeId, peopleGroup.groupId) : ''}
                  disabled={mutationPending}
                  onChange={async (event) => {
                    const value = event.target.value;
                    if (await beforeReviewChange()) {
                      setPeopleGroupKey(value);
                      setPeopleRowCursor(undefined);
                    }
                  }}
                >
                  {data.people.groups.map((group, index) => (
                    <option
                      key={groupKey(group.intakeId, group.groupId)}
                      value={groupKey(group.intakeId, group.groupId)}
                    >
                      Report {index + 1} on this page
                    </option>
                  ))}
                </select>
              </label>
            )}
            {peoplePage.error && (
              <p role="alert">
                {peoplePage.error.message}
                <button type="button" onClick={peoplePage.reload}>
                  Refresh People page
                </button>
              </p>
            )}
            {peoplePage.loading && <p role="status">Opening named People…</p>}
            {peoplePage.data && (
              <p>
                {peoplePage.data.totalPeople} named People in this report scope; one page is shown.
              </p>
            )}
            {peoplePage.data?.people
              .filter((item) => item.kind === 'reference')
              .map((item) =>
                item.kind === 'reference' ? (
                  <section key={item.reference.id}>
                    <p>Person with paged evidence</p>
                    <Link
                      to={`/import?${new URLSearchParams({ intake: peopleGroup!.intakeId, group: peopleGroup!.groupId, person: item.reference.id })}`}
                    >
                      Review exact Person
                    </Link>
                  </section>
                ) : null,
              )}
            {peoplePage.data?.nextCursor && (
              <button
                type="button"
                disabled={mutationPending}
                onClick={async () => {
                  if (await beforeReviewChange()) setPeopleRowCursor(peoplePage.data!.nextCursor!);
                }}
              >
                Next named People
              </button>
            )}
            {peopleRowCursor && (
              <button
                type="button"
                disabled={mutationPending}
                onClick={async () => {
                  if (await beforeReviewChange()) setPeopleRowCursor(undefined);
                }}
              >
                First named People page
              </button>
            )}
            {data.people.nextCursor && (
              <button
                type="button"
                disabled={mutationPending}
                onClick={async () => {
                  if (await beforeReviewChange()) setPeopleCursor(data.people.nextCursor!);
                }}
              >
                Next reports with People
              </button>
            )}
            {peopleCursor && (
              <button
                type="button"
                disabled={mutationPending}
                onClick={async () => {
                  if (await beforeReviewChange()) setPeopleCursor(undefined);
                }}
              >
                First reports with People
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
export function NativeIdentity({
  intakeId,
  groupId,
  onChanged,
  onPending,
  onGrounded,
  onDone,
}: {
  intakeId: string;
  groupId: string;
  onChanged: () => void;
  onPending?: (pending: boolean) => void;
  onGrounded?: () => void;
  onDone?: () => void;
}) {
  const profile = useProfile();
  const path = `/intakes/${encodeURIComponent(intakeId)}/identity-review?groupId=${encodeURIComponent(groupId)}`;
  const identity = useResource<IntakeIdentityReview>(path);
  const [fresh, setFresh] = useState<IntakeIdentityReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const retained = useRef(new Map<string, IntakeIdentityConfirmation>());
  const acknowledgedRefresh = useRef(false);
  const scope = JSON.stringify([profile?.id, intakeId, groupId]);
  const current = useRef(scope);
  current.current = scope;
  useEffect(() => {
    setFresh(undefined);
    acknowledgedRefresh.current = false;
    retained.current.clear();
    setError('');
    setNotice('');
    return () => {
      current.current = '';
    };
  }, [scope]);
  useEffect(() => setFresh(undefined), [identity.data]);
  const groundingListener = useRef(onGrounded);
  groundingListener.current = onGrounded;
  const changedListener = useRef(onChanged);
  changedListener.current = onChanged;
  const observedGrounding = useRef<string | undefined>(undefined);
  useEffect(() => {
    const review = identity.data;
    if (!review) return;
    const alreadyRefreshing = acknowledgedRefresh.current;
    acknowledgedRefresh.current = false;
    if (alreadyRefreshing) {
      // This GET establishes receipt grounding. Read clinical readiness only
      // after it completes, rather than racing that proof with the report read.
      if (hostGroundedIdentity(review))
        observedGrounding.current = JSON.stringify([
          scope,
          (review.scopeReference || review.scope)?.scopeToken,
        ]);
      changedListener.current();
      return;
    }
    if (!hostGroundedIdentity(review)) return;
    const key = JSON.stringify([scope, (review.scopeReference || review.scope)?.scopeToken]);
    if (observedGrounding.current === key) return;
    observedGrounding.current = key;
    groundingListener.current?.();
  }, [identity.data, scope]);
  const pendingListener = useRef(onPending);
  pendingListener.current = onPending;
  useEffect(() => {
    pendingListener.current?.(busy || retained.current.size > 0);
  }, [busy, error, scope]);
  useEffect(() => () => pendingListener.current?.(false), []);
  const review = fresh || identity.data;
  const identityScope = review?.scopeReference || review?.scope;
  const confirm: ComponentProps<typeof ImportDetailIdentityPanel>['onConfirm'] = (
    fields,
    personSelection,
    printedName,
    identityAnswers,
    futureNameOwner,
  ) => {
    if (!review || !identityScope || busy || identity.refreshing) return;
    const key = JSON.stringify([
      identityScope,
      fields,
      personSelection,
      printedName,
      identityAnswers,
      futureNameOwner,
    ]);
    if (retained.current.size && !retained.current.has(key)) {
      setError(
        'The earlier person choice is unconfirmed. Retry the exact identity confirmation before changing it.',
      );
      return;
    }
    const request = retained.current.get(key) || {
      version: identityScope.intakeVersion,
      operationId: crypto.randomUUID(),
      scope: identityScope,
      outcome: personSelection ? ('this_is_person' as const) : ('this_is_me' as const),
      ...(personSelection ? { personSelection } : {}),
      ...(printedName ? { printedName } : {}),
      ...(identityAnswers ? { identityAnswers } : {}),
      ...(review.challengedName
        ? { futureNameOwner: futureNameOwner || { outcome: 'ask' as const } }
        : {}),
      attestation:
        (review.scopeReference?.collection.questions ?? review.scope?.questions?.length)
          ? ('confirmed_displayed_identity_questions' as const)
          : ('confirmed_displayed_report_subject' as const),
      ...(!personSelection && Object.keys(fields).length
        ? { selfUpdate: { expectedVersion: review.self.version, fields } }
        : {}),
    };
    sendIdentity(key, request);
  };
  function sendIdentity(key: string, request: IntakeIdentityConfirmation) {
    if (!review || busy) return;
    setBusy(true);
    setError('');
    void confirmIdentityWithFreshness({
      displayed: review,
      request,
      send: async (next) =>
        (
          await api<Intake>(`/intakes/${encodeURIComponent(intakeId)}/identity-scope`, {
            method: 'POST',
            body: JSON.stringify(next),
          })
        ).data,
      loadFresh: async () => (await api<IntakeIdentityReview>(path)).data,
      isContextCurrent: () => current.current === scope,
      retainRequest: (next) => {
        if (next) retained.current.set(key, next);
        else retained.current.delete(key);
      },
    })
      .then((result) => {
        if (current.current !== scope || result.status === 'context_changed') return;
        if (result.status === 'scope_changed') {
          setFresh(result.fresh);
          setError(result.message);
          return;
        }
        setNotice('Report identity confirmed. Clinical records remain in review.');
        acknowledgedRefresh.current = true;
        identity.reload();
      })
      .catch((cause) => {
        if (current.current === scope) setError(message(cause));
      })
      .finally(() => {
        if (current.current === scope) setBusy(false);
      });
  }
  return (
    <>
      {retained.current.size > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const exact = retained.current.entries().next().value;
            if (exact) sendIdentity(exact[0], exact[1]);
          }}
        >
          Retry exact identity confirmation
        </button>
      )}
      {review?.scopeFragmentReference && (
        <section aria-label="Referenced report identity evidence">
          <p>
            This retained identity field needs paged inspection. Reading it does not establish a
            complete scope for person confirmation.
          </p>
          <CollectionEvidenceWindow
            scope={JSON.stringify([scope, review.scopeFragmentReference])}
            label="Complete retained identity field"
            path={`/intakes/${encodeURIComponent(intakeId)}/collection-fragment`}
            body={{ reference: review.scopeFragmentReference }}
            onRefresh={identity.reload}
          />
        </section>
      )}
      <ImportDetailIdentityPanel
        review={identity.error || identity.refreshing ? undefined : review || undefined}
        loading={identity.loading || !!identity.refreshing}
        error={error || identity.error?.message || ''}
        notice={notice}
        busy={busy}
        onRetry={identity.reload}
        onDone={onDone || (() => {})}
        onConfirm={confirm}
      />
    </>
  );
}

export function CollectionReportReview({
  initial,
  selection,
  onBack,
  onChanged,
  embedded,
  beforeCloseRef,
  parentError,
  guardNavigation = true,
  externalPending = false,
  firstPage,
}: ComponentProps<typeof ImportDetailReview> & {
  initial: CollectionReportDetail;
  parentError?: string;
  /** The parent owns the first bounded page; only subsequent windows fetch here. */
  firstPage?: { reload: () => void; refreshing?: boolean; error: Error | null };
}) {
  const profile = useProfile();
  const [identityPending, setIdentityPending] = useState(false);
  const [sourcePending, setSourcePending] = useState(false);
  const [peoplePending, setPeoplePending] = useState(false);
  const [sourceTextPending, setSourceTextPending] = useState(false);
  const contextPending =
    identityPending || sourcePending || peoplePending || sourceTextPending || externalPending;
  useEffect(() => {
    if (!beforeCloseRef || (selection.recordId && selection.proposalId !== undefined)) return;
    const flush = async () => !contextPending;
    beforeCloseRef.current = flush;
    return () => {
      if (beforeCloseRef.current === flush) beforeCloseRef.current = null;
    };
  }, [beforeCloseRef, selection.recordId, selection.proposalId, contextPending]);
  const guardedBack = () => {
    if (!contextPending) onBack();
  };
  const [cursor, setCursor] = useState<string>();
  const [peopleCursor, setPeopleCursor] = useState<string>();
  const query = new URLSearchParams({
    view: 'all',
    intakeId: initial.group.intakeId,
    limit: '40',
    bytes: '65536',
  });
  if (cursor) query.set('cursor', cursor);
  if (peopleCursor) query.set('peopleCursor', peopleCursor);
  if (selection.personId) query.set('personId', selection.personId);
  const pagedResource = useResource<CollectionReportDetail>(
    firstPage && !cursor && !peopleCursor
      ? null
      : `/intakes/report-queue/${encodeURIComponent(selection.groupId)}?${query}`,
  );
  const resource =
    firstPage && !cursor && !peopleCursor
      ? { ...firstPage, data: initial, loading: false }
      : pagedResource;
  useEffect(() => {
    setCursor(undefined);
    setPeopleCursor(undefined);
  }, [initial]);
  const pageLoading = !resource.data && (!!cursor || !!peopleCursor);
  // Keep report context and its exact operation state mounted while replacing
  // a clinical or People window. The old rows are not shown as the new page.
  const data = resource.data || initial;
  const refresh = () => {
    setCursor(undefined);
    setPeopleCursor(undefined);
    (firstPage || pagedResource).reload();
    onChanged();
  };
  const refreshGrounding = () => {
    resource.reload();
    onChanged();
  };
  if (resource.error && !data)
    return (
      <section role="alert">
        <p>{resource.error.message}</p>
        <button className="button secondary" type="button" onClick={refresh}>
          Refresh report
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={contextPending}
          onClick={guardedBack}
        >
          Back to Import
        </button>
      </section>
    );
  if (!data) return <LoadingIndicator label="Opening report page…" />;
  if (!isCollectionReportDetail(data))
    return <p role="alert">This report changed. Refresh Import.</p>;
  const identityPanel = (
    <NativeIdentity
      key={`${profile?.id}:${data.group.intakeId}:${data.group.groupId}`}
      intakeId={data.group.intakeId}
      groupId={data.group.groupId}
      onChanged={refresh}
      onPending={setIdentityPending}
      onGrounded={() => {
        if (
          data.records.records.some(
            (row) => row.kind === 'record_reference' || row.record.identityReview?.blocking,
          )
        )
          refreshGrounding();
      }}
    />
  );
  const sourcePanel = (
    <CollectionReportSource
      intakeId={data.group.intakeId}
      groupId={data.group.groupId}
      onChanged={refresh}
      onPending={setSourcePending}
    />
  );
  if (selection.recordId && selection.proposalId !== undefined)
    return (
      <ImportRecordDetail
        embedded={embedded}
        contextPending={contextPending}
        guardNavigation={guardNavigation}
        beforeCloseRef={beforeCloseRef}
        groupId={data.group.groupId}
        block={{
          intakeId: selection.intakeId || data.group.intakeId,
          proposalId: selection.proposalId,
        }}
        recordId={selection.recordId}
        contextError={parentError || resource.error?.message}
        onRetryContext={refresh}
        identityPanel={
          <fieldset
            disabled={sourcePending || peoplePending || sourceTextPending}
            inert={sourcePending || peoplePending || sourceTextPending}
            style={{ border: 0, padding: 0, margin: 0 }}
          >
            {identityPanel}
          </fieldset>
        }
        identityRevision={data.group.intakeVersion}
        sourcePanel={
          <fieldset
            disabled={identityPending || peoplePending || sourceTextPending}
            inert={identityPending || peoplePending || sourceTextPending}
            style={{ border: 0, padding: 0, margin: 0 }}
          >
            {sourcePanel}
          </fieldset>
        }
        commonIdentityIssueIds={new Set()}
        sourceError=""
        onBack={guardedBack}
        onChanged={refresh}
        onUseSource={() => {}}
      />
    );
  return (
    <section className="import-detail">
      {guardNavigation && (
        <ReviewNavigationGuard
          anyLocationChange
          pending={() => contextPending}
          flush={async () => !contextPending}
        />
      )}
      {resource.error && (
        <p role="alert">
          {resource.error.message}
          {(cursor || peopleCursor) && (
            <button
              type="button"
              disabled={contextPending || resource.loading || resource.refreshing}
              onClick={resource.reload}
            >
              Retry report page
            </button>
          )}
          <button type="button" onClick={refresh}>
            Refresh report
          </button>
        </p>
      )}
      <button
        className="button secondary"
        type="button"
        disabled={contextPending}
        onClick={guardedBack}
      >
        Back to Import
      </button>
      <h2>{label(data.group.title, 'Report with paged evidence')}</h2>
      <a href={apiUrl(data.group.original.contentUrl)} target="_blank" rel="noreferrer">
        Open retained original
      </a>
      <p>
        {data.records.totalRecords} clinical records · {data.people.totalPeople} named People
      </p>
      <details>
        <summary>Original report details</summary>
        {(
          [
            ['Report title', data.group.title],
            ['Source', data.group.source],
            ['Original filename', data.group.original.filename],
            ['Package filename', data.group.member?.filename],
            ['Package location', data.group.member?.locator],
            ['Report evidence', data.group.report],
            ['Report context', data.group.reportContext],
          ] as [string, unknown][]
        ).map(([heading, value]) => {
          if (!value) return null;
          if (
            typeof value === 'object' &&
            'format' in value &&
            value.format === 'health-intake-review-fragment-v1'
          ) {
            const reference = value as IntakeReviewFragmentReference;
            return (
              <CollectionEvidenceWindow
                key={heading}
                scope={JSON.stringify(reference)}
                label={heading}
                path={`/intakes/${encodeURIComponent(data.group.intakeId)}/collection-fragment`}
                body={{ reference }}
                onRefresh={refresh}
              />
            );
          }
          return (
            <p key={heading}>
              <strong>{heading}: </strong>
              {typeof value === 'string' ? value : JSON.stringify(value)}
            </p>
          );
        })}
      </details>
      <fieldset
        disabled={sourcePending || peoplePending || sourceTextPending}
        inert={sourcePending || peoplePending || sourceTextPending}
        style={{ border: 0, padding: 0, margin: 0 }}
      >
        {identityPanel}
      </fieldset>
      <fieldset
        disabled={identityPending || peoplePending || sourceTextPending}
        inert={identityPending || peoplePending || sourceTextPending}
        style={{ border: 0, padding: 0, margin: 0 }}
      >
        {sourcePanel}
      </fieldset>
      <fieldset
        disabled={contextPending}
        inert={contextPending}
        style={{ border: 0, padding: 0, margin: 0 }}
      >
        {pageLoading ? (
          <LoadingIndicator label="Opening report records…" />
        ) : (
          <>
            <CollectionReportRecords data={data} onRefresh={refresh} />
            {data.records.records.some((row) => row.queueState === 'accepted') && (
              <section aria-label="Saved destinations for this report">
                <h3>Saved destinations for this report</h3>
                <p>
                  Saved records on the displayed report page. Use the report page controls to
                  inspect additional records.
                </p>
                {data.records.records
                  .filter((row) => row.queueState === 'accepted')
                  .map((row) => {
                    const recordId = row.kind === 'record' ? row.record.id : row.selection.recordId;
                    return (
                      <CollectionRecordDestination
                        key={`${row.proposalId}:${recordId}`}
                        intakeId={data.records.intakeId}
                        groupId={row.groupId}
                        proposalId={row.proposalId}
                        recordId={recordId}
                        intakeVersion={data.records.version}
                      />
                    );
                  })}
              </section>
            )}
            {data.records.nextCursor && (
              <button
                className="button secondary"
                type="button"
                disabled={resource.loading || resource.refreshing}
                onClick={() => setCursor(data.records.nextCursor!)}
              >
                Next report records
              </button>
            )}
            {cursor && (
              <button
                className="button secondary"
                type="button"
                onClick={() => setCursor(undefined)}
              >
                First report records
              </button>
            )}
          </>
        )}
      </fieldset>
      <fieldset
        disabled={identityPending || sourcePending || sourceTextPending}
        inert={identityPending || sourcePending || sourceTextPending}
        style={{ border: 0, padding: 0, margin: 0 }}
      >
        {pageLoading ? (
          <LoadingIndicator label="Opening report People…" />
        ) : (
          <>
            <CollectionPeople
              onPending={setPeoplePending}
              page={data.people}
              groupId={data.group.groupId}
              preferredPersonId={selection.personId}
              onRefresh={refresh}
              onNext={() => setPeopleCursor(data.people.nextCursor || undefined)}
            />
            {peopleCursor && (
              <button
                className="button secondary"
                type="button"
                disabled={peoplePending}
                onClick={() => setPeopleCursor(undefined)}
              >
                First People page
              </button>
            )}
          </>
        )}
      </fieldset>
      <fieldset
        disabled={identityPending || sourcePending || peoplePending || externalPending}
        inert={identityPending || sourcePending || peoplePending || externalPending}
        style={{ border: 0, padding: 0, margin: 0 }}
      >
        <ImportSourceTextBrowser
          intakeId={data.group.intakeId}
          onChanged={refresh}
          guardNavigation={false}
          onPendingChange={setSourceTextPending}
        />
      </fieldset>
    </section>
  );
}

function CollectionReportRecords({
  data,
  onRefresh,
}: {
  data: CollectionReportDetail;
  onRefresh: () => void;
}) {
  return (
    <ul aria-label="Report clinical records">
      {data.records.records.map((row, index) => {
        const recordId =
          row.kind === 'record'
            ? row.record.id
            : 'selection' in row
              ? (row.selection as { recordId: string }).recordId
              : undefined;
        return (
          <li key={`${row.proposalId}:${recordId || index}`}>
            <strong>
              {row.kind === 'record' ? row.record.title : 'Clinical record with paged evidence'}
            </strong>
            <p>{row.queueState.replaceAll('_', ' ')}</p>
            {recordId ? (
              <Link
                className="import-detail-record-link"
                to={`/import?${selectionUrl(data.records.intakeId, row.groupId, row.proposalId, recordId)}`}
              >
                Review exact record —{' '}
                {row.kind === 'record' ? row.record.title : 'Referenced clinical record'}
              </Link>
            ) : (
              row.kind === 'record_reference' && (
                <ClinicalReviewReference
                  intakeId={data.records.intakeId}
                  proposalId={row.proposalId}
                  reference={row.reference}
                  onRefresh={onRefresh}
                />
              )
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function CollectionPeople({
  page,
  groupId,
  preferredPersonId,
  onRefresh,
  onNext,
  onPending,
}: {
  page: CollectionPeoplePage;
  groupId: string;
  preferredPersonId?: string;
  onRefresh: () => void;
  onNext: () => void;
  onPending?: (pending: boolean) => void;
}) {
  const profile = useProfile();
  const scope = JSON.stringify([profile?.id, page.intakeId, groupId]);
  const active = useRef(scope);
  active.current = scope;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requests = useRef(
    new Map<string, IntakePersonApplyRequest | IntakePersonDispositionRequest>(),
  );
  useEffect(() => {
    requests.current.clear();
    setBusy(false);
    setError('');
    return () => {
      active.current = '';
    };
  }, [scope]);
  const pendingListener = useRef(onPending);
  pendingListener.current = onPending;
  useEffect(() => {
    pendingListener.current?.(busy || requests.current.size > 0);
  }, [busy, error, scope]);
  useEffect(() => () => pendingListener.current?.(false), []);
  async function mutate(
    proposal: Pick<CollectionPersonProposal, 'id' | 'intakeId' | 'version' | 'intakeVersion'>,
    choice:
      | { state: 'pending' | 'later' | 'excluded' }
      | { action: 'add' }
      | { action: 'update'; noteId: string; version: number },
  ) {
    if (busy || requests.current.size) return;
    const key = JSON.stringify([proposal.id, proposal.version, choice]);
    const base = {
      operationId: crypto.randomUUID(),
      intakeId: proposal.intakeId,
      proposalId: proposal.id,
      proposalVersion: proposal.version,
    };
    const request: IntakePersonApplyRequest | IntakePersonDispositionRequest =
      requests.current.get(key) ||
      ('state' in choice
        ? { ...base, ...choice, intakeVersion: proposal.intakeVersion }
        : { ...base, ...choice });
    requests.current.set(key, request);
    await send(key, request);
  }
  async function send(
    key: string,
    request: IntakePersonApplyRequest | IntakePersonDispositionRequest,
  ) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api('state' in request ? '/intakes/people-disposition' : '/intakes/people-apply', {
        method: 'POST',
        body: JSON.stringify(request),
      });
      if (active.current !== scope) return;
      requests.current.delete(key);
      onRefresh();
    } catch (cause) {
      if (active.current !== scope) return;
      if (
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        ![408, 429].includes(cause.status)
      )
        requests.current.delete(key);
      setError(message(cause));
    } finally {
      if (active.current === scope) setBusy(false);
    }
  }
  if (preferredPersonId && page.selectedPersonId !== preferredPersonId)
    return <p role="status">Opening the exact requested person…</p>;
  return (
    <section aria-label="Report People">
      <h3>People</h3>
      {preferredPersonId &&
        !page.people.some(
          (item) =>
            (item.kind === 'person' ? item.person.id : item.reference.id) === preferredPersonId,
        ) && (
          <p role="alert">
            The requested named person is not available in this report page. Refresh the exact
            report before choosing a person.
            <button className="button secondary" type="button" onClick={onRefresh}>
              Refresh exact person
            </button>
          </p>
        )}
      {error && <p role="alert">{error}</p>}
      {requests.current.size > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const exact = requests.current.entries().next().value;
            if (exact) void send(exact[0], exact[1]);
          }}
        >
          Retry exact Person choice
        </button>
      )}
      <ReportPeopleReview
        queue={{
          groupId,
          people: page.people.flatMap((item) => (item.kind === 'person' ? [item.person] : [])),
          totalPeople: page.totalPeople,
          peopleNextCursor: page.nextCursor,
        }}
        preferredPersonId={preferredPersonId}
        busy={busy || requests.current.size > 0}
        loadingMore={false}
        onLoadMore={onNext}
        onDisposition={(person, state) => void mutate(person, { state })}
        onApply={(person, choice) => void mutate(person, choice)}
      />
      {page.people
        .filter((item) => item.kind === 'reference')
        .map((item) => (
          <ReferencedPerson
            key={`${item.reference.id}:${item.reference.binding}`}
            reference={item.reference}
            busy={busy || requests.current.size > 0}
            onRefresh={onRefresh}
            onDecision={(choice) =>
              void mutate(
                { intakeId: item.reference.intakeId, ...item.reference.selection },
                choice,
              )
            }
          />
        ))}
    </section>
  );
}

function ReferencedPerson({
  reference,
  busy,
  onRefresh,
  onDecision,
}: {
  reference: CollectionPersonReference;
  busy: boolean;
  onRefresh: () => void;
  onDecision: (
    choice:
      | { state: 'pending' | 'later' | 'excluded' }
      | { action: 'add' }
      | { action: 'update'; noteId: string; version: number },
  ) => void;
}) {
  const [inspected, setInspected] = useState(false);
  const finalized = reference.selection.state === 'saved';
  return (
    <section aria-label="Named person with paged evidence">
      <CollectionEvidenceWindow
        bytes={reference.bytes}
        scope={JSON.stringify(reference)}
        label="Named person evidence"
        path={`/intakes/${encodeURIComponent(reference.intakeId)}/people-fragment`}
        body={{ reference }}
        onRefresh={onRefresh}
        onInspected={setInspected}
      />
      <p>
        Read every evidence page before choosing how to keep this person. Clinical records are not
        changed by this action.
      </p>
      {reference.saved && <a href={reference.saved.resultUrl}>Open saved person</a>}
      {reference.policy.selfMatch && (
        <p role="status">
          This evidence matches Self. Review the report identity before adding another person.
        </p>
      )}
      {reference.matches.truncated && (
        <p>
          Only the first {reference.matches.items.length} of {reference.matches.total} possible
          matches are shown. These short labels identify the saved People; review their profiles
          before choosing.
        </p>
      )}
      <button
        className="button secondary"
        type="button"
        disabled={busy || !inspected || finalized || !reference.policy.canAdd}
        onClick={() => onDecision({ action: 'add' })}
      >
        Add named person
      </button>
      {reference.matches.items.map((match) => (
        <div key={match.noteId}>
          <a
            href={`#/people?id=${encodeURIComponent(match.noteId)}`}
            target="_blank"
            rel="noreferrer"
          >
            Open saved person: {match.title}
          </a>
          <button
            className="button secondary"
            type="button"
            disabled={
              busy ||
              !inspected ||
              finalized ||
              reference.policy.selfMatch ||
              reference.selection.state !== 'pending'
            }
            onClick={() =>
              onDecision({ action: 'update', noteId: match.noteId, version: match.version })
            }
          >
            Update {match.title}
          </button>
        </div>
      ))}
      {!finalized && (
        <>
          <button
            className="button secondary"
            type="button"
            disabled={busy || !inspected}
            onClick={() => onDecision({ state: 'later' })}
          >
            Review person later
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy || !inspected}
            onClick={() => onDecision({ state: 'excluded' })}
          >
            Exclude named person
          </button>
          {reference.selection.state !== 'pending' && (
            <button
              className="button secondary"
              type="button"
              disabled={busy || !inspected}
              onClick={() => onDecision({ state: 'pending' })}
            >
              Return person to review
            </button>
          )}
        </>
      )}
    </section>
  );
}
