/** Bind reviewed saved evidence to immutable audit snapshots before projection. */
import { HttpError, clinicalReviewRevision, type Database } from './database.ts';
import { setImmediate } from 'node:timers/promises';
import { canonicalLiteral } from './intake-format.ts';
import { duplicateEvidenceValue, nativeDuplicateRecord } from './duplicate-review.ts';
import { ownershipDecisionQueries } from './ownership-decision-index.ts';
import { hasIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import { createDuplicateEvidenceSnapshotPreparation } from './duplicate-evidence-snapshots.ts';
import {
  collectionClinicalProjectionContext,
  type CollectionClinicalReviewSession,
} from './intake-review-collection-session.ts';
import type { IntakeReviewDecision } from '../shared/intake.ts';
import type { RetainedDuplicateEvidenceReference } from '../shared/saved-duplicate-evidence.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import { clinicalTables, type ClinicalKind } from './clinical-references.ts';
type Factory = ReturnType<typeof createDuplicateEvidenceSnapshotPreparation>;
type Stage = Awaited<ReturnType<Factory['finish']>>;
type Standalone = ReturnType<Stage['prepareStandalone']>;
const key = (kind: string, id: string) => JSON.stringify([kind, id]);

/** Accepted corrections prove kind aliases; a coincidentally equal row ID is
 * insufficient. Only four scalar kinds are retained while history streams. */
async function previousSnapshot(
  db: Database,
  target: ReturnType<typeof nativeDuplicateRecord>,
  assertCurrent: () => void,
) {
  const queries = ownershipDecisionQueries(db);
  if (!queries)
    throw new HttpError(
      409,
      'OWNERSHIP_DECISION_INDEX_PENDING',
      'Prepare accepted evidence decisions',
    );
  const kinds = new Set<ClinicalKind>([target.kind]);
  let priorKind: ClinicalKind = target.kind,
    visited = 0,
    fallbackIdentity = false,
    checkedIdentity = false;
  for (const transition of queries.reclassifications(target.id)) {
    const missingIdentity =
      transition.identity === null && target.identity === `${target.kind}:${target.id}`;
    if (
      transition.to_kind !== priorKind ||
      typeof transition.from_kind !== 'string' ||
      !Object.hasOwn(clinicalTables, transition.from_kind) ||
      (!missingIdentity && transition.identity !== target.identity) ||
      (checkedIdentity && missingIdentity !== fallbackIdentity)
    )
      throw new HttpError(
        409,
        'DUPLICATE_EVIDENCE_CHANGED',
        'Accepted record kind history disagrees with this target',
      );
    fallbackIdentity = missingIdentity;
    checkedIdentity = true;
    priorKind = transition.from_kind as ClinicalKind;
    kinds.add(priorKind);
    if (++visited % 64 === 0) {
      await setImmediate();
      assertCurrent();
    }
  }
  let selected: ReturnType<typeof queries.latestDuplicateEvidenceSnapshotIdentity>;
  for (const kind of kinds) {
    const candidate = queries.latestDuplicateEvidenceSnapshotIdentity(kind, target.id);
    if (
      candidate &&
      candidate.identity === (fallbackIdentity ? `${kind}:${target.id}` : target.identity) &&
      candidate.source_record_id === target.sourceRecordId &&
      (!selected || Number(candidate.sequence) > Number(selected.sequence))
    )
      selected = candidate;
  }
  return selected
    ? {
        previous: JSON.parse(String(selected.reference)) as RetainedDuplicateEvidenceReference,
        previousKind: selected.kind as ClinicalKind,
      }
    : {};
}
export interface PreparedDuplicateEvidence {
  reference(kind: string, id: string): RetainedDuplicateEvidenceReference;
  changes(sourceId: string): readonly IntakeCollectionChange[];
  assertCurrent(): void;
  applyStandalone(): void;
  dispose(): void;
}
export async function prepareDuplicateEvidenceSnapshots(
  db: Database,
  members: {
    session: CollectionClinicalReviewSession;
    decisions: readonly IntakeReviewDecision[];
  }[],
): Promise<PreparedDuplicateEvidence> {
  const basis = clinicalReviewRevision(db),
    contexts = members.map((m) => collectionClinicalProjectionContext(m.session));
  const refs = new Map<string, RetainedDuplicateEvidenceReference>(),
    pins = new Map<string, ReturnType<typeof nativeDuplicateRecord>>(),
    factories = new Map<string, Factory>(),
    stages = new Map<string, Stage>(),
    standalone = new Map<string, Standalone>(),
    composed = new Set<string>();
  let disposed = false,
    staged = false;
  const assertCurrent = () => {
    if (disposed || clinicalReviewRevision(db) !== basis)
      throw new HttpError(
        409,
        'DUPLICATE_EVIDENCE_CHANGED',
        'Refresh this exact reviewed evidence',
      );
    for (const context of contexts) context.assertCurrent();
    for (const target of pins.values())
      if (
        canonicalLiteral(nativeDuplicateRecord(db, target.kind, target.id)) !==
        canonicalLiteral(target)
      )
        throw new HttpError(
          409,
          'DUPLICATE_EVIDENCE_CHANGED',
          'Saved evidence changed during preparation',
        );
    for (const factory of factories.values()) factory.assertCurrent();
  };
  try {
    for (const [index, member] of members.entries())
      for (const decision of member.decisions)
        for (const pair of decision.comparisons || []) {
          assertCurrent();
          const record = member.session.record(decision.recordId);
          if (!record?.comparisonReference)
            throw new HttpError(
              409,
              'DUPLICATE_SCOPE_CHANGED',
              'Choose a current clinical comparison',
            );
          const kind = record.comparisonReference.kind,
            id = pair.otherRecordId,
            targetKey = key(kind, id);
          if (refs.has(targetKey)) continue;
          const target = nativeDuplicateRecord(db, kind, id);
          pins.set(targetKey, target);
          const { previous, previousKind } = await previousSnapshot(db, target, assertCurrent);
          const importedOriginal = db
            .prepare(
              `SELECT json_extract(extra_json,'$.import.intakeId') AS id FROM ${kind === 'observation' ? 'observations' : kind === 'medication' ? 'medications' : kind === 'procedure' ? 'procedures' : 'documents'} WHERE id=?`,
            )
            .get(id)?.id;
          const imported =
            typeof importedOriginal === 'string' &&
            db
              .prepare(
                "SELECT id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
              )
              .get(importedOriginal);
          const nativeImported =
            imported &&
            hasIntakeCollectionEnvelope(db, {
              id: String(imported.id),
              kind: 'intake_original',
              sha256: String(imported.sha256),
              details_json: String(imported.details_json),
            });
          const custodian =
            previous?.source.intakeId ||
            (nativeImported ? String(imported.id) : contexts[index]!.proposal.file.id);
          if (!factories.has(custodian)) {
            factories.set(
              custodian,
              createDuplicateEvidenceSnapshotPreparation(
                db,
                { id: custodian },
                {
                  assertRunning: () => {
                    if (clinicalReviewRevision(db) !== basis)
                      throw new HttpError(
                        409,
                        'DUPLICATE_EVIDENCE_CHANGED',
                        'Reviewed evidence changed',
                      );
                  },
                },
              ),
            );
          }
          const reference = await factories.get(custodian)!.prepareTarget({
            kind,
            recordId: id,
            previous,
            previousKind,
            evidence: function* () {
              for (const row of db
                .prepare(
                  'SELECT s.*,e.id AS evidence_id,e.locator_json AS evidence_locator,p.name AS acquiring_source FROM evidence e JOIN source_records s ON s.id=e.source_record_id LEFT JOIN providers p ON p.id=s.provider_id WHERE e.entity_type=? AND e.entity_id=? ORDER BY e.id',
                )
                .iterate(kind, id))
                yield { id: String(row.evidence_id), value: duplicateEvidenceValue(row) };
            },
          });
          if (
            reference.digest !== target.evidence.digest ||
            reference.count !== target.evidence.count ||
            canonicalLiteral(nativeDuplicateRecord(db, kind, id)) !== canonicalLiteral(target)
          )
            throw new HttpError(
              409,
              'DUPLICATE_EVIDENCE_CHANGED',
              'Saved evidence changed during preparation',
            );
          refs.set(targetKey, reference);
        }
    for (const [id, factory] of factories) {
      const stage = await factory.finish();
      stages.set(id, stage);
      standalone.set(id, stage.prepareStandalone());
    }
    assertCurrent();
    return {
      reference(kind, id) {
        const value = refs.get(key(kind, id));
        if (!value || disposed)
          throw new HttpError(
            409,
            'DUPLICATE_EVIDENCE_PENDING',
            'Prepare this selected evidence snapshot',
          );
        return value;
      },
      changes(id) {
        if (staged) throw Error('Evidence catalogs already staged');
        composed.add(id);
        standalone.get(id)?.dispose();
        standalone.delete(id);
        return stages.get(id)?.changes || [];
      },
      assertCurrent,
      applyStandalone() {
        assertCurrent();
        for (const [id, selected] of standalone) if (!composed.has(id)) selected.apply();
        staged = true;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const stage of standalone.values()) stage.dispose();
        for (const stage of stages.values()) stage.dispose();
      },
    };
  } catch (error) {
    for (const stage of standalone.values()) stage.dispose();
    for (const stage of stages.values()) stage.dispose();
    for (const factory of factories.values()) factory.dispose();
    throw error;
  }
}
