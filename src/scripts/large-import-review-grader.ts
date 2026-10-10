import type {
  IntakeClinicalMapping,
  IntakeEvidenceLocator,
  IntakeReportGroup,
  IntakeReportQueueGroup,
  IntakeReview,
  IntakeReviewRecord,
  IntakeReportReference,
} from '../shared/intake.ts';
import type {
  IntakeIdentityPerson,
  IntakeIdentityReview,
  IntakeIdentityScope,
} from '../shared/intake-identity.ts';
import type {
  CollectionReportGroupSummary,
  CollectionIntakeReportRecordPage,
} from '../shared/intake-clinical-pages.ts';
import type { LargeImportAssertion, LargeImportOracle } from './large-import-fixture.ts';
import { exactQualificationPage } from './provider-qualification-fixture.ts';

export interface LargeImportReviewAuthority {
  /** Retained versions/membership from Intake.workflow, never invented from labels. */
  retained: IntakeReportGroup;
  queue: IntakeReportQueueGroup;
  identity: IntakeIdentityReview;
}
/** Native qualification inspects the current group and every returned record page.
 * It makes no claim about unloaded retained historical group versions. */
export interface NativeLargeImportReviewAuthority {
  format: 'qualification-native-report-v1';
  inspectedScope?: IntakeIdentityScope;
  group: CollectionReportGroupSummary;
  records: CollectionIntakeReportRecordPage[];
  sourceHash: string;
  identity: IntakeIdentityReview;
}
interface InspectedReportAuthority {
  id: string;
  sourceFileId: string | null;
  sourceHash: string | null;
  memberId: string | null;
  basis: string;
  report: IntakeReportReference | undefined;
  queue: Pick<
    IntakeReportQueueGroup,
    'groupId' | 'groupVersionId' | 'intakeId' | 'intakeVersion' | 'anchor'
  > & { basis: string; member: { memberId: string } | null; original: { contentUrl: string } };
  identity: IntakeIdentityReview;
  latestVersionId: string | null;
  memberships: Map<string, Set<string>>;
  complete: boolean;
}
export interface LargeImportReviewInput<Authority = LargeImportReviewAuthority> {
  oracle: LargeImportOracle;
  stage: 'proposal' | 'review';
  originalId: string;
  people: Readonly<Record<string, IntakeIdentityPerson>>;
  reviews: readonly IntakeReview[];
  authorities: readonly Authority[];
}
const blank = (value: unknown) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const label = (mapping: IntakeClinicalMapping) =>
  mapping.kind === 'observation'
    ? mapping.testLabel
    : mapping.kind === 'medication'
      ? mapping.medicationName
      : mapping.kind === 'procedure'
        ? mapping.procedureLabel
        : undefined;
const occurrenceKey = (
  proposal: string | null,
  record: string,
  candidate: string,
  version: string,
) => JSON.stringify([proposal, record, candidate, version]);
const printed = (text: string, literal: string) => {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}($|[^\\p{L}\\p{N}_-])`, 'u').test(text);
};
/** The current review API has one original locator. Only explicit semicolon-separated
 * single-page clauses extend that contract; every clause must independently validate. */
export function exactLargeImportPages(
  evidence: IntakeEvidenceLocator,
  originalId: string,
): number[] | null {
  if (!evidence.locator.includes(';')) {
    const single = exactQualificationPage(evidence, originalId);
    return single === null ? null : [single];
  }
  const clauses = evidence.locator.split(';');
  if (clauses.some((clause) => !/\b(?:pages?|pp?\.?)[\s:#]*\d+\b/i.test(clause))) return null;
  const pages = clauses.map((locator) =>
    exactQualificationPage({ ...evidence, locator }, originalId),
  );
  return pages.every((page) => page !== null) ? [...new Set(pages as number[])] : null;
}
export function largeImportFieldMismatches(
  record: Pick<IntakeReviewRecord, 'kind' | 'mapping'>,
  expected: LargeImportAssertion,
  original: string,
) {
  const mapping = record.mapping as Record<string, unknown>;
  const origins = object(mapping.mappingOrigins);
  const fields = new Set<string>();
  for (const [field, value] of Object.entries(expected.mapping))
    if (mapping[field] !== value) fields.add(field);
  if (record.kind !== expected.mapping.kind) fields.add('kind');
  for (const [field, value] of Object.entries(mapping)) {
    if (Object.hasOwn(expected.mapping, field) || blank(value)) continue;
    let allowed = false;
    if (field === 'personId' || field === 'subject')
      allowed = true; // Graded separately below.
    else if (field === 'label') allowed = value === label(expected.mapping);
    else if (field === 'dateRole') allowed = value === 'recorded';
    else if (field === 'medicationKind') allowed = value === 'unknown';
    else if (field === 'procedureCategory') allowed = value === 'unspecified';
    else if (field === 'documentDate') allowed = value === expected.mapping.date;
    else if (field === 'documentTitle')
      allowed = typeof value === 'string' && origins.documentTitle === 'envelope';
    else if (field === 'text') allowed = typeof value === 'string' && origins.text === 'payload';
    else if (field === 'assets')
      allowed = Array.isArray(value) && value.every((asset) => asset === original);
    else if (field === 'mappingOrigins')
      allowed =
        Object.keys(origins).every((key) => ['kind', 'documentTitle', 'text'].includes(key)) &&
        ['clinical', 'envelope'].includes(String(origins.kind)) &&
        ['clinical', 'envelope'].includes(String(origins.documentTitle)) &&
        ['clinical', 'payload'].includes(String(origins.text));
    if (!allowed) fields.add(Object.hasOwn(expected.mapping, field) ? field : 'unexpectedField');
  }
  return [...fields];
}

/** Pure fixture reconciliation, never acceptance authority or extraction/collection qualification. */
export function gradeLargeImportReview(
  input: LargeImportReviewInput<LargeImportReviewAuthority | NativeLargeImportReviewAuthority>,
) {
  const { oracle, originalId } = input;
  if (
    !['proposal', 'review'].includes(input.stage) ||
    oracle.format !== 'circus-fictional-large-import-oracle-v1' ||
    oracle.pages !== 900 ||
    oracle.assertions.length !== 901 ||
    oracle.people.length !== 2 ||
    oracle.reports.length !== 6 ||
    new Set(oracle.assertions.map((item) => item.key)).size !== 901
  )
    throw Error('Unsupported or invalid fictional large-import oracle');
  const authorityIssues = new Set<string>();
  if (!originalId) authorityIssues.add('originalBinding');
  const personIds = new Set<string>(),
    noteIds = new Set<string>();
  for (const person of oracle.people) {
    const bound = Object.hasOwn(input.people, person.key) ? input.people[person.key] : undefined;
    if (
      !bound ||
      !bound.personId ||
      !bound.noteId ||
      !Number.isSafeInteger(bound.version) ||
      bound.version < 1 ||
      bound.fullName !== person.name ||
      bound.birthDate !== person.birthDate ||
      personIds.has(bound.personId) ||
      noteIds.has(bound.noteId)
    )
      authorityIssues.add('peopleBinding');
    if (bound) {
      personIds.add(bound.personId);
      noteIds.add(bound.noteId);
    }
  }
  if (Object.keys(input.people).some((key) => !oracle.people.some((person) => person.key === key)))
    authorityIssues.add('peopleBinding');
  const byGroup = new Map<string, InspectedReportAuthority>();
  const memberships = new Map<string, Set<string>>();
  const scopeMemberships = new Map<string, Set<string>>();
  const profileIds = new Set<string>();
  for (const source of input.authorities) {
    const authority = inspectAuthority(source);
    const { queue, identity } = authority;
    if (byGroup.has(authority.id)) authorityIssues.add('duplicateAuthority');
    else byGroup.set(authority.id, authority);
    if (
      !authority.complete ||
      authority.id !== queue.groupId ||
      authority.sourceFileId !== originalId ||
      authority.basis !== 'report_anchor' ||
      queue.basis !== authority.basis ||
      (queue.member?.memberId ?? null) !== authority.memberId ||
      !authority.report ||
      authority.latestVersionId !== queue.groupVersionId ||
      (identity.scope &&
        (identity.scope.groupId !== authority.id ||
          identity.scope.groupVersionId !== queue.groupVersionId ||
          identity.scope.intakeId !== queue.intakeId ||
          identity.scope.intakeVersion !== queue.intakeVersion ||
          identity.scope.memberId !== authority.memberId ||
          identity.scope.sourceHash !== authority.sourceHash))
    )
      authorityIssues.add('conflictingAuthority');
    if (identity.scope) {
      profileIds.add(identity.scope.profileId);
      const set = new Set<string>();
      for (const member of identity.scope.membership)
        for (const occurrence of member.occurrences)
          set.add(
            occurrenceKey(
              occurrence.proposalId,
              occurrence.recordId,
              member.candidateId,
              member.candidateVersionId,
            ),
          );
      scopeMemberships.set(authority.id, set);
    }
    for (const [versionId, set] of authority.memberships)
      memberships.set(JSON.stringify([authority.id, versionId]), set);
  }
  if (profileIds.size > 1) authorityIssues.add('conflictingAuthority');
  const expectedByLabel = new Map<string, LargeImportAssertion>();
  for (const expected of oracle.assertions) {
    const marker = label(expected.mapping);
    if (!marker || expectedByLabel.has(marker)) throw Error('Invalid fictional assertion labels');
    expectedByLabel.set(marker, expected);
  }
  const reports = new Map(oracle.reports.map((report) => [report.key, report]));
  const persons = new Map(oracle.people.map((person) => [person.key, person]));
  const matches = new Map<string, number>();
  const occurrences = new Set<string>();
  const mismatches: Array<{
    key: string;
    fields: string[];
    provenance: string[];
    ownership: string[];
  }> = [];
  const unresolved = new Set<string>(),
    unresolvedIssues = new Set<string>();
  let observedRecords = 0,
    unexpectedRecords = 0,
    duplicateOccurrences = 0;
  for (const review of input.reviews)
    for (const record of review.records) {
      // This oracle requires inspected membership; an unloaded reference cannot qualify it.
      const reportGroups = Array.isArray(record.reportGroups) ? record.reportGroups : [];
      observedRecords++;
      const occurrence = JSON.stringify([review.intakeId, review.proposalId, record.id]);
      if (occurrences.has(occurrence)) duplicateOccurrences++;
      occurrences.add(occurrence);
      const expected = expectedByLabel.get(label(record.mapping) ?? '');
      if (!expected) {
        unexpectedRecords++;
        continue;
      }
      matches.set(expected.key, (matches.get(expected.key) ?? 0) + 1);
      const fields = largeImportFieldMismatches(record, expected, originalId);
      const provenance = new Set<string>(),
        ownership = new Set<string>();
      const report = reports.get(expected.reportKey),
        person = persons.get(expected.personKey);
      if (
        !report ||
        !person ||
        report.personKey !== expected.personKey ||
        expected.pages.some((page) => page < report.firstPage || page > report.lastPage)
      )
        throw Error('Invalid fictional assertion attribution');
      const pages = new Set<number>();
      for (const evidence of record.evidence) {
        if (!evidence.contentUrl?.includes('/sources/') && evidence.label !== 'Original source')
          continue;
        const located = exactLargeImportPages(evidence, originalId);
        if (located === null || located.some((page) => !expected.pages.includes(page)))
          provenance.add('originalPages');
        else for (const page of located) pages.add(page);
      }
      if (expected.pages.some((page) => !pages.has(page))) provenance.add('originalPages');
      if (reportGroups.length !== 1) {
        provenance.add('reportMembership');
        unresolved.add(expected.key);
      }
      const bound = input.people[person.key];
      const selfAuthority =
        reportGroups.length === 1 ? byGroup.get(reportGroups[0]!.groupId) : undefined;
      const selfIdentity = selfAuthority?.identity;
      const selfScope = selfIdentity?.scope;
      // Normal Self confirmation stores subject:self without a personId or
      // assignedPerson. Its current, explicitly bound Self snapshot and exact
      // scoped original evidence supply that authority; absence alone never does.
      const scopedSelfProof = !!(
        bound?.noteId === 'person-note:self' &&
        bound.personId === 'patient' &&
        record.mapping.subject === 'self' &&
        (!record.mapping.personId || record.mapping.personId === 'patient') &&
        selfIdentity &&
        selfScope &&
        selfAuthority &&
        selfIdentity.self?.noteId === bound.noteId &&
        selfIdentity.self.version === bound.version &&
        selfScope.selfVersion === bound.version &&
        selfIdentity.self.fullName === bound.fullName &&
        selfIdentity.self.birthDate === bound.birthDate &&
        selfIdentity.evidencedIdentity.fullName === person.name &&
        selfIdentity.evidencedIdentity.birthDate === person.birthDate &&
        selfScope.evidencedIdentity?.fullName === person.name &&
        selfScope.evidencedIdentity.birthDate === person.birthDate &&
        !selfIdentity.blocking &&
        !selfIdentity.conflicts.length &&
        ['evidenced_match', 'prior_confirmation'].includes(selfIdentity.status) &&
        selfScope.groupId === selfAuthority.id &&
        selfScope.groupVersionId === selfAuthority.queue.groupVersionId &&
        selfScope.intakeId === review.intakeId &&
        selfScope.intakeVersion === review.version &&
        selfScope.sourceHash === selfAuthority.sourceHash &&
        selfScope.memberId === selfAuthority.memberId &&
        selfScope.report.text === selfAuthority.report?.anchor.text &&
        selfScope.report.locator === selfAuthority.report?.anchor.locator &&
        selfScope.subject.text === selfAuthority.report?.subject?.text &&
        selfScope.subject.locator === selfAuthority.report?.subject?.locator &&
        scopeMemberships
          .get(selfAuthority.id)
          ?.has(
            occurrenceKey(
              review.proposalId,
              record.id,
              record.candidateId ?? '',
              record.candidateVersionId ?? '',
            ),
          ) &&
        memberships
          .get(JSON.stringify([selfAuthority.id, reportGroups[0]!.groupVersionId]))
          ?.has(
            occurrenceKey(
              review.proposalId,
              record.id,
              record.candidateId ?? '',
              record.candidateVersionId ?? '',
            ),
          )
      );
      if (!record.mapping.personId) {
        if (!scopedSelfProof) unresolved.add(expected.key);
      } else if (record.mapping.personId !== bound?.personId) ownership.add('mappingPerson');
      if (record.mapping.subject && !['self', 'other', 'unknown'].includes(record.mapping.subject))
        ownership.add('subject');
      if (!record.mapping.subject || record.mapping.subject === 'unknown')
        unresolved.add(expected.key);
      if (record.mapping.subject === 'self' && bound?.noteId !== 'person-note:self')
        ownership.add('subject');
      if (record.mapping.subject === 'other' && bound?.noteId === 'person-note:self')
        ownership.add('subject');
      for (const reference of reportGroups) {
        const authority = byGroup.get(reference.groupId);
        if (!authority) {
          provenance.add('reportAuthority');
          unresolved.add(expected.key);
          continue;
        }
        const { queue, identity } = authority;
        const member = occurrenceKey(
          review.proposalId,
          record.id,
          record.candidateId ?? '',
          record.candidateVersionId ?? '',
        );
        if (
          queue.intakeId !== review.intakeId ||
          queue.intakeVersion !== review.version ||
          !memberships
            .get(JSON.stringify([reference.groupId, reference.groupVersionId]))
            ?.has(member)
        )
          provenance.add('reportMembership');
        const anchor = authority.report?.anchor;
        const subject = authority.report?.subject;
        const anchorPage = anchor
          ? exactQualificationPage(
              { label: 'Original source', ...anchor, contentUrl: queue.original.contentUrl },
              originalId,
            )
          : null;
        const subjectPage = subject
          ? exactQualificationPage(
              { label: 'Original source', ...subject, contentUrl: queue.original.contentUrl },
              originalId,
            )
          : null;
        if (
          authority.report?.key !== report.key ||
          !anchor ||
          !printed(anchor.text, report.key) ||
          anchorPage === null ||
          anchorPage < report.firstPage ||
          anchorPage > report.lastPage ||
          !subject ||
          !printed(subject.text, person.name) ||
          subjectPage === null ||
          subjectPage < report.firstPage ||
          subjectPage > report.lastPage ||
          queue.anchor?.text !== anchor.text ||
          queue.anchor?.locator !== anchor.locator
        )
          provenance.add('reportAnchors');
        if (identity.scope) {
          const scope = identity.scope;
          const scopePage = exactQualificationPage(
            {
              label: 'Original source',
              locator: scope.report.locator,
              contentUrl: scope.original.contentUrl,
            },
            originalId,
          );
          const scopeSubjectPage = exactQualificationPage(
            {
              label: 'Original source',
              locator: scope.subject.locator,
              contentUrl: scope.original.contentUrl,
            },
            originalId,
          );
          if (
            scope.report.text !== anchor?.text ||
            scope.report.locator !== anchor?.locator ||
            scope.subject.text !== subject?.text ||
            scope.subject.locator !== subject?.locator ||
            scopePage === null ||
            scopePage < report.firstPage ||
            scopePage > report.lastPage ||
            scopeSubjectPage === null ||
            scopeSubjectPage < report.firstPage ||
            scopeSubjectPage > report.lastPage ||
            !scopeMemberships.get(authority.id)?.has(member)
          )
            provenance.add('identityScope');
        }
        const identities = [identity, record.identityReview];
        for (const reading of identities) {
          if (!reading) {
            unresolved.add(expected.key);
            continue;
          }
          const readingScope = (reading as { scope?: IntakeIdentityScope | null }).scope;
          const scopeEvidence = readingScope?.evidencedIdentity;
          if (
            scopeEvidence &&
            ((scopeEvidence.fullName !== undefined &&
              (scopeEvidence.fullName !== person.name ||
                scopeEvidence.fullName !== reading.evidencedIdentity.fullName)) ||
              (scopeEvidence.birthDate !== undefined &&
                (scopeEvidence.birthDate !== person.birthDate ||
                  scopeEvidence.birthDate !== reading.evidencedIdentity.birthDate)))
          )
            ownership.add('identityConflict');
          if (readingScope && reading !== identity) {
            const membership = readingScope.membership.some(
              (member) =>
                member.candidateId === record.candidateId &&
                member.candidateVersionId === record.candidateVersionId &&
                member.occurrences.some(
                  (occurrence) =>
                    occurrence.recordId === record.id &&
                    occurrence.proposalId === review.proposalId,
                ),
            );
            if (
              !identity.scope ||
              readingScope.groupId !== identity.scope.groupId ||
              readingScope.groupVersionId !== identity.scope.groupVersionId ||
              readingScope.intakeId !== identity.scope.intakeId ||
              readingScope.intakeVersion !== identity.scope.intakeVersion ||
              readingScope.profileId !== identity.scope.profileId ||
              readingScope.sourceHash !== identity.scope.sourceHash ||
              readingScope.memberId !== identity.scope.memberId ||
              readingScope.original.contentUrl !== identity.scope.original.contentUrl ||
              readingScope.report.text !== identity.scope.report.text ||
              readingScope.report.locator !== identity.scope.report.locator ||
              readingScope.subject.text !== identity.scope.subject.text ||
              readingScope.subject.locator !== identity.scope.subject.locator ||
              !membership
            )
              provenance.add('identityScope');
          }
          if (
            reading.status === 'conflict' ||
            reading.conflicts.length ||
            (reading.evidencedIdentity.fullName !== undefined &&
              reading.evidencedIdentity.fullName !== person.name) ||
            (reading.evidencedIdentity.birthDate !== undefined &&
              reading.evidencedIdentity.birthDate !== person.birthDate)
          )
            ownership.add('identityConflict');
          const assigned = reading.assignedPerson;
          if (
            assigned &&
            (!bound ||
              assigned.personId !== bound.personId ||
              assigned.noteId !== bound.noteId ||
              assigned.version !== bound.version ||
              assigned.fullName !== bound.fullName ||
              (assigned.birthDate !== undefined && assigned.birthDate !== bound.birthDate))
          )
            ownership.add('assignedPerson');
          if (
            (!assigned && !scopedSelfProof) ||
            reading.blocking ||
            !['evidenced_match', 'prior_confirmation'].includes(reading.status) ||
            reading.evidencedIdentity.fullName !== person.name ||
            reading.evidencedIdentity.birthDate !== person.birthDate
          )
            unresolved.add(expected.key);
        }
        if (!identity.scope) unresolved.add(expected.key);
      }
      if (
        record.issuesReference ||
        record.questionsReference ||
        (record.issues ?? []).some((issue) => issue.status === 'unresolved') ||
        (record.questions ?? []).some((question) => question.status === 'unanswered')
      )
        unresolvedIssues.add(expected.key);
      // Omitted Self fields depend on this exact source/report proof. A later
      // attribution failure cannot leave the ownership-only result resolved.
      if (
        scopedSelfProof &&
        provenance.size &&
        (!record.mapping.personId ||
          !selfIdentity?.assignedPerson ||
          !record.identityReview?.assignedPerson)
      )
        unresolved.add(expected.key);
      if (fields.length || provenance.size || ownership.size)
        mismatches.push({
          key: expected.key,
          fields,
          provenance: [...provenance],
          ownership: [...ownership],
        });
    }
  const missing = oracle.assertions
    .filter((item) => !matches.has(item.key))
    .map((item) => item.key);
  const duplicate = [...matches].filter(([, count]) => count > 1).map(([key]) => key);
  const invalidClinical = new Set(
    mismatches
      .filter((item) => item.fields.length || item.provenance.length)
      .map((item) => item.key),
  );
  const invalidOwnership = new Set(
    mismatches.filter((item) => item.ownership.length).map((item) => item.key),
  );
  const exactKeys = oracle.assertions
    .filter((item) => matches.get(item.key) === 1 && !invalidClinical.has(item.key))
    .map((item) => item.key);
  const complete =
    !missing.length && !duplicate.length && !unexpectedRecords && !duplicateOccurrences;
  const clinicalProvenancePassed = complete && !authorityIssues.size && !invalidClinical.size;
  const ownershipResolved =
    complete &&
    !authorityIssues.size &&
    !invalidOwnership.size &&
    !unresolved.size &&
    !unresolvedIssues.size;
  return {
    format: 'circus-large-import-review-grade-v1' as const,
    stage: input.stage,
    passed:
      clinicalProvenancePassed &&
      !invalidOwnership.size &&
      (input.stage === 'proposal' || ownershipResolved),
    clinicalProvenancePassed,
    ownershipResolved,
    reviewReady: clinicalProvenancePassed && ownershipResolved,
    expectedRecords: oracle.assertions.length,
    observedRecords,
    exactRecords: exactKeys.length,
    missing,
    duplicate,
    unexpectedRecords,
    duplicateOccurrences,
    authorityIssues: [...authorityIssues],
    unresolved: [...unresolved],
    unresolvedIssues: [...unresolvedIssues],
    mismatches,
  };
}

function inspectedReport(value: unknown): IntakeReportReference | undefined {
  const report = object(value),
    anchor = object(report.anchor),
    subject = report.subject === null ? null : object(report.subject);
  if (
    typeof report.key !== 'string' ||
    typeof report.title !== 'string' ||
    typeof anchor.text !== 'string' ||
    typeof anchor.locator !== 'string' ||
    (subject !== null && (typeof subject.text !== 'string' || typeof subject.locator !== 'string'))
  )
    return undefined;
  return {
    key: report.key,
    title: report.title,
    anchor: { text: anchor.text, locator: anchor.locator },
    subject:
      subject === null ? null : { text: String(subject.text), locator: String(subject.locator) },
  };
}
function inspectAuthority(
  input: LargeImportReviewAuthority | NativeLargeImportReviewAuthority,
): InspectedReportAuthority {
  const memberships = new Map<string, Set<string>>();
  let complete = true;
  if (!('format' in input)) {
    const { retained, queue, identity } = input;
    for (const version of retained.versions) {
      if (memberships.has(version.id)) complete = false;
      const members = new Set<string>();
      for (const member of version.members)
        for (const occurrence of member.occurrences)
          members.add(
            occurrenceKey(
              occurrence.proposalId,
              occurrence.recordId,
              member.candidateId,
              member.candidateVersionId,
            ),
          );
      memberships.set(version.id, members);
    }
    return {
      id: retained.id,
      sourceFileId: retained.sourceFileId,
      sourceHash: retained.sourceHash,
      memberId: retained.memberId,
      basis: retained.basis,
      report: retained.report ?? undefined,
      queue,
      identity,
      latestVersionId: retained.versions.at(-1)?.id ?? null,
      memberships,
      complete,
    };
  }
  const { group } = input;
  const identity = { ...input.identity, scope: input.inspectedScope ?? input.identity.scope };
  const report = inspectedReport(group.report),
    members = new Set<string>();
  let count = 0;
  const total = input.records[0]?.totalRecords;
  for (const [index, page] of input.records.entries()) {
    if (
      page.intakeId !== group.intakeId ||
      page.version !== group.intakeVersion ||
      page.totalRecords !== total ||
      page.view !== 'all' ||
      index + 1 < input.records.length !== !!page.nextCursor
    )
      complete = false;
    for (const entry of page.records) {
      count++;
      if (
        entry.kind !== 'record' ||
        entry.groupId !== group.groupId ||
        !entry.record.candidateId ||
        !entry.record.candidateVersionId
      ) {
        complete = false;
        continue;
      }
      const refs = entry.record.reportGroups;
      if (!Array.isArray(refs)) {
        complete = false;
        continue;
      }
      // Each public row proves only its actual introducing group-version link.
      for (const reference of refs.filter((ref) => ref.groupId === group.groupId)) {
        let selected = memberships.get(reference.groupVersionId);
        if (!selected) {
          selected = new Set();
          memberships.set(reference.groupVersionId, selected);
        }
        const key = occurrenceKey(
          entry.proposalId,
          entry.record.id,
          entry.record.candidateId,
          entry.record.candidateVersionId,
        );
        if (members.has(key)) complete = false;
        members.add(key);
        selected.add(key);
      }
    }
  }
  if (count !== total || !report || group.groupVersionId === null) complete = false;
  return {
    id: group.groupId,
    sourceFileId: group.intakeId,
    sourceHash: input.sourceHash,
    memberId: group.member?.memberId ?? null,
    basis: group.basis,
    report,
    identity,
    queue: {
      groupId: group.groupId,
      groupVersionId: group.groupVersionId ?? '',
      intakeId: group.intakeId,
      intakeVersion: group.intakeVersion,
      basis: group.basis,
      member: group.member,
      original: group.original,
      anchor: report?.anchor ?? null,
    },
    latestVersionId: group.groupVersionId,
    memberships,
    complete,
  };
}
