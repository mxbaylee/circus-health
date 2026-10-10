import { selectedReportGroups } from './intake-selected-report-groups.ts';
import { createHash } from 'node:crypto';
import { canonicalLiteral } from './intake-format.ts';
import type {
  IntakeReportGroup,
  IntakeReportGroupVersion,
  IntakeReportSourceConfirmation,
  IntakeReportSourceCoverageEntry,
  IntakeReportSourceExtension,
  IntakeReportSourceScope,
  IntakeReportQueueView,
  IntakeReportSourceCoverageCounts,
  IntakeWorkflow,
} from '../shared/intake.ts';

const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');
const memberKey = (member: { candidateId: string; candidateVersionId: string }): string =>
  canonicalLiteral([member.candidateId, member.candidateVersionId]);
const occurrenceKey = (occurrence: IntakeReportSourceCoverageEntry['occurrence']): string =>
  canonicalLiteral([
    occurrence.proposalId,
    occurrence.recordId,
    occurrence.batchId,
    occurrence.locator,
  ]);

export type IntakeReportSourceGroupHeader = Omit<IntakeReportGroup, 'versions'>;
export type IntakeReportSourceVersionHeader = Omit<IntakeReportGroupVersion, 'members'>;

function reportFingerprint(group: IntakeReportSourceGroupHeader): string {
  return hash([
    group.id,
    group.sourceFileId,
    group.sourceHash,
    group.sourceSystem,
    group.memberId,
    group.report?.anchor || null,
    group.report?.subject || null,
  ]);
}

export function intakeReportSourceReference(
  group: IntakeReportSourceGroupHeader,
  version: IntakeReportSourceVersionHeader,
): IntakeReportSourceCoverageEntry['sourceRef'] {
  const contextId = version.context?.contextId || version.id;
  const extensionScope = intakeReportSourceScope(group, version, 'manual_report_label');
  return {
    groupId: group.id,
    groupVersionId: version.id,
    contributionId: version.contributionId,
    contextId,
    fingerprint: hash([
      reportFingerprint(group),
      version.id,
      version.contributionId,
      version.contextState || 'none',
      version.context || null,
    ]),
    ...(extensionScope ? { extensionScope } : {}),
  };
}

function exactOccurrence(
  left: IntakeReportSourceCoverageEntry['occurrence'],
  right: IntakeReportSourceCoverageEntry['occurrence'],
): boolean {
  return occurrenceKey(left) === occurrenceKey(right);
}
type OccurrenceLookup = Pick<
  IntakeReportSourceCoverageEntry['occurrence'],
  'proposalId' | 'recordId'
> &
  Partial<Pick<IntakeReportSourceCoverageEntry['occurrence'], 'batchId' | 'locator'>>;
function matchesOccurrence(
  candidate: IntakeReportSourceCoverageEntry['occurrence'],
  requested: OccurrenceLookup,
): boolean {
  return (
    candidate.proposalId === requested.proposalId &&
    candidate.recordId === requested.recordId &&
    (requested.batchId === undefined || candidate.batchId === requested.batchId) &&
    (requested.locator === undefined || candidate.locator === requested.locator)
  );
}

export interface IntakeReportSourceReviewScope {
  group: IntakeReportGroup;
  current: IntakeReportGroupVersion;
  view: IntakeReportQueueView;
  scopeToken: string;
  entries: IntakeReportSourceCoverageEntry[];
  sourceEvidence: string[];
}

export function intakeReportSourceCoverageCounts(
  sources: (string | null)[],
): IntakeReportSourceCoverageCounts {
  const bySource = new Map<string, number>();
  for (const source of sources) if (source) bySource.set(source, (bySource.get(source) || 0) + 1);
  const total = sources.length;
  const covered = [...bySource.values()].reduce((sum, count) => sum + count, 0);
  return {
    total,
    covered,
    uncovered: total - covered,
    status:
      total === 0
        ? 'empty'
        : covered === 0
          ? 'uncovered'
          : covered < total
            ? 'partial'
            : bySource.size === 1
              ? 'single'
              : 'mixed',
    bySource: [...bySource.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((left, right) => left.source.localeCompare(right.source)),
  };
}

/** Build the one complete, non-paginated source authority boundary shown to the user. */
export function intakeReportSourceReviewScope(
  workflow: IntakeWorkflow,
  profileId: string,
  intakeId: string,
  groupId: string,
  view: IntakeReportQueueView,
): IntakeReportSourceReviewScope | null {
  const group = workflow.reportGroups?.find((candidate) => candidate.id === groupId);
  const current = group?.versions.at(-1);
  if (!group || !current || group.basis !== 'report_anchor' || !group.report?.anchor) return null;
  const owners = new Map<string, string>();
  for (const candidateGroup of [
    ...(workflow.reportGroups || []).filter(
      (candidate) => candidate.basis === 'candidate_fallback',
    ),
    ...(workflow.reportGroups || []).filter((candidate) => candidate.basis === 'report_anchor'),
  ])
    for (const version of candidateGroup.versions)
      for (const member of version.members) owners.set(memberKey(member), candidateGroup.id);
  const candidates = new Map(workflow.candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const entries: IntakeReportSourceCoverageEntry[] = [];
  for (const member of current.members) {
    const key = memberKey(member);
    if (owners.get(key) !== group.id) continue;
    const candidate = candidates.get(member.candidateId);
    const version = candidate?.versions.find((item) => item.id === member.candidateVersionId);
    if (!candidate || !version || version.sourceContext || version.peopleOnly) continue;
    const accepted =
      version.status === 'accepted' ||
      workflow.decisions.some(
        (decision) =>
          decision.action === 'accept' &&
          decision.candidateId === candidate.id &&
          decision.candidateVersionId === version.id,
      );
    if (accepted || version.status === 'kept_original' || version.status === 'superseded') continue;
    if (candidate.versions.at(-1)?.id !== version.id) continue;
    for (const occurrence of version.occurrences) {
      const draft = workflow.reviewDrafts?.findLast(
        (item) =>
          item.candidateId === candidate.id &&
          item.candidateVersionId === version.id &&
          item.proposalId === occurrence.proposalId &&
          item.recordId === occurrence.recordId,
      );
      const state = draft?.disposition === 'review_later' ? 'deferred' : 'active';
      if (view !== 'all' && view !== state) continue;
      const exactKey = canonicalLiteral([key, occurrenceKey(occurrence)]);
      if (seen.has(exactKey)) continue;
      seen.add(exactKey);
      const introduced = group.versions.find((snapshot) =>
        snapshot.members.some(
          (candidateMember) =>
            memberKey(candidateMember) === key &&
            candidateMember.occurrences.some((candidateOccurrence) =>
              exactOccurrence(candidateOccurrence, occurrence),
            ),
        ),
      );
      if (!introduced) continue;
      const sourceRef = intakeReportSourceReference(group, introduced);
      const identity = [candidate.id, version.id, occurrence, sourceRef];
      entries.push({
        id: 'report-source-coverage:' + hash(identity),
        candidateId: candidate.id,
        candidateVersionId: version.id,
        occurrence: { ...occurrence },
        sourceRef,
      });
    }
  }
  entries.sort((left, right) => canonicalLiteral(left).localeCompare(canonicalLiteral(right)));
  const sourceEvidence = [
    ...new Set(
      entries.flatMap((entry) => {
        const version = group.versions.find(
          (candidate) => candidate.id === entry.sourceRef.groupVersionId,
        );
        const value = version?.context?.sourceSuggestion?.value.trim();
        return value ? [value] : [];
      }),
    ),
  ].sort();
  const scopeToken = hash([
    'report-source-review-v1',
    profileId,
    intakeId,
    view,
    {
      id: group.id,
      basis: group.basis,
      sourceFileId: group.sourceFileId,
      sourceHash: group.sourceHash,
      sourceSystem: group.sourceSystem,
      memberId: group.memberId,
      report: group.report,
    },
    current,
    entries,
    sourceEvidence,
  ]);
  return { group, current, view, scopeToken, entries, sourceEvidence };
}

/** A durable boundary for later members; presentation labels and sections are excluded. */
export function intakeReportSourceScope(
  group: IntakeReportSourceGroupHeader,
  version: IntakeReportSourceVersionHeader,
  basis: IntakeReportSourceConfirmation['basis'],
): IntakeReportSourceScope | null {
  if (
    group.basis !== 'report_anchor' ||
    !group.sourceFileId ||
    !group.sourceHash ||
    !group.report?.anchor ||
    version.contextState === 'mixed'
  )
    return null;
  const contextFingerprint =
    basis === 'manual_report_label'
      ? version.context
        ? hash(version.context)
        : null
      : version.context?.status === 'linked' && version.context.sourceSuggestion
        ? hash(version.context)
        : null;
  if (basis !== 'manual_report_label' && !contextFingerprint) return null;
  return {
    kind: 'anchored_report',
    reportFingerprint: reportFingerprint(group),
    contextFingerprint,
  };
}

function exactScope(
  left: IntakeReportSourceScope | undefined,
  right: IntakeReportSourceScope | null,
) {
  return !!left && !!right && canonicalLiteral(left) === canonicalLiteral(right);
}

export function extendIntakeReportSourceConfirmations(
  workflow: IntakeWorkflow,
  group: IntakeReportGroup,
  version: IntakeReportGroupVersion,
  contributedMembers: { candidateId: string; candidateVersionId: string }[],
): void {
  for (const confirmation of workflow.reportSourceConfirmations || []) {
    const explicitAuthorities =
      confirmation.basis === 'explicit_current_members'
        ? (confirmation.coverageEntries || []).filter((entry) =>
            exactScope(
              entry.sourceRef.extensionScope,
              intakeReportSourceScope(group, version, 'manual_report_label'),
            ),
          )
        : [];
    if (
      confirmation.groupId !== group.id ||
      (confirmation.basis === 'explicit_current_members'
        ? !explicitAuthorities.length
        : !exactScope(
            confirmation.scope,
            intakeReportSourceScope(group, version, confirmation.basis),
          )) ||
      confirmation.groupVersionId === version.id ||
      confirmation.extensions?.some((extension) => extension.groupVersionId === version.id)
    )
      continue;
    const covered = new Set([
      ...confirmation.members.map(memberKey),
      ...(confirmation.extensions || []).flatMap((extension) => extension.members.map(memberKey)),
    ]);
    const coveredOccurrences = new Set([
      ...(confirmation.coverageEntries || []).map((entry) =>
        canonicalLiteral([memberKey(entry), occurrenceKey(entry.occurrence)]),
      ),
      ...(confirmation.extensions || []).flatMap((extension) =>
        (extension.coverageEntries || []).map((entry) =>
          canonicalLiteral([memberKey(entry), occurrenceKey(entry.occurrence)]),
        ),
      ),
    ]);
    const contributed = new Set(contributedMembers.map(memberKey));
    const versionIndex = group.versions.findIndex((candidate) => candidate.id === version.id);
    const priorOccurrences = new Set(
      (versionIndex < 0 ? group.versions : group.versions.slice(0, versionIndex)).flatMap(
        (candidate) =>
          candidate.members.flatMap((member) =>
            member.occurrences.map((occurrence) =>
              canonicalLiteral([memberKey(member), occurrenceKey(occurrence)]),
            ),
          ),
      ),
    );
    const members = version.members
      .filter((member) => {
        if (covered.has(memberKey(member))) return true;
        if (!contributed.has(memberKey(member))) return false;
        const candidate = workflow.candidates.find((item) => item.id === member.candidateId);
        const current = candidate?.versions.at(-1);
        return (
          current?.id === member.candidateVersionId &&
          current.status === 'pending' &&
          !workflow.decisions.some(
            (decision) =>
              decision.action === 'accept' &&
              decision.candidateId === member.candidateId &&
              decision.candidateVersionId === member.candidateVersionId,
          )
        );
      })
      .map(({ candidateId, candidateVersionId }) => ({ candidateId, candidateVersionId }));
    const contextId =
      confirmation.basis === 'manual_report_label'
        ? version.id
        : version.context?.contextId || version.id;
    const authorityEntryId = explicitAuthorities.map((entry) => entry.id).sort()[0];
    const coverageEntries =
      confirmation.basis === 'explicit_current_members' && authorityEntryId
        ? version.members
            .filter((member) => contributed.has(memberKey(member)))
            .flatMap((member) =>
              member.occurrences.flatMap((occurrence) => {
                const identity = canonicalLiteral([memberKey(member), occurrenceKey(occurrence)]);
                // A compatible contribution may inherit only occurrences it actually introduced.
                // Older active/deferred occurrences excluded from the explicit click stay uncovered.
                if (coveredOccurrences.has(identity) || priorOccurrences.has(identity)) return [];
                const sourceRef = intakeReportSourceReference(group, version);
                return [
                  {
                    id:
                      'report-source-coverage:' +
                      hash([
                        confirmation.operationId,
                        authorityEntryId,
                        member,
                        occurrence,
                        sourceRef,
                      ]),
                    candidateId: member.candidateId,
                    candidateVersionId: member.candidateVersionId,
                    occurrence: { ...occurrence },
                    sourceRef,
                  },
                ];
              }),
            )
        : [];
    const extension: IntakeReportSourceExtension = {
      id:
        'report-source-extension:' +
        hash([confirmation.operationId, version.id, contextId, members]),
      groupVersionId: version.id,
      contextId,
      members,
      ...(coverageEntries.length ? { coverageEntries, authorityEntryId } : {}),
      at: version.createdAt,
    };
    (confirmation.extensions ||= []).push(extension);
  }
}

/** Cover retained first-occurrence versions when confirmation follows a compatible retry. */
export function priorIntakeReportSourceExtensions(
  group: IntakeReportGroup,
  current: IntakeReportGroupVersion,
  basis: IntakeReportSourceConfirmation['basis'],
  operationId: string,
  members: { candidateId: string; candidateVersionId: string }[],
  at: string,
): IntakeReportSourceExtension[] {
  const currentScope = intakeReportSourceScope(group, current, basis);
  if (!currentScope) return [];
  const covered = new Set(members.map(memberKey));
  const currentIndex = group.versions.findIndex((version) => version.id === current.id);
  if (currentIndex < 0) return [];
  return group.versions.slice(0, currentIndex).flatMap((version) => {
    if (!exactScope(currentScope, intakeReportSourceScope(group, version, basis))) return [];
    const versionMembers = version.members
      .filter((member) => covered.has(memberKey(member)))
      .map(({ candidateId, candidateVersionId }) => ({ candidateId, candidateVersionId }));
    if (!versionMembers.length) return [];
    const contextId =
      basis === 'manual_report_label' ? version.id : version.context?.contextId || version.id;
    return [
      {
        id: 'report-source-extension:' + hash([operationId, version.id, contextId, versionMembers]),
        groupVersionId: version.id,
        contextId,
        members: versionMembers,
        at,
      },
    ];
  });
}

export interface ResolvedIntakeReportSource {
  confirmation: IntakeReportSourceConfirmation;
  coverage: Pick<IntakeReportSourceConfirmation, 'groupVersionId' | 'contextId' | 'members'> & {
    extensionId?: string;
    coverageEntryId?: string;
  };
}

export function intakeReportSourceForVersion(
  confirmations: IntakeReportSourceConfirmation[] | undefined,
  groupId: string,
  groupVersionId: string,
): ResolvedIntakeReportSource | null {
  for (const confirmation of (confirmations || []).toReversed()) {
    if (confirmation.groupId !== groupId) continue;
    if (confirmation.groupVersionId === groupVersionId)
      return {
        confirmation,
        coverage: {
          groupVersionId: confirmation.groupVersionId,
          contextId: confirmation.contextId,
          members: confirmation.members,
        },
      };
    const extension = confirmation.extensions?.findLast(
      (candidate) => candidate.groupVersionId === groupVersionId,
    );
    if (extension)
      return {
        confirmation,
        coverage: {
          groupVersionId: extension.groupVersionId,
          contextId: extension.contextId,
          members: extension.members,
          extensionId: extension.id,
        },
      };
  }
  return null;
}

/** Resolve an exact member and the immutable group version that introduced this occurrence. */
export function intakeReportSourceForMember(
  confirmations: IntakeReportSourceConfirmation[] | undefined,
  references: import('../shared/intake-report-group-links.ts').IntakeReviewGroupLinks | undefined,
  member: { candidateId?: string; candidateVersionId?: string },
  occurrence?: OccurrenceLookup,
): ResolvedIntakeReportSource | null {
  if (!member.candidateId || !member.candidateVersionId) return null;
  const scopes = {
    has(key: string) {
      return selectedReportGroups(references).some(
        (reference) => canonicalLiteral([reference.groupId, reference.groupVersionId]) === key,
      );
    },
  };
  const key = memberKey({
    candidateId: member.candidateId,
    candidateVersionId: member.candidateVersionId,
  });
  for (const confirmation of (confirmations || []).toReversed()) {
    if (confirmation.basis === 'explicit_current_members' && occurrence) {
      const entry = confirmation.coverageEntries?.find(
        (candidate) =>
          candidate.candidateId === member.candidateId &&
          candidate.candidateVersionId === member.candidateVersionId &&
          scopes.has(
            canonicalLiteral([candidate.sourceRef.groupId, candidate.sourceRef.groupVersionId]),
          ) &&
          matchesOccurrence(candidate.occurrence, occurrence),
      );
      if (entry)
        return {
          confirmation,
          coverage: {
            groupVersionId: entry.sourceRef.groupVersionId,
            contextId: entry.sourceRef.contextId,
            members: [
              {
                candidateId: entry.candidateId,
                candidateVersionId: entry.candidateVersionId,
              },
            ],
            coverageEntryId: entry.id,
          },
        };
      const explicitExtension = confirmation.extensions?.findLast((candidate) => {
        const covered = candidate.coverageEntries?.find(
          (candidateEntry) =>
            candidateEntry.candidateId === member.candidateId &&
            candidateEntry.candidateVersionId === member.candidateVersionId &&
            scopes.has(
              canonicalLiteral([
                candidateEntry.sourceRef.groupId,
                candidateEntry.sourceRef.groupVersionId,
              ]),
            ) &&
            matchesOccurrence(candidateEntry.occurrence, occurrence),
        );
        return !!covered;
      });
      const extensionEntry = explicitExtension?.coverageEntries?.find(
        (candidate) =>
          candidate.candidateId === member.candidateId &&
          candidate.candidateVersionId === member.candidateVersionId &&
          scopes.has(
            canonicalLiteral([candidate.sourceRef.groupId, candidate.sourceRef.groupVersionId]),
          ) &&
          matchesOccurrence(candidate.occurrence, occurrence),
      );
      if (explicitExtension && extensionEntry)
        return {
          confirmation,
          coverage: {
            groupVersionId: extensionEntry.sourceRef.groupVersionId,
            contextId: extensionEntry.sourceRef.contextId,
            members: explicitExtension.members,
            extensionId: explicitExtension.id,
            coverageEntryId: extensionEntry.id,
          },
        };
      continue;
    }
    if (
      scopes.has(canonicalLiteral([confirmation.groupId, confirmation.groupVersionId])) &&
      confirmation.members.some((candidate) => memberKey(candidate) === key)
    )
      return {
        confirmation,
        coverage: {
          groupVersionId: confirmation.groupVersionId,
          contextId: confirmation.contextId,
          members: confirmation.members,
        },
      };
    const extension = confirmation.extensions?.findLast(
      (candidate) =>
        scopes.has(canonicalLiteral([confirmation.groupId, candidate.groupVersionId])) &&
        candidate.members.some((covered) => memberKey(covered) === key),
    );
    if (extension)
      return {
        confirmation,
        coverage: {
          groupVersionId: extension.groupVersionId,
          contextId: extension.contextId,
          members: extension.members,
          extensionId: extension.id,
        },
      };
  }
  return null;
}
