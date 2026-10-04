import { ownershipBlockerStoreForPlan } from './ownership-blocker-store.ts';
import { ownershipBlockerCount } from './ownership-preview-store.ts';
import { duplicateRecord, verifyDuplicateOriginals } from './duplicate-review.ts';
import { prepareOwnershipMatchEvidenceSteps } from './ownership-match-evidence.ts';
import { setImmediate } from 'node:timers/promises';
import { splitOwnershipExtra, reconcileOwnershipAttachments } from './ownership-projection.ts';
import {
  ownershipCommitGroups,
  ownershipGroupRequest,
  ownershipPlans,
  retainOwnershipPlan,
  childOwnershipOperation,
  combineOwnershipReceipts,
} from './ownership-groups.ts';
import { ownershipRequest as request, object, text, invalid } from './record-ownership-input.ts';
import {
  HttpError,
  json,
  now,
  revision,
  clinicalReviewRevision,
  transaction,
  type Database,
} from './database.ts';
import { ownershipClinicalHeader as clinicalRecord } from './ownership-clinical-header.ts';
import { clinicalTables, type ClinicalKind } from './clinical-references.ts';
import {
  clinicalVersion,
  checkClinicalMapping,
  insertClinicalProjection,
  mappingFrom,
  assetProblem,
  activeMappingRules,
} from './clinical-import.ts';
import { getNote, createIntakeFamilyPersonInTransaction } from './notes.ts';
import { getIntake, reviewIntake, verifyIntakeOriginal } from './intake.ts';
import { getIntakeIdentityReview } from './intake-identity.ts';
import { relatedRecordIds } from './related-records.ts';
import { clinicalRelationshipProjection } from './clinical-relationships.ts';
import {
  ownershipContributions,
  retainAcceptedContribution,
  type SourceContribution,
} from './ownership-contributions.ts';
import {
  ownershipContributionSequence,
  iterateOwnershipStreamContributions,
  contributionMappingSteps,
  type OwnershipContributionSequence,
  type OwnershipStreamContribution,
} from './ownership-contribution-stream.ts';
import type { OwnershipReportPreviewRecord } from '../shared/ownership-report-reference.ts';
import { ownershipHash as digest, appendOwnershipDecision } from './ownership-journal.ts';
import {
  ownershipIdentityBlockers,
  ownershipReportHolds,
  ownershipReportBoundary,
  ownershipEnvelopeHash,
  ownershipMappingHash,
  ownershipIdentityIssues,
} from './record-ownership-authority.ts';
import { previewOwnershipNames, commitOwnershipNames } from './ownership-names.ts';
import type { OwnershipScopeIndex } from './ownership-scope-index.ts';
import type { OwnershipPreviewSink, OwnershipCommitView } from './ownership-preview-store.ts';
import type { PreparedOwnershipNamePlan } from './ownership-name-plan.ts';
import { ownershipIntakeScopes } from './ownership-intake-scopes.ts';
import { ownershipOutcomeDigest } from './ownership-outcome-page.ts';
import { hasIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import { prepareCollectionClinicalReview } from './intake-review-collection-host.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import { prepareCollectionReviewMembership } from './intake-review-membership-index.ts';
import { intakeSourceMetadata } from './intake-state-access.ts';
import { workflowHash } from './intake-workflow.ts';
import type { SelectedOwnershipReviewScope } from './record-ownership-authority.ts';
import type { IntakeIdentityPerson } from '../shared/intake-identity.ts';
import type { IntakeClinicalMapping, IntakeReportGroup, IntakeReview } from '../shared/intake.ts';
import type {
  OwnershipRequest,
  OwnershipPreview,
  OwnershipPreviewRecord,
  OwnershipCommit,
  OwnershipReceipt,
} from '../shared/record-ownership.ts';

function owner(db: Database, profileId: string) {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Ownership correction belongs to another profile');
}
function nativeOwnershipSource(db: Database, intakeId: string) {
  const source = db
    .prepare('SELECT id,kind,sha256,details_json,provider_id FROM source_files WHERE id=?')
    .get(intakeId);
  return source && hasIntakeCollectionEnvelope(db, source as { id: string }) ? source : undefined;
}
function person(db: Database, noteId: string, allowArchived = false): IntakeIdentityPerson {
  const note = getNote(db, noteId);
  if (note.kind !== 'person' || (!allowArchived && note.archived) || !note.personId)
    throw new HttpError(409, 'OWNERSHIP_DESTINATION', 'Choose an active person in this profile');
  return {
    noteId,
    personId: note.personId,
    version: note.version,
    fullName: note.person.fullName || note.title || 'Self',
    birthDate: note.person.birthDate || null,
    relationship: note.person.relationship || null,
  };
}
function personForId(db: Database, id: string) {
  const row = db.prepare("SELECT id FROM notes WHERE kind='person' AND person_id=?").get(id);
  if (!row) throw new HttpError(409, 'OWNERSHIP_PERSON', 'The current owner has no People entry');
  return person(db, String(row.id), true);
}
export function ownershipPeople(db: Database, profileId: string) {
  owner(db, profileId);
  return db
    .prepare("SELECT id FROM notes WHERE kind='person' ORDER BY person_id='patient' DESC,title,id")
    .all()
    .flatMap((row) => {
      const note = getNote(db, String(row.id));
      return note.archived ? [] : [person(db, note.id)];
    });
}
function reportSelection(
  db: Database,
  root: string,
  profileId: string,
  selected: OwnershipRequest,
) {
  const sources = new Set<string>();
  const pending: OwnershipPreview['pending'] = [];
  let refs = selected.selection.type === 'records' ? selected.selection.records : [];
  let report: { group: IntakeReportGroup; sourceHash: string; boundary: string } | null = null;
  if (selected.selection.type === 'report') {
    const selection = selected.selection;
    const intake = getIntake(db, root, profileId, selection.intakeId);
    const group = intake.workflow?.reportGroups?.find((g) => g.id === selection.groupId);
    const version = group?.versions.at(-1);
    if (!group || !version || version.id !== selection.groupVersionId)
      throw new HttpError(
        409,
        'OWNERSHIP_CHANGED',
        'Report membership changed; review the report again',
      );
    const sourceHash = String(
      db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(intake.id)?.sha256,
    );
    report = { group, sourceHash, boundary: ownershipReportBoundary(intake.id, sourceHash, group) };
    for (const member of version.members)
      for (const occurrence of member.occurrences) {
        sources.add(occurrence.recordId);
        const candidate = intake.workflow?.candidates
          .find((c) => c.id === member.candidateId)
          ?.versions.find((v) => v.id === member.candidateVersionId);
        if (candidate?.status === 'pending')
          pending.push({
            recordId: occurrence.recordId,
            candidateId: member.candidateId,
            candidateVersionId: member.candidateVersionId,
          });
      }
    const found = new Map<string, { kind: ClinicalKind; recordId: string }>();
    for (const sourceId of sources)
      for (const [kind, table] of Object.entries(clinicalTables))
        for (const row of db
          .prepare(
            `SELECT id FROM ${table} WHERE source_record_id=? UNION SELECT entity_id id FROM evidence WHERE entity_type=? AND source_record_id=?`,
          )
          .iterate(sourceId, kind, sourceId)) {
          if (db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(row.id))
            found.set(kind + ':' + row.id, {
              kind: kind as ClinicalKind,
              recordId: String(row.id),
            });
        }
    refs = [...found.values()].sort((a, b) =>
      (a.kind + a.recordId).localeCompare(b.kind + b.recordId),
    );
  }
  return { sources, pending, refs, report };
}
/** Ground originals before opening the synchronous, pinned preview/publication transaction. */
export async function prepareOwnershipEvidence(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
  scopes?: OwnershipScopeIndex,
) {
  owner(db, profileId);
  const selected = request(input);
  const selection = reportSelection(db, root, profileId, selected);
  const groups = new Map<string, { intakeId: string; groupId: string }>();
  let prepared = 0;
  if (selected.selection.type === 'report')
    groups.set(selected.selection.groupId, selected.selection);
  for (const ref of selection.refs)
    for (const contribution of iterateOwnershipStreamContributions(db, ref.kind, ref.recordId, {
      scopes: scopes?.contributionValues.bind(scopes),
    })) {
      const native = nativeOwnershipSource(db, contribution.intakeId);
      if (native) {
        const mappingVersion = () =>
          workflowHash(
            activeMappingRules(
              db,
              intakeSourceMetadata(db, contribution.intakeId).metadata?.sourceProviderId ||
                (native.provider_id as string),
            ),
          );
        const ready = await prepareCollectionWorkflowReadiness(
          db,
          root,
          profileId,
          contribution.intakeId,
          { mappingVersion: mappingVersion(), currentMappingVersion: mappingVersion },
        );
        if (ready.state !== 'ready')
          throw new HttpError(
            409,
            'OWNERSHIP_REVIEW_PENDING',
            'Complete selected clinical evidence is still pending',
          );
        await prepareCollectionReviewMembership(db, { id: contribution.intakeId });
        const proposal = contribution.sourceRecordId.replace(/:line:\d+$/, '');
        const review = prepareCollectionClinicalReview(
          db,
          root,
          profileId,
          contribution.intakeId,
          proposal === contribution.intakeId ? null : proposal,
        );
        if (review.status !== 'ready')
          throw new HttpError(
            409,
            'OWNERSHIP_REVIEW_FRAGMENT',
            'Selected clinical evidence requires its complete addressed reference',
          );
        review.session.close();
        if (++prepared % 32 === 0) await setImmediate();
        continue;
      }
      const intake = getIntake(db, root, profileId, contribution.intakeId);
      for (const group of intake.workflow?.reportGroups || [])
        if (
          group.versions
            .at(-1)
            ?.members.some((m) =>
              m.occurrences.some((o) => o.recordId === contribution.sourceRecordId),
            )
        )
          groups.set(group.id, { intakeId: intake.id, groupId: group.id });
    }
  for (const group of groups.values()) {
    if (nativeOwnershipSource(db, group.intakeId)) continue;
    await getIntakeIdentityReview(db, root, profileId, group.intakeId, group.groupId);
  }
}
function normalized(
  mapping: IntakeClinicalMapping,
  source: Pick<SourceContribution, 'envelope'>,
  kind: ClinicalKind,
  personId: string,
) {
  // Reuse the import's literal normalization and validation; a split never fabricates required values.
  const mapped = mappingFrom({ value: { ...source.envelope, clinical: mapping } });
  return {
    ...mapped,
    kind,
    personId,
    subject: personId === 'patient' ? 'self' : 'other',
  } as typeof mapped & IntakeClinicalMapping;
}
export interface OwnedReportOwnershipSelection {
  sources: ReadonlySet<string>;
  refs: Iterable<import('../shared/record-ownership.ts').OwnershipRecordReference>;
  pending: Iterable<OwnershipPreview['pending'][number]>;
  hasRecord(kind: string, id: string): boolean;
  boundary: string;
}
/** Read-only preview. Publication repeats all reads under the same durable transaction. */
function* ownershipPreviewSteps(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
  owned?: {
    namePlan?: PreparedOwnershipNamePlan;
    blockerStore?: import('./ownership-blocker-store.ts').OwnershipBlockerStore;
    selection?: OwnedReportOwnershipSelection;
    sink?: OwnershipPreviewSink;
    scopes?: OwnershipScopeIndex;
    reviewSource?: (
      intakeId: string,
      sourceId: string,
    ) => { review: IntakeReview; ownership?: SelectedOwnershipReviewScope };
    decision?: (recordId: string) => NonNullable<OwnershipRequest['decisions']>[number] | undefined;
    relationshipDecision?: (id: string) => boolean;
    contributions?: (kind: ClinicalKind, recordId: string) => OwnershipContributionSequence;
    captureNameScopes?: (
      sources: ReadonlySet<string>,
      owners: ReadonlySet<string>,
      request: OwnershipRequest,
    ) => void;
  },
): Generator<void, OwnershipPreview> {
  owner(db, profileId);
  const selected = request(input);
  const destination =
    'newPerson' in selected.destination
      ? selected.destination
      : person(db, selected.destination.noteId);
  if (
    'personId' in destination &&
    destination.version !== (selected.destination as { expectedVersion: number }).expectedVersion
  )
    throw new HttpError(409, 'OWNERSHIP_CHANGED', 'The destination changed; review it again');
  const destinationId = 'personId' in destination ? destination.personId : 'new-person';
  const selection = owned?.selection
    ? { ...owned.selection, report: null }
    : reportSelection(db, root, profileId, selected);
  const selectedSources = owned?.sink?.sources ?? new Set(selection.sources),
    oldOwners = owned?.sink?.owners ?? new Set<string>();
  const reviews = new Map<
    string,
    { review: IntakeReview; ownership?: SelectedOwnershipReviewScope; close?(): void }
  >();
  try {
    const getReview = (intakeId: string, sourceId: string) => {
      if (owned?.reviewSource) return owned.reviewSource(intakeId, sourceId);
      const proposal = sourceId.replace(/:line:\d+$/, '');
      const key = intakeId + ':' + proposal;
      if (!reviews.has(key)) {
        if (nativeOwnershipSource(db, intakeId)) {
          const selected = prepareCollectionClinicalReview(
            db,
            root,
            profileId,
            intakeId,
            proposal === intakeId ? null : proposal,
          );
          if (selected.status !== 'ready')
            throw new HttpError(
              409,
              'OWNERSHIP_REVIEW_FRAGMENT',
              'Selected clinical evidence requires its complete addressed reference',
            );
          // A native proposal retains at most one complete bounded review here.
          for (const review of reviews.values()) review.close?.();
          reviews.clear();
          reviews.set(key, {
            review: selected.session.review,
            ownership: selected.session.ownership,
            close: () => selected.session.close(),
          });
        } else
          reviews.set(key, {
            review: reviewIntake(
              db,
              root,
              profileId,
              intakeId,
              proposal === intakeId ? null : proposal,
            ),
          });
      }
      return reviews.get(key)!;
    };
    const pins = owned?.sink
      ? {
          push(...values: string[]) {
            for (const value of values) owned.sink!.pin(value);
          },
        }
      : ([] as string[]);
    const relationships =
      owned?.sink?.relationships ?? new Map<string, OwnershipPreview['relationships'][number]>();
    const records: OwnershipPreviewRecord[] = [];
    let visited = 0;
    for (const ref of selection.refs) {
      const item = yield* (function* (): Generator<void, OwnershipReportPreviewRecord> {
        const record = clinicalRecord(db, ref.kind, ref.recordId);
        const version = digest(record.row);
        if (ref.version !== undefined && ref.version !== version)
          throw new HttpError(
            409,
            'OWNERSHIP_CHANGED',
            'A selected record changed; review it again',
          );
        const oldId =
          ref.kind === 'document'
            ? String(record.extra.import.personId || 'patient')
            : String(record.row.person_id || 'patient');
        const contributions =
          owned?.contributions?.(ref.kind, ref.recordId) ??
          ownershipContributionSequence(db, ref.kind, ref.recordId, {
            scopes: owned?.scopes?.contributionValues.bind(owned.scopes),
          });
        const included = contributions.filter(
          (c) => selected.selection.type === 'records' || selection.sources.has(c.sourceRecordId),
        );
        const remaining = contributions.filter(
          (c) => selected.selection.type !== 'records' && !selection.sources.has(c.sourceRecordId),
        );
        let source: OwnershipStreamContribution | undefined,
          firstRemaining: OwnershipStreamContribution | undefined,
          includedMapping: IntakeClinicalMapping | null | undefined,
          leftMapping: IntakeClinicalMapping | null | undefined;
        for (const c of contributions) {
          if (selected.selection.type === 'records' || selection.sources.has(c.sourceRecordId)) {
            source ??= c;
            includedMapping ||= c.acceptedMapping;
          } else {
            firstRemaining ??= c;
            leftMapping ||= c.acceptedMapping;
          }
          if (++visited % 32 === 0) yield;
        }
        const split = firstRemaining !== undefined;
        const unchanged = oldId === destinationId;
        const blockerBucket = (owned?.sink ?? owned?.blockerStore?.sink)?.blockerBucket(
          ref.kind + ':' + ref.recordId,
        );
        const blockerValues = new Set<string>(),
          blockers = {
            push(...values: string[]) {
              if (blockerBucket) for (const value of values) blockerBucket.push(value);
              else for (const value of values) blockerValues.add(value);
            },
            [Symbol.iterator]() {
              return (blockerBucket ? blockerBucket.values() : blockerValues)[Symbol.iterator]();
            },
          };
        const decision = owned?.decision
          ? owned.decision(ref.recordId)
          : selected.decisions?.find((d) => d.recordId === ref.recordId);
        if (!source) blockers.push('No source contribution belongs to this selection.');
        if (!unchanged) {
          oldOwners.add(oldId);
          for (const c of included) {
            selectedSources.add(c.sourceRecordId);
            if (++visited % 32 === 0) yield;
          }
        }
        for (const c of contributions) {
          verifyIntakeOriginal(db, root, profileId, c.sourceFileId);
          pins.push(c.version);
          if (++visited % 32 === 0) yield;
        }
        for (const c of included) {
          const selectedReview = getReview(c.intakeId, c.sourceRecordId);
          const occurrence = selectedReview.review.records.find((r) => r.id === c.sourceRecordId);
          if (!occurrence) blockers.push('The accepted source no longer has a reviewable mapping.');
          else {
            pins.push(digest(occurrence.identityReview));
            for (const blocker of ownershipIdentityBlockers(
              db,
              c.intakeId,
              occurrence,
              'personId' in destination ? destination.birthDate : null,
              selectedReview.ownership,
            ))
              blockers.push(blocker);
          }
          if (++visited % 32 === 0) yield;
        }
        const proposed = split ? includedMapping : (record.mapping as IntakeClinicalMapping);
        const mapping = source
          ? normalized(decision?.splitMapping || proposed || {}, source, ref.kind, destinationId)
          : (record.mapping as IntakeClinicalMapping);
        let remainingMapping: IntakeClinicalMapping | undefined;
        if (split) {
          remainingMapping = normalized(
            decision?.remainingMapping || leftMapping || {},
            firstRemaining!,
            ref.kind,
            oldId,
          );
          if (!decision?.reviewedSplit)
            blockers.push(
              'Review both the transferred and remaining clinical contents with their original sources.',
            );
          const incomingProblem = checkClinicalMapping(
            mapping as Parameters<typeof checkClinicalMapping>[0],
          );
          const remainingProblem = checkClinicalMapping(
            remainingMapping as Parameters<typeof checkClinicalMapping>[0],
          );
          if (incomingProblem) blockers.push('Transferred record: ' + incomingProblem);
          if (remainingProblem) blockers.push('Remaining record: ' + remainingProblem);
          for (const [contents, contribution] of [
            [mapping, source],
            [remainingMapping, firstRemaining],
          ] as const)
            if (contribution) {
              const file = db
                .prepare('SELECT * FROM source_files WHERE id=?')
                .get(contribution.sourceFileId);
              const problem = assetProblem(
                db,
                file as unknown as Parameters<typeof assetProblem>[1],
                contents as Parameters<typeof assetProblem>[2],
              );
              if (problem) blockers.push(problem);
            }
          if (
            (yield* contributionMappingSteps(included, ownershipMappingHash)) &&
            !decision?.splitMapping
          )
            blockers.push(
              'Choose exact transferred values; source contributions are incomplete or disagree.',
            );
          if (
            (yield* contributionMappingSteps(remaining, ownershipMappingHash)) &&
            !decision?.remainingMapping
          )
            blockers.push(
              'Choose exact remaining values; source contributions are incomplete or disagree.',
            );
        } else if (decision?.splitMapping || decision?.remainingMapping || decision?.reviewedSplit)
          blockers.push('Clinical content changes belong only to a reviewed contribution split.');
        const matches: OwnershipReportPreviewRecord['matches'] = [];
        if (destinationId !== 'new-person' && !unchanged) {
          let cursor: string | undefined;
          do {
            const page = relatedRecordIds(
              db,
              { kind: ref.kind, mapping, identity: '' },
              { limit: 50, ...(cursor ? { cursor } : {}) },
            );
            for (const match of page.matches)
              if (match.id !== ref.recordId) {
                const target = clinicalRecord(db, ref.kind, match.id);
                if (owned?.sink) {
                  const evidence = yield* prepareOwnershipMatchEvidenceSteps(
                    db,
                    root,
                    profileId,
                    ref.kind,
                    match.id,
                    owned.sink,
                    owned.scopes,
                  );
                  pins.push(digest([target.row, evidence.digest]));
                  matches.push({
                    recordId: match.id,
                    version: digest(target.row),
                    title: String(target.row.title || target.row.label || match.id),
                    evidence: evidence.reference,
                    mapping: target.mapping as IntakeClinicalMapping,
                  });
                  continue;
                }
                const comparison = duplicateRecord(db, ref.kind, match.id);
                verifyDuplicateOriginals(db, root, profileId, comparison, new Set());
                const targetSources = ownershipContributions(db, ref.kind, match.id, {
                  scopes: owned?.scopes?.contributions.bind(owned.scopes),
                });
                for (const c of targetSources)
                  verifyIntakeOriginal(db, root, profileId, c.sourceFileId);
                pins.push(digest([target.row, comparison, targetSources]));
                matches.push({
                  recordId: match.id,
                  version: digest(target.row),
                  title: comparison.title,
                  evidence: comparison.evidence.map(
                    ({ label, locator, sourceRecordId, contentUrl }) => ({
                      label,
                      locator,
                      sourceRecordId,
                      contentUrl,
                    }),
                  ),
                  mapping: target.mapping as IntakeClinicalMapping,
                });
              }
            if (page.page.truncated)
              blockers.push(
                'Destination matching exceeds its supported bound; narrow the saved selection after reviewing matches.',
              );
            cursor = page.page.nextCursor || undefined;
          } while (cursor);
        }
        if (matches.length && !decision?.action)
          blockers.push('Choose whether to link a destination match or keep both.');
        if (
          decision?.action === 'link' &&
          !matches.some((m) => m.recordId === decision.targetRecordId)
        )
          blockers.push('The selected match is not a current destination record.');
        const relationship = clinicalRelationshipProjection(db, profileId, ref);
        pins.push(digest(relationship));
        if (relationship.truncated)
          blockers.push('Review the complete relationship graph before correcting ownership.');
        if (!unchanged)
          for (const r of relationship.relationships)
            if (r.status !== 'withdrawn') {
              const other =
                r.request.left.recordId === ref.recordId ? r.request.right : r.request.left;
              const movingTogether =
                !split &&
                (owned?.selection
                  ? owned.selection.hasRecord(other.kind, other.recordId)
                  : [...selection.refs].some(
                      (r) => r.kind === other.kind && r.recordId === other.recordId,
                    )) &&
                !(owned?.decision
                  ? owned.decision(other.recordId)?.action === 'link'
                  : selected.decisions?.some(
                      (d) => d.recordId === other.recordId && d.action === 'link',
                    ));
              // Coupled records still need renewed relationship review after clinical-version changes.
              const resolution = (
                owned?.relationshipDecision
                  ? owned.relationshipDecision(r.decisionId)
                  : selected.relationshipDecisions?.some((d) => d.decisionId === r.decisionId)
              )
                ? 'withdraw'
                : null;
              if (movingTogether && !split && decision?.action !== 'link' && !resolution)
                relationships.set(r.decisionId, {
                  decisionId: r.decisionId,
                  recordId: ref.recordId,
                  otherRecordId: other.recordId,
                  action: r.request.action,
                  resolution: 'move_together',
                });
              if (!movingTogether || split || decision?.action === 'link' || resolution) {
                relationships.set(r.decisionId, {
                  decisionId: r.decisionId,
                  recordId: ref.recordId,
                  otherRecordId: other.recordId,
                  action: r.request.action,
                  resolution,
                });
                if (!resolution)
                  blockers.push(
                    'Explicitly withdraw the affected relationship or include its dependent record in a new selection.',
                  );
              }
            }
        const nativeReport =
          source && nativeOwnershipSource(db, source.intakeId)
            ? (owned?.scopes
                ? owned.scopes.scopes(source.intakeId, source.sourceRecordId, {
                    latestOnly: true,
                    subject: false,
                    version: true,
                  })
                : ownershipIntakeScopes(db, source.intakeId, source.sourceRecordId, {
                    latestOnly: true,
                    subject: false,
                    version: true,
                  })
              ).next().value
            : undefined;
        const intake =
          source && !nativeOwnershipSource(db, source.intakeId)
            ? getIntake(db, root, profileId, source.intakeId)
            : null;
        const group = intake?.workflow?.reportGroups?.find((g) =>
          g.versions
            .at(-1)
            ?.members.some((m) => m.occurrences.some((o) => o.recordId === source?.sourceRecordId)),
        );
        return {
          ...ref,
          version,
          title: String(record.row.label || record.row.title),
          owner: personForId(db, oldId),
          action: unchanged
            ? 'unchanged'
            : decision?.action === 'link'
              ? 'link'
              : split
                ? 'split'
                : 'move',
          mapping,
          remainingMapping,
          splitReviewRequired: split,
          sourceReport: nativeReport
            ? {
                intakeId: source!.intakeId,
                groupId: nativeReport.id,
                groupVersionId: nativeReport.versionId!,
              }
            : group
              ? {
                  intakeId: intake!.id,
                  groupId: group.id,
                  groupVersionId: group.versions.at(-1)!.id,
                }
              : undefined,
          contributions: owned?.sink
            ? yield* owned.sink.contributionSteps(
                ref.kind,
                ref.recordId,
                contributions,
                (id) => selected.selection.type === 'records' || selection.sources.has(id),
              )
            : Array.from(contributions, (c) => ({
                sourceRecordId: c.sourceRecordId,
                sourceFileId: c.sourceFileId,
                reportScopes: [...c.reportScopes()],
                contentUrl: c.contentUrl,
                locator: c.locator,
                version: c.version,
                selected:
                  selected.selection.type === 'records' || selection.sources.has(c.sourceRecordId),
                identity: c.identity,
                acceptedMapping: c.acceptedMapping,
              })),
          matches,
          blockers: unchanged
            ? []
            : blockerBucket
              ? blockerBucket.presentation()
              : [...new Set(blockers)],
          medicationActivity:
            ref.kind === 'medication'
              ? unchanged || decision?.action === 'link'
                ? 'preserved'
                : 'inactive'
              : null,
        };
      })();
      if (owned?.sink)
        owned.sink.record({
          ...item,
          ...(owned.decision?.(item.recordId)
            ? { reviewedDecision: owned.decision(item.recordId) }
            : {}),
        });
      else {
        if (!Array.isArray(item.contributions))
          throw Error('Legacy ownership preview requires complete inline evidence');
        const matches = item.matches.map((match) => {
          if (!Array.isArray(match.evidence))
            throw Error('Legacy ownership preview requires complete inline matches');
          return { ...match, evidence: match.evidence };
        });
        if (!Array.isArray(item.blockers) && !owned?.blockerStore)
          throw Error('Legacy ownership requires complete inline blockers');
        records.push({
          ...item,
          blockers: Array.isArray(item.blockers) ? item.blockers : [],
          ...(!Array.isArray(item.blockers) ? { blockerEvidence: item.blockers } : {}),
          contributions: item.contributions,
          matches,
        });
      }
    }
    const blockerBucket = (owned?.sink ?? owned?.blockerStore?.sink)?.blockerBucket('header');
    const blockerValues: string[] = [];
    const blockers = {
      push(...values: string[]) {
        if (blockerBucket) for (const value of values) blockerBucket.push(value);
        else blockerValues.push(...values);
      },
      [Symbol.iterator]() {
        return (blockerBucket ? blockerBucket.values() : blockerValues)[Symbol.iterator]();
      },
    };
    for (const p of selection.pending) {
      if (selected.selection.type !== 'report') continue;
      const selectedReview = getReview(selected.selection.intakeId, p.recordId);
      const occurrence = selectedReview.review.records.find((r) => r.id === p.recordId);
      if (!occurrence) blockers.push('A pending report member changed.');
      else {
        for (const blocker of ownershipIdentityBlockers(
          db,
          selected.selection.intakeId,
          occurrence,
          'personId' in destination ? destination.birthDate : null,
          selectedReview.ownership,
        ))
          blockers.push(blocker);
        if (
          (occurrence.identityAttribution?.assignedPerson?.personId || 'patient') !== destinationId
        )
          oldOwners.add(occurrence.identityAttribution?.assignedPerson?.personId || 'patient');
        pins.push(digest(occurrence));
        p.personId = occurrence.identityAttribution?.assignedPerson?.personId || 'patient';
      }
      owned?.sink?.pending(p);
    }
    if (
      !(owned?.sink?.recordCount ?? records.length) &&
      !(owned?.sink?.pendingCount ?? [...selection.pending].length)
    )
      blockers.push('There are no clinical records in this selection.');
    owned?.captureNameScopes?.(selectedSources, oldOwners, selected);
    if (owned?.namePlan) {
      owned.namePlan.assertCurrent();
      if (
        (owned.sink
          ? owned.namePlan.sources !== selectedSources || owned.namePlan.owners !== oldOwners
          : digest([...selectedSources].sort()) !== digest([...owned.namePlan.sources].sort()) ||
            digest([...oldOwners].sort()) !== digest([...owned.namePlan.owners].sort())) ||
        digest(selected) !== digest(owned.namePlan.request)
      )
        throw new HttpError(
          409,
          'OWNERSHIP_CHANGED',
          'The name evidence plan belongs to another selection',
        );
    }
    // The capture pass is private preparation. Native public responses carry the
    // explicit complete plan reference, never this internal empty compatibility slot.
    const names = owned ? [] : previewOwnershipNames(db, selectedSources, oldOwners, selected);
    for (const d of selected.nameDecisions || [])
      if (
        !(owned?.namePlan
          ? owned.namePlan.has(d.key)
          : owned?.captureNameScopes || names.some((n) => n.key === d.key))
      )
        blockers.push('The remembered name support changed; review the current decision.');
    for (const d of selected.decisions || [])
      if (
        !(owned?.sink
          ? owned.sink.hasRecord(d.recordId)
          : records.some((r) => r.recordId === d.recordId))
      )
        blockers.push('A matching decision is outside this selection.');
    for (const d of selected.relationshipDecisions || [])
      if (!relationships.has(d.decisionId))
        blockers.push('A relationship decision is outside this selection.');
    const preview: OwnershipPreview = {
      request: selected,
      profileId,
      version: owned?.sink || owned?.blockerStore ? clinicalReviewRevision(db) : revision(db),
      scopeToken: '',
      title:
        selected.selection.type === 'report'
          ? 'Change person for this report'
          : 'Move these saved records and all their sources',
      destination,
      records,
      pending: owned?.sink ? [] : [...selection.pending],
      blockers: blockerBucket ? [] : [...new Set(blockers)],
      ...(blockerBucket ? { blockerEvidence: blockerBucket.reference() } : {}),
      reportDefault: selected.selection.type === 'report',
      reportHolds:
        selected.selection.type === 'records'
          ? ownershipReportHolds(
              db,
              records,
              (intakeId, sourceRecordId) => getReview(intakeId, sourceRecordId).ownership,
            )
          : [],
      names,
      relationships: owned?.sink ? [] : [...relationships.values()],
      commitGroups: [
        {
          id: digest(selected.selection),
          recordIds: records.map((r) => r.recordId),
          pendingCount: owned?.sink?.pendingCount ?? [...selection.pending].length,
          atomic: true,
        },
      ],
    };
    if (!owned?.sink)
      preview.commitGroups = ownershipCommitGroups(
        owned?.namePlan ? { ...preview, names: owned.namePlan.groupEffects() } : preview,
        selected,
      );
    preview.scopeToken = digest({
      ...preview,
      ...(owned?.namePlan ? { names: owned.namePlan.reference } : {}),
      pins: owned?.sink ? owned.sink.digest : pins,
      ...(owned?.selection ? { scopedReport: owned.selection.boundary } : {}),
      reportPin: selection.report ? digest(selection.report) : null,
    });
    return preview;
  } finally {
    for (const review of reviews.values()) review.close?.();
  }
}
export function previewRecordOwnership(
  ...args: Parameters<typeof ownershipPreviewSteps>
): OwnershipPreview {
  const steps = ownershipPreviewSteps(...args);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}
/** Same complete policy, yielding between bounded contribution batches outside publication. */
export async function previewRecordOwnershipPrepared(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
  owned: Parameters<typeof ownershipPreviewSteps>[4],
  assertCurrent: () => void,
): Promise<OwnershipPreview> {
  if (db.isTransaction)
    throw Error('Cooperative ownership preview requires outside-transaction preparation');
  const steps = ownershipPreviewSteps(db, root, profileId, input, owned);
  try {
    for (;;) {
      assertCurrent();
      const step = steps.next();
      if (step.done) return step.value;
      await setImmediate();
      assertCurrent();
    }
  } finally {
    steps.return(undefined as never);
  }
}
function receiptOutcomes(db: Database, operationId: string): OwnershipReceipt['outcomes'] {
  return db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Record ownership event' AND json_extract(coverage_json,'$.operationId')=? ORDER BY id",
    )
    .all(operationId)
    .map((r) => {
      const e = json(r.coverage_json) as OwnershipReceipt['outcomes'][number];
      return {
        recordId: e.recordId,
        kind: e.kind,
        destinationRecordId: e.destinationRecordId,
        action: e.action,
      };
    });
}
export function getRecordOwnershipReceipt(
  db: Database,
  profileId: string,
  operationId: string,
): OwnershipReceipt {
  owner(db, profileId);
  const row = db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE id=? AND title='Record ownership correction'",
    )
    .get('ownership:' + operationId);
  if (!row) {
    const plans = ownershipPlans(db, operationId);
    if (plans.length)
      return combineOwnershipReceipts(
        plans,
        plans.flatMap((plan) => {
          try {
            return [getRecordOwnershipReceipt(db, profileId, plan.childOperationId)];
          } catch (error) {
            if (error instanceof HttpError && error.code === 'OWNERSHIP_NOT_FOUND') return [];
            throw error;
          }
        }),
      );
    throw new HttpError(
      404,
      'OWNERSHIP_NOT_FOUND',
      'No committed ownership correction has this operation ID',
    );
  }
  const saved = (
    json(row.coverage_json) as { receipt: OwnershipReceipt & { outcomesIncluded?: boolean } }
  ).receipt;
  if (saved.outcomesIncluded === false)
    throw new HttpError(
      409,
      'OWNERSHIP_REFERENCE',
      'This accepted report has paged outcomes; use its checked outcome reference',
    );
  return {
    ...saved,
    outcomes: receiptOutcomes(db, operationId),
    replayed: true,
  };
}
function commitOwnershipUnit(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
  parent?: { operationId: string; fingerprint: string; groups: OwnershipPreview['commitGroups'] },
  namePlan?: PreparedOwnershipNamePlan,
  reportPlan?: {
    assertForTransaction(): void;
    preview(): OwnershipCommitView;
    boundary: string;
    occurrences(): Iterable<string>;
    contributions: import('./ownership-report-plan.ts').PreparedOwnershipReportPlan['contributions'];
    sourceSnapshots: import('./ownership-report-plan.ts').PreparedOwnershipReportPlan['sourceSnapshots'];
    stageSourceSnapshots(): void;
    identityIssues: import('./ownership-report-plan.ts').PreparedOwnershipReportPlan['identityIssues'];
    reportIdentityIssues: import('./ownership-report-plan.ts').PreparedOwnershipReportPlan['reportIdentityIssues'];
    scopes: OwnershipScopeIndex;
    decision(recordId: string): NonNullable<OwnershipRequest['decisions']>[number] | undefined;
  },
  identityPlan?: import('./ownership-identity-snapshots.ts').OwnershipIdentitySnapshotPlan,
): OwnershipReceipt {
  owner(db, profileId);
  if (
    !object(input) ||
    Object.keys(input).some(
      (k) => !['operationId', 'request', 'scopeToken', 'version'].includes(k),
    ) ||
    typeof input.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.operationId,
    ) ||
    !Number.isSafeInteger(input.version) ||
    !text(input.scopeToken)
  )
    return invalid('Commit the displayed preview with a stable operation ID');
  const supplied = input as unknown as OwnershipCommit,
    selected = request(supplied.request),
    fingerprint = digest({ ...supplied, request: selected });
  const previous = db
    .prepare('SELECT coverage_json FROM manual_batches WHERE id=?')
    .get('ownership:' + supplied.operationId);
  if (previous) {
    if ((json(previous.coverage_json) as { fingerprint: string }).fingerprint !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation ID belongs to another correction',
      );
    return getRecordOwnershipReceipt(db, profileId, supplied.operationId);
  }
  const committed = transaction(
    db,
    () => {
      reportPlan?.assertForTransaction();
      namePlan?.assertForTransaction();
      const preview = reportPlan
        ? reportPlan.preview()
        : previewRecordOwnership(
            db,
            root,
            profileId,
            selected,
            namePlan
              ? { namePlan, blockerStore: ownershipBlockerStoreForPlan(namePlan) }
              : undefined,
          );
      if (preview.version !== supplied.version || preview.scopeToken !== supplied.scopeToken)
        throw new HttpError(
          409,
          'OWNERSHIP_CHANGED',
          'The selection or evidence changed; review a fresh preview',
        );
      if (
        ownershipBlockerCount(preview) ||
        preview.records.some((r) => ownershipBlockerCount(r) > 0)
      )
        throw new HttpError(
          409,
          'OWNERSHIP_REVIEW',
          'Resolve every displayed decision before saving',
        );
      const changed = preview.records.filter((r) => r.action !== 'unchanged');
      const noChange =
        !changed.length &&
        preview.pending.every(
          (p) =>
            p.personId ===
            ('personId' in preview.destination ? preview.destination.personId : null),
        );
      if (noChange && 'personId' in preview.destination) {
        const receipt = {
          operationId: supplied.operationId,
          at: now(),
          destinationPersonId: preview.destination.personId,
          moved: 0,
          unchanged: preview.records.length,
          pending: 0,
          replayed: false,
          groupId: preview.commitGroups[0]!.id,
          ...(reportPlan
            ? {
                outcomesIncluded: false,
                outcomeTotal: 0,
                outcomeDigest: ownershipOutcomeDigest(db, supplied.operationId),
                outcomesUrl:
                  '/api/profiles/' +
                  encodeURIComponent(profileId) +
                  '/record-ownership/outcomes/' +
                  supplied.operationId,
              }
            : {}),
        };
        appendOwnershipDecision(
          db,
          'ownership:' + supplied.operationId,
          'Record ownership correction',
          { fingerprint, receipt, noOp: true },
          'No ownership change; no new assignment or name authority',
        );
        if (parent && !ownershipPlans(db, parent.operationId).length)
          retainOwnershipPlan(
            db,
            parent.operationId,
            parent.fingerprint,
            parent.groups,
            preview.destination.personId,
          );
        return receipt;
      }
      reportPlan?.stageSourceSnapshots();
      identityPlan?.stage();
      const destination =
        'personId' in preview.destination
          ? preview.destination
          : person(
              db,
              createIntakeFamilyPersonInTransaction(
                db,
                preview.destination.newPerson.fullName,
                preview.destination.newPerson.relationship,
              ).id,
            );
      if (parent && !ownershipPlans(db, parent.operationId).length)
        retainOwnershipPlan(
          db,
          parent.operationId,
          parent.fingerprint,
          parent.groups,
          destination.personId,
        );
      const at = now(),
        operationId = supplied.operationId;
      const issueReviews = new Map<string, IntakeReview>();
      const compatibilityIssues = new Map<string, string[]>();
      const issuesFor = (intakeId: string, sourceRecordId: string) => {
        if (reportPlan) return reportPlan.identityIssues(intakeId, sourceRecordId);
        if (identityPlan) return identityPlan.forSource(intakeId, sourceRecordId);
        const proposal = sourceRecordId.replace(/:line:\d+$/, '');
        const key = intakeId + ':' + proposal;
        if (!issueReviews.has(key)) {
          if (nativeOwnershipSource(db, intakeId)) {
            const selectedKey = JSON.stringify([intakeId, sourceRecordId]);
            const cached = compatibilityIssues.get(selectedKey);
            if (cached) return cached;
            const selected = prepareCollectionClinicalReview(
              db,
              root,
              profileId,
              intakeId,
              proposal === intakeId ? null : proposal,
            );
            if (selected.status !== 'ready')
              throw new HttpError(
                409,
                'OWNERSHIP_REVIEW_FRAGMENT',
                'Selected clinical evidence requires its complete addressed reference',
              );
            try {
              const record = selected.session.record(sourceRecordId);
              const values = record ? [...ownershipIdentityIssues(record)] : [];
              compatibilityIssues.set(selectedKey, values);
              return values;
            } finally {
              selected.session.close();
            }
          } else
            issueReviews.set(
              key,
              reviewIntake(db, root, profileId, intakeId, proposal === intakeId ? null : proposal),
            );
        }
        const record = issueReviews.get(key)!.records.find((r) => r.id === sourceRecordId);
        return record ? [...ownershipIdentityIssues(record)] : [];
      };
      for (const item of preview.records)
        for (const c of iterateOwnershipStreamContributions(db, item.kind, item.recordId, {
          scopes: reportPlan?.scopes.contributionValues.bind(reportPlan.scopes),
        }))
          issuesFor(c.intakeId, c.sourceRecordId);
      if (selected.selection.type === 'report')
        for (const pending of preview.pending)
          issuesFor(selected.selection.intakeId, pending.recordId);
      for (const relationship of preview.relationships.filter((r) => r.resolution === 'withdraw'))
        appendOwnershipDecision(
          db,
          'ownership-relationship:' + operationId + ':' + relationship.decisionId,
          'Ownership relationship withdrawal',
          { operationId, ...relationship },
        );
      for (const item of changed) {
        const record = clinicalRecord(db, item.kind, item.recordId);
        const contributions = ownershipContributionSequence(db, item.kind, item.recordId);
        const selectedContribution = (id: string) => {
          if (!Array.isArray(item.contributions))
            throw Error('Native ownership contribution selection requires its prepared plan');
          return !!item.contributions.find((p) => p.sourceRecordId === id)?.selected;
        };
        const moving = reportPlan
            ? reportPlan.contributions(item.kind, item.recordId, true)
            : contributions.filter((c) => selectedContribution(c.sourceRecordId)),
          remaining = reportPlan
            ? reportPlan.contributions(item.kind, item.recordId, false)
            : contributions.filter((c) => !selectedContribution(c.sourceRecordId));
        const split = remaining.length > 0,
          linked = item.action === 'link';
        const decision = reportPlan
          ? reportPlan.decision(item.recordId)
          : selected.decisions?.find((d) => d.recordId === item.recordId);
        const destinationRecordId = linked
          ? decision!.targetRecordId!
          : split
            ? 'ownership-record:' + digest([operationId, item.kind, item.recordId])
            : item.recordId;
        const firstMoving = moving.first()!,
          firstRemaining = remaining.first();
        const mapping = normalized(item.mapping, firstMoving, item.kind, destination.personId);
        const extra = split
          ? splitOwnershipExtra(
              moving,
              mapping,
              operationId,
              item.recordId,
              item.version,
              destination,
              reportPlan?.sourceSnapshots(item.kind, item.recordId).moving,
            )
          : {
              ...record.extra,
              import: {
                ...(split ? {} : record.extra.import),
                identity: split ? firstMoving.identity : record.extra.import.identity,
                intakeId: firstMoving.intakeId,
                personId: destination.personId,
                acceptedMapping: mapping,
                version: clinicalVersion(mapping),
                ownershipOperationId: operationId,
                identityAttribution: {
                  status: 'prior_confirmation',
                  basis: 'explicit_ownership_correction',
                  assignedPerson: destination,
                  groupId: null,
                  groupVersionId: null,
                  confirmationOperationId: operationId,
                },
                identityAttributions: undefined,
              },
            };
        if (!linked) {
          insertClinicalProjection(
            db,
            destinationRecordId,
            split ? firstMoving.sourceRecordId : String(record.row.source_record_id),
            split ? String(firstMoving.source.provider_id) : String(record.row.provider_id),
            mapping,
            extra,
            !split,
          );
          if (item.kind === 'medication')
            db.prepare(
              "INSERT INTO medication_preferences(medication_id,status,version,updated_at,assertion_json) VALUES(?,'not_current',1,?,?) ON CONFLICT(medication_id) DO UPDATE SET status='not_current',version=version+1,updated_at=excluded.updated_at,assertion_json=excluded.assertion_json",
            ).run(
              destinationRecordId,
              at,
              JSON.stringify({
                operationId,
                reason: 'Person assignment corrected',
                personId: destination.personId,
              }),
            );
        }
        if (split) {
          const left = normalized(
            item.remainingMapping!,
            firstRemaining!,
            item.kind,
            item.owner.personId,
          );
          insertClinicalProjection(
            db,
            item.recordId,
            firstRemaining!.sourceRecordId,
            String(firstRemaining!.source.provider_id),
            left,
            splitOwnershipExtra(
              remaining,
              left,
              operationId,
              item.recordId,
              item.version,
              item.owner,
              reportPlan?.sourceSnapshots(item.kind, item.recordId).remaining,
            ),
            true,
          );
        }
        reconcileOwnershipAttachments(
          db,
          item.kind,
          item.recordId,
          destinationRecordId,
          moving,
          remaining,
          mapping,
          item.remainingMapping,
          operationId,
        );
        for (const c of moving) {
          // Current person evidence follows the correction; durable row history preserves the prior link.
          db.prepare(
            "UPDATE evidence SET entity_id=? WHERE entity_type='person' AND source_record_id=? AND entity_id=?",
          ).run(destination.personId, c.sourceRecordId, item.owner.personId);
          if (destinationRecordId !== item.recordId)
            db.prepare(
              'UPDATE evidence SET entity_id=? WHERE entity_type=? AND entity_id=? AND source_record_id=?',
            ).run(destinationRecordId, item.kind, item.recordId, c.sourceRecordId);
          // Every occurrence gets its own current authority. Historic attachment decisions remain evidence.
          appendOwnershipDecision(
            db,
            'ownership-source:' +
              operationId +
              ':' +
              digest([item.kind, item.recordId, c.sourceRecordId]),
            'Record ownership source',
            {
              operationId,
              recordId: destinationRecordId,
              kind: item.kind,
              sourceRecordId: c.sourceRecordId,
              identity: c.identity,
              personId: destination.personId,
              noteId: destination.noteId,
              sourceHash: c.sourceHash,
              envelopeHash: ownershipEnvelopeHash(c.envelope),
              mappingHash: ownershipMappingHash(c.acceptedMapping || record.mapping),
              targetVersion: clinicalRecord(db, item.kind, destinationRecordId).extra.import
                .version,
              identityIssues: issuesFor(c.intakeId, c.sourceRecordId),
              previousRecordId: item.recordId,
              previousAttachmentVersion: c.attachmentVersion,
            },
          );
          retainAcceptedContribution(db, {
            sourceRecordId: c.sourceRecordId,
            identity: c.identity,
            recordId: destinationRecordId,
            kind: item.kind,
            mapping: c.acceptedMapping || mapping,
            intakeId: c.intakeId,
            candidateVersionId: null,
          });
        }
        if (linked && !split) {
          if (item.kind === 'medication')
            db.prepare('DELETE FROM medication_preferences WHERE medication_id=?').run(
              item.recordId,
            );
          db.prepare(`DELETE FROM ${record.table} WHERE id=?`).run(item.recordId);
          appendOwnershipDecision(
            db,
            'ownership-redirect:' + operationId + ':' + item.recordId,
            'Record ownership redirect',
            { operationId, recordId: item.recordId, kind: item.kind, destinationRecordId },
          );
        }
        appendOwnershipDecision(
          db,
          'ownership-event:' + operationId + ':' + item.recordId,
          'Record ownership event',
          {
            operationId,
            kind: item.kind,
            recordId: item.recordId,
            destinationRecordId,
            action: item.action,
            previousVersion: item.version,
            fromPersonId: item.owner.personId,
            fromNoteId: item.owner.noteId,
            fromPersonName: item.owner.fullName,
            toPersonId: destination.personId,
            sourceReport: item.sourceReport,
          },
          selected.reason?.trim(),
        );
      }
      for (const hold of preview.reportHolds)
        appendOwnershipDecision(
          db,
          'ownership-report-hold:' + operationId + ':' + hold.defaultOperationId,
          'Report ownership default hold',
          { operationId, ...hold },
        );
      if (namePlan) namePlan.stage(destination.noteId, operationId);
      else commitOwnershipNames(db, preview.names, destination.noteId, operationId);
      if (selected.selection.type === 'report') {
        const report = reportPlan ? null : reportSelection(db, root, profileId, selected).report!;
        const identityIssues = new Set<string>();
        const recordIds = reportPlan
          ? reportPlan.occurrences()
          : (function* () {
              for (const member of report!.group.versions.at(-1)!.members)
                for (const occurrence of member.occurrences) yield occurrence.recordId;
            })();
        if (!reportPlan)
          for (const recordId of recordIds) {
            const issues = issuesFor(selected.selection.intakeId, recordId);
            if (!Array.isArray(issues)) throw Error('Expected prepared report identity authority');
            for (const issue of issues) identityIssues.add(issue);
          }
        appendOwnershipDecision(db, 'ownership-report:' + operationId, 'Report ownership default', {
          operationId,
          intakeId: selected.selection.intakeId,
          groupId: selected.selection.groupId,
          groupVersionId: selected.selection.groupVersionId,
          boundary: reportPlan?.boundary ?? report!.boundary,
          personId: destination.personId,
          noteId: destination.noteId,
          identityIssues: reportPlan ? reportPlan.reportIdentityIssues() : [...identityIssues],
        });
      }
      const receipt: OwnershipReceipt = {
        operationId,
        at,
        destinationPersonId: destination.personId,
        moved: changed.length,
        unchanged: preview.records.length - changed.length,
        pending: preview.pending.length,
        replayed: false,
        groupId: preview.commitGroups[0]!.id,
        outcomes: [],
      };
      // Outcomes are reconstructed from small per-record events, never duplicated in the group receipt.
      const { outcomes: _outcomes, ...baseReceipt } = receipt;
      const smallReceipt = {
        ...baseReceipt,
        ...(reportPlan
          ? {
              outcomesIncluded: false,
              outcomeTotal: changed.length,
              outcomeDigest: ownershipOutcomeDigest(db, operationId),
              outcomesUrl: `/api/profiles/${encodeURIComponent(profileId)}/record-ownership/outcomes/${operationId}`,
            }
          : {}),
      };
      appendOwnershipDecision(
        db,
        'ownership:' + operationId,
        'Record ownership correction',
        { fingerprint, receipt: smallReceipt },
        selected.reason?.trim(),
      );
      return smallReceipt;
    },
    {
      operationId: supplied.operationId,
      fingerprint,
      actor: 'profile-user',
      origin: 'record-ownership',
    },
  );
  return { ...committed, outcomes: reportPlan ? [] : receiptOutcomes(db, supplied.operationId) };
}

/** Owned native participant; asynchronous preparation must already be complete. */
export function commitRecordOwnershipPlannedUnit(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
  namePlan: PreparedOwnershipNamePlan,
  parent?: { operationId: string; fingerprint: string; groups: OwnershipPreview['commitGroups'] },
  reportPlan?: {
    assertForTransaction(): void;
    preview(): OwnershipCommitView;
    boundary: string;
    occurrences(): Iterable<string>;
    contributions: import('./ownership-report-plan.ts').PreparedOwnershipReportPlan['contributions'];
    sourceSnapshots: import('./ownership-report-plan.ts').PreparedOwnershipReportPlan['sourceSnapshots'];
    stageSourceSnapshots(): void;
    identityIssues: import('./ownership-report-plan.ts').PreparedOwnershipReportPlan['identityIssues'];
    reportIdentityIssues: import('./ownership-report-plan.ts').PreparedOwnershipReportPlan['reportIdentityIssues'];
    scopes: OwnershipScopeIndex;
    decision(recordId: string): NonNullable<OwnershipRequest['decisions']>[number] | undefined;
  },
  identityPlan?: import('./ownership-identity-snapshots.ts').OwnershipIdentitySnapshotPlan,
): OwnershipReceipt {
  return commitOwnershipUnit(
    db,
    root,
    profileId,
    input,
    parent,
    namePlan,
    reportPlan,
    identityPlan,
  );
}

/** Independent groups preserve earlier durable results when a later group cannot publish. */
export function commitRecordOwnership(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
): OwnershipReceipt {
  owner(db, profileId);
  // The unit validator also rejects extra keys and malformed operation IDs.
  if (!object(input) || !object(input.request) || typeof input.operationId !== 'string')
    return commitOwnershipUnit(db, root, profileId, input);
  const supplied = input as unknown as OwnershipCommit,
    selected = request(supplied.request),
    fingerprint = digest({ ...supplied, request: selected });
  const plans = ownershipPlans(db, supplied.operationId);
  if (plans.length) {
    if (plans.some((p) => p.fingerprint !== fingerprint))
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation ID belongs to another correction',
      );
    return getRecordOwnershipReceipt(db, profileId, supplied.operationId);
  }
  if (
    db.prepare('SELECT 1 FROM manual_batches WHERE id=?').get('ownership:' + supplied.operationId)
  )
    return commitOwnershipUnit(db, root, profileId, input);
  const preview = previewRecordOwnership(db, root, profileId, selected);
  if (preview.commitGroups.length <= 1) return commitOwnershipUnit(db, root, profileId, input);
  if (
    Object.keys(input).some(
      (k) => !['operationId', 'request', 'scopeToken', 'version'].includes(k),
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      supplied.operationId,
    )
  )
    return invalid('Commit the displayed preview with a stable operation ID');
  if (preview.version !== supplied.version || preview.scopeToken !== supplied.scopeToken)
    throw new HttpError(409, 'OWNERSHIP_CHANGED', 'Review the current selection before saving');
  if (ownershipBlockerCount(preview) || preview.records.some((r) => ownershipBlockerCount(r) > 0))
    throw new HttpError(409, 'OWNERSHIP_REVIEW', 'Resolve every displayed decision before saving');
  let destination = selected.destination;
  for (const group of preview.commitGroups) {
    try {
      // No asynchronous work occurs between these transactions. Only preceding, reviewed groups
      // can change the common destination's note version while this call owns execution.
      if ('noteId' in destination)
        destination = { ...destination, expectedVersion: getNote(db, destination.noteId).version };
      const childRequest = { ...ownershipGroupRequest(selected, group, preview), destination };
      const childPreview = previewRecordOwnership(db, root, profileId, childRequest);
      const receipt = commitOwnershipUnit(
        db,
        root,
        profileId,
        {
          operationId: childOwnershipOperation(supplied.operationId, group.id),
          request: childRequest,
          scopeToken: childPreview.scopeToken,
          version: childPreview.version,
        },
        { operationId: supplied.operationId, fingerprint, groups: preview.commitGroups },
      );
      if ('newPerson' in destination) {
        const current = personForId(db, receipt.destinationPersonId);
        destination = { noteId: current.noteId, expectedVersion: current.version };
      }
    } catch (error) {
      if (!ownershipPlans(db, supplied.operationId).length) throw error;
      return { ...getRecordOwnershipReceipt(db, profileId, supplied.operationId), replayed: false };
    }
  }
  return { ...getRecordOwnershipReceipt(db, profileId, supplied.operationId), replayed: false };
}
