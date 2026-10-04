import { createHash } from 'node:crypto';
import { HttpError, type Database } from './database.ts';
import { assertIntakeOwner, getIntakeEvidenceHeader } from './intake.ts';
import { intakeEnvelopeAuthorityBinding, type IntakeEnvelopeSource } from './intake-authority.ts';
import {
  hasIntakeCollectionEnvelope,
  openIntakeCollectionEnvelope,
} from './intake-collection-envelope.ts';
import { readIntakeSourcePin } from './intake-source-pin.ts';
import { modelIntakeEvidenceContext } from './intake-model-context.ts';
import { readVerifiedWorkflowSummary } from './intake-workflow-state.ts';
import { intakeSourceMetadata } from './intake-state-access.ts';
import { readDurablePackageInventory } from './intake-package-state.ts';

/** SQL selects matching compact accepted source rows in retained order; each
 * candidate is then checked against its selected authority. json_each's last
 * name occurrence preserves JSON.parse semantics for raw duplicate metadata. */
export function evidenceSuppliedTarget(db: Database, root: string, profileId: string, id: string) {
  assertIntakeOwner(db, profileId);
  const parentId = intakeSourceMetadata(db, id).parentSourceFileId;
  return (
    filename: string,
  ): { id: string } | { memberId: string; intakeId: string } | undefined => {
    if (!parentId) return undefined;
    const matches = db
      .prepare(
        `SELECT id,kind,sha256,details_json FROM source_files
      WHERE json_extract(details_json,'$.intake.parentSourceFileId')=?
      AND (SELECT value FROM json_each(json_extract(source_files.details_json,'$.intake'))
        WHERE key='originalName' ORDER BY id DESC LIMIT 1)=?
      ORDER BY rowid`,
      )
      .iterate(parentId, filename);
    for (const match of matches) {
      const source = match as unknown as IntakeEnvelopeSource;
      intakeEnvelopeAuthorityBinding(db, source);
      if (intakeSourceMetadata(db, source.id).originalName === filename) return { id: source.id };
    }
    const parent = getIntakeEvidenceHeader(db, root, profileId, parentId);
    if (parent.mimeType !== 'application/zip') return undefined;
    const source = db
      .prepare(
        "SELECT id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
      )
      .get(parentId) as unknown as IntakeEnvelopeSource;
    const binding = intakeEnvelopeAuthorityBinding(db, source);
    if (!binding.logicalHead)
      throw new HttpError(
        409,
        'EVIDENCE_INDEX_PENDING',
        'The complete package reference index is not selected yet.',
      );
    const inventory = readDurablePackageInventory({
      db,
      root,
      profileId,
      id: parentId,
      rawDomainVersion: (JSON.parse(binding.logicalHead) as { domainVersion: number })
        .domainVersion,
    });
    if (inventory) {
      const member = inventory.matchesByExactName(filename).next().value;
      return member && { memberId: member.memberId, intakeId: parentId };
    }
    const view = openIntakeCollectionEnvelope(db, source);
    const plan = view.lookup('active-inventory-plan-first', []),
      index = plan && view.child(plan, 'index');
    if (!index) return undefined;
    const member = view.lookup('inventory-name-first', [view.address(index), filename]);
    if (!member) return undefined;
    const field = view.field(member, 'memberId', { bytes: 4096 });
    if (field.kind !== 'value' || typeof field.value !== 'string')
      throw Error('Selected inventory member identity is unavailable');
    return { memberId: field.value, intakeId: parentId };
  };
}

/** Evidence-only model bridge. A legacy child remains explicitly pending until
 * schema maintenance is selected; reading its original never decodes its history. */
export function collectionEvidenceModelContext(
  db: Database,
  profileId: string,
  id: string,
  mappingVersion: string,
  page?: number,
) {
  assertIntakeOwner(db, profileId);
  const source = db
    .prepare(
      "SELECT id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(id) as IntakeEnvelopeSource | undefined;
  if (!source) throw new HttpError(404, 'NOT_FOUND', 'Source intake not found');
  const binding = intakeEnvelopeAuthorityBinding(db, source);
  if (!hasIntakeCollectionEnvelope(db, source))
    return {
      format: 'health-intake-model-evidence-pending-v1' as const,
      id,
      sourceHash: source.sha256,
      version: null,
      mappingVersion,
      sourceTextPin: readIntakeSourcePin(db, id),
      authorityBinding: createHash('sha256')
        .update(binding.logicalHead ?? binding.head ?? '')
        .digest('hex'),
      state: 'pending_migration' as const,
      summary: { state: 'pending' as const, counts: null },
      note: 'Original evidence is available. Complete workflow context requires selected schema maintenance; no candidate, question, unit, or acceptance scope is asserted empty.',
    };
  return modelIntakeEvidenceContext(
    {
      format: 'health-intake-selected-model-source-v2',
      db,
      source,
      options: {
        mappingVersion,
        summary: readVerifiedWorkflowSummary(db, source, { mappingVersion }),
      },
    },
    { page },
  );
}
