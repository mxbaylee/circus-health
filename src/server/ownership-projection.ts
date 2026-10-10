import { clinicalVersion, datePrecision, mappingFrom } from './clinical-import.ts';
import type { OwnershipContributionSequence } from './ownership-contribution-stream.ts';
import type { IntakeClinicalMapping } from '../shared/intake.ts';
import type { IntakeIdentityPerson } from '../shared/intake-identity.ts';
import type { Database } from './database.ts';
import { ownershipHash } from './ownership-journal.ts';
import type { OwnershipSourceSnapshotReference } from './ownership-source-snapshots.ts';

/** Reconstruct current provenance from retained occurrences. The prior merged version stays in history. */
export function splitOwnershipExtra(
  sources: OwnershipContributionSequence,
  mapping: IntakeClinicalMapping,
  operationId: string,
  previousRecordId: string,
  previousVersion: string,
  destination: IntakeIdentityPerson,
  sourceRecordIdsReference?: OwnershipSourceSnapshotReference,
) {
  const source = sources.first()!;
  const originalMapping = mappingFrom({ value: source.envelope });
  const version = clinicalVersion(mapping as Parameters<typeof clinicalVersion>[0]);
  return {
    attribution: source.envelope.provenance,
    datePrecision: datePrecision(mapping.date || ''),
    ...(mapping.kind === 'medication'
      ? { sourceFields: { recordedDate: mapping.dateRole === 'recorded' ? mapping.date : null } }
      : {}),
    import: {
      identity: source.identity,
      version,
      intakeId: source.intakeId,
      personId: mapping.personId,
      acceptedMapping: mapping,
      originalMapping,
      sourceSystem: source.envelope.provenance.sourceSystem,
      sourceRecordId: source.envelope.provenance.sourceRecordId,
      // Explicitly reviewed split values take precedence over future normalization rules.
      recordException: {
        kind: mapping.kind,
        set: mapping,
        reason: 'Reviewed source contribution split',
        operationId,
      },
      manuallyEdited: true,
      ruleIds: [],
      ownershipOperationId: operationId,
      identityAttribution: {
        status: 'prior_confirmation',
        basis: 'explicit_ownership_correction',
        assignedPerson: destination,
        groupId: null,
        groupVersionId: null,
        confirmationOperationId: operationId,
      },
      ownershipReview: {
        operationId,
        previousRecordId,
        previousVersion,
        ...(sourceRecordIdsReference
          ? { sourceRecordIdsReference }
          : { sourceRecordIds: Array.from(sources, (s) => s.sourceRecordId) }),
      },
      // A split does not inherit merged identity confirmations, source confirmations or correction arrays.
      // Exact original envelopes and accepted contribution versions remain available through evidence.
    },
  };
}

/** Provider attachments follow their supported occurrences; personal attachments stay on the original record. */
export function reconcileOwnershipAttachments(
  db: Database,
  kind: string,
  oldId: string,
  newId: string,
  moving: OwnershipContributionSequence,
  remaining: OwnershipContributionSequence,
  mapping: IntakeClinicalMapping,
  left: IntakeClinicalMapping | undefined,
  operationId: string,
) {
  if (oldId === newId) {
    recordMutationStatement(
      db,
      'UPDATE attachments SET person_id=? WHERE owner_type=? AND owner_id=? AND person_id IS NOT NULL',
    ).run(mapping.personId || 'patient', kind, oldId);
    return;
  }
  const hasFile = (
    sources: OwnershipContributionSequence,
    values: IntakeClinicalMapping | undefined,
    file: string,
  ) =>
    (values?.assets || []).includes(file) || sources.some((source) => source.sourceFileId === file);
  const rows = db
    .prepare(
      'SELECT a.*,s.source_file_id FROM attachments a JOIN assets s ON s.id=a.asset_id WHERE a.owner_type=? AND a.owner_id=?',
    )
    .iterate(kind, oldId);
  for (const row of rows) {
    if (!hasFile(moving, mapping, String(row.source_file_id))) continue;
    if (
      !db
        .prepare('SELECT 1 FROM attachments WHERE owner_type=? AND owner_id=? AND asset_id=?')
        .get(kind, newId, row.asset_id)
    )
      recordMutationStatement(
        db,
        'INSERT INTO attachments(id,asset_id,owner_type,owner_id,caption,created_at,body_location,event_date,person_id) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(
        'ownership-attachment:' + ownershipHash([operationId, newId, row.asset_id]),
        row.asset_id,
        kind,
        newId,
        row.caption,
        row.created_at,
        row.body_location,
        row.event_date,
        row.person_id === null ? null : mapping.personId || 'patient',
      );
    if (!hasFile(remaining, left, String(row.source_file_id)))
      recordMutationStatement(db, 'DELETE FROM attachments WHERE id=?').run(row.id);
  }
  // A whole-record link leaves no orphan attachment owner, including personal attachments.
  if (!remaining.length)
    recordMutationStatement(
      db,
      'UPDATE attachments SET owner_id=?,person_id=CASE WHEN person_id IS NULL THEN NULL ELSE ? END WHERE owner_type=? AND owner_id=?',
    ).run(newId, mapping.personId || 'patient', kind, oldId);
}
import { recordMutationStatement } from './record-mutation-recipe.ts';
