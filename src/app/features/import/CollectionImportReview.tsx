import { CollectionEvidenceWindow } from '../intake/CollectionEvidenceWindow';
export { CollectionEvidenceWindow } from '../intake/CollectionEvidenceWindow';
import { useEffect, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  CollectionImportFeed,
  CollectionReportDetail,
  CollectionPersonProposal,
  CollectionPeoplePage,
  CollectionPersonReference,
  IntakeReviewFragmentReference,
} from '../../../shared/intake-clinical-pages';
import {
  isCollectionImportFeed,
  isCollectionReportDetail,
} from '../../../shared/intake-clinical-pages';
import type { Intake, IntakeReportAcceptanceRequest } from '../../../shared/intake';
import { readSelectedClinicalReview } from '../../data/intake-clinical-review';
import { useReportAcceptance } from '../intake/useReportAcceptance';
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
import { api, useResource, ApiError } from '../../data/api';
import { useProfile } from '../../data/profile';
import { confirmIdentityWithFreshness } from '../../data/identity-confirmation-freshness';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import { ReportPeopleReview } from '../intake/ReportPeopleReview';
import { ClinicalReviewReference } from '../intake/ClinicalReviewPages';
import { ImportDetailReview, ImportRecordDetail } from './ImportDetailReview';
import { ImportDetailIdentityPanel } from './ImportDetailIdentityPanel';
import { ImportSourceTextBrowser, type SourceBrowserProps } from './ImportSourceTextBrowser';
import { CollectionReportSource } from './CollectionReportSource';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'This review could not finish. Refresh and try again.';
const label = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
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

/** Only one feed window is retained. Counts always come from the complete server scope. */
export function CollectionImportReview({
  initial,
  selection,
  selectionLoading,
  selectionError,
  path,
  onChanged,
  sourceProps,
  onUpload,
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
  onChanged: () => void;
  sourceProps: SourceBrowserProps;
  onUpload: (files: File[]) => Promise<void>;
  busy: boolean;
  status: string;
  error: string;
  reading?: ReactNode;
}) {
  const profile = useProfile();
  const [params, setParams] = useSearchParams();
  const [cursor, setCursor] = useState<string>();
  const [peopleCursor, setPeopleCursor] = useState<string>();
  const [view, setView] = useState(initial.view);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [edited, setEdited] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveNotice, setSaveNotice] = useState('');
  const queryParams = new URLSearchParams(path.split('?')[1]);
  queryParams.set('view', view);
  queryParams.set('limit', '40');
  queryParams.set('bytes', '65536');
  if (view !== initial.view) queryParams.delete('state');
  if (query) queryParams.set('q', query);
  else queryParams.delete('q');
  if (cursor) queryParams.set('cursor', cursor);
  if (peopleCursor) queryParams.set('peopleCursor', peopleCursor);
  if (kind) queryParams.set('kind', kind);
  if (edited) queryParams.set('edited', 'true');
  const ownPath = `/intakes/import-feed?${queryParams}`;
  const page = useResource<CollectionImportFeed>(ownPath);
  useEffect(() => {
    setCursor(undefined);
    setPeopleCursor(undefined);
  }, [path, view, query, kind, edited, profile?.id, initial]);
  const data = page.data || (!cursor && view === initial.view && !query ? initial : null);
  const activeScope = JSON.stringify([profile?.id, ownPath]);
  const active = useRef(activeScope);
  active.current = activeScope;
  useEffect(() => {
    setSelected(new Set());
    setSaveError('');
    setSaving(false);
    return () => {
      active.current = '';
    };
  }, [activeScope, data]);
  const acceptance = useReportAcceptance(profile?.id || '', (result) => {
    setSaveNotice(
      `${result.receipt.acceptedCount} records saved. Any remaining records still need review.`,
    );
    setSelected(new Set());
    page.reload();
    onChanged();
  });
  async function saveSelected() {
    if (
      !data ||
      saving ||
      acceptance.busy ||
      acceptance.recovering ||
      acceptance.recoveryOperationId
    )
      return;
    setSaving(true);
    setSaveError('');
    try {
      const blocks = new Map<string, IntakeReportAcceptanceRequest['blocks'][number]>();
      for (const row of data.records.filter((item) => selected.has(item.feedKey))) {
        if (row.detail.kind !== 'record' || !row.detail.record.selectable)
          throw new Error('Open this exact record to review its evidence before saving.');
        const shown = row.detail.record;
        const fresh = await readSelectedClinicalReview(
          row.intakeId,
          row.proposalId,
          shown.id,
          shown.candidateVersionId,
        );
        if (active.current !== activeScope) return;
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
        let block = blocks.get(key);
        if (!block) {
          block = {
            intakeId: row.intakeId,
            proposalId: row.proposalId,
            intakeVersion: fresh.context.version,
            reviewToken: fresh.context.reviewToken,
            selections: [],
          };
          blocks.set(key, block);
        }
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
          mapping: record.mapping,
          comparisons: record.draft?.decision?.comparisons,
        });
      }
      if (blocks.size)
        await acceptance.submit({
          mode: 'partial-v1',
          operationId: crypto.randomUUID(),
          blocks: [...blocks.values()],
        });
    } catch (cause) {
      if (active.current === activeScope) setSaveError(message(cause));
    } finally {
      if (active.current === activeScope) setSaving(false);
    }
  }
  const groupId = params.get('group') || params.get('report') || selection?.groupId;
  const intakeId = params.get('intake') || selection?.intakeId;
  const requestedRecord = params.get('record');
  const exactRows = requestedRecord
    ? data?.records.filter(
        (row) =>
          row.intakeId === intakeId &&
          row.groupId === groupId &&
          (row.detail.kind === 'record' ? row.detail.record.id : row.detail.selection.recordId) ===
            requestedRecord,
      )
    : [];
  const refresh = () => {
    setCursor(undefined);
    setPeopleCursor(undefined);
    page.reload();
    onChanged();
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
  if (groupId && intakeId)
    return (
      <ImportDetailReview
        key={`${profile?.id}:${groupId}:${intakeId}`}
        selection={{
          groupId,
          intakeId,
          proposalId: params.has('proposal')
            ? params.get('proposal') === 'original'
              ? null
              : params.get('proposal')
            : exactRows?.length === 1
              ? exactRows[0]!.proposalId
              : undefined,
          recordId: params.get('record') || undefined,
          personId: params.get('person') || undefined,
        }}
        onBack={() => setParams({})}
        onChanged={refresh}
        onUseSource={() => {}}
      />
    );
  return (
    <div className="page import-page">
      <h1>Import</h1>
      {reading}
      <label className="button secondary">
        Add originals
        <input
          type="file"
          multiple
          disabled={busy}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files || []);
            event.currentTarget.value = '';
            void onUpload(files);
          }}
        />
      </label>
      {status && <p role="status">{status}</p>}
      {saveNotice && <p role="status">{saveNotice}</p>}
      {(saveError || acceptance.error) && <p role="alert">{saveError || acceptance.error}</p>}
      <ImportSaveStatus
        pendingOperation={!!acceptance.recoveryOperationId}
        saving={acceptance.busy}
        checking={acceptance.recovering}
        canRetry={!!acceptance.pending}
        onCheck={() => void acceptance.checkReceipt()}
        onRetry={() => void acceptance.retry()}
      />
      {(actionError || page.error) && (
        <p role="alert">
          {actionError || page.error?.message}
          <button className="button secondary" type="button" onClick={refresh}>
            Refresh import review
          </button>
        </p>
      )}
      <label>
        Review view
        <select
          value={view}
          onChange={(event) => setView(event.target.value as CollectionImportFeed['view'])}
        >
          <option value="active">To review</option>
          <option value="deferred">Review later</option>
          <option value="all">All records</option>
        </select>
      </label>
      <label>
        Find records
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <label>
        Record kind
        <select value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="">All kinds</option>
          {['test', 'prescription', 'vision', 'procedure', 'history', 'unsupported', 'person'].map(
            (value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ),
          )}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={edited}
          onChange={(event) => setEdited(event.target.checked)}
        />
        Edited records only
      </label>
      {data && isCollectionImportFeed(data) && (
        <>
          <p role="status">
            {data.totalRecords.toLocaleString()} clinical records ·{' '}
            {data.totalGroups.toLocaleString()} reports · {data.counts.pending.toLocaleString()}{' '}
            awaiting review
          </p>
          <p>
            {data.activity.runningFiles} files reading · {data.activity.queuedFiles} queued ·{' '}
            {data.activity.pausedFiles} paused.{' '}
            {data.activity.remainingUnits.state === 'exact'
              ? `${data.activity.remainingUnits.value.toLocaleString()} reading units remain.`
              : 'Remaining reading work is still being checked.'}
          </p>
          <ul aria-label="Clinical records">
            {data.records.map((row) => {
              const recordId =
                row.detail.kind === 'record'
                  ? row.detail.record.id
                  : 'selection' in row.detail
                    ? (row.detail.selection as { recordId: string }).recordId
                    : undefined;
              return (
                <li key={row.feedKey}>
                  <strong>
                    {row.detail.kind === 'record'
                      ? row.detail.record.title
                      : 'Clinical record with paged evidence'}
                  </strong>
                  {row.detail.kind === 'record' && row.detail.record.selectable && (
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.has(row.feedKey)}
                        disabled={saving || acceptance.busy || !!acceptance.recoveryOperationId}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(row.feedKey);
                            else next.delete(row.feedKey);
                            return next;
                          })
                        }
                      />
                      Select {row.detail.record.title}
                    </label>
                  )}
                  <p>
                    {row.feedKind.replaceAll('_', ' ')}
                    {row.detail.kind === 'record'
                      ? ` · ${row.detail.record.queueState.replaceAll('_', ' ')}`
                      : ''}
                  </p>
                  {recordId ? (
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() =>
                        setParams(selectionUrl(row.intakeId, row.groupId, row.proposalId, recordId))
                      }
                    >
                      Review exact record
                    </button>
                  ) : (
                    row.detail.kind === 'reference' && (
                      <ClinicalReviewReference
                        intakeId={row.intakeId}
                        proposalId={row.proposalId}
                        reference={row.detail.reference}
                        onRefresh={refresh}
                      />
                    )
                  )}
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => setParams(selectionUrl(row.intakeId, row.groupId))}
                  >
                    Open report
                  </button>
                </li>
              );
            })}
          </ul>
          {!data.records.length && <p>No clinical records match this view.</p>}
          <button
            className="button secondary"
            type="button"
            disabled={
              !selected.size ||
              saving ||
              acceptance.busy ||
              acceptance.recovering ||
              !!acceptance.recoveryOperationId
            }
            onClick={() => void saveSelected()}
          >
            {saving ? 'Checking selected records…' : `Save ${selected.size} selected records`}
          </button>
          {data.nextCursor && (
            <button
              className="button secondary"
              type="button"
              disabled={page.loading || page.refreshing}
              onClick={() => setCursor(data.nextCursor!)}
            >
              Next records
            </button>
          )}
          {cursor && (
            <button className="button secondary" type="button" onClick={() => setCursor(undefined)}>
              First records
            </button>
          )}
          <section aria-label="Reports with People">
            <h2>People</h2>
            <p>{data.people.totalGroups} reports contain named People.</p>
            {data.people.groups.map((group) => (
              <p key={`${group.intakeId}:${group.groupId}`}>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setParams(selectionUrl(group.intakeId, group.groupId))}
                >
                  Review People in report
                </button>
              </p>
            ))}
            {data.people.nextCursor && (
              <button
                className="button secondary"
                type="button"
                disabled={page.loading || page.refreshing}
                onClick={() => setPeopleCursor(data.people.nextCursor!)}
              >
                Next reports with People
              </button>
            )}
            {peopleCursor && (
              <button
                className="button secondary"
                type="button"
                onClick={() => setPeopleCursor(undefined)}
              >
                First reports with People
              </button>
            )}
          </section>
        </>
      )}
      {page.loading && !data && <LoadingIndicator label="Opening import review…" />}
      <ImportSourceTextBrowser {...sourceProps} />
    </div>
  );
}

export function NativeIdentity({
  intakeId,
  groupId,
  onChanged,
}: {
  intakeId: string;
  groupId: string;
  onChanged: () => void;
}) {
  const profile = useProfile();
  const path = `/intakes/${encodeURIComponent(intakeId)}/identity-review?groupId=${encodeURIComponent(groupId)}`;
  const identity = useResource<IntakeIdentityReview>(path);
  const [fresh, setFresh] = useState<IntakeIdentityReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const retained = useRef(new Map<string, IntakeIdentityConfirmation>());
  const scope = JSON.stringify([profile?.id, intakeId, groupId]);
  const current = useRef(scope);
  current.current = scope;
  useEffect(() => {
    setFresh(undefined);
    retained.current.clear();
    setError('');
    setNotice('');
    return () => {
      current.current = '';
    };
  }, [scope]);
  useEffect(() => setFresh(undefined), [identity.data]);
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
        identity.reload();
        onChanged();
      })
      .catch((cause) => {
        if (current.current === scope) setError(message(cause));
      })
      .finally(() => {
        if (current.current === scope) setBusy(false);
      });
  };
  return (
    <>
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
        onDone={() => {}}
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
}: ComponentProps<typeof ImportDetailReview> & {
  initial: CollectionReportDetail;
  parentError?: string;
}) {
  const profile = useProfile();
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
  const resource = useResource<CollectionReportDetail>(
    `/intakes/report-queue/${encodeURIComponent(selection.groupId)}?${query}`,
  );
  useEffect(() => {
    setCursor(undefined);
    setPeopleCursor(undefined);
  }, [initial]);
  const data = resource.data || (!cursor && !peopleCursor ? initial : null);
  const refresh = () => {
    setCursor(undefined);
    setPeopleCursor(undefined);
    resource.reload();
    onChanged();
  };
  if (resource.error && (!data || !selection.recordId))
    return (
      <section role="alert">
        <p>{resource.error.message}</p>
        <button className="button secondary" type="button" onClick={refresh}>
          Refresh report
        </button>
        <button className="button secondary" type="button" onClick={onBack}>
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
    />
  );
  const sourcePanel = (
    <CollectionReportSource
      intakeId={data.group.intakeId}
      groupId={data.group.groupId}
      onChanged={refresh}
    />
  );
  if (selection.recordId && selection.proposalId !== undefined)
    return (
      <ImportRecordDetail
        embedded={embedded}
        beforeCloseRef={beforeCloseRef}
        groupId={data.group.groupId}
        block={{
          intakeId: selection.intakeId || data.group.intakeId,
          proposalId: selection.proposalId,
        }}
        recordId={selection.recordId}
        contextError={parentError || resource.error?.message}
        onRetryContext={refresh}
        identityPanel={identityPanel}
        identityRevision={data.group.intakeVersion}
        sourcePanel={sourcePanel}
        commonIdentityIssueIds={new Set()}
        sourceError=""
        onBack={onBack}
        onChanged={refresh}
        onUseSource={() => {}}
      />
    );
  return (
    <section className="import-detail">
      <button className="button secondary" type="button" onClick={onBack}>
        Back to Import
      </button>
      <h2>{label(data.group.title, 'Report with paged evidence')}</h2>
      <a href={data.group.original.contentUrl} target="_blank" rel="noreferrer">
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
      {identityPanel}
      {sourcePanel}
      <CollectionReportRecords data={data} onRefresh={refresh} />
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
        <button className="button secondary" type="button" onClick={() => setCursor(undefined)}>
          First report records
        </button>
      )}
      <CollectionPeople
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
          onClick={() => setPeopleCursor(undefined)}
        >
          First People page
        </button>
      )}
      <ImportSourceTextBrowser intakeId={data.group.intakeId} onChanged={refresh} />
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
  const [, setParams] = useSearchParams();
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
              <button
                className="button secondary"
                type="button"
                onClick={() =>
                  setParams(
                    selectionUrl(data.records.intakeId, row.groupId, row.proposalId, recordId),
                  )
                }
              >
                Review exact record
              </button>
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
}: {
  page: CollectionPeoplePage;
  groupId: string;
  preferredPersonId?: string;
  onRefresh: () => void;
  onNext: () => void;
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
  async function mutate(
    proposal: Pick<CollectionPersonProposal, 'id' | 'intakeId' | 'version' | 'intakeVersion'>,
    choice:
      | { state: 'pending' | 'later' | 'excluded' }
      | { action: 'add' }
      | { action: 'update'; noteId: string; version: number },
  ) {
    if (busy) return;
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
    setBusy(true);
    setError('');
    try {
      await api('state' in choice ? '/intakes/people-disposition' : '/intakes/people-apply', {
        method: 'POST',
        body: JSON.stringify(request),
      });
      if (active.current !== scope) return;
      requests.current.delete(key);
      onRefresh();
    } catch (cause) {
      if (active.current !== scope) return;
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500)
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
      <ReportPeopleReview
        queue={{
          groupId,
          people: page.people.flatMap((item) => (item.kind === 'person' ? [item.person] : [])),
          totalPeople: page.totalPeople,
          peopleNextCursor: page.nextCursor,
        }}
        preferredPersonId={preferredPersonId}
        busy={busy}
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
            busy={busy}
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
