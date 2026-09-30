import { duplicateRecord, verifyDuplicateOriginals } from './duplicate-review.ts';
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
import { HttpError, json, now, revision, transaction, type Database } from './database.ts';
import { clinicalRecord } from './record-corrections.ts';
import { clinicalTables, type ClinicalKind } from './clinical-references.ts';
import {
  clinicalVersion,
  checkClinicalMapping,
  insertClinicalProjection,
  mappingFrom,
  assetProblem,
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
) {
  owner(db, profileId);
  const selected = request(input);
  const selection = reportSelection(db, root, profileId, selected);
  const groups = new Map<string, { intakeId: string; groupId: string }>();
  if (selected.selection.type === 'report')
    groups.set(selected.selection.groupId, selected.selection);
  for (const ref of selection.refs)
    for (const contribution of ownershipContributions(db, ref.kind, ref.recordId)) {
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
  for (const group of groups.values())
    await getIntakeIdentityReview(db, root, profileId, group.intakeId, group.groupId);
}
function normalized(
  mapping: IntakeClinicalMapping,
  source: SourceContribution,
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
/** Read-only preview. Publication repeats all reads under the same durable transaction. */
export function previewRecordOwnership(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
): OwnershipPreview {
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
  const selection = reportSelection(db, root, profileId, selected);
  const selectedSources = new Set(selection.sources),
    oldOwners = new Set<string>();
  const reviews = new Map<string, IntakeReview>();
  const getReview = (intakeId: string, sourceId: string) => {
    const proposal = sourceId.replace(/:line:\d+$/, '');
    const key = intakeId + ':' + proposal;
    if (!reviews.has(key))
      reviews.set(
        key,
        reviewIntake(db, root, profileId, intakeId, proposal === intakeId ? null : proposal),
      );
    return reviews.get(key)!;
  };
  const pins: string[] = [];
  const relationships = new Map<string, OwnershipPreview['relationships'][number]>();
  const records: OwnershipPreviewRecord[] = selection.refs.map((ref) => {
    const record = clinicalRecord(db, ref.kind, ref.recordId);
    const version = digest(record.row);
    if (ref.version !== undefined && ref.version !== version)
      throw new HttpError(409, 'OWNERSHIP_CHANGED', 'A selected record changed; review it again');
    const oldId =
      ref.kind === 'document'
        ? String(record.extra.import.personId || 'patient')
        : String(record.row.person_id || 'patient');
    const contributions = ownershipContributions(db, ref.kind, ref.recordId);
    const included = contributions.filter(
      (c) => selected.selection.type === 'records' || selection.sources.has(c.sourceRecordId),
    );
    const remaining = contributions.filter((c) => !included.includes(c));
    const split = remaining.length > 0;
    const unchanged = oldId === destinationId;
    const blockers: string[] = [];
    const decision = selected.decisions?.find((d) => d.recordId === ref.recordId);
    if (!included.length) blockers.push('No source contribution belongs to this selection.');
    if (!unchanged) {
      oldOwners.add(oldId);
      for (const c of included) selectedSources.add(c.sourceRecordId);
    }
    for (const c of contributions) {
      verifyIntakeOriginal(db, root, profileId, c.sourceFileId);
      pins.push(c.version);
    }
    for (const c of included) {
      const occurrence = getReview(c.intakeId, c.sourceRecordId).records.find(
        (r) => r.id === c.sourceRecordId,
      );
      if (!occurrence) blockers.push('The accepted source no longer has a reviewable mapping.');
      else {
        pins.push(digest(occurrence.identityReview));
        blockers.push(
          ...ownershipIdentityBlockers(
            db,
            c.intakeId,
            occurrence,
            'personId' in destination ? destination.birthDate : null,
          ),
        );
      }
    }
    const source = included[0];
    const proposed = split
      ? included.find((c) => c.acceptedMapping)?.acceptedMapping
      : (record.mapping as IntakeClinicalMapping);
    const mapping = source
      ? normalized(decision?.splitMapping || proposed || {}, source, ref.kind, destinationId)
      : (record.mapping as IntakeClinicalMapping);
    let remainingMapping: IntakeClinicalMapping | undefined;
    if (split) {
      remainingMapping = normalized(
        decision?.remainingMapping ||
          remaining.find((c) => c.acceptedMapping)?.acceptedMapping ||
          {},
        remaining[0]!,
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
        [remainingMapping, remaining[0]],
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
        (included.some((c) => !c.acceptedMapping) ||
          new Set(included.map((c) => ownershipMappingHash(c.acceptedMapping || {}))).size > 1) &&
        !decision?.splitMapping
      )
        blockers.push(
          'Choose exact transferred values; source contributions are incomplete or disagree.',
        );
      if (
        (remaining.some((c) => !c.acceptedMapping) ||
          new Set(remaining.map((c) => ownershipMappingHash(c.acceptedMapping || {}))).size > 1) &&
        !decision?.remainingMapping
      )
        blockers.push(
          'Choose exact remaining values; source contributions are incomplete or disagree.',
        );
    } else if (decision?.splitMapping || decision?.remainingMapping || decision?.reviewedSplit)
      blockers.push('Clinical content changes belong only to a reviewed contribution split.');
    const matches: OwnershipPreviewRecord['matches'] = [];
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
            const comparison = duplicateRecord(db, ref.kind, match.id);
            verifyDuplicateOriginals(db, root, profileId, comparison, new Set());
            const targetSources = ownershipContributions(db, ref.kind, match.id);
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
    if (matches.length && !decision)
      blockers.push('Choose whether to link a destination match or keep both.');
    if (decision?.action === 'link' && !matches.some((m) => m.recordId === decision.targetRecordId))
      blockers.push('The selected match is not a current destination record.');
    const relationship = clinicalRelationshipProjection(db, profileId, ref);
    pins.push(digest(relationship));
    if (relationship.truncated)
      blockers.push('Review the complete relationship graph before correcting ownership.');
    if (!unchanged)
      for (const r of relationship.relationships)
        if (r.status !== 'withdrawn') {
          const other = r.request.left.recordId === ref.recordId ? r.request.right : r.request.left;
          const movingTogether =
            !split &&
            selection.refs.some((r) => r.kind === other.kind && r.recordId === other.recordId) &&
            !selected.decisions?.some((d) => d.recordId === other.recordId && d.action === 'link');
          // Coupled records still need renewed relationship review after clinical-version changes.
          const resolution = selected.relationshipDecisions?.some(
            (d) => d.decisionId === r.decisionId,
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
    const intake = source ? getIntake(db, root, profileId, source.intakeId) : null;
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
      sourceReport: group
        ? { intakeId: intake!.id, groupId: group.id, groupVersionId: group.versions.at(-1)!.id }
        : undefined,
      contributions: contributions.map((c) => ({
        sourceRecordId: c.sourceRecordId,
        sourceFileId: c.sourceFileId,
        reportScopes: c.reportScopes,
        contentUrl: c.contentUrl,
        locator: c.locator,
        version: c.version,
        selected: included.includes(c),
        identity: c.identity,
        acceptedMapping: c.acceptedMapping,
      })),
      matches,
      blockers: unchanged ? [] : [...new Set(blockers)],
      medicationActivity:
        ref.kind === 'medication'
          ? unchanged || decision?.action === 'link'
            ? 'preserved'
            : 'inactive'
          : null,
    };
  });
  const blockers: string[] = [];
  for (const p of selection.pending) {
    if (selected.selection.type !== 'report') continue;
    const occurrence = getReview(selected.selection.intakeId, p.recordId).records.find(
      (r) => r.id === p.recordId,
    );
    if (!occurrence) blockers.push('A pending report member changed.');
    else {
      blockers.push(
        ...ownershipIdentityBlockers(
          db,
          selected.selection.intakeId,
          occurrence,
          'personId' in destination ? destination.birthDate : null,
        ),
      );
      if ((occurrence.identityAttribution?.assignedPerson?.personId || 'patient') !== destinationId)
        oldOwners.add(occurrence.identityAttribution?.assignedPerson?.personId || 'patient');
      pins.push(digest(occurrence));
      p.personId = occurrence.identityAttribution?.assignedPerson?.personId || 'patient';
    }
  }
  if (!records.length && !selection.pending.length)
    blockers.push('There are no clinical records in this selection.');
  const names = previewOwnershipNames(db, selectedSources, oldOwners, selected);
  for (const d of selected.nameDecisions || [])
    if (!names.some((n) => n.key === d.key))
      blockers.push('The remembered name support changed; review the current decision.');
  for (const d of selected.decisions || [])
    if (!records.some((r) => r.recordId === d.recordId))
      blockers.push('A matching decision is outside this selection.');
  for (const d of selected.relationshipDecisions || [])
    if (!relationships.has(d.decisionId))
      blockers.push('A relationship decision is outside this selection.');
  const preview: OwnershipPreview = {
    request: selected,
    profileId,
    version: revision(db),
    scopeToken: '',
    title:
      selected.selection.type === 'report'
        ? 'Change person for this report'
        : 'Move these saved records and all their sources',
    destination,
    records,
    pending: selection.pending,
    blockers: [...new Set(blockers)],
    reportDefault: selected.selection.type === 'report',
    reportHolds: selected.selection.type === 'records' ? ownershipReportHolds(db, records) : [],
    names,
    relationships: [...relationships.values()],
    commitGroups: [
      {
        id: digest(selected.selection),
        recordIds: records.map((r) => r.recordId),
        pendingCount: selection.pending.length,
        atomic: true,
      },
    ],
  };
  preview.commitGroups = ownershipCommitGroups(preview, selected);
  preview.scopeToken = digest({
    ...preview,
    pins,
    reportPin: selection.report ? digest(selection.report) : null,
  });
  return preview;
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
  return {
    ...(json(row.coverage_json) as { receipt: OwnershipReceipt }).receipt,
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
      const preview = previewRecordOwnership(db, root, profileId, selected);
      if (preview.version !== supplied.version || preview.scopeToken !== supplied.scopeToken)
        throw new HttpError(
          409,
          'OWNERSHIP_CHANGED',
          'The selection or evidence changed; review a fresh preview',
        );
      if (preview.blockers.length || preview.records.some((r) => r.blockers.length))
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
      const issuesFor = (intakeId: string, sourceRecordId: string) => {
        const proposal = sourceRecordId.replace(/:line:\d+$/, '');
        const key = intakeId + ':' + proposal;
        if (!issueReviews.has(key))
          issueReviews.set(
            key,
            reviewIntake(db, root, profileId, intakeId, proposal === intakeId ? null : proposal),
          );
        const record = issueReviews.get(key)!.records.find((r) => r.id === sourceRecordId);
        return record ? ownershipIdentityIssues(record) : [];
      };
      for (const item of preview.records)
        for (const c of ownershipContributions(db, item.kind, item.recordId))
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
        const contributions = ownershipContributions(db, item.kind, item.recordId);
        const moving = contributions.filter(
            (c) => item.contributions.find((p) => p.sourceRecordId === c.sourceRecordId)?.selected,
          ),
          remaining = contributions.filter((c) => !moving.includes(c));
        const split = remaining.length > 0,
          linked = item.action === 'link';
        const decision = selected.decisions?.find((d) => d.recordId === item.recordId);
        const destinationRecordId = linked
          ? decision!.targetRecordId!
          : split
            ? 'ownership-record:' + digest([operationId, item.kind, item.recordId])
            : item.recordId;
        const mapping = normalized(item.mapping, moving[0]!, item.kind, destination.personId);
        const extra = split
          ? splitOwnershipExtra(
              moving,
              mapping,
              operationId,
              item.recordId,
              item.version,
              destination,
            )
          : {
              ...record.extra,
              import: {
                ...(split ? {} : record.extra.import),
                identity: split ? moving[0]!.identity : record.extra.import.identity,
                intakeId: moving[0]!.intakeId,
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
            split ? moving[0]!.sourceRecordId : String(record.row.source_record_id),
            split ? String(moving[0]!.source.provider_id) : String(record.row.provider_id),
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
            remaining[0]!,
            item.kind,
            item.owner.personId,
          );
          insertClinicalProjection(
            db,
            item.recordId,
            remaining[0]!.sourceRecordId,
            String(remaining[0]!.source.provider_id),
            left,
            splitOwnershipExtra(
              remaining,
              left,
              operationId,
              item.recordId,
              item.version,
              item.owner,
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
            toPersonId: destination.personId,
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
      commitOwnershipNames(db, preview.names, destination.noteId, operationId);
      if (selected.selection.type === 'report') {
        const report = reportSelection(db, root, profileId, selected).report!;
        appendOwnershipDecision(db, 'ownership-report:' + operationId, 'Report ownership default', {
          operationId,
          intakeId: selected.selection.intakeId,
          groupId: selected.selection.groupId,
          groupVersionId: selected.selection.groupVersionId,
          boundary: report.boundary,
          personId: destination.personId,
          noteId: destination.noteId,
          identityIssues: [
            ...new Set(
              report.group.versions.at(-1)!.members.flatMap((m) =>
                m.occurrences.flatMap((o) => {
                  return issuesFor(
                    selected.selection.type === 'report' ? selected.selection.intakeId : '',
                    o.recordId,
                  );
                }),
              ),
            ),
          ],
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
      const { outcomes: _outcomes, ...smallReceipt } = receipt;
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
  return { ...committed, outcomes: receiptOutcomes(db, supplied.operationId) };
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
  if (preview.blockers.length || preview.records.some((r) => r.blockers.length))
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
