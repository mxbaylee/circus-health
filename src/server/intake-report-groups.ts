import { createHash } from 'node:crypto';
import { canonicalLiteral } from './intake-format.ts';
import { clinicalMappingEnvelope } from './clinical-import.ts';
import { resolveReportContexts, type ResolvedReportContext } from './intake-report-context.ts';
import { extendIntakeReportSourceConfirmations } from './intake-report-source.ts';
import type { IntakeEntry } from './intake-format.ts';
import type {
  HealthRecordEnvelope,
  IntakeReportGroup,
  IntakeReportGroupMember,
  IntakeReportReference,
  IntakeWorkflow,
} from '../shared/intake.ts';

const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');
interface GroupFile {
  id: string;
  sha256: string;
  mime_type?: string;
}
export interface ReportGroupContribution {
  value: HealthRecordEnvelope;
  candidateId: string;
  candidateVersionId: string;
  occurrence: IntakeReportGroupMember['occurrences'][number];
  entryLine: number;
}

/** A report quote is an extraction claim. Package occurrence IDs are host checked. */
function supportedReference(
  file: GroupFile,
  workflow: IntakeWorkflow,
  report: IntakeReportReference | undefined,
): IntakeReportReference | null {
  if (!report) return null;
  const inventories = workflow.plans.flatMap((plan) => plan.index.members || []);
  const packageSource = file.mime_type === 'application/zip' || inventories.length > 0;
  if (packageSource && !report.memberId) return null;
  if (report.memberId && !inventories.some((member) => member.memberId === report.memberId))
    return null;
  return report;
}

export function recordReportGroups(
  file: GroupFile,
  workflow: IntakeWorkflow,
  contributions: ReportGroupContribution[],
  entries: IntakeEntry[],
): void {
  const groups = (workflow.reportGroups ||= []);
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const grouped = new Map<
    string,
    {
      report: IntakeReportReference | null;
      items: ReportGroupContribution[];
      context: ResolvedReportContext | null;
      contextState: 'none' | 'uniform' | 'mixed';
    }
  >();
  const contexts = resolveReportContexts(file, workflow, entries);
  for (const contribution of contributions) {
    const linked = contexts.get(contribution.entryLine);
    const report = supportedReference(
      file,
      workflow,
      contribution.value.report || linked?.report || undefined,
    );
    // Scope is evidence, not a model's arbitrary key or the shared outer delivery.
    const scope = report
      ? [
          file.id,
          file.sha256,
          contribution.value.provenance.sourceSystem,
          report.memberId || null,
          report.anchor,
          report.subject,
          // Contradictory proposed subject roles must not share a presentation group.
          clinicalSubject(contribution.value),
        ]
      : ['candidate', contribution.candidateId];
    const id = 'report-group:' + hash(scope);
    const existing = grouped.get(id);
    if (existing) {
      existing.items.push(contribution);
      if (canonicalLiteral(existing.context) !== canonicalLiteral(linked || null)) {
        existing.context = null;
        existing.contextState = 'mixed';
      }
    } else
      grouped.set(id, {
        report,
        items: [contribution],
        context: linked || null,
        contextState: linked ? 'uniform' : 'none',
      });
  }
  for (const [id, { report, items, context, contextState }] of grouped) {
    let group = groupsById.get(id);
    if (!group) {
      group = {
        id,
        basis: report ? 'report_anchor' : 'candidate_fallback',
        sourceFileId: file.id,
        sourceHash: file.sha256,
        sourceSystem: items[0]!.value.provenance.sourceSystem,
        memberId: report?.memberId || null,
        report: report ? structuredClone(report) : null,
        versions: [],
      };
      groups.push(group);
      groupsById.set(id, group);
    }
    const contributed = items
      .map((item) => ({
        candidateId: item.candidateId,
        candidateVersionId: item.candidateVersionId,
        occurrence: item.occurrence,
        section: report ? item.value.report?.section || null : null,
      }))
      .sort((a, b) => {
        const left = canonicalLiteral(a),
          right = canonicalLiteral(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
    const title = report?.title || items[0]!.value.id;
    const retainedContext = context?.context || null;
    const contributionId = 'report-contribution:' + hash([id, title, contributed, retainedContext]);
    // Reaccepting/retrying a retained proposal does not make its old versions current again.
    if (group.versions.some((version) => version.contributionId === contributionId)) continue;
    const members = structuredClone(group.versions.at(-1)?.members || []);
    for (const item of items) {
      const oldIndex = members.findIndex(
        (member) =>
          member.candidateId === item.candidateId &&
          member.candidateVersionId === item.candidateVersionId,
      );
      let member = oldIndex < 0 ? undefined : members[oldIndex];
      if (!member) {
        member = {
          candidateId: item.candidateId,
          candidateVersionId: item.candidateVersionId,
          occurrences: [],
          ...(report && item.value.report?.section
            ? { section: structuredClone(item.value.report.section) }
            : {}),
        };
        if (oldIndex < 0) members.push(member);
        else members[oldIndex] = member;
      }
      if (
        !member.occurrences.some(
          (occurrence) => canonicalLiteral(occurrence) === canonicalLiteral(item.occurrence),
        )
      )
        member.occurrences.push({ ...item.occurrence });
    }
    // Keep member discovery order, with a version ID derived only from durable inputs.
    const version: IntakeReportGroup['versions'][number] = {
      id: 'report-group-version:' + hash([id, contributionId, members]),
      contributionId,
      context: retainedContext ? structuredClone(retainedContext) : null,
      contextState,
      title,
      createdAt: items.reduce((latest, item) => {
        const at =
          workflow.candidates
            .find((candidate) => candidate.id === item.candidateId)
            ?.versions.find((version) => version.id === item.candidateVersionId)?.createdAt || '';
        return at > latest ? at : latest;
      }, ''),
      members,
    };
    group.versions.push(version);
    extendIntakeReportSourceConfirmations(
      workflow,
      group,
      version,
      items.map(({ candidateId, candidateVersionId }) => ({
        candidateId,
        candidateVersionId,
      })),
    );
  }
}

function clinicalSubject(value: HealthRecordEnvelope): string | null {
  const clinical = clinicalMappingEnvelope(value);
  const subject = clinical.subject === undefined ? value.subject : clinical.subject;
  return typeof subject === 'string' ? subject : null;
}

/** Read-only compatibility projection. Never groups legacy rows by a file/date/label. */
export function reportGroupsWithLegacyFallback(workflow: IntakeWorkflow): IntakeReportGroup[] {
  const groups = [...(workflow.reportGroups || [])];
  const covered = new Set(
    groups.flatMap((group) =>
      group.versions.flatMap((version) =>
        version.members.map((member) =>
          canonicalLiteral([member.candidateId, member.candidateVersionId]),
        ),
      ),
    ),
  );
  for (const candidate of workflow.candidates) {
    const versions = candidate.versions.filter(
      (version) =>
        !version.sourceContext && !covered.has(canonicalLiteral([candidate.id, version.id])),
    );
    if (!versions.length) continue;
    const id = 'report-group:' + hash(['candidate', candidate.id]);
    const fallback: IntakeReportGroup = {
      id,
      basis: 'candidate_fallback',
      sourceFileId: null,
      sourceHash: null,
      sourceSystem: candidate.sourceSystem,
      memberId: null,
      report: null,
      versions: versions.map((version) => ({
        id: 'report-group-version:' + hash([id, version.id, version.occurrences]),
        contributionId: 'legacy:' + version.id,
        createdAt: version.createdAt,
        title: candidate.envelopeId,
        members: [
          {
            candidateId: candidate.id,
            candidateVersionId: version.id,
            occurrences: structuredClone(version.occurrences),
          },
        ],
      })),
    };
    const existing = groups.findIndex((group) => group.id === id);
    if (existing < 0) groups.push(fallback);
    else
      groups[existing] = {
        ...groups[existing]!,
        versions: [...fallback.versions, ...groups[existing]!.versions],
      };
  }
  return groups;
}
