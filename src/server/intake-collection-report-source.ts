import { createHash, type Hash } from 'node:crypto';
import type {
  IntakeReportGroupMember,
  IntakeReportSourceConfirmation,
  IntakeReportSourceCoverageEntry,
  IntakeReportSourceScope,
} from '../shared/intake.ts';
import { canonicalLiteral } from './intake-format.ts';
import {
  intakeReportSourceReference,
  intakeReportSourceScope,
  type IntakeReportSourceGroupHeader,
  type IntakeReportSourceVersionHeader,
} from './intake-report-source.ts';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { recordIntakeSerialization, recordIntakeWork } from './intake-work-accounting.ts';

export interface ReportSourceMemberHeader {
  key: string;
  ordinal: number;
  candidateId: string;
  candidateVersionId: string;
  occurrenceCount: number;
  sectionPresent: boolean;
}
type Occurrence = IntakeReportGroupMember['occurrences'][number];
export interface ReportSourceOccurrenceDescriptor {
  readonly ordinal: number;
  readonly key: string;
  readonly sourceIdentity: string;
}
/** Capabilities are minted from selected immutable snapshots or the caller's pinned staged build. */
export interface ReportSourceMemberSnapshot {
  memberAt?(ordinal: number): ReportSourceMemberHeader | undefined;
  member(candidateId: string, candidateVersionId: string): ReportSourceMemberHeader | undefined;
  members(options: { after?: string; items: number; bytes: number }): {
    members: ReportSourceMemberHeader[];
    complete: boolean;
    after: string | null;
  };
  occurrences(
    member: ReportSourceMemberHeader,
    options: { after?: string; items: number; bytes: number },
  ): { occurrences: Occurrence[]; complete: boolean; after: string | null };
  hasOccurrence(member: ReportSourceMemberHeader, occurrence: Occurrence): boolean;
  canonicalMember(member: ReportSourceMemberHeader): Iterable<string>;
  occurrenceDescriptors?(
    member: ReportSourceMemberHeader,
    options: { after?: string; items: number; bytes: number },
  ): { occurrences: ReportSourceOccurrenceDescriptor[]; complete: boolean; after: string | null };
  canonicalOccurrence?(occurrence: ReportSourceOccurrenceDescriptor): Iterable<string>;
  hasSourceOccurrenceIdentity?(member: ReportSourceMemberHeader, identity: string): boolean;
  hasAnySourceOccurrenceIdentity?(
    candidateId: string,
    candidateVersionId: string,
    identity: string,
  ): boolean;
}
export type ReportSourceConfirmationHeader = Omit<
  IntakeReportSourceConfirmation,
  'members' | 'extensions' | 'coverageEntries'
>;
export interface SelectedReportSourceConfirmation {
  header: ReportSourceConfirmationHeader;
  hasExtension(groupVersionId: string): boolean;
  hasMember(member: Pick<ReportSourceMemberHeader, 'candidateId' | 'candidateVersionId'>): boolean;
  hasOccurrence(member: ReportSourceMemberHeader, occurrence: Occurrence): boolean;
  hasOccurrenceIdentity?(member: ReportSourceMemberHeader, identity: string): boolean;
  /** Exact compatible explicit entry with the smallest retained ID, never an inferred authority. */
  authorityEntry(scope: IntakeReportSourceScope): string | undefined;
}
/** Selected group authority keeps arbitrary retained anchor/subject text behind a checked streaming fingerprint. */
export interface ReportSourceGroupAuthority {
  format: 'health-intake-report-source-group-authority-v1';
  id: string;
  scope(
    version: IntakeReportSourceVersionHeader,
    basis: ReportSourceConfirmationHeader['basis'],
  ): IntakeReportSourceScope | null;
  reference(version: IntakeReportSourceVersionHeader): IntakeReportSourceCoverageEntry['sourceRef'];
}
const isGroupAuthority = (
  group: IntakeReportSourceGroupHeader | ReportSourceGroupAuthority,
): group is ReportSourceGroupAuthority =>
  'format' in group &&
  group.format === 'health-intake-report-source-group-authority-v1' &&
  typeof group.scope === 'function' &&
  typeof group.reference === 'function';
export interface ReportSourceExtensionInput {
  group: IntakeReportSourceGroupHeader | ReportSourceGroupAuthority;
  version: IntakeReportSourceVersionHeader;
  current: ReportSourceMemberSnapshot;
  /** Complete prior occurrence union; the immediate predecessor suffices only with proven cumulative membership. */
  prior?: ReportSourceMemberSnapshot;
  confirmation: SelectedReportSourceConfirmation;
  contributed(member: ReportSourceMemberHeader): boolean;
  pendingUnaccepted(member: ReportSourceMemberHeader): boolean;
  assertCurrent(): void;
}
export type ReportSourceExtensionEvent =
  | { kind: 'checkpoint' }
  | { kind: 'member'; member: ReportSourceMemberHeader }
  | { kind: 'coverage'; entry: IntakeReportSourceCoverageEntry; extensionId: string }
  | {
      kind: 'coverage-reference';
      extensionId: string;
      entry: Omit<IntakeReportSourceCoverageEntry, 'occurrence'>;
      occurrence: ReportSourceOccurrenceDescriptor;
      canonicalOccurrence: () => Iterable<string>;
    }
  | {
      kind: 'complete';
      header: {
        id: string;
        groupVersionId: string;
        contextId: string;
        at: string;
        authorityEntryId?: string;
      };
      memberCount: number;
      coverageEntryCount: number;
    };

const literal = (value: unknown) => recordIntakeSerialization(canonicalLiteral(value));
const hash = () => {
  recordIntakeWork('hashCalls');
  return createHash('sha256');
};
const update = (target: Hash, text: string) => {
  recordIntakeWork('hashedBytes', Buffer.byteLength(text));
  target.update(text);
};
function* members(
  snapshot: ReportSourceMemberSnapshot,
  check: () => void,
): Generator<ReportSourceMemberHeader> {
  let after: string | undefined;
  do {
    check();
    const page = snapshot.members({ after, items: 64, bytes: 128 * 1024 });
    for (const member of page.members) {
      check();
      yield member;
    }
    if (page.complete) return;
    if (!page.after || page.after === after || !page.members.length)
      throw Error('Report source member page did not advance');
    after = page.after;
  } while (true);
}
function* occurrences(
  snapshot: ReportSourceMemberSnapshot,
  member: ReportSourceMemberHeader,
  check: () => void,
): Generator<Occurrence> {
  let after: string | undefined;
  do {
    check();
    const page = snapshot.occurrences(member, { after, items: 64, bytes: 128 * 1024 });
    for (const occurrence of page.occurrences) {
      check();
      yield occurrence;
    }
    if (page.complete) return;
    if (!page.after || page.after === after || !page.occurrences.length)
      throw Error('Report source occurrence page did not advance');
    after = page.after;
  } while (true);
}

/** Concrete eligibility join. It preserves first candidate occurrence and last retained version semantics. */
export function pendingUnacceptedSourceMember(
  view: IntakeCollectionEnvelopeReader,
  workflow: IntakeEnvelopeRecord,
  member: ReportSourceMemberHeader,
  decisionView: IntakeCollectionEnvelopeReader = view,
): boolean {
  const candidate = view.find('candidate', workflow, member.candidateId);
  if (!candidate) return false;
  const count = view.childCount(candidate, 'versions'),
    version = count ? view.childAt(candidate, 'versions', count - 1) : undefined;
  if (!version) return false;
  const id = view.field(version, 'id'),
    status = view.field(version, 'status');
  if (id.kind !== 'value' || status.kind !== 'value')
    throw Error('Report source candidate header is unavailable');
  if (id.value !== member.candidateVersionId || status.value !== 'pending') return false;
  const accepted = decisionView.lookup('accepted-candidate-version', [
    JSON.stringify(member.candidateId),
    member.candidateVersionId,
  ]);
  if (!accepted) return true;
  const selectedId = decisionView.field(accepted, 'candidateId'),
    selectedVersion = decisionView.field(accepted, 'candidateVersionId'),
    action = decisionView.field(accepted, 'action');
  if (
    selectedId.kind !== 'value' ||
    selectedId.value !== member.candidateId ||
    selectedVersion.kind !== 'value' ||
    selectedVersion.value !== member.candidateVersionId ||
    action.kind !== 'value' ||
    action.value !== 'accept'
  )
    throw Error('Report source acceptance index target changed');
  return false;
}

/**
 * Emits selected members/changed occurrence coverage followed by the exact old
 * extension ID. The caller stages events into one owned catalog; only the final
 * domain transaction may select its new descriptor. No event accepts records.
 * Cumulative ID hashing remains linear work and is charged; memory is one page.
 */
export function* reportSourceExtensionEvents(
  input: ReportSourceExtensionInput,
): Generator<ReportSourceExtensionEvent> {
  const { group, version, confirmation, current, prior } = input,
    header = confirmation.header;
  input.assertCurrent();
  if (
    header.groupId !== group.id ||
    header.groupVersionId === version.id ||
    confirmation.hasExtension(version.id)
  )
    return;
  const explicit = header.basis === 'explicit_current_members',
    basis = explicit ? 'manual_report_label' : header.basis,
    scope = isGroupAuthority(group)
      ? group.scope(version, basis)
      : intakeReportSourceScope(group, version, basis);
  const authorityEntryId = explicit && scope ? confirmation.authorityEntry(scope) : undefined;
  if (
    explicit
      ? !authorityEntryId
      : !header.scope || !scope || literal(header.scope) !== literal(scope)
  )
    return;
  const contextId =
    header.basis === 'manual_report_label' ? version.id : version.context?.contextId || version.id;
  const extension = hash();
  update(
    extension,
    '[' + literal(header.operationId) + ',' + literal(version.id) + ',' + literal(contextId) + ',[',
  );
  let memberCount = 0,
    coverageEntryCount = 0,
    visited = 0;
  function* checkpoint(): Generator<ReportSourceExtensionEvent> {
    if (++visited % 64 !== 0) return;
    input.assertCurrent();
    yield { kind: 'checkpoint' };
    input.assertCurrent();
  }
  for (const member of members(current, input.assertCurrent)) {
    yield* checkpoint();
    if (
      !confirmation.hasMember(member) &&
      (!input.contributed(member) || !input.pendingUnaccepted(member))
    )
      continue;
    if (memberCount++) update(extension, ',');
    update(
      extension,
      literal({ candidateId: member.candidateId, candidateVersionId: member.candidateVersionId }),
    );
    yield { kind: 'member', member };
  }
  update(extension, ']]');
  const id = 'report-source-extension:' + extension.digest('hex');
  if (explicit && authorityEntryId) {
    const sourceRef = isGroupAuthority(group)
        ? group.reference(version)
        : intakeReportSourceReference(group, version),
      suffix = ',' + literal(sourceRef) + ']';
    for (const member of members(current, input.assertCurrent)) {
      yield* checkpoint();
      if (!input.contributed(member)) continue;
      function* priorHas(occurrence: Occurrence): Generator<ReportSourceExtensionEvent, boolean> {
        if (!prior) return false;
        for (const retained of members(prior, input.assertCurrent)) {
          yield* checkpoint();
          if (
            retained.candidateId === member.candidateId &&
            retained.candidateVersionId === member.candidateVersionId &&
            prior.hasOccurrence(retained, occurrence)
          )
            return true;
        }
        return false;
      }
      // Fork the hash after the exact full member grammar once per member, not once per occurrence.
      let prefix: Hash | undefined;
      function* entryId(pieces: Iterable<string>): Generator<ReportSourceExtensionEvent, string> {
        if (!prefix) {
          prefix = hash();
          update(prefix, '[' + literal(header.operationId) + ',' + literal(authorityEntryId) + ',');
          for (const chunk of current.canonicalMember(member)) {
            yield* checkpoint();
            input.assertCurrent();
            update(prefix, chunk);
          }
          update(prefix, ',');
        }
        recordIntakeWork('hashCalls');
        const target = prefix.copy();
        for (const chunk of pieces) {
          yield* checkpoint();
          input.assertCurrent();
          update(target, chunk);
        }
        update(target, suffix);
        return 'report-source-coverage:' + target.digest('hex');
      }
      if (current.occurrenceDescriptors) {
        if (
          !current.canonicalOccurrence ||
          !confirmation.hasOccurrenceIdentity ||
          (prior && !prior.hasAnySourceOccurrenceIdentity)
        )
          throw Error('Native source occurrence capabilities are incomplete');
        let after: string | undefined;
        do {
          input.assertCurrent();
          const page = current.occurrenceDescriptors(member, {
            after,
            items: 64,
            bytes: 128 * 1024,
          });
          for (const occurrence of page.occurrences) {
            yield* checkpoint();
            if (
              confirmation.hasOccurrenceIdentity(member, occurrence.sourceIdentity) ||
              (prior &&
                prior.hasAnySourceOccurrenceIdentity!(
                  member.candidateId,
                  member.candidateVersionId,
                  occurrence.sourceIdentity,
                ))
            )
              continue;
            const canonicalOccurrence = () => current.canonicalOccurrence!(occurrence);
            const entry = {
              id: yield* entryId(canonicalOccurrence()),
              candidateId: member.candidateId,
              candidateVersionId: member.candidateVersionId,
              sourceRef,
            };
            coverageEntryCount++;
            yield {
              kind: 'coverage-reference',
              entry,
              occurrence,
              canonicalOccurrence,
              extensionId: id,
            };
          }
          if (page.complete) break;
          if (!page.after || page.after === after || !page.occurrences.length)
            throw Error('Report source occurrence descriptor page did not advance');
          after = page.after;
        } while (true);
      } else
        for (const occurrence of occurrences(current, member, input.assertCurrent)) {
          yield* checkpoint();
          if (confirmation.hasOccurrence(member, occurrence) || (yield* priorHas(occurrence)))
            continue;
          const entry: IntakeReportSourceCoverageEntry = {
            id: yield* entryId([literal(occurrence)]),
            candidateId: member.candidateId,
            candidateVersionId: member.candidateVersionId,
            occurrence: { ...occurrence },
            sourceRef,
          };
          coverageEntryCount++;
          yield { kind: 'coverage', entry, extensionId: id };
        }
    }
  }
  input.assertCurrent();
  yield {
    kind: 'complete',
    header: {
      id,
      groupVersionId: version.id,
      contextId,
      at: version.createdAt,
      ...(coverageEntryCount ? { authorityEntryId } : {}),
    },
    memberCount,
    coverageEntryCount,
  };
}
