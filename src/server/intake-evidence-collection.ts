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
import { isPreparedIntakeCompactScalar } from './intake-compact-scalar.ts';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';
import { evidenceRelativeFilename, type EvidenceFilename } from './intake-evidence-filename.ts';
import { reviewReadStamp } from './intake-clinical-review-read-cache.ts';

function* filenameLexical(value: string) {
  yield '"';
  for (let at = 0; at < value.length;) {
    let end = Math.min(at + 4096, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
    yield JSON.stringify(value.slice(at, end)).slice(1, -1);
    at = end;
  }
  yield '"';
}

/** UTF-8 name buckets can contain distinct lone-surrogate and replacement scalars. */
export function exactEvidenceInventoryMember<T extends { filename: string }>(
  candidates: Iterable<T>,
  scalarHash: string,
): T | undefined {
  for (const member of candidates)
    if (hashIntakeJsonScalar(filenameLexical(member.filename)).hash === scalarHash) return member;
  return undefined;
}

/** One source-bound directory preparation, reused for every literal HTML reference. */
export function evidenceRelativeSuppliedTarget(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  assertRunning: () => void = () => {},
) {
  assertRunning();
  assertIntakeOwner(db, profileId);
  const metadata = intakeSourceMetadata(db, id);
  const selected = hasIntakeCollectionEnvelope(db, { id });
  const view = selected ? openIntakeCollectionEnvelope(db, { id }) : undefined;
  const intake = view?.child(view.root(), 'intake');
  const stamp = reviewReadStamp(db);
  const check = () => {
    assertRunning();
    if (stamp === undefined || reviewReadStamp(db) !== stamp)
      throw Error('Evidence filename source changed during navigation');
  };
  const pieces = function* () {
    if (!view || !intake) {
      if (typeof metadata.originalName !== 'string') throw Error('Evidence filename unavailable');
      yield* filenameLexical(metadata.originalName);
      return;
    }
    let after: string | undefined;
    for (;;) {
      check();
      const page = view.fieldFragment(intake, 'originalName', { after, bytes: 4096 });
      yield page.text;
      if (page.complete) return;
      if (!page.after || page.after === after) throw Error('Evidence filename did not advance');
      after = page.after;
    }
  };
  const name = evidenceRelativeFilename(pieces(), check),
    lookup = evidenceSuppliedTarget(db, root, profileId, id);
  return {
    resolve: (path: string) => {
      check();
      const target = name.resolve(path);
      const result = target.hash === name.sourceHash ? { id } : lookup(target);
      check();
      return result;
    },
    close: name.close,
  };
}

/** SQL selects a superset from compact metadata in retained row order. The
 * checked JavaScript metadata decides last-duplicate parent/name semantics. */
export function evidenceSuppliedTarget(db: Database, root: string, profileId: string, id: string) {
  assertIntakeOwner(db, profileId);
  const parentId = intakeSourceMetadata(db, id).parentSourceFileId;
  return (
    filename: string | EvidenceFilename,
  ): { id: string } | { memberId: string; intakeId: string } | undefined => {
    if (!parentId) return undefined;
    const matches = db
      .prepare(
        `SELECT id,kind,sha256,details_json FROM source_files
      WHERE kind='intake_original' AND EXISTS (
        SELECT 1 FROM json_each(source_files.details_json) AS intake
        WHERE intake.key='intake' AND intake.type='object'
        AND EXISTS (
          SELECT 1 FROM json_each(CASE WHEN intake.type='object' THEN intake.value ELSE '{}' END)
          WHERE key='parentSourceFileId' AND value=?
        )
        AND EXISTS (
          SELECT 1 FROM json_each(CASE WHEN intake.type='object' THEN intake.value ELSE '{}' END)
          WHERE key='originalName' AND (
            (? IS NOT NULL AND value=?) OR
            (? IS NOT NULL AND (
              (type='object' AND json_extract(value,'$.scalarHash')=?) OR
              (type='text' AND length(CAST(value AS BLOB))=?
                AND substr(CAST(value AS BLOB),1,512)=?
                AND substr(CAST(value AS BLOB),-512)=?)
            ))
          )
        )
      )
      ORDER BY rowid`,
      )
      .iterate(
        parentId,
        typeof filename === 'string' ? filename : null,
        typeof filename === 'string' ? filename : null,
        typeof filename === 'string' ? null : filename.hash,
        typeof filename === 'string' ? null : filename.hash,
        typeof filename === 'string' ? null : filename.bytes,
        typeof filename === 'string' ? null : filename.prefix,
        typeof filename === 'string' ? null : filename.suffix,
      );
    for (const match of matches) {
      const source = match as unknown as IntakeEnvelopeSource;
      intakeEnvelopeAuthorityBinding(db, source);
      const metadata = intakeSourceMetadata(db, source.id);
      const matches =
        typeof filename === 'string'
          ? metadata.originalName === filename
          : isPreparedIntakeCompactScalar(metadata.originalName)
            ? metadata.originalName.scalarHash === filename.hash
            : typeof metadata.originalName === 'string' &&
              hashIntakeJsonScalar(filenameLexical(metadata.originalName)).hash === filename.hash;
      if (metadata.parentSourceFileId === parentId && matches) return { id: source.id };
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
      const member =
        typeof filename === 'string'
          ? inventory.matchesByExactName(filename).next().value
          : exactEvidenceInventoryMember(
              inventory.matchesByNameDigest(filename.utf8Hash),
              filename.hash,
            );
      return member ? { memberId: member.memberId, intakeId: parentId } : undefined;
    }
    const view = openIntakeCollectionEnvelope(db, source);
    const plan = view.lookup('active-inventory-plan-first', []),
      index = plan && view.child(plan, 'index');
    if (!index) return undefined;
    const member =
      typeof filename === 'string'
        ? view.lookup('inventory-name-first', [view.address(index), filename])
        : view.lookupDigest(filename.key(['inventory-name-first', view.address(index)]));
    if (!member) return undefined;
    if (
      typeof filename !== 'string' &&
      hashIntakeJsonScalar(view.fieldChunks(member, 'filename')).hash !== filename.hash
    )
      throw Error('Selected inventory reference filename digest mismatch');
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
