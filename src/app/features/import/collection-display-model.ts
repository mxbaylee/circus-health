import { useEffect, useMemo, useState } from 'react';
import type {
  CollectionFeedRecord,
  CollectionImportFeed,
  CollectionPersonProposal,
  CollectionReportDetail,
  CollectionReportGroupSummary,
} from '../../../shared/intake-clinical-pages';
import type { IntakeIdentityReview } from '../../../shared/intake-identity';
import type {
  ImportReviewKind,
  ImportReviewModel,
  ImportReviewRecord,
  ImportReviewReport,
  ImportReviewStatus,
} from './ImportReviewPresentation';
import { api, apiUrl } from '../../data/api';
import { useProfile } from '../../data/profile';
import { initialDraft } from '../intake/useReviewDrafts';
import { hasUnreviewedPairChoices } from '../../../shared/clinical-review';
import { recordLabel, recordValue, recordSaveBlockReason } from './import-feed-presentation';
import { possibleSavedOverlapCount } from './possible-overlaps';

export const collectionKind: Record<CollectionFeedRecord['feedKind'] | 'person', ImportReviewKind> =
  {
    test: 'Test results',
    prescription: 'Prescriptions',
    vision: 'Vision',
    procedure: 'Procedures',
    history: 'Documents',
    unsupported: 'Documents',
    person: 'People',
  };
export const collectionStatus = (state: string): ImportReviewStatus =>
  state === 'accepted' || state === 'saved'
    ? 'saved'
    : state === 'deferred' || state === 'later'
      ? 'later'
      : state === 'kept_original' || state === 'excluded' || state === 'superseded'
        ? 'excluded'
        : 'review';
export const groupKey = (intakeId: string, groupId: string) => JSON.stringify([intakeId, groupId]);
export const collectionDetailUrl = (row: CollectionFeedRecord) =>
  `/import?${new URLSearchParams({ intake: row.intakeId, group: row.groupId, proposal: row.proposalId || 'original', record: row.detail.kind === 'record' ? row.detail.record.id : row.detail.selection.recordId, review: 'full' })}`;

/** This is a presentation row for a displayed record, never a reconstructed legacy intake. */
export function collectionDisplayRecord(
  row: CollectionFeedRecord,
  group?: CollectionReportGroupSummary,
): ImportReviewRecord | null {
  if (row.detail.kind !== 'record') return null;
  const record = row.detail.record;
  const draft = initialDraft(record).decision;
  const mapping = draft.mapping;
  const literal = recordValue(record);
  return {
    id: row.feedKey,
    reportId: row.groupId,
    kind: collectionKind[row.feedKind],
    label: recordLabel(record),
    originalLabel: record.mapping.label || record.title,
    value: literal.value,
    unit: literal.unit,
    date: mapping.date || mapping.startDate || mapping.documentDate || record.date || undefined,
    status: collectionStatus(record.queueState),
    eligible: record.selectable,
    saveBlockReason: recordSaveBlockReason(record),
    saveBlockReview:
      !hasUnreviewedPairChoices(record) &&
      (record.identityReview?.blocking ||
        record.issues?.find((issue) => issue.blocking && issue.status !== 'resolved')?.kind ===
          'identity')
        ? 'identity'
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
    originalUrl: group ? apiUrl(group.original.contentUrl) : undefined,
    originalUnavailable: !group,
    detailUrl: collectionDetailUrl(row),
    approval:
      record.candidateId && record.candidateVersionId
        ? {
            intakeId: row.intakeId,
            proposalId: row.proposalId,
            intakeVersion: row.intakeVersion,
            reviewToken: row.reviewToken,
            selections: [
              {
                recordId: record.id,
                candidateId: record.candidateId,
                candidateVersionId: record.candidateVersionId,
                selectionReviewToken: record.selectionReviewToken,
                mapping,
                comparisons: draft.comparisons,
              },
            ],
          }
        : undefined,
    draftRepair:
      record.classification !== 'unsupported' &&
      ['pending', 'deferred'].includes(record.queueState) &&
      record.candidateVersionId &&
      ['observation', 'procedure'].includes(mapping.kind || '')
        ? {
            intakeId: row.intakeId,
            proposalId: row.proposalId,
            recordId: record.id,
            candidateVersionId: record.candidateVersionId,
            fields: {
              date: mapping.date || '',
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
}

export function collectionDisplayPerson(person: CollectionPersonProposal): ImportReviewRecord {
  return {
    id: `person:${person.id}`,
    reportId: person.groupId,
    kind: 'People',
    label: person.person.fullName,
    originalLabel: person.title,
    value: person.person.relationship || person.person.tags.join(' · ') || 'Named person',
    status: collectionStatus(person.state),
    eligible:
      ['pending', 'later'].includes(person.state) &&
      !person.selfMatch &&
      !person.matches.length &&
      !person.matchesTruncated,
    saveBlockReason: person.selfMatch
      ? 'This person may be Self. Review the person before adding them.'
      : person.matches.length || person.matchesTruncated
        ? 'Review the possible person matches before adding this person.'
        : undefined,
    originalUrl: apiUrl(person.source.contentUrl),
    detailUrl: `/import?${new URLSearchParams({ group: person.groupId, intake: person.intakeId, person: person.id })}`,
    savedPersonDestination: person.saved
      ? { ...person.saved, proposalId: person.id, title: person.person.fullName }
      : undefined,
  };
}

/** Report headers are loaded only for this displayed window, with no cross-page accumulation. */
export function useCollectionDisplayModel({
  data,
  people,
  peopleGroup,
  identities,
  filters,
  loading,
  confirmedSavedIds,
  selectionWindowKey,
}: {
  data: CollectionImportFeed | null;
  people: CollectionPersonProposal[];
  peopleGroup?: { intakeId: string; groupId: string };
  identities: Map<string, IntakeIdentityReview>;
  filters: NonNullable<ImportReviewModel['filters']>;
  loading: boolean;
  confirmedSavedIds: string[];
  selectionWindowKey: string;
}) {
  const profile = useProfile();
  const [revision, setRevision] = useState(0);
  const requests = new Map<
    string,
    { intakeId: string; groupId: string; version: number | string }
  >();
  for (const row of data?.records || [])
    requests.set(groupKey(row.intakeId, row.groupId), {
      intakeId: row.intakeId,
      groupId: row.groupId,
      version: row.intakeVersion,
    });
  if (peopleGroup)
    requests.set(groupKey(peopleGroup.intakeId, peopleGroup.groupId), {
      ...peopleGroup,
      version:
        people[0]?.intakeVersion ??
        data?.people.groups.find(
          (group) =>
            group.intakeId === peopleGroup.intakeId && group.groupId === peopleGroup.groupId,
        )?.binding ??
        '',
    });
  const requestKey = JSON.stringify([profile?.id, [...requests.entries()]]);
  const [headers, setHeaders] = useState<{
    key: string;
    values: Map<string, CollectionReportGroupSummary>;
    errors: Map<string, string>;
  }>();
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const values = new Map<string, CollectionReportGroupSummary>();
    const errors = new Map<string, string>();
    setHeaders({ key: requestKey, values, errors });
    void Promise.all(
      [...requests].map(async ([key, scope]) => {
        try {
          const query = new URLSearchParams({
            intakeId: scope.intakeId,
            view: 'all',
            limit: '1',
            bytes: '8192',
          });
          const result = (
            await api<CollectionReportDetail>(
              `/intakes/report-queue/${encodeURIComponent(scope.groupId)}?${query}`,
              { signal: controller.signal },
            )
          ).data;
          if (
            result.format !== 'health-intake-report-detail-v2' ||
            result.group.intakeId !== scope.intakeId ||
            result.group.groupId !== scope.groupId
          )
            throw new Error('Report details did not match this displayed report.');
          values.set(key, result.group);
        } catch (cause) {
          errors.set(
            key,
            cause instanceof Error ? cause.message : 'Report details could not load.',
          );
        }
        if (active)
          setHeaders({ key: requestKey, values: new Map(values), errors: new Map(errors) });
      }),
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [requestKey, revision]);
  const current = headers?.key === requestKey ? headers : undefined;
  const model = useMemo<ImportReviewModel>(() => {
    const reports: ImportReviewReport[] = [...requests].map(([key, scope]) => {
      const header = current?.values.get(key);
      const identity = identities.get(key);
      const visibleIdentity = data?.records.find(
        (row) =>
          row.intakeId === scope.intakeId &&
          row.groupId === scope.groupId &&
          row.detail.kind === 'record' &&
          row.detail.record.identityReview,
      )?.detail;
      const recordIdentity =
        visibleIdentity?.kind === 'record' ? visibleIdentity.record.identityReview : undefined;
      const identityStatus = identity?.status || recordIdentity?.status;
      const coverage = header?.sourceCoverage.current;
      const original = header?.original.contentUrl;
      return {
        id: scope.groupId,
        sourceIntakeId: scope.intakeId,
        ownershipSelection: header?.groupVersionId
          ? {
              type: 'report',
              intakeId: scope.intakeId,
              groupId: scope.groupId,
              groupVersionId: header.groupVersionId,
            }
          : undefined,
        filename:
          typeof header?.original.filename === 'string' ? header.original.filename : undefined,
        source:
          typeof header?.source === 'string' && header.source
            ? header.source
            : header?.source && typeof header.source === 'object'
              ? 'Source with paged evidence'
              : 'Source not labeled',
        sourceLabelAvailable: true,
        sourceNeedsLabel: !header?.source,
        sourceConfirmed: !!coverage && coverage.total > 0 && coverage.uncovered === 0,
        sourceEvidence: original
          ? { label: 'Open original evidence', contentUrl: apiUrl(original) }
          : undefined,
        reportType:
          typeof header?.title === 'string'
            ? header.title
            : header
              ? 'Report with paged evidence'
              : current?.errors.has(key)
                ? 'Report details unavailable'
                : 'Opening report details…',
        date: header?.date || 'Date not given',
        subject: {
          label:
            identity?.assignedPerson?.fullName ||
            identity?.evidencedIdentity.fullName ||
            'Review person',
          evidence: identity?.evidencedIdentity.fullName ? 'named' : 'missing',
          confirmed:
            identityStatus === 'evidenced_match' || identityStatus === 'prior_confirmation',
          identityStatus,
          identityMessage:
            identity?.message ||
            recordIdentity?.message ||
            'Open the retained report identity evidence.',
          blocking: identity?.blocking ?? recordIdentity?.blocking,
          scopeReady: !!identity?.scopeReference || !!identity?.scope,
          reviewUrl: `/import?${new URLSearchParams({ intake: scope.intakeId, group: scope.groupId })}`,
          hidden: !data?.records.some(
            (row) => row.intakeId === scope.intakeId && row.groupId === scope.groupId,
          ),
        },
      };
    });
    const records = (data?.records || []).flatMap((row) => {
      const display = collectionDisplayRecord(
        row,
        current?.values.get(groupKey(row.intakeId, row.groupId)),
      );
      return display ? [display] : [];
    });
    records.push(...people.map(collectionDisplayPerson));
    const peopleCounts = data?.people.counts;
    const kindCounts: ImportReviewModel['kindCounts'] = { All: data?.totalRecords || 0 };
    for (const [key, count] of Object.entries(data?.kindCounts || {})) {
      const displayKind = collectionKind[key as keyof typeof collectionKind];
      if (displayKind) kindCounts[displayKind] = (kindCounts[displayKind] || 0) + count;
    }
    return {
      contextKey: profile?.id,
      selectionWindowKey,
      reports,
      records,
      loading,
      filters,
      searchAppliedByModel: true,
      confirmedSavedIds,
      counts: data
        ? {
            review: data.counts.pending + (peopleCounts?.pending || 0),
            later: data.counts.deferred + (peopleCounts?.later || 0),
            excluded: data.counts.keptOriginal + (peopleCounts?.excluded || 0),
            saved: data.counts.accepted + (peopleCounts?.saved || 0),
          }
        : undefined,
      kindCounts,
    };
  }, [
    data,
    people,
    peopleGroup,
    current,
    identities,
    filters,
    loading,
    confirmedSavedIds,
    selectionWindowKey,
    profile?.id,
  ]);
  return {
    model,
    headerErrors: current?.errors,
    reloadHeaders: () => setRevision((value) => value + 1),
  };
}
