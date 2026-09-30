import type { Database, SqliteRow } from './database.ts';
import { json } from './database.ts';
import { clinicalTables, type ClinicalKind } from './clinical-references.ts';
import { clinicalSourceIdentityV1 } from './intake-source-identity.ts';
import {
  ownershipHash,
  latestOwnershipDecision,
  appendOwnershipDecision,
} from './ownership-journal.ts';
import type { HealthRecordEnvelope, IntakeClinicalMapping } from '../shared/intake.ts';
import type { OwnershipContribution } from '../shared/record-ownership.ts';

export interface AcceptedContribution {
  sourceRecordId: string;
  identity: string;
  recordId: string;
  kind: ClinicalKind;
  mapping: IntakeClinicalMapping;
  intakeId: string;
  candidateVersionId: string | null;
  revision: number;
}
export function retainAcceptedContribution(
  db: Database,
  value: Omit<AcceptedContribution, 'revision'>,
) {
  const id = 'accepted-contribution:' + ownershipHash(value);
  if (db.prepare('SELECT 1 FROM manual_batches WHERE id=?').get(id)) return;
  appendOwnershipDecision(
    db,
    id,
    'Accepted clinical contribution',
    value,
    'Accepted literal clinical mapping for this source occurrence',
  );
}
export interface SourceContribution extends OwnershipContribution {
  evidenceIds: string[];
  source: SqliteRow;
  envelope: HealthRecordEnvelope;
  intakeId: string;
  sourceHash: string;
  attachmentVersion: string;
}
export function ownershipContributions(
  db: Database,
  kind: ClinicalKind,
  recordId: string,
): SourceContribution[] {
  const row = db
    .prepare(`SELECT source_record_id FROM ${clinicalTables[kind]} WHERE id=?`)
    .get(recordId)!;
  const ids = new Set<string>([String(row.source_record_id)]);
  for (const e of db
    .prepare('SELECT source_record_id FROM evidence WHERE entity_type=? AND entity_id=?')
    .iterate(kind, recordId))
    ids.add(String(e.source_record_id));
  return [...ids].sort().map((id) => {
    const source = db.prepare('SELECT * FROM source_records WHERE id=?').get(id)!;
    const envelope = json(source.raw_json) as HealthRecordEnvelope;
    const locator = json(source.locator_json, {}) as Record<string, unknown>;
    const originalId = String(locator.originalSourceFileId || source.source_file_id);
    const original = db
      .prepare('SELECT sha256,details_json FROM source_files WHERE id=?')
      .get(originalId)!;
    const evidence = db
      .prepare(
        'SELECT * FROM evidence WHERE entity_type=? AND entity_id=? AND source_record_id=? ORDER BY id',
      )
      .all(kind, recordId, id);
    const identity = envelope?.provenance
      ? clinicalSourceIdentityV1({ value: envelope }, { sha256: String(original.sha256) })
      : '';
    const accepted = latestOwnershipDecision<AcceptedContribution>(
      db,
      'Accepted clinical contribution',
      'sourceRecordId',
      id,
    );
    const transitions = db
      .prepare(
        "SELECT id,coverage_json FROM manual_batches WHERE title='Duplicate evidence decision' AND json_extract(coverage_json,'$.duplicateDecision.occurrenceAttachment.incomingSourceRecordId')=? ORDER BY json_extract(coverage_json,'$.duplicateDecision.sequence'),id",
      )
      .all(id);
    return {
      sourceRecordId: id,
      sourceFileId: originalId,
      reportScopes: (
        (
          json(original.details_json) as {
            intake?: { workflow?: import('../shared/intake.ts').IntakeWorkflow };
          }
        ).intake?.workflow?.reportGroups || []
      )
        .filter((g) =>
          g.versions.at(-1)?.members.some((m) => m.occurrences.some((o) => o.recordId === id)),
        )
        .map((g) => originalId + ':' + g.id),
      contentUrl: `/api/sources/${encodeURIComponent(originalId)}/content`,
      locator: envelope?.provenance?.locator || locator,
      version: ownershipHash([source, evidence, accepted, transitions]),
      selected: false,
      identity,
      acceptedMapping: accepted?.mapping || null,
      evidenceIds: evidence.map((e) => String(e.id)),
      source,
      envelope,
      intakeId: accepted?.intakeId || originalId,
      sourceHash: String(original.sha256),
      attachmentVersion: ownershipHash(transitions),
    };
  });
}
