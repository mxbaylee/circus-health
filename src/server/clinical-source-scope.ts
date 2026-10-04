import { selectedSequence, type SelectedSequence } from './intake-selected-sequence.ts';
import { storedIntakeDetails } from './intake-state-access.ts';
import { latestOwnershipDecision } from './ownership-journal.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { HealthRecordEnvelope, IntakeWorkflow } from '../shared/intake.ts';
import { createHash } from 'node:crypto';
import { canonicalLiteral, parseLiteralJSON, type IntakeEntry } from './intake-format.ts';
import { clinicalSourceIdentityV1 } from './intake-source-identity.ts';
import {
  identityOriginalFingerprint,
  identityReceiptAppliesToCurrentBoundary,
  repeatedIdentityQuestionReceipt,
} from './intake-identity-policy.ts';
import {
  identityGroundingLookup,
  identitySubjectGroundingLookup,
} from './intake-identity-grounding.ts';

export const CLINICAL_SOURCE_SCOPE_COLLISION =
  'This issuing source identifier is already used by a different or unverified report subject or member. Nothing was merged. Review the originals; correct an extraction mistake only when supported by the source. Keep valid identifiers and patient identities unchanged.';

const tables = ['observations', 'medications', 'procedures', 'documents'] as const;
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function parse(value: unknown): Record<string, unknown> {
  try {
    return object(JSON.parse(String(value)));
  } catch {
    return {};
  }
}
function literalEnvelope(value: unknown): Record<string, unknown> {
  try {
    return object(parseLiteralJSON(String(value)));
  } catch {
    return {};
  }
}
function contains(payload: unknown, expected: string): boolean {
  const pending = [payload],
    seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length && visited++ < 100_000) {
    const value = pending.pop();
    if (typeof value === 'string' && value.includes(expected)) return true;
    if (!value || typeof value !== 'object' || JSON.isRawJSON(value) || seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) {
      if (pending.length + visited >= 100_000) return false;
      pending.push(child);
    }
  }
  return false;
}
export interface ClinicalScopeOriginal {
  id: string;
  sha256: string;
  mime_type?: string;
  details_json?: string;
}
export interface ClinicalSourceScopeGroup extends importHeader {}
type importHeader = import('./intake-identity-policy.ts').IdentityBoundaryHeader;
export interface ClinicalSourceScopeVersion {
  id: string;
  membership: import('./intake-identity-policy.ts').CurrentIdentityReceiptBoundary['membership'];
  hasOccurrence(candidateVersionId: string, recordId: string, proposalId?: string | null): boolean;
}
export interface ClinicalOriginalScope {
  profileId: string;
  hasParent: boolean;
  hasMember(id: string): boolean;
  packageSource: boolean;
  childBoundary: string | null;
  groups(): SelectedSequence<ClinicalSourceScopeGroup>;
  version(group: ClinicalSourceScopeGroup, id?: string): ClinicalSourceScopeVersion | undefined;
  receipts(): SelectedSequence<import('./intake-identity-policy.ts').IdentityPolicyReceipt>;
  originalFingerprint(group: ClinicalSourceScopeGroup): string;
  subjectGrounded(group: ClinicalSourceScopeGroup): boolean;
  questionGrounded(
    group: ClinicalSourceScopeGroup,
    issue: { prompt: string; textAnchor: string },
    receipt: import('./intake-identity-policy.ts').IdentityGroundingReceipt,
  ): boolean;
  acceptedRecords(): Iterable<Record<string, unknown>>;
}

interface Evidence {
  value: HealthRecordEnvelope;
  originalHash: string;
  scope: { subject: string; member: string | null } | null;
  unsupportedMember: boolean;
  occurrence: string;
  childBoundary: string | null;
}
function evidenceFor(
  value: HealthRecordEnvelope,
  original: ClinicalScopeOriginal,
  originalScope: ClinicalOriginalScope,
  recordId: string,
  retained = false,
): Evidence {
  const { packageSource, childBoundary } = originalScope;
  const report = value.report;
  const unsupportedMember =
    (originalScope.hasParent && !childBoundary) ||
    (packageSource && !report?.memberId) ||
    (!!report?.memberId && !originalScope.hasMember(report.memberId));
  const result: Evidence = {
    value,
    originalHash: original.sha256,
    scope: null,
    unsupportedMember,
    occurrence: `${original.id}:${recordId}`,
    childBoundary,
  };
  if (
    unsupportedMember ||
    !report ||
    !report.subject ||
    typeof report.subject.text !== 'string' ||
    !report.subject.text.trim() ||
    !report.anchor ||
    typeof report.anchor.text !== 'string'
  )
    return result;
  const literal =
    contains(value.payload, report.subject.text) && contains(value.payload, report.anchor.text);
  if (literal)
    return { ...result, scope: { subject: report.subject.text, member: report.memberId || null } };
  const version =
    'candidate-version:' + createHash('sha256').update(canonicalLiteral(value)).digest('hex');
  // Existing original-review receipts support headers on the retained page;
  // callers must not copy those headers into each clinical payload to qualify.
  const confirmed =
    !literal &&
    originalScope.receipts().some((receipt) => {
      const group = originalScope.groups().find((item) => item.id === receipt.scope.groupId);
      const current = retained
        ? group && originalScope.version(group, receipt.scope.groupVersionId)
        : group && originalScope.version(group);
      return (
        !!group &&
        !!current &&
        group.sourceFileId === original.id &&
        group.sourceHash === original.sha256 &&
        canonicalLiteral(group.report?.anchor) === canonicalLiteral(report.anchor) &&
        canonicalLiteral(group.report?.subject) === canonicalLiteral(report.subject) &&
        ['this_is_me', 'this_is_person'].includes(receipt.outcome) &&
        (receipt.scope.assignmentTargets || receipt.scope.targets).some(
          (target) => target.recordId === recordId && target.candidateVersionId === version,
        ) &&
        identityReceiptAppliesToCurrentBoundary(receipt, {
          intakeId: original.id,
          groupId: group.id,
          groupVersionId: current.id,
          sourceHash: original.sha256,
          memberId: report.memberId || null,
          report: report.anchor,
          subject: report.subject!,
          membership: current.membership,
          evidencedIdentity: receipt.scope.evidencedIdentity,
          evidenceOriginalFingerprint: originalScope.originalFingerprint(group),
        })
      );
    });
  const grounded =
    !confirmed &&
    originalScope.groups().some((group) => {
      const current = originalScope.version(group);
      if (
        !current ||
        group.sourceFileId !== original.id ||
        group.sourceHash !== original.sha256 ||
        canonicalLiteral(group.report?.anchor) !== canonicalLiteral(report.anchor) ||
        canonicalLiteral(group.report?.subject) !== canonicalLiteral(report.subject) ||
        group.memberId !== (report.memberId || null) ||
        !current.hasOccurrence(version, recordId)
      )
        return false;
      // A null-proposal occurrence with the original's own line ID is literal
      // uploaded JSONL, including report headers outside its clinical payload.
      if (
        recordId.startsWith(`${original.id}:line:`) &&
        /^[1-9]\d*$/.test(recordId.slice(`${original.id}:line:`.length)) &&
        current.hasOccurrence(version, recordId, null)
      )
        return true;
      if (originalScope.subjectGrounded(group)) return true;
      const clinicalIssues = object(value.clinical).reviewIssues;
      const questions = [
        ...(Array.isArray(value.reviewIssues) ? value.reviewIssues : []),
        ...(Array.isArray(clinicalIssues) ? clinicalIssues : []),
      ]
        .map(object)
        .filter(
          (issue) =>
            issue.kind === 'identity' &&
            typeof issue.prompt === 'string' &&
            typeof issue.textAnchor === 'string',
        );
      return questions.some((question) =>
        originalScope.receipts().some((receipt) => {
          const issue = {
            prompt: String(question.prompt),
            textAnchor: String(question.textAnchor),
          };
          return !!repeatedIdentityQuestionReceipt({
            issue,
            group,
            receipts: [receipt],
            profileId: receipt.scope.profileId,
            intakeId: original.id,
            sourceHash: original.sha256,
            originalFingerprint: originalScope.originalFingerprint(group),
            grounded: (candidate) => originalScope.questionGrounded(group, issue, candidate),
          });
        }),
      );
    });
  // A prior accepted occurrence already has a durable scoped attribution.
  // Rebuilding SQLite must not turn its cold, non-authoritative grounding cache
  // into a demand to re-review every historical PDF page.
  const acceptedProof =
    retained &&
    !confirmed &&
    !grounded &&
    selectedSequence(originalScope.acceptedRecords()).some((record) => {
      if (record.recordId !== recordId) return false;
      const attribution = object(record.identityAttribution);
      if (
        ![
          'explicit_report_confirmation',
          'same_original_person_confirmation',
          'explicit_person_confirmation',
          'matched_saved_self',
          'matched_saved_person',
        ].includes(String(attribution.basis))
      )
        return false;
      const group = originalScope.groups().find((item) => item.id === attribution.groupId);
      const historical = group && originalScope.version(group, String(attribution.groupVersionId));
      const receipt = originalScope
        .receipts()
        .find((item) => item.operationId === attribution.confirmationOperationId);
      const exactAcceptedOccurrence =
        !!group &&
        !!historical &&
        group.sourceFileId === original.id &&
        group.sourceHash === original.sha256 &&
        group.memberId === (report.memberId || null) &&
        canonicalLiteral(group.report?.anchor) === canonicalLiteral(report.anchor) &&
        canonicalLiteral(group.report?.subject) === canonicalLiteral(report.subject) &&
        historical.hasOccurrence(version, recordId);
      if (!exactAcceptedOccurrence) return false;
      const originalFingerprint = originalScope.originalFingerprint(group!);
      if (['matched_saved_self', 'matched_saved_person'].includes(String(attribution.basis)))
        return attribution.originalSubjectFingerprint === originalFingerprint;
      return (
        !!receipt &&
        ['this_is_me', 'this_is_person'].includes(receipt.outcome) &&
        receipt.scope.memberId === group!.memberId &&
        receipt.scope.intakeId === original.id &&
        receipt.scope.sourceHash === original.sha256 &&
        receipt.scope.evidenceOriginalFingerprint === originalFingerprint &&
        receipt.scope.subject.text === report.subject!.text
      );
    });
  if (confirmed || grounded || acceptedProof)
    result.scope = { subject: report.subject.text, member: report.memberId || null };
  return result;
}
function compatible(left: Evidence, right: Evidence | null): boolean {
  if (!right) return false;
  if (left.value === right.value) return true;
  if (
    left.occurrence === right.occurrence &&
    left.originalHash === right.originalHash &&
    canonicalLiteral(left.value) === canonicalLiteral(right.value)
  )
    return true;
  if (left.childBoundary !== right.childBoundary) return false;
  if (left.unsupportedMember || right.unsupportedMember) return false;
  const a = left.scope,
    b = right.scope;
  if (a && b) return a.subject === b.subject && a.member === b.member;
  if (a || b) return false;
  const contextClaim = (value: HealthRecordEnvelope) =>
    value.contextId !== undefined || object(value.payload).contextId !== undefined;
  if (contextClaim(left.value) || contextClaim(right.value)) return false;
  // Absence is not equality. Only an identical retained occurrence can be
  // retried without printed subject evidence; Self and source IDs prove none.
  return (
    !!left.originalHash &&
    left.originalHash === right.originalHash &&
    canonicalLiteral(left.value) === canonicalLiteral(right.value)
  );
}

/** Exact accepted occurrence selector shared by dependency preparation and policy. */
export function* clinicalSourceScopeRecordIds(
  db: DatabaseSync,
  identity: string,
): Generator<string> {
  for (const row of db
    .prepare("SELECT coverage_json FROM manual_batches WHERE title='Import record exception'")
    .iterate()) {
    const exception = object(parse(row.coverage_json).recordException);
    if (exception.identityKey === identity)
      yield typeof exception.recordId === 'string' ? exception.recordId : '';
  }
  for (const table of tables) {
    const kind = table === 'procedures' ? 'procedure' : table.slice(0, -1);
    for (const row of db
      .prepare(
        `SELECT id,source_record_id FROM ${table} WHERE json_extract(extra_json,'$.import.identity')=?`,
      )
      .iterate(identity)) {
      yield String(row.source_record_id);
      for (const evidence of db
        .prepare('SELECT source_record_id FROM evidence WHERE entity_type=? AND entity_id=?')
        .iterate(kind, String(row.id))) {
        const correction = latestOwnershipDecision<{
          recordId: string;
          kind: string;
          identity: string;
        }>(db, 'Record ownership source', 'sourceRecordId', String(evidence.source_record_id));
        if (
          correction &&
          correction.recordId === String(row.id) &&
          correction.kind === kind &&
          correction.identity !== identity
        )
          continue;
        yield String(evidence.source_record_id);
      }
    }
  }
}
function retainedSourceRow(db: DatabaseSync, recordId: string) {
  let row = db
    .prepare('SELECT raw_json,locator_json,source_file_id FROM source_records WHERE id=?')
    .get(recordId) as
    { raw_json: string; locator_json: string; source_file_id: string } | undefined;
  if (!row)
    for (const table of tables) {
      const entity = db
        .prepare(`SELECT source_record_id FROM ${table} WHERE id=?`)
        .get(recordId) as { source_record_id: string } | undefined;
      if (entity) {
        recordId = entity.source_record_id;
        row = db
          .prepare('SELECT raw_json,locator_json,source_file_id FROM source_records WHERE id=?')
          .get(recordId) as typeof row;
        break;
      }
    }
  return { row, recordId };
}
/** A repeatable complete dependency walk; duplicate IDs may be yielded without retaining an unbounded set. */
export function* clinicalSourceScopeDependencyIds(
  db: DatabaseSync,
  file: { id?: string; sha256: string },
  entries: IntakeEntry[],
): Generator<string> {
  if (file.id) yield file.id;
  const identities = new Set(entries.map((entry) => clinicalSourceIdentityV1(entry, file)));
  for (const identity of identities)
    for (const id of clinicalSourceScopeRecordIds(db, identity)) {
      const { row } = retainedSourceRow(db, id);
      if (!row || literalEnvelope(row.raw_json).format !== 'health-record-v1') continue;
      const originalId = parse(row.locator_json).originalSourceFileId || row.source_file_id;
      if (
        typeof originalId === 'string' &&
        db.prepare('SELECT 1 FROM source_files WHERE id=? AND sha256 IS NOT NULL').get(originalId)
      )
        yield originalId;
    }
}

/** Read-only, invocation-local snapshot. Recreate during each transactional
 * projection; never reuse a review's cached result to authorize an acceptance.
 * Neither persisted identity domain nor accepted source envelopes are changed. */
export function clinicalSourceScopeCheck(
  db: DatabaseSync,
  file: { id?: string; sha256: string; mime_type?: string; details_json?: string },
  entries: IntakeEntry[],
  inputFileId = file.id || '',
  selectedScope?: (original: ClinicalScopeOriginal) => ClinicalOriginalScope,
): (entry: IntakeEntry) => string | null {
  const incomingOriginal: ClinicalScopeOriginal = { ...file, id: file.id || '' };
  const profileId = String(
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value || '',
  );
  // The workflow can contain many historical candidates. Parse it once per
  // original in this synchronous snapshot, never once per candidate/evidence.
  // Each caller creates a new checker, including transactional projection.
  const scopeCache = new WeakMap<ClinicalScopeOriginal, ClinicalOriginalScope>();
  const scopeFor = (original: ClinicalScopeOriginal): ClinicalOriginalScope => {
    if (selectedScope) return selectedScope(original);
    const cached = scopeCache.get(original);
    if (cached) return cached;
    const intake = object(storedIntakeDetails(db, original));
    const workflow = object(intake.workflow) as unknown as IntakeWorkflow;
    workflow.plans ||= [];
    const memberIds = new Set(
      workflow.plans.flatMap((plan) => (plan.index.members || []).map((member) => member.memberId)),
    );
    const fullGroup = (group: ClinicalSourceScopeGroup) =>
      workflow.reportGroups!.find((item) => item === group)!;
    const result: ClinicalOriginalScope = {
      profileId,
      hasParent: !!intake.parentSourceFileId,
      hasMember: (id) => memberIds.has(id),
      groups: () => selectedSequence(workflow.reportGroups || []),
      version(group, id) {
        const selected =
          id === undefined
            ? fullGroup(group).versions.at(-1)
            : fullGroup(group).versions.find((version) => version.id === id);
        return (
          selected && {
            id: selected.id,
            membership: selected.members,
            hasOccurrence: (versionId, recordId, proposalId) =>
              selected.members.some(
                (member) =>
                  member.candidateVersionId === versionId &&
                  member.occurrences.some(
                    (occurrence) =>
                      occurrence.recordId === recordId &&
                      (proposalId === undefined || occurrence.proposalId === proposalId),
                  ),
              ),
          }
        );
      },
      receipts: () => selectedSequence(workflow.identityConfirmations || []),
      originalFingerprint: (group) =>
        identityOriginalFingerprint(original.id, original.sha256, fullGroup(group), workflow),
      subjectGrounded: (group) =>
        identitySubjectGroundingLookup(db, {
          profileId,
          intakeId: original.id,
          sourceHash: original.sha256,
          workflow,
        })(fullGroup(group)),
      questionGrounded: (group, issue, receipt) =>
        identityGroundingLookup(db, {
          profileId: receipt.scope.profileId,
          intakeId: original.id,
          sourceHash: original.sha256,
          workflow,
        })(fullGroup(group), issue, receipt),
      *acceptedRecords() {
        for (const batch of [
          intake.imported,
          ...(Array.isArray(intake.importHistory) ? intake.importHistory : []),
        ]) {
          const records = object(object(batch).clinical).records;
          if (Array.isArray(records)) for (const record of records) yield object(record);
        }
      },
      packageSource: original.mime_type === 'application/zip' || memberIds.size > 0,
      childBoundary:
        typeof intake.parentSourceFileId === 'string' && typeof intake.locator === 'string'
          ? canonicalLiteral([original.id, intake.parentSourceFileId, intake.locator])
          : null,
    };
    scopeCache.set(original, result);
    return result;
  };
  const originalCache = new Map<string, ClinicalScopeOriginal | null>();
  const originalFor = (id: string): ClinicalScopeOriginal | null => {
    if (originalCache.size >= 256 && !originalCache.has(id))
      originalCache.delete(originalCache.keys().next().value!);
    if (!originalCache.has(id))
      originalCache.set(
        id,
        (db
          .prepare('SELECT id,sha256,mime_type,details_json FROM source_files WHERE id=?')
          .get(id) as ClinicalScopeOriginal | undefined) || null,
      );
    return originalCache.get(id)!;
  };
  const retainedCache = new Map<string, Evidence | null>();
  const retained = (recordId: string): Evidence | null => {
    if (retainedCache.has(recordId)) return retainedCache.get(recordId)!;
    const selected = retainedSourceRow(db, recordId),
      row = selected.row;
    recordId = selected.recordId;
    const raw = literalEnvelope(row?.raw_json);
    const originalId = parse(row?.locator_json).originalSourceFileId || row?.source_file_id;
    const original = typeof originalId === 'string' ? originalFor(originalId) : null;
    const result =
      row && raw.format === 'health-record-v1' && original?.sha256
        ? evidenceFor(
            raw as unknown as HealthRecordEnvelope,
            original,
            scopeFor(original),
            recordId,
            true,
          )
        : null;
    if (retainedCache.size >= 256) retainedCache.delete(retainedCache.keys().next().value!);
    retainedCache.set(recordId, result);
    return result;
  };
  function* accepted(identity: string): Generator<Evidence | null> {
    for (const recordId of clinicalSourceScopeRecordIds(db, identity)) yield retained(recordId);
  }
  const incoming = new Map<string, Evidence[]>();
  const entryEvidence = new Map<IntakeEntry, Evidence>();
  for (const entry of entries) {
    const identity = clinicalSourceIdentityV1(entry, file);
    const peers = incoming.get(identity) || [];
    const evidence = evidenceFor(
      entry.value,
      incomingOriginal,
      scopeFor(incomingOriginal),
      `${inputFileId}:line:${entry.line}`,
    );
    entryEvidence.set(entry, evidence);
    peers.push(evidence);
    incoming.set(identity, peers);
  }
  return (entry) => {
    const identity = clinicalSourceIdentityV1(entry, file);
    const evidence =
      entryEvidence.get(entry) ||
      evidenceFor(
        entry.value,
        incomingOriginal,
        scopeFor(incomingOriginal),
        `${inputFileId}:line:${entry.line}`,
      );
    return selectedSequence(accepted(identity)).some((prior) => !compatible(evidence, prior)) ||
      (incoming.get(identity) || []).some((prior) => !compatible(evidence, prior))
      ? CLINICAL_SOURCE_SCOPE_COLLISION
      : null;
  };
}
