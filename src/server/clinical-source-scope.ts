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
interface Original {
  id: string;
  sha256: string;
  mime_type?: string;
  details_json?: string;
}
interface OriginalScope {
  profileId: string;
  intake: Record<string, unknown>;
  workflow: IntakeWorkflow;
  memberIds: Set<string>;
  packageSource: boolean;
  childBoundary: string | null;
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
  db: DatabaseSync,
  value: HealthRecordEnvelope,
  original: Original,
  originalScope: OriginalScope,
  recordId: string,
  retained = false,
): Evidence {
  const { workflow, intake, memberIds, packageSource, childBoundary, profileId } = originalScope;
  const report = value.report;
  const unsupportedMember =
    (!!intake.parentSourceFileId && !childBoundary) ||
    (packageSource && !report?.memberId) ||
    (!!report?.memberId && !memberIds.has(report.memberId));
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
    (workflow.identityConfirmations || []).some((receipt) => {
      const group = workflow.reportGroups?.find((item) => item.id === receipt.scope.groupId);
      const current = retained
        ? group?.versions.find((item) => item.id === receipt.scope.groupVersionId)
        : group?.versions.at(-1);
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
          membership: current.members,
          evidencedIdentity: receipt.scope.evidencedIdentity,
          evidenceOriginalFingerprint: identityOriginalFingerprint(
            original.id,
            original.sha256,
            group,
            workflow,
          ),
        })
      );
    });
  const grounded =
    !confirmed &&
    (workflow.reportGroups || []).some((group) => {
      const current = group.versions.at(-1);
      if (
        !current ||
        group.sourceFileId !== original.id ||
        group.sourceHash !== original.sha256 ||
        canonicalLiteral(group.report?.anchor) !== canonicalLiteral(report.anchor) ||
        canonicalLiteral(group.report?.subject) !== canonicalLiteral(report.subject) ||
        group.memberId !== (report.memberId || null) ||
        !current.members.some(
          (member) =>
            member.candidateVersionId === version &&
            member.occurrences.some((occurrence) => occurrence.recordId === recordId),
        )
      )
        return false;
      // A null-proposal occurrence with the original's own line ID is literal
      // uploaded JSONL, including report headers outside its clinical payload.
      if (
        recordId.startsWith(`${original.id}:line:`) &&
        /^[1-9]\d*$/.test(recordId.slice(`${original.id}:line:`.length)) &&
        current.members.some(
          (member) =>
            member.candidateVersionId === version &&
            member.occurrences.some(
              (occurrence) => occurrence.recordId === recordId && occurrence.proposalId === null,
            ),
        )
      )
        return true;
      if (
        identitySubjectGroundingLookup(db, {
          profileId,
          intakeId: original.id,
          sourceHash: original.sha256,
          workflow,
        })(group)
      )
        return true;
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
        (workflow.identityConfirmations || []).some((receipt) => {
          const lookup = identityGroundingLookup(db, {
            profileId: receipt.scope.profileId,
            intakeId: original.id,
            sourceHash: original.sha256,
            workflow,
          });
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
            originalFingerprint: identityOriginalFingerprint(
              original.id,
              original.sha256,
              group,
              workflow,
            ),
            grounded: (candidate) => lookup(group, issue, candidate),
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
    [intake.imported, ...(Array.isArray(intake.importHistory) ? intake.importHistory : [])]
      .flatMap((batch) => {
        const records = object(object(batch).clinical).records;
        return Array.isArray(records) ? records : [];
      })
      .map(object)
      .some((record) => {
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
        const group = workflow.reportGroups?.find((item) => item.id === attribution.groupId);
        const historical = group?.versions.find((item) => item.id === attribution.groupVersionId);
        const receipt = workflow.identityConfirmations?.find(
          (item) => item.operationId === attribution.confirmationOperationId,
        );
        const exactAcceptedOccurrence =
          !!group &&
          !!historical &&
          group.sourceFileId === original.id &&
          group.sourceHash === original.sha256 &&
          group.memberId === (report.memberId || null) &&
          canonicalLiteral(group.report?.anchor) === canonicalLiteral(report.anchor) &&
          canonicalLiteral(group.report?.subject) === canonicalLiteral(report.subject) &&
          historical.members.some(
            (member) =>
              member.candidateVersionId === version &&
              member.occurrences.some((occurrence) => occurrence.recordId === recordId),
          );
        if (!exactAcceptedOccurrence) return false;
        const originalFingerprint = identityOriginalFingerprint(
          original.id,
          original.sha256,
          group!,
          workflow,
        );
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

/** Read-only, invocation-local snapshot. Recreate during each transactional
 * projection; never reuse a review's cached result to authorize an acceptance.
 * Neither persisted identity domain nor accepted source envelopes are changed. */
export function clinicalSourceScopeCheck(
  db: DatabaseSync,
  file: { id?: string; sha256: string; mime_type?: string; details_json?: string },
  entries: IntakeEntry[],
  inputFileId = file.id || '',
): (entry: IntakeEntry) => string | null {
  const incomingOriginal: Original = { ...file, id: file.id || '' };
  const profileId = String(
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value || '',
  );
  // The workflow can contain many historical candidates. Parse it once per
  // original in this synchronous snapshot, never once per candidate/evidence.
  // Each caller creates a new checker, including transactional projection.
  const scopeCache = new WeakMap<Original, OriginalScope>();
  const scopeFor = (original: Original): OriginalScope => {
    const cached = scopeCache.get(original);
    if (cached) return cached;
    const intake = object(storedIntakeDetails(db, original));
    const workflow = object(intake.workflow) as unknown as IntakeWorkflow;
    workflow.plans ||= [];
    const memberIds = new Set(
      workflow.plans.flatMap((plan) => (plan.index.members || []).map((member) => member.memberId)),
    );
    const result = {
      profileId,
      intake,
      workflow,
      memberIds,
      packageSource: original.mime_type === 'application/zip' || memberIds.size > 0,
      childBoundary:
        typeof intake.parentSourceFileId === 'string' && typeof intake.locator === 'string'
          ? canonicalLiteral([original.id, intake.parentSourceFileId, intake.locator])
          : null,
    };
    scopeCache.set(original, result);
    return result;
  };
  const originalCache = new Map<string, Original | null>();
  const originalFor = (id: string): Original | null => {
    if (!originalCache.has(id))
      originalCache.set(
        id,
        (db
          .prepare('SELECT id,sha256,mime_type,details_json FROM source_files WHERE id=?')
          .get(id) as Original | undefined) || null,
      );
    return originalCache.get(id)!;
  };
  const retainedCache = new Map<string, Evidence | null>();
  const retained = (recordId: string): Evidence | null => {
    if (retainedCache.has(recordId)) return retainedCache.get(recordId)!;
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
            .get(entity.source_record_id) as typeof row;
          break;
        }
      }
    const raw = literalEnvelope(row?.raw_json);
    const originalId = parse(row?.locator_json).originalSourceFileId || row?.source_file_id;
    const original = typeof originalId === 'string' ? originalFor(originalId) : null;
    const result =
      row && raw.format === 'health-record-v1' && original?.sha256
        ? evidenceFor(
            db,
            raw as unknown as HealthRecordEnvelope,
            original,
            scopeFor(original),
            recordId,
            true,
          )
        : null;
    retainedCache.set(recordId, result);
    return result;
  };
  const exceptions = new Map<string, string[]>();
  for (const row of db
    .prepare("SELECT coverage_json FROM manual_batches WHERE title='Import record exception'")
    .all()) {
    const exception = object(parse(row.coverage_json).recordException);
    if (typeof exception.identityKey !== 'string') continue;
    const records = exceptions.get(exception.identityKey) || [];
    records.push(typeof exception.recordId === 'string' ? exception.recordId : '');
    exceptions.set(exception.identityKey, records);
  }
  const acceptedCache = new Map<string, (Evidence | null)[]>();
  const accepted = (identity: string): (Evidence | null)[] => {
    if (acceptedCache.has(identity)) return acceptedCache.get(identity)!;
    const ids = new Set(exceptions.get(identity) || []);
    for (const table of tables) {
      const kind = table === 'procedures' ? 'procedure' : table.slice(0, -1);
      for (const row of db
        .prepare(
          `SELECT id,source_record_id FROM ${table} WHERE json_extract(extra_json,'$.import.identity')=?`,
        )
        .all(identity)) {
        ids.add(String(row.source_record_id));
        // Include every retained occurrence: old silent merges must not become
        // safe merely because their first source happens to match this input.
        for (const evidence of db
          .prepare('SELECT source_record_id FROM evidence WHERE entity_type=? AND entity_id=?')
          .all(kind, String(row.id))) {
          const correction = latestOwnershipDecision<{
            recordId: string;
            kind: string;
            identity: string;
          }>(db, 'Record ownership source', 'sourceRecordId', String(evidence.source_record_id));
          // A reviewed contribution with its own identity is not an issuer-ID collision.
          // The exact retained source still goes through its own scope check on reimport.
          if (
            correction &&
            correction.recordId === String(row.id) &&
            correction.kind === kind &&
            correction.identity !== identity
          )
            continue;
          ids.add(String(evidence.source_record_id));
        }
      }
    }
    const result = [...ids].map(retained);
    acceptedCache.set(identity, result);
    return result;
  };
  const incoming = new Map<string, Evidence[]>();
  const entryEvidence = new Map<IntakeEntry, Evidence>();
  for (const entry of entries) {
    const identity = clinicalSourceIdentityV1(entry, file);
    const peers = incoming.get(identity) || [];
    const evidence = evidenceFor(
      db,
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
        db,
        entry.value,
        incomingOriginal,
        scopeFor(incomingOriginal),
        `${inputFileId}:line:${entry.line}`,
      );
    return [...accepted(identity), ...(incoming.get(identity) || [])].some(
      (prior) => !compatible(evidence, prior),
    )
      ? CLINICAL_SOURCE_SCOPE_COLLISION
      : null;
  };
}
